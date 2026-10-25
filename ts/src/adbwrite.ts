/**
 * Assemble an .adb file: header + the outer ROMBlocks container.
 *
 * The pieces are the ones the Delphi indexer writes (index.pas: writeindex):
 *
 *   source             packed text, 16 KiB blocks, each bzip2 (bs9), feature 0
 *   tokens             named boHits container, one packed list per token
 *   tables             named boHits container (lines/doclengths/blocks.virtual)
 *   attributes         named boBlocks container (values + owning docnodes)
 *   attributes.sorted  same data, boSorted
 *   tags               named boHits container, one packed list per tag
 *   caches             named boBlocks container
 *   resources          named container of raw blocks (images)
 *   outer              named container whose blocks are the containers above
 */
import { Bz2Encoder } from './bz2';
import { crc32 } from './crc32';
import { encodePackedList } from './packedlist';
import {
  BO_HITS,
  BO_NAMED,
  BO_UNICODE,
  buildContainer,
} from './romblock';
import { FILE_HEADER_SIZE } from './format';

export interface SourcePackResult {
  /** one compressed block per 16 KiB of text */
  blocks: Buffer[];
  /** cumulative byte offset at the end of every line */
  linesPhysical: number[];
  /** total bytes of text */
  totalBytes: number;
}

/**
 * Pack the lines exactly like srcpack.pas: TSrcPacker.add() fills a block of
 * srcBlockSize bytes (splitting a line across blocks if needed) and compresses
 * each full block, plus the trailing partial one (destroy()).
 */
export function packSource(lines: readonly string[], srcBlockSize: number, encoder: Bz2Encoder): SourcePackResult {
  const blocks: Buffer[] = [];
  const linesPhysical: number[] = [];
  let buf = Buffer.allocUnsafe(srcBlockSize);
  let used = 0;
  let total = 0;

  const flush = (): void => {
    if (used === 0) return;
    blocks.push(Buffer.from(encoder.encode(buf.subarray(0, used))));
    used = 0;
  };

  for (const line of lines) {
    const bytes = Buffer.from(line, 'utf16le');
    let off = 0;
    let len = bytes.length;
    total += len;
    linesPhysical.push(total);
    while (len > 0) {
      const space = srcBlockSize - used;
      const take = Math.min(space, len);
      bytes.copy(buf, used, off, off + take);
      used += take;
      off += take;
      len -= take;
      if (used === srcBlockSize) flush();
    }
  }
  flush();
  return { blocks, linesPhysical, totalBytes: total };
}

/** A named boHits container: one packed list of virtual addresses per key. */
export function hitsContainer(
  keys: readonly string[],
  values: readonly (readonly number[])[],
  idx: number,
  nameFeature: number = BO_UNICODE,
): Buffer {
  return buildContainer({
    feature: BO_NAMED | BO_HITS | idx,
    blocks: values.map((v) => encodePackedList(v)),
    names: keys as string[],
    nameFeature,
  });
}

/** A named container of pre-built blocks (attributes, caches, resources). */
export function blockContainer(keys: readonly string[], blocks: readonly Buffer[], feature: number): Buffer {
  return buildContainer({ feature: feature | BO_NAMED, blocks: blocks as Buffer[], names: keys as string[], nameFeature: BO_UNICODE });
}

export interface HeaderFields {
  /** the whole 256 byte header; fields below overwrite what they name */
  raw: Buffer;
  at: {
    dbname: number;
    dbcname: number;
    linecount: number;
    dbtype: number;
    srcblocksize: number;
    maxblockoffset: number;
    tagcount: number;
    features: number;
    compression: number;
    version: number;
  };
}

/** The 48 byte signature every .adb carries at offset 32 (basetype.pas). */
export const ADB_SIGNATURE = '\r\nAccelon Search Engine\r\ndesigned by C.S.Yap';

export interface NewHeaderFields {
  /** 32 bytes, ASCII: the base name the reader shows and the default file name */
  dbname: string;
  /** 64 bytes of UTF-16LE (32 chars): the display name */
  dbcname: string;
  linecount: number;
  tagcount: number;
  maxblockoffset: number;
  /** bit 1 = dictionary, bit 4 = hidden (kangxi is 6); 0 for a book */
  dbtype?: number;
  features?: number;
  /** block index of the page tag in the `tags` container */
  andtagid?: number;
  srcblocksize?: number;
  version?: number;
}

/**
 * Build a 256 byte file header from scratch.
 *
 * Every field the reader looks at is written explicitly instead of copying a
 * donor header, so a database authored here does not inherit a stranger's
 * serial, protection flags or display name. The trailing crc32 covers the
 * first 252 bytes (same rule as `patchHeader`).
 */
export function makeHeader(f: NewHeaderFields): Buffer {
  const h = Buffer.alloc(FILE_HEADER_SIZE);
  const dbname = f.dbname.slice(0, 31);
  if (!/^[\x20-\x7e]*$/.test(dbname)) throw new Error(`dbname must be ASCII: ${dbname}`);
  h.write(dbname, 0, 'ascii');
  h.write(ADB_SIGNATURE, 32, 'ascii');
  h.writeUInt32LE(0x1a1a1a1a, 80);          // textterminator (constant, unused)
  h.writeInt32LE(f.version ?? 0, 84);
  h.writeInt32LE(1, 88);                    // compression: source blocks are bzip2
  h.writeInt32LE(f.srcblocksize ?? 16384, 92);
  h.writeInt32LE(f.maxblockoffset, 96);
  h.writeInt32LE(f.andtagid ?? 0, 100);
  h.writeInt32LE(f.linecount, 104);
  h.writeInt32LE(f.dbtype ?? 0, 108);
  h.writeInt32LE(0, 112);                   // protection
  h.writeInt32LE(f.tagcount, 116);
  h.writeInt32LE(f.features ?? 0, 120);
  // dbcname: 64 bytes of UTF-16LE, NUL padded, at most 31 characters + terminator
  const name = Buffer.from(f.dbcname.slice(0, 31), 'utf16le');
  name.copy(h, 128, 0, Math.min(name.length, 62));
  h.writeUInt32LE(0, FILE_HEADER_SIZE - 4);
  h.writeUInt32LE(crc32(h.subarray(0, FILE_HEADER_SIZE - 4)), FILE_HEADER_SIZE - 4);
  return h;
}

/** Copy a header, patch the given fields and recompute the stored crc32. */
export function patchHeader(
  raw: Buffer,
  at: HeaderFields['at'],
  fields: Partial<Record<keyof HeaderFields['at'], number>>,
): Buffer {
  const h = Buffer.from(raw);
  const u32 = (off: number, v: number) => h.writeUInt32LE(v >>> 0, off);
  if (fields.dbname !== undefined) u32(at.dbname, fields.dbname);
  if (fields.dbcname !== undefined) u32(at.dbcname, fields.dbcname);
  if (fields.linecount !== undefined) u32(at.linecount, fields.linecount);
  if (fields.dbtype !== undefined) u32(at.dbtype, fields.dbtype);
  if (fields.srcblocksize !== undefined) u32(at.srcblocksize, fields.srcblocksize);
  if (fields.maxblockoffset !== undefined) u32(at.maxblockoffset, fields.maxblockoffset);
  if (fields.tagcount !== undefined) u32(at.tagcount, fields.tagcount);
  if (fields.features !== undefined) u32(at.features, fields.features);
  if (fields.compression !== undefined) u32(at.compression, fields.compression);
  if (fields.version !== undefined) u32(at.version, fields.version);
  // the crc32 field is the last 4 bytes of the header and covers the rest
  h.writeUInt32LE(0, FILE_HEADER_SIZE - 4);
  h.writeUInt32LE(crc32(h.subarray(0, FILE_HEADER_SIZE - 4)), FILE_HEADER_SIZE - 4);
  return h;
}

/** Assemble the file: header followed by the outer container. */
export function assembleAdb(header: Buffer, outer: Buffer): Buffer {
  if (header.length !== FILE_HEADER_SIZE) throw new Error(`header must be ${FILE_HEADER_SIZE} bytes`);
  return Buffer.concat([header, outer]);
}
