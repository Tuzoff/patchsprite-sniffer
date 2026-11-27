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
const MAX_FILES = 256;
const MAX_TEXT = 1024;
/** One op's value, as canonical JSON. */
const MAX_VALUE_CHARS = 256 << 10;
/** One frame, as hex: 64 KiB of bytes. */
const MAX_FRAME_CHARS = 3 * (64 << 10);

const fp16 = z.string().regex(/^[0-9a-f]{16}$/, "a fingerprint is 16 lowercase hex digits");
const hexBytes = z.string().max(MAX_FRAME_CHARS).regex(/^[0-9a-f]{2}( [0-9a-f]{2})*$/, "bytes are lowercase hex pairs separated by single spaces");
const time = z.iso.datetime({ offset: true });
const text = z.string().min(1).max(MAX_TEXT);
const NAME_RE = /^[a-z][A-Za-z0-9]*$/;
/** An array index in a JSON Pointer segment. */
const INDEX_RE = /^(0|[1-9]\d*)$/;
const name = z.string().max(64).regex(NAME_RE, "names are camelCase");
const firmware = z.string().max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

/**
 * The firmware a patch names when the unit reports none (a map with no firmwareVersion message): the app keeps such a
 * unit's map checks under this name, and its evidence edits only the base map, never a firmware's delta.
 */
export const UNKNOWN_FIRMWARE = "unknown";
const fileId = z.string().max(64).regex(/^[a-z0-9][a-z0-9-]*$/, "file ids are lowercase letters, digits and dashes");
const u16 = z.number().int().min(0).max(0xffff);

// ---- entries ------------------------------------------------------------------------------------------------------

/**
 * The map's top-level keys this engine knows that a change may cover whole. Any other top-level key, such as a section
 * a newer map or a draft has, is a whole-section entry too, named by its key alone (see parseEntry).
 */
export const SECTION_ENTRIES = [
  "transport", "host", "identity", "driver", "session", "safety", "blocked", "hazards", "scratch", "audio", "display",
  "parameters", "controls", "settings", "eq", "addresses", "editor", "modes", "cautions",
] as const;
/** Top-level keys only ever covered by finer entries (`<message>`, `layout/<name>` and so on), never whole. */
export const FINE_SECTIONS = ["messages", "layouts", "enums", "constants", "choices", "firmwares", "schema"] as const;
/** Kinds of entry written `<kind>/<name>`. */
export const NAMED_KINDS = ["choice", "layout", "enum", "constant", "control"] as const;
/** A draft's own bookkeeping at its top level, which no op writes. */
const BOOKKEEPING = new Set(["status", "gaps", "provenance"]);
/** Top-level keys no entry names whole, and no measured value lies in. */
const RESERVED_TOP = new Set<string>([...FINE_SECTIONS, ...BOOKKEEPING]);
/**
 * Words that never name a message, since they name a section or start another kind of entry (parseEntry never reads
 * them as one). A map's messages also never share a name with any of its own top-level keys.
 */
export const RESERVED_WORDS: readonly string[] = [...SECTION_ENTRIES, ...RESERVED_TOP, ...NAMED_KINDS, "param", "setting", "measured", "linked"];

export type Entry =
  /**
   * a message, or a top-level section this engine doesn't know by that name, whichever the map has; with a mode
   * (`getPreset@bass`), the message as a mode that stands in layouts or enums reads it
   */
  | { kind: "message"; message: string; block?: string; mode?: string }
  /** a measured value, by its dotted path (`transport.timing.compareToggle`) */
  | { kind: "measured"; field: string }
  /** with a group (`param/amp/3/bassAmp`), the parameter in a group that stands in for another in some mode */
  /** `owner`: the block, or on a slot pedal the effect type, whose table the parameter is in */
  | { kind: "param"; owner: string; id: number; group?: string }
  /** a set of paired parameters in a parameter group (`linked/<group>/<set>`) */
  | { kind: "linked"; group: string; set: string }
  | { kind: "setting"; id: string }
  | { kind: (typeof NAMED_KINDS)[number]; name: string }
  | { kind: "section"; section: (typeof SECTION_ENTRIES)[number] };

const BLOCK_RE = /^[a-z][A-Za-z0-9_]*$/;
const KEY_RE = /^[a-z][a-z0-9_]*$/;
/** A parameter group's key, as `param/<owner>/<id>/<group>` and `linked/<group>/<set>` name it. */
const isGroup = (s: string) => s.length <= 64 && (KEY_RE.test(s) || NAME_RE.test(s));

/**
 * An entry name, as the app's map checks write it (docs/design/map-checks.md in the app) plus the kinds a patch also
 * needs: `<message>`, `<message>/<block>`, `<message>@<mode>`, `<message>@<mode>/<block>`, `param/<owner>/<id>`,
 * `param/<owner>/<id>/<group>`, `choice/<name>`, then `layout/<name>`, `enum/<name>`, `constant/<name>`,
 * `control/<name>`, `setting/<id>`, `linked/<group>/<set>`, `measured/<field>` and the section names. Null when it is
 * none of these.
 */
export function parseEntry(entry: string): Entry | null {
  if (entry.length > 160) return null;
  const parts = entry.split("/");
  const [head, a, b] = parts;
  // never in a section only finer entries cover (another firmware's delta, a message) or in a draft's bookkeeping
  if (head === "measured")
    return parts.length === 2 && /^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*){1,7}$/.test(a) && (SECTION_ENTRIES as readonly string[]).includes(a.split(".")[0]) ? { kind: "measured", field: a } : null;
  if (head === "linked") return parts.length === 3 && isGroup(a) && KEY_RE.test(b) && b.length <= 64 ? { kind: "linked", group: a, set: b } : null;
  if (RESERVED_TOP.has(head)) return null;
  if ((SECTION_ENTRIES as readonly string[]).includes(head)) return parts.length === 1 ? { kind: "section", section: head as (typeof SECTION_ENTRIES)[number] } : null;
  if ((NAMED_KINDS as readonly string[]).includes(head)) return parts.length === 2 && NAME_RE.test(a) ? { kind: head as (typeof NAMED_KINDS)[number], name: a } : null;
  if (head === "setting") return parts.length === 2 && KEY_RE.test(a) ? { kind: "setting", id: a } : null;
  if (head === "param") {
    if ((parts.length !== 3 && parts.length !== 4) || !BLOCK_RE.test(a) || !/^(0|[1-9]\d{0,4})$/.test(b)) return null;
    if (parts.length === 3) return { kind: "param", owner: a, id: Number(b) };
    return isGroup(parts[3]) ? { kind: "param", owner: a, id: Number(b), group: parts[3] } : null;
  }
  // `<message>@<mode>`, `<message>@<mode>/<block>`
  const [message, mode, ...more] = head.split("@");
  if (more.length || (mode !== undefined && (!BLOCK_RE.test(mode) || mode.length > 64))) return null;
  if (!NAME_RE.test(message) || message.length > 64) return null;
  // `param@x` and the like name no message, just as a bare `param` doesn't
  if (mode !== undefined && RESERVED_WORDS.includes(message)) return null;
  const tagged = mode === undefined ? {} : { mode };
  if (parts.length === 1) return { kind: "message", message, ...tagged };
  return parts.length === 2 && BLOCK_RE.test(a) && a.length <= 64 ? { kind: "message", message, block: a, ...tagged } : null;
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
      // a bare name is also a top-level section this engine doesn't know (a draft's own, or a newer map's)
      return [["messages", e.message], ["firmwares", FW, "messages", e.message], ...(e.block === undefined && e.mode === undefined ? [[e.message]] : [])];
    case "measured":
      return [e.field.split(".")];
    case "linked":
      return [["parameters", "groups", e.group, "linked", e.set]];
    case "param":
      return [["parameters", "groups", e.group ?? "*", "params", "*"]];
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
  .regex(/^(\/(?!__proto__(\/|$))([^~/]|~[01])*)+$/, "a path is a JSON Pointer below the map's root, such as /messages/getPreset, with no __proto__ segment");

export const splitPointer = (p: string): string[] => p.slice(1).split("/").map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));

const underHome = (segs: string[], home: string[], fw: string) =>
  segs.length >= home.length && home.every((h, i) => h === "*" || (h === FW ? segs[i] === fw : segs[i] === h));

/**
 * The op paths of earlier changes as a tree of segments, so finding an overlap costs one walk down a path, not a
 * comparison with every other op: `at` is the first change with an op at the node, `below` the first with one under it.
 */
interface PathNode {
  kids: Map<string, PathNode>;
  at?: number;
  below?: number;
}

/** The first earlier change with an op path that is this one, lies inside it or holds it. */
function overlapIn(root: PathNode, segs: readonly string[]): number | undefined {
  let n: PathNode | undefined = root;
  for (const s of segs) {
    if (n.at !== undefined) return n.at;
    n = n.kids.get(s);
    if (!n) return undefined;
  }
  return n.at ?? n.below;
}

function addPath(root: PathNode, segs: readonly string[], change: number): void {
  let n = root;
  for (const s of segs) {
    n.below ??= change;
    let kid = n.kids.get(s);
    if (!kid) n.kids.set(s, (kid = { kids: new Map() }));
    n = kid;
  }
  // appends never meet: each goes to its own new place at the end of the array
  if (segs[segs.length - 1] !== "-") n.at ??= change;
}

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
    file: fileId,
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
  z.strictObject({ kind: z.literal("replay"), at: time, result: z.enum(["match", "differs"]), file: fileId.optional(), detail: text.optional() }),
  /** a list the unit gave about itself when asked: blocks, a block's parameters, models (S17) */
  z.strictObject({
    kind: z.literal("device-list"),
    at: time,
    request: name,
    replies: z.array(hexBytes).min(1).max(MAX_RECORDS),
    file: fileId.optional(),
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
 * Where the entry's claim comes from once the change is in, the map's source kinds: `wire` (a capture),
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
  /** the mode the unit was in when the evidence was seen, for a map with modes; an `@<mode>` entry needs its own */
  mode: z.string().max(64).regex(BLOCK_RE).optional(),
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
    /** as the unit reports it and the map spells it, or "unknown" when the unit reports none (UNKNOWN_FIRMWARE) */
    firmware,
    /** the MIDI universal identity reply as received */
    identity: hexBytes.optional(),
    usb: z.strictObject({ vid: u16, pid: u16 }).optional(),
  }),
  producer: z.strictObject({ tool: z.enum(["sniffer", "app", "cloud", "manual"]), version: z.string().min(1).max(64) }),
  createdAt: time,
  /** files the evidence points into, by id: a capture, a probe log, a map-check log, a document */
  files: z
    .record(fileId, z.strictObject({ kind: z.enum(["capture", "probe-log", "map-checks", "doc"]), sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(), note: text.optional() }))
    .refine((r) => Object.keys(r).length <= MAX_FILES, `at most ${MAX_FILES} files`)
    .optional(),
  changes: z.array(ChangeSchema).min(1).max(MAX_CHANGES),
});
export type SeedPatch = z.infer<typeof SeedPatchSchema>;

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
const isObject = (v: unknown): v is Record<string, Json> => v !== null && typeof v === "object" && !Array.isArray(v);

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

/** Where the map keeps an entry's `source` ({kind, ref}, device-map-protocol.md): on a message, a parameter, a choice. */
const SOURCE_HOMES = [["messages", "*"], ["parameters", "groups", "*", "params", "*"], ["choices", "*"]] as const;
const SOURCE_KEYS = SOURCE_HOMES.flatMap((h) => [[...h, "source"], ["firmwares", "*", ...h, "source"]]);

/** A value holds something at `pat` (`*` is any key or array item, as a path's `*` matches an index too). */
const holdsAt = (v: unknown, pat: readonly string[]): boolean => {
  if (!pat.length) return true;
  const [k, ...rest] = pat;
  if (v === null || typeof v !== "object") return false;
  return k === "*" ? Object.values(v).some((x) => holdsAt(x, rest)) : isObject(v) && Object.hasOwn(v, k) && holdsAt(v[k], rest);
};

/** An op at `segs` that puts `value` there writes an entry's `source`: it is at or under one, or its value holds one. */
function writesSource(segs: readonly string[], value: unknown, hasValue: boolean): boolean {
  return SOURCE_KEYS.some((pat) => {
    for (let i = 0; i < pat.length; i++) {
      if (i === segs.length) return hasValue && holdsAt(value, pat.slice(i));
      if (pat[i] !== "*" && pat[i] !== segs[i]) return false;
    }
    return true;
  });
}

/**
 * Rules the schema can't state: unique ids and entries, ops that fit the action and stay inside the entry's homes,
 * no two changes editing the same place, a source the evidence backs, and evidence files that exist.
 */
export function checkSeedPatch(p: SeedPatch): Issue[] {
  const issues: Issue[] = [];
  const ids = new Set<string>();
  const entries = new Set<string>();
  const edited: PathNode = { kids: new Map() };
  p.changes.forEach((c, i) => {
    const at = `changes[${i}]`;
    const add = (where: string, message: string) => issues.push({ at: `${at}${where}`, message });
    if (ids.has(c.id)) add(".id", `change id "${c.id}" is used twice`);
    ids.add(c.id);
    if (entries.has(c.entry)) add(".entry", `entry "${c.entry}" has two changes; one change per entry`);
    entries.add(c.entry);
    const entry = parseEntry(c.entry)!;
    if (entry.kind === "message" && entry.mode !== undefined && c.mode !== entry.mode)
      add(".mode", `${c.entry} is the message as mode ${entry.mode} reads it, so its evidence must be seen in that mode`);
    if (entry.kind === "param" && entry.group !== undefined && c.mode === undefined)
      add(".mode", `${c.entry} is in a stand-in group, so its change needs the mode it was seen in`);

    const isEdit = EDITS.includes(c.action);
    if (isEdit && !c.ops) add(".ops", `${c.action} needs ops`);
    if (!isEdit && c.ops) add(".ops", `${c.action} marks the entry and carries no ops`);
    if (c.action === "add" && c.entryFp) add(".entryFp", "add is for an entry the base map lacks, but entryFp says it has one");
    if ((c.action === "repair" || c.action === "remove" || c.action === "confirm" || c.action === "suspect") && c.entryFp === null) add(".entryFp", `${c.action} needs an entry the base map has`);
    if (entry.kind === "message" && (entry.block !== undefined || entry.mode !== undefined) && isEdit)
      add(".entry", "edits go to the message itself, or to the mode's own entries (modes, layout/, enum/); a message on one block or in one mode is for marks");

    const homes = entryHomes(entry);
    const opSegs = (c.ops ?? []).map((op) => splitPointer(op.path));
    c.ops?.forEach((op, j) => {
      const segs = opSegs[j];
      if (!homes.some((h) => underHome(segs, h, p.unit.firmware))) add(`.ops[${j}].path`, `${op.path} is outside entry ${c.entry} (or in another firmware's delta)`);
      if (p.unit.firmware === UNKNOWN_FIRMWARE && segs[0] === "firmwares")
        add(`.ops[${j}].path`, "the unit's firmware is unknown, so its evidence edits only the base map, never a firmware's delta");
      if (c.action === "add" && op.op !== "add") add(`.ops[${j}].op`, "an add only adds");
      if (c.action === "remove" && op.op !== "remove") add(`.ops[${j}].op`, "a remove only removes");
      if (op.op === "add" && INDEX_RE.test(segs[segs.length - 1])) add(`.ops[${j}].path`, "add appends to an array with -; to change an array in the middle, replace it whole");
      if (BOOKKEEPING.has(segs[0]) || segs.includes("provenance") || ("value" in op && keysIn(op.value).has("provenance")))
        add(`.ops[${j}]`, "provenance comes from the change's source and evidence, and status and gaps are the draft's own bookkeeping; ops never write them");
      if (writesSource(segs, "value" in op ? op.value : undefined, "value" in op))
        add(`.ops[${j}]`, "an entry's source comes from the change's source and evidence; ops never write it");
      const other = overlapIn(edited, segs);
      if (other !== undefined) add(`.ops[${j}].path`, `${op.path} overlaps an edit of changes[${other}]`);
    });
    for (const segs of opSegs) addPath(edited, segs, i);

    if (c.action === "confirm" || c.action === "repair" || c.action === "add") {
      if (!c.source) add(".source", `${c.action} states the source its evidence gives the entry`);
      else if (!c.evidence.some(backs[c.source])) add(".source", `no evidence backs "${c.source}"`);
    } else if (c.source) add(".source", `${c.action} gives the entry no source`);
    if (c.action === "confirm" && c.evidence.some(contradicts)) add(".evidence", "a confirm can't carry evidence against the entry; that is a suspect");
    if (c.action === "suspect" && !c.evidence.some(contradicts)) add(".evidence", "a suspect needs evidence against the entry (mismatch, silent, differs, contradicts, a no, a freeze)");
    if (c.action === "block" && !c.evidence.some((e) => e.kind === "freeze" || e.kind === "doc")) add(".evidence", "a block needs a freeze or a document naming the hazard");

    c.evidence.forEach((e, j) => {
      if ("file" in e && e.file !== undefined && !Object.hasOwn(p.files ?? {}, e.file)) add(`.evidence[${j}].file`, `no file "${e.file}" in files`);
    });
  });
  return issues;
}

/** How deep a patch may nest: far more than any map entry needs, and shallow enough for the recursive checks. */
export const MAX_DEPTH = 100;

/**
 * What the schema can't safely be handed: nesting too deep for its recursive checks, or a `__proto__` key, which a
 * parser would turn into an object's prototype, hiding the value from review and from the applied map. Iterative, so
 * deep input can't overflow the stack.
 */
function rawIssue(json: unknown): string | null {
  const stack: [unknown, number][] = [[json, 1]];
  while (stack.length) {
    const [v, depth] = stack.pop()!;
    if (v === null || typeof v !== "object") continue;
    if (depth > MAX_DEPTH) return `a patch nests at most ${MAX_DEPTH} deep`;
    for (const [k, x] of Object.entries(v)) {
      if (k === "__proto__") return "no key may be __proto__";
      stack.push([x, depth + 1]);
    }
  }
  return null;
}

/** Parse and check a patch from its file text or JSON. Throws on bad JSON; otherwise returns the patch or its issues. */
export function parseSeedPatch(input: string | unknown): { ok: true; patch: SeedPatch } | { ok: false; issues: Issue[] } {
  let json = input;
  if (typeof input === "string") {
    // a UTF-16 unit is at least one UTF-8 byte, so a long string is too big before it is encoded
    if (input.length > MAX_PATCH_BYTES || new TextEncoder().encode(input).length > MAX_PATCH_BYTES) return { ok: false, issues: [{ at: "", message: `a patch is at most ${MAX_PATCH_BYTES} bytes` }] };
    json = JSON.parse(input);
  }
  const raw = rawIssue(json);
  if (raw) return { ok: false, issues: [{ at: "", message: raw }] };
  const r = SeedPatchSchema.safeParse(json);
  if (!r.success) return { ok: false, issues: r.error.issues.slice(0, 100).map((i) => ({ at: formatPath(i.path), message: i.message })) };
  const issues = checkSeedPatch(r.data);
  return issues.length ? { ok: false, issues } : { ok: true, patch: r.data };
}

const formatPath = (path: readonly PropertyKey[]) => path.map((k, i) => (typeof k === "number" ? `[${k}]` : `${i ? "." : ""}${String(k)}`)).join("");

// ---- review ---------------------------------------------------------------------------------------------------------

const SAFETY_KEYS = new Set(["safety", "blocked", "hazards"]);
/** Top-level keys whose risks the reasons below know; a change to any other section can't be judged, so it's reviewed. */
const KNOWN_TOP = new Set<string>([...SECTION_ENTRIES, ...FINE_SECTIONS]);
/** What may be written. A parameter's `default` isn't here: the map checks it at load against these limits, and it only says where a reset lands. */
const WRITE_RANGE_KEYS = new Set(["allowed", "writable", "min", "max", "saturate", "readOnly", "linked"]);
/** Keys that decide what first contact sends to an unknown unit and whether a write counts as verified. */
const PROBE_KEYS = new Set(["safeRead", "readBack"]);
/** Keys of a MIDI channel control that say what it sends to: a changed one retargets every write through it. */
const CONTROL_TARGET_KEYS = new Set(["type", "cc", "pc", "nrpn", "number", "msb", "lsb", "channel", "bits"]);

/**
 * Keys of a message that decide which bytes it sends: its cmd, its direction, its payload (inline or a layout's name)
 * and its header (on sysex-plain framing, two messages with one cmd under different headers are different messages).
 */
const PIN_KEYS = ["cmd", "dir", "payload", "header"];

/** The shared layouts a layout's (or an inline payload's) packed tail is read with, or joined into as a piece. */
function tailLayouts(layout: Json | undefined): string[] {
  const packed = isObject(layout) ? layout.packed : undefined;
  if (!isObject(packed)) return [];
  const pieces = packed.pieces;
  return [packed.layout, isObject(pieces) ? pieces.layout : undefined].filter((l): l is string => typeof l === "string");
}

/** The app's longest cmd, in bytes (`transport.inner.cmdLength`). A longer one can't load, so it is judged by nothing. */
const MAX_CMD_TOKENS = 8;

/** A cmd's tokens and which of them are `{placeholders}`, as bits; null past the app's longest cmd. */
function parseCmd(cmd: string): { toks: string[]; mask: number } | null {
  const toks = cmd.toLowerCase().split(" ");
  if (toks.length > MAX_CMD_TOKENS) return null;
  return { toks, mask: toks.reduce((m, t, i) => (t.startsWith("{") ? m | (1 << i) : m), 0) };
}

const maskedKey = (toks: readonly string[], mask: number) => toks.map((t, i) => (mask & (1 << i) ? "*" : t)).join(" ");

/**
 * Blocked cmds, for asking whether a cmd can be the bytes of one: as long, and each token the same or a placeholder on
 * either side (the app's rule). They are grouped by length and placeholder positions, so a lookup costs a Set probe
 * per group rather than a compare per cmd. A cmd past the app's longest can't load and matches everything.
 */
class BlockedCmds {
  private readonly groups = new Map<number, Map<number, string[][]>>();
  private readonly keyed = new Map<string, Set<string>>();
  private all = false;
  add(cmd: string): void {
    const c = parseCmd(cmd);
    if (!c) return void (this.all = true);
    let byMask = this.groups.get(c.toks.length);
    if (!byMask) this.groups.set(c.toks.length, (byMask = new Map()));
    const list = byMask.get(c.mask);
    if (list) list.push(c.toks);
    else byMask.set(c.mask, [c.toks]);
  }
  hits(cmd: string): boolean {
    const c = parseCmd(cmd);
    if (!c || this.all) return true;
    for (const [mask, list] of this.groups.get(c.toks.length) ?? []) {
      const both = mask | c.mask;
      const id = `${c.toks.length}/${mask}/${both}`;
      let keys = this.keyed.get(id);
      if (!keys) this.keyed.set(id, (keys = new Set(list.map((t) => maskedKey(t, both)))));
      if (keys.has(maskedKey(c.toks, both))) return true;
    }
    return false;
  }
}

const SEP = "\u0000";

/**
 * Where a change may lift a block, as joined paths. A block is per message: the app lets a send share a blocked
 * message's cmd only while their payload pins (`const`, `not`, `size`, `minSize`, `maxSize`, a named layout) tell them
 * apart, so those pins are what keep the block standing. The pins are the `cmd`, `dir`, `payload` and `header` of every
 * blocked message and of every send or request whose cmd can be a blocked one's, the layouts their payloads name, the
 * layouts those payloads' packed tails are read with (whose consts pin bytes and whose fields set lengths), and what a
 * mode stands in for any of them. A firmware delta's paths are matched without their `/firmwares/<fw>` prefix.
 *
 * A reviewer may accept any subset of a patch's changes, so each message counts with every cmd, direction and payload
 * it has in any of `maps` (the base map and the map the whole patch leaves), on the base and in every firmware's delta.
 */
function blockPins(maps: readonly Json[]): Set<string> {
  const seen = new Map<string, Record<string, Json>[]>();
  // every version of each layout, for the packed tails a named payload reads with
  const layouts = new Map<string, Json[]>();
  const blocked = new Set<string>();
  // what stands in for a message or layout in some mode; one mapped to itself doesn't
  const stand = { messages: new Map<string, Set<string>>(), layouts: new Map<string, Set<string>>() };
  for (const map of maps) {
    const firmwares = at(map, ["firmwares"]);
    const deltas = isObject(firmwares) ? Object.values(firmwares) : [];
    for (const messages of [at(map, ["messages"]), ...deltas.map((d) => at(d, ["messages"]))])
      if (isObject(messages))
        for (const [n, m] of Object.entries(messages)) {
          if (!isObject(m)) continue;
          const list = seen.get(n);
          if (list) list.push(m);
          else seen.set(n, [m]);
        }
    for (const table of [at(map, ["layouts"]), ...deltas.map((d) => at(d, ["layouts"]))])
      if (isObject(table))
        for (const [n, l] of Object.entries(table)) {
          const list = layouts.get(n);
          if (list) list.push(l);
          else layouts.set(n, [l]);
        }
    for (const list of [at(map, ["blocked"]), ...deltas.map((d) => at(d, ["blocked"]))])
      if (Array.isArray(list)) for (const b of list) if (typeof b === "string") blocked.add(b);
    const use = at(map, ["modes", "use"]);
    if (isObject(use))
      for (const u of Object.values(use))
        for (const kind of ["messages", "layouts"] as const) {
          const t = isObject(u) ? u[kind] : undefined;
          if (isObject(t))
            for (const [name, v] of Object.entries(t))
              if (typeof v === "string" && v !== name) {
                const set = stand[kind].get(name);
                if (set) set.add(v);
                else stand[kind].set(name, new Set([v]));
              }
        }
  }
  const standIns = (kind: "messages" | "layouts", name: string): Iterable<string> => stand[kind].get(name) ?? [];
  for (const b of [...blocked]) for (const s of standIns("messages", b)) blocked.add(s);
  const cmds = new BlockedCmds();
  for (const b of blocked) for (const m of seen.get(b) ?? []) if (typeof m.cmd === "string") cmds.add(m.cmd);

  const out = new Set<string>();
  const pin = (n: string) => {
    for (const k of PIN_KEYS) out.add(["messages", n, k].join(SEP));
    // by name, whether or not a view has the layout: adding the layout a pinned payload names is a pin change too
    const named = (l: string) => {
      for (const x of [l, ...standIns("layouts", l)]) out.add(["layouts", x].join(SEP));
    };
    for (const m of seen.get(n) ?? []) {
      // the layout a payload names, or the payload itself, and the layouts their packed tails read with
      const own = typeof m.payload === "string" ? [m.payload, ...standIns("layouts", m.payload)] : [];
      for (const l of own) named(l);
      const shapes = typeof m.payload === "string" ? own.flatMap((l) => layouts.get(l) ?? []) : [m.payload];
      for (const shape of shapes) for (const t of tailLayouts(shape)) named(t);
    }
  };
  for (const b of blocked) pin(b);
  for (const [n, ms] of seen) {
    const sends = ms.some((m) => m.dir === "send" || m.dir === "request");
    if (sends && ms.some((m) => typeof m.cmd === "string" && cmds.hits(m.cmd))) for (const x of [n, ...standIns("messages", n)]) pin(x);
  }
  return out;
}

/** The paths above the pins: a whole message, a section. */
function abovePins(pins: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const pin of pins) {
    const segs = pin.split(SEP);
    for (let i = 1; i < segs.length; i++) out.add(segs.slice(0, i).join(SEP));
  }
  return out;
}

/** An op at `segs` writes a block's pin: at or under one, or above one (a whole message, section or firmware delta). */
function writesPin(segs: readonly string[], pins: Set<string>, above: Set<string>): boolean {
  if (segs[0] === "firmwares" && segs.length <= 2) return pins.size > 0;
  const own = segs[0] === "firmwares" ? segs.slice(2) : segs;
  for (let i = 1; i <= own.length; i++) if (pins.has(own.slice(0, i).join(SEP))) return true;
  return above.has(own.join(SEP));
}

const LIFT_BLOCK = "may lift a block";

/**
 * A send or request kept apart from a blocked message on a cmd they can share, and what keeps them apart ("byte 4: 08
 * vs 01", "length: 1 vs 2 or more"), as a caller's map checks work it out. A firmware is named only for a pair that is
 * new there or rests on something else.
 */
export interface BlockSeparation {
  firmware?: string;
  send: string;
  blocked: string;
  by: string;
}

export interface ReviewOptions {
  /**
   * Optional: the block separations of a map, from the caller's own map checks. With it, a change that may lift a
   * block says which pair it touches and how their separation changes when the change is accepted. It may throw (or
   * return something else) when a map doesn't load; the reason then stays the plain one.
   */
  separations?: (map: unknown) => readonly BlockSeparation[];
}

/** At most this many changes are weighed alone against their separations; the rest keep the plain reason. */
const MAX_WEIGHED_ALONE = 64;

/** At most this many separation notes per change; the rest are counted. */
const MAX_SEPARATION_NOTES = 8;

/**
 * The messages an op at `segs` touches by name: a message, every message whose payload names a layout it touches, all
 * of them for a whole section or firmware delta, and what a mode puts in or takes the place of any of those.
 */
function touchedMessages(segs: readonly string[], maps: readonly Json[]): Set<string> {
  const own = segs[0] === "firmwares" ? (segs.length <= 2 ? ["messages"] : segs.slice(2)) : segs;
  const tables = maps.flatMap((m) => {
    const firmwares = at(m, ["firmwares"]);
    return [at(m, ["messages"]), ...(isObject(firmwares) ? Object.values(firmwares).map((d) => at(d, ["messages"])) : [])].filter(isObject);
  });
  // mode stand-ins both ways: [kind, name, stand-in]
  const swaps = maps.flatMap((m) => {
    const use = at(m, ["modes", "use"]);
    return (isObject(use) ? Object.values(use) : []).flatMap((u) =>
      (["messages", "layouts"] as const).flatMap((kind) => {
        const t = isObject(u) ? u[kind] : undefined;
        return isObject(t) ? Object.entries(t).flatMap(([n, v]) => (typeof v === "string" ? [[kind, n, v] as const] : [])) : [];
      }),
    );
  });
  const alike = (kind: "messages" | "layouts", name: string) =>
    new Set([name, ...swaps.flatMap(([k, n, v]) => (k !== kind ? [] : n === name ? [v] : v === name ? [n] : []))]);
  const out = new Set<string>();
  if (own[0] === "messages") {
    if (own.length >= 2) for (const n of alike("messages", own[1])) out.add(n);
    else for (const t of tables) for (const n of Object.keys(t)) out.add(n);
  } else if (own[0] === "layouts") {
    const layouts = own.length >= 2 ? alike("layouts", own[1]) : undefined;
    for (const t of tables)
      for (const [n, m] of Object.entries(t))
        if (isObject(m) && typeof m.payload === "string" && (!layouts || layouts.has(m.payload))) for (const x of alike("messages", n)) out.add(x);
  }
  return out;
}

/** A name or separation from the caller, as it goes into reason text: one line, no control or direction marks, bounded. */
const shown = (s: string, max = 80): string => {
  const t = s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "?");
  return t.length > max ? `${t.slice(0, max)}…` : t;
};

/**
 * The separations before and after a change, as notes for the messages it touches: a pair that is new
 * means the patch puts a send beside a blocked message, a changed `by` means a separation moved, a pair that is gone
 * means the send no longer shares the cmd (or no longer loads beside it), and an unchanged pair says what still keeps
 * them apart. A pair named on a firmware is compared with the unnamed one where the other map doesn't name it there,
 * since an unnamed pair holds on every firmware that doesn't say otherwise. The base map's and the whole patch's
 * separations are asked for once. Undefined when the base map's, the whole patch's or `map`'s separations can't be
 * had: a change that is fine alone may still leave nothing between a send and a blocked message beside the rest.
 */
function separationNotes(separations: NonNullable<ReviewOptions["separations"]>, base: unknown, patched: unknown): (map: unknown, names: Set<string>) => string[] | undefined {
  const key = (s: { firmware?: string; send: string; blocked: string }) => [s.firmware ?? "", s.send, s.blocked].join(SEP);
  const ok = (s: unknown): s is BlockSeparation =>
    isObject(s) && typeof s.send === "string" && typeof s.blocked === "string" && typeof s.by === "string" && (s.firmware === undefined || typeof s.firmware === "string");
  const table = (map: unknown): Map<string, BlockSeparation> | undefined => {
    try {
      const list: unknown = separations(map);
      return Array.isArray(list) && list.every(ok) ? new Map(list.map((s) => [key(s), s])) : undefined;
    } catch {
      return undefined;
    }
  };
  const was = table(base);
  const whole = was && table(patched);
  const find = (t: Map<string, BlockSeparation>, s: BlockSeparation) => t.get(key(s)) ?? (s.firmware ? t.get(key({ send: s.send, blocked: s.blocked })) : undefined);
  const on = (s: BlockSeparation) => (s.firmware ? ` on ${shown(s.firmware)}` : "");
  return (map, names) => {
    const now = map === patched ? whole : whole && table(map);
    if (!was || !now) return undefined;
    const notes: string[] = [];
    for (const k of new Set([...was.keys(), ...now.keys()])) {
      const s = (now.get(k) ?? was.get(k))!;
      if (!names.has(s.send) && !names.has(s.blocked)) continue;
      const a = find(was, s);
      const b = find(now, s);
      const [send, blocked] = [shown(s.send), shown(s.blocked)];
      notes.push(
        !a ? `${send} now shares a cmd with the blocked ${blocked}${on(s)}, kept apart only by ${shown(b!.by)}`
        : !b ? `${send} no longer shares a cmd with the blocked ${blocked}${on(s)} (was kept apart by ${shown(a.by)})`
        : a.by !== b.by ? `what keeps ${send} apart from the blocked ${blocked}${on(s)} moves from ${shown(a.by)} to ${shown(b.by)}`
        : `${send} is kept apart from the blocked ${blocked}${on(s)} by ${shown(b.by)}`,
      );
    }
    return notes;
  };
}

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

/** A value holds a send: a message the app writes to the unit. */
const holdsSend = (v: unknown): boolean =>
  Array.isArray(v) ? v.some(holdsSend) : isObject(v) && (v.dir === "send" || Object.values(v).some(holdsSend));
/** The value at a path ending in `last` makes a send: a `dir` that is `send`, or a value that holds one. */
const makesSend = (v: unknown, last: string | undefined): boolean => (last === "dir" ? v === "send" : holdsSend(v));

/**
 * Why a person must review a change before it reaches players other than the unit's owner (live updates design,
 * "Versions, rollback and trust"). Worked out from the ops and the base map, never taken from the producer, so a patch
 * can't talk its way past review. A replace or remove is judged by what it takes out of the base map as well as what
 * it puts in, so dropping a limit by replacing its parent still counts. `base` is the map the patch is applied to.
 */
/** A measured value's shape: {value, unit, measuredOn, date, source} and nothing else. */
const isMeasured = (v: unknown): boolean =>
  isObject(v) && typeof v.value === "number" && Object.keys(v).every((k) => ["value", "unit", "measuredOn", "date", "source"].includes(k));

const HOST_REASON = "changes which port, USB unit or vendor app the map looks for";

export function reviewReasons(p: SeedPatch, base: unknown, opts: ReviewOptions = {}): { change: string; reason: string }[] {
  const out: { change: string; reason: string }[] = [];
  const patched = applySeedPatch(base, p).map;
  // the pins as the base map has them and as the whole patch leaves them, so a change that brings a send onto a
  // blocked cmd, or a block onto a send's cmd, counts as well as one that edits a pin in place, whatever subset is accepted
  const pins = blockPins([base as Json, patched as Json]);
  const above = abovePins(pins);
  // separations load a map, so they're asked for only once a change writes a pin. A change's notes weigh the change
  // accepted alone, since a reviewer may turn the rest down; one that doesn't apply alone is weighed with the whole patch.
  // Past MAX_WEIGHED_ALONE changes the rest keep the plain reason, so a patch can't make the review load a map per change
  let separated: ReturnType<typeof separationNotes> | undefined;
  let weighed = 0;
  const notesFor = (c: Change, names: Set<string>) => {
    if (!opts.separations || weighed++ >= MAX_WEIGHED_ALONE) return [];
    separated ??= separationNotes(opts.separations, base, patched);
    const alone = p.changes.length > 1 ? applySeedPatch(base, p, new Set([c.id])) : undefined;
    return separated(alone?.results.find((r) => r.change === c.id)?.status === "applied" ? alone.map : patched, names) ?? [];
  };
  for (const c of p.changes) {
    const reasons = new Set<string>();
    const lifted = new Set<string>();
    const measured = parseEntry(c.entry)?.kind === "measured";
    if (c.action === "remove") reasons.add("removes an entry");
    for (const op of c.ops ?? []) {
      const segs = splitPointer(op.path);
      const put = "value" in op ? keysIn(op.value) : new Set<string>();
      const old = op.op === "add" ? undefined : at(base as Json, segs);
      // what goes is the value whose fingerprint is `was`; when the base map has another one there (an earlier op
      // moved an array's items, or the patch is stale), what goes isn't known, so a person looks
      if (op.op !== "add" && fingerprint(old) !== op.was) reasons.add("takes out something other than what the base map has there");
      // a firmware's delta stands in for the base map's entry on that firmware, so what it covers counts as taken out
      const covered = segs[0] === "firmwares" && op.op !== "remove" ? at(base as Json, segs.slice(2)) : undefined;
      const keys = new Set([...segs, ...put, ...keysIn(old), ...keysIn(covered)]);
      const any = (set: Set<string>) => [...keys].some((k) => set.has(k));
      if (any(SAFETY_KEYS)) reasons.add("changes safety rules, blocked lists or hazards");
      if (writesPin(segs, pins, above)) {
        reasons.add(LIFT_BLOCK);
        for (const n of touchedMessages(segs, [base as Json, patched as Json])) lifted.add(n);
      }
      if (any(WRITE_RANGE_KEYS)) reasons.add("changes what may be written");
      if (any(PROBE_KEYS)) reasons.add("changes what is probed or what verifies a write");
      if (!KNOWN_TOP.has(segs[0])) reasons.add("changes a map section this engine doesn't know");
      // a measured value is only a timing: framing is reviewed unless both what goes in and what comes out are measured values
      const onlyTiming = measured && ("value" in op ? isMeasured(op.value) : true) && (old === undefined || isMeasured(old));
      if ((segs[0] === "transport" || segs[0] === "addresses") && !onlyTiming) reasons.add("changes the framing of every message");
      if (segs[0] === "session") reasons.add("changes what is sent on every connect");
      // the identity decides which unit the map drives at all, whatever the change's evidence
      if (segs[0] === "identity") reasons.add("changes which unit the map drives (its identity)");
      // the driver picks the code that runs the unit; the host, which port, USB unit and vendor apps the map looks for
      // (a measured value there is only a timing, exempt as in the framing)
      if (segs[0] === "driver") reasons.add("changes which driver runs the unit");
      if (segs[0] === "host" && !onlyTiming) reasons.add(HOST_REASON);
      if (segs[0] === "modes") reasons.add("changes which entries a mode uses");
      if (segs[0] === "controls" && (segs.length < 3 || any(CONTROL_TARGET_KEYS))) reasons.add("may change what a control sends to");
      const last = segs.at(-1);
      if (("value" in op && makesSend(op.value, last) && !makesSend(old, last)) || (op.op === "add" && segs[0] === "controls" && segs.length <= 3))
        reasons.add("adds something that writes to the unit");
      // agentNotes and cautions (shown in the unit's status) reach the player's chat model; safety.notes reach the model
      // that drives a sniffer walk
      if (keys.has("agentNotes") || segs[0] === "cautions" || (keys.has("safety") && keys.has("notes"))) reasons.add("changes text a chat model reads");
    }
    // the separation notes stand where the plain reason would, at most MAX_SEPARATION_NOTES of them for the change
    const notes = reasons.has(LIFT_BLOCK) ? notesFor(c, lifted) : [];
    const lift = !notes.length
      ? [`${LIFT_BLOCK}: changes what tells a blocked message from a send on its cmd`]
      : [...notes.slice(0, MAX_SEPARATION_NOTES), ...(notes.length > MAX_SEPARATION_NOTES ? [`and ${notes.length - MAX_SEPARATION_NOTES} more pairs`] : [])].map((n) => `${LIFT_BLOCK}: ${n}`);
    for (const reason of reasons) for (const r of reason === LIFT_BLOCK ? lift : [reason]) out.push({ change: c.id, reason: r });
  }
  return out;
}

// ---- applying -------------------------------------------------------------------------------------------------------

export type ChangeStatus =
  /** its ops are in the map */
  | "applied"
  /** a mark (confirm, suspect, block): the reader keeps the mark in its own store; the map is unchanged, but for a confirm that raises the entry's source */
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

/** The value at a path, or undefined. */
function at(doc: Json | undefined, segs: readonly string[]): Json | undefined {
  let cur: Json | undefined = doc;
  for (const s of segs) {
    if (Array.isArray(cur)) cur = INDEX_RE.test(s) ? cur[Number(s)] : undefined;
    else if (isObject(cur)) cur = Object.hasOwn(cur, s) ? cur[s] : undefined;
    else return undefined;
  }
  return cur;
}

/**
 * What a change touched, to put back if it fails: each container it changed, as a shallow copy from before its first
 * change. The values an op writes are fresh copies, so restoring the containers restores the map.
 */
type Undo = Map<Json[] | Record<string, Json>, Json[] | Record<string, Json>>;

function save(undo: Undo, c: Json[] | Record<string, Json>): void {
  if (!undo.has(c)) undo.set(c, Array.isArray(c) ? [...c] : { ...c });
}

function rollBack(undo: Undo): void {
  for (const [c, was] of undo) {
    // by index and by defining keys: spreading a long array overflows the stack, and assigning an own `__proto__`
    // key would set the prototype instead
    if (Array.isArray(c)) {
      c.length = 0;
      (was as Json[]).forEach((x, i) => (c[i] = x));
    } else {
      for (const k of Object.keys(c)) delete c[k];
      for (const [k, x] of Object.entries(was)) Object.defineProperty(c, k, { value: x, writable: true, enumerable: true, configurable: true });
    }
  }
}

/** Apply one op in place, adding the path it wrote to `landed` (an append's `-` as its index), or say why not. */
function applyOp(doc: Json, op: Op, undo: Undo, landed: string[][]): string | null {
  const segs = splitPointer(op.path);
  // an add opens the objects on its way that aren't there yet, such as the delta of a firmware the map lacks
  if (op.op === "add") {
    let up: Json | undefined = doc;
    for (const s of segs.slice(0, -1)) {
      if (isObject(up) && !Object.hasOwn(up, s)) {
        save(undo, up);
        up[s] = {};
      }
      up = at(up, [s]);
    }
  }
  const parent = at(doc, segs.slice(0, -1));
  const last = segs[segs.length - 1];
  const target = at(doc, segs);
  if (op.op === "add") {
    if (Array.isArray(parent) && last === "-") {
      save(undo, parent);
      landed.push([...segs.slice(0, -1), String(parent.length)]);
      parent.push(structuredClone(op.value) as Json);
      return null;
    }
    if (!isObject(parent)) return `${op.path}: nothing to add into`;
    if (target !== undefined) return `${op.path}: already there`;
    save(undo, parent);
    parent[last] = structuredClone(op.value) as Json;
    landed.push(segs);
    return null;
  }
  if (target === undefined) return `${op.path}: not there`;
  if (fingerprint(target) !== op.was) return `${op.path}: was ${fingerprint(target)}, the patch expected ${op.was}`;
  const box = parent as Json[] | Record<string, Json>;
  save(undo, box);
  if (op.op === "replace") (box as Record<string, Json>)[last] = structuredClone(op.value) as Json;
  else if (Array.isArray(box)) box.splice(Number(last), 1);
  else delete box[last];
  landed.push(segs);
  return null;
}

/** The parameter groups that stand in for another in some mode (`modes.use.<mode>.groups`); one mapped to itself doesn't. */
function standInGroups(doc: Json): Set<string> {
  const out = new Set<string>();
  const use = at(doc, ["modes", "use"]);
  if (isObject(use))
    for (const u of Object.values(use)) {
      const g = isObject(u) ? u.groups : undefined;
      if (isObject(g)) for (const [k, v] of Object.entries(g)) if (typeof v === "string" && v !== k) out.add(v);
    }
  return out;
}

/** A parameter group holds the tables of a block (`blocks`) or, on a slot pedal, of an effect type (`types`). */
const owns = (grp: Record<string, Json>, owner: string): boolean =>
  (Array.isArray(grp.blocks) && grp.blocks.includes(owner)) || (Array.isArray(grp.types) && grp.types.includes(owner));

/**
 * Where an entry is in a map for a firmware, as concrete paths: its delta's and the base's homes that exist; for a
 * parameter, every parameter with its id in a group that lists its block (a stand-in group only when
 * the entry names it, as `param/<owner>/<id>/<group>`); for a setting, every item with its id.
 */
export function entryPaths(map: unknown, entry: string, fw: string, standIns?: ReadonlySet<string>): string[][] {
  const e = parseEntry(entry);
  if (!e || !isObject(map)) return [];
  const doc = map as Json;
  const out: string[][] = [];
  if (e.kind === "param") {
    const groups = at(doc, ["parameters", "groups"]);
    const stand = standIns ?? standInGroups(doc);
    if (isObject(groups))
      for (const [g, grp] of Object.entries(groups)) {
        // a plain entry is in a group that stands in for none; one with a group, in that stand-in group
        if (e.group === undefined ? stand.has(g) : g !== e.group || !stand.has(g)) continue;
        if (!isObject(grp) || !owns(grp, e.owner) || !isObject(grp.params)) continue;
        for (const [k, x] of Object.entries(grp.params)) if (isObject(x) && x.id === e.id) out.push(["parameters", "groups", g, "params", k]);
      }
    return out;
  }
  if (e.kind === "setting") {
    const items = at(doc, ["settings", "items"]);
    if (Array.isArray(items)) items.forEach((x, i) => isObject(x) && x.id === e.id && out.push(["settings", "items", String(i)]));
    return out;
  }
  for (const h of entryHomes(e)) {
    const path = h.map((s) => (s === FW ? fw : s));
    if (at(doc, path) !== undefined) out.push(path);
  }
  return out;
}

/** Whether the map has the entry for a firmware, in the firmware's delta or the base. */
export const hasEntry = (map: unknown, entry: string, fw: string): boolean => entryPaths(map, entry, fw).length > 0;

const under = (segs: readonly string[], home: readonly string[]) => segs.length >= home.length && home.every((h, i) => segs[i] === h);

/** The messages a firmware sees: the base map's, with the firmware's delta standing in for those it names. */
function messagesFor(map: Json, fw: string): Record<string, Json> {
  const base = at(map, ["messages"]);
  const delta = at(map, ["firmwares", fw, "messages"]);
  return { ...(isObject(base) ? base : {}), ...(isObject(delta) ? delta : {}) };
}

/**
 * A probe the seed doesn't allow: the request it names isn't a request in the map, isn't marked `safeRead` in a map that
 * marks them, or has a command a send in the same map also uses, so the "read" may have changed something on the unit.
 * `messages` are the map's as the unit was probed, before the patch.
 */
function unsafeProbe(messages: Record<string, Json>, c: Change): string | null {
  for (const e of c.evidence) {
    if (e.kind !== "probe") continue;
    const m = Object.hasOwn(messages, e.request) ? messages[e.request] : undefined;
    if (!isObject(m) || m.dir !== "request") return `probed ${e.request}, which is not a request in the map`;
    // once a map marks its safe reads, only those are probed
    if (m.safeRead !== true && Object.values(messages).some((x) => isObject(x) && Object.hasOwn(x, "safeRead"))) return `probed ${e.request}, which the map has not marked safeRead`;
    const sends = m.cmd === undefined ? [] : Object.entries(messages).filter(([, x]) => isObject(x) && x.dir === "send" && x.cmd === m.cmd);
    if (sends.length) return `probed ${e.request}, whose command ${String(m.cmd)} the send ${sends[0][0]} also uses`;
  }
  return null;
}

/**
 * Why a change's mode doesn't fit the map: an `@<mode>` entry or a grouped parameter needs a mode the map uses, and a
 * grouped parameter's group must stand in for another in that mode; a plain entry seen in a mode where another entry
 * stands in for it is evidence about the stand-in, not about it.
 */
function modeIssue(use: Json | undefined, doc: Json, e: Entry | null, mode: string | undefined): string | null {
  const modeOf = (m: string | undefined) =>
    m !== undefined && isObject(use) && Object.hasOwn(use, m) && isObject(use[m]) ? (use[m] as Record<string, Json>) : undefined;
  // the entry that stands in for `name` in a mode's `messages` or `groups`; one mapped to itself doesn't
  const standsIn = (u: Record<string, Json>, kind: "messages" | "layouts" | "enums" | "constants" | "groups", name: string) => {
    const t = u[kind];
    const v = isObject(t) && Object.hasOwn(t, name) ? t[name] : undefined;
    return typeof v === "string" && v !== name ? v : undefined;
  };
  if (e?.kind === "message" && e.mode !== undefined) {
    const u = modeOf(e.mode);
    if (!u) return `the map has no mode ${e.mode}`;
    // a mode that stands another message in never reads this one
    const s = standsIn(u, "messages", e.message);
    return s === undefined ? null : `mode ${e.mode} reads ${s}, not ${e.message}; name that entry`;
  }
  if (e?.kind === "param" && e.group !== undefined) {
    const u = modeOf(mode);
    if (!u) return `a parameter of the stand-in group ${e.group} needs the mode it was seen in, one the map uses`;
    const g = u.groups;
    return isObject(g) && Object.entries(g).some(([k, v]) => v === e.group && k !== v) ? null : `group ${e.group} stands in for none in mode ${mode}`;
  }
  if (mode === undefined || !e) return null;
  const u = modeOf(mode);
  if (!u) return isObject(use) ? `the map has no mode ${mode}` : null;
  // a mode's own message, layout, enum or constant stands in for the shared one: the evidence is about that one
  const KINDS = { message: "messages", layout: "layouts", enum: "enums", constant: "constants" } as const;
  if (e.kind === "message" || e.kind === "layout" || e.kind === "enum" || e.kind === "constant") {
    const name = e.kind === "message" ? e.message : e.name;
    const s = standsIn(u, KINDS[e.kind], name);
    return s === undefined ? null : `in mode ${mode}, ${s} stands in for ${name}`;
  }
  if (e.kind !== "param") return null;
  const groups = at(doc, ["parameters", "groups"]);
  if (isObject(groups))
    for (const [g, grp] of Object.entries(groups)) {
      const s = standsIn(u, "groups", g);
      if (s !== undefined && isObject(grp) && owns(grp, e.owner)) return `in mode ${mode}, ${s} stands in for group ${g}`;
    }
  return null;
}

/** The map's source kinds, weakest first (device-map-protocol.md, `source`; agreed with the app 24 Nov 2026). */
const SOURCE_RANK = ["doc", "player-confirmed", "wire", "device-reported", "read-back", "replay-verified", "test"];

/** What the evidence that backs a change's source was read from, for the entry's `source.ref`. */
function sourceRef(p: SeedPatch, c: Change): string | undefined {
  const e = c.source ? c.evidence.find(backs[c.source]) : undefined;
  if (!e) return undefined;
  const file = "file" in e ? e.file : undefined;
  const sha = file !== undefined && p.files && Object.hasOwn(p.files, file) ? p.files[file].sha256 : undefined;
  const ref =
    e.kind === "doc" ? e.citation
    : e.kind === "probe" ? `probe ${e.request} at ${e.at}`
    : file !== undefined ? `${e.kind} ${file}${sha ? ` sha256:${sha.slice(0, 16)}` : ""}`
    : "at" in e ? `${e.kind} at ${e.at}` : undefined;
  return ref?.slice(0, 512);
}

const withSource = (kind: Source, ref: string | undefined): Json => (ref ? { kind, ref } : { kind });

/** The objects that keep a source (a message, a parameter, a choice) at `pat` under `path`, as concrete paths. */
function homesUnder(doc: Json, path: string[], pat: readonly string[]): string[][] {
  if (!pat.length) return isObject(at(doc, path)) ? [path] : [];
  const [k, ...rest] = pat;
  const v = at(doc, path);
  if (!isObject(v)) return [];
  return (k === "*" ? Object.keys(v) : Object.hasOwn(v, k) ? [k] : []).flatMap((x) => homesUnder(doc, [...path, x], rest));
}

/** Where a path is in a source home: the home it is in, or the homes it holds, in the base or a firmware delta. */
function sourceHomesOf(doc: Json, segs: readonly string[]): string[][] {
  const fws = segs[0] === "firmwares" ? (segs.length >= 2 ? [segs[1]] : Object.keys((at(doc, ["firmwares"]) as Record<string, Json>) ?? {})) : [undefined];
  return fws.flatMap((fw) => {
    const prefix = fw === undefined ? [] : ["firmwares", fw];
    const own = fw === undefined ? segs : segs.slice(2);
    // a group's own keys (its blocks or types, say) are part of every one of its parameters' claim
    if (own.length >= 4 && own[0] === "parameters" && own[1] === "groups" && own[3] !== "params")
      return homesUnder(doc, [...prefix, ...own.slice(0, 3)], ["params", "*"]);
    return SOURCE_HOMES.flatMap((home) => {
      const n = Math.min(own.length, home.length);
      if (!home.slice(0, n).every((x, i) => x === "*" || x === own[i])) return [];
      // in a home: that one; above homes: every one it holds
      return own.length >= home.length ? [[...prefix, ...own.slice(0, home.length)]] : homesUnder(doc, [...prefix, ...own], home.slice(own.length));
    });
  });
}

/**
 * An edit gives its source to every message, parameter or choice its ops landed in or wrote whole, whatever entry
 * the change names (a section or measured edit that changes a parameter changes the claim the parameter's source
 * backs). It replaces the old source, which backed the claim as it was.
 */
function giveEditSource(doc: Json, p: SeedPatch, c: Change, landed: readonly string[][]): void {
  if (c.source === undefined) return;
  const ref = sourceRef(p, c);
  const done = new Set<string>();
  for (const l of landed)
    for (const h of sourceHomesOf(doc, l)) {
      const key = h.join(SEP);
      const entry = at(doc, h);
      if (done.has(key) || !isObject(entry)) continue;
      done.add(key);
      entry.source = withSource(c.source, ref);
    }
}

/**
 * A confirm raises its entry's source, never lowers it, and only when the evidence is about the entry as it now is:
 * on the map the patch was made against, with no earlier change in the patch having edited it, and for the whole
 * entry (not one block's or one mode's view of a message). It lands in the unit's firmware delta when the delta has the
 * entry, else in the base.
 */
function raiseSource(doc: Json, input: Json, p: SeedPatch, c: Change, paths: string[][], standIns: ReadonlySet<string>): void {
  const e = parseEntry(c.entry);
  if (c.source === undefined || !e || (e.kind === "message" && (e.block !== undefined || e.mode !== undefined))) return;
  // the entry as the evidence saw it: an earlier change may have made the name reach another item (a group's blocks)
  const seen = new Set(entryPaths(input, c.entry, p.unit.firmware, standIns).map((h) => h.join(SEP)));
  // only paths that are a home themselves; a section's path holds homes but is none
  const homes = paths.filter((h) => {
    if (!seen.has(h.join(SEP))) return false;
    const own = h[0] === "firmwares" ? h.slice(2) : h;
    return SOURCE_HOMES.some((home) => own.length === home.length && home.every((x, i) => x === "*" || x === own[i]));
  });
  const delta = homes.filter((h) => h[0] === "firmwares");
  const ref = sourceRef(p, c);
  const claim = (v: Json | undefined) => (isObject(v) ? fingerprint({ ...v, source: undefined }) : undefined);
  // a base entry serves every firmware without its own delta: say which one the evidence was seen on
  const baseRef = `${ref ?? c.source}, on ${p.unit.firmware}`.slice(0, 512);
  for (const h of delta.length ? delta : homes) {
    const entry = at(doc, h);
    if (!isObject(entry) || claim(entry) !== claim(at(input, h))) continue;
    const had = isObject(entry.source) && typeof entry.source.kind === "string" ? SOURCE_RANK.indexOf(entry.source.kind) : -1;
    if (SOURCE_RANK.indexOf(c.source) > had) entry.source = withSource(c.source, delta.length ? ref : baseRef);
  }
}

/**
 * Apply a checked patch to a copy of the map, change by change, each all or nothing. `accept` limits it to the
 * changes a review accepted. A change whose ops no longer fit (a `was` that doesn't match) is left out as stale,
 * so a patch made against an older map still lands wherever its entries are unchanged. A change is refused when its
 * ops don't do what its action says, when they edit another parameter or setting than the one its entry names, when
 * a confirm or suspect names an entry the map lacks, or when its evidence probed a request the map doesn't allow.
 */
export function applySeedPatch(map: unknown, p: SeedPatch, accept?: ReadonlySet<string>): { map: unknown; rebased: boolean; results: ChangeResult[] } {
  const doc = structuredClone(map) as Json;
  const fw = p.unit.firmware;
  // from the input map, which is never changed: doc's messages change as the changes land
  const probed = messagesFor(map as Json, fw);
  // which groups stand in is read from the map as the reviewer saw it, not as earlier changes leave it
  const standIns = standInGroups(map as Json);
  const modeUse = at(map as Json, ["modes", "use"]);
  const rebased = fingerprint(map) !== p.base.file;
  const refused = (c: Change, why: string): ChangeResult => ({ change: c.id, status: "refused", why });
  const results: ChangeResult[] = p.changes.map((c) => {
    if (accept && !accept.has(c.id)) return { change: c.id, status: "skipped" };
    const probe = unsafeProbe(probed, c);
    if (probe) return refused(c, probe);
    const e = parseEntry(c.entry);
    const kind = e?.kind;
    const before = entryPaths(doc, c.entry, fw, standIns);
    const wrongMode = modeIssue(modeUse, doc, e, c.mode);
    if (wrongMode) return refused(c, wrongMode);
    // a bare name is the message or the top-level section, never both: in the map, or once the ops have run; an entry
    // with a block or a mode never covers the section, so a top-level key of its message's name counts on its own
    if (e?.kind === "message") {
      const top = [...before.map((h) => h.length === 1), ...(c.ops ?? []).map((op) => splitPointer(op.path)[0] === c.entry)];
      if ((e.block !== undefined || e.mode !== undefined) && at(doc, [e.message]) !== undefined) top.push(true);
      if (top.includes(true) && top.includes(false)) return refused(c, `${e.message} is both a message and a top-level section of the map`);
    }
    if (!c.ops) {
      if ((c.action === "confirm" || c.action === "suspect") && !before.length) return refused(c, "the map has no such entry to mark");
      if (c.action === "confirm" && !rebased) raiseSource(doc, map as Json, p, c, before, standIns);
      return { change: c.id, status: "marked" };
    }
    // an add is for an entry the map lacks: one it has was added since the patch was made, or the add is a repair
    if (c.action === "add" && before.length) return { change: c.id, status: "stale", why: "the map already has the entry" };
    const undo: Undo = new Map();
    const landed: string[][] = [];
    for (const op of c.ops) {
      const why = applyOp(doc, op, undo, landed);
      if (why) {
        rollBack(undo);
        return { change: c.id, status: "stale", why };
      }
    }
    const after = entryPaths(doc, c.entry, fw, standIns);
    const why =
      c.action === "remove" ? (after.length ? "the entry is still there" : null) : !after.length ? "the entry isn't there after the ops" : null;
    // a parameter or setting is found by its id, so its ops must land on that one, not another in the same table
    const own = c.action === "add" ? after : before;
    const stray = kind === "param" || kind === "setting" ? c.ops.findIndex((_, j) => !own.some((h) => under(landed[j], h))) : -1;
    if (why || stray >= 0) {
      rollBack(undo);
      return refused(c, why ?? `${c.ops[stray].path} is not where ${c.entry} is`);
    }
    giveEditSource(doc, p, c, landed);
    return { change: c.id, status: "applied" };
  });
  return { map: doc, rebased, results };
}
