#!/usr/bin/env bun
/**
 * 產生「大正藏研究」作者源檔：金剛經＋法華經＋大日經（含深層注疏指針）。
 * 源檔只有 <融>／<嵌>／說明；經文建置時從 taisho 抽。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const OUT = join(ROOT, 'jingqun/taisho-study.txt');
const GROUPS_OUT = join(ROOT, 'build/jingqun/study-groups.tsv');

const TEXTS = [
  { id: 'n1', label: '金剛般若波羅蜜經', file: 'jingang.txt', groups: 'jingang-groups.tsv', child: '分.', patch: 'jingang.tsv' },
  { id: 'n2', label: '妙法蓮華經', file: 'fahua.txt', groups: 'fahua-groups.tsv', child: '品.', patch: 'fahua.tsv' },
  { id: 'n3', label: '大毘盧遮那成佛神變加持經', file: 'dari.txt', groups: 'dari-groups.tsv', child: '品.', patch: 'dari.tsv' },
];
const HAN = /[\u3400-\u9fff\uf900-\ufaff]/;

interface Heading { page: string; rel: number; tag: string; text: string }

/** 把 body 裡的 <卷>／<品> 掛到所在頁，並記下它在該頁的 Han 位置。 */
function headingsOf(body: string, tags: string[], firstPage: string): Heading[] {
  const out: Heading[] = [];
  let page = '';
  let pageAt = 0;
  const re = /<頁 id="([^"]+)"\/>|<(卷|品|分)>([^<]*)<\/\2>/g;
  for (const m of body.matchAll(re)) {
    if (m[1]) {
      if (m[1] !== page) { page = m[1]; pageAt = m.index! + m[0].length; }
      continue;
    }
    if (m[2] && tags.includes(m[2])) {
      const rel = [...body.slice(pageAt, m.index!)
        .replace(/<(卷|品|分)>[\s\S]*?<\/\1>/g, '')
        .replace(/<[^>]*>/g, '')].filter((c) => HAN.test(c)).length;
      out.push({ page: page || firstPage, rel: page ? rel : 0, tag: m[2], text: m[3] });
    }
  }
  return out;
}

/** 目錄節點名 patch：左邊是 TEI 原文，右邊是顯示名（例如去掉經名）。 */
function tocPatch(file: string): Map<string, string> {
  const map = new Map<string, string>();
  const text = readFileSync(join(ROOT, 'jingqun/toc-patch', file), 'utf8');
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const [raw, display] = line.split('\t');
    if (raw && display) map.set(raw, display);
  }
  return map;
}

function jingangFen(firstPage: string): Heading[] {
  const tsv = readFileSync(join(ROOT, 'build/jingqun/jingang-fen.tsv'), 'utf8').split(/\r?\n/).filter(Boolean);
  return tsv.map((line) => {
    const p = line.split('\t');
    return { page: p[2] || firstPage, rel: Math.max(0, +(p[3] || 0)), tag: '分', text: p[1] || '' };
  }).filter((h) => !!h.text);
}

const header = [
  '<檔 n="study.xml">',
  '<集 c="hidden">大正藏研究</集>',
  '<英文名>Taisho Study</英文名>',
  '<樹 s="*" t="書">大正藏研究</樹>',
  '<樹 s="$書" pf="$頁.id;)" sf="-$書.id;">書名</樹>',
  '<隱><引>《$書;》：「$_;」( $*頁; )</引><摘要頭>$書;($頁;)</摘要頭></隱>',
  '</檔>',
];
const lines = [...header];
const groupLines: string[] = ['page\trel\tend\tq\tt\tn'];
const seenAnn = new Set<string>();

for (const tx of TEXTS) {
  const raw = readFileSync(join(ROOT, 'build/jingqun', tx.file), 'utf8');
  const parts = raw.split(/(?=<段\/><書 id="n\d+">)/);
  const sec = parts.find((p) => p.startsWith('<段/><書 id="n') && p.includes('>' + tx.label + '</書>'));
  if (!sec) throw new Error('missing ' + tx.label);
  const body = sec.slice(sec.indexOf('</書>') + 4);
  const ms = [...body.matchAll(/<頁 id="([^"]+)"\/>/g)];
  const pageOrder: string[] = [];
  const pageFirstAt = new Map<string, number>();
  for (const m of ms) {
    if (!pageFirstAt.has(m[1])) {
      pageFirstAt.set(m[1], m.index!);
      pageOrder.push(m[1]);
    }
  }
  const pageHan = new Map<string, number>();
  const pageStart = new Map<string, number>();
  let running = 0;
  for (let i = 0; i < pageOrder.length; i++) {
    const page = pageOrder[i];
    const start = pageFirstAt.get(page)!;
    const end = i + 1 < pageOrder.length ? pageFirstAt.get(pageOrder[i + 1])! : body.length;
    const text = body.slice(start, end)
      .replace(/<(卷|品|分)>[\s\S]*?<\/\1>/g, '')
      .replace(/<[^>]*>/g, '');
    const n = [...text].filter((c) => HAN.test(c)).length;
    pageHan.set(page, n);
    pageStart.set(page, running);
    running += n;
  }
  const firstPage = pageOrder[0] ?? '';
  let headings = tx.id === 'n2'
    ? headingsOf(body, ['品'], firstPage)
    : tx.id === 'n3' ? headingsOf(body, ['品'], firstPage) : [];
  if (tx.id === 'n1') headings = jingangFen(firstPage);
  const patch = tocPatch(tx.patch);
  for (const h of headings) h.text = patch.get(h.text) ?? h.text;
  const byPage = new Map<string, Heading[]>();
  for (const h of headings) {
    if (!byPage.has(h.page)) byPage.set(h.page, []);
    byPage.get(h.page)!.push(h);
  }
  lines.push(`<段/><書 id="${tx.id}" t="${tx.child}">${tx.label}</書>`, '');
  const groups = readFileSync(join(ROOT, 'build/jingqun', tx.groups), 'utf8').split(/\r?\n/).slice(1).filter(Boolean);
  for (const g of groups) {
    const p = g.split('\t');
    const page = p[2];
    const rel = Math.max(0, +p[3] - (pageStart.get(page) ?? 0));
    const end = Math.min(pageHan.get(page) ?? rel + +p[4], rel + +p[4]);
    groupLines.push([page, rel, end, p[9], p[10], p[11]].join('\t'));
  }
  for (const page of pageOrder) {
    const pageEnd = pageHan.get(page) ?? 0;
    let cursor = 0;
    const hs = [...(byPage.get(page) ?? [])].sort((a, b) => a.rel - b.rel);
    for (const h of hs) {
      const rel = Math.max(cursor, Math.min(h.rel, pageEnd));
      if (rel > cursor) lines.push(`<融 i="taisho?${page}" j="${cursor}-${rel}"></融>`);
      lines.push(`<${h.tag}>${h.text}</${h.tag}>`);
      cursor = rel;
    }
    if (cursor < pageEnd) lines.push(`<融 i="taisho?${page}" j="${cursor}-${pageEnd}"></融>`);
    if (pageEnd === 0) lines.push(`<融 i="taisho?${page}" j="0-0"></融>`);
    for (const g of groups) {
      const p = g.split('\t');
      if (p[2] !== page) continue;
      const rel = Math.max(0, +p[3] - (pageStart.get(page) ?? 0));
      const end = Math.min(pageHan.get(page) ?? rel + +p[4], rel + +p[4]);
      const key = `${page}:${rel}-${end}`;
      if (seenAnn.has(key)) continue;
      seenAnn.add(key);
      lines.push(`<嵌 i="taisho?${page}" j="${rel}-${end}"/>`);
    }
    lines.push('');
  }
}
writeFileSync(OUT, lines.join('\n'));
writeFileSync(GROUPS_OUT, groupLines.join('\n') + '\n');
console.log(`texts=${TEXTS.length} groups=${groupLines.length - 1} wrote ${OUT}`);

