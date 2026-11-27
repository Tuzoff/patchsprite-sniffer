import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseCapture } from "@patchsprite/engine/capture";
import { CaptureWriter } from "../src/capture-writer.ts";
import { captureHeader, defaultCaptureName } from "../src/header.ts";

const dir = () => mkdtempSync(join(tmpdir(), "sniff-capture-"));

test("a written capture reads back with parseCapture, and a crash mid-session leaves what came before", () => {
  const path = join(dir(), "c.jsonl");
  const w = new CaptureWriter(path, captureHeader({ editorExe: "AcmeEdit.exe", now: new Date("2026-11-27T08:00:00Z") }));
  w.write({ type: "event", t: 1, kind: "attached", pid: 7 });
  w.write({ type: "stepStart", t: 2, id: 1, kind: "action", label: "Drive: off → on" });
  w.write({ type: "midi", t: 3, dir: "out", kind: "sysex", bytes: "f0 7d 01 22 02 01 f7" });
  w.sync();
  // no close, no end: as after a crash
  const cut = parseCapture(readFileSync(path, "utf8"));
  assert.ok(cut.ok);
  assert.equal(cut.capture.end, undefined);
  assert.equal(cut.capture.steps[0].end, undefined, "the open step shows as incomplete");
  w.write({ type: "stepEnd", t: 4, id: 1, status: "quiet" });
  w.write({ type: "end", t: 5, reason: "stopped" });
  w.close();
  const r = parseCapture(readFileSync(path, "utf8"));
  assert.ok(r.ok, JSON.stringify(!r.ok && r.issues));
  assert.equal(r.capture.header.editor.exe, "AcmeEdit.exe");
  assert.equal(r.capture.end?.reason, "stopped");
  assert.throws(() => w.write({ type: "event", t: 6, kind: "info", text: "late" }), /closed/);
});

test("never overwrites a file, and refuses a record the format doesn't take before writing it", () => {
  const path = join(dir(), "c.jsonl");
  writeFileSync(path, "keep");
  assert.throws(() => new CaptureWriter(path, captureHeader({ editorExe: "AcmeEdit.exe" })), /EEXIST/);
  assert.equal(readFileSync(path, "utf8"), "keep");
  const p2 = join(dir(), "d.jsonl");
  const w = new CaptureWriter(p2, captureHeader({ editorExe: "AcmeEdit.exe" }));
  assert.throws(() => w.write({ type: "midi", t: 1, dir: "out", kind: "sysex", bytes: "F0" }));
  w.write({ type: "end", t: 2, reason: "stopped" });
  assert.throws(() => w.write({ type: "event", t: 3, kind: "info", text: "after end" }), /closed/);
  w.close();
  assert.equal(readFileSync(p2, "utf8").trimEnd().split("\n").length, 2);
});

test("the header names a file, never a path, and the default file name is safe on every OS", () => {
  assert.throws(() => captureHeader({ editorExe: "C:\\Users\\someone\\Editor.exe" }), /file name, not a path/);
  const h = captureHeader({ editorExe: "AcmeEdit.exe", now: new Date("2026-11-27T08:00:00.123Z") });
  assert.match(h.session, /^[0-9a-f-]{36}$/);
  assert.equal(h.tool.name, "patchsprite-sniffer");
  assert.match(defaultCaptureName(h), /^capture-2026-11-27T08-00-00-123Z-[0-9a-f]{8}\.jsonl$/);
});
