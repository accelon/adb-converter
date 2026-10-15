#!/usr/bin/env bun
/**
 * Rewrite an .adb from its own parsed structure with the TypeScript writer and
 * compare the result with the original file, byte for byte.
 *
 * This is the strongest available check that the container writer, the packed
 * list writer, the name tables, the pointer tables and the fixed/variable block
 * logic all agree with the Delphi implementation: the original file was written
 * by the Delphi program, so a byte identical rewrite means the writer can emit
 * files that the old program reads.
 *
 *   bun run tools/roundtrip-adb.ts <file.adb> [out.adb] [--report]
 */
import { closeSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import {
  blockRange,
  parseBlockSet,
  parseHeader,
  readAt,
  FILE_HEADER_SIZE,
  BO_NAMED,
  type BlockSet,
} from '../src/format';
import { buildContainer, BO_WITH_POINTER, BO_UNICODE, ROMBLOCK_HEADER_SIZE } from '../src/romblock';

/** Rebuild one container from the file it lives in. */
function rebuild(fd: number, bs: BlockSet, path: string): Buffer {
  const rawCount = bs.lengths ? bs.lengths.length : bs.count;
  const named = (bs.feature & BO_NAMED) !== 0;
  const blocks: Buffer[] = [];
  const names: string[] = [];
  let nameFeature: number | undefined;
  let namePointers: number[] | null = null;

  for (let i = 0; i < rawCount; i++) {
    const r = blockRange(bs, i);
    const isNameBlock = named && i === rawCount - 1;
    if (isNameBlock) {
      const nb = parseBlockSet(fd, r.start);
      nameFeature = nb.feature;
      namePointers = nb.pointers ? [...nb.pointers] : null;
      // the name strings themselves: use my own block list names (they were
      // parsed from this very container)
      names.push(...bs.names);
      void nb;
    } else {
      blocks.push(readAt(fd, r.start, r.end - r.start));
    }
  }

  const pointers = bs.pointers ? [...bs.pointers] : null;
  void path;
  return buildContainer({
    feature: bs.feature,
    blocks,
    names: named ? names : null,
    nameFeature: nameFeature ?? BO_UNICODE,
    namePointers,
    pointers,
    signature: bs.signature,
    blockSize: bs.blockSize,
  });
}

function main(): void {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const out = args.indexOf('--report') >= 0 ? null : args[1] && !args[1].startsWith('--') ? args[1] : null;
  if (!file) {
    console.error('usage: bun run tools/roundtrip-adb.ts <file.adb> [out.adb] [--report]');
    process.exit(2);
  }
  const fd = openSync(file, 'r');
  const size = statSync(file).size;
  const headerBytes = readAt(fd, 0, FILE_HEADER_SIZE);
  const header = parseHeader(headerBytes)!;
  if (!header) throw new Error(`${file}: not an adb`);
  const outer = parseBlockSet(fd, FILE_HEADER_SIZE);

  // per sub container report: rebuild each one on its own and compare
  const subReports: string[] = [];
  const rawCount = outer.lengths ? outer.lengths.length : outer.count;
  const named = (outer.feature & BO_NAMED) !== 0;
  for (let i = 0; i < rawCount; i++) {
    const r = blockRange(outer, i);
    const isNameBlock = named && i === rawCount - 1;
    if (isNameBlock) continue;
    const sub = parseBlockSet(fd, r.start);
    const orig = readAt(fd, r.start, r.end - r.start);
    const rebuilt = rebuild(fd, sub, outer.names[i] ?? String(i));
    subReports.push(
      `  ${(outer.names[i] ?? i).padEnd(20)} ${String(orig.length).padStart(10)} B  ${
        rebuilt.equals(orig) ? 'ok' : 'DIFF'
      }  feature=0x${sub.feature.toString(16)} blocks=${sub.count} names=${sub.names.length}`,
    );
  }

  const mine = Buffer.concat([headerBytes, rebuild(fd, outer, '<outer>')]);
  closeSync(fd);

  const original = readFileSync(file);
  const same = mine.length === size && mine.equals(original);
  console.log(`${same ? 'ok  ' : 'FAIL'} ${file}: original ${size} B, rewrite ${mine.length} B`);
  if (!same) {
    let at = 0;
    while (at < Math.min(original.length, mine.length) && original[at] === mine[at]) at++;
    console.log(`     first difference at byte ${at} (original ${original[at]}, mine ${mine[at]})`);
  }
  if (args.includes('--report')) {
    console.log('  sub containers:');
    for (const s of subReports) console.log(s);
    console.log(
      `  outer: feature=0x${outer.feature.toString(16)} blocks=${outer.count} names=${outer.names.length} ` +
        `lengths=${outer.lengths?.length ?? 'fixed'} header=${ROMBLOCK_HEADER_SIZE}B`,
    );
  }
  if (out) {
    writeFileSync(out, mine);
    console.log(`wrote ${out}`);
  }
  process.exitCode = same ? 0 : 1;
}

main();
