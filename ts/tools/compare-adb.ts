#!/usr/bin/env bun
/**
 * Block level comparison of two .adb files (goal 3).
 *
 *   bun run tools/compare-adb.ts <original.adb> <rebuilt.adb> [--allow-index-diff]
 *
 * What must match (the goal's "every block has to be the same"):
 *   source             decompressed text of every block, and the raw block bytes
 *   resources          every image name present, byte for byte (nothing missing)
 *   attributes/.sorted, caches, topics
 *   tables             lines.physical/virtual, blocks.virtual, tags.virtual, doclengths
 *   the text itself    line by line
 *
 * What may differ (the goal allows it, and different tokenizer builds do differ):
 *   tokens             the inverted index (postings)
 *   tags               the tag index (the tfDontCare formats live in the build
 *                      definition, which is not stored in the adb)
 * Pass --allow-index-diff (default) to only report those two, or
 * --strict to require them to be identical as well.
 */
import { closeSync, openSync } from 'node:fs';
import {
  blockOffsetByName,
  blockRange,
  parseBlockSet,
  parseHeader,
  readAt,
  FILE_HEADER_SIZE,
  type BlockSet,
} from '../src/format';
import { createDecoder } from '../src/bz2';
import { decodeChunk } from '../src/decode';

const args = process.argv.slice(2);
const files = args.filter((a) => !a.startsWith('--'));
const strict = args.includes('--strict');
if (files.length !== 2) {
  console.error('usage: bun run tools/compare-adb.ts <original.adb> <rebuilt.adb> [--strict]');
  process.exit(2);
}
const [aPath, bPath] = files;

interface Side {
  path: string;
  fd: number;
  header: NonNullable<ReturnType<typeof parseHeader>>;
  outer: BlockSet;
  container(name: string): BlockSet | null;
}
const open = (path: string): Side => {
  const fd = openSync(path, 'r');
  const header = parseHeader(readAt(fd, 0, FILE_HEADER_SIZE))!;
  if (!header) throw new Error(`${path}: not an adb`);
  const outer = parseBlockSet(fd, FILE_HEADER_SIZE);
  return {
    path,
    fd,
    header,
    outer,
    container(name: string) {
      const at = blockOffsetByName(outer, name);
      return at ? parseBlockSet(fd, at) : null;
    },
  };
};
const A = open(aPath);
const B = open(bPath);

/** blocks of a container keyed by name (the name table block itself excluded) */
function blocksOf(s: Side, bs: BlockSet | null): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  if (!bs) return out;
  const rawCount = bs.lengths ? bs.lengths.length : bs.count;
  const named = (bs.feature & 0x10000000) !== 0;
  for (let i = 0; i < rawCount; i++) {
    if (named && i === rawCount - 1) continue;
    const r = blockRange(bs, i);
    out.set(bs.names[i] ?? `#${i}`, readAt(s.fd, r.start, r.end - r.start));
  }
  return out;
}

let failures = 0;
let notes = 0;
const say = (s: string) => console.log(s);
const fail = (s: string) => {
  failures++;
  console.log(`FAIL ${s}`);
};
const note = (s: string) => {
  notes++;
  console.log(`note ${s}`);
};

say(`original ${A.path}  (${A.header.dbname}, ${A.header.lineCount} lines, srcblocksize ${A.header.srcBlockSize})`);
say(`rebuilt  ${B.path}  (${B.header.dbname}, ${B.header.lineCount} lines, srcblocksize ${B.header.srcBlockSize})`);

for (const f of ['dbname', 'lineCount', 'srcBlockSize', 'compression', 'dbType'] as const) {
  if (A.header[f] !== B.header[f]) fail(`header.${f}: ${String(A.header[f])} vs ${String(B.header[f])}`);
}
say(`ok   header: dbname/lineCount/srcBlockSize/compression/dbType match`);
if (A.header.maxBlockOffset !== B.header.maxBlockOffset) {
  note(`header.maxBlockOffset ${A.header.maxBlockOffset} vs ${B.header.maxBlockOffset}`);
}
if (A.header.tagCount !== B.header.tagCount) {
  note(`header.tagCount ${A.header.tagCount} vs ${B.header.tagCount}`);
}

const containerNames = [...new Set([...A.outer.names, ...B.outer.names])];
const indexContainers = new Set(['tokens', 'tags']);

for (const name of containerNames) {
  const bsA = A.container(name);
  const bsB = B.container(name);
  if (!bsA || !bsB) {
    fail(`container ${name}: present in ${bsA ? 'original only' : 'rebuilt only'}`);
    continue;
  }
  const mA = blocksOf(A, bsA);
  const mB = blocksOf(B, bsB);
  const missing = [...mA.keys()].filter((k) => !mB.has(k));
  const extra = [...mB.keys()].filter((k) => !mA.has(k));
  let differing = 0;
  const examples: string[] = [];
  for (const k of mA.keys()) {
    const b = mB.get(k);
    if (!b) continue;
    const a = mA.get(k)!;
    if (!a.equals(b)) {
      differing++;
      if (examples.length < 3) {
        let i = 0;
        while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
        examples.push(`${JSON.stringify(k)} (${a.length} vs ${b.length} B, first diff at ${i})`);
      }
    }
  }
  const allowed = indexContainers.has(name);
  const sizeInfo = `${mA.size} vs ${mB.size} blocks`;
  if (!differing && !missing.length && !extra.length) {
    say(`ok   ${name.padEnd(18)} ${sizeInfo}, all blocks byte identical`);
    continue;
  }
  const msg =
    `${name.padEnd(18)} ${sizeInfo}: ${differing} differing, ${missing.length} missing, ${extra.length} extra` +
    (examples.length ? ` e.g. ${examples.join('; ')}` : '');
  if (allowed && !strict) note(`${msg}  (index container: counts may differ)`);
  else fail(msg);
  if (missing.length && name === 'resources') fail(`resources lost: ${missing.slice(0, 5).join(', ')}`);
}

// ------------------------------------------------------------- source text
{
  const srcA = A.container('source');
  const srcB = B.container('source');
  if (!srcA || !srcB) fail('source container missing');
  else {
    const { decoder } = createDecoder('auto');
    const buf = new Uint8Array(A.header.srcBlockSize * 4);
    /** decode every block on its own and return the code units of each */
    const codeUnits = (s: Side, bs: BlockSet): string[] => {
      const lines: string[] = [];
      for (let k = 0; k < bs.count; k++) {
        const b = blockRange(bs, k);
        const one = new Uint8Array(readAt(s.fd, b.start, b.end - b.start));
        const { out } = decodeChunk(
          decoder,
          { src: one, ends: [one.length], hint: s.header.srcBlockSize, firstBlock: k, blockCount: bs.count, model: 'delphi' },
          { buf },
        );
        const view = Buffer.from(out.buffer, out.byteOffset, out.byteLength);
        let stop = view.length;
        for (let i = 0; i + 1 < view.length; i += 2) {
          if (view[i] === 0 && view[i + 1] === 0) {
            stop = i;
            break;
          }
        }
        lines.push(view.subarray(0, stop).toString('utf16le'));
      }
      return lines;
    };
    const ta = codeUnits(A, srcA).join('');
    const tb = codeUnits(B, srcB).join('');
    decoder.close();
    if (ta === tb) say(`ok   source text: ${(ta.length / 1048576).toFixed(1)} M code units identical`);
    else {
      let i = 0;
      while (i < Math.min(ta.length, tb.length) && ta[i] === tb[i]) i++;
      fail(`source text differs at code unit ${i} of ${ta.length} vs ${tb.length}`);
    }
  }
}

say('');
say(`${failures} failed checks, ${notes} notes${strict ? ' (strict)' : ''}`);
closeSync(A.fd);
closeSync(B.fd);
process.exitCode = failures ? 1 : 0;
