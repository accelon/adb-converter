#!/usr/bin/env bun
/**
 * 把 jingang-groups.tsv 的每個「經文段落 → 多家註疏」注入成
 *
 *   <嵌 q="經文段落" t="jingang?33p228b@318-360@註解|…" n="3 家注疏"/>
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

interface Group { line: number; col: number; quote: string; targets: string; n: number }
const groups: Group[] = readFileSync(LINKS, 'utf8').split(/\r?\n/).slice(1).filter(Boolean).map((l) => {
  const p = l.split('\t');
  return { line: +p[5], col: +p[6], quote: p[7], targets: p[8], n: +p[9] };
});

const raw = readFileSync(SRC, 'utf8');
const parts = raw.split(/(?=<段\/><書 id="n\d+">)/);
const at = parts.findIndex((p) => p.startsWith('<段/><書 id="n') && p.includes('>' + ROOT_TITLE + '</書>'));
if (at < 0) throw new Error('找不到根經 section: ' + ROOT_TITLE);
const headEnd = parts[at].indexOf('</書>') + 4;
const head = parts[at].slice(0, headEnd);
const body = parts[at].slice(headEnd);
const lines = body.split('\n');

const byLine = new Map<number, Group[]>();
for (const g of groups) {
  const arr = byLine.get(g.line) ?? [];
  arr.push(g);
  byLine.set(g.line, arr);
}
for (const [ln, arr] of byLine) {
  let line = lines[ln];
  if (line === undefined) { console.warn('bad line', ln); continue; }
  const byCol = new Map<number, Group[]>();
  for (const g of arr) {
    const a = byCol.get(g.col) ?? [];
    a.push(g);
    byCol.set(g.col, a);
  }
  for (const col of [...byCol.keys()].sort((a, b) => b - a)) {
    if (col > line.length) { console.warn('bad col', ln + ':' + col); continue; }
    const tags = byCol.get(col)!.map((g) =>
      `<嵌 q="${escAttr(g.quote)}" t="${escAttr(g.targets)}" n="${g.n} 家注疏"/>`).join('');
    line = line.slice(0, col) + tags + line.slice(col);
  }
  lines[ln] = line;
}

parts[at] = head + lines.join('\n');
const header = raw.slice(0, raw.indexOf('<段/>'));
writeFileSync(OUT, header + parts.slice(1).join(''));
console.log(`groups=${groups.length} lines=${byLine.size} out=${OUT}`);
