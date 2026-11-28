// Records that cross the wire in pieces (docs/formats/device-map.md, "Records in pieces"): a device that sends
// a whole patch as several messages, each with a byte offset and a packed tail holding that many bytes of it.
// ByteJoiner knows nothing of maps (any reply sent in pieces at offsets can use it); RecordJoiner and recordPieces read
// the message's `packed.pieces` through the codec (codec.pieceSpec, codec.pieceOf). No device fact lives here.

import { hexOf, lastPieceAt, MAX_RECORD, ProtocolError, type Encoded, type Piece, type PieceSpec, type ProtocolCodec } from "./protocol-schema.ts";

type Values = Record<string, unknown>;

/**
 * Two pieces gave one byte different values: a report the unit sent of its own (a knob turned) where a piece would sit
 * and as long, or a unit sending the same piece twice with other bytes. The param-change driver asks a read in
 * pieces (a reply's `pieces`) once more on it; elsewhere (packed records, the sniffer) it fails as any ProtocolError.
 */
export class PiecesDisagree extends ProtocolError {
  constructor(message: string) {
    super(message);
    this.name = "PiecesDisagree";
  }
}

/**
 * Joins `size` bytes sent in pieces at offsets, in any order: `put` returns the joined bytes once every byte is filled.
 * A piece that repeats bytes already held must match them; a piece past the size, or more than twice the size received
 * in all (pieces sent again and again), is refused, so a device that never completes the record cannot hold it open.
 */
export class ByteJoiner {
  readonly size: number;
  private readonly bytes: Uint8Array;
  private readonly filled: Uint8Array;
  private held = 0;
  private received = 0;

  constructor(size: number) {
    if (!Number.isInteger(size) || size < 1 || size > MAX_RECORD) throw new ProtocolError(`a record of ${size} bytes; 1 to ${MAX_RECORD} are joined`);
    this.size = size;
    this.bytes = new Uint8Array(size);
    this.filled = new Uint8Array(size);
  }

  /** Bytes filled so far. */
  get have(): number {
    return this.held;
  }

  get complete(): boolean {
    return this.held === this.size;
  }

  /** Places a piece; returns the joined bytes (a copy) when this piece completes them, else null. */
  put(offset: number, piece: Uint8Array): Uint8Array | null {
    if (this.complete) throw new ProtocolError("the record is already complete");
    if (!Number.isInteger(offset) || offset < 0 || offset + piece.length > this.size) {
      throw new ProtocolError(`a piece of ${piece.length} bytes at ${offset} runs past the record's ${this.size} bytes`);
    }
    for (let i = 0; i < piece.length; i++) {
      const at = offset + i;
      if (!this.filled[at]) continue;
      if (this.bytes[at] !== piece[i]) throw new PiecesDisagree(`pieces disagree at byte ${at} of the record`);
    }
    // an empty piece counts as one byte, so endless empty pieces are refused too
    const received = this.received + Math.max(piece.length, 1);
    if (received > 2 * this.size) throw new ProtocolError(`${received} bytes received for a record of ${this.size} without completing it`);
    this.received = received;
    for (let i = 0; i < piece.length; i++) {
      const at = offset + i;
      if (this.filled[at]) continue;
      this.filled[at] = 1;
      this.bytes[at] = piece[i];
      this.held++;
    }
    return this.complete ? this.bytes.slice() : null;
  }
}

/** A decoded value as text, to compare two values (bytes as hex). */
const valueText = (v: unknown): string => JSON.stringify(v, (_, x) => (x instanceof Uint8Array ? hexOf(x) : x));

/**
 * Joins a record from its pieces (`codec.pieceOf(message, payload)` of each), then reads it with the record's layout. A
 * piece belongs to the record when its key (its fields but the offset, the tail, its length and checksums) has the
 * values in `expect` (decoded values, such as an enum's key) and, for those not in `expect`, the first piece's: a piece
 * of another record (another slot, a transfer given up on) is not taken, and `feed` returns null for it.
 */
export class RecordJoiner {
  readonly message: string;
  /** The record's layout name. */
  readonly record: string;
  private readonly codec: ProtocolCodec;
  private readonly joiner: ByteJoiner;
  private readonly expect: Map<string, string>;
  private keys: Map<string, string> | null = null;
  private joined: Uint8Array | null = null;
  /** Pieces taken. */
  pieces = 0;

  constructor(codec: ProtocolCodec, message: string, expect: Values = {}) {
    const spec = codec.pieceSpec(message);
    this.codec = codec;
    this.message = message;
    this.record = spec.layout;
    this.joiner = new ByteJoiner(spec.size);
    for (const k of Object.keys(expect)) {
      if (spec.vary.has(k)) throw new ProtocolError(`${message}: ${k} differs from piece to piece; it cannot be expected`);
      if (codec.field(message, k).type === "pad") throw new ProtocolError(`${message}: ${k} is padding, never decoded; it cannot be expected`);
    }
    this.expect = new Map(Object.entries(expect).map(([k, v]) => [k, valueText(v)]));
  }

  get size(): number {
    return this.joiner.size;
  }

  /** Bytes joined so far. */
  get have(): number {
    return this.joiner.have;
  }

  /** The joined bytes once complete, else null. */
  get bytes(): Uint8Array | null {
    return this.joined;
  }

  /** Whether this is a piece of this record (and the record is not complete yet). */
  takes(piece: Piece): boolean {
    if (this.joined) return false;
    const key = new Map(Object.entries(piece.key).map(([k, v]) => [k, valueText(v)]));
    for (const [k, v] of this.expect) if (key.get(k) !== v) return false;
    if (this.keys) for (const [k, v] of this.keys) if (key.get(k) !== v) return false;
    return true;
  }

  /**
   * Takes a piece; returns the record's fields when this piece completes it, else null (also for a piece that is not
   * this record's). Refuses a piece past the record's end, one that contradicts bytes already held, and a record sent
   * over and over without completing.
   */
  feed(piece: Piece): Values | null {
    if (!this.takes(piece)) return null;
    // a refused piece neither pins the record's key nor counts
    const done = this.joiner.put(piece.offset, piece.bytes);
    this.keys ??= new Map(Object.entries(piece.key).map(([k, v]) => [k, valueText(v)]));
    this.pieces++;
    if (!done) return null;
    this.joined = done;
    return this.codec.decodeLayout(this.record, done);
  }
}

/**
 * The messages that write a record in pieces: the record (its fields, or its bytes) encoded with its layout and cut into
 * pieces of the tail's maxLength, each sent with its offset and with `fields` (the other fields, the same in every
 * piece). Every piece is encoded before any is returned, so a refusal sends nothing.
 */
export function recordPieces(codec: ProtocolCodec, message: string, record: Values | Uint8Array, fields: Values = {}, args: Record<string, number> = {}): Encoded[] {
  const { tail, layout, size, offsetField }: PieceSpec = codec.pieceSpec(message);
  for (const k of [offsetField, tail.name]) if (Object.hasOwn(fields, k)) throw new ProtocolError(`${message}: ${k} is set for each piece; do not pass it`);
  const bytes = record instanceof Uint8Array ? record : codec.encodeLayout(layout, record);
  if (bytes.length !== size) throw new ProtocolError(`${message}: a record of ${bytes.length} bytes, but ${layout} has ${size}`);
  const out: Encoded[] = [];
  for (let at = 0; at <= lastPieceAt(size, tail.maxLength); at += tail.maxLength) {
    out.push(codec.encode(message, { ...fields, [offsetField]: at, [tail.name]: bytes.subarray(at, at + tail.maxLength) }, args));
  }
  return out;
}
