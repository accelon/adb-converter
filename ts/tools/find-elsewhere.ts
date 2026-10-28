#!/usr/bin/env bun
/**
 * 對 broken-quote.tsv 裡「有 q、頁內找不到」的條目，用 accelon 全文檢索引擎
 * 到 taisho.adb 找找看是否出現在別頁。
 *
 *   bun run ts/tools/find-elsewhere.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AdbReader, SyncIO } from '../src/accelon26/adb';
import { SearchSession } from '../src/accelon26/search';
import { VaPaMapper } from '../src/accelon26/vapa';

const ROOT = resolve(import.meta.dir, '../..');
const TSV = resolve(ROOT, 'build/ys-broken-quotes.tsv');
const OUT = resolve(ROOT, 'build/ys-elsewhere.tsv');
const REPORT = resolve(ROOT, 'docs/adb/broken-quote-elsewhere.md');

const isHan = (c: string) => /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(c);
const han = (s: string) => Array.from(s.replace(/&[a-z]+;/g, '')).filter(isHan).join('');
const rows = readFileSync(TSV, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => {
  const [srcPage, line, target, reason, q = ''] = l.split('\t');
  return { srcPage, line: Number(line), target, reason, q };
}).filter((r) => r.reason.startsWith('no-match') && r.q);

const tr = await AdbReader.open(new SyncIO(resolve(ROOT, 'accelon3/taisho.adb')));
const tc = tr.containers.get('tags')!;
const pv = Int32Array.from(await tr.decodeBlockList('tags', tc.names.indexOf('頁')));
const ids = (await tr.attributeValues('頁.id'))!.values;
const pageOfVa = (va: number) => {
  let lo = 0, hi = pv.length - 1, k = 0;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (pv[m] <= va) { k = m; lo = m + 1; } else hi = m - 1; }
  return ids[k] ?? '';
};
const bv = await tr.blocksVirtual();
const pos = new Map<string, { b: number; off: number }[]>();
for (let b = 0; b < bv.length; b++) {
  const s = await tr.sourceText(b);
  let at = s.indexOf('<頁');
  while (at >= 0) {
    const gt = s.indexOf('>', at);
    if (gt > at) {
      const id = /id="([^"]*)"/.exec(s.slice(at, gt + 1))?.[1];
      if (id) { const a = pos.get(id) ?? []; a.push({ b, off: at }); pos.set(id, a); }
    }
    at = s.indexOf('<頁', at + 2);
  }
}
const pageCache = new Map<string, string[]>();
async function pageTexts(id: string): Promise<string[]> {
  const hit = pageCache.get(id); if (hit) return hit;
  const out: string[] = [];
  for (const p of pos.get(id) ?? []) {
    let t = (await tr.sourceText(p.b)).slice(p.off);
    for (let b = p.b + 1; t.indexOf('<頁 ') < 0 && b < bv.length && t.length < 4500; b++) t += await tr.sourceText(b);
    const cut = t.indexOf('<頁 ', 1);
    if (cut > 0) t = t.slice(0, cut);
    const gt = t.indexOf('>'); if (gt >= 0) t = t.slice(gt + 1);
    out.push(han(t));
  }
  pageCache.set(id, out); return out;
}
async function hasFull(id: string, q: string): Promise<boolean> {
  for (const t of await pageTexts(id)) if (t.includes(q)) return true;
  return false;
}

const session = new SearchSession(tr);
await session.init();

type Out = { srcPage: string; line: number; oldTarget: string; q: string; found: boolean; newTarget: string; same: boolean; prefix: number; full: boolean };
const out: Out[] = [];
let found = 0, same = 0, other = 0, strong = 0, strongOther = 0;
for (let i = 0; i < rows.length; i++) {
  const r = rows[i];
  const qh0 = han(r.q);
  let nr = '', ok = false, used = 0;
  for (const L of [30, 24, 18, 14, 10, 8, 6]) {
    const qh = qh0.slice(0, L);
    if (qh.length < 4) continue;
    try {
      const res = await session.search(qh, 3);
      if (res.hits.length) { nr = pageOfVa(res.hits[0].va); ok = true; used = qh.length; break; }
    } catch { /* ignore */ }
  }
  let full = false;
  if (ok) {
    found++;
    if (nr === r.target) same++; else other++;
    full = qh0.length <= 30 ? await hasFull(nr, qh0) : false;
    if (full) { strong++; if (nr !== r.target) strongOther++; }
  }
  out.push({ srcPage: r.srcPage, line: r.line, oldTarget: r.target, q: r.q, found: ok, newTarget: nr, same: ok && nr === r.target, prefix: used, full });
  if ((i + 1) % 50 === 0) console.log('...', i + 1, '/', rows.length, 'found', found, 'strong', strong);
}
writeFileSync(OUT, ['src\tline\told\tq\tfound\tnew\tsame\tprefix\tfull'].concat(out.map((x) => [x.srcPage, x.line, x.oldTarget, x.q, x.found ? '1' : '0', x.newTarget, x.same ? '1' : '0', x.prefix, x.full ? '1' : '0'].join('\t'))).join('\n') + '\n');
const esc = (s: string) => s.replace(/\|/g, '\\|').slice(0, 70);
const table = (xs: Out[]) => `| 來源頁 | 行 | 原目標 | 新目標 | 前綴 | 全文 | q |\n|---|---:|---|---|---:|---|---|\n` +
  xs.map((x) => `| ${x.srcPage} | ${x.line} | ${x.oldTarget} | ${x.newTarget || '—'} | ${x.prefix} | ${x.full ? '是' : '否'} | ${esc(x.q)} |`).join('\n') + '\n';
let rep = `# ${rows.length} 條有 q 的 broken quote 全文檢索結果\n\n`;
rep += `> 工具：\`bun run ts/tools/find-elsewhere.ts\`（accelon26 SearchSession，查 \`taisho.adb\`）\n`;
rep += `> 原始清單：\`build/ys-broken-quotes.tsv\` 的 \`no-match\` ${rows.length} 條。\n`;
rep += `> 搜尋方式：全句 30 字 → 24 → 18 → 14 → 10 → 8 → 6 字前綴，取第一個命中。\n\n`;
rep += `| 結果 | 條數 |\n|---|---:|\n`;
rep += `| 找到，且整句 q 真的在該頁 | ${strong} |\n`;
rep += `| 其中在別頁（可改 i） | ${strongOther} |\n`;
rep += `| 找到，但只是前綴命中（需人工看） | ${found - strong} |\n`;
rep += `| 找不到 | ${rows.length - found} |\n`;
rep += `| **合計** | **${rows.length}** |\n\n`;
rep += `## 整句在別頁找到（可直接改 i）\n\n` + table(out.filter((x) => x.full && !x.same));
rep += `\n## 整句在相同頁找到（頁內位置不同，可補 j）\n\n` + table(out.filter((x) => x.full && x.same));
rep += `\n## 只有前綴命中（可能誤中，需人工）\n\n` + table(out.filter((x) => x.found && !x.full));
rep += `\n## 完全找不到\n\n` + table(out.filter((x) => !x.found));
writeFileSync(REPORT, rep);
console.log(`total ${rows.length}；found ${found}（same ${same}、other ${other}）；strong ${strong}（strongOther ${strongOther}）；missing ${rows.length - found}`);
console.log(`wrote ${OUT}\nwrote ${REPORT}`);
process.exit(0);
