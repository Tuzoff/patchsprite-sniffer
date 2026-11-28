// The protocol section of a device map: transport, named messages, record layouts, settings, enums and constants,
// plus a generic codec over them. The format: docs/formats/device-map.md.
//
// Everything learnt about a device is data in its device map; this file holds only the shapes and the engine. It must
// never hold a real command code, offset, size or rule: tests use made-up maps (packages/engine/test/fixtures).
//
// The map is untrusted input (it may come from a server): every count is capped, sizes are computed without
// enumerating elements, and lookups by name never reach inherited object properties.

import { z } from "zod";
import { compareVersions, firmwareEntryKey, rangesOverlap, versionParts, VERSION_PATTERN } from "./firmware-versions.ts";
import { ControlsSchema, controlsIssues } from "./channel-messages.ts";
import type { KnownCmd } from "./framing.ts";
import { cmdsOverlap, MAX_CMD_TOKENS, tokensBegin } from "./cmd-overlap.ts";
import { IdentitySchema } from "./identity.ts";
import { line, text } from "./map-text.ts";
import { choiceEntry, type UnitChecks } from "./map-checks.ts";
import { crc32, pack8to7, packedLength, septets32, type TopBits, unpack7to8, unpackedLength } from "./pack7.ts";
import { joinNibbles, type NibbleOrder, splitNibbles } from "./nibbles.ts";
import { MEASURED_FIELDS } from "./measured-fields.ts";
import { groupsInMode, inMode, MODE_KINDS, modeEnum, modeNames, modeReadField, modeUse, standIns, type ModeKind, type ModeUse } from "./modes.ts";
import { SafetyError } from "./safety.ts";

// ---- codec use ------------------------------------------------------------------------------------------------

/** Told of each message a codec encodes (its payload built) or decodes (its payload read) successfully. */
export type CodecUseObserver = (protocol: Protocol, use: "encode" | "decode", message: string) => void;

let codecObserver: CodecUseObserver | undefined;

/**
 * Sets the one observer of codec use (a test run's per-message coverage log, say), or clears it with undefined. An
 * observer that throws is ignored: it never stops a codec call. The observer belongs to this copy of the module: a
 * second copy of the engine loaded beside it (another version, or src/ beside dist/) has its own.
 */
export function observeCodecUse(observer: CodecUseObserver | undefined): void {
  codecObserver = observer;
}

function noteCodecUse(protocol: Protocol, use: "encode" | "decode", message: string): void {
  if (!codecObserver) return;
  try {
    codecObserver(protocol, use, message);
  } catch {
    // coverage is the observer's business
  }
}

// ---- limits ----------------------------------------------------------------------------------------------------

/** Bytes in any layout. */
const MAX_BYTES = 1 << 20;
/** Problems reported before validation stops listing more. */
const MAX_ISSUES = 100;
/** The most block separations a report lists (blockSeparations). */
const MAX_SEPARATIONS = 1000;
/** Elements in one layout, all fields together. */
const MAX_ELEMENTS = 1 << 16;
/** Bytes in one string field. */
const MAX_STRING = 4096;
/** Firmware entries in one protocol. */
const MAX_FIRMWARES = 64;
/** Blocked messages in one list. */
const MAX_BLOCKED = 256;
/** Blocked messages across the base and every firmware together. */
const MAX_BLOCKED_TOTAL = 512;
/** Entries in any named table (messages, layouts, enums, enum keys, constants, settings groups). */
const MAX_ENTRIES = 4096;
/** Items one list reply may carry. */
const MAX_LIST_ITEMS = 4096;
/** Item payload bytes one list reply may carry, all items together. */
const MAX_LIST_BYTES = 1 << 20;
/** The longest a whole list reply may take, from the request to its end message. */
const MAX_LIST_MS = 60_000;
/** Parameters across all groups of a map, and select or switch options across all of them. */
const MAX_PARAMS = 16384;
const MAX_OPTIONS = 65536;
/** Messages marked noChecksum across the base and every firmware together. */
const MAX_UNCHECKED = 64;
/** Other headers one sysex-plain transport may name. */
const MAX_HEADERS = 8;
/** Templated cmds on a sysex-plain transport with cmds of several lengths, across the base and all firmwares: each is
 * checked against every other cmd for one beginning the other. */
const MAX_TEMPLATED_PLAIN = 64;
/** Choices in a map, options per choice, and choices one layout may use (a layout is read every way they allow). */
const MAX_CHOICES = 16;
const MAX_CHOICE_OPTIONS = 4;
const MAX_CHOICES_PER_LAYOUT = 2;
/** Caps on the on-connect steps: their count, one step's pause, and every pause together. */
const MAX_CONNECT_STEPS = 16;
const MAX_STEP_PAUSE_MS = 10_000;
const MAX_CONNECT_PAUSE_MS = 30_000;
/** Bytes in one record joined from pieces (`pieces`). */
export const MAX_RECORD = 1 << 16;

/** Address bytes at most: wider than any address-based unit uses, and still exact as a number (7 x 7 bits). */
const MAX_ADDRESS_BYTES = 7;
/** Address tables in a map. */
const MAX_ADDRESS_TABLES = 64;
/** Steps the address search may take for one question before it gives up (a load check then refuses the map). */
const MAX_ADDRESS_STEPS = 20_000;
/** Addresses one message may reach for the lookalike check to walk them all; past it the pair counts as meeting. */
const MAX_LOOKALIKE_ADDRESSES = 4096;

/** A record refused before its entries are parsed when it has too many keys. */
function cappedRecord<K extends z.ZodType<string>, V extends z.ZodType>(key: K, value: V, max: number, what: string) {
  return z.preprocess((v, ctx) => {
    if (v !== null && typeof v === "object" && Object.keys(v).length > max) {
      ctx.addIssue({ code: "custom", message: `at most ${max} ${what}` });
      return z.NEVER;
    }
    return v;
  }, z.record(key, value));
}

// ---- primitives ------------------------------------------------------------------------------------------------

/** An integer written as a JSON number or as a "0x.." string (codes read better in hex). */
const int = z.union([z.number().int(), z.string().regex(/^0x[0-9a-fA-F]{1,8}$/).transform((s) => Number(s))]);
const byte = int.pipe(z.number().int().min(0).max(0xff));
const sevenBitByte = int.pipe(z.number().int().min(0).max(0x7f));
const nonNeg = int.pipe(z.number().int().min(0).max(MAX_BYTES));
const size = nonNeg;

/** Bytes as space-separated hex pairs: "f0 7d 01". */
const HEX_BYTES = /^[0-9a-f]{2}( [0-9a-f]{2})*$/;
const hexBytes = z.string().max(3 * MAX_STRING).regex(HEX_BYTES, "bytes are lowercase hex pairs separated by single spaces");
/** An address or an address offset: 7-bit digits, most significant first ("00 01 00" is 128). */
const addressHex = hexBytes
  .refine((h) => h.split(" ").every((x) => parseInt(x, 16) < 0x80), "address digits are 7-bit")
  .refine((h) => h.split(" ").length <= MAX_ADDRESS_BYTES, "an address has at most 7 digits");

/** A command: hex pairs, or `{arg}` placeholders filled per call (one byte each). */
const CMD_TOKEN = /^([0-9a-f]{2}|\{[a-z][A-Za-z0-9]*\})$/;
const cmdTemplate = z
  .string()
  .max(256)
  .refine((s) => s.split(" ").every((t) => CMD_TOKEN.test(t)), "cmd is hex pairs or {arg} placeholders, space-separated");
const name = z.string().max(64).regex(/^[a-z][A-Za-z0-9]*$/, "names are camelCase");
const key = z.string().max(64).regex(/^[a-z][a-z0-9_]*$/, "keys are snake_case");

export const SCALAR_TYPES = ["u8", "i8", "u16", "i16", "u32", "i32", "f32"] as const;
export type ScalarType = (typeof SCALAR_TYPES)[number];
export const SCALAR_SIZE: Record<ScalarType, number> = { u8: 1, i8: 1, u16: 2, i16: 2, u32: 4, i32: 4, f32: 4 };
const endian = z.enum(["le", "be"]);

// ---- fields and layouts ----------------------------------------------------------------------------------------

/** A repeated field: `dims` elements per dimension (row-major), each dimension `strides[i]` bytes apart (default: packed). */
const repeat = z
  .strictObject({ dims: z.array(nonNeg).min(1).max(4), strides: z.array(nonNeg).min(1).max(4).optional() })
  .refine((r) => !r.strides || r.strides.length === r.dims.length, "one stride per dim")
  .refine((r) => r.dims.reduce((a, b) => a * b, 1) <= MAX_ELEMENTS, `at most ${MAX_ELEMENTS} elements`);

const fieldBase = {
  name,
  /** Byte offset in the layout. Omitted: right after the furthest byte any earlier field reaches. */
  offset: size.optional(),
  repeat: repeat.optional(),
  /** Free text: where the fact comes from. Ignored by the codec. */
  note: text().max(1024).optional(),
};

/** Sum of the payload's bytes from `from`, masked: up to this field ("self") or to the end of the payload ("end"). */
const checksum = z.strictObject({
  algo: z.literal("sum"),
  from: size,
  to: z.enum(["self", "end"]),
  mask: int.optional(),
});

const scalarField = z.strictObject({
  ...fieldBase,
  type: z.enum(SCALAR_TYPES),
  endian: endian.optional(),
  /** Always this raw value: written whatever the caller passes, and checked on decode. */
  const: z.number().optional(),
  /**
   * Never these raw values: encode refuses them, and a payload that holds one is not this message (decode refuses it),
   * so a message that shares its cmd with another is told apart by a value the other one always has there.
   */
  not: z.array(z.number()).min(1).max(MAX_ENTRIES).optional(),
  /** Written when the caller passes nothing. */
  default: z.number().optional(),
  /** Written as the value given for that (single, scalar) field when the caller passes nothing for this one. */
  copyOf: name.optional(),
  /** Fixed point and offsets: wire = round(value * scale + bias). */
  scale: z.number().positive().optional(),
  bias: z.number().optional(),
  /** This raw value means "none": null encodes as it, and it decodes as null. */
  nullAs: int.optional(),
  /** Value range (before scale and bias): outside it is refused, or clamped when the field saturates. */
  min: z.number().optional(),
  max: z.number().optional(),
  /** Clamp to `min`/`max` and to the type's range instead of refusing. */
  saturate: z.boolean().optional(),
  /** Name of an enum: encode accepts its keys, decode returns them (numbers it does not know stay numbers). */
  enum: name.optional(),
  /**
   * The enum this field reads, chosen by another field of the same payload or layout (each block's effect type has a
   * list of its own, say): `field` names that field, which reads an enum, and `enums` gives the enum for each of its
   * keys. Where `enums` names none for the other field's value, this field reads and takes numbers. Not with `enum`.
   */
  enumBy: z.strictObject({ field: name, enums: cappedRecord(key, name, MAX_ENTRIES, "enumBy entries") }).optional(),
  /** The only values encode may write (safety: values known to be safe). */
  allowed: z.array(z.number()).max(MAX_ENTRIES).optional(),
  /** Computed by the codec, checked on decode; the caller passes nothing. */
  checksum: checksum.optional(),
  /**
   * Sent as this many 7-bit bytes instead of the type's own bytes (SysEx data cannot carry the high bit), least
   * significant first, or most significant first under endian "be". The type still sets the value range; the wire
   * value must also fit 7 * septets bits.
   */
  septets: z.number().int().min(1).max(5).optional(),
  /**
   * Sent as this many bytes of 4 bits each (0000 aaaa 0000 bbbb ...), as address-based units carry a wide value: least
   * significant first, or most significant first under endian "be", as for septets. Not with septets.
   */
  nibbles: z.number().int().min(1).max(8).optional(),
  /**
   * Only these bits of the element: the value is (raw >> shift) & (2^width - 1). Fields that share a byte each name
   * their bits at the same offset; encode leaves the other bits as they are.
   */
  bits: z.strictObject({ shift: z.number().int().min(0).max(31), width: z.number().int().min(1).max(32) }).optional(),
  /**
   * With bits: the wire holds the complement within the bits (all ones minus the value), as a flag that means "off".
   * `const`, `nullAs`, `default`, `min` and `max` name the value before it is inverted, never the inverted wire bits.
   */
  invert: z.boolean().optional(),
  /**
   * The name of a protocol `choice`: the docs give this field more than one encoding, and the unit settles which.
   * The field takes the keys the choice's options set (today its endian) from the option in force.
   */
  choice: name.optional(),
  /**
   * roland-address only, on a field of a message's own payload: the field takes no payload bytes but moves the
   * message's address. Its wire value times `stride` (address digits, "00 01 00" is 128) is added to the cmd's address,
   * or, with `table`, the offset the map's `addresses` table gives the field's enum key (a block's own area, say). A reply
   * to such a request carries the same fields: its address moves with the request's, and they read as the request's.
   */
  address: z
    .strictObject({ stride: addressHex.optional(), table: name.optional() })
    .refine((a) => (a.stride === undefined) !== (a.table === undefined), "an address field has a stride or a table, not both")
    .refine((a) => a.stride === undefined || /[1-9a-f]/.test(a.stride), "a stride of 0 does not move the address")
    .optional(),
});

const bytesField = z.strictObject({
  ...fieldBase,
  type: z.literal("bytes"),
  length: size,
  /** Fill byte when the caller passes nothing or too few bytes. */
  fill: byte.optional(),
  /** Always these bytes: written whatever the caller passes, and checked on decode. */
  const: hexBytes.optional(),
});

const stringField = z.strictObject({
  ...fieldBase,
  type: z.literal("string"),
  /** Bytes; latin1, NUL-padded, at most length - 1 characters so a NUL always ends it. */
  length: int.pipe(z.number().int().min(1).max(MAX_STRING)),
  /** An element of all this byte decodes as null (a free list entry), and null encodes as it. */
  free: byte.optional(),
  /**
   * The last field, of variable length: decode takes the payload's remaining bytes (at most `length`) up to a NUL, so a
   * shorter payload is whole. Encode still writes `length` bytes.
   */
  open: z.boolean().optional(),
});

const padField = z.strictObject({ ...fieldBase, type: z.literal("pad"), length: size, fill: byte.optional() });

export const FieldSchema = z.discriminatedUnion("type", [scalarField, bytesField, stringField, padField]);
export type Field = z.infer<typeof FieldSchema>;
export type ScalarField = z.infer<typeof scalarField>;

/**
 * How a record that comes in pieces is joined: where each piece goes (`offset`: a field of the piece holding its byte
 * offset, or "address", the address its cmd names), the shared layout the joined bytes are read with, their size when
 * no layout fixes it (a number, the request's field, or a constant), the largest piece, and how long the whole may take.
 * One shape on a packed tail (`packed.pieces`, the tail is the piece) and on a request's reply rule (`reply.pieces`).
 * On a reply, each piece says where its bytes go: at its own address (`offset: "address"`, the framing's address
 * counted from the reply's cmd: roland-address only; the pieces are slices of the reply, read with its own layout, so
 * no `layout`), or in a field of the reply message holding the byte offset (`{ field }`), its bytes then the payload
 * after the reply's layout. The joined value is `size` bytes, by default the size of the layout it is read with.
 * `maxPiece` is the unit's own cap on one piece; `deadlineMs` (default and most MAX_PIECES_MS) counts from the request,
 * while the reply timeout still counts from the request to the first piece and from each piece to the next.
 */
export const PiecesSchema = z.strictObject({
  offset: z.union([z.literal("address"), z.strictObject({ field: name })]),
  layout: name.optional(),
  size: z.union([z.number().int().min(1).max(MAX_RECORD), z.strictObject({ request: name }), z.strictObject({ constant: name })]).optional(),
  maxPiece: z.number().int().min(1).max(MAX_RECORD).optional(),
  deadlineMs: z.number().int().min(1).max(MAX_LIST_MS).optional(),
  /**
   * By address only: the unit splits the answer every `step` bytes from the read's start, so only a message where that
   * split puts a piece, and not shorter than that piece (the last runs to the end), is one. A change the unit reports
   * of its own inside the read's range (a knob turned meanwhile) is then left alone rather than taken for a piece.
   * Without it, any message of the reply's command inside the range is a piece. Set it only from a capture.
   */
  step: z.number().int().min(1).max(MAX_RECORD).optional(),
});
export type Pieces = z.infer<typeof PiecesSchema>;

/**
 * 8-bit data after the layout's fields, sent 7-bit, then an optional CRC. It runs to the end of the payload; its value
 * is the unpacked bytes, or with `layout` the fields that layout reads from them. Packings:
 * - "8to7": groups of up to 7 bytes, each preceded by a byte holding their top bits (`topBits` says which bit is whose).
 * - "nibbles-hi-lo", "nibbles-lo-hi": each byte as two bytes of 4 bits, its high half first or its low half first.
 */
const packedTail = z.strictObject({
  name,
  /** How the bytes are carried 7-bit: 8-to-7 groups, or nibble pairs high half first or low half first. */
  packing: z.enum(["8to7", "nibbles-hi-lo", "nibbles-lo-hi"]),
  /**
   * With 8to7 (required there, refused with a nibble packing): where the first byte of a group keeps its top bit in
   * the high-bits byte, bit 6 (then 5..0) or bit 0 (then 1..6).
   */
  topBits: z.enum(["first-in-bit6", "first-in-bit0"]).optional(),
  /**
   * A field of the layout holding the unpacked byte count: encode writes it, decode reads it and refuses a payload of
   * any other length. Omitted: the packed bytes run to the CRC, or to the end.
   */
  lengthField: name.optional(),
  /** The most unpacked bytes encode or decode accepts. */
  maxLength: size,
  /** CRC-32 (reflected, poly edb88320, init ffffffff) of the unpacked bytes, with or without the final XOR, as 5 septets least significant first. */
  crc: z.strictObject({ algo: z.literal("crc32"), finalXor: z.boolean() }).optional(),
  /**
   * A shared layout (in `layouts`, with no packed tail of its own) that reads the unpacked bytes: its fields join this
   * layout's own, by name, so the tail is encoded from and decoded to fields rather than one bytes value (`name` then
   * only labels the tail in errors). Its fields may use all 8 bits.
   */
  layout: name.optional(),
  /**
   * The unpacked bytes are one piece of a record that comes in several messages: the bytes of the shared layout
   * `pieces.layout` (fixed size, at most MAX_RECORD bytes, required here) from the byte offset held in this layout's
   * field `pieces.offset.field`. Not with `layout`; `offset: "address"`, `size`, `maxPiece` and `deadlineMs` are a reply
   * rule's, refused here. The record layout's fields may use all 8 bits. record-pieces.ts joins and splits.
   */
  pieces: PiecesSchema.optional(),
  note: text().max(1024).optional(),
});
export type PackedTail = z.infer<typeof packedTail>;

export const LayoutSchema = z.strictObject({
  /** Total bytes. Omitted: the end of the last field. Encode pads to it; decode refuses less. */
  size: size.optional(),
  /** Decode accepts a payload this long or longer (a list reply may carry extra bytes). Default: size. */
  minSize: size.optional(),
  /** Decode refuses a longer payload (a record whose size must match exactly, or its offsets are stale). */
  maxSize: size.optional(),
  fields: z.array(FieldSchema).max(MAX_ENTRIES),
  /** Packed data after the fields (which then end at `size`, or the last field), to the end of the payload. */
  packed: packedTail.optional(),
  /**
   * An 8-bit record that never goes on the wire as it is (a file format, or a record only ever sent packed): left out
   * of the 7-bit check, and refused as a message's payload.
   */
  eightBit: z.boolean().optional(),
});
export type Layout = z.infer<typeof LayoutSchema>;

/** The ways a device is driven (a map's `driver`). */
export const DRIVERS = ["patch-dump", "param-change", "control-only"] as const;
export type Driver = (typeof DRIVERS)[number];

// ---- measured values --------------------------------------------------------------------------------------------

export const MEASURED_UNITS = ["ms", "s", "dB", "LUFS", "Hz", "%"] as const;
export const MEASURED_SOURCES = ["hardware-check", "sniffer-capture", "manual"] as const;

/** A calendar date as YYYY-MM-DD, one of the dates a measured value takes. */
export const MeasuredDateSchema = z.iso.date();

/**
 * One figure measured on the device, the one shape every measured value in a map takes: the number in its unit, what
 * it was measured on (device and firmware), when (an ISO date or date-time) and how (a hardware-check run, a sniffer
 * capture, or by hand).
 */
export const MeasuredValueSchema = z.strictObject({
  value: z.number(),
  unit: z.enum(MEASURED_UNITS),
  measuredOn: text().max(256),
  date: z.union([MeasuredDateSchema, z.iso.datetime({ offset: true })]),
  source: z.enum(MEASURED_SOURCES),
});
export type MeasuredValue = z.infer<typeof MeasuredValueSchema>;

export { MEASURED_FIELDS };
export type MeasuredField = keyof typeof MEASURED_FIELDS;

/**
 * A measured field: the shared shape in the field's own unit, from 0 (or above 0, for a positive one) to its max. The
 * open schema reads only this shape.
 */
export function measuredFieldSchema<F extends MeasuredField>(field: F) {
  const f: { unit: string; max: number; positive?: boolean } = MEASURED_FIELDS[field];
  const value = f.positive ? z.number().positive() : z.number().min(0);
  return MeasuredValueSchema.extend({ value: value.max(f.max), unit: z.literal(f.unit as (typeof MEASURED_FIELDS)[F]["unit"]) });
}

// ---- transport -------------------------------------------------------------------------------------------------

const sevenBit = (s: string) => s === "" || s.split(" ").every((h) => parseInt(h, 16) < 0x80);

/** Opening bytes: the SysEx start, then 7-bit data (manufacturer id and the rest). */
const sysexHeader = hexBytes
  .refine((h) => h.startsWith("f0"), "a SysEx header starts with f0")
  .refine((h) => sevenBit(h.split(" ").slice(1).join(" ")), "header bytes after f0 are 7-bit");

const TimingSchema = z.strictObject({
  /** Pause between frames of a send. */
  frameGapMs: nonNeg,
  /** Default wait for a reply or an acknowledgement; a message may set its own. */
  replyTimeoutMs: nonNeg,
  ackTimeoutMs: nonNeg,
  /** Named pauses the driver takes between steps. */
  pauses: cappedRecord(name, nonNeg, MAX_ENTRIES, "pauses").optional(),
  /** Measured on the device: what one request takes there, its median and p95, each a measured value in ms. */
  measured: z
    .strictObject({
      roundTripMedianMs: measuredFieldSchema("transport.timing.measured.roundTripMedianMs"),
      roundTripP95Ms: measuredFieldSchema("transport.timing.measured.roundTripP95Ms"),
    })
    .optional(),
  /**
   * Measured on the device by a hardware check run:
   * the median time of one compare_patch switch, in ms.
   */
  compareToggle: measuredFieldSchema("transport.timing.compareToggle").optional(),
});

const NibbleTransportSchema = z.strictObject({
  /** Selects the generic framing engine in code: SysEx frames carrying the inner message as nibbles. */
  framing: z.literal("sysex-nibbles"),
  frame: z
    .strictObject({
    header: sysexHeader,
    /** Fixed bytes between the header and the frame fields. */
    preamble: hexBytes.refine(sevenBit, "preamble bytes are 7-bit").optional(),
    /** Order of the frame fields after the preamble, each once. */
    fields: z
      .array(z.enum(["checksum", "kind", "total", "offset"]))
      .length(4)
      .refine((f) => new Set(f).size === 4, "each frame field once"),
    terminator: z.literal("f7"),
    /** Frame kinds by direction. */
    kinds: z.strictObject({ request: sevenBitByte, send: sevenBitByte, reply: sevenBitByte.optional(), notify: sevenBitByte.optional() }),
    checksum: z.strictObject({ algo: z.literal("nibble-sum"), mask: sevenBitByte }),
    nibbles: z.enum(["hi-lo", "lo-hi"]),
    /** Inner-message bytes per frame (before nibble splitting). */
    chunk: size.pipe(z.number().min(1)),
    /** Bits of the total and offset fields. */
    lengthBits: z.number().int().min(7).max(28),
    }),
  inner: z.strictObject({
    cmdLength: z.number().int().min(1).max(MAX_CMD_TOKENS),
    length: z.strictObject({ type: z.enum(["u16", "u32"]), endian }),
    compression: z.enum(["none", "lzo1x-literal"]),
  }),
  /** Default endianness of payload fields. */
  endian,
  timing: TimingSchema,
});

const cmdByteCount = z.number().int().min(1).max(MAX_CMD_TOKENS);

/**
 * One SysEx message per inner message, with no nibbles, chunks or length field:
 *   header | cmd | payload (7-bit bytes) | checksum | f7
 * The checksum is the XOR of every byte from the header's f0 to the last payload byte, masked.
 */
const XorTransportSchema = z.strictObject({
  framing: z.literal("sysex-xor"),
  frame: z.strictObject({
    header: sysexHeader,
    terminator: z.literal("f7"),
    checksum: z.strictObject({
      algo: z.literal("xor"),
      mask: sevenBitByte,
      /** Refuse an incoming message whose checksum does not match (otherwise it is read, not enforced). */
      verify: z.boolean(),
    }),
  }),
  inner: z.strictObject({ cmdLength: z.number().int().min(1).max(MAX_CMD_TOKENS) }),
  endian,
  timing: TimingSchema,
});

/**
 * One SysEx message per inner message, with nothing added: header | cmd | payload (7-bit bytes) | f7. No checksum,
 * nibbles, chunks or length field. Cmds may differ in length (`cmdLength` as {min, max}): an incoming message is read
 * with the longest cmd of the map that its bytes start with, so no cmd may begin another under the same header.
 */
const PlainTransportSchema = z.strictObject({
  framing: z.literal("sysex-plain"),
  frame: z.strictObject({
    header: sysexHeader,
    terminator: z.literal("f7"),
    /**
     * Other headers some messages are sent and received under, by name; a message picks one with `header`. For
     * messages outside the device's own header, such as the universal identity request and reply ("f0 7e").
     */
    headers: cappedRecord(name, sysexHeader, MAX_HEADERS, "headers").optional(),
  }),
  inner: z.strictObject({
    cmdLength: z.union([
      cmdByteCount,
      z.strictObject({ min: cmdByteCount, max: cmdByteCount }).refine((r) => r.min <= r.max, "cmdLength min is at most max"),
    ]),
  }),
  endian,
  timing: TimingSchema,
});

/**
 * Address-based SysEx ("roland-address"), one message per inner message:
 *   header | cmd (command byte(s), then the address) | payload | checksum | f7
 * The header holds the manufacturer, device ID and model ID, all from the map. The address is the cmd's last
 * `addressBytes` bytes, 7-bit digits most significant first. The checksum makes the address and payload bytes sum to 0
 * modulo 128: (128 - sum mod 128) & 7f. A read names an address and a size; the unit may answer it in pieces at
 * successive addresses (AddressReassembler joins them). Writes are not acknowledged.
 */
const AddressTransportSchema = z.strictObject({
  framing: z.literal("roland-address"),
  frame: z
    .strictObject({
      header: sysexHeader,
      /**
       * The header byte holding the device ID. The ID is set per unit, so the map's byte is only a default: until the
       * app sets the unit's own (AddressFramer's `deviceId`), an incoming message may carry any ID there, since a unit
       * answers a broadcast with its own. Omitted: incoming messages must carry the header as it is.
       */
      deviceIdAt: z.number().int().min(1).max(15).optional(),
      /**
       * Where the unit's MIDI identity reply carries the same device ID as this header (`f0 7e <id> 06 02`, as the
       * vendor documents it, cited in `source`): a unit silent at the map's default ID is tried once more at the
       * reply's ID. Left out, the reply's ID is never used. Needs `deviceIdAt` and the map's `identity`.
       */
      identityDeviceId: z.strictObject({ source: z.lazy(() => SourceSchema) }).optional(),
      terminator: z.literal("f7"),
      checksum: z.strictObject({
        algo: z.literal("roland-sum"),
        /** Refuse an incoming message whose checksum does not match (otherwise it is read, not enforced). */
        verify: z.boolean(),
      }),
      /** The most data bytes one message carries: a longer write goes in pieces at successive addresses. */
      maxData: z.number().int().min(1).max(MAX_BYTES).optional(),
    })
    .refine((f) => f.deviceIdAt === undefined || f.deviceIdAt < f.header.split(" ").length, "deviceIdAt is inside the header")
    .refine((f) => f.identityDeviceId === undefined || f.deviceIdAt !== undefined, "identityDeviceId needs deviceIdAt"),
  inner: z
    .strictObject({
      cmdLength: z.number().int().min(2).max(MAX_CMD_TOKENS),
      /** The cmd's last bytes that are the address; the bytes before them are the command. */
      addressBytes: z.number().int().min(1).max(MAX_ADDRESS_BYTES),
    })
    .refine((i) => i.addressBytes < i.cmdLength, "the cmd holds a command byte before the address"),
  endian,
  timing: TimingSchema,
});

/**
 * No SysEx: the unit takes MIDI channel messages only (the map's `controls`), so the map has no messages or layouts.
 * The timing's frame gap is the pause between two channel messages.
 */
const ChannelTransportSchema = z.strictObject({
  framing: z.literal("midi-channel"),
  endian: endian.default("le"),
  timing: TimingSchema.extend({ replyTimeoutMs: nonNeg.default(0), ackTimeoutMs: nonNeg.default(0) }).default({ frameGapMs: 0, replyTimeoutMs: 0, ackTimeoutMs: 0 }),
});

const TransportSchema = z.discriminatedUnion("framing", [NibbleTransportSchema, XorTransportSchema, PlainTransportSchema, AddressTransportSchema, ChannelTransportSchema]);
export type Transport = z.infer<typeof TransportSchema>;
export type NibbleTransport = z.infer<typeof NibbleTransportSchema>;
export type XorTransport = z.infer<typeof XorTransportSchema>;
export type PlainTransport = z.infer<typeof PlainTransportSchema>;
export type AddressTransport = z.infer<typeof AddressTransportSchema>;

/** The shortest and longest cmd the transport allows. */
export function cmdLengths(t: Transport): { min: number; max: number } {
  // a "midi-channel" transport frames no SysEx, so it has no inner frame
  if (!("inner" in t)) return { min: 1, max: 1 };
  const c = t.inner.cmdLength;
  return typeof c === "number" ? { min: c, max: c } : c;
}

// ---- where an entry comes from ------------------------------------------------------------------------------------

/**
 * Where a map entry's claim comes from, the sniffer spec's evidence per entry, ranked weakest first (agreed with the
 * seed-patch format, patchsprite-sniffer docs/formats/seed-patch.md, whose words a seed patch gives the entries it
 * changes; a patch's confirmation only raises an entry's source in this order, an addition or repair replaces it):
 * `doc` (vendor or third-party docs, unconfirmed on a unit), `player-confirmed` (a player saw a write the unit cannot
 * read back take effect), `wire` (seen in a capture of the vendor's editor), `device-reported` (a list the unit itself
 * reports, such as a block's parameters), `read-back` (a change read back on a unit), `replay-verified` (the sniffer
 * replayed it and the unit did it); and `test`, the app's own test maps only (a hardware-check run), never in a patch.
 * It is about the map, the same for every player; how far one unit trusts the entry is kept outside the map (map
 * checks).
 */
export const ENTRY_SOURCES = ["doc", "player-confirmed", "wire", "device-reported", "read-back", "replay-verified", "test"] as const;
export const SourceSchema = z.strictObject({
  kind: z.enum(ENTRY_SOURCES),
  /** what it was read from: a document and page, a capture or action id */
  ref: text().min(1).max(512).optional(),
});
export type EntrySource = z.infer<typeof SourceSchema>;

// ---- messages --------------------------------------------------------------------------------------------------

/** The longest an answer in pieces may take, and its deadline when the map sets none. */
export const MAX_PIECES_MS = MAX_LIST_MS;

/** How a request is answered. The reply's own layout sets the sizes it accepts. */
const ReplySchema = z.strictObject({
  /** The answering message; default: the same name (a request answered with the same cmd). */
  message: name.optional(),
  timeoutMs: nonNeg.optional(),
  /** Accept only a reply whose field has the request's field's wire value (a late answer to another request is skipped). */
  echo: z.array(z.strictObject({ reply: name, request: name })).max(16).optional(),
  /**
   * The answer is a list: an optional start message, then any number of `message` items (each checked by echo), then
   * the end message. Start and end are replies or notifies with cmds of their own. A list that passes `maxItems` items
   * or `maxBytes` item payload bytes is refused; one that has not ended `deadlineMs` after the request is given up on
   * (the reply `timeoutMs` still counts from each message received).
   */
  list: z
    .strictObject({
      start: name.optional(),
      end: name,
      maxItems: z.number().int().min(1).max(MAX_LIST_ITEMS),
      maxBytes: z.number().int().min(1).max(MAX_LIST_BYTES),
      deadlineMs: z.number().int().min(1).max(MAX_LIST_MS),
    })
    .optional(),
  /** The answer comes in pieces, joined before it is read (see PiecesSchema). Not with `list`. */
  pieces: PiecesSchema.optional(),
}).refine((r) => !(r.list && r.pieces), "a reply is a list or comes in pieces, not both");

const AckSchema = z
  .strictObject({
    /** The acknowledgement message (its layout has the fields below). */
    message: name,
    timeoutMs: nonNeg.optional(),
    /** Ack field holding the acknowledged cmd bytes. */
    cmdField: name,
    statusField: name,
    okStatus: z.number().int(),
    /** Match the ack's id field against this message's field, so a late ack of an earlier command is skipped. */
    idField: name.optional(),
    requestIdField: name.optional(),
  })
  .refine((a) => (a.idField === undefined) === (a.requestIdField === undefined), "idField and requestIdField go together");

/** A value a probe or read-back puts in a request field: a number, an enum key, or null for a field's "none". */
const sampleValue = z.union([z.number(), z.string().max(64), z.null()]);

/**
 * First contact: the request has no side effect on the unit (some maps write with a request, so `dir` alone does not
 * say so), and the read-only probe may send it once. `true`, or the values to send it with: `fields` for payload
 * fields that have no const, default or copyOf, `args` for cmd placeholders.
 */
const SafeReadSchema = z.union([
  z.literal(true),
  z.strictObject({
    fields: cappedRecord(name, sampleValue, 64, "safeRead fields").optional(),
    args: cappedRecord(name, byte, 16, "safeRead args").optional(),
  }),
]);

/**
 * On a write (a send, or a request that is not a safeRead): the safeRead request that reads back what it wrote. A
 * name alone pairs fields by name: the read's own payload fields the write also has are its inputs, and the read's
 * reply fields the write also has (inputs aside, and only fields that carry a value in both) are compared. The long
 * form names the pairs, each list replacing what the name alone would infer. Compared as decoded values. `false` says
 * the unit has no read for it, so only the player can confirm it lands.
 */
const ReadBackSchema = z.union([
  name,
  /** the unit can't read the write back: only the player can confirm it (said outright where the framing never acknowledges one) */
  z.literal(false),
  z.strictObject({
    request: name,
    /** the read's request field filled from the write's field (its address: block, parameter) */
    inputs: z.array(z.strictObject({ request: name, send: name })).max(16).optional(),
    /** the read's reply field that must equal the write's field */
    compare: z.array(z.strictObject({ reply: name, send: name })).min(1).max(16).optional(),
  }),
]);

export const MessageSchema = z.strictObject({
  cmd: cmdTemplate,
  /** request: host asks; send: host writes; reply: device answers; notify: device speaks unasked. */
  dir: z.enum(["request", "send", "reply", "notify"]),
  /** Inline layout, or the name of a shared one in `layouts`. Omitted: no payload. */
  payload: z.union([LayoutSchema, name]).optional(),
  reply: ReplySchema.optional(),
  ack: AckSchema.optional(),
  /** sysex-xor only, on a reply or notify: the device sends it with no checksum byte, so its payload runs to the f7. */
  noChecksum: z.boolean().optional(),
  /** sysex-plain only: sent and received under this entry of `transport.frame.headers` instead of the device's header. */
  header: name.optional(),
  /**
   * On a request or send with a fixed cmd: the vendor's editor sends it on its own, all the time (a status poll). The
   * editor-walk tools leave it, and the device's answer to it, out of what counts as an action's traffic.
   */
  poll: z.boolean().optional(),
  source: SourceSchema.optional(),
  /** On a request with no side effect: the first-contact probe may send it (see SafeReadSchema). */
  safeRead: SafeReadSchema.optional(),
  /** On a write: the request that reads back what it wrote (see ReadBackSchema). */
  readBack: ReadBackSchema.optional(),
  note: text().max(1024).optional(),
});
export type Message = z.infer<typeof MessageSchema>;
export type SafeRead = z.infer<typeof SafeReadSchema>;
type Reply = z.infer<typeof ReplySchema>;

// ---- settings (device-wide globals and EQ) -----------------------------------------------------------------------

const SettingSchema = z.strictObject({
  id: key,
  label: line().max(256),
  group: name,
  /** Where the value sits in the group read-back. */
  read: z.strictObject({ offset: size, type: z.enum(SCALAR_TYPES) }),
  /** The message that writes it, and its cmd arguments. Its payload has a field named `value`. */
  write: z.strictObject({ message: name, args: cappedRecord(name, byte, 8, "args").optional() }),
  /** Value -> name, for the values known. How a value is shown otherwise stays in code. */
  options: cappedRecord(z.string().regex(/^-?\d{1,10}$/), line().max(256), MAX_ENTRIES, "options").optional(),
  /** Values known to be safe to write: the only ones written. */
  writable: z.array(z.number().int()).max(MAX_ENTRIES),
  /** Shown, never written. */
  readOnly: z.boolean().optional(),
  /** A MIDI channel setting: the `count` raw values from `first` are channels 1..count (other values are options). */
  channel: z.strictObject({ first: int, count: z.number().int().min(1).max(16) }).optional(),
});

const SettingsSchema = z.strictObject({
  /** Group id -> the message that reads it, and its cmd arguments. */
  groups: cappedRecord(name, z.strictObject({ read: name, args: cappedRecord(name, byte, 8, "args").optional() }), MAX_ENTRIES, "groups"),
  items: z.array(SettingSchema).max(MAX_ENTRIES),
});

const EqSchema = z.strictObject({
  /** The settings group holding the EQ. */
  group: name,
  power: z.strictObject({ write: name, read: z.strictObject({ offset: size, type: z.enum(SCALAR_TYPES) }) }),
  /** Parameter p is read at base + stride * p, written with `write` (fields `param` and `value`). */
  param: z.strictObject({ write: name, base: size, stride: size, type: z.enum(SCALAR_TYPES) }),
  bands: z
    .array(z.strictObject({ id: key, label: line().max(256), on: nonNeg, freq: nonNeg, q: nonNeg, gain: nonNeg.optional() }))
    .max(64),
  level: nonNeg,
  ranges: z.record(z.enum(["freq", "q", "gain", "level"]), z.tuple([z.number(), z.number()])),
});

// ---- the section -----------------------------------------------------------------------------------------------

const EnumSchema = cappedRecord(key, z.number().int(), MAX_ENTRIES, "enum keys");
const enums = cappedRecord(name, EnumSchema, MAX_ENTRIES, "enums");
const messages = cappedRecord(name, MessageSchema, MAX_ENTRIES, "messages");
const layouts = cappedRecord(name, LayoutSchema, MAX_ENTRIES, "layouts");
const constants = cappedRecord(name, z.number(), MAX_ENTRIES, "constants");
const blocked = z.array(name).max(MAX_BLOCKED);

/** What a firmware changes from the base protocol: whole entries replaced by name, and messages it must not get. */
const reason = text().min(1).max(512);

/**
 * The safety floor: rules the driver enforces before anything is sent, whatever the caller asks. A firmware can make
 * them stricter, never looser.
 */
const SafetySchema = z.strictObject({
  /** A block's model may change only in these scenes (0-based). */
  modelChange: z.strictObject({ scenes: z.array(z.number().int().min(0).max(255)).min(1).max(64), reason }),
  /**
   * Models whose type (the model code shifted right by `typeShift`) halts the device are never assigned. An empty
   * `types` list means no type is known to halt the device; a firmware entry may still add some.
   */
  haltingModels: z.strictObject({ typeShift: z.number().int().min(0).max(31), types: z.array(z.number().int().min(0)).max(256), reason }),
  /**
   * Short notes on how the device behaves that anyone driving it by hand must know (an editor walk prints them at
   * start): what froze it and how it came back, which reads have side effects. Text for people and the walk prompt
   * only: no code parses them, and the driver checks none. A note that should become a guard (say "change the
   * algorithm only in Scene 1") moves to a structured rule in this section, which the driver enforces, rather than
   * being read out of the text. A note needs a character that prints, so it never shows as a bare "Note: ".
   */
  notes: z
    .array(text().max(200).refine((s) => /[^\s\x00-\x1f\x7f-\x9f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/.test(s), "a note has text"))
    .max(16)
    .optional(),
});

/** How the device names things for the player. */
const DisplaySchema = z.strictObject({
  /** The device's own name, as the player knows it. */
  deviceName: line()
    .min(1)
    .max(64)
    .regex(/^[\p{L}\p{N}](?:[\p{L}\p{N} .,!'&+()/_®™-]|(?<=\S):(?=\S))*$/u, "a device name is letters, digits, spaces and . , ! ' & + ( ) / _ - ® ™, and : only between two non-spaces"),
  /**
   * Patch labels: `{bank}`, `{slot}` and `{index}` stand for numbers, `{index:3}` zero-padded to 3 digits. A patch's
   * index i is in bank floor(i / bankSize) + firstBank, at slot i % bankSize + firstSlot, and is number i + firstIndex.
   */
  patchLabel: z.strictObject({
    pattern: z.string().min(1).max(32).regex(/^([A-Za-z0-9 ._-]|\{(bank|slot|index)(:[1-9])?\})+$/, "letters, digits and {bank}, {slot}, {index} tokens"),
    bankSize: z.number().int().min(1).max(1000),
    firstBank: z.number().int().min(0).max(1000).optional(),
    firstSlot: z.number().int().min(0).max(1000).optional(),
    firstIndex: z.number().int().min(0).max(1000).optional(),
  }),
  /** Rows the blocks are laid out in on the device's screen. Needed on a patch-dump device. */
  rows: z.number().int().min(1).max(16).optional(),
  /** The name a free patch slot has. Needed on a patch-dump device. */
  emptyPatchName: line().min(1).max(64).optional(),
  /** A scene's name before anyone names it; `{n}` is its number from 1. Needed on a device with scenes. */
  defaultSceneName: line().min(1).max(64).optional(),
  /** How the player is told which scene: `{n}` is its number from 1 ("Scene {n}"). Needed on a device with scenes. */
  sceneLabel: line().min(1).max(64).regex(/\{n\}/, "a {n} for the scene's number").optional(),
  /** What the device calls a block's channels, one character each in order ("ABCD", "XY"). Default: A, B, C, ... */
  channelNames: z
    .string()
    .min(1)
    .max(16)
    .regex(/^[A-Za-z0-9]+$/)
    .refine((s) => new Set(s.toUpperCase()).size === s.length, "channel names that differ, not only in case")
    .optional(),
});

/** Audio facts measured on the device. */
const AudioSchema = z.strictObject({
  /** Patch volume to gain: "amplitude" is dB = 20 log10(v / unity). */
  volumeLaw: z.strictObject({
    kind: z.literal("amplitude"),
    unity: z.number().positive(),
    min: z.number().int(),
    max: z.number().int(),
    /** the quietest volume that is not muted */
    quietest: z.number().int(),
    calibrated: z.boolean(),
    calibratedOn: text().max(256).optional(),
    /** how far the measurements sit from the law, dB */
    toleranceDb: z.number().nonnegative().optional(),
    evidence: z.array(z.strictObject({ volume: z.number(), lufs: z.number() })).max(64).optional(),
  }),
  /** Reamping through the device's USB audio. */
  reamp: z.strictObject({
    /** the audio endpoint's name, or a part of it */
    endpoint: z.string().min(1).max(64),
    sampleRate: z.number().int().min(8000).max(384000),
    channels: z.number().int().min(1).max(32),
    /** the USB output the DI is sent on, and the USB inputs captured (name -> number), from 1 */
    send: z.number().int().min(1).max(64),
    inputs: z.record(key, z.number().int().min(1).max(64)),
    /** the USB outputs (from 1) that join the device's outputs after its effects chain, like an AUX input: finished
     * A/B files are played on them to play them clean through the device. Never the send, which feeds the chain.
     * Absent: nothing is known to bypass the chain, and that is refused. */
    bypassOutputs: z.array(z.number().int().min(1).max(64)).min(1).max(2).optional(),
    /** the boost that makes a reamp as loud as the take played live, dB */
    gainDb: z.number().min(-60).max(24),
    /** below this correlation the latency estimate is not trusted */
    minLatencyConfidence: z.number().min(0).max(1),
    /** the inputSource keys for a reamp and for live playing, with what the player calls them */
    source: key,
    liveSource: key,
    sourceNames: z.record(key, line().min(1).max(64)),
    /** what one reamp takes on top of its audio (opening the endpoints, pre-roll, tail, the input switch), measured
     * on the device, in s: a reamp of s seconds takes about s + value */
    overhead: measuredFieldSchema("audio.reamp.overhead").optional(),
  }),
});

/**
 * The vendor's editor, for the editor-walk tools. The app's sniff decoder checks the
 * walk's env overrides with it too, so the Python tools hold none of these rules.
 */
export const EditorSchema = z.strictObject({
  /** its executable's file name, as the process list shows it */
  exe: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[\x20-\x7e]+$/, "printable ASCII")
    .regex(/^[^\\/:*?"<>|]+$/, "a file name, with no folder"),
  /** how long to wait after the editor starts before attaching to it, measured on the device's editor, in s */
  attachDelay: measuredFieldSchema("host.editor.attachDelay").optional(),
});

/** How the host finds the device. */
const HostSchema = z.strictObject({
  /** the MIDI port's name, or a part of it */
  midiPort: z.string().min(1).max(128),
  /** USB vendor and product ids, 4 hex digits each */
  usb: z.strictObject({ vid: z.string().regex(/^[0-9A-F]{4}$/), pid: z.string().regex(/^[0-9A-F]{4}$/) }),
  /** the vendor's own apps that hold the port: process name prefix (lower case) and what to call it */
  vendorApps: z.array(z.tuple([line().min(1).max(64), line().min(1).max(64)])).max(16),
  /** the vendor's editor, for the editor-walk tools */
  editor: EditorSchema.optional(),
});

const version = z.string().regex(VERSION_PATTERN, "a version is dotted whole numbers, maybe after a V, such as 4.00, 21 or V1.2.0");
const FirmwareDeltaSchema = z.strictObject({
  /**
   * The versions this entry covers besides its own key: from `from` (included) up to `below` (left out), either end
   * open. A version the unit reports reads the entry keyed by exactly it first, else the one entry whose range holds it.
   */
  range: z
    .strictObject({ from: version.optional(), below: version.optional() })
    .refine((r) => r.from !== undefined || r.below !== undefined, "a range needs from, below or both")
    .optional(),
  messages: messages.optional(),
  layouts: layouts.optional(),
  /** whole enums replaced by name (a firmware that adds models lists them all), or new ones its own messages name */
  enums: enums.optional(),
  constants: constants.optional(),
  blocked: blocked.optional(),
  /** stricter safety on this firmware: fewer scenes for model changes, more halting model types */
  safety: z
    .strictObject({
      modelChangeScenes: z.array(z.number().int().min(0).max(255)).min(1).max(64).optional(),
      haltingTypes: z.array(z.number().int().min(0)).max(256).optional(),
    })
    .optional(),
  note: text().max(1024).optional(),
});

/** One block parameter, by the name the device shows. */
const ParameterSchema = z.strictObject({
  id: z.number().int().min(0).max(16383),
  /**
   * knob or slider: a position 0..max (the device shows its own label for it); select or switch: one of `options`;
   * range: a plain number min..max in steps of `step`.
   */
  kind: z.enum(["knob", "slider", "select", "switch", "range"]),
  options: cappedRecord(z.string().regex(/^\d{1,5}$/), line().min(1).max(64), 1024, "options").optional(),
  min: z.number().int().optional(),
  max: z.number().int().optional(),
  step: z.number().int().min(1).optional(),
  /** The raw value the device gives the parameter when the effect is put in (an option's key for a select or switch). */
  default: z.number().int().optional(),
  source: SourceSchema.optional(),
  note: text().max(1024).optional(),
});

/** Parameters and options across every group, counted before the groups are parsed. */
function parameterTotals(v: unknown): { params: number; options: number } {
  let params = 0;
  let options = 0;
  const entries = (o: unknown) => (o !== null && typeof o === "object" ? Object.values(o) : []);
  for (const g of entries((v as { groups?: unknown } | null)?.groups)) {
    for (const x of entries((g as { params?: unknown } | null)?.params)) {
      params++;
      const opts = (x as { options?: unknown } | null)?.options;
      if (opts !== null && typeof opts === "object") options += Object.keys(opts).length;
    }
  }
  return { params, options };
}

/**
 * A rule a linked set's values must keep, over the set's parameters in its order or over `params`, a run of them:
 * - ascending: each at or below the next (a min and max pair; `strict`: below it);
 * - distinct: no value twice, except the `repeatable` ones (an order of effects, where a split may repeat).
 */
const LinkRuleSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("ascending"), params: z.array(line().min(1).max(64)).min(2).max(256).optional(), strict: z.boolean().optional() }),
  z.strictObject({
    kind: z.literal("distinct"),
    params: z.array(line().min(1).max(64)).min(2).max(256).optional(),
    repeatable: z.array(z.number().int()).max(64).optional(),
  }),
]);

/**
 * Parameters the device checks together: a write that would break a rule is refused before anything is sent, and
 * the driver writes the set in an order that never leaves it in a state the rules forbid.
 * - commit "last": the device holds each write pending until the set's last parameter is written, then applies them
 *   all if they keep its rules. Every parameter of the set is written, in the
 *   set's order, ending with the last one.
 * - commit "each": the device applies each write at once. Only the parameters that change are written, in an order
 *   that keeps the rules after every write; a change no such order reaches (a swap within a distinct set) is refused.
 */
const LinkedSetSchema = z.strictObject({
  /** names of the table's parameters, in the order the device takes them (the last commits a "last" set) */
  params: z.array(line().min(1).max(64)).min(2).max(256),
  commit: z.enum(["last", "each"]),
  rules: z.array(LinkRuleSchema).max(16).optional(),
  note: text().max(1024).optional(),
});
export type LinkedSetDef = z.infer<typeof LinkedSetSchema>;
export type LinkRule = z.infer<typeof LinkRuleSchema>;

/**
 * Block parameters, for devices that set them one by one: groups of blocks (all amps, all delays) that share one
 * parameter table, or, on a device whose slots can each hold any effect, groups of effect types (keys of the `type`
 * enum) that share one: a slot's table is then its current type's. A parameter the device lists (paramList) but no
 * table names is still read and set by its id.
 */
const ParametersObject = z.strictObject({
  /** The raw value of a knob or slider at full travel (its labels come from the device). */
  knobMax: z.number().int().min(1).max(2 ** 21),
  groups: cappedRecord(
    key,
    z.strictObject({
      /** keys of the `block` enum: the table goes with these blocks, whatever effect is in them */
      blocks: z.array(key).min(1).max(64).optional(),
      /** keys of the `type` enum: the table goes with these effect types, in whichever block (slot) holds one */
      types: z.array(key).min(1).max(1024).optional(),
      params: cappedRecord(line().min(1).max(64), ParameterSchema, 1024, "params"),
      /** parameters the device checks together, by a name for the set (see LinkedSetSchema) */
      linked: cappedRecord(key, LinkedSetSchema, 64, "linked").optional(),
    }),
    256,
    "groups",
  ),
});
const ParametersSchema = z.preprocess((v, ctx) => {
  if (v === null || typeof v !== "object") return v;
  const { params, options } = parameterTotals(v);
  if (params > MAX_PARAMS) ctx.addIssue({ code: "custom", message: `at most ${MAX_PARAMS} parameters across all groups, got ${params}` });
  if (options > MAX_OPTIONS) ctx.addIssue({ code: "custom", message: `at most ${MAX_OPTIONS} options across all parameters, got ${options}` });
  return params > MAX_PARAMS || options > MAX_OPTIONS ? z.NEVER : v;
}, ParametersObject);

/**
 * Encodings the docs disagree on (a preset number's byte order, say): every field that names the choice takes the keys
 * of the option in force. The unit settles it: a value it reports that only one option reads within the field's
 * range (or as a known enum key) pins that option for the unit. Until then a message whose bytes differ between the
 * options is not sent.
 */
const ChoiceSchema = z.strictObject({
  /** what is in doubt, for the player: "how this unit numbers presets" */
  what: line().min(1).max(128),
  /** a request whose reply settles it, which the driver may read before refusing a send: a read, never a change */
  readBy: name.optional(),
  /** what the player can do to settle it: "switch to any preset on the unit itself, then ask again" */
  settle: text().min(1).max(256).optional(),
  options: cappedRecord(name, z.strictObject({ endian }), MAX_CHOICE_OPTIONS, "options"),
  source: SourceSchema.optional(),
  note: text().max(1024).optional(),
});

/** Modes a map may name, and stand-ins one mode may list per kind. */
const MAX_MODES = 16;
const standInsOf = (k: z.ZodType<string>, what: string) => cappedRecord(k, k.nullable(), MAX_ENTRIES, what).optional();

/**
 * Modes whose entries live apart (a unit set up for guitar or for bass keeps its patches at other addresses in each).
 * `read` names a request and the field of its reply that says which mode the unit is in, reading an enum whose keys are
 * the modes. `use` lists, per mode, the map entries that stand in for the names the driver asks for (null where the
 * mode has no such entry); a mode it does not list uses the map's own entries.
 */
const ModesSchema = z.strictObject({
  read: z.strictObject({ message: name, field: line().min(1).max(64) }),
  use: cappedRecord(
    key,
    z.strictObject({
      messages: standInsOf(name, "message stand-ins"),
      layouts: standInsOf(name, "layout stand-ins"),
      enums: standInsOf(name, "enum stand-ins"),
      constants: standInsOf(name, "constant stand-ins"),
      groups: standInsOf(key, "group stand-ins"),
    }),
    MAX_MODES,
    "modes",
  ),
  note: text().max(1024).optional(),
});

/**
 * One step a unit needs from its host when the port opens, before it answers (an edit mode, a handshake): a message of
 * the map, sent with `values` for its payload fields (a request's reply, or its list, is waited for), then a pause of
 * `pauseMs`. A step may be only a pause (a unit that needs a moment after the port opens).
 */
const ConnectStepSchema = z
  .strictObject({
    message: name.optional(),
    values: cappedRecord(name, z.union([z.number(), z.string().max(3 * MAX_STRING)]), 64, "values").optional(),
    pauseMs: z.number().int().min(0).max(MAX_STEP_PAUSE_MS).optional(),
    note: text().max(1024).optional(),
  })
  .refine((s) => s.message !== undefined || s.pauseMs !== undefined, "a step sends a message, pauses, or both")
  .refine((s) => s.message !== undefined || s.values === undefined, "values go with a message");

/** What the host does around a connection, beyond reading the unit's firmware. */
const SessionSchema = z.strictObject({
  /**
   * Run in order each time the port opens, before the firmware is read: the base map's messages (a firmware's own
   * definitions are not known yet). A request the unit does not answer fails the connection, as a silent unit does.
   */
  onConnect: z
    .array(ConnectStepSchema)
    .min(1)
    .max(MAX_CONNECT_STEPS)
    .refine((steps) => steps.reduce((n, s) => n + (s.pauseMs ?? 0), 0) <= MAX_CONNECT_PAUSE_MS, `at most ${MAX_CONNECT_PAUSE_MS} ms of pauses in all`),
});
export type ConnectStep = z.infer<typeof ConnectStepSchema>;

const ProtocolBase = z.strictObject({
  /** Schema version of this section. */
  schema: z.literal(1),
  transport: TransportSchema,
  messages,
  layouts,
  enums: enums.optional(),
  /** Named sizes, counts and sentinels ("presetCount", "sampleFirstId"). */
  constants: constants.optional(),
  settings: SettingsSchema.optional(),
  eq: EqSchema.optional(),
  /** Messages never sent on any firmware. */
  blocked: blocked.optional(),
  /**
   * roland-address only: named tables of address offsets by enum key, for address fields with `table` (where each block's
   * area starts, relative to the message's own address).
   */
  addresses: cappedRecord(name, cappedRecord(key, addressHex, MAX_ENTRIES, "table entries"), MAX_ADDRESS_TABLES, "address tables").optional(),
  safety: SafetySchema.optional(),
  display: DisplaySchema.optional(),
  audio: AudioSchema.optional(),
  host: HostSchema.optional(),
  /** What the unit answers to the MIDI identity request; checked before anything else is sent to it (identity.ts). */
  identity: IdentitySchema.optional(),
  /**
   * How the device is driven, stated by the map rather than guessed from its framing: "patch-dump" (the unit hands
   * over and takes whole patches as one record the map lays out) or "param-change" (the unit
   * is addressed one message at a time: preset, scene, block bypass and channel, one parameter per message) or
   * "control-only" (the unit takes MIDI channel messages, its `controls`, and answers none: nothing is read back). A map the
   * sniffer builds states it (parseDeviceMap refuses one that doesn't); parseProtocol reads one without it as
   * "patch-dump", for the maps written before the field was required.
   */
  driver: z
    .preprocess((v, ctx) => {
      // the names before 24 Nov 2026: a map still using one is told what it is now, not just refused
      const renamed: Record<string, string> = { patch: "patch-dump", rig: "param-change" };
      if (typeof v !== "string" || !Object.hasOwn(renamed, v)) return v;
      ctx.addIssue({ code: "custom", message: `driver "${v}" was renamed "${renamed[v]}"; change it in the map` });
      return z.NEVER;
    }, z.enum(DRIVERS))
    .optional(),
  parameters: ParametersSchema.optional(),
  /**
   * What the map's sources warn crashed a unit or hurt someone's ears (a seed's hazard list), by the entry names map
   * checks use ("setParam", "param/amp/1", "setBypass/amp") -> why. With `values`, only writes of those raw values (an
   * amp model's number). While no unit has verified the map on its firmware (a draft, or a confirmed map that lists no
   * check of that firmware), those writes are refused (first-write.ts); a map listing the firmware settled them.
   */
  hazards: cappedRecord(
    text().min(1).max(256),
    z.strictObject({ why: reason, values: z.array(z.union([z.number(), z.string().max(64)])).min(1).max(256).optional() }),
    MAX_ENTRIES,
    "hazards",
  ).optional(),
  /**
   * What the map's sources warn about that no single write names (a timing rule, a mode, how a save must be sent): told
   * to the player while the map is a draft, never enforced. A caution code can enforce becomes data instead (a pause in
   * `transport.timing`, a hazard on an entry). `about` lists the entries it concerns, by the same names as `hazards`.
   */
  cautions: z
    .array(z.strictObject({ why: reason, about: z.array(line().min(1).max(256)).min(1).max(64).optional() }))
    .max(256)
    .optional(),
  /** MIDI channel messages the unit takes (CC, program change with bank select, NRPN): see channel-messages.ts. */
  controls: ControlsSchema.optional(),
  /** Encodings the docs disagree on, settled per unit (fields name them with `choice`). */
  choices: cappedRecord(name, ChoiceSchema, MAX_CHOICES, "choices").optional(),
  /** Patch slots Patchsprite may use as scratch (compare_patch parks the edits there), labels as the device spells
   * them, best first. Whatever a player keeps there is backed up before first use. */
  scratch: z.strictObject({ slots: z.array(line().min(1).max(16)).min(1).max(8) }).optional(),
  /** Modes whose entries live apart, how the unit's mode is read, and which entries stand in for which in each. */
  modes: ModesSchema.optional(),
  /** Steps the unit needs when its port opens (an edit mode, a handshake). */
  session: SessionSchema.optional(),
  /** Per-firmware changes, keyed by the version string the device reports. */
  firmwares: cappedRecord(z.string().max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/), FirmwareDeltaSchema, MAX_FIRMWARES, "firmwares").optional(),
});

export const ProtocolSchema = ProtocolBase.superRefine((p, ctx) => {
  for (const issue of crossCheck(p)) ctx.addIssue({ code: "custom", message: issue });
});
export type Protocol = z.infer<typeof ProtocolSchema>;
export type SafetyRules = z.infer<typeof SafetySchema>;
export type Display = z.infer<typeof DisplaySchema>;
export type Audio = z.infer<typeof AudioSchema>;
export type Host = z.infer<typeof HostSchema>;
export type Parameters = z.infer<typeof ParametersObject>;
export type Parameter = z.infer<typeof ParameterSchema>;
export type Choice = z.infer<typeof ChoiceSchema>;

// ---- validation beyond shapes ------------------------------------------------------------------------------------

type ProtocolShape = z.infer<typeof ProtocolBase>;
const has = (o: object, k: string) => Object.hasOwn(o, k);

/** A layout's fields, then those of the shared layout its packed tail is read with (their values share one record). */
function withTailFields(l: Layout, layouts: Record<string, Layout>): Field[] {
  const t = l.packed?.layout;
  return t !== undefined && has(layouts, t) ? [...l.fields, ...layouts[t].fields] : l.fields;
}

interface View {
  messages: Record<string, Message>;
  layouts: Record<string, Layout>;
  enums: Record<string, Record<string, number>>;
  endian: "le" | "be";
  blocked: string[];
  settings: ProtocolShape["settings"];
  eq: ProtocolShape["eq"];
}

/** The shared layout a layout's packed tail is read with, or joined into as a piece of a record. */
export const tailLayoutName = (l: Layout): string | undefined => l.packed?.layout ?? l.packed?.pieces?.layout;

/** A tail's pieces as a tail may state them (an offset field and a record layout), or undefined. */
export function tailPieces(p: PackedTail | undefined): { layout: string; offsetField: string } | undefined {
  const x = p?.pieces;
  return x?.layout !== undefined && typeof x.offset === "object" ? { layout: x.layout, offsetField: x.offset.field } : undefined;
}

/**
 * Shared layouts that only read packed tails (a tail's `layout` or `pieces.layout`), and those marked eightBit, that no
 * message names as its payload: their bytes are never sent as they are, so their fields may use all 8 bits.
 */
function tailOnlyLayouts(msgs: Record<string, Message>, lays: Record<string, Layout>): Set<string> {
  const out = new Set<string>();
  for (const [n, l] of Object.entries(lays)) if (l.eightBit) out.add(n);
  for (const l of [...Object.values(lays), ...Object.values(msgs).map((m) => m.payload)]) {
    const t = l !== undefined && typeof l !== "string" ? tailLayoutName(l) : undefined;
    if (t !== undefined) out.add(t);
  }
  for (const m of Object.values(msgs)) if (typeof m.payload === "string") out.delete(m.payload);
  return out;
}

/**
 * Every framing but "sysex-nibbles" sends payload bytes as they are, so every byte must be 7-bit. A scalar is either one
 * byte whose bits stay below the eighth (u8, or bits within the low 7), or is sent as septets or nibbles; anything else
 * would be refused on encode and misread on decode. A layout that only reads packed tails, or is marked eightBit, is
 * exempt.
 */
function sevenBitIssues(p: ProtocolShape): string[] {
  const out: string[] = [];
  type Enums = Record<string, Record<string, number>>;
  type AnyField = Layout["fields"][number];
  // each enum's largest value, found once per table: scale is positive, so it gives the field's largest enum wire value
  const largest = new Map<Record<string, number>, number>();
  const largestOf = (e: Record<string, number>) => {
    let m = largest.get(e);
    if (m === undefined) largest.set(e, (m = Object.values(e).reduce((x, y) => Math.max(x, y), -Infinity)));
    return m;
  };
  /** The enums a field names: its own `enum`, and those its `enumBy` picks from. */
  const enumsOf = (f: AnyField): string[] =>
    f.type === "bytes" || f.type === "string" || f.type === "pad" ? [] : [...(f.enum !== undefined ? [f.enum] : []), ...Object.values(f.enumBy?.enums ?? {})];
  const fits = (f: AnyField, l: Layout, all: Record<string, Layout>, enums: Enums) => {
    // an address field's value goes in the address, which the address checks cover
    if (f.type === "bytes" || f.type === "string" || f.type === "pad" || digitsOf(f) || f.address) return true;
    // every wire value the map names for a whole-byte u8: its max, default and largest enum value (scaled), const and nullAs
    const wire = (x: number) => x * (f.scale ?? 1) + (f.bias ?? 0);
    // its own enum and every enum an enumBy can pick for it
    const named = [f.max, f.default, ...enumsOf(f).map((e) => (has(enums, e) ? largestOf(enums[e]) : undefined))].filter((x) => x !== undefined).map(wire);
    for (const x of [f.const, f.nullAs]) if (x !== undefined) named.push(x);
    // a packed tail's length field is written from the data, up to its maxLength
    if (l.packed?.lengthField === f.name) named.push(l.packed.maxLength);
    // a record piece's offset field, up to the last piece's offset
    const rec = tailPieces(l.packed);
    if (rec?.offsetField === f.name && has(all, rec.layout) && l.packed!.maxLength >= 1) named.push(lastPieceAt(layoutSize(all[rec.layout]), l.packed!.maxLength));
    return f.type === "u8" && (f.bits ? f.bits.shift + f.bits.width <= 7 : named.every((x) => x <= 0x7f));
  };
  const fieldIssue = (where: string, f: AnyField, l: Layout, all: Record<string, Layout>, enums: Enums) => {
    if (!fits(f, l, all, enums)) out.push(`${where}: field ${f.name} needs septets or nibbles, or 7 bits at most, on a ${p.transport.framing} transport`);
  };
  const check = (where: string, l: Layout, all: Record<string, Layout>, enums: Enums) => {
    for (const f of l.fields) fieldIssue(where, f, l, all, enums);
  };
  const scan = (prefix: string, msgs: Record<string, Message> | undefined, lays: Record<string, Layout> | undefined, exempt: Set<string>, all: Record<string, Layout>, enums: Enums) => {
    for (const [n, l] of Object.entries(lays ?? {})) if (!exempt.has(n)) check(`${prefix}layout ${n}`, l, all, enums);
    for (const [n, m] of Object.entries(msgs ?? {})) {
      if (m.cmd.split(" ").some((t) => !t.startsWith("{") && parseInt(t, 16) > 0x7f)) out.push(`${prefix}message ${n}: cmd bytes are 7-bit on a ${p.transport.framing} transport`);
      if (m.payload !== undefined && typeof m.payload !== "string") check(`${prefix}message ${n}`, m.payload, all, enums);
    }
  };
  const baseEnums = p.enums ?? {};
  const baseExempt = tailOnlyLayouts(p.messages, p.layouts);
  scan("", p.messages, p.layouts, baseExempt, p.layouts, baseEnums);
  // the base fields naming each enum, found once: a firmware that replaces an enum checks only those it keeps
  let byEnum: Map<string, [kind: "layout" | "message", entry: string, f: AnyField, l: Layout][]> | undefined;
  const fieldsNaming = (e: string) => {
    if (!byEnum) {
      byEnum = new Map();
      const add = (kind: "layout" | "message", entry: string, l: Layout) => {
        for (const f of l.fields) {
          for (const e of new Set(enumsOf(f))) {
            const list = byEnum!.get(e);
            if (list) list.push([kind, entry, f, l]);
            else byEnum!.set(e, [[kind, entry, f, l]]);
          }
        }
      };
      for (const [n, l] of Object.entries(p.layouts)) add("layout", n, l);
      for (const [n, m] of Object.entries(p.messages)) if (m.payload !== undefined && typeof m.payload !== "string") add("message", n, m.payload);
    }
    return byEnum.get(e) ?? [];
  };
  for (const [fw, d] of Object.entries(p.firmwares ?? {})) {
    const prefix = `firmware ${fw}: `;
    const enums = { ...baseEnums, ...d.enums };
    const allFw = { ...p.layouts, ...d.layouts };
    const exempt = tailOnlyLayouts({ ...p.messages, ...d.messages }, allFw);
    // a base layout exempt in the base but sent as is on this firmware is checked here
    const lays = { ...d.layouts };
    for (const n of baseExempt) if (!exempt.has(n) && !has(lays, n)) lays[n] = p.layouts[n];
    // a base record piece whose record this firmware replaces: its offset field must hold the new last offset
    const newRecord = (l: Layout | string | undefined) => {
      const rec = typeof l === "object" ? tailPieces(l.packed) : undefined;
      return rec !== undefined && has(d.layouts ?? {}, rec.layout);
    };
    const msgs = { ...d.messages };
    for (const [n, m] of Object.entries(p.messages)) if (!has(msgs, n) && newRecord(m.payload)) msgs[n] = m;
    for (const [n, l] of Object.entries(p.layouts)) if (!has(lays, n) && !exempt.has(n) && newRecord(l)) lays[n] = l;
    scan(prefix, msgs, lays, exempt, allFw, enums);
    // base entries it keeps whose fields name an enum it replaces: their values change with it
    for (const e of Object.keys(d.enums ?? {})) {
      for (const [kind, entry, f, l] of fieldsNaming(e)) {
        // scanned above already (its own entries and the base ones it rechecks), or never sent as is
        if (has(kind === "layout" ? lays : msgs, entry) || (kind === "layout" && exempt.has(entry))) continue;
        // a field the base already fails on is reported once, as the base's
        if (fits(f, l, p.layouts, baseEnums)) fieldIssue(`${prefix}${kind} ${entry}`, f, l, allFw, enums);
      }
    }
  }
  return out.slice(0, MAX_ISSUES);
}

/**
 * A packed tail read with a layout: the layout is a shared one with no tail of its own and no choice, that fits the
 * tail's maxLength, and none of its fields has the name of a field of the layout around it (their values share one
 * record).
 */
function packedLayoutIssues(p: ProtocolShape): string[] {
  const out: string[] = [];
  const scan = (prefix: string, msgs: Record<string, Message>, lays: Record<string, Layout>, all: Record<string, Layout>) => {
    const outer: [string, Layout][] = [
      ...Object.entries(lays).map(([n, l]): [string, Layout] => [`layout ${n}`, l]),
      ...Object.entries(msgs).flatMap(([n, m]): [string, Layout][] => (m.payload !== undefined && typeof m.payload !== "string" ? [[`message ${n}`, m.payload]] : [])),
    ];
    for (const [where, l] of outer) {
      const t = tailLayoutName(l);
      if (t === undefined || out.length >= MAX_ISSUES) continue;
      const w = `${prefix}${where}: packed ${l.packed!.name}`;
      if (!has(all, t)) {
        out.push(`${w}: no layout "${t}"`);
        continue;
      }
      if (all[t].packed) out.push(`${w}: layout "${t}" has a packed tail of its own`);
      // the codec settles choices on the layout's own fields only, so one in a tail would go out in the map's byte order
      if (all[t].fields.some(isChoiceField)) out.push(`${w}: layout "${t}" has a field with a choice, which a packed tail does not settle`);
      // enumBy reads by the message's own layout, so one in a tail would read and take numbers only
      if (all[t].fields.some((f) => f.type !== "bytes" && f.type !== "string" && f.type !== "pad" && f.enumBy)) out.push(`${w}: layout "${t}" has a field with enumBy, which a packed tail does not read`);
      if (l.packed!.pieces !== undefined) {
        // with `layout` too (refused in packedIssues), t is not the record: its record checks would mislead
        if (l.packed!.layout === undefined) out.push(...recordIssues(w, l, l.packed!, t, all[t]));
        continue;
      }
      const need = all[t].minSize ?? openStringAt(all[t]) ?? layoutSize(all[t]);
      if (need > l.packed!.maxLength) out.push(`${w}: layout "${t}" needs ${need} bytes, more than maxLength ${l.packed!.maxLength}`);
      const mine = new Set(l.fields.map((f) => f.name));
      for (const f of all[t].fields) if (mine.has(f.name)) out.push(`${w}: field ${f.name} is in both this layout and "${t}"`);
    }
  };
  // an eightBit layout is never a message's payload; on a firmware, a message it adds or whose payload layout it replaces
  const eightBit = (prefix: string, msgs: Record<string, Message>, all: Record<string, Layout>, mine: (n: string, m: Message) => boolean) => {
    for (const [n, m] of Object.entries(msgs)) {
      if (!mine(n, m)) continue;
      if (typeof m.payload === "object" && m.payload.eightBit) out.push(`${prefix}message ${n}: an inline payload is not eightBit; name a shared layout`);
      if (typeof m.payload === "string" && has(all, m.payload) && all[m.payload].eightBit) out.push(`${prefix}message ${n}: layout "${m.payload}" is eightBit, never sent as it is`);
    }
  };
  eightBit("", p.messages, p.layouts, () => true);
  scan("", p.messages, p.layouts, p.layouts);
  // a firmware: its own entries, and the base ones whose tail layout it replaces
  for (const [fw, d] of Object.entries(p.firmwares ?? {})) {
    const all = { ...p.layouts, ...d.layouts };
    const replaced = (l: Layout | string | undefined) => {
      const t = typeof l === "object" ? tailLayoutName(l) : undefined;
      return t !== undefined && has(d.layouts ?? {}, t);
    };
    const fwMsgs = { ...p.messages, ...d.messages };
    const msgs = Object.fromEntries(Object.entries(fwMsgs).filter(([n, m]) => has(d.messages ?? {}, n) || replaced(m.payload)));
    const lays = Object.fromEntries(Object.entries(all).filter(([n, l]) => has(d.layouts ?? {}, n) || replaced(l)));
    scan(`firmware ${fw}: `, msgs, lays, all);
    eightBit(`firmware ${fw}: `, fwMsgs, all, (n, m) => has(d.messages ?? {}, n) || (typeof m.payload === "string" && has(d.layouts ?? {}, m.payload)));
  }
  return out.slice(0, MAX_ISSUES);
}

/** The offset of the last piece of a record of `size` bytes split into pieces of `max`. */
export const lastPieceAt = (size: number, max: number): number => Math.floor((size - 1) / max) * max;

/**
 * A record joined from tails: its layout has one fixed size, at most MAX_RECORD bytes (pieces fill it, so it is complete
 * when every byte is), and the offset field can hold the last piece's offset when the record is split at maxLength.
 */
function recordIssues(w: string, host: Layout, p: PackedTail, t: string, rec: Layout): string[] {
  const out: string[] = [];
  if (p.maxLength < 1) return [`${w}: a piece of a record holds at least 1 byte (maxLength)`];
  if (rec.minSize !== undefined || openStringAt(rec) !== undefined) out.push(`${w}: record "${t}" has no minSize or open string; it has one size`);
  const size = layoutSize(rec);
  if (rec.maxSize !== undefined && rec.maxSize !== size) out.push(`${w}: record "${t}" has maxSize ${rec.maxSize}, not its size ${size}`);
  if (size < 1 || size > MAX_RECORD) return [...out, `${w}: record "${t}" is ${size} bytes; 1 to ${MAX_RECORD} are joined`];
  const f = host.fields.find((x) => x.name === tailPieces(p)?.offsetField);
  const last = lastPieceAt(size, p.maxLength);
  if (plainCount(f) && rawMax(f) < last) out.push(`${w}: pieces offset field "${f.name}" cannot hold offset ${last}`);
  return out;
}

/**
 * A message sent without a checksum is one the device sends, on a framing that has a checksum to leave out, with a
 * fixed cmd that nothing else the device sends with a checksum shares: the framer skips the checksum for every incoming
 * message on that cmd. A request with no reply message of its own is answered on its own cmd, so it counts as incoming.
 */
function noChecksumIssues(p: ProtocolShape): string[] {
  const out: string[] = [];
  // each scan pairs every unchecked cmd with every placeholder pattern, once for the base and once per firmware
  const count = (msgs: Record<string, Message> | undefined) => Object.values(msgs ?? {}).filter((m) => m.noChecksum).length;
  const total = count(p.messages) + Object.values(p.firmwares ?? {}).reduce((n, d) => n + count(d.messages), 0);
  if (total > MAX_UNCHECKED) return [`at most ${MAX_UNCHECKED} noChecksum messages across the base and all firmwares, got ${total}`];
  const incoming = (m: Message) => m.dir === "reply" || m.dir === "notify";
  const answeredOn = (m: Message) => incoming(m) || (m.dir === "request" && m.reply?.message === undefined);
  const scan = (prefix: string, msgs: Record<string, Message> | undefined, view: Record<string, Message>) => {
    const unchecked = new Map<string, string>();
    for (const [n, m] of Object.entries(view)) if (m.noChecksum && incoming(m) && !m.cmd.includes("{")) unchecked.set(m.cmd.toLowerCase(), n);
    for (const [n, m] of Object.entries(msgs ?? {})) {
      if (!m.noChecksum) continue;
      if (p.transport.framing !== "sysex-xor") out.push(`${prefix}message ${n}: noChecksum needs a sysex-xor transport`);
      if (!incoming(m)) out.push(`${prefix}message ${n}: noChecksum is for a reply or notify, not a ${m.dir}`);
      if (m.cmd.includes("{")) out.push(`${prefix}message ${n}: noChecksum needs a fixed cmd`);
    }
    if (!unchecked.size) return;
    // a firmware reports only the clashes it brings, not the base map's again
    const own = (n: string) => Object.hasOwn(msgs ?? {}, n);
    const clash = (n: string, other: string) => {
      if (out.length < MAX_ISSUES && (own(n) || own(other))) out.push(`${prefix}message ${n}: shares its cmd with ${other}, which has noChecksum`);
    };
    // a templated cmd (a request answered on its own cmd) can still produce an unchecked cmd's bytes: templated cmds are
    // keyed with their placeholders as "*", and each unchecked cmd is looked up once per placeholder pattern
    const templated = new Map<string, string[]>();
    for (const [n, m] of Object.entries(view)) {
      if (m.noChecksum || !answeredOn(m)) continue;
      const cmd = m.cmd.toLowerCase();
      if (!cmd.includes("{")) {
        const other = unchecked.get(cmd);
        if (other) clash(n, other);
        continue;
      }
      const k = cmd.split(" ").map((t) => (t.startsWith("{") ? "*" : t)).join(" ");
      const names = templated.get(k);
      if (names) names.push(n);
      else templated.set(k, [n]);
    }
    const patterns = new Set([...templated.keys()].map((k) => k.split(" ").map((t) => (t === "*" ? "*" : "")).join(" ")));
    for (const [c, other] of unchecked) {
      for (const pattern of patterns) {
        const mask = pattern.split(" ");
        const k = c.split(" ").map((t, i) => mask[i] || t).join(" ");
        for (const n of templated.get(k) ?? []) clash(n, other);
      }
    }
  };
  scan("", p.messages, p.messages);
  for (const [fw, d] of Object.entries(p.firmwares ?? {})) if (d.messages) scan(`firmware ${fw}: `, d.messages, { ...p.messages, ...d.messages });
  return out.slice(0, MAX_ISSUES);
}

/**
 * A poll is a message the host side sends (a request or send) with a fixed cmd, answered (if at all) on a fixed cmd, so
 * the walk tools can match both. The walk tools leave out every message on a poll's cmd or its answer's, so nothing
 * else may share those cmds, and no other message may be answered (a list's start and end included) or acknowledged by a
 * poll's answer: that traffic would vanish from the decode and from act.py's count of an action's traffic.
 */
function pollIssues(p: ProtocolShape): string[] {
  const out: string[] = [];
  const scan = (prefix: string, msgs: Record<string, Message> | undefined, view: Record<string, Message>) => {
    for (const [n, m] of Object.entries(msgs ?? {})) {
      if (!m.poll || out.length >= MAX_ISSUES) continue;
      if (m.dir !== "request" && m.dir !== "send") out.push(`${prefix}message ${n}: poll is for a request or send, not a ${m.dir}`);
      if (m.cmd.includes("{")) out.push(`${prefix}message ${n}: poll needs a fixed cmd`);
      const answer = m.reply?.message;
      if (answer !== undefined && Object.hasOwn(view, answer) && view[answer].cmd.includes("{")) {
        out.push(`${prefix}message ${n}: poll needs an answer with a fixed cmd, and ${answer} has a templated one`);
      }
    }
  };
  // what the walk tools leave out in a view: its polls and their answers
  const quietIn = (view: Record<string, Message>) =>
    new Set(Object.keys(view).filter((n) => view[n].poll).flatMap((n) => [n, view[n].reply?.message ?? n]).filter((n) => Object.hasOwn(view, n)));
  // the base and each firmware as the codec sees it, with what the firmware itself says
  const views: [string, Record<string, Message>, Record<string, Message>][] = [["", p.messages, p.messages]];
  for (const [fw, d] of Object.entries(p.firmwares ?? {})) if (d.messages) views.push([`firmware ${fw}: `, d.messages, { ...p.messages, ...d.messages }]);
  for (const [prefix, own, view] of views) scan(prefix, own, view);
  // the quiet filter is built without the walk's firmware, so it hides every firmware's poll cmds in every walk
  // (a message that is a poll or a poll's answer in some firmware, on the same cmd, is one the walk leaves out on purpose)
  const hidden = new Map<string, string>();
  const quietAnywhere = new Set<string>();
  for (const [prefix, , view] of views) {
    for (const q of quietIn(view)) {
      const cmd = view[q].cmd.toLowerCase();
      quietAnywhere.add(`${q} ${cmd}`);
      if (!hidden.has(cmd)) hidden.set(cmd, prefix ? `${q} (${prefix.slice(0, -2)})` : q);
    }
  }
  if (!hidden.size) return out.slice(0, MAX_ISSUES);
  // anything else a view's messages would lose with them
  const shared = (view: Record<string, Message>): string[] => {
    const quiet = quietIn(view);
    const issues: string[] = [];
    for (const [n, m] of Object.entries(view)) {
      if (quiet.has(n) || issues.length >= MAX_ISSUES) continue;
      const twin = quietAnywhere.has(`${n} ${m.cmd.toLowerCase()}`) ? undefined : [...hidden].find(([c]) => cmdsOverlap(c, m.cmd.toLowerCase()))?.[1];
      const by = [m.reply?.message, m.reply?.list?.start, m.reply?.list?.end, m.ack?.message].find((a) => a !== undefined && quiet.has(a));
      if (twin !== undefined) issues.push(`message ${n}: shares its cmd with ${twin}, which the walk tools leave out as a poll or a poll's answer`);
      else if (by !== undefined) issues.push(`message ${n}: is answered by ${by}, which the walk tools leave out as a poll or a poll's answer`);
    }
    return issues;
  };
  const base = shared(p.messages);
  out.push(...base);
  // a firmware only adds what the base doesn't already say
  for (const [prefix, , view] of views.slice(1)) for (const issue of shared(view)) if (!base.includes(issue)) out.push(`${prefix}${issue}`);
  return out.slice(0, MAX_ISSUES);
}

/** A message's payload layout in the map as loaded (before the codec), or undefined where it names a missing layout. */
const messageLayout = (m: Message, layouts: Record<string, Layout>): Layout | undefined =>
  m.payload === undefined ? { fields: [] } : typeof m.payload === "string" ? (has(layouts, m.payload) ? layouts[m.payload] : undefined) : m.payload;

/** A single scalar field (no repeat, not bytes, string or padding): one number, as an offset or a size must be. */
const isSingleScalar = (f: Field | undefined): boolean => f !== undefined && f.type !== "bytes" && f.type !== "string" && f.type !== "pad" && !f.repeat;

/**
 * An answer in pieces is a request's, on a param-change map, joined by address only on roland-address, and names
 * fields, a constant and a layout the map has: an offset that is one number in a reply of fixed size (a message of its
 * own, not the request), a size that is
 * one number in the request, and (by an offset field) the layout the joined value is read with. Without a size, that
 * layout must have one. Each firmware's view is checked too.
 */
function piecesIssues(p: ProtocolShape): string[] {
  const scan = (view: Record<string, Message>, layouts: Record<string, Layout>, constants: Record<string, number>): string[] => {
    const out: string[] = [];
    const layoutOf = (n: string): Layout | undefined => (has(view, n) ? messageLayout(view[n], layouts) : undefined);
    const fieldOf = (n: string, f: string) => layoutOf(n)?.fields.find((x) => x.name === f);
    for (const [n, m] of Object.entries(view)) {
      const pieces = m.reply?.pieces;
      if (!pieces || out.length >= MAX_ISSUES) continue;
      const where = `message ${n}: reply pieces`;
      const reply = m.reply?.message ?? n;
      if (m.dir !== "request") out.push(`${where}: only a request's answer comes in pieces, not a ${m.dir}'s`);
      // a request heard back (a MIDI thru) would read as a piece of its own answer
      if (reply === n) out.push(`${where}: the pieces must come in a reply message of their own, not the request's`);
      // only the param-change driver joins pieces; another would read the first piece as the whole answer
      if (p.driver !== "param-change") out.push(`${where}: only the param-change driver joins an answer in pieces`);
      if (pieces.offset === "address") {
        if (p.transport.framing !== "roland-address") out.push(`${where}: offset "address" needs a roland-address transport`);
        if (pieces.layout !== undefined) out.push(`${where}: by address the pieces are slices of the reply, read with its own layout: layout goes with an offset field`);
        if (pieces.step !== undefined && pieces.maxPiece !== undefined && pieces.step > pieces.maxPiece) out.push(`${where}: step ${pieces.step} is over maxPiece ${pieces.maxPiece}`);
      } else if (pieces.step !== undefined) {
        out.push(`${where}: step goes with offset "address": by an offset field each piece says where it goes`);
      } else if (!isSingleScalar(fieldOf(reply, pieces.offset.field))) {
        out.push(`${where}: offset field "${pieces.offset.field}" must be a single number in "${reply}"`);
      } else {
        // each piece's bytes follow the reply's layout: it must end at a fixed byte and take a longer payload
        const r = layoutOf(reply);
        if (r && (r.minSize !== undefined || r.maxSize !== undefined || openStringAt(r) !== undefined)) out.push(`${where}: "${reply}" must have a fixed size, with no minSize, maxSize or open string, since each piece's bytes follow it`);
      }
      const size = pieces.size;
      if (typeof size === "object" && "request" in size && !isSingleScalar(fieldOf(n, size.request))) {
        out.push(`${where}: size field "${size.request}" must be a single number in "${n}"`);
      }
      if (typeof size === "object" && "constant" in size && !has(constants, size.constant)) out.push(`${where}: no constant "${size.constant}"`);
      if (pieces.layout !== undefined && !has(layouts, pieces.layout)) out.push(`${where}: no layout "${pieces.layout}"`);
      // by an offset field the reply's layout is each piece's head, not the joined value: that needs a layout of its own
      if (pieces.offset !== "address" && pieces.layout === undefined) out.push(`${where}: an offset field needs a layout to read the joined value with`);
      const joined = pieces.layout === undefined ? layoutOf(reply) : has(layouts, pieces.layout) ? layouts[pieces.layout] : undefined;
      // a layout that may run longer or shorter (minSize, maxSize, an open string) gives no size to join to
      const unsized = (l: Layout) => layoutSize(l) === 0 || l.minSize !== undefined || l.maxSize !== undefined || openStringAt(l) !== undefined;
      if (size === undefined && joined && unsized(joined)) out.push(`${where}: needs a size, since the layout it is read with has no fixed one`);
    }
    return out;
  };
  const base = scan(p.messages, p.layouts, p.constants ?? {});
  const out = [...base];
  // each firmware as the codec will see it, since it may replace a reply, layout or constant a base request's pieces
  // name; a base problem is reported once, not again for every firmware
  for (const [fw, d] of Object.entries(p.firmwares ?? {})) {
    if (out.length >= MAX_ISSUES) break;
    const issues = scan({ ...p.messages, ...d.messages }, { ...p.layouts, ...d.layouts }, { ...p.constants, ...d.constants });
    for (const issue of issues) if (!base.includes(issue)) out.push(`firmware ${fw}: ${issue}`);
  }
  return out.slice(0, MAX_ISSUES);
}

/**
 * Parameter tables name real blocks or effect types, each in one table only, and say enough to set each parameter: ids
 * unique in a table, ranges with both ends, switches with their options, knob travel within `knobMax`, and defaults
 * each parameter can take. A select may leave its options out (the device names them in its labels); it is then set
 * by number.
 */
function parametersIssues(p: ProtocolShape): string[] {
  const out: string[] = [];
  const P = p.parameters;
  if (!P) return out;
  const blocks = p.enums?.block;
  if (!blocks) out.push("parameters: need the block enum");
  const types = p.enums?.type;
  const groups = Object.values(P.groups);
  if (!types && groups.some((g) => g.types)) out.push("parameters: tables keyed by effect type need the type enum");
  // the block and type enums as each firmware has them: a table may name a block or type only some firmwares have
  const views = [
    { prefix: "", block: blocks, type: types },
    ...Object.entries(p.firmwares ?? {})
      .filter(([, d]) => d.enums?.block || d.enums?.type)
      .map(([fw, d]) => ({ prefix: `firmware ${fw}: `, block: d.enums?.block ?? blocks, type: d.enums?.type ?? types })),
  ];
  // a type's parameters are checked under its key, as a block's are under its own: one name for both would share them
  if (groups.some((g) => g.types)) {
    // a clash the base has is reported once, not again for every firmware; each firmware's own clash is its own
    const baseClashes = new Set<string>();
    for (const v of views) {
      if (!v.type || !v.block) continue;
      for (const k of Object.keys(v.type)) {
        if (!has(v.block, k) || (v !== views[0] && baseClashes.has(k))) continue;
        if (v === views[0]) baseClashes.add(k);
        out.push(`${v.prefix}parameters: "${k}" is both a block and an effect type; give them different keys`);
      }
    }
  }
  // a block or type has one table in each mode: the groups as each mode sees them (a stand-in only under the name it
  // stands in for) are checked apart, so a mode's group may list what another mode's lists
  const modeViews: [string, Parameters["groups"]][] = [["", groupsInMode(p, {})]];
  for (const [mode, use] of Object.entries(p.modes?.use ?? {})) if (use.groups) modeViews.push([`mode ${mode}: `, groupsInMode(p, use)]);
  // (crossCheck collects issues in a set, so one a view repeats is reported once)
  for (const [where, view] of modeViews) {
    const owner = new Map<string, string>();
    for (const [g, group] of Object.entries(view)) {
      for (const [kind, k] of [...(group.blocks ?? []).map((k) => ["block", k] as const), ...(group.types ?? []).map((k) => ["type", k] as const)]) {
        const first = owner.get(`${kind}:${k}`);
        if (first === undefined) owner.set(`${kind}:${k}`, g);
        else out.push(`${where}parameters.${g}: ${kind} "${k}" is already in ${first}`);
      }
    }
  }
  // a group's blocks and types are keys of the enums of the mode it is used in (a stand-in group only in its mode), on
  // the base map or on some firmware: a table may name a block or type only some firmwares have, but each key must be
  // one that some firmware has in that mode
  const fwEnums = [p.enums ?? {}, ...Object.values(p.firmwares ?? {}).flatMap((d) => (d.enums ? [{ ...p.enums, ...d.enums }] : []))];
  const anyFirmware = fwEnums.length > 1 ? " on any firmware" : "";
  const enumViews: [string, Parameters["groups"], Record<string, Record<string, number>>[]][] = [["", groupsInMode(p, {}), fwEnums]];
  for (const [mode, use] of Object.entries(p.modes?.use ?? {})) {
    if (use.groups || use.enums) enumViews.push([`mode ${mode}: `, groupsInMode(p, use), fwEnums.map((e) => inMode(e, use.enums))]);
  }
  for (const [where, view, enumsByFirmware] of enumViews) {
    // the keys each kind has on some firmware in this mode, gathered once rather than searched per table key
    const keysOf = (kind: "block" | "type") => {
      const withKind = enumsByFirmware.filter((e) => has(e, kind));
      return withKind.length ? new Set(withKind.flatMap((e) => Object.keys(e[kind]))) : undefined;
    };
    const known = { block: keysOf("block"), type: keysOf("type") };
    for (const [g, group] of Object.entries(view)) {
      const keys = [...(group.blocks ?? []).map((k) => ["block", k] as const), ...(group.types ?? []).map((k) => ["type", k] as const)];
      for (const [kind, k] of keys) if (known[kind] && !known[kind].has(k)) out.push(`${where}parameters.${g}: "${k}" is not a key of the ${kind} enum${anyFirmware}`);
    }
  }
  for (const [g, group] of Object.entries(P.groups)) {
    if (!group.blocks && !group.types) out.push(`parameters.${g}: needs blocks or types`);
    if (group.blocks && group.types) out.push(`parameters.${g}: has both blocks and types; give one`);
    const ids = new Map<number, string>();
    for (const [n, x] of Object.entries(group.params)) {
      const where = `parameters.${g}.${n}`;
      const twin = ids.get(x.id);
      if (twin !== undefined) out.push(`${where}: id ${x.id} is already ${twin}`);
      else ids.set(x.id, n);
      if (x.min !== undefined && x.max !== undefined && x.min > x.max) out.push(`${where}: min ${x.min} > max ${x.max}`);
      const hasOptions = x.options !== undefined && Object.keys(x.options).length > 0;
      if (x.kind === "range" && (x.min === undefined || x.max === undefined)) out.push(`${where}: a range needs min and max`);
      if (x.kind === "switch" && !hasOptions) out.push(`${where}: a switch needs options`);
      if (x.options !== undefined && x.kind !== "select" && x.kind !== "switch") out.push(`${where}: options go with a select or switch`);
      if ((x.kind === "knob" || x.kind === "slider") && x.max !== undefined && (x.max < 1 || x.max > P.knobMax)) out.push(`${where}: max ${x.max} is outside 1..knobMax ${P.knobMax}`);
      const fault = x.default === undefined ? undefined : defaultFault(x, x.default, P.knobMax);
      if (fault) out.push(`${where}: default ${x.default} ${fault}`);
      if (out.length >= MAX_ISSUES) return out;
    }
    out.push(...linkedIssues(g, group.params, group.linked ?? {}, P.knobMax));
    if (out.length >= MAX_ISSUES) return out;
  }
  return out;
}

/**
 * Linked sets name parameters of their own table, each at most once and in one set only; a rule's run is a run of
 * its set's parameters in the set's order; `repeatable` goes with a distinct rule and names values its parameters can
 * take.
 */
function linkedIssues(g: string, params: Record<string, Parameter>, linked: Record<string, LinkedSetDef>, knobMax: number): string[] {
  const out: string[] = [];
  const inSet = new Map<string, string>();
  for (const [n, set] of Object.entries(linked)) {
    const where = `parameters.${g}.linked.${n}`;
    for (const p of set.params) {
      if (!has(params, p)) out.push(`${where}: "${p}" is not a parameter of this table`);
      const first = inSet.get(p);
      if (first !== undefined) out.push(`${where}: "${p}" is already in ${first === n ? "this set" : `linked.${first}`}`);
      else inSet.set(p, n);
    }
    for (const [i, r] of (set.rules ?? []).entries()) {
      const run = r.params ?? set.params;
      const at = set.params.indexOf(run[0]);
      if (at < 0 || run.some((p, j) => set.params[at + j] !== p)) out.push(`${where}.rules.${i}: its params must be a run of the set's, in the set's order`);
      if (r.kind === "distinct") {
        for (const v of r.repeatable ?? []) {
          if (!run.some((p) => has(params, p) && !defaultFault(params[p], v, knobMax))) out.push(`${where}.rules.${i}: repeatable ${v} is a value none of its parameters takes`);
        }
      }
    }
  }
  return out;
}

/**
 * Modes: the read is a request whose reply carries the field, reading an enum whose keys are the modes; each mode `use`
 * lists is one of them. A stand-in and the name it stands in for are both the map's own (base) entries of that kind, a
 * message stands in only for one in the same direction, and no name both stands in and is stood in for. What is read
 * before the mode is known (the read, its reply, the mode enum, and the on-connect steps with their replies) is the
 * same in every mode, and the read is never blocked. A block on the map's own message holds in every mode, even one
 * that stands an unblocked entry in for it. No group a mode stands in for, nor its stand-in, has linked sets.
 */
function modesIssues(p: ProtocolShape): string[] {
  const out: string[] = [];
  const M = p.modes;
  if (!M) return out;
  const read = M.read;
  if (!has(p.messages, read.message)) return [`modes.read: "${read.message}" is not a message`];
  const request = p.messages[read.message];
  if (request.dir !== "request") out.push(`modes.read: "${read.message}" must be a request, not a ${request.dir}`);
  // every tool call starts by reading the mode, so blocking the read would refuse them all
  if (p.blocked?.includes(read.message)) out.push(`modes.read: "${read.message}" is blocked, and every tool call reads the mode first`);
  for (const [fw, d] of Object.entries(p.firmwares ?? {})) {
    if (d.blocked?.includes(read.message)) out.push(`modes.read: "${read.message}" is blocked on firmware ${fw}, and every tool call reads the mode first`);
  }
  const { reply, field } = modeReadField(p)!;
  const e = modeEnum(p);
  if (!field) out.push(`modes.read: the reply "${reply}" has no field "${read.field}"`);
  else if (e === undefined) out.push(`modes.read: the reply's field "${read.field}" must read an enum (its keys are the modes)`);
  else if (!p.enums || !has(p.enums, e)) out.push(`modes.read: no enum "${e}"`);
  const modes = e !== undefined && p.enums && has(p.enums, e) ? p.enums[e] : undefined;
  const tables: Record<ModeKind, Record<string, unknown>> = {
    messages: p.messages,
    layouts: p.layouts,
    enums: p.enums ?? {},
    constants: p.constants ?? {},
    groups: p.parameters?.groups ?? {},
  };
  // read before the mode is known, so the same in every mode
  // (the request's and the reply's named payload layouts too: the reply is decoded in the mode the unit was last seen in)
  // (and the on-connect steps with all that answers them, their layouts and the enums those read: they go out with
  // the map's own entries, before the mode is read)
  const steps = (p.session?.onConnect ?? []).flatMap((s) => (s.message !== undefined && has(p.messages, s.message) ? [s.message] : []));
  const answers = (m: Message) => [m.reply?.message, m.reply?.list?.start, m.reply?.list?.end, m.ack?.message].flatMap((a) => (a === undefined ? [] : [a]));
  const stepMessages = [...steps, ...steps.flatMap((m) => answers(p.messages[m]))].filter((m) => has(p.messages, m));
  const stepLayouts = steps.flatMap((m) => p.messages[m].reply?.pieces?.layout ?? []);
  const stepEnums = [...stepMessages.map((m) => messageLayout(p.messages[m], p.layouts)), ...stepLayouts.map((l) => (has(p.layouts, l) ? p.layouts[l] : undefined))]
    .flatMap((l) => l?.fields ?? [])
    .flatMap((f) => ("enum" in f && typeof f.enum === "string" ? [f.enum] : []));
  const early = [read.message, reply, ...stepMessages];
  const named = early.flatMap((m) => (has(p.messages, m) && typeof p.messages[m].payload === "string" ? [p.messages[m].payload as string] : []));
  const fixed: Partial<Record<ModeKind, string[]>> = { messages: early, layouts: [...named, ...stepLayouts], enums: [...(e === undefined ? [] : [e]), ...stepEnums] };
  for (const kind of MODE_KINDS) {
    const standing = standIns(p, kind);
    for (const [mode, u] of Object.entries(M.use)) {
      const where = `modes.use.${mode}.${kind}`;
      for (const [n, sub] of Object.entries(u[kind] ?? {})) {
        if (!has(tables[kind], n)) out.push(`${where}: "${n}" is not one of the map's ${kind}`);
        if (sub !== null && !has(tables[kind], sub)) out.push(`${where}: "${sub}" (for "${n}") is not one of the map's ${kind}`);
        if (sub === n) out.push(`${where}: "${n}" stands in for itself`);
        if (standing.has(n)) out.push(`${where}: "${n}" stands in for another entry in some mode, so it can't be stood in for`);
        for (const x of [n, sub]) if (x !== null && fixed[kind]?.includes(x)) out.push(`${where}: "${x}" is read before the mode is known, so it is the same in every mode`);
        if (kind === "messages" && sub !== null && has(p.messages, n) && has(p.messages, sub) && p.messages[n].dir !== p.messages[sub].dir) {
          out.push(`${where}: "${sub}" is a ${p.messages[sub].dir} and can't stand in for the ${p.messages[n].dir} "${n}"`);
        }
      }
    }
  }
  // linked sets are read from the map's own groups (linked-params.ts), not as a mode sees them: a group a mode
  // replaces, or one that stands in for another, would take or drop its sets unseen, so neither may carry any
  const groups = p.parameters?.groups ?? {};
  for (const [mode, u] of Object.entries(M.use)) {
    for (const [n, sub] of Object.entries(u.groups ?? {})) {
      for (const g of [n, sub]) {
        if (g !== null && has(groups, g) && Object.keys(groups[g].linked ?? {}).length) {
          out.push(`modes.use.${mode}.groups: "${g}" has linked sets, which are read from the map's own groups only, so a mode can't stand a group in for it or for one it stands in for`);
        }
      }
    }
  }
  // a firmware's enum replaces the map's own by name, and a mode then reads some names as its stand-ins: a firmware that
  // replaces a name a mode stands in, but not the stand-in, would not apply in that mode, and nothing would say so
  for (const [fw, d] of Object.entries(p.firmwares ?? {})) {
    for (const [mode, u] of Object.entries(M.use)) {
      for (const [n, sub] of Object.entries(u.enums ?? {})) {
        if (sub === null || !has(d.enums ?? {}, n) || has(d.enums ?? {}, sub)) continue;
        out.push(
          `firmware ${fw}: replaces enum "${n}", which mode ${mode} reads as "${sub}"; the firmware keeps the map's own "${sub}", so its "${n}" would not apply in that mode: give "${sub}" on the firmware too`,
        );
      }
    }
  }
  if (modes) for (const mode of Object.keys(M.use)) if (!has(modes, mode)) out.push(`modes.use: "${mode}" is not a key of the ${e} enum (the modes)`);
  return out.slice(0, MAX_ISSUES);
}

/** Why a raw value (a parameter's default, a linked set's repeatable value) is not one it can take, or undefined when it is one. */
function defaultFault(x: z.infer<typeof ParameterSchema>, d: number, knobMax: number): string | undefined {
  if (x.options && Object.keys(x.options).length) return has(x.options, String(d)) ? undefined : "is not one of its options";
  // a range without both ends is reported on its own
  const min = x.min ?? 0;
  const max = x.max ?? (x.kind === "knob" || x.kind === "slider" ? knobMax : undefined);
  if (d < min || (max !== undefined && d > max)) return `is outside ${min}..${max ?? "its last"}`;
  if (x.kind === "range" && (d - min) % (x.step ?? 1) !== 0) return `is not on its step of ${x.step}`;
  return undefined;
}

/**
 * On-connect steps send base messages the host sends (a request or send), never one the map blocks or redefines on any
 * firmware (they go out before the firmware is known), with values only for fields their payload has, and no field
 * naming a choice (settling it would ask the unit, which answers nothing until the steps have gone out).
 */
function connectIssues(p: ProtocolShape): string[] {
  const out: string[] = [];
  for (const [i, { message: n, values }] of (p.session?.onConnect ?? []).entries()) {
    if (n === undefined) continue;
    const where = `session.onConnect[${i}]`;
    const m = has(p.messages, n) ? p.messages[n] : undefined;
    if (!m) {
      out.push(`${where}: unknown message "${n}"`);
      continue;
    }
    if (m.dir !== "request" && m.dir !== "send") out.push(`${where}: ${n} is a ${m.dir}; the host sends a request or send`);
    // a control-only unit answers nothing (its driver reads no reply), so a request would never be answered
    else if (m.dir === "request" && p.driver === "control-only") out.push(`${where}: ${n} is a request, and a control-only unit answers nothing: a step only sends`);
    // the control-only driver frames a step as one SysEx message, which a nibble transport's chunked frames are not
    if (p.driver === "control-only" && p.transport.framing === "sysex-nibbles") out.push(`${where}: a control-only map sends a step on a sysex-xor, sysex-plain or roland-address transport, not sysex-nibbles`);
    const fw = Object.entries(p.firmwares ?? {}).find(([, d]) => d.blocked?.includes(n))?.[0];
    const blocker = p.blocked?.includes(n) ? "the base map" : fw !== undefined ? `firmware ${fw}` : undefined;
    if (blocker) out.push(`${where}: ${n} is blocked on ${blocker}, and steps go out before the firmware is known`);
    // the firmware is not known yet, so a firmware's own definition of a step would never be the one sent
    const named = typeof m.payload === "string" ? m.payload : undefined;
    for (const [v, d] of Object.entries(p.firmwares ?? {})) {
      const what = d.messages && has(d.messages, n) ? n : named !== undefined && d.layouts && has(d.layouts, named) ? `${n}'s layout ${named}` : undefined;
      if (what) {
        out.push(`${where}: firmware ${v} redefines ${what}, and steps go out before the firmware is known`);
        break;
      }
    }
    // a layout the map lacks is reported on its own
    const layout = messageLayout(m, p.layouts);
    const fields = new Set(layout?.fields.map((f) => f.name));
    if (layout) for (const k of Object.keys(values ?? {})) if (!fields.has(k)) out.push(`${where}: ${n} has no payload field "${k}"`);
    // settling a choice means asking the unit, which answers nothing until the steps have gone out
    const open = layout?.fields.find(isChoiceField);
    if (open) out.push(`${where}: ${n}'s field ${open.name} names choice "${open.choice}", which can't be settled before the steps`);
  }
  return out;
}

type ChoiceField = ScalarField & { choice: string };

const isChoiceField = (f: Layout["fields"][number]): f is ChoiceField =>
  f.type !== "bytes" && f.type !== "string" && f.type !== "pad" && f.choice !== undefined;

/**
 * Choices: every field that names one names a choice the map has, is a single scalar of more than one byte (its
 * encoding is what is in doubt, so it does not set it itself), and sits in a layout using at most two choices. Every
 * choice has two options or more and can be settled: some field naming it sits in a message the device sends, with a
 * range or an enum to tell the options apart. A `readBy` is a request whose reply carries such a field.
 */
function choicesIssues(p: ProtocolShape): string[] {
  const out: string[] = [];
  const choices = p.choices ?? {};
  // per choice: whether a field the device sends can settle it, and the replies that carry such a field
  const settles = new Map<string, Set<string>>();
  // a named layout's issues are reported once, as the layout's; a message using it only records what it settles
  const check = (where: string, l: Layout, sentBy?: string, report = true) => {
    const issues: string[] = [];
    const used = new Set<string>();
    for (const f of l.fields) {
      if (!isChoiceField(f)) continue;
      const fw = `${where}: field ${f.name}`;
      used.add(f.choice);
      if (!has(choices, f.choice)) {
        issues.push(`${fw}: unknown choice "${f.choice}"`);
        continue;
      }
      if (f.endian !== undefined) issues.push(`${fw}: a field with a choice takes its endian from the choice`);
      if (f.repeat !== undefined) issues.push(`${fw}: a field with a choice cannot repeat`);
      if (f.bits !== undefined || f.checksum !== undefined) issues.push(`${fw}: a field with a choice has no bits or checksum`);
      if (elementSize(f) < 2) issues.push(`${fw}: a choice of byte order needs a field of two bytes or more`);
      if (sentBy !== undefined && (f.min !== undefined || f.max !== undefined || f.enum !== undefined)) {
        let by = settles.get(f.choice);
        if (!by) settles.set(f.choice, (by = new Set()));
        by.add(sentBy);
      }
    }
    if (used.size > MAX_CHOICES_PER_LAYOUT) issues.push(`${where}: at most ${MAX_CHOICES_PER_LAYOUT} choices in one layout`);
    if (report) out.push(...issues);
  };
  // a firmware is checked for what it adds or replaces, its messages' named layouts looked up as the codec will
  const scan = (prefix: string, msgs: Record<string, Message>, own: Record<string, Layout>, lays: Record<string, Layout>) => {
    for (const [n, l] of Object.entries(own)) check(`${prefix}layout ${n}`, l);
    for (const [n, m] of Object.entries(msgs)) {
      // a request with no reply rule is answered by the same message
      const incoming = m.dir === "reply" || m.dir === "notify" || (m.dir === "request" && m.reply === undefined);
      if (typeof m.payload !== "string") {
        if (m.payload !== undefined) check(`${prefix}message ${n}`, m.payload, incoming ? n : undefined);
      } else if (incoming && has(lays, m.payload)) check(`${prefix}message ${n}`, lays[m.payload], n, false);
    }
  };
  scan("", p.messages, p.layouts, p.layouts);
  for (const [fw, d] of Object.entries(p.firmwares ?? {})) scan(`firmware ${fw}: `, d.messages ?? {}, d.layouts ?? {}, { ...p.layouts, ...d.layouts });
  for (const [c, choice] of Object.entries(choices)) {
    const where = `choices.${c}`;
    if (Object.keys(choice.options).length < 2) out.push(`${where}: needs two options or more`);
    const by = settles.get(c);
    if (!by) out.push(`${where}: no field the device sends names it with a range or an enum, so the unit could never settle it`);
    if (choice.readBy !== undefined) {
      const m = has(p.messages, choice.readBy) ? p.messages[choice.readBy] : undefined;
      if (!m || m.dir !== "request") out.push(`${where}: readBy "${choice.readBy}" is not a request`);
      else if (!by?.has(m.reply?.message ?? choice.readBy)) out.push(`${where}: the reply to readBy "${choice.readBy}" does not carry a field that settles it`);
    }
  }
  return [...new Set(out)].slice(0, MAX_ISSUES);
}

/**
 * Firmware ranges: each runs from before where it ends, and no version falls in two entries' ranges, so a version
 * reads one entry. An entry keyed by exactly a version still wins over a range that holds it.
 */
function firmwareRangeIssues(p: ProtocolShape): string[] {
  const out: string[] = [];
  // two keys that are one version written two ways ("4.0" and "4.00") would leave that version two entries
  const byVersion = new Map<string, string>();
  for (const fw of Object.keys(p.firmwares ?? {})) {
    const v = versionParts(fw);
    if (!v) continue;
    const norm = v.join(".").replace(/(\.0)+$/, "");
    const twin = byVersion.get(norm);
    if (twin !== undefined) out.push(`firmware ${fw}: is the same version as firmware ${twin}; a version must read one entry`);
    else byVersion.set(norm, fw);
  }
  const ranged = Object.entries(p.firmwares ?? {}).filter(([, d]) => d.range !== undefined);
  for (const [fw, d] of ranged) {
    const { from, below } = d.range!;
    if (from !== undefined && below !== undefined && compareVersions(versionParts(from)!, versionParts(below)!) >= 0) {
      out.push(`firmware ${fw}: range.from ${from} must be before range.below ${below}`);
    }
  }
  for (let i = 0; i < ranged.length; i++) {
    for (let j = i + 1; j < ranged.length; j++) {
      if (rangesOverlap(ranged[i][1].range!, ranged[j][1].range!)) out.push(`firmware ${ranged[j][0]}: its range overlaps firmware ${ranged[i][0]}'s; a version must read one entry`);
    }
  }
  return out.slice(0, MAX_ISSUES);
}

function crossCheck(p: ProtocolShape): string[] {
  const floor: string[] = [];
  for (const [fw, d] of Object.entries(p.firmwares ?? {})) {
    const scenes = d.safety?.modelChangeScenes;
    if (d.safety && !p.safety) floor.push(`firmware ${fw}: safety rules need the base safety section`);
    else if (scenes && !scenes.every((sc) => p.safety!.modelChange.scenes.includes(sc))) {
      floor.push(`firmware ${fw}: safety may only narrow the scenes for model changes, never add one`);
    }
  }
  // models are put in in the reference scene (a build, a rebuild), so it must be one model changes are allowed in, on
  // every firmware
  if (p.safety) {
    const check = (where: string, ref: number | undefined, scenes: number[]) => {
      if (ref !== undefined && !scenes.includes(ref)) floor.push(`${where}constants.referenceScene ${ref} is not one of the scenes model changes are allowed in`);
    };
    const baseRef = p.constants?.referenceScene;
    check("", baseRef, p.safety.modelChange.scenes);
    for (const [fw, d] of Object.entries(p.firmwares ?? {})) {
      const ref = d.constants?.referenceScene ?? baseRef;
      const scenes = d.safety?.modelChangeScenes ?? p.safety.modelChange.scenes;
      if (ref !== baseRef || d.safety?.modelChangeScenes) check(`firmware ${fw}: `, ref, scenes);
    }
  }
  // a device with scenes tells the player which one by the map's words: a patch-dump unit always has scenes
  const patchDump = (p.driver ?? "patch-dump") === "patch-dump";
  const scened = patchDump || p.constants?.scenes !== undefined || Object.values(p.firmwares ?? {}).some((d) => d.constants?.scenes !== undefined);
  if (p.display && scened) {
    for (const k of ["defaultSceneName", "sceneLabel"] as const) if (p.display[k] === undefined) floor.push(`display.${k}: needed on a device with scenes`);
  }
  // the patch-dump driver lays blocks out in the screen's rows and names free patch slots
  if (p.display && patchDump) {
    for (const k of ["rows", "emptyPatchName"] as const) if (p.display[k] === undefined) floor.push(`display.${k}: needed on a patch-dump device`);
  }
  const law = p.audio?.volumeLaw;
  if (law && !(law.min <= law.quietest && law.quietest <= law.max && law.min < law.max)) floor.push("audio.volumeLaw: needs min <= quietest <= max, min < max");
  // blocks the base keeps always on stay always on: a firmware's noBypass may add blocks, never drop one
  // (the first dropped block per firmware, so a long base list can't multiply into one issue per key per firmware)
  const alwaysOn = Object.keys(p.enums?.noBypass ?? {});
  for (const [fw, d] of Object.entries(p.firmwares ?? {})) {
    const own = d.enums?.noBypass;
    const dropped = own ? alwaysOn.find((k) => !has(own, k)) : undefined;
    if (dropped !== undefined) floor.push(`firmware ${fw}: enums.noBypass drops "${dropped}"; a firmware may only add blocks that can't be bypassed`);
  }
  if (p.audio && p.enums) {
    const sources: [string, Record<string, number> | undefined][] = [["", p.enums.inputSource], ...Object.entries(p.firmwares ?? {}).filter(([, d]) => d.enums?.inputSource).map(([fw, d]): [string, Record<string, number> | undefined] => [`firmware ${fw}: `, d.enums!.inputSource])];
    for (const [prefix, src] of sources) {
      for (const k of [p.audio.reamp.source, p.audio.reamp.liveSource]) if (!has(src ?? {}, k)) floor.push(`${prefix}audio.reamp: "${k}" is not an inputSource key`);
    }
  }
  const r = p.audio?.reamp;
  if (r) {
    // the audio helper's own rules: USB Out 1/2 is never a send, and every channel is one the interface has
    if (r.send < 3 || r.send > r.channels) floor.push(`audio.reamp: send ${r.send} must be a USB output 3-${r.channels}`);
    for (const n of ["wet", "di"]) if (!has(r.inputs, n)) floor.push(`audio.reamp: inputs need "${n}"`);
    for (const [n, i] of Object.entries(r.inputs)) if (i > r.channels) floor.push(`audio.reamp: input ${n} is ${i}, past the ${r.channels} channels`);
    // the bypass outputs carry finished audio past the chain: never the send into it, each once, all on the interface
    const bypass = r.bypassOutputs ?? [];
    if (bypass.includes(r.send)) floor.push(`audio.reamp: bypassOutputs can't include the send (${r.send}), which feeds the chain`);
    if (new Set(bypass).size !== bypass.length) floor.push("audio.reamp: bypassOutputs lists an output twice");
    for (const o of bypass) if (o > r.channels) floor.push(`audio.reamp: bypass output ${o} is past the ${r.channels} channels`);
  }
  floor.push(...channelIssues(p));
  if (floor.length) return floor;
  const enums = p.enums ?? {};
  const cmdLength = cmdLengths(p.transport);
  const base: View = { messages: p.messages, layouts: p.layouts, enums, endian: p.transport.endian, blocked: p.blocked ?? [], settings: p.settings, eq: p.eq };
  const total = (p.blocked?.length ?? 0) + Object.values(p.firmwares ?? {}).reduce((n, d) => n + (d.blocked?.length ?? 0), 0);
  if (total > MAX_BLOCKED_TOTAL) return [`at most ${MAX_BLOCKED_TOTAL} blocked messages across the base and all firmwares, got ${total}`];
  const all = Object.keys(p.messages);
  // base messages a block's cmd can overlap, computed once per block and shared by every firmware that adds it
  const baseHits = new Map<string, string[]>();
  const hitsInBase = (b: string): string[] => {
    let hits = baseHits.get(b);
    if (!hits) {
      const c = p.messages[b].cmd;
      hits = all.filter((n) => (p.messages[n].dir === "send" || p.messages[n].dir === "request") && cmdsOverlap(p.messages[n].cmd, c));
      baseHits.set(b, hits);
    }
    return hits;
  };
  const out = new Set<string>(checkView(base, cmdLength, { layouts: Object.keys(p.layouts), messages: all, scan: all, blocks: base.blocked }));
  // only the nibble framing splits bytes itself; the others send payload bytes as they are
  if (p.transport.framing !== "sysex-nibbles") for (const issue of sevenBitIssues(p)) out.add(issue);
  if (p.transport.framing === "roland-address") for (const issue of unacknowledgedWriteIssues(p)) out.add(issue);
  if (p.transport.framing === "roland-address" && p.transport.frame.identityDeviceId && !p.identity) out.add("transport.frame.identityDeviceId: needs the map's identity, which the reply is checked against");
  for (const issue of plainIssues(p)) out.add(issue);
  for (const issue of noChecksumIssues(p)) out.add(issue);
  for (const issue of packedLayoutIssues(p)) out.add(issue);
  for (const issue of pollIssues(p)) out.add(issue);
  for (const issue of piecesIssues(p)) out.add(issue);
  for (const issue of parametersIssues(p)) out.add(issue);
  for (const issue of choicesIssues(p)) out.add(issue);
  for (const issue of addressIssues(p)) out.add(issue);
  for (const issue of modesIssues(p)) out.add(issue);
  for (const issue of firmwareRangeIssues(p)) out.add(issue);
  for (const issue of connectIssues(p)) out.add(issue);
  // the views a mode's stand-ins apply to: the base map's and each firmware's
  const roots: { prefix: string; v: View }[] = [{ prefix: "", v: base }];
  // each firmware as the codec will see it; only what it replaces or adds is checked again in depth
  for (const [fw, d] of Object.entries(p.firmwares ?? {})) {
    if (out.size >= MAX_ISSUES) break;
    const view: View = {
      ...base,
      messages: { ...p.messages, ...d.messages },
      layouts: { ...p.layouts, ...d.layouts },
      // an enum it replaces keeps its name, so only an enum it adds can be new to its own entries
      enums: d.enums ? { ...enums, ...d.enums } : enums,
      blocked: [...(p.blocked ?? []), ...(d.blocked ?? [])],
    };
    roots.push({ prefix: `firmware ${fw}: `, v: view });
    const changed = Object.keys(d.messages ?? {});
    // a block depends on payloads too: a message whose named layout, or whose packed tail's layout, the firmware
    // replaces is scanned again, and a base block the firmware re-lays out (or redefines) is scanned against every message
    const relaid = Object.keys(view.messages).filter((n) => {
      const pl = view.messages[n].payload;
      if (typeof pl === "string" && has(d.layouts ?? {}, pl)) return true;
      const tail = (typeof pl === "string" ? (has(view.layouts, pl) ? view.layouts[pl] : undefined) : pl)?.packed?.layout;
      return tail !== undefined && has(d.layouts ?? {}, tail);
    });
    const rescan = [...new Set([...changed, ...relaid])];
    // the blocked-cmd scan: its own messages against every block, and every message against its own blocks
    const replaced = d.messages ?? {};
    const scope: Scope = {
      layouts: Object.keys(d.layouts ?? {}),
      messages: changed,
      scan: rescan,
      blocks: view.blocked,
      scanAll: [...new Set([...(d.blocked ?? []), ...view.blocked.filter((b) => rescan.includes(b))])],
      // a block the firmware itself redefines has a new cmd: scan everything; otherwise reuse the base result
      // (messages the firmware replaces are in `scan` already)
      candidates: (b) =>
        has(replaced, b) || !has(p.messages, b) ? Object.keys(view.messages) : hitsInBase(b).filter((n) => !has(replaced, n)),
    };
    // a base problem is reported once, not again for every firmware
    for (const issue of checkView(view, cmdLength, scope)) if (!out.has(issue)) out.add(`firmware ${fw}: ${issue}`);
    // the mode read and the stand-ins as this firmware has its messages and layouts
    const modesView = { ...p, messages: view.messages, layouts: view.layouts, constants: { ...p.constants, ...d.constants } };
    for (const issue of modesIssues(modesView)) if (!out.has(issue)) out.add(`firmware ${fw}: ${issue}`);
  }
  // each mode as the codec will see it, in the base map and in each firmware: its stand-ins can lay out a send or a
  // blocked message otherwise, so the blocked-cmd scan runs again (a problem the view it builds on has is not repeated)
  for (const [mode, u] of Object.entries(p.modes?.use ?? {})) {
    if (!u.messages && !u.layouts) continue;
    for (const r of roots) {
      if (out.size >= MAX_ISSUES) break;
      const v = modeView(r.v, u);
      for (const issue of blockIssues(v, { scan: Object.keys(v.messages), blocks: blockedBytes(r.v, u, v) })) {
        // a blocked message kept under AS_BLOCKED is the same problem as under its own name
        const plain = issue.replace(AS_BLOCKED, "");
        if (![plain, `${r.prefix}${plain}`, `mode ${mode}: ${plain}`, `${r.prefix}mode ${mode}: ${plain}`].some((x) => out.has(x))) out.add(`${r.prefix}mode ${mode}: ${issue}`);
      }
    }
  }
  return [...out].slice(0, MAX_ISSUES);
}

/**
 * On roland-address a unit never acknowledges a write (a send), so the map says how it is checked: the read that reads
 * it back (`readBack`), or `"readBack": false` where the unit has none and only the player can confirm it. Left
 * unsaid, the write's trust would stay unchecked with no way for the unit to raise it.
 */
function unacknowledgedWriteIssues(p: ProtocolShape): string[] {
  const out: string[] = [];
  // a blocked write is never sent, so nothing is left to check
  const check = (prefix: string, messages: Record<string, Message>, blocked: string[]) => {
    for (const [n, m] of Object.entries(messages)) {
      if (m.dir === "send" && m.readBack === undefined && !blocked.includes(n)) {
        out.push(`${prefix}message ${n}: a write on a roland-address transport is never acknowledged: name the read that reads it back in readBack, or set "readBack": false if the unit has none`);
      }
    }
  };
  const blocked = p.blocked ?? [];
  check("", p.messages, blocked);
  for (const [fw, d] of Object.entries(p.firmwares ?? {})) check(`firmware ${fw}: `, d.messages ?? {}, [...blocked, ...(d.blocked ?? [])]);
  return out;
}

/** How a mode's view names a blocked message whose own name the mode stands in for, or drops: its bytes stay blocked. */
const AS_BLOCKED = " (its own bytes, blocked)";

/**
 * A view with a mode's stand-ins applied, as the codec sees it there: each name a mode stands in reads as its
 * stand-in, and a name standing in for a blocked message is blocked too (the codec refuses to encode all of these).
 * A block is on the bytes, not the name: a blocked message whose name the mode stands in for, or drops, stays in the
 * view under its name and AS_BLOCKED, laid out as the mode lays it out, so no send there can make its bytes.
 */
function modeView(v: View, u: ModeUse): View {
  const blocked = new Set(v.blocked);
  for (const [n, sub] of Object.entries(u.messages ?? {})) if (sub !== null && blocked.has(sub)) blocked.add(n);
  const messages = inMode(v.messages, u.messages);
  for (const b of v.blocked) {
    if (!u.messages || !has(u.messages, b) || !has(v.messages, b)) continue;
    messages[`${b}${AS_BLOCKED}`] = v.messages[b];
    blocked.add(`${b}${AS_BLOCKED}`);
  }
  return { ...v, messages, layouts: inMode(v.layouts, u.layouts), blocked: [...blocked] };
}

/**
 * The names in a mode's view that hold a blocked message's bytes, once each: a blocked message the mode leaves as it
 * is, and one kept under AS_BLOCKED. A name standing in for a blocked message is refused by the codec and has the same
 * bytes as one of those, so it is not held against the sends again; a blocked name standing in for a safe message has
 * that message's bytes, so nothing is held against them.
 */
function blockedBytes(root: View, u: ModeUse, v: View): string[] {
  const blocked = new Set(root.blocked);
  return Object.keys(v.messages).filter((n) => n.endsWith(AS_BLOCKED) || (blocked.has(n) && !(u.messages && has(u.messages, n))));
}

/** Keys an address field may not have: each would give it bytes or a reading of its own in the payload. */
const ADDRESS_FIELD_REFUSES = ["offset", "repeat", "bits", "invert", "septets", "nibbles", "checksum", "choice", "nullAs", "copyOf", "saturate", "enumBy"] as const;

/**
 * Address fields (roland-address): unsigned scalars in a message's own payload, with a fixed cmd, a stride or a table
 * whose keys are the field's enum's, never moving the address past its last digit, and a reply that carries the same
 * ones (its address moves with the request's). An address field may not reach a blocked message's bytes: any address
 * it can move a send or request to is checked against the blocked messages with the same command bytes, the blocked
 * one's whole span (a write covers its address and the bytes after it).
 */
function addressIssues(p: ProtocolShape): string[] {
  const out: string[] = [];
  const t = p.transport;
  const tables = p.addresses ?? {};
  type Enums = View["enums"];
  const enums: Enums = p.enums ?? {};
  const roland = t.framing === "roland-address";
  if (p.addresses && !roland) out.push(`addresses: address tables need the roland-address framing, not ${t.framing}`);
  const fieldsOf = (m: Message): AddressField[] => (typeof m.payload === "object" ? m.payload.fields.filter(isAddressField) : []);
  // each view's fields read with its own enums: a firmware replaces whole enums by name or adds its own, a mode stands
  // one in for another, as the codec reads them there
  const checkFields = (prefix: string, msgs: Record<string, Message>, lays: Record<string, Layout>, enums: Enums) => {
    for (const [n, l] of Object.entries(lays)) {
      if (l.fields.some(isAddressField)) out.push(`${prefix}layout ${n}: address fields go in a message's own payload, not a shared layout`);
    }
    for (const [n, m] of Object.entries(msgs)) {
      const fields = fieldsOf(m);
      if (!fields.length) continue;
      const where = `${prefix}message ${n}`;
      if (!roland) {
        out.push(`${where}: address fields need the roland-address framing, not ${t.framing}`);
        continue;
      }
      if (m.cmd.includes("{")) out.push(`${where}: a message with address fields has a fixed cmd`);
      for (const f of fields) {
        const at = `${where}: address field ${f.name}`;
        if (f.type !== "u8" && f.type !== "u16" && f.type !== "u32") out.push(`${at} is an unsigned integer`);
        for (const k of ADDRESS_FIELD_REFUSES) if (f[k] !== undefined) out.push(`${at} takes no ${k} (it has no payload bytes)`);
        if (f.enum !== undefined && !has(enums, f.enum)) out.push(`${at}: unknown enum "${f.enum}"`);
        if (f.address.table !== undefined) {
          const table = f.address.table;
          if (!has(tables, table)) out.push(`${at}: no address table "${table}"`);
          else if (f.enum === undefined) out.push(`${at}: a table is keyed by the field's enum, and it names none`);
          else if (has(enums, f.enum)) {
            for (const k of Object.keys(tables[table])) if (!has(enums[f.enum], k)) out.push(`${at}: table ${table} key "${k}" is not a key of enum ${f.enum}`);
          }
        }
      }
    }
  };
  // each message's terms once per enums: the reach check asks for them per blocked message, and views with the same
  // enums share them
  const termCache = new Map<Enums, Map<Message, AddressTerm[]>>();
  const termsOf = (v: View, m: Message) => {
    let c = termCache.get(v.enums);
    if (!c) termCache.set(v.enums, (c = new Map()));
    const ctx: CodecContext = { endian: t.endian, enums: v.enums };
    return c.get(m) ?? c.set(m, fieldsOf(m).map((f) => addressTerm(f, ctx, tables))).get(m)!;
  };
  // a cmd's command bytes, and the lowest and highest address it names: an {arg} digit may be anything from 00 to 7f
  const split = (m: Message) => {
    // types only: a transport without an inner header (midi-channel) never gets here with an address field
    const at = (t as { inner: { cmdLength: number } }).inner.cmdLength - (roland ? t.inner.addressBytes : 0);
    const c = m.cmd.split(" ");
    const digits = (fill: string) => addressOfHex(c.slice(at).map((x) => (x.startsWith("{") ? fill : x)).join(" "));
    return { command: c.slice(0, at).join(" "), lo: digits("00"), hi: digits("7f") };
  };
  const span = (v: View, m: Message) => {
    const l = m.payload === undefined ? { fields: [] } : typeof m.payload === "string" ? v.layouts[m.payload] : m.payload;
    // a request on a write command writes its payload as a send does (an answered write); a read's payload sits on
    // another command, which the command-bytes test sets apart
    return (m.dir === "send" || m.dir === "request") && l ? Math.max(1, layoutSize(l), l.maxSize ?? 0) : 1;
  };
  let shaped = true;
  // targets: the names whose bytes are a blocked message's (a mode's view picks them with blockedBytes)
  const checkView = (prefix: string, v: View, targets: string[]) => {
    if (!roland || !shaped) return;
    const msgs = v.messages;
    const last = 128 ** t.inner.addressBytes;
    for (const [n, m] of Object.entries(msgs)) {
      const fields = fieldsOf(m);
      if (!fields.length) continue;
      const terms = termsOf(v, m);
      if (split(m).hi + terms.reduce((x, y) => x + termMax(y), 0) >= last) out.push(`${prefix}message ${n}: its address fields can move it past the last address`);
      if (!addressesApart(terms)) out.push(`${prefix}message ${n}: two sets of its address values can reach one address (an area runs into the next); narrow the fields with min and max, or move the areas apart`);
      if (m.dir !== "request" || !m.reply) continue;
      const r = m.reply.message ?? n;
      if (!has(msgs, r)) continue;
      const own = new Set(fields.map((f) => f.name));
      const theirs = fieldsOf(msgs[r]);
      // the reply's address and values come from the request's wire values, read with the reply's own field
      const reads = (f: AddressField) => JSON.stringify([f.type, f.address.stride ?? null, f.address.table ?? null, f.enum ?? null, f.scale ?? 1, f.bias ?? 0]);
      for (const f of fields) {
        const x = theirs.find((y) => y.name === f.name);
        if (!x) out.push(`${prefix}message ${n}: its reply ${r} carries its address field ${f.name} too (its address moves with the request's)`);
        else if (reads(x) !== reads(f)) out.push(`${prefix}message ${n}: its reply ${r} has address field ${f.name} with the request's type, address, enum, scale and bias`);
      }
      for (const f of theirs) if (!own.has(f.name)) out.push(`${prefix}message ${n}: its reply ${r} has address field ${f.name}, which the request does not`);
    }
    // a list's start and end are matched by their own fixed cmd: an address field would move them where none is heard
    for (const [n, m] of Object.entries(msgs)) {
      const list = m.reply?.list;
      if (!list) continue;
      for (const e of [list.start, list.end]) if (e !== undefined && has(msgs, e) && fieldsOf(msgs[e]).length) out.push(`${prefix}message ${n}: its list's ${e === list.end ? "end" : "start"} ${e} has address fields; a list's start and end sit at a fixed cmd`);
    }
    // a reply answering a request without address fields has none of its own to read
    for (const [n, m] of Object.entries(msgs)) {
      if (m.dir !== "request" || !m.reply || fieldsOf(m).length) continue;
      const r = m.reply.message ?? n;
      if (has(msgs, r) && fieldsOf(msgs[r]).length) out.push(`${prefix}message ${n}: its reply ${r} has address fields, which the request does not`);
    }
    // reach: any address a send or request can be moved to, against each blocked message's span
    const blocked = new Set(v.blocked);
    for (const b of targets) {
      if (!has(msgs, b)) continue;
      const bm = msgs[b];
      const bt = termsOf(v, bm);
      const bs = split(bm);
      // its whole area: every address its fields and {arg} digits can name, and its write's span past the last
      const from = bs.lo + bt.reduce((x, y) => x + termMin(y), 0);
      const to = bs.hi + bt.reduce((x, y) => x + termMax(y), 0) + span(v, bm) - 1;
      for (const [n, m] of Object.entries(msgs)) {
        if (out.length >= MAX_ISSUES) return;
        if (blocked.has(n) || (m.dir !== "send" && m.dir !== "request")) continue;
        // pairs without address fields keep the blocked-cmd scan's rules; an equal cmd with address fields on either
        // side is searched too, since that scan compares only the unmoved cmds
        if (!fieldsOf(m).length && !bt.length) continue;
        const ms = split(m);
        if (!cmdsOverlap(ms.command, bs.command)) continue;
        let hits: number[][];
        try {
          hits = searchAddress(termsOf(v, m), from - ms.hi - span(v, m) + 1, to - ms.lo, 1);
        } catch (e) {
          if (!(e instanceof AddressSearchTooLong)) throw e;
          out.push(`${prefix}message ${n}: too many addresses to check against the blocked "${b}"; narrow its address fields with min and max`);
          continue;
        }
        if (hits.length) out.push(`${prefix}message ${n}: its address fields can reach the blocked "${b}"`);
      }
    }
  };
  const fwEnums = (d: NonNullable<ProtocolShape["firmwares"]>[string]): Enums => (d.enums ? { ...enums, ...d.enums } : enums);
  checkFields("", p.messages, p.layouts, enums);
  for (const [fw, d] of Object.entries(p.firmwares ?? {})) checkFields(`firmware ${fw}: `, d.messages ?? {}, d.layouts ?? {}, fwEnums(d));
  // the address search needs well-formed address fields; an address the shape check refuses (a digit past 7 bits)
  // is reported there
  shaped = out.length === 0;
  const viewChecked = (prefix: string, v: View, targets: string[]) => {
    try {
      checkView(prefix, v, targets);
    } catch (e) {
      // a check that could not finish refuses the map rather than letting it through unchecked
      if (!(e instanceof ProtocolError)) throw e;
      out.push(`${prefix}address fields could not be checked: ${e.message}`);
    }
  };
  const base: View = { messages: p.messages, layouts: p.layouts, enums, endian: t.endian, blocked: p.blocked ?? [], settings: p.settings, eq: p.eq };
  // each view, and the views whose report of the same problem it repeats: a firmware repeats the base, a mode the
  // base, its firmware and the base in that mode (sibling firmwares each report their own)
  const views: { prefix: string; v: View; under: string[]; targets?: string[] }[] = [{ prefix: "", v: base, under: [] }];
  for (const [fw, d] of Object.entries(p.firmwares ?? {})) {
    views.push({ prefix: `firmware ${fw}: `, v: { ...base, messages: { ...p.messages, ...d.messages }, layouts: { ...p.layouts, ...d.layouts }, enums: fwEnums(d), blocked: [...(p.blocked ?? []), ...(d.blocked ?? [])] }, under: [""] });
  }
  // a mode adds no message of its own, but pairs a request with the reply its name stands for there: each mode's view
  // is checked too (a name standing in for a blocked message is blocked in that mode)
  const roots = [...views];
  for (const [mode, u] of Object.entries(p.modes?.use ?? {})) {
    for (const r of roots) {
      const v = { ...modeView(r.v, u), enums: u.enums ? inMode(r.v.enums, u.enums) : r.v.enums };
      // a blocked name standing in for a safe message has that message's bytes, as for the cmd scan: not a target
      views.push({ prefix: `${r.prefix}mode ${mode}: `, v, under: r.prefix ? ["", r.prefix, `mode ${mode}: `] : [""], targets: blockedBytes(r.v, u, v) });
    }
  }
  for (const { prefix, v, under, targets } of views) {
    const before = new Set(out);
    viewChecked(prefix, v, targets ?? v.blocked);
    // a problem a view it builds on has is reported once, not again for every firmware or mode (a blocked message kept
    // under AS_BLOCKED is the same problem as under its own name)
    for (const x of [...out]) {
      if (before.has(x)) continue;
      const bare = x.slice(prefix.length).replace(AS_BLOCKED, "");
      if (under.some((q) => before.has(`${q}${bare}`))) out.splice(out.indexOf(x), 1);
    }
  }
  return out.slice(0, MAX_ISSUES);
}

/** A send kept apart from a blocked message on a cmd they can share, and what keeps them apart. */
export interface BlockSeparation {
  /** The firmware whose view it is in, when it differs from the base map's. */
  firmware?: string;
  /** The mode whose stand-ins it is in (in the base map or `firmware`), when it differs from the view without them. */
  mode?: string;
  send: string;
  blocked: string;
  /**
   * What the separation rests on: "byte 4: 08 vs 01" (the send's pin, then the blocked one's) or "length: ...". A byte
   * either side pins inside a packed tail (a nibble or an 8to7 byte its layout's const fixes) ends " (packed tail)": the
   * least-known part of a map, so a walk or a capture should confirm it first.
   */
  by: string;
}

/**
 * Every request or send on a cmd that can be a blocked message's, kept apart from it only by its payload (the block is
 * per message), with what that rests on, for the base map and then each firmware's pairs that are new or rest on
 * something else there (a base pair a firmware drops, by blocking the send or moving its cmd, is not listed). A
 * blocked message is half-known, so a pinned byte of it may really be a parameter: these are what a walk, a review or a
 * unit should confirm. Comparing them across a map change shows a block it lifts (a pair that is new) or moves (a pair whose `by`
 * changed). Each mode's stand-ins are scanned the same way, in the base map and each firmware, and a pair they make
 * new or move is listed with `mode`. Sorted by firmware, mode, send and blocked message. At most `limit` pairs: a hostile
 * map can hold millions, so the scan stops there (base pairs first, then the firmwares in the map's order, then the
 * modes), and a list of `limit` may be cut short.
 */
export function blockSeparations(p: Protocol, limit = MAX_SEPARATIONS): BlockSeparation[] {
  const endian = p.transport.endian;
  /** A view's pairs, at most `max` of them: `blocked` has the blocked bytes, `refused` the names never sent. */
  const viewOf = (messages: Record<string, Message>, layouts: Record<string, Layout>, blocked: string[], max: number, refused: string[] = blocked) => {
    const out: BlockSeparation[] = [];
    const shapes = new Map<string, FrameShape | undefined>();
    const shapeOf = (n: string): FrameShape | undefined => {
      if (!shapes.has(n)) {
        const l = messageLayout(messages[n], layouts);
        shapes.set(n, l && frameShape(l, endian, layouts));
      }
      return shapes.get(n);
    };
    const blocks = new Set(blocked.filter((b) => has(messages, b)));
    const never = new Set(refused);
    // the sends and requests with their cmds split once: a view scans each against every block
    const sends = Object.entries(messages).flatMap(([n, m]) =>
      blocks.has(n) || never.has(n) || (m.dir !== "send" && m.dir !== "request") ? [] : [[n, m.cmd.split(" ")] as const],
    );
    for (const b of blocks) {
      const y = shapeOf(b);
      if (!y) continue;
      const cmd = messages[b].cmd.split(" ");
      for (const [n, c] of sends) {
        if (out.length >= max) return out;
        // under another header (sysex-plain) its frame starts with other bytes
        if (messages[n].header !== messages[b].header || !tokensOverlap(c, cmd)) continue;
        const x = shapeOf(n);
        const by = x && shapesApart(x, y);
        if (by) out.push({ send: n, blocked: b, by });
      }
    }
    return out;
  };
  const key = (s: BlockSeparation) => `${s.send}\u0000${s.blocked}\u0000${s.by}`;
  const base = viewOf(p.messages, p.layouts ?? {}, p.blocked ?? [], limit);
  const seen = new Set(base.map(key));
  const out = [...base];
  // the views a mode's stand-ins apply to, with the pairs each lists
  const roots: { firmware?: string; v: View; seen: Set<string>; size: number }[] = [];
  const asView = (messages: Record<string, Message>, layouts: Record<string, Layout>, blocked: string[]): View => ({ messages, layouts, blocked, enums: {}, endian, settings: undefined, eq: undefined });
  roots.push({ v: asView(p.messages, p.layouts ?? {}, p.blocked ?? []), seen, size: base.length });
  for (const [fw, d] of Object.entries(p.firmwares ?? {})) {
    if (out.length >= limit) break;
    const fv = asView({ ...p.messages, ...d.messages }, { ...p.layouts, ...d.layouts }, [...(p.blocked ?? []), ...(d.blocked ?? [])]);
    // a firmware that replaces no message or layout and adds no block sees the base's list
    if (!d.messages && !d.layouts && !d.blocked?.length) {
      roots.push({ firmware: fw, v: fv, seen, size: base.length });
      continue;
    }
    // room for the base pairs it repeats, and for the new ones still to list
    const view = viewOf(fv.messages, fv.layouts, fv.blocked, base.length + limit - out.length);
    roots.push({ firmware: fw, v: fv, seen: new Set(view.map(key)), size: view.length });
    for (const s of view) if (!seen.has(key(s)) && out.length < limit) out.push({ firmware: fw, ...s });
  }
  // each mode's stand-ins, in the base map and each firmware: the pairs new or resting on something else there. A pair
  // left out on a firmware in a mode holds as that firmware's pair where the firmware lists one (it moves the pair),
  // else as the base map's in that mode, else as the firmware's view has it: a pair is left out only when it is that
  const pair = (s: BlockSeparation) => `${s.send}\u0000${s.blocked}`;
  const moved = new Set(out.flatMap((s) => (s.firmware === undefined ? [] : [`${s.firmware}\u0000${pair(s)}`])));
  for (const [mode, u] of Object.entries(p.modes?.use ?? {})) {
    if (!u.messages && !u.layouts) continue;
    let inBase = new Set<string>();
    let inBasePairs = new Set<string>();
    for (const r of roots) {
      if (out.length >= limit) break;
      const mv = modeView(r.v, u);
      // a blocked message kept under AS_BLOCKED is listed by its own name: the same pair as without the mode is not new
      const view = viewOf(mv.messages, mv.layouts, blockedBytes(r.v, u, mv), r.size + inBase.size + limit - out.length, mv.blocked).map((s) =>
        s.blocked.endsWith(AS_BLOCKED) ? { ...s, blocked: s.blocked.slice(0, -AS_BLOCKED.length) } : s,
      );
      if (r.firmware === undefined) {
        inBase = new Set(view.map(key));
        inBasePairs = new Set(view.map(pair));
      }
      const implied = (s: BlockSeparation) =>
        (r.firmware === undefined || moved.has(`${r.firmware}\u0000${pair(s)}`) || !inBasePairs.has(pair(s)) ? r.seen : inBase).has(key(s));
      for (const s of view) {
        if (implied(s) || out.length >= limit) continue;
        out.push({ ...(r.firmware === undefined ? {} : { firmware: r.firmware }), mode, ...s });
      }
    }
  }
  const order = (s: BlockSeparation) => `${s.firmware ?? ""}\u0000${s.mode ?? ""}\u0000${s.send}\u0000${s.blocked}`;
  return out.sort((a, b) => (order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0));
}

/** What a map's channel messages need: a control-only map has some, and a channel-only transport carries nothing else. */
function channelIssues(p: ProtocolShape): string[] {
  const out = p.controls ? controlsIssues(p.controls, p.enums ?? {}) : [];
  const c = p.controls;
  if (p.driver === "control-only" && !(c && (Object.keys(c.items).length || c.presets))) out.push('driver "control-only" needs controls: items or presets');
  if (p.transport.framing === "midi-channel") {
    if (p.driver !== "control-only") out.push('a "midi-channel" transport carries channel messages only: its map needs driver "control-only"');
    if (Object.keys(p.messages).length || Object.keys(p.layouts).length || p.firmwares) out.push('a "midi-channel" transport sends no SysEx: messages and layouts stay empty, and there are no firmwares');
  }
  return out.slice(0, MAX_ISSUES);
}

const lengthText = (r: { min: number; max: number }) => (r.min === r.max ? `${r.min}` : `${r.min} to ${r.max}`);

/**
 * The rules of a "sysex-plain" transport. A message's `header` names one of `transport.frame.headers`, and no header
 * begins another, so an incoming message has one header. With cmds of several lengths, no cmd begins another cmd under
 * the same header (a placeholder matches any byte), so an incoming message has one cmd: the framer reads the longest
 * one its bytes start with.
 */
function plainIssues(p: ProtocolShape): string[] {
  const t = p.transport;
  const out: string[] = [];
  const named = t.framing === "sysex-plain" ? (t.frame.headers ?? {}) : {};
  // a request's answers (reply, list start and end, ack) come under its header: the codec pairs them by cmd alone
  // a firmware reports what it brings: its own messages, and a base request whose answer it moves to another header
  const scanHeaders = (prefix: string, own: Record<string, Message> | undefined, view: Record<string, Message>) => {
    for (const [n, m] of Object.entries(own ?? {})) {
      if (m.header === undefined || out.length >= MAX_ISSUES) continue;
      if (t.framing !== "sysex-plain") out.push(`${prefix}message ${n}: header needs a sysex-plain transport`);
      else if (!has(named, m.header)) out.push(`${prefix}message ${n}: header "${m.header}" is not in transport.frame.headers`);
      // the editor-walk tools match polls by cmd under the device's header
      if (m.poll) out.push(`${prefix}message ${n}: poll is for a message under the device's header`);
    }
    for (const [n, m] of Object.entries(view)) {
      for (const a of [m.reply?.message, m.reply?.list?.start, m.reply?.list?.end, m.ack?.message]) {
        if (a === undefined || !has(view, a) || view[a].header === m.header || out.length >= MAX_ISSUES) continue;
        if (own === view || has(own ?? {}, n) || has(own ?? {}, a)) out.push(`${prefix}message ${n}: its answer ${a} comes under another header`);
      }
    }
  };
  scanHeaders("", p.messages, p.messages);
  for (const [fw, d] of Object.entries(p.firmwares ?? {})) scanHeaders(`firmware ${fw}: `, d.messages, { ...p.messages, ...d.messages });
  if (t.framing !== "sysex-plain") return out;
  const all: [string, string][] = [["the device header", t.frame.header], ...Object.entries(named).map(([n, h]): [string, string] => [`header ${n}`, h])];
  for (const [a, x] of all) {
    for (const [b, y] of all) {
      if (a !== b && y === x && a < b) out.push(`transport.frame: ${b} repeats ${a} (${x})`);
      else if (y.startsWith(`${x} `)) out.push(`transport.frame: ${b} (${y}) begins with ${a} (${x})`);
    }
  }
  const { min, max } = cmdLengths(t);
  if (min === max) return out;
  const templated = (msgs: Record<string, Message> | undefined) => Object.values(msgs ?? {}).filter((m) => m.cmd.includes("{")).length;
  const total = templated(p.messages) + Object.values(p.firmwares ?? {}).reduce((n, d) => n + templated(d.messages), 0);
  if (total > MAX_TEMPLATED_PLAIN) return [...out, `at most ${MAX_TEMPLATED_PLAIN} templated cmds across the base and all firmwares when cmds differ in length, got ${total}`];
  const scan = (prefix: string, own: Record<string, Message> | undefined, view: Record<string, Message>) => {
    const groups = new Map<string, [string, string[]][]>();
    for (const [n, m] of Object.entries(view)) {
      const h = m.header ?? "";
      if (!groups.has(h)) groups.set(h, []);
      groups.get(h)!.push([n, m.cmd.split(" ")]);
    }
    // a firmware reports only the clashes it brings, not the base map's again
    const report = (long: string, longCmd: string[], short: string, shortCmd: string[]) => {
      if (out.length >= MAX_ISSUES || (own && !has(own, long) && !has(own, short))) return;
      out.push(`${prefix}message ${long}: cmd ${longCmd.join(" ")} begins with message ${short}'s cmd ${shortCmd.join(" ")}`);
    };
    for (const cmds of groups.values()) {
      const fixed = new Map<string, string>();
      for (const [n, c] of cmds) if (!c.some((x) => x.startsWith("{")) && !fixed.has(c.join(" "))) fixed.set(c.join(" "), n);
      // a firmware's scan pairs only with its own messages: the base pairs were checked once already
      const mine = own ? cmds.filter(([n]) => has(own, n)) : cmds;
      for (const [n, c] of cmds) {
        if (c.some((x) => x.startsWith("{"))) {
          // a templated cmd against every cmd of another length, either way round
          for (const [o, d] of own && !has(own, n) ? mine : cmds) {
            if (d.length === c.length || (d.some((x) => x.startsWith("{")) && d.length < c.length)) continue;
            const [s, l, sn, ln] = d.length < c.length ? [d, c, o, n] : [c, d, n, o];
            if (tokensBegin(s, l)) report(ln, l, sn, s);
          }
        } else {
          for (let k = min; k < c.length; k++) {
            const hit = fixed.get(c.slice(0, k).join(" "));
            if (hit !== undefined) report(n, c, hit, c.slice(0, k));
          }
        }
      }
    }
  };
  scan("", undefined, p.messages);
  for (const [fw, d] of Object.entries(p.firmwares ?? {})) if (d.messages) scan(`firmware ${fw}: `, d.messages, { ...p.messages, ...d.messages });
  return out.slice(0, MAX_ISSUES);
}

/**
 * A list's start and end are messages the device sends, each on a cmd that neither the item nor the other shares: an
 * end that reads as an item (or a start that reads as an end) would leave the list never ending.
 */
function listIssues(v: View, request: string, item: string, list: NonNullable<Reply["list"]>): string[] {
  const out: string[] = [];
  const where = `message ${request}: reply list`;
  const ends: [string, string][] = list.start === undefined ? [["end", list.end]] : [["start", list.start], ["end", list.end]];
  for (const [role, x] of ends) {
    if (!has(v.messages, x)) {
      out.push(`${where} ${role} "${x}" is not a message`);
      continue;
    }
    const dir = v.messages[x].dir;
    if (dir !== "reply" && dir !== "notify") out.push(`${where} ${role} "${x}" must be a reply or notify, not a ${dir}`);
    if (has(v.messages, item) && cmdsOverlap(v.messages[x].cmd, v.messages[item].cmd)) out.push(`${where} ${role} "${x}" shares its cmd with the item "${item}"`);
  }
  const [s, e] = [list.start, list.end];
  if (s !== undefined && has(v.messages, s) && has(v.messages, e) && cmdsOverlap(v.messages[s].cmd, v.messages[e].cmd)) out.push(`${where} start "${s}" and end "${e}" share a cmd`);
  return out;
}

/**
 * What any payload that decodes as a layout holds, as far as the map pins it: its length range, and per byte the value
 * a const fixes or the values a whole-byte `not` rules out. Every byte it leaves out can hold anything. A payload the
 * codec encodes for the layout fits it too (encode writes the consts, refuses a `not` and writes at least the layout).
 */
interface FrameShape {
  min: number;
  max: number;
  is: Map<number, number>;
  not: Map<number, number[]>;
  /** The bytes a packed tail's layout pins (see packedShape). */
  tail: Set<number>;
}

function frameShape(l: Layout, endian: "le" | "be", layouts: Record<string, Layout> = {}): FrameShape {
  const shape: FrameShape = { min: l.minSize ?? openStringAt(l) ?? layoutSize(l), max: l.maxSize ?? Infinity, is: new Map(), not: new Map(), tail: new Set() };
  for (const { f, at } of placed(l)) {
    if (f.type === "pad" || f.type === "string") continue;
    if (f.type === "bytes") {
      if (f.const === undefined) continue;
      const c = parseHex(f.const);
      for (const o of elementOffsets(f)) c.forEach((x, i) => shape.is.set(at + o + i, x));
      continue;
    }
    // a field of bits shares its byte with others, a checksum's value depends on the rest, a choice field's encoding
    // is the unit's to settle, and an f32 const is checked as a number (-0 reads as 0): all left free
    if (f.bits !== undefined || f.checksum || f.choice !== undefined || f.type === "f32") continue;
    const size = elementSize(f);
    if (f.const !== undefined) {
      const b = new Uint8Array(size);
      putScalar(f, new DataView(b.buffer), 0, (f.endian ?? endian) === "le", f.const);
      for (const o of elementOffsets(f)) b.forEach((x, i) => shape.is.set(at + o + i, x));
    } else if (f.not !== undefined && size === 1) {
      const not = f.not.map((n) => n & 0xff);
      for (const o of elementOffsets(f)) shape.not.set(at + o, not);
    }
  }
  // a byte two fields cover is written by whichever comes last (a pad, a string, bits or a checksum): pinned by neither
  const covered = new Map<number, number>();
  for (const { f, at } of placed(l)) {
    for (const o of elementOffsets(f)) for (let i = 0; i < elementSize(f); i++) covered.set(at + o + i, (covered.get(at + o + i) ?? 0) + 1);
  }
  for (const [at, n] of covered) {
    if (n < 2) continue;
    shape.is.delete(at);
    shape.not.delete(at);
  }
  if (l.packed) packedShape(shape, layoutSize(l), l.packed, endian, layouts);
  return shape;
}

/**
 * A packed tail's part of a frame shape (`shape` holds the fields before it; the tail starts at `at`, the fields' size,
 * as encode and decode place it): the payload's length range, from the unpacked bytes the tail takes (its layout's
 * range, or none to maxLength, either capped by maxLength) packed, plus its CRC; and, read with a layout, that
 * layout's pinned bytes where packing keeps them whole: a nibble pair for each (both nibbles fixed), or the low seven
 * bits of each 8to7 data byte (its top bit shares the group's high-bits byte).
 * A `not` of the tail layout pins nothing here: no one packed byte holds the whole value.
 */
function packedShape(shape: FrameShape, at: number, p: PackedTail, endian: "le" | "be", layouts: Record<string, Layout>): void {
  const crc = p.crc ? CRC_SEPTETS : 0;
  // a missing or packed tail layout is refused at load: until then, any bytes up to maxLength
  const t = p.layout !== undefined && has(layouts, p.layout) && !layouts[p.layout].packed ? frameShape(layouts[p.layout], endian) : undefined;
  const fewest = Math.min(t?.min ?? 0, p.maxLength);
  const most = Math.min(t?.max ?? Infinity, p.maxLength);
  shape.min = at + packedSize(p, fewest) + crc;
  shape.max = at + packedSize(p, most) + crc;
  if (!t) return;
  const pin = (i: number, y: number) => {
    shape.is.set(i, y);
    shape.tail.add(i);
  };
  for (const [o, x] of t.is) {
    if (p.packing === "8to7") pin(at + 8 * Math.floor(o / 7) + 1 + (o % 7), x & 0x7f);
    else splitNibbles(Uint8Array.of(x), nibbleOrder(p)).forEach((y, i) => pin(at + 2 * o + i, y));
  }
}

/**
 * Why no payload can fit both shapes, in words ("byte 4: 08 vs 01", "byte 4: 08 vs never 08", "length: 1 vs 2 or
 * more", "byte 9: 01 vs 03 (packed tail)" where either pin comes from a packed tail), or undefined when one can.
 * Lengths come first, then the lowest byte pinned apart.
 */
function shapesApart(a: FrameShape, b: FrameShape): string | undefined {
  const span = (x: FrameShape) => (x.max === Infinity ? `${x.min} or more` : x.min === x.max ? `${x.min}` : `${x.min}..${x.max}`);
  if (Math.max(a.min, b.min) > Math.min(a.max, b.max)) return `length: ${span(a)} vs ${span(b)}`;
  const hex = (v: number) => v.toString(16).padStart(2, "0");
  let at = Infinity;
  let why = "";
  const scan = (x: FrameShape, y: FrameShape, flip: boolean) => {
    for (const [i, v] of x.is) {
      if (i >= at) continue;
      const w = y.is.get(i);
      const [mine, theirs] = w !== undefined ? (w !== v ? [hex(v), hex(w)] : []) : y.not.get(i)?.includes(v) ? [hex(v), `never ${hex(v)}`] : [];
      if (mine === undefined) continue;
      at = i;
      const tail = x.tail.has(i) || y.tail.has(i) ? " (packed tail)" : "";
      why = `byte ${i}: ${flip ? `${theirs} vs ${mine}` : `${mine} vs ${theirs}`}${tail}`;
    }
  };
  scan(a, b, false);
  scan(b, a, true);
  return at === Infinity ? undefined : why;
}

/** Whether one payload can fit both shapes: their lengths meet, and no byte is pinned apart. */
function shapesMeet(a: FrameShape, b: FrameShape): boolean {
  return shapesApart(a, b) === undefined;
}

export { cmdsOverlap };

/** cmdsOverlap on cmds already split into their tokens. */
function tokensOverlap(x: readonly string[], y: readonly string[]): boolean {
  return x.length === y.length && tokensBegin(x, y);
}

interface Scope {
  /** Layouts and inline payloads to check in depth. */
  layouts: string[];
  messages: string[];
  /** Messages to check against `blocks`. */
  scan: string[];
  blocks: string[];
  /** Blocks to check against every message. */
  scanAll?: string[];
  /** For a block in `scanAll`: the messages that may overlap it (default: all). */
  candidates?: (block: string) => string[];
}

function checkView(v: View, cmdLength: { min: number; max: number }, scope: Scope): string[] {
  const out: string[] = [];
  const layoutsToCheck = scope.layouts;
  const messagesToCheck = scope.messages;
  const layoutOf = (m: Message): Layout | undefined => messageLayout(m, v.layouts);
  const fieldsOf = (n: string): Field[] | undefined => {
    const l = has(v.messages, n) ? layoutOf(v.messages[n]) : undefined;
    return l && withTailFields(l, v.layouts);
  };
  const fieldNames = (n: string): Set<string> | undefined => {
    const fields = fieldsOf(n);
    return fields && new Set(fields.map((f) => f.name));
  };
  const placeholders = (n: string) => (has(v.messages, n) ? placeholdersOf(v.messages[n].cmd) : []);
  const fieldOf = (msg: string, field: string): Field | undefined => fieldsOf(msg)?.find((f) => f.name === field);
  // the pairing and write rules name fields: a typo there would silently switch a filter off
  const needField = (where: string, msg: string, field: string | undefined) => {
    const names = fieldNames(msg);
    if (field === undefined || !names) return;
    if (!names.has(field)) out.push(`${where}: "${msg}" has no field "${field}"`);
    else if (fieldOf(msg, field)?.type === "pad") out.push(`${where}: "${msg}" field "${field}" is padding`);
  };
  const needArgs = (where: string, msg: string, args: Record<string, number> | undefined) => {
    for (const a of placeholders(msg)) if (!(args && has(args, a))) out.push(`${where}: no value for {${a}} of "${msg}"`);
  };
  for (const n of layoutsToCheck) out.push(...checkLayout(`layout ${n}`, v.layouts[n], v.enums));
  for (const n of messagesToCheck) {
    const m = v.messages[n];
    if (typeof m.payload === "object") out.push(...checkLayout(`message ${n}`, m.payload, v.enums));
  }
  for (const [n, m] of Object.entries(v.messages)) {
    const cmdLen = m.cmd.split(" ").length;
    if (cmdLen < cmdLength.min || cmdLen > cmdLength.max) out.push(`message ${n}: cmd has ${cmdLen} bytes, transport says ${lengthText(cmdLength)}`);
    if (typeof m.payload === "string" && !has(v.layouts, m.payload)) out.push(`message ${n}: no layout "${m.payload}"`);
    if (m.reply) {
      const r = m.reply.message ?? n;
      if (!has(v.messages, r)) out.push(`message ${n}: reply "${r}" is not a message`);
      for (const e of m.reply.echo ?? []) {
        needField(`message ${n} reply echo`, r, e.reply);
        needField(`message ${n} reply echo`, n, e.request);
      }
      if (m.reply.list) out.push(...listIssues(v, n, r, m.reply.list));
    }
    if (m.ack) {
      if (!has(v.messages, m.ack.message)) out.push(`message ${n}: ack "${m.ack.message}" is not a message`);
      for (const f of [m.ack.cmdField, m.ack.statusField, m.ack.idField]) needField(`message ${n} ack`, m.ack.message, f);
      needField(`message ${n} ack`, n, m.ack.requestIdField);
      const c = fieldOf(m.ack.message, m.ack.cmdField);
      // readAck compares this field with the sent cmd byte for byte, so it is as long as this message's cmd
      if (c && (c.type !== "bytes" || c.repeat || c.length !== cmdLen)) {
        out.push(`message ${n} ack: "${m.ack.message}" field "${m.ack.cmdField}" must be ${cmdLen} bytes`);
      }
    }
  }
  out.push(...blockIssues(v, scope));
  out.push(...probeIssues(v, layoutOf));
  for (const [g, def] of Object.entries(v.settings?.groups ?? {})) {
    if (!has(v.messages, def.read)) out.push(`settings group ${g}: read "${def.read}" is not a message`);
    else needArgs(`settings group ${g}`, def.read, def.args);
  }
  for (const s of v.settings?.items ?? []) {
    if (!v.settings || !has(v.settings.groups, s.group)) out.push(`setting ${s.id}: no group "${s.group}"`);
    if (!has(v.messages, s.write.message)) out.push(`setting ${s.id}: write "${s.write.message}" is not a message`);
    else {
      needField(`setting ${s.id}`, s.write.message, "value");
      needArgs(`setting ${s.id}`, s.write.message, s.write.args);
    }
  }
  if (v.eq) {
    if (!v.settings || !has(v.settings.groups, v.eq.group)) out.push(`eq: no settings group "${v.eq.group}"`);
    for (const [w, fields] of [[v.eq.power.write, ["value"]], [v.eq.param.write, ["param", "value"]]] as const) {
      if (!has(v.messages, w)) out.push(`eq: "${w}" is not a message`);
      else {
        for (const f of fields) needField("eq", w, f);
        needArgs("eq", w, undefined);
      }
    }
  }
  return out;
}

/**
 * The blocked-cmd scan of one view: a send or request on a blocked message's cmd whose payload can be the blocked
 * one's bytes (and a block that names no message).
 */
function blockIssues(v: View, scope: Pick<Scope, "scan" | "blocks" | "scanAll" | "candidates">): string[] {
  const out: string[] = [];
  // a block must not be bypassed by another name that sends the same bytes
  const isBlocked = new Set(v.blocked);
  for (const b of new Set([...scope.blocks, ...(scope.scanAll ?? [])])) if (!has(v.messages, b)) out.push(`blocked "${b}" is not a message`);
  // a send on a blocked message's cmd is refused only when its payload can be the blocked one's: a block is per
  // message, so a safe send that shares the cmd and differs in a pinned byte (or its length) stays usable
  const shapes = new Map<string, FrameShape | null>();
  const shapeOfMessage = (n: string): FrameShape | null => {
    if (!shapes.has(n)) {
      const l = messageLayout(v.messages[n], v.layouts);
      shapes.set(n, l ? frameShape(l, v.endian, v.layouts) : null);
    }
    return shapes.get(n)!;
  };
  const canBe = (n: string, b: string) => {
    // under another header (sysex-plain) its frame starts with other bytes
    if (v.messages[n].header !== v.messages[b].header) return false;
    const [x, y] = [shapeOfMessage(n), shapeOfMessage(b)];
    return !x || !y || shapesMeet(x, y);
  };
  const scanBlocks = (names: Iterable<string>, blocks: string[]) => {
    const fixed = new Map<string, string[]>();
    const templated: [string, string][] = [];
    for (const b of blocks) {
      if (!has(v.messages, b)) continue;
      const c = v.messages[b].cmd;
      if (c.includes("{")) templated.push([b, c]);
      else fixed.set(c, [...(fixed.get(c) ?? []), b]);
    }
    if (!fixed.size && !templated.length) return;
    for (const n of names) {
      if (out.length >= MAX_ISSUES) return;
      const m = v.messages[n];
      if (isBlocked.has(n) || (m.dir !== "send" && m.dir !== "request")) continue;
      const hits = m.cmd.includes("{")
        ? [...fixed].filter(([c]) => cmdsOverlap(m.cmd, c)).flatMap(([, b]) => b)
        : [...(fixed.get(m.cmd) ?? [])];
      for (const [b, c] of templated) if (cmdsOverlap(m.cmd, c)) hits.push(b);
      for (const b of hits) if (canBe(n, b)) out.push(`message ${n}: cmd ${m.cmd} can send the blocked "${b}"`);
    }
  };
  scanBlocks(scope.scan, scope.blocks);
  for (const b of scope.scanAll ?? []) {
    if (!has(v.messages, b)) continue;
    scanBlocks(scope.candidates ? scope.candidates(b) : Object.keys(v.messages), [b]);
  }
  return out;
}

// ---- first contact: safe reads and read-backs ----------------------------------------------------------------------

/** A message and its payload layout, looked up by name in the map as one firmware sees it. */
export interface MessageLookup {
  message(name: string): Message | undefined;
  /** the message's payload layout (`{fields: []}` without one), or undefined where the map lacks the layout */
  payload(name: string): Layout | undefined;
}

/** A write's read-back, resolved: the read, the message that answers it, and the field pairs. */
export interface ReadBackPair {
  request: string;
  reply: string;
  /** the read's request field filled from the write's field */
  inputs: { request: string; send: string }[];
  /** the read's reply field that must equal the write's field */
  compare: { reply: string; send: string }[];
}

/** A field the caller gives a value for: not padding, a const, a checksum or a copy of another field. */
function carriesValue(f: Field): boolean {
  if (f.type === "pad") return false;
  if (f.type === "string") return true;
  if (f.type === "bytes") return f.const === undefined;
  return f.const === undefined && f.checksum === undefined && f.copyOf === undefined;
}

/** A field encode refuses to write without the caller's value: a scalar with no default (bytes and strings go empty). */
function needsValue(f: Field): boolean {
  return f.type !== "pad" && f.type !== "bytes" && f.type !== "string" && carriesValue(f) && f.default === undefined;
}

/** The `{arg}` placeholder names of a cmd template. */
function placeholdersOf(cmd: string): string[] {
  return cmd.split(" ").filter((t) => t.startsWith("{")).map((t) => t.slice(1, -1));
}

/**
 * A write's `readBack` resolved against the map, with whatever keeps it from working: the read must be a safeRead
 * request with a fixed cmd and one reply, every pair must name real fields, the write's values must fill every field
 * the read needs, and the inputs and compared fields together must cover every value the write carries, so the write
 * can be rebuilt from the read (the echo write) and nothing it sets goes unchecked.
 */
export function resolveReadBack(write: string, look: MessageLookup): { pair?: ReadBackPair; problems: string[] } {
  const m = look.message(write);
  const rb = m?.readBack;
  if (!m || rb === undefined) return { problems: [] };
  const where = `message ${write} readBack`;
  const problems: string[] = [];
  if (m.dir !== "send" && m.dir !== "request") problems.push(`${where}: only a write has a read-back, not a ${m.dir}`);
  if (m.safeRead !== undefined) problems.push(`${where}: a safeRead request writes nothing to read back`);
  if (rb === false) return { problems };
  const request = typeof rb === "string" ? rb : rb.request;
  const r = look.message(request);
  if (!r) return { problems: [...problems, `${where}: "${request}" is not a message`] };
  if (r.dir !== "request" || r.safeRead === undefined) problems.push(`${where}: "${request}" must be a safeRead request`);
  if (r.cmd.includes("{")) problems.push(`${where}: "${request}" needs a fixed cmd`);
  if (r.reply?.list) problems.push(`${where}: "${request}" is answered with a list, and a read-back needs one reply`);
  const reply = r.reply?.message ?? request;
  const [wl, rl, pl] = [look.payload(write), look.payload(request), look.message(reply) && look.payload(reply)];
  // a missing message or layout is reported by the message checks
  if (!wl || !rl || !pl) return { problems };
  const fields = (l: Layout) => new Map(l.fields.filter((f) => f.type !== "pad").map((f) => [f.name, f]));
  const [W, R, P] = [fields(wl), fields(rl), fields(pl)];
  const inputs = typeof rb === "object" && rb.inputs ? rb.inputs : [...R].filter(([k, f]) => carriesValue(f) && W.has(k) && carriesValue(W.get(k)!)).map(([k]) => ({ request: k, send: k }));
  const given = new Set(inputs.map((i) => i.send));
  const compare =
    typeof rb === "object" && rb.compare
      ? rb.compare
      : [...P].filter(([k, f]) => carriesValue(f) && W.has(k) && carriesValue(W.get(k)!) && !given.has(k)).map(([k]) => ({ reply: k, send: k }));
  for (const i of inputs) {
    if (!R.has(i.request)) problems.push(`${where}: "${request}" has no field "${i.request}"`);
    if (!W.has(i.send)) problems.push(`${where}: "${write}" has no field "${i.send}"`);
  }
  for (const c of compare) {
    if (!P.has(c.reply)) problems.push(`${where}: "${reply}" has no field "${c.reply}"`);
    if (!W.has(c.send)) problems.push(`${where}: "${write}" has no field "${c.send}"`);
  }
  if (!compare.length) problems.push(`${where}: "${reply}" shares no field with "${write}", so there is nothing to compare`);
  const filled = new Set(inputs.map((i) => i.request));
  for (const [k, f] of R) if (needsValue(f) && !filled.has(k)) problems.push(`${where}: nothing of "${write}" fills "${request}" field "${k}"`);
  const covered = new Set([...given, ...compare.map((c) => c.send)]);
  for (const [k, f] of W) if (carriesValue(f) && !covered.has(k)) problems.push(`${where}: "${write}" field "${k}" is neither an input nor compared`);
  return problems.length ? { problems } : { pair: { request, reply, inputs, compare }, problems };
}

/**
 * A safeRead is a request the probe can send as the map gives it (a firmware may still block it): its placeholders
 * and every field that needs a value filled by its own `fields` and `args`, which name nothing the request lacks.
 * Read-backs are resolved as above.
 */
function probeIssues(v: View, layoutOf: (m: Message) => Layout | undefined): string[] {
  const out: string[] = [];
  const look: MessageLookup = {
    message: (n) => (has(v.messages, n) ? v.messages[n] : undefined),
    payload: (n) => (has(v.messages, n) ? layoutOf(v.messages[n]) : { fields: [] }),
  };
  for (const [n, m] of Object.entries(v.messages)) {
    if (out.length >= MAX_ISSUES) break;
    if (m.readBack !== undefined) out.push(...resolveReadBack(n, look).problems);
    const s = m.safeRead;
    if (s === undefined) continue;
    const where = `message ${n} safeRead`;
    if (m.dir !== "request") out.push(`${where}: only a request is a safe read, not a ${m.dir}`);
    if (m.ack) out.push(`${where}: an acknowledged message is a write`);
    const l = look.payload(n);
    const fields = new Map((l?.fields ?? []).filter((f) => f.type !== "pad").map((f) => [f.name, f]));
    const given = s === true ? {} : (s.fields ?? {});
    const args = s === true ? {} : (s.args ?? {});
    for (const k of Object.keys(given)) if (l && !fields.has(k)) out.push(`${where}: "${n}" has no field "${k}"`);
    for (const [k, f] of fields) if (needsValue(f) && !has(given, k)) out.push(`${where}: no value for field "${k}"`);
    const ph = placeholdersOf(m.cmd);
    for (const a of ph) if (!has(args, a)) out.push(`${where}: no value for {${a}}`);
    for (const a of Object.keys(args)) if (!ph.includes(a)) out.push(`${where}: "${n}" has no {${a}} in its cmd`);
  }
  return out;
}

const INT_RANGE: Record<Exclude<ScalarType, "f32">, [number, number]> = {
  u8: [0, 0xff],
  i8: [-0x80, 0x7f],
  u16: [0, 0xffff],
  i16: [-0x8000, 0x7fff],
  u32: [0, 0xffffffff],
  i32: [-0x80000000, 0x7fffffff],
};

/** Whether a raw value can be stored in the type exactly. */
function fitsRaw(type: ScalarType, n: number): boolean {
  if (type === "f32") return Number.isFinite(n) && Math.fround(n) === n;
  const [lo, hi] = INT_RANGE[type];
  return Number.isInteger(n) && n >= lo && n <= hi;
}

/** A field sent as narrow digits instead of its type's own bytes: septets (7 bits a byte) or nibbles (4). */
function digitsOf(f: ScalarField): { n: number; bits: number; what: string } | undefined {
  if (f.septets !== undefined) return { n: f.septets, bits: 7, what: "septets" };
  if (f.nibbles !== undefined) return { n: f.nibbles, bits: 4, what: "nibbles" };
  return undefined;
}

/** Largest raw value a field can carry on the wire: its type's, narrowed by its bits, septets or nibbles. */
function rawMax(f: ScalarField): number {
  const hi = f.type === "f32" ? Infinity : INT_RANGE[f.type][1];
  if (f.bits !== undefined) return Math.min(hi, 2 ** f.bits.width - 1);
  const d = digitsOf(f);
  return d === undefined ? hi : Math.min(hi, 2 ** (d.bits * d.n) - 1);
}

function fitsField(f: ScalarField, n: number): boolean {
  return fitsRaw(f.type, n) && n <= rawMax(f);
}

function typeNameOfWire(f: ScalarField): string {
  const d = digitsOf(f);
  return d === undefined ? f.type : `${d.n} ${d.what}`;
}

function typeName(f: ScalarField): string {
  if (f.bits !== undefined) return `${f.bits.width} bits`;
  const d = digitsOf(f);
  return d === undefined ? f.type : `${f.type} in ${d.n} ${d.what}`;
}

function checkField(where: string, f: Field, at: number, layoutEnd: number, enums: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (f.type === "bytes" && f.const !== undefined && parseHex(f.const).length > f.length) {
    out.push(`${where}: const is longer than ${f.length} bytes`);
  }
  if (f.type === "string" && f.open && f.repeat) out.push(`${where}: an open string cannot repeat`);
  // a short tail would be read as a free entry, so free needs every byte present
  if (f.type === "string" && f.open && f.free !== undefined) out.push(`${where}: an open string cannot have free`);
  if (f.type === "bytes" || f.type === "string" || f.type === "pad") return out;
  if (f.invert && f.bits === undefined) out.push(`${where}: invert goes with bits`);
  if (f.enum && !has(enums, f.enum)) out.push(`${where}: unknown enum "${f.enum}"`);
  if (f.min !== undefined && f.max !== undefined && f.min > f.max) out.push(`${where}: min ${f.min} > max ${f.max}`);
  if (f.const !== undefined && !fitsField(f, f.const)) out.push(`${where}: const ${f.const} does not fit ${typeName(f)}`);
  if (f.nullAs !== undefined && !fitsField(f, f.nullAs)) out.push(`${where}: nullAs ${f.nullAs} does not fit ${typeName(f)}`);
  if (f.not !== undefined) {
    for (const n of f.not) if (!fitsField(f, n)) out.push(`${where}: not ${n} does not fit ${typeName(f)}`);
    // a const or a checksum leaves nothing to rule out; a nullAs it rules out could never be written
    if (f.const !== undefined || f.checksum) out.push(`${where}: not goes with no const or checksum`);
    if (f.nullAs !== undefined && f.not.includes(f.nullAs)) out.push(`${where}: not rules out its own nullAs ${f.nullAs}`);
    if (f.default !== undefined && f.not.includes(Math.round(f.default * (f.scale ?? 1) + (f.bias ?? 0)))) out.push(`${where}: not rules out its own default ${f.default}`);
  }
  if (f.septets !== undefined && f.nibbles !== undefined) out.push(`${where}: septets or nibbles, not both`);
  const digits = digitsOf(f);
  if (digits !== undefined) {
    if (f.type !== "u8" && f.type !== "u16" && f.type !== "u32") out.push(`${where}: ${digits.what} go with an unsigned integer type`);
    if (f.checksum) out.push(`${where}: a checksum is not sent as ${digits.what}`);
  }
  if (f.bits !== undefined) {
    if (f.type !== "u8" && f.type !== "u16" && f.type !== "u32") out.push(`${where}: bits go with an unsigned integer type`);
    else if (f.bits.shift + f.bits.width > (digits !== undefined ? digits.bits * digits.n : 8 * SCALAR_SIZE[f.type])) {
      out.push(`${where}: bits ${f.bits.shift}+${f.bits.width} do not fit ${typeNameOfWire(f)}`);
    }
    if (f.checksum) out.push(`${where}: bits go with no checksum`);
  }
  if (f.default !== undefined) {
    const d = f.default;
    if ((f.min !== undefined && d < f.min) || (f.max !== undefined && d > f.max)) out.push(`${where}: default ${d} is outside min..max`);
    const wire = d * (f.scale ?? 1) + (f.bias ?? 0);
    if (!f.saturate && !fitsField(f, f.type === "f32" ? Math.fround(wire) : Math.round(wire))) {
      out.push(`${where}: default ${d} does not fit ${typeName(f)}`);
    }
  }
  if (f.checksum) {
    const c = f.checksum;
    const size = SCALAR_SIZE[f.type];
    if (f.repeat) out.push(`${where}: a checksum cannot repeat`);
    if (f.type !== "u8" && f.type !== "u16" && f.type !== "u32") out.push(`${where}: a checksum is unsigned`);
    if (c.to === "self" && c.from > at) out.push(`${where}: checksum starts at ${c.from}, after the field at ${at}`);
    if (c.to === "end" && c.from > layoutEnd) out.push(`${where}: checksum starts at ${c.from}, past the end ${layoutEnd}`);
    // the sum may not cover its own bytes
    if (c.to === "end" && c.from < at + size) out.push(`${where}: checksum range covers the field itself`);
  }
  return out;
}

/** Keys the field a packed tail's length or record offset lives in may have: a plain unsigned count, which encode writes as is. */
const LENGTH_FIELD_KEYS = new Set(["name", "type", "offset", "endian", "septets", "note"]);
const plainCount = (f: Field | undefined): f is ScalarField =>
  f !== undefined && (f.type === "u8" || f.type === "u16" || f.type === "u32") && Object.keys(f).every((k) => LENGTH_FIELD_KEYS.has(k));

function packedIssues(where: string, l: Layout, p: PackedTail, openString: boolean): string[] {
  const out: string[] = [];
  const w = `${where}: packed ${p.name}`;
  // the packed bytes run to the end of the payload, so nothing else may decide where the payload ends
  if (l.minSize !== undefined || l.maxSize !== undefined) out.push(`${w}: a layout with packed data has no minSize or maxSize`);
  if (openString) out.push(`${w}: a layout with packed data has no open string`);
  if (l.fields.some((f) => f.name === p.name)) out.push(`${w}: a field has the same name`);
  if (p.packing === "8to7" && p.topBits === undefined) out.push(`${w}: 8to7 packing needs topBits`);
  if (p.packing !== "8to7" && p.topBits !== undefined) out.push(`${w}: topBits go with 8to7 packing only`);
  if (p.pieces !== undefined) {
    const x = p.pieces;
    if (p.layout !== undefined) out.push(`${w}: a tail is read with a layout or is a piece of a record, not both`);
    if (x.layout === undefined) out.push(`${w}: pieces on a tail name the record's layout`);
    for (const k of ["size", "maxPiece", "deadlineMs"] as const) if (x[k] !== undefined) out.push(`${w}: pieces ${k} is a reply rule's, not a tail's (the record's layout sets the size, maxLength the piece)`);
    if (typeof x.offset !== "object") out.push(`${w}: pieces on a tail take their offset from a field, not the address`);
    else {
      const field = x.offset.field;
      const f = l.fields.find((y) => y.name === field);
      if (!plainCount(f)) out.push(`${w}: pieces offset field "${field}" is not a plain unsigned field (no repeat, const, scale, enum or other keys)`);
      if (field === p.lengthField) out.push(`${w}: the pieces offset field and lengthField are one field`);
    }
  }
  if (p.lengthField !== undefined) {
    const f = l.fields.find((x) => x.name === p.lengthField);
    if (!plainCount(f)) out.push(`${w}: lengthField "${p.lengthField}" is not a plain unsigned field (no repeat, const, scale, enum or other keys)`);
    else if (rawMax(f) < p.maxLength) out.push(`${w}: lengthField "${p.lengthField}" cannot hold maxLength ${p.maxLength}`);
  }
  // the fields are encoded and decoded apart from the packed bytes, so a sum to the end would leave them out
  if (l.fields.some((f) => f.type !== "bytes" && f.type !== "string" && f.type !== "pad" && f.checksum?.to === "end")) {
    out.push(`${w}: a layout with packed data has no checksum to the end`);
  }
  return out;
}

function checkLayout(where: string, l: Layout, enums: Record<string, unknown>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let elements = 0;
  for (const f of l.fields) {
    if (seen.has(f.name)) out.push(`${where}: field ${f.name} twice`);
    seen.add(f.name);
    elements += count(f);
  }
  if (elements > MAX_ELEMENTS) return [...out, `${where}: ${elements} elements, at most ${MAX_ELEMENTS}`];
  const end = layoutEnd(l);
  if (end > MAX_BYTES) return [...out, `${where}: larger than ${MAX_BYTES} bytes`];
  if (l.size !== undefined && fieldsEnd(l) > l.size) out.push(`${where}: fields reach byte ${fieldsEnd(l)}, past size ${l.size}`);
  if (l.minSize !== undefined && l.maxSize !== undefined && l.minSize > l.maxSize) out.push(`${where}: minSize > maxSize`);
  const fields = placed(l);
  for (const { f, at } of fields) out.push(...checkField(`${where}: field ${f.name}`, f, at, end, enums));
  // an address field has no place, but its const, min, max and default still fit its type (a wrapped const moves it)
  for (const f of l.fields.filter(isAddressField)) out.push(...checkField(`${where}: field ${f.name}`, f, 0, end, enums));
  const open = fields.find(({ f }) => f.type === "string" && f.open);
  if (open && fields.some(({ f, at }) => f !== open.f && at + extent(f) > open.at)) out.push(`${where}: open string ${open.f.name} must be the last field`);
  if (l.packed) out.push(...packedIssues(where, l, l.packed, open !== undefined));
  for (const { f } of fields) {
    if (f.type === "bytes" || f.type === "string" || f.type === "pad" || f.copyOf === undefined) continue;
    const t = l.fields.find((x) => x.name === f.copyOf);
    const scalar = t && t.type !== "bytes" && t.type !== "string" && t.type !== "pad";
    if (!t || !scalar || t.repeat || t.copyOf !== undefined || t === f) out.push(`${where}: field ${f.name}: copyOf "${f.copyOf}" is not a single scalar field`);
    if (f.const !== undefined || f.repeat || f.checksum) out.push(`${where}: field ${f.name}: copyOf goes with no const, repeat or checksum`);
  }
  for (const f of l.fields) {
    if (f.type === "bytes" || f.type === "string" || f.type === "pad" || !f.enumBy) continue;
    const at = `${where}: field ${f.name}: enumBy`;
    if (f.enum !== undefined) out.push(`${at} goes without enum`);
    // a repeat's values are read and taken as numbers only: each element would need a selector of its own
    if (f.repeat) out.push(`${at} goes on a single field, not a repeat`);
    const by = l.fields.find((x) => x.name === f.enumBy!.field);
    const sel = by && by.type !== "bytes" && by.type !== "string" && by.type !== "pad" ? by : undefined;
    if (!sel || sel === f || sel.repeat || sel.enum === undefined) out.push(`${at}: "${f.enumBy.field}" is not a single field of this payload that reads an enum`);
    else if (has(enums, sel.enum)) {
      const keys = enums[sel.enum] as Record<string, number>;
      for (const k of Object.keys(f.enumBy.enums)) if (!has(keys, k)) out.push(`${at}: "${k}" is not a key of enum ${sel.enum}`);
    }
    for (const e of new Set(Object.values(f.enumBy.enums))) if (!has(enums, e)) out.push(`${at}: unknown enum "${e}"`);
  }
  // a checksum may not sum another checksum's bytes: the result would depend on the order they are written
  const sums = fields.filter(({ f }) => f.type !== "bytes" && f.type !== "string" && f.type !== "pad" && f.checksum);
  for (const { f, at } of sums) {
    const c = (f as ScalarField).checksum!;
    const to = c.to === "self" ? at : end;
    for (const o of sums) {
      if (o.f === f) continue;
      if (o.at < to && o.at + elementSize(o.f) > c.from) out.push(`${where}: field ${f.name}: checksum range covers checksum field ${o.f.name}`);
    }
  }
  return out;
}

// ---- the codec -------------------------------------------------------------------------------------------------

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

/** The map forbids this message on this firmware: a refusal, never sent. */
export class BlockedMessageError extends ProtocolError {
  constructor(message: string) {
    super(message);
    this.name = "BlockedMessageError";
  }
}

export function elementSize(f: Field): number {
  return f.type === "bytes" || f.type === "string" || f.type === "pad" ? f.length : (digitsOf(f)?.n ?? SCALAR_SIZE[f.type]);
}

/** Septets and nibbles go least significant first unless the field itself says "be"; the map's default endian never flips them. */
const digitsLe = (f: ScalarField) => f.endian !== "be";

/** The whole wire value under a field: the type's own bytes, or its septets or nibbles in the field's byte order. */
function readWire(f: ScalarField, v: DataView, at: number, le: boolean): number {
  const d = digitsOf(f);
  if (d === undefined) return readScalar(v, at, f.type, le);
  const lo = digitsLe(f);
  let n = 0;
  for (let i = 0; i < d.n; i++) {
    const b = v.getUint8(at + (lo ? i : d.n - 1 - i));
    if (b >= 2 ** d.bits) throw new ProtocolError(`field ${f.name}: byte ${b} is not ${d.bits}-bit`);
    n += b * 2 ** (d.bits * i);
  }
  return n;
}

function writeWire(f: ScalarField, v: DataView, at: number, le: boolean, x: number): void {
  const d = digitsOf(f);
  if (d === undefined) return writeScalar(v, at, f.type, le, x);
  const lo = digitsLe(f);
  for (let i = 0; i < d.n; i++) v.setUint8(at + (lo ? i : d.n - 1 - i), Math.floor(x / 2 ** (d.bits * i)) % 2 ** d.bits);
}

/** Write one scalar element: the whole wire value, or only its bits (inverted where the map says), keeping the rest. */
function putScalar(f: ScalarField, v: DataView, at: number, le: boolean, x: number): void {
  if (f.bits === undefined) return writeWire(f, v, at, le, x);
  const mask = 2 ** f.bits.width - 1;
  const old = readWire(f, v, at, le);
  const cleared = old - (Math.floor(old / 2 ** f.bits.shift) % (mask + 1)) * 2 ** f.bits.shift;
  writeWire(f, v, at, le, cleared + (f.invert ? mask - x : x) * 2 ** f.bits.shift);
}

function getScalar(f: ScalarField, v: DataView, at: number, le: boolean): number {
  const n = readWire(f, v, at, le);
  if (f.bits === undefined) return n;
  const got = Math.floor(n / 2 ** f.bits.shift) % 2 ** f.bits.width;
  return f.invert ? 2 ** f.bits.width - 1 - got : got;
}

function shapeOf(f: Field): number[] {
  return f.repeat ? f.repeat.dims : [];
}

function count(f: Field): number {
  return shapeOf(f).reduce((a, b) => a * b, 1);
}

function stridesOf(f: Field): number[] {
  const dims = shapeOf(f);
  if (f.repeat?.strides) return f.repeat.strides;
  const s = Array<number>(dims.length);
  let acc = elementSize(f);
  for (let i = dims.length - 1; i >= 0; i--) {
    s[i] = acc;
    acc *= dims[i];
  }
  return s;
}

/** Bytes from the field's offset to the end of its last-reaching element, computed without enumerating elements. */
function extent(f: Field): number {
  const dims = shapeOf(f);
  if (dims.some((d) => d === 0)) return 0;
  const strides = stridesOf(f);
  return dims.reduce((n, d, i) => n + (d - 1) * strides[i], 0) + elementSize(f);
}

/** Element offsets relative to the field's own offset, in row-major order. */
export function elementOffsets(f: Field): number[] {
  if (count(f) > MAX_ELEMENTS) throw new ProtocolError(`field ${f.name} repeats too often`);
  const dims = shapeOf(f);
  const strides = stridesOf(f);
  const out: number[] = [];
  const walk = (d: number, base: number) => {
    if (d === dims.length) return void out.push(base);
    for (let i = 0; i < dims[d]; i++) walk(d + 1, base + i * strides[d]);
  };
  walk(0, 0);
  return out;
}

/**
 * Field offsets resolved: a field without an offset starts right after the furthest byte any earlier field reaches. An
 * address field takes no payload bytes, so it has no place.
 */
function placed(l: Layout): { f: Field; at: number }[] {
  let end = 0;
  return l.fields.filter((f) => !isAddressField(f)).map((f) => {
    const at = f.offset ?? end;
    end = Math.max(end, at + extent(f));
    return { f, at };
  });
}

function fieldsEnd(l: Layout): number {
  return placed(l).reduce((n, { f, at }) => Math.max(n, at + extent(f)), 0);
}

function layoutEnd(l: Layout): number {
  return l.size ?? fieldsEnd(l);
}

export function layoutSize(l: Layout): number {
  return layoutEnd(l);
}

// ---- address fields (roland-address) ---------------------------------------------------------------------------

/** A field that moves its message's address instead of taking payload bytes. */
export type AddressField = ScalarField & { address: NonNullable<ScalarField["address"]> };

export const isAddressField = (f: Field): f is AddressField => f.type !== "bytes" && f.type !== "string" && f.type !== "pad" && f.address !== undefined;

/** An address (7-bit digits, most significant first) as a number; throws on a digit with the high bit set. */
export function addressValue(address: ArrayLike<number>): number {
  let n = 0;
  for (let i = 0; i < address.length; i++) {
    if (address[i] > 0x7f) throw new ProtocolError(`address byte ${address[i]} is not 7-bit`);
    n = n * 128 + address[i];
  }
  return n;
}

/** A number as an address of `width` 7-bit digits, most significant first; throws when it does not fit. */
export function addressBytes(n: number, width: number): Uint8Array {
  if (!Number.isSafeInteger(n) || n < 0 || n >= 128 ** width) throw new ProtocolError(`address ${n} does not fit ${width} 7-bit bytes`);
  const out = new Uint8Array(width);
  for (let i = width - 1; i >= 0; i--, n = Math.floor(n / 128)) out[i] = n % 128;
  return out;
}

const addressOfHex = (h: string): number => addressValue(parseHex(h));

/** The wire value an address field takes for what a caller gives (an enum key, a number, nothing for its default). */
function addressWire(f: AddressField, x: unknown, ctx: CodecContext, where: string): number {
  const b = new Uint8Array(8);
  const v = new DataView(b.buffer);
  const le = (f.endian ?? ctx.endian) === "le";
  writeElement(f, v, b, 0, x, ctx, where);
  return getScalar(f, v, 0, le);
}

/** What an address field's wire value reads as (an enum key where the enum names it, else the number). */
function addressRead(f: AddressField, wire: number, ctx: CodecContext, where: string): unknown {
  const b = new Uint8Array(8);
  const v = new DataView(b.buffer);
  const le = (f.endian ?? ctx.endian) === "le";
  putScalar(f, v, 0, le, wire);
  return readElement(f, v, b, 0, ctx, where);
}

/** How far an address field at a wire value moves the address; a table that has no entry for it refuses. */
function addressStep(f: AddressField, wire: number, ctx: CodecContext, tables: Protocol["addresses"], where: string): number {
  if (f.address.stride !== undefined) return wire * addressOfHex(f.address.stride);
  const table = tables && has(tables, f.address.table!) ? tables[f.address.table!] : {};
  const e = enumOf(ctx, f);
  // the enum names values before scale and bias, as readElement reads them
  const n = (wire - (f.bias ?? 0)) / (f.scale ?? 1);
  const key = e && Object.keys(e).find((k) => e[k] === n);
  if (key === undefined || !has(table, key)) throw new SafetyError(`${where}: the device map gives no address for ${f.name} ${key ?? wire}; nothing was sent`);
  return addressOfHex(table[key]);
}

/** An address field's choices: (wire value, offset) pairs, or a run of wire values lo..hi each `stride` apart. */
type AddressTerm = { options: [number, number][] } | { lo: number; hi: number; stride: number };

/** The wire values an address field may take, as the search walks them; one the field refuses is left out. */
function addressTerm(f: AddressField, ctx: CodecContext, tables: Protocol["addresses"]): AddressTerm {
  const listed = (xs: unknown[]): AddressTerm => {
    const options: [number, number][] = [];
    for (const x of xs) {
      try {
        const w = addressWire(f, x, ctx, f.name);
        options.push([w, addressStep(f, w, ctx, tables, f.name)]);
      } catch {
        // a value the field or its table refuses is never sent
      }
    }
    return { options };
  };
  if (f.address.table !== undefined) return listed(Object.keys(tables?.[f.address.table] ?? {}));
  if (f.const !== undefined) return { options: [[f.const, f.const * addressOfHex(f.address.stride!)]] };
  if (f.allowed) return listed(f.allowed);
  const [typeLo, typeHi] = INT_RANGE[f.type as "u8" | "u16" | "u32"] ?? [0, 0];
  const wire = (x: number) => Math.round(x * (f.scale ?? 1) + (f.bias ?? 0));
  const lo = Math.max(typeLo, f.min === undefined ? typeLo : wire(f.min));
  const hi = Math.min(typeHi, f.max === undefined ? typeHi : wire(f.max));
  return { lo, hi, stride: addressOfHex(f.address.stride!) };
}

const termMin = (t: AddressTerm) => ("options" in t ? Math.min(...t.options.map(([, o]) => o)) : t.lo * t.stride);
const termMax = (t: AddressTerm) => ("options" in t ? Math.max(...t.options.map(([, o]) => o)) : t.hi * t.stride);

/**
 * Whether no two sets of values reach the same address: sufficient, as for the digits of a number, when each term's
 * smallest step between its own offsets is wider than every term with smaller steps can spread. A table with two
 * keys at one offset fails it, as does a parameter range that runs into the next block's area.
 */
function addressesApart(terms: AddressTerm[]): boolean {
  const stepOf = (t: AddressTerm): number => {
    if (!("options" in t)) return t.hi > t.lo ? t.stride : Infinity;
    const o = [...new Set(t.options.map(([, x]) => x))].sort((a, b) => a - b);
    if (o.length < t.options.length) return 0;
    let step = Infinity;
    for (let i = 1; i < o.length; i++) step = Math.min(step, o[i] - o[i - 1]);
    return step;
  };
  const order = terms.map((t) => ({ step: stepOf(t), spread: termMax(t) - termMin(t) })).sort((a, b) => b.step - a.step);
  let below = 0;
  for (let k = order.length - 1; k >= 0; k--) {
    if (order[k].step === 0 || (order[k].spread > 0 && order[k].step <= below)) return false;
    below += order[k].spread;
  }
  return true;
}

/** The search gave up before it could answer. */
class AddressSearchTooLong extends Error {}

/**
 * Wire values for the terms (in their order) whose offsets sum into lo..hi: up to `limit` of them. Runs are walked
 * widest stride first, each narrowed to what the rest can still reach, so nested areas (a block, then a parameter in
 * it) take a step or two per field. Throws AddressSearchTooLong past MAX_ADDRESS_STEPS.
 */
function searchAddress(terms: AddressTerm[], lo: number, hi: number, limit: number): number[][] {
  const order = terms.map((t, i) => ({ t, i })).sort((a, b) => ("options" in a.t ? 0 : 1) - ("options" in b.t ? 0 : 1) || ("stride" in b.t ? b.t.stride : 0) - ("stride" in a.t ? a.t.stride : 0));
  const restMin: number[] = [0];
  const restMax: number[] = [0];
  for (let k = order.length - 1; k >= 0; k--) {
    restMin.unshift(restMin[0] + termMin(order[k].t));
    restMax.unshift(restMax[0] + termMax(order[k].t));
  }
  const found: number[][] = [];
  const chosen: number[] = new Array(terms.length);
  let steps = 0;
  const go = (k: number, from: number, to: number): void => {
    if (++steps > MAX_ADDRESS_STEPS) throw new AddressSearchTooLong();
    if (k === order.length) {
      if (from <= 0 && 0 <= to) found.push([...chosen]);
      return;
    }
    const { t, i } = order[k];
    const [rMin, rMax] = [restMin[k + 1], restMax[k + 1]];
    if ("options" in t) {
      for (const [w, o] of t.options) {
        if (found.length >= limit) return;
        if (o + rMin > to || o + rMax < from) continue;
        chosen[i] = w;
        go(k + 1, from - o, to - o);
      }
      return;
    }
    const first = Math.max(t.lo, Math.ceil((from - rMax) / t.stride));
    const last = Math.min(t.hi, Math.floor((to - rMin) / t.stride));
    for (let w = first; w <= last && found.length < limit; w++) {
      chosen[i] = w;
      go(k + 1, from - w * t.stride, to - w * t.stride);
    }
  };
  if (terms.every((t) => !("options" in t) || t.options.length)) go(0, lo, hi);
  return found;
}

export function writeScalar(v: DataView, at: number, type: ScalarType, le: boolean, x: number): void {
  switch (type) {
    case "u8": return v.setUint8(at, x);
    case "i8": return v.setInt8(at, x);
    case "u16": return v.setUint16(at, x, le);
    case "i16": return v.setInt16(at, x, le);
    case "u32": return v.setUint32(at, x, le);
    case "i32": return v.setInt32(at, x, le);
    case "f32": return v.setFloat32(at, x, le);
  }
}

export function readScalar(v: DataView, at: number, type: ScalarType, le: boolean): number {
  switch (type) {
    case "u8": return v.getUint8(at);
    case "i8": return v.getInt8(at);
    case "u16": return v.getUint16(at, le);
    case "i16": return v.getInt16(at, le);
    case "u32": return v.getUint32(at, le);
    case "i32": return v.getInt32(at, le);
    case "f32": return v.getFloat32(at, le);
  }
}

/** Bytes as space-separated hex pairs, the form cmds and frames are written in. */
export const hexOf = (b: ArrayLike<number>): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(" ");

export function parseHex(s: string): Uint8Array {
  return s === "" ? new Uint8Array(0) : Uint8Array.from(s.split(" "), (h) => parseInt(h, 16));
}

/** latin1 text of some bytes, in chunks so a long string cannot overflow the call stack. */
function latin1(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 1024) s += String.fromCharCode(...b.subarray(i, i + 1024));
  return s;
}

export interface CodecContext {
  endian: "le" | "be";
  enums: Record<string, Record<string, number>>;
  /** Decode raw wire values: no sentinel, scale, bias or enum applied. */
  raw?: boolean;
  /** The shared layouts, for a packed tail read with one of them. */
  layouts?: Record<string, Layout>;
}

type Values = Record<string, unknown>;

/** Nested arrays of `dims` shape -> flat element list; every level must have its dim's length. */
function flatten(x: unknown, dims: number[], where: string): unknown[] {
  if (dims.length === 0) return [x];
  if (!Array.isArray(x)) throw new ProtocolError(`${where}: expected an array`);
  const [n, ...rest] = dims;
  if (x.length !== n) throw new ProtocolError(`${where}: ${n} values expected, got ${x.length}`);
  return x.flatMap((y, i) => flatten(y, rest, `${where}[${i}]`));
}

function nest(flat: unknown[], dims: number[]): unknown {
  if (dims.length === 0) return flat[0];
  const [n, ...rest] = dims;
  const per = rest.reduce((a, b) => a * b, 1);
  return Array.from({ length: n }, (_, i) => nest(flat.slice(i * per, (i + 1) * per), rest));
}

function checksumOf(f: ScalarField, at: number, b: Uint8Array): number {
  const c = f.checksum!;
  const to = c.to === "self" ? at : b.length;
  let sum = 0;
  for (let i = c.from; i < to; i++) sum += b[i];
  if (c.mask !== undefined) sum &= c.mask;
  return sum % (INT_RANGE[f.type as "u8" | "u16" | "u32"][1] + 1);
}

/**
 * Encode values into a layout. Unknown value names are refused, so a typo never silently sends zeros.
 * With `base`, the result is a copy of it with only the given fields (and consts and checksums) rewritten: bytes the
 * layout does not name, or the caller does not pass, stay as they were (re-slotting a file, editing one field).
 */
export function encodeLayout(l: Layout, values: Values, ctx: CodecContext, where = "layout", base?: Uint8Array): Uint8Array {
  if (l.packed) return encodePacked(l, values, ctx, where, base);
  const known = new Set(l.fields.map((f) => f.name));
  for (const k of Object.keys(values)) if (!known.has(k)) throw new ProtocolError(`${where}: no field "${k}"`);
  const out = base ? base.slice() : new Uint8Array(layoutSize(l));
  if (base && base.length < layoutSize(l)) throw new ProtocolError(`${where}: base of ${base.length} bytes, need ${layoutSize(l)}`);
  // the load check's block-per-message test counts on maxSize capping what a send can be
  if (base && l.maxSize !== undefined && base.length > l.maxSize) throw new ProtocolError(`${where}: base of ${base.length} bytes, at most ${l.maxSize}`);
  const v = new DataView(out.buffer);
  const sums: { f: ScalarField; at: number }[] = [];
  for (const { f, at } of placed(l)) {
    const offs = elementOffsets(f);
    const shape = shapeOf(f);
    if (f.type === "pad") {
      if (!base) for (const o of offs) out.fill(f.fill ?? 0, at + o, at + o + f.length);
      continue;
    }
    if (f.type !== "bytes" && f.type !== "string" && f.checksum) {
      sums.push({ f, at });
      continue;
    }
    let given = values[f.name];
    if (given === undefined && f.type !== "bytes" && f.type !== "string" && f.copyOf !== undefined) given = values[f.copyOf];
    if (base && given === undefined && (f.type === "string" || f.const === undefined)) {
      // a value kept from the base is still one this message never has (the load check counts on it)
      if (f.type !== "bytes" && f.type !== "string" && f.not) {
        for (const o of offs) {
          const n = getScalar(f, v, at + o, (f.endian ?? ctx.endian) === "le");
          if (f.not.includes(n)) throw new ProtocolError(`${where}.${f.name}: the base holds ${n}, a value this message never has`);
        }
      }
      continue;
    }
    // a short list fills up with the field's default (a short sample array is zero-padded)
    if (shape.length === 1 && Array.isArray(given) && given.length < shape[0] && f.type !== "bytes" && f.type !== "string" && f.default !== undefined) {
      given = [...given, ...Array(shape[0] - given.length).fill(undefined)];
    }
    const elems = given === undefined ? offs.map(() => undefined) : flatten(given, shape, `${where}.${f.name}`);
    offs.forEach((o, i) => writeElement(f, v, out, at + o, elems[i], ctx, `${where}.${f.name}`));
  }
  for (const { f, at } of sums) writeScalar(v, at, f.type, (f.endian ?? ctx.endian) === "le", checksumOf(f, at, out));
  return out;
}

function writeElement(f: Field, v: DataView, out: Uint8Array, at: number, x: unknown, ctx: CodecContext, where: string): void {
  if (f.type === "pad") return;
  if (f.type === "bytes") {
    const b = f.const !== undefined ? parseHex(f.const) : x === undefined ? new Uint8Array(0) : toBytes(x, where);
    if (b.length > f.length) throw new ProtocolError(`${where}: ${b.length} bytes do not fit ${f.length}`);
    out.fill(f.fill ?? 0, at, at + f.length);
    out.set(b, at);
    return;
  }
  if (f.type === "string") {
    if (x === null && f.free !== undefined) return void out.fill(f.free, at, at + f.length);
    if (x === undefined) x = "";
    if (typeof x !== "string") throw new ProtocolError(`${where}: expected a string`);
    out.fill(0, at, at + f.length);
    for (let i = 0; i < Math.min(x.length, f.length - 1); i++) out[at + i] = x.charCodeAt(i) & 0xff;
    return;
  }
  const le = (f.endian ?? ctx.endian) === "le";
  if (x === null && f.const === undefined) {
    if (f.nullAs === undefined) throw new ProtocolError(`${where}: no value`);
    return putScalar(f, v, at, le, f.nullAs);
  }
  if (f.const !== undefined) return putScalar(f, v, at, le, f.const);
  let n: number;
  if (x === undefined) {
    if (f.default === undefined) throw new ProtocolError(`${where}: no value`);
    n = f.default;
  } else if (typeof x === "boolean") n = x ? 1 : 0;
  else if (typeof x === "string") n = enumValue(ctx, f, x, where);
  else if (typeof x === "number" && Number.isFinite(x)) n = x;
  else throw new ProtocolError(`${where}: expected a number`);
  if (f.allowed && !f.allowed.includes(n)) throw new ProtocolError(`${where}: ${n} is not an allowed value (${f.allowed.join(", ")})`);
  if ((f.min !== undefined && n < f.min) || (f.max !== undefined && n > f.max)) {
    if (!f.saturate) throw new ProtocolError(`${where}: ${n} is outside ${f.min ?? "-inf"}..${f.max ?? "inf"}`);
    n = Math.max(f.min ?? -Infinity, Math.min(f.max ?? Infinity, n));
  }
  n = n * (f.scale ?? 1) + (f.bias ?? 0);
  if (f.type !== "f32") {
    n = Math.round(n);
    const lo = INT_RANGE[f.type][0];
    const hi = rawMax(f);
    if (n < lo || n > hi) {
      if (!f.saturate) throw new ProtocolError(`${where}: ${n} does not fit ${typeName(f)}`);
      n = Math.max(lo, Math.min(hi, n));
    }
  }
  // the message never holds it: written, it would read as another message on the same cmd
  if (f.not?.includes(n)) throw new ProtocolError(`${where}: ${n} is a value this message never has`);
  putScalar(f, v, at, le, n);
}

function toBytes(x: unknown, where: string): Uint8Array {
  if (x instanceof Uint8Array) return x;
  if (typeof x === "string" && HEX_BYTES.test(x)) return parseHex(x);
  if (Array.isArray(x) && x.every((b) => Number.isInteger(b) && b >= 0 && b <= 0xff)) return Uint8Array.from(x as number[]);
  throw new ProtocolError(`${where}: expected bytes`);
}

function enumOf(ctx: CodecContext, f: ScalarField): Record<string, number> | undefined {
  return f.enum !== undefined && has(ctx.enums, f.enum) ? ctx.enums[f.enum] : undefined;
}

function enumValue(ctx: CodecContext, f: ScalarField, key: string, where: string): number {
  const e = enumOf(ctx, f);
  if (!e) throw new ProtocolError(`${where}: expected a number`);
  if (!has(e, key)) {
    // an enum left empty is one the map can't give for this firmware (see ProtocolCodec.enumsInDoubt): say so, not "one of"
    const keys = Object.keys(e);
    throw new ProtocolError(keys.length ? `${where}: "${key}" is not one of ${keys.join(", ")}` : `${where}: "${key}" can't be sent: the map has no ${f.enum} list for this firmware`);
  }
  return e[key];
}

/** Where a layout's open string starts: a payload that reaches it is long enough. */
function openStringAt(l: Layout): number | undefined {
  return placed(l).find(({ f }) => f.type === "string" && f.open)?.at;
}

/**
 * Decode a layout. Pads are skipped; strings stop at NUL; enum fields come back as keys where known. Consts and
 * checksums are verified: a mismatch is a malformed message, not data.
 */
export function decodeLayout(l: Layout, b: Uint8Array, ctx: CodecContext, where = "layout"): Values {
  if (l.packed) return decodePacked(l, b, ctx, where);
  const need = l.minSize ?? openStringAt(l) ?? layoutSize(l);
  if (b.length < need) throw new ProtocolError(`${where}: ${b.length} bytes, need ${need}`);
  if (l.maxSize !== undefined && b.length > l.maxSize) throw new ProtocolError(`${where}: ${b.length} bytes, at most ${l.maxSize}`);
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out: Values = {};
  for (const { f, at } of placed(l)) {
    if (f.type === "pad") continue;
    const open = f.type === "string" && f.open;
    if (!open && at + extent(f) > b.length) throw new ProtocolError(`${where}.${f.name}: past the end of ${b.length} bytes`);
    if (f.type !== "bytes" && f.type !== "string" && f.checksum) {
      const stored = readScalar(v, at, f.type, (f.endian ?? ctx.endian) === "le");
      const want = checksumOf(f, at, b);
      if (stored !== want) throw new ProtocolError(`${where}.${f.name}: checksum ${stored}, expected ${want}`);
      out[f.name] = stored;
      continue;
    }
    const elems = elementOffsets(f).map((o) => readElement(f, v, b, at + o, ctx, `${where}.${f.name}`));
    out[f.name] = nest(elems, shapeOf(f));
  }
  return out;
}

function readElement(f: Field, v: DataView, b: Uint8Array, at: number, ctx: CodecContext, where: string): unknown {
  if (f.type === "bytes") {
    const got = b.slice(at, at + f.length);
    if (f.const !== undefined) {
      const want = parseHex(f.const);
      if (want.some((x, i) => got[i] !== x)) throw new ProtocolError(`${where}: expected ${f.const}`);
    }
    return got;
  }
  if (f.type === "string") {
    const s = b.subarray(at, at + f.length);
    if (f.free !== undefined && s.every((x) => x === f.free)) return null;
    const end = s.indexOf(0);
    return latin1(s.subarray(0, end < 0 ? s.length : end));
  }
  if (f.type === "pad") return undefined;
  let n = getScalar(f, v, at, (f.endian ?? ctx.endian) === "le");
  if (f.const !== undefined && n !== f.const) throw new ProtocolError(`${where}: expected ${f.const}, got ${n}`);
  if (f.not?.includes(n)) throw new ProtocolError(`${where}: ${n} is a value this message never has`);
  if (ctx.raw) return n;
  if (f.nullAs !== undefined && n === f.nullAs) return null;
  n = (n - (f.bias ?? 0)) / (f.scale ?? 1);
  const e = enumOf(ctx, f);
  if (e) {
    const k = Object.keys(e).find((x) => e[x] === n);
    if (k !== undefined) return k;
  }
  return n;
}

const CRC_SEPTETS = 5;

/** The 8to7 bit order: the map check requires it, and a layout built past that check is refused, never read bit-0 first. */
function topBitsOf(p: PackedTail, w: string): TopBits {
  if (p.topBits === undefined) throw new ProtocolError(`${w}: 8to7 packing needs topBits`);
  return p.topBits;
}

const nibbleOrder = (p: PackedTail): NibbleOrder => (p.packing === "nibbles-hi-lo" ? "hi-lo" : "lo-hi");

/** The tail's bytes as sent. */
function packTail(p: PackedTail, data: Uint8Array, w: string): Uint8Array {
  return p.packing === "8to7" ? pack8to7(data, topBitsOf(p, w)) : splitNibbles(data, nibbleOrder(p));
}

/** The tail's bytes as received, unpacked; throws on bytes no data packs to. */
function unpackTail(p: PackedTail, body: Uint8Array, w: string): Uint8Array {
  return p.packing === "8to7" ? unpack7to8(body, topBitsOf(p, w)) : joinNibbles(body, nibbleOrder(p));
}

/** Bytes `n` data bytes pack to. */
const packedSize = (p: PackedTail, n: number): number => (p.packing === "8to7" ? packedLength(n) : 2 * n);

/** Data bytes `len` packed bytes hold, or null when no data packs to that many. */
function unpackedSize(p: PackedTail, len: number): number | null {
  if (p.packing === "8to7") return unpackedLength(len);
  return len % 2 === 0 ? len / 2 : null;
}

/** The layout that reads a tail's bytes, from the codec's shared layouts. */
function tailLayout(p: PackedTail, ctx: CodecContext, w: string): Layout {
  const t = p.layout!;
  if (!ctx.layouts || !has(ctx.layouts, t)) throw new ProtocolError(`${w}: no layout "${t}" in the device map`);
  return ctx.layouts[t];
}

/**
 * The fields, then the packed tail's value packed, then its CRC. The tail's value is required (with `base` too, which
 * covers the fields only); its length field is written from it, and a different length passed for it is refused. With
 * `layout`, the tail is that layout encoded from the values named by its fields (with `base`, over the base's tail
 * unpacked).
 */
function encodePacked(l: Layout, values: Values, ctx: CodecContext, where: string, base?: Uint8Array): Uint8Array {
  const { packed, ...fixed } = l;
  const p = packed!;
  const w = `${where}.${p.name}`;
  if (p.packing === "8to7") topBitsOf(p, w);
  const at = layoutSize(fixed);
  let data: Uint8Array;
  let rest: Values;
  if (p.layout !== undefined) {
    const t = tailLayout(p, ctx, w);
    const inTail = new Set(t.fields.map((f) => f.name));
    const tail = Object.fromEntries(Object.entries(values).filter(([k]) => inTail.has(k)));
    rest = Object.fromEntries(Object.entries(values).filter(([k]) => !inTail.has(k)));
    // with `base`, the tail's fields not passed keep the base's: its tail is unpacked to serve as the tail's base (a
    // base with no tail, or a short one, is refused rather than ignored)
    let tailBase: Uint8Array | undefined;
    if (base) {
      try {
        tailBase = unpackTail(p, base.subarray(at, base.length - (p.crc ? CRC_SEPTETS : 0)), w);
      } catch (e) {
        throw new ProtocolError(`${w}: the base's packed bytes do not unpack: ${(e as Error).message}`);
      }
    }
    data = encodeLayout(t, tail, ctx, w, tailBase);
  } else {
    const { [p.name]: given, ...others } = values;
    if (given === undefined) throw new ProtocolError(`${w}: no value`);
    data = toBytes(given, w);
    rest = others;
  }
  if (data.length > p.maxLength) throw new ProtocolError(`${w}: ${data.length} bytes, at most ${p.maxLength}`);
  if (p.lengthField !== undefined) {
    const n = has(rest, p.lengthField) ? rest[p.lengthField] : undefined;
    if (n !== undefined && n !== data.length) throw new ProtocolError(`${where}.${p.lengthField}: ${String(n)}, but ${p.name} has ${data.length} bytes`);
    rest[p.lengthField] = data.length;
  }
  const head = encodeLayout(fixed, rest, ctx, where, base?.subarray(0, at));
  const body = packTail(p, data, w);
  const crc = p.crc ? septets32(crc32(data, p.crc.finalXor)) : new Uint8Array(0);
  const out = new Uint8Array(head.length + body.length + crc.length);
  out.set(head, 0);
  out.set(body, head.length);
  out.set(crc, head.length + body.length);
  return out;
}

/**
 * The fields, then the packed tail unpacked: its length (from its field, or from what is left) and CRC checked. With
 * `layout`, the tail's fields join the others.
 */
function decodePacked(l: Layout, b: Uint8Array, ctx: CodecContext, where: string): Values {
  const { packed, ...fixed } = l;
  const p = packed!;
  const w = `${where}.${p.name}`;
  // an 8to7 tail without its bit order is refused before anything is read
  if (p.packing === "8to7") topBitsOf(p, w);
  const at = layoutSize(fixed);
  if (b.length < at) throw new ProtocolError(`${where}: ${b.length} bytes, need ${at}`);
  const out = decodeLayout(fixed, b.subarray(0, at), ctx, where);
  const crcLen = p.crc ? CRC_SEPTETS : 0;
  const tail = b.subarray(at);
  if (tail.length < crcLen) throw new ProtocolError(`${w}: ${tail.length} bytes, need ${crcLen} for the CRC`);
  const body = tail.subarray(0, tail.length - crcLen);
  const n = p.lengthField !== undefined ? (out[p.lengthField] as number) : unpackedSize(p, body.length);
  if (n === null) {
    const why = p.packing === "8to7" ? "end with a lone high-bits byte" : "are an odd count, not nibble pairs";
    throw new ProtocolError(`${w}: ${body.length} packed bytes ${why}`);
  }
  // the count is checked against the cap before anything is unpacked
  if (n > p.maxLength) throw new ProtocolError(`${w}: ${n} bytes, at most ${p.maxLength}`);
  if (p.lengthField !== undefined && packedSize(p, n) !== body.length) {
    throw new ProtocolError(`${w}: ${body.length} packed bytes, but ${p.lengthField} says ${n} bytes (${packedSize(p, n)} packed)`);
  }
  let data: Uint8Array;
  try {
    data = unpackTail(p, body, w);
  } catch (e) {
    throw new ProtocolError(`${w}: ${(e as Error).message}`);
  }
  if (p.crc) {
    const want = septets32(crc32(data, p.crc.finalXor));
    const got = tail.subarray(body.length);
    if (!sameBytes(got, want)) throw new ProtocolError(`${w}: CRC ${hexOf(got)}, expected ${hexOf(want)}`);
  }
  if (p.layout === undefined) out[p.name] = data;
  else Object.assign(out, decodeLayout(tailLayout(p, ctx, w), data, ctx, w));
  return out;
}

/**
 * The byte range [start, end) that a field's elements cover, or those under leading indexes: `fieldSpan(l, "params", 1)`
 * is everything under index 1 of the first dimension (the second scene, in a patch). Strides are never negative, so the first and last elements bound it.
 */
export function fieldSpan(l: Layout, field: string, ...prefix: number[]): [number, number] {
  const hit = placed(l).find((p) => p.f.name === field);
  if (!hit) throw new ProtocolError(`no field "${field}"`);
  const shape = shapeOf(hit.f);
  if (prefix.length > shape.length) throw new ProtocolError(`${field} takes ${shape.length} indexes`);
  const rest = shape.slice(prefix.length);
  if (rest.some((d) => d === 0)) return [hit.at, hit.at];
  const first = offsetOf(l, field, ...prefix, ...rest.map(() => 0));
  const last = offsetOf(l, field, ...prefix, ...rest.map((d) => d - 1));
  return [first, last + elementSize(hit.f)];
}

/** Byte offset of one element of a layout field: `offsetOf(layout, "levels", row, column)`. */
export function offsetOf(l: Layout, field: string, ...index: number[]): number {
  const hit = placed(l).find((p) => p.f.name === field);
  if (!hit) throw new ProtocolError(`no field "${field}"`);
  const { f, at } = hit;
  const shape = shapeOf(f);
  if (index.length !== shape.length) throw new ProtocolError(`${field} takes ${shape.length} indexes`);
  const strides = stridesOf(f);
  return index.reduce((o, i, d) => {
    if (!Number.isInteger(i) || i < 0 || i >= shape[d]) throw new ProtocolError(`${field}: index ${i} is not 0..${shape[d] - 1}`);
    return o + i * strides[d];
  }, at);
}

// ---- the protocol, resolved for one firmware ----------------------------------------------------------------------

/** A message whose packed tail is a piece of a record, as `codec.pieceSpec` reads it from the map. */
export interface PieceSpec {
  tail: PackedTail;
  /** The record's layout and its size in bytes. */
  layout: string;
  size: number;
  offsetField: string;
  /** The fields that differ from piece to piece: the offset, the tail, its length and any checksum. */
  vary: Set<string>;
}

/** One piece of a record as received: its byte offset in the record, its bytes, and the piece's other fields. */
export interface Piece {
  offset: number;
  bytes: Uint8Array;
  /** The fields that are the same in every piece of one record (a slot): they tell one record's pieces from another's. */
  key: Values;
}

export interface Encoded {
  name: string;
  cmd: Uint8Array;
  /** Uncompressed payload; the framing engine compresses and frames it. */
  payload: Uint8Array;
  dir: Message["dir"];
  /** The wire values of the message's address fields (roland-address), which moved its cmd's address: its reply's
   * address moves with them, and its address fields read as them. */
  address?: Record<string, number>;
  /** sysex-plain: the entry of transport.frame.headers it is sent under; omitted: the device's header. */
  header?: string;
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Deep equality of decoded raw values (numbers, strings, bytes, nested arrays). */
function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Uint8Array && b instanceof Uint8Array) return sameBytes(a, b);
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => sameValue(x, b[i]));
  return a === b;
}

/** A message the map's unsettled choices leave in doubt on this unit: refused, and nothing was sent. */
export class ChoiceOpenError extends SafetyError {
  /** the choices still open */
  readonly choices: string[];
  constructor(message: string, choices: string[]) {
    super(message);
    this.name = "ChoiceOpenError";
    this.choices = choices;
  }
}

/** One way to read a layout under the map's choices: the option taken for each, and the layout with it applied. */
interface Way {
  options: Record<string, string>;
  layout: Layout;
}

const choiceFields = (l: Layout): ChoiceField[] => l.fields.filter(isChoiceField);

/** Whether a decoded value is one the field allows: within its range, and a known key where it names an enum. */
function within(f: ScalarField, v: unknown): boolean {
  if (v === null) return true;
  if (f.enum !== undefined) return typeof v === "string";
  return typeof v === "number" && (f.min === undefined || v >= f.min) && (f.max === undefined || v <= f.max);
}

/** Who sends a message: the device (its replies and notifies) or the host (its requests and sends). */
export type Side = "device" | "host";
const SIDE_DIRS: Record<Side, readonly Message["dir"][]> = { device: ["reply", "notify"], host: ["request", "send"] };

/**
 * The protocol for one firmware: base entries with that firmware's replacements applied and its blocked messages
 * refused. A firmware the map does not list gets the base protocol. The driver asks for everything by name.
 */
export class ProtocolCodec {
  readonly protocol: Protocol;
  readonly firmware: string | undefined;
  /** True when the map lists this firmware, by its own key or in a range; false means the base protocol, unverified for it. */
  readonly firmwareListed: boolean;
  /** The key of the firmware entry this firmware reads (its own, or the one whose range holds it), or undefined. */
  readonly firmwareEntry: string | undefined;
  /**
   * Enums that some firmware entry replaces, on a firmware the map does not list: the map can't say which list this
   * firmware has, so they read as empty (a value stays a number, and no key is sent) rather than as the base's guess.
   */
  readonly enumsInDoubt: readonly string[];
  private readonly messages: Record<string, Message>;
  private readonly layouts: Record<string, Layout>;
  private readonly blocked: Set<string>;
  /** Frame shapes by message name, filled on first use. */
  private readonly shapes = new Map<string, FrameShape>();
  /** Each message's address terms, worked out once: messagesForCmd asks every message for every incoming frame. */
  private readonly terms = new Map<string, AddressTerm[]>();
  readonly enums: Record<string, Record<string, number>>;
  readonly constants: Record<string, number>;
  readonly timing: Transport["timing"];
  readonly settings: Protocol["settings"];
  readonly eq: Protocol["eq"];
  /** The safety floor for this firmware: the base rules made stricter by the firmware's, never looser. */
  readonly safety: SafetyRules | undefined;
  readonly display: Display | undefined;
  readonly audio: Audio | undefined;
  readonly host: Host | undefined;
  readonly scratch: Protocol["scratch"];
  /** the mode this view is for, where the map has modes; undefined for the map's own entries */
  readonly mode: string | undefined;
  /** the block parameter tables as this mode sees them */
  readonly parameters: Protocol["parameters"];
  /** this mode's stand-ins */
  private readonly use: ModeUse;
  /** this unit's checks: the choices it has settled, and the entries it has contradicted */
  private readonly checks: UnitChecks | undefined;
  /** settled choices: the checks' own, so a choice the unit settles here is kept for it */
  private readonly pins: Record<string, string>;

  /**
   * `mode` is the mode the unit reports, where the map has modes (a key of its mode enum): each name the mode stands
   * an entry in for reads as that entry, and one it maps to null is gone. Without it, the map's own entries.
   */
  constructor(protocol: Protocol, firmware?: string, checks?: UnitChecks, mode?: string) {
    this.protocol = protocol;
    this.checks = checks;
    this.pins = checks?.pins ?? {};
    this.firmware = firmware;
    this.firmwareEntry = firmwareEntryKey(protocol.firmwares, firmware);
    this.firmwareListed = this.firmwareEntry !== undefined;
    const d = this.firmwareListed ? protocol.firmwares![this.firmwareEntry!] : {};
    // a firmware the map does not list: an enum some listed firmware replaces may differ on it too, so it is not guessed
    // (only the base's own enums: one a firmware adds is named by that firmware's own entries alone)
    const doubt =
      firmware === undefined || this.firmwareListed
        ? []
        : [...new Set(Object.values(protocol.firmwares ?? {}).flatMap((x) => Object.keys(x.enums ?? {})))].filter((e) => has(protocol.enums ?? {}, e));
    this.enumsInDoubt = doubt;
    if (mode !== undefined && !modeNames(protocol).includes(mode)) throw new ProtocolError(`the device map has no mode "${mode}"`);
    this.mode = mode;
    const use = (this.use = mode === undefined ? {} : modeUse(protocol, mode));
    this.messages = inMode({ ...protocol.messages, ...d.messages }, use.messages);
    this.layouts = inMode({ ...protocol.layouts, ...d.layouts }, use.layouts);
    // (a firmware may only add blocks that can't be bypassed, so in doubt every block some firmware keeps on stays on)
    const inDoubt = (e: string) =>
      e === "noBypass" ? Object.assign({}, protocol.enums?.noBypass, ...Object.values(protocol.firmwares ?? {}).map((x) => x.enums?.noBypass)) : {};
    this.enums = inMode({ ...protocol.enums, ...d.enums, ...Object.fromEntries(doubt.map((e) => [e, inDoubt(e)])) }, use.enums);
    this.constants = inMode({ ...protocol.constants, ...d.constants }, use.constants);
    this.parameters = protocol.parameters && { ...protocol.parameters, groups: groupsInMode(protocol, use) };
    this.timing = protocol.transport.timing;
    this.settings = protocol.settings;
    this.eq = protocol.eq;
    this.display = protocol.display;
    this.audio = protocol.audio;
    this.host = protocol.host;
    this.scratch = protocol.scratch;
    const base = protocol.safety;
    const extra = d.safety;
    this.safety = base && {
      ...base,
      modelChange: {
        ...base.modelChange,
        scenes: extra?.modelChangeScenes ? base.modelChange.scenes.filter((sc) => extra.modelChangeScenes!.includes(sc)) : base.modelChange.scenes,
      },
      haltingModels: { ...base.haltingModels, types: [...new Set([...base.haltingModels.types, ...(extra?.haltingTypes ?? [])])] },
    };
    // a firmware can only add to the blocked list, never lift a base block
    this.blocked = new Set([...(protocol.blocked ?? []), ...(d.blocked ?? [])]);
    // a name a mode stands a blocked message in for is blocked in that mode: the block is on the bytes
    for (const [n, sub] of Object.entries(use.messages ?? {})) if (sub !== null && this.blocked.has(sub)) this.blocked.add(n);
  }

  /**
   * The map-check entry (map-checks.ts) for one the driver names: in a mode, the entry the mode stands in for
   * it (`getPresetBass` for `getPreset`, `setBypassBass/amp1` for `setBypass/amp1`), and a parameter of a stand-in
   * group named with that group (`param/amp1/12/ampBass`), so what the unit shows in one mode is never held against
   * another's entries. In a mode that stands in layouts or enums, a message entry is tagged with the mode
   * (`getPreset@bass`): the same message reads otherwise there.
   */
  entry(e: string): string {
    const [kind, ...rest] = e.split("/");
    if (kind === "choice") return e;
    if (kind === "param") {
      const subs = this.use.groups ?? {};
      const g = Object.keys(this.parameters?.groups ?? {}).find((n) => {
        const x = this.parameters!.groups[n];
        return x.blocks?.includes(rest[0]) || x.types?.includes(rest[0]);
      });
      const sub = g !== undefined && has(subs, g) ? subs[g] : null;
      return sub === null || rest.length !== 2 ? e : `${e}/${sub}`;
    }
    // a mode that stands in layouts or enums may read a message otherwise than the map read without a mode does:
    // its entries are tagged with the mode, and fingerprinted as that mode reads them
    const swaps = Object.keys(this.use.layouts ?? {}).length + Object.keys(this.use.enums ?? {}).length > 0;
    return [`${this.mapMessage(kind)}${swaps ? `@${this.mode}` : ""}`, ...rest].join("/");
  }

  /** The map's own message a driver name reads as here: in a mode, the one the mode stands in for it. */
  mapMessage(name: string): string {
    const subs = this.use.messages ?? {};
    return (has(subs, name) ? subs[name] : null) ?? name;
  }

  private get ctx(): CodecContext {
    return { endian: this.protocol.transport.endian, enums: this.enums, layouts: this.layouts };
  }

  message(name: string): Message {
    if (!has(this.messages, name)) throw new ProtocolError(`no message "${name}" in the device map`);
    return this.messages[name];
  }

  isBlocked(name: string): boolean {
    return this.blocked.has(name);
  }

  layout(name: string): Layout {
    if (!has(this.layouts, name)) throw new ProtocolError(`no layout "${name}" in the device map`);
    return this.layouts[name];
  }

  payloadLayout(name: string): Layout {
    const p = this.message(name).payload;
    return p === undefined ? { fields: [] } : typeof p === "string" ? this.layout(p) : p;
  }

  /** A message's address fields (roland-address): each moves the message's address instead of taking payload bytes. */
  addressFields(name: string): AddressField[] {
    return this.payloadLayout(name).fields.filter(isAddressField);
  }

  /** The wire values of a message's address fields for the values a caller gives (enum keys, numbers, defaults). */
  private addressWires(name: string, values: Values): Record<string, number> {
    return Object.fromEntries(this.addressFields(name).map((f) => [f.name, addressWire(f, values[f.name], this.ctx, `${name}.${f.name}`)]));
  }

  /** The cmd with its address moved by the address fields' wire values (a message without any keeps the map's). */
  private moved(name: string, wires: Record<string, number>, args: Record<string, number> = {}): Uint8Array {
    const cmd = this.cmd(name, args);
    const fields = this.addressFields(name);
    const t = this.protocol.transport;
    if (!fields.length || t.framing !== "roland-address") return cmd;
    const at = t.inner.cmdLength - t.inner.addressBytes;
    let a = addressValue(cmd.subarray(at));
    for (const f of fields) {
      if (!has(wires, f.name)) throw new ProtocolError(`${name}: no value for its address field ${f.name}`);
      a += addressStep(f, wires[f.name], this.ctx, this.protocol.addresses, name);
    }
    cmd.set(addressBytes(a, t.inner.addressBytes), at);
    return cmd;
  }

  /** The cmd a message goes with for these values: the map's, its address moved by the message's address fields. */
  cmdFor(name: string, values: Values = {}, args: Record<string, number> = {}): Uint8Array {
    return this.moved(name, this.addressWires(name, values), args);
  }

  /** The cmd that answers a sent request: its reply message's, the address moved as the request's was. */
  replyCmd(sent: Encoded): Uint8Array {
    return this.moved(this.replyName(sent.name), sent.address ?? {});
  }

  /**
   * The wire values of a message's address fields that move its address to the one `cmd` names, or undefined when no
   * values reach it, more than one set does (the map can't tell them apart), the command bytes differ, or the search
   * gives up. A message without address fields: {} for its own cmd.
   */
  addressOf(name: string, cmd: Uint8Array): Record<string, number> | undefined {
    const fields = this.addressFields(name);
    const t = this.protocol.transport;
    const base = this.message(name).cmd.split(" ");
    if (!fields.length || t.framing !== "roland-address") {
      return base.length === cmd.length && base.every((x, i) => x.startsWith("{") || parseInt(x, 16) === cmd[i]) ? {} : undefined;
    }
    const at = t.inner.cmdLength - t.inner.addressBytes;
    if (cmd.length !== base.length || base.slice(0, at).some((x, i) => parseInt(x, 16) !== cmd[i])) return undefined;
    const target = addressValue(cmd.subarray(at)) - addressValue(parseHex(base.slice(at).join(" ")));
    let found: number[][];
    try {
      found = searchAddress(this.termsOf(name), target, target, 2);
    } catch (e) {
      if (e instanceof AddressSearchTooLong) return undefined;
      throw e;
    }
    return found.length === 1 ? Object.fromEntries(fields.map((f, i) => [f.name, found[0][i]])) : undefined;
  }

  /** What a message's address fields read as at these wire values (enum keys where named); `raw` keeps the numbers. */
  private addressValues(name: string, wires: Record<string, number>, raw = false): Values {
    const ctx = raw ? { ...this.ctx, raw: true } : this.ctx;
    return Object.fromEntries(this.addressFields(name).filter((f) => has(wires, f.name)).map((f) => [f.name, addressRead(f, wires[f.name], ctx, `${name}.${f.name}`)]));
  }

  /** The cmd bytes, with `{arg}` placeholders filled. */
  cmd(name: string, args: Record<string, number> = {}): Uint8Array {
    const m = this.message(name);
    return Uint8Array.from(m.cmd.split(" "), (t) => {
      if (!t.startsWith("{")) return parseInt(t, 16);
      const k = t.slice(1, -1);
      const x = has(args, k) ? args[k] : undefined;
      if (!Number.isInteger(x) || x! < 0 || x! > 0xff) throw new ProtocolError(`message ${name}: cmd argument ${k} must be a byte`);
      return x!;
    });
  }

  /**
   * Encode a message. With `base`, the payload is a copy of it with only the given fields (and consts and checksums)
   * rewritten, as for a file sent back with a new id.
   */
  encode(name: string, fields: Values = {}, args: Record<string, number> = {}, base?: Uint8Array): Encoded {
    const m = this.message(name);
    if (this.blocked.has(name)) {
      throw new BlockedMessageError(`the device map blocks "${name}" on firmware ${this.firmware ?? "(any)"}`);
    }
    if (m.dir === "reply" || m.dir === "notify") throw new ProtocolError(`"${name}" comes from the device; it is not sent`);
    fields = this.writeEnumsBy(this.payloadLayout(name), fields, name);
    const wires = this.addressWires(name, fields);
    const out: Encoded = { name, cmd: this.moved(name, wires, args), payload: this.encodeChoosing(this.payloadLayout(name), fields, name, base), dir: m.dir };
    if (Object.keys(wires).length) out.address = wires;
    if (m.header !== undefined) out.header = m.header;
    noteCodecUse(this.protocol, "encode", this.mapMessage(name));
    return out;
  }

  /** A reply's or notification's payload as the device sends it, for a simulated device or a test. Address fields take no payload bytes: cmdFor() moves the cmd by them. */
  encodeFromDevice(name: string, fields: Values = {}): Uint8Array {
    const m = this.message(name);
    if (m.dir !== "reply" && m.dir !== "notify") throw new ProtocolError(`"${name}" is sent to the device; encode() builds it`);
    const l = this.payloadLayout(name);
    const out = this.encodeChoosing(l, this.writeEnumsBy(l, fields, name), name);
    noteCodecUse(this.protocol, "encode", this.mapMessage(name));
    return out;
  }

  /**
   * Decode a message's payload. With `cmd` (the message's own, as it came), its address fields are read from the
   * address there; a cmd they can't reach is refused. Without it, address fields are left out.
   */
  decode(name: string, payload: Uint8Array, cmd?: Uint8Array): Values {
    const l = this.payloadLayout(name);
    const values = this.decodeChoosing(l, payload, name);
    let out = values;
    if (cmd !== undefined && this.addressFields(name).length) {
      const wires = this.addressOf(name, cmd);
      if (!wires) throw new ProtocolError(`${name}: its address fields reach no single value set at ${hexOf(cmd)}`);
      out = { ...values, ...this.addressValues(name, wires) };
    }
    // noted once the whole message reads, address included: a refused cmd is no decode
    noteCodecUse(this.protocol, "decode", this.mapMessage(name));
    return this.readEnumsBy(l, out);
  }

  /**
   * Decode the answer to a sent request: with the pieces' `layout` for an answer joined from them, else as the reply
   * message; either way the reply's address fields read as the request's (the answer came at its moved address).
   */
  decodeReply(sent: Encoded, payload: Uint8Array): Values {
    const layout = this.pieces(sent.name)?.layout;
    const reply = this.replyName(sent.name);
    const read = layout === undefined ? this.decode(reply, payload) : this.decodeLayout(layout, payload);
    // an enumBy field may be chosen by an address field, known only once the request's address values are in
    return this.readEnumsBy(layout === undefined ? this.payloadLayout(reply) : this.layout(layout), { ...read, ...this.addressValues(reply, sent.address ?? {}) });
  }

  /**
   * The enum a field of a message's payload or a layout reads under these values: its own `enum`, or the one its
   * `enumBy` picks for the other field's value (undefined where it picks none).
   */
  fieldEnum(layoutOrMessage: string, field: string, values: Values = {}): string | undefined {
    const l = has(this.layouts, layoutOrMessage) ? this.layouts[layoutOrMessage] : this.payloadLayout(layoutOrMessage);
    const f = this.field(layoutOrMessage, field);
    return f.type === "bytes" || f.type === "string" || f.type === "pad" ? undefined : this.chosenEnum(l, f, values);
  }

  private chosenEnum(l: Layout, f: ScalarField, values: Values): string | undefined {
    if (!f.enumBy) return f.enum;
    const sel = l.fields.find((x) => x.name === f.enumBy!.field);
    let v = values[f.enumBy.field];
    if (typeof v === "number" && sel && "enum" in sel && sel.enum !== undefined) v = this.enumKey(sel.enum, v) ?? v;
    return typeof v === "string" && has(f.enumBy.enums, v) ? f.enumBy.enums[v] : undefined;
  }

  /** The layout's enumBy fields, each read as a key of the enum chosen for it; a number that enum lacks stays one. */
  private readEnumsBy(l: Layout, values: Values): Values {
    let out = values;
    for (const f of l.fields) {
      if (f.type === "bytes" || f.type === "string" || f.type === "pad" || !f.enumBy || typeof values[f.name] !== "number") continue;
      const e = this.chosenEnum(l, f, values);
      const k = e === undefined ? undefined : this.enumKey(e, values[f.name] as number);
      if (k !== undefined) out = { ...out, [f.name]: k };
    }
    return out;
  }

  /** The layout's enumBy fields given as keys, as their numbers; a key the chosen enum lacks is refused. */
  private writeEnumsBy(l: Layout, values: Values, where: string): Values {
    let out = values;
    for (const f of l.fields) {
      if (f.type === "bytes" || f.type === "string" || f.type === "pad" || !f.enumBy || typeof values[f.name] !== "string") continue;
      const v = values[f.name] as string;
      const e = this.chosenEnum(l, f, values);
      if (e === undefined || !has(this.enums, e) || !has(this.enums[e], v)) {
        // an enum left empty is one the map can't give for this firmware (see enumsInDoubt): say so, not "one of"
        if (e !== undefined && has(this.enums, e) && !Object.keys(this.enums[e]).length) {
          throw new ProtocolError(`${where}.${f.name}: "${v}" can't be sent: the map has no ${e} list for this firmware`);
        }
        const known = e !== undefined && has(this.enums, e) ? `one of ${Object.keys(this.enums[e]).join(", ")}` : `named for this ${f.enumBy.field}`;
        throw new ProtocolError(`${where}.${f.name}: "${v}" is not ${known}`);
      }
      out = { ...out, [f.name]: this.enums[e][v] };
    }
    return out;
  }

  /**
   * Every way the map's choices allow a layout to be read: one per open choice's option, the settled option alone. A
   * choice this unit has contradicted is refused: nothing it would decide is sent or believed.
   */
  private ways(l: Layout, name: string, every = false): Way[] {
    const fields = choiceFields(l);
    if (!fields.length) return [{ options: {}, layout: l }];
    const choices = this.protocol.choices ?? {};
    let ways: Record<string, string>[] = [{}];
    for (const c of new Set(fields.map((f) => f.choice))) {
      const why = this.checks?.suspect(choiceEntry(c));
      if (why) {
        throw new SafetyError(`this unit contradicted the device map on ${choices[c].what} (${why}), so Patchsprite won't send or read anything that depends on it until the map is fixed`);
      }
      // a read is read every way, so a pin made on another unit of the model can be ruled out (see decodeChoosing)
      const options = !every && has(this.pins, c) && has(choices[c].options, this.pins[c]) ? [this.pins[c]] : Object.keys(choices[c].options);
      ways = ways.flatMap((w) => options.map((o) => ({ ...w, [c]: o })));
    }
    return ways.map((options) => ({
      options,
      layout: { ...l, fields: l.fields.map((f) => (isChoiceField(f) ? { ...f, ...choices[f.choice].options[options[f.choice]] } : f)) },
    }));
  }

  /** The choices of a layout still open on this unit. */
  private open(l: Layout): string[] {
    const choices = this.protocol.choices ?? {};
    return [...new Set(choiceFields(l).map((f) => f.choice))].filter((c) => !(has(this.pins, c) && has(choices[c].options, this.pins[c])));
  }

  /**
   * Refuses a message whose payload names a choice this unit has not settled, even where this value encodes the same
   * every way: an echo of it would read back right under either option, so it proves nothing about the choice.
   */
  refuseOpenChoices(name: string): void {
    const open = this.open(this.payloadLayout(name));
    if (open.length) throw new ChoiceOpenError(`Patchsprite can't check ${name} on this unit yet: ${this.doubt(open)}`, open);
  }

  /** What the player sees about open choices: what is in doubt, and how to settle it. */
  private doubt(open: string[]): string {
    const choices = this.protocol.choices ?? {};
    const what = open.map((c) => choices[c].what).join(" and ");
    const settle = open.flatMap((c) => (choices[c].settle ? [choices[c].settle!] : [])).join(" ");
    return `${what} ${open.length > 1 ? "are" : "is"} not confirmed on this unit yet${settle ? `. ${settle}` : ""}`;
  }

  /** Encode under every way the open choices allow: sent only when they all give the same bytes. */
  private encodeChoosing(l: Layout, fields: Values, name: string, base?: Uint8Array): Uint8Array {
    const ways = this.ways(l, name);
    const out = ways.map((w) => encodeLayout(w.layout, fields, this.ctx, name, base));
    if (out.some((b) => !sameBytes(b, out[0]))) {
      const open = this.open(l);
      throw new ChoiceOpenError(`Patchsprite can't send that yet (${name}): ${this.doubt(open)}`, open);
    }
    return out[0];
  }

  /**
   * Decode under every way the choices allow, pinned or not. A way that reads a choice's field outside its range (or
   * as no key of its enum) is ruled out. A settled option that is ruled out while another fits is reopened (the pin
   * may come from another unit of the model, which numbers its presets the other way); an open choice left with one
   * option is settled for this unit; a choice left with none is contradicted. Ways that remain and read differently
   * leave the answer in doubt.
   */
  private decodeChoosing(l: Layout, payload: Uint8Array, name: string): Values {
    const fields = choiceFields(l);
    if (!fields.length) return decodeLayout(l, payload, this.ctx, name);
    let failure: unknown;
    const read: (Way & { values: Values })[] = [];
    for (const w of this.ways(l, name, true)) {
      try {
        read.push({ ...w, values: decodeLayout(w.layout, payload, this.ctx, name) });
      } catch (e) {
        failure ??= e;
      }
    }
    // a payload no way reads is malformed whatever the choice: that is not the unit's answer to it
    if (!read.length) throw failure;
    let fits = read.filter((r) => fields.every((f) => within(f, r.values[f.name])));
    const shown = (r: { values: Values }) => fields.map((f) => `${f.name} ${String(r.values[f.name])}`).join(", ");
    if (fits.length) {
      for (const c of new Set(fields.map((f) => f.choice))) {
        if (!has(this.pins, c)) continue;
        const pinned = this.pins[c];
        if (fits.some((r) => r.options[c] === pinned)) {
          fits = fits.filter((r) => r.options[c] === pinned);
          // an answer the pin reads is no contradiction: an odd one before it no longer counts toward a suspect
          this.checks?.observe({ entry: choiceEntry(c), outcome: "confirms" });
          continue;
        }
        delete this.pins[c];
        this.checks?.observe({
          entry: choiceEntry(c),
          outcome: "reopens",
          claimed: pinned,
          observed: { message: name, fits: [...new Set(fits.map((r) => r.options[c]))] },
          why: `its ${name} does not fit ${pinned}, the option settled before`,
        });
      }
    }
    const open = this.open(l);
    if (!fits.length) {
      const choices = [...new Set(fields.map((f) => f.choice))];
      const observed = read.map((r) => ({ options: r.options, read: shown(r) }));
      for (const c of choices) {
        delete this.pins[c];
        this.checks?.observe({
          entry: choiceEntry(c),
          outcome: "contradicts",
          claimed: Object.keys(this.protocol.choices![c].options),
          observed: { message: name, readings: observed },
          why: `its ${name} reads as ${read.map(shown).join(" or ")}, which the map does not allow`,
          // one odd answer is not enough to turn off what depends on the choice
          strikes: 2,
        });
      }
      throw new SafetyError(`this unit's answer (${name}) fits none of the ways the device map reads it (${read.map(shown).join(" or ")}); the map needs fixing`);
    }
    for (const c of open) {
      const left = new Set(fits.map((r) => r.options[c]));
      if (left.size !== 1) continue;
      const option = [...left][0];
      this.pins[c] = option;
      this.checks?.observe({
        entry: choiceEntry(c),
        outcome: "settles",
        claimed: Object.keys(this.protocol.choices![c].options),
        observed: { option, message: name, read: shown(fits[0]), ruledOut: read.filter((r) => !fits.includes(r)).map(shown) },
      });
    }
    const readings = new Set(fits.map(shown));
    if (readings.size > 1) {
      const still = this.open(l);
      throw new ChoiceOpenError(`this unit's answer (${name}) reads as ${[...readings].join(" or ")}: ${this.doubt(still)}`, still);
    }
    return fits[0].values;
  }

  /** A message's payload layout with its choices as this unit settled them, for a simulated unit that answers as one. */
  settledPayloadLayout(name: string): Layout {
    return this.settled(this.payloadLayout(name), name);
  }

  /** A shared layout with its choices as this unit settled them (as settledPayloadLayout). */
  settledLayout(name: string): Layout {
    return this.settled(this.layout(name), name);
  }

  private settled(l: Layout, name: string): Layout {
    const open = this.open(l);
    if (open.length) throw new ChoiceOpenError(`${name}: ${this.doubt(open)}`, open);
    return this.ways(l, name)[0].layout;
  }

  /**
   * `note` false: not a decode to note for codec coverage, either a payload this side built (a sent request read back to
   * compare) or a trial read (identify tries every candidate; its caller decodes the one it takes).
   */
  private decodeRaw(name: string, payload: Uint8Array, note = true): Values | null {
    let out: Values;
    try {
      out = decodeLayout(this.payloadLayout(name), payload, { ...this.ctx, raw: true }, name);
    } catch {
      return null;
    }
    if (note) noteCodecUse(this.protocol, "decode", this.mapMessage(name));
    return out;
  }

  encodeLayout(name: string, values: Values, base?: Uint8Array): Uint8Array {
    return this.encodeChoosing(this.layout(name), this.writeEnumsBy(this.layout(name), values, name), name, base);
  }

  decodeLayout(name: string, bytes: Uint8Array): Values {
    return this.readEnumsBy(this.layout(name), this.decodeChoosing(this.layout(name), bytes, name));
  }

  offset(layout: string, field: string, ...index: number[]): number {
    return offsetOf(this.layout(layout), field, ...index);
  }

  /** The bytes a layout field covers, or the part of it under leading indexes. */
  span(layout: string, field: string, ...prefix: number[]): [number, number] {
    return fieldSpan(this.layout(layout), field, ...prefix);
  }

  /**
   * Why a driver's needs can fail on this firmware beyond what the map lacks: the lists it can't give a firmware it does
   * not cover, said so the player's refusal points at the map's firmwares, not a missing entry. Empty when none.
   */
  uncoveredNote(): string {
    const e = this.enumsInDoubt;
    if (!e.length) return "";
    return ` (the map has no entry or range for firmware ${this.firmware}, and its firmwares change the ${e.join(", ")} list${e.length > 1 ? "s" : ""}, so it can't say which this firmware has)`;
  }

  /** The keys of an enum, in the map's order. */
  enumKeys(e: string): string[] {
    if (!has(this.enums, e)) throw new ProtocolError(`no enum "${e}" in the device map`);
    return Object.keys(this.enums[e]);
  }

  /** The key for a value of an enum, or undefined. */
  enumKey(e: string, value: number): string | undefined {
    if (!has(this.enums, e)) return undefined;
    const t = this.enums[e];
    return Object.keys(t).find((k) => t[k] === value);
  }

  hasMessage(name: string): boolean {
    return has(this.messages, name);
  }

  /** Every message name on this firmware, in the map's order (the base's, then the firmware's own additions). */
  messageNames(): string[] {
    return Object.keys(this.messages);
  }

  hasLayout(name: string): boolean {
    return has(this.layouts, name);
  }

  /** The cmds (hex) of the messages marked poll and of the device's answers to them (reply.message, or itself). */
  pollCmds(): string[] {
    const names = Object.keys(this.messages).filter((n) => this.messages[n].poll);
    const answers = names.map((n) => this.replyName(n)).filter((n) => this.hasMessage(n));
    return [...new Set([...names, ...answers].map((n) => hexOf(this.cmd(n))))];
  }

  /** Cmds (hex) of the messages the device sends without a checksum, for the framer. */
  noChecksumCmds(): string[] {
    return Object.keys(this.messages).filter((n) => this.messages[n].noChecksum).map((n) => hexOf(this.cmd(n)));
  }

  /** The message that answers a request: its reply rule's, or the request itself. */
  replyName(request: string): string {
    return this.message(request).reply?.message ?? request;
  }

  /** The characters a string field keeps: one less than its bytes, so a NUL always ends it. */
  textLimit(layoutOrMessage: string, field: string): number {
    const f = this.field(layoutOrMessage, field);
    if (f.type !== "string") throw new ProtocolError(`${layoutOrMessage}.${field} is not a string`);
    return f.length - 1;
  }

  /** The text as a string field stores it: latin1, cut to the field's limit. */
  storedText(layoutOrMessage: string, field: string, text: string): string {
    return Array.from(text.slice(0, this.textLimit(layoutOrMessage, field)), (c) => String.fromCharCode(c.charCodeAt(0) & 0xff)).join("");
  }

  /**
   * The byte ranges a field's elements cover, or those under leading indexes, one per run of adjacent elements: gaps
   * between strided elements are not in any range.
   */
  ranges(layout: string, field: string, ...prefix: number[]): [number, number][] {
    const l = this.layout(layout);
    const f = l.fields.find((x) => x.name === field);
    if (!f) throw new ProtocolError(`no field "${field}"`);
    const shape = f.repeat?.dims ?? [];
    if (prefix.length > shape.length) throw new ProtocolError(`${field} takes ${shape.length} indexes`);
    const size = elementSize(f);
    const out: [number, number][] = [];
    const walk = (idx: number[]) => {
      if (idx.length === shape.length) {
        const at = offsetOf(l, field, ...idx);
        const last = out.at(-1);
        if (last && last[1] === at) last[1] = at + size;
        else out.push([at, at + size]);
        return;
      }
      for (let i = 0; i < shape[idx.length]; i++) walk([...idx, i]);
    };
    walk(prefix);
    return out;
  }

  /** A message whose packed tail is a piece of a record (`packed.pieces`): its tail, record, offset field and varying fields. */
  pieceSpec(message: string): PieceSpec {
    const l = this.payloadLayout(message);
    const x = tailPieces(l.packed);
    if (!l.packed || !x) throw new ProtocolError(`message ${message} carries no piece of a record`);
    const sums = l.fields.filter((f) => f.type !== "bytes" && f.type !== "string" && f.type !== "pad" && f.checksum).map((f) => f.name);
    const length = l.packed.lengthField === undefined ? [] : [l.packed.lengthField];
    return { tail: l.packed, layout: x.layout, size: this.size(x.layout), offsetField: x.offsetField, vary: new Set([x.offsetField, l.packed.name, ...length, ...sums]) };
  }

  /**
   * One piece of a record, decoded from a payload of a message whose packed tail has `pieces`: its offset, its bytes and
   * its key. It checks what decoding does (sizes, consts, the tail); the caller pairs it with a request (acceptsReply).
   */
  pieceOf(message: string, payload: Uint8Array): Piece {
    const spec = this.pieceSpec(message);
    const v = this.decode(message, payload);
    const key = Object.fromEntries(Object.entries(v).filter(([k]) => !spec.vary.has(k)));
    return { offset: v[spec.offsetField] as number, bytes: v[spec.tail.name] as Uint8Array, key };
  }

  /** The total size of a layout in bytes. */
  size(layout: string): number {
    const l = this.layout(layout);
    if (l.packed) throw new ProtocolError(`layout ${layout} ends with packed data, so it has no fixed size`);
    return layoutSize(l);
  }

  /** A field's definition in a message's payload or a layout. */
  field(layoutOrMessage: string, field: string): Field {
    const l = has(this.layouts, layoutOrMessage) ? this.layouts[layoutOrMessage] : this.payloadLayout(layoutOrMessage);
    const f = withTailFields(l, this.layouts).find((x) => x.name === field);
    if (!f) throw new ProtocolError(`no field "${field}" in ${layoutOrMessage}`);
    return f;
  }

  enumValue(e: string, key: string): number {
    const t = has(this.enums, e) ? this.enums[e] : undefined;
    if (!t || !has(t, key)) throw new ProtocolError(`no ${e} "${key}" in the device map`);
    return t[key];
  }

  constant(name: string): number {
    if (!has(this.constants, name)) throw new ProtocolError(`no constant "${name}" in the device map`);
    return this.constants[name];
  }

  /**
   * Whether `reply` answers this sent request: it decodes as the reply message (its sizes, consts and checksums), and
   * every echoed field has the request's wire value. A late answer to an earlier request is not taken for this one.
   */
  acceptsReply(sent: Encoded, reply: Uint8Array): boolean {
    return this.replyFields(sent, reply) !== null;
  }

  /** The reply's wire values when it answers this sent request (as acceptsReply), else null. */
  private replyFields(sent: Encoded, reply: Uint8Array): Values | null {
    const m = this.message(sent.name);
    // a request with no reply rule is answered by the same message, unfiltered
    const r = m.reply ?? (m.dir === "request" ? {} : undefined);
    if (!r) throw new ProtocolError(`"${sent.name}" expects no reply`);
    const read = this.decodeRaw(r.message ?? sent.name, reply);
    if (!read || !r.echo?.length) return read;
    // address fields are the request's on both sides: the reply's address moved with it
    const got = { ...read, ...this.addressValues(r.message ?? sent.name, sent.address ?? {}, true) };
    const decoded = this.decodeRaw(sent.name, sent.payload, false);
    if (decoded === null) return null;
    const asked = { ...decoded, ...sent.address };
    return r.echo.every((e) => sameValue(got[e.reply], asked[e.request])) ? read : null;
  }

  /** How a request's answer comes in pieces (its reply rule's `pieces`), or undefined when it comes in one message. */
  pieces(request: string): Pieces | undefined {
    return this.message(request).reply?.pieces;
  }

  /** The layout a request's answer is read with: its pieces' `layout` once joined, else the reply message's own. */
  private answerLayout(request: string): Layout {
    const layout = this.pieces(request)?.layout;
    return layout === undefined ? this.payloadLayout(this.replyName(request)) : this.layout(layout);
  }

  /**
   * The bytes the answer to this sent request joins to: the request's size field as sent, the map's constant or number,
   * or the size of the layout the answer is read with. Refused outside 1 to MAX_RECORD bytes (what ByteJoiner joins).
   */
  answerSize(sent: Encoded): number {
    const p = this.pieces(sent.name);
    if (!p) throw new ProtocolError(`"${sent.name}" is not answered in pieces`);
    const s = p.size;
    const n =
      s === undefined ? layoutSize(this.answerLayout(sent.name))
      : typeof s === "number" ? s
      : "constant" in s ? this.constant(s.constant)
      : this.decodeRaw(sent.name, sent.payload, false)?.[s.request];
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > MAX_RECORD) throw new ProtocolError(`the answer to ${sent.name} would join ${String(n)} bytes; 1 to ${MAX_RECORD} are joined`);
    return n;
  }

  /**
   * A piece of the answer to this sent request, where each piece names its byte offset in a field: the offset, the
   * piece's bytes (the payload after the reply's layout) and `key`, its other fields' wire values as one string
   * (pieces of one answer share it, so a stray piece of another transfer is told apart). Null when the message is not
   * one: it does not read as the reply, or its echoed fields are another request's.
   */
  answerPiece(sent: Encoded, data: Uint8Array): { offset: number; bytes: Uint8Array; key: string } | null {
    const p = this.pieces(sent.name);
    if (!p || p.offset === "address") throw new ProtocolError(`"${sent.name}" is not answered in pieces with an offset field`);
    const got = this.replyFields(sent, data);
    if (!got) return null;
    const offset = got[p.offset.field];
    const layout = this.payloadLayout(this.replyName(sent.name));
    const bytes = data.subarray(layoutSize(layout));
    if (typeof offset !== "number") return null;
    // a checksum of the piece differs from piece to piece: it names no transfer
    const own = new Set([p.offset.field, ...layout.fields.filter((f) => "checksum" in f && f.checksum).map((f) => f.name)]);
    const others = Object.entries(got).filter(([k]) => !own.has(k));
    const key = JSON.stringify(others, (_, v) => (v instanceof Uint8Array ? hexOf(v) : v));
    return { offset, bytes, key };
  }

  /** Read an acknowledgement: does it answer this sent message (cmd, and id where the map pairs one), and did it succeed. */
  readAck(sent: Encoded, ack: Uint8Array): { answers: boolean; ok: boolean; id?: number; status?: unknown } {
    const a = this.message(sent.name).ack;
    if (!a) throw new ProtocolError(`"${sent.name}" is not acknowledged`);
    const d = this.decodeRaw(a.message, ack);
    if (!d) return { answers: false, ok: false };
    const cmd = d[a.cmdField];
    const sameCmd = cmd instanceof Uint8Array && sameBytes(cmd, sent.cmd);
    let sameId = true;
    let id: number | undefined;
    if (a.idField !== undefined && a.requestIdField !== undefined) {
      id = d[a.idField] as number;
      const asked = this.decodeRaw(sent.name, sent.payload, false);
      sameId = asked !== null && sameValue(id, asked[a.requestIdField]);
    }
    return { answers: sameCmd && sameId, ok: d[a.statusField] === a.okStatus, id, status: d[a.statusField] };
  }

  /**
   * Every cmd template of the map with its header (sysex-plain), for a framer that reads cmds of several lengths. The
   * whole map's, whatever the mode: a mode only renames or drops messages, and a framer built in one mode must still
   * split the cmds of a mode the unit switches to before the driver has read it.
   */
  knownCmds(): KnownCmd[] {
    const seen = new Map<string, KnownCmd>();
    const d = this.firmwareListed ? this.protocol.firmwares![this.firmwareEntry!].messages : undefined;
    for (const m of Object.values({ ...this.protocol.messages, ...d })) {
      const k = `${m.header ?? ""}|${m.cmd}`;
      if (!seen.has(k)) seen.set(k, m.header === undefined ? { cmd: m.cmd } : { cmd: m.cmd, header: m.header });
    }
    return [...seen.values()];
  }

  /**
   * The messages from one side (the device's replies and notifies, or the host's requests and sends) that a payload on
   * this cmd reads as, by their sizes, consts and `not`s: the most specific first (more fixed cmd bytes, then a layout
   * the payload fills exactly, then more payload bytes pinned), then by name. More than one name means the map can't
   * tell them apart. `header`: the entry of transport.frame.headers it came under (sysex-plain).
   */
  identify(cmd: Uint8Array, payload: Uint8Array, from: Side, header?: string): string[] {
    const dirs = SIDE_DIRS[from];
    return this.messagesForCmd(cmd, header)
      .filter((n) => dirs.includes(this.messages[n].dir) && this.decodeRaw(n, payload, false) !== null)
      .map((n) => {
        const cmdBytes = this.messages[n].cmd.split(" ").filter((t) => !t.startsWith("{")).length;
        return { n, cmdBytes, exact: layoutSize(this.payloadLayout(n)) === payload.length ? 1 : 0, pinned: this.shapeOf(n).is.size };
      })
      // the last tie-break is the name, not the map's key order, which a canonical (RFC 8785) round trip re-sorts
      .sort((a, b) => b.cmdBytes - a.cmdBytes || b.exact - a.exact || b.pinned - a.pinned || (a.n < b.n ? -1 : a.n > b.n ? 1 : 0))
      .map((x) => x.n);
  }

  /**
   * Pairs of messages from the same side, under the same header, on cmds that can be the same bytes (as their address
   * fields move them), that one payload can read as both: the map pins no byte (const or `not`, a packed tail's layout
   * included) or length that tells them apart. A frame of either is named by `identify` alone.
   */
  lookalikes(): [string, string][] {
    const out: [string, string][] = [];
    for (const dirs of Object.values(SIDE_DIRS)) {
      // by name, so the list doesn't depend on the map's key order
      const names = Object.keys(this.messages).filter((n) => dirs.includes(this.messages[n].dir)).sort();
      names.forEach((a, i) => {
        for (const b of names.slice(i + 1)) {
          if (this.messages[a].header === this.messages[b].header && this.cmdsMeet(a, b) && shapesMeet(this.shapeOf(a), this.shapeOf(b))) out.push([a, b]);
        }
      });
    }
    return out;
  }

  /** A message's address terms, worked out once: messagesForCmd asks every message for every incoming frame. */
  private termsOf(name: string): AddressTerm[] {
    let terms = this.terms.get(name);
    if (!terms) this.terms.set(name, (terms = this.addressFields(name).map((f) => addressTerm(f, this.ctx, this.protocol.addresses))));
    return terms;
  }

  /**
   * Whether two messages can go on the same cmd bytes: their templates overlap, or, where either has address fields,
   * some address both reach. A search too long to finish counts as meeting (a lookalike is only ever a warning).
   */
  private cmdsMeet(a: string, b: string): boolean {
    const t = this.protocol.transport;
    const [x, y] = [this.messages[a].cmd, this.messages[b].cmd];
    if (t.framing !== "roland-address") return cmdsOverlap(x, y);
    if (!this.addressFields(a).length) {
      if (!this.addressFields(b).length) return cmdsOverlap(x, y);
      [a, b] = [b, a];
    }
    // a has address fields and a fixed cmd: walk the addresses it reaches, and ask b for each
    const at = t.inner.cmdLength - t.inner.addressBytes;
    const cmd = this.cmd(a);
    if (!cmdsOverlap(hexOf(cmd.subarray(0, at)), this.messages[b].cmd.split(" ").slice(0, at).join(" "))) return false;
    const terms = this.termsOf(a);
    const base = addressValue(cmd.subarray(at));
    let reached: number[][];
    try {
      reached = searchAddress(terms, terms.reduce((n, x) => n + termMin(x), 0), terms.reduce((n, x) => n + termMax(x), 0), MAX_LOOKALIKE_ADDRESSES);
    } catch (e) {
      if (e instanceof AddressSearchTooLong) return true;
      throw e;
    }
    if (reached.length >= MAX_LOOKALIKE_ADDRESSES) return true;
    const offset = (k: number, w: number) => {
      const term = terms[k];
      return "options" in term ? term.options.find(([v]) => v === w)![1] : w * term.stride;
    };
    return reached.some((ws) => {
      const address = base + ws.reduce((n, w, k) => n + offset(k, w), 0);
      if (address >= 128 ** t.inner.addressBytes) return false;
      cmd.set(addressBytes(address, t.inner.addressBytes), at);
      return this.addressOf(b, cmd) !== undefined;
    });
  }

  /** A message's frame shape, worked out once: identify runs on every frame a simulator or a sniff decode reads. */
  private shapeOf(name: string): FrameShape {
    let s = this.shapes.get(name);
    if (!s) this.shapes.set(name, (s = frameShape(this.payloadLayout(name), this.protocol.transport.endian, this.layouts)));
    return s;
  }

  /**
   * Incoming dispatch: the device-side messages (reply/notify, then request) whose fixed cmd bytes match, or whose
   * address fields reach the cmd's address, under the named header (sysex-plain) or, by default, the device's own.
   */
  messagesForCmd(cmd: Uint8Array, header?: string): string[] {
    const rank = { reply: 0, notify: 1, request: 2, send: 3 } as const;
    return Object.entries(this.messages)
      .filter(([n, m]) => m.header === header && this.addressOf(n, cmd) !== undefined)
      .sort(([, a], [, b]) => rank[a.dir] - rank[b.dir])
      .map(([n]) => n);
  }
}

/** Validate the protocol section of a device map; throws with every problem listed. */
export function parseProtocol(json: unknown): Protocol {
  const r = ProtocolSchema.safeParse(json);
  if (!r.success) throw new ProtocolError(`device map protocol section is invalid:\n${z.prettifyError(r.error)}`);
  return r.data;
}

/**
 * A device map's protocol as the open format states it: as parseProtocol reads it, and refused when it doesn't name its
 * driver. What the sniffer checks a map it built with.
 */
export const DeviceMapSchema = ProtocolSchema.refine((p) => p.driver !== undefined, {
  message: `a device map states its driver (${DRIVERS.map((d) => `"${d}"`).join(" or ")})`,
  path: ["driver"],
});

/** parseProtocol for a map the sniffer built: one that doesn't state its driver is refused. */
export function parseDeviceMap(json: unknown): Protocol {
  const r = DeviceMapSchema.safeParse(json);
  if (!r.success) throw new ProtocolError(`device map protocol section is invalid:\n${z.prettifyError(r.error)}`);
  return r.data;
}
