#!/usr/bin/env bun
/**
 * Rebuild the inverted index of an .adb with the TypeScript port of the Delphi
 * tokenizer/indexer and compare it, character by character, with the index that
 * is stored inside the database.
 *
 *   bun run tools/compare-index.ts <file.adb> [--json out.json] [--max-diffs 10]
 *
 * Compared: the `tokens` container (the inverted index), the `tags` container,
 * `tables/tags.virtual`, `tables/blocks.virtual`, `tables/lines.physical`,
 * `tables/lines.virtual`, `tables/doclengths`, header.maxblockoffset/tagcount.
 */
import { closeSync, openSync, statSync, writeFileSync } from 'node:fs';
import {
  blockOffsetByName,
  blockRange,
  decodePackedList,
  packedListSize,
  parseBlockSet,
  parseHeader,
  readAt,
  FILE_HEADER_SIZE,
  type BlockSet,
} from '../src/format';
import { createDecoder } from '../src/bz2';
import { decodeChunk } from '../src/decode';
import { LineSplitter } from '../src/textstream';
import { buildIndex, type BuiltIndex } from '../src/index-builder';
import { hasHan } from '../src/han';

const argv = process.argv.slice(2);
const file = argv.find((a) => !a.startsWith('--'));
if (!file) {
  console.error('usage: bun run tools/compare-index.ts <file.adb> [--json out.json] [--max-diffs N]');
  process.exit(2);
}
const jsonOut = argv.includes('--json') ? argv[argv.indexOf('--json') + 1] : null;
const maxDiffs = argv.includes('--max-diffs') ? Number(argv[argv.indexOf('--max-diffs') + 1]) : 10;
const requireTags = argv.includes('--require-tags');
const dropPunct = argv.includes('--drop-punct') ? argv[argv.indexOf('--drop-punct') + 1] : undefined;

const started = performance.now();
const fd = openSync(file, 'r');
const size = statSync(file).size;
const header = parseHeader(readAt(fd, 0, FILE_HEADER_SIZE));
if (!header) throw new Error(`${file}: not an adb file`);
const S = header.srcBlockSize || 16384;
const outer = parseBlockSet(fd, FILE_HEADER_SIZE);
const sources = parseBlockSet(fd, blockOffsetByName(outer, 'source'));
const tables = parseBlockSet(fd, blockOffsetByName(outer, 'tables'));

const listOf = (bs: BlockSet, name: string): number[] => {
  const at = blockOffsetByName(bs, name);
  return at ? decodePackedList(readAt(fd, at, packedListSize(fd, at))) : [];
};

/** token/tag name -> ascending virtual addresses (one packed list per block) */
function readHitsMap(bs: BlockSet): Map<string, number[]> {
  const out = new Map<string, number[]>();
  const lens = new Array<number>(bs.count);
  let prev = 0;
  for (let i = 0; i < bs.count; i++) {
    const end = bs.lengths ? bs.lengths[i] : (i + 1) * bs.blockSize;
    lens[i] = end - prev;
    prev = end;
  }
  const data = bs.totalBlockSize <= 512 << 20 ? readAt(fd, bs.dataStart, bs.totalBlockSize) : null;
  for (let i = 0; i < bs.count; i++) {
    const start = bs.lengths ? (i > 0 ? bs.lengths[i - 1] : 0) : i * bs.blockSize;
    const buf = data
      ? data.subarray(start, start + lens[i])
      : readAt(fd, bs.dataStart + start, lens[i]);
    out.set(bs.names[i] ?? `#${i}`, decodePackedList(buf));
  }
  return out;
}

// ---------------------------------------------------------------- ADB tables
const adbTagsVirtual = listOf(tables, 'tags.virtual');
const adbBlocksVirtual = listOf(tables, 'blocks.virtual');
const adbLinesPhysical = listOf(tables, 'lines.physical');
const adbLinesVirtual = listOf(tables, 'lines.virtual');
const adbDocLengths = listOf(tables, 'doclengths');
const adbTokensOff = blockOffsetByName(outer, 'tokens');
const adbTagsOff = blockOffsetByName(outer, 'tags');
const adbTokens = adbTokensOff ? readHitsMap(parseBlockSet(fd, adbTokensOff)) : new Map();
const adbTags = adbTagsOff ? readHitsMap(parseBlockSet(fd, adbTagsOff)) : new Map();

// ------------------------------------------------------- extract the ADB text
// (delphi text model: physical grid, per block NUL termination, CR/LF skipped)
const textParts: string[] = [];
const splitter = new LineSplitter(adbLinesPhysical, { pushText: (s: string) => textParts.push(s) }, 1 << 22, {
  stripNul: true,
  skipCrLf: true,
  keepBom: true,
});
{
  const { decoder } = createDecoder('auto');
  const scratch = { buf: new Uint8Array(S * 4) };
  const n = sources.count;
  const perChunk = 64;
  for (let first = 0; first < n; first += perChunk) {
    const last = Math.min(n, first + perChunk) - 1;
    const start = blockRange(sources, first).start;
    const end = blockRange(sources, last).end;
    const src = new Uint8Array(readAt(fd, start, end - start));
    const ends: number[] = [];
    for (let k = first; k <= last; k++) ends.push(blockRange(sources, k).end - start);
    const { out } = decodeChunk(
      decoder,
      { src, ends, hint: S, firstBlock: first, blockCount: n, model: 'delphi' },
      scratch,
    );
    splitter.push(Buffer.from(out.buffer, out.byteOffset, out.byteLength));
  }
  splitter.finish();
  decoder.close();
}
const lines = textParts.join('').split('\n');
// the per source file boundaries are not stored in the adb; its doclengths table
// gives the running byte total at the end of each file, which maps back to a line
const fileLines: string[][] = [];
{
  let start = 0;
  for (const bytes of adbDocLengths) {
    let end = start;
    while (end < adbLinesPhysical.length && adbLinesPhysical[end] < bytes) end++;
    while (end < adbLinesPhysical.length && adbLinesPhysical[end] === bytes) end++;
    if (end <= start) continue;
    fileLines.push(lines.slice(start, end));
    start = end;
  }
  if (start < lines.length) fileLines.push(lines.slice(start));
  if (fileLines.length === 0) fileLines.push(lines);
}
console.error(`extracted ${lines.length} lines from ${file} (${(size / 1048576).toFixed(1)} MiB) in ${((performance.now() - started) / 1000).toFixed(1)}s`);

// ------------------------------------------------------------ build the index
// docdef.validate()/putindex: approximate with the tag names that exist in the
// database (the `tags` container holds one block per indexed tag name)
const validTags = new Set<string>();
for (const name of adbTags.keys()) {
  validTags.add(name);
  validTags.add(name.startsWith('/') ? name.slice(1) : name);
}
const built: BuiltIndex = buildIndex(fileLines, {
  srcBlockSize: S,
  ignoreBlank: (header.dbType & 1) !== 0,
  validTags,
  indexedTags: null,
  dropPunct,
});
console.error(`built index in ${((performance.now() - started) / 1000).toFixed(1)}s: ${built.tokens.size} tokens, ${built.tokenHits} hits, voff=${built.maxBlockOffset}`);

// ------------------------------------------------------------------- compare
let problems = 0;      // the goal: the token inverted index (plus the VA tables)
let tagProblems = 0;  // secondary: the tag index needs the docdef tag formats
const report: string[] = [];
const say = (s: string) => {
  console.log(s);
  report.push(s);
};
const checkEqual = (label: string, mine: number, adb: number, tagSide = false) => {
  const ok = mine === adb;
  if (!ok) (tagSide ? tagProblems++ : problems++);
  say(`${ok ? 'ok  ' : 'FAIL'} ${label}: ts=${mine} adb=${adb}${ok ? '' : ` (diff ${mine - adb})`}`);
};
const compareLists = (label: string, mine: number[], adb: number[], tagSide = false) => {
  if (mine.length !== adb.length) {
    (tagSide ? tagProblems++ : problems++);
    say(`FAIL ${label}: length ts=${mine.length} adb=${adb.length}`);
    return;
  }
  for (let i = 0; i < mine.length; i++) {
    if (mine[i] !== adb[i]) {
      problems++;
      say(`FAIL ${label}: first difference at index ${i}: ts=${mine[i]} adb=${adb[i]} (of ${mine.length})`);
      return;
    }
  }
  say(`ok   ${label}: ${mine.length} entries identical`);
};

checkEqual('header.maxblockoffset', built.maxBlockOffset, header.maxBlockOffset);
checkEqual('header.tagcount', built.tagCount, header.tagCount);
checkEqual('tables/tags.virtual count', built.tagsVirtual.length, adbTagsVirtual.length);
checkEqual('tables/blocks.virtual count', built.blocksVirtual.length, adbBlocksVirtual.length);
checkEqual('tables/lines.physical count', built.linesPhysical.length, adbLinesPhysical.length);
checkEqual('tables/lines.virtual count', built.linesVirtual.length, adbLinesVirtual.length);

// tokens / tags
checkEqual('token hits total', built.tokenHits, [...adbTokens.values()].reduce((a, v) => a + v.length, 0));
checkEqual('distinct tokens', built.tokens.size, adbTokens.size);
checkEqual(
  'tag hits total (needs the docdef tag formats)',
  [...built.tags.values()].reduce((a, v) => a + v.length, 0),
  [...adbTags.values()].reduce((a, v) => a + v.length, 0),
  true,
);

const missing: string[] = [];
const extra: string[] = [];
for (const k of adbTokens.keys()) if (!built.tokens.has(k)) missing.push(k);
for (const k of built.tokens.keys()) if (!adbTokens.has(k)) extra.push(k);
if (missing.length || extra.length) {
  problems++;
  say(`FAIL token key sets differ: missing ${missing.length}, extra ${extra.length}`);
  if (missing.length) say(`     missing e.g. ${missing.slice(0, maxDiffs).map((s) => JSON.stringify(s)).join(' ')}`);
  if (extra.length) {
    say(`     extra   e.g. ${extra.slice(0, maxDiffs).map((s) => JSON.stringify(s)).join(' ')}`);
    for (const k of extra.slice(0, maxDiffs)) {
      const cp = k.codePointAt(0)!.toString(16).padStart(4, '0');
      say(`       ${JSON.stringify(k)} U+${cp} hits=${built.tokens.get(k)!.length}`);
    }
  }
} else {
  say(`ok   token key sets identical (${adbTokens.size} tokens)`);
}

// where do the hit counts differ most? (diagnostic for the tokenizer rules)
{
  const keys = new Set([...adbTokens.keys(), ...built.tokens.keys()]);
  const diffs: { key: string; mine: number; adb: number; diff: number }[] = [];
  for (const k of keys) {
    const mine = built.tokens.get(k)?.length ?? 0;
    const adb = adbTokens.get(k)?.length ?? 0;
    if (mine !== adb) diffs.push({ key: k, mine, adb, diff: mine - adb });
  }
  diffs.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
  if (diffs.length) {
    say(`     ${diffs.length} tokens with a different hit count; largest:`);
    for (const d of diffs.slice(0, maxDiffs)) {
      const cp = d.key.codePointAt(0)!.toString(16).padStart(4, '0');
      say(`       ${JSON.stringify(d.key)} U+${cp} ts=${d.mine} adb=${d.adb} diff=${d.diff}`);
    }
  }
}

// per token character level comparison (only when the key sets agree)
if (!missing.length && !extra.length) {
  let bad = 0;
  const shown: string[] = [];
  for (const [token, adbHits] of adbTokens) {
    const mine = built.tokens.get(token)!;
    if (mine.length !== adbHits.length) {
      bad++;
      if (shown.length < maxDiffs) shown.push(`${JSON.stringify(token)} length ts=${mine.length} adb=${adbHits.length}`);
      continue;
    }
    for (let i = 0; i < mine.length; i++) {
      if (mine[i] !== adbHits[i]) {
        bad++;
        if (shown.length < maxDiffs) {
          shown.push(`${JSON.stringify(token)} pos[${i}] ts=${mine[i]} adb=${adbHits[i]}`);
        }
        break;
      }
    }
  }
  if (bad === 0) say(`ok   every token's hit list is identical (${adbTokens.size} tokens)`);
  else {
    problems++;
    say(`FAIL ${bad} tokens differ:`);
    for (const s of shown) say(`     ${s}`);
  }

  // tags (secondary)
  let badTags = 0;
  const shownTags: string[] = [];
  for (const [name, adbHits] of adbTags) {
    const mine = built.tags.get(name);
    if (!mine) {
      badTags++;
      if (shownTags.length < maxDiffs) shownTags.push(`${JSON.stringify(name)} missing in ts`);
      continue;
    }
    if (mine.length !== adbHits.length) {
      badTags++;
      if (shownTags.length < maxDiffs) shownTags.push(`${JSON.stringify(name)} length ts=${mine.length} adb=${adbHits.length}`);
      continue;
    }
    for (let i = 0; i < mine.length; i++) {
      if (mine[i] !== adbHits[i]) {
        badTags++;
        if (shownTags.length < maxDiffs) shownTags.push(`${JSON.stringify(name)} pos[${i}] ts=${mine[i]} adb=${adbHits[i]}`);
        break;
      }
    }
  }
  if (badTags === 0) say(`ok   every tag's hit list is identical (${adbTags.size} tags)`);
  else {
    // The tag index additionally records self closing tags in the close tag's
    // list when the build definition declares the tag as tfDontCare. That format
    // lives in the definition file used at build time, NOT in the adb, so it is
    // reported separately (--require-tags makes it fatal).
    tagProblems++;
    say(`note ${badTags} tags differ (needs the docdef tfDontCare formats; --require-tags to fail on it):`);
    for (const s of shownTags) say(`     ${s}`);
  }
}

compareLists('tables/tags.virtual', built.tagsVirtual, adbTagsVirtual);
compareLists('tables/blocks.virtual', built.blocksVirtual, adbBlocksVirtual);
compareLists('tables/lines.physical', built.linesPhysical, adbLinesPhysical);
compareLists('tables/lines.virtual', built.linesVirtual, adbLinesVirtual);
compareLists('tables/doclengths', built.docLengths, adbDocLengths);

// ---------------------------------------------------------- Han level order
// Databases were built by different tokenizer versions, so punctuation and
// whitespace handling differs between them (and with it every virtual address).
// Comparing the ORDER of the Han tokens instead of their addresses isolates the
// part the user cares about: which Han characters end up in the index.
{
  const seq = (map: Map<string, number[]>): { va: number; token: string }[] => {
    const out: { va: number; token: string }[] = [];
    for (const [token, vas] of map) {
      if (!hasHan(token)) continue;
      for (const va of vas) out.push({ va, token });
    }
    out.sort((a, b) => a.va - b.va);
    return out;
  };
  const mine = seq(built.tokens);
  const theirs = seq(adbTokens);
  let firstDiff = -1;
  for (let i = 0; i < Math.min(mine.length, theirs.length); i++) {
    if (mine[i].token !== theirs[i].token) {
      firstDiff = i;
      break;
    }
  }
  if (firstDiff < 0 && mine.length === theirs.length) {
    say(`ok   Han token sequence identical (${mine.length} Han tokens; order compared, addresses ignored)`);
  } else {
    say(`note Han token sequence differs: ts=${mine.length} adb=${theirs.length}`);
    const at = firstDiff < 0 ? Math.min(mine.length, theirs.length) : firstDiff;
    for (let k = Math.max(0, at - 2); k < at + 3; k++) {
      const a = mine[k] ? `ts[${k}]=${JSON.stringify(mine[k].token)}@${mine[k].va}` : `ts[${k}]=-`;
      const b = theirs[k] ? `adb[${k}]=${JSON.stringify(theirs[k].token)}@${theirs[k].va}` : `adb[${k}]=-`;
      say(`     ${a}  ${b}`);
    }
  }
}

say('');
if (problems === 0) {
  say(
    `TOKEN INDEX MATCHES EXACTLY: ${built.tokens.size} tokens, ${built.tokenHits} hits, ` +
      `every position identical (${((performance.now() - started) / 1000).toFixed(1)}s)`,
  );
  if (tagProblems) say(`(${tagProblems} tag side notes above; the token index is what this tool certifies)`);
} else {
  say(`${problems} TOKEN INDEX CHECKS FAILED`);
}

if (jsonOut) {
  const obj = {
    file,
    header: {
      dbname: header.dbname, dbcname: header.dbcname, srcBlockSize: S,
      maxBlockOffset: header.maxBlockOffset, tagCount: header.tagCount, lineCount: header.lineCount,
    },
    stats: {
      tokens: built.tokens.size, tokenHits: built.tokenHits, tags: built.tags.size,
      tagHits: [...built.tags.values()].reduce((a, v) => a + v.length, 0), blanks: built.blanks,
      invalidTags: built.invalidTags, badTokens: built.badTokens, droppedPunct: built.droppedPunct,
    },
    tokens: Object.fromEntries(built.tokens),
    tags: Object.fromEntries(built.tags),
  };
  writeFileSync(jsonOut, JSON.stringify(obj));
  console.error(`wrote ${jsonOut}`);
}
closeSync(fd);
process.exit(problems === 0 && (!requireTags || tagProblems === 0) ? 0 : 1);
