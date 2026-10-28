#!/usr/bin/env bun
/**
 * 把「中华典藏网」《说文解字注》的現代標點借過來，補進 `swjz.xml`。
 *
 *   bun run ts/tools/swjz-punct.ts --xml swjz.xml --dcw dcw --out swjz-punct.xml [--report r.md]
 *
 * 做法：
 *   1. 網站文字是**簡體＋標點**，一段（`<p>注解：…`）一條字；本站 xml 是繁體、沒有標點。
 *   2. 兩邊都照字頭順序排，先按字頭逐條配對（配不到就往前後找幾條）。
 *   3. 每一條：把本站文字逐字轉成簡體（FORCE 表）當 a，網站文字去掉標點當 b，
 *      用「雙指標＋前後找重同步」的方式對齊；網站每個字前面有哪些標點，就插到 a 對應字前面。
 *   4. 插入位置換算成 xml 原始位元組位移，最後一次插回原檔（不動標籤、不動空白）。
 *
 * 只借標點（，。、；：！？「」『』《》〈〉（）〔〕【】…—），不借字：字仍然是 swjz.xml 的繁體原文。
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { simplifyChar } from '../src/accelon26/lossless';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const XML = opt('xml', 'D:/2026/swjzz/swjz.xml');
const DCW = opt('dcw', 'D:/2026/swjzz/dcw');
const OUT = opt('out', 'D:/2026/swjzz/swjz-punct.xml');
const REPORT = opt('report', '');

/** 借用的標點（含全形空白以外的空白都不借） */
const PUNCT = new Set([...'，。、；：！？「」『』《》〈〉（）〔〕【】…—～·“”‘’']);
const isPunct = (ch: string) => PUNCT.has(ch);

// ── 1. 網站文字：一段一檔，拆成「字頭／注解」 ────────────────────────────
interface SiteEntry { head: string; body: string }
function loadSite(): SiteEntry[] {
  const out: SiteEntry[] = [];
  const files = readdirSync(DCW).filter((f) => /^p\d+\.txt$/.test(f)).sort();
  for (const f of files) {
    const lines = readFileSync(`${DCW}/${f}`, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line.startsWith('注解：')) continue;
      // 字頭不一定緊貼在上一行（中間可能有拼音、頁碼）；往前找最近的「短漢字行」
      let head: string | null = null;
      for (let k = 1; k <= 4 && i - k >= 0; k++) {
        const prev = lines[i - k];
        if (prev.length > 24) continue;
        const mt = /^标题：\s*([\u3400-\u9fff\uf900-\ufaff□]{1,6})/.exec(prev);
        if (mt) { head = mt[1]; break; }
        if (/^(路径：|文[一二三四五六七八九十百]|第[一二三四五六七八九十百])/.test(prev)) continue;
        const m = /^([\u3400-\u9fff\uf900-\ufaff□]{1,6})/.exec(prev);
        if (m) { head = m[1]; break; }
      }
      if (head) out.push({ head, body: line.slice(3) });
    }
  }
  return out;
}

// ── 2. swjz.xml：取出每個字頭與它的說文／段注文字（附原始位移） ──────────
interface XEntry { head: string; rawHead: number; chars: { ch: string; raw: number }[] }
function loadXml(text: string): { entries: XEntry[]; raw: string } {
  const entries: XEntry[] = [];
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<(\/?)([A-Za-z_][\w.:-]*)((?:\s[^>]*?)?)(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  let cur: XEntry | null = null;
  let inHead = false;
  let headText = '';
  let headStart = 0;
  /** >0 表示正在 explanation／duan_note 裡面（要收字） */
  let fragDepth = 0;
  const stack: string[] = [];
  while ((m = re.exec(text))) {
    if (m[5] !== undefined) {                       // 文字
      const s = m[5];
      if (inHead) { headText += s.trim(); continue; }
      if (fragDepth > 0 && cur) {
        for (let i = 0; i < s.length; i++) {
          const ch = s[i];
          if (/[\r\n\t ]/.test(ch)) continue;
          cur.chars.push({ ch, raw: m.index + i });
        }
      }
      continue;
    }
    if (!m[2]) continue;                            // 註解／PI
    const close = m[1] === '/';
    const name = m[2];
    if (close) {
      stack.pop();
      if (name === 'wordhead') {
        inHead = false;
        cur = { head: headText, rawHead: headStart, chars: [] };
        entries.push(cur);
      } else if (name === 'explanation' || name === 'duan_note') {
        fragDepth = Math.max(0, fragDepth - 1);
      }
      continue;
    }
    if (name === 'wordhead') { inHead = true; headText = ''; headStart = m.index; }
    else if (name === 'explanation' || name === 'duan_note') { fragDepth++; }
    if (m[4] !== '/') stack.push(name);
  }
  return { entries, raw: text };
}

// ── 3. 對齊：a＝本站（簡體）、b＝網站（去標點） ──────────────────────────
/** 回傳 b 每個字對應到 a 的索引（-1＝對不上）。 */
function align(a: string, b: string): number[] {
  const map = new Array<number>(b.length).fill(-1);
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { map[j] = i; i++; j++; continue; }
    // 找最小位移讓後面 3 個字重新對上
    let best: { d: number; di: number; dj: number } | null = null;
    for (let k = 1; k <= 12; k++) {
      for (const [di, dj] of [[0, k], [k, 0]] as const) {
        const ni = i + di, nj = j + dj;
        if (ni >= a.length || nj >= b.length) continue;
        if (a[ni] !== b[nj]) continue;
        let ok = 0;
        for (let t = 0; t < 3 && ni + t < a.length && nj + t < b.length; t++) if (a[ni + t] === b[nj + t]) ok++;
        if (ok < 2) continue;
        if (!best || di + dj < best.d) best = { d: di + dj, di, dj };
      }
      if (best) break;
    }
    if (best) { i += best.di; j += best.dj; } else { i++; j++; }
  }
  return map;
}

// ── 4. 主流程 ────────────────────────────────────────────────────────────
const site = loadSite();
console.error(`網站條目 ${site.length}`);
const raw = readFileSync(XML, 'utf8');
const { entries } = loadXml(raw);
console.error(`swjz.xml 字頭 ${entries.length}`);

// 配對：兩邊都在文件順序。先比字頭（都轉簡體），字頭對不上時再比「開頭幾個字」，
// 因為網站有 □（缺字）、異體（祐／佑、祕／秘），本站又多了重文與部目。
const simpStr = (s: string) => [...s].map((c) => simplifyChar(c, 2)).join('');
const bodyPrefix = (s: string) => simpStr([...s.replace(/^注解：/, '')].filter((c) => !isPunct(c) && !/\s/.test(c)).slice(0, 16).join(''));
const ourPrefix = (xe: XEntry) => simpStr(xe.chars.slice(0, 40).map((c) => c.ch !== undefined ? simplifyChar(c.ch, 2) : '').join(''));

const pairs: { xe: XEntry; se: SiteEntry }[] = [];
let i = 0, j = 0;
while (i < entries.length && j < site.length) {
  const hd = simpStr(entries[i].head);
  if (hd === site[j].head) { pairs.push({ xe: entries[i], se: site[j] }); i++; j++; continue; }
  // 開頭文字很像 → 當成同一條（異體字、缺字）
  const bp = bodyPrefix(site[j].body);
  if (bp.length >= 4 && ourPrefix(entries[i]).includes(bp.slice(0, 4))) {
    pairs.push({ xe: entries[i], se: site[j] }); i++; j++; continue;
  }
  // 找最小位移，讓某一邊追上
  let a = -1, b = -1;
  for (let k = 1; k <= 25 && j + k < site.length; k++) if (site[j + k].head === hd) { a = k; break; }
  for (let k = 1; k <= 25 && i + k < entries.length; k++) if (simpStr(entries[i + k].head) === site[j].head) { b = k; break; }
  if (a >= 0 && (b < 0 || a <= b)) j += a;
  else if (b >= 0) i += b;
  else { i++; j++; }
}
console.error(`配對 ${pairs.length}`);

const inserts: { at: number; text: string }[] = [];
const replaces: { start: number; end: number; text: string }[] = [];
let matchedChars = 0, totalChars = 0, punctCount = 0, skipped = 0;
const worst: { head: string; pct: number }[] = [];

const xIndex = new Map<XEntry, number>();
entries.forEach((e, k) => xIndex.set(e, k));
// 網站把重文（如「弌」「𢂇」）併在同一條注解裡，本站卻各自是一個字頭。
// 所以每一條網站文字要對上「從這一條到下一條之間」的所有本站字頭。
const spans = pairs.map((p, k) => ({
  se: p.se,
  from: xIndex.get(p.xe) ?? 0,
  to: k + 1 < pairs.length ? (xIndex.get(pairs[k + 1].xe) ?? entries.length) : entries.length,
}));

for (const span of spans) {
  const all = entries.slice(span.from, span.to).flatMap((e) => e.chars);
  if (!all.length) continue;
  const se = span.se;
  const ours = all.filter((c) => !isPunct(c.ch));
  if (!ours.length) continue;
  // 第 k 個內容字「前面已經有的標點」：文字與它在原檔的位移範圍
  const ourPunct: { text: string; start: number; end: number }[] = [];
  let buf = '';
  let bufStart = -1, bufEnd = -1;
  for (const c of all) {
    if (isPunct(c.ch)) {
      if (bufStart < 0) bufStart = c.raw;
      bufEnd = c.raw + c.ch.length;
      buf += c.ch;
      continue;
    }
    ourPunct.push({ text: buf, start: bufStart, end: bufEnd });
    buf = '';
    bufStart = bufEnd = -1;
  }
  // 網站文字：拆成「標點前綴 ＋ 字」
  const bChars: string[] = [];
  const before: string[] = [];
  let pend = '';
  for (const ch of se.body) {
    if (isPunct(ch)) { pend += ch; continue; }
    if (/[\s\u3000]/.test(ch)) continue;
    bChars.push(ch);
    before.push(pend);
    pend = '';
  }
  const tailPunct = pend;
  if (!bChars.length) { skipped++; continue; }

  const a = ours.map((c) => simplifyChar(c.ch, 2)).join('');
  const b = bChars.map((c) => simplifyChar(c, 2)).join('');
  const map = align(a, b);

  let hit = 0;
  for (let j = 0; j < b.length; j++) {
    const i = map[j];
    if (i < 0) continue;
    hit++;
    const want = before[j];
    if (!want) continue;                       // 網站這裡沒有標點：保留本站原樣
    const mine = ourPunct[i];
    if (mine.text === want) continue;          // 一樣就不動
    // 只有「標點與這個字在同一個文字節點裡」才替換；跨 <說文>／<段注> 標籤的不能替換
    // （會把標籤吃掉，也會讓書名號留在上一行），改成插在這個字前面。
    const sameNode = mine.text && !raw.slice(mine.start, ours[i].raw).includes('<');
    if (sameNode) {
      replaces.push({ start: mine.start, end: mine.end, text: want });
      punctCount += want.length;
      continue;
    }
    // 跨節點：本站那一段標點已經有了，只補網站多出來的（例：本站「。」＋網站「。《」→ 只補「《」）
    let add = want;
    if (mine.text && want.startsWith(mine.text)) add = want.slice(mine.text.length);
    else if (mine.text && mine.text.startsWith(want)) add = '';
    if (!add) continue;
    inserts.push({ at: ours[i].raw, text: add });
    punctCount += add.length;
  }
  matchedChars += hit;
  totalChars += b.length;
  const pct = b.length ? (hit / b.length) * 100 : 0;
  if (pct < 80) worst.push({ head: se.head, pct: Math.round(pct) });
  // 條末的標點
  if (tailPunct && ours.length) {
    const last = ours[ours.length - 1];
    inserts.push({ at: last.raw + last.ch.length, text: tailPunct });
    punctCount += tailPunct.length;
  }
}

// 一次套回去：插入（start=end）與替換（本站原有的標點換成網站的）一起處理
type Edit = { start: number; end: number; text: string };
const edits: Edit[] = [
  ...inserts.map((x) => ({ start: x.at, end: x.at, text: x.text })),
  ...replaces.map((x) => ({ start: x.start, end: x.end, text: x.text })),
];
edits.sort((x, y) => x.start - y.start || x.end - y.end);
let out = '';
let prev = 0;
for (const e of edits) {
  if (e.start < prev) continue;                    // 重疊（同一位置被兩條規則碰到）：保留先套用的
  out += raw.slice(prev, e.start) + e.text;
  prev = e.end;
}
out += raw.slice(prev);
writeFileSync(OUT, out, 'utf8');

const pct = totalChars ? (matchedChars / totalChars) * 100 : 0;
console.error(`字元對上 ${matchedChars}/${totalChars}（${pct.toFixed(1)}%）`);
console.error(`插入／替換標點 ${punctCount} 個（替換 ${replaces.length} 處）、條目 ${pairs.length}`);
if (worst.length) console.error(`对齐最差的 ${worst.length} 條（<80%）：` + worst.slice(0, 15).map((w) => `${w.head}${w.pct}%`).join(' '));
console.error(`wrote ${OUT}`);

if (REPORT) {
  const md = [
    '# 《說文解字注》標點轉移報告',
    '',
    `* 來源：中华典藏网《说文解字注》（简体、现代标点，136 段）— <https://www.diancangwang.cn/xueshuzaji/b425b900dc24/>`,
    `* 目標：\`swjz.xml\`（繁体、无标点）`,
    `* 網站條目 ${site.length}、本站字頭 ${entries.length}、配對 ${pairs.length}`,
    `* 字元對上 **${matchedChars} / ${totalChars}（${pct.toFixed(1)}%）**，插入標點 ${punctCount} 個`,
    `* 只借標點（，。、；：！？「」『』《》〈〉（）…），不借字`,
    '',
    `對齊 <80% 的條目 ${worst.length} 條（前 20）：`,
    '',
    worst.slice(0, 20).map((w) => `* ${w.head}（${w.pct}%）`).join('\n'),
    '',
  ].join('\n');
  writeFileSync(REPORT, md, 'utf8');
  console.error(`wrote ${REPORT}`);
}
