/**
 * Byte-level writers for the browser (file:// build).
 *
 * The Node tooling uses Buffer; the viewer bundle cannot. These functions are the
 * same algorithms as src/packedlist.ts, src/romblock.ts and src/adbwrite.ts, kept
 * deliberately small so a browser build can assemble a container without pulling
 * Node polyfills into the single-file HTML.
 */

export const BO_WITH_POINTER = 0x40000000;
export const BO_SORTED = 0x20000000;
export const BO_NAMED = 0x10000000;
export const BO_UNDEFINED = 0x00000000;
export const BO_HITS = 0x00000001;
export const BO_ASCII = 0x00000002;
export const BO_UNICODE = 0x00000003;
export const BO_BLOCKS = 0x00000004;
export const ROMBLOCK_HEADER_SIZE = 16;
export const MILE_DISTANCE = 512;
export const CRC_MAGIC = 0x55aa55aa;

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** UTF-16LE bytes without TextEncoder (which would turn lone surrogates into U+FFFD). */
export function utf16leBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out[i * 2] = c & 0xff;
    out[i * 2 + 1] = c >>> 8;
  }
  return out;
}

export function decodeUtf16le(bytes: Uint8Array): string {
  const units = new Uint16Array(bytes.length >> 1);
  for (let i = 0; i < units.length; i++) units[i] = bytes[i * 2] | (bytes[i * 2 + 1] << 8);
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < units.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, units.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return s;
}

export function utf8Bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** lists.pas varint: low 7-bit group first with bit7 clear, higher groups bit7 set. */
function varintSize(delta: number): number {
  let n = 0;
  do { delta = Math.floor(delta / 128); n++; } while (delta !== 0);
  return n;
}

/** TPackedList writer, byte for byte (see src/packedlist.ts). */
export function encodePackedList(values: ArrayLike<number>): Uint8Array {
  const n = values.length;
  let added = 0;
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    added += varintSize(v - prev);
    prev = v;
  }
  const miles = Math.floor(added / MILE_DISTANCE);
  const buf = new Uint8Array(4 + miles * 8 + added);
  const dv = new DataView(buf.buffer);
  dv.setInt32(0, added, true);
  let at = 4 + miles * 8;
  let written = 0;
  let milesDone = 0;
  prev = 0;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    let delta = v - prev;
    if (delta < 0) throw new Error('packed list values must not decrease: ' + v + ' after ' + prev);
    buf[at++] = delta & 0x7f;
    written++;
    delta = Math.floor(delta / 128);
    while (delta > 0) {
      buf[at++] = 0x80 | (delta & 0x7f);
      written++;
      delta = Math.floor(delta / 128);
    }
    prev = v;
    while (Math.floor(written / MILE_DISTANCE) > milesDone) {
      const off = 4 + milesDone * 8;
      dv.setInt32(off, v, true);
      dv.setInt32(off + 4, i + 1, true);
      milesDone++;
    }
  }
  if (written !== added || milesDone !== miles) {
    throw new Error('packed list size mismatch: ' + written + '/' + added + ' ' + milesDone + '/' + miles);
  }
  return buf;
}

export interface ContainerInput {
  feature: number;
  blocks: Uint8Array[];
  names?: string[] | null;
  nameFeature?: number;
  pointers?: number[] | null;
  signature?: number;
  blockSize?: number;
}

export function stringBlocks(strings: readonly string[]): Uint8Array[] {
  return strings.map((s) => {
    const b = new Uint8Array((s.length + 1) * 2);
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      b[i * 2] = c & 0xff;
      b[i * 2 + 1] = c >>> 8;
    }
    return b;
  });
}

/** rombuilder.pas / romblock.pas: header + data blocks + packed length list + pointers. */
export function buildContainer(input: ContainerInput): Uint8Array {
  const blockSize = input.blockSize ?? 0;
  const blocks = input.blocks.slice();
  if (input.names && input.names.length) {
    const nameFeature = (input.nameFeature ?? BO_UNICODE) | (input.pointers ? BO_WITH_POINTER : 0);
    blocks.push(buildContainer({ feature: nameFeature, blocks: stringBlocks(input.names) }));
  }
  const sizes = blocks.map((b) => (blockSize ? blockSize : b.length));
  const total = sizes.reduce((a, b) => a + b, 0);
  const header = new Uint8Array(ROMBLOCK_HEADER_SIZE);
  const dv = new DataView(header.buffer);
  dv.setUint32(0, input.feature >>> 0, true);
  dv.setInt32(4, input.signature ?? 0, true);
  dv.setUint32(8, total, true);
  dv.setInt32(12, blockSize, true);
  const parts: Uint8Array[] = [header];
  if (blockSize) {
    for (const b of blocks) {
      if (b.length >= blockSize) parts.push(b.subarray(0, blockSize));
      else { const padded = new Uint8Array(blockSize); padded.set(b); parts.push(padded); }
    }
  } else {
    for (const b of blocks) parts.push(b);
  }
  if (!blockSize) {
    const lengths: number[] = [];
    let acc = 0;
    for (const s of sizes) { acc += s; lengths.push(acc); }
    parts.push(encodePackedList(lengths));
  }
  if (input.feature & BO_WITH_POINTER) {
    const n = input.pointers ? input.pointers.length : blocks.length;
    const table = new Uint8Array(n * 4);
    const tdv = new DataView(table.buffer);
    for (let i = 0; i < n; i++) tdv.setInt32(i * 4, input.pointers ? input.pointers[i] : 0, true);
    parts.push(table);
  }
  return concatBytes(parts);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Uint8Array, init = CRC_MAGIC): number {
  let crc = init >>> 0;
  for (let i = 0; i < buf.length; i++) crc = ((crc >>> 8) ^ CRC_TABLE[(buf[i] ^ crc) & 0xff]) >>> 0;
  return crc >>> 0;
}

/** Patch the header fields the rebuild changes and recompute the stored crc32. */
export function patchHeader(raw: Uint8Array, fields: {
  linecount?: number; maxblockoffset?: number; tagcount?: number; andtagid?: number;
}): Uint8Array {
  const h = raw.slice();
  const dv = new DataView(h.buffer);
  if (fields.linecount !== undefined) dv.setInt32(104, fields.linecount, true);
  if (fields.maxblockoffset !== undefined) dv.setInt32(96, fields.maxblockoffset, true);
  if (fields.tagcount !== undefined) dv.setInt32(116, fields.tagcount, true);
  if (fields.andtagid !== undefined) dv.setInt32(100, fields.andtagid, true);
  dv.setUint32(252, 0, true);
  dv.setUint32(252, crc32(h.subarray(0, 252)), true);
  return h;
}

export function assembleAdb(header: Uint8Array, outer: Uint8Array): Uint8Array {
  if (header.length !== 256) throw new Error('header must be 256 bytes');
  return concatBytes([header, outer]);
}
