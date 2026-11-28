// The sniffer's MCP server, end to end through an MCP client, on a fake Frida device and a temp data folder.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { parseCapture } from "@patchsprite/engine/capture";
import { acquirePedalLock, PEDAL_LOCK_IDLE_MS, pedalLockPath, readPedalLock, releasePedalLock } from "@patchsprite/engine/pedal-lock";
import { createServer, INSTRUCTIONS } from "../src/mcp/server.ts";
import { CaptureWriter } from "../src/capture-writer.ts";
import { Recorder } from "../src/recorder.ts";
import { FakeDevice, type FakeSession } from "./fake-frida.ts";

async function rig() {
  const env = { PATCHSPRITE_HOME: mkdtempSync(join(tmpdir(), "sniff-mcp-")) };
  const device = new FakeDevice();
  const recorder = new Recorder({ getDevice: async () => device, env, settleMs: 40, maxMs: 1000, pollMs: 5 });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer(recorder).connect(a);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean; structuredContent?: Record<string, unknown> };
    return { text: r.content[0].text, error: r.isError === true, data: r.structuredContent };
  };
  return { env, device, recorder, client, call };
}

const until = async (ok: () => boolean) => {
  for (let i = 0; i < 400 && !ok(); i++) await sleep(5);
  assert.ok(ok(), "timed out");
};

/** The editor answering a change: what its agent reports. */
const exchange = (s: FakeSession, send: string, answer: string) => {
  s.scripts[0].send({ dir: "out", kind: "sysex", h: "0x1a", hex: send.replaceAll(" ", "") });
  s.scripts[0].send({ dir: "in", kind: "sysex", h: "0x2b", hex: answer.replaceAll(" ", "") });
};

test("the instructions fit Claude Code's cut, and every tool carries all four annotations", async () => {
  assert.ok(INSTRUCTIONS.length < 3000, `${INSTRUCTIONS.length} characters`);
  const { client } = await rig();
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["begin_step", "capture_status", "end_step", "help", "record_idle", "start_capture", "stop_capture", "summarize_capture"]);
  for (const t of tools) for (const k of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const) assert.equal(typeof t.annotations?.[k], "boolean", `${t.name}.${k}`);
});

test("a whole session: start, idle, self-test, a step, stop; the capture reads back and the lock is given back", async () => {
  const { env, device, recorder, call } = await rig();
  device.processes = [{ pid: 7, name: "AcmeEdit.exe" }];
  const started = await call("start_capture", { editor: "AcmeEdit.exe", attachDelaySeconds: 0 });
  assert.equal(started.error, false, started.text);
  const file = started.data!.file as string;
  assert.ok(file.startsWith(join(env.PATCHSPRITE_HOME, "sniffer", "captures")));
  assert.ok(existsSync(pedalLockPath(env)), "the device is held for the whole session");
  assert.equal(recorder.editor, "AcmeEdit.exe");
  const s = await device.nextSession().catch(() => device.sessions[0]);
  await until(() => s.scripts[0]?.loaded === true);
  await until(() => readFileSync(file, "utf8").includes('"attached"'));
  assert.match((await call("capture_status")).text, /attached to the editor/);

  const idle = call("record_idle", { seconds: 3 });
  await sleep(20);
  exchange(s, "f0 7d 01 50 f7", "f0 7d 01 51 12 f7");
  assert.match((await idle).text, /^Recorded 3 s idle: 2 polled message kinds/);

  await call("begin_step", { kind: "selfTest", label: "Preset: 1 → 2" });
  exchange(s, "f0 7d 01 12 01 f7", "f0 7d 01 11 01 f7");
  const self = await call("end_step");
  assert.equal(self.data!.selfTest, true, self.text);

  assert.equal((await call("begin_step", { label: "Drive" })).error, false);
  exchange(s, "f0 7d 01 22 02 01 f7", "f0 7d 01 51 40 f7"); // the poll answer doesn't count
  const refused = await call("end_step");
  assert.equal(refused.error, true);
  assert.match(refused.text, /say what changed/);
  const ended = await call("end_step", { label: "Drive: off → on" });
  assert.equal(ended.data!.counted, 1, ended.text);

  assert.match((await call("stop_capture")).text, /^Stopped\. Saved /);
  assert.equal(recorder.editor, undefined);
  assert.equal(existsSync(pedalLockPath(env)), false, "the lock is given back");
  assert.equal(s.detachedByUs, true);
  const r = parseCapture(readFileSync(file, "utf8"));
  assert.ok(r.ok, JSON.stringify(!r.ok && r.issues));
  assert.deepEqual(r.capture.steps.map((x) => [x.start.kind, x.end?.status]), [["idle", "quiet"], ["selfTest", "quiet"], ["action", "quiet"]]);
  const summary = (await call("summarize_capture")).text;
  assert.match(summary, /^Capture of AcmeEdit\.exe/);
  assert.match(summary, /3\. \[action\] Drive: off → on: quiet, 1 sent, 0 received/);
});

test("a failed self-test stops the capture and says why", async () => {
  const { env, device, call } = await rig();
  device.processes = [{ pid: 7, name: "AcmeEdit.exe" }];
  const file = (await call("start_capture", { editor: "AcmeEdit.exe", attachDelaySeconds: 0 })).data!.file as string;
  await until(() => device.sessions[0]?.scripts[0]?.loaded === true);
  await call("begin_step", { kind: "selfTest", label: "Preset: 1 → 2" });
  device.sessions[0].scripts[0].send({ dir: "in", kind: "short", h: "0x2b", hex: "f8" }); // clock alone proves nothing
  const r = await call("end_step");
  assert.equal(r.data!.selfTest, false);
  assert.match(r.text, /saw no MIDI at all.*The capture has stopped\.$/);
  assert.match((await call("capture_status")).text, /^No capture is running/);
  assert.equal(existsSync(pedalLockPath(env)), false);
  const c = parseCapture(readFileSync(file, "utf8"));
  assert.ok(c.ok);
  assert.equal(c.capture.end?.reason, "selfTestFailed");
});

test("a capture that fails on its own: the status says so, and stop ends the file as an error and frees the device", async () => {
  const { env, device, call } = await rig();
  device.processes = [{ pid: 7, name: "AcmeEdit.exe" }];
  const write = CaptureWriter.prototype.write;
  CaptureWriter.prototype.write = function (r) {
    if (r.type === "event") throw new Error("disk full");
    return write.call(this, r);
  };
  try {
    const { data } = await call("start_capture", { editor: "AcmeEdit.exe", attachDelaySeconds: 0 });
    let status = await call("capture_status");
    for (let i = 0; i < 400 && !status.data?.failed; i++) status = (await sleep(5), await call("capture_status"));
    assert.match(status.text, /^The capture stopped: disk full\. Stop it with stop_capture\./);
    await call("stop_capture");
    const c = parseCapture(readFileSync(data!.file as string, "utf8"));
    assert.ok(c.ok);
    assert.deepEqual([c.capture.end?.reason, c.capture.end?.text], ["error", "The capture stopped: disk full"]);
    assert.ok(acquirePedalLock("check", { env }).ok);
  } finally {
    CaptureWriter.prototype.write = write;
  }
});

test("stop_capture while a step is still ending waits for it, so the step closes in the file before the end", async () => {
  const { device, call } = await rig();
  device.processes = [{ pid: 7, name: "AcmeEdit.exe" }];
  const { data } = await call("start_capture", { editor: "AcmeEdit.exe", attachDelaySeconds: 0 });
  const s = await device.nextSession();
  for (let i = 0; i < 400 && !(await call("capture_status")).data?.attached; i++) await sleep(5);
  await call("begin_step", { label: "Drive: off → on" });
  exchange(s, "f0 7d 01 12 01 f7", "f0 7d 01 31 f7");
  const ending = call("end_step");
  await sleep(10); // the step waits 40 ms for quiet
  const [ended, stopped] = await Promise.all([ending, call("stop_capture")]);
  assert.equal(ended.error, false, ended.text);
  assert.equal(stopped.error, false, stopped.text);
  const c = parseCapture(readFileSync(data!.file as string, "utf8"));
  assert.ok(c.ok);
  const types = c.capture.records.map((r) => r.type);
  assert.deepEqual(types.slice(-2), ["stepEnd", "end"]);
  assert.equal(c.capture.end?.reason, "stopped");
});

test("a capture left alone lets the device go: a step then takes it again, or is refused while someone else has it", async () => {
  const { env, device, call } = await rig();
  device.processes = [{ pid: 7, name: "AcmeEdit.exe" }];
  const { data } = await call("start_capture", { editor: "AcmeEdit.exe", attachDelaySeconds: 0 });
  const idle = () => {
    const then = new Date(Date.now() - PEDAL_LOCK_IDLE_MS - 60_000);
    utimesSync(pedalLockPath(env), then, then);
  };
  idle(); // nobody touched it for 16 minutes
  const other = acquirePedalLock("hardware check", { env });
  assert.ok(other.ok);
  const refused = await call("begin_step", { label: "Drive: off → on" });
  assert.equal(refused.error, true);
  assert.match(refused.text, /^The device is in use: hardware check \(process \d+\)/);
  releasePedalLock(other.lock, env);
  assert.equal((await call("begin_step", { label: "Drive: off → on" })).error, false);
  assert.equal(readPedalLock(env)?.owner, "sniffer capture", "taken again");
  await call("end_step", { aborted: true });
  await call("stop_capture");
  assert.equal(readPedalLock(env), undefined, "and given back at the end");
  const c = parseCapture(readFileSync(data!.file as string, "utf8"));
  assert.ok(c.ok);
  const notes = c.capture.records.flatMap((r) => (r.type === "event" && (r.kind === "warning" || r.kind === "info") ? [r.text] : []));
  assert.ok(notes.some((n) => /^the device's lock went idle and hardware check/.test(n ?? "")), notes.join("; "));
});

test("someone else holding the device: start_capture refuses and creates nothing", async () => {
  const { env, call } = await rig();
  const other = acquirePedalLock("hardware check", { env });
  assert.ok(other.ok);
  try {
    const r = await call("start_capture", { editor: "AcmeEdit.exe", attachDelaySeconds: 0 });
    assert.equal(r.error, true);
    assert.match(r.text, /^The device is in use: hardware check \(process \d+\)/);
    assert.equal(existsSync(join(env.PATCHSPRITE_HOME, "sniffer", "captures")), false);
  } finally {
    releasePedalLock(other.lock, env);
  }
});

test("steps and stops without a capture are refused in words; a path for the editor is refused", async () => {
  const { call } = await rig();
  for (const [tool, args] of [["begin_step", { label: "x: 1 → 2" }], ["end_step", {}], ["record_idle", { seconds: 3 }]] as const) {
    const r = await call(tool, args);
    assert.equal(r.error, true, tool);
    assert.match(r.text, /no capture is running/, tool);
  }
  assert.equal((await call("stop_capture")).text, "No capture is running.");
  assert.equal((await call("summarize_capture")).text, "There is no capture yet.");
  const p = await call("start_capture", { editor: "C:\\Users\\someone\\AcmeEdit.exe", attachDelaySeconds: 0 });
  assert.equal(p.error, true);
  assert.match(p.text, /file name, not a path/);
});

test("a channel-message device: its CC and PC messages count as a step's traffic", async () => {
  const { device, call } = await rig();
  device.processes = [{ pid: 7, name: "AcmeEdit.exe" }];
  await call("start_capture", { editor: "AcmeEdit.exe", attachDelaySeconds: 0, channelMessages: true });
  await until(() => device.sessions[0]?.scripts[0]?.loaded === true);
  await call("begin_step", { label: "Preset: 1 → 2" });
  device.sessions[0].scripts[0].send({ dir: "out", kind: "short", h: "0x1a", hex: "c001" });
  device.sessions[0].scripts[0].send({ dir: "out", kind: "short", h: "0x1a", hex: "b00764" });
  device.sessions[0].scripts[0].send({ dir: "in", kind: "short", h: "0x2b", hex: "f8" });
  assert.equal((await call("end_step")).data!.counted, 2);
  await call("stop_capture");
});
