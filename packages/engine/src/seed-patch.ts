// Seed patches (docs/formats/seed-patch.md, a proposal until the first-contact work is built): the changes a unit's
// evidence makes to a seed map, one change per map entry, each with its own evidence, so each is reviewed, accepted or
// refused alone and the entries that passed keep their trust. The sniffer, the app and the cloud write and read this one
// format. It holds no device data of its own: whatever it says about a device is in a patch file, which is kept as
// privately as the capture it came from.

import { z } from "zod";
import { canonicalJson, fingerprint } from "./canonical-json.ts";

export const SEED_PATCH_FORMAT = "patchsprite-seed-patch";
export const SEED_PATCH_VERSION = 1;

/** A patch file is at most this many UTF-8 bytes. */
export const MAX_PATCH_BYTES = 4 << 20;
const MAX_CHANGES = 4096;
const MAX_OPS = 64;
const MAX_EVIDENCE = 64;
const MAX_FRAMES = 256;
const MAX_RECORDS = 4096;
const MAX_SOURCES = 256;
const MAX_TEXT = 1024;
/** One op's value, as canonical JSON. */
const MAX_VALUE_CHARS = 256 << 10;
/** One frame, as hex: 64 KiB of bytes. */
const MAX_FRAME_CHARS = 3 * (64 << 10);

const fp16 = z.string().regex(/^[0-9a-f]{16}$/, "a fingerprint is 16 lowercase hex digits");
const hexBytes = z.string().max(MAX_FRAME_CHARS).regex(/^[0-9a-f]{2}( [0-9a-f]{2})*$/, "bytes are lowercase hex pairs separated by single spaces");
const time = z.iso.datetime({ offset: true });
const text = z.string().min(1).max(MAX_TEXT);
const name = z.string().max(64).regex(/^[a-z][A-Za-z0-9]*$/, "names are camelCase");
const firmware = z.string().max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const sourceId = z.string().max(64).regex(/^[a-z0-9][a-z0-9-]*$/, "source ids are lowercase letters, digits and dashes");
const u16 = z.number().int().min(0).max(0xffff);

// ---- entries ------------------------------------------------------------------------------------------------------

/** Whole sections a change may cover as one entry. */
export const SECTION_ENTRIES = ["transport", "host", "identity", "driver", "safety", "blocked", "scratch", "audio", "display"] as const;
/** Kinds of entry written `<kind>/<name>`. */
export const NAMED_KINDS = ["choice", "layout", "enum", "constant", "control"] as const;
/** Words a map may not name a message, since they start other kinds of entry (parseEntry never reads them as one). */
export const RESERVED_WORDS: readonly string[] = [...SECTION_ENTRIES, ...NAMED_KINDS, "param", "setting"];

export type Entry =
  | { kind: "message"; message: string; block?: string }
  | { kind: "param"; block: string; id: number }
  | { kind: "setting"; id: string }
  | { kind: (typeof NAMED_KINDS)[number]; name: string }
  | { kind: "section"; section: (typeof SECTION_ENTRIES)[number] };

const NAME_RE = /^[a-z][A-Za-z0-9]*$/;
const BLOCK_RE = /^[a-z][A-Za-z0-9_]*$/;
const KEY_RE = /^[a-z][a-z0-9_]*$/;

/**
 * An entry name, as the app's map checks write it (docs/design/map-checks.md in the app) plus the kinds a patch also
 * needs: `<message>`, `<message>/<block>`, `param/<block>/<id>`, `choice/<name>`, then `layout/<name>`, `enum/<name>`,
 * `constant/<name>`, `control/<name>`, `setting/<id>` and the section names. Null when it is none of these.
 */
export function parseEntry(entry: string): Entry | null {
  if (entry.length > 160) return null;
  const parts = entry.split("/");
  const [head, a, b] = parts;
  if ((SECTION_ENTRIES as readonly string[]).includes(head)) return parts.length === 1 ? { kind: "section", section: head as (typeof SECTION_ENTRIES)[number] } : null;
  if ((NAMED_KINDS as readonly string[]).includes(head)) return parts.length === 2 && NAME_RE.test(a) ? { kind: head as (typeof NAMED_KINDS)[number], name: a } : null;
  if (head === "setting") return parts.length === 2 && KEY_RE.test(a) ? { kind: "setting", id: a } : null;
  if (head === "param") return parts.length === 3 && BLOCK_RE.test(a) && /^(0|[1-9]\d{0,4})$/.test(b) ? { kind: "param", block: a, id: Number(b) } : null;
  if (!NAME_RE.test(head) || head.length > 64) return null;
  if (parts.length === 1) return { kind: "message", message: head };
  return parts.length === 2 && BLOCK_RE.test(a) && a.length <= 64 ? { kind: "message", message: head, block: a } : null;
}

const FW = "$fw";

/**
 * Where an entry lives in a map, as JSON Pointer segment patterns: `*` matches any one segment and `$fw` the
 * firmware the evidence came from. A change's ops stay inside its entry's homes, and a firmware delta is written only
 * for the unit's own firmware.
 */
export function entryHomes(e: Entry): string[][] {
  switch (e.kind) {
    case "message":
      return [["messages", e.message], ["firmwares", FW, "messages", e.message]];
    case "param":
      return [["parameters", "groups", "*", "params", "*"]];
    case "setting":
      return [["settings", "items", "*"]];
    case "choice":
      return [["choices", e.name]];
    case "layout":
      return [["layouts", e.name], ["firmwares", FW, "layouts", e.name]];
    case "enum":
      return [["enums", e.name]];
    case "constant":
      return [["constants", e.name], ["firmwares", FW, "constants", e.name]];
    case "control":
      return [["controls", "items", e.name]];
    case "section":
      return e.section === "safety" || e.section === "blocked" ? [[e.section], ["firmwares", FW, e.section]] : [[e.section]];
  }
}

// ---- JSON Pointer (RFC 6901) ----------------------------------------------------------------------------------------

const pointer = z
  .string()
  .max(1024)
  .regex(/^(\/([^~/]|~[01])*)+$/, "a path is a JSON Pointer below the map's root, such as /messages/getPreset");

export const splitPointer = (p: string): string[] => p.slice(1).split("/").map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));

const underHome = (segs: string[], home: string[], fw: string) =>
  segs.length >= home.length && home.every((h, i) => h === "*" || (h === FW ? segs[i] === fw : segs[i] === h));

/** One path is the other or lies inside it. */
const overlaps = (a: string[], b: string[]) => {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false;
  return true;
};

// ---- the schema -----------------------------------------------------------------------------------------------------

const jsonValue = z.json().refine((v) => canonicalJson(v).length <= MAX_VALUE_CHARS, `a value is at most ${MAX_VALUE_CHARS} characters as JSON`);

/**
 * One edit to the map, a subset of JSON Patch (RFC 6902). `was` is the fingerprint of the value the edit replaces or
 * removes, so an edit made against another version of the entry is refused rather than applied blind. `add` writes
 * only where nothing is: a new object member, or `-` to append to an array.
 */
export const OpSchema = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("add"), path: pointer, value: jsonValue }),
  z.strictObject({ op: z.literal("replace"), path: pointer, value: jsonValue, was: fp16 }),
  z.strictObject({ op: z.literal("remove"), path: pointer, was: fp16 }),
]);
export type Op = z.infer<typeof OpSchema>;

const frame = z.strictObject({
  /** as the capture records it: `out` from the editor or app to the device, `in` from the device */
  dir: z.enum(["in", "out"]),
  bytes: hexBytes,
});

/** What the unit, the editor, the player or a document showed about the entry. */
export const EvidenceSchema = z.discriminatedUnion("kind", [
  /** traffic the sniffer recorded between the vendor editor and the unit */
  z.strictObject({
    kind: z.literal("capture"),
    source: sourceId,
    /** the labelled step (S3) */
    action: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/).optional(),
    label: text.optional(),
    /** record numbers in the capture file, counted from 0 */
    records: z.array(z.number().int().min(0)).max(MAX_RECORDS).optional(),
    /** the frames that show it, copied so the change can be reviewed without the capture */
    frames: z.array(frame).min(1).max(MAX_FRAMES).optional(),
  }),
  /** a read-only request sent once on first contact, and how its answer decoded against the seed */
  z.strictObject({
    kind: z.literal("probe"),
    at: time,
    request: name,
    sent: hexBytes,
    replies: z.array(hexBytes).max(MAX_FRAMES),
    /** shape-ok: decoded as the seed says; mismatch: answered, but not as the seed says; silent: no answer in time */
    result: z.enum(["shape-ok", "mismatch", "silent"]),
    /** the decoder's difference, such as "cmd 31 has one more byte than the seed says" */
    detail: text.optional(),
  }),
  /** a write, then a read of the same value */
  z.strictObject({
    kind: z.literal("read-back"),
    at: time,
    sent: hexBytes,
    readBack: hexBytes,
    result: z.enum(["match", "differs"]),
    /** the write sent back the value its paired read had just returned, so the sound did not change */
    echo: z.boolean(),
    detail: text.optional(),
  }),
  /** the rebuilt entry replayed on the unit (sniffer spec S18, "Verify before it goes live") */
  z.strictObject({ kind: z.literal("replay"), at: time, result: z.enum(["match", "differs"]), source: sourceId.optional(), detail: text.optional() }),
  /** a list the unit gave about itself when asked: blocks, a block's parameters, models (S17) */
  z.strictObject({
    kind: z.literal("device-list"),
    at: time,
    request: name,
    replies: z.array(hexBytes).min(1).max(MAX_RECORDS),
    source: sourceId.optional(),
  }),
  /** the player's answer where no read-back exists ("did the unit switch to preset 12?") */
  z.strictObject({ kind: z.literal("player"), at: time, question: text, answer: z.enum(["yes", "no", "unsure"]) }),
  /** the unit stopped answering after a send */
  z.strictObject({
    kind: z.literal("freeze"),
    at: time,
    sent: hexBytes,
    errorText: text.optional(),
    recovery: z.enum(["power-cycle", "replug", "none"]),
  }),
  /** a line of the app's map-check log (map-checks.md), less what the patch already says (map, firmware, entry) */
  z.strictObject({
    kind: z.literal("map-check"),
    at: time,
    fp: fp16,
    outcome: z.enum(["confirms", "settles", "reopens", "contradicts", "disagrees", "retried"]),
    claimed: z.json().optional(),
    observed: z.json().optional(),
    why: text.optional(),
  }),
  /** a vendor or third-party document; the weakest evidence, unconfirmed on a unit */
  z.strictObject({ kind: z.literal("doc"), citation: text, quote: text.optional() }),
]);
export type Evidence = z.infer<typeof EvidenceSchema>;

/**
 * What a change does to its entry. Edits: `add` (the entry is new), `repair` (it changes), `remove` (the unit has no
 * such thing). Marks, with no ops, for the unit's firmware: `confirm` (right as seeded), `suspect` (contradicted, no
 * fix yet; the re-walk's plan), `block` (never send it on this firmware).
 */
export const ACTIONS = ["add", "repair", "remove", "confirm", "suspect", "block"] as const;
export type Action = (typeof ACTIONS)[number];

/**
 * Where the entry's claim comes from once the change is in, the map's provenance words: `wire` (a capture),
 * `device-reported` (S17), `read-back` (the unit answered or read back as the map says), `replay-verified`,
 * `player-confirmed` (the player saw it happen), `doc`.
 */
export const SOURCES = ["wire", "device-reported", "read-back", "replay-verified", "player-confirmed", "doc"] as const;
export type Source = (typeof SOURCES)[number];

export const ChangeSchema = z.strictObject({
  /** unique in the patch, so a review can accept or refuse it by id */
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  entry: z.string().refine((e) => parseEntry(e) !== null, "not an entry name (see parseEntry)"),
  action: z.enum(ACTIONS),
  /** the entry's map-check fingerprint in the base map, null when the base has no such entry; only when the base loads */
  entryFp: fp16.nullable().optional(),
  source: z.enum(SOURCES).optional(),
  ops: z.array(OpSchema).min(1).max(MAX_OPS).optional(),
  evidence: z.array(EvidenceSchema).min(1).max(MAX_EVIDENCE),
  /** for the reviewer, never shown to the chat model */
  note: text.optional(),
});
export type Change = z.infer<typeof ChangeSchema>;

export const SeedPatchSchema = z.strictObject({
  format: z.literal(SEED_PATCH_FORMAT),
  version: z.literal(SEED_PATCH_VERSION),
  /** the seed map it changes, `<make>/<device>` as the map folder names it */
  map: z.string().max(129).regex(/^[a-z0-9][a-z0-9-]{0,63}\/[a-z0-9][a-z0-9.-]{0,63}$/),
  base: z.strictObject({
    /** fingerprint of the map file's JSON as written, so a draft that does not load yet still has one */
    file: fp16,
    /** the map's mapVersion (map-checks.md), when it loads */
    mapVersion: fp16.optional(),
  }),
  /** the unit the evidence came from: a model and firmware, never a person, machine, path or port name */
  unit: z.strictObject({
    /** as the unit reports it and the map spells it */
    firmware,
    /** the MIDI universal identity reply as received */
    identity: hexBytes.optional(),
    usb: z.strictObject({ vid: u16, pid: u16 }).optional(),
  }),
  producer: z.strictObject({ tool: z.enum(["sniffer", "app", "cloud", "manual"]), version: z.string().min(1).max(64) }),
  createdAt: time,
  /** files the evidence points into, by id: a capture, a probe log, a map-check log, a document */
  sources: z
    .record(sourceId, z.strictObject({ kind: z.enum(["capture", "probe-log", "map-checks", "doc"]), sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(), note: text.optional() }))
    .refine((r) => Object.keys(r).length <= MAX_SOURCES, `at most ${MAX_SOURCES} sources`)
    .optional(),
  changes: z.array(ChangeSchema).min(1).max(MAX_CHANGES),
});
export type SeedPatch = z.infer<typeof SeedPatchSchema>;

// ---- checks beyond the schema ---------------------------------------------------------------------------------------

export interface Issue {
  /** where, such as `changes[2].ops[0].path` */
  at: string;
  message: string;
}

const EDITS: readonly Action[] = ["add", "repair", "remove"];

/** Evidence against the entry as the base map has it. */
const contradicts = (e: Evidence): boolean =>
  (e.kind === "probe" && e.result !== "shape-ok") ||
  ((e.kind === "read-back" || e.kind === "replay") && e.result === "differs") ||
  (e.kind === "map-check" && (e.outcome === "contradicts" || e.outcome === "disagrees" || e.outcome === "reopens")) ||
  (e.kind === "player" && e.answer === "no") ||
  e.kind === "freeze";

/** Whether one piece of evidence carries a source: a change claims no more trust than its evidence shows. */
const backs: Record<Source, (e: Evidence) => boolean> = {
  wire: (e) => e.kind === "capture",
  "device-reported": (e) => e.kind === "device-list",
  "read-back": (e) => (e.kind === "probe" && e.result === "shape-ok") || (e.kind === "read-back" && e.result === "match") || (e.kind === "map-check" && (e.outcome === "confirms" || e.outcome === "settles")),
  "replay-verified": (e) => e.kind === "replay" && e.result === "match",
  "player-confirmed": (e) => e.kind === "player" && e.answer === "yes",
  doc: (e) => e.kind === "doc",
};

/**
 * Rules the schema can't state: unique ids and entries, ops that fit the action and stay inside the entry's homes,
 * no two changes editing the same place, a source the evidence backs, and evidence sources that exist.
 */
export function checkSeedPatch(p: SeedPatch): Issue[] {
  const issues: Issue[] = [];
  const ids = new Set<string>();
  const entries = new Set<string>();
  const edited: { change: number; segs: string[] }[] = [];
  p.changes.forEach((c, i) => {
    const at = `changes[${i}]`;
    const add = (where: string, message: string) => issues.push({ at: `${at}${where}`, message });
    if (ids.has(c.id)) add(".id", `change id "${c.id}" is used twice`);
    ids.add(c.id);
    if (entries.has(c.entry)) add(".entry", `entry "${c.entry}" has two changes; one change per entry`);
    entries.add(c.entry);
    const entry = parseEntry(c.entry)!;

    const isEdit = EDITS.includes(c.action);
    if (isEdit && !c.ops) add(".ops", `${c.action} needs ops`);
    if (!isEdit && c.ops) add(".ops", `${c.action} marks the entry and carries no ops`);
    if (c.action === "add" && c.entryFp) add(".entryFp", "add is for an entry the base map lacks, but entryFp says it has one");
    if ((c.action === "repair" || c.action === "remove") && c.entryFp === null) add(".entryFp", `${c.action} needs an entry the base map has`);
    if (entry.kind === "message" && entry.block !== undefined && isEdit) add(".entry", "edits go to the message; a message on one block is for marks");

    const homes = entryHomes(entry);
    c.ops?.forEach((op, j) => {
      const segs = splitPointer(op.path);
      if (!homes.some((h) => underHome(segs, h, p.unit.firmware))) add(`.ops[${j}].path`, `${op.path} is outside entry ${c.entry} (or in another firmware's delta)`);
      if (c.action === "add" && op.op !== "add") add(`.ops[${j}].op`, "an add only adds");
      if (c.action === "remove" && op.op !== "remove") add(`.ops[${j}].op`, "a remove only removes");
      if (op.op === "add" && /^(0|[1-9]\d*)$/.test(segs[segs.length - 1])) add(`.ops[${j}].path`, "add appends to an array with -; to change an array in the middle, replace it whole");
      for (const o of edited) if (o.change !== i && overlaps(o.segs, segs)) add(`.ops[${j}].path`, `${op.path} overlaps an edit of changes[${o.change}]`);
    });
    for (const op of c.ops ?? []) edited.push({ change: i, segs: splitPointer(op.path) });

    if (c.action === "confirm" || c.action === "repair" || c.action === "add") {
      if (!c.source) add(".source", `${c.action} states the source its evidence gives the entry`);
      else if (!c.evidence.some(backs[c.source])) add(".source", `no evidence backs "${c.source}"`);
    } else if (c.source) add(".source", `${c.action} gives the entry no source`);
    if (c.action === "confirm" && c.evidence.some(contradicts)) add(".evidence", "a confirm can't carry evidence against the entry; that is a suspect");
    if (c.action === "suspect" && !c.evidence.some(contradicts)) add(".evidence", "a suspect needs evidence against the entry (mismatch, silent, differs, contradicts, a no, a freeze)");
    if (c.action === "block" && !c.evidence.some((e) => e.kind === "freeze" || e.kind === "doc")) add(".evidence", "a block needs a freeze or a document naming the hazard");

    c.evidence.forEach((e, j) => {
      if ("source" in e && e.source !== undefined && !Object.hasOwn(p.sources ?? {}, e.source)) add(`.evidence[${j}].source`, `no source "${e.source}" in sources`);
    });
  });
  return issues;
}

/** Parse and check a patch from its file text or JSON. Throws on bad JSON; otherwise returns the patch or its issues. */
export function parseSeedPatch(input: string | unknown): { ok: true; patch: SeedPatch } | { ok: false; issues: Issue[] } {
  let json = input;
  if (typeof input === "string") {
    if (new TextEncoder().encode(input).length > MAX_PATCH_BYTES) return { ok: false, issues: [{ at: "", message: `a patch is at most ${MAX_PATCH_BYTES} bytes` }] };
    json = JSON.parse(input);
  }
  const r = SeedPatchSchema.safeParse(json);
  if (!r.success) return { ok: false, issues: r.error.issues.slice(0, 100).map((i) => ({ at: formatPath(i.path), message: i.message })) };
  const issues = checkSeedPatch(r.data);
  return issues.length ? { ok: false, issues } : { ok: true, patch: r.data };
}

const formatPath = (path: readonly PropertyKey[]) => path.map((k, i) => (typeof k === "number" ? `[${k}]` : `${i ? "." : ""}${String(k)}`)).join("");

// ---- review ---------------------------------------------------------------------------------------------------------

const SAFETY_SEGMENTS = new Set(["safety", "blocked"]);
const WRITE_RANGE_KEYS = new Set(["allowed", "writable", "min", "max", "saturate", "readOnly"]);

/** Keys anywhere inside a value. */
function keysIn(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) for (const x of v) keysIn(x, out);
  else if (v !== null && typeof v === "object")
    for (const [k, x] of Object.entries(v)) {
      out.add(k);
      keysIn(x, out);
    }
  return out;
}

/**
 * Why a person must review a change before it reaches players other than the unit's owner (live updates design,
 * "Versions, rollback and trust"). Worked out from the ops, never taken from the producer, so a patch can't talk its
 * way past review: removing an entry, touching safety or blocked lists, changing what may be written (ranges and
 * allowed values), changing the framing, and adding text the chat model reads (agentNotes).
 */
export function reviewReasons(p: SeedPatch): { change: string; reason: string }[] {
  const out: { change: string; reason: string }[] = [];
  for (const c of p.changes) {
    const reasons = new Set<string>();
    if (c.action === "remove") reasons.add("removes an entry");
    for (const op of c.ops ?? []) {
      const segs = splitPointer(op.path);
      const keys = new Set([...segs, ...("value" in op ? keysIn(op.value) : [])]);
      if ([...keys].some((k) => SAFETY_SEGMENTS.has(k))) reasons.add("changes safety rules or blocked lists");
      if ([...keys].some((k) => WRITE_RANGE_KEYS.has(k))) reasons.add("changes what may be written");
      if (segs[0] === "transport") reasons.add("changes the framing of every message");
      if (keys.has("agentNotes")) reasons.add("adds text the chat model reads");
    }
    for (const reason of reasons) out.push({ change: c.id, reason });
  }
  return out;
}

// ---- applying -------------------------------------------------------------------------------------------------------

export type ChangeStatus =
  /** its ops are in the map */
  | "applied"
  /** a mark (confirm, suspect, block): the map is unchanged and the reader keeps the mark in its own store */
  | "marked"
  /** not in the accepted set */
  | "skipped"
  /** an op's `was` or target doesn't match this map: made against another version of the entry */
  | "stale"
  /** the ops ran but don't do what the action says (an add whose entry still isn't there, say) */
  | "refused";

export interface ChangeResult {
  change: string;
  status: ChangeStatus;
  why?: string;
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
const isObject = (v: unknown): v is Record<string, Json> => v !== null && typeof v === "object" && !Array.isArray(v);

/** The value at a path, or undefined. */
function at(doc: Json, segs: readonly string[]): Json | undefined {
  let cur: Json | undefined = doc;
  for (const s of segs) {
    if (Array.isArray(cur)) cur = /^(0|[1-9]\d*)$/.test(s) ? cur[Number(s)] : undefined;
    else if (isObject(cur)) cur = Object.hasOwn(cur, s) ? cur[s] : undefined;
    else return undefined;
  }
  return cur;
}

/** Apply one op in place, or say why not. */
function applyOp(doc: Json, op: Op): string | null {
  const segs = splitPointer(op.path);
  // an add opens the objects on its way that aren't there yet, such as the delta of a firmware the map lacks
  if (op.op === "add")
    for (let i = 1; i < segs.length; i++) {
      const up = at(doc, segs.slice(0, i - 1));
      if (isObject(up) && !Object.hasOwn(up, segs[i - 1])) up[segs[i - 1]] = {};
    }
  const parent = at(doc, segs.slice(0, -1));
  const last = segs[segs.length - 1];
  const target = at(doc, segs);
  if (op.op === "add") {
    if (Array.isArray(parent) && last === "-") {
      parent.push(structuredClone(op.value) as Json);
      return null;
    }
    if (!isObject(parent)) return `${op.path}: nothing to add into`;
    if (target !== undefined) return `${op.path}: already there`;
    parent[last] = structuredClone(op.value) as Json;
    return null;
  }
  if (target === undefined) return `${op.path}: not there`;
  if (fingerprint(target) !== op.was) return `${op.path}: was ${fingerprint(target)}, the patch expected ${op.was}`;
  if (op.op === "replace") {
    if (Array.isArray(parent)) parent[Number(last)] = structuredClone(op.value) as Json;
    else (parent as Record<string, Json>)[last] = structuredClone(op.value) as Json;
  } else if (Array.isArray(parent)) parent.splice(Number(last), 1);
  else delete (parent as Record<string, Json>)[last];
  return null;
}

/**
 * Whether the map has the entry for a firmware: in the firmware's delta or the base. A parameter is found by block
 * and id, a setting by id; anything else at its home.
 */
export function hasEntry(map: unknown, entry: string, fw: string): boolean {
  const e = parseEntry(entry);
  if (!e || !isObject(map)) return false;
  const doc = map as Json;
  if (e.kind === "param") {
    const groups = at(doc, ["parameters", "groups"]);
    if (!isObject(groups)) return false;
    return Object.values(groups).some(
      (g) => isObject(g) && Array.isArray(g.blocks) && g.blocks.includes(e.block) && isObject(g.params) && Object.values(g.params).some((x) => isObject(x) && x.id === e.id),
    );
  }
  if (e.kind === "setting") {
    const items = at(doc, ["settings", "items"]);
    return Array.isArray(items) && items.some((x) => isObject(x) && x.id === e.id);
  }
  return entryHomes(e).some((h) => !h.includes("*") && at(doc, h.map((s) => (s === FW ? fw : s))) !== undefined);
}

/**
 * Apply a checked patch to a copy of the map, change by change, each all or nothing. `accept` limits it to the
 * changes a review accepted. Changes whose ops no longer fit (a `was` that doesn't match) are left out as stale,
 * so a patch made against an older map still lands wherever its entries are unchanged.
 */
export function applySeedPatch(map: unknown, p: SeedPatch, accept?: ReadonlySet<string>): { map: unknown; rebased: boolean; results: ChangeResult[] } {
  let doc = structuredClone(map) as Json;
  const rebased = fingerprint(map) !== p.base.file;
  const results: ChangeResult[] = p.changes.map((c) => {
    if (accept && !accept.has(c.id)) return { change: c.id, status: "skipped" };
    if (!c.ops) return { change: c.id, status: "marked" };
    const trial = structuredClone(doc);
    for (const op of c.ops) {
      const why = applyOp(trial, op);
      if (why) return { change: c.id, status: "stale", why };
    }
    const has = hasEntry(trial, c.entry, p.unit.firmware);
    if (c.action === "remove" ? has : !has) return { change: c.id, status: "refused", why: c.action === "remove" ? "the entry is still there" : "the entry isn't there after the ops" };
    doc = trial;
    return { change: c.id, status: "applied" };
  });
  return { map: doc, rebased, results };
}
