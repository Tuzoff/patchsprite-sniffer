// The protocol section of a device map: transport, named messages, record layouts, settings, enums and constants,
// plus a generic codec over them. The format: docs/formats/device-map.md.
//
// Everything learnt about a device is data in its device map; this file holds only the shapes and the engine. It must
// never hold a real command code, offset, size or rule: tests use made-up maps (packages/engine/test/fixtures).
//
// The map is untrusted input (it may come from a server): every count is capped, sizes are computed without
// enumerating elements, and lookups by name never reach inherited object properties.

import { z } from "zod";
import type { KnownCmd } from "./framing.ts";
import { cmdsOverlap, tokensBegin } from "./cmd-overlap.ts";
import { choiceEntry, type UnitChecks } from "./map-checks.ts";
import { crc32, pack8to7, packedLength, septets32, type TopBits, unpack7to8, unpackedLength } from "./pack7.ts";
import { joinNibbles, type NibbleOrder, splitNibbles } from "./nibbles.ts";
import { MEASURED_FIELDS } from "./measured-fields.ts";
import { SafetyError } from "./safety.ts";

// ---- codec use ------------------------------------------------------------------------------------------------

/** Told of each message a codec encodes (its payload built) or decodes (its payload read) successfully. */
export type CodecUseObserver = (protocol: Protocol, use: "encode" | "decode", message: string) => void;

let codecObserver: CodecUseObserver | undefined;

/**
 * Sets the one observer of codec use (a test run's per-message coverage log, say), or clears it with undefined. An
 * observer that throws is ignored: it never stops a codec call.
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
/** Bytes in one record joined from pieces (`pieces`). */
export const MAX_RECORD = 1 << 16;

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
  note: z.string().max(1024).optional(),
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
  note: z.string().max(1024).optional(),
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
export const DRIVERS = ["patch-dump", "param-change"] as const;
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
  measuredOn: z.string().max(256),
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
    cmdLength: z.number().int().min(1).max(8),
    length: z.strictObject({ type: z.enum(["u16", "u32"]), endian }),
    compression: z.enum(["none", "lzo1x-literal"]),
  }),
  /** Default endianness of payload fields. */
  endian,
  timing: TimingSchema,
});

const cmdByteCount = z.number().int().min(1).max(8);

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
  inner: z.strictObject({ cmdLength: z.number().int().min(1).max(8) }),
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

/** Address bytes at most: wider than any address-based unit uses, and still exact as a number (7 x 7 bits). */
const MAX_ADDRESS_BYTES = 7;

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
      terminator: z.literal("f7"),
      checksum: z.strictObject({
        algo: z.literal("roland-sum"),
        /** Refuse an incoming message whose checksum does not match (otherwise it is read, not enforced). */
        verify: z.boolean(),
      }),
      /** The most data bytes one message carries: a longer write goes in pieces at successive addresses. */
      maxData: z.number().int().min(1).max(MAX_BYTES).optional(),
    })
    .refine((f) => f.deviceIdAt === undefined || f.deviceIdAt < f.header.split(" ").length, "deviceIdAt is inside the header"),
  inner: z
    .strictObject({
      cmdLength: z.number().int().min(2).max(8),
      /** The cmd's last bytes that are the address; the bytes before them are the command. */
      addressBytes: z.number().int().min(1).max(MAX_ADDRESS_BYTES),
    })
    .refine((i) => i.addressBytes < i.cmdLength, "the cmd holds a command byte before the address"),
  endian,
  timing: TimingSchema,
});

const TransportSchema = z.discriminatedUnion("framing", [NibbleTransportSchema, XorTransportSchema, PlainTransportSchema, AddressTransportSchema]);
export type Transport = z.infer<typeof TransportSchema>;
export type NibbleTransport = z.infer<typeof NibbleTransportSchema>;
export type XorTransport = z.infer<typeof XorTransportSchema>;
export type PlainTransport = z.infer<typeof PlainTransportSchema>;
export type AddressTransport = z.infer<typeof AddressTransportSchema>;

/** The shortest and longest cmd the transport allows. */
export function cmdLengths(t: Transport): { min: number; max: number } {
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
  ref: z.string().min(1).max(512).optional(),
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
  note: z.string().max(1024).optional(),
});
export type Message = z.infer<typeof MessageSchema>;
type Reply = z.infer<typeof ReplySchema>;

// ---- settings (device-wide globals and EQ) -----------------------------------------------------------------------

const SettingSchema = z.strictObject({
  id: key,
  label: z.string().max(256),
  group: name,
  /** Where the value sits in the group read-back. */
  read: z.strictObject({ offset: size, type: z.enum(SCALAR_TYPES) }),
  /** The message that writes it, and its cmd arguments. Its payload has a field named `value`. */
  write: z.strictObject({ message: name, args: cappedRecord(name, byte, 8, "args").optional() }),
  /** Value -> name, for the values known. How a value is shown otherwise stays in code. */
  options: cappedRecord(z.string().regex(/^-?\d{1,10}$/), z.string().max(256), MAX_ENTRIES, "options").optional(),
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
    .array(z.strictObject({ id: key, label: z.string().max(256), on: nonNeg, freq: nonNeg, q: nonNeg, gain: nonNeg.optional() }))
    .max(64),
  level: nonNeg,
  ranges: z.record(z.enum(["freq", "q", "gain", "level"]), z.tuple([z.number(), z.number()])),
});

// ---- the section -----------------------------------------------------------------------------------------------

const EnumSchema = cappedRecord(key, z.number().int(), MAX_ENTRIES, "enum keys");
const messages = cappedRecord(name, MessageSchema, MAX_ENTRIES, "messages");
const layouts = cappedRecord(name, LayoutSchema, MAX_ENTRIES, "layouts");
const constants = cappedRecord(name, z.number(), MAX_ENTRIES, "constants");
const blocked = z.array(name).max(MAX_BLOCKED);

/** What a firmware changes from the base protocol: whole entries replaced by name, and messages it must not get. */
const reason = z.string().min(1).max(512);

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
    .array(z.string().max(200).refine((s) => /[^\s\x00-\x1f\x7f-\x9f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/.test(s), "a note has text"))
    .max(16)
    .optional(),
});

/** How the device names things for the player. */
const DisplaySchema = z.strictObject({
  /** The device's own name, as the player knows it. */
  deviceName: z.string().min(1).max(64),
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
  emptyPatchName: z.string().min(1).max(64).optional(),
  /** A scene's name before anyone names it; `{n}` is its number from 1. Needed on a device with scenes. */
  defaultSceneName: z.string().min(1).max(64).optional(),
  /** How the player is told which scene: `{n}` is its number from 1 ("Scene {n}"). Needed on a device with scenes. */
  sceneLabel: z.string().min(1).max(64).regex(/\{n\}/, "a {n} for the scene's number").optional(),
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
    calibratedOn: z.string().max(256).optional(),
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
    sourceNames: z.record(key, z.string().min(1).max(64)),
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
  vendorApps: z.array(z.tuple([z.string().min(1).max(64), z.string().min(1).max(64)])).max(16),
  /** the vendor's editor, for the editor-walk tools */
  editor: EditorSchema.optional(),
});

const FirmwareDeltaSchema = z.strictObject({
  messages: messages.optional(),
  layouts: layouts.optional(),
  constants: constants.optional(),
  blocked: blocked.optional(),
  /** stricter safety on this firmware: fewer scenes for model changes, more halting model types */
  safety: z
    .strictObject({
      modelChangeScenes: z.array(z.number().int().min(0).max(255)).min(1).max(64).optional(),
      haltingTypes: z.array(z.number().int().min(0)).max(256).optional(),
    })
    .optional(),
});

/** One block parameter, by the name the device shows. */
const ParameterSchema = z.strictObject({
  id: z.number().int().min(0).max(16383),
  /**
   * knob or slider: a position 0..max (the device shows its own label for it); select or switch: one of `options`;
   * range: a plain number min..max in steps of `step`.
   */
  kind: z.enum(["knob", "slider", "select", "switch", "range"]),
  options: cappedRecord(z.string().regex(/^\d{1,5}$/), z.string().min(1).max(64), 1024, "options").optional(),
  min: z.number().int().optional(),
  max: z.number().int().optional(),
  step: z.number().int().min(1).optional(),
  /** The raw value the device gives the parameter when the effect is put in (an option's key for a select or switch). */
  default: z.number().int().optional(),
  source: SourceSchema.optional(),
  note: z.string().max(1024).optional(),
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
      params: cappedRecord(z.string().min(1).max(64), ParameterSchema, 1024, "params"),
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
  what: z.string().min(1).max(128),
  /** a request whose reply settles it, which the driver may read before refusing a send: a read, never a change */
  readBy: name.optional(),
  /** what the player can do to settle it: "switch to any preset on the unit itself, then ask again" */
  settle: z.string().min(1).max(256).optional(),
  options: cappedRecord(name, z.strictObject({ endian }), MAX_CHOICE_OPTIONS, "options"),
  source: SourceSchema.optional(),
  note: z.string().max(1024).optional(),
});

const ProtocolBase = z.strictObject({
  /** Schema version of this section. */
  schema: z.literal(1),
  transport: TransportSchema,
  messages,
  layouts,
  enums: cappedRecord(name, EnumSchema, MAX_ENTRIES, "enums").optional(),
  /** Named sizes, counts and sentinels ("presetCount", "sampleFirstId"). */
  constants: constants.optional(),
  settings: SettingsSchema.optional(),
  eq: EqSchema.optional(),
  /** Messages never sent on any firmware. */
  blocked: blocked.optional(),
  safety: SafetySchema.optional(),
  display: DisplaySchema.optional(),
  audio: AudioSchema.optional(),
  host: HostSchema.optional(),
  /**
   * How the device is driven, stated by the map rather than guessed from its framing: "patch-dump" (the unit hands
   * over and takes whole patches as one record the map lays out) or "param-change" (the unit
   * is addressed one message at a time: preset, scene, block bypass and channel, one parameter per message). A map the
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
  /** Encodings the docs disagree on, settled per unit (fields name them with `choice`). */
  choices: cappedRecord(name, ChoiceSchema, MAX_CHOICES, "choices").optional(),
  /** Patch slots Patchsprite may use as scratch (compare_patch parks the edits there), labels as the device spells
   * them, best first. Whatever a player keeps there is backed up before first use. */
  scratch: z.strictObject({ slots: z.array(z.string().min(1).max(16)).min(1).max(8) }).optional(),
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
  const check = (where: string, l: Layout, all: Record<string, Layout>) => {
    for (const f of l.fields) {
      if (f.type === "bytes" || f.type === "string" || f.type === "pad" || digitsOf(f)) continue;
      // every wire value the map names for a whole-byte u8: its max, default and enum values (scaled), const and nullAs
      const wire = (x: number) => x * (f.scale ?? 1) + (f.bias ?? 0);
      const enumValues = f.enum !== undefined && p.enums && Object.hasOwn(p.enums, f.enum) ? Object.values(p.enums[f.enum]) : [];
      const named = [f.max, f.default, ...enumValues].filter((x) => x !== undefined).map(wire);
      for (const x of [f.const, f.nullAs]) if (x !== undefined) named.push(x);
      // a packed tail's length field is written from the data, up to its maxLength
      if (l.packed?.lengthField === f.name) named.push(l.packed.maxLength);
      // a record piece's offset field, up to the last piece's offset
      const rec = tailPieces(l.packed);
      if (rec?.offsetField === f.name && has(all, rec.layout) && l.packed!.maxLength >= 1) named.push(lastPieceAt(layoutSize(all[rec.layout]), l.packed!.maxLength));
      const ok = f.type === "u8" && (f.bits ? f.bits.shift + f.bits.width <= 7 : named.every((x) => x <= 0x7f));
      if (!ok) out.push(`${where}: field ${f.name} needs septets or nibbles, or 7 bits at most, on a ${p.transport.framing} transport`);
    }
  };
  const scan = (prefix: string, msgs: Record<string, Message> | undefined, lays: Record<string, Layout> | undefined, exempt: Set<string>, all: Record<string, Layout>) => {
    for (const [n, l] of Object.entries(lays ?? {})) if (!exempt.has(n)) check(`${prefix}layout ${n}`, l, all);
    for (const [n, m] of Object.entries(msgs ?? {})) {
      if (m.cmd.split(" ").some((t) => !t.startsWith("{") && parseInt(t, 16) > 0x7f)) out.push(`${prefix}message ${n}: cmd bytes are 7-bit on a ${p.transport.framing} transport`);
      if (m.payload !== undefined && typeof m.payload !== "string") check(`${prefix}message ${n}`, m.payload, all);
    }
  };
  const baseExempt = tailOnlyLayouts(p.messages, p.layouts);
  scan("", p.messages, p.layouts, baseExempt, p.layouts);
  for (const [fw, d] of Object.entries(p.firmwares ?? {})) {
    const exempt = tailOnlyLayouts({ ...p.messages, ...d.messages }, { ...p.layouts, ...d.layouts });
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
    scan(`firmware ${fw}: `, msgs, lays, exempt, { ...p.layouts, ...d.layouts });
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
  // a type's parameters are checked under its key, as a block's are under its own: one name for both would share them
  if (types && blocks && groups.some((g) => g.types)) {
    for (const k of Object.keys(types)) if (has(blocks, k)) out.push(`parameters: "${k}" is both a block and an effect type; give them different keys`);
  }
  const owner = new Map<string, string>();
  for (const [g, group] of Object.entries(P.groups)) {
    if (!group.blocks && !group.types) out.push(`parameters.${g}: needs blocks or types`);
    if (group.blocks && group.types) out.push(`parameters.${g}: has both blocks and types; give one`);
    const keys = [...(group.blocks ?? []).map((k) => ["block", k, blocks] as const), ...(group.types ?? []).map((k) => ["type", k, types] as const)];
    for (const [kind, k, e] of keys) {
      if (e && !has(e, k)) out.push(`parameters.${g}: "${k}" is not a key of the ${kind} enum`);
      const first = owner.get(`${kind}:${k}`);
      if (first !== undefined) out.push(`parameters.${g}: ${kind} "${k}" is already in ${first}`);
      else owner.set(`${kind}:${k}`, g);
    }
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
  }
  return out;
}

/** Why a parameter's default is not a value it can take, or undefined when it is one. */
function defaultFault(x: z.infer<typeof ParameterSchema>, d: number, knobMax: number): string | undefined {
  if (x.options && Object.keys(x.options).length) return has(x.options, String(d)) ? undefined : "is not one of its options";
  // a range without both ends is reported on its own
  const min = x.min ?? 0;
  const max = x.max ?? (x.kind === "knob" || x.kind === "slider" ? knobMax : undefined);
  if (d < min || (max !== undefined && d > max)) return `is outside ${min}..${max ?? "its last"}`;
  if (x.kind === "range" && (d - min) % (x.step ?? 1) !== 0) return `is not on its step of ${x.step}`;
  return undefined;
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
  if (p.audio && p.enums) {
    const src = p.enums.inputSource ?? {};
    for (const k of [p.audio.reamp.source, p.audio.reamp.liveSource]) if (!has(src, k)) floor.push(`audio.reamp: "${k}" is not an inputSource key`);
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
  for (const issue of plainIssues(p)) out.add(issue);
  for (const issue of noChecksumIssues(p)) out.add(issue);
  for (const issue of packedLayoutIssues(p)) out.add(issue);
  for (const issue of pollIssues(p)) out.add(issue);
  for (const issue of piecesIssues(p)) out.add(issue);
  for (const issue of parametersIssues(p)) out.add(issue);
  for (const issue of choicesIssues(p)) out.add(issue);
  // each firmware as the codec will see it; only what it replaces or adds is checked again in depth
  for (const [fw, d] of Object.entries(p.firmwares ?? {})) {
    if (out.size >= MAX_ISSUES) break;
    const view: View = {
      ...base,
      messages: { ...p.messages, ...d.messages },
      layouts: { ...p.layouts, ...d.layouts },
      blocked: [...(p.blocked ?? []), ...(d.blocked ?? [])],
    };
    const changed = Object.keys(d.messages ?? {});
    // a block depends on payloads too: a message whose named layout the firmware replaces is scanned again, and a
    // base block the firmware re-lays out (or redefines) is scanned against every message
    const relaid = Object.keys(view.messages).filter((n) => {
      const pl = view.messages[n].payload;
      return typeof pl === "string" && has(d.layouts ?? {}, pl);
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
  }
  return [...out].slice(0, MAX_ISSUES);
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
}

function frameShape(l: Layout, endian: "le" | "be"): FrameShape {
  const shape: FrameShape = { min: l.minSize ?? openStringAt(l) ?? layoutSize(l), max: l.maxSize ?? Infinity, is: new Map(), not: new Map() };
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
  return shape;
}

/** Whether one payload can fit both shapes: their lengths meet, and no byte is pinned apart. */
function shapesMeet(a: FrameShape, b: FrameShape): boolean {
  if (Math.max(a.min, b.min) > Math.min(a.max, b.max)) return false;
  const apart = (x: FrameShape, y: FrameShape) =>
    [...x.is].some(([at, v]) => (y.is.has(at) ? y.is.get(at) !== v : (y.not.get(at)?.includes(v) ?? false)));
  return !apart(a, b) && !apart(b, a);
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
  const placeholders = (n: string) => (has(v.messages, n) ? v.messages[n].cmd.split(" ").filter((t) => t.startsWith("{")).map((t) => t.slice(1, -1)) : []);
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
  // a block must not be bypassed by another name that sends the same bytes
  const isBlocked = new Set(v.blocked);
  for (const b of new Set([...scope.blocks, ...(scope.scanAll ?? [])])) if (!has(v.messages, b)) out.push(`blocked "${b}" is not a message`);
  // a send on a blocked message's cmd is refused only when its payload can be the blocked one's: a block is per
  // message, so a safe send that shares the cmd and differs in a pinned byte (or its length) stays usable
  const shapes = new Map<string, FrameShape | null>();
  const shapeOfMessage = (n: string): FrameShape | null => {
    if (!shapes.has(n)) {
      const l = layoutOf(v.messages[n]);
      shapes.set(n, l ? frameShape(l, v.endian) : null);
    }
    return shapes.get(n)!;
  };
  const canBe = (n: string, b: string) => {
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

/** Field offsets resolved: a field without an offset starts right after the furthest byte any earlier field reaches. */
function placed(l: Layout): { f: Field; at: number }[] {
  let end = 0;
  return l.fields.map((f) => {
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
  if (!has(e, key)) throw new ProtocolError(`${where}: "${key}" is not one of ${Object.keys(e).join(", ")}`);
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
  /** True when the map lists this firmware; false means the base protocol, unverified for it. */
  readonly firmwareListed: boolean;
  private readonly messages: Record<string, Message>;
  private readonly layouts: Record<string, Layout>;
  private readonly blocked: Set<string>;
  /** Frame shapes by message name, filled on first use. */
  private readonly shapes = new Map<string, FrameShape>();
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
  /** this unit's checks: the choices it has settled, and the entries it has contradicted */
  private readonly checks: UnitChecks | undefined;
  /** settled choices: the checks' own, so a choice the unit settles here is kept for it */
  private readonly pins: Record<string, string>;

  constructor(protocol: Protocol, firmware?: string, checks?: UnitChecks) {
    this.protocol = protocol;
    this.checks = checks;
    this.pins = checks?.pins ?? {};
    this.firmware = firmware;
    this.firmwareListed = firmware !== undefined && protocol.firmwares !== undefined && has(protocol.firmwares, firmware);
    const d = this.firmwareListed ? protocol.firmwares![firmware!] : {};
    this.messages = { ...protocol.messages, ...d.messages };
    this.layouts = { ...protocol.layouts, ...d.layouts };
    this.enums = { ...protocol.enums };
    this.constants = { ...protocol.constants, ...d.constants };
    this.timing = protocol.transport.timing;
    this.settings = protocol.settings;
    this.eq = protocol.eq;
    this.display = protocol.display;
    this.audio = protocol.audio;
    this.host = protocol.host;
    this.scratch = protocol.scratch;
    const base = protocol.safety;
    const extra = this.firmwareListed ? protocol.firmwares![firmware!].safety : undefined;
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
    const out: Encoded = { name, cmd: this.cmd(name, args), payload: this.encodeChoosing(this.payloadLayout(name), fields, name, base), dir: m.dir };
    if (m.header !== undefined) out.header = m.header;
    noteCodecUse(this.protocol, "encode", name);
    return out;
  }

  /** A reply's or notification's payload as the device sends it, for a simulated device or a test. */
  encodeFromDevice(name: string, fields: Values = {}): Uint8Array {
    const m = this.message(name);
    if (m.dir !== "reply" && m.dir !== "notify") throw new ProtocolError(`"${name}" is sent to the device; encode() builds it`);
    const out = this.encodeChoosing(this.payloadLayout(name), fields, name);
    noteCodecUse(this.protocol, "encode", name);
    return out;
  }

  decode(name: string, payload: Uint8Array): Values {
    const out = this.decodeChoosing(this.payloadLayout(name), payload, name);
    noteCodecUse(this.protocol, "decode", name);
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
    if (note) noteCodecUse(this.protocol, "decode", name);
    return out;
  }

  encodeLayout(name: string, values: Values, base?: Uint8Array): Uint8Array {
    return this.encodeChoosing(this.layout(name), values, name, base);
  }

  decodeLayout(name: string, bytes: Uint8Array): Values {
    return this.decodeChoosing(this.layout(name), bytes, name);
  }

  offset(layout: string, field: string, ...index: number[]): number {
    return offsetOf(this.layout(layout), field, ...index);
  }

  /** The bytes a layout field covers, or the part of it under leading indexes. */
  span(layout: string, field: string, ...prefix: number[]): [number, number] {
    return fieldSpan(this.layout(layout), field, ...prefix);
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
    const got = this.decodeRaw(r.message ?? sent.name, reply);
    if (!got || !r.echo?.length) return got;
    const asked = this.decodeRaw(sent.name, sent.payload, false);
    return asked !== null && r.echo.every((e) => sameValue(got[e.reply], asked[e.request])) ? got : null;
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

  /** A request's answer read: with the reply message's layout, or the pieces' `layout` for an answer joined from them. */
  decodeAnswer(request: string, bytes: Uint8Array): Values {
    const layout = this.pieces(request)?.layout;
    return layout === undefined ? this.decode(this.replyName(request), bytes) : this.decodeLayout(layout, bytes);
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

  /** Every cmd template of the map with its header (sysex-plain), for a framer that reads cmds of several lengths. */
  knownCmds(): KnownCmd[] {
    const seen = new Map<string, KnownCmd>();
    for (const m of Object.values(this.messages)) {
      const k = `${m.header ?? ""}|${m.cmd}`;
      if (!seen.has(k)) seen.set(k, m.header === undefined ? { cmd: m.cmd } : { cmd: m.cmd, header: m.header });
    }
    return [...seen.values()];
  }

  /**
   * The messages from one side (the device's replies and notifies, or the host's requests and sends) that a payload on
   * this cmd reads as, by their sizes, consts and `not`s: the most specific first (more fixed cmd bytes, then a layout
   * the payload fills exactly, then more payload bytes pinned), then in the map's order. More than one name means the
   * map can't tell them apart. `header`: the entry of transport.frame.headers it came under (sysex-plain).
   */
  identify(cmd: Uint8Array, payload: Uint8Array, from: Side, header?: string): string[] {
    const dirs = SIDE_DIRS[from];
    return this.messagesForCmd(cmd, header)
      .filter((n) => dirs.includes(this.messages[n].dir) && this.decodeRaw(n, payload, false) !== null)
      .map((n) => {
        const cmdBytes = this.messages[n].cmd.split(" ").filter((t) => !t.startsWith("{")).length;
        return { n, cmdBytes, exact: layoutSize(this.payloadLayout(n)) === payload.length ? 1 : 0, pinned: this.shapeOf(n).is.size };
      })
      .sort((a, b) => b.cmdBytes - a.cmdBytes || b.exact - a.exact || b.pinned - a.pinned)
      .map((x) => x.n);
  }

  /**
   * Pairs of messages from the same side, on cmds that can be the same bytes, that one payload can read as both: the
   * map pins no byte (const or `not`) or length that tells them apart. A frame of either is named by `identify` alone.
   */
  lookalikes(): [string, string][] {
    const out: [string, string][] = [];
    for (const dirs of Object.values(SIDE_DIRS)) {
      const names = Object.keys(this.messages).filter((n) => dirs.includes(this.messages[n].dir));
      names.forEach((a, i) => {
        for (const b of names.slice(i + 1)) {
          if (cmdsOverlap(this.messages[a].cmd, this.messages[b].cmd) && shapesMeet(this.shapeOf(a), this.shapeOf(b))) out.push([a, b]);
        }
      });
    }
    return out;
  }

  /** A message's frame shape, worked out once: identify runs on every frame a simulator or a sniff decode reads. */
  private shapeOf(name: string): FrameShape {
    let s = this.shapes.get(name);
    if (!s) this.shapes.set(name, (s = frameShape(this.payloadLayout(name), this.protocol.transport.endian)));
    return s;
  }

  /**
   * Incoming dispatch: the device-side messages (reply/notify, then request) whose fixed cmd bytes match, under the
   * named header (sysex-plain) or, by default, the device's own.
   */
  messagesForCmd(cmd: Uint8Array, header?: string): string[] {
    const hex = Array.from(cmd, (b) => b.toString(16).padStart(2, "0"));
    const rank = { reply: 0, notify: 1, request: 2, send: 3 } as const;
    return Object.entries(this.messages)
      .filter(([, m]) => {
        const t = m.cmd.split(" ");
        return m.header === header && t.length === hex.length && t.every((x, i) => x.startsWith("{") || x === hex[i]);
      })
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
