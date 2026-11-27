// The walk tools through an MCP client on the real server, with a fake window host and a fake Frida device.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/mcp/server.ts";
import { Recorder } from "../src/recorder.ts";
import type { WindowHost } from "../src/walk/host.ts";
import { filesDir, shotsDir, walkTools } from "../src/walk/tools.ts";
import { fakeWindowHost } from "./fake-window-host.ts";
import { FakeDevice } from "./fake-frida.ts";

const RECT = { left: 0, top: 0, width: 1000, height: 600 };
const WIN = { found: true as const, hwnd: 3, pid: 9, rect: RECT, minimized: false };

async function rig() {
  const env = { PATCHSPRITE_HOME: mkdtempSync(join(tmpdir(), "sniff-walk-")) };
  const device = new FakeDevice();
  device.processes = [{ pid: 7, name: "AcmeEdit.exe" }];
  const recorder = new Recorder({ getDevice: async () => device, env, settleMs: 40, maxMs: 1000, pollMs: 5 });
  const log: string[] = [];
  const roots: string[] = [];
  const host: WindowHost = fakeWindowHost({
    find: async (app) => (log.push(`find ${app}`), WIN),
    shot: async (_h, path, scale) => {
      writeFileSync(path, "PNG");
      return { saved: true, spread: 80, source: "window", rect: RECT, width: RECT.width * scale };
    },
    click: async (pid, x, y) => (log.push(`click ${pid} ${x},${y}`), { done: true }),
    type: async (pid, t) => (log.push(`type ${pid} ${t}`), { done: true }),
    element: async () => ({ found: true, element: { name: "Level", controlType: "Edit", automationId: "", className: "", enabled: true, rect: { left: 100, top: 100, width: 50, height: 20 }, value: "-6.0" } }),
    dialogs: async () => ({ dialogs: [{ title: "Save As", fileBox: true, buttons: ["Save", "Cancel"] }] }),
    fill: async (pid, title, path, button) => (log.push(`fill ${title} ${path} ${button}`), { done: true, remaining: [] }),
  });
  const register = walkTools({ makeHost: (root) => (roots.push(root), host), sleep: async () => {} });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer(recorder, [register]).connect(a);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  type Result = { content: { type: string; text?: string; data?: string }[]; isError?: boolean; structuredContent?: Record<string, unknown> };
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as Result;
    return { r, text: r.content.find((c) => c.type === "text")?.text ?? "", error: r.isError === true, data: r.structuredContent };
  };
  return { env, recorder, client, call, log, roots };
}

test("the walk tools are listed with all four annotations, and input is marked destructive", async () => {
  const { client } = await rig();
  const { tools } = await client.listTools();
  const walk = tools.filter((t) => ["editor_screenshot", "editor_input", "read_control", "list_dialogs", "fill_dialog"].includes(t.name));
  assert.equal(walk.length, 5);
  for (const t of walk) for (const k of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const) assert.equal(typeof t.annotations?.[k], "boolean", `${t.name}.${k}`);
  assert.equal(walk.find((t) => t.name === "editor_input")?.annotations?.destructiveHint, true);
  assert.equal(walk.find((t) => t.name === "editor_screenshot")?.annotations?.readOnlyHint, true);
});

test("with no capture running, every walk tool refuses and nothing reaches the editor", async () => {
  const { call, log, roots } = await rig();
  for (const [name, args] of [["editor_screenshot", { name: "x" }], ["editor_input", { steps: ["click:1,1"] }], ["read_control", { x: 1, y: 1 }], ["list_dialogs", {}], ["fill_dialog", { title: "Save As", path: "x", button: "Save" }]] as const) {
    const res = await call(name, args);
    assert.equal(res.error, true, name);
    assert.match(res.text, /No capture is running/);
  }
  assert.deepEqual(log, []);
  assert.deepEqual(roots, []);
});

test("during a capture: a shot of the capture's editor beside the capture, then input, a control read and a dialog fill", async () => {
  const { call, log, roots, recorder } = await rig();
  const started = await call("start_capture", { editor: "AcmeEdit.exe", attachDelaySeconds: 0 });
  assert.equal(started.error, false, started.text);
  const file = started.data!.file as string;

  const shot = await call("editor_screenshot", { name: "Main view" });
  assert.equal(shot.error, false, shot.text);
  assert.deepEqual(roots, [shotsDir(file)]);
  assert.equal(dirname(shot.data!.path as string), shotsDir(file));
  assert.equal(shot.r.content[0].type, "image");
  assert.equal(Buffer.from(shot.r.content[0].data!, "base64").toString(), "PNG");
  assert.deepEqual([shot.data!.width, shot.data!.height], [500, 300]);
  assert.equal(log[0], "find AcmeEdit.exe", "the window is the capture's editor");

  const done = await call("editor_input", { steps: ["click:10,20", "type:-3.5"] });
  assert.equal(done.error, false, done.text);
  assert.ok(log.includes("click 9 20,40") && log.includes("type 9 -3.5"), log.join("; "));

  const bad = await call("editor_input", { steps: ["click:10,20", "press:1"] });
  assert.equal(bad.error, true);
  assert.match(bad.text, /unknown step "press:1"/);

  const ctl = await call("read_control", { x: 60, y: 55 });
  assert.equal((ctl.data!.control as { value: string }).value, "-6.0");

  assert.match((await call("list_dialogs")).text, /Save As/);
  const backup = join(filesDir(file), "walk-backup.syx");
  const filled = await call("fill_dialog", { title: "Save As", path: backup, button: "Save" });
  assert.equal(filled.error, false, filled.text);
  assert.ok(log.includes(`fill Save As ${backup} Save`));
  for (const path of [join(tmpdir(), "firmware.prst"), file, join(dirname(file), "other-capture.jsonl"), join(shotsDir(file), "main-view.png")]) {
    const outside = await call("fill_dialog", { title: "Save As", path, button: "Save" });
    assert.equal(outside.error, true, path);
    assert.match(outside.text, /inside the capture's folder/, path);
  }
  const open = await call("fill_dialog", { title: "Open", path: join(filesDir(file), "walk-backup.syx"), button: "Open" });
  assert.match(open.text, /never opened/);

  await recorder.stop();
  const after = await call("editor_input", { steps: ["click:1,1"] });
  assert.equal(after.error, true);
  assert.ok(readFileSync(file, "utf8").length > 0);
  await sleep(1);
});
