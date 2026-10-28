#!/usr/bin/env bun
/**
 * 古籍 adb → 大正藏：把書中引用的經文加上 `<聯 i="taisho?頁碼" q="大正原文">`。
 *
 *   bun run tools/backlink.ts [options]
 *
 * 流程（四步，全部在這支程式裡）：
 *   1. 解出 accelon3 標記：讀來源 adb 的 source，一行一個 pcl 行（含標記）。
 *   2. 抽引文：依 `--cues` 找 cue（預設太虛的五種），取引號內的文字；
 *      沒有引號的收到句末標點為止（可跨行；跨行時記下每行的字元範圍）。
 *   3. 去大正藏搜尋：不用整串詞，而是把引文切成**單字**，用 taisho.adb 的
 *      tokens posting 產生候選 VA，再在候選 VA 附近取原文核對（近似查詢）。
 *      書名（引文前面 30 字與大正 `書` 標題的最長共同子串）用來優先挑本經，
 *      而不是後代註疏。
 *   4. 套回原文並重新打包：`<聯>` 是 skip tag，不佔 VA；頁碼 id、caches 全部沿用
 *      原庫（resources 也原樣帶過去）。
 *
 * 選項：
 *   --src <path>      來源 adb（預設 accelon3/taixu.adb）
 *   --taisho <path>   大正藏 adb（預設 accelon3/taisho.adb）
 *   --out <path>      輸出 adb（預設 build/taixu-linked.adb）
 *   --slug <name>     中間產物前綴（build/<slug>-text.txt…；預設 taixu）
 *   --cues <list>     逗號分隔的 cue（例：`經云：,經上說：,曰：,云：,：「,：『`）
 *   --explicit        只用預設的前四種明確 cue（不含泛用「：『」）
 *   --dbname <name>   檔頭 dbname（預設沿用來源；反連結靠它找庫，通常設成檔名）
 *   --logo <path>     換上這個 logo（資源名改成 `<dbname>_logo.ext`，舊的 *_logo.* 移除）
 *   --reuse           重用 build/<slug>-quotes.json / <slug>-matches.json，只做套用與打包
 *   --no-pack         只寫 build/<slug>-linked.txt，不打包
 *   --limit <n>       只處理前 n 筆（除錯用）
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readAdbText } from '../src/adbtext';
import { authorAdb } from '../src/adbauthor';
import { AdbReader, SyncIO } from '../src/accelon26/adb';
import { VaPaMapper } from '../src/accelon26/vapa';
import { expandToken } from '../src/accelon26/variants';

const ROOT = resolve(import.meta.dir, '../..');
const args = process.argv.slice(2);
const opt = (n: string, d?: string): string | undefined => {
  const i = args.indexOf('--' + n);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};
const SRC = resolve(ROOT, opt('src', 'accelon3/taixu.adb')!);
const TAISHO = resolve(ROOT, opt('taisho', 'accelon3/taisho.adb')!);
const OUT = resolve(ROOT, opt('out', 'build/taixu-linked.adb')!);
const DBNAME = opt('dbname');
const LOGO = opt('logo');
const SLUG = opt('slug', 'taixu')!;
const TXT = resolve(ROOT, `build/${SLUG}-text.txt`);
const QUOTES = resolve(ROOT, `build/${SLUG}-quotes.json`);
const MATCHES = resolve(ROOT, `build/${SLUG}-matches.json`);
const EXPLICIT = args.includes('--explicit');
const REUSE = args.includes('--reuse');
const NO_PACK = args.includes('--no-pack');
const LIMIT = Number(opt('limit', '0')) || 0;
const DEFAULT_CUES = ['經曰：', '經上說：', '經云：', '法華云：『', '：『'];
const CUES = (opt('cues') ? opt('cues')!.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_CUES)
  .filter((c) => !EXPLICIT || !c.startsWith('：'));

if (!existsSync(SRC)) { console.error('missing source adb: ' + SRC); process.exit(2); }
if (!REUSE && !existsSync(TAISHO)) { console.error('missing taisho adb: ' + TAISHO); process.exit(2); }

const isHan = (c: string): boolean => {
  if (!c) return false;
  const cp = c.codePointAt(0)!;
  return (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x4e00 && cp <= 0x9fff)
    || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0x20000 && cp <= 0x2fa1f);
};
const xmlAttr = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---------------------------------------------------------------- 1. 解出文字
interface Seg { line: number; from: number; to: number; rawFrom: number }
interface Quote {
  cue: string; line: number; start: number; endLine: number; end: number;
  raw: string; han: string; segs: Seg[];
}
let lines: string[] = [];
if (REUSE) {
  lines = readFileSync(TXT, 'utf8').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
} else {
  const adb = readAdbText(SRC);
  lines = adb.lines;
  writeFileSync(TXT, lines.join('\n') + '\n');
  console.log(`解出 ${lines.length} 行（${(lines.join('').length / 1048576).toFixed(1)} MiB）→ ${TXT}`);
  adb.close();
}

// ---------------------------------------------------------------- 2. 抽引文
function collect(li: number, col: number, close: string | null): { raw: string; segs: Seg[]; endLine: number; end: number } {
  const segs: Seg[] = [];
  let raw = '';
  let depth = 1;
  let first = true;
  for (let guard = 0; guard < 24 && li < lines.length; guard++, li++, col = 0) {
    if (!first) raw += '\n';
    first = false;
    const line = lines[li];
    let c = col;
    let segFrom = c, segRawFrom = raw.length;
    const flush = (): void => { if (c > segFrom) segs.push({ line: li, from: segFrom, to: c, rawFrom: segRawFrom }); };
    while (c < line.length) {
      const ch = line[c];
      if (ch === '<') {
        const gt = line.indexOf('>', c);
        if (gt < 0) break;
        flush();
        raw += line.slice(c, gt + 1);
        c = gt + 1;
        segFrom = c; segRawFrom = raw.length;
        continue;
      }
      if (close) {
        if (ch === '「' || ch === '『') depth++;
        else if (ch === '」' || ch === '』') { depth--; if (depth === 0) { flush(); return { raw, segs, endLine: li, end: c }; } }
        raw += ch; c++;
        if (raw.length > 300) { flush(); return { raw, segs, endLine: li, end: c }; }
      } else {
        if ('。！？；」』'.includes(ch)) { flush(); return { raw, segs, endLine: li, end: c }; }
        raw += ch; c++;
        if (raw.length > 160) { flush(); return { raw, segs, endLine: li, end: c }; }
      }
    }
    flush();
  }
  return { raw, segs, endLine: Math.min(li, lines.length - 1), end: 0 };
}
function hanOf(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '<') { const gt = raw.indexOf('>', i); if (gt < 0) break; i = gt; continue; }
    if (isHan(raw[i])) out += raw[i];
  }
  return out;
}
function extractQuotes(): Quote[] {
  const quotes: Quote[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    for (const cue of CUES) {
      let at = lines[i].indexOf(cue);
      while (at >= 0) {
        let c = at + cue.length;
        let close: string | null = null;
        const last = cue[cue.length - 1];
        const cueOpener = last === '「' || last === '『';
        const generic = cue === '「' || cue === '『';
        if (cueOpener) {
          // cue 裡的開引號就是引文開始。`：「`／`：『`／泛用 `「`／`所謂「`
          // 收到對應的關引號；具名 cue `法華云：『` 沿用舊行為（遇到句末標點就停），
          // 以免重跑舊庫時引文突然變長。
          close = generic || cue.startsWith('：') || cue.startsWith('所謂') ? (last === '「' ? '」' : '』') : null;
        } else {
          // cue 後面可能還有空白再開引號（「經云： 「…」」）
          while (c < lines[i].length && /[\s　]/.test(lines[i][c])) c++;
          const ch = lines[i][c];
          if (ch === '「' || ch === '『') { close = ch === '「' ? '」' : '』'; c++; }
          else if (ch === '“') { close = '”'; c++; }
        }
        const got = close ? collect(i, c, close) : collect(i, c, null);
        const han = hanOf(got.raw);
        // 泛用 `「` 會抽到所有引號（含術語、非佛典），門檻提高到 8 字；
        // 具名 cue 仍用 6/4 字。
        const min = generic ? 8 : cueOpener ? 6 : close ? 4 : 6;
        const key = i + ':' + c;
        if (han.length >= min && !seen.has(key)) {
          seen.add(key);
          quotes.push({ cue, line: i, start: c, endLine: got.endLine, end: got.end, raw: got.raw, han, segs: got.segs });
        }
        at = lines[i].indexOf(cue, at + 1);
      }
    }
  }
  return quotes;
}
let quotes: Quote[];
if (REUSE) {
  quotes = JSON.parse(readFileSync(QUOTES, 'utf8'));
} else {
  quotes = extractQuotes();
  writeFileSync(QUOTES, JSON.stringify(quotes, null, 1));
  const by: Record<string, number> = {};
  for (const q of quotes) by[q.cue] = (by[q.cue] ?? 0) + 1;
  console.log(`抽出 ${quotes.length} 筆引文`, by);
}

// ---------------------------------------------------------------- 3. 大正藏近似查詢
interface Match {
  qIndex: number; cue: string; line: number; anchor: string; pageVa: number;
  quoteHan: string; qAttr: string; matched: number; n: number; cands: number;
  book: string; hint: number; j?: string;
}
const POST_CACHE = new Map<string, Int32Array>();
const UNION_CACHE = new Map<string, Int32Array>();
const EMPTY = new Int32Array(0);
let tr!: AdbReader;
let tokIndex!: Map<string, number>;
let pageVas!: Int32Array;
let pageIds!: string[];
let bookVas!: Int32Array;
let bookTitles!: string[];
let mapper!: VaPaMapper;
const canonCache = new Map<string, string>();
function canon(ch: string): string {
  let c = canonCache.get(ch);
  if (c) return c;
  const g = expandToken(ch);
  c = g.length > 1 ? [...g].sort()[0] : ch;
  canonCache.set(ch, c);
  return c;
}
async function rawPostings(ch: string): Promise<Int32Array> {
  const hit = POST_CACHE.get(ch);
  if (hit) return hit;
  const i = tokIndex.get(ch);
  if (i === undefined) return EMPTY;
  const arr = Int32Array.from(await tr.decodeBlockList('tokens', i));
  POST_CACHE.set(ch, arr);
  if (POST_CACHE.size > 1500) { let n = 0; for (const k of POST_CACHE.keys()) { if (n++ > 700) break; POST_CACHE.delete(k); } }
  return arr;
}
async function postings(ch: string): Promise<Int32Array> {
  const hit = UNION_CACHE.get(ch);
  if (hit) return hit;
  const parts: Int32Array[] = [];
  for (const v of expandToken(ch)) { const p = await rawPostings(v); if (p.length) parts.push(p); }
  let out: Int32Array;
  if (parts.length === 0) out = EMPTY;
  else if (parts.length === 1) out = parts[0];
  else {
    const total = parts.reduce((a, p) => a + p.length, 0);
    const tmp = new Int32Array(total);
    let k = 0; const ptr = new Array(parts.length).fill(0);
    while (k < total) {
      let best = -1, bestI = -1;
      for (let j = 0; j < parts.length; j++) { const p = parts[j], q = ptr[j]; if (q < p.length && (best < 0 || p[q] < best)) { best = p[q]; bestI = j; } }
      if (best < 0) break;
      tmp[k++] = best; ptr[bestI]++;
    }
    out = tmp.subarray(0, k);
  }
  UNION_CACHE.set(ch, out);
  if (UNION_CACHE.size > 3000) UNION_CACHE.clear();
  return out;
}
function firstGT(a: Int32Array, v: number): number {
  let lo = 0, hi = a.length - 1, r = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (a[m] > v) { r = m; hi = m - 1; } else lo = m + 1; }
  return r;
}
function lastLT(a: Int32Array, v: number): number {
  let lo = 0, hi = a.length - 1, r = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (a[m] < v) { r = m; lo = m + 1; } else hi = m - 1; }
  return r;
}
function pageOf(va: number): string {
  let lo = 0, hi = pageVas.length - 1, k = 0;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (pageVas[m] <= va) { k = m; lo = m + 1; } else hi = m - 1; }
  return pageIds[k] ?? '';
}
function bookOf(va: number): { i: number; title: string } {
  let lo = 0, hi = bookVas.length - 1, k = 0;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (bookVas[m] <= va) { k = m; lo = m + 1; } else hi = m - 1; }
  return { i: k, title: bookTitles[k] ?? '' };
}
function titleHint(prefix: string, title: string): number {
  const a = Array.from(prefix), b = Array.from(title);
  let best = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      let k = 0;
      while (i + k < a.length && j + k < b.length && a[i + k] === b[j + k]) k++;
      if (k > best) best = k;
    }
  }
  return best;
}
function hanWithPos(text: string): { c: string; pos: number }[] {
  const out: { c: string; pos: number }[] = [];
  for (let i = 0; i < text.length; i++) if (isHan(text[i])) out.push({ c: canon(text[i]), pos: i });
  return out;
}
const MAXGAP = 20;
function scan(lists: Int32Array[], a: number, va: number, n: number): { score: number; hits: number[] } {
  const hits = new Array<number>(n).fill(-1);
  hits[a] = va;
  let prev = va;
  for (let k = a + 1; k < n; k++) {
    const L = lists[k]; const idx = firstGT(L, prev);
    if (idx >= 0 && L[idx] <= prev + MAXGAP) { hits[k] = L[idx]; prev = L[idx]; } else break;
  }
  prev = va;
  for (let k = a - 1; k >= 0; k--) {
    const L = lists[k]; const idx = lastLT(L, prev);
    if (idx >= 0 && L[idx] >= prev - MAXGAP) { hits[k] = L[idx]; prev = L[idx]; } else break;
  }
  let score = 0; for (const h of hits) if (h >= 0) score++;
  return { score, hits };
}

async function searchTaisho(): Promise<Match[]> {
  tr = await AdbReader.open(new SyncIO(TAISHO));
  const tokC = tr.containers.get('tokens')!;
  tokIndex = new Map<string, number>();
  for (let i = 0; i < tokC.names.length; i++) tokIndex.set(tokC.names[i], i);
  const tagC = tr.containers.get('tags')!;
  pageVas = Int32Array.from(await tr.decodeBlockList('tags', tagC.names.indexOf('頁')));
  pageIds = (await tr.attributeValues('頁.id'))!.values;
  bookVas = Int32Array.from(await tr.decodeBlockList('tags', tagC.names.indexOf('書')));
  bookTitles = await tr.cachedStrings('書');
  mapper = new VaPaMapper(tr);
  await mapper.init();
  console.log(`大正藏：${pageIds.length} 頁、${bookTitles.length} 部`);

  // ---- 字級範圍 j：目標頁「可見漢字」的起訖索引（0 起算，end 不含）。
  // 和 xref.renderForeign 的 lineHtml() 用同一種索引（只數漢字，跳過標記）。
  const pageHanCache = new Map<number, string>();
  const bv = await tr.blocksVirtual();
  const pageIndexOf = (va: number): number => {
    let lo = 0, hi = pageVas.length - 1, k = 0;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (pageVas[m] <= va) { k = m; lo = m + 1; } else hi = m - 1; }
    return k;
  };
  const pageHanAt = async (pi: number): Promise<string> => {
    const hit = pageHanCache.get(pi);
    if (hit !== undefined) return hit;
    // 和 xref.renderForeign 完全一樣的取法：從 source block 找 `<頁 id="…"`，
    // 切掉頁標記，收到下一個 `<頁 ` 或 2000 字。不能只用 elementAt(pageVa)，
    // 頁是 skip tag，VA 會落在後面的 token 上，索引會偏。
    const pageId = pageIds[pi];
    let blk = 0;
    for (let k = 0; k < bv.length; k++) { if (bv[k] <= pageVas[pi]) blk = k; else break; }
    let t = '';
    for (const off of [0, -1, 1, -2, 2, -3, 3, -4, 4, -5, 5, -6, 6, -8, 8]) {
      const b = blk + off;
      if (b < 0 || b >= bv.length) continue;
      const s = await tr.sourceText(b);
      const k = s.indexOf('<頁 id="' + pageId + '"');
      if (k >= 0) { t = s.slice(k); blk = b; break; }
    }
    if (!t) return '';
    const gt0 = t.indexOf('>');
    if (gt0 >= 0) t = t.slice(gt0 + 1);
    for (let b = blk + 1; t.length < 2200 && b < bv.length; b++) t += await tr.sourceText(b);
    const cut = t.indexOf('<頁 ');
    if (cut > 0) t = t.slice(0, cut);
    if (t.length > 2000) t = t.slice(0, 2000);   // renderForeign 的 maxChars
    let out = '';
    // 與 xref.renderForeign 的 HAN_RE／逐 code unit 完全一致（含增補平面時會少算，
    // 但兩邊一致才不會位移）。
    const isHanBmp = (c: string): boolean => /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(c);
    for (let i = 0; i < t.length; i++) {
      if (t[i] === '<') { const gt = t.indexOf('>', i); if (gt < 0) break; i = gt; continue; }
      if (isHanBmp(t[i])) out += canon(t[i]);
    }
    pageHanCache.set(pi, out);
    return out;
  };
  const rangeFor = async (vaStart: number, quoteHan: string, matched: number): Promise<string | undefined> => {
    const pi = pageIndexOf(vaStart);
    const han = await pageHanAt(pi);
    if (!han) return undefined;
    const qn = Array.from(quoteHan).slice(0, Math.min(matched, 60)).map(canon).join('');
    if (qn.length < 4) return undefined;
    let pos = -1;
    for (const L of [12, 10, 8, 6, 4]) {
      if (L > qn.length) continue;
      const probe = qn.slice(0, L);
      const approx = vaStart - pageVas[pi];
      let at = han.indexOf(probe), best = -1, bestD = Infinity;
      while (at >= 0) {
        const d = Math.abs(at - approx);
        if (d < bestD) { bestD = d; best = at; }
        at = han.indexOf(probe, at + 1);
      }
      if (best >= 0 && han.slice(best, best + Math.min(matched, 40)) === qn.slice(0, Math.min(matched, 40))) { pos = best; break; }
    }
    if (pos < 0) return undefined;
    const end = Math.min(han.length, pos + matched);
    if (end - pos < 4) return undefined;
    return `${pos}-${end}`;
  };

  const matches: Match[] = [];
  const t0 = Date.now();
  const total = LIMIT ? Math.min(LIMIT, quotes.length) : quotes.length;
  for (let qi = 0; qi < total; qi++) {
    const q = quotes[qi];
    const chars = Array.from(q.han);
    const nFull = Math.min(chars.length, 80);
    const n = Math.min(chars.length, 24);
    const qFull = chars.slice(0, nFull).map(canon).join('');
    const lists: Int32Array[] = [];
    for (let k = 0; k < n; k++) lists.push(await postings(chars[k]));
    let a = -1, bestLen = Infinity;
    for (let k = 0; k < n; k++) if (lists[k].length && lists[k].length < bestLen) { bestLen = lists[k].length; a = k; }
    if (a < 0) continue;
    let b = -1, bl = Infinity, b2 = -1, b2l = Infinity;
    for (let k = 0; k < n; k++) if (k !== a && lists[k].length && lists[k].length < bl) { bl = lists[k].length; b = k; }
    for (let k = 0; k < n; k++) if (k !== a && k !== b && lists[k].length && lists[k].length < b2l) { b2l = lists[k].length; b2 = k; }
    const near = (k: number, expect: number, slack = 20): boolean => {
      const L = lists[k]; const j = firstGT(L, expect - slack);
      return j >= 0 && L[j] <= expect + slack;
    };
    type Cand = { score: number; hits: number[]; va: number; hint: number };
    const cands: Cand[] = [];
    for (const va of lists[a]) {
      if (lists[a].length > 3000 && (b >= 0 || b2 >= 0)) {
        let ok = false;
        if (b >= 0 && near(b, va + (b - a))) ok = true;
        if (!ok && b2 >= 0 && near(b2, va + (b2 - a))) ok = true;
        if (!ok) continue;
      }
      const r = scan(lists, a, va, n);
      if (r.score >= Math.max(5, Math.ceil(n * 0.55))) cands.push({ score: r.score, hits: r.hits, va, hint: 0 });
      if (cands.length > 400) break;
    }
    if (!cands.length) continue;
    const prefix = lines[q.line].slice(Math.max(0, q.start - 30), q.start).replace(/<[^>]*>/g, '');
    for (const c of cands) c.hint = titleHint(prefix, bookOf(c.va).title) >= 2 ? 1 : 0;
    cands.sort((x, y) => y.hint - x.hint || y.score - x.score || x.va - y.va);

    for (const c of cands.slice(0, 12)) {
      const before = Math.min(200, Math.max(24, a * 3 + 20));
      const after = Math.min(400, Math.max(120, (n - a) * 3 + 80));
      const ctx = await mapper.context(c.va, before, after);
      if (!ctx) continue;
      const win = hanWithPos(ctx.text);
      const winStr = win.map((w) => w.c).join('');
      let bestS = -1, bestM = 0;
      for (const plen of [12, 8, 6, 4]) {
        const probe = qFull.slice(0, Math.min(plen, nFull));
        if (!probe) break;
        let at = winStr.indexOf(probe);
        while (at >= 0) {
          let m = 0;
          while (m < nFull && at + m < win.length && win[at + m].c === qFull[m]) m++;
          if (m > bestM) { bestM = m; bestS = at; }
          at = winStr.indexOf(probe, at + 1);
        }
        if (bestM >= Math.min(nFull, Math.max(8, plen))) break;
      }
      let aWin = 0;
      for (const h of win) { if (h.pos < ctx.hitStart) aWin++; else break; }
      const vaStart = Math.max(0, c.va - (aWin - (bestS < 0 ? aWin : bestS)));
      const need = n <= 8 ? Math.max(4, n - 1) : 8;
      if (bestM < need || bestS < 0) continue;
      const sPos = win[bestS].pos;
      const ePos = bestS + bestM < win.length ? win[bestS + bestM].pos : ctx.text.length;
      const rawTaisho = ctx.text.slice(sPos, ePos).replace(/<[^>]*>/g, '');
      const j = await rangeFor(vaStart, q.han, bestM);
      matches.push({
        qIndex: qi, cue: q.cue, line: q.line, anchor: pageOf(vaStart), pageVa: vaStart,
        quoteHan: q.han, qAttr: rawTaisho.slice(0, 160), matched: bestM, n: chars.length,
        cands: cands.length, book: bookOf(vaStart).title, hint: c.hint, j,
      });
      break;
    }
    if ((qi + 1) % 500 === 0) console.log(`  搜尋 ${qi + 1}/${total}，已命中 ${matches.length}（${((Date.now() - t0) / 1000).toFixed(0)}s）`);
  }
  writeFileSync(MATCHES, JSON.stringify(matches, null, 1));
  const by: Record<string, { all: number; ok: number }> = {};
  for (const q of quotes.slice(0, total)) { const x = by[q.cue] ??= { all: 0, ok: 0 }; x.all++; }
  for (const m of matches) by[m.cue].ok++;
  console.log(`大正藏命中 ${matches.length}/${total}（${((Date.now() - t0) / 1000).toFixed(0)}s）`, by);
  return matches;
}
let matches: Match[];
if (REUSE) matches = JSON.parse(readFileSync(MATCHES, 'utf8'));
else matches = await searchTaisho();

// ---------------------------------------------------------------- 4. 套回原文
function hanRawIndex(raw: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < raw.length;) {
    if (raw[i] === '<') { const gt = raw.indexOf('>', i); if (gt < 0) break; i = gt + 1; continue; }
    const cp = raw.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    if (isHan(ch)) out.push(i);
    i += ch.length;
  }
  return out;
}
function posOf(q: Quote, ri: number): { line: number; col: number } | null {
  for (const s of q.segs) {
    const len = s.to - s.from;
    if (ri >= s.rawFrom && ri < s.rawFrom + len) return { line: s.line, col: s.from + (ri - s.rawFrom) };
  }
  return null;
}
const PUNCT = '，。、；：！？…—‧・';
interface Span { line: number; from: number; to: number; tag: string }
const spans: Span[] = [];
let wrapped = 0, skipped = 0;
for (const mt of matches) {
  const q = quotes[mt.qIndex];
  if (!mt.anchor) { skipped++; continue; }
  const idx = hanRawIndex(q.raw);
  const m = Math.min(mt.matched, idx.length);
  if (m < 1) { skipped++; continue; }
  const startRaw = idx[0];
  let endRaw = idx[m - 1] + 1;
  while (endRaw < q.raw.length && PUNCT.includes(q.raw[endRaw])) endRaw++;
  const a = posOf(q, startRaw), b = posOf(q, endRaw - 1);
  if (!a || !b) { skipped++; continue; }
  const jAttr = mt.j ? ` j="${xmlAttr(String(mt.j))}"` : '';
  const tag = `<聯 i="taisho?${xmlAttr(mt.anchor)}" q="${xmlAttr(String(mt.qAttr).slice(0, 160))}"${jAttr}>`;
  if (a.line === b.line) spans.push({ line: a.line, from: a.col, to: b.col + 1, tag });
  else {
    spans.push({ line: a.line, from: a.col, to: lines[a.line].length, tag });
    for (let l = a.line + 1; l < b.line; l++) spans.push({ line: l, from: 0, to: lines[l].length, tag });
    spans.push({ line: b.line, from: 0, to: b.col + 1, tag });
  }
  wrapped++;
}
spans.sort((x, y) => x.line - y.line || x.from - y.from || y.to - x.to);
const byLine = new Map<number, Span[]>();
for (const s of spans) { const arr = byLine.get(s.line) ?? []; arr.push(s); byLine.set(s.line, arr); }
let dropped = 0;
for (const [li, list] of byLine) {
  const keep: Span[] = [];
  let lastEnd = -1;
  for (const s of list) {
    if (s.from < lastEnd) { dropped++; continue; }
    if (s.to > lines[li].length) s.to = lines[li].length;
    if (s.to <= s.from) { dropped++; continue; }
    keep.push(s); lastEnd = s.to;
  }
  byLine.set(li, keep);
}
function wrapLine(line: string, list: Span[]): string {
  if (!list.length) return line;
  let out = '';
  let i = 0, si = 0, open = false;
  while (i < line.length) {
    if (line[i] === '<') {
      const gt = line.indexOf('>', i);
      if (gt < 0) { out += line.slice(i); break; }
      if (open) { out += '</聯>'; open = false; }
      out += line.slice(i, gt + 1);
      i = gt + 1;
      while (si < list.length && list[si].to <= i) si++;
      if (si < list.length && list[si].from <= i && i < list[si].to) { out += list[si].tag; open = true; }
      continue;
    }
    while (si < list.length && list[si].to <= i) { if (open) { out += '</聯>'; open = false; } si++; }
    if (!open && si < list.length && list[si].from <= i && i < list[si].to) { out += list[si].tag; open = true; }
    out += line[i];
    i++;
  }
  if (open) out += '</聯>';
  return out;
}
const outLines = lines.slice();
for (const [li, list] of byLine) outLines[li] = wrapLine(lines[li], list);
writeFileSync(resolve(ROOT, `build/${SLUG}-linked.txt`), outLines.join('\n') + '\n');
const anchors = outLines.reduce((n, l) => n + ((l.match(/<聯 i="taisho\?/g) ?? []).length), 0);
console.log(`套用 ${wrapped} 筆（略過 ${skipped}、重疊 ${dropped}）→ ${anchors} 個錨點`);

// ---------------------------------------------------------------- 5. 重新打包
if (!NO_PACK) {
  const srcReader = await AdbReader.open(new SyncIO(SRC));
  const srcHeader = srcReader.header;
  const resC = srcReader.containers.get('resources');
  const resources: { name: string; bytes: Buffer }[] = [];
  if (resC) {
    for (let i = 0; i < resC.count; i++) resources.push({ name: resC.names[i], bytes: Buffer.from(await srcReader.readBlock('resources', i)) });
  }
  // 換 logo：資源名要跟檔頭 dbname 對得上（logo.ts 找 `<dbname>_logo.*`），
  // 舊的 `taixu_logo.png` 之類一併移除，免得同一個庫有兩張封面圖。
  if (LOGO) {
    const logoPath = resolve(ROOT, LOGO);
    if (!existsSync(logoPath)) { console.error('missing logo: ' + logoPath); process.exit(2); }
    const ext = /\.[a-z0-9]+$/i.exec(logoPath)?.[0] ?? '.png';
    const logoName = `${DBNAME ?? srcHeader.dbname}_logo${ext}`;
    const before = resources.length;
    const kept = resources.filter((r) => !/(^|\/)[^/]*_logo\.[a-z0-9]+$/i.test(r.name));
    const logoBytes = readFileSync(logoPath);
    kept.push({ name: logoName, bytes: logoBytes });
    resources.length = 0;
    resources.push(...kept);
    console.log(`logo → ${logoName}（${(logoBytes.length / 1024).toFixed(0)} KiB，移除 ${before - (kept.length - 1)} 張舊 logo）`);
  }
  const cachedTags = (srcReader.containers.get('caches')?.names ?? []).slice();
  // 舊 docdef 會把某些成對標記寫成 `<x/>` 但仍索引 `/x`（太虛的平裝／精裝）。
  // 掃原庫的 tag 表，找出「有 /x、文字裡只有自閉合、沒有 </x>」的標記。
  const srcTags = (srcReader.containers.get('tags')?.names ?? []).slice();
  // 只承認原庫的標記＋新加的 `聯`。于淩波正文用 `<大唐西域記>` 包書名，
  // 不設 validTags 會被當成 150 多種新標記。
  const validTags = [...new Set([...srcTags.filter((n) => !n.startsWith('/')), '聯'])];
  const closeSet = new Set(srcTags.filter((n) => n.startsWith('/')).map((n) => n.slice(1)));
  const dualSelfClosingTags: string[] = [];
  for (const t of srcTags.filter((n) => !n.startsWith('/'))) {
    if (!closeSet.has(t)) continue;
    const selfRe = new RegExp(`<${t}(?=[\\s/>])[^>]*/>`);
    let hasSelf = false, hasClose = false;
    for (const line of outLines) {
      if (!hasSelf && selfRe.test(line)) hasSelf = true;
      if (!hasClose && line.includes(`</${t}>`)) hasClose = true;
      if (hasSelf && hasClose) break;
    }
    if (hasSelf && !hasClose) dualSelfClosingTags.push(t);
  }
  const out = await authorAdb({
    dbname: DBNAME ?? srcHeader.dbname,
    dbcname: srcHeader.dbcname,
    dbtype: srcHeader.dbType,
    features: srcHeader.features,
    srcBlockSize: srcHeader.srcBlockSize,
    lines: outLines,
    resources,
    cachedTags,
    dualSelfClosingTags,
    validTags,
    log: (m) => console.error(m),
  });
  writeFileSync(OUT, Buffer.from(out.file));
  console.log(`打包 ${OUT}（${(out.file.length / 1048576).toFixed(2)} MiB，${out.lines} 行，${out.tagNames.length} 種標記；雙收尾 ${dualSelfClosingTags.join(',') || '無'}）`);
  srcReader.close?.();
}

// ---------------------------------------------------------------- 6. 驗收
if (!NO_PACK) {
  const check = await AdbReader.open(new SyncIO(OUT));
  const iAttr = await check.attributeValues('聯.i');
  const qAttr = await check.attributeValues('聯.q');
  console.log(`驗收：聯.i ${iAttr?.values.length ?? 0}、聯.q ${qAttr?.values.length ?? 0}`);
  check.close?.();
}
