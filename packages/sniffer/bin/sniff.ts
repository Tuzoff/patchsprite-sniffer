#!/usr/bin/env node
// The sniffer's command line.
//
//   patchsprite-sniff capture --editor EXE --attach-delay SECONDS [--out FILE] [--note TEXT]
//
// Records a vendor editor's MIDI traffic with its device (S1) until Ctrl+C, into FILE (default
// capture-<time>.jsonl in this folder; never an existing file). EXE is the editor's executable file name, as the OS
// names its process ("Editor.exe"); the session waits for it to start, attaches SECONDS after it appears, and
// attaches again whenever it restarts. It sends nothing to the device (S2). Windows only today (S8).
// Exit codes: 0 stopped, 2 usage, 4 could not capture.

import { parseArgs } from "node:util";
import { CaptureSession, type FridaDevice } from "../src/capture-session.ts";
import { CaptureWriter } from "../src/capture-writer.ts";
import { captureHeader, defaultCaptureName } from "../src/header.ts";

const USAGE = "usage: patchsprite-sniff capture --editor EXE --attach-delay SECONDS [--out FILE] [--note TEXT]";
const fail = (code: number, text: string): never => {
  console.error(text);
  process.exit(code);
};

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "--help" || cmd === "help") {
  console.log(USAGE);
  process.exit(0);
}
if (cmd !== "capture") fail(2, USAGE);

let values: { editor?: string; "attach-delay"?: string; out?: string; note?: string; help?: boolean };
try {
  ({ values } = parseArgs({ args: rest, options: { editor: { type: "string" }, "attach-delay": { type: "string" }, out: { type: "string" }, note: { type: "string" }, help: { type: "boolean" } }, strict: true }));
} catch (e) {
  fail(2, `${(e as Error).message}\n${USAGE}`);
}
if (values!.help) {
  console.log(USAGE);
  process.exit(0);
}
const { editor, out, note } = values!;
const delay = Number(values!["attach-delay"]);
if (!editor || values!["attach-delay"] === undefined || !Number.isFinite(delay) || delay < 0 || delay > 60) fail(2, USAGE);
if (process.platform !== "win32") fail(4, "Capturing needs Windows today: the frida-winmm method hooks the editor's Windows MIDI calls.");

let frida: { getLocalDevice(): Promise<FridaDevice> };
try {
  frida = (await import("frida")).default;
} catch {
  fail(4, "Frida's Node bindings aren't installed: run npm install in the sniffer's folder.");
}
let header;
try {
  header = captureHeader({ editorExe: editor!, note });
} catch (e) {
  fail(2, (e as Error).message);
}
const path = out ?? defaultCaptureName(header!);
let writer: CaptureWriter;
try {
  writer = new CaptureWriter(path, header!);
} catch (e) {
  fail(4, `Could not create ${path}: ${(e as Error).message}`);
}
const stop = new AbortController();
for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"] as const) process.on(sig, () => stop.abort());
const session = new CaptureSession({ device: await frida!.getLocalDevice(), editorExe: editor!, attachDelayMs: delay * 1000, write: (r) => writer.write(r) });
console.log(`Capturing to ${path}. Waiting for ${editor}; press Ctrl+C to stop.`);
let reason: "stopped" | "error" = "stopped";
try {
  await session.run(stop.signal);
} catch (e) {
  reason = "error";
  console.error(`The capture stopped: ${(e as Error).message}`);
}
writer!.write({ type: "end", t: Date.now(), reason });
writer!.close();
console.log(`Saved ${path}.`);
process.exit(reason === "stopped" ? 0 : 4);
