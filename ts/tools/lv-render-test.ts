#!/usr/bin/env bun
/**
 * 科判層號 `lv="N"` 的最小回歸（厚觀法師《法華經講義》方案丙，作者 2026-11-15）。
 *
 *   cd ts && bun run tools/lv-render-test.ts
 *
 * 《法華經講義》的科判是「甲一、乙一…子一、丑一…」共 19 層，比資料庫的標籤層級多；
 * 同一個 `<項>` 裝 19 層時，靠 `lv` 給左縮進與色號（字級不動——紙本科判與正文同級，
 * 靠位置分辨深淺）。這裡只驗「沒有 lv 的標題完全不受影響」與「縮進／色號對得上」。
 */
import { renderPageBlocks, setTierContext, computeTierContext } from '../src/accelon26/render_accelon3';

const roots = [
  {
    tag: '書', title: '法華經講義', children: [
      { tag: '品', title: '序品', children: [{ tag: '項', title: '甲一', children: [] }] },
    ],
  },
] as any;
setTierContext(computeTierContext(roots));

const lines = [
  '<書 id="yl7">法華經講義</書>',
  '<品>〈序品第一〉</品>',
  '<項 lv="1">甲一　為佛護念</項>',
  '<項 lv="2">乙一　總標</項>',
  '<項 lv="12">子一　別釋</項>',
  '<項>丙一　沒有層號的標題（不該有縮進）</項>',
  '正文一段，不含任何標題。',
];
const blocks = renderPageBlocks(lines, lines.map((_, i) => i + 1));
let out = '';
for (const b of blocks) for (const ln of b.lines) if ((ln as any).visible) out += ((ln as any).html ?? '') + '\n';

const checks: [string, boolean][] = [
  ['lv=1 有 data-lv', out.includes('data-lv="1"')],
  ['lv=12 有 data-lv', out.includes('data-lv="12"')],
  ['lv=1 不縮進', !/data-lv="1"[^>]*padding-left/.test(out)],
  ['lv=2 縮進 0.9em', /data-lv="2"[^>]*padding-left:0\.9em/.test(out)],
  ['lv=12 縮進 9.9em', /data-lv="12"[^>]*padding-left:9\.9em/.test(out)],
  ['lv=12 色號 3', /data-lv="12"[^>]*--tagtext:var\(--tag-text-3\)/.test(out)],
  ['沒有 lv 的標題沒有 data-lv', (out.match(/class="h"/g) ?? []).length === 6 && !/data-lv="undefined"/.test(out)],
  ['正文照常輸出', out.includes('正文一段')],
];
let fail = 0;
for (const [name, ok] of checks) {
  console.log((ok ? '  ok   ' : '  FAIL ') + name);
  if (!ok) fail++;
}
if (fail) {
  console.log('\n--- 實際輸出 ---\n' + out);
  process.exit(1);
}
console.log('\n全部通過');
