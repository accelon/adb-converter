#!/usr/bin/env bun
/**
 * Summarise build/corpus-scan.tsv (produced by tools/scan-corpus.ts) and emit a
 * markdown block for SPEC.md.
 *
 * usage: bun run tools/corpus-summary.ts [scan.tsv]
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const path = process.argv[2] ?? join(import.meta.dir, '..', '..', 'build', 'corpus-scan.tsv');
const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim().length > 0);
const header = lines[0].split('\t');
const rows = lines.slice(1).map((l) => {
  const f = l.split('\t');
  const num = (i: number) => Number(f[i] || 0);
  return {
    file: f[0], mib: num(1), dbname: f[2], dbcname: f[3], dbtype: num(4), features: num(5),
    blocks: num(6), lines: num(7), chars: num(8), tokens: num(9), hits: num(10),
    uni: num(11), unihits: num(12), coverage: num(13), cjkUni: num(14),
    tags: num(15), tagHits: num(16), docs: num(17), collection: f[18],
    resources: num(19), images: num(20), imageMiB: num(21), ms: num(22), error: f[23] ?? '',
  };
});
const sum = (pick: (r: typeof rows[number]) => number) => rows.reduce((a, r) => a + pick(r), 0);
const fmt = (n: number) => n.toLocaleString('en-US');

console.log(`# corpus scan summary (${path})\n`);
console.log(`databases            : ${rows.length}`);
console.log(`total size           : ${(sum((r) => r.mib) / 1024).toFixed(2)} GiB`);
console.log(`total text           : ${fmt(sum((r) => r.chars))} chars (${(sum((r) => r.chars) / 1e9).toFixed(2)} G)`);
console.log(`total lines          : ${fmt(sum((r) => r.lines))}`);
console.log(`total source blocks  : ${fmt(sum((r) => r.blocks))}`);
console.log(`token index hits     : ${fmt(sum((r) => r.hits))}`);
console.log(`unigram index hits   : ${fmt(sum((r) => r.unihits))} (${((sum((r) => r.unihits) / sum((r) => r.hits)) * 100).toFixed(1)}% of all hits)`);
console.log(`distinct unigrams    : ${fmt(sum((r) => r.uni))} (sum over databases)`);
console.log(`distinct dbnames     : ${new Set(rows.map((r) => r.dbname)).size}`);
console.log(`dictionary databases : ${rows.filter((r) => r.dbtype & 2).length}`);
console.log(`databases with 檔    : ${rows.filter((r) => r.docs > 0).length}  (documents total ${fmt(sum((r) => r.docs))})`);
console.log(`databases with images: ${rows.filter((r) => r.images > 0).length}  (images ${fmt(sum((r) => r.images))}, ${(sum((r) => r.imageMiB) / 1024).toFixed(2)} GiB)`);
console.log(`resources total      : ${fmt(sum((r) => r.resources))}`);
console.log(`errors               : ${rows.filter((r) => r.error).length}`);
console.log(`scan wall time       : ${(sum((r) => r.ms) / 1000).toFixed(1)} s of analysis`);

const top = (pick: (r: typeof rows[number]) => number, n = 8) =>
  [...rows].sort((a, b) => pick(b) - pick(a)).slice(0, n);

console.log('\n## largest databases\n');
console.log('| MiB | chars | lines | unigrams | 檔 | name |');
console.log('|---:|---:|---:|---:|---:|---|');
for (const r of top((r) => r.mib)) {
  console.log(`| ${r.mib.toFixed(0)} | ${fmt(r.chars)} | ${fmt(r.lines)} | ${fmt(r.uni)} | ${r.docs} | ${r.dbcname || r.dbname} |`);
}

console.log('\n## most unigram hits\n');
console.log('| unigram hits | coverage | unigrams | name |');
console.log('|---:|---:|---:|---|');
for (const r of top((r) => r.unihits)) {
  console.log(`| ${fmt(r.unihits)} | ${r.coverage}% | ${fmt(r.uni)} | ${r.dbcname || r.dbname} |`);
}

console.log('\n## largest dictionaries (dbtype & 2)\n');
console.log('| MiB | chars | unigrams | 檔 | images | name |');
console.log('|---:|---:|---:|---:|---:|---|');
for (const r of rows.filter((r) => r.dbtype & 2).sort((a, b) => b.mib - a.mib)) {
  console.log(`| ${r.mib.toFixed(1)} | ${fmt(r.chars)} | ${fmt(r.uni)} | ${r.docs} | ${r.images} | ${r.dbcname || r.dbname} |`);
}

const withDocs = rows.filter((r) => r.docs > 0).sort((a, b) => b.docs - a.docs).slice(0, 8);
console.log('\n## most documents (檔)\n');
console.log('| 檔 | name |');
console.log('|---:|---|');
for (const r of withDocs) console.log(`| ${fmt(r.docs)} | ${r.dbcname || r.dbname} |`);
