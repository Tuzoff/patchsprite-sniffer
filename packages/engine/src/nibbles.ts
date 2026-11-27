// Bytes carried as nibble pairs: each byte goes as two bytes of 4 bits, its high half first ("hi-lo") or its low half
// first ("lo-hi"). The "sysex-nibbles" framing sends every inner byte this way; a layout's `packed` tail can send its
// data this way on any framing (packing "nibbles-hi-lo" or "nibbles-lo-hi"). No device fact lives here.

export type NibbleOrder = "hi-lo" | "lo-hi";

/** Each byte as two nibbles, in the given order. */
export function splitNibbles(bytes: Uint8Array, order: NibbleOrder): Uint8Array {
  const out = new Uint8Array(2 * bytes.length);
  const hiFirst = order === "hi-lo";
  bytes.forEach((b, i) => {
    out[2 * i] = hiFirst ? b >> 4 : b & 0x0f;
    out[2 * i + 1] = hiFirst ? b & 0x0f : b >> 4;
  });
  return out;
}

/** Nibble pairs joined back into bytes; throws on an odd count or a byte above 0x0f. */
export function joinNibbles(nibbles: Uint8Array, order: NibbleOrder): Uint8Array {
  if (nibbles.length % 2 !== 0 || nibbles.some((x) => x > 0x0f)) throw new Error("malformed nibble data");
  const out = new Uint8Array(nibbles.length / 2);
  const hiFirst = order === "hi-lo";
  for (let i = 0; i < out.length; i++) {
    const [a, b] = [nibbles[2 * i], nibbles[2 * i + 1]];
    out[i] = hiFirst ? (a << 4) | b : (b << 4) | a;
  }
  return out;
}
