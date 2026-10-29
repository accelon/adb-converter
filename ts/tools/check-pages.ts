/**
 * 底座重建後的頁 id／跨庫連結檢查（作者 2026-10-29）。
 *
 *   cd ts && bun run tools/check-pages.ts --adb build/taisho-2026R2.adb \
 *     --old D:\accelon3\taisho.adb \
 *     --xref build/ys-linked.txt,build/taixu-linked.txt,build/lc-linked.txt,build/yulinpo-linked.txt
 *
 * 做三件事：
 *   1. `attributes/頁.id` 的數量／唯一性（頁 id 重複會讓跳至、回連結錯亂）。
 *   2. 與舊底座比較：新增／消失的頁 id（消失的頁會讓既有 `<聯>` 斷掉）。
 *   3. 掃 linked 文字裡的 `<聯 i="taisho?頁id">`，列出新底座找不到的頁 id。
 */
import { existsSync, readFileSync } from 'node:fs';
import { AdbReader, SyncIO } from '../src/accelon26/adb';

const args = process.argv.slice(2);
const opt = (n: string, d = '') => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const ADB = opt('adb');
const OLD = opt('old');
const XREFS = opt('xref').split(',').map((s) => s.trim()).filter(Boolean);
const TARGET = opt('target', 'taisho');
if (!ADB) { console.error('需要 --adb <新 adb>'); process.exit(2); }

async function pages(path: string): Promise<string[]> {
  const r = await AdbReader.open(new SyncIO(path));
  const a = await r.attributeValues('頁.id');
  return a?.values ?? [];
}

const now = await pages(ADB);
const uniqNow = new Set(now);
console.log(`${ADB}`);
console.log(`  頁 id：${now.length} 個，唯一 ${uniqNow.size}${now.length === uniqNow.size ? ' ✓' : ' ✗ 有重複！'}`);

if (OLD && existsSync(OLD)) {
  const old = await pages(OLD);
  const uniqOld = new Set(old);
  const added = [...uniqNow].filter((x) => !uniqOld.has(x));
  const removed = [...uniqOld].filter((x) => !uniqNow.has(x));
  console.log(`  舊檔：${old.length} 個（唯一 ${uniqOld.size}）`);
  console.log(`  新增 ${added.length}、消失 ${removed.length}`);
  if (removed.length) console.log('  消失的頁（前 30）：' + removed.slice(0, 30).join('、'));
}

let bad = 0;
for (const f of XREFS) {
  if (!existsSync(f)) { console.log(`  （找不到 ${f}，略過）`); continue; }
  const text = readFileSync(f, 'utf8');
  const re = new RegExp(`<聯 i="${TARGET}\\?([^"\\s]+)"`, 'g');
  const ids = new Set<string>();
  for (let m = re.exec(text); m; m = re.exec(text)) ids.add(m[1]);
  const miss = [...ids].filter((id) => !uniqNow.has(id));
  console.log(`  ${f}：${ids.size} 個 ${TARGET} 頁 id，找不到 ${miss.length}`
    + (miss.length ? '（前 20：' + miss.slice(0, 20).join('、') + '）' : ' ✓'));
  if (miss.length) bad++;
}

if (now.length !== uniqNow.size) bad++;
process.exit(bad ? 1 : 0);
