// The sniffer's MCP server, end to end through an MCP client, on a fake Frida device and a temp data folder.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { parseCapture } from "@patchsprite/engine/capture";
import { acquirePedalLock, pedalLockPath, releasePedalLock } from "@patchsprite/engine/pedal-lock";
import { createServer, INSTRUCTIONS } from "../src/mcp/server.ts";
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
  const { env, device, call } = await rig();
  device.processes = [{ pid: 7, name: "AcmeEdit.exe" }];
  const started = await call("start_capture", { editor: "AcmeEdit.exe", attachDelaySeconds: 0 });
  assert.equal(started.error, false, started.text);
  const file = started.data!.file as string;
  assert.ok(file.startsWith(join(env.PATCHSPRITE_HOME, "sniffer", "captures")));
  assert.ok(existsSync(pedalLockPath(env)), "the device is held for the whole session");
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
