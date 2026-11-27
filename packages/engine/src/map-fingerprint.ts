// Fingerprints of device-map entries (docs/formats/device-map.md, "Fingerprints"): the app, the sniffer and the server
// must compute the same one for the same entry, so the form is pinned here, in the engine they share. A fingerprint is
// the first 16 hex digits of the SHA-256 of the entry's definition in canonical JSON (RFC 8785, JCS): object keys
// sorted by UTF-16 code units, no whitespace, members whose value is undefined left out. The definition is the map as
// the engine reads it (parseProtocol: "0x.." numbers as numbers, no defaults added) for one firmware (its delta merged).

import type { EntrySource, Field, Layout, Message, Protocol } from "./protocol-schema.ts";
import { ProtocolCodec, tailLayoutName } from "./protocol-schema.ts";
import { canonicalJson, fingerprint } from "./canonical-json.ts";

export { canonicalJson, fingerprint };

/**
 * An entry's definition, as its fingerprint covers it (null for an entry the map doesn't have):
 * - a message, or a message on one block (`setBypass/amp`): [message, its payload layout, [reply message, its payload
 *   layout] or null, the enums their fields name, the transport's byte order], then, only when either payload layout
 *   has a packed tail read with a shared layout or joined into a record (`packed.pieces`), [the message's tail layout
 *   or null, the reply's or null] (the enums include those its fields name);
 * - `param/<owner>/<id>`: the parameter's definition in the first parameter group that lists the owner (a block, or
 *   the effect type whose table a slot takes) and the id;
 * - `choice/<name>`: [the choice, [[where, field], ...] for every field that names it, by message and then by layout
 *   (`layout <name>`), each in the map's order, the enums those fields name].
 * The enums are an object of each enum a field names (`enum`) to its definition: a repaired enum value (a block's id)
 * repairs every entry that reads it. Keys that say where a claim comes from or what it means to a person (`source`,
 * `note`, on the message, parameter or choice and on each field) are left out: a map that only records better
 * evidence for a claim, or rewords a note, has not repaired it, so the unit's marks on it still hold.
 */
export function entryDefinition(protocol: Protocol, firmware: string | undefined, entry: string, codec = new ProtocolCodec(protocol, firmware)): unknown {
  return definition(protocol, firmware, entry, codec, false);
}

function definition(protocol: Protocol, firmware: string | undefined, entry: string, codec: ProtocolCodec, before25Nov: boolean): unknown {
  if (codec.protocol !== protocol || codec.firmware !== firmware) throw new Error("entryDefinition: the codec is for another map or firmware");
  // the form before 25 Nov 2026 left out only a top-level `source`, and kept every note
  const top = <T extends object>(d: T): T => (before25Nov ? strip(d, ["source"]) : bare(d));
  const field = <T extends object>(d: T): T => (before25Nov ? d : bare(d));
  const lay = (l: Layout): Layout => (before25Nov ? l : bareLayout(l));
  const msg = (m: Message): Message => (before25Nov ? strip(m, ["source"]) : bareMessage(m));
  const [kind, a] = entry.split("/");
  const claim = entryClaim(codec, entry);
  if (claim === undefined) return null;
  if (kind === "choice") {
    const fields = fieldsNaming(codec, a);
    return [top(claim), fields.map(([where, f]) => [where, field(f)]), enumsNamed(codec, fields.map(([, f]) => f))];
  }
  if (kind === "param") return top(claim);
  const m = codec.message(kind);
  const reply = m.reply?.message;
  const layout = codec.payloadLayout(kind);
  const replied = reply && codec.hasMessage(reply) ? ([msg(codec.message(reply)), lay(codec.payloadLayout(reply))] as const) : null;
  // a packed tail read with a shared layout, or a piece of a record: that layout is part of the definition (added only
  // where there is one, so every other entry's fingerprint stays as it was)
  const tail = (l: Layout) => {
    const t = tailLayoutName(l);
    return t !== undefined && codec.hasLayout(t) ? lay(codec.layout(t)) : null;
  };
  const tails = [tail(layout), replied ? tail(replied[1]) : null];
  const fields = [...layout.fields, ...(replied?.[1].fields ?? []), ...tails.flatMap((t) => t?.fields ?? [])];
  // the transport's byte order is every field's that sets none: a repair to it repairs every message
  const def = [msg(m), lay(layout), replied, enumsNamed(codec, fields), protocol.transport.endian];
  return tails.some((t) => t !== null) ? [...def, tails] : def;
}

/**
 * The fingerprint an entry had in the form used until 25 Nov 2026, which kept notes: a mark made then still holds
 * when it matches this, and is carried over to the current form (`map-checks.md`, "Fingerprints").
 */
export const entryFingerprintBefore25Nov = (protocol: Protocol, firmware: string | undefined, entry: string, codec = new ProtocolCodec(protocol, firmware)): string =>
  fingerprint(definition(protocol, firmware, entry, codec, true));

/**
 * Keys of a message, parameter, choice or field that say where a claim comes from or what it means to a person, not
 * what the unit does: a change to them repairs nothing, so no fingerprint covers them.
 */
const NOT_FINGERPRINTED: readonly string[] = ["source", "note"];

/** A definition without some keys, at its top level. */
function strip<T extends object>(def: T, keys: readonly string[]): T {
  if (!keys.some((k) => Object.hasOwn(def, k))) return def;
  return Object.fromEntries(Object.entries(def).filter(([k]) => !keys.includes(k))) as T;
}

/** A definition (a message, a parameter, a choice, a field) without the keys no fingerprint covers, at its top level. */
const bare = <T extends object>(def: T): T => strip(def, NOT_FINGERPRINTED);

/** A layout whose fields are without the keys no fingerprint covers (a layout itself has none). */
const bareLayout = (l: Layout): Layout => ({ ...l, fields: l.fields.map((f) => bare(f)) });

/** A message without the keys no fingerprint covers, its inline payload layout's fields included. */
function bareMessage(m: Message): Message {
  const out = bare(m);
  return typeof out.payload === "object" ? { ...out, payload: bareLayout(out.payload) } : out;
}

/**
 * The map's own claim behind an entry, as one firmware reads it: the message (for a message on one block too), the
 * parameter (in the first group that lists the block and has the id) or the choice; undefined for one the map lacks.
 */
function entryClaim(codec: ProtocolCodec, entry: string): { source?: EntrySource } | undefined {
  const { protocol } = codec;
  const [kind, a, b] = entry.split("/");
  if (kind === "choice") return protocol.choices && Object.hasOwn(protocol.choices, a) ? protocol.choices[a] : undefined;
  if (kind === "param") {
    for (const g of Object.values(protocol.parameters?.groups ?? {})) {
      if (!g.blocks?.includes(a) && !g.types?.includes(a)) continue;
      const def = Object.values(g.params).find((p) => p.id === Number(b));
      if (def) return def;
    }
    return undefined;
  }
  return codec.hasMessage(kind) ? codec.message(kind) : undefined;
}

/** Where the map says an entry's claim comes from (`source`), or undefined when it doesn't say or lacks the entry. */
export const entrySource = (codec: ProtocolCodec, entry: string): EntrySource | undefined => entryClaim(codec, entry)?.source;

/** The enums some fields name, by name, as the map defines them. */
function enumsNamed(codec: ProtocolCodec, fields: readonly Field[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const e = "enum" in f ? f.enum : undefined;
    if (e !== undefined && Object.hasOwn(codec.enums, e)) out[e] = codec.enums[e];
  }
  return out;
}

/** The fingerprint of an entry's definition. */
export const entryFingerprint = (protocol: Protocol, firmware: string | undefined, entry: string, codec?: ProtocolCodec): string =>
  fingerprint(entryDefinition(protocol, firmware, entry, codec));

/** The fields that name a choice: their ranges and enums settle it, so a repair to one of them repairs the choice. */
function fieldsNaming(codec: ProtocolCodec, choice: string): [string, Field][] {
  const { protocol, firmware } = codec;
  const fw = firmware !== undefined && protocol.firmwares && Object.hasOwn(protocol.firmwares, firmware) ? protocol.firmwares[firmware] : undefined;
  const out: [string, Field][] = [];
  const add = (where: string, l: Layout) => {
    for (const f of l.fields) if ("choice" in f && f.choice === choice) out.push([where, f]);
  };
  for (const n of new Set([...Object.keys(protocol.messages), ...Object.keys(fw?.messages ?? {})])) if (codec.hasMessage(n)) add(n, codec.payloadLayout(n));
  for (const n of new Set([...Object.keys(protocol.layouts), ...Object.keys(fw?.layouts ?? {})])) if (codec.hasLayout(n)) add(`layout ${n}`, codec.layout(n));
  return out;
}
