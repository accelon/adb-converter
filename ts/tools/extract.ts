#!/usr/bin/env bun
/**
 * Extract an .adb into well formed XML files plus every resource (images).
 *
 *   bun run tools/extract.ts <file.adb> -o <outdir> [--no-repair] [--no-root]
 *                            [--resources-only] [--quiet]
 *
 * The database text is split at `檔` (FILE) boundaries; each document is
 * repaired into well formed XML (src/xmlrepair.ts) and written as the file name
 * the database itself records in the 檔 element's `n` attribute. Databases
 * without 檔 produce a single `<dbname>.xml`; when the fragment has no single
 * root element it is wrapped in a synthetic `<adb>` element (the indexer strips
 * it again).
 *
 * Every block of the `resources` container is written out byte for byte under
 * the name stored in the container (paths such as `images/mc0198.png`), and a
 * manifest.json records the line count, per file hashes, repair statistics and
 * the full resource list so the result can be verified block by block.
 */
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve, sep } from 'node:path';
import { readAdbText } from '../src/adbtext';
import { blockOffsetByName, blockRange, parseBlockSet, readAt } from '../src/format';
import { emptyStats, needsRoot, repairDocument, type RepairStats } from '../src/xmlrepair';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('-'));
const outDir = args.includes('-o') ? args[args.indexOf('-o') + 1] : null;
const repair = !args.includes('--no-repair');
const wrapRoot = !args.includes('--no-root');
const resourcesOnly = args.includes('--resources-only');
const quiet = args.includes('--quiet');

if (!file || !outDir) {
  console.error('usage: bun run tools/extract.ts <file.adb> -o <outdir> [--no-repair] [--no-root] [--resources-only]');
  process.exit(2);
}

const sha = (b: Uint8Array | string): string =>
  createHash('sha256').update(b as never).digest('hex');

const adb = readAdbText(file);
mkdirSync(outDir, { recursive: true });

// ------------------------------------------------------------ resources first
const resources: { name: string; bytes: number; sha256: string; path: string }[] = [];
{
  const fd = openSync(file, 'r');
  const at = blockOffsetByName(adb.outer, 'resources');
  if (at) {
    const res = parseBlockSet(fd, at);
    for (let i = 0; i < res.count; i++) {
      const name = res.names[i] ?? `resource-${i}`;
      const target = join(outDir, 'resources', name);
      const rel = relative(outDir, resolve(target));
      if (rel.startsWith('..') || rel.startsWith(sep)) throw new Error(`resource name escapes the output dir: ${name}`);
      const r = blockRange(res, i);
      const data = readAt(fd, r.start, r.end - r.start);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, data);
      resources.push({ name, bytes: data.length, sha256: sha(data), path: normalize(join('resources', name)) });
    }
  }
  closeSync(fd);
}

// ------------------------------------------------------------- documents (檔)
interface Doc {
  name: string;
  fromLine: number;
  toLine: number;
}
const docs: Doc[] = [];
const fileTagAt = adb.tagNames.indexOf('檔');
if (fileTagAt >= 0) {
  const hits = adb.tagHits(fileTagAt);
  const lineOf = (va: number): number => {
    let lo = 0;
    let hi = adb.linesVirtual.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (adb.linesVirtual[mid] < va) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  // the `n` attribute of each 檔 element gives the file name; read it from the text
  const names: string[] = [];
  for (let i = 0; i < hits.length; i++) {
    const ln = lineOf(hits[i]);
    const m = /<檔[^>]*\bn\s*=\s*"([^"]*)"/.exec(adb.lines[ln] ?? '');
    names.push(m?.[1] ?? '');
  }
  const starts = hits.map(lineOf);
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i];
    const to = i + 1 < starts.length ? starts[i + 1] : adb.lines.length;
    const raw = (names[i] || '').trim();
    docs.push({ name: raw || `${adb.header.dbname}-${String(i + 1).padStart(3, '0')}.xml`, fromLine: from, toLine: to });
  }
} else {
  docs.push({ name: `${adb.header.dbname}.xml`, fromLine: 0, toLine: adb.lines.length });
}

// ------------------------------------------------------------------- write
const files: Record<string, unknown>[] = [];
const totals: RepairStats = emptyStats();
for (const d of docs) {
  if (resourcesOnly) break;
  const text = adb.lines.slice(d.fromLine, d.toLine).join('\n');
  const stats = emptyStats();
  let body = text;
  let wrapped = false;
  if (repair) {
    body = repairDocument(text, stats);
    // a synthetic root is needed whenever the fragment is not exactly one well
    // formed element (databases without 檔, several top level elements, stray
    // text outside the elements); the indexer removes it again
    if (wrapRoot && needsRoot(body)) {
      const attrs = Object.entries({ dbname: adb.header.dbname, source: d.name })
        .map(([k, v]) => ` ${k}="${v}"`)
        .join('');
      body = `<adb${attrs}>${body}</adb>`;
      wrapped = true;
    }
  }
  const target = join(outDir, d.name);
  const rel = relative(outDir, resolve(target));
  if (rel.startsWith('..') || rel.startsWith(sep)) throw new Error(`document name escapes the output dir: ${d.name}`);
  mkdirSync(dirname(target), { recursive: true });
  const data = Buffer.from(body, 'utf8');
  writeFileSync(target, data);
  for (const k of Object.keys(totals) as (keyof RepairStats)[]) {
    if (k === 'badNames') totals.badNames.push(...stats.badNames);
    else if (k === 'renamed') Object.assign(totals.renamed, stats.renamed);
    else (totals[k] as number) += stats[k] as number;
  }
  files.push({
    name: d.name,
    lines: d.toLine - d.fromLine,
    fromLine: d.fromLine,
    bytes: data.length,
    sha256: sha(data),
    wrapped,
    repairs: { ...stats, badNames: stats.badNames.length ? stats.badNames : undefined },
  });
  if (!quiet) {
    const r = stats;
    console.log(
      `  ${d.name.padEnd(28)} lines=${String(d.toLine - d.fromLine).padStart(7)} ${(data.length / 1024).toFixed(0).padStart(7)} KiB  ` +
        `repaired: amp=${r.amp} lt=${r.lt} close+=${r.insertedClose} stray=${r.droppedStray} endclose=${r.closedAtEnd} attrs=${r.attrEmpty + r.attrQuoted}`,
    );
  }
}

// docdef cached tag set: the only place it survives is the caches container
const cachesAt = blockOffsetByName(adb.outer, 'caches');
const fdTags = openSync(file, 'r');
const cachedTags = cachesAt ? parseBlockSet(fdTags, cachesAt).names : [];
closeSync(fdTags);
const SKIP_NAMES = ['頁', '聯', '註', '維', '粗', '亮', '連'];
const manifest = {
  cachedTags,
  tagKeys: adb.tagNames,
  // build parameters the adb does not store structurally, recorded so that a
  // standalone rebuild needs nothing but this directory
  dualClosing: SKIP_NAMES.some((s) => adb.tagNames.includes('/' + s)) ? 'blanket' : 'nonskip',
  singleCharTokens: adb.tokenNames.filter((n) => n.length === 1).join(''),
  source: file,
  // everything a standalone rebuild needs: the original 256 byte header and the
  // order/names of the outer containers (the header carries dbtype, serial,
  // features, andtagid ... which the text alone cannot express)
  headerBase64: readAt(openSync(file, 'r'), 0, 256).toString('base64'),
  outerNames: adb.outer.names,
  outerFeature: adb.outer.feature,
  dbname: adb.header.dbname,
  dbcname: adb.header.dbcname,
  lineCount: adb.lines.length,
  srcBlockSize: adb.srcBlockSize,
  documents: docs.length,
  repaired: repair,
  synthRoot: repair && wrapRoot && fileTagAt < 0,
  files,
  totals,
  resources: {
    count: resources.length,
    bytes: resources.reduce((a, r) => a + r.bytes, 0),
    items: resources,
  },
};
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
adb.close();

console.log(
  `${file}: ${docs.length} document(s), ${resources.length} resource(s) ` +
    `(${(manifest.resources.bytes / 1048576).toFixed(2)} MiB) -> ${outDir}`,
);
console.log(
  `repairs: amp=${totals.amp} lt=${totals.lt} insertedClose=${totals.insertedClose} droppedStray=${totals.droppedStray} ` +
    `closedAtEnd=${totals.closedAtEnd} attrEmpty=${totals.attrEmpty} attrQuoted=${totals.attrQuoted} attrEscaped=${totals.attrEscaped}` +
    (totals.badNames.length ? ` badNames=${[...new Set(totals.badNames)].slice(0, 5).join(',')}` : ''),
);
