// The self-test that opens every session (S15): one control is changed in the editor (a preset or scene switch), and
// the capture must see traffic both ways. If it doesn't, the hook can't see this editor's MIDI, so the session stops
// and says so before any walk. Clock and active sensing prove nothing (a device streams them on its own), so they
// don't count; the editor's polls and their answers do, since they show the hook sees both directions.

import type { MidiRecord } from "@patchsprite/engine/capture";
import type { Change, Steps } from "./steps.ts";

export interface SelfTestResult {
  ok: boolean;
  out: number;
  in: number;
  /** What to tell the user. */
  text: string;
}

const proves = (m: MidiRecord) => !m.flags?.some((f) => f === "clock" || f === "activeSensing");

/** Judges a self-test step's messages. */
export function judgeSelfTest(messages: readonly MidiRecord[]): SelfTestResult {
  const seen = messages.filter(proves);
  const out = seen.filter((m) => m.dir === "out").length;
  const inn = seen.filter((m) => m.dir === "in").length;
  if (out && inn) return { ok: true, out, in: inn, text: `The capture sees the editor's MIDI both ways (${out} sent, ${inn} received).` };
  const missing = !out && !inn ? "no MIDI at all" : !out ? "nothing the editor sent" : "nothing the device sent back";
  return { ok: false, out, in: inn, text: `The self-test saw ${missing}, so the capture can't see this editor's MIDI. Check the editor is connected to the device and the capture attached to the right program, then start again.` };
}

/**
 * Runs the self-test as a `selfTest` step: `act` makes the change (a click, or the user's own hand), then the step
 * ends once the capture is quiet. A failed self-test is for the caller to end the session on (`end` reason
 * `selfTestFailed`).
 */
export async function runSelfTest(steps: Steps, change: Change, act: () => Promise<void>): Promise<SelfTestResult> {
  steps.begin("selfTest", `${change.control}: ${change.before} → ${change.after}`, { change });
  try {
    await act();
  } catch (e) {
    await steps.end({ aborted: true, note: `the change could not be made: ${(e as Error).message}`.slice(0, 1024) });
    throw e;
  }
  const r = await steps.end();
  return judgeSelfTest(r.messages);
}
