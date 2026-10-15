#!/usr/bin/env bun
/**
 * Corpus wide scan: run the analyzer over every .adb under the given roots and
 * write one TSV row per database (plus a summary on stdout).
 *
 * usage: bun run tools/scan-corpus.ts <dir> [dir...]
 */
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyzeAdb } from '../src/analyze';

const roots = process.argv.slice(2);
if (roots.length === 0) {
  console.error('usage: bun run tools/scan-corpus.ts <dir> [dir...]');
  process.exit(2);
}

const files: string[] = [];
const walk = (dir: string) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.isFile() && /\.adb$/i.test(e.name)) files.push(p);
  }
};
for (const r of roots) walk(r);
files.sort();

const header = [
  'file', 'MiB', 'dbname', 'dbcname', 'dbtype', 'features', 'blocks', 'lines', 'chars',
  'tokensDistinct', 'tokenHits', 'uniDistinct', 'uniHits', 'uniCoverage', 'cjkUni',
  'tags', 'tagHits', 'documents', 'collection', 'resources', 'images', 'imageMiB', 'ms', 'error',
].join('\t');

const rows: string[] = [];
const t0All = performance.now();
for (let i = 0; i < files.length; i++) {
  const file = files[i];
  const started = performance.now();
  try {
    const m = analyzeAdb(file, { top: 5 });
    const tk = m.tokens;
    const uniTotal = tk.unigram.hits;
    const coverage = tk.totalHits ? ((uniTotal / tk.totalHits) * 100).toFixed(1) : '0';
    rows.push([
      file.replace(/^[A-Za-z]:\\/, ''), (m.size / 1048576).toFixed(2), m.header.dbname, m.header.dbcname,
      m.header.dbType, m.header.features, m.text.blocks, m.text.lineCount, m.text.chars,
      tk.distinct, tk.totalHits, tk.unigram.distinct, uniTotal, coverage, tk.unigramClasses.cjk,
      m.tags.length, m.tags.reduce((a, t) => a + t.hits, 0),
      m.documents ? m.documents.count : 0, m.collection?.sample[0]?.name ?? '',
      m.resources.count, m.resources.images, (m.resources.imageBytes / 1048576).toFixed(2),
      Math.round(m.ms), '',
    ].join('\t'));
    if (i % 5 === 0 || i === files.length - 1) {
      console.error(`[${i + 1}/${files.length}] ${file} ${Math.round(performance.now() - started)}ms`);
    }
  } catch (e) {
    rows.push([file, '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', (e as Error).message].join('\t'));
    console.error(`[${i + 1}/${files.length}] FAILED ${file}: ${(e as Error).message}`);
  }
}

const out = join(import.meta.dir, '..', '..', 'build', 'corpus-scan.tsv');
writeFileSync(out, header + '\n' + rows.join('\n') + '\n');
console.error(`wrote ${out} (${files.length} databases in ${((performance.now() - t0All) / 1000).toFixed(1)}s)`);
