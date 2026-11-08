/**
 * svg-inline-check.ts — `<圖 n="x.svg"/>` 內嵌結果的回歸檢查（2026-11-08）
 *
 *   bun run ts/tools/svg-inline-check.ts [svg 目錄]
 *
 * 檢查 Visio 匯出的圖版內嵌後：`.stN` 樣式有沒有攤進元素、`<style>`／CDATA 有沒有
 * 漏進內文、overflow 是否收好。厚觀法師 2026-11-07 回報 hg03.162／hg03.164 字重疊、右邊缺漏。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { inlineSvgHtml } from '../src/accelon26/render_accelon3';

const dir = process.argv[2] ?? 'D:\\2026\\fuyan\\raw\\hg\\中觀今論svg';
if (!existsSync(dir)) {
  console.error('找不到目錄:', dir);
  process.exit(2);
}

let bad = 0;
let n = 0;
for (const f of readdirSync(dir).filter((x) => x.toLowerCase().endsWith('.svg'))) {
  const src = readFileSync(join(dir, f), 'utf8');
  const html = inlineSvgHtml(src, f, true);
  const problems: string[] = [];
  if (/<!\[CDATA\[|\]\]>/.test(html)) problems.push('CDATA 漏進內文');
  if (/<style/i.test(html)) problems.push('<style> 沒拿掉');
  if (!html.includes('overflow:hidden')) problems.push('沒有 overflow:hidden');
  if (!/viewBox="[^"]+"/.test(html)) problems.push('沒有 viewBox');
  // 來源有 .stN 且有 class= 的元素，就應該被攤上 style
  if (/\.st\d+\s*\{/.test(src) && !/style="[^"]*(font-size|fill|stroke)[^"]*"/.test(html)) {
    problems.push('樣式沒攤進元素');
  }
  n++;
  if (problems.length) {
    bad++;
    console.log(`✗ ${f}: ${problems.join('、')}`);
  }
}
console.log(`${bad ? '✗' : '✓'} ${n - bad}/${n} 張 SVG 通過（${dir}）`);
process.exit(bad ? 1 : 0);
