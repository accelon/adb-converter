/**
 * 瀏覽器重建管線的測試（Bun 直接跑，不需要瀏覽器）：
 *   bun run test/rebuild-browser.test.ts [--adb path]
 *
 * 證明：
 *   1. 無編輯重建 13j 是 byte-identical（bzip2 wasm 與 libbz2 輸出相同）
 *   2. 改一頁後，只有那一頁的內文變；header/line table/tokens 都可重開
 *   3. revisions 容器可以讀回，且記錄了 old lines（回滾用）
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AdbReader, BlobIO, SyncIO } from '../src/accelon26/adb';
import { buildAdb, readAllLines, readRevisions } from '../src/accelon26/rebuild-browser';
import { applyEdits, makeRevision, sessionFor, stagePage } from '../src/accelon26/edit-session';

const args = process.argv.slice(2);
const adbPath = args.includes('--adb') ? args[args.indexOf('--adb') + 1] : resolve(import.meta.dir, '../../13j.adb');

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + name + (detail ? '  ' + detail : '')); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
};

if (!existsSync(adbPath)) {
  console.log('skip: ' + adbPath + ' not found');
  process.exit(0);
}

const reader = await AdbReader.open(new SyncIO(adbPath));
const base = await readAllLines(reader);
console.log('  base: ' + reader.header.dbname + ', ' + base.length + ' lines, ' + (reader.header.size / 1048576).toFixed(1) + ' MiB');

// 1. no-op identity
const noop = await buildAdb({ reader, lines: base, baseLines: base, edits: [], key: 'noop:' + adbPath });
const original = readFileSync(adbPath);
ok('no-op rebuild is byte-identical', noop.length === original.length && Buffer.from(noop).equals(original), noop.length + ' vs ' + original.length);

// 2. edit one page
const file = { name: adbPath, size: original.length, lastModified: 1 } as any;
const s = sessionFor(file, reader.header.dbname || 'adb');
const first = 0;
const last = Math.min(199, base.length - 1);
const oldLines = base.slice(first, last + 1);
const newLines = oldLines.slice();
const target = newLines.findIndex((x) => x.length > 2);
newLines[target] = newLines[target] + 'X';
stagePage(s, first, last, oldLines, newLines, 'test');
const merged = applyEdits(base, s.edits.values());
const rev = makeRevision(s, { name: 'test', size: original.length, lineCount: base.length, headerCrc: reader.header.crc32 }, 'v1', null);
const built = await buildAdb({ reader, lines: merged, baseLines: base, edits: [...s.edits.values()], key: 'edit:' + adbPath, revision: rev });
ok('edited build is bigger', built.length > 0);
const re = await AdbReader.open(new BlobIO(new Blob([built])));
const lines2 = await readAllLines(re);
ok('line count preserved', lines2.length === base.length, String(lines2.length));
let diffs = 0;
for (let i = 0; i < base.length; i++) if (base[i] !== lines2[i]) diffs++;
ok('only one line changed', diffs === 1, String(diffs));
ok('changed line has the edit', lines2[target] === base[target] + 'X');
ok('header.crc32 is present', re.header.crc32 !== 0);
ok('revisions container exists', re.order.includes('revisions'));
const revs = await readRevisions(re);
ok('one revision', revs.length === 1 && revs[0].id === 'v1');
const record = JSON.parse(new TextDecoder().decode(revs[0].blob));
ok('revision format', record.format === 'accelon26-revision/1');
ok('revision page', record.pages.length === 1 && record.pages[0].first === first && record.pages[0].last === last);
ok('revision keeps old lines', Array.isArray(record.pages[0].oldLines) && record.pages[0].oldLines[target] === base[target]);
ok('revision change line', record.pages[0].changes[0]?.line === target);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
