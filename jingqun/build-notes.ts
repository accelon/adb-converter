#!/usr/bin/env bun
/**
 * 把作者源檔 jingqun/jingang.txt 展開成可打包的讀本：
 *   1. <融 i="jingang?page"/> → 該頁經文（含 <頁>）
 *   2. <嵌 e q t n/> → 依 q 找到段落，前插 <嵌始 e>、後插 <嵌 e>
 *   3. 接上六部註疏的 <書> section（只供 <嵌> 取文，不在讀本正文出現）
 *
 * 產出 build/jingqun/jingang-notes.txt；再 tei-pack 成 build/jingang.adb。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const HERE = import.meta.dir;
const ROOT = resolve(HERE, '..');
const SRC = join(ROOT, 'jingqun/jingang.txt');
const FULL = join(ROOT, 'build/jingqun/jingang.txt');
const GROUPS = join(ROOT, 'build/jingqun/jingang-groups.tsv');
const OUT = join(ROOT, 'build/jingqun/jingang-notes.txt');

const unesc = (s: string) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const full = readFileSync(FULL, 'utf8');
const parts = full.split(/(?=<段\/><書 id="n\d+">)/);
const t = parts.find((p) => p.startsWith('<段/><書 id="n1">'));
if (!t) throw new Error('找不到 T235 section');
const body = t.slice(t.indexOf('</書>') + 4);
const pages = new Map<string, string>();
const pageStart = new Map<string, number>();
const pageLen = new Map<string, number>();
let running = 0;
const ms = [...body.matchAll(/<頁 id="([^"]+)"\/>/g)];
for (let i = 0; i < ms.length; i++) {
  const start = ms[i].index!;
  const end = i + 1 < ms.length ? ms[i + 1].index! : body.length;
  const content = body.slice(start, end);
  pages.set(ms[i][1], content);
  pageStart.set(ms[i][1], running);
  const n = [...content.replace(/<[^>]*>/g, '')].filter((c) => /[\u3400-\u9fff\uf900-\ufaff]/.test(c)).length;
  pageLen.set(ms[i][1], n);
  running += n;
}
const groupMap = new Map<string, { q: string; t: string; n: string }>();
for (const l of readFileSync(GROUPS, 'utf8').split(/\r?\n/).slice(1).filter(Boolean)) {
  const p = l.split('\t');
  const rel = +p[3] - (pageStart.get(p[2]) ?? 0);
  const end = Math.min(pageLen.get(p[2]) ?? rel + +p[4], rel + +p[4]);
  groupMap.set(`${p[2]}:${rel}-${end}`, { q: p[9], t: p[10], n: p[11] });
}

const extract = (content: string, attrs: string): string => {
  const m = /j="(\d+)-(\d+)"/.exec(attrs);
  if (!m) return content;
  const a = Number(m[1]), b = Number(m[2]);
  const han: number[] = [];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '<') { const gt = content.indexOf('>', i); if (gt < 0) break; i = gt; continue; }
    if (/[\u3400-\u9fff\uf900-\ufaff]/.test(content[i])) han.push(i);
  }
  if (a <= 0 && b >= han.length) return content;
  if (a >= han.length || b <= a) return content;
  return content.slice(han[a], han[Math.min(b, han.length) - 1] + 1);
};
let out = readFileSync(SRC, 'utf8').replace(/<融([^>]*)>([\s\S]*?)<\/融>|<融([^>]*)\/>/g, (all, a1: string | undefined, inner: string | undefined, a2: string | undefined) => {
  const attrs = a1 ?? a2 ?? '';
  // 用戶已在 <融> 裡編輯過文字：保留，不覆蓋；指針 attrs 不動。
  if (inner && inner.trim()) return `<融${attrs}>${inner}</融>`;
  const page = /i="[^"]*\?([^"]+)"/.exec(attrs)?.[1];
  if (!page || !pages.has(page)) return all;
  return `<融${attrs}>${extract(pages.get(page)!, attrs)}</融>`;
});
// 先把作者標記收起來；建置後不留在讀本裡。
// q 可省略：用 i（頁）+ j（頁內漢字範圍）從母 adb 抽出段落。
const attr = (attrs: string, name: string) => new RegExp('\\b' + name + '="([^"]*)"').exec(attrs)?.[1] ?? '';
const stripTags = (s: string) => s.replace(/<[^>]*>/g, '');
const rongInner = (page: string): string => {
  const p = page.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp('<融[^>]*i="[^"]*\\?' + p + '"[^>]*>([\\s\\S]*?)<\\/融>').exec(out);
  return m ? m[1] : (pages.get(page) ?? '');
};
const anns = [...out.matchAll(/<嵌(?!始)([^>]*)\/>/g)].map((m) => {
  const attrs = m[1];
  const i = attr(attrs, 'i');
  const j = attr(attrs, 'j');
  const page = i.replace(/^.*\?/, '');
  const g = groupMap.get(`${page}:${j}`);
  let q = unesc(attr(attrs, 'q'));
  let t = unesc(attr(attrs, 't'));
  let n = attr(attrs, 'n');
  // 源檔只寫 i/j：群組的 q／目標清單由 groups.tsv 補，目標庫改成 taisho。
  if (g) {
    if (!q) q = g.q;
    if (!t) t = g.t;
    if (!n) n = g.n + ' 家注疏';
  }
  if (!q && i) q = stripTags(extract(rongInner(page), j ? `j="${j}"` : ''));
  if (t) t = t.replace(/jingang\?/g, 'taisho?');
  return { i, j, q, t, n };
}).filter((a) => a.i && a.j && a.q && a.t);
out = out.replace(/<嵌(?!始)[^>]*\/>/g, '');

// 建「去標記、去空白」的字元 → 原文 offset 對照
const plain: string[] = [];
const map: number[] = [];
for (let i = 0; i < out.length; i++) {
  if (out[i] === '<') { const gt = out.indexOf('>', i); if (gt < 0) break; i = gt; continue; }
  if (/\s/.test(out[i])) continue;
  plain.push(out[i]); map.push(i);
}
const text = plain.join('');
const inserts: { pos: number; tag: string }[] = [];
let placed = 0;
for (const a of anns) {
  const q = a.q.replace(/\s+/g, '');
  const at = text.indexOf(q);
  if (at < 0) { console.warn('q not found:', a.i, a.j, q.slice(0, 20)); continue; }
  const start = map[at];
  const end = map[at + q.length - 1] + 1;
  inserts.push({ pos: end, tag: `<嵌 i="${esc(a.i)}" j="${esc(a.j)}" t="${esc(a.t)}" n="${esc(a.n)}"/>` });
  inserts.push({ pos: start, tag: `<嵌始 i="${esc(a.i)}" j="${esc(a.j)}"/>` });
  placed++;
}
for (const ins of inserts.sort((x, y) => y.pos - x.pos)) {
  out = out.slice(0, ins.pos) + ins.tag + out.slice(ins.pos);
}

writeFileSync(OUT, out);
console.log(`pages=${pages.size} annotations=${anns.length} placed=${placed} wrote ${OUT}`);
