// MIDI universal identity (Universal Non-realtime SysEx, General Information, Identity Request and Reply): the request
// any MIDI unit may answer, its reply, and whether a reply is the unit a map's `identity` describes. Standard MIDI
// only: no map data, no framing engine, no Node API, so the sniffer can import it as it is.
//
// Request: f0 7e <device id> 06 01 f7, sent to every device id (7f).
// Reply:   f0 7e <device id> 06 02 <maker: 1 byte, or 00 and 2 more> <family: 2> <model: 2> <version: 4> f7.
// Family and model are the 2 bytes as the unit sends them (low byte first, by the MIDI spec), kept as bytes so a map
// writes them exactly as its source prints them.

import { z } from "zod";
import { text } from "./map-text.ts";

/** The identity request to every device id on the port. */
export const IDENTITY_REQUEST: Uint8Array = Uint8Array.of(0xf0, 0x7e, 0x7f, 0x06, 0x01, 0xf7);

/** How long a unit is given to answer the identity request, at least (a map's longer reply timeout wins). */
export const IDENTITY_TIMEOUT_MS = 1000;

/** The longest an identity reply may be: a 3-byte maker plus a few vendor bytes past the version. */
const MAX_REPLY = 32;

export interface IdentityReply {
  /** the unit's own SysEx device id (0 to 7f) */
  deviceId: number;
  /** 1 byte, or 3 starting with 00 */
  manufacturer: Uint8Array;
  family: Uint8Array;
  model: Uint8Array;
  /** 4 bytes; their meaning is the maker's, so they are never matched */
  version: Uint8Array;
}

/** Whether a frame is an identity request (to any device id). */
export function isIdentityRequest(frame: Uint8Array): boolean {
  return frame.length === 6 && frame[0] === 0xf0 && frame[1] === 0x7e && frame[2] <= 0x7f && frame[3] === 0x06 && frame[4] === 0x01 && frame[5] === 0xf7;
}

/** The reply in a whole SysEx frame, or null when the frame is not a well-formed identity reply. */
export function parseIdentityReply(frame: Uint8Array): IdentityReply | null {
  if (frame.length < 15 || frame.length > MAX_REPLY) return null;
  if (frame[0] !== 0xf0 || frame[1] !== 0x7e || frame[3] !== 0x06 || frame[4] !== 0x02 || frame[frame.length - 1] !== 0xf7) return null;
  const body = frame.subarray(2, frame.length - 1);
  if (body.some((b) => b > 0x7f)) return null;
  const makerLength = frame[5] === 0x00 ? 3 : 1;
  const at = 5 + makerLength;
  // vendor bytes past the version are allowed and ignored; a reply short of the version is not one
  if (frame.length < at + 8 + 1) return null;
  return {
    deviceId: frame[2],
    manufacturer: frame.slice(5, at),
    family: frame.slice(at, at + 2),
    model: frame.slice(at + 2, at + 4),
    version: frame.slice(at + 4, at + 8),
  };
}

/** A reply frame, for simulated units and tests. */
export function identityReplyFrame(r: IdentityReply): Uint8Array {
  return Uint8Array.from([0xf0, 0x7e, r.deviceId, 0x06, 0x02, ...r.manufacturer, ...r.family, ...r.model, ...r.version, 0xf7]);
}

const hex = (b: ArrayLike<number>) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(" ");

/** A reply as a player-facing line: "maker 7d, family 0b 04, model 02 00, version 1a 2b 3c 4d". */
export function describeIdentity(r: IdentityReply): string {
  return `maker ${hex(r.manufacturer)}, family ${hex(r.family)}, model ${hex(r.model)}, version ${hex(r.version)}`;
}

const hexPairs = (n: number) => new RegExp(`^[0-7][0-9a-f]( [0-7][0-9a-f]){${n - 1}}$`);

/** Indexes into the reply's 4 version bytes, read most significant first at 7 bits a byte. */
const versionBytes = z
  .array(z.number().int().min(0).max(3))
  .min(1)
  .max(2)
  .refine((a) => new Set(a).size === a.length, "a version byte is named once");

/**
 * How the reply's version bytes give the firmware: "ascii" for bytes that spell it ("1.20" as 31 2e 32 30), or the
 * bytes that hold its major and minor numbers. Left out where the version bytes' meaning isn't known.
 */
export const IdentityFirmwareSchema = z.union([
  z.literal("ascii"),
  z
    .strictObject({ major: versionBytes, minor: versionBytes })
    .refine((f) => !f.major.some((i) => f.minor.includes(i)), "major and minor use different version bytes"),
]);

/**
 * Where a map's identity bytes, or its way of reading the firmware from them, come from, strongest first: `capture` (a
 * reply from a real unit), `device-reported` (a reply a player's unit gave that the map did not expect, sent in),
 * `vendor-doc` (the maker's own documents), `community-table` (a table other people compiled, unconfirmed). A guess,
 * or bytes carried over from a sibling model, is none of these, so it never goes in a map.
 */
export const IDENTITY_SOURCES = ["capture", "device-reported", "vendor-doc", "community-table"] as const;
export type IdentitySourceKind = (typeof IDENTITY_SOURCES)[number];

/** `{kind, ref}`: `ref` names the capture, report, document or table. */
export const IdentitySourceSchema = z.strictObject({ kind: z.enum(IDENTITY_SOURCES), ref: text().min(1).max(512) });
export type IdentitySource = z.infer<typeof IdentitySourceSchema>;

/**
 * The map's `identity`: what the unit must answer to the identity request before anything else is sent to it. Bytes
 * are lowercase hex pairs, as the map writes every byte; the version is never matched.
 */
export const IdentitySchema = z.strictObject({
  /** 1 byte, or 3 starting with 00 */
  manufacturer: z
    .string()
    .refine((s) => (hexPairs(1).test(s) && s !== "00" && s !== "7e" && s !== "7f") || (hexPairs(3).test(s) && s.startsWith("00 ")), "manufacturer is one 7-bit byte (not 00, 7e or 7f) or three starting with 00"),
  /** 2 bytes, as the unit sends them */
  family: z.string().regex(hexPairs(2), "family is two 7-bit hex bytes"),
  /** 2 bytes, as the unit sends them; left out when the family alone names the unit */
  model: z.string().regex(hexPairs(2), "model is two 7-bit hex bytes").optional(),
  /** where the reply's 4 version bytes carry the unit's firmware, how to read it (identityFirmware) */
  firmware: IdentityFirmwareSchema.optional(),
  /** where the bytes come from; a confirmed map (protocol.json) must say (identitySourceProblems) */
  source: IdentitySourceSchema.optional(),
  /** where `firmware` comes from; a confirmed map that reads the firmware must say */
  firmwareSource: IdentitySourceSchema.optional(),
  note: text().max(1024).optional(),
}).refine((i) => i.firmwareSource === undefined || i.firmware !== undefined, "identity.firmwareSource is only for an identity.firmware");
export type MapIdentity = z.infer<typeof IdentitySchema>;

const bytesOf = (h: string) => Uint8Array.from(h.split(" "), (x) => parseInt(x, 16));

/** The reply a unit the map describes gives (a model left out reads 00 00), for simulated units and tests. */
export function replyOf(want: MapIdentity, deviceId = 0, version = "1a 2b 3c 4d"): IdentityReply {
  return { deviceId, manufacturer: bytesOf(want.manufacturer), family: bytesOf(want.family), model: bytesOf(want.model ?? "00 00"), version: bytesOf(version) };
}

/** Why a reply is not the unit the map describes, or null when it is. */
export function identityMismatch(want: MapIdentity, got: IdentityReply): string | null {
  const off: string[] = [];
  if (hex(got.manufacturer) !== want.manufacturer) off.push(`maker ${hex(got.manufacturer)}, not ${want.manufacturer}`);
  if (hex(got.family) !== want.family) off.push(`family ${hex(got.family)}, not ${want.family}`);
  if (want.model !== undefined && hex(got.model) !== want.model) off.push(`model ${hex(got.model)}, not ${want.model}`);
  return off.length ? off.join("; ") : null;
}

/** What requestIdentity needs of a MIDI connection: the same shape as the drivers' transports. */
export interface IdentityTransport {
  send(frame: Uint8Array): Promise<void> | void;
  onData(cb: (chunk: Uint8Array) => void): void;
}

/**
 * Sends the identity request and waits up to `timeoutMs` for the first identity reply; anything else the unit sends
 * meanwhile is ignored. Null when none comes. Takes the transport's data callback for the wait and leaves a no-op in
 * its place, so the caller (a driver) sets its own after.
 */
export async function requestIdentity(t: IdentityTransport, timeoutMs: number): Promise<IdentityReply | null> {
  let buf: number[] = [];
  let done: (r: IdentityReply | null) => void = () => {};
  const got = new Promise<IdentityReply | null>((resolve) => (done = resolve));
  t.onData((chunk) => {
    // a SysEx message may arrive in pieces; anything that is not one is skipped
    for (const b of chunk) {
      if (b >= 0xf8) continue; // real-time bytes may come between a SysEx message's bytes
      if (b === 0xf0) buf = [];
      else if (!buf.length) continue;
      buf.push(b);
      if (buf.length > MAX_REPLY) buf = [];
      else if (b === 0xf7) {
        const r = parseIdentityReply(Uint8Array.from(buf));
        buf = [];
        if (r) return done(r);
      }
    }
  });
  const timer = setTimeout(() => done(null), timeoutMs);
  try {
    await t.send(IDENTITY_REQUEST);
    return await got;
  } finally {
    clearTimeout(timer);
    t.onData(() => {});
  }
}

/**
 * The firmware the reply's version bytes give, by the map's `identity.firmware`: "major.minor" from numbered bytes
 * (minor zero-padded to 2 digits, as the drivers write it), or the text spelled bytes give. Null where the map says
 * nothing of it, or spelled bytes don't read as a version.
 */
export function identityFirmware(want: MapIdentity, got: IdentityReply): string | null {
  const how = want.firmware;
  if (how === undefined) return null;
  // spelled out: kept as the unit spells it ("1.20"), trailing NULs and spaces dropped
  if (how === "ascii") return /^\d{1,3}\.\d{1,3}$/.exec(String.fromCharCode(...got.version).replace(/[\0 ]+$/, ""))?.[0] ?? null;
  const read = (at: number[]) => at.reduce((n, i) => n * 128 + got.version[i], 0);
  return `${read(how.major)}.${String(read(how.minor)).padStart(2, "0")}`;
}

/** The map's `identity` as map checks name it: a match verifies it, and a reply that doesn't is logged against it. */
export const IDENTITY_ENTRY = "identity";

/**
 * What a confirmed map (protocol.json, not a draft) leaves out of its `identity`: the source of its bytes, and of its
 * firmware read where it has one. A draft loads without them, its identity unchecked until a unit answers it.
 */
export function identitySourceProblems(want: MapIdentity): string[] {
  const out: string[] = [];
  if (want.source === undefined) out.push("identity states no source for its bytes (identity.source: capture, device-reported, vendor-doc or community-table, with a ref)");
  if (want.firmware !== undefined && want.firmwareSource === undefined) out.push("identity.firmware states no source (identity.firmwareSource, as identity.source)");
  return out;
}

/** Whether nobody has seen a unit give the map's identity bytes: taken from a community table, or a draft's with no source. */
export const identityUnconfirmed = (want: MapIdentity): boolean => want.source === undefined || want.source.kind === "community-table";

/**
 * Whether two identities state the same bytes: maker, family and model (or both leave the model out). Every answer
 * that fits one fits the other, so the unit's answer can never choose between two such maps (two models that answer
 * alike). An identity with no model beside one with a model is not this: most answers tell them apart, and an answer
 * that fits both is caught when it comes.
 */
export function sameIdentity(a: MapIdentity, b: MapIdentity): boolean {
  return a.manufacturer === b.manufacturer && a.family === b.family && a.model === b.model;
}
