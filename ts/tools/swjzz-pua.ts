#!/usr/bin/env bun
/**
 * 把 swjzz.adb 的「缺字」整理成 `docs/adb/pua.md`（＋可填寫的 `build/pua.tsv`）。
 *
 *   bun run ts/tools/swjzz-pua.ts [--adb accelon3/swjzz.adb]
 *
 * 「缺字」分四類：
 *   1. IDS 裡的私用區字（PUA U+E000–U+F8FF）：原檔用 PUA 表示 Unicode 沒有的部件
 *   2. IDS 裡的「？」（原檔就缺那個部件）
 *   3. 字頭本身就是「（图164A-01）」這種只有圖的佔位（12 個）
 *   4. 字頭是 U+FFFD（1 個）
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readAdbText } from '../src/adbtext';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const ROOT = resolve(import.meta.dir, '../..');
const ADB = args.includes('--adb') ? resolve(opt('adb', '')) : resolve(ROOT, 'accelon3/swjzz.adb');
const OUT = resolve(ROOT, 'docs/adb/pua.md');
const TSV = resolve(ROOT, 'build/pua.tsv');

const isPua = (cp: number) => cp >= 0xe000 && cp <= 0xf8ff;
const hex = (cp: number) => 'U+' + cp.toString(16).toUpperCase().padStart(4, '0');

interface Occ {
  pua: string;
  ids: string;
  head: string;
  id: string;
  img: string;
  line: string;
}

const t = readAdbText(ADB);
const occ: Occ[] = [];
const puaIds: Occ[] = [];                   // 3. 字頭是（图…）
let fffdHead = 0;
let qIds = 0;                               // IDS 內含 ？
const qList: Occ[] = [];
let cur = { head: '', id: '', img: '', text: '' };

for (const line of t.lines) {
  const h = /^<字(?: ([^>]*))?>([\s\S]*?)<\/字>/.exec(line);
  if (h) {
    const attrs = h[1] ?? '';
    cur = {
      head: h[2],
      id: (/\bid="([^"]*)"/.exec(attrs)?.[1]) ?? '',
      img: (/\bimg="([^"]*)"/.exec(attrs)?.[1]) ?? '',
      text: '',
    };
    if (/^（图/.test(cur.head)) puaIds.push({ pua: '', ids: '', head: cur.head, id: cur.id, img: cur.img, line: '' });
    if (cur.head.includes('\uFFFD')) fffdHead++;
    continue;
  }
  for (const m of line.matchAll(/<構形>([\s\S]*?)<\/構形>/g)) {
    const ids = m[1];
    const priv = [...ids].map((c) => c.codePointAt(0)!).filter(isPua);
    for (const cp of new Set(priv)) {
      occ.push({ pua: hex(cp), ids, head: cur.head, id: cur.id, img: cur.img, line: line.slice(0, 160) });
    }
    if (/[？?]/.test(ids)) {
      qIds++;
      qList.push({ pua: '', ids, head: cur.head, id: cur.id, img: cur.img, line: line.slice(0, 160) });
    }
  }
}

const byPua = new Map<string, Occ[]>();
for (const o of occ) {
  const list = byPua.get(o.pua) ?? [];
  list.push(o);
  byPua.set(o.pua, list);
}
const puaRows = [...byPua.entries()].sort((a, b) => b[1].length - a[1].length);
const headsOf = (list: Occ[]) => [...new Set(list.map((o) => o.head))];

const md: string[] = [];
md.push('# 缺字清單（PUA／？／只有圖／U+FFFD）');
md.push('');
md.push(`> 由 \`ts/tools/swjzz-pua.ts\` 掃 \`${ADB}\` 產生；之後要逐條查原書、換成真字或 Unicode 部件。`);
md.push('> 這一頁只**記錄**，不改庫。');
md.push('');
md.push('## 0. 現況');
md.push('');
md.push('| 類別 | 數量 |');
md.push('|---|---|');
md.push(`| IDS 內含私用區字（PUA） | ${occ.length} 處、${puaRows.length} 個不同的 PUA、涉及 ${new Set(occ.map((o) => o.head)).size} 個字頭 |`);
md.push(`| IDS 內含「？」（原檔缺部件） | ${qIds} 處 |`);
md.push(`| 字頭是「（图…）」（只有圖） | ${puaIds.length} 個 |`);
md.push(`| 字頭是 U+FFFD | ${fffdHead} 個 |`);
md.push('');
md.push('## 1. PUA 一覽（依出現次數）');
md.push('');
md.push('| # | PUA | 次數 | 出現在哪個 IDS | 涉及字頭 |');
md.push('|---|---|---|---|---|');
puaRows.forEach(([pua, list], i) => {
  const ids = [...new Set(list.map((o) => o.ids))];
  md.push(`| ${i + 1} | \`${pua}\` | ${list.length} | ${ids.map((x) => '`' + x + '`').join(' ')} | ${headsOf(list).slice(0, 12).join('')} |`);
});
md.push('');
md.push('## 2. 逐條（字頭 / 字 id / 書影 / IDS）');
md.push('');
md.push('| 字頭 | 字 id | img（原書頁） | IDS | PUA |');
md.push('|---|---|---|---|---|');
for (const o of occ) md.push(`| ${o.head || '（无）'} | ${o.id} | ${o.img} | \`${o.ids}\` | ${o.pua} |`);
md.push('');
md.push('## 3. IDS 裡有「？」的');
md.push('');
qList.forEach((o) => md.push(`* ${o.head}（${o.id}，img ${o.img}）：\`${o.ids}\``));
md.push('');
md.push('## 4. 字頭本身就是佔位');
md.push('');
md.push('| 字頭 | 字 id | img |');
md.push('|---|---|---|');
puaIds.forEach((o) => md.push(`| ${o.head} | ${o.id} | ${o.img} |`));
md.push('');
md.push('## 5. 之後怎麼處理（建議）');
md.push('');
md.push('1. **先查書影**：每個 `<字>` 都有 `img`（如 `001a-01`，指 kanji-database 的頁面影像），');
md.push('   PUA 的那個部件多半可以直接從原書認出來。');
md.push('2. **查 cjkvi 的 PUA 對照**：`swjz.xml` 的 PUA 是 cjkvi 自訂的私用區，');
md.push('   他們的 `swjz.xsl`／字型（SW.ttf）裡有對應表；對到的話可以直接換成 Unicode 部件。');
md.push('3. **能組就組**：如果部件都在 Unicode，IDS 本身就已經是答案，只是顯示時要組字');
md.push('   （例如 `⿱艹X` 的 X 換成真字後，IDS 就完整了）。');
md.push('4. **換不掉的留白**：標成 `□` 並保留 `pua.tsv` 的 `suggestion` 欄，之後人工補。');
md.push('');
md.push('可填寫的清單：`build/pua.tsv`（欄位：pua, 次數, IDS, 字頭, 字 id, img, 建議）。');
md.push('');
writeFileSync(OUT, md.join('\n'), 'utf8');

const tsv = ['pua\t次數\tIDS\t字頭\t字id\timg\t建議'];
for (const [pua, list] of puaRows) {
  const ids = [...new Set(list.map((o) => o.ids))].join(' ');
  const heads = headsOf(list).join('');
  tsv.push([pua, list.length, ids, heads, list[0].id, list[0].img, ''].join('\t'));
}
writeFileSync(TSV, tsv.join('\n') + '\n', 'utf8');

console.log(`${ADB}`);
console.log(`PUA ${occ.length} 處／${puaRows.length} 種、？ ${qIds} 處、（图…）${puaIds.length} 個、U+FFFD ${fffdHead} 個`);
console.log(`wrote ${OUT}`);
console.log(`wrote ${TSV}`);
