import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { CaptureRecord } from "@patchsprite/engine/capture";
import { CaptureSession, winmmAgentSource } from "../src/capture-session.ts";
import { FakeDevice } from "./fake-frida.ts";

const until = async (ok: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out");
    await sleep(5);
  }
};

function start(device: FakeDevice, o: { attachDelayMs?: number } = {}) {
  const records: CaptureRecord[] = [];
  const stop = new AbortController();
  let t = 1000;
  const session = new CaptureSession({ device, editorExe: "AcmeEdit.exe", attachDelayMs: o.attachDelayMs ?? 0, write: (r) => records.push(r), pollMs: 5, retryMs: 5, now: () => t++ });
  const done = session.run(stop.signal);
  return { records, stop: async () => (stop.abort(), await done), kinds: () => records.map((r) => (r.type === "event" ? r.kind : r.type)) };
}

test("waits for the editor, attaches the receive-only agent, and writes what it reports", async () => {
  const device = new FakeDevice();
  const c = start(device);
  await sleep(20);
  assert.equal(device.sessions.length, 0, "nothing to attach to yet");
  device.processes = [{ pid: 7, name: "acmeedit.EXE" }]; // matched without case
  const s = await device.nextSession();
  await until(() => s.scripts[0]?.loaded === true && c.kinds().includes("attached"));
  assert.equal(s.scripts[0].source, winmmAgentSource());
  s.scripts[0].send({ dir: "out", kind: "open", dev: 1, h: "0x1a2b", t: 5 });
  s.scripts[0].send({ dir: "out", kind: "sysex", h: "0x1a2b", hex: "f07d0110f7", t: 999 });
  s.scripts[0].send({ dir: "in", kind: "short", h: "0x3c4d", hex: "f8", t: 1000 });
  await c.stop();
  assert.equal(s.scripts[0].unloaded, true, "stopping unloads the agent");
  assert.equal(s.detachedByUs, true, "and lets go of the editor, which keeps running");
  const midi = c.records.filter((r) => r.type === "midi");
  assert.deepEqual(midi.map((m) => [m.dir, m.kind, m.bytes, m.port]), [["out", "sysex", "f0 7d 01 10 f7", "0x1a2b"], ["in", "short", "f8", "0x3c4d"]]);
  assert.deepEqual(c.records.find((r) => r.type === "event" && r.kind === "portOpen"), { type: "event", t: (c.records[1] as { t: number }).t, kind: "portOpen", dir: "out", port: "0x1a2b", device: 1 });
});

test("attaches again after the editor restarts, and says it lost it", async () => {
  const device = new FakeDevice();
  device.processes = [{ pid: 7, name: "AcmeEdit.exe" }];
  const c = start(device);
  const first = await device.nextSession();
  await until(() => c.kinds().includes("attached"));
  device.processes = [];
  first.gone();
  await until(() => c.kinds().includes("detached"));
  device.processes = [{ pid: 8, name: "AcmeEdit.exe" }];
  const second = await device.nextSession();
  assert.equal(second.pid, 8);
  await until(() => c.kinds().filter((k) => k === "attached").length === 2);
  await c.stop();
  assert.equal(first.detachedByUs, false, "a session the editor ended isn't detached again");
  assert.deepEqual(c.kinds(), ["attached", "detached", "attached"]);
  assert.deepEqual(c.records.map((r) => (r.type === "event" ? r.pid : undefined)), [7, 7, 8]);
});

test("waits the attach delay after the editor appears", async () => {
  const device = new FakeDevice();
  device.processes = [{ pid: 7, name: "AcmeEdit.exe" }];
  const t0 = Date.now();
  const c = start(device, { attachDelayMs: 120 });
  await device.nextSession();
  assert.ok(Date.now() - t0 >= 110, `attached after ${Date.now() - t0} ms`);
  await c.stop();
});

test("a failed attach is retried, and after five in a row it waits for the editor to restart", async () => {
  const device = new FakeDevice();
  device.processes = [{ pid: 7, name: "AcmeEdit.exe" }];
  device.attachFails = 100;
  const c = start(device);
  await until(() => c.kinds().includes("warning"));
  await sleep(40);
  assert.equal(c.kinds().filter((k) => k === "error").length, 5, "no sixth try on the same process");
  device.attachFails = 0;
  device.processes = [{ pid: 9, name: "AcmeEdit.exe" }];
  const s = await device.nextSession();
  assert.equal(s.pid, 9);
  await c.stop();
});

test("an agent that fails to load lets go of the editor and is retried", async () => {
  const device = new FakeDevice();
  device.processes = [{ pid: 7, name: "AcmeEdit.exe" }];
  device.failLoad = true;
  const c = start(device);
  const s = await device.nextSession();
  await until(() => c.kinds().includes("error"));
  assert.equal(s.detachedByUs, true);
  assert.match((c.records.find((r) => r.type === "event" && r.kind === "error") as { text: string }).text, /load failed/);
  await c.stop();
});

test("stopping before the editor ever starts ends at once", async () => {
  const c = start(new FakeDevice());
  await c.stop();
  assert.deepEqual(c.records, []);
});
