/** LZ4 block-format decompressor (used by .rbxl chunks). */
export function lz4Decompress(src: Uint8Array, outLen: number): Uint8Array {
  const dst = new Uint8Array(outLen);
  let s = 0, d = 0;
  while (s < src.length) {
    const token = src[s++];
    let lit = token >> 4;
    if (lit === 15) { let b; do { b = src[s++]; lit += b; } while (b === 255); }
    dst.set(src.subarray(s, s + lit), d);
    s += lit; d += lit;
    if (s >= src.length) break;
    const off = src[s] | (src[s + 1] << 8);
    s += 2;
    let mlen = token & 15;
    if (mlen === 15) { let b; do { b = src[s++]; mlen += b; } while (b === 255); }
    mlen += 4;
    let m = d - off;
    if (off === 0 || m < 0) throw new Error('Corrupt LZ4 data');
    for (let k = 0; k < mlen; k++) dst[d++] = dst[m++];
  }
  return dst;
}

/** Simple greedy LZ4 block compressor (hash-table based). Output is valid LZ4 block format. */
export function lz4Compress(src: Uint8Array): Uint8Array {
  const n = src.length;
  const out = new Uint8Array(n + Math.ceil(n / 255) + 32);
  const table = new Int32Array(1 << 16).fill(-1);
  let o = 0, anchor = 0, i = 0;
  const limit = n - 12; // last 5 bytes must be literals; keep margin
  const hash = (p: number) => (Math.imul(src[p] | (src[p + 1] << 8) | (src[p + 2] << 16) | (src[p + 3] << 24), 2654435761) >>> 16);
  const writeLen = (len: number) => { while (len >= 255) { out[o++] = 255; len -= 255; } out[o++] = len; };
  while (i < limit) {
    const h = hash(i);
    const ref = table[h];
    table[h] = i;
    if (ref >= 0 && i - ref < 65535 &&
      src[ref] === src[i] && src[ref + 1] === src[i + 1] && src[ref + 2] === src[i + 2] && src[ref + 3] === src[i + 3]) {
      let len = 4;
      while (i + len < n - 5 && src[ref + len] === src[i + len]) len++;
      const lit = i - anchor;
      const tok = o++;
      out[tok] = (Math.min(lit, 15) << 4) | Math.min(len - 4, 15);
      if (lit >= 15) writeLen(lit - 15);
      out.set(src.subarray(anchor, i), o); o += lit;
      const off = i - ref;
      out[o++] = off & 255; out[o++] = off >> 8;
      if (len - 4 >= 15) writeLen(len - 4 - 15);
      i += len;
      anchor = i;
    } else i++;
  }
  const lit = n - anchor;
  out[o++] = Math.min(lit, 15) << 4;
  if (lit >= 15) writeLen(lit - 15);
  out.set(src.subarray(anchor, n), o); o += lit;
  return out.slice(0, o);
}
