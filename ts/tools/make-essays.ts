/**
 * 產生官網「文章」頁（www/essays/）。
 *
 * 源稿在 docs/essays/（canonical，只讀）：本工具只做排版，不改字、不刪段、
 * 不加導讀。篇名、段落、小標題、數字都照源稿原樣輸出。
 *
 *   cd ts && bun run tools/make-essays.ts
 *
 * 產出：
 *   www/essays/index.html                        系列索引
 *   www/essays/the-day-the-earth-moved.html      主文
 *   www/essays/appendix-1-for-technical-readers.html
 *   www/essays/appendix-2-for-textual-scholars.html
 *   www/essays/essays.css                        共用版面
 *
 * 繁簡：用 agent-norms 的無損簡體表（SAFE_PAIRS），只抽本篇用到的字；
 * 主站 shutonggui.cn 預設簡體、鏡像 nissaya.cn 預設繁體（writing-skill §13）。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../..');
const SRC = resolve(ROOT, 'docs/essays');
const OUT = resolve(ROOT, 'www/essays');
const DATA = 'D:\\2026\\agent-norms\\lossless-simplified\\simplified-data.ts';

const SERIES = '從內觀研究所啟程的巴利佛典學習之旅';
const DATE = '2026-11-03';

type Kind = 'main' | 'appendix';
const ESSAYS: { md: string; slug: string; kind: Kind }[] = [
  { md: '土開始動的那天.md', slug: 'the-day-the-earth-moved.html', kind: 'main' },
  { md: '附文一-寫給有技術背景的人.md', slug: 'appendix-1-for-technical-readers.html', kind: 'appendix' },
  { md: '附文二-寫給有文獻背景的人.md', slug: 'appendix-2-for-textual-scholars.html', kind: 'appendix' },
];

// ---- 無損簡體表 -----------------------------------------------------------------
const safeLit = readFileSync(DATA, 'utf8').match(/export const SAFE_PAIRS\s*=\s*((?:"[^"]*"\s*\+?\s*)+)/);
if (!safeLit) throw new Error('找不到 SAFE_PAIRS');
const SAFE = [...safeLit[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]).join('');
if (SAFE.length % 2) throw new Error('SAFE_PAIRS 不是兩字一組');
/**
 * 「著→着」逐篇人工看過（writing-skill §13.3）：本篇的「著」若都是時態助詞
 * （看著、醒著、盯著、帶著），就照轉；出現「著作／著名／著者／著述／著錄／土著」
 * 這種名詞用法時整頁不轉，寧可留繁體也不要把「著作」變成「着作」。
 */
const ZHU_NOUN = /著(?:作|名|者|述|錄)|土著/;

/**
 * 表裡少數配對的簡體字不是通用字形，逐篇看過後改用通用字：
 * 線→缐（Unihan 給的異體，通用簡體是「线」）。
 * 其餘配對都用原表，不自造規則。
 */
const FIX: Record<string, string> = { 線: '线' };

function simTable(text: string): { table: string; pairs: [string, string][] } {
  const chars = new Set(text);
  const zhuOk = text.includes('著') && !ZHU_NOUN.test(text);
  const pairs: [string, string][] = [];
  for (let i = 0; i < SAFE.length; i += 2) {
    const t = SAFE[i], s = FIX[t] ?? SAFE[i + 1];
    if (!chars.has(t)) continue;
    if (t === '著' && !zhuOk) continue;
    pairs.push([t, s]);
  }
  return { table: pairs.map(([t, s]) => t + s).join(''), pairs };
}

// ---- Markdown → 區塊 -------------------------------------------------------------
type Block = { type: 'p' | 'h2'; text: string } | { type: 'ul'; items: string[] };

function inline(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '$1')   // 源稿的粗體只當標記，正文樸素
    // 「——」不能斷在行首（CSS 的 line-break:strict 不管破折號）：
    // 把前一個字和破折號包成不換行的一段，字一個都沒動。
    .replace(/(.)——/g, '<span class="nb">$1——</span>');
}

function parse(md: string) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  let title = '';
  let seriesLine = '';
  const blocks: Block[] = [];
  let i = 0;
  for (; i < lines.length; i++) {
    if (lines[i].startsWith('# ')) { title = lines[i].slice(2).trim(); i++; break; }
  }
  // 主文的系列副標（源稿用 blockquote 標示；不畫引言框，只當副標）
  for (; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l) continue;
    if (l.startsWith('> ')) { seriesLine = l.slice(2).trim(); continue; }
    break;
  }
  const body = lines.slice(i).join('\n');
  for (const raw of body.split(/\n\s*\n/)) {
    const b = raw.trim();
    if (!b) continue;
    if (b.startsWith('## ')) { blocks.push({ type: 'h2', text: b.slice(3).trim() }); continue; }
    const ls = b.split('\n').map((s) => s.trim()).filter(Boolean);
    if (ls.every((s) => s.startsWith('- '))) {
      blocks.push({ type: 'ul', items: ls.map((s) => s.slice(2).trim()) });
      continue;
    }
    blocks.push({ type: 'p', text: ls.join('') });
  }
  return { title, seriesLine, blocks };
}

// ---- 版面 -----------------------------------------------------------------------
const CSS = `/* 由 ts/tools/make-essays.ts 產生；改版面請改那裡。 */
:root{
  --paper:#F6EFDA; --ink:#2C2822; --soft:#6E6457; --faint:#9A8E7C;
  --vermi:#A6332B; --line:rgba(60,50,35,.26);
  --serif:'Noto Serif TC','Noto Serif SC','Songti TC','Songti SC','SimSun',serif;
  --sans:'Noto Sans TC','Noto Sans SC','Microsoft JhengHei','PingFang TC',sans-serif;
}
*{margin:0;padding:0;box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  background:var(--paper); color:var(--ink); font-family:var(--serif);
  font-size:17.5px; line-height:2; letter-spacing:.01em;
  -webkit-font-smoothing:antialiased; overflow-x:hidden;
}
::selection{background:var(--vermi);color:var(--paper)}
a{color:var(--vermi);text-decoration:none;border-bottom:1px dotted rgba(166,51,43,.5)}
a:hover{color:#8A2820;border-color:#8A2820}
a:focus-visible{outline:2px solid var(--vermi);outline-offset:2px}

/* 行長 ≤ 34 字（中文閱讀）；頁面區塊與正文同寬 */
.wrap{width:min(33em,90vw);margin:0 auto}

/* 頂欄：回索引 ＋ 繁簡切換 */
.topbar{
  position:sticky; top:0; z-index:60; padding:9px 0;
  background:rgba(246,239,218,.95); backdrop-filter:blur(6px);
  border-bottom:1px solid var(--line);
}
.tb-inner{
  display:flex; align-items:center; justify-content:space-between; gap:12px;
  width:min(33em,90vw); margin:0 auto;
  font-family:var(--sans); font-size:.82rem; letter-spacing:.02em;
}
.topbar a.back{color:var(--soft);border-bottom:1px dotted rgba(60,50,35,.35)}
.topbar a.back:hover{color:var(--vermi);border-color:var(--vermi)}
#simToggle{
  display:inline-flex;align-items:center;justify-content:center;
  min-width:58px;height:30px;padding:0 13px;border:1px solid rgba(166,51,43,.5);
  border-radius:999px;color:var(--vermi);background:#FFFDF5;
  font-family:var(--sans);font-size:.78rem;letter-spacing:1.5px;
}
#simToggle:hover{background:var(--vermi);color:var(--paper);border-color:var(--vermi)}

header{padding:48px 0 24px;border-bottom:2px solid var(--ink)}
.kicker{font-family:var(--sans);font-size:.72rem;letter-spacing:.16em;color:var(--vermi);margin-bottom:14px}
h1{font-size:clamp(1.55rem,4.6vw,2.1rem);line-height:1.5;letter-spacing:1.5px;font-weight:700;text-wrap:balance}
.sub{font-family:var(--sans);color:var(--soft);font-size:.94rem;letter-spacing:1.5px;margin-top:12px}
.byline{font-family:var(--sans);color:var(--faint);font-size:.78rem;letter-spacing:1px;margin-top:14px}

article{padding:32px 0 8px}
/* 標點不落行首：line-break:strict 讓 ，。、；：」』 等不開頭、 「『（ 等不結尾 */
p{
  margin-bottom:1.05em; text-indent:2em; text-align:justify;
  text-justify:inter-ideograph; line-break:strict; word-break:normal; overflow-wrap:break-word;
}
h2{
  font-size:1.08rem; line-height:1.6; letter-spacing:.08em; font-weight:700;
  margin:2.3em 0 .9em; line-break:strict;
}
ul{margin:0 0 1.15em; padding-left:1.55em; list-style:none}
li{position:relative; line-break:strict}
li::before{content:"・"; position:absolute; left:-1.1em; color:var(--faint)}
.nb{white-space:nowrap}

footer{margin-top:40px;padding:24px 0 56px;border-top:1px solid var(--line);
  font-family:var(--sans);font-size:.8rem;color:var(--soft);line-height:2;letter-spacing:.02em}
.foot-links{display:flex;flex-wrap:wrap;gap:6px 18px;margin-bottom:10px}
.foot-series{color:var(--faint)}

/* 系列索引 */
.list{list-style:none;margin:0;padding:0}
.list li{padding:20px 0 18px;border-bottom:1px solid var(--line)}
.list li:last-child{border-bottom:0}
.list li::before{content:none}
.list .t{display:block;font-size:1.16rem;line-height:1.65;color:var(--ink);border-bottom:0;letter-spacing:.02em}
.list .t:hover{color:var(--vermi)}
.list .t:focus-visible{outline:2px solid var(--vermi);outline-offset:3px}
.list .m{display:block;margin-top:6px;font-family:var(--sans);font-size:.76rem;color:var(--faint);letter-spacing:.06em}

@media (max-width:560px){
  body{font-size:17px;line-height:1.95}
  .wrap,.tb-inner{width:92vw}
  header{padding:36px 0 20px}
  h1{letter-spacing:1px}
  .sub{font-size:.9rem}
  .tb-inner{font-size:.76rem}
  #simToggle{height:28px;min-width:52px;font-size:.74rem}
  .list .t{font-size:1.1rem}
}
`;

const SCRIPT = (table: string) => `<script>
(function () {
  var P = "${table}", M = {};
  for (var i = 0; i < P.length; i += 2) M[P.charAt(i)] = P.charAt(i + 1);
  var SKIP_TAG = /^(SCRIPT|STYLE|CODE|PRE)$/;
  var SKIP_CLASS = /(^|\\s)(mono|ex-code|urlbox|no-sim)(\\s|$)/;
  var nodes = [], orig = [];
  try {
    var w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false), n;
    while ((n = w.nextNode())) {
      var p = n.parentNode; if (!p) continue;
      if (SKIP_TAG.test(p.nodeName)) continue;
      var cn = p.className;
      if (typeof cn === "string" && SKIP_CLASS.test(cn)) continue;
      var v = n.nodeValue;
      if (!v || !v.replace(/\\s/g, "")) continue;
      nodes.push(n); orig.push(v);
    }
  } catch (e) { /* 沒有 TreeWalker 就原樣顯示 */ }

  var titleOrig = document.title;
  function conv(s) {
    var o = "";
    for (var i = 0; i < s.length; i++) { var c = s.charAt(i); o += M[c] || c; }
    return o;
  }
  function apply(sim) {
    for (var i = 0; i < nodes.length; i++) nodes[i].nodeValue = sim ? conv(orig[i]) : orig[i];
    document.title = sim ? conv(titleOrig) : titleOrig;
    document.documentElement.lang = sim ? "zh-Hans" : "zh-Hant";
    var b = document.getElementById("simToggle");
    if (b) b.textContent = sim ? "繁體" : "简体";
  }

  var host = location.hostname.toLowerCase();
  var q = new URLSearchParams(location.search);
  var saved = null;
  try { saved = localStorage.getItem("rut.sim"); } catch (e) {}
  var sim = saved
    ? saved === "s"
    : (q.get("sim") === "1" ? true
      : q.get("sim") === "0" ? false
      : (host === "shutonggui.cn" || host === "www.shutonggui.cn"));

  try { apply(sim); } catch (e) {}
  document.body.style.visibility = "visible";

  var btn = document.getElementById("simToggle");
  if (btn) btn.addEventListener("click", function (e) {
    e.preventDefault();
    sim = !sim; apply(sim);
    try { localStorage.setItem("rut.sim", sim ? "s" : "t"); } catch (e2) {}
  });
}());
</script>`;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function page(o: {
  title: string; desc: string; body: string; navBack: string; navLabel: string; footer: string; text: string;
}): string {
  const { table } = simTable(o.text);
  return `<!DOCTYPE html>
<!-- 由 docs/essays/ 同步產生（ts/tools/make-essays.ts 執行）；請改源稿再重建，勿直接編輯本檔。 -->
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.title)}</title>
<meta name="description" content="${esc(o.desc)}">
<link rel="stylesheet" href="essays.css">
</head>
<body style="visibility:hidden">

<div class="topbar">
  <div class="tb-inner">
    <a class="back" href="${o.navBack}">${o.navLabel}</a>
    <a href="#" id="simToggle" aria-label="切換繁體／簡體">简体</a>
  </div>
</div>

${o.body}

<footer>
  <div class="wrap">
    <div class="foot-links">
${o.footer}
    </div>
    <div class="foot-series">《${esc(SERIES)}》 · ${DATE}</div>
  </div>
</footer>

<noscript><style>body{visibility:visible!important}</style></noscript>
${SCRIPT(table)}
</body>
</html>
`;
}

function renderEssay(e: (typeof ESSAYS)[number]) {
  const src = parse(readFileSync(resolve(SRC, e.md), 'utf8'));
  const parts: string[] = [];
  for (const b of src.blocks) {
    if (b.type === 'h2') parts.push(`    <h2>${inline(b.text)}</h2>`);
    else if (b.type === 'ul') parts.push(`    <ul>\n${b.items.map((t) => `      <li>${inline(t)}</li>`).join('\n')}\n    </ul>`);
    else parts.push(`    <p>${inline(b.text)}</p>`);
  }
  const titleOf = (x: (typeof ESSAYS)[number]) => parse(readFileSync(resolve(SRC, x.md), 'utf8')).title;
  const footLinks = [
    '      <a href="index.html">← 文章索引</a>',
    e.kind === 'main'
      ? ESSAYS.filter((x) => x.kind === 'appendix').map((x) => `      <a href="${x.slug}">${esc(titleOf(x))}</a>`).join('\n')
      : `      <a href="${ESSAYS[0].slug}">主文：${esc(titleOf(ESSAYS[0]))}</a>`,
    '      <a href="../index.html">accelon26 官網</a>',
  ].join('\n');

  const header = [
    '  <div class="wrap">',
    e.kind === 'appendix' ? `    <p class="kicker">《${esc(SERIES)}》</p>` : '',
    `    <h1>${inline(src.title)}</h1>`,
    src.seriesLine ? `    <p class="sub">${inline(src.seriesLine)}</p>` : '',
    `    <p class="byline">${DATE}</p>`,
    '  </div>',
  ].filter(Boolean).join('\n');

  const bodyText = [src.title, src.seriesLine, ...src.blocks.flatMap((b) => (b.type === 'ul' ? b.items : [b.text])), SERIES, DATE, '简体'].join('\n');
  return page({
    title: `${src.title} · ${SERIES}`,
    desc: `《${SERIES}》· ${src.title} · ${DATE}`,
    body: `<header>\n${header}\n</header>\n\n<article class="wrap">\n${parts.join('\n\n')}\n</article>`,
    navBack: 'index.html',
    navLabel: '← 文章',
    footer: footLinks,
    text: bodyText,
  });
}

function renderIndex() {
  const items = ESSAYS.map((e) => {
    const src = parse(readFileSync(resolve(SRC, e.md), 'utf8'));
    const meta = [e.kind === 'main' ? '主文' : '', DATE].filter(Boolean).join(' · ');
    return `      <li>\n        <a class="t" href="${e.slug}">${inline(src.title)}</a>\n        <span class="m">${meta}</span>\n      </li>`;
  }).join('\n');
  const header = `  <div class="wrap">
    <p class="kicker">文章</p>
    <h1>《${esc(SERIES)}》</h1>
    <p class="byline">${DATE}</p>
  </div>`;
  const bodyText = [SERIES, DATE, ...ESSAYS.map((e) => parse(readFileSync(resolve(SRC, e.md), 'utf8')).title), '简体'].join('\n');
  return page({
    title: `文章 · 《${SERIES}》`,
    desc: `《${SERIES}》文章索引：主文與兩篇附文。`,
    body: `<header>\n${header}\n</header>\n\n<article class="wrap">\n    <ul class="list">\n${items}\n    </ul>\n  </article>`,
    navBack: '../index.html',
    navLabel: '← accelon26 官網',
    footer: '      <a href="../index.html">accelon26 官網</a>',
    text: bodyText,
  });
}

// ---- 寫檔 -----------------------------------------------------------------------
mkdirSync(OUT, { recursive: true });
writeFileSync(resolve(OUT, 'essays.css'), CSS);
for (const e of ESSAYS) {
  const html = renderEssay(e);
  writeFileSync(resolve(OUT, e.slug), html);
  console.log(`wrote www/essays/${e.slug}  ${html.length} chars`);
}
const idx = renderIndex();
writeFileSync(resolve(OUT, 'index.html'), idx);
console.log(`wrote www/essays/index.html  ${idx.length} chars`);
console.log('wrote www/essays/essays.css');
