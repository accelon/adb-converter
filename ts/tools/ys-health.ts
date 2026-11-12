#!/usr/bin/env bun
/**
 * ys.adb 體檢（2026-11-12）。把 fuyan 那條產線上踩過的坑，逐項回頭問 ys 一次。
 *
 *   bun run tools/ys-health.ts [--adb D:/accelon3/ys.adb]
 *
 * 只讀不寫。輸出六節：
 *   A 標籤平衡（開/閉配對）     B 頁 id（數量、重複、每冊連續性）
 *   C 註號 pg 與實頁             D 圖表數與注號
 *   E 引用 $URL                  F 粗體／楷體
 */
import { existsSync } from 'node:fs';
import { AdbReader, SyncIO } from '../src/accelon26/adb';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => {
  const i = args.indexOf('--' + n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const ADB = opt('adb', 'D:/accelon3/ys.adb');
if (!existsSync(ADB)) { console.error('missing ' + ADB); process.exit(2); }

const nu = (n: number) => n.toLocaleString('en-US');
const r = await AdbReader.open(new SyncIO(ADB));
console.log(`\n=== ${ADB} ===`);
console.log(`dbname=${r.header.dbname}  maxVA=${nu(r.header.maxBlockOffset ?? 0)}  blocks=${nu(r.header.blockCount ?? 0)}  size=${nu(r.header.textSize ?? 0)}`);

// ---- A. 標籤平衡 -----------------------------------------------------------
const tg = r.containers.get('tags');
const counts = new Map<string, number>();
for (let i = 0; i < (tg?.count ?? 0); i++) {
  const name = tg!.names[i] ?? '';
  if (!name) continue;
  counts.set(name, await r.blockListCount('tags', i));
}
const OPEN = ['引', '术', '聯', '註', '釋', '頁', '圖', '表', '粗', '經', '章', '節', '項', '目', '檔'];
console.log('\nA. 標籤平衡（開 / 閉）');
for (const t of OPEN) {
  const o = counts.get(t) ?? 0;
  const c = counts.get('/' + t) ?? 0;
  const flag = o === c ? 'ok' : (t === '檔' || t === '頁' ? 'note' : 'DIFF');
  console.log(`  ${t.padEnd(3)} ${String(o).padStart(7)} / ${String(c).padStart(7)}  ${flag}`);
}
const allTags = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14);
console.log('  最多：' + allTags.map(([k, v]) => `${k}=${nu(v)}`).join('  '));

// ---- B. 頁 id --------------------------------------------------------------
const pg = await r.attributeValues('頁.id');
const ids = pg?.values ?? [];
console.log(`\nB. 頁 id  共 ${nu(ids.length)} 個`);
const seen = new Map<string, number>();
for (const id of ids) seen.set(id, (seen.get(id) ?? 0) + 1);
const dup = [...seen.entries()].filter(([, n]) => n > 1);
console.log(`  重複 ${dup.length} 個` + (dup.length ? '：' + dup.slice(0, 10).map(([k, n]) => `${k}×${n}`).join('，') : ''));
console.log(`  樣本：${ids.slice(0, 6).join(' ')} … ${ids.slice(-4).join(' ')}`);

// 形如 1pa1a / 9p1a / 38p107a
const rx = /^(\d+[a-z]?)p(\d+)([a-c]?)$/;
const byBook = new Map<string, number[]>();
let unparsed = 0;
for (const id of new Set(ids)) {
  const m = rx.exec(id);
  if (!m) { unparsed++; continue; }
  if (m[3]) continue;                       // 只看每頁首列（無 a/b/c）
  const arr = byBook.get(m[1]) ?? [];
  arr.push(Number(m[2]));
  byBook.set(m[1], arr);
}
console.log(`  解不出的 id ${nu(unparsed)}；有頁碼的冊 ${byBook.size}`);
const gaps: string[] = [];
for (const [book, arr] of [...byBook.entries()].sort()) {
  arr.sort((a, b) => a - b);
  const miss: number[] = [];
  for (let i = 1; i < arr.length; i++) {
    for (let k = arr[i - 1] + 1; k < arr[i]; k++) miss.push(k);
  }
  if (arr[0] !== 1) miss.unshift(0);
  if (miss.length) gaps.push(`${book}: 缺 ${miss.slice(0, 8).join(',')}${miss.length > 8 ? `…(${miss.length})` : ''}`);
}
console.log(gaps.length ? '  頁碼不連續：\n    ' + gaps.join('\n    ') : '  頁碼全部連續（每冊由 1 起）');

// ---- C. 註號 pg ------------------------------------------------------------
const npg = await r.attributeValues('註.pg');
console.log(`\nC. <註 pg>  ${nu(npg?.values.length ?? 0)} 個`);
if (npg?.values.length) {
  const vs = npg.values;
  const bad = vs.filter((v) => v && !seen.has(v));
  console.log(`  pg 不在頁 id 集合裡：${bad.length}` + (bad.length ? '，例：' + [...new Set(bad)].slice(0, 8).join(' ') : ''));
  console.log(`  樣本：${vs.slice(0, 8).join(' ')}`);
  console.log(`  空值：${vs.filter((v) => !v).length}`);
}

// ---- D. 圖表 ---------------------------------------------------------------
console.log('\nD. 圖表');
console.log(`  <圖> ${nu(counts.get('圖') ?? 0)}  <表> ${nu(counts.get('表') ?? 0)}`);

// ---- E. 引用 $URL ----------------------------------------------------------
for (const key of ['引.pf', '引.pf1']) {
  const a = await r.attributeValues(key);
  if (a?.values.length) {
    const sx = a.values.slice(0, 4);
    console.log(`\nE. ${key}  ${nu(a.values.length)} 個  樣本：${sx.join(' | ')}`);
  }
}

// ---- F. 粗體／楷體 ---------------------------------------------------------
console.log('\nF. 粗體／楷體');
for (const t of ['粗', '經', '楷', 'b']) console.log(`  <${t}> ${nu(counts.get(t) ?? 0)}`);
