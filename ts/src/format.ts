/**
 * Reader for the Accelon3 .adb binary format (little endian).
 *
 * Layout
 *   [0,256)                    file header
 *   [256, ...)                 top level ROMBlocks container
 *                                data blocks: source / tokens / tags / tables / attributes / caches
 *                                last data block: block name table (UTF-16LE)
 *                                then: packed length list
 *
 * This module only performs random access reads (`pread`), never loading the
 * whole file: .adb files can be many GB.
 */
import { readSync } from 'node:fs';

export const FILE_HEADER_SIZE = 256;
export const ROMBLOCK_HEADER_SIZE = 16;
export const SIGNATURE = '\r\nAccelon Search Engine\r\ndesigned by C.S.Yap';

export const BO_WITH_POINTER = 0x40000000;
export const BO_SORTED = 0x20000000;
export const BO_NAMED = 0x10000000;
export const FORMAT_MASK = 0x00000007;
export const FORMAT_NAMES = ['undefined', 'hits', 'ascii', 'unicode', 'blocks'];

export const DBTYPE_DICTIONARY = 2;

/** Distance between two entries of the milestone table of a packed list. */
export const MILE_DISTANCE = 512;

export interface AdbHeader {
  dbname: string;
  dbcname: string;
  signature: string;
  textTerminator: number;
  version: number;
  compression: number;
  srcBlockSize: number;
  maxBlockOffset: number;
  andTagId: number;
  lineCount: number;
  dbType: number;
  protection: number;
  tagCount: number;
  features: number;
  reserved2: number;
  crc32: number;
  serial: string;
  pw: string;
  tokenCount: number;
  isDictionary: boolean;
}

/** Read exactly `length` bytes at `offset`; throws on short read. */
export function readAt(fd: number, offset: number, length: number): Buffer {
  const buf = Buffer.allocUnsafe(length);
  let done = 0;
  while (done < length) {
    const n = readSync(fd, buf, done, length - done, offset + done);
    if (n <= 0) throw new Error(`unexpected EOF at ${offset + done} (wanted ${length} bytes)`);
    done += n;
  }
  return buf;
}

const cstr = (b: Buffer) => {
  const z = b.indexOf(0);
  return b.toString('latin1', 0, z < 0 ? b.length : z);
};

/** NUL terminated UTF-16LE string (dbcname is a fixed 64 byte field) */
const cstrUtf16 = (b: Buffer) => {
  const s = b.toString('utf16le');
  const z = s.indexOf('\0');
  return z < 0 ? s : s.slice(0, z);
};

/** Parse the 256 byte file header. Returns null when the signature is wrong. */
export function parseHeader(h: Buffer): AdbHeader | null {
  const signature = cstr(h.subarray(32, 80));
  if (signature !== SIGNATURE) return null;
  const dbname = cstr(h.subarray(0, 32));
  const dv = new DataView(h.buffer, h.byteOffset, h.byteLength);
  const u32 = (o: number) => dv.getInt32(o, true);
  const textTerminator = u32(80);
  const version = u32(84);
  const compression = u32(88);
  const srcBlockSize = u32(92);
  const maxBlockOffset = u32(96);
  const andTagId = u32(100);
  const lineCount = u32(104);
  const dbType = u32(108);
  const protection = u32(112);
  const tagCount = u32(116);
  const features = u32(120);
  const reserved2 = u32(124);
  const dbcname = cstrUtf16(h.subarray(128, 192));
  const serial = cstr(h.subarray(192, 208));
  const pw = cstr(h.subarray(208, 228));
  const crc32 = dv.getUint32(252, true); // field at 252, covers the first 252 bytes
  return {
    dbname, dbcname, signature,
    textTerminator, version, compression, srcBlockSize, maxBlockOffset, andTagId,
    lineCount, dbType, protection, tagCount, features, reserved2, crc32, serial, pw,
    tokenCount: maxBlockOffset - tagCount,
    isDictionary: (dbType & DBTYPE_DICTIONARY) !== 0,
  };
}

export interface BlockSet {
  /** absolute offset of the container header */
  start: number;
  feature: number;
  signature: number;
  totalBlockSize: number;
  /** 0 => variable length blocks (a packed length list follows the data) */
  blockSize: number;
  /** number of data blocks, excluding the trailing name block */
  count: number;
  /** cumulative END offsets of every data block, including the name block */
  lengths: number[] | null;
  names: string[];
  dataStart: number;
  /** absolute offset of the packed length list (0 when fixed size) */
  listStart: number;
  /**
   * boWithPointer tables: one int32 per data block (including the name block).
   * Attribute containers use it to store the docnode that owns each value.
   */
  pointers: Int32Array | null;
}

/**
 * Read the size of a packed length list: u32 entry count/byte budget, then a
 * milestone table, then the LEB128 delta payload.
 */
export function packedListSize(fd: number, offset: number): number {
  const added = readAt(fd, offset, 4).readUInt32LE(0);
  return 4 + Math.floor(added / MILE_DISTANCE) * 8 + added;
}

/**
 * Decode a packed list: u32 `added` (payload bytes), milestone table
 * (one 8 byte entry per 512 payload bytes), then LEB128 deltas that
 * accumulate into the block END offsets.
 */
export function decodePackedList(buf: Buffer): number[] {
  let offset = 0;
  const added = buf.readUInt32LE(offset); offset += 4;
  const nMileStone = Math.floor(added / MILE_DISTANCE);
  offset += nMileStone * 8;
  const out: number[] = [];
  let remain = added;
  let v = 0;
  while (remain > 0) {
    let delta = 0, shift = 0;
    let c = buf[offset];
    do {
      delta += (c & 0x7f) << shift;
      shift += 7;
      offset++;
      remain--;
      if (remain > 0) c = buf[offset];
    } while (c >= 0x80 && remain > 0 && shift < 32);
    v += delta;
    out.push(v);
  }
  return out;
}

/**
 * Count the entries of a packed list without materialising them.
 *
 * A value is: a lead byte, followed by every following byte that has its high
 * bit set; the first byte with a clear high bit belongs to the next value
 * (this is the exact shape of TPackedList.next in lists.pas).
 */
export function countPackedList(buf: Buffer): number {
  const added = buf.readUInt32LE(0);
  const end = 4 + Math.floor(added / MILE_DISTANCE) * 8 + added;
  let off = 4 + Math.floor(added / MILE_DISTANCE) * 8;
  let count = 0;
  while (off < end) {
    off++; // lead byte
    while (off < end && buf[off] >= 0x80) off++; // follow bytes
    count++;
  }
  return count;
}

/** Parse a ROMBlocks container header (and its length list / block names). */
export function parseBlockSet(fd: number, start: number, depth = 0): BlockSet {
  const h = readAt(fd, start, ROMBLOCK_HEADER_SIZE);
  const dv = new DataView(h.buffer, h.byteOffset, h.byteLength);
  const feature = dv.getUint32(0, true);
  const signature = dv.getInt32(4, true);
  const totalBlockSize = dv.getUint32(8, true);
  const blockSize = dv.getInt32(12, true);
  const dataStart = start + ROMBLOCK_HEADER_SIZE;
  let lengths: number[] | null = null;
  let count = 0;
  let listStart = 0;
  if (blockSize === 0) {
    listStart = dataStart + totalBlockSize;
    const size = packedListSize(fd, listStart);
    lengths = decodePackedList(readAt(fd, listStart, size));
    count = lengths.length;
  } else {
    count = Math.floor(totalBlockSize / blockSize);
  }
  let pointers: Int32Array | null = null;
  if (feature & BO_WITH_POINTER) {
    const n = lengths ? lengths.length : count;
    const at = blockSize === 0 ? listStart + packedListSize(fd, listStart) : dataStart + totalBlockSize;
    const buf = readAt(fd, at, n * 4);
    pointers = new Int32Array(n);
    for (let i = 0; i < n; i++) pointers[i] = buf.readInt32LE(i * 4);
  }
  const names: string[] = [];
  if (feature & BO_NAMED) {
    if (lengths && lengths.length >= 2) {
      // the last data block holds the name table
      const nameBlockStart = dataStart + lengths[lengths.length - 2];
      const nb = parseBlockSet(fd, nameBlockStart, depth + 1);
      const n = nb.lengths ? nb.lengths.length : nb.count;
      for (let i = 0; i < n; i++) {
        const end = nb.lengths ? nb.lengths[i] : (i + 1) * nb.blockSize;
        const begin = nb.lengths ? (i > 0 ? nb.lengths[i - 1] : 0) : i * nb.blockSize;
        // each name is UTF-16LE with a trailing NUL that is not part of the name
        const len = end - begin - 2;
        if (len > 0) names.push(readAt(fd, nb.dataStart + begin, len).toString('utf16le'));
      }
      count--;
    } else if (!lengths) {
      // fixed size blocks: the last block is the name table, its payload is
      // a sequence of NUL terminated UTF-16LE strings
      const begin = (count - 1) * blockSize;
      const raw = readAt(fd, dataStart + begin, blockSize).toString('utf16le');
      for (const s of raw.split('\0')) if (s) names.push(s);
      count--;
    }
  }
  return { start, feature, signature, totalBlockSize, blockSize, count, lengths, names, dataStart, listStart, pointers };
}

/** Byte range [start,end) of data block `i` inside the file. */
export function blockRange(bs: BlockSet, i: number): { start: number; end: number } {
  if (bs.lengths) {
    return { start: bs.dataStart + (i > 0 ? bs.lengths[i - 1] : 0), end: bs.dataStart + bs.lengths[i] };
  }
  return { start: bs.dataStart + i * bs.blockSize, end: bs.dataStart + (i + 1) * bs.blockSize };
}

/** Offset of a named block inside a container (0 when absent). */
export function blockOffsetByName(bs: BlockSet, name: string): number {
  const at = bs.names.indexOf(name);
  if (at < 0) return 0;
  return blockRange(bs, at).start;
}
