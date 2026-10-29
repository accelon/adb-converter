#!/usr/bin/env bun
/**
 * 產生「金剛經注疏讀本」的**作者源檔** jingqun/jingang.txt。
 *
 * 源檔只有：
 *   - <融 i="jingang?8p748c"/>      把大正藏那一頁經文融入本文（Obsidian ![[]]）
 *   - <嵌 e="g004" q="…" t="…" n="5 家注疏"/>  段落後的注疏群
 *   - 必要的說明文字
 *
 * 不在源檔放經文本身；build-notes.ts 建置時才把 <融> 展開、把 <嵌> 定位。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const HERE = import.meta.dir;
const ROOT = resolve(HERE, '..');
const FULL = join(ROOT, 'build/jingqun/jingang.txt');
const GROUPS = join(ROOT, 'build/jingqun/jingang-groups.tsv');
const OUT = join(ROOT, 'jingqun/jingang.txt');

const escAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const raw = readFileSync(FULL, 'utf8');
// 讀本不沿用大正藏的冊／部目錄；書就是第一層。
const head = [
  '<檔 n="jingang.xml">',
  '<集 c="hidden">金剛經注疏讀本</集>',
  '<英文名>Jingang Notes</英文名>',
  '<樹 s="*" t="書">金剛經</樹>',
  '<樹 s="$書" pf="$頁.id;)" sf="-$書.id;">書名</樹>',
  '<樹 s="*詞">全文</樹>',
  '<隱><引>《$書;》：「$_;」( $*頁; )</引><摘要頭>$書;($頁;)</摘要頭></隱>',
  '</檔>',
].join('\n');
const parts = raw.split(/(?=<段\/><書 id="n\d+">)/);
const t = parts.find((p) => p.startsWith('<段/><書 id="n1">'));
if (!t) throw new Error('找不到 T235 section');
const body = t.slice(t.indexOf('</書>') + 4);
const pageMatches = [...body.matchAll(/<頁 id="([^"]+)"\/>/g)];
const pages = pageMatches.map((m) => m[1]);
const pageHan = new Map<string, number>();
const pageStart = new Map<string, number>();
let running = 0;
for (let i = 0; i < pageMatches.length; i++) {
  const start = pageMatches[i].index!;
  const end = i + 1 < pageMatches.length ? pageMatches[i + 1].index! : body.length;
  const text = body.slice(start, end).replace(/<[^>]*>/g, '');
  const n = [...text].filter((c) => /[\u3400-\u9fff\uf900-\ufaff]/.test(c)).length;
  pageHan.set(pageMatches[i][1], n);
  pageStart.set(pageMatches[i][1], running);
  running += n;
}

const groups = readFileSync(GROUPS, 'utf8').split(/\r?\n/).slice(1).filter(Boolean).map((l) => {
  const p = l.split('\t');
  return { page: p[2], start: +p[3], len: +p[4], t: p[10], n: +p[11] };
});

const out: string[] = [
  head,
  '<段/><書 id="n1">金剛經注疏讀本</書>',
  '<卷>金剛般若波羅蜜經</卷>',
  '金剛經注疏讀本',
  '本讀本以《金剛般若波羅蜜經》正文為底本；',
  '段落後標出大正藏註疏家數，點開可就地讀各家解釋。',
  '',
];
for (const page of pages) {
  // 空殼：建置時若裡面沒有文字，才從母 adb 抽頁填入；用戶可自行編輯、保留指針。
  out.push(`<融 i="taisho?${page}" j="0-${pageHan.get(page) ?? 0}"></融>`);
  for (const g of groups.filter((x) => x.page === page)) {
    const rel = Math.max(0, g.start - (pageStart.get(page) ?? 0));
    const end = Math.min(pageHan.get(page) ?? rel + g.len, rel + g.len);
    // 與 <融>／<聯> 同一套：i=頁，j=頁內漢字範圍。
    out.push(`<嵌 i="taisho?${page}" j="${rel}-${end}"/>`);
  }
  out.push('');
}
writeFileSync(OUT, out.join('\n'));
console.log(`pages=${pages.length} groups=${groups.length} wrote ${OUT}`);
