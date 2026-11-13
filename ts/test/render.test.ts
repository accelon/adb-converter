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
ok('段：行首只加縮排 span（不插 <br>，避免多空一行）',
  para.startsWith('<span class="paraIndent">　　</span>何故禮拜')
  && !para.startsWith('<br'), para);

const paraMid = r.line('何故<段/>禮拜', 6);
ok('段：行中才插 <br class="para"> ＋ 縮排',
  paraMid === '何故<br class="para"><span class="paraIndent">　　</span>禮拜', paraMid);

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

// 圖版後面接頁碼：頁碼只接到圖那一行，後面的文字不能擠進同一行（作者 2026-11-01）
const figBlockSvg = '<svg width="10" height="10" viewBox="0 0 10 10"><g><rect width="5" height="5"/></g></svg>';
const figBlocks = renderPageBlocks(
  ['<圖 n="a.svg" t="圖版"/>', '', '<頁 id="12"/>', '', '後面的文字'],
  [1, 2, 3, 4, 5],
  { hardBreaks: true, svgText: () => figBlockSvg },
  ctx,
);
const figHtml = figBlocks.map((b) => b.lines.map((l) => l.html).join('')).join('\n');
const figBlock = figBlocks.find((b) => b.lines.some((l) => l.html.includes('figureSvg')));
ok('圖版後面的頁碼／文字不擠進圖那一行',
  !!figBlock
  && !figBlock.lines.some((l) => l.html.includes('後面的文字'))
  && figBlocks.some((b) => b !== figBlock && b.lines.some((l) => l.html.includes('後面的文字'))),
  figHtml.slice(0, 200));

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

// 詞典型：連排模式下 `<字>`／`<詞>` 是條目標題，要另起一段（hanyudazidian 2026-11-06）
const dictLines = ['<段/>上一條釋文', '<字>乙</字>', '<形>乙的釋文。</形>', '', '<字>丙</字>'];
const dictBlocks = renderPageBlocks(dictLines, [1, 2, 3, 4, 5], { hardBreaks: false, dictEntries: true }, ctx);
ok('詞典型：<字> 在連排模式另起 heading 塊',
  dictBlocks.some((b) => b.kind === 'heading' && b.lines.some((l) => l.raw.includes('<字>乙'))),
  JSON.stringify(dictBlocks.map((b) => b.kind + ':' + b.lines.map((l) => l.raw).join('|'))));
const plainDict = renderPageBlocks(dictLines, [1, 2, 3, 4, 5], { hardBreaks: false }, ctx);
ok('沒有 dictEntries：<字> 不當標題（cs 的 <詞> 不受影響）',
  plainDict.every((b) => b.kind !== 'heading'),
  JSON.stringify(plainDict.map((b) => b.kind)));

// 渲染前塗紅（作者 2026-10：不保留硬換行時關鍵字可能跨行，事後在 DOM 找字容易錯）
const marked = new Accelon3Renderer(ctx, { hardBreaks: false, marks: [{ text: '第一行', hue: 0 }, { text: '第二行', hue: 120 }] });
const markedHtml = marked.line('第一行第二行', 1);
ok('渲染前就把關鍵字包成 <mark class="kw">',
  markedHtml.includes('<mark class="kw" style="--hue:0">第一行</mark>')
  && markedHtml.includes('<mark class="kw" style="--hue:120">第二行</mark>'), markedHtml);

// <术 sk|pi|tb="…">：hover（預設）／inline／off（作者 2026-10-31）
const termHover = new Accelon3Renderer(ctx).line('<术 sk="svabhāva">自性</术>是術語', 1);
ok('術語 hover：漢詞有 term-sk、外語在 title、行內不顯示',
  termHover.includes('class="term term-sk has-tip"')
  && termHover.includes('data-lang="sk"')
  && termHover.includes('data-term="svabhāva"')
  && termHover.includes('title="梵：svabhāva"')
  && termHover.includes('>自性</span>')
  && !termHover.includes('termGloss'), termHover);

const termInline = new Accelon3Renderer(ctx, { termMode: 'inline' }).line('<术 pi="kamma">業</术>', 1);
ok('術語 inline：漢詞之後出現「（外語）」、不再掛 title',
  termInline.includes('class="term term-pi"')
  && !termInline.includes('title=')
  && termInline.includes('>業</span>')
  && termInline.includes('<span class="termGloss">（kamma）</span>'), termInline);

const termOff = new Accelon3Renderer(ctx, { termMode: 'off' }).line('<术 tb="…">法</术>', 1);
ok('術語 off：只留漢詞（仍有虛線外框）、沒有 title／外語',
  termOff.includes('class="term term-tb"')
  && !termOff.includes('title=')
  && !termOff.includes('termGloss')
  && termOff.includes('>法</span>'), termOff);

const termEmpty = new Accelon3Renderer(ctx).line('<术 sk="">自性</术>', 1);
ok('術語空值：只顯示漢詞、不爆錯', termEmpty === '自性', termEmpty);

const termQuote = new Accelon3Renderer(ctx).line('<术 sk="a&quot;b">自性</术>', 1);
ok('術語值含 &quot;：解碼後再轉義',
  termQuote.includes('data-term="a&quot;b"') && termQuote.includes('title="梵：a&quot;b"'), termQuote);

const termUnknown = new Accelon3Renderer(ctx).line('<术 en="term">自性</术>', 1);
ok('未知語言鍵：用 term-other，不爆錯',
  termUnknown.includes('term term-other') && termUnknown.includes('data-lang="en"'), termUnknown);

const termMulti = new Accelon3Renderer(ctx).line('<术 sk="a">甲</术>與<术 pi="b">乙</术>', 1);
ok('同一行多個術語：各自標記（term-sk／term-pi）',
  termMulti.includes('term-sk') && termMulti.includes('term-pi')
  && termMulti.includes('>甲</span>') && termMulti.includes('>乙</span>'), termMulti);

// 跨行：第一行開、第二行收（HTML 要平衡）
const cross = new Accelon3Renderer(ctx, { termMode: 'inline' });
const cross1 = cross.line('<术 sk="x">自', 1);
const cross2 = cross.line('性</术>。', 2);
ok('術語跨行：兩行都各自開／收，第二行結尾補上外語',
  cross1.includes('class="term term-sk"') && cross1.trimEnd().endsWith('</span>')
  && cross2.includes('class="term term-sk"') && cross2.includes('>性</span>')
  && cross2.includes('（x）'), JSON.stringify({ cross1, cross2 }));

// 圖版 inline SVG：兩張圖的 clipPath id 不能共用（fuyan y37.0347 被第一張切掉，2026-10-31）
const figSvg = '<svg width="20" height="10" viewBox="0 0 20 10">'
  + '<defs><clipPath id="clip_1"><rect width="20" height="10"/></clipPath></defs>'
  + '<g clip-path="url(#clip_1)"><rect width="10" height="5"/></g></svg>';
const figR = new Accelon3Renderer(ctx, { svgText: () => figSvg });
const fig1 = figR.line('<圖 n="a.svg" t="圖版"/>', 1);
const fig2 = figR.line('<圖 n="b.svg" t="圖版"/>', 2);
const id1 = /id="(svg\d+-clip_1)"/.exec(fig1)?.[1] ?? '';
const id2 = /id="(svg\d+-clip_1)"/.exec(fig2)?.[1] ?? '';
ok('inline SVG 的 id 每張圖各自加前綴（clipPath 不會互相蓋掉）',
  !!id1 && !!id2 && id1 !== id2
  && fig1.includes(`url(#${id1})`) && fig2.includes(`url(#${id2})`)
  && !fig1.includes('id="clip_1"') && !fig2.includes('id="clip_1"'),
  JSON.stringify({ id1, id2 }));

// 舊資料的點陣圖版：tx 的 `<圖 f="images/…png"/>` 沒有 t="圖版"（作者 2026-11-06）
const rasterR = new Accelon3Renderer(ctx, { imageUrl: (n) => 'blob:' + n, untaggedFigures: true });
const legacyFig = rasterR.line('<圖 f="images/11-0226.png"/>', 1);
ok('tx 相容：沒有 t= 的 <圖 f=…png> 當圖版（不被 1.5em 壓成字形圖）',
  legacyFig.includes('class="inlineImg figureImg"') && legacyFig.includes('alt="images/11-0226.png"'), legacyFig);

const inlineRaster = rasterR.line('<圖 n="glyph.png"/>', 2);
ok('n= 的點陣圖沒有 t=：維持 inlineImg（句中的小圖）',
  inlineRaster.includes('class="inlineImg"') && !inlineRaster.includes('figureImg'), inlineRaster);

const glyphSvg = new Accelon3Renderer(ctx, { svgText: () => figSvg }).line('<圖 n="a.svg"/>', 3);
ok('沒有 t= 的 SVG 仍是字形圖（不變）',
  glyphSvg.includes('inlineSvg') && !glyphSvg.includes('figureSvg'), glyphSvg);

const yinshunR = new Accelon3Renderer(ctx, { imageUrl: (n) => 'blob:' + n });
const yinshunFig = yinshunR.line('<圖 f="images/y01-18.png"/>', 4);
ok('yinshun 的 f= 行內插圖（沒有開啟相容）：維持 inlineImg',
  yinshunFig.includes('class="inlineImg"') && !yinshunFig.includes('figureImg'), yinshunFig);

// `<節聯>`／`<嵌 sub|max>` 渲染（2026-11-13，ybh v4 需求）
const nl = new Accelon3Renderer(ctx).line('詳見<節聯 n="T1579-1#kpD03-001">問答標列</節聯>一段。', 9);
ok('節聯：長出 data-link="node" ＋ data-node ＋ nodeLink class',
  nl.includes('data-link="node"') && nl.includes('data-node="T1579-1#kpD03-001"') && nl.includes('nodeLink'), nl);
const nlx = new Accelon3Renderer(ctx).line('<節聯 i="other?PXJ-H-1#kpD02-001">它庫科判</節聯>', 9);
ok('節聯 i=：拆出 data-nodedb', nlx.includes('data-nodedb="other"') && nlx.includes('data-node="PXJ-H-1#kpD02-001"'), nlx);
const chipSub = new Accelon3Renderer(ctx).line('<嵌 i="ybh?T1579-1#kpD01-001" n="本地分" sub="1" max="6000"/>', 9);
ok('嵌 sub/max：data-sub 與 data-max 直達晶片',
  chipSub.includes('data-sub="1"') && chipSub.includes('data-max="6000"') && chipSub.includes('embedChip'), chipSub);
const chipBadMax = new Accelon3Renderer(ctx).line('<嵌 i="ybh?kpD01-001" max="abc"/>', 9);
ok('嵌 max 非數字：不輸出 data-max（舊行為穩健）', !chipBadMax.includes('data-max'), chipBadMax);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);