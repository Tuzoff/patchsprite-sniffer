// The first write to an untested seed map, proven by an echo (first contact, step 5 of the design: "First write,
// proven by an echo"). A seed's write is never trusted on the word of its source: before the player's change goes out,
// the driver writes back the value the write's paired read has just returned, so the sound does not change, and reads
// again. An unchanged read-back proves the message and its framing; only then does the player's change go out, with
// the value read first kept to put back if the change reads back otherwise.
//
// The echo proves a message, never an encoding the map leaves open: a write whose encoding depends on a choice this
// unit has not settled is refused before the echo, so a wrong byte order can't read back right twice and pass. On a
// confirmed map that lists this unit's firmware as checked nothing here runs, and writes go out as before; on one that
// doesn't (a beta map), a write the map pairs with a read is echoed first too. Nothing here sends a message on its own:
// the driver gives it the steps.

import type { TrustLevel, UnitChecks } from "./map-checks.ts";
import { SafetyError } from "./safety.ts";

/** What a draft write may do: a change to the edit buffer, or something that outlives it. */
export type WriteKind = "change" | "store" | "reset" | "firmware";

/** What the gate needs to know about the map and this unit's evidence. */
export interface DraftTrust {
  /** True while the map is an unconfirmed seed: every write goes through the gate. False leaves writes as they were. */
  readonly draft: boolean;
  /**
   * True for a confirmed map that lists no check of this unit's firmware (a beta map no unit has verified): a write the
   * map pairs with a read is proven by an echo first, as on a draft, until this unit has verified it; one with no
   * read goes out as before (the status says to be ready to restart the unit). Refusals are as on a draft.
   */
  readonly unverified?: boolean;
  /**
   * With `unverified`: the unit is read-only in the beta (the remote server), so what an echo can't prove is refused
   * instead of going out as before: a write the map pairs with no read, and anything that outlives the edit buffer.
   * Each write opens on its own once the map pairs it with a read; nothing turns the whole unit writable, and no trust
   * level (verified or player-confirmed) opens a write the map pairs with no read.
   */
  readonly readOnly?: boolean;
  /** This unit's checks of the map: each entry's trust, and where the echo's outcome is recorded. */
  readonly checks: Pick<UnitChecks, "trust" | "observe">;
  /** Why the seed lists a write of this value to the entry as a hazard (by its source's word), or undefined. */
  hazard?(entry: string, value?: unknown): string | undefined;
}

/** How the gate lets a write go: at once, or after an echo proves it. */
export type Gate = "write" | "echo";

const PROVEN: ReadonlySet<TrustLevel> = new Set(["verified", "player-confirmed"]);

/** Why a level keeps a write off, in the player's words, where the trust store gives no why of its own. */
const OFF: Partial<Record<TrustLevel, string>> = {
  blocked: "the device map blocks it on this firmware",
  unsupported: "Patchsprite can't do that on this unit yet",
  suspect: "the unit contradicted the map there",
};

/**
 * A beta unit's refusal of a write no echo can prove. It names the same cause as the gate's other refusals on a beta
 * map (the map not checked on this firmware), so the chat gives one reason.
 */
export function readOnly(doing: string, why = "the map pairs no read with this change to check it lands"): SafetyError {
  return new SafetyError(
    `Patchsprite won't ${doing}: this unit is read-only in the beta for now. Its device map has not been checked on its firmware yet, and ${why}. Reading the unit and tone advice still work`,
  );
}

const KIND_TEXT: Record<Exclude<WriteKind, "change">, string> = {
  store: "store anything on the unit",
  reset: "reset the unit",
  firmware: "touch the unit's firmware",
};

/**
 * Whether a write may go out on this map, and how. `message` is the map's write message ("setParam") and `entry` the
 * claim it changes ("param/amp1/12"), which may be the same; `value` is the raw value written, for the hazard list. `readBack` says whether the map pairs the write with a
 * read the echo can use. A write the gate keeps off is refused with why, before anything is sent.
 */
export function gateWrite(
  trust: DraftTrust,
  w: { message: string; entry: string; value?: unknown; kind: WriteKind; readBack: boolean; doing: string },
): Gate {
  if (!trust.draft && !trust.unverified) return "write";
  // a confirmed map's stores and resets are as they were: only a draft keeps them off, and the beta's read-only units
  if (!trust.draft && w.kind !== "change") {
    if (trust.readOnly) throw readOnly(w.doing, `it doesn't ${KIND_TEXT[w.kind]} until then`);
    return "write";
  }
  const refuse = (why: string) =>
    new SafetyError(
      `Patchsprite won't ${w.doing} yet: ${why}. ${trust.draft ? "This unit's device map is new to Patchsprite and not confirmed on a unit" : "This unit's device map has not been checked on its firmware yet"}`,
    );
  if (w.kind !== "change") throw refuse(`it doesn't ${KIND_TEXT[w.kind]} until the map is confirmed`);
  for (const e of new Set([w.message, w.entry])) {
    const hazard = trust.hazard?.(e, w.value);
    if (hazard) throw refuse(`the map's source warns about it (${hazard})`);
    const { level, why } = trust.checks.trust(e);
    if (OFF[level]) throw refuse(why ? `${OFF[level]} (${why})` : OFF[level]!);
  }
  // read-only holds whatever this unit's checks say: only a read the map pairs with the write lifts it, never an entry a
  // player confirmed or a check made elsewhere
  if (!w.readBack && !trust.draft && trust.readOnly) throw readOnly(w.doing);
  if (PROVEN.has(trust.checks.trust(w.message).level)) return "write";
  if (!w.readBack && !trust.draft) return "write";
  if (!w.readBack) throw refuse("the map pairs no read with it, so Patchsprite can't check it lands without changing the sound, and it stays off until the map is confirmed");
  return "echo";
}

/** The steps of an echo, which the driver supplies: its paired read, the write, and how the two compare. */
export interface EchoSteps {
  /** The paired read now. */
  read(): Promise<Record<string, unknown>>;
  /** The write's values that put back what the read returned. */
  echoValues(read: Record<string, unknown>): Record<string, unknown>;
  /** Send the write with these values. */
  write(values: Record<string, unknown>): Promise<void>;
  /** Fields of a read that differ from what a write with these values should read as; empty when they agree. */
  diffs(values: Record<string, unknown>, read: Record<string, unknown>): string[];
  /** Whether an error is the unit going silent: then nothing more is sent, not even the undo (freeze detection's). */
  silent?(e: unknown): boolean;
  /** How long a unit may take to apply a write (ms): the undo's read-back is read again until then. Default 0. */
  settleMs?: number;
  /** The pause between those reads (ms). Default 50. */
  pauseMs?: number;
}

/** Values the write put back, kept to undo the player's change. */
export type Undo = Record<string, unknown>;

/**
 * Prove a write by an echo: read, write the same back, read again. Returns the values written, which put back the state
 * before the player's change. A read-back that differs is read once more before it counts: a value that has moved
 * again points to a hand on a knob, not to the map, so the change is refused and the message is left as it was. One that
 * holds still marks the message contradicted and refuses the change, saying the unit may have been changed on its own
 * meanwhile and that `retry_map_entry` checks again. What the echo wrote is in the edit buffer only, so reloading the
 * preset drops it. A unit that stops answering is left to freeze detection: the error passes through and nothing is
 * retried.
 */
export async function proveByEcho(trust: DraftTrust, message: string, steps: EchoSteps): Promise<Undo> {
  const read = await steps.read();
  const values = steps.echoValues(read);
  await steps.write(values);
  const readBack = await steps.read();
  const diffs = steps.diffs(values, readBack);
  if (diffs.length) {
    const why = `writing back what the unit reported (${message}) read back as ${diffs.join(", ")}`;
    const dropped = "Nothing is stored on the unit: reloading the preset drops what the check wrote";
    // read once more: a value still moving is a knob being turned on the unit, not a map's mistake
    if (steps.diffs(steps.echoValues(readBack), await steps.read()).length) {
      throw new Error(`${why}, and then moved again: the unit is being changed while Patchsprite checks it, so Patchsprite won't send the change and has not judged the map. Leave the unit alone and ask again. ${dropped}`);
    }
    trust.checks.observe({ entry: message, outcome: "contradicts", how: "echo", claimed: read, observed: readBack, why });
    throw new Error(
      `${why}, so Patchsprite won't send the change. ${dropped}. If the unit was changed on its own meanwhile (a knob turned), retry_map_entry checks it again`,
    );
  }
  // the echo proves the message and its framing: it never settles a choice (the write's must already be settled)
  trust.checks.observe({ entry: message, outcome: "confirms", how: "echo", claimed: read, observed: readBack });
  return values;
}

/**
 * One draft write at a time, from first send to its read-back, whoever asks: an echo and the change that follows are
 * one step, and a second write waits for both.
 */
export class DraftWriteQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(step: () => Promise<T>): Promise<T> {
    const next = this.tail.then(step, step);
    this.tail = next.catch(() => {});
    return next;
  }
}

/**
 * A write on a map that may be a draft: gated, proven by an echo where the gate asks for one, then the player's change.
 * A change that fails after it went out (its read-back differs, or no answer came) is undone with the values the echo
 * wrote, and the error says whether they read back. A refusal (a SafetyError) sent nothing, so there is nothing to undo.
 * On a confirmed map `change` runs as it is.
 */
export async function writeDraft<T>(
  trust: DraftTrust,
  queue: DraftWriteQueue,
  w: { message: string; entry: string; value?: unknown; kind: WriteKind; doing: string },
  steps: EchoSteps | undefined,
  change: () => Promise<T>,
): Promise<T> {
  if (!trust.draft && !trust.unverified) return change();
  return queue.run(async () => {
    // gated at its turn: a write ahead of it in the queue may have changed this unit's trust (an echo that differed)
    if (gateWrite(trust, { ...w, readBack: steps !== undefined }) === "write" || !steps) return change();
    const undo = await proveByEcho(trust, w.message, steps);
    try {
      return await change();
    } catch (e) {
      // a refusal sent nothing; a unit gone silent gets nothing more (freeze detection's to judge)
      if (e instanceof SafetyError || !(e instanceof Error) || steps.silent?.(e)) throw e;
      let lost: string | undefined;
      let silent = false;
      try {
        await steps.write(undo);
        if (!(await settled(steps, undo))) lost = "putting the old value back did not read back right either";
      } catch (e2) {
        silent = steps.silent?.(e2) ?? false;
        lost = `putting the old value back failed too (${e2 instanceof Error ? e2.message : String(e2)})`;
      }
      if (lost === undefined) {
        e.message += "; the old value is back (checked by read-back)";
        throw e;
      }
      e.message += `; ${lost}, so the unit may now hold neither value. Reload the preset on the unit (that drops unsaved changes) or check its screen before going on`;
      // neither value is known to be on the unit: the write is off until retried. A unit that went silent during the
      // undo is freeze detection's to judge, not the map's
      if (!silent) {
        trust.checks.observe({ entry: w.message, outcome: "contradicts", how: "echo", why: `${lost} after a change to ${w.message} failed` });
        e.message += "; Patchsprite won't send this again until it is retried";
      }
      throw e;
    }
  });
}

/** Read back until the unit shows these values or its time to apply a write has passed. */
async function settled(steps: EchoSteps, values: Undo): Promise<boolean> {
  const until = Date.now() + (steps.settleMs ?? 0);
  for (;;) {
    if (!steps.diffs(values, await steps.read()).length) return true;
    if (Date.now() >= until) return false;
    await new Promise((r) => setTimeout(r, steps.pauseMs ?? 50));
  }
}

/** The hazard lookup a map's `hazards` section gives: by entry, for every value or only the values it lists. */
export function mapHazards(hazards: Record<string, { why: string; values?: (number | string)[] }> | undefined): DraftTrust["hazard"] {
  return (entry, value) => {
    const h = hazards && Object.hasOwn(hazards, entry) ? hazards[entry] : undefined;
    if (!h) return undefined;
    return !h.values || h.values.some((v) => v === value) ? h.why : undefined;
  };
}
