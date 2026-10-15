#!/usr/bin/env bun
/**
 * Test fixture generator: build a large .adb whose source region is the
 * compressed blocks of an existing .adb repeated N times.
 *
 * This exists ONLY so the exporter can be benchmarked on realistic multi GB
 * inputs (the compressed blocks are reused verbatim, nothing is re-encoded).
 * It is deliberately strict: the output is a faithful container layout, and
 * `--reps 3` round trips byte for byte against the reference text.
 *
 * usage: bun run tools/mkadb.ts <src.adb> <reps> <out.adb>
 */
import { closeSync, openSync, readFileSync, statSync, writeSync } from 'node:fs';
import {
  BO_NAMED,
  blockOffsetByName,
  blockRange,
  decodePackedList,
  packedListSize,
  parseBlockSet,
  parseHeader,
  readAt,
  ROMBLOCK_HEADER_SIZE,
  FILE_HEADER_SIZE,
} from '../src/format';

/**
 * The packed list varint of accelon3 is NOT LEB128.
 *
 * Verified against 13j.adb: the block length 7807 is stored as `7f bc`, i.e.
 * the LOW group comes first with a CLEAR high bit, and every following higher
 * group has its high bit SET. (LEB128 would be `ff 3d`.) The reference decoder
 * (`loadPackedList`) matches this: it keeps accumulating while the *next* byte
 * has the high bit set.
 */
function putVarint(buf: Buffer, at: number, d: number): number {
  let n = at;
  buf[n++] = d & 0x7f;
  d = Math.floor(d / 128);
  while (d > 0) {
    buf[n++] = (d & 0x7f) | 0x80;
    d = Math.floor(d / 128);
  }
  return n;
}

function varintSize(d: number): number {
  let n = 1;
  d = Math.floor(d / 128);
  while (d > 0) {
    n++;
    d = Math.floor(d / 128);
  }
  return n;
}

export function encodePackedList(values: number[]): Buffer {
  let n = 0;
  let prev = 0;
  for (const v of values) {
    n += varintSize(v - prev);
    prev = v;
  }
  const miles = Math.floor(n / 512);
  const list = Buffer.allocUnsafe(4 + miles * 8 + n);
  list.writeUInt32LE(n, 0);
  let at = 4 + miles * 8;
  prev = 0;
  for (const v of values) {
    at = putVarint(list, at, v - prev);
    prev = v;
  }
  return list;
}

/**
 * Streaming variant used for lists too big to materialise as a JS array.
 * `count` must be the exact number of values, `byteSize` must be the exact
 * payload size (both computed by the caller with varintSize).
 */
export function encodePackedListStream(
  byteSize: number,
  count: number,
  emit: (put: (d: number) => void) => void,
): Buffer {
  const miles = Math.floor(byteSize / 512);
  const list = Buffer.allocUnsafe(4 + miles * 8 + byteSize);
  list.writeUInt32LE(byteSize, 0);
  let at = 4 + miles * 8;
  let n = 0;
  let prev = 0;
  emit((value: number) => {
    at = putVarint(list, at, value - prev);
    prev = value;
    n++;
    if (n === count && at !== list.length) throw new Error(`packed list size mismatch: ${at} != ${list.length}`);
  });
  return list;
}

/** Build a ROMBlocks container: header + data blocks + names block + length list. */
export function buildContainer(blocks: Buffer[], names: string[] | null): Buffer {
  const data: Buffer[] = [...blocks];
  const lengths: number[] = [];
  let acc = 0;
  for (const b of data) {
    acc += b.length;
    lengths.push(acc);
  }
  if (names) {
    const strings = names.map((s) => Buffer.from(s + '\0', 'utf16le'));
    const nameBlock = buildContainer(strings, null);
    data.push(nameBlock);
    acc += nameBlock.length;
    lengths.push(acc);
  }
  const body = Buffer.concat(data);
  const header = Buffer.alloc(ROMBLOCK_HEADER_SIZE);
  header.writeUInt32LE(names ? BO_NAMED : 0, 0);
  header.writeInt32LE(0, 4);
  header.writeUInt32LE(body.length, 8);
  header.writeInt32LE(0, 12); // variable length blocks
  return Buffer.concat([header, body, encodePackedList(lengths)]);
}

function main(): void {
  const [src, repsArg, out] = process.argv.slice(2);
  if (!src || !repsArg || !out) {
    console.error('usage: bun run tools/mkadb.ts <src.adb> <reps> <out.adb>');
    process.exit(2);
  }
  const reps = Number(repsArg);
  const fd = openSync(src, 'r');
  const header = parseHeader(readAt(fd, 0, FILE_HEADER_SIZE))!;
  if (!header) throw new Error(`${src}: not an adb file`);
  const outer = parseBlockSet(fd, FILE_HEADER_SIZE);
  const sources = parseBlockSet(fd, blockOffsetByName(outer, 'source'));
  const tables = parseBlockSet(fd, blockOffsetByName(outer, 'tables'));
  const linesAt = blockOffsetByName(tables, 'lines.physical');
  const palines = decodePackedList(readAt(fd, linesAt, packedListSize(fd, linesAt)));
  const blockCount = sources.lengths!.length;
  const blocks: Buffer[] = [];
  for (let i = 0; i < blockCount; i++) {
    const r = blockRange(sources, i);
    blocks.push(readAt(fd, r.start, r.end - r.start));
  }
  const textBytes = palines[palines.length - 1];
  console.log(
    `${src}: ${blockCount} blocks, ${palines.length} lines, ${textBytes} text bytes; x${reps} -> ` +
      `${((textBytes * reps) / 1073741824).toFixed(2)} GiB text`,
  );
  closeSync(fd);

  // source container: the same blocks, reps times
  //   `acc`            = size of the data region only (the header field)
  //   `sourceTotal`    = data + length list (the on disk body, used by the outer list)
  const sourceEnds: number[] = [];
  let acc = 0;
  for (let r = 0; r < reps; r++) {
    for (const b of blocks) {
      acc += b.length;
      sourceEnds.push(acc);
    }
  }
  const sourceList = encodePackedList(sourceEnds);
  const sourceData = acc;
  const sourceTotal = acc + sourceList.length;

  // lines.physical: the same line ends shifted by whole copies
  const lineCount = palines.length * reps;
  let linesBytes = 0;
  {
    let prev = 0;
    for (let r = 0; r < reps; r++) {
      const base = r * textBytes;
      for (const v of palines) {
        linesBytes += varintSize(base + v - prev);
        prev = base + v;
      }
    }
  }
  const linesBuf = encodePackedListStream(linesBytes, lineCount, (put) => {
    for (let r = 0; r < reps; r++) {
      const base = r * textBytes;
      for (const v of palines) put(base + v);
    }
  });

  const tablesContainer = buildContainer(
    [linesBuf, Buffer.alloc(0)], // lines.physical + an empty extra block
    ['lines.physical', 'doclengths'],
  );
  const outerNameBlock = buildContainer(
    ['source', 'tables'].map((s) => Buffer.from(s + '\0', 'utf16le')),
    null,
  );

  // file header: start from the source header, then patch what we changed
  const fh = readAt(openSync(src, 'r'), 0, FILE_HEADER_SIZE);
  fh.fill(0, 0, 32);
  fh.write('bench' + reps, 0, 'latin1');
  fh.writeUInt32LE(1, 88); // compression = bzip2
  fh.writeUInt32LE(header.srcBlockSize, 92);
  fh.writeInt32LE(0, 96); // maxblockoffset
  fh.writeUInt32LE(palines.length * reps, 104); // linecount
  fh.writeUInt32LE(0, 116); // tagcount
  fh.writeUInt32LE(0, 120); // features

  const outFd = openSync(out, 'w');
  const w = (b: Buffer) => writeSync(outFd, b);
  w(fh);
  // outer container header
  const outerHeader = Buffer.alloc(ROMBLOCK_HEADER_SIZE);
  const outerBodySize = sourceTotal + ROMBLOCK_HEADER_SIZE + tablesContainer.length + outerNameBlock.length;
  outerHeader.writeUInt32LE(BO_NAMED, 0);
  outerHeader.writeUInt32LE(outerBodySize, 8);
  w(outerHeader);
  // source container
  const srcHeader = Buffer.alloc(ROMBLOCK_HEADER_SIZE);
  srcHeader.writeUInt32LE(sourceData, 8); // data region only, not the length list
  w(srcHeader);
  const chunk = Buffer.concat(blocks);
  for (let r = 0; r < reps; r++) w(chunk);
  w(sourceList);
  // tables container
  w(tablesContainer);
  // outer names block + outer length list. NOTE: the entries are ends of the
  // data blocks of the *outer* container, so they include the 16 byte header
  // of each sub container (verified against 13j.adb: 897698+16+208 = 897922).
  w(outerNameBlock);
  const sourceEnd = sourceTotal + ROMBLOCK_HEADER_SIZE;
  w(encodePackedList([sourceEnd, sourceEnd + tablesContainer.length, outerBodySize]));

  closeSync(outFd);
  console.log(`wrote ${out}: ${(statSync(out).size / 1073741824).toFixed(2)} GiB compressed, ${palines.length * reps} lines`);
}

if (import.meta.main) main();
