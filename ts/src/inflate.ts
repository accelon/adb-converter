/**
 * Raw DEFLATE (RFC 1951) decoder — no dependencies, no streams.
 *
 * Why: reading an Obsidian vault's `.zip` means inflating ~1,300 entries. One
 * `DecompressionStream('deflate-raw')` per entry (Blob → stream → Response) costs
 * ~50–100 ms of setup each in Chromium, i.e. **two minutes** for a vault this
 * size. This decoder does the same work in a few milliseconds per entry.
 *
 * It is the plain RFC 1951 algorithm: stored / fixed-Huffman / dynamic-Huffman
 * blocks, LSB-first bits, the standard length/distance tables. `test/inflate.test.ts`
 * checks it against `node:zlib` for every compression level and for stored blocks,
 * and on the real vault zip when that file is present.
 */

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** canonical Huffman table: counts per code length + symbols sorted by code */
interface Huffman {
  counts: Uint16Array;   // 16 entries (1..15 used)
  symbols: Uint16Array;  // symbols in canonical order
}

function buildHuffman(lengths: Uint8Array): Huffman {
  const counts = new Uint16Array(16);
  for (let i = 0; i < lengths.length; i++) counts[lengths[i]]++;
  counts[0] = 0;
  const offsets = new Uint16Array(16);
  for (let i = 1; i < 16; i++) offsets[i] = offsets[i - 1] + counts[i - 1];
  const symbols = new Uint16Array(lengths.length);
  for (let i = 0; i < lengths.length; i++) {
    if (lengths[i]) symbols[offsets[lengths[i]]++] = i;
  }
  return { counts, symbols };
}

const FIXED_LIT: Huffman = (() => {
  const l = new Uint8Array(288);
  for (let i = 0; i < 144; i++) l[i] = 8;
  for (let i = 144; i < 256; i++) l[i] = 9;
  for (let i = 256; i < 280; i++) l[i] = 7;
  for (let i = 280; i < 288; i++) l[i] = 8;
  return buildHuffman(l);
})();

const FIXED_DIST: Huffman = (() => {
  const l = new Uint8Array(30).fill(5);
  return buildHuffman(l);
})();

export function inflateRaw(input: Uint8Array): Uint8Array {
  let pos = 0;
  let bitBuf = 0;
  let bitCnt = 0;
  let out = new Uint8Array(Math.max(1024, input.length * 4));
  let outLen = 0;

  const grow = (need: number): void => {
    if (outLen + need <= out.length) return;
    let size = out.length * 2;
    while (size < outLen + need) size *= 2;
    const next = new Uint8Array(size);
    next.set(out.subarray(0, outLen));
    out = next;
  };

  const bits = (n: number): number => {
    while (bitCnt < n) {
      if (pos >= input.length) throw new Error('inflate: unexpected end of input');
      bitBuf |= input[pos++] << bitCnt;
      bitCnt += 8;
    }
    const v = bitBuf & ((1 << n) - 1);
    bitBuf >>>= n;
    bitCnt -= n;
    return v;
  };

  const decode = (h: Huffman): number => {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len < 16; len++) {
      code |= bits(1);
      const count = h.counts[len];
      if (code - first < count) return h.symbols[index + (code - first)];
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    throw new Error('inflate: bad Huffman code');
  };

  let last = 0;
  while (!last) {
    last = bits(1);
    const type = bits(2);
    if (type === 0) {
      // stored: drop to a byte boundary, then copy LEN bytes
      bitBuf = 0;
      bitCnt = 0;
      if (pos + 4 > input.length) throw new Error('inflate: truncated stored block');
      const len = input[pos] | (input[pos + 1] << 8);
      const nlen = input[pos + 2] | (input[pos + 3] << 8);
      pos += 4;
      if ((len ^ 0xffff) !== nlen) throw new Error('inflate: stored block length mismatch');
      if (pos + len > input.length) throw new Error('inflate: truncated stored block data');
      grow(len);
      out.set(input.subarray(pos, pos + len), outLen);
      outLen += len;
      pos += len;
      continue;
    }
    if (type === 3) throw new Error('inflate: invalid block type');

    let lit: Huffman;
    let dist: Huffman;
    if (type === 1) {
      lit = FIXED_LIT;
      dist = FIXED_DIST;
    } else {
      const hlit = bits(5) + 257;
      const hdist = bits(5) + 1;
      const hclen = bits(4) + 4;
      const clens = new Uint8Array(19);
      for (let i = 0; i < hclen; i++) clens[CLEN_ORDER[i]] = bits(3);
      const clenTree = buildHuffman(clens);
      const lengths = new Uint8Array(hlit + hdist);
      for (let i = 0; i < lengths.length;) {
        const sym = decode(clenTree);
        if (sym < 16) { lengths[i++] = sym; continue; }
        let rep = 0;
        let val = 0;
        if (sym === 16) {
          if (i === 0) throw new Error('inflate: repeat with no previous length');
          val = lengths[i - 1];
          rep = 3 + bits(2);
        } else if (sym === 17) {
          rep = 3 + bits(3);
        } else {
          rep = 11 + bits(7);
        }
        if (i + rep > lengths.length) throw new Error('inflate: too many code lengths');
        lengths.fill(val, i, i + rep);
        i += rep;
      }
      lit = buildHuffman(lengths.subarray(0, hlit));
      dist = buildHuffman(lengths.subarray(hlit));
    }

    for (;;) {
      const sym = decode(lit);
      if (sym < 256) {
        grow(1);
        out[outLen++] = sym;
        continue;
      }
      if (sym === 256) break;
      const li = sym - 257;
      if (li >= LENGTH_BASE.length) throw new Error('inflate: bad length symbol');
      const len = LENGTH_BASE[li] + bits(LENGTH_EXTRA[li]);
      const di = decode(dist);
      if (di >= DIST_BASE.length) throw new Error('inflate: bad distance symbol');
      const d = DIST_BASE[di] + bits(DIST_EXTRA[di]);
      if (d > outLen) throw new Error('inflate: distance beyond output');
      grow(len);
      // byte-by-byte is required: source and destination may overlap
      for (let k = 0; k < len; k++) out[outLen + k] = out[outLen - d + k];
      outLen += len;
    }
  }
  return out.subarray(0, outLen);
}
