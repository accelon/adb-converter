/**
 * 產生官網的「公開數據庫」頁面：www/adb/index.html（清單存檔 www/adb/index.txt）。
 *
 *   cd ts && bun run tools/make-adb-index.ts
 *   bun run tools/make-adb-index.ts --adb-dir D:\accelon3
 *   bun run tools/make-adb-index.ts --index https://shutonggui.cn/accelon26/adb/index.txt
 *
 * 作者維護的清單在伺服器 `/accelon26/adb/index.txt`（一行一個 .adb 檔名，`#` 是註解），
 * 同一個目錄就是公開的 .adb 本體。這支**只讀檔頭、不下載 adb**：本機工作文件夾
 * `accelon3/` 就有那些檔（作者 2026-10）。
 *
 * 每個資料庫取四樣：
 *   中文名     adb 檔頭 offset 128..192（utf-16le 的 dbcname；沒有就用 dbname）
 *   字數（約） adb 檔頭 offset 96 的 maxblockoffset（最大的文字位置）—— 不必解壓整本，
 *              跟精確字數差 1–7%（作者 2026-10：「不必計算精確的字數，大概就好，不然很慢」）
 *   建置日期   檔案時間（adb 檔頭沒有日期欄位）
 *   檔案大小   stat
 *
 * 頁面的 <style>／頁首／頁尾直接從 www/index.html 抓過來，所以官網改樣式時這頁會跟著改。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const opt = (n: string, d = '') => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };

const ROOT = resolve(import.meta.dir, '../..');
const SITE = resolve(ROOT, 'www');
const OUT = resolve(opt('out', resolve(SITE, 'adb')));
const LOCAL_INDEX = resolve(SITE, 'adb/index.txt');
const INDEX_URL = opt('index', existsSync(LOCAL_INDEX) ? LOCAL_INDEX : 'https://shutonggui.cn/accelon26/adb/index.txt');
const ADB_DIR = resolve(opt('adb-dir', resolve(ROOT, 'accelon3')));
const SITE_URL = 'https://shutonggui.cn/accelon26/';

// ---- 清單 ---------------------------------------------------------------------
const raw = /^https?:/.test(INDEX_URL)
  ? await (await fetch(INDEX_URL, { headers: { 'cache-control': 'no-cache' } })).text()
  : readFileSync(resolve(INDEX_URL), 'utf8');
// 一行一筆：`檔名.adb`，可選第二欄（TAB 分隔）是「說明頁」的檔名，例如 ys.html。
// 有說明頁的資料庫，清單上會多一個「改版說明」連結（作者 2026-10-28）。
const entries = raw.split(/\r?\n/)
  .map((s) => s.trim())
  .filter((s) => s && !s.startsWith('#'))
  .map((s) => {
    const [file, doc] = s.split(/\t+|\s{2,}/);
    return { file: file.trim(), doc: (doc ?? '').trim() };
  });
const names = entries.map((e) => e.file);
const docOf = new Map(entries.filter((e) => e.doc).map((e) => [e.file, e.doc]));

// ---- 本機的 .adb：同名取最淺層那一份（D:\accelon3\13j.adb 優先於 sub\13j.adb）----
const local = new Map<string, { path: string; depth: number }>();
const walk = (dir: string, depth: number) => {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { walk(p, depth + 1); continue; }
    if (!/\.adb$/i.test(e.name)) continue;
    const key = e.name.toLowerCase();
    const hit = local.get(key);
    if (!hit || depth < hit.depth) local.set(key, { path: p, depth });
  }
};
if (existsSync(ADB_DIR)) walk(ADB_DIR, 0);
console.log(`清單 ${names.length} 個；本機 ${ADB_DIR} 找到 ${local.size} 個 .adb`);

// ---- 讀一個 adb 的名稱與字數 ----------------------------------------------------
const asciiZ = (b: Uint8Array, from: number, to: number) => {
  let s = '';
  for (let i = from; i < to && b[i]; i++) s += String.fromCharCode(b[i]);
  return s.trim();
};
const utf16z = (b: Uint8Array, from: number, to: number) => {
  let s = '';
  for (let i = from; i + 1 < to; i += 2) {
    const cu = b[i] | (b[i + 1] << 8);
    if (!cu) break;
    s += String.fromCharCode(cu);
  }
  return s.trim();
};

async function inspect(path: string, fileName: string) {
  const st = statSync(path);
  const hdr = new Uint8Array(await Bun.file(path).slice(0, 256).arrayBuffer());
  const dbname = asciiZ(hdr, 0, 32);
  const dbcname = utf16z(hdr, 128, 192);
  // 字數（約）：檔頭 offset 96 的 maxblockoffset＝最大的文字位置。
  // 精確字數要把每個 source 區塊解壓再數，五本要四秒多；這裡只讀 4 個位元組。
  const chars = hdr.length >= 100 ? new DataView(hdr.buffer, 96, 4).getInt32(0, true) : 0;
  // 下載連結與檔名一律用 index.txt 的那個名字（那才是伺服器上的檔名）；
  // dbname／dbcname 只是檔頭裡的名字，不一定相同。
  return { fileName, name: dbcname || dbname || fileName, dbname, chars: chars > 0 ? chars : null, size: st.size, mtime: st.mtimeMs };
}

// ---- 逐筆 ---------------------------------------------------------------------
const rows: Awaited<ReturnType<typeof inspect>>[] = [];
for (const fileName of names) {
  const hit = local.get(fileName.toLowerCase());
  if (!hit) {
    console.warn(`  ! 本機找不到 ${fileName}（${ADB_DIR}）→ 這一列只顯示檔名`);
    const clean = fileName.replace(/\.adb$/i, '');
    rows.push({ fileName, name: clean, dbname: clean, chars: null, size: 0, mtime: 0 });
    continue;
  }
  const r = await inspect(hit.path, fileName);
  console.log(`  ${fileName}  ${r.name}  ${r.chars ?? '?'} 字（約）  ${(r.size / 1048576).toFixed(1)} MB  (${hit.path})`);
  rows.push(r);
}

// ---- 版面：直接沿用官網的 <style> 與頁首頁尾 -------------------------------------
const siteHtml = readFileSync(resolve(SITE, 'index.html'), 'utf8');
const style = /<style>([\s\S]*?)<\/style>/.exec(siteHtml)?.[1];
if (!style) { console.error('www/index.html 裡找不到 <style>'); process.exit(1); }
const themeBoot = /<script>([\s\S]*?)<\/script>/.exec(siteHtml)?.[1] ?? '';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const fmtInt = (n: number) => n.toLocaleString('en-US');
const fmtSize = (n: number) => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
const fmtDate = (ms: number) => {
  if (!ms) return '—';
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

// 施工中的庫：manifest 有記錄，但 downloadable:false（官網不給下載連結）。
interface ManifestDb { file: string; name?: string; size?: number; buildTime?: string; status?: string; statusLabel?: string; statusNote?: string; source?: string; licenseNote?: string; crossCheck?: string; downloadable?: boolean }
let wip: ManifestDb[] = [];
let allDbs: ManifestDb[] = [];
try {
  const mf = JSON.parse(readFileSync(resolve(SITE, 'adb/manifest.json'), 'utf8')) as { dbs?: ManifestDb[] };
  allDbs = mf.dbs ?? [];
  wip = allDbs.filter((d) => d.downloadable === false || (d.status && d.status !== 'available'));
} catch { /* 還沒有 manifest 就只列可下載的 */ }
// 可下載但帶說明的庫（例：內測中、限某校師生）
const wipNotes = allDbs.filter((d) => d.statusNote && d.statusLabel && d.statusLabel !== '可下載' && d.downloadable !== false);

const totalChars = rows.reduce((a, r) => a + (r.chars ?? 0), 0);
const totalSize = rows.reduce((a, r) => a + r.size, 0);
const known = rows.filter((r) => r.chars !== null).length;

const body = rows.map((r) => `        <tr>
          <td class="db"><b>${esc(r.name)}</b><span class="file">${esc(r.fileName)}</span>${docOf.has(r.fileName) ? `<a class="docLink" href="${esc(docOf.get(r.fileName)!)}">改版說明</a>` : ''}</td>
          <td class="num">${r.chars === null ? '—' : fmtInt(r.chars)}</td>
          <td class="num">${fmtDate(r.mtime)}</td>
          <td class="num">${r.size ? fmtSize(r.size) : '—'}</td>
          <td class="dl"><a href="${esc(r.fileName)}" download>下載</a></td>
        </tr>`).join('\n');

const html = `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>公開數據庫 — 開放古籍平台 accelon26</title>
<meta name="description" content="accelon26 公開的 .adb 古籍資料庫清單：可直接下載，放進 accelon3.exe 同一個資料夾就能讀。">
<link rel="icon" href="../img/appicon.png">
<script>${themeBoot}</script>
<style>${style}
  /* ---- 這一頁自己的（公開數據庫） ---- */
  .dbHead { padding: 34px 0 8px; }
  .dbHead h1 { font-size: clamp(22px, 2.6vw, 30px); margin: 0 0 10px; font-weight: 700; }
  .dbHead p { margin: 0; color: var(--muted); font-size: 16px; max-width: 46em; }
  .dbMeta { margin: 16px 0 0; color: var(--dim); font-size: 14px; }
  .dbTable { width: 100%; border-collapse: collapse; margin: 26px 0 10px; font-size: 15px; }
  .dbTable th, .dbTable td { text-align: left; padding: 11px 12px; border-bottom: 1px solid var(--line); }
  .dbTable th { color: var(--dim); font-weight: 600; font-size: 13px; letter-spacing: .04em; text-transform: uppercase; }
  .dbTable tbody tr:hover { background: var(--panel2); }
  .dbTable .db { min-width: 12em; }
  .dbTable .db b { font-weight: 700; }
  .dbTable .db .file { display: block; color: var(--dim); font-size: 12.5px; font-family: ui-monospace, Consolas, monospace; }
  .dbTable .db .docLink { display: inline-block; margin-top: 3px; font-size: 12.5px; color: var(--accent); }
  .dbTable .num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; color: var(--muted); }
  .dbTable .dl { text-align: right; white-space: nowrap; }
  .dbWarn { margin: 16px 0 0; padding: 12px 16px; border-left: 3px solid var(--gold);
    background: var(--panel); color: var(--muted2); font-size: 13.5px; line-height: 1.7; }
  .dbWarn b { color: var(--fg); margin-right: 6px; }
  .dbNote { margin: 22px 0 8px; padding: 14px 18px; background: var(--panel); border: 1px solid var(--line);
    border-left: 3px solid var(--gold); border-radius: 8px; color: var(--muted2); font-size: 14.5px; }
  .dbNote b { color: var(--fg); }
  /* 施工中（2026-10-29）：manifest 有記錄，但先不提供下載 */
  .wipSection { margin: 34px 0 0; border-top: 1px solid var(--line); padding-top: 24px; }
  .wipSection h2 { font-size: 21px; margin: 0 0 6px; }
  .wipSection > p { margin: 0 0 14px; color: var(--dim); font-size: 14px; max-width: 48em; }
  .wipRow { border: 1px solid var(--line); background: var(--panel); border-left: 3px solid var(--gold);
    border-radius: 8px; padding: 12px 16px; margin: 0 0 10px; }
  .wipName { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
  .wipName b { font-size: 16px; }
  .wipName .file { color: var(--dim); font-size: 12px; font-family: ui-monospace, Consolas, monospace; }
  .wipBadge { display: inline-block; padding: 1px 8px; border-radius: 999px; background: var(--gold);
    color: #fff; font-size: 11px; font-weight: 700; }
  html[data-theme="dark"] .wipBadge { color: #231a05; }
  .wipMeta { color: var(--dim); font-size: 12.5px; margin-top: 3px; font-variant-numeric: tabular-nums; }
  .wipNote { margin: 6px 0 0; color: var(--muted2); font-size: 13.5px; line-height: 1.65; }
  @media (max-width: 640px) {
    .dbTable th:nth-child(3), .dbTable td:nth-child(3) { display: none; }
  }
</style>
</head>
<body>

<header class="top">
  <div class="wrap">
    <div class="brand">accelon<b>26</b><span>古籍資料庫閱讀器</span></div>
    <nav>
      <a href="../index.html#features">特色</a>
      <a href="../index.html#shots">畫面</a>
      <a href="../index.html#install">下載與安裝</a>
      <a href="../index.html#contact">聯絡</a>
      <a href="index.html">公開數據庫</a>
      <button type="button" class="themeBtn" id="themeBtn" aria-label="切換亮底／暗底" title="切換亮底／暗底">
        <svg viewBox="0 0 24 24" aria-hidden="true" id="themeIcon"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.2 5.2l1.6 1.6M17.2 17.2l1.6 1.6M18.8 5.2l-1.6 1.6M6.8 17.2l-1.6 1.6"/></svg>
        <span id="themeLabel">亮底</span>
      </button>
    </nav>
  </div>
</header>

<main class="wrap">
  <section class="dbHead" style="border-top:none">
    <h1>公開數據庫</h1>
    <p>這些 <code>.adb</code> 都可以直接下載：放進 <code>accelon3.exe</code> 同一個資料夾，
      accelon26 開啟時就會自動列出來；也可以在程式裡用 <code>📁</code> 或拖進視窗。</p>
    <p class="dbMeta">共 ${rows.length} 個可下載資料庫${wip.length ? ` · 另有 ${wip.length} 個施工中（不提供下載）` : ''}${known ? ` · 合計約 ${fmtInt(totalChars)} 字` : ''} · 下載約 ${fmtSize(totalSize)}</p>
  </section>

  <table class="dbTable">
    <thead>
      <tr><th>資料庫</th><th class="num">字數（約）</th><th class="num">建置日期</th><th class="num">檔案大小</th><th class="dl">下載</th></tr>
    </thead>
    <tbody>
${body}
    </tbody>
  </table>

  ${wipNotes.map((d) => `<p class="dbWarn"><b>《${esc(d.name || d.file)}》${esc(d.statusLabel || '')}</b>${esc(d.statusNote)}</p>`).join('')}

  ${wip.length ? `<section class="wipSection">
    <h2>施工中</h2>
    <p>這些底座正在整理，<b>先不提供下載</b>；下方是我們目前做到哪裡（版本記錄仍在 manifest 裡）。</p>
    ${wip.map((d) => `<div class="wipRow">
      <div class="wipName"><b>${esc(d.name || d.file)}</b><span class="file">${esc(d.file)}</span><span class="wipBadge">${esc(d.statusLabel || '施工中')}</span></div>
      <div class="wipMeta">${d.size ? fmtSize(d.size) : ''}${d.buildTime ? ` · 最新 ${fmtDate(Date.parse(d.buildTime))}` : ''}</div>
      ${d.source ? `<div class="wipMeta">來源：${esc(d.source)}</div>` : ''}
      ${d.licenseNote ? `<div class="wipMeta">授權：${esc(d.licenseNote)}</div>` : ''}
      ${d.crossCheck ? `<div class="wipMeta">核對：${esc(d.crossCheck)}</div>` : ''}
      ${d.statusNote ? `<p class="wipNote">${esc(d.statusNote)}</p>` : ''}
    </div>`).join('')}
  </section>` : ''}

  <div class="dbNote">
    <b>關於這些資料庫</b>：由作者整理公開，歡迎自由使用。<b>小於 30 MB</b> 的庫可以經常更新；
    <b>超過 30 MB</b> 的底座仍可整檔下載，但只在 CBETA 換版等重大更新時才換版，也不列入桌面版的
    「全部更新」。字數取自 adb 檔頭的
    <code>maxblockoffset</code>（最大的文字位置），是<b>近似值</b>（與精確字數差幾個百分點，不必解壓整本）；
    建置日期取自檔案時間。想增補資料庫或發現錯誤，請<a href="../index.html#contact">留言給作者</a>。
  </div>
</main>

<footer>
  <div class="wrap">
    <span>accelon26 · Accelon3 跨平台平替 · <a href="../index.html">回首頁</a></span>
    <span class="right">授權：Apache-2.0 · 開發者微信 Sukhanika</span>
  </div>
</footer>

<script>
  // 亮底／暗底：跟官網同一個 localStorage key、同一個行為 —— 按鈕上顯示的是**現在**
  // 的底色（亮底＝現在是亮底），圖示也跟著換（作者 2026-10：這裡一度寫成「下一個」而反了）。
  (function () {
    var root = document.documentElement;
    var btn = document.getElementById('themeBtn');
    var label = document.getElementById('themeLabel');
    var icon = document.getElementById('themeIcon');
    var KEY = 'accelon26.site.theme';
    var SUN = '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.2 5.2l1.6 1.6M17.2 17.2l1.6 1.6M18.8 5.2l-1.6 1.6M6.8 17.2l-1.6 1.6"/>';
    var MOON = '<path d="M20 14.6A8.6 8.6 0 1 1 9.4 4a6.9 6.9 0 0 0 10.6 10.6z"/>';
    function paint(t) {
      root.setAttribute('data-theme', t);
      if (label) label.textContent = t === 'dark' ? '暗底' : '亮底';
      if (btn) btn.setAttribute('aria-pressed', t === 'dark' ? 'true' : 'false');
      if (icon) icon.innerHTML = t === 'dark' ? MOON : SUN;
    }
    paint(root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');
    if (btn) {
      btn.addEventListener('click', function () {
        var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
        try { localStorage.setItem(KEY, next); } catch (e) { /* 無痕模式 */ }
        paint(next);
      });
    }
  }());
</script>
</body>
</html>
`;

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'index.txt'), entries.map((e) => e.doc ? `${e.file}\t${e.doc}` : e.file).join('\n') + '\n', 'utf8');
writeFileSync(join(OUT, 'index.html'), html, 'utf8');
console.log(`\n寫好 ${join(OUT, 'index.html')}（${(html.length / 1024).toFixed(1)} KiB）與 index.txt`);
console.log(`上傳：cd ts && bun run tools/deploy.ts --site-only   （會一起傳 www/adb/）`);
