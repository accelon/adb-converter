/**
 * svg-inline-check.ts — `<圖 n="x.svg"/>` 內嵌結果的回歸檢查（2026-11-08）
 *
 *   bun run ts/tools/svg-inline-check.ts [svg 目錄]
 *
 * 檢查 Visio 匯出的圖版內嵌後：根標籤的 class 有留、`<![CDATA[` 沒有漏進樣式表、
 * overflow 沒有被丟掉。厚觀法師 2026-11-07 回報 hg03.162／hg03.164 字重疊、右邊缺漏。
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
  const rootClass = /\bclass\s*=\s*"([^"]*)"/i.exec(src)?.[1]?.trim() ?? '';
  const html = inlineSvgHtml(src, f, true);
  const problems: string[] = [];
  if (/<!\[CDATA\[|\]\]>/.test(html)) problems.push('CDATA 漏進內文');
  if (!html.includes('overflow:visible')) problems.push('沒有 overflow:visible');
  if (!/viewBox="[^"]+"/.test(html)) problems.push('沒有 viewBox');
  if (rootClass && !html.includes(`class="inlineSvg figureSvg ${rootClass}"`)) {
    problems.push(`根 class 沒保留（${rootClass}）`);
  }
  n++;
  if (problems.length) {
    bad++;
    console.log(`✗ ${f}: ${problems.join('、')}`);
  }
}
console.log(`${bad ? '✗' : '✓'} ${n - bad}/${n} 張 SVG 通過（${dir}）`);
process.exit(bad ? 1 : 0);
