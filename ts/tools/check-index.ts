#!/usr/bin/env bun
/**
 * Integrity check for an AUTHORED database: re-index the XML the authoring tool
 * produced and compare every posting list (tokens and tags) with what is stored
 * in the .adb.
 *
 *   bun run tools/check-index.ts <xml> <adb> [--drop-punct "…"]
 *
 * This is the authoring counterpart of `test/index-match.ts` (which checks a
 * rebuilt copy of an existing database). It answers one question: did the
 * writer store exactly the index the indexer computed — same keys, same order,
 * same virtual addresses?
 *
 * Exit code 0 = identical, 1 = differences (up to 20 printed).
 */
import { openSync, readFileSync } from 'node:fs';
import { blockOffsetByName, blockRange, decodePackedList, FILE_HEADER_SIZE, parseBlockSet, readAt } from '../src/format';
import { buildIndex } from '../src/index-builder';

const args = process.argv.slice(2);
const opt = (name: string, dflt?: string): string | undefined => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const files = args.filter((a, i) => !a.startsWith('-') && args[i - 1] !== '--drop-punct');
const [xmlPath, adbPath] = files;
if (!xmlPath || !adbPath) {
  console.error('usage: bun run tools/check-index.ts <xml> <adb> [--drop-punct ""]');
  process.exit(2);
}

const lines = readFileSync(xmlPath, 'utf8').replace(/\n$/, '').split('\n');
const built = buildIndex([lines], {
  srcBlockSize: 16384,
  ignoreBlank: false,
  validTags: null,
  indexedTags: null,
  dropPunct: opt('drop-punct'),
  dualIndexSelfClosing: false,
  cachedTags: null,
});

const fd = openSync(adbPath, 'r');
const outer = parseBlockSet(fd, FILE_HEADER_SIZE)!;
function list(container: string, name: string): number[] | null {
  const c = parseBlockSet(fd, blockOffsetByName(outer, container)!)!;
  const i = c.names.indexOf(name);
  if (i < 0) return null;
  const r = blockRange(c, i);
  return decodePackedList(readAt(fd, r.start, r.end - r.start));
}

let bad = 0;
let shown = 0;
const report = (kind: string, name: string, want: number[], got: number[] | null): void => {
  const same = got && got.length === want.length && got.every((v, i) => v === want[i]);
  if (same) return;
  bad++;
  if (shown++ < 20) {
    console.log(`${kind} differs: ${JSON.stringify(name)} — indexer ${want.length} hit(s), adb ${got ? got.length : 'missing'}`);
    if (got) {
      const at = want.findIndex((v, i) => v !== got[i]);
      console.log(`    first difference at #${at}: indexer ${want[at]}, adb ${got[at]}`);
    }
  }
};

let storedHits = 0;
for (const [name, want] of built.tokens) {
  const got = list('tokens', name);
  storedHits += got?.length ?? 0;
  report('token', name, want, got);
}
for (const [name, want] of built.tags) report('tag', name, want, list('tags', name));

const storedNames = (container: string): string[] => parseBlockSet(fd, blockOffsetByName(outer, container)!)?.names ?? [];
const extraTokens = storedNames('tokens').filter((n) => !built.tokens.has(n));
const extraTags = storedNames('tags').filter((n) => !built.tags.has(n));
if (extraTokens.length) console.log('token names only in the adb:', JSON.stringify(extraTokens.slice(0, 10)));
if (extraTags.length) console.log('tag names only in the adb:', JSON.stringify(extraTags.slice(0, 10)));

console.log(
  `${built.tokens.size} tokens / ${built.tokenHits} hits, ${built.tags.size} tags — ` +
    `indexer vs adb: ${bad === 0 && !extraTokens.length && !extraTags.length ? 'identical' : `${bad} difference(s)`} ` +
    `(adb postings ${storedHits})`,
);
process.exitCode = bad === 0 && !extraTokens.length && !extraTags.length ? 0 : 1;
