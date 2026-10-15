#!/usr/bin/env bun
/**
 * Golden tests for the exporter.
 *
 * Fixtures live in the repository root (13j.adb is the sample database). The
 * expected SHA-256 values were produced by the independent reference decoder
 * (accelon/adbjs, `dumpXML`/`dumpAll`) - see FORMAT.md "Verification".
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { exportAdb } from '../src/export';

const root = resolve(dirname(import.meta.dir), '..');
const fixture = process.argv[2] ?? join(root, '13j.adb');

/** 13j.adb, exported by the reference decoder (dumpXML). */
const GOLDEN_13J = 'd0a82266bc35c58e1c6ac896132ca5a1f6903dffce95c7b872eaac343a38a74d';

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) {
    pass++;
    console.log(`  ok    ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
  }
};

const sha256 = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');

if (!existsSync(fixture)) {
  console.error(`missing fixture ${fixture}`);
  process.exit(2);
}

const outDir = mkdtempSync(join(tmpdir(), 'abx-test-'));
console.log(`fixture ${fixture}`);
console.log(`out     ${outDir}`);

// 1. the adbjs model must reproduce the JS port byte for byte, and both models
//    must agree on a database without BOMs / cross block surrogate pairs
const hashes: Record<string, string> = {};
for (const [name, model, jobs] of [
  ['adbjs/j1', 'adbjs', 1],
  ['adbjs/j3', 'adbjs', 3],
  ['adbjs/j14', 'adbjs', 14],
  ['delphi/j1', 'delphi', 1],
  ['delphi/j7', 'delphi', 7],
] as const) {
  const dir = join(outDir, name.replace('/', '-'));
  mkdirSync(dir, { recursive: true });
  await exportAdb(fixture, { outDir: dir, jobs, noOverwrite: false, text: model });
  hashes[name] = sha256(join(dir, '13j.xml'));
}
check('adbjs  model matches reference dumpXML', hashes['adbjs/j1'] === GOLDEN_13J, hashes['adbjs/j1']);
check('adbjs  model is thread count independent', hashes['adbjs/j3'] === hashes['adbjs/j1'] && hashes['adbjs/j14'] === hashes['adbjs/j1']);
check('delphi model identical here (no BOM / surrogate split in 13j)', hashes['delphi/j1'] === GOLDEN_13J, hashes['delphi/j1']);
check('delphi model is thread count independent', hashes['delphi/j7'] === hashes['delphi/j1']);

// 2. line count and size sanity
const dir1 = join(outDir, 'adbjs-j1');
const xml = readFileSync(join(dir1, '13j.xml'));
const lines = xml.toString('utf8').split('\n');
check('42173 lines', lines.length === 42173, String(lines.length));
check('2484602 bytes', xml.length === 2484602, String(xml.length));
check('starts with <集>十三經</集>', lines[0] === '<集>十三經</集>', lines[0]);
check('last non empty line is 孟子終', lines[lines.length - 3] === '孟子終', lines[lines.length - 3]);
check('two trailing empty lines', lines[lines.length - 1] === '' && lines[lines.length - 2] === '');

// 3. inspect agrees with the header
const { inspectAdb } = await import('../src/export');
const info = inspectAdb(fixture);
check('linecount == lines.physical entries', info.header!.lineCount === info.lineEnds.length);
check('dbcname is 十三經', info.header!.dbcname === '十三經', JSON.stringify(info.header!.dbcname));
check(
  'outer blocks are named',
  info.outer.names.join(',') === 'source,tokens,tags,tables,attributes,caches',
  info.outer.names.join(','),
);

rmSync(outDir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
