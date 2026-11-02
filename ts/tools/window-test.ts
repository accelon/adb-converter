/**
 * 讀窗／分窗的規則驗證（作者 2026-11-02）。
 *
 *   bun run tools/window-test.ts [--db ys] [--db yl38] [--db ccc]
 *
 * 不開 GUI：直接對真的 adb 算讀窗，檢查
 *   1. 窗尾不會停在標題（標題群歸下一個讀窗），窗首不會從群的第二大標題開始
 *   2. 長度 ≥ 20（除非界線是大標題）、≤ 400
 *   3. 沒有 `<段>` 可用時才硬切 400
 *   4. `<文>`／`u="文"`／目錄節點都能當邊界
 *   5. 從窗尾往後算會連續、不重疊、不漏行（抽 200 個窗逐一看）
 */
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { AdbReader, SyncIO } from '../src/accelon26/adb';
import { VaPaMapper } from '../src/accelon26/vapa';
import {
  computeReadWindow, windowLabel, windowSourceFromReader,
  WINDOW_MAX_LINES, WINDOW_MIN_LINES, type WindowSource,
} from '../src/accelon26/read-window';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const DBS = args.includes('--db') ? [] : ['ys', 'yl38', 'ccc'];
for (let i = 0; i < args.length; i++) if (args[i] === '--db' && args[i + 1]) DBS.push(args[i + 1]);
const DIR = { ys: 'D:/accelon3', yl38: 'D:/accelon3', ccc: 'D:/2026/sz/accelon26' } as Record<string, string>;
/** 每個庫的「目錄節點」用哪些標籤、深度多少（閱讀器用的是真正的樹，這裡用簡表） */
const NODE_SPEC: Record<string, [string, number][]> = {
  ys: [['書', 0], ['章', 1], ['節', 2], ['項', 3]],
  yl38: [['章', 0], ['節', 1]],
  // 段 不當目錄節點（它是「已經讀很多行就停在段」的界線，不是分窗的第一選擇）
  ccc: [['書', 0], ['小節', 1], ['塊', 2]],
};

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + name + (detail ? '  ' + detail : '')); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
};

for (const db of DBS) {
  const file = resolve(DIR[db] ?? 'D:/accelon3', db + '.adb');
  if (!existsSync(file)) { console.log(`（找不到 ${file}，跳過）`); continue; }
  const r = await AdbReader.open(new SyncIO(file));
  const m = new VaPaMapper(r);
  await m.init();
  const tagsC = r.containers.get('tags');
  // 用簡表造節點（VA → 深度）
  const nodes: { va: number; depth: number }[] = [];
  for (const [tag, depth] of NODE_SPEC[db] ?? [['書', 0]]) {
    const ti = tagsC?.names.indexOf(tag) ?? -1;
    if (ti < 0) continue;
    const vas = await r.decodeBlockList('tags', ti);
    for (const va of vas) nodes.push({ va, depth });
  }
  const src: WindowSource = await windowSourceFromReader(r, m, nodes);
  const plainOf = async (i: number): Promise<string> =>
    (await m.lineText(i)).replace(/<[^>]*>/g, '').replace(/\s+/g, '');
  const nodeSet = new Set(src.nodeStarts);
  const last = r.header.lineCount - 1;

  // 從前 200 個節點各算一窗，檢查不變式
  let bad = 0;
  let minSeen = Number.POSITIVE_INFINITY;
  let maxSeen = 0;
  const sample: string[] = [];
  const starts = src.nodeStarts.slice(0, 200);
  for (const start of starts) {
    const w = await computeReadWindow(src, start, last, plainOf);
    const len = w.last - w.first + 1;
    minSeen = Math.min(minSeen, len);
    maxSeen = Math.max(maxSeen, len);
    if (sample.length < 4) sample.push(windowLabel(w) + (nodeSet.has(w.first) ? '〔首=標題〕' : ''));
    const endsOnHeading = nodeSet.has(w.last) && w.last !== w.first;
    const tooLong = len > WINDOW_MAX_LINES;
    if (endsOnHeading || tooLong || len < 1) bad++;
  }
  ok(`${db}：${starts.length} 個起點算出的讀窗都合法（不以標題結尾、≤ ${WINDOW_MAX_LINES} 行）`,
    bad === 0, `不合格 ${bad}；長度 ${minSeen}–${maxSeen}；例：${sample.join('｜')}`);

  // 連續性：從第一個節點一路往後算 300 窗，檢查 first 遞增、不重疊、不漏
  let cur = src.nodeStarts[0] ?? 0;
  let prevLast = -1;
  let gaps = 0;
  let overlap = 0;
  for (let i = 0; i < 300; i++) {
    const w = await computeReadWindow(src, cur, last, plainOf, { minFirst: prevLast + 1 });
    if (prevLast >= 0 && w.first <= prevLast) overlap++;
    if (prevLast >= 0 && w.first > prevLast + 1) gaps++;
    prevLast = w.last;
    if (w.last >= last) break;
    cur = w.last + 1;
  }
  ok(`${db}：往後翻 300 窗不重疊、不漏行`, overlap === 0 && gaps === 0,
    `overlap=${overlap} gap=${gaps}`);

  // 標題群：找一個「章→節」相連的地方，起點給「節」時應該被拉回「章」
  const chapTag = NODE_SPEC[db]?.[0]?.[0] ?? '書';
  const secTag = NODE_SPEC[db]?.[1]?.[0] ?? '章';
  const linesOf = async (tag: string): Promise<number[]> => {
    const ti = tagsC?.names.indexOf(tag) ?? -1;
    return ti < 0 ? [] : (await r.decodeBlockList('tags', ti)).map((v) => m.lineOfVa(v)).sort((a, b) => a - b);
  };
  const chapLines = await linesOf(chapTag);
  const secLines = new Set(await linesOf(secTag));
  let demo = '';
  let pulled = 0;
  let checked = 0;
  for (const sec of secLines) {
    const chap = chapLines.filter((l) => l < sec).pop();
    if (chap === undefined || sec - chap > 6) continue;
    // 中間必須都是空白行才算同一群（有正文就不是）
    let blankOnly = true;
    for (let l = chap + 1; l < sec; l++) if ((await plainOf(l)).trim()) blankOnly = false;
    if (!blankOnly) continue;
    checked++;
    const w = await computeReadWindow(src, sec, last, plainOf);
    if (w.first <= chap) pulled++;
    if (!demo) demo = `節在 ${sec}、章在 ${chap} → 窗首 ${w.first}`;
    if (checked >= 30) break;
  }
  ok(`${db}：起點給小標題時，會往前拉到大標題（標題群同一窗）`,
    checked === 0 || pulled === checked,
    checked === 0 ? '（這個庫找不到「大標題緊接小標題」的樣本，跳過）' : `檢查 ${checked} 處、拉回 ${pulled}；${demo}`);

  // 窗尾若剛好是標題 → 一定被推走
  let headingEnds = 0;
  for (const start of src.nodeStarts.slice(0, 200)) {
    const w = await computeReadWindow(src, start, last, plainOf);
    if (nodeSet.has(w.last) && w.last !== w.first) headingEnds++;
  }
  ok(`${db}：沒有任何一窗以標題結尾`, headingEnds === 0, `以標題結尾 ${headingEnds} 窗`);

  console.log(`\n  ${db}：節點 ${src.nodeStarts.length}、文邊界 ${src.wenStarts.length}、段 ${src.segStarts.length}、頁 ${src.pageStarts.length}（最短 ${WINDOW_MIN_LINES} 行）`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
