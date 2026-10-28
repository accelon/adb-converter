#!/usr/bin/env bun
/**
 * 把 jingang-links.tsv 的每一筆，在 T235 的對應字前插入 <嵌>。
 *
 *   <嵌 i="jingang?33p158a" q="佛言善哉…" j="61-123" n="纂要"/>
 *
 * 產出 build/jingqun/jingang-embed.txt（可直接 tei-pack 成 jingang.adb）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const HERE = import.meta.dir;
const ROOT = resolve(HERE, '..');
/** 例：EMBED_DB=jingang EMBED_ROOT=金剛般若波羅蜜經 bun run jingqun/inject.ts */
const DB = process.env.EMBED_DB || 'jingang';
const ROOT_TITLE = process.env.EMBED_ROOT || '金剛般若波羅蜜經';
const SRC = join(ROOT, 'build/jingqun', `${DB}.txt`);
const LINKS = join(ROOT, 'build/jingqun', `${DB}-links.tsv`);
const OUT = join(ROOT, 'build/jingqun', `${DB}-embed.txt`);

const SHORT: Record<string, string> = {
  '1510a': '無著論', '1511': '天親論', '1512': '金剛仙',
  '1515': '功德施', '1698': '智顗疏', '1699': '吉藏疏',
  '1700': '贊述', '1701': '纂要', '1702': '刊定記', '1703': '註解',
};
const escAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

interface Link { line: number; col: number; page: string; commNo: string; commPage: string; pi: number; pe: number; quote: string }
const links: Link[] = readFileSync(LINKS, 'utf8').split(/\r?\n/).slice(1).filter(Boolean).map((l) => {
  const p = l.split('\t');
  return { page: p[1], line: +p[3], col: +p[4], quote: p[5], commNo: p[6], commPage: p[8], pi: +p[9], pe: +p[10] };
});

const raw = readFileSync(SRC, 'utf8');
const parts = raw.split(/(?=<段\/><書 id="n\d+">)/);
const at = parts.findIndex((p) => p.startsWith('<段/><書 id="n') && p.includes('>' + ROOT_TITLE + '</書>'));
if (at < 0) throw new Error('找不到根經 section: ' + ROOT_TITLE);
const headEnd = parts[at].indexOf('</書>') + 4;
const head = parts[at].slice(0, headEnd);
const body = parts[at].slice(headEnd);
const lines = body.split('\n');

// 同一行的多個位置，必須由後往前插，否則前面的插入會讓後面的 offset 位移
const byLine = new Map<number, Link[]>();
for (const l of links) {
  const arr = byLine.get(l.line) ?? [];
  arr.push(l);
  byLine.set(l.line, arr);
}
for (const [ln, arr] of byLine) {
  let line = lines[ln];
  if (line === undefined) { console.warn('bad line', ln); continue; }
  const byCol = new Map<number, Link[]>();
  for (const l of arr) {
    const a = byCol.get(l.col) ?? [];
    a.push(l);
    byCol.set(l.col, a);
  }
  for (const col of [...byCol.keys()].sort((a, b) => b - a)) {
    if (col > line.length) { console.warn('bad col', ln + ':' + col); continue; }
    const tags = byCol.get(col)!.sort((a, b) => a.commNo.localeCompare(b.commNo)).map((l) => {
      const n = SHORT[l.commNo] ?? l.commNo;
      return `<嵌 i="${DB}?${l.commPage}" q="${escAttr(l.quote)}" j="${l.pi}-${l.pe}" n="${n}"/>`;
    }).join('');
    line = line.slice(0, col) + tags + line.slice(col);
  }
  lines[ln] = line;
}

parts[at] = head + lines.join('\n');
// 只保留 header（檔頭）與 T235＋註疏 sections；parts 已按原順序
const header = raw.slice(0, raw.indexOf('<段/>'));
writeFileSync(OUT, header + parts.slice(1).join(''));
console.log(`links=${links.length} lines=${byLine.size} out=${OUT}`);



