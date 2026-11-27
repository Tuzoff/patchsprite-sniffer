// The quiet check (S1, S13): which messages count as a step's traffic, so a step ends once the editor and the device
// have gone quiet. A device may stream MIDI clock and an editor may poll nonstop; those are flagged and kept in the
// capture, never dropped, and never keep a step waiting.

import type { MidiRecord } from "@patchsprite/engine/capture";

export interface QuietRules {
  /** Flag MIDI clock (F8). Default on. */
  clock?: boolean;
  /** Flag active sensing (FE). Default on. */
  activeSensing?: boolean;
  /**
   * Flag every other message of this many bytes or fewer as `short`. Default 3, for SysEx devices, whose editors
   * also send stray channel messages; 0 counts them all, for a device driven by channel messages alone.
   */
  shortMax?: number;
  /**
   * The editor's poll set: messages the editor sends by itself all the time, and the device's answers. Each is a byte
   * signature, spaced hex where `..` matches any byte, matching a message of exactly that length.
   */
  polls?: string[];
}

/** A message as a signature that matches exactly it. */
export const signature = (bytes: string): string => bytes;

function matches(sig: string, bytes: string): boolean {
  const a = sig.split(" ");
  const b = bytes.split(" ");
  return a.length === b.length && a.every((x, i) => x === ".." || x === b[i]);
}

/** The flags `r` gets under `rules`: empty when it counts. */
export function quietFlags(r: Pick<MidiRecord, "bytes">, rules: QuietRules = {}): NonNullable<MidiRecord["flags"]> {
  const { clock = true, activeSensing = true, shortMax = 3, polls = [] } = rules;
  const n = (r.bytes.length + 1) / 3;
  if (clock && r.bytes === "f8") return ["clock"];
  if (activeSensing && r.bytes === "fe") return ["activeSensing"];
  if (polls.some((p) => matches(p, r.bytes))) return ["poll"];
  if (n <= shortMax && r.bytes !== "f8" && r.bytes !== "fe") return ["short"];
  return [];
}

/**
 * The poll set an idle recording shows (S13): every message the editor sent while left alone, and every answer the
 * device gave, as signatures. The editor's messages are kept as sent, with any byte that differed between repeats as
 * `..`. The device's answers usually carry a changing value (a meter, the DSP load) even when seen once, so an answer
 * keeps only its first four bytes (a SysEx header and command, for most devices) and its closing F7, and its length.
 * Messages already flagged clock, active sensing or short are left out: the rules flag them anyway.
 */
export function pollSetFrom(idle: readonly MidiRecord[]): string[] {
  const out = new Set<string>();
  const groups = new Map<string, { dir: MidiRecord["dir"]; msgs: string[][] }>();
  for (const r of idle) {
    if (r.flags?.some((f) => f !== "poll")) continue;
    const b = r.bytes.split(" ");
    const key = `${r.dir}|${b.length}|${b.slice(0, 4).join(" ")}`;
    const g = groups.get(key) ?? { dir: r.dir, msgs: [] };
    g.msgs.push(b);
    groups.set(key, g);
  }
  for (const { dir, msgs } of groups.values()) {
    const keep = (x: string, i: number) => (dir === "in" ? i < 4 || (i === msgs[0].length - 1 && x === "f7") : true) && msgs.every((m) => m[i] === x);
    out.add(msgs[0].map((x, i) => (keep(x, i) ? x : "..")).join(" "));
  }
  return [...out].sort();
}
