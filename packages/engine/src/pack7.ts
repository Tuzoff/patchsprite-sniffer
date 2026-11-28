// 8-bit data carried in 7-bit SysEx bytes, and the CRC-32 some devices send with it. Generic: the device map's layout
// `packed` tail chooses the bit order and whether a CRC follows (see docs/formats/device-map.md). Browser-safe.

/** Where the first byte of a group keeps its top bit in the group's high-bits byte. */
export type TopBits = "first-in-bit6" | "first-in-bit0";

/** The bit of the high-bits byte that holds the top bit of the group's byte `i` (0..6). */
const bitFor = (order: TopBits, i: number) => (order === "first-in-bit6" ? 6 - i : i);

/** Bytes 8-to-7 packing makes of `n` data bytes: one high-bits byte per group of up to 7. */
export const packedLength = (n: number): number => n + Math.ceil(n / 7);

/**
 * Data bytes `p` packed bytes hold, or null when no data packs to that many (a group is a high-bits byte and at least
 * one data byte, so a lone trailing byte is impossible).
 */
export function unpackedLength(p: number): number | null {
  const r = p % 8;
  return r === 1 ? null : Math.floor(p / 8) * 7 + Math.max(r - 1, 0);
}

/** Each group of up to 7 bytes, preceded by a byte holding their top bits. */
export function pack8to7(data: Uint8Array, order: TopBits): Uint8Array {
  const out = new Uint8Array(packedLength(data.length));
  let o = 0;
  for (let g = 0; g < data.length; g += 7) {
    const head = o++;
    for (let i = 0; i < 7 && g + i < data.length; i++) {
      const b = data[g + i];
      out[head] |= (b >> 7) << bitFor(order, i);
      out[o++] = b & 0x7f;
    }
  }
  return out;
}

/** The inverse of pack8to7. Throws on a byte with the high bit set or a length no data packs to. */
export function unpack7to8(packed: Uint8Array, order: TopBits): Uint8Array {
  const n = unpackedLength(packed.length);
  if (n === null) throw new RangeError(`${packed.length} packed bytes end with a lone high-bits byte`);
  if (packed.some((b) => b > 0x7f)) throw new RangeError("a packed byte has the high bit set");
  const out = new Uint8Array(n);
  let o = 0;
  for (let g = 0; g < packed.length; g += 8) {
    const head = packed[g];
    for (let i = 0; i < 7 && g + 1 + i < packed.length; i++) out[o++] = packed[g + 1 + i] | (((head >> bitFor(order, i)) & 1) << 7);
  }
  return out;
}

let table: Uint32Array | null = null;

/** CRC-32 (reflected, polynomial edb88320, initial value ffffffff), with the usual final XOR of ffffffff or without it. */
export function crc32(data: Uint8Array, finalXor = true): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const b of data) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (finalXor ? crc ^ 0xffffffff : crc) >>> 0;
}

/** A 32-bit value as 5 septets, least significant first (the last holds the top 4 bits). */
export function septets32(x: number): Uint8Array {
  return Uint8Array.from({ length: 5 }, (_, i) => Math.floor(x / 2 ** (7 * i)) & 0x7f);
}
