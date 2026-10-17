/**
 * 產生 `accelon26-map.html`：一份「DOM id 對照表」。
 *
 * 為什麼要自動產生：這份示意圖以前是手寫的，改過幾次之後**編碼壞掉**（UTF-8 被當成
 * GBK 讀寫，出現「鍒嗗崁」這種亂碼），可是它又不是程式的產物，只能整份重寫。
 * 現在由模板＋build 產物直接掃 id，永遠跟程式一致（`tools/check-map-ids.ts` 會比對）。
 *
 *   bun run tools/gen-map.ts
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const TEMPLATE = resolve(import.meta.dir, '../src/accelon26/accelon26.template.html');
const OUT = resolve(import.meta.dir, '../../accelon26-map.html');

/** 已知 id 的一句話說明（沒列到的就顯示它所在的區塊） */
const DESC: Record<string, string> = {
  brand: '左上角標題；桌面版 hover 顯示建置時間、有新版本時閃動',
  toggleLeft: '顯示／隱藏左欄',
  toggleRight: '顯示／隱藏右欄',
  dbPickBtn: '📁 adb 選單（file:// 的第一項是「加入 adb」）',
  dbPickMenu: 'adb 選單展開後的面板',
  file: '隱藏的 <input type=file>，只由「加入 adb」觸發',
  searchAllBtn: '🔍 搜尋所有 adb（沒有開庫時隱藏）',
  dbHint: '沒有資料庫時的閃爍提示',
  dbTabs: '每個已開啟的庫一個 chip（active 才有 ✕）',
  status: '狀態列：只顯示錯誤／忙碌',
  settingsBtn: '🔧 設置（最右邊）',
  query: '目錄分頁的查詢輸入',
  searchList: '摘要卡片清單',
  searchMeta: '摘要統計（幾筆命中、幾個詞組）',
  searchMore: '摘要「還有更多」提示',
  termsQuery: '名詞分頁的輸入',
  termsMode: '名詞比對位置三態 toggle（開頭／中間／結尾）',
  termsCount: '一般模式顯示的符合詞條數',
  termsMeta: '進階模式的完整統計',
  termsList: '名詞分頁的詞條清單',
  freqQuery: '全文．頻次的輸入',
  freqMeta: '頻次統計',
  freqList: '分段命中數清單',
  folioQuery: '原書分頁的輸入',
  folioMeta: '原書分頁統計',
  folioList: '頁碼清單',
  latinQuery: '西文分頁的輸入',
  latinMode: '西文比對位置',
  latinMeta: '西文統計',
  latinList: '西文 token 清單',
  dirTree: '目錄樹（分批掛上 DOM）',
  treeReveal: '把目錄樹展開到目前節點',
  docTabs: '本文分頁列',
  docText: '中間本文（一頁一頁載入）',
  docTrail: '本文上方的 breadcrumb（祖先＋同層）',
  docPager: '本文換頁',
  docLogo: '本文空白時顯示這個庫的 logo',
  docLogoImg: 'logo 圖',
  textTabs: '右欄「文字內容」的分頁',
  textBody: '右欄「文字內容」的內文',
  textPager: '右欄「文字內容」換頁',
  dictList: '右欄「詞典」上區：詞條清單',
  dictBody: '右欄「詞典」下區：詞條正文＋開頭/結尾',
  meta: 'META 分頁',
  containers: 'META：容器清單',
  capacity: '容量分頁',
  docs: '文件分頁',
  resources: '圖片分頁',
  tokenRows: 'token 統計',
  settingsBox: '設置彈窗',
  settingsBackdrop: '設置彈窗背景',
  allSearchBox: '「搜尋所有 adb」彈窗',
  allSearchBackdrop: '搜尋彈窗背景',
  allSearchTitle: '「搜尋 n 個數據庫」標題',
  allSearchClose: '關閉搜尋彈窗',
  allSearchQuery: '搜尋所有 adb 的輸入',
  allSearchGo: '開始搜尋（每查完一個庫就更新一次）',
  allSearchMsg: '進度／結果摘要',
  allSearchList: '各庫命中數清單（依命中數排序）',
  aboutBox: '關於彈窗',
  aboutBackdrop: '關於彈窗背景',
  aboutLogo: '關於彈窗的大 logo',
  splitLeft: '左欄分隔線',
  splitRight: '右欄分隔線',
};

interface Row { id: string; region: string; tab: string }

const html = readFileSync(TEMPLATE, 'utf8');
const rows: Row[] = [];
let region = '（其他）';
let tab = '';
const TAG = /<(\/?)(section|header|div|span|button|input|h1|h2|h3|h4|h5|select|a|table|tr|td|th|main|nav|body|label|li|ul|ol|p|em|b|i|small|strong|textarea|img|pre|code)\b[^>]*>/g;

let m: RegExpExecArray | null;
while ((m = TAG.exec(html))) {
  const [tagText, closing, name] = m;
  if (closing) continue;
  if (name === 'header') region = '頂欄';
  else if (/id="colLeft"/.test(tagText)) region = '左欄';
  else if (/id="colRight"/.test(tagText)) region = '右欄';
  else if (/id="colMid"|id="docPane"/.test(tagText)) region = '中欄';
  else if (/id="settingsBox"/.test(tagText)) region = '設置彈窗';
  else if (/id="allSearchBox"/.test(tagText)) region = '搜尋彈窗';
  else if (/id="aboutBox"/.test(tagText)) region = '關於彈窗';
  const dt = /data-tab="([^"]+)"/.exec(tagText);
  if (dt) tab = dt[1];
  if (/class="tabPane/.test(tagText) === false && /tabPane/.test(tagText)) tab = '';
  const id = /\sid="([A-Za-z][\w-]*)"/.exec(tagText);
  if (id) rows.push({ id: id[1], region, tab: /tabPane/.test(tagText) ? (dt?.[1] ?? tab) : tab });
}
// main 區的幾個容器
for (const id of ['splitLeft', 'splitRight']) {
  if (!rows.some((r) => r.id === id)) rows.push({ id, region: '中欄', tab: '' });
}

// 由程式（TS）動態插入的 id：掃 src 裡的 `id="…"`（模板掃不到的補進來）
{
  const SRC = resolve(import.meta.dir, '../src/accelon26');
  const seen = new Set(rows.map((r) => r.id));
  for (const name of readdirSync(SRC)) {
    if (!name.endsWith('.ts')) continue;
    const text = readFileSync(resolve(SRC, name), 'utf8');
    for (const m2 of text.matchAll(/id="([A-Za-z][\w-]*)"/g)) {
      const id = m2[1];
      if (seen.has(id)) continue;
      seen.add(id);
      rows.push({ id, region: '動態產生', tab: '' });
    }
  }
}

const byRegion = new Map<string, Row[]>();
for (const r of rows) {
  const list = byRegion.get(r.region) ?? [];
  list.push(r);
  byRegion.set(r.region, list);
}
const ORDER = ['頂欄', '左欄', '中欄', '右欄', '設置彈窗', '搜尋彈窗', '關於彈窗', '（其他）'];
const regions = [...byRegion.keys()].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));

const chip = (r: Row) =>
  `<span class="chip"><span class="rid">#${r.id}</span> ${DESC[r.id] ?? (r.tab ? `<span class="sel">[data-tab=${r.tab}]</span>` : r.region)}</span>`;

const body = regions.map((reg) => `
    <h2>${reg}</h2>
    <div class="chips">
      ${(byRegion.get(reg) ?? []).map(chip).join('\n      ')}
    </div>
    <table>
      <tr><th>id</th><th>所在分頁</th><th>說明</th></tr>
      ${(byRegion.get(reg) ?? []).map((r) => `<tr><td><code>#${r.id}</code></td><td>${r.tab ? `<code>${r.tab}</code>` : '—'}</td><td>${DESC[r.id] ?? '—'}</td></tr>`).join('\n      ')}
    </table>`).join('\n');

const page = `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>accelon26 分區示意圖（DOM id 對照）</title>
<style>
  :root { --line:#2c313c; --bg:#171a21; --panel:#1e222b; --ink:#e7e9ef; --dim:#98a0b3; --id:#ff7a90; }
  * { box-sizing:border-box; }
  body { margin:0; padding:22px 26px 60px; background:var(--bg); color:var(--ink);
         font:14px/1.6 system-ui,"Noto Sans TC","Microsoft JhengHei",sans-serif; }
  h1 { font-size:20px; margin:0 0 4px; }
  h2 { font-size:15px; margin:26px 0 8px; color:var(--id); border-bottom:1px solid var(--line); padding-bottom:4px; }
  .lead { color:var(--dim); margin:0 0 10px; }
  code, .rid { font-family:ui-monospace,Consolas,monospace; font-size:12.5px; }
  .rid { color:var(--id); }
  .sel { color:#22d3ee; font-family:ui-monospace,Consolas,monospace; font-size:12.5px; }
  .chips { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:10px; }
  .chip { border:1px solid var(--line); border-radius:6px; padding:3px 8px; background:var(--panel); color:var(--dim); }
  table { border-collapse:collapse; width:100%; }
  th, td { text-align:left; padding:3px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--dim); font-weight:600; }
  td code { color:var(--id); }
</style>
</head>
<body>
  <h1>accelon26 分區示意圖</h1>
  <p class="lead">所有分區的名稱一律以 <b>DOM id</b> 為準（紅字）；分頁面板另外標 <span class="sel">[data-tab=…]</span>。
  這份檔案由 <code>ts/tools/gen-map.ts</code> 從 <code>ts/src/accelon26/accelon26.template.html</code> 掃出來，
  <code>bun run tools/check-map-ids.ts</code> 會雙向比對它和 <code>build/accelon26.html</code>。</p>
  <p class="lead">對應產物：<code>build/accelon26.html</code>（file:// 版）與 <code>wails/assets/index.html</code>（桌面版，同一份）。</p>
${body}
</body>
</html>
`;

writeFileSync(OUT, page, 'utf8');
const named = new Set(rows.map((r) => r.id));
console.log(`wrote ${OUT}（${named.size} 個 id、${regions.length} 個區塊）`);
