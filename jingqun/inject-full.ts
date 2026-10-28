#!/usr/bin/env bun
/**
 * 把金剛經的 <嵌> 插進「完整」tei-all.txt 的 T235 section，產生
 * build/tei-all-embed.txt（給 tei-pack 打包成 taisho-85-embed.adb）。
 *
 * 用法：
 *   bun run jingqun/inject-full.ts
 *   bun run ts/tools/tei-pack.ts build/tei-all-embed.txt build/taisho-85-embed.adb taisho 大正新脩大藏經 logo/taisho_logo.png ""
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const HERE = import.meta.dir;
const ROOT = resolve(HERE, '..');
const DB = process.env.EMBED_DB || 'taisho';
const ROOT_TITLE = process.env.EMBED_ROOT || '金剛般若波羅蜜經';
const SRC = join(ROOT, 'build/tei-all.txt');
const LINKS = join(ROOT, 'build/jingqun', `${process.env.EMBED_LINKS || 'jingang'}-links.tsv`);
const OUT = join(ROOT, 'build/tei-all-embed.txt');

const SHORT: Record<string, string> = {
  '1510a': '無著論', '1511': '天親論', '1512': '金剛仙',
  '1515': '功德施', '1698': '智顗疏', '1699': '吉藏疏',
  '1700': '贊述', '1701': '纂要', '1702': '刊定記', '1703': '註解',
};
const escAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

interface Link { line: number; col: number; commNo: string; commPage: string; pi: number; pe: number; quote: string }
const links: Link[] = readFileSync(LINKS, 'utf8').split(/\r?\n/).slice(1).filter(Boolean).map((l) => {
  const p = l.split('\t');
  return { line: +p[3], col: +p[4], quote: p[5], commNo: p[6], commPage: p[8], pi: +p[9], pe: +p[10] };
});

const raw = readFileSync(SRC, 'utf8');
const marker = '<段/><書 id="n245">' + ROOT_TITLE + '</書>';
const at = raw.indexOf(marker);
if (at < 0) throw new Error('找不到 ' + ROOT_TITLE);
const next = raw.indexOf('<段/><書 id=', at + marker.length);
const section = raw.slice(at, next < 0 ? raw.length : next);
const headEnd = section.indexOf('</書>') + 4;
const head = section.slice(0, headEnd);
const body = section.slice(headEnd);
const lines = body.split('\n');

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

const replaced = head + lines.join('\n');
writeFileSync(OUT, raw.slice(0, at) + replaced + raw.slice(next < 0 ? raw.length : next));
console.log(`links=${links.length} lines=${byLine.size} wrote ${OUT}`);
