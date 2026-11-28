// Partial loading of a draft device map (protocol.draft.json): a map that no real unit has confirmed, and that may
// need engine features this app does not have yet. What the app can run loads, as a draft; every entry it cannot run is
// left out and listed as unsupported, with one line of why.
//
// The draft is untrusted input: every list is capped, entry paths are checked segment by segment and never reach
// inherited properties, and nothing that keeps the unit safe or decides how it is driven (blocked messages, the safety
// section, firmwares, the driver, the host, the display, the session's on-connect steps, the identity) is ever left out: a draft
// where one of those does not load is refused whole.

import { z } from "zod";
import { shownText, text } from "./map-text.ts";
import { ProtocolError, ProtocolSchema, type Protocol } from "./protocol-schema.ts";

// ---- limits ----------------------------------------------------------------------------------------------------

/** Items in `requires` and in `gaps`, entries one item names, and the length of a `why`. */
const MAX_ITEMS = 512;
const MAX_ENTRIES_PER_ITEM = 256;
const MAX_WHY = 512;
/** Validation rounds: each one leaves out at least one entry, and what it leaves out can take others with it. */
const MAX_ROUNDS = 64;
/** The longest reason kept per unsupported entry (a schema problem can be long). */
const MAX_REASON = 300;

// ---- the app's engine features ------------------------------------------------------------------------------------

/** Every literal value a zod schema accepts, through optionals, preprocessors, pipes, enums and literals. */
function literals(s: unknown): string[] {
  const def = (s as { _zod?: { def?: Record<string, unknown> } } | undefined)?._zod?.def;
  if (!def) return [];
  switch (def.type) {
    case "optional":
    case "nullable":
    case "default":
      return literals(def.innerType);
    case "pipe":
      return literals(def.out);
    case "enum":
      return Object.values(def.entries as Record<string, unknown>).filter((v): v is string => typeof v === "string");
    case "literal":
      return (def.values as unknown[]).filter((v): v is string => typeof v === "string");
    case "union":
      return (def.options as unknown[]).flatMap(literals);
    default:
      return [];
  }
}

/**
 * The engine features this app has, by id: `transport:midi`, `framing:<name>` for every framing the schema takes, and
 * `driver:<name>` for every driver it names. They are read from the schema itself, so an engine PR that adds a framing
 * or a driver adds its feature without touching this list. Features that are not a framing or a driver are named in
 * FEATURES below.
 */
export function engineFeatures(): Set<string> {
  const shape = protocolShape();
  const transport = shape.transport as { options?: { shape: Record<string, unknown> }[] };
  const framings = (transport.options ?? []).flatMap((o) => literals(o.shape.framing));
  const drivers = literals(shape.driver);
  return new Set([...FEATURES, ...framings.map((f) => `framing:${f}`), ...drivers.map((d) => `driver:${d}`)]);
}

/** Engine features that are not a framing or a driver: an engine PR adds its own here. */
const FEATURES = ["transport:midi"];

/** Whether the schema refuses a driver name as an old one it was renamed from (a custom issue, not an unknown value). */
const renamedDriver = (v: string) =>
  (protocolShape().driver as z.ZodType).safeParse(v).error?.issues.some((i) => i.code === "custom") ?? false;

/** The protocol's top-level keys and their schemas. */
const protocolShape = () => (ProtocolSchema as unknown as { shape: Record<string, unknown> }).shape;

// ---- the draft's own keys -------------------------------------------------------------------------------------------

/** A feature id: an area and a name, `framing:roland-address`, `transport:ble-midi`, `field:nibbles`. */
const featureId = z.string().max(64).regex(/^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9.+-]*$/, "a feature is area:name, lower case");
/**
 * An entry, by the id map checks and seed patches use for it: `<message>`, `layout/<name>`,
 * `enum/<name>`, `constant/<name>`, `choice/<name>`, `control/<name>`, `setting/<id>`, `param/<block>/<id>`,
 * `linked/<block>/<set>`, or a section's name (`eq`, `audio`).
 */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const entryId = z
  .string()
  .max(200)
  .refine((s) => s.split("/").length <= 3 && s.split("/").every((p) => SEGMENT.test(p)), "an entry id is 1 to 3 names joined by /");
const entries = z.array(entryId).min(1).max(MAX_ENTRIES_PER_ITEM);
// a why reaches the chat in the draft's status: it hides nothing from the player
const why = text().min(1).max(MAX_WHY);

const DraftKeys = z.object({
  /**
   * Engine features the map needs. A bare id is needed by the whole map: without it nothing loads. An item with
   * entries is needed by those entries only: without it they are unsupported and the rest loads.
   */
  requires: z.array(z.union([featureId, z.strictObject({ feature: featureId, entries, why: why.optional() })])).max(MAX_ITEMS).optional(),
  /**
   * What the map does not know or cannot say yet. A string is a note for people (the seeds' notes). An item with
   * entries makes those entries unsupported, whatever the app can do.
   */
  gaps: z.array(z.union([z.string().max(4096), z.strictObject({ entries, why })])).max(MAX_ITEMS).optional(),
});

// ---- the result -------------------------------------------------------------------------------------------------

export interface UnsupportedEntry {
  /** The entry's id, as map checks name it: `tuner`, `layout/blockStatus`, `param/amp/3`, `eq`. */
  entry: string;
  /** One line of why: the feature it needs, the map's own gap, or the schema problem it has. */
  why: string;
  /** The engine feature it needs and this app lacks, when that is the reason. */
  feature?: string;
  /** A blocked message cut to its cmd: still blocks, so nothing the player could use is off. */
  blockOnly?: true;
}

export interface DraftReport {
  /** Entries left out, in the order they were found. */
  unsupported: UnsupportedEntry[];
  /** Engine features the map names that this app lacks (each also explains its entries above). */
  missingFeatures: string[];
  /** Top-level keys the app does not read (the seeds' notes, sources and draft-only sections). */
  ignored: string[];
}

export interface DraftLoad {
  /** What loads: a valid protocol, made only of the entries the app can run. */
  protocol: Protocol;
  report: DraftReport;
}

/** A draft that cannot load at all: what it needs is missing, or what keeps the unit safe does not load. */
export class DraftMapError extends ProtocolError {
  constructor(message: string) {
    super(message);
    this.name = "DraftMapError";
  }
}

// ---- entries --------------------------------------------------------------------------------------------------

/** Keys the protocol cannot do without. */
const REQUIRED = new Set(["schema", "transport", "messages", "layouts"]);
/**
 * Keys that keep the unit safe or decide how it is driven: leaving one out would loosen what the app refuses to send
 * (blocked messages, the safety floor, and `firmwares`, which holds each firmware's own blocks and stricter safety) or
 * drive the unit another way (a dropped `driver` reads as the default), and `host`, without which the app would open a
 * port by the device's display name, which may be another unit's, and `display`, without which presets would be
 * numbered differently from the unit's screen (patchLabel falls back to `{index}` from 0), and `session`, without which
 * the unit would be driven without the steps it needs when the port opens (`session.onConnect`), and `modes`, without
 * which a unit in another mode would be sent the first mode's messages and edit that mode's patches, and `identity`,
 * without which the unit on the port would be driven without first checking it is the one the draft describes.
 */
const KEEP = new Set(["blocked", "safety", "driver", "firmwares", "host", "display", "session", "modes", "identity", "hazards", "cautions"]);
/** Entry kinds with a name, and the map table each lives in; those marked `fw` have a home in each firmware too. */
const KINDS: Record<string, { table: string[]; fw: boolean }> = {
  layout: { table: ["layouts"], fw: true },
  enum: { table: ["enums"], fw: false },
  constant: { table: ["constants"], fw: true },
  choice: { table: ["choices"], fw: false },
  control: { table: ["controls", "items"], fw: false },
};
const TABLE_KIND: Record<string, string> = { messages: "", layouts: "layout", enums: "enum", constants: "constant", choices: "choice" };

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);
/** The value at `path`, following own properties of objects only; undefined when it is not there. */
function at(v: unknown, path: readonly string[]): unknown {
  for (const seg of path) v = isObject(v) && Object.hasOwn(v, seg) ? v[seg] : undefined;
  return v;
}
const ownKeys = (v: unknown): string[] => (isObject(v) ? Object.keys(v) : []);

/** What leaving an entry out takes away: the ids reported, and the places in the map removed. */
interface Entry {
  ids: string[];
  /** Paths in the map; a last segment `@<id>` on an array means its items with that `id` (settings). */
  homes: string[][];
  /** A message the entry is, when it is one. */
  message?: string;
  /** A section the entry is, when it is one. */
  section?: string;
}

/** Top-level keys an entry id may name as a whole section. */
const SECTIONS = new Set([...Object.keys(protocolShape()), "controls"]);

/** A message's homes: the base map and every firmware that has its own version. */
function messageEntry(map: Json, name: string): Entry {
  const fws = ownKeys(map.firmwares).filter((f) => at(map, ["firmwares", f, "messages", name]) !== undefined);
  return { ids: [name], homes: [["messages", name], ...fws.map((f) => ["firmwares", f, "messages", name])], message: name };
}

function namedEntry(map: Json, kind: string, name: string): Entry {
  const { table, fw } = KINDS[kind];
  const fws = fw ? ownKeys(map.firmwares).filter((f) => at(map, ["firmwares", f, ...table, name]) !== undefined) : [];
  return { ids: [`${kind}/${name}`], homes: [[...table, name], ...fws.map((f) => ["firmwares", f, ...table, name])] };
}

/** The blocks (or effect types) a parameter group covers, when the map says so readably. */
function groupKeys(map: Json, group: string): string[] | undefined {
  const g = at(map, ["parameters", "groups", group]);
  const keys = isObject(g) ? (Array.isArray(g.blocks) ? g.blocks : Array.isArray(g.types) ? g.types : undefined) : undefined;
  return keys?.length && keys.length <= 256 && keys.every((k) => typeof k === "string" && SEGMENT.test(k)) ? (keys as string[]) : undefined;
}

/** One parameter of a group: `param/<block>/<id>` for each block the group covers. */
function paramEntry(map: Json, group: string, param: string): Entry | undefined {
  const keys = groupKeys(map, group);
  const id = at(map, ["parameters", "groups", group, "params", param, "id"]);
  if (!keys || typeof id !== "number" || !Number.isInteger(id)) return undefined;
  return { ids: keys.map((k) => `param/${k}/${id}`), homes: [["parameters", "groups", group, "params", param]] };
}

/** A whole parameter group: each of its parameters by id, or the whole parameters section when it can't say. */
function groupEntry(map: Json, group: string): Entry {
  const keys = groupKeys(map, group);
  const params = at(map, ["parameters", "groups", group, "params"]);
  const ids = ownKeys(params).map((p) => at(params, [p, "id"]));
  if (!keys || !ids.length || !ids.every((i) => typeof i === "number" && Number.isInteger(i))) return { ids: ["parameters"], homes: [["parameters"]], section: "parameters" };
  return { ids: keys.flatMap((k) => ids.map((i) => `param/${k}/${i}`)), homes: [["parameters", "groups", group]] };
}

/**
 * A parameter group's linked set (`linked/<block>/<set>` for each block the group covers, as map checks name it), with
 * its parameters: written one at a time, outside the set, they could go in an order the unit refuses, or be held pending
 * by a unit that takes the set on its last write, so they go with it. The whole parameters section when the group can't
 * say its blocks.
 */
function linkedSetEntry(map: Json, group: string, set: string): Entry {
  const keys = groupKeys(map, group);
  if (!keys) return groupEntry(map, group);
  const ids = keys.map((k) => `linked/${k}/${set}`);
  const homes = [["parameters", "groups", group, "linked", set]];
  const members = at(map, ["parameters", "groups", group, "linked", set, "params"]);
  for (const q of Array.isArray(members) ? members.slice(0, 256) : []) {
    // a parameter name is any string up to 64 (`Low Cut`), not a segment; at() follows own properties only
    const e = typeof q === "string" ? paramEntry(map, group, q) : undefined;
    if (!e) continue;
    ids.push(...e.ids);
    homes.push(...e.homes);
  }
  return { ids, homes };
}

/** Every linked set of a group, with their parameters; undefined when it has none. */
function linkedSetsEntry(map: Json, group: string): Entry | undefined {
  const sets = ownKeys(at(map, ["parameters", "groups", group, "linked"])).filter((s) => SEGMENT.test(s));
  if (!sets.length) return undefined;
  const all = sets.map((s) => linkedSetEntry(map, group, s));
  if (all.some((e) => e.section)) return groupEntry(map, group);
  return { ids: [...new Set(all.flatMap((e) => e.ids))], homes: all.flatMap((e) => e.homes) };
}

const sectionEntry = (s: string): Entry => ({ ids: [s], homes: [[s]], section: s });
/** A setting, by its id: its item in the `settings.items` array. */
const settingEntry = (id: string): Entry => ({ ids: [`setting/${id}`], homes: [["settings", "items", `@${id}`]] });

/** The entry an id from `requires` or `gaps` names. */
function entryOfId(map: Json, id: string): Entry {
  const p = id.split("/");
  if (p.length === 1) return SECTIONS.has(p[0]) ? sectionEntry(p[0]) : messageEntry(map, p[0]);
  if (p.length === 2 && Object.hasOwn(KINDS, p[0])) return namedEntry(map, p[0], p[1]);
  if (p.length === 2 && p[0] === "setting") return settingEntry(p[1]);
  if (p.length === 3 && p[0] === "param" && /^\d{1,5}$/.test(p[2])) {
    const homes: string[][] = [];
    const ids = new Set<string>();
    for (const g of ownKeys(at(map, ["parameters", "groups"]))) {
      if (!groupKeys(map, g)?.includes(p[1])) continue;
      for (const q of ownKeys(at(map, ["parameters", "groups", g, "params"]))) {
        if (at(map, ["parameters", "groups", g, "params", q, "id"]) !== Number(p[2])) continue;
        homes.push(["parameters", "groups", g, "params", q]);
        for (const i of paramEntry(map, g, q)?.ids ?? []) ids.add(i);
      }
    }
    return { ids: ids.size ? [...ids] : [id], homes };
  }
  if (p.length === 3 && p[0] === "linked") {
    // the set by that name in every group that covers the block, with its parameters
    const found = ownKeys(at(map, ["parameters", "groups"])).filter((g) => groupKeys(map, g)?.includes(p[1]) && at(map, ["parameters", "groups", g, "linked", p[2]]) !== undefined);
    const all = found.map((g) => linkedSetEntry(map, g, p[2]));
    return all.length ? { ids: [...new Set(all.flatMap((e) => e.ids))], homes: all.flatMap((e) => e.homes) } : { ids: [id], homes: [] };
  }
  if (p.length === 2 && p[0] !== "param" && !SECTIONS.has(p[0])) throw new DraftMapError(`entry ${id} is a message on one block, which map checks mark but a map can't leave out; name the message`);
  throw new DraftMapError(`entry ${id} is not an entry id`);
}

/** The entry a schema problem at `path` belongs to; undefined when it belongs to none that could be left out. */
function entryAtPath(map: Json, path: readonly PropertyKey[]): Entry | undefined {
  const p = path.map((x) => (typeof x === "symbol" ? "" : String(x)));
  const [top] = p;
  const tableEntry = (table: string, name: string | undefined) =>
    name === undefined ? undefined : table === "messages" ? messageEntry(map, name) : namedEntry(map, TABLE_KIND[table], name);
  if (Object.hasOwn(TABLE_KIND, top)) return tableEntry(top, p[1]) ?? sectionEntry(top);
  if (top === "firmwares") return p.length >= 4 && Object.hasOwn(TABLE_KIND, p[2]) ? tableEntry(p[2], p[3]) : p.length >= 3 && KEEP.has(p[2]) ? sectionEntry(p[2]) : undefined;
  if (top === "controls" && p[1] === "items" && p[2] !== undefined) return namedEntry(map, "control", p[2]);
  if (top === "settings" && p[1] === "items" && p[2] !== undefined) {
    const items = at(map, ["settings", "items"]);
    const item = Array.isArray(items) ? items[Number(p[2])] : undefined;
    const sid = isObject(item) ? item.id : undefined;
    return typeof sid === "string" && SEGMENT.test(sid) ? settingEntry(sid) : sectionEntry("settings");
  }
  if (top === "parameters" && p[1] === "groups" && p[2] !== undefined) {
    if (p[3] === "linked" && p[4] !== undefined && SEGMENT.test(p[4])) return linkedSetEntry(map, p[2], p[4]);
    return (p[3] === "params" && p[4] !== undefined ? paramEntry(map, p[2], p[4]) : undefined) ?? groupEntry(map, p[2]);
  }
  return top ? sectionEntry(top) : undefined;
}

/**
 * The entry a cross-check problem names. Those problems come as text ("message x: ...", "firmware f: layout y: ...");
 * one that names no entry returns undefined, and the draft is refused with it.
 */
function entryOfIssue(map: Json, text: string): Entry | undefined {
  const rest = /^firmware \S+: (.*)$/s.exec(text)?.[1] ?? text;
  const m = /^(message|layout|setting) ([A-Za-z0-9_]+)\b/.exec(rest);
  if (m?.[1] === "message") return messageEntry(map, m[2]);
  if (m?.[1] === "layout") return namedEntry(map, "layout", m[2]);
  if (m?.[1] === "setting") return settingEntry(m[2]);
  if (rest !== text) return undefined;
  if (/^settings /.test(rest)) return sectionEntry("settings");
  if (/^eq\b/.test(rest)) return sectionEntry("eq");
  // a unit with scenes needs the display's words for them: without those it runs without scenes (a patch-dump unit
  // always has scenes, so there the display is what's wrong, and it is never left out)
  const patchDump = (map.driver ?? "patch-dump") === "patch-dump";
  if (!patchDump && /^display\.\w+: needed on a device with scenes/.test(rest)) return namedEntry(map, "constant", "scenes");
  if (/^display\b/.test(rest)) return sectionEntry("display");
  // a group with linked sets that a mode stands in, or stands another in for: its sets go, with their parameters, so the
  // mode is kept (the modes section is never left out) and the group's other parameters with it
  const standIn = /^modes\.use\.[^.\s]+\.groups: "([A-Za-z0-9_]+)" has linked sets\b/.exec(rest);
  const sets = standIn && linkedSetsEntry(map, standIn[1]);
  if (sets) return sets;
  // a mode's read or stand-ins: the modes section, which is never left out (an entry a mode names was left out)
  if (/^modes\b/.test(rest)) return sectionEntry("modes");
  const set = /^parameters\.([A-Za-z0-9_]+)\.linked\.([a-z][a-z0-9_]*)[.:]/.exec(rest);
  if (set) return linkedSetEntry(map, set[1], set[2]);
  const group = /^parameters\.([A-Za-z0-9_]+)\b/.exec(rest);
  if (group) return groupEntry(map, group[1]);
  if (/^parameters\b/.test(rest)) return sectionEntry("parameters");
  const choice = /^choices\.([A-Za-z0-9_]+)\b/.exec(rest);
  if (choice) return namedEntry(map, "choice", choice[1]);
  if (/^audio\b/.test(rest)) return sectionEntry("audio");
  return undefined;
}

/** Message names the map blocks, in the base and on any firmware. */
function blockedNames(map: Json): Set<string> {
  const out = new Set<string>();
  const add = (v: unknown) => {
    if (Array.isArray(v)) for (const n of v.slice(0, 1024)) if (typeof n === "string") out.add(n);
  };
  add(map.blocked);
  for (const f of ownKeys(map.firmwares)) add(at(map, ["firmwares", f, "blocked"]));
  return out;
}

const baseBlocked = (map: Json, name: string) => Array.isArray(map.blocked) && map.blocked.includes(name);

/** Why an entry may not be left out, or undefined when it may. */
function keptReason(e: Entry, map: Json, keep: ReadonlySet<string>): string | undefined {
  // a kept entry goes with its whole table too (`enums` holds `enum/noBypass`)
  const driverKeeps = e.ids.find((id) => keep.has(id)) ?? [...keep].find((id) => e.section !== undefined && KINDS[id.split("/")[0]]?.table[0] === e.section);
  if (driverKeeps) return `the driver relies on ${driverKeeps} to refuse what is unsafe, so it is never left out`;
  if (e.section && REQUIRED.has(e.section)) return `the map cannot do without its ${e.section}`;
  if (e.section && KEEP.has(e.section)) return `${e.section} keeps the unit safe or decides how it is driven, so it is never left out`;
  if (e.message !== undefined && blockedNames(map).has(e.message)) return `message ${e.message} is blocked, and a block is never left out`;
  return undefined;
}

/**
 * A blocked message is never sent, so a block needs only its cmd and direction (the cmd is what other messages are
 * checked against). One that does not load in full is cut to those two in every home; true when any was. On the
 * roland-address framing a block's payload is part of what it blocks (a write covers the addresses after its own, and
 * its address fields move it over an area), so a block with one there is never cut: false, and the draft is refused.
 */
function toBlockOnly(map: Json, e: Entry): boolean {
  const spans = at(map, ["transport", "framing"]) === "roland-address";
  if (spans && e.homes.some((h) => at(map, [...h, "payload"]) !== undefined)) return false;
  let cut = false;
  for (const h of e.homes) {
    const m = at(map, h);
    if (!isObject(m) || typeof m.cmd !== "string" || typeof m.dir !== "string") continue;
    for (const k of Object.keys(m)) {
      if (k === "cmd" || k === "dir") continue;
      delete m[k];
      cut = true;
    }
  }
  return cut;
}

/** Removes one home from the map; true when it was there. Only own properties are followed. */
function remove(map: Json, home: string[]): boolean {
  const parent = at(map, home.slice(0, -1));
  const last = home[home.length - 1];
  if (last.startsWith("@")) {
    if (!Array.isArray(parent)) return false;
    const keep = parent.filter((x) => !(isObject(x) && x.id === last.slice(1)));
    if (keep.length === parent.length) return false;
    parent.splice(0, parent.length, ...keep);
    return true;
  }
  if (!isObject(parent) || !Object.hasOwn(parent, last)) return false;
  delete parent[last];
  return true;
}

/** An entry id as a person reads it: "message tuner", "layout blockStatus", "parameter 3 of amp", "the eq section". */
export function draftEntryText(id: string): string {
  const p = id.split("/");
  if (p.length === 1) return SECTIONS.has(p[0]) ? `the ${p[0]} section` : `message ${p[0]}`;
  if (p.length === 3 && p[0] === "param") return `parameter ${p[2]} of ${p[1]}`;
  if (p.length === 3 && p[0] === "linked") return `linked set ${p[2]} of ${p[1]}`;
  return p.join(" ");
}

/** At most this many ignored top-level keys are listed, each cut to this length: the list reaches the chat. */
const MAX_IGNORED = 32;
const MAX_IGNORED_KEY = 64;

const clip = (s: string) => {
  const line = shownText(s.replace(/\s+/g, " ").trim());
  return line.length > MAX_REASON ? `${line.slice(0, MAX_REASON - 1)}…` : line;
};

// ---- loading ------------------------------------------------------------------------------------------------------

/** Protocols loaded from a draft. Kept beside them, not in them, so the protocol's shape stays the schema's. */
const drafts = new WeakSet<Protocol>();

/** Whether a protocol came from a draft map no real unit has confirmed (first-write.ts keeps its writes gated). */
export const isDraftProtocol = (p: Protocol): boolean => drafts.has(p);

/** How a draft loads: against which features, and the driver's own rules. */
export interface DraftOptions {
  /** The engine features to load against; default: this app's. */
  features?: ReadonlySet<string>;
  /** Entry ids the driver relies on to refuse what is unsafe (an enum of blocks it never bypasses): never left out. */
  keep?: readonly string[];
  /** Entry ids the driver uses only all together: when one is left out, the rest go with it. */
  together?: readonly (readonly string[])[];
  /** Entry ids the driver uses only beside one of a group: when the whole group is off, the entry goes too. */
  needs?: Readonly<Record<string, readonly string[]>>;
}

/**
 * Loads what a draft map's protocol can run on this app. Top-level keys the protocol does not have are ignored;
 * entries a missing feature or the map's own gaps name are left out; then every entry that still does not validate is
 * left out with its problem as the reason, and the entries that depended on it with it, until the rest validates.
 * Throws DraftMapError when the whole map needs a feature this app lacks, or when something that cannot be left out
 * does not load.
 */
export function loadDraftProtocol(json: unknown, opts: DraftOptions = {}): DraftLoad {
  const features = opts.features ?? engineFeatures();
  const keep = new Set(opts.keep ?? []);
  if (!isObject(json)) throw new DraftMapError("a draft map is a JSON object");
  const own = DraftKeys.safeParse({ requires: json.requires, gaps: json.gaps });
  if (!own.success) throw new DraftMapError(`the draft's requires or gaps are invalid:\n${z.prettifyError(own.error)}`);
  const known = new Set(Object.keys(protocolShape()));
  const map: Json = {};
  const ignored: string[] = [];
  for (const [k, v] of Object.entries(json)) {
    if (known.has(k)) map[k] = structuredClone(v);
    else if (k !== "requires" && k !== "gaps") ignored.push(clip(k).slice(0, MAX_IGNORED_KEY));
  }
  if (ignored.length > MAX_IGNORED) ignored.splice(MAX_IGNORED, Infinity, `and ${ignored.length - MAX_IGNORED} more`);

  const missing = new Set<string>();
  const unsupported: UnsupportedEntry[] = [];
  /**
   * Leaves an entry out of every home it has (a message's firmware versions with it: one left alone would run where
   * the others don't); true when anything was there to leave out. `stated`: the map itself named it (requires or
   * gaps), rather than the schema finding a problem in it.
   */
  const leaveOut = (e: Entry, reason: string, stated: boolean, feature?: string): boolean => {
    const kept = keptReason(e, map, keep);
    // a block the schema can't take in full still blocks with its cmd alone: kept as that, and said so
    // only a base block blocks every home; one blocked on some firmwares would be a bare, sendable cmd on the others
    if (kept && !stated && e.message !== undefined && baseBlocked(map, e.message) && toBlockOnly(map, e)) {
      unsupported.push({ entry: shownText(e.message), why: clip(`kept as a block only (its cmd), since ${reason}`), blockOnly: true });
      return true;
    }
    if (kept) throw new DraftMapError(`${e.ids[0]} does not load (${clip(reason)}), and ${kept}`);
    let removed = false;
    for (const h of e.homes) if (remove(map, h)) removed = true;
    if (removed) for (const id of e.ids) unsupported.push({ entry: shownText(id), why: clip(reason), ...(feature ? { feature } : {}) });
    return removed;
  };

  // the framing and driver the map names are features it needs as a whole, listed in requires or not
  const named = [
    ...(isObject(map.transport) && typeof map.transport.framing === "string" ? [`framing:${map.transport.framing}`] : []),
    // an old driver name is the schema's to explain ("was renamed"), not a feature from a newer app
    ...(typeof map.driver === "string" && !renamedDriver(map.driver) ? [`driver:${map.driver}`] : []),
  ].filter((f) => featureId.safeParse(f).success);
  const whole = [...new Set([...(own.data.requires ?? []).filter((r): r is string => typeof r === "string"), ...named])].filter((f) => !features.has(f));
  if (whole.length) {
    throw new DraftMapError(
      `this map needs engine features this version of Patchsprite does not have yet: ${whole.join(", ")}. A newer version may run it`,
    );
  }
  for (const r of own.data.requires ?? []) {
    if (typeof r === "string") continue;
    // its entry ids are checked whatever this app has, so a draft loads or is refused alike on every version
    const left = r.entries.map((id) => entryOfId(map, id));
    if (features.has(r.feature)) continue;
    missing.add(r.feature);
    const reason = `needs ${r.feature}, which this version of Patchsprite does not have yet${r.why ? ` (${r.why})` : ""}`;
    for (const e of left) leaveOut(e, reason, true, r.feature);
  }
  for (const g of own.data.gaps ?? []) {
    if (typeof g === "string") continue;
    for (const id of g.entries) leaveOut(entryOfId(map, id), `the map does not know this yet: ${g.why}`, true);
  }

  const isOff = (id: string) => unsupported.some((u) => u.entry === id);
  /**
   * Leaves out the rest of each group one of whose members is off, and each entry whose needed group is all off; true
   * when it left anything out, since that can close another group or need.
   */
  const closeGroups = (): boolean => {
    let changed = false;
    for (const group of opts.together ?? []) {
      const off = group.find(isOff);
      if (off === undefined) continue;
      for (const id of group) {
        if (isOff(id)) continue;
        // a kept member (a blocked message is never sent anyway) stays: only what can run goes with the group
        const e = entryOfId(map, id);
        if (!keptReason(e, map, keep) && leaveOut(e, `it goes with ${off}, which is off`, false)) changed = true;
      }
    }
    for (const [id, group] of Object.entries(opts.needs ?? {})) {
      if (isOff(id) || !group.every(isOff)) continue;
      const e = entryOfId(map, id);
      if (!keptReason(e, map, keep) && leaveOut(e, `it needs ${group.join(" or ")}, which ${group.length > 1 ? "are" : "is"} off`, false)) changed = true;
    }
    return changed;
  };

  for (let round = 0; round < MAX_ROUNDS; round++) {
    // each pass leaves out at least one entry of a finite map, so this ends
    while (closeGroups());
    const r = ProtocolSchema.safeParse(map);
    if (r.success) {
      drafts.add(r.data);
      return { protocol: r.data, report: { unsupported, missingFeatures: [...missing], ignored } };
    }
    const found = new Map<string, { entry: Entry; reason: string }>();
    for (const issue of r.error.issues) {
      const where = issue.path.length ? issue.path.map(String).join(".") : "";
      const entry = issue.path.length ? entryAtPath(map, issue.path) : entryOfIssue(map, issue.message);
      const reason = where ? `${where}: ${issue.message}` : issue.message;
      if (!entry) throw new DraftMapError(`the draft does not load, and the problem names no entry that could be left out: ${clip(reason)}`);
      const key = entry.ids.join(" ");
      if (!found.has(key)) found.set(key, { entry, reason });
    }
    let progress = false;
    for (const { entry, reason } of found.values()) if (leaveOut(entry, reason, false)) progress = true;
    // a problem that leaving its entry out does not clear (the entry is not where the problem says) ends it here
    if (!progress) throw new DraftMapError(`the draft does not load: ${clip([...found.values()][0].reason)}`);
  }
  throw new DraftMapError(`the draft still does not load after leaving out ${unsupported.length} entries`);
}
