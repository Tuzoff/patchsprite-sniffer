import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { CaptureRecord, MidiRecord } from "@patchsprite/engine/capture";
import { pollSetFrom, quietFlags } from "../src/quiet.ts";
import { formatLabel, parseLabel, Steps } from "../src/steps.ts";

const midi = (bytes: string, dir: "in" | "out" = "out", t = Date.now()): MidiRecord => ({ type: "midi", t, dir, kind: bytes.length > 8 ? "sysex" : "short", bytes });

test("clock, active sensing and short messages are flagged; SysEx counts", () => {
  assert.deepEqual(quietFlags(midi("f8")), ["clock"]);
  assert.deepEqual(quietFlags(midi("fe")), ["activeSensing"]);
  assert.deepEqual(quietFlags(midi("b0 07 64")), ["short"]);
  assert.deepEqual(quietFlags(midi("f0 7d 01 22 02 01 f7")), []);
});

test("a device driven by channel messages alone keeps them counted (shortMax 0), clock still flagged", () => {
  const rules = { shortMax: 0 };
  assert.deepEqual(quietFlags(midi("b0 07 64"), rules), []);
  assert.deepEqual(quietFlags(midi("c0 05"), rules), []);
  assert.deepEqual(quietFlags(midi("f8"), rules), ["clock"]);
});

test("a poll signature matches its exact length, .. any byte", () => {
  const rules = { polls: ["f0 7d 01 51 .. f7"] };
  assert.deepEqual(quietFlags(midi("f0 7d 01 51 12 f7"), rules), ["poll"]);
  assert.deepEqual(quietFlags(midi("f0 7d 01 51 12 00 f7"), rules), []);
  assert.deepEqual(quietFlags(midi("f0 7d 01 52 12 f7"), rules), []);
});

test("the poll set of an idle recording: the editor's polls as sent, the device's changing answers with .. bytes", () => {
  const idle = [midi("f0 7d 01 50 f7"), midi("f0 7d 01 51 12 f7", "in"), midi("f8", "in"), midi("f0 7d 01 50 f7"), midi("f0 7d 01 51 17 f7", "in")];
  idle[2].flags = ["clock"];
  assert.deepEqual(pollSetFrom(idle), ["f0 7d 01 50 f7", "f0 7d 01 51 .. f7"]);
});

test("labels name their change as control: before → after", () => {
  assert.deepEqual(parseLabel("Drive gain: 5 → 6"), { control: "Drive gain", before: "5", after: "6" });
  assert.deepEqual(parseLabel("Amp: Clean -> Crunch"), { control: "Amp", before: "Clean", after: "Crunch" });
  for (const bad of ["Drive gain", "Drive gain: 6", ": 5 → 6", "Drive: → 6", "Drive: 5 → 6 → 7"]) assert.equal(parseLabel(bad), undefined, bad);
  assert.equal(formatLabel({ control: "Drive", before: "off", after: "on" }), "Drive: off → on");
});

function steps(o: { settleMs?: number; maxMs?: number } = {}) {
  const out: CaptureRecord[] = [];
  const s = new Steps({ write: (r) => out.push(r), settleMs: o.settleMs ?? 60, maxMs: o.maxMs ?? 2000, pollMs: 5 });
  return { s, out };
}

test("a step is written at its start, and ends once nothing counted has arrived for the settle time", async () => {
  const { s, out } = steps();
  s.begin("action", "Drive: off → on");
  assert.equal(out.length, 1, "the start is on disk before anything else");
  const ending = s.end();
  s.record(midi("f0 7d 01 22 02 01 f7"));
  // clock streams on, and doesn't keep the step open
  const clock = setInterval(() => s.record(midi("f8", "in")), 5);
  const r = await ending;
  clearInterval(clock);
  assert.equal(r.status, "quiet");
  assert.equal(r.counted, 1);
  assert.deepEqual(out[0], { type: "stepStart", t: (out[0] as { t: number }).t, id: 1, kind: "action", label: "Drive: off → on", change: { control: "Drive", before: "off", after: "on" } });
  assert.ok(out.some((x) => x.type === "midi" && x.bytes === "f8" && x.flags?.[0] === "clock"), "clock kept, flagged");
  assert.equal(out.at(-1)?.type, "stepEnd");
});

test("a step that never goes quiet ends at the longest wait, as a timeout", async () => {
  const { s } = steps({ settleMs: 40, maxMs: 120 });
  s.begin("action", "Drive: off → on");
  const busy = setInterval(() => s.record(midi("f0 7d 01 22 02 01 f7")), 5);
  const r = await s.end();
  clearInterval(busy);
  assert.equal(r.status, "timeout");
});

test("an action that never says what changed is refused at its end, and stays open to be ended again", async () => {
  const { s, out } = steps();
  s.begin("action", "Drive", { before: "00001-before.png" });
  await assert.rejects(s.end(), /say what changed, as "control: before → after" \(the label was "Drive"\)/);
  assert.equal(out.length, 1);
  const r = await s.end({ label: "Drive: off → on", after: "00001-after.png" });
  assert.equal(r.status, "quiet");
  assert.deepEqual(out.at(-1), { type: "stepEnd", t: (out.at(-1) as { t: number }).t, id: 1, status: "quiet", label: "Drive: off → on", change: { control: "Drive", before: "off", after: "on" }, after: "00001-after.png" });
});

test("steps don't overlap, and ids go up", async () => {
  const { s } = steps();
  assert.equal(s.begin("manual", "Reorder: amp, drive → drive, amp"), 1);
  assert.throws(() => s.begin("action", "x: 1 → 2"), /step 1 is still open/);
  await s.end({ aborted: true });
  assert.equal(s.begin("action", "x: 1 → 2"), 2);
  await assert.rejects(new Steps({ write: () => {} }).end(), /no step is open/);
});

test("the idle recording flags all its traffic as the poll set, and later steps don't count it", async () => {
  const { s, out } = steps();
  const idle = s.idle(80);
  await sleep(10);
  s.record(midi("f0 7d 01 50 f7"));
  s.record(midi("f0 7d 01 51 12 f7", "in"));
  await sleep(10);
  s.record(midi("f0 7d 01 51 33 f7", "in"));
  const set = await idle;
  assert.deepEqual(set, ["f0 7d 01 50 f7", "f0 7d 01 51 .. f7"]);
  assert.ok(out.filter((x) => x.type === "midi").every((x) => (x as MidiRecord).flags?.[0] === "poll"));
  assert.deepEqual(s.quietRules.polls, set);
  s.begin("action", "Drive: off → on");
  s.record(midi("f0 7d 01 51 44 f7", "in"));
  s.record(midi("f0 7d 01 22 02 01 f7"));
  const r = await s.end();
  assert.equal(r.counted, 1, "the poll answer doesn't count; the change does");
});

test("a step ends once: a second end while it waits is refused, and so is ending or beginning during the idle recording", async () => {
  const { s, out } = steps();
  s.begin("action", "Drive: off → on");
  const first = s.end();
  await assert.rejects(s.end(), /already ending/);
  assert.throws(() => s.begin("action", "x: 1 → 2"), /still ending/);
  await first;
  assert.equal(out.filter((x) => x.type === "stepEnd").length, 1);
  const idle = s.idle(40);
  await assert.rejects(s.end(), /idle recording ends on its own/);
  assert.throws(() => s.begin("action", "x: 1 → 2"), /idle recording is still running/);
  await idle;
  assert.equal(s.begin("action", "x: 1 → 2"), 3);
});

test("an answer seen once keeps its maker id and command, so another command's answer of the same length still counts", () => {
  const set = pollSetFrom([midi("f0 00 20 33 51 12 f7", "in")]);
  assert.deepEqual(set, ["f0 00 20 33 51 .. f7"]);
  assert.deepEqual(quietFlags(midi("f0 00 20 33 22 05 f7", "in"), { polls: set }), []);
  assert.deepEqual(quietFlags(midi("f0 00 20 33 51 40 f7", "in"), { polls: set }), ["poll"]);
});
