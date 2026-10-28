/**
 * 把一份 Markdown 變成官網樣式的單頁 HTML（作者 2026-10-28）。
 *
 *   bun run tools/md-page.ts --md ../ys.md --out ../www/adb/ys.html --title "ys.adb 與 yinshun.adb 有什麼不同"
 *
 * 只支援我們自己會用到的語法：標題、段落、清單、引用、表格、圍欄程式碼，
 * 以及行內的 **粗體**、`code`、[連結](url)。版面直接沿用 www/index.html 的
 * <style> 與頁首頁尾，所以官網換樣式時這一頁會跟著換。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const opt = (n: string, d = '') => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };

const ROOT = resolve(import.meta.dir, '../..');
const SITE = resolve(ROOT, 'www');
const mdPath = resolve(opt('md', resolve(ROOT, 'ys.md')));
const outPath = resolve(opt('out', resolve(SITE, 'adb', 'ys.html')));
const title = opt('title', '說明');

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const inline = (s: string): string => esc(s)
  .replace(/`([^`]+)`/g, '<code>$1</code>')
  .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
  .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

const lines = readFileSync(mdPath, 'utf8').split(/\r?\n/);
const out: string[] = [];
let i = 0;
let inCode = false;
let code: string[] = [];
let list: string[] = [];

const flushList = () => {
  if (list.length) { out.push('<ul>\n' + list.map((x) => '  <li>' + x + '</li>').join('\n') + '\n</ul>'); list = []; }
};

while (i < lines.length) {
  const line = lines[i];
  if (/^```/.test(line)) {
    if (inCode) { out.push('<pre><code>' + esc(code.join('\n')) + '</code></pre>'); code = []; inCode = false; }
    else { flushList(); inCode = true; }
    i++;
    continue;
  }
  if (inCode) { code.push(line); i++; continue; }
  if (!line.trim()) { flushList(); i++; continue; }

  const h = /^(#{1,4})\s+(.*)$/.exec(line);
  if (h) {
    flushList();
    const level = h[1].length;
    out.push(`<h${level}>${inline(h[2])}</h${level}>`);
    i++;
    continue;
  }
  if (/^\s*-\s+/.test(line)) { list.push(inline(line.replace(/^\s*-\s+/, ''))); i++; continue; }

  // 表格：| a | b | … 接著 |---|---|
  if (/^\s*\|/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? '')) {
    flushList();
    const cells = (s: string) => s.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    const head = cells(line);
    i += 2;
    const body: string[][] = [];
    while (i < lines.length && /^\s*\|/.test(lines[i])) { body.push(cells(lines[i])); i++; }
    out.push('<div class="tableWrap"><table>\n<thead><tr>' + head.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead>\n<tbody>'
      + body.map((r) => '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('\n') + '</tbody></table></div>');
    continue;
  }
  if (/^\s*>\s?/.test(line)) { flushList(); out.push('<blockquote>' + inline(line.replace(/^\s*>\s?/, '')) + '</blockquote>'); i++; continue; }

  flushList();
  out.push('<p>' + inline(line) + '</p>');
  i++;
}
flushList();
if (inCode) out.push('<pre><code>' + esc(code.join('\n')) + '</code></pre>');

const siteHtml = readFileSync(resolve(SITE, 'index.html'), 'utf8');
const style = /<style>([\s\S]*?)<\/style>/.exec(siteHtml)?.[1] ?? '';
const themeBoot = /<script>([\s\S]*?)<\/script>/.exec(siteHtml.split('<body')[0])?.[1] ?? '';

const html = `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="theme-color" content="#f7f7f8" id="themeColor">
<link rel="icon" type="image/png" href="../img/appicon.png">
<script>${themeBoot}</script>
<style>${style}
  .doc { max-width: 860px; margin: 0 auto; padding: 28px 20px 60px; }
  .doc h1 { font-size: 1.6em; margin: .2em 0 .8em; }
  .doc h2 { font-size: 1.2em; margin: 1.6em 0 .6em; }
  .doc h3 { font-size: 1.05em; margin: 1.2em 0 .4em; }
  .doc p { line-height: 1.9; margin: .7em 0; color: var(--muted); }
  .doc li { line-height: 1.85; color: var(--muted); }
  .doc code { background: var(--code-bg); border-radius: 4px; padding: 1px 5px; font-size: .92em; }
  .doc pre { background: var(--code-bg); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; overflow: auto; }
  .doc pre code { background: none; padding: 0; }
  .doc blockquote { margin: 1em 0; padding: .4em 1em; border-left: 3px solid var(--line); color: var(--dim); }
  .tableWrap { overflow-x: auto; margin: 1em 0; }
  .doc table { border-collapse: collapse; width: 100%; font-size: .94em; }
  .doc th, .doc td { border: 1px solid var(--line); padding: 7px 10px; text-align: left; vertical-align: top; }
  .doc th { background: var(--panel2); font-weight: 600; }
  .doc a { color: var(--accent); }
</style>
</head>
<body>
<header class="top">
  <div class="wrap">
    <div class="brand">accelon<b>26</b><span>古籍資料庫閱讀器</span></div>
    <nav>
      <a href="../index.html">首頁</a>
      <a href="index.html">公開數據庫</a>
      <a href="../changelog.html">更新說明</a>
    </nav>
  </div>
</header>
<main class="doc">
${out.join('\n')}
</main>
<footer>
  <div class="wrap">
    <span>accelon26 · Accelon3 跨平台平替 · <a href="index.html">公開數據庫</a></span>
    <span class="right">授權：Apache-2.0</span>
  </div>
</footer>
</body>
</html>
`;
writeFileSync(outPath, html, 'utf8');
console.log(`wrote ${outPath}（${(html.length / 1024).toFixed(1)} KiB，${out.length} 個區塊）`);
