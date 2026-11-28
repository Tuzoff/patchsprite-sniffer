// First contact with an untested device map: the read-only probe and the read-back pairs (the
// format doc, docs/formats/device-map.md). The probe sends each request the map marks `safeRead` once, under a cap on
// messages and time, and says of each whether the unit answered as the map claims. It never sends a write: a write's
// `readBack` only says which read can prove it later (the echo write). Nothing here knows a device; the framing is the
// caller's (a ProbeLink), and the results go where the caller records them.

import type { Observation, UnitChecks } from "./map-checks.ts";
import {
  ChoiceOpenError,
  cmdsOverlap,
  encodeLayout,
  parseHex,
  ProtocolError,
  resolveReadBack,
  type Encoded,
  type Field,
  type MessageLookup,
  type ProtocolCodec,
  type ReadBackPair,
} from "./protocol-schema.ts";

type Values = Record<string, unknown>;

/** How the unit met one safe read. */
export type ProbeOutcome =
  /** it answered, and the answer decodes with the codec's checks (sizes, consts, checksums, echoed fields) */
  | "shape-ok"
  /** it answered on the reply's cmd, but not as the map says */
  | "mismatch"
  /** no answer in time */
  | "silent"
  /** not sent: blocked, too risky on the map's word alone, left in doubt, past a cap, or the unit stopped answering */
  | "not-probed";

export interface ProbeEntry {
  /** the request's message name, as map checks name a message */
  entry: string;
  outcome: ProbeOutcome;
  /** for a mismatch or an entry not probed: why, in plain words */
  why?: string;
  /** for a mismatch: what came back, at most four messages, by cmd and size (never the payload, which may hold names) */
  observed?: { cmd: string; bytes: number }[];
  /** for an answer: how long it took, in ms */
  ms?: number;
  /** the unit stopped answering after this request: a possible freeze */
  froze?: boolean;
}

/** A write and whether a read can prove it: its read-back answered (readable), did not (unreadable), or it has none. */
export interface ProbeWrite {
  entry: string;
  readBack?: string;
  state: "readable" | "unreadable" | "no-read-back";
}

export interface ProbeReport {
  firmware?: string;
  /** every safe read on this firmware, in the map's order */
  entries: ProbeEntry[];
  /** every write on this firmware the map does not block */
  writes: ProbeWrite[];
  /** the entries a targeted sniffer walk should cover: what failed, what was not probed, and unreadable writes */
  walkPlan: { entry: string; why: string }[];
  /** the safe reads the map does not block on this firmware: what `summary` counts */
  reads: number;
  /**
   * ok: every one of those passed; partial: some did; nothing-decodes: none did, and some were answered wrongly or not
   * at all; not-checked: none could be judged (each skipped, a send failed, or no wait was long enough); no-safe-reads:
   * the map marks none this firmware may send
   */
  summary: "ok" | "partial" | "nothing-decodes" | "not-checked" | "no-safe-reads";
  /** why the probe stopped before the end, if it did */
  stopped?: string;
  /** messages sent, and the probe's length in ms */
  sent: number;
  ms: number;
  /** cmds (hex) the unit sent during the probe that no message of the map has, at most 16 */
  unknownCmds: string[];
  /**
   * The list-answered reads the probe sent and stopped waiting on before their end came (a heartbeat's too): they may
   * still be streaming, so the caller lets them run out before its next request. Left out when there are none.
   */
  listsLeft?: string[];
}

/** The probe's way to the unit: the caller frames and unframes. */
export interface ProbeLink {
  send(m: Encoded): Promise<void> | void;
  /** Every message the unit sends from now on, as the framing reads it (cmd as lowercase hex pairs). Returns a
   * function that stops listening. */
  listen(cb: (cmd: string, payload: Uint8Array) => void): () => void;
}

export interface ProbeOptions {
  /** at most this many messages sent (default 32); the check after an unanswered read may go one past it */
  maxMessages?: number;
  /** at most this long in all, in ms (default 20000) */
  maxMs?: number;
  /** a reply wait is the map's, but never longer than this, in ms (default 3000) */
  maxReplyMs?: number;
  /**
   * The unit's checks (the trust store): an entry it holds blocked or unsupported is not sent, and each outcome is
   * observed as it is known (see probeObservations).
   */
  checks?: Pick<UnitChecks, "observe" | "trust">;
  /**
   * Whether the unit answers a message the caller knows it does (the firmware read at connect, say): asked before the
   * first read, and after an unanswered read while no safe read has passed yet. Without it a unit that is off
   * from the start would have every read held against the map. Each call counts as one message.
   */
  alive?: () => Promise<boolean>;
}

const DEFAULTS = { maxMessages: 32, maxMs: 20_000, maxReplyMs: 3000 };
/** a reply wait when the map gives none */
const FALLBACK_REPLY_MS = 1000;
const MAX_UNKNOWN = 16;
const MAX_OBSERVED = 4;

// ---- read-back pairs ----------------------------------------------------------------------------------------------

/** The map as the codec sees it on one firmware, for the checks that resolve a read-back. */
function lookupOf(codec: ProtocolCodec): MessageLookup {
  return {
    message: (n) => (codec.hasMessage(n) ? codec.message(n) : undefined),
    payload: (n) => {
      try {
        return codec.payloadLayout(n);
      } catch {
        return undefined;
      }
    },
  };
}

/** A write's read-back on this firmware, or undefined when the map gives it none. A map that loaded has a sound one. */
export function readBackPair(codec: ProtocolCodec, write: string): ReadBackPair | undefined {
  const r = resolveReadBack(write, lookupOf(codec));
  if (r.problems.length) throw new ProtocolError(r.problems.join("; "));
  return r.pair;
}

function pairOrThrow(codec: ProtocolCodec, write: string): ReadBackPair {
  const pair = readBackPair(codec, write);
  if (!pair) throw new ProtocolError(`"${write}" has no read-back in the device map`);
  return pair;
}

/** The read that reads back a write: its request fields filled from the write's values. Refused like any encode. */
export function readBackRequest(codec: ProtocolCodec, write: string, writeValues: Values): { encoded: Encoded; fields: Values } {
  const pair = pairOrThrow(codec, write);
  const fields: Values = {};
  for (const i of pair.inputs) if (Object.hasOwn(writeValues, i.send)) fields[i.request] = writeValues[i.send];
  return { encoded: codec.encode(pair.request, fields), fields };
}

/**
 * Whether the read-back's decoded reply shows what the write set; each difference by the write's field name. Both
 * sides are compared as the write's field puts them on the wire (an enum key or its number, a saturating value clamped,
 * a scaled one rounded as sent), so a value the unit stores exactly as written never reads as a difference.
 */
export function compareReadBack(codec: ProtocolCodec, write: string, writeValues: Values, reply: Values): { same: boolean; diffs: { field: string; wrote: unknown; read: unknown }[] } {
  const pair = pairOrThrow(codec, write);
  const diffs = pair.compare
    .filter((c) => {
      const f = codec.field(write, c.send);
      // the reply's enum keys are its own field's
      return !sameDecoded(wireValue(codec, f, writeValues[c.send]), wireValue(codec, f, reply[c.reply], codec.field(pair.reply, c.reply)));
    })
    .map((c) => ({ field: c.send, wrote: writeValues[c.send], read: reply[c.reply] }));
  return { same: diffs.length === 0, diffs };
}

/**
 * The write that sets again what the read-back reports (the echo write): its inputs from the read's request fields,
 * its compared fields from the reply. Sending it changes nothing on the unit when the map is right.
 */
export function echoWrite(codec: ProtocolCodec, write: string, readFields: Values, reply: Values): Values {
  const pair = pairOrThrow(codec, write);
  const out: Values = {};
  for (const i of pair.inputs) out[i.send] = readFields[i.request];
  for (const c of pair.compare) out[c.send] = reply[c.reply];
  return out;
}

/**
 * A decoded value as a scalar field writes it: enum keys (of `keys`, the field it was decoded with) as their numbers,
 * clamped where the field saturates, scale and bias applied and rounded.
 */
function wireValue(codec: ProtocolCodec, f: Field, v: unknown, keys: Field = f): unknown {
  if (f.type === "bytes" || f.type === "string") {
    // the bytes the field writes: a string cut and NUL-padded, short bytes filled (given as bytes, hex or a number
    // list), every element of a repeated field, as encode puts them
    try {
      return encodeLayout({ fields: [{ ...f, name: "v", offset: 0 }] }, { v }, { endian: codec.protocol.transport.endian, enums: codec.enums });
    } catch {
      return v;
    }
  }
  if (Array.isArray(v)) return v.map((x) => wireValue(codec, f, x, keys));
  if (f.type === "pad") return v;
  let n = v;
  if (typeof v === "boolean") n = v ? 1 : 0;
  const e = keys.type === "pad" || keys.type === "bytes" || keys.type === "string" ? undefined : keys.enum;
  if (typeof v === "string" && e !== undefined) {
    try {
      n = codec.enumValue(e, v);
    } catch {
      return v;
    }
  }
  if (typeof n !== "number") return n;
  const clamped = f.saturate ? Math.max(f.min ?? -Infinity, Math.min(f.max ?? Infinity, n)) : n;
  const x = clamped * (f.scale ?? 1) + (f.bias ?? 0);
  return f.type === "f32" ? Math.fround(x) : Math.round(x);
}

function sameDecoded(a: unknown, b: unknown): boolean {
  if (a instanceof Uint8Array && b instanceof Uint8Array) return a.length === b.length && a.every((x, i) => x === b[i]);
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => sameDecoded(x, b[i]));
  return a === b;
}

// ---- the probe ----------------------------------------------------------------------------------------------------

/** The safe reads on this firmware, in the map's order. */
export function safeReads(codec: ProtocolCodec): string[] {
  return codec.messageNames().filter((n) => codec.message(n).dir === "request" && codec.message(n).safeRead !== undefined);
}

/**
 * The read a driver asks for a sign of life (after a lost reply, or to confirm a freeze): the first request the map
 * marks `safeRead` that one reply answers and that needs no fields. Undefined when the map marks none: the driver then
 * asks the MIDI identity request, where the map has `identity`.
 */
export function livenessRead(codec: ProtocolCodec): string | undefined {
  return safeReads(codec).find((n) => {
    if (codec.message(n).reply?.list) return false;
    try {
      codec.encode(n, {});
      return true;
    } catch {
      return false;
    }
  });
}

/** The writes on this firmware: sends, and requests that are not safe reads. */
function writes(codec: ProtocolCodec): string[] {
  return codec.messageNames().filter((n) => {
    const m = codec.message(n);
    return m.dir === "send" || (m.dir === "request" && m.safeRead === undefined);
  });
}

/**
 * Sources that show a message is what the unit itself does (seen in the editor's traffic, reported by the unit, read
 * back or replayed on one), not only what a document says.
 */
const SEEN_ON_A_UNIT = new Set(["wire", "device-reported", "read-back", "replay-verified", "test"]);

/**
 * Why a safe read is too risky to send on first contact, or undefined. A read whose cmd a write of the map also uses
 * (a get and a set told apart only by a sentinel value, say) turns into that write if the map has the sentinel wrong,
 * so it is sent only where the map's `source` says the read was seen on a unit, never on a document's word alone.
 */
function riskyRead(codec: ProtocolCodec, name: string, allWrites: string[]): string | undefined {
  const m = codec.message(name);
  if (m.source && SEEN_ON_A_UNIT.has(m.source.kind)) return undefined;
  const shared = allWrites.filter((w) => cmdsOverlap(codec.message(w).cmd, m.cmd));
  if (!shared.length) return undefined;
  return `it shares its cmd with ${shared.join(", ")}, and the map's source does not show it was seen as a read on a unit`;
}

function encodeSafeRead(codec: ProtocolCodec, name: string): Encoded {
  const s = codec.message(name).safeRead!;
  return s === true ? codec.encode(name) : codec.encode(name, s.fields ?? {}, s.args ?? {});
}

interface Heard {
  cmd: string;
  payload: Uint8Array;
  /** the map's messages on this cmd */
  names: string[];
}

/** What one request drew from the unit. */
type Answer =
  | { outcome: "shape-ok"; ms: number }
  | { outcome: "mismatch"; ms: number; why: string; observed: Heard[] }
  /** cut: the probe's caps made the wait shorter than the map's, so the silence proves nothing */
  | { outcome: "silent"; cut: boolean }
  /** the link could not send it: the way to the unit failed, which says nothing about the map */
  | { outcome: "unsent"; why: string };

/**
 * Sends each safe read once, in the map's order, and waits for its answer. A read the map's open choices leave in
 * doubt is tried again at the end, once the others may have settled them. After a read goes unanswered, the last read
 * that passed is sent again: if that goes unanswered too, the unit has stopped answering, and the probe stops
 * there, sending nothing more. Nothing is retried on its own.
 */
export async function runProbe(codec: ProtocolCodec, link: ProbeLink, options: ProbeOptions = {}): Promise<ProbeReport> {
  const o = { ...DEFAULTS, ...options };
  const started = Date.now();
  const entries = new Map<string, ProbeEntry>();
  const unknown = new Set<string>();
  let sent = 0;
  let stopped: string | undefined;
  let heartbeat: string | undefined;
  /** lists sent whose end has not come, by how many are still streaming (a heartbeat may send one again): what the
   * caller must let run out */
  const listsLeft = new Map<string, number>();
  const leave = (name: string, by: 1 | -1) => {
    const n = (listsLeft.get(name) ?? 0) + by;
    if (n > 0) listsLeft.set(name, n);
    else listsLeft.delete(name);
  };
  // every message the unit sends goes to the current wait, if any
  let onHeard: ((h: Heard) => void) | undefined;
  const stop = link.listen((cmd, payload) => {
    const names = codec.messagesForCmd(parseHex(cmd));
    if (!names.length && unknown.size < MAX_UNKNOWN) unknown.add(cmd);
    onHeard?.({ cmd, payload, names });
  });

  const finish = (e: ProbeEntry) => {
    entries.set(e.entry, e);
    for (const ob of probeObservations(e)) o.checks?.observe(ob);
  };
  const capReached = (): string | undefined => {
    if (sent >= o.maxMessages) return `the probe's cap of ${o.maxMessages} messages was reached`;
    if (Date.now() - started >= o.maxMs) return `the probe's cap of ${o.maxMs} ms was reached`;
    return undefined;
  };

  /** Send one request and wait for its answer, as the map pairs them. */
  const ask = async (name: string, encoded: Encoded): Promise<Answer> => {
    const m = codec.message(name);
    const replyName = codec.replyName(name);
    const list = m.reply?.list;
    const remaining = Math.max(0, o.maxMs - (Date.now() - started));
    const mapWait = m.reply?.timeoutMs ?? codec.timing.replyTimeoutMs ?? FALLBACK_REPLY_MS;
    const quiet = Math.min(mapWait, o.maxReplyMs, remaining);
    const deadline = Math.min(list?.deadlineMs ?? quiet, remaining);
    // a wait the probe cut short of the map's own (its reply ceiling or its time budget) proves no silence
    const cut = quiet < mapWait || (list !== undefined && deadline < list.deadlineMs);
    const isCmd = (h: Heard, message: string | undefined) => message !== undefined && h.names.includes(message);
    const t0 = Date.now();
    const bad: Heard[] = [];
    let firstWhy: string | undefined;
    let items = 0;
    let bytes = 0;
    let begun = list?.start === undefined;
    return new Promise<Answer>((resolve) => {
      let quietTimer: ReturnType<typeof setTimeout> | undefined;
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const done = (a: Answer) => {
        // once only: a send that fails after this wait ended must not unhook the next request's listener
        if (settled) return;
        settled = true;
        clearTimeout(quietTimer);
        clearTimeout(deadlineTimer);
        onHeard = undefined;
        resolve(a);
      };
      const timedOut = () => {
        if (bad.length) return done({ outcome: "mismatch", ms: Date.now() - t0, why: firstWhy!, observed: bad });
        // a list still streaming when the probe cut its wait short proves nothing either
        if (list && items && !cut) return done({ outcome: "mismatch", ms: Date.now() - t0, why: `the list sent ${items} items but never its end`, observed: [] });
        done({ outcome: "silent", cut });
      };
      const arm = () => {
        clearTimeout(quietTimer);
        quietTimer = setTimeout(timedOut, quiet);
      };
      const wrong = (h: Heard, why: string) => {
        firstWhy ??= why;
        if (bad.length < MAX_OBSERVED) bad.push(h);
      };
      onHeard = (h) => {
        if (list && isCmd(h, list.start)) {
          begun = true;
          return arm();
        }
        if (list && isCmd(h, list.end)) {
          if (!begun) return;
          leave(name, -1);
          if (bad.length) return done({ outcome: "mismatch", ms: Date.now() - t0, why: firstWhy!, observed: bad });
          if (items > list.maxItems) return done({ outcome: "mismatch", ms: Date.now() - t0, why: `the list ran past the map's ${list.maxItems} items`, observed: [] });
          if (bytes > list.maxBytes) return done({ outcome: "mismatch", ms: Date.now() - t0, why: `the list ran past the map's ${list.maxBytes} bytes`, observed: [] });
          return done({ outcome: "shape-ok", ms: Date.now() - t0 });
        }
        if (!isCmd(h, replyName)) return;
        const why = answerProblem(codec, encoded, replyName, h.payload);
        if (why === "another") return; // a late answer to another request: not this one's
        if (list) {
          begun = true;
          items++;
          bytes += h.payload.length;
          if (why) wrong(h, why);
          return arm();
        }
        if (why) return wrong(h, why);
        done({ outcome: "shape-ok", ms: Date.now() - t0 });
      };
      if (list) {
        deadlineTimer = setTimeout(timedOut, deadline);
        leave(name, 1);
      }
      arm();
      sent++;
      Promise.resolve()
        .then(() => link.send(encoded))
        .catch((e: Error) => {
          // once: a send that fails after its list ended (a slow link) must not take off another send's count
          if (list && !settled) leave(name, -1);
          done({ outcome: "unsent", why: `could not send it: ${e.message}` });
        });
    });
  };

  /** The caller's check that the unit is there, counted as one message; a failure is a no. */
  const alive = o.alive;
  const isAlive =
    alive &&
    (async (): Promise<boolean> => {
      sent++;
      try {
        return await alive();
      } catch {
        return false;
      }
    });

  const allWrites = writes(codec);
  /** One safe read's entry, or "retry" for one the map's open choices leave in doubt before the last pass. */
  const probe = async (name: string, last: boolean): Promise<ProbeEntry | "retry"> => {
    const skip = (why: string): ProbeEntry => ({ entry: name, outcome: "not-probed", why });
    if (codec.isBlocked(name)) return skip(`the map blocks it on firmware ${codec.firmware ?? "(any)"}`);
    const risky = riskyRead(codec, name, allWrites);
    if (risky) return skip(risky);
    const held = o.checks?.trust(name);
    if (held && (held.level === "blocked" || held.level === "unsupported")) return skip(`this unit holds it ${held.level}${held.why ? ` (${held.why})` : ""}`);
    // one it contradicted before (the read it froze on, say) is not sent again until the player retries it
    if (held?.level === "suspect") return skip(`this unit contradicted it before${held.why ? ` (${held.why})` : ""}; retry_map_entry turns it back on`);
    let encoded: Encoded;
    try {
      encoded = encodeSafeRead(codec, name);
    } catch (e) {
      if (e instanceof ChoiceOpenError && !last) return "retry";
      return skip(`it could not be encoded: ${(e as Error).message}`);
    }
    // the way to the unit failed, which says nothing about the map: the probe stops there
    const unsent = (why: string) => skip((stopped = why));
    const a = await ask(name, encoded);
    if (a.outcome === "unsent") return unsent(a.why);
    if (a.outcome === "shape-ok") {
      heartbeat = name;
      return { entry: name, outcome: "shape-ok", ms: a.ms };
    }
    if (a.outcome === "mismatch") {
      // it answered, but it is now held suspect: the heartbeat stays the last read that passed
      return { entry: name, outcome: "mismatch", why: a.why, ms: a.ms, observed: a.observed.map((h) => ({ cmd: h.cmd, bytes: h.payload.length })) };
    }
    if (a.cut) return skip(`no answer within the ${o.maxReplyMs} ms reply wait or ${o.maxMs} ms in all the probe allows, short of the map's own wait`);
    // unanswered: is the unit still there? The last read that passed tells, or the caller's own check; one message
    // past the cap, so a freeze at the cap is still told apart
    if (Date.now() - started < o.maxMs) {
      let gone = false;
      let again: Encoded | undefined;
      try {
        if (heartbeat !== undefined) again = encodeSafeRead(codec, heartbeat);
      } catch {
        // an answer since then reopened or contradicted a choice it depends on: the caller's check tells instead
      }
      if (heartbeat !== undefined && again) {
        const beat = await ask(heartbeat, again);
        if (beat.outcome === "unsent") return unsent(beat.why);
        gone = beat.outcome === "silent" && !beat.cut;
      } else if (isAlive) gone = !(await isAlive());
      if (gone) {
        stopped = `the unit stopped answering after ${name}`;
        return { entry: name, outcome: "silent", froze: true };
      }
    }
    return { entry: name, outcome: "silent" };
  };

  const reads = safeReads(codec);
  try {
    if (isAlive && reads.length && !(await isAlive())) stopped = "the unit did not answer before the probe began";
    const later: string[] = [];
    for (const pass of [reads, later]) {
      for (const name of pass) {
        const cap = stopped ? undefined : capReached();
        if (stopped || cap) {
          stopped ??= cap;
          finish({ entry: name, outcome: "not-probed", why: stopped! });
          continue;
        }
        const e = await probe(name, pass === later);
        if (e === "retry") later.push(name);
        else finish(e);
      }
    }
  } finally {
    onHeard = undefined;
    stop();
  }

  const ordered = reads.map((n) => entries.get(n)!);
  const passed = new Set(ordered.filter((e) => e.outcome === "shape-ok").map((e) => e.entry));
  // a read the map blocks on this firmware is no read of it
  const probed = reads.filter((n) => !codec.isBlocked(n));
  const judged = ordered.some((e) => e.outcome === "mismatch" || e.outcome === "silent");
  const ws: ProbeWrite[] = allWrites
    .filter((n) => !codec.isBlocked(n))
    .map((n) => {
      const pair = readBackPair(codec, n);
      if (!pair) return { entry: n, state: "no-read-back" };
      return { entry: n, readBack: pair.request, state: passed.has(pair.request) ? "readable" : "unreadable" };
    });
  const walkPlan = [
    ...ordered.filter((e) => e.outcome !== "shape-ok" && !(e.outcome === "not-probed" && codec.isBlocked(e.entry))).map((e) => ({ entry: e.entry, why: e.why ?? (e.froze ? "the unit stopped answering after it" : "no answer") })),
    ...ws.filter((w) => w.state === "unreadable").map((w) => ({ entry: w.entry, why: `its read-back ${w.readBack} did not pass` })),
  ];
  return {
    firmware: codec.firmware,
    entries: ordered,
    writes: ws,
    walkPlan,
    reads: probed.length,
    summary: !probed.length ? "no-safe-reads" : passed.size === probed.length ? "ok" : passed.size ? "partial" : judged ? "nothing-decodes" : "not-checked",
    ...(stopped ? { stopped } : {}),
    sent,
    ms: Date.now() - started,
    unknownCmds: [...unknown],
    ...(listsLeft.size ? { listsLeft: [...listsLeft.keys()] } : {}),
  };
}

/**
 * Why a message on the reply's cmd is not the answer the map describes, "another" for a well-formed answer to another
 * request (its echoed fields differ), or undefined for the answer. A reply the map's choices read is decoded with
 * them, which settles a choice from what the unit reports, as self-healing does.
 */
function answerProblem(codec: ProtocolCodec, sent: Encoded, replyName: string, payload: Uint8Array): string | undefined | "another" {
  let accepted: boolean;
  try {
    accepted = codec.acceptsReply(sent, payload);
  } catch (e) {
    return (e as Error).message;
  }
  try {
    codec.decode(replyName, payload);
  } catch (e) {
    // still in doubt between a choice's options: the shape is right, the choice stays open
    if (!(e instanceof ChoiceOpenError)) return accepted ? (e as Error).message : `${replyName} does not decode: ${(e as Error).message}`;
  }
  return accepted ? undefined : "another";
}

/**
 * A probe outcome as the trust store records it: an answer in the map's shape decodes (shape-ok); a wrong answer or
 * none contradicts at once; an entry not sent is skipped, logged only. A read the unit stopped answering after is held
 * suspect like any silence, never recorded as `froze`: as in freeze detection, a read is never pinned as a freeze,
 * since the probe can't tell a frozen unit from one unplugged or switched off, and `retry_map_entry` turns it back on.
 */
export function probeObservations(e: ProbeEntry): Observation[] {
  const base = { entry: e.entry, how: "probe" };
  if (e.outcome === "shape-ok") return [{ ...base, outcome: "decodes" }];
  if (e.outcome === "not-probed") return [{ ...base, outcome: "skipped", why: e.why }];
  if (e.outcome === "mismatch") return [{ ...base, outcome: "contradicts", strikes: 1, why: `it answered ${e.entry}, but not as the device map says: ${e.why}`, observed: { answers: e.observed } }];
  const why = e.froze ? `it stopped answering after ${e.entry}` : `it did not answer ${e.entry}`;
  return [{ ...base, outcome: "contradicts", strikes: 1, why, observed: { silent: true } }];
}
