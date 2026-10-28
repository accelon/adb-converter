/**
 * 跨庫錨點：<聯 i="taisho?51p185b"> 的點擊入口，以及「逆鏈結」。
 *
 * 正向（本文 → 右欄）：
 *   中間點聯 → 右欄「文字內容」顯示目標庫那一頁（含經名／經號／卷）
 *   右欄點聯 → 目標是本庫就回中間；是別庫就換掉右欄
 *   Ctrl/Cmd → 同一側再開分頁
 *
 * 逆鏈結（大正藏 → 其他藏）：
 *   載入一個庫時，掃它的 `聯.i` 屬性（不讀全文），建一張
 *   「目標庫頁碼 → 來源書／頁」的表；顯示大正藏經文時，若這一頁被
 *   某庫連過，就畫出按鈕（《書名》 頁碼），按下在右欄讀來源庫。
 *
 * 目標庫必須已在同一工作階段開過（file:// 不能自己讀硬碟）。
 */
import { AdbReader, BlobIO } from './adb';
import { openDbs, switchTo } from './dbs';
import { mapper, reader, setStatus } from './viewer';
import { ensureRightPane, openForeignTab, setForeignRender } from './text-pane';
import { linkTo } from './link';
import { markLineRange } from './doc-pane';
import { VaPaMapper } from './vapa';
import { variantGroupOf } from './variants';

interface AnchorIndex {
  values: string[];
  pointers: Int32Array;
  vas: number[];
  tags: string[];
  bv: number[];
  lv: number[];
  bookVas: number[];
  juanVas: number[];
  lianVas: number[];
}

const indexCache = new Map<AdbReader, AnchorIndex>();
const foreignReaders = new Map<string, AdbReader>();
const mapperCache = new WeakMap<AdbReader, VaPaMapper>();

let bakedQuotes: Map<string, string[]> | null = null;
/** 從 yinshun.adb 的 xref block 讀「每一頁的候選引文」（對照表抽出的文字） */
async function ensureBaked(rd: AdbReader | null): Promise<void> {
  if (bakedQuotes !== null || !rd) return;
  bakedQuotes = new Map();
  const c = rd.containers.get('xref');
  if (!c) return;
  const bytes = await rd.readBlock('xref', 0);
  const mag = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5]);
  if (mag !== 'XREFQ2') return;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = dv.getUint32(8, true);
  let p = 12;
  const dec = new TextDecoder();
  for (let k = 0; k < n; k++) {
    const la = dv.getUint16(p, true); p += 2;
    const page = dec.decode(bytes.subarray(p, p + la)); p += la;
    const cnt = dv.getUint16(p, true); p += 2;
    const qs: string[] = [];
    for (let j = 0; j < cnt; j++) {
      const lq = dv.getUint16(p, true); p += 2;
      qs.push(dec.decode(bytes.subarray(p, p + lq))); p += lq;
    }
    bakedQuotes.set(page, qs);
  }
}

async function mapperOf(r: AdbReader): Promise<VaPaMapper> {
  let m = mapperCache.get(r);
  if (!m) { m = new VaPaMapper(r); await m.init(); mapperCache.set(r, m); }
  return m;
}

async function anchorIndex(r: AdbReader): Promise<AnchorIndex | null> {
  const hit = indexCache.get(r);
  if (hit) return hit;
  const av = await r.attributeValues('頁.id');
  if (!av || !av.pointers) return null;
  const tagsC = r.containers.get('tags');
  const ti = tagsC?.names.indexOf('頁') ?? -1;
  if (!tagsC || ti < 0) return null;
  const list = async (name: string): Promise<number[]> => {
    const i = tagsC.names.indexOf(name);
    return i < 0 ? [] : r.decodeBlockList('tags', i);
  };
  const idx: AnchorIndex = {
    values: av.values,
    pointers: av.pointers as Int32Array,
    vas: await r.decodeBlockList('tags', ti),
    tags: tagsC.names,
    bv: await r.blocksVirtual(),
    lv: await r.linesVirtual(),
    bookVas: await list('書'),
    juanVas: await list('卷'),
    lianVas: await list('聯'),
  };
  indexCache.set(r, idx);
  return idx;
}

/** 頁 id → VA（走 accelon3 的 attributes/頁.id → pointer → tags/頁 鏈） */
export async function anchorVa(r: AdbReader, anchor: string): Promise<number | null> {
  const idx = await anchorIndex(r);
  if (!idx) return null;
  const i = idx.values.indexOf(anchor);
  if (i < 0) return null;
  const ptr = idx.pointers[i];
  if (idx.tags[(ptr >>> 24) & 0xff] !== '頁') return null;
  return idx.vas[(ptr & 0xffffff) - 1] ?? null;
}

async function readerFor(db: string): Promise<AdbReader | null> {
  if (reader && reader.header.dbname === db) return reader;
  const cached = foreignReaders.get(db);
  if (cached) return cached;
  const slot = openDbs.find((s) => s.file.name.replace(/\.adb$/i, '').toLowerCase() === db.toLowerCase() || s.name === db);
  if (!slot) return null;
  const r = await AdbReader.open(new BlobIO(slot.file));
  foreignReaders.set(db, r);
  return r;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 一行 adb 文字（含標記）→ HTML；<聯> 變成可點的錨點，其餘標記去掉 */
function lineHtml(s: string, markFrom = -1, markTo = -1): string {
  s = s.replace(/^[^<>]*\/>/, ''); // 行首可能是上一個標籤的殘尾
  let out = '';
  let i = 0;
  let cjk = 0;
  let inMark = false;
  while (i < s.length) {
    if (s[i] === '<') {
      const gt = s.indexOf('>', i);
      if (gt < 0) break; // 行尾被切斷的半個標籤：丟掉，不要當文字畫
      const tag = s.slice(i, gt + 1);
      i = gt + 1;
      if (tag.startsWith('</聯')) { out += '</a>'; continue; }
      if (tag.startsWith('</')) continue;
      const m = /^<聯([^>]*)>/.exec(tag);
      if (m) {
        const attrs = m[1];
        const xref = /\bi="([^"]*)"/.exec(attrs)?.[1];
        const xq = /\bq="([^"]*)"/.exec(attrs)?.[1];
        const entry = /\bn="([^"]*)"/.exec(attrs)?.[1];
        if (xref) { out += `<a class="entryLink xrefLink" href="#" data-xref="${esc(xref)}"` + (xq ? ` data-q="${esc(xq)}"` : '') + ` title="${esc(xref)}">`; continue; }
        if (entry) { out += `<a class="entryLink" href="#" data-entry="${esc(entry)}" title="${esc(entry)}">`; continue; }
        continue;
      }
      continue;
    }
    if (markFrom >= 0 && !inMark && cjk >= markFrom && cjk < markTo) { out += '<mark class="xrefHit">'; inMark = true; }
    if (inMark && cjk >= markTo) { out += '</mark>'; inMark = false; }
    out += esc(s[i]);
    if (HAN_RE.test(s[i])) cjk++;
    i++;
  }
  if (inMark) out += '</mark>';
  return out;
}

// ---------------------------------------------------------------- 逆鏈結表

interface RevEntry { src: string; db: string; va: number; pageId: string; bookVa: number; cite: string; quote: string }
let revKey = '';
let revIndex: Map<string, RevEntry[]> = new Map();
const linkedDbs = new Set<string>();

/**
 * 反連表的來源：**每一個開著的庫**，不只主庫。
 *
 * 原本只掃主庫的 `聯.i`，所以把大正藏當成主庫（例如用「跳至」跳過去）時，
 * 大正藏自己沒有 `聯` 屬性，表就空著——明明右邊還開著印順，卻看不到回連結按鈕。
 * 現在主庫優先，其餘開啟中的庫依序補上；同一個庫只掃一次。
 */
function reverseSources(): AdbReader[] {
  const out: AdbReader[] = [];
  const seen = new Set<AdbReader>();
  const push = (r: AdbReader | null | undefined): void => {
    if (!r || seen.has(r)) return;
    seen.add(r);
    out.push(r);
  };
  push(reader);
  for (const s of openDbs) push((s.core as { reader?: AdbReader } | undefined)?.reader);
  return out;
}

async function ensureReverse(): Promise<void> {
  const sources = reverseSources();
  // 只讀屬性就能判斷「要不要重建」：庫的組合或行數變了才重建
  const key = sources.map((r) => r.header.dbname + ':' + r.header.lineCount).join('|');
  if (key === revKey) return;
  revKey = key;
  revIndex = new Map();
  linkedDbs.clear();
  for (const r of sources) await addReverseFrom(r);
}

/** 把一個庫的 `聯.i` 併進反連表：目標頁碼 → 來源的書／頁。只讀屬性，不讀全文。 */
async function addReverseFrom(r: AdbReader): Promise<void> {
  const idx = await anchorIndex(r);
  if (!idx) return;
  const av = await r.attributeValues('聯.i');
  if (!av || !av.pointers) return;
  // 頁 VA → 頁碼
  const pageByVa = new Map<number, string>();
  for (let k = 0; k < idx.values.length; k++) pageByVa.set(idx.vas[(idx.pointers[k] & 0xffffff) - 1], idx.values[k]);
  const pageVas = [...pageByVa.keys()].sort((a, b) => a - b);
  const lastLE = (arr: number[], v: number): number => {
    let lo = 0, hi = arr.length - 1, ans = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (arr[mid] <= v) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return ans;
  };
  for (let k = 0; k < av.values.length; k++) {
    const val = av.values[k];
    const q = val.indexOf('?');
    if (q <= 0) continue;
    const db = val.slice(0, q);
    const anchor = val.slice(q + 1);
    const ptr = av.pointers[k];
    if (idx.tags[(ptr >>> 24) & 0xff] !== '聯') continue;
    const va = idx.lianVas[(ptr & 0xffffff) - 1];
    if (va == null) continue;
    linkedDbs.add(db);
    const pi = lastLE(pageVas, va);
    const bi = lastLE(idx.bookVas, va);
    const entry: RevEntry = {
      src: r.header.dbname, db, va,
      pageId: pi >= 0 ? pageByVa.get(pageVas[pi]) ?? '' : '',
      bookVa: bi >= 0 ? idx.bookVas[bi] : -1,
      cite: '',
      quote: '',
    };
    // 這一聯的顯示文字（例「五一‧一八五中」），回印順時用來塗紅
    try {
      const m = await mapperOf(r);
      const dt = await m.docText(va, va + 700, 20);
      const raw = dt.lines.join('');
      const mm = /<聯[^>]*>([\s\S]*?)<\/聯>/.exec(raw);
      if (mm) entry.cite = mm[1].replace(/<[^>]*>/g, '').trim();
      // 聯後面的「…」引文，回印順時一起塗紅
      const tail = mm ? raw.slice((mm.index ?? 0) + mm[0].length) : raw;
      const qm = /「([^」]{8,240})」/.exec(tail) || /「([^」]{8,240})」/.exec(raw.slice(0, mm?.index ?? 0));
      if (qm) entry.quote = qm[1];
    } catch { /* 取不到就算了 */ }
    const key = db + '?' + anchor;
    const arr = revIndex.get(key);
    if (arr) arr.push(entry); else revIndex.set(key, [entry]);
    // 大正藏一頁有三欄（a/b/c）：讀者在 a 欄時，連到 b、c 欄的引文也該看得到，
    // 所以另外用「頁」為鍵收一份（作者 2026-10-28）。
    const pageKey = db + '?' + anchor.replace(/[a-z]$/, '');
    if (pageKey !== key) {
      const parr = revIndex.get(pageKey);
      if (parr) parr.push(entry); else revIndex.set(pageKey, [entry]);
    }
  }
}

/** 某個目標庫被哪些主庫連過（載入時就知道了） */
export function linkedTargets(): string[] { return [...linkedDbs]; }

// ---------------------------------------------------------------- 顯示

interface TagCtx { title: string; no: string; juan: string }

/** VA → source block index */
function blockOf(idx: AnchorIndex, va: number): number {
  let blk = 0;
  for (let k = 0; k < idx.bv.length; k++) { if (idx.bv[k] <= va) blk = k; else break; }
  return blk;
}

/** 從 va 往前找最近一個 <tag>…</tag> 的純文字（可跨回前幾個區塊） */
async function prevTagText(r: AdbReader, idx: AnchorIndex, va: number, tag: string, maxBlocks = 6): Promise<string> {
  const blk0 = blockOf(idx, va);
  for (let b = blk0; b >= 0 && b > blk0 - maxBlocks; b--) {
    const text = await r.sourceText(b);
    const upto = b === blk0 ? Math.max(0, va - idx.bv[b]) : text.length;
    const i = text.lastIndexOf('<' + tag, upto);
    if (i < 0) continue;
    const open = text.indexOf('>', i);
    if (open < 0) continue;
    const close = text.indexOf('</' + tag + '>', open);
    const body = close > open ? text.slice(open + 1, close) : text.slice(open + 1, open + 400);
    return body.replace(/<[^>]*>/g, '').trim();
  }
  return '';
}

/** va 往前最近的 <書>（書名）＋其後 800 字內的 No. N */
async function bookAt(r: AdbReader, idx: AnchorIndex, va: number): Promise<{ title: string; no: string }> {
  const blk0 = blockOf(idx, va);
  for (let b = blk0; b >= 0 && b > blk0 - 8; b--) {
    const text = await r.sourceText(b);
    const upto = b === blk0 ? Math.max(0, va - idx.bv[b]) : text.length;
    const i = text.lastIndexOf('<書', upto);
    if (i < 0) continue;
    const open = text.indexOf('>', i);
    const close = text.indexOf('</書>', open);
    const title = (close > open ? text.slice(open + 1, close) : '').replace(/<[^>]*>/g, '').trim();
    let tail = text.slice(open + 1, open + 900);
    if (b + 1 < idx.bv.length && tail.length < 900) tail += await r.sourceText(b + 1);
    const m = /No\.\s*(\d+)/.exec(tail);
    return { title, no: m ? m[1] : '' };
  }
  return { title: '', no: '' };
}

const labelCache = new WeakMap<AdbReader, Map<string, string[]>>();

/** 用 caches/<tag> 的標籤（書名、卷名）對回 tags/<tag> 的順序 */
async function cachedLabel(r: AdbReader, tag: string, vas: number[], va: number): Promise<string> {
  let m = labelCache.get(r);
  if (!m) { m = new Map(); labelCache.set(r, m); }
  let names = m.get(tag);
  if (!names) { try { names = await r.cachedStrings(tag); } catch { names = []; } m.set(tag, names); }
  if (!names.length) return '';
  let lo = 0, hi = vas.length - 1, ans = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (vas[mid] <= va) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  return ans >= 0 ? (names[ans] ?? '') : '';
}

async function contextOf(r: AdbReader, idx: AnchorIndex, va: number): Promise<TagCtx> {
  const title = await cachedLabel(r, '書', idx.bookVas, va);
  const juan = await cachedLabel(r, '卷', idx.juanVas, va);
  const no = (await bookAt(r, idx, va)).no;
  return { title, no, juan };
}

/** 把目標庫的某一頁（從 anchor 起，到下一個 <頁> 為止）畫成右欄 HTML */
/** 把一行含標記的文字畫成 HTML，並把第 from..to 個漢字包進 <mark>（純比對用，這一行不再長聯結錨點） */
const HAN_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
/** 異體字折疊：把每個字換成它那一組的代表字（比對用，不改原文） */
function foldVariants(s: string): string {
  const out: string[] = [];
  for (const ch of s) {
    const g = variantGroupOf(ch);
    out.push(g ? g[0] : ch);
  }
  return out.join('');
}
/** 依「原始字元位置」（含標點，不含標籤）塗紅；同一底本的精確引文用這個最準 */
function markRaw(s: string, from: number, to: number): string {
  let out = '', i = 0, inMark = false;
  while (i < s.length) {
    if (s[i] === '<') { const gt = s.indexOf('>', i); if (gt < 0) break; i = gt + 1; continue; }
    if (i >= from && i < to && !inMark) { out += '<mark class="xrefHit">'; inMark = true; }
    if (i >= to && inMark) { out += '</mark>'; inMark = false; }
    out += esc(s[i]);
    i++;
  }
  if (inMark) out += '</mark>';
  return out;
}

function markLine(s: string, from: number, to: number): string {
  let out = '', i = 0, n = 0, inMark = false;
  while (i < s.length) {
    if (s[i] === '<') { const gt = s.indexOf('>', i); if (gt < 0) break; i = gt + 1; continue; }
    const ch = s[i];
    if (HAN_RE.test(ch)) {
      if (n >= from && n < to && !inMark) { out += '<mark class="xrefHit">'; inMark = true; }
      if ((n >= to || n < from) && inMark) { out += '</mark>'; inMark = false; }
      n++;
    }
    out += esc(ch);
    i++;
  }
  if (inMark) out += '</mark>';
  return out;
}

/** 最長共同子序列（允許插入／刪字），回傳匹配字數與在 b 的首尾位置 */
function lcsSpan(a: string, b: string): { count: number; bFirst: number; bLast: number } {
  const A = Array.from(a), B = Array.from(b);
  const n = A.length, m = B.length;
  if (!n || !m) return { count: 0, bFirst: 0, bLast: 0 };
  // dp[i][j] = LCS 長度（只保留兩列以省記憶體）
  const prev = new Int32Array(m + 1);
  const rows: Int32Array[] = [];
  for (let i = 1; i <= n; i++) {
    const cur = new Int32Array(m + 1);
    for (let j = 1; j <= m; j++) {
      cur[j] = A[i - 1] === B[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    rows.push(cur);
    prev.set(cur);
  }
  const count = prev[m];
  // 回溯找出最後一個匹配在 b 的位置，以及第一個
  let i = n, j = m, bLast = -1, bFirst = -1;
  while (i > 0 && j > 0) {
    if (A[i - 1] === B[j - 1]) { if (bLast < 0) bLast = j - 1; bFirst = j - 1; i--; j--; }
    else if (rows[i - 2]?.[j] >= rows[i - 1]?.[j - 1]) i--;
    else j--;
  }
  return { count, bFirst, bLast };
}

export async function renderForeign(db: string, va: number, anchor?: string, quote?: string): Promise<{ html: string; title: string }> {
  const r = await readerFor(db);
  if (!r) return { html: '<p class="dim">請先把 ' + esc(db) + '.adb 開起來（同一個瀏覽器工作階段）。</p>', title: db };
  const idx = await anchorIndex(r);
  if (!idx) return { html: '<p class="dim">這個庫沒有頁碼表。</p>', title: db };
  await ensureReverse();
  const maxChars = 2000;
  let blk = 0;
  for (let k = 0; k < idx.bv.length; k++) { if (idx.bv[k] <= va) blk = k; else break; }
  let blockText = await r.sourceText(blk);
  let startAt = va - idx.bv[blk];
  if (anchor) {
    // 頁碼的 VA 與實際標籤位置可能有差；往前後幾個 block 找，找到才切
    let at = -1;
    for (const off of [0, -1, 1, -2, 2, -3, 3, -4, 4, -5, 5, -6, 6, -8, 8]) {
      const b = blk + off;
      if (b < 0 || b >= idx.bv.length) continue;
      const t = off === 0 ? blockText : await r.sourceText(b);
      const k = t.indexOf('<頁 id="' + anchor + '"');
      if (k >= 0) { blockText = t; blk = b; at = k; break; }
    }
    if (at >= 0) startAt = at;
  }
  let raw = blockText.slice(startAt);
  let baseVa = idx.bv[blk] + startAt;
  if (raw.startsWith('<頁')) {
    const gt = raw.indexOf('>');
    if (gt > 0) { raw = raw.slice(gt + 1); baseVa += gt + 1; }
  }
  for (let b = blk + 1; raw.length < maxChars && b < idx.bv.length; b++) raw += await r.sourceText(b);
  const cut = raw.indexOf('<頁 ');
  if (cut > 0) raw = raw.slice(0, cut);
  if (raw.length > maxChars) raw = raw.slice(0, maxChars);

  const pageId = anchor ?? idx.values.find((v, k) => idx.vas[(idx.pointers[k] & 0xffffff) - 1] === va) ?? '';
  await ensureBaked(reader && reader.containers.has('xref') ? reader : null);
  const cands: string[] = db === 'taisho' ? bakedQuotes?.get(pageId) ?? [] : [];

  // 不再用 lines.virtual 切行：它與原始字元的對應不可靠，會把 <聯> 標籤切斷。
  const rawLines: string[] = [raw];

  // 引文塗紅：即時引文優先；沒有就用對照表候選（單筆直接用，多筆才比相似度）
  let bodyHtml = '';
  let hitLen = 0;
  if (quote || cands.length) {
    const chars: string[] = [];
    const rawAt: number[] = [];
    for (let i = 0; i < raw.length; i++) {
      if (raw[i] === '<') { const gt = raw.indexOf('>', i); if (gt < 0) break; i = gt; continue; }
      if (HAN_RE.test(raw[i])) { chars.push(raw[i]); rawAt.push(i); }
    }
    const pn = foldVariants(chars.join(''));
    const matchOf = (src: string) => {
      const qn = foldVariants(Array.from(src).filter((c) => HAN_RE.test(c)).join('').slice(0, 160));
      if (!qn || !pn) return null;
      let count = 0, bFirst = -1, bLast = -1;
      const exact = pn.indexOf(qn);
      if (exact >= 0) { count = qn.length; bFirst = exact; bLast = exact + qn.length - 1; }
      else if (qn.length >= 12) {
        const r2 = lcsSpan(qn, pn);
        count = r2.count; bFirst = r2.bFirst; bLast = r2.bLast;
        if (bLast - bFirst + 1 > qn.length * 2 + 4) count = 0;
      }
      const denom = Math.min(qn.length, 80);
      const ok = count > 0 && (count >= 12 || (count >= 6 && count >= denom * 0.5)) && bFirst >= 0;
      return ok ? { count, bFirst, bLast, qn } : null;
    };
    let hit = quote ? matchOf(quote) : null;
    if (!hit && cands.length === 1) hit = matchOf(cands[0]);
    if (!hit && quote && cands.length > 1) {
      const qn = foldVariants(Array.from(quote).filter((c) => HAN_RE.test(c)).join('')).slice(0, 40);
      let best: { count: number; bFirst: number; bLast: number; qn: string } | null = null;
      for (const c of cands) {
        const m = matchOf(c);
        if (!m) continue;
        const sim = qn ? lcsSpan(qn, m.qn) : 0;
        if (sim >= 8 && (!best || m.count > best.count)) best = m;
      }
      hit = best;
    }
    (globalThis as any).__xrefLast = { cands: cands.length, quoteLen: quote?.length ?? 0, hit: hit?.count ?? 0 };
    if (hit) { hitLen = hit.count; bodyHtml = lineHtml(raw, hit.bFirst, hit.bLast + 1); }
  }
  if (!bodyHtml) bodyHtml = rawLines.map((t) => lineHtml(t)).join('<br>');

  // 這一段的經名／經號／卷
  const ctx = await contextOf(r, idx, baseVa);
  const meta: string[] = [];
  if (ctx.no) meta.push('No. ' + ctx.no);
  if (ctx.title) meta.push(ctx.title);
  if (ctx.juan) {
    const j = ctx.title && ctx.juan.includes(ctx.title) ? ctx.juan.split(ctx.title).filter(Boolean).pop() ?? '' : ctx.juan;
    if (j.trim()) meta.push(j.trim());
  }
  const head = '<div class="docHead">' + esc(r.header.dbcname || db)
    + (meta.length ? ' <span class="dim">' + esc(meta.join(' · ')) + '</span>' : '')
    + ' <span class="dim">' + esc(pageId) + '</span></div>';

  // 逆鏈結：這一頁被哪些庫／書連過
  const rev = await revBarHtml(db, pageId);

  const html = head + rev + '<div class="docBody reflow"><p class="docPara">' + bodyHtml + '</p></div>';
  return { html, title: db + ' ' + pageId };
}

/**
 * 「回連結」那一列按鈕（作者 2026-10-28）：右欄的跨庫頁面與中間的本文都用它，
 * 所以抽成一支。目標庫沒有被連過就回空字串。
 */
async function revBarHtml(db: string, pageId: string): Promise<string> {
  if (!revIndex.size || !pageId) return '';
  // 先看這一欄；整頁（a/b/c 三欄）如果還有別的欄被引用，就一併列出（作者 2026-10-28）
  const colEntries = revIndex.get(db + '?' + pageId) ?? [];
  const pageEntries = revIndex.get(db + '?' + pageId.replace(/[a-z]$/, '')) ?? [];
  const wholePage = pageEntries.length > colEntries.length;
  const entries = wholePage ? pageEntries : colEntries;
  if (!entries.length) return '';
  // 同一本書同一頁常常被引用好幾次：按鈕只留一個（按下去到的地方一樣），總數另外寫
  const uniq = new Map<string, RevEntry>();
  for (const e of entries) {
    const k = e.src + ':' + e.pageId + ':' + e.va;
    uniq.set(k, e);
  }
  const total = uniq.size;
  const btns: string[] = [];
  const seenLabel = new Set<string>();
  let n = 0;
  for (const e of uniq.values()) {
    if (n >= 12) break;
    const srcR = await readerFor(e.src);
    const srcIdx = srcR ? await anchorIndex(srcR) : null;
    const name = (srcR && srcIdx ? (await cachedLabel(srcR, '書', srcIdx.bookVas, e.va)) : '') || e.src;
    const label = '《' + name + '》 ' + e.pageId;
    if (seenLabel.has(label)) continue;
    seenLabel.add(label);
    n++;
    btns.push('<button class="mini xrefRev" type="button" data-rrev="' + esc(e.src + '|' + e.va) + '" data-rrev-label="' + esc(label) + '" data-rpage="' + esc(e.pageId) + '" data-rcite="' + esc(e.cite) + '" data-rquote="' + esc(e.quote) + '">'
      + esc(label) + '</button>');
  }
  const more = total > btns.length ? '<span class="dim">…共 ' + total + ' 條</span>' : '';
  const scope = wholePage ? '本頁（含其他欄）' : '';
  return '<div class="xrefRevBar"><span class="dim">回連結' + (scope ? '·' + scope : '')
    + '（' + esc([...new Set(entries.map((e) => e.src))].join('、')) + '）：</span>' + btns.join('') + more + '</div>';
}

/** 本文中間那一頁的頁 id（給中間的「回連結」用） */
export async function pageIdAtVa(va: number): Promise<string> {
  if (!reader) return '';
  const idx = await anchorIndex(reader);
  if (!idx) return '';
  let lo = 0, hi = idx.vas.length - 1, k = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (idx.vas[m] <= va) { k = m; lo = m + 1; } else hi = m - 1; }
  return k >= 0 ? idx.values[k] : '';
}

/** 中間那一頁的回連結列（doc-pane 畫完頁面後呼叫；沒有就回空字串） */
export async function reverseBarForPage(pageId: string): Promise<string> {
  if (!reader || !pageId) return '';
  await ensureReverse();
  return revBarHtml(reader.header.dbname, pageId);
}

async function handleXref(value: string, fromRight: boolean, newTab: boolean, quote?: string): Promise<void> {
  const q = value.indexOf('?');
  const db = q >= 0 ? value.slice(0, q) : '';
  const anchor = q >= 0 ? value.slice(q + 1) : value;
  if (!db || !anchor) return;
  ensureRightPane();
  const main = reader;
  const mainName = main?.header.dbname ?? '';
  const target = await readerFor(db);
  if (!target) { setStatus('請先開啟 ' + db + '.adb（工具列資料夾圖示）', 'warn'); return; }
  const va = await anchorVa(target, anchor);
  if (va == null) { setStatus((db === mainName ? '本庫' : db) + ' 找不到頁碼 ' + anchor, 'err'); return; }
  const short = db === 'taisho' ? 'T' : db.slice(0, 4);
  if (!fromRight) {
    if (db === mainName) { await linkTo(va, anchor, 1, { newTab, exact: true }); return; }
    openForeignTab(db, va, short + ' ' + anchor, newTab, anchor, quote);
    return;
  }
  if (db === mainName) { await linkTo(va, anchor, 1, { newTab, exact: true }); return; }
  openForeignTab(db, va, short + ' ' + anchor, newTab, anchor, quote);
}

export async function xrefJump(value: string, fromRight = false, newTab = false, quote?: string): Promise<void> {
  await handleXref(value, fromRight, newTab, quote);
}

/* ------------------------------------------------------------------ 大正藏引用
 *
 * 「大正2，206a15-b13」＝第二冊、206 頁 a 欄第 15 行，到同頁 b 欄第 13 行。
 * 冊號有時寫成國字（大正二），所以數字兩種都吃。
 * 頁 id 在 taisho.adb 就是 `2p206a`，a 欄的行號 1..N 對應 `<頁 id="2p206a">` 那一行起算的 N 行。
 */
export interface TaishoCite {
  vol: number;
  page: string;
  col: string;
  line: number;
  endPage?: string;
  endCol?: string;
  endLine?: number;
}

const CN_NUM: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** 「二」「二十四」「一百零五」→ 24 / 105；阿拉伯數字原樣 */
function numOf(s: string): number | null {
  if (/^\d+$/.test(s)) return Number(s);
  let total = 0, cur = 0, seen = false;
  for (const ch of s) {
    if (ch === '百') { total += (cur || 1) * 100; cur = 0; seen = true; }
    else if (ch === '十') { total += (cur || 1) * 10; cur = 0; seen = true; }
    else if (CN_NUM[ch]) { cur = CN_NUM[ch]; seen = true; }
    else if (ch === '〇' || ch === '零') continue;
    else return null;
  }
  if (!seen) return null;
  return total + cur;
}

export function parseTaishoCite(raw: string): TaishoCite | null {
  // 全形 → 半形，並去掉空白（讀者常從 PDF／網頁複製，逗號是「，」）
  const s = raw.replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/\s+/g, '');
  const m = /^(?:大正|T)?([0-9]+|[一二三四五六七八九十百〇零]+)[,，](\d+)([abc])(\d{1,2})(?:[-–—~至](\d+)?([abc])(\d{1,2}))?$/i.exec(s);
  if (!m) return null;
  const vol = numOf(m[1]);
  if (vol == null) return null;
  return {
    vol,
    page: m[2],
    col: m[3].toLowerCase(),
    line: Number(m[4]),
    endPage: m[5] ?? undefined,
    endCol: m[6]?.toLowerCase(),
    endLine: m[7] ? Number(m[7]) : undefined,
  };
}

const taishoDbSlot = () => openDbs.find((d) => d.name.includes('大正') || /^taisho/i.test(d.file.name));

/**
 * 跳到「大正 V，P C L[-C L]」並把整段塗上色帶。
 * 目前開的庫裡沒有這個頁時，會切到已開啟的大正藏（讀者常在印順的頁上抄大正藏座標）。
 */
export async function jumpTaishoCite(c: TaishoCite): Promise<boolean> {
  const id = `${c.vol}p${c.page}${c.col}`;
  let va = reader ? await anchorVa(reader, id) : null;
  if (va == null) {
    const slot = taishoDbSlot();
    if (slot) {
      switchTo(slot.id);
      va = reader ? await anchorVa(reader, id) : null;
    }
  }
  if (va == null || !reader) { setStatus('找不到 ' + id + '（這個庫沒有這一頁）', 'err'); return false; }
  await linkTo(va, '', 1, { mode: 'node', noMark: true, name: id });
  const m = mapper;
  if (!m) return true;
  const startLine = m.lineOfVa(va) + Math.max(0, c.line - 1);
  let endLine = startLine;
  if (c.endCol) {
    const eid = `${c.vol}p${c.endPage ?? c.page}${c.endCol}`;
    const eva = await anchorVa(reader, eid);
    if (eva != null) endLine = m.lineOfVa(eva) + Math.max(0, (c.endLine ?? 1) - 1);
  }
  markLineRange(startLine, endLine);
  return true;
}

export async function xrefProbe(db: string, anchor: string) {
  const r = await readerFor(db);
  if (!r) return { error: 'no db' };
  const idx = await anchorIndex(r);
  if (!idx) return { error: 'no index' };
  const va = await anchorVa(r, anchor);
  let blk = 0;
  for (let k = 0; k < idx.bv.length; k++) { if (idx.bv[k] <= (va ?? 0)) blk = k; else break; }
  const raw = va == null ? '' : (await r.sourceText(blk)).slice(va - idx.bv[blk], va - idx.bv[blk] + 60);
  return { va, blk, bv0: idx.bv[blk], raw };
}

export async function previewForeign(db: string, anchor: string, quote?: string) {
  const r = await readerFor(db);
  if (!r) return 'no db';
  const va = await anchorVa(r, anchor);
  if (va == null) return 'no va';
  const out = await renderForeign(db, va, anchor, quote);
  const dm = /data-q="([^"]+)"/.exec(out.html);
  return { mark: out.html.includes('<mark'), dbg: (globalThis as any).__xrefLast ?? null, dataQ: dm ? dm[1].slice(0, 40) : null, xrefSnippet: (out.html.match(/<a[^>]*data-xref[^>]*>/) || [''])[0].slice(0, 120), head: out.html.slice(0, 120) };
}

export function xrefDebug() {
  return {
    main: reader?.header.dbname ?? '',
    slots: openDbs.map((s) => ({ name: s.name, file: s.file.name })),
    foreign: [...foreignReaders.keys()],
    linked: [...linkedDbs],
    revKeys: revIndex.size,
    hasXref: !!reader?.containers.has('xref'),
    baked: bakedQuotes?.size ?? -1,
  };
}

/** 取連結前後的引文（含「」的段落優先），給目標頁做塗紅比對 */
function quoteNear(a: HTMLElement): string {
  const line = a.closest('.docLine');
  if (!line) return '';
  let before = '', after = '';
  try {
    const r = document.createRange();
    r.setStart(line, 0); r.setEndBefore(a);
    before = r.toString();
    r.setStartAfter(a); r.setEnd(line, line.childNodes.length);
    after = r.toString();
  } catch { /* 取不到就用整行 */ }
  let tail = '';
  let el: Element | null = line.nextElementSibling;
  for (let i = 0; i < 3 && el; i++) { tail += (el as HTMLElement).textContent ?? ''; el = el.nextElementSibling; }
  // 優先取「…」裡的引文（聯後面最常見），沒有才用前後文
  const quoted = (s: string) => {
    const m = /「([^」]{8,300})」/.exec(s);
    return m ? m[1] : '';
  };
  const qa = quoted(after + tail) || quoted(before.slice(-200)) || quoted(before);
  if (qa) return qa.slice(0, 240);
  return (before.slice(-80) + after + tail).slice(0, 240);
}

let bound = false;

export function initXref(): void {
  setForeignRender(renderForeign);
  if (bound) return;
  bound = true;
  document.addEventListener('click', (ev) => {
    const rev = (ev.target as Element | null)?.closest?.('[data-rrev]') as HTMLElement | null;
    if (rev) {
      ev.preventDefault();
      ev.stopPropagation();
      const [db, vaStr] = (rev.dataset.rrev ?? '').split('|');
      if (!db || !vaStr) return;
      ensureRightPane();
      openForeignTab(db, Number(vaStr), rev.dataset.rrevLabel ?? db, ev.ctrlKey || ev.metaKey, rev.dataset.rpage || undefined, rev.dataset.rcite || rev.dataset.rquote || undefined);
      return;
    }
    const a = (ev.target as Element | null)?.closest?.('a[data-xref]') as HTMLElement | null;
    if (!a) return;
    ev.preventDefault();
    ev.stopPropagation();
    const fromRight = !!a.closest('#textBody');
    void handleXref(a.dataset.xref ?? '', fromRight, ev.ctrlKey || ev.metaKey, (a.dataset.q || (fromRight ? '' : quoteNear(a))));
  }, true);
  // 主庫換了（或第一次載入）就重建反連表
  document.addEventListener('accelon26:db', () => { revKey = ''; void buildReverseIfPossible(); });
  void buildReverseIfPossible();
}

async function buildReverseIfPossible(): Promise<void> {
  if (!reader) return;
  await ensureReverse();
  void linkedTargets();
}

/** 由 UI 在開庫後呼叫：建立反連表（很快，只讀屬性）。 */
export async function refreshReverse(): Promise<void> {
  revKey = '';
  await buildReverseIfPossible();
}
