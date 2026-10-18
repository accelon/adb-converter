/**
 * 內文渲染器（`render_accelon3.ts`）的單元測試 —— 不開瀏覽器。
 *
 *   bun run test/render.test.ts
 *
 * 驗的是作者 2026-10 指定的規則：
 *   * 標題依「離本文幾層」每層 +2px、上限 200%；字色吃主題變數 `--tag-text-N`
 *   * `<頁>` → 右靠的分隔（`.pageBreak`，帶頁碼），`<段/>` → 段落
 *   * 沒有 `t=` 定義的標籤只丟標籤、文字照留；`樹`／`隱` 連內容一起隱藏
 *   * 跨行的標題在每一行都重新開／收（HTML 平衡）
 */
import { Accelon3Renderer, computeTierContext, LEVEL_MAX_SCALE, LEVEL_STEP_PX, renderPageBlocks, setTierContext, tierContext } from '../src/accelon26/render_accelon3';
import type { TreeNode } from '../src/accelon26/search';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + name + (detail ? '  ' + detail : '')); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
};

const node = (tag: string, depth: number, children: TreeNode[] = []): TreeNode => ({
  tag, depth, va: 0, vaEnd: 0, label: tag, index: 0, children,
});

// 樹：書 → 章 → 節（三層）
const roots = [node('書', 0, [node('章', 1, [node('節', 2)])])];
const ctx = computeTierContext(roots);
console.log(`層級：${JSON.stringify([...ctx.depthOf])} levels=${ctx.levels}`);
ok('computeTierContext：三個層級都記到', ctx.levels === 3 && ctx.depthOf.get('書') === 0
  && ctx.depthOf.get('章') === 1 && ctx.depthOf.get('節') === 2, JSON.stringify([...ctx.depthOf]));

setTierContext(ctx);
ok('setTierContext 會更新模組狀態', tierContext().levels === 3);

const r = new Accelon3Renderer(ctx);
const h1 = r.line('<書>周易</書>', 1);
ok('標題：書（最上層）＝本文 +2×2px，最多 180%', h1.includes(`min(calc(1em + ${2 * LEVEL_STEP_PX}px), ${LEVEL_MAX_SCALE}em)`)
  && h1.includes('data-tag="書"') && h1.includes('--tagtext:var(--tag-text-0)'), h1);

const h3 = r.line('<節>乾</節>', 2);
ok('標題：節（最深）維持 1em',
  h3.includes('font-size:1em;') && h3.includes('--tagtext:var(--tag-text-2)'), h3);

const plain = r.line('潛龍勿用', 3);
ok('本文：沒有標題就是純文字，不會多一層 span', plain === '潛龍勿用', plain);

const page = r.line('周易<頁 n="12"/>乾', 4);
ok('頁：變成 .pageBreak 並帶頁碼 12',
  page.includes('class="pageBreak"') && page.includes('data-page="12"') && page.includes('<span class="pageId">12</span>')
  && page.startsWith('周易') && page.endsWith('乾'), page);

const para = r.line('<段/>何故禮拜', 5);
ok('段：變成 <br class="para"> ＋ 縮排 span（兩個全形空格）',
  para.startsWith('<br class="para"><span class="paraIndent">　　</span>何故禮拜')
  && para.includes('　　'), para);

const unknown = r.line('<聯 i="taisho">參考</聯>正文', 6);
ok('沒有 t= 的標籤：標籤丟掉、文字留著', unknown === '參考正文', unknown);

const hidden = r.line('<隱><樹 s="*" t="書">目錄</樹></隱>正文', 7);
ok('樹／隱：連內容一起隱藏', hidden === '正文', hidden);

// 跨行標題：<章> 開在第 1 行，第 2 行還是標題，</章> 收在第 3 行
const a = r.line('<章>標題一', 8);
const b = r.line('第二行', 9);
const c = r.line('結束</章>之後', 10);
ok('跨行標題：每一行都重新開 span、行尾收掉',
  a.includes('data-tag="章"') && b.includes('data-tag="章"') && c.includes('結束</span>之後')
  && a.endsWith('</span>') && b.endsWith('</span>'), [a, b, c].join(' ｜ '));
ok('跨行標題：收掉之後不再是標題',
  !r.line('普通文字', 11).includes('<span class="h"'), r.line('普通文字', 11));

const esc = r.line('a < b & c', 12);
ok('文字有轉義', esc === 'a &lt; b &amp; c', esc);

// 很深的樹（yinshun 可以有十幾層）：每層 +2px，但 CSS 上限 200%（min() 交給瀏覽器）
const deep = new Accelon3Renderer({ depthOf: new Map([['書', 0], ['章', 1], ['文', 17]]), levels: 19 });
const deepH = deep.line('<章>經文</章>', 13);
ok('很深的樹：仍然是「+2px × 層數」但最多 180%',
  deepH.includes(`min(calc(1em + ${17 * LEVEL_STEP_PX}px), ${LEVEL_MAX_SCALE}em)`) && deepH.includes('data-up="17"'), deepH);

// 沒有樹的庫（fgdict）：全部當普通文字
const flat = new Accelon3Renderer({ depthOf: new Map(), levels: 0 });
ok('沒有樹：標題標籤也只丟標籤', flat.line('<書>書名</書>', 1) === '書名', flat.line('<書>書名</書>', 1));

// ---------------------------------------------------------------- 原書分行
// 預設（hardBreaks）：<頁> 是右靠分隔；關掉：<頁> 變成行內頁碼，硬換行全部不保留
const hard = new Accelon3Renderer(ctx);
ok('原書分行（預設）：<頁> 是 .pageBreak 分隔',
  hard.line('周易<頁 n="12"/>乾', 1).includes('class="pageBreak"'), hard.line('周易<頁 n="12"/>乾', 2));

const soft = new Accelon3Renderer(ctx, { hardBreaks: false });
const softPage = soft.line('周易<頁 n="12"/>乾', 1);
ok('原書分行關閉：<頁> 是行內頁碼，不是分隔線',
  softPage.includes('class="pageMark"') && softPage.includes('〔12〕') && !softPage.includes('pageBreak'), softPage);

const blocksHard = renderPageBlocks(['<章>標題', '第一行', '第二行'], [1, 2, 3], { hardBreaks: true }, ctx);
ok('原書分行（預設）：每一行都是自己的版面塊',
  blocksHard.length === 3 && blocksHard.every((b) => b.kind === 'line'), JSON.stringify(blocksHard.map((b) => b.kind)));

const blocksSoft = renderPageBlocks(['<章>標題', '第一行', '第二行', '', '第三行'], [1, 2, 3, 4, 5], { hardBreaks: false }, ctx);
ok('不保留硬換行：內文連成一段、標題獨立、空行分段',
  blocksSoft.length === 3
  && blocksSoft[0].kind === 'heading' && blocksSoft[0].lines.length === 1
  && blocksSoft[1].kind === 'para' && blocksSoft[1].lines.length === 2
  && blocksSoft[2].kind === 'para' && blocksSoft[2].lines.length === 1,
  JSON.stringify(blocksSoft.map((b) => b.kind + ':' + b.lines.length)));

// 渲染前塗紅（作者 2026-10：不保留硬換行時關鍵字可能跨行，事後在 DOM 找字容易錯）
const marked = new Accelon3Renderer(ctx, { hardBreaks: false, marks: [{ text: '第一行', hue: 0 }, { text: '第二行', hue: 120 }] });
const markedHtml = marked.line('第一行第二行', 1);
ok('渲染前就把關鍵字包成 <mark class="kw">',
  markedHtml.includes('<mark class="kw" style="--hue:0">第一行</mark>')
  && markedHtml.includes('<mark class="kw" style="--hue:120">第二行</mark>'), markedHtml);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
