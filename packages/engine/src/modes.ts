// Device modes whose entries live apart (a unit set up for guitar or for bass keeps its patches and settings at other
// addresses in each): the map names how the mode is read and, per mode, which of its entries stand in for the names
// the driver asks for. Everything here is generic; which modes a unit has, and where each keeps what, is map data.

import type { Field, Parameters, Protocol } from "./protocol-schema.ts";

/** The kinds of map entries a mode can stand another in for. */
export const MODE_KINDS = ["messages", "layouts", "enums", "constants", "groups"] as const;
export type ModeKind = (typeof MODE_KINDS)[number];

/** One mode's stand-ins per kind: the name the driver uses -> the map entry used in this mode, or null where the mode
 * has no such entry. */
export type ModeUse = Partial<Record<ModeKind, Record<string, string | null>>>;

const has = (o: object, k: string) => Object.hasOwn(o, k);

/** The mode read's reply message and the field of it that says the mode (undefined where the map has none). */
export function modeReadField(protocol: Pick<Protocol, "modes" | "messages" | "layouts">): { reply: string; field: Field | undefined } | undefined {
  const read = protocol.modes?.read;
  if (!read || !has(protocol.messages, read.message)) return undefined;
  const reply = protocol.messages[read.message].reply?.message ?? read.message;
  const payload = has(protocol.messages, reply) ? protocol.messages[reply].payload : undefined;
  const layout = typeof payload === "string" ? (has(protocol.layouts, payload) ? protocol.layouts[payload] : undefined) : payload;
  return { reply, field: layout?.fields.find((x) => x.name === read.field) };
}

/** The enum that names the modes: the one the mode read's reply field reads, or undefined (no modes, or a map the
 * schema refuses). */
export function modeEnum(protocol: Pick<Protocol, "modes" | "messages" | "layouts">): string | undefined {
  const f = modeReadField(protocol)?.field;
  return f && "enum" in f ? f.enum : undefined;
}

/** The modes a map names (the keys of its mode enum), in the map's order; empty for a map without modes. */
export function modeNames(protocol: Pick<Protocol, "modes" | "messages" | "enums" | "layouts">): string[] {
  const e = modeEnum(protocol);
  return e !== undefined && protocol.enums && has(protocol.enums, e) ? Object.keys(protocol.enums[e]) : [];
}

/** A mode's stand-ins ({} for a mode that uses the map's own entries). */
export function modeUse(protocol: Pick<Protocol, "modes">, mode: string): ModeUse {
  const use = protocol.modes?.use;
  return use && has(use, mode) ? use[mode] : {};
}

/** Every name some mode uses as a stand-in for this kind: such an entry is used only through the name it stands in for. */
export function standIns(protocol: Pick<Protocol, "modes">, kind: ModeKind): Set<string> {
  const out = new Set<string>();
  for (const u of Object.values(protocol.modes?.use ?? {})) for (const v of Object.values(u[kind] ?? {})) if (v !== null) out.add(v);
  return out;
}

/**
 * A table as a mode sees it: each name the mode stands an entry in for takes that entry's definition (looked up in
 * `table` itself), and a name the mode maps to null is gone. Names not listed stay as they are. Always a new object.
 */
export function inMode<T>(table: Record<string, T>, subs: Record<string, string | null> | undefined): Record<string, T> {
  const out = { ...table };
  for (const [n, s] of Object.entries(subs ?? {})) {
    if (s === null || !has(table, s)) delete out[n];
    else out[n] = table[s];
  }
  return out;
}

/**
 * The parameter groups as a mode sees them. Groups are found by the blocks and types they list, not by name, so a
 * group some mode uses as a stand-in is left out of every mode's view but through the name it stands in for.
 */
export function groupsInMode(protocol: Pick<Protocol, "modes" | "parameters">, use: ModeUse): Parameters["groups"] {
  const groups = protocol.parameters?.groups ?? {};
  const view = inMode(groups, use.groups);
  for (const s of standIns(protocol, "groups")) delete view[s];
  return view;
}
