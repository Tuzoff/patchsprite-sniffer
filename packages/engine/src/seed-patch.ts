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
const NAME_RE = /^[a-z][A-Za-z0-9]*$/;
/** An array index in a JSON Pointer segment. */
const INDEX_RE = /^(0|[1-9]\d*)$/;
const name = z.string().max(64).regex(NAME_RE, "names are camelCase");
const firmware = z.string().max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const sourceId = z.string().max(64).regex(/^[a-z0-9][a-z0-9-]*$/, "source ids are lowercase letters, digits and dashes");
const u16 = z.number().int().min(0).max(0xffff);

// ---- entries ------------------------------------------------------------------------------------------------------

/**
 * The map's top-level keys this engine knows that a change may cover whole. Any other top-level key, such as a section
 * a newer map or a draft has, is a whole-section entry too, named by its key alone (see parseEntry).
 */
export const SECTION_ENTRIES = [
  "transport", "host", "identity", "driver", "session", "safety", "blocked", "hazards", "scratch", "audio", "display",
  "parameters", "controls", "settings", "eq", "addresses", "editor", "modes",
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
  | { kind: "param"; block: string; id: number; group?: string }
  /** a set of paired parameters in a parameter group (`linked/<group>/<set>`) */
  | { kind: "linked"; group: string; set: string }
  | { kind: "setting"; id: string }
  | { kind: (typeof NAMED_KINDS)[number]; name: string }
  | { kind: "section"; section: (typeof SECTION_ENTRIES)[number] };

const BLOCK_RE = /^[a-z][A-Za-z0-9_]*$/;
const KEY_RE = /^[a-z][a-z0-9_]*$/;
/** A parameter group's key, as `param/<block>/<id>/<group>` and `linked/<group>/<set>` name it. */
const isGroup = (s: string) => s.length <= 64 && (KEY_RE.test(s) || NAME_RE.test(s));

/**
 * An entry name, as the app's map checks write it (docs/design/map-checks.md in the app) plus the kinds a patch also
 * needs: `<message>`, `<message>/<block>`, `<message>@<mode>`, `<message>@<mode>/<block>`, `param/<block>/<id>`,
 * `param/<block>/<id>/<group>`, `choice/<name>`, then `layout/<name>`, `enum/<name>`, `constant/<name>`,
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
    if (parts.length === 3) return { kind: "param", block: a, id: Number(b) };
    return isGroup(parts[3]) ? { kind: "param", block: a, id: Number(b), group: parts[3] } : null;
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

/**
 * Rules the schema can't state: unique ids and entries, ops that fit the action and stay inside the entry's homes,
 * no two changes editing the same place, a source the evidence backs, and evidence sources that exist.
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
      if (c.action === "add" && op.op !== "add") add(`.ops[${j}].op`, "an add only adds");
      if (c.action === "remove" && op.op !== "remove") add(`.ops[${j}].op`, "a remove only removes");
      if (op.op === "add" && INDEX_RE.test(segs[segs.length - 1])) add(`.ops[${j}].path`, "add appends to an array with -; to change an array in the middle, replace it whole");
      if (BOOKKEEPING.has(segs[0]) || segs.includes("provenance") || ("value" in op && keysIn(op.value).has("provenance")))
        add(`.ops[${j}]`, "provenance comes from the change's source and evidence, and status and gaps are the draft's own bookkeeping; ops never write them");
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
      if ("source" in e && e.source !== undefined && !Object.hasOwn(p.sources ?? {}, e.source)) add(`.evidence[${j}].source`, `no source "${e.source}" in sources`);
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
const WRITE_RANGE_KEYS = new Set(["allowed", "writable", "min", "max", "saturate", "readOnly", "linked"]);
/** Keys that decide what first contact sends to an unknown unit and whether a write counts as verified. */
const PROBE_KEYS = new Set(["safeRead", "readBack"]);
/** Keys of a MIDI channel control that say what it sends to: a changed one retargets every write through it. */
const CONTROL_TARGET_KEYS = new Set(["type", "cc", "pc", "nrpn", "number", "msb", "lsb", "channel", "bits"]);

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

export function reviewReasons(p: SeedPatch, base: unknown): { change: string; reason: string }[] {
  const out: { change: string; reason: string }[] = [];
  for (const c of p.changes) {
    const reasons = new Set<string>();
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
      if (any(WRITE_RANGE_KEYS)) reasons.add("changes what may be written");
      if (any(PROBE_KEYS)) reasons.add("changes what is probed or what verifies a write");
      if (!KNOWN_TOP.has(segs[0])) reasons.add("changes a map section this engine doesn't know");
      // a measured value is only a timing: framing is reviewed unless both what goes in and what comes out are measured values
      const onlyTiming = measured && ("value" in op ? isMeasured(op.value) : true) && (old === undefined || isMeasured(old));
      if ((segs[0] === "transport" || segs[0] === "addresses") && !onlyTiming) reasons.add("changes the framing of every message");
      if (segs[0] === "session") reasons.add("changes what is sent on every connect");
      if (segs[0] === "modes") reasons.add("changes which entries a mode uses");
      if (segs[0] === "controls" && (segs.length < 3 || any(CONTROL_TARGET_KEYS))) reasons.add("may change what a control sends to");
      const last = segs.at(-1);
      if (("value" in op && makesSend(op.value, last) && !makesSend(old, last)) || (op.op === "add" && segs[0] === "controls" && segs.length <= 3))
        reasons.add("adds something that writes to the unit");
      // agentNotes reach the player's chat model; safety.notes reach the model that drives a sniffer walk
      if (keys.has("agentNotes") || (keys.has("safety") && keys.has("notes"))) reasons.add("changes text a chat model reads");
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

/**
 * Where an entry is in a map for a firmware, as concrete paths: its delta's and the base's homes that exist; for a
 * parameter, every parameter with its id in a group that lists its block (a stand-in group only when
 * the entry names it, as `param/<block>/<id>/<group>`); for a setting, every item with its id.
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
        if (!isObject(grp) || !Array.isArray(grp.blocks) || !grp.blocks.includes(e.block) || !isObject(grp.params)) continue;
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
  const modeOf = (m: string) => (isObject(use) && Object.hasOwn(use, m) && isObject(use[m]) ? (use[m] as Record<string, Json>) : undefined);
  const standsIn = (u: Record<string, Json> | undefined, kind: string, name: string) => {
    const t = u?.[kind];
    return isObject(t) && Object.hasOwn(t, name) && t[name] !== name ? t[name] : undefined;
  };
  if (e?.kind === "message" && e.mode !== undefined) return modeOf(e.mode) ? null : `the map has no mode ${e.mode}`;
  if (e?.kind === "param" && e.group !== undefined) {
    const u = mode === undefined ? undefined : modeOf(mode);
    if (!u) return `a parameter of the stand-in group ${e.group} needs the mode it was seen in, one the map uses`;
    const g = u.groups;
    return isObject(g) && Object.values(g).includes(e.group) ? null : `group ${e.group} stands in for none in mode ${mode}`;
  }
  if (mode === undefined || !e) return null;
  const u = modeOf(mode);
  if (!u) return isObject(use) ? `the map has no mode ${mode}` : null;
  if (e.kind === "message" && standsIn(u, "messages", e.message) !== undefined) return `in mode ${mode}, ${String(standsIn(u, "messages", e.message))} stands in for ${e.message}`;
  if (e.kind === "param") {
    const groups = at(doc, ["parameters", "groups"]);
    if (isObject(groups))
      for (const [g, grp] of Object.entries(groups))
        if (isObject(grp) && Array.isArray(grp.blocks) && grp.blocks.includes(e.block) && standsIn(u, "groups", g) !== undefined)
          return `in mode ${mode}, ${String(standsIn(u, "groups", g))} stands in for group ${g}`;
  }
  return null;
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
    return { change: c.id, status: "applied" };
  });
  return { map: doc, rebased, results };
}
