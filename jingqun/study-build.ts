#!/usr/bin/env bun
/** 展開 taisho-study.txt：<融> 從母庫抽頁，<嵌> 依 i/j 從 study-groups.tsv 取 q/t。 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const SRC = join(ROOT, 'jingqun/taisho-study.txt');
const OUT = join(ROOT, 'build/jingqun/taisho-study-notes.txt');
const ROOTS = [
  join(ROOT, 'build/jingqun/jingang.txt'),
  join(ROOT, 'build/jingqun/fahua.txt'),
  join(ROOT, 'build/jingqun/dari.txt'),
];
const GROUPS = join(ROOT, 'build/jingqun/study-groups.tsv');

const unesc = (s: string) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const pages = new Map<string, string>();
const pageStart = new Map<string, number>();
const pageLen = new Map<string, number>();
for (const file of ROOTS) {
  const raw = readFileSync(file, 'utf8');
  const parts = raw.split(/(?=<段\/><書 id="n\d+">)/);
  for (const p of parts) {
    if (!p.startsWith('<段/><書 id=')) continue;
    const body = p.slice(p.indexOf('</書>') + 4);
    const ms = [...body.matchAll(/<頁 id="([^"]+)"\/>/g)];
    const order: string[] = [];
    const firstAt = new Map<string, number>();
    for (const m of ms) {
      if (!firstAt.has(m[1])) { firstAt.set(m[1], m.index!); order.push(m[1]); }
    }
    let running = 0;
    for (let i = 0; i < order.length; i++) {
      const page = order[i];
      const start = firstAt.get(page)!;
      const end = i + 1 < order.length ? firstAt.get(order[i + 1])! : body.length;
      const content = body.slice(start, end);
      pages.set(page, content);
      pageStart.set(page, running);
      const n = [...content.replace(/<[^>]*>/g, '')].filter((c) => /[\u3400-\u9fff\uf900-\ufaff]/.test(c)).length;
      pageLen.set(page, n);
      running += n;
    }
  }
}

const groups = new Map<string, { q: string; t: string; n: string }>();
for (const l of readFileSync(GROUPS, 'utf8').split(/\r?\n/).slice(1).filter(Boolean)) {
  const p = l.split('\t');
  groups.set(`${p[0]}:${p[1]}-${p[2]}`, { q: p[3], t: p[4], n: p[5] });
}

const extract = (content: string, attrs: string): string => {
  // <融> 只取經文；卷／品／分由作者源檔另外插入，避免同一標題被算成兩個樹節點。
  const clean = content.replace(/<(卷|品|分)>[\s\S]*?<\/\1>/g, '');
  const m = /j="(\d+)-(\d+)"/.exec(attrs);
  if (!m) return clean;
  const a = Number(m[1]), b = Number(m[2]);
  const han: number[] = [];
  for (let i = 0; i < clean.length; i++) {
    if (clean[i] === '<') { const gt = clean.indexOf('>', i); if (gt < 0) break; i = gt; continue; }
    if (/[\u3400-\u9fff\uf900-\ufaff]/.test(clean[i])) han.push(i);
  }
  if (a <= 0 && b >= han.length) return clean;
  if (a >= han.length || b <= a) return clean;
  const start = a <= 0 ? 0 : han[a];
  return clean.slice(start, han[Math.min(b, han.length) - 1] + 1);
};
const stripTags = (s: string) => s.replace(/<[^>]*>/g, '');
const attr = (attrs: string, name: string) => new RegExp('\\b' + name + '="([^"]*)"').exec(attrs)?.[1] ?? '';
let out = readFileSync(SRC, 'utf8').replace(/<融([^>]*)>([\s\S]*?)<\/融>|<融([^>]*)\/>/g, (all, a1: string | undefined, inner: string | undefined, a2: string | undefined) => {
  const attrs = a1 ?? a2 ?? '';
  if (inner && inner.trim()) return `<融${attrs}>${inner}</融>`;
  const page = /i="[^"]*\?([^"]+)"/.exec(attrs)?.[1];
  if (!page || !pages.has(page)) return all;
  return `<融${attrs}>${extract(pages.get(page)!, attrs)}</融>`;
});

const anns = [...out.matchAll(/<嵌(?!始)([^>]*)\/>/g)].map((m) => {
  const attrs = m[1];
  const i = attr(attrs, 'i');
  const j = attr(attrs, 'j');
  const page = i.replace(/^.*\?/, '');
  const key = `${page}:${j}`;
  const g = groups.get(key);
  if (!g) return null;
  return { i, j, q: g.q, t: g.t.replace(/(jingang|fahua|dari)\?/g, 'taisho?'), n: g.n + ' 家注疏' };
}).filter(Boolean) as { i: string; j: string; q: string; t: string; n: string }[];
out = out.replace(/<嵌(?!始)[^>]*\/>/g, '');

const plain: string[] = [];
const map: number[] = [];
for (let i = 0; i < out.length; i++) {
  if (out[i] === '<') { const gt = out.indexOf('>', i); if (gt < 0) break; i = gt; continue; }
  if (!/[\u3400-\u9fff\uf900-\ufaff]/.test(out[i])) continue;
  plain.push(out[i]); map.push(i);
}
const text = plain.join('');
const inserts: { pos: number; tag: string }[] = [];
let placed = 0;
for (const a of anns) {
  const q = Array.from(a.q).filter((c) => /[\u3400-\u9fff\uf900-\ufaff]/.test(c)).join('');
  const at = text.indexOf(q);
  if (at < 0) { console.warn('q not found:', a.i, a.j, q.slice(0, 20)); continue; }
  const start = map[at];
  const end = map[at + q.length - 1] + 1;
  inserts.push({ pos: end, tag: `<嵌 i="${esc(a.i)}" j="${esc(a.j)}" t="${esc(a.t)}" n="${esc(a.n)}"/>` });
  inserts.push({ pos: start, tag: `<嵌始 i="${esc(a.i)}" j="${esc(a.j)}"/>` });
  placed++;
}
for (const ins of inserts.sort((x, y) => y.pos - x.pos)) out = out.slice(0, ins.pos) + ins.tag + out.slice(ins.pos);
writeFileSync(OUT, out);
console.log(`pages=${pages.size} annotations=${anns.length} placed=${placed} wrote ${OUT}`);




