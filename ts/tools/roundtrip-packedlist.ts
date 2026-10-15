#!/usr/bin/env bun
/**
 * Prove the TypeScript TPackedList writer is byte identical to Delphi's.
 *
 * Walks every packed list of an .adb (container length lists, every block of a
 * boHits container such as tables/tokens/tags, the name table containers),
 * decodes it and re-encodes it with src/packedlist.ts, then compares the bytes.
 *
 *   bun run tools/roundtrip-packedlist.ts <file.adb> [...]
 */
import { closeSync, openSync } from 'node:fs';
import {
  blockOffsetByName,
  blockRange,
  decodePackedList,
  packedListSize,
  parseBlockSet,
  readAt,
  FILE_HEADER_SIZE,
  BO_NAMED,
  type BlockSet,
} from '../src/format';
import { encodePackedListInfo } from '../src/packedlist';

interface Stats {
  lists: number;
  bytes: number;
  mismatch: string[];
  miles: number;
  zeroMiles: number;
}

const BO_FORMAT_MASK = 7;
const BO_HITS = 0x1;
const BO_BLOCKS = 0x4;

function checkList(fd: number, at: number, label: string, stats: Stats): boolean {
  const size = packedListSize(fd, at);
  const raw = readAt(fd, at, size);
  const values = decodePackedList(raw);
  const { buffer, milestones } = encodePackedListInfo(values);
  stats.lists++;
  stats.bytes += size;
  stats.miles += milestones;
  // how many of the original milestones are zero filled?
  for (let i = 0; i < milestones; i++) {
    if (raw.readInt32LE(4 + i * 8) === 0 && raw.readInt32LE(8 + i * 8) === 0) stats.zeroMiles++;
  }
  if (buffer.length !== raw.length || !buffer.equals(raw)) {
    if (stats.mismatch.length < 10) {
      let at2 = 0;
      while (at2 < Math.min(buffer.length, raw.length) && buffer[at2] === raw[at2]) at2++;
      stats.mismatch.push(
        `${label}: size ${raw.length} -> ${buffer.length}, first byte difference at ${at2} ` +
          `(orig ${raw[at2]}, mine ${buffer[at2]})`,
      );
    }
    return false;
  }
  return true;
}

function walk(fd: number, start: number, label: string, stats: Stats, depth: number): void {
  const bs = parseBlockSet(fd, start);
  const rawCount = bs.lengths ? bs.lengths.length : bs.count;
  const named = (bs.feature & BO_NAMED) !== 0;
  const format = bs.feature & BO_FORMAT_MASK;

  // 1) the container's own length list
  if (bs.lengths) checkList(fd, bs.listStart, `${label}/lengths`, stats);

  // 2) the data blocks
  for (let i = 0; i < rawCount; i++) {
    const r = blockRange(bs, i);
    if (r.end <= r.start) continue;
    const isNameBlock = named && i === rawCount - 1;
    if (format === BO_HITS && !isNameBlock) {
      checkList(fd, r.start, `${label}/${bs.names[i] ?? i}`, stats);
    } else if (format === BO_BLOCKS || isNameBlock) {
      if (depth < 6) walk(fd, r.start, `${label}/${bs.names[i] ?? (isNameBlock ? '@names' : i)}`, stats, depth + 1);
    }
  }
}

function main(): void {
  const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (files.length === 0) {
    console.error('usage: bun run tools/roundtrip-packedlist.ts <file.adb> [...]');
    process.exit(2);
  }
  for (const file of files) {
    const fd = openSync(file, 'r');
    const outer = parseBlockSet(fd, FILE_HEADER_SIZE);
    const stats: Stats = { lists: 0, bytes: 0, mismatch: [], miles: 0, zeroMiles: 0 };
    const rawCount = outer.lengths ? outer.lengths.length : outer.count;
    for (let i = 0; i < rawCount; i++) {
      const r = blockRange(outer, i);
      if (r.end <= r.start) continue;
      const isNameBlock = (outer.feature & BO_NAMED) !== 0 && i === rawCount - 1;
      if (!isNameBlock) walk(fd, r.start, outer.names[i] ?? String(i), stats, 0);
    }
    closeSync(fd);
    const ok = stats.mismatch.length === 0;
    console.log(
      `${ok ? 'ok  ' : 'FAIL'} ${file}: ${stats.lists} packed lists, ${(stats.bytes / 1048576).toFixed(1)} MiB, ` +
        `${stats.miles} milestones (${stats.zeroMiles} zero filled in the original)`,
    );
    for (const m of stats.mismatch) console.log(`     ${m}`);
    process.exitCode = ok ? process.exitCode ?? 0 : 1;
  }
}

main();
