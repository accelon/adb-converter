#!/usr/bin/env bun
/**
 * Build a small, self contained .adb for testing with the old Accelon3.exe.
 *
 *   bun run tools/make-small.ts <source.adb> [--docs 10] [--out build/<name>-small.adb]
 *                              [--work build/<name>-small]
 *
 * What it does:
 *   1. extracts the whole source database into a working directory (tools/extract.ts)
 *   2. keeps only the first N documents (the 檔 documents, in order) and only the
 *      resources those documents actually reference, plus the collection logo
 *      (`<dbname>_logo.png`, which the reader loads by convention) and any other
 *      file at the resources root (about/help images)
 *   3. rebuilds a new .adb from that subset (tools/rebuild-adb.ts, no original
 *      needed) and verifies it by extracting it again and comparing the XML
 *   4. writes a report next to the .adb (JSON) and prints a summary
 *
 * The result is deterministic: running it again after a code change produces a
 * fresh yinshun-small.adb that can be loaded in the old program to check it.
 */
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { parseBlockSet, blockOffsetByName, blockRange, readAt, FILE_HEADER_SIZE } from '../src/format';
import { readAdbText } from '../src/adbtext';

const args = process.argv.slice(2);
const source = args.find((a) => !a.startsWith('-'));
if (!source) {
  console.error('usage: bun run tools/make-small.ts <source.adb> [--docs N] [--out file.adb] [--work dir]');
  process.exit(2);
}
const docs = args.includes('--docs') ? Number(args[args.indexOf('--docs') + 1]) : 10;
const dbname = basename(source).replace(/\.adb$/i, '');
const root = join(import.meta.dir, '..', '..');
const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : join(root, 'build', dbname + '-small.adb');
const work = args.includes('--work') ? args[args.indexOf('--work') + 1] : join(root, 'build', dbname + '-small');
const tsDir = join(import.meta.dir, '..');
const repo = join(tsDir, '..');
const run = (argv: string[]): { code: number; out: string } => {
  const p = Bun.spawnSync(['bun', 'run', ...argv], { cwd: tsDir });
  return { code: p.exitCode, out: `${p.stdout.toString()}${p.stderr.toString()}` };
};

// ---------------------------------------------------- 1. extract the whole file
const full = join(work, 'full');
rmSync(full, { recursive: true, force: true });
mkdirSync(full, { recursive: true });
console.log(`[1/4] extracting ${source} ...`);
{
  const r = run(['tools/extract.ts', source, '-o', full, '--quiet']);
  if (r.code !== 0) {
    console.error(r.out.slice(-800));
    process.exit(1);
  }
}
const manifest = JSON.parse(readFileSync(join(full, 'manifest.json'), 'utf8'));

// ------------------------------------------------- 2. keep only the first N docs
const adb = readAdbText(source);
const fileTagAt = adb.tagNames.indexOf('檔');
const docStarts: number[] = [];
if (fileTagAt >= 0) {
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
  for (const va of adb.tagHits(fileTagAt)) docStarts.push(lineOf(va));
}
const keep = docStarts.slice(0, docs).length || Math.min(docs, manifest.files.length);
const keptFiles = manifest.files.slice(0, keep);
const text = adb.lines.join('\n');

const subset = join(work, 'small');
rmSync(subset, { recursive: true, force: true });
mkdirSync(join(subset, 'resources'), { recursive: true });
let textBytes = 0;
for (const f of keptFiles) {
  copyFileSync(join(full, f.name), join(subset, f.name));
  textBytes += f.bytes;
}

// --------------------------------------------------- 3. only the used resources
const allResources: { name: string; bytes: number }[] = manifest.resources.items;
const used: string[] = [];
// the text of the kept documents decides which images are referenced
const keptText = keptFiles.map((f: { name: string }) => readFileSync(join(full, f.name), 'utf8')).join('\n');
for (const r of allResources) {
  const base = r.name.replace(/^.*\//, '');
  const referenced = keptText.includes(r.name) || keptText.includes(base);
  // the reader looks up <dbname>_logo.png by convention, and any file directly
  // at the resources root belongs to the shell (about box, help, ...)
  const conventional = basename(r.name) === `${dbname}_logo.png` || !r.name.includes('/');
  if (referenced || conventional) used.push(r.name);
}
for (const name of used) {
  const target = join(subset, 'resources', name);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(full, 'resources', name), target);
}
// The reader looks the collection logo up as `<dbname>_logo.png` where the name
// comes from the database FILE: when the output is renamed (yinshun-small), the
// logo must carry the matching name or it vanishes in the viewer.
const outBase = basename(out).replace(/\.adb$/i, '');
const logoSource = used.find((n) => basename(n) === dbname + '_logo.png');
const logoAliases: string[] = [];
if (logoSource && outBase !== dbname) {
  const alias = outBase + '_logo.png';
  copyFileSync(join(full, 'resources', logoSource), join(subset, 'resources', alias));
  used.push(alias);
  logoAliases.push(alias);
  console.log('      logo alias for the renamed file: ' + alias);
}
const subsetManifest = {
  ...manifest,
  source: relative(subset, source) || source,
  documents: keptFiles.length,
  subset: { of: source, documents: keep, ofTotal: manifest.files.length, textBytes },
  files: keptFiles,
  resources: {
    count: used.length,
    bytes: used.reduce((a, n) => a + (allResources.find((r) => r.name === n)?.bytes ?? 0), 0),
    items: allResources
      .filter((r) => used.includes(r.name))
      .concat(logoAliases.map((n) => ({ name: n, bytes: allResources.find((r) => r.name === logoSource)?.bytes ?? 0 }))),
  },
};
writeFileSync(join(subset, 'manifest.json'), JSON.stringify(subsetManifest, null, 2));
console.log(
  `[2/4] kept ${keptFiles.length}/${manifest.files.length} documents (${(textBytes / 1048576).toFixed(1)} MiB) and ` +
    `${used.length}/${allResources.length} resources (${(subsetManifest.resources.bytes / 1048576).toFixed(2)} MiB)`,
);
if (used.includes(`${dbname}_logo.png`)) console.log(`      logo kept: ${dbname}_logo.png`);

// --------------------------------------------------------------- 4. rebuild it
rmSync(out, { force: true });
console.log(`[3/4] rebuilding ${out} ...`);
{
  const r = run(['tools/rebuild-adb.ts', subset, '-o', out]);
  if (r.code !== 0 && !existsSync(out)) {
    console.error(r.out.slice(-1200));
    process.exit(1);
  }
}
const size = statSync(out).size;

// ------------------------------------------------------------------- verify
const again = join(work, 'reextract');
rmSync(again, { recursive: true, force: true });
mkdirSync(again, { recursive: true });
const roundtrip = run(['tools/extract.ts', out, '-o', again, '--quiet']);
const sameXml: string[] = [];
const diffXml: string[] = [];
for (const f of keptFiles) {
  const a = readFileSync(join(subset, f.name));
  const b = existsSync(join(again, f.name)) ? readFileSync(join(again, f.name)) : Buffer.alloc(0);
  (a.equals(b) ? sameXml : diffXml).push(f.name);
}
const smallAdb = readAdbText(out);
const report = {
  source,
  out,
  bytes: size,
  documents: keptFiles.length,
  lines: smallAdb.lines.length,
  textBytes,
  header: {
    dbname: smallAdb.header.dbname,
    dbcname: smallAdb.header.dbcname,
    lineCount: smallAdb.header.lineCount,
    maxBlockOffset: smallAdb.header.maxBlockOffset,
    tagCount: smallAdb.header.tagCount,
    srcBlockSize: smallAdb.header.srcBlockSize,
    andTagId: smallAdb.header.andTagId,
    dbType: smallAdb.header.dbType,
    compression: smallAdb.header.compression,
  },
  containers: smallAdb.outer.names,
  resources: subsetManifest.resources,
  roundTrip: { identical: sameXml.length, different: diffXml },
  extractOfSmallAdbOk: roundtrip.code === 0,
};
smallAdb.close();
adb.close();
writeFileSync(join(dirname(out) || '.', `${dbname}-small-report.json`), JSON.stringify(report, null, 2));
console.log(
  `[4/4] ${out}: ${(size / 1048576).toFixed(2)} MiB, ${report.lines} lines, ` +
    `${report.resources.count} resources; re-extract round trip: ${sameXml.length} identical, ${diffXml.length} different`,
);
if (diffXml.length) console.log(`      differs: ${diffXml.slice(0, 5).join(', ')}`);
console.log(`report: ${join(dirname(out) || '.', `${dbname}-small-report.json`)}`);
