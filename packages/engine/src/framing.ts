// The generic framing engines, laid out as the device map's `transport` says (see docs/formats/device-map.md).
// No device fact lives here.
//
// "sysex-nibbles" (Framer): SysEx frames carrying an inner message split into nibbles.
//   frame = header | preamble | the four frame fields in the map's order | data nibbles | terminator
//   inner = cmd | payload length | payload (compressed when the map says so)
//
// "sysex-xor" (XorFramer): one SysEx message per inner message, its data 7-bit as sent.
//   frame = header | cmd | payload | checksum (XOR of every byte from f0 to the last payload byte, masked) | terminator
//
// "sysex-plain" (PlainFramer): one SysEx message per inner message with nothing added, its data 7-bit as sent.
//   frame = header (the device's, or one the map names for some messages) | cmd (1 to 8 bytes) | payload | terminator
//
// "roland-address" (AddressFramer): one SysEx message per inner message, its cmd a command and an address.
//   frame = header | cmd (command, address) | payload | checksum (address and payload sum to 0 mod 128) | terminator
//
// messageFramer() picks the engine for a framing that carries each inner message in one SysEx message, which is what
// the param-change driver and its simulator take: they never name a framing themselves.

import { compressLiteral, decompress } from "./lzo.ts";
import { joinNibbles, splitNibbles } from "./nibbles.ts";
import { ByteJoiner } from "./record-pieces.ts";
import { addressBytes, addressValue, cmdLengths, hexOf, parseHex, ProtocolError, type AddressTransport, type PlainTransport, type NibbleTransport as TransportDef, type Transport, type XorTransport } from "./protocol-schema.ts";
import { SafetyError } from "./safety.ts";

export type FrameDirection = "request" | "send" | "reply" | "notify";

export interface Frame {
  kind: number;
  csum: number;
  total: number;
  offset: number;
  data: Uint8Array;
}

export interface InnerMessage {
  /** The cmd bytes as lowercase hex pairs, "a1 10 03". */
  cmd: string;
  /** The payload as sent (compressed when the map says so). */
  raw: Uint8Array;
  /** The payload as the codec reads it, or null if it did not decompress. */
  data: Uint8Array | null;
  /** sysex-plain: the entry of transport.frame.headers it came under; omitted: the device's header. */
  header?: string;
}

/** Frames and inner messages for one device's transport. */
export class Framer {
  readonly def: TransportDef;
  private readonly header: Uint8Array;
  private readonly preamble: Uint8Array;
  private readonly terminator: Uint8Array;
  /** bytes of the total and offset fields */
  private readonly lenBytes: number;
  /** where the frame fields start, and the data after them */
  private readonly metaAt: number;
  private readonly dataAt: number;

  constructor(def: Transport) {
    if (def.framing !== "sysex-nibbles") throw new Error(`this framing engine reads sysex-nibbles, not ${def.framing}`);
    this.def = def;
    this.header = parseHex(def.frame.header);
    this.preamble = parseHex(def.frame.preamble ?? "");
    this.terminator = parseHex(def.frame.terminator);
    this.lenBytes = Math.ceil(def.frame.lengthBits / 7);
    this.metaAt = this.header.length + this.preamble.length;
    this.dataAt = this.metaAt + 2 + 2 * this.lenBytes;
  }

  kind(dir: FrameDirection): number {
    const k = this.def.frame.kinds;
    return dir === "request" ? k.request : dir === "send" ? k.send : dir === "reply" ? (k.reply ?? k.send) : (k.notify ?? k.reply ?? k.send);
  }

  /** cmd | length | payload, compressed when the map says so. An empty payload is sent as is. */
  buildInner(cmd: Uint8Array, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
    const inner = this.def.inner;
    if (cmd.length !== inner.cmdLength) throw new Error(`a cmd is ${inner.cmdLength} bytes, got ${cmd.length}`);
    const p = payload.length && inner.compression === "lzo1x-literal" ? compressLiteral(payload) : payload;
    const lw = inner.length.type === "u16" ? 2 : 4;
    if (p.length >= 2 ** (8 * lw)) throw new Error(`a payload of ${p.length} bytes does not fit the length field`);
    const out = new Uint8Array(cmd.length + lw + p.length);
    out.set(cmd, 0);
    const v = new DataView(out.buffer);
    const le = inner.length.endian === "le";
    if (lw === 2) v.setUint16(cmd.length, p.length, le);
    else v.setUint32(cmd.length, p.length, le);
    out.set(p, cmd.length + lw);
    return out;
  }

  parseInner(inner: Uint8Array): InnerMessage {
    const def = this.def.inner;
    const lw = def.length.type === "u16" ? 2 : 4;
    const v = new DataView(inner.buffer, inner.byteOffset, inner.byteLength);
    const le = def.length.endian === "le";
    const n = inner.length >= def.cmdLength + lw ? (lw === 2 ? v.getUint16(def.cmdLength, le) : v.getUint32(def.cmdLength, le)) : 0;
    const raw = inner.slice(def.cmdLength + lw, def.cmdLength + lw + n);
    let data: Uint8Array | null;
    if (def.compression === "none") data = raw;
    else {
      try {
        data = raw.length ? decompress(raw) : new Uint8Array(0);
      } catch {
        data = null;
      }
    }
    return { cmd: hexOf(inner.subarray(0, def.cmdLength)), raw, data };
  }

  private putLength(f: Uint8Array, at: number, n: number): void {
    for (let i = 0; i < this.lenBytes; i++) f[at + i] = (n >> (7 * i)) & 0x7f;
  }

  private getLength(f: Uint8Array, at: number): number {
    let n = 0;
    for (let i = 0; i < this.lenBytes; i++) n |= f[at + i] << (7 * i);
    return n;
  }

  /** Where each frame field sits, from the map's order. */
  private positions(): Record<"checksum" | "kind" | "total" | "offset", number> {
    const out = { checksum: 0, kind: 0, total: 0, offset: 0 };
    let at = this.metaAt;
    for (const name of this.def.frame.fields) {
      out[name] = at;
      at += name === "checksum" || name === "kind" ? 1 : this.lenBytes;
    }
    return out;
  }

  encodeFrames(inner: Uint8Array, kind: number): Uint8Array[] {
    const fr = this.def.frame;
    const tot = inner.length;
    if (tot >= 2 ** fr.lengthBits) throw new Error(`inner message of ${tot} bytes does not fit the ${fr.lengthBits}-bit length field`);
    const at = this.positions();
    const frames: Uint8Array[] = [];
    for (let off = 0; off < Math.max(tot, 1); off += fr.chunk) {
      const part = inner.subarray(off, off + fr.chunk);
      const nib = splitNibbles(part, fr.nibbles);
      const f = new Uint8Array(this.dataAt + nib.length + this.terminator.length);
      f.set(nib, this.dataAt);
      const sum = nib.reduce((n, x) => n + x, 0);
      f.set(this.header, 0);
      f.set(this.preamble, this.header.length);
      f[at.checksum] = sum & fr.checksum.mask;
      f[at.kind] = kind;
      this.putLength(f, at.total, tot);
      this.putLength(f, at.offset, off);
      f.set(this.terminator, f.length - this.terminator.length);
      frames.push(f);
    }
    return frames;
  }

  /**
   * One frame of this device; throws on anything else. The checksum is read, not enforced: none of the replies recorded
   * from the device carry the sum the host sends, so rejecting a mismatch would drop every real reply.
   */
  decodeFrame(f: Uint8Array): Frame {
    const t = this.terminator;
    if (
      f.length < this.dataAt + t.length ||
      this.header.some((b, i) => f[i] !== b) ||
      t.some((b, i) => f[f.length - t.length + i] !== b)
    ) {
      throw new Error("not a frame of this device");
    }
    const data = joinNibbles(f.subarray(this.dataAt, f.length - t.length), this.def.frame.nibbles);
    const at = this.positions();
    return { kind: f[at.kind], csum: f[at.checksum], total: this.getLength(f, at.total), offset: this.getLength(f, at.offset), data };
  }

  reassembler(): Reassembler {
    return new Reassembler(this);
  }

  /**
   * A regular expression, over a frame as lowercase hex with no spaces and anchored at its start by the caller, that
   * matches the first frame of an inner message with this cmd, in either direction. Like decodeFrame it reads the
   * header, not the preamble; the kind, checksum and total match anything, the offset only 0. The same syntax works in
   * JavaScript and Python.
   */
  cmdPattern(cmd: Uint8Array): string {
    if (cmd.length !== this.def.inner.cmdLength) throw new Error(`a cmd is ${this.def.inner.cmdLength} bytes, got ${cmd.length}`);
    if (cmd.length > this.def.frame.chunk) throw new Error("the cmd does not fit the first frame");
    const any = (bytes: number) => `[0-9a-f]{${2 * bytes}}`;
    const fields = this.def.frame.fields.map((f) => (f === "offset" ? "00".repeat(this.lenBytes) : any(f === "total" ? this.lenBytes : 1)));
    const nibbles = Array.from(splitNibbles(cmd, this.def.frame.nibbles), (n) => `0${n.toString(16)}`).join("");
    return `${hexOf(this.header).replace(/ /g, "")}${any(this.preamble.length)}${fields.join("")}${nibbles}`;
  }
}

/** Feed whole frames of one direction; returns an inner message when its last frame arrives. */
export class Reassembler {
  private parts: Uint8Array[] = [];
  private have = 0;
  private total: number | null = null;
  private readonly framer: Framer;

  constructor(framer: Framer) {
    this.framer = framer;
  }

  feed(frame: Uint8Array): InnerMessage | null {
    const d = this.framer.decodeFrame(frame);
    if (d.offset === 0) {
      this.parts = [];
      this.have = 0;
      this.total = d.total;
    }
    if (this.total === null) return null; // joined mid-message
    if (d.offset !== this.have || d.total !== this.total) {
      // a dropped or repeated frame: discard the message rather than return corrupt bytes
      this.parts = [];
      this.have = 0;
      this.total = null;
      return null;
    }
    this.parts.push(d.data);
    this.have += d.data.length;
    if (this.have < this.total) return null;
    const inner = new Uint8Array(this.have);
    let o = 0;
    for (const p of this.parts) {
      inner.set(p, o);
      o += p.length;
    }
    this.parts = [];
    this.have = 0;
    this.total = null;
    return this.framer.parseInner(inner);
  }
}

/** Splits a raw MIDI input stream (driver buffers of any size) into SysEx messages. */
export class SysexSplitter {
  private buf: number[] = [];

  push(chunk: Uint8Array): Uint8Array[] {
    const frames: Uint8Array[] = [];
    for (const b of chunk) {
      if (b === 0xf0) this.buf = [];
      this.buf.push(b);
      if (b === 0xf7) {
        if (this.buf[0] === 0xf0) frames.push(Uint8Array.from(this.buf));
        this.buf = [];
      }
    }
    return frames;
  }
}

/** Frames for a "sysex-xor" transport: one SysEx message per inner message, no chunks, nibbles or length field. */
export class XorFramer {
  readonly def: XorTransport;
  private readonly header: Uint8Array;

  private readonly unchecked: Set<string>;

  /**
   * `noChecksum`: cmds (hex) whose incoming messages carry no checksum byte (the map's messages marked noChecksum).
   * Only the host's framer takes them: the device answers some requests with the request's own cmd, unchecked.
   */
  constructor(def: Transport, noChecksum: string[] = []) {
    if (def.framing !== "sysex-xor") throw new Error(`this framing engine reads sysex-xor, not ${def.framing}`);
    this.def = def;
    this.header = parseHex(def.frame.header);
    this.unchecked = new Set(noChecksum);
  }

  private checksum(f: Uint8Array, end: number): number {
    let x = 0;
    for (let i = 0; i < end; i++) x ^= f[i];
    return x & this.def.frame.checksum.mask;
  }

  /**
   * header | cmd | payload | checksum | f7. `checksum: false` leaves the checksum byte out, as the device does for a
   * message the map marks noChecksum (the simulator speaks as the device). Refuses a byte with the high bit set, which
   * SysEx data cannot carry.
   */
  encode(cmd: Uint8Array, payload: Uint8Array = new Uint8Array(0), checksum = true): Uint8Array {
    if (cmd.length !== this.def.inner.cmdLength) throw new Error(`a cmd is ${this.def.inner.cmdLength} bytes, got ${cmd.length}`);
    const bad = cmd.find((b) => b > 0x7f) ?? payload.find((b) => b > 0x7f);
    // a refusal, since nothing has been sent: the tool says so instead of dropping the connection
    if (bad !== undefined) throw new SafetyError(`byte ${bad} is not 7-bit; a SysEx message cannot carry it`);
    const sum = checksum ? 1 : 0;
    const f = new Uint8Array(this.header.length + cmd.length + payload.length + sum + 1);
    f.set(this.header, 0);
    f.set(cmd, this.header.length);
    f.set(payload, this.header.length + cmd.length);
    if (sum) f[f.length - 2] = this.checksum(f, f.length - 2);
    f[f.length - 1] = 0xf7;
    return f;
  }

  /** As Framer.cmdPattern: a regular expression over a message as lowercase hex, anchored by the caller, for this cmd. */
  cmdPattern(cmd: Uint8Array): string {
    if (cmd.length !== this.def.inner.cmdLength) throw new Error(`a cmd is ${this.def.inner.cmdLength} bytes, got ${cmd.length}`);
    return `${hexOf(this.header).replace(/ /g, "")}${hexOf(cmd).replace(/ /g, "")}`;
  }

  /** One message of this device as an inner message; throws on anything else, and on a bad checksum when the map verifies. */
  decode(f: Uint8Array): InnerMessage {
    const h = this.header;
    const cmdAt = h.length;
    const n = this.def.inner.cmdLength;
    if (f.length < cmdAt + n + 1 || h.some((b, i) => f[i] !== b) || f[f.length - 1] !== 0xf7) throw new Error("not a message of this device");
    const cmd = hexOf(f.subarray(cmdAt, cmdAt + n));
    // a message the device sends without a checksum: everything up to the f7 is payload (possibly none)
    if (this.unchecked.has(cmd)) {
      const payload = f.slice(cmdAt + n, f.length - 1);
      return { cmd, raw: payload, data: payload };
    }
    if (f.length < cmdAt + n + 2) throw new Error("not a message of this device");
    if (this.def.frame.checksum.verify && f[f.length - 2] !== this.checksum(f, f.length - 2)) throw new Error("checksum mismatch");
    const payload = f.slice(cmdAt + n, f.length - 2);
    return { cmd, raw: payload, data: payload };
  }
}

/** An outgoing message as the codec encodes it: the framing engine adds the rest. */
export interface OutgoingMessage {
  cmd: Uint8Array;
  payload: Uint8Array;
  /** sysex-plain: the entry of transport.frame.headers it goes under; omitted: the device's header. */
  header?: string;
}

/** A framing engine that carries each inner message in one SysEx message, whatever the framing. */
export interface MessageFramer {
  /** The message framed for the wire. `checksum: false` leaves out a checksum where the framing has one: only the
   * simulator, speaking as the device, sends a message the map marks noChecksum. */
  frame(m: OutgoingMessage, opts?: { checksum?: boolean }): Uint8Array;
  /** One message of this device as an inner message; throws on anything else. */
  decode(frame: Uint8Array): InnerMessage;
  /**
   * Where the framing carries a device ID set per unit (roland-address with the map's `deviceIdAt`): the unit's own ID
   * a message of this device carries, or undefined when it does not decode or carries the broadcast ID 7f, which
   * SysEx reserves for "all units" and is no unit's own (the host's broadcast request echoed back by a MIDI thru, say).
   * A map default that is a real ID (a factory default) is learned like any other: the host sends to it already. The
   * caller keeps a learned ID outside the map and passes it back as `deviceId`.
   */
  deviceIdOf?(frame: Uint8Array): number | undefined;
  /** The device ID this framer's messages carry, where the framing has one: the one given, else the map's default. */
  readonly deviceId?: number;
  /**
   * Where the framing addresses its data (roland-address): joins the answer to a read of `size` bytes sent in pieces at
   * successive addresses, the first at `cmd` (the answer's own cmd).
   */
  reassembler?(cmd: Uint8Array, size: number, step?: number): PieceReassembler;
  /** Where the framing addresses its data: the message split as the map's `maxData` says, each piece at its address. */
  framePieces?(m: OutgoingMessage): Uint8Array[];
}

/** Joins an answer that comes in pieces (AddressReassembler): feed each incoming message; the data once complete. */
export interface PieceReassembler {
  /** Whether this message is a piece of the answer still being joined (anything else is for its own handler). */
  takes(m: InnerMessage): boolean;
  /** The joined data when this message completes the answer, else null; throws on a piece that runs past the size or is sent again with other bytes. */
  feed(m: InnerMessage): Uint8Array | null;
  /** Whether this message is one of the answer's pieces, taken or not (a late or repeated one): never another's. */
  within(m: InnerMessage): boolean;
}

export interface MessageFramerOptions {
  /** cmds (hex) whose incoming messages carry no checksum byte (the map's messages marked noChecksum) */
  noChecksum?: string[];
  /** sysex-plain: every cmd template of the map with its header (ProtocolCodec.knownCmds), to read cmds of several lengths */
  known?: KnownCmd[];
  /**
   * The unit's own device ID, learned with deviceIdOf: messages go to it and only it is heard. Taken where the framing
   * has a device ID (roland-address with `deviceIdAt`); a framing without one has nothing to set and ignores it.
   */
  deviceId?: number;
}

/** The SysEx device ID that addresses every unit (the "all call"): a framing fact, never one unit's own ID. */
export const BROADCAST_ID = 0x7f;

/** The framing engine for a transport whose messages each fit one SysEx message, or a refusal naming the framing. */
export function messageFramer(def: Transport, opts: MessageFramerOptions = {}): MessageFramer {
  switch (def.framing) {
    case "sysex-xor": {
      const x = new XorFramer(def, opts.noChecksum);
      return { frame: (m, o) => x.encode(m.cmd, m.payload, o?.checksum ?? true), decode: (f) => x.decode(f) };
    }
    case "sysex-plain": {
      // no checksum to leave out
      const x = new PlainFramer(def, opts.known ?? []);
      return { frame: (m) => x.encode(m.cmd, m.payload, m.header), decode: (f) => x.decode(f) };
    }
    case "roland-address": {
      const at = def.frame.deviceIdAt;
      const x = new AddressFramer(def, at === undefined ? {} : { deviceId: opts.deviceId });
      const framer: MessageFramer = {
        frame: (m, o) => x.encode(m.cmd, m.payload, o?.checksum ?? true),
        decode: (f) => x.decode(f),
        reassembler: (cmd, size, step) => x.reassembler(cmd, size, step),
        framePieces: (m) => x.encodePieces(m.cmd, m.payload),
      };
      if (at === undefined) return framer;
      const deviceIdOf = (f: Uint8Array) => {
        const id = x.deviceIdOf(f);
        return id === BROADCAST_ID ? undefined : id;
      };
      return { ...framer, deviceIdOf, deviceId: opts.deviceId ?? parseHex(def.frame.header)[at] };
    }
    default:
      throw new Error(`no single-message framing engine for "${def.framing}": the param-change driver can't run on it`);
  }
}

/** A cmd template of the map ("64 {slot}") and the header it goes under (omitted: the device's). */
export interface KnownCmd {
  cmd: string;
  header?: string;
}

/**
 * Frames for a "sysex-plain" transport: header | cmd | payload | f7, nothing added. When the map's cmds differ in
 * length, an incoming message's cmd is the longest of `known` (ProtocolCodec.knownCmds) under its header that its bytes
 * start with; the map's checks make that one cmd. A message no known cmd fits is read with the shortest cmd length.
 */
export class PlainFramer {
  readonly def: PlainTransport;
  /** Header bytes by name ("" is the device's own), longest first, so a message is read under the longest it starts with. */
  private readonly headers: [string, Uint8Array][];
  private readonly min: number;
  private readonly max: number;
  /** Known cmd tokens per header name, longest first. */
  private readonly known = new Map<string, string[][]>();

  constructor(def: Transport, known: KnownCmd[] = []) {
    if (def.framing !== "sysex-plain") throw new Error(`this framing engine reads sysex-plain, not ${def.framing}`);
    this.def = def;
    ({ min: this.min, max: this.max } = cmdLengths(def));
    const named = Object.entries(def.frame.headers ?? {}).map(([n, h]): [string, Uint8Array] => [n, parseHex(h)]);
    this.headers = [["", parseHex(def.frame.header)] as [string, Uint8Array], ...named].sort((a, b) => b[1].length - a[1].length);
    for (const k of known) {
      const t = k.cmd.split(" ");
      if (t.length < this.min || t.length > this.max) continue;
      const h = k.header ?? "";
      if (!this.known.has(h)) this.known.set(h, []);
      this.known.get(h)!.push(t);
    }
    for (const list of this.known.values()) list.sort((a, b) => b.length - a.length);
  }

  private header(name: string | undefined): Uint8Array {
    const h = this.headers.find(([n]) => n === (name ?? ""));
    if (!h) throw new Error(`no header "${name}" in transport.frame.headers`);
    return h[1];
  }

  private checkCmd(cmd: Uint8Array): void {
    if (cmd.length < this.min || cmd.length > this.max) {
      throw new Error(`a cmd is ${this.min === this.max ? this.min : `${this.min} to ${this.max}`} bytes, got ${cmd.length}`);
    }
  }

  /**
   * header | cmd | payload | f7, under the device's header or the named one. Refuses a byte with the high bit set,
   * which SysEx data cannot carry.
   */
  encode(cmd: Uint8Array, payload: Uint8Array = new Uint8Array(0), header?: string): Uint8Array {
    this.checkCmd(cmd);
    const h = this.header(header);
    const bad = cmd.find((b) => b > 0x7f) ?? payload.find((b) => b > 0x7f);
    // a refusal, since nothing has been sent: the tool says so instead of dropping the connection
    if (bad !== undefined) throw new SafetyError(`byte ${bad} is not 7-bit; a SysEx message cannot carry it`);
    const f = new Uint8Array(h.length + cmd.length + payload.length + 1);
    f.set(h, 0);
    f.set(cmd, h.length);
    f.set(payload, h.length + cmd.length);
    f[f.length - 1] = 0xf7;
    return f;
  }

  /** As Framer.cmdPattern: a regular expression over a message as lowercase hex, anchored by the caller, for this cmd. */
  cmdPattern(cmd: Uint8Array, header?: string): string {
    this.checkCmd(cmd);
    return `${hexOf(this.header(header)).replace(/ /g, "")}${hexOf(cmd).replace(/ /g, "")}`;
  }

  /** One message of this device as an inner message; throws on anything else. */
  decode(f: Uint8Array): InnerMessage {
    const hit = f.at(-1) === 0xf7 ? this.headers.find(([, h]) => f.length >= h.length + this.min + 1 && h.every((b, i) => f[i] === b)) : undefined;
    if (!hit) throw new Error("not a message of this device");
    const [name, h] = hit;
    const at = h.length;
    const room = f.length - 1 - at;
    let n = this.min;
    if (this.max > this.min) {
      const fits = (t: string[]) => t.length <= room && t.every((x, i) => x.startsWith("{") || parseInt(x, 16) === f[at + i]);
      n = this.known.get(name)?.find(fits)?.length ?? this.min;
    }
    const payload = f.slice(at + n, f.length - 1);
    const m: InnerMessage = { cmd: hexOf(f.subarray(at, at + n)), raw: payload, data: payload };
    if (name) m.header = name;
    return m;
  }
}

// ---- address-based SysEx -----------------------------------------------------------------------------------------

/** Frames for a "roland-address" transport: header | cmd (command, address) | payload | checksum | f7. */
export class AddressFramer {
  readonly def: AddressTransport;
  private readonly header: Uint8Array;
  /** where the address starts in a cmd (the command bytes come before it) */
  readonly addressAt: number;
  /** The unit's own device ID when known, else undefined (the map's header byte is sent, and any ID is heard). */
  readonly deviceId: number | undefined;

  /**
   * `deviceId`: the unit's own device ID, learned from it (deviceIdOf on its first answer to a request of this framer) and kept
   * outside the map, since it is set per unit, not per model. With it, messages go to that ID and only messages from
   * it are heard (another unit of the model on the same chain is not). Without it, the header's byte at the map's
   * `deviceIdAt` is sent (its default, such as the broadcast 7f) and any ID is heard there. Needs `deviceIdAt`.
   */
  constructor(def: Transport, { deviceId }: { deviceId?: number } = {}) {
    if (def.framing !== "roland-address") throw new Error(`this framing engine reads roland-address, not ${def.framing}`);
    this.def = def;
    this.header = parseHex(def.frame.header);
    this.addressAt = def.inner.cmdLength - def.inner.addressBytes;
    if (deviceId !== undefined) {
      if (def.frame.deviceIdAt === undefined) throw new Error("a device ID needs the map's frame.deviceIdAt");
      if (!Number.isInteger(deviceId) || deviceId < 0 || deviceId > 0x7f) throw new Error(`device ID ${deviceId} is not 7-bit`);
      this.header[def.frame.deviceIdAt] = deviceId;
    }
    this.deviceId = deviceId;
  }

  /**
   * The device ID a message of this device carries (to learn the unit's own from its answer), or undefined where the
   * map names none or the message does not decode (cut off, another device's, a bad checksum). A Universal Identity
   * Reply (f0 7e ...) does not carry this header, so it teaches nothing here.
   */
  deviceIdOf(f: Uint8Array): number | undefined {
    const at = this.def.frame.deviceIdAt;
    if (at === undefined) return undefined;
    try {
      this.decode(f);
    } catch {
      return undefined;
    }
    return f[at];
  }

  /** The address and payload bytes (everything between the command and the checksum) sum to 0 modulo 128. */
  private checksum(f: Uint8Array, end: number): number {
    let sum = 0;
    for (let i = this.header.length + this.addressAt; i < end; i++) sum += f[i];
    return (128 - (sum % 128)) & 0x7f;
  }

  private checkCmd(cmd: Uint8Array): void {
    if (cmd.length !== this.def.inner.cmdLength) throw new Error(`a cmd is ${this.def.inner.cmdLength} bytes, got ${cmd.length}`);
  }

  /** The address a cmd names, as a number. */
  address(cmd: Uint8Array): number {
    this.checkCmd(cmd);
    return addressValue(cmd.subarray(this.addressAt));
  }

  /** The cmd with its address moved `n` bytes on (the command kept). */
  advance(cmd: Uint8Array, n: number): Uint8Array {
    const out = Uint8Array.from(cmd);
    out.set(addressBytes(this.address(cmd) + n, this.def.inner.addressBytes), this.addressAt);
    return out;
  }

  /**
   * header | cmd | payload | checksum | f7, the header as the map has it (with the unit's device ID when known).
   * `checksum: false` leaves the checksum byte out (no message of this framing does; the parameter keeps the shape the
   * other message framers share). Refuses a byte with the high bit set, which SysEx data cannot carry.
   */
  encode(cmd: Uint8Array, payload: Uint8Array = new Uint8Array(0), checksum = true): Uint8Array {
    this.checkCmd(cmd);
    const bad = cmd.find((b) => b > 0x7f) ?? payload.find((b) => b > 0x7f);
    // a refusal, since nothing has been sent: the tool says so instead of dropping the connection
    if (bad !== undefined) throw new SafetyError(`byte ${bad} is not 7-bit; a SysEx message cannot carry it`);
    const sum = checksum ? 1 : 0;
    const f = new Uint8Array(this.header.length + cmd.length + payload.length + sum + 1);
    f.set(this.header, 0);
    f.set(cmd, this.header.length);
    f.set(payload, this.header.length + cmd.length);
    if (sum) f[f.length - 2] = this.checksum(f, f.length - 2);
    f[f.length - 1] = 0xf7;
    return f;
  }

  /**
   * A write of any length: one message, or pieces of at most the map's `maxData` bytes at successive addresses (the
   * first at the cmd's own). Every piece is built before any is returned, so a refusal sends nothing.
   */
  encodePieces(cmd: Uint8Array, payload: Uint8Array = new Uint8Array(0)): Uint8Array[] {
    const max = this.def.frame.maxData;
    if (max === undefined || payload.length <= max) return [this.encode(cmd, payload)];
    const out: Uint8Array[] = [];
    for (let at = 0; at < payload.length; at += max) out.push(this.encode(this.advance(cmd, at), payload.subarray(at, at + max)));
    return out;
  }

  /** Where any device ID is heard: the map names its byte and the unit's own is not known yet. */
  private get anyIdAt(): number | undefined {
    return this.deviceId === undefined ? this.def.frame.deviceIdAt : undefined;
  }

  /** Whether a message starts with this device's header (the device ID byte may be any until the unit's is known). */
  private headerMatches(f: Uint8Array): boolean {
    const at = this.anyIdAt;
    return this.header.every((b, i) => f[i] === b || (i === at && f[i] <= 0x7f));
  }

  /** As XorFramer.cmdPattern; the device ID byte matches any until the unit's own is known. */
  cmdPattern(cmd: Uint8Array): string {
    this.checkCmd(cmd);
    const at = this.anyIdAt;
    const header = Array.from(this.header, (b, i) => (i === at ? "[0-7][0-9a-f]" : hexOf([b]))).join("");
    return `${header}${hexOf(cmd).replace(/ /g, "")}`;
  }

  /** One message of this device as an inner message; throws on anything else, and on a bad checksum when the map verifies. */
  decode(f: Uint8Array): InnerMessage {
    const cmdAt = this.header.length;
    const n = this.def.inner.cmdLength;
    if (f.length < cmdAt + n + 2 || !this.headerMatches(f) || f[f.length - 1] !== 0xf7) throw new Error("not a message of this device");
    // SysEx data is 7-bit: a byte with the high bit set (a stray status byte) is not this device's, verified or not
    if (f.subarray(cmdAt, f.length - 1).some((b) => b > 0x7f)) throw new Error("not a message of this device: a byte is not 7-bit");
    if (this.def.frame.checksum.verify && f[f.length - 2] !== this.checksum(f, f.length - 2)) throw new Error("checksum mismatch");
    const payload = f.slice(cmdAt + n, f.length - 2);
    return { cmd: hexOf(f.subarray(cmdAt, cmdAt + n)), raw: payload, data: payload };
  }

  /**
   * Joins the pieces of the answer to a read of `size` bytes from the address in `cmd` (the answer's own cmd); with a
   * `step` (the map's `pieces.step`), each that many bytes but the last.
   */
  reassembler(cmd: Uint8Array, size: number, step?: number): AddressReassembler {
    return new AddressReassembler(this, cmd, size, step);
  }
}

/**
 * Joins a read's answer sent in pieces at successive addresses: feed each incoming message; returns the data once every
 * byte of the size is filled. It is the shared joiner (ByteJoiner) with each piece's offset its address less the
 * read's: pieces may come in any order, a piece sent again must carry the same bytes, and one that runs past the size is
 * refused. A message with another command, or at an address outside the read, is not part of it and is left alone (the
 * unit may report a change meanwhile); a dropped piece leaves the read unanswered, for the caller's timeout. With a
 * `step` (the size the unit splits an answer into, the map's `pieces.step`), only a message where that split puts a
 * piece, and not shorter than that piece, is one: a report the unit sends of its own inside the read's range (a knob
 * turned meanwhile) is left alone too, unless it happens to start where a piece would and be as long. A longer or empty
 * one is taken, so the caller refuses it (over the map's maxPiece, or empty) rather than wait for the deadline.
 */
export class AddressReassembler {
  private readonly framer: AddressFramer;
  private readonly command: string;
  private readonly start: number;
  private readonly joiner: ByteJoiner;
  private readonly step: number | undefined;

  constructor(framer: AddressFramer, cmd: Uint8Array, size: number, step?: number) {
    this.joiner = new ByteJoiner(size);
    this.step = step;
    this.framer = framer;
    this.start = framer.address(cmd);
    this.command = hexOf(cmd.subarray(0, framer.addressAt));
  }

  get size(): number {
    return this.joiner.size;
  }

  /** Whether this message is a piece of the read still being joined (anything else is for its own handler). */
  takes(m: InnerMessage): boolean {
    return !this.joiner.complete && this.within(m);
  }

  /** Whether this message is the answer's command at an address inside the read, joined or not. */
  within(m: InnerMessage): boolean {
    return this.offsetOf(m) !== undefined;
  }

  /** The message's offset into the read when it is the answer's command at an address inside it, else undefined. */
  private offsetOf(m: InnerMessage): number | undefined {
    try {
      const cmd = parseHex(m.cmd);
      if (hexOf(cmd.subarray(0, this.framer.addressAt)) !== this.command) return undefined;
      const at = this.framer.address(cmd) - this.start;
      if (at < 0 || at >= this.size) return undefined;
      // where the unit's split puts a piece, and not shorter than that piece (the last runs to the end of the read): a
      // longer or empty one is still the answer's, for the caller to refuse
      const s = this.step;
      const n = (m.data ?? m.raw).length;
      return s === undefined || (at % s === 0 && (n === 0 || n >= Math.min(s, this.size - at))) ? at : undefined;
    } catch {
      return undefined;
    }
  }

  /** The joined data when this message completes the read, else null (also for a message it does not take). */
  feed(m: InnerMessage): Uint8Array | null {
    const at = this.joiner.complete ? undefined : this.offsetOf(m);
    if (at === undefined) return null;
    return this.joiner.put(at, m.data ?? m.raw);
  }
}
