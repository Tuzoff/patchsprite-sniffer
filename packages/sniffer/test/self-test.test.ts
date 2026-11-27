import assert from "node:assert/strict";
import { test } from "node:test";
import type { CaptureRecord, MidiRecord } from "@patchsprite/engine/capture";
import { judgeSelfTest, runSelfTest } from "../src/self-test.ts";
import { Steps } from "../src/steps.ts";

const midi = (bytes: string, dir: "in" | "out", flags?: MidiRecord["flags"]): MidiRecord => ({ type: "midi", t: Date.now(), dir, kind: "sysex", bytes, ...(flags ? { flags } : {}) });
const preset = { control: "Preset", before: "1", after: "2" };

test("traffic both ways passes; polls count, clock and active sensing don't", () => {
  assert.equal(judgeSelfTest([midi("f0 7d 01 12 01 f7", "out"), midi("f0 7d 01 31 f7", "in")]).ok, true);
  assert.equal(judgeSelfTest([midi("f0 7d 01 50 f7", "out", ["poll"]), midi("f0 7d 01 51 01 f7", "in", ["poll"])]).ok, true);
  const clockOnly = judgeSelfTest([midi("f0 7d 01 12 01 f7", "out"), midi("f8", "in", ["clock"]), midi("fe", "in", ["activeSensing"])]);
  assert.deepEqual([clockOnly.ok, clockOnly.out, clockOnly.in], [false, 1, 0]);
  assert.match(clockOnly.text, /nothing the device sent back/);
  assert.match(judgeSelfTest([]).text, /^The self-test saw no MIDI at all, so the capture can't see this editor's MIDI\./);
  assert.match(judgeSelfTest([midi("f0 f7", "in")]).text, /nothing the editor sent/);
});

test("the self-test is a selfTest step around the change", async () => {
  const out: CaptureRecord[] = [];
  const steps = new Steps({ write: (r) => out.push(r), settleMs: 30, pollMs: 5 });
  const r = await runSelfTest(steps, preset, async () => {
    steps.record(midi("f0 7d 01 12 01 f7", "out"));
    steps.record(midi("f0 7d 01 31 f7", "in"));
  });
  assert.equal(r.ok, true);
  assert.deepEqual(out.map((x) => x.type), ["stepStart", "midi", "midi", "stepEnd"]);
  assert.equal((out[0] as { kind: string }).kind, "selfTest");
  assert.equal((out[0] as { label: string }).label, "Preset: 1 → 2");
});

test("a change that can't be made aborts the step and passes the error on", async () => {
  const out: CaptureRecord[] = [];
  const steps = new Steps({ write: (r) => out.push(r), settleMs: 30, pollMs: 5 });
  await assert.rejects(runSelfTest(steps, preset, async () => { throw new Error("no editor window"); }), /no editor window/);
  assert.deepEqual(out.at(-1), { type: "stepEnd", t: (out.at(-1) as { t: number }).t, id: 1, status: "aborted", note: "the change could not be made: no editor window" });
});
