import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { FoundWindow, ShotResult, WindowHost } from "../src/walk/host.ts";
import { ShotError, shotFileName, shotToScreen, takeEditorShot } from "../src/walk/shot.ts";

const RECT = { left: 100, top: 50, width: 1600, height: 900 };

/** A fake window system: each shot call takes the next frame's luminance spread ("covered" = PrintWindow failed
 * and the editor wasn't safely in front). */
function fakeHost(frames: Array<number | "covered">, found = true) {
  const calls: string[] = [];
  const host: WindowHost = {
    async find(exe) {
      calls.push(`find ${exe}`);
      return found ? ({ found: true, hwnd: 7, pid: 42, rect: RECT, minimized: false } satisfies FoundWindow) : { found: false };
    },
    async front(hwnd) {
      calls.push(`front ${hwnd}`);
      return { front: true };
    },
    async shot(hwnd, path, scale, minSpread): Promise<ShotResult> {
      calls.push(`shot ${hwnd} ${scale} ${minSpread}`);
      const f = frames.shift() ?? 0;
      if (f === "covered") return { saved: false, spread: 0, rect: RECT };
      const width = Math.round(RECT.width * scale);
      await writeFile(path, `png ${f}`);
      return { saved: true, spread: f, source: "window", rect: RECT, width };
    },
    close() {},
  };
  return { host, calls };
}

const noSleep = async () => {};
const exists = (p: string) => access(p).then(() => true, () => false);

test("a shot brings the editor to the front first and saves it at half size", async () => {
  const dir = await mkdtemp(join(tmpdir(), "walk-shot-"));
  const { host, calls } = fakeHost([120]);
  const shot = await takeEditorShot(host, { exe: "Editor.exe", dir, name: "Amp block", sleep: noSleep });
  assert.deepEqual(calls, ["find Editor.exe", "front 7", "shot 7 0.5 16"]);
  assert.equal(shot.path, join(dir, "amp-block.png"));
  assert.equal(shot.width, 800);
  assert.equal(shot.height, 450);
  assert.equal(shot.scale, 0.5);
  assert.equal(shot.tries, 1);
  assert.deepEqual(shot.window, RECT);
});

test("a blank frame is retaken", async () => {
  const dir = await mkdtemp(join(tmpdir(), "walk-shot-"));
  const { host, calls } = fakeHost([0, 3, 90]);
  const shot = await takeEditorShot(host, { exe: "Editor.exe", dir, name: "x", sleep: noSleep });
  assert.equal(shot.tries, 3);
  assert.equal(calls.filter((c) => c.startsWith("front")).length, 3);
  assert.equal(await readFile(shot.path, "utf8"), "png 90");
});

test("after the last blank try the shot is refused and the blank file removed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "walk-shot-"));
  const { host } = fakeHost([0, 0]);
  await assert.rejects(takeEditorShot(host, { exe: "Editor.exe", dir, name: "x", tries: 2, sleep: noSleep }), (e: Error) => {
    assert.ok(e instanceof ShotError);
    assert.match(e.message, /blank/);
    return true;
  });
  assert.equal(await exists(join(dir, "x.png")), false);
});

test("a covered editor is never shot from the screen: the tool refuses", async () => {
  const dir = await mkdtemp(join(tmpdir(), "walk-shot-"));
  const { host } = fakeHost(["covered", "covered", "covered"]);
  await assert.rejects(takeEditorShot(host, { exe: "Editor.exe", dir, name: "x", sleep: noSleep }), /covered by another window/);
});

test("no editor window: a clear error, no shot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "walk-shot-"));
  const { host, calls } = fakeHost([100], false);
  await assert.rejects(takeEditorShot(host, { exe: "Editor.exe", dir, name: "x", sleep: noSleep }), /is the editor running/);
  assert.deepEqual(calls, ["find Editor.exe"]);
});

test("shot names are safe file names", () => {
  assert.equal(shotFileName("Scene 2 BPM: 120 → 122"), "scene-2-bpm-120-122.png");
  assert.equal(shotFileName("../../etc/passwd"), "etc-passwd.png");
  assert.throws(() => shotFileName("→ ←"), ShotError);
  assert.equal(shotFileName("a".repeat(100)).length, 64);
});

test("a point on a half-size shot maps back to the screen", () => {
  assert.deepEqual(shotToScreen({ window: RECT, scale: 0.5 }, 10, 20), { x: 120, y: 90 });
});

test("scale outside (0, 1] is refused", async () => {
  const { host } = fakeHost([100]);
  await assert.rejects(takeEditorShot(host, { exe: "e.exe", dir: tmpdir(), name: "x", scale: 2 }), /scale/);
});
