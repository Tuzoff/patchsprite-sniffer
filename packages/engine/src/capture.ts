// Captures (docs/formats/capture.md): what the sniffer records while a vendor editor talks to a device. One session
// per file, JSON Lines: a header line, then one record per line, so a long session streams to disk and a cut-off file
// still reads up to its last whole line. A capture holds wire bytes, the session's own events and the user's step
// labels only (S5, S7). Like a seed patch, a capture file is as private as the device it came from; this repository
// holds the format and made-up examples only.

import { z } from "zod";

export const CAPTURE_FORMAT = "patchsprite-capture";
export const CAPTURE_VERSION = 1;

/** One line is at most this many characters: a 64 KiB SysEx message as spaced hex, plus room for its fields. */
export const MAX_LINE_CHARS = 256 << 10;
const MAX_FRAME_CHARS = 3 * (64 << 10);
const MAX_TEXT = 1024;
const MAX_LABEL = 200;
const MAX_PORTS = 64;

const hexBytes = z.string().max(MAX_FRAME_CHARS).regex(/^[0-9a-f]{2}( [0-9a-f]{2})*$/, "bytes are lowercase hex pairs separated by single spaces");
const time = z.iso.datetime({ offset: true });
/** Milliseconds since the Unix epoch, on the capturing computer's clock; fractions allowed. */
const ms = z.number().finite().nonnegative();
const text = z.string().min(1).max(MAX_TEXT);
const u16 = z.number().int().min(0).max(0xffff);
const stepId = z.number().int().min(1).max(1_000_000);
const portName = z.string().min(1).max(256);

// ---- header -------------------------------------------------------------------------------------------------------

export const CaptureHeaderSchema = z.strictObject({
  type: z.literal("header"),
  format: z.literal(CAPTURE_FORMAT),
  version: z.literal(CAPTURE_VERSION),
  /** Random, unique per session: evidence (a seed patch's capture file) names the session by it. */
  session: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, "a session id is a lowercase UUID"),
  startedAt: time,
  tool: z.strictObject({ name: z.string().min(1).max(64), version: z.string().min(1).max(64) }),
  os: z.strictObject({ platform: z.enum(["win32", "darwin", "linux"]), release: z.string().min(1).max(64) }),
  /** The capture method: `frida-winmm` hooks the editor's WinMM calls (Windows). */
  method: z.enum(["frida-winmm"]),
  device: z
    .strictObject({
      usb: z.strictObject({ vid: u16, pid: u16 }).optional(),
      /** The MIDI port names exactly as the OS shows them; the map builder writes the map's bare port name from them. */
      ports: z.strictObject({ in: z.array(portName).max(MAX_PORTS), out: z.array(portName).max(MAX_PORTS) }).optional(),
    })
    .optional(),
  editor: z.strictObject({
    /** The executable the capture attached to, as the OS names it. */
    exe: z.string().min(1).max(260),
    /** The editor's version as it reports it, when it does. */
    version: z.string().min(1).max(64).optional(),
  }),
  note: text.optional(),
});

// ---- records ------------------------------------------------------------------------------------------------------

/**
 * Why a message doesn't count as a step's traffic: the step is over once nothing else arrives for a while. Flagged
 * messages stay in the capture; nothing is ever dropped.
 */
export const MIDI_FLAGS = ["clock", "activeSensing", "short", "poll"] as const;

export const MidiRecordSchema = z.strictObject({
  type: z.literal("midi"),
  /** When the hook saw it (`hookT`, the editor's own clock read inside the hook) and when it was written. */
  t: ms,
  hookT: ms.optional(),
  /** `out`: the editor to the device. `in`: the device to the editor. */
  dir: z.enum(["in", "out"]),
  /** `sysexError`: the driver flagged the buffer as incomplete or invalid (MIM_LONGERROR and the like). */
  kind: z.enum(["sysex", "short", "sysexError", "shortError"]),
  bytes: hexBytes,
  /** The MIDI handle the editor used, as the hook saw it, so two ports in one session are told apart. */
  port: z.string().min(1).max(32).optional(),
  flags: z.array(z.enum(MIDI_FLAGS)).max(MIDI_FLAGS.length).optional(),
});

export const EventRecordSchema = z.strictObject({
  type: z.literal("event"),
  t: ms,
  /**
   * `attached`/`detached`: the capture attached to or lost the editor (it re-attaches after a restart).
   * `portOpen`/`portClose`: the editor opened or closed a MIDI port. `info`, `warning`, `error`: the sniffer's own notes.
   */
  kind: z.enum(["attached", "detached", "portOpen", "portClose", "info", "warning", "error"]),
  dir: z.enum(["in", "out"]).optional(),
  port: z.string().min(1).max(32).optional(),
  /** The OS's index of the port the editor opened. */
  device: z.number().int().min(0).max(255).optional(),
  pid: z.number().int().min(0).optional(),
  text: text.optional(),
});

/**
 * `action`: one labelled change the editor makes (S3). `idle`: the editor left alone, so what it sends is its poll set
 * (S13). `selfTest`: the session's opening check (S15). `manual`: a step the user performs by hand while the capture
 * runs, for what automation can't do.
 */
export const STEP_KINDS = ["action", "idle", "selfTest", "manual"] as const;

/** The change a label names: "Drive gain: 5 → 6". */
const ChangeSchema = z.strictObject({ control: z.string().min(1).max(MAX_LABEL), before: z.string().max(MAX_LABEL), after: z.string().max(MAX_LABEL) });

export const StepStartSchema = z.strictObject({
  type: z.literal("stepStart"),
  t: ms,
  id: stepId,
  kind: z.enum(STEP_KINDS),
  label: z.string().min(1).max(MAX_LABEL),
  change: ChangeSchema.optional(),
  /** Screenshot file names beside the capture, never paths. */
  before: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/).optional(),
});

export const StepEndSchema = z.strictObject({
  type: z.literal("stepEnd"),
  t: ms,
  id: stepId,
  /** `quiet`: nothing counted arrived for the settle time. `timeout`: it never went quiet. `aborted`: stopped early. */
  status: z.enum(["quiet", "timeout", "aborted"]),
  /** The label again when it changed at the end (the after-value is known only then). */
  label: z.string().min(1).max(MAX_LABEL).optional(),
  change: ChangeSchema.optional(),
  after: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/).optional(),
  note: text.optional(),
});

export const EndRecordSchema = z.strictObject({
  type: z.literal("end"),
  t: ms,
  reason: z.enum(["stopped", "selfTestFailed", "error"]),
  text: text.optional(),
});

export const CaptureRecordSchema = z.discriminatedUnion("type", [MidiRecordSchema, EventRecordSchema, StepStartSchema, StepEndSchema, EndRecordSchema]);

export type CaptureHeader = z.infer<typeof CaptureHeaderSchema>;
export type MidiRecord = z.infer<typeof MidiRecordSchema>;
export type EventRecord = z.infer<typeof EventRecordSchema>;
export type StepStart = z.infer<typeof StepStartSchema>;
export type StepEnd = z.infer<typeof StepEndSchema>;
export type EndRecord = z.infer<typeof EndRecordSchema>;
export type CaptureRecord = z.infer<typeof CaptureRecordSchema>;

// ---- reading ------------------------------------------------------------------------------------------------------

export interface CaptureIssue {
  /** 1-based line number in the file. */
  line: number;
  message: string;
}

/** A step as read back: its records, and whether it ended (a step cut off mid-way has no end). */
export interface Step {
  start: StepStart;
  end?: StepEnd;
  /** Line of its start record. */
  line: number;
}

export interface Capture {
  header: CaptureHeader;
  records: CaptureRecord[];
  steps: Step[];
  /** The session's end record; missing when the capture was cut off. */
  end?: EndRecord;
  /** A last line with no newline, cut off mid-write: left out, not an error. */
  truncated: boolean;
}

export type CaptureResult = { ok: true; capture: Capture } | { ok: false; issues: CaptureIssue[] };

function zodIssues(line: number, error: z.ZodError): CaptureIssue[] {
  return error.issues.map((i) => ({ line, message: i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message }));
}

/**
 * Reads a whole capture from its text. Checks every line against the schema and the rules across lines: the header
 * comes first and only once; steps don't overlap, and each has a unique id; a step's end follows its start; nothing
 * follows the end record. A last line with no newline is a write cut off by a crash and is left out.
 */
export function parseCapture(source: string): CaptureResult {
  const lines = source.split("\n");
  let truncated = false;
  if (lines.at(-1) === "") lines.pop();
  else if (lines.length > 0) {
    lines.pop();
    truncated = true;
  }
  const reader = new CaptureReader();
  lines.forEach((l, i) => reader.line(l.endsWith("\r") ? l.slice(0, -1) : l, i + 1));
  return reader.finish(truncated);
}

/** Reads a capture line by line, for a file too long to hold as one string. */
export class CaptureReader {
  private header?: CaptureHeader;
  private readonly records: CaptureRecord[] = [];
  private readonly steps: Step[] = [];
  private readonly ids = new Set<number>();
  private open?: Step;
  private end?: EndRecord;
  private readonly issues: CaptureIssue[] = [];
  private lines = 0;

  line(text: string, line: number): void {
    // without a header nothing after it can be read, so the first line's issues are the only ones
    if (this.lines++ > 0 && !this.header) return;
    if (text.length > MAX_LINE_CHARS) return void this.issues.push({ line, message: `a line is at most ${MAX_LINE_CHARS} characters` });
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return void this.issues.push({ line, message: "not JSON" });
    }
    if (!this.header) {
      const h = CaptureHeaderSchema.safeParse(value);
      if (!h.success) {
        const type = (value as { type?: unknown } | null)?.type;
        return void this.issues.push(...(type === "header" ? zodIssues(line, h.error) : [{ line, message: "the first record is the header" }]));
      }
      this.header = h.data;
      return;
    }
    if (this.end) return void this.issues.push({ line, message: "nothing follows the end record" });
    const r = CaptureRecordSchema.safeParse(value);
    if (!r.success) {
      const type = (value as { type?: unknown } | null)?.type;
      return void this.issues.push(...(type === "header" ? [{ line, message: "a capture has one header" }] : zodIssues(line, r.error)));
    }
    const rec = r.data;
    if (rec.type === "stepStart") {
      if (this.open) this.issues.push({ line, message: `step ${rec.id} starts while step ${this.open.start.id} is open` });
      if (this.ids.has(rec.id)) this.issues.push({ line, message: `step id ${rec.id} is used twice` });
      this.ids.add(rec.id);
      this.open = { start: rec, line };
      this.steps.push(this.open);
    } else if (rec.type === "stepEnd") {
      if (!this.open || this.open.start.id !== rec.id) this.issues.push({ line, message: `step ${rec.id} ends but isn't open` });
      else if (rec.t < this.open.start.t) this.issues.push({ line, message: `step ${rec.id} ends before it starts` });
      else this.open.end = rec;
      this.open = undefined;
    } else if (rec.type === "end") this.end = rec;
    this.records.push(rec);
  }

  finish(truncated = false): CaptureResult {
    if (!this.header && this.issues.length === 0) this.issues.push({ line: 1, message: "the capture is empty" });
    if (this.issues.length > 0 || !this.header) return { ok: false, issues: this.issues };
    return { ok: true, capture: { header: this.header, records: this.records, steps: this.steps, end: this.end, truncated } };
  }
}

/**
 * The messages that belong to a step: those timed from its start to its end (to the next step's start, or the end of
 * the capture, for a step that was cut off). Steps are time ranges over the capture, so a message is never copied into
 * a step.
 */
export function stepMessages(capture: Capture, step: Step): MidiRecord[] {
  const from = step.start.t;
  const i = capture.steps.indexOf(step);
  const until = step.end?.t ?? capture.steps[i + 1]?.start.t ?? capture.end?.t ?? Infinity;
  return capture.records.filter((r): r is MidiRecord => r.type === "midi" && r.t >= from && r.t <= until);
}

/** Whether a message counts as a step's traffic: it has no flag. */
export const counts = (r: MidiRecord): boolean => !r.flags || r.flags.length === 0;

/** One record as a capture line, without its newline. */
export function captureLine(record: CaptureHeader | CaptureRecord): string {
  const parsed = record.type === "header" ? CaptureHeaderSchema.parse(record) : CaptureRecordSchema.parse(record);
  const s = JSON.stringify(parsed);
  if (s.length > MAX_LINE_CHARS) throw new Error(`a line is at most ${MAX_LINE_CHARS} characters`);
  return s;
}
