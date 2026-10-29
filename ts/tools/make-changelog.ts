/**
 * 產生官網的更新說明頁：`www/changelog.html`（作者 2026-10-22）。
 *
 * 資料來源是 `wails/release_notes.json`（release.ts 在發佈時 append）。
 * `deploy.ts --site`／`--site-only` 會先跑這一支，所以官網的 changelog 不會漏掉
 * 最新一版；首頁的「最新版」則是抓 `versions.json` 的 buildTime。
 *
 *   cd ts && bun run tools/make-changelog.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface Note {
  buildTime: string;
  title?: string;
  items: string[];
}

const ROOT = resolve(import.meta.dir, '../..');
const NOTES = resolve(ROOT, 'wails/release_notes.json');
const OUT = resolve(ROOT, 'www/changelog.html');

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string
));

const raw = JSON.parse(readFileSync(NOTES, 'utf8')) as Note[];
const notes = [...raw].sort((a, b) => String(b.buildTime).localeCompare(String(a.buildTime)));
const latest = notes[0];
// 版本日期用北京時間（作者 2026-10-29）：buildTime 是 UTC，10-28T23:11Z 其實是
// 10-29 早上；用 UTC 切日期會讓官網／更新說明看起來停在「前天」。
const dateOf = (iso: string): string => {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return String(iso).slice(0, 10);
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(d);
};
const latestDate = latest ? dateOf(latest.buildTime) : '';
const stamp = (iso: string): string => {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return String(iso).replace('T', ' ').replace(/Z$/, ' UTC');
  const s = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d);
  return s + ' 北京時間';
};

const entries = notes.map((n) => {
  const date = dateOf(n.buildTime);
  const items = (n.items ?? []).map((it) => `        <li>${esc(it)}</li>`).join('\n');
  const title = n.title && n.title !== `accelon26 ${date}`
    ? `<div class="noteTitle">${esc(n.title)}</div>` : '';
  return `      <article class="ver" id="d-${date}">
        <h2>${esc(date)}<span class="build">${esc(stamp(n.buildTime))}</span></h2>
        ${title}
        <ul>
${items}
        </ul>
      </article>`;
}).join('\n\n');

const html = `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>更新說明 — accelon26</title>
<meta name="description" content="accelon26 的版本更新說明：每個版本改了什麼、最新版是哪一天。">
<script>try{var t=localStorage.getItem('accelon26.site.theme')==='dark'?'dark':'light';document.documentElement.setAttribute('data-theme',t);}catch(e){}</script>
<style>
  :root {
    --bg: #f7f7f8; --panel: #ffffff; --fg: #1f2328; --dim: #6a7280;
    --line: #d6d9de; --accent: #1f6feb; --gold: #b45309; --hl: #eef2f7;
  }
  html[data-theme="dark"] {
    --bg: #16171a; --panel: #1e1f23; --fg: #e8e8e8; --dim: #9aa1ab;
    --line: #2c2d31; --accent: #5aa9ff; --gold: #ffd479; --hl: #25272c;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--fg);
    font: 15px/1.65 "Segoe UI", "Microsoft JhengHei", system-ui, sans-serif;
  }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .wrap { max-width: 900px; margin: 0 auto; padding: 0 24px; }
  header { border-bottom: 1px solid var(--line); background: var(--panel); position: sticky; top: 0; z-index: 5; }
  header .wrap { display: flex; align-items: center; gap: 16px; height: 60px; }
  .brand { font-size: 19px; font-weight: 700; color: var(--fg); }
  .brand b { color: var(--gold); }
  nav { margin-left: auto; display: flex; align-items: center; gap: 16px; font-size: 13px; }
  nav a { color: var(--dim); }
  nav a:hover { color: var(--fg); }
  .themeBtn {
    background: transparent; color: var(--dim); border: 1px solid var(--line);
    border-radius: 999px; padding: 4px 11px; font: inherit; font-size: 12.5px; cursor: pointer;
  }
  .themeBtn:hover { color: var(--fg); border-color: var(--dim); }
  main { padding: 42px 0 64px; }
  h1 { font-size: 30px; margin: 0 0 6px; letter-spacing: .01em; }
  .lead { color: var(--dim); margin: 0 0 10px; }
  .latest {
    display: inline-flex; align-items: center; gap: 8px; margin: 0 0 34px;
    border: 1px solid var(--line); background: var(--panel); border-radius: 999px;
    padding: 4px 12px; font-size: 13px; color: var(--dim);
  }
  .latest b { color: var(--fg); }
  .actions { display: flex; gap: 12px; margin: 0 0 34px; flex-wrap: wrap; }
  .btn {
    display: inline-block; background: var(--accent); color: #fff;
    border-radius: 8px; padding: 9px 18px; font-size: 14px; font-weight: 600;
  }
  html[data-theme="dark"] .btn { color: #08243f; }
  .btn:hover { text-decoration: none; filter: brightness(1.06); }
  .btn.ghost { background: transparent; color: var(--fg); border: 1px solid var(--line); }
  .ver {
    border-left: 3px solid var(--accent); padding: 2px 0 2px 18px; margin: 0 0 32px;
  }
  .ver h2 { font-size: 18px; margin: 0 0 4px; }
  .ver .build { color: var(--dim); font-size: 12px; font-weight: 400; margin-left: 9px; }
  .noteTitle { color: var(--dim); font-size: 13px; margin: 0 0 4px; }
  .ver ul { margin: 8px 0 0; padding-left: 20px; }
  .ver li { margin: 5px 0; }
  footer { border-top: 1px solid var(--line); color: var(--dim); font-size: 12.5px; padding: 18px 0 36px; }
  footer a { color: var(--dim); }
  @media (max-width: 640px) {
    header .wrap { height: auto; min-height: 54px; flex-wrap: wrap; padding: 8px 24px; }
    nav { flex: 1 1 100%; width: 100%; justify-content: flex-end; flex-wrap: wrap; gap: 8px 12px; }
    h1 { font-size: 26px; }
  }
</style>
</head>
<body>
<header>
  <div class="wrap">
    <a class="brand" href="index.html">accelon<b>26</b></a>
    <nav>
      <a href="index.html">首頁</a>
      <a href="index.html#install">下載與安裝</a>
      <a href="releases.html">版本下載</a>
      <a href="https://github.com/accelon/adb-converter" target="_blank" rel="noopener noreferrer">GitHub</a>
      <button type="button" class="themeBtn" id="themeBtn">暗底</button>
    </nav>
  </div>
</header>
<main class="wrap">
  <h1>更新說明</h1>
  <p class="lead">accelon26 每個版本改了什麼；最新版是 <b>${esc(latestDate)}</b>。</p>
  <div class="latest">最新版 <b>${esc(latestDate)}</b><span>·</span><span>${esc(latest ? stamp(latest.buildTime) : '')}</span></div>
  <div class="actions">
    <a class="btn" href="index.html#install">下載最新版</a>
    <a class="btn ghost" href="index.html">回首頁</a>
  </div>

${entries}

</main>
<footer>
  <div class="wrap">accelon26 · Accelon3 跨平台平替 · <a href="index.html">首頁</a> · <a href="https://github.com/accelon/adb-converter" target="_blank" rel="noopener noreferrer">GitHub</a> · 授權 Apache-2.0</div>
</footer>
<script>
  (function () {
    var KEY = 'accelon26.site.theme';
    var root = document.documentElement;
    var btn = document.getElementById('themeBtn');
    try { root.setAttribute('data-theme', localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light'); } catch (e) {}
    function paint() {
      var dark = root.getAttribute('data-theme') === 'dark';
      if (btn) { btn.textContent = dark ? '亮底' : '暗底'; btn.title = dark ? '切到亮底' : '切到暗底'; }
    }
    if (btn) {
      btn.addEventListener('click', function () {
        var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
        root.setAttribute('data-theme', next);
        try { localStorage.setItem(KEY, next); } catch (e) {}
        paint();
      });
    }
    paint();
  }());
</script>
</body>
</html>
`;

writeFileSync(OUT, html);
console.log('wrote ' + OUT + '（' + notes.length + ' 版；最新 ' + latestDate + '）');
