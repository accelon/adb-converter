/**
 * 建內建說明手冊：`src/accelon26/manual/manual.xml` → `wails/assets/manual.adb`
 *
 *   cd ts && bun run tools/build-manual.ts
 *
 * 手冊是給桌面版使用者看的：開機沒有書時自動打開它（`ui.ts` 的 openBundledManual）。
 * 網頁版不打包（單檔 HTML 不另外帶 .adb）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { authorAdb } from '../src/adbauthor';

const ROOT = resolve(import.meta.dir, '../..');
const SRC = resolve(ROOT, 'ts/src/accelon26/manual/manual.xml');
const OUT = [
  resolve(ROOT, 'wails/assets/manual.adb'),
  resolve(ROOT, 'build/manual.adb'),
];

const text = readFileSync(SRC, 'utf8').replace(/^\uFEFF/, '');
const lines = text.split(/\r?\n/);
// 檔尾空行不要（adb 的行數會多一）
while (lines.length && !lines[lines.length - 1].trim()) lines.pop();

const adb = await authorAdb({ dbname: 'manual', dbcname: '說明手冊', lines });
for (const out of OUT) writeFileSync(out, adb.file);

console.log(`說明手冊：${lines.length} 行 → ${adb.file.length} bytes`);
console.log(`  標籤：${adb.tagNames.join(' ')}`);
console.log(`  → ${OUT.join('\n  → ')}`);
