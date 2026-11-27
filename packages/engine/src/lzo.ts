// LZO1X decompressor and a literal-only "compressor", for transports whose payloads are LZO1X streams
// (transport.inner.compression "lzo1x-literal"). Writers may send literal-only streams.

export function decompress(src: Uint8Array, maxOut = 1 << 20): Uint8Array {
  const out: number[] = [];
  let ip = 0;

  const need = (n: number): void => {
    if (ip + n > src.length) throw new Error("lzo: input overrun");
  };
  const ext = (base: number): number => {
    let t = 0;
    need(1);
    while (src[ip] === 0) {
      t += 255;
      ip++;
      need(1);
    }
    t += base + src[ip];
    ip++;
    return t;
  };
  const copyMatch = (dist: number, n: number): void => {
    let p = out.length - dist;
    if (p < 0) throw new Error("lzo: lookbehind overrun");
    if (out.length + n > maxOut) throw new Error("lzo: output too large");
    for (let i = 0; i < n; i++) out.push(out[p++]);
  };
  const copyLiterals = (n: number): void => {
    need(n);
    if (out.length + n > maxOut) throw new Error("lzo: output too large");
    for (let i = 0; i < n; i++) out.push(src[ip++]);
  };

  // state = literals copied by the previous instruction: 0, 1..3, or 4 for a long run
  let state = 0;
  need(1);
  let t = src[ip];
  if (t > 17) {
    ip++;
    const n = t - 17;
    copyLiterals(n);
    state = n >= 4 ? 4 : n;
  }
  for (;;) {
    if (ip >= src.length) throw new Error("lzo: missing end marker");
    t = src[ip++];
    if (t < 16) {
      if (state === 0) {
        // literal run
        copyLiterals((t === 0 ? ext(15) : t) + 3);
        state = 4;
        continue;
      }
      if (state === 4) {
        // M1 after a long literal run: 3 bytes, distance 0x801..0xC00
        need(1);
        const dist = (t >> 2) + (src[ip++] << 2) + 0x801;
        copyMatch(dist, 3);
      } else {
        // M1 after a short literal run: 2 bytes, distance 1..0x400
        need(1);
        const dist = (t >> 2) + (src[ip++] << 2) + 1;
        copyMatch(dist, 2);
      }
    } else if (t >= 64) {
      // M2: 3..8 bytes, distance 1..0x800
      const n = (t >> 5) + 1;
      need(1);
      const dist = ((t >> 2) & 7) + (src[ip++] << 3) + 1;
      copyMatch(dist, n);
    } else if (t >= 32) {
      // M3: distance 1..0x4000
      const n = ((t & 31) === 0 ? ext(31) : t & 31) + 2;
      need(2);
      const d = src[ip] | (src[ip + 1] << 8);
      ip += 2;
      copyMatch((d >> 2) + 1, n);
      t = d;
    } else {
      // M4 (16..31): distance 0x4000..0xBFFF, or the end marker 11 00 00
      const n = ((t & 7) === 0 ? ext(7) : t & 7) + 2;
      need(2);
      const d = src[ip] | (src[ip + 1] << 8);
      ip += 2;
      const dist = ((t & 8) << 11) + (d >> 2);
      if (dist === 0) break;
      copyMatch(dist + 0x4000, n);
      t = d;
    }
    // 0..3 trailing literals ride in the low 2 bits of the last byte read
    const s = t & 3;
    copyLiterals(s);
    state = s;
  }
  return Uint8Array.from(out);
}

/** A valid LZO1X stream holding only literals, ended by the 11 00 00 marker. */
export function compressLiteral(data: Uint8Array): Uint8Array {
  const n = data.length;
  if (n === 0) return Uint8Array.of(0x11, 0x00, 0x00);
  const head: number[] = [];
  if (n <= 238) {
    head.push(17 + n); // first-byte literal run
  } else {
    let r = n - 3 - 15; // 00 {00 x k} r  =>  15 + 255k + r + 3 literals
    head.push(0);
    while (r > 255) {
      head.push(0);
      r -= 255;
    }
    head.push(r);
  }
  const out = new Uint8Array(head.length + n + 3);
  out.set(head, 0);
  out.set(data, head.length);
  out.set([0x11, 0x00, 0x00], head.length + n);
  return out;
}
