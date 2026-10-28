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
ok('computeTierContext：色號依標籤第一次出現的順序（章≠節）',
  ctx.tagChroma?.get('書') === 0 && ctx.tagChroma?.get('章') === 1 && ctx.tagChroma?.get('節') === 2,
  JSON.stringify([...(ctx.tagChroma ?? new Map())]));

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

// 2026-10：`<聯 i="…">` 已經是跨庫錨點，不再算「未知標籤」；用真的未知標籤測。
const unknown = r.line('<未知 i="taisho">參考</未知>正文', 6);
ok('沒有 t= 的標籤：標籤丟掉、文字留著', unknown === '參考正文', unknown);

const hidden = r.line('<隱><樹 s="*" t="書">目錄</樹></隱>正文', 7);
ok('樹／隱：連內容一起隱藏', hidden === '正文', hidden);

const jl = r.line('<聯 i="taisho?8p848c" q="色即是空" j="52-60">色即是空</聯>', 7);
ok('聯 j：字級範圍帶到 data-j，舊的 data-xref 不變',
  jl.includes('data-xref="taisho?8p848c"') && jl.includes('data-j="52-60"'), jl);

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

// 作者 2026-10-25：Obsidian 筆記會有 `<br>`、`A & B`。adb 裡存成 XML 實體，
// 畫面要還原成原字，而且解出來的 `<` 不能再被當成標籤。
const ent = r.line('&lt;br&gt; &amp; more', 13);
ok('XML 實體：&lt; 顯示為 <，不會變成標籤', ent === '&lt;br&gt; &amp; more', ent);
const entOnce = r.line('&amp;lt;', 14);
ok('XML 實體只解一層：&amp;lt; 是文字 &lt;', entOnce === '&amp;lt;', entOnce);
const entAttr = r.line('<聯 n="A&amp;B">A &amp; B</聯>', 15);
ok('連結的屬性與文字都解實體',
  entAttr.startsWith('<a class="entryLink" href="#" data-entry="A&amp;B" title="A&amp;B">')
  && entAttr.endsWith('>A &amp; B</a>'), entAttr);

// 作者 2026-10-26：<註 n> ↔ <釋 n> 腳注（manual／thonzu 兩種寫法）
const noteRef = r.line('本軟體為綠色軟體<註 n="1"/>，可以直接執行', 16);
ok('註：變成 noteRef 錨點（data-note、上標 [1]）',
  noteRef.includes('<a class="noteRef" data-note="1" href="#" title="註 1">[1]</a>')
  && noteRef.startsWith('本軟體為綠色軟體') && noteRef.endsWith('，可以直接執行'), noteRef);
const noteOne = r.line('<釋 n="1">綠色軟體：免安裝。</釋>', 17);
ok('釋（包住型）：長出 noteBody 與回跳編號，文字留在裡面',
  noteOne.includes('<span class="noteBody" data-note="1">')
  && noteOne.includes('<a class="noteBack" data-note="1" href="#" title="回到註 1">[1]</a>')
  && noteOne.includes('綠色軟體：免安裝。') && noteOne.endsWith('</span>'), noteOne);
const noteOpen = r.line('<釋 n="2">第一行', 18);
const noteMid = r.line('第二行', 19);
const noteClose = r.line('第三行</釋>之後', 20);
ok('釋（跨行）：每行重新開、收掉後不再是注文',
  noteOpen.includes('data-note="2"') && noteMid.includes('data-note="2"')
  && noteClose.includes('</span>之後')
  && !r.line('後面的正文', 21).includes('noteBody'), [noteOpen, noteMid, noteClose].join(' ｜ '));
const noteSelf = r.line('<釋 n="3"/>　宿慧──早先熟悉的技能。', 22);
ok('釋（自閉合）：注文在標籤後面，整行都包在 noteBody 裡',
  noteSelf.startsWith('<span class="noteBody" data-note="3"><a class="noteBack" data-note="3"')
  && noteSelf.includes('宿慧──早先熟悉的技能。') && noteSelf.endsWith('</span>'), noteSelf);
const notePlain = r.line('<釋>意思是，不干則已。</釋>', 23);
ok('沒有 n 的釋（hcy）：不是腳注，只丟標籤', notePlain === '意思是，不干則已。', notePlain);

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
const tierCtx = { depthOf: new Map([['書', 0], ['章', 1], ['節', 2]]), levels: 3 };
const tierPage = renderPageBlocks(
  ['<書>乙一 如來開示', '<章>丙一 依正行願', '<節>丁一 總標依正', '佛告曼殊室利', '<節>丁二 別陳行願', '正文二'],
  [1, 2, 3, 4, 5, 6], { hardBreaks: true }, tierCtx);
const tierHtml = tierPage.map((b) => b.lines.map((l) => l.html).join('')).join('\n');
ok('標題字級：正文上一層只 +2px、每往上一層再 +2px（不依資料庫深度）',
  tierHtml.includes(`data-depth="2" style="font-size:min(calc(1em + ${1 * LEVEL_STEP_PX}px)`)
  && tierHtml.includes(`data-depth="1" style="font-size:min(calc(1em + ${2 * LEVEL_STEP_PX}px)`)
  && tierHtml.includes(`data-depth="0" style="font-size:min(calc(1em + ${3 * LEVEL_STEP_PX}px)`),
  tierHtml.split('\n').map((h) => h.slice(0, 110)).join(' ｜ '));

// 作者 2026-10-18：同一個庫裡「章」和「節」可能位在同一層（depth 一樣），
// 顏色要跟著標籤走，兩者才會分得開。
const sameDepth = new Accelon3Renderer({
  depthOf: new Map([['章', 1], ['節', 1]]), levels: 2,
  tagChroma: new Map([['章', 0], ['節', 1]]),
});
const zhang = sameDepth.line('<章>甲</章>', 1);
const jie = sameDepth.line('<節>乙</節>', 2);
ok('章與節同一層、不同標籤 → 不同顏色',
  zhang.includes('--tag-text-0') && jie.includes('--tag-text-1'), zhang + ' ｜ ' + jie);

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
