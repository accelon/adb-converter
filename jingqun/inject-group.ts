#!/usr/bin/env bun
/**
 * 把 jingang-groups.tsv 的每個「經文段落 → 多家註疏」注入成
 *
 *   <嵌始 e="g004"/>…經文段落…<嵌 e="g004" q="經文段落" t="…" n="3 家注疏"/>
 *
 * 產出 build/jingqun/jingang-embed-group.txt。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const HERE = import.meta.dir;
const ROOT = resolve(HERE, '..');
const DB = process.env.EMBED_DB || 'jingang';
const ROOT_TITLE = process.env.EMBED_ROOT || '金剛般若波羅蜜經';
const SRC = join(ROOT, 'build/jingqun', `${DB}.txt`);
const LINKS = join(ROOT, 'build/jingqun', `${DB}-groups.tsv`);
const OUT = join(ROOT, 'build/jingqun', `${DB}-embed-group.txt`);

const escAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

interface Group { eid: string; startLine: number; startCol: number; endLine: number; endCol: number; quote: string; targets: string; n: number }
const groups: Group[] = readFileSync(LINKS, 'utf8').split(/\r?\n/).slice(1).filter(Boolean).map((l) => {
  const p = l.split('\t');
  return {
    eid: p[0], startLine: +p[5], startCol: +p[6], endLine: +p[7], endCol: +p[8],
    quote: p[9], targets: p[10], n: +p[11],
  };
});

const raw = readFileSync(SRC, 'utf8');
const parts = raw.split(/(?=<段\/><書 id="n\d+">)/);
const at = parts.findIndex((p) => p.startsWith('<段/><書 id="n') && p.includes('>' + ROOT_TITLE + '</書>'));
if (at < 0) throw new Error('找不到根經 section: ' + ROOT_TITLE);
const headEnd = parts[at].indexOf('</書>') + 4;
const head = parts[at].slice(0, headEnd);
const body = parts[at].slice(headEnd);
const lines = body.split('\n');

interface Insert { col: number; tag: string }
const byLine = new Map<number, Insert[]>();
const add = (line: number, col: number, tag: string) => {
  const arr = byLine.get(line) ?? [];
  arr.push({ col, tag });
  byLine.set(line, arr);
};
for (const g of groups) {
  // 段落起點放零寬標記，方便展開時亮起正文；晶片放在整段之後。
  add(g.startLine, g.startCol, `<嵌始 e="${g.eid}"/>`);
  add(g.endLine, g.endCol, `<嵌 e="${g.eid}" q="${escAttr(g.quote)}" t="${escAttr(g.targets)}" n="${g.n} 家注疏"/>`);
}
for (const [ln, arr] of byLine) {
  let line = lines[ln];
  if (line === undefined) { console.warn('bad line', ln); continue; }
  const byCol = new Map<number, string[]>();
  for (const it of arr) {
    const a = byCol.get(it.col) ?? [];
    a.push(it.tag);
    byCol.set(it.col, a);
  }
  for (const col of [...byCol.keys()].sort((a, b) => b - a)) {
    if (col > line.length) { console.warn('bad col', ln + ':' + col); continue; }
    const tags = byCol.get(col)!.join('');
    line = line.slice(0, col) + tags + line.slice(col);
  }
  lines[ln] = line;
}

parts[at] = head + lines.join('\n');
const header = raw.slice(0, raw.indexOf('<段/>'));
writeFileSync(OUT, header + parts.slice(1).join(''));
console.log(`groups=${groups.length} lines=${byLine.size} out=${OUT}`);
