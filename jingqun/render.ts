#!/usr/bin/env bun
/** 由 jingqun.json 產生可離線看的樹狀 HTML。 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const HERE = import.meta.dir;
const ROOT = resolve(HERE, '..');

interface JNode {
  no: string; idx: number; title: string; author: string; genre: string; cls: string; depth: number;
  conf: string; evidence: string; note?: string; children: JNode[];
}
interface Group { family: string; label: string; roots: JNode[] }

const groups: Group[] = JSON.parse(readFileSync(join(ROOT, 'build/jingqun/jingqun.json'), 'utf8'));
const count = (ns: JNode[]): number => ns.reduce((a, n) => a + 1 + count(n.children), 0);
const total = groups.reduce((a, g) => a + g.roots.reduce((b, r) => b + 1 + count(r.children), 0), 0);

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function nodeHtml(n: JNode): string {
  const badge = `<span class="b b-${n.cls}">${n.cls}</span>`;
  const kids = n.children.length
    ? `<div class="kids">${n.children.map(nodeHtml).join('')}</div>`
    : '';
  const note = n.note ? `<span class="note">${esc(n.note)}</span>` : '';
  const auth = n.author ? `<span class="auth">${esc(n.author)}</span>` : '';
  return `<div class="node d${n.depth}" data-k="${esc(n.no + ' ' + n.title + ' ' + n.author + ' ' + (n.note ?? ''))}">
    <div class="row">${badge}<span class="no">${esc(n.no)}</span><span class="t">${esc(n.title)}</span>${auth}<span class="g">${esc(n.genre)}</span>${note}</div>${kids}</div>`;
}

const sections = groups.map((g) => {
  const roots = g.roots.map(nodeHtml).join('');
  const n = g.roots.reduce((a, r) => a + 1 + count(r.children), 0);
  return `<section class="fam" id="${esc(g.family)}" data-fam="${esc(g.label)}">
    <h2><span>${esc(g.label)}</span><small>${n} 部</small></h2>
    ${roots}
  </section>`;
}).join('');

const html = `<!doctype html>
<html lang="zh-Hant"><meta charset="utf-8">
<title>大正藏 經／論／律→注→疏 繼承表</title>
<style>
  :root{--bg:#fbfaf7;--fg:#26221c;--dim:#7b7468;--line:#e3ddd1;--jing:#8a5a2b;--zhu:#2f6b4f;--shu:#7a4b8f;--lun:#3b5f8a;--lv:#6b5b2e}
  @media (prefers-color-scheme:dark){:root{--bg:#171614;--fg:#e8e2d6;--dim:#9a9284;--line:#33302b;--jing:#d9a15c;--zhu:#7fbf9a;--shu:#c39bd8;--lun:#8fb4e6}}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.65 "Noto Serif TC","Source Han Serif TC","PMingLiU",serif}
  header{padding:22px 26px 12px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg);z-index:5}
  h1{margin:0 0 4px;font-size:20px;letter-spacing:.04em}
  .sub{color:var(--dim);font-size:13px}
  .tools{margin-top:10px;display:flex;gap:8px;flex-wrap:wrap}
  input{flex:1 1 260px;max-width:420px;padding:6px 10px;border:1px solid var(--line);border-radius:6px;background:transparent;color:var(--fg);font:inherit}
  button{padding:6px 12px;border:1px solid var(--line);border-radius:6px;background:transparent;color:var(--fg);font:inherit;cursor:pointer}
  main{padding:16px 26px 60px;max-width:1080px}
  .fam{margin:0 0 18px;border-bottom:1px solid var(--line);padding-bottom:10px}
  .fam h2{font-size:16px;margin:0 0 6px;display:flex;align-items:baseline;gap:10px}
  .fam h2 small{color:var(--dim);font-weight:400;font-size:12px}
  .node{margin:2px 0}
  .row{display:flex;align-items:baseline;gap:8px;padding:2px 0;border-radius:4px}
  .row:hover{background:color-mix(in srgb,var(--fg) 5%,transparent)}
  .kids{margin-left:20px;border-left:1px solid var(--line);padding-left:10px}
  .b{display:inline-block;min-width:1.6em;text-align:center;font-size:11px;line-height:1.5;border-radius:3px;color:#fff;padding:0 4px;font-family:system-ui,sans-serif}
  .b-經{background:var(--jing)}.b-論{background:var(--lun)}.b-律{background:var(--lv)}.b-注{background:var(--zhu)}.b-疏{background:var(--shu)}
  .no{color:var(--dim);font:12px/1 ui-monospace,monospace;min-width:4.2em}
  .t{font-weight:600}
  .auth{color:var(--dim);font-size:12px}
  .g{color:var(--dim);font-size:11px;border:1px solid var(--line);border-radius:3px;padding:0 4px}
  .note{color:var(--dim);font-size:12px}
  .hide{display:none}
  .d0>.row .t{font-size:16px;color:var(--jing)}.d0>.row .b-論~.t{color:var(--lun)}.d0>.row .b-律~.t{color:var(--lv)}
  .d2>.row .t,.d3>.row .t{font-weight:400}
</style>
<header>
  <h1>大正藏「經／論／律 → 注 → 疏」繼承表</h1>
  <div class="sub">以 CBETA TEI 的 <code>[cf. No. N]</code> 為第一證據，續經疏部等無 cf 者用人工種子；共 ${groups.length} 群、${total} 部。${new Date().toISOString().slice(0, 10)}</div>
  <div class="tools"><input id="q" placeholder="搜題名／經號／作者…"><button id="all">全部展開</button><button id="none">全部收合</button></div>
</header>
<main id="main">${sections}</main>
<script>
  const q = document.getElementById('q');
  const nodes = [...document.querySelectorAll('.node')];
  q.addEventListener('input', () => {
    const s = q.value.trim().toLowerCase();
    for (const n of nodes) n.classList.toggle('hide', s && !n.dataset.k.toLowerCase().includes(s));
    for (const f of document.querySelectorAll('.fam')) {
      const vis = [...f.querySelectorAll('.node')].some((n) => !n.classList.contains('hide'));
      f.classList.toggle('hide', !vis);
    }
  });
  // 預設只展開到「注」；「疏」收在注下面
  for (const n of nodes) if (n.classList.contains('d2')) n.querySelector('.kids')?.classList.add('hide');
  document.querySelectorAll('.row').forEach((r) => r.addEventListener('click', (e) => {
    e.stopPropagation();
    const k = r.parentElement.querySelector(':scope > .kids');
    if (k) k.classList.toggle('hide');
  }));
  document.getElementById('all').onclick = () => document.querySelectorAll('.kids').forEach((k) => k.classList.remove('hide'));
  document.getElementById('none').onclick = () => document.querySelectorAll('.kids').forEach((k) => k.classList.add('hide'));
</script>
</html>`;

writeFileSync(join(ROOT, 'build/jingqun/jingqun.html'), html);
console.log(`families=${groups.length} nodes=${total} bytes=${html.length}`);




