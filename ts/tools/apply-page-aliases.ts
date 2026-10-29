/**
 * 底座換版後，修正連結裡的舊頁 id（作者 2026-10-29）。
 *
 *   cd ts && bun run tools/apply-page-aliases.ts build/ys-linked.txt build/ys-linked-2026R2.txt
 *
 * 對照表在 `deploy/page-aliases.json`：
 *   { "taisho": { "27p661c": "27p661b" } }
 *
 * 為什麼要另外一張表：CBETA 換版偶爾會把頁界挪一格（舊頁 id 消失），
 * 但 `taisho.adb` 是底座、不該為了幾條連結重建；把「舊頁 → 新頁」記在這裡，
 * 重建 ys/tx/lc/yulinpo 的連結文字時套用。套用後仍要用
 * `tools/check-pages.ts` 驗一次，確認新頁 id 真的存在。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../..');
const MAP = resolve(ROOT, 'deploy/page-aliases.json');
const [, , textFile, outFile] = process.argv;
if (!textFile || !outFile) {
  console.error('usage: bun run tools/apply-page-aliases.ts <in.txt> <out.txt>');
  process.exit(2);
}

const aliases = existsSync(MAP)
  ? JSON.parse(readFileSync(MAP, 'utf8')) as Record<string, Record<string, string>>
  : {};
let text = readFileSync(textFile, 'utf8');
let total = 0;
for (const [db, map] of Object.entries(aliases)) {
  if (db.startsWith('_')) continue;
  for (const [from, to] of Object.entries(map)) {
    const needle = `${db}?${from}`;
    const n = text.split(needle).length - 1;
    if (!n) continue;
    text = text.split(needle).join(`${db}?${to}`);
    total += n;
    console.log(`  ${needle} → ${db}?${to}：${n} 處`);
  }
}
writeFileSync(outFile, text, 'utf8');
console.log(`寫好 ${outFile}（共改 ${total} 處）`);
if (!total) console.log('（沒有需要改的頁 id）');
