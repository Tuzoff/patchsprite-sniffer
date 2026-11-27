// Marked steps (S3) and the idle recording (S13), on top of a capture: every record goes through `record`, which
// flags what the quiet check leaves out, and a step is written when it starts and closed when the capture has gone
// quiet, so a step cut off mid-way shows as incomplete instead of vanishing.

import type { CaptureRecord, MidiRecord, StepEnd, StepStart } from "@patchsprite/engine/capture";
import { setTimeout as sleep } from "node:timers/promises";
import { pollSetFrom, quietFlags, type QuietRules } from "./quiet.ts";

export interface Change {
  control: string;
  before: string;
  after: string;
}

const ARROW = /\s*(?:→|->)\s*/;
/**
 * The change an action's label names, "control: before → after" (`->` also taken), or undefined when it names
 * none: "Drive gain" alone doesn't say what changed, so the step is asked for again.
 */
export function parseLabel(label: string): Change | undefined {
  const colon = label.indexOf(":");
  if (colon <= 0) return undefined;
  const control = label.slice(0, colon).trim();
  const parts = label.slice(colon + 1).split(ARROW);
  if (!control || parts.length !== 2) return undefined;
  const [before, after] = parts.map((p) => p.trim());
  if (!before || !after) return undefined;
  return { control, before, after };
}

export const formatLabel = (c: Change): string => `${c.control}: ${c.before} → ${c.after}`;

export interface StepsOptions {
  write: (r: CaptureRecord) => void;
  rules?: QuietRules;
  now?: () => number;
  /** How long nothing counted must arrive before a step is over. Default 600 ms. */
  settleMs?: number;
  /** The longest a step waits to go quiet. Default 8 s. */
  maxMs?: number;
  /** How often the quiet check looks. */
  pollMs?: number;
}

export interface StepResult {
  id: number;
  status: StepEnd["status"];
  /** Counted messages in the step. */
  counted: number;
}

export class Steps {
  private readonly o: Required<Omit<StepsOptions, "rules">>;
  private rules: QuietRules;
  private nextId = 1;
  private open?: { start: StepStart; messages: MidiRecord[] };
  private lastCounted = 0;

  constructor(o: StepsOptions) {
    this.o = { now: Date.now, settleMs: 600, maxMs: 8000, pollMs: 50, ...o };
    this.rules = { ...o.rules };
  }

  /** The open step's kind, if one is open. */
  get openKind(): StepStart["kind"] | undefined {
    return this.open?.start.kind;
  }

  get quietRules(): QuietRules {
    return { ...this.rules, polls: [...(this.rules.polls ?? [])] };
  }

  /** Writes a record, flagging a message the quiet check doesn't count. */
  record = (r: CaptureRecord): void => {
    if (r.type === "midi") {
      let flags = quietFlags(r, this.rules);
      // everything the editor does while left alone is its poll set (S13)
      if (!flags.length && this.open?.start.kind === "idle") flags = ["poll"];
      if (flags.length) r = { ...r, flags };
      else this.lastCounted = Math.max(this.lastCounted, r.t);
      this.open?.messages.push(r);
    }
    this.o.write(r);
  };

  /**
   * Starts a step. An `action` must name its change ("Drive: off → on"), here or at its end; `change` states it
   * apart from the label.
   */
  begin(kind: StepStart["kind"], label: string, extra: { change?: Change; mode?: string; before?: string } = {}): number {
    if (this.open) throw new Error(`step ${this.open.start.id} is still open: end it first`);
    const change = extra.change ?? parseLabel(label);
    const start: StepStart = { type: "stepStart", t: this.o.now(), id: this.nextId, kind, label, ...(change ? { change } : {}), ...(extra.mode ? { mode: extra.mode } : {}), ...(extra.before ? { before: extra.before } : {}) };
    this.o.write(start);
    this.open = { start, messages: [] };
    return this.nextId++;
  }

  /**
   * Ends the open step once nothing counted has arrived for the settle time (or the longest wait has passed). An
   * action whose label never named its change is refused before anything is written: say what changed, then end it.
   */
  async end(extra: { label?: string; change?: Change; after?: string; note?: string; aborted?: boolean } = {}): Promise<StepResult> {
    const open = this.open;
    if (!open) throw new Error("no step is open");
    const change = extra.change ?? (extra.label ? parseLabel(extra.label) : undefined) ?? open.start.change;
    if (open.start.kind === "action" && !change && !extra.aborted) throw new Error(`say what changed, as "control: before → after" (the label was "${extra.label ?? open.start.label}")`);
    let status: StepEnd["status"] = "aborted";
    if (!extra.aborted) {
      const started = open.start.t;
      for (;;) {
        const now = this.o.now();
        if (now - Math.max(started, this.lastCounted) >= this.o.settleMs) {
          status = "quiet";
          break;
        }
        if (now - started >= this.o.maxMs) {
          status = "timeout";
          break;
        }
        await sleep(this.o.pollMs);
      }
    }
    const label = extra.label ?? (change && !open.start.change ? formatLabel(change) : undefined);
    const end: StepEnd = { type: "stepEnd", t: this.o.now(), id: open.start.id, status, ...(label ? { label } : {}), ...(change && !open.start.change ? { change } : {}), ...(extra.after ? { after: extra.after } : {}), ...(extra.note ? { note: extra.note } : {}) };
    this.o.write(end);
    this.open = undefined;
    return { id: open.start.id, status, counted: open.messages.filter((m) => !m.flags).length };
  }

  /**
   * Records the editor left alone for `ms` (about 10 s, S13) as an `idle` step, then adds what it saw to the poll set,
   * so later steps don't count it. Returns the signatures added.
   */
  async idle(ms = 10_000): Promise<string[]> {
    this.begin("idle", "editor idle");
    const messages = this.open!.messages;
    await sleep(ms);
    const set = pollSetFrom(messages);
    const polls = new Set([...(this.rules.polls ?? []), ...set]);
    this.rules = { ...this.rules, polls: [...polls] };
    // the step ends at once: its traffic is the poll set, none of which counted
    await this.end();
    return set;
  }
}
