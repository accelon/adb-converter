#!/usr/bin/env bun
/**
 * 找出兩個（或多個）adb **都引用到**的大正藏經典，以及共同的頁。
 *
 *   bun run tools/xref-shared.ts [options] <a.adb> <b.adb> [...]
 *
 * 只讀各庫的 `聯.i` 屬性與大正藏的 `頁.id`／`書` 表，不讀全文。
 * 例：
 *   bun run tools/xref-shared.ts accelon3/taixu.adb accelon3/ys.adb
 *   bun run tools/xref-shared.ts accelon3/taixu.adb accelon3/ys.adb --book 金剛 --md build/shared.md
 *
 * 選項：
 *   --taisho <path>  大正藏 adb（預設 accelon3/taisho.adb）
 *   --book <text>    額外列出書名含這段文字的「逐頁」明細（可重複）
 *   --md <path>      另存一份 markdown 表格
 *   --min <n>        只列共同頁數 ≥ n 的書（預設 1）
 */
import { existsSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { AdbReader, SyncIO } from '../src/accelon26/adb';

const ROOT = resolve(import.meta.dir, '../..');
const args = process.argv.slice(2);
const opt = (n: string, d?: string): string | undefined => {
  const i = args.indexOf('--' + n);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};
const TAISHO = resolve(ROOT, opt('taisho', 'accelon3/taisho.adb')!);
const MD = opt('md');
const MIN = Number(opt('min', '1')) || 1;
const BOOKS: string[] = [];
for (let i = 0; i < args.length; i++) if (args[i] === '--book' && args[i + 1]) BOOKS.push(args[i + 1]);
const paths = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--taisho' && args[i - 1] !== '--md' && args[i - 1] !== '--min' && args[i - 1] !== '--book')
  .map((p) => resolve(ROOT, p));
if (paths.length < 2) { console.error('需要至少兩個 adb'); process.exit(2); }
for (const p of [...paths, TAISHO]) if (!existsSync(p)) { console.error('missing ' + p); process.exit(2); }

interface Target { db: string; anchor: string }
async function targets(path: string): Promise<{ name: string; cname: string; pages: Map<string, number> }> {
  const r = await AdbReader.open(new SyncIO(path));
  const av = await r.attributeValues('聯.i');
  const pages = new Map<string, number>();
  if (av) {
    for (const v of av.values) {
      const q = v.indexOf('?');
      if (q <= 0) continue;
      const db = v.slice(0, q), anchor = v.slice(q + 1);
      if (db !== 'taisho') continue;
      pages.set(anchor, (pages.get(anchor) ?? 0) + 1);
    }
  }
  return { name: r.header.dbname, cname: r.header.dbcname || r.header.dbname, pages };
}

const taisho = await AdbReader.open(new SyncIO(TAISHO));
const tagC = taisho.containers.get('tags')!;
const pv = Int32Array.from(await taisho.decodeBlockList('tags', tagC.names.indexOf('頁')));
const pageIds = (await taisho.attributeValues('頁.id'))!.values;
const bv = Int32Array.from(await taisho.decodeBlockList('tags', tagC.names.indexOf('書')));
const bookTitles = await taisho.cachedStrings('書');
const pageIdx = new Map<string, number>();
pageIds.forEach((v, i) => { if (!pageIdx.has(v)) pageIdx.set(v, i); });
function bookAtPage(id: string): string {
  const i = pageIdx.get(id);
  if (i === undefined) return '';
  const va = pv[i];
  let lo = 0, hi = bv.length - 1, k = 0;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (bv[m] <= va) { k = m; lo = m + 1; } else hi = m - 1; }
  return bookTitles[k] ?? '';
}

const sources = [];
for (const p of paths) sources.push({ file: basename(p), ...(await targets(p)) });
let shared = new Set<string>(sources[0].pages.keys());
for (const s of sources.slice(1)) shared = new Set([...shared].filter((p) => s.pages.has(p)));
const sharedPages = [...shared];
console.log(`來源：${sources.map((s) => `${s.cname}（${s.pages.size} 頁）`).join('、')}`);
console.log(`共同引用的大正頁：${sharedPages.length}`);

interface Row { book: string; pages: number; counts: number[] }
const byBook = new Map<string, Row>();
for (const p of sharedPages) {
  const book = bookAtPage(p) || '(未知)';
  const row = byBook.get(book) ?? { book, pages: 0, counts: sources.map(() => 0) };
  row.pages++;
  for (let i = 0; i < sources.length; i++) row.counts[i] += sources[i].pages.get(p) ?? 0;
  byBook.set(book, row);
}
const rows = [...byBook.values()].filter((r) => r.pages >= MIN).sort((a, b) => b.pages - a.pages || b.counts.reduce((x, y) => x + y, 0) - a.counts.reduce((x, y) => x + y, 0));
console.log(`共同的經：${rows.length} 部\n`);
const header = ['共同頁', ...sources.map((s) => s.name + ' 連結'), '書名'];
const widths = header.map((h, i) => Math.max(...[h, ...rows.map((r) => String(i === 0 ? r.pages : i === header.length - 1 ? r.book : r.counts[i - 1]))].map((s) => [...s].length)));
const fmt = (cells: string[]) => cells.map((c, i) => (i === 0 || i === cells.length - 1 ? c : c.padStart(widths[i]))).join('  ');
console.log(fmt(header));
for (const r of rows) console.log(fmt([String(r.pages), ...r.counts.map(String), r.book]));

for (const needle of BOOKS) {
  const hitRows = sharedPages.filter((p) => (bookAtPage(p) || '').includes(needle));
  if (!hitRows.length) { console.log(`\n（沒有書名含「${needle}」的共同頁）`); continue; }
  console.log(`\n== 書名含「${needle}」的逐頁明細（${hitRows.length} 頁）==`);
  for (const p of hitRows) {
    const counts = sources.map((s) => s.pages.get(p) ?? 0);
    console.log(`  ${p}  ${counts.map((n, i) => sources[i].name + ' ' + n).join('  ')}  ${bookAtPage(p)}`);
  }
}

if (MD) {
  const lines: string[] = [];
  lines.push('# 共同引用的大正藏經典', '');
  lines.push(`來源：${sources.map((s) => `**${s.cname}**（${s.pages.size} 頁）`).join('、')}`);
  lines.push('', `共同引用的大正頁：**${sharedPages.length}**；共同經典：**${rows.length}** 部。`);
  lines.push('', '> 數字是 `<聯>` 連結數（同一頁可能有多筆引用）；由 `ts/tools/xref-shared.ts` 產生。', '');
  lines.push('| 共同頁 | ' + sources.map((s) => s.cname).join(' | ') + ' | 書名 |');
  lines.push('|---:|---:|---:|---|');
  for (const r of rows) lines.push(`| ${r.pages} | ${r.counts.join(' | ')} | ${r.book} |`);
  for (const needle of BOOKS) {
    const hitRows = sharedPages.filter((p) => (bookAtPage(p) || '').includes(needle));
    if (!hitRows.length) continue;
    lines.push('', `## ${needle}：共同頁明細`, '', '| 頁 | ' + sources.map((s) => s.cname).join(' | ') + ' | 書名 |', '|---|---:|---:|---|');
    for (const p of hitRows) lines.push(`| ${p} | ${sources.map((s) => s.pages.get(p) ?? 0).join(' | ')} | ${bookAtPage(p)} |`);
  }
  writeFileSync(resolve(ROOT, MD), lines.join('\n') + '\n');
  console.log('\n寫出 ' + MD);
}
process.exit(0);
