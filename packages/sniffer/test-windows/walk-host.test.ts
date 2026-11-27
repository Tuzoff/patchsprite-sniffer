// Runs the real window host (host.ps1) on Windows, against Notepad: CI's `windows-host` job runs this file only.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PowerShellHost } from "../src/walk/host.ts";
import { parseStep, runSteps } from "../src/walk/input.ts";
import { fillDialog, listDialogs, readControl } from "../src/walk/read.ts";
import { takeEditorShot } from "../src/walk/shot.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

test("the window host finds, fronts and shoots a real window at half size", async (t) => {
  const notepad = spawn("notepad.exe", [], { stdio: "ignore" });
  const dir = await mkdtemp(join(tmpdir(), "walk-host-"));
  const host = new PowerShellHost(dir);
  t.after(() => {
    host.close();
    notepad.kill();
  });
  let win = await host.find("notepad.exe");
  for (let i = 0; i < 50 && !win.found; i++) {
    await new Promise((r) => setTimeout(r, 200));
    win = await host.find("notepad.exe");
  }
  assert.ok(win.found, "notepad's window appears");
  const shot = await takeEditorShot(host, { app: "notepad.exe", dir, name: "notepad" });
  assert.deepEqual((await readFile(shot.path)).subarray(0, 4), PNG);
  assert.ok(Math.abs(shot.width - shot.window.width / 2) <= 1, `half width: ${shot.width} of ${shot.window.width}`);
  await assert.rejects(host.shot(win.hwnd, join(dir, "..", "outside.png"), 0.5, 16), /session folder/);
  await assert.rejects(host.shot(win.hwnd, join(dir, "x.txt"), 0.5, 16), /session folder/);
  t.diagnostic(`tries ${shot.tries}, window ${shot.window.width}x${shot.window.height}`);

  // Type into Notepad, read its text box back through UI Automation, then save through the file-dialog helper.
  const deps = { host, app: "notepad.exe", beforeInput: async () => {}, sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) };
  const mid = { x: Math.round(shot.width / 2), y: Math.round(shot.height / 2) };
  await runSteps(deps, [parseStep(`click:${mid.x},${mid.y}`), parseStep("type:walk tools ok")]);
  const box = await readControl(deps, mid.x, mid.y);
  t.diagnostic(`control at the middle: ${box?.controlType} ${JSON.stringify(box?.name)}`);
  assert.ok(box, "UI Automation sees Notepad's text box");
  await runSteps(deps, [parseStep("key:ctrl+s"), parseStep("wait:2")]);
  const dialogs = await listDialogs(deps);
  t.diagnostic(`dialogs: ${JSON.stringify(dialogs)}`);
  assert.equal(dialogs.length, 1);
  const file = join(dir, "saved.txt");
  await fillDialog(deps, dialogs[0].title, file, "Save");
  assert.equal((await readFile(file, "utf8")).trim(), "walk tools ok");
});

test("the window host says when no window of an executable is open", async (t) => {
  const host = new PowerShellHost(tmpdir());
  t.after(() => host.close());
  assert.deepEqual(await host.find("no-such-editor-here.exe"), { found: false });
});
