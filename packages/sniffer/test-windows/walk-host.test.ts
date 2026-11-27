// Runs the real window host (host.ps1) on Windows, against Notepad: CI's `windows-host` job runs this file only.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PowerShellHost } from "../src/walk/host.ts";
import { takeEditorShot } from "../src/walk/shot.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

test("the window host finds, fronts and shoots a real window at half size", async (t) => {
  const notepad = spawn("notepad.exe", [], { stdio: "ignore" });
  const host = new PowerShellHost();
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
  const dir = await mkdtemp(join(tmpdir(), "walk-host-"));
  const shot = await takeEditorShot(host, { app: "notepad.exe", dir, name: "notepad" });
  assert.deepEqual((await readFile(shot.path)).subarray(0, 4), PNG);
  assert.ok(Math.abs(shot.width - shot.window.width / 2) <= 1, `half width: ${shot.width} of ${shot.window.width}`);
  t.diagnostic(`tries ${shot.tries}, window ${shot.window.width}x${shot.window.height}`);
});

test("the window host says when no window of an executable is open", async (t) => {
  const host = new PowerShellHost();
  t.after(() => host.close());
  assert.deepEqual(await host.find("no-such-editor-here.exe"), { found: false });
});
