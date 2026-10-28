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
import { SHORT_TITLES } from './short-titles';

interface AnchorIndex {
  values: string[];
  pointers: Int32Array;
  vas: number[];
  tags: string[];
  bv: number[];
  lv: number[];
  bookVas: number[];
  juanVas: number[];
  volVas: number[];
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
    volVas: await list('冊'),
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

export async function readerFor(db: string): Promise<AdbReader | null> {
  if (reader && reader.header.dbname === db) return reader;
  const cached = foreignReaders.get(db);
  if (cached) return cached;
  const slot = openDbs.find((s) => s.file.name.replace(/\.adb$/i, '').toLowerCase() === db.toLowerCase() || s.name === db);
  if (!slot) return null;
  const r = await AdbReader.open(new BlobIO(slot.file));
  foreignReaders.set(db, r);
  return r;
}

export interface BookHit { db: string; va: number; title: string; pageVa?: number; pageId?: string }

const bookCache = new WeakMap<AdbReader, Promise<{ title: string; va: number }[]>>();

async function bookList(r: AdbReader): Promise<{ title: string; va: number }[]> {
  const cached = bookCache.get(r);
  if (cached) return cached;
  const p = (async () => {
    const tc = r.containers.get('tags');
    const i = tc?.names.indexOf('書') ?? -1;
    if (!tc || i < 0) return [];
    const vas = await r.decodeBlockList('tags', i);
    const names = await r.cachedStrings('書').catch(() => [] as string[]);
    const out: { title: string; va: number }[] = [];
    for (let k = 0; k < vas.length; k++) {
      const title = names[k] ?? '';
      if (title) out.push({ title, va: vas[k] });
    }
    return out;
  })();
  bookCache.set(r, p);
  return p;
}

const normBook = (s: string): string => s.replace(/[^\p{L}\p{N}]/gu, '');

/** 常見簡稱 → 大正藏題名（《金剛經》這種簡稱不能只靠字面比對）。 */
const BOOK_ALIASES: Record<string, string[]> = {
  金剛經: ['金剛般若波羅蜜經'],
  心經: ['般若波羅蜜多心經'],
  法華經: ['妙法蓮華經'],
  華嚴經: ['大方廣佛華嚴經'],
  般若經: ['大般若波羅蜜多經'],
  大般若經: ['大般若波羅蜜多經'],
  涅槃經: ['大般涅槃經'],
  大涅槃經: ['大般涅槃經'],
  楞嚴經: ['大佛頂如來密因修證了義諸菩薩萬行首楞嚴經'],
  楞伽經: ['楞伽阿跋多羅寶經'],
  圓覺經: ['大方廣圓覺修多羅了義經'],
  維摩經: ['維摩詰所說經'],
  起信論: ['大乘起信論'],
  俱舍論: ['阿毘達磨俱舍論'],
};

/** 書名相似度：完全符合 → 開頭 → 包含 → 依序出現（處理《金剛經》→《金剛般若波羅蜜經》）。 */
function bookScore(q: string, title: string): number {
  if (title === q) return 0;
  const qEnd = [...q].at(-1);
  const tEnd = [...title].at(-1);
  // 選《金剛經》時，優先「…經」本經，不要先抓到《金剛經疏》這類註疏。
  const endingPenalty = (qEnd === '經' || qEnd === '論') && tEnd !== qEnd ? 20 : 0;
  if (title.startsWith(q)) return 1 + title.length / 100 + endingPenalty;
  if (q.startsWith(title)) return 2 + q.length / 100 + endingPenalty;
  if (title.includes(q)) return 12 + title.length / 100 + endingPenalty;
  if (q.includes(title)) return 13 + title.length / 100 + endingPenalty;
  const qa = [...q], ta = [...title];
  let at = 0, gaps = 0;
  for (const ch of qa) {
    const k = ta.indexOf(ch, at);
    if (k < 0) return Infinity;
    gaps += Math.max(0, k - at);
    at = k + 1;
  }
  return 10 + gaps + title.length / 100 + endingPenalty;
}

/**
 * 在有「書名」快取的庫（大正藏）裡找一本書；給選取選單的「開《…》」用。
 * query 可以是《金剛經》這類簡稱，會用書名子序列比對完整題名。
 */
export async function lookupBook(db: string, query: string): Promise<BookHit | null> {
  const r = await readerFor(db);
  if (!r) return null;
  let q = query.trim();
  const inside = /《([^》]+)》/.exec(q);
  if (inside) q = inside[1];
  q = q.replace(/^[「『《〈（(【\[]+|[」』》〉）)】\]]+$/g, '').replace(/[，。；：、！？…\s]+$/g, '').trim();
  const nq = normBook(q);
  if ([...nq].length < 2) return null;
  const books = await bookList(r);
  const aliases = BOOK_ALIASES[nq];
  if (aliases) {
    for (const a of aliases) {
      const hits = books.filter((b) => normBook(b.title) === normBook(a));
      const hit = hits.at(-1);       // 同一題名有幾個版本時，取最後一個（通常才是正文，不是前面的參照）
      if (hit) return { db, va: hit.va, title: hit.title };
    }
  }
  let best: { title: string; va: number } | null = null;
  let bestScore = Infinity;
  for (const b of books) {
    const nt = normBook(b.title);
    if (!nt) continue;
    const score = bookScore(nq, nt);
    if (score < Infinity && score <= bestScore) { bestScore = score; best = b; }
  }
  if (!best) return null;
  const hit: BookHit = { db, va: best.va, title: best.title };
  const idx = await anchorIndex(r);
  if (idx) {
    let pi = -1;
    for (let i = 0; i < idx.values.length; i++) {
      const ptr = idx.pointers[i];
      if (idx.tags[(ptr >>> 24) & 0xff] !== '頁') continue;
      const v = idx.vas[(ptr & 0xffffff) - 1];
      if (v < best.va) continue;
      if (pi < 0 || v < idx.vas[(idx.pointers[pi] & 0xffffff) - 1]) pi = i;
    }
    if (pi >= 0) {
      hit.pageId = idx.values[pi];
      hit.pageVa = idx.vas[(idx.pointers[pi] & 0xffffff) - 1];
    }
  }
  return hit;
}

function esc(s: string): string {
  // `"` 一定要跳脫：revButtonHtml 把 cite / quote 放進 data-* 屬性，
  // 引文裡可能出現 `"`（或整段 `<聯 …>` 標記），不跳脫會把屬性切斷。
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
      const me = /^<嵌([^>]*)>/.exec(tag);
      if (me) {
        const attrs = me[1];
        const xref = /\bi="([^"]*)"/.exec(attrs)?.[1];
        const xq = /\bq="([^"]*)"/.exec(attrs)?.[1];
        const xj = /\bj="([^"]*)"/.exec(attrs)?.[1];
        const label = /\bn="([^"]*)"/.exec(attrs)?.[1] ?? '嵌';
        if (xref) {
          out += `<button type="button" class="embedChip" data-embed="${esc(xref)}"`
            + (xq ? ` data-q="${esc(xq)}"` : '') + (xj ? ` data-j="${esc(xj)}"` : '')
            + ` data-label="${esc(label)}" title="嵌入 ${esc(label)} 的引文">▸ ${esc(label)}</button>`;
        }
        continue;
      }
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

interface RevEntry { src: string; db: string; va: number; pageId: string; bookVa: number; cite: string; quote: string; tq: string; targetPage: string }
let revKey = '';
let revIndex: Map<string, RevEntry[]> = new Map();
/** 全部 <聯> 的扁平清單（給「引用分布」熱圖用；每個聯只收一次） */
let allEntries: RevEntry[] = [];
const linkedDbs = new Set<string>();
/** dbname → 中文庫名（回連結那一排的來源標籤） */
const srcLabels = new Map<string, string>();

/**
 * 反連表的來源：**每一個開著的庫**，不只主庫。
 *
 * 原本只掃主庫的 `聯.i`，所以把大正藏當成主庫（例如用「跳至」跳過去）時，
 * 大正藏自己沒有 `聯` 屬性，表就空著——明明右邊還開著印順，卻看不到回連結按鈕。
 * 現在主庫優先，其餘開啟中的庫依序補上；同一個庫只掃一次。
 */
function reverseSources(): AdbReader[] {
  const out: AdbReader[] = [];
  const seen = new Set<string>();
  const push = (r: AdbReader | null | undefined): void => {
    if (!r) return;
    // 同一個庫可能同時以主 reader 與 openDbs 的 reader 出現，用 dbname 去重；
    // 用物件去重會讓同一個庫被掃兩次，反鏈與熱圖的數量都會變兩倍。
    if (seen.has(r.header.dbname)) return;
    seen.add(r.header.dbname);
    out.push(r);
  };
  push(reader);
  for (const s of openDbs) push((s.core as { reader?: AdbReader } | undefined)?.reader);
  return out;
}

let revBuilding: Promise<void> | null = null;
async function ensureReverse(): Promise<void> {
  // 建表期間來的呼叫先排隊；建完再重算 key，避免兩支同時清表／塞表
  // （先前會讓 allEntries 累積成兩倍、三倍，熱圖數字越開越大）。
  for (;;) {
    if (revBuilding) {
      await revBuilding;
      continue;
    }
    const sources = reverseSources();
    const key = sources.map((r) => r.header.dbname + ':' + r.header.lineCount).join('|');
    if (key === revKey) return;
    const idx = new Map<string, RevEntry[]>();
    const entries: RevEntry[] = [];
    const linked = new Set<string>();
    const labels = new Map<string, string>();
    const build = (async () => {
      for (const r of sources) await addReverseFrom(r, idx, entries, linked, labels);
    })();
    revBuilding = build;
    try {
      await build;
      revKey = key;
      revIndex = idx;
      allEntries = entries;
      linkedDbs.clear();
      for (const d of linked) linkedDbs.add(d);
      srcLabels.clear();
      for (const [k, v] of labels) srcLabels.set(k, v);
      document.dispatchEvent(new CustomEvent('accelon26:reverse'));
    } finally {
      revBuilding = null;
    }
    return;
  }
}

/** 把一個庫的 `聯.i` 併進反連表：目標頁碼 → 來源的書／頁。只讀屬性，不讀全文。 */
async function addReverseFrom(
  r: AdbReader,
  outIndex: Map<string, RevEntry[]>,
  outAll: RevEntry[],
  outLinked: Set<string>,
  outLabels: Map<string, string>,
): Promise<void> {
  const idx = await anchorIndex(r);
  if (!idx) return;
  const av = await r.attributeValues('聯.i');
  if (!av || !av.pointers) return;
  // 同一批 <聯> 的 q 屬性（大正藏原文），用來把按鈕嵌到經文那一行（作者 2026-10-28）
  const avq = await r.attributeValues('聯.q');
  const lianTag = idx.tags[(av.pointers[0] >>> 24) & 0xff];
  const qByInst = new Map<number, string>();
  if (avq?.pointers) {
    for (let k = 0; k < avq.values.length; k++) {
      const p = avq.pointers[k];
      if (idx.tags[(p >>> 24) & 0xff] !== lianTag) continue;
      qByInst.set((p & 0xffffff) - 1, avq.values[k]);
    }
  }
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
    const inst = (ptr & 0xffffff) - 1;
    const va = idx.lianVas[inst];
    if (va == null) continue;
    outLinked.add(db);
    outLabels.set(r.header.dbname, r.header.dbcname || r.header.dbname);
    const pi = lastLE(pageVas, va);
    const bi = lastLE(idx.bookVas, va);
    const entry: RevEntry = {
      src: r.header.dbname, db, va,
      pageId: pi >= 0 ? pageByVa.get(pageVas[pi]) ?? '' : '',
      bookVa: bi >= 0 ? idx.bookVas[bi] : -1,
      cite: '',
      quote: '',
      tq: qByInst.get(inst) ?? '',
      targetPage: anchor,
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
      if (qm) entry.quote = qm[1].replace(/<[^>]*>/g, '').trim();
    } catch { /* 取不到就算了 */ }
    outAll.push(entry);
    const key = db + '?' + anchor;
    const arr = outIndex.get(key);
    if (arr) arr.push(entry); else outIndex.set(key, [entry]);
    // 大正藏一頁有三欄（a/b/c）：讀者在 a 欄時，連到 b、c 欄的引文也該看得到，
    // 所以另外用「頁」為鍵收一份（作者 2026-10-28）。
    const pageKey = db + '?' + anchor.replace(/[a-z]$/, '');
    if (pageKey !== key) {
      const parr = outIndex.get(pageKey);
      if (parr) parr.push(entry); else outIndex.set(pageKey, [entry]);
    }
  }
}

/** 某個目標庫被哪些主庫連過（載入時就知道了） */
export function linkedTargets(): string[] { return [...linkedDbs]; }

function lastLEof(arr: number[] | Int32Array, v: number): number {
  let lo = 0, hi = arr.length - 1, ans = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (arr[mid] <= v) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  return ans;
}

/** 目標庫的「頁碼 → 頁 VA」表；熱圖要按 host 的自然次序排，不能每次線性搜頁碼。 */
const pageVaMaps = new Map<string, Map<string, number>>();
async function pageVaMapOf(db: string): Promise<Map<string, number>> {
  const hit = pageVaMaps.get(db);
  if (hit) return hit;
  const m = new Map<string, number>();
  const r = await readerFor(db);
  if (r) {
    const idx = await anchorIndex(r);
    if (idx) {
      for (let k = 0; k < idx.values.length; k++) {
        m.set(idx.values[k], idx.vas[(idx.pointers[k] & 0xffffff) - 1] ?? 0);
      }
    }
  }
  pageVaMaps.set(db, m);
  return m;
}

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
const tagVasCache = new WeakMap<AdbReader, Map<string, number[]>>();

/** 某個標籤在 tags 容器的 VA 表（快取；太虛的 <編>/<章> 需要） */
async function tagVasOf(r: AdbReader, tag: string): Promise<number[]> {
  let m = tagVasCache.get(r);
  if (!m) { m = new Map(); tagVasCache.set(r, m); }
  const hit = m.get(tag);
  if (hit) return hit;
  const ti = r.containers.get('tags')?.names.indexOf(tag) ?? -1;
  const vas = ti < 0 ? [] : await r.decodeBlockList('tags', ti);
  m.set(tag, vas);
  return vas;
}

/** 一個 VA 所屬的書名；沒有 <書> 的庫（太虛）退到 <編>/<集>/<章>。 */
async function sourceLabelAt(r: AdbReader, idx: AnchorIndex, va: number): Promise<string> {
  const book = await cachedLabel(r, '書', idx.bookVas, va);
  if (book) return book;
  for (const tag of ['編', '集', '篇', '章', '節', '文']) {
    const vas = await tagVasOf(r, tag);
    if (!vas.length) continue;
    const name = await cachedLabel(r, tag, vas, va);
    if (name) return name;
  }
  return '';
}

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

export async function renderForeign(db: string, va: number, anchor?: string, quote?: string, range?: string): Promise<{ html: string; title: string }> {
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
    // 頁碼的 VA 與實際標籤位置可能有差；往前後幾個 block 找，找到才切。
    // 同一頁 id 可能出現兩次（大正藏有這種情形），有 quote 時選「含這段引文」的那一個。
    const qh = quote ? foldVariants(Array.from(quote).filter((c) => HAN_RE.test(c)).join('')).slice(0, 40) : '';
    const pageAt = async (b: number, at: number): Promise<string> => {
      let t = (await r.sourceText(b)).slice(at);
      for (let bb = b + 1; t.indexOf('<頁 ') < 0 && bb < idx.bv.length && t.length < maxChars + 500; bb++) t += await r.sourceText(bb);
      const cut = t.indexOf('<頁 ', 1);
      if (cut > 0) t = t.slice(0, cut);
      const gt = t.indexOf('>');
      if (gt >= 0) t = t.slice(gt + 1);
      return t.length > maxChars ? t.slice(0, maxChars) : t;
    };
    let first: { b: number; at: number } | null = null;
    let chosen: { b: number; at: number } | null = null;
    for (const off of [0, -1, 1, -2, 2, -3, 3, -4, 4, -5, 5, -6, 6, -8, 8]) {
      const b = blk + off;
      if (b < 0 || b >= idx.bv.length) continue;
      const t = off === 0 ? blockText : await r.sourceText(b);
      let from = 0, k = t.indexOf('<頁 id="' + anchor + '"');
      while (k >= 0) {
        const cand = { b, at: k };
        if (!first) first = cand;
        if (qh) {
          const pt = await pageAt(b, k);
          const ph = foldVariants(Array.from(pt).filter((c) => HAN_RE.test(c)).join(''));
          if (ph.includes(qh.slice(0, 8))) { chosen = cand; break; }
        }
        from = k + 1;
        k = t.indexOf('<頁 id="' + anchor + '"', from);
      }
      if (chosen) break;
    }
    const pick = chosen ?? first;
    if (pick) {
      blockText = pick.b === blk ? blockText : await r.sourceText(pick.b);
      blk = pick.b;
      startAt = pick.at;
    }
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
    let hit = null as { count: number; bFirst: number; bLast: number; qn: string } | null;
    // <聯 i="…" j="12-34">：字級範圍（相對於目標頁的漢字索引）。
    // 只有和 q 對得上才用；對不上就退回下面的引文比對，避免標錯位置。
    if (range && quote) {
      const mm = /^(\d+)-(\d+)$/.exec(range);
      const qn0 = foldVariants(Array.from(quote).filter((c) => HAN_RE.test(c)).join('').slice(0, 160));
      if (mm && qn0) {
        const from = Number(mm[1]), to = Number(mm[2]);
        if (from >= 0 && to > from && to <= pn.length) {
          const piece = pn.slice(from, to);
          if (piece && piece === qn0.slice(0, piece.length)) hit = { count: piece.length, bFirst: from, bLast: to - 1, qn: qn0 };
        }
      }
    }
    if (!hit && quote) hit = matchOf(quote);
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
 * 按鈕上的書名：corpus 的短名（「般若經講記」→「般若」）。
 * CBETA 的書名寫「華雨集（二）」，corpus 寫「華雨集第二冊」，去掉「第、冊、括號」再比一次。
 */
function shortTitle(name: string): string {
  const hit = SHORT_TITLES[name];
  if (hit) return hit;
  const k = name.replace(/[\s第冊（）()]/g, '');
  for (const full of Object.keys(SHORT_TITLES)) {
    if (full.replace(/[\s第冊（）()]/g, '') === k) return SHORT_TITLES[full];
  }
  return name;
}

/** 反鏈按鈕上要顯示的東西（書名短名＋頁碼＋大正原文 tq，給中間本文定位用） */
export interface RevItem {
  src: string; va: number; pageId: string;
  label: string; book: string; page: string;
  full: string; tq: string; cite: string; quote: string;
  /** 同一來源頁對這一頁的引用次數（跨行引文只算一筆） */
  count: number;
  /** 來源庫的自然次序（VA）：按「來源序」排用 */
  srcVa: number;
  /** 目標庫的自然次序（VA）：按「目標序」排用（同一頁時都相同） */
  hostVa: number;
  hostPage: string;
}

export type RevSort = 'freq' | 'src' | 'host';

/** 三種排序：引用頻次、來源庫自然次序、目標庫自然次序。 */
export function sortRevItems(items: RevItem[], mode: RevSort): RevItem[] {
  const out = items.slice();
  if (mode === 'src') {
    out.sort((a, b) => a.src.localeCompare(b.src) || a.srcVa - b.srcVa || b.count - a.count);
  } else if (mode === 'host') {
    out.sort((a, b) => a.hostVa - b.hostVa || a.src.localeCompare(b.src) || a.srcVa - b.srcVa);
  } else {
    out.sort((a, b) => b.count - a.count || a.src.localeCompare(b.src) || a.srcVa - b.srcVa);
  }
  return out;
}

/**
 * 這一頁的反鏈清單（去重、算好短名、算引用次數）。中間本文拿它逐條比對經文，
 * 把按鈕嵌到引用處；右欄的跨庫頁面則整排畫在標題下。
 */
export async function reverseItemsForPage(db: string, pageId: string, mode: RevSort = 'freq'): Promise<RevItem[]> {
  if (!revIndex.size || !pageId) return [];
  // 先看這一欄；整頁（a/b/c 三欄）如果還有別的欄被引用，就一併列出（作者 2026-10-28）
  const colEntries = revIndex.get(db + '?' + pageId) ?? [];
  const pageEntries = revIndex.get(db + '?' + pageId.replace(/[a-z]$/, '')) ?? [];
  const entries = pageEntries.length > colEntries.length ? pageEntries : colEntries;
  if (!entries.length) return [];
  const uniq = new Map<string, RevEntry>();
  for (const e of entries) uniq.set(e.src + ':' + e.pageId + ':' + e.va, e);
  // 目標頁的 VA（給「目標序」用；同一頁的所有按鈕都一樣，但語義要對）
  let hostVa = 0;
  const hostR = await readerFor(db);
  if (hostR) hostVa = (await anchorVa(hostR, pageId)) ?? 0;

  // 先按「來源庫＋來源頁」分組：同一頁引用好幾次 → count；跨行引文的同一個 q 只算一筆。
  interface Group { e: RevEntry; count: number; firstVa: number; tqs: Set<string> }
  const groups = new Map<string, Group>();
  for (const e of uniq.values()) {
    const gk = e.src + '\u0000' + e.pageId;
    let g = groups.get(gk);
    if (!g) { g = { e, count: 0, firstVa: e.va, tqs: new Set() }; groups.set(gk, g); }
    if (e.va < g.firstVa) { g.e = e; g.firstVa = e.va; }
    const ck = e.tq || e.quote || 'va:' + e.va;
    if (!g.tqs.has(ck)) { g.tqs.add(ck); g.count++; }
  }

  const temp: RevItem[] = [];
  const nameCache = new Map<string, { srcR: AdbReader | null; srcIdx: AnchorIndex | null }>();
  for (const g of groups.values()) {
    const e = g.e;
    let cached = nameCache.get(e.src);
    if (!cached) {
      const srcR = await readerFor(e.src);
      cached = { srcR, srcIdx: srcR ? await anchorIndex(srcR) : null };
      nameCache.set(e.src, cached);
    }
    // 沒有 <書> 的庫（例如太虛全書用 <集>/<編>/<文>）先退到 <編>/<章>，再退中文庫名。
    const name = (cached.srcR && cached.srcIdx ? await sourceLabelAt(cached.srcR, cached.srcIdx, e.va) : '')
      || (cached.srcR ? cached.srcR.header.dbcname : '') || e.src;
    const page = shortPage(e.pageId);
    temp.push({
      src: e.src, va: e.va, pageId: e.pageId, label: '', book: shortTitle(name), page,
      full: name, tq: e.tq, cite: e.cite, quote: e.quote,
      count: g.count, srcVa: g.firstVa, hostVa, hostPage: pageId,
    });
  }

  const out = sortRevItems(temp, mode);
  // 同一本書的連續幾條只寫頁碼，讓按鈕群短一些（作者 2026-10-28）
  let lastBook = '';
  for (const it of out) {
    const bkey = it.src + '|' + it.book;
    it.label = bkey === lastBook ? it.page : it.book + ' ' + it.page;
    lastBook = bkey;
  }
  return out;
}

/** 按鈕上的頁碼：去掉冊號前綴與前導 0（`11p0035a` → `35a`、`2p206a` → `206a`） */
function shortPage(id: string): string {
  return id.replace(/^\d+p/, '').replace(/^0+(?=\d)/, '');
}

/** 一顆反鏈按鈕（按鈕上文字很短，完整書名與頁碼放 title／data） */
export function revButtonHtml(it: RevItem, hidden = false): string {
  const badge = it.count > 1 ? '<span class="xrefRevN">×' + it.count + '</span>' : '';
  const title = '《' + it.full + '》 ' + it.pageId + (it.count > 1 ? ' · ' + it.count + ' 次' : '');
  return '<button class="mini xrefRev' + (hidden ? ' is-hidden' : '') + '" type="button" title="' + esc(title) + '" data-rrev="' + esc(it.src + '|' + it.va) + '" data-rrev-label="' + esc(it.full + ' ' + it.pageId) + '" data-rpage="' + esc(it.pageId) + '" data-rcite="' + esc(it.cite) + '" data-rquote="' + esc(it.quote) + '"'
    + ' data-rbook="' + esc(it.book) + '" data-rp="' + esc(it.page) + '"'
    + ' data-count="' + it.count + '" data-srcva="' + it.srcVa + '" data-hostva="' + it.hostVa + '"'
    + '><span class="revLabel">' + esc(it.label) + '</span>' + badge + '</button>';
}

/**
 * 換行處補回書名（作者 2026-10-28）：同一本書的按鈕只寫頁碼，但一排排到折行時，
 * 新的一行開頭若只剩「69a」，讀者就得回頭找是哪一本。這裡按實際版面（offsetTop）
 * 把每一行第一顆補上書名。
 */
export function relabelRevRows(): void {
  document.querySelectorAll<HTMLElement>('.xrefRevBar, .xrefRevInline').forEach((box) => {
    let lastTop = Number.NaN;
    box.querySelectorAll<HTMLElement>('.xrefRev:not(.is-hidden)').forEach((btn) => {
      const top = btn.offsetTop;
      if (top !== lastTop) {
        const book = btn.dataset.rbook;
        const page = btn.dataset.rp;
        if (book && page) {
          const want = book + ' ' + page;
          const label = btn.querySelector<HTMLElement>('.revLabel');
          if (label && label.textContent !== want) label.textContent = want;
        }
        lastTop = top;
      }
    });
  });
}

/** 一次顯示幾顆；超過就分批，按「＋N」再放一批（作者 2026-10-28） */
const REV_BATCH = 10;

/** 一整組回連結按鈕（含分批的「＋N」） */
export function revButtonsHtml(items: RevItem[]): string {
  const btns = items.map((it, i) => revButtonHtml(it, i >= REV_BATCH)).join('');
  const rest = items.length - REV_BATCH;
  const more = rest > 0
    ? '<button class="mini xrefMore" type="button" data-revmore="' + rest + '" title="再顯示 ' + Math.min(rest, REV_BATCH) + ' 條">＋' + rest + '</button>'
    : '';
  return btns + more;
}

/**
 * 「反鏈」那一排（作者 2026-10-28；2026-10-28 改成可排序＋帶次數）：
 * 右欄的跨庫頁面用。按鈕上的書名用 corpus 的短名（「般若經講記」→「般若」）。
 */
async function revBarHtml(db: string, pageId: string): Promise<string> {
  const items = await reverseItemsForPage(db, pageId, 'freq');
  (globalThis as any).__revBar = { db, pageId, count: items.length, srcs: [...new Set(items.map((i) => i.src))] };
  if (!items.length) return '';
  const srcList = [...new Set(items.map((e) => e.src))];
  const srcs = esc(srcList.map((s) => srcLabels.get(s) ?? s).join('、'));
  const tr = await readerFor(db);
  const hostName = esc(tr?.header.dbcname || db);
  const total = items.reduce((n, it) => n + it.count, 0);
  const singleSrc = srcList.length === 1 ? srcList[0] : '';
  return '<div class="xrefRevBar" data-revhost="' + esc(db) + '" data-revpage="' + esc(pageId) + '">'
    + '<div class="revTop">'
    + '<span class="revTitle">反鏈 <b>' + total + '</b></span>'
    + '<span class="dim revFrom" title="' + srcs + ' → ' + hostName + '">' + srcs + ' → ' + hostName + '</span>'
    + '<span class="revSortSeg" role="group" aria-label="反鏈排序">'
    + '<button type="button" data-revsort="freq" class="active" title="引用次數多的在前">頻次</button>'
    + '<button type="button" data-revsort="src" title="按來源庫的閱讀次序">來源序</button>'
    + '<button type="button" data-revsort="host" title="按目標庫的閱讀次序">目標序</button>'
    + '</span>'
    + '<button type="button" class="mini revHeatBtn" data-revheat="' + esc(db) + '"'
    + (singleSrc ? ' data-revsrc="' + esc(singleSrc) + '"' : '') + ' title="引用分布熱圖">分布</button>'
    + '<button type="button" class="mini revListBtn" data-revlisthost="' + esc(db) + '" data-revlistpage="' + esc(pageId) + '" data-revlistname="' + hostName + '" title="完整反鏈清單">清單</button>'
    + '</div>'
    + '<div class="revChips">' + revButtonsHtml(items) + '</div></div>';
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

/** 中間本文用的版本：回傳這一頁的反鏈清單（由 doc-pane 逐條嵌進經文） */
export async function reverseItemsOf(pageId: string): Promise<RevItem[]> {
  if (!reader || !pageId) return [];
  await ensureReverse();
  return reverseItemsForPage(reader.header.dbname, pageId);
}

// ---------------------------------------------------------------- 引用分布（熱圖）

export interface RevHeatAxis { label: string; total: number; key: number }
export type HeatGrain = 'volume' | 'sutra' | 'juan';
export interface RevHeatData {
  hostDb: string; hostName: string; srcDb: string; srcName: string;
  grain: HeatGrain;
  rowTag: string; colTag: string;
  rows: RevHeatAxis[]; cols: RevHeatAxis[];
  cells: number[][];
  rowVas: number[]; colVas: number[];
  total: number; hostPages: number; srcPages: number;
  topRows: RevHeatAxis[]; topCols: RevHeatAxis[];
  sources: { db: string; name: string; total: number }[];
}

/** 目前開啟的來源庫中，有哪些對 hostDb 有 <聯>（給熱圖的來源選單） */
export async function reverseHeatSources(hostDb: string): Promise<{ db: string; name: string; total: number }[]> {
  await ensureReverse();
  const m = new Map<string, { db: string; name: string; total: number }>();
  for (const e of allEntries) {
    if (e.db !== hostDb) continue;
    const hit = m.get(e.src) ?? { db: e.src, name: srcLabels.get(e.src) ?? e.src, total: 0 };
    hit.total++;
    m.set(e.src, hit);
  }
  return [...m.values()].sort((a, b) => b.total - a.total);
}

/** 有 <聯> 指向的目標庫（給「引紋」頁籤的 host 選單） */
export async function reverseHosts(): Promise<{ db: string; name: string; total: number }[]> {
  await ensureReverse();
  const m = new Map<string, { db: string; name: string; total: number }>();
  for (const e of allEntries) {
    const hit = m.get(e.db) ?? { db: e.db, name: e.db, total: 0 };
    hit.total++;
    m.set(e.db, hit);
  }
  const out: { db: string; name: string; total: number }[] = [];
  for (const v of m.values()) {
    const r = await readerFor(v.db);
    if (!r) continue;
    v.name = r.header.dbcname || v.db;
    out.push(v);
  }
  return out.sort((a, b) => b.total - a.total);
}

/**
 * 引用分布：host 的「部（冊）／經（書）／卷」× 來源庫的「書」。
 *
 * 列的次序＝host 的自然次序（冊 1→85、書的 VA、卷的 VA），欄的次序＝來源庫的
 * 自然次序（書的 VA）；格子是 <聯> 的數量。這正是「作者思想指紋」要看的分佈。
 */
export async function reverseHeat(hostDb: string, srcDb?: string, grain: HeatGrain = 'volume'): Promise<RevHeatData | null> {
  await ensureReverse();
  const all = allEntries.filter((e) => e.db === hostDb);
  if (!all.length) return null;
  const sources = await reverseHeatSources(hostDb);
  const useSrc = srcDb && sources.some((s) => s.db === srcDb) ? srcDb : sources[0]?.db;
  if (!useSrc) return null;
  const entries = all.filter((e) => e.src === useSrc);
  if (!entries.length) return null;

  const hostR = await readerFor(hostDb);
  const srcR = await readerFor(useSrc);
  if (!hostR || !srcR) return null;
  const hostIdx = await anchorIndex(hostR);
  const srcIdx = await anchorIndex(srcR);
  if (!hostIdx || !srcIdx) return null;

  // 部＝<冊>（大正 85 冊）；經＝<書>；卷＝<卷>。沒有冊就退回書。
  let rowTag = '書';
  let rowVas = hostIdx.bookVas;
  if (grain === 'volume' && hostIdx.volVas.length) { rowTag = '冊'; rowVas = hostIdx.volVas; }
  else if (grain === 'juan' && hostIdx.juanVas.length) { rowTag = '卷'; rowVas = hostIdx.juanVas; }
  const colTag0 = '書';
  let colTag = colTag0;
  let colVas = srcIdx.bookVas;
  if (!colVas.length) {
    // 太虛全書沒有 <書>（用 <集>/<編>/<文>）；挑第一個「夠細」的層級當來源欄。
    let fallbackTag = '';
    let fallbackVas: number[] = [];
    for (const t of ['集', '編', '篇', '章', '節', '文', '類']) {
      const ti = srcIdx.tags.indexOf(t);
      if (ti < 0) continue;
      const vas = await srcR.decodeBlockList('tags', ti);
      if (!vas.length) continue;
      if (!fallbackTag) { fallbackTag = t; fallbackVas = vas; }
      if (vas.length >= 4) { colTag = t; colVas = vas; break; }
    }
    if (!colVas.length && fallbackTag) { colTag = fallbackTag; colVas = fallbackVas; }
  }
  const rowNames = await hostR.cachedStrings(rowTag).catch(() => [] as string[]);
  const colNames = await srcR.cachedStrings(colTag).catch(() => [] as string[]);
  const bookNames = rowTag === '卷' ? await hostR.cachedStrings('書').catch(() => [] as string[]) : [];
  const pageVa = await pageVaMapOf(hostDb);
  const rowCount = new Map<number, number>();
  const colCount = new Map<number, number>();
  const cellMap = new Map<string, number>();
  const hostPages = new Set<string>();
  const srcPages = new Set<string>();
  for (const e of entries) {
    const tva = pageVa.get(e.targetPage);
    if (tva == null) continue;
    const ri = lastLEof(rowVas, tva);
    const ci = lastLEof(colVas, e.va);
    if (ri < 0 || ci < 0) continue;
    rowCount.set(ri, (rowCount.get(ri) ?? 0) + 1);
    colCount.set(ci, (colCount.get(ci) ?? 0) + 1);
    const key = ri + ',' + ci;
    cellMap.set(key, (cellMap.get(key) ?? 0) + 1);
    hostPages.add(e.targetPage);
    srcPages.add(e.src + ':' + e.pageId);
  }
  const rowLabel = (v: number): string => {
    const name = rowNames[v] || '';
    if (rowTag === '冊') return name ? '第' + (v + 1) + '冊 ' + name : '第' + (v + 1) + '冊';
    if (rowTag === '卷') {
      const bi = lastLEof(hostIdx.bookVas, rowVas[v]);
      const book = bi >= 0 ? (bookNames[bi] || '') : '';
      const jn = name || '卷' + (v + 1);
      // 大正藏的 <卷> 快取常已含書名（佛說長阿含經卷第一），不要重複加。
      return book && !jn.includes(book) ? book + ' ' + jn : jn;
    }
    return name || String(v + 1);
  };
  const rowIdx = [...rowCount.keys()].sort((a, b) => a - b);
  const colIdx = [...colCount.keys()].sort((a, b) => a - b);
  const rowPos = new Map(rowIdx.map((v, i) => [v, i]));
  const colPos = new Map(colIdx.map((v, i) => [v, i]));
  const rows: RevHeatAxis[] = rowIdx.map((v) => ({
    key: v,
    label: rowLabel(v),
    total: rowCount.get(v) ?? 0,
  }));
  const cols: RevHeatAxis[] = colIdx.map((v) => ({
    key: v,
    label: shortTitle(colNames[v] || srcR.header.dbcname || String(v + 1)),
    total: colCount.get(v) ?? 0,
  }));
  const cells: number[][] = rows.map(() => new Array(cols.length).fill(0));
  for (const [key, n] of cellMap) {
    const [r, c] = key.split(',').map(Number);
    const rp = rowPos.get(r), cp = colPos.get(c);
    if (rp != null && cp != null) cells[rp][cp] = n;
  }
  const topRows = rows.slice().sort((a, b) => b.total - a.total).slice(0, 8);
  const topCols = cols.slice().sort((a, b) => b.total - a.total).slice(0, 8);
  return {
    hostDb, hostName: hostR.header.dbcname || hostDb,
    srcDb: useSrc, srcName: srcR.header.dbcname || useSrc,
    grain,
    rowTag, colTag, rows, cols, cells,
    rowVas, colVas,
    total: entries.length, hostPages: hostPages.size, srcPages: srcPages.size,
    topRows, topCols, sources,
  };
}

function shortHeatLabel(s: string, n = 10): string {
  const t = s.replace(/[（(].*$/, '').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

/** 點熱圖一格 → 這一格（某個目標範圍 × 某部來源書）的所有反鏈。 */
export async function reverseHeatCellItems(data: RevHeatData, ri: number, ci: number): Promise<RevItem[]> {
  return reverseHeatRangeItems(data, ri, ri + 1, ci, ci + 1);
}

/** 點縮圖的合併格 → 該範圍（列 r0..r1-1、欄 c0..c1-1）內的所有反鏈。 */
export async function reverseHeatRangeItems(data: RevHeatData, r0: number, r1: number, c0: number, c1: number): Promise<RevItem[]> {
  const rowKey0 = data.rows[r0]?.key;
  const rowKey1 = data.rows[Math.max(r0, r1 - 1)]?.key;
  const colKey0 = data.cols[c0]?.key;
  const colKey1 = data.cols[Math.max(c0, c1 - 1)]?.key;
  if (rowKey0 == null || rowKey1 == null || colKey0 == null || colKey1 == null) return [];
  const hostR = await readerFor(data.hostDb);
  const srcR = await readerFor(data.srcDb);
  if (!hostR || !srcR) return [];
  const srcIdx = await anchorIndex(srcR);
  if (!srcIdx) return [];
  const pageVa = await pageVaMapOf(data.hostDb);
  const groups = new Map<string, { e: RevEntry; count: number; tqs: Set<string>; firstVa: number; hostVa: number }>();
  for (const e of allEntries) {
    if (e.db !== data.hostDb || e.src !== data.srcDb) continue;
    const tva = pageVa.get(e.targetPage);
    if (tva == null) continue;
    const ri = lastLEof(data.rowVas, tva);
    const ci = lastLEof(data.colVas, e.va);
    if (ri < rowKey0 || ri > rowKey1 || ci < colKey0 || ci > colKey1) continue;
    const k = e.src + '\u0000' + e.pageId;
    let g = groups.get(k);
    if (!g) { g = { e, count: 0, tqs: new Set(), firstVa: e.va, hostVa: data.rowVas[rowKey0] }; groups.set(k, g); }
    if (e.va < g.firstVa) { g.e = e; g.firstVa = e.va; }
    const ck = e.tq || e.quote || 'va:' + e.va;
    if (!g.tqs.has(ck)) { g.tqs.add(ck); g.count++; }
  }
  const out: RevItem[] = [];
  for (const g of groups.values()) {
    const e = g.e;
    const name = (await sourceLabelAt(srcR, srcIdx, e.va)) || srcR.header.dbcname || e.src;
    out.push({
      src: e.src, va: e.va, pageId: e.pageId, label: '', book: shortTitle(name), page: shortPage(e.pageId),
      full: name, tq: e.tq, cite: e.cite, quote: e.quote,
      count: g.count, srcVa: g.firstVa, hostVa: g.hostVa, hostPage: e.targetPage,
    });
  }
  const sorted = sortRevItems(out, 'freq');
  let last = '';
  for (const it of sorted) {
    const bk = it.src + '|' + it.book;
    it.label = bk === last ? it.page : it.book + ' ' + it.page;
    last = bk;
  }
  return sorted;
}

/** 畫熱圖（右欄「分布」按鈕）。用 fixed overlay，不开新分頁，避免打斷閱讀位置。 */
export async function openRevHeat(hostDb: string, srcDb?: string): Promise<void> {
  const box = document.getElementById('revHeat') as HTMLElement | null;
  const body = document.getElementById('revHeatBody') as HTMLElement | null;
  if (!box || !body) return;
  body.innerHTML = '<p class="dim">計算中…</p>';
  box.hidden = false;
  const data = await reverseHeat(hostDb, srcDb);
  if (!data) { body.innerHTML = '<p class="dim">這個庫目前沒有可用的 <聯> 反鏈。</p>'; return; }
  const title = document.getElementById('revHeatTitle');
  const sub = document.getElementById('revHeatSub');
  const sel = document.getElementById('revHeatSrc') as HTMLSelectElement | null;
  if (title) title.textContent = '引用分布：' + data.srcName + ' → ' + data.hostName;
  if (sub) sub.textContent = '共 ' + data.total.toLocaleString() + ' 條 · 來源頁 ' + data.srcPages.toLocaleString() + ' · 目標頁 ' + data.hostPages.toLocaleString();
  if (sel) {
    sel.innerHTML = data.sources.map((s) => '<option value="' + esc(s.db) + '"' + (s.db === data.srcDb ? ' selected' : '') + '>' + esc(s.name) + '（' + s.total.toLocaleString() + '）</option>').join('');
    sel.hidden = data.sources.length < 2;
    sel.onchange = () => { void openRevHeat(hostDb, sel.value); };
  }
  const max = Math.max(1, ...data.cells.flat());
  const cellColor = (n: number): string => {
    if (!n) return '';
    const a = 0.10 + 0.90 * Math.sqrt(n / max);
    return 'background:rgba(198,84,54,' + a.toFixed(3) + ');color:' + (a > 0.55 ? '#fff' : 'var(--fg)');
  };
  const colW = 30, rowW = 150;
  let grid = '<div class="revHeatGrid" style="grid-template-columns:' + rowW + 'px repeat(' + data.cols.length + ',' + colW + 'px) 56px">';
  grid += '<div class="hgCorner">' + esc(data.rowTag) + ' ＼ ' + esc(data.colTag) + '</div>';
  for (const c of data.cols) {
    grid += '<div class="hgCol" title="' + esc(c.label) + '（' + c.total + ' 條）">' + esc(shortHeatLabel(c.label, 4)) + '</div>';
  }
  grid += '<div class="hgCorner hgCornerTot"></div>';
  data.rows.forEach((r, ri) => {
    grid += '<div class="hgRow" title="' + esc(r.label) + '">' + esc(shortHeatLabel(r.label, 10)) + '</div>';
    data.cells[ri].forEach((n, ci) => {
      grid += n
        ? '<div class="hgCell" style="' + cellColor(n) + '" title="' + esc(r.label) + ' × ' + esc(data.cols[ci].label) + '：' + n + ' 條">' + n + '</div>'
        : '<div class="hgCell"></div>';
    });
    grid += '<div class="hgTot">' + r.total + '</div>';
  });
  grid += '</div>';
  const topList = (xs: RevHeatAxis[]): string => '<ol>' + xs.map((x) => '<li><span>' + esc(x.label) + '</span><b>' + x.total + '</b></li>').join('') + '</ol>';
  body.innerHTML = '<div class="revHeatMain"><div class="revHeatWrap">' + grid + '</div>'
    + '<div class="revHeatTops"><div><h4>引用最多的目標</h4>' + topList(data.topRows) + '</div>'
    + '<div><h4>引用最多的來源</h4>' + topList(data.topCols) + '</div></div></div>'
    + '<p class="dim revHeatNote">列＝' + esc(data.hostName) + '的自然次序；欄＝' + esc(data.srcName) + '的自然次序。格內數字是 <聯> 條數，顏色越深代表引用越集中；右側是總量最高的目標／來源。</p>';
}

async function handleXref(value: string, fromRight: boolean, newTab: boolean, quote?: string, j?: string): Promise<void> {
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
    openForeignTab(db, va, short + ' ' + anchor, newTab, anchor, quote, j);
    return;
  }
  if (db === mainName) { await linkTo(va, anchor, 1, { newTab, exact: true }); return; }
  openForeignTab(db, va, short + ' ' + anchor, newTab, anchor, quote, j);
}

export async function xrefJump(value: string, fromRight = false, newTab = false, quote?: string, j?: string): Promise<void> {
  await handleXref(value, fromRight, newTab, quote, j);
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
  // 全形 → 半形，去掉空白與最外層括號（讀者多半是整段複製：(CBETA 2025.R1, T02, no. 99, p. 1a7-9)）
  const s = raw
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\s+/g, '')
    .replace(/^[(（]+|[(）)]+$/g, '');
  // ① CBETA style：CBETA 2025.R1, T02, no. 99, p. 1a7-9（版本段可省略、T 可省略）
  const cb = /^(?:(?:CBETA|C)[\d.A-Za-z]*[,，])?T?(\d{1,2})[,，]no\.?(\d+)[,，]p\.?(\d+)([abc])(\d{1,2})(?:[-–—~至](?:(\d+)?([abc])(\d{1,2})|(\d{1,2})))?$/i.exec(s);
  if (cb) {
    const vol = Number(cb[1]);
    // 「1a7-9」只有行號（同欄）；「1a7-2b3」才跨頁跨欄
    const sameColEnd = cb[9] ? Number(cb[9]) : undefined;
    return {
      vol,
      page: cb[3],
      col: cb[4].toLowerCase(),
      line: Number(cb[5]),
      endPage: cb[6] ?? undefined,
      endCol: cb[7] ? cb[7].toLowerCase() : undefined,
      endLine: cb[7] ? Number(cb[8]) : sameColEnd,
    };
  }
  // ② 大正 style：大正2，206a15-b13
  const m = /^(?:大正|T)?([0-9]+|[一二三四五六七八九十百〇零]+)[,，](\d+)([abc])(\d{1,2})(?:[-–—~至](?:(\d+)?([abc])(\d{1,2})|(\d{1,2})))?$/i.exec(s);
  if (m) {
    const vol = numOf(m[1]);
    if (vol != null) {
      return {
        vol,
        page: m[2],
        col: m[3].toLowerCase(),
        line: Number(m[4]),
        endPage: m[5] ?? undefined,
        endCol: m[6]?.toLowerCase(),
        endLine: m[6] ? Number(m[7]) : (m[8] ? Number(m[8]) : undefined),
      };
    }
  }
  // ③ 頁 id 直接加行號：`2p1a7`＝第 2 冊 1 頁 a 欄第 7 行（與庫裡的頁 id `2p1a` 同一種寫法）。
  //    沒有尾隨行號的 `49p15a`、`20p0065a` 不匹配，仍走頁 id 清單那條路。
  const m3 = /^(\d{1,2})p(\d+)([abc])(\d{1,2})(?:[-–—~至](?:(\d{1,2})p)?(\d+)?([abc])(\d{1,2}))?$/i.exec(s);
  if (m3) {
    return {
      vol: Number(m3[1]),
      page: m3[2],
      col: m3[3].toLowerCase(),
      line: Number(m3[4]),
      endPage: m3[6] ?? undefined,
      endCol: m3[7]?.toLowerCase(),
      endLine: m3[7] ? Number(m3[8]) : undefined,
    };
  }
  return null;
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
  } else if (c.endLine != null) {
    // 同一欄的行範圍（CBETA 的「p. 1a7-9」）
    endLine = m.lineOfVa(va) + Math.max(0, c.endLine - 1);
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
  const blk = va == null ? 0 : blockOf(idx, va);
  const text = va == null ? '' : await r.sourceText(blk);
  const at = text.indexOf('<頁 id="' + anchor + '"');
  const raw = at >= 0 ? text.slice(at, at + 60) : text.slice(Math.max(0, (va ?? 0) - idx.bv[blk] - 20), (va ?? 0) - idx.bv[blk] + 60);
  return { va, blk, bv0: idx.bv[blk], raw };
}

/**
 * `<嵌>` 的內容：只取目標頁上「被引用的那一段」，不是整頁。
 *
 *   <嵌 i="jingang?33p158a" q="佛言善哉…" j="61-123" n="纂要"/>
 *
 * `j` 是目標頁的漢字索引（0 起，end 不含）；和 `q` 對不上時退回 q 比對。
 * 回傳的 HTML 只包含一段 `.embedDoc`，由 embed.ts 插在晶片後面。
 */
export async function renderEmbed(db: string, anchor: string, quote = '', range = '', label = ''): Promise<{ html: string; title: string }> {
  const r = await readerFor(db);
  if (!r) return { html: '<p class="dim">請先開啟 ' + esc(db) + '.adb（同一個瀏覽器工作階段）。</p>', title: label || db };
  const idx = await anchorIndex(r);
  if (!idx) return { html: '<p class="dim">這個庫沒有頁碼表。</p>', title: label || db };
  const va = await anchorVa(r, anchor);
  if (va == null) return { html: '<p class="dim">找不到頁碼 ' + esc(anchor) + '。</p>', title: label || db };

  const blk0 = blockOf(idx, va);
  let blk = blk0;
  let blockText = await r.sourceText(blk);
  let startAt = Math.max(0, va - idx.bv[blk]);
  // VA 與 source block 的邊界不一定對得剛好（作者的 adb 有這個情形）；
  // 直接在附近 block 找 `<頁 id="anchor">`，找到就以它為起點。
  for (const off of [0, -1, 1, -2, 2, -3, 3]) {
    const b = blk0 + off;
    if (b < 0 || b >= idx.bv.length) continue;
    const t = off === 0 ? blockText : await r.sourceText(b);
    const k = t.indexOf('<頁 id="' + anchor + '"');
    if (k >= 0) { blk = b; blockText = t; startAt = k; break; }
  }
  let raw = blockText.slice(startAt);
  if (raw.startsWith('<頁')) {
    const gt = raw.indexOf('>');
    if (gt > 0) raw = raw.slice(gt + 1);
  }
  for (let b = blk + 1; raw.length < 5000 && b < idx.bv.length; b++) raw += await r.sourceText(b);
  const cut = raw.indexOf('<頁 ');
  if (cut > 0) raw = raw.slice(0, cut);

  // 漢字 → 原始字元位置；標籤跳過
  const chars: string[] = [];
  const rawAt: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '<') {
      const gt = raw.indexOf('>', i);
      if (gt < 0) break;
      i = gt;
      continue;
    }
    if (HAN_RE.test(raw[i])) { chars.push(raw[i]); rawAt.push(i); }
  }
  const pn = foldVariants(chars.join(''));
  let from = 0;
  let to = Math.min(pn.length, 300);
  if (quote) {
    const qn = foldVariants(Array.from(quote).filter((c) => HAN_RE.test(c)).join(''));
    if (qn) {
      let hit = pn.indexOf(qn);
      if (hit < 0 && qn.length >= 10) hit = pn.indexOf(qn.slice(0, 10));
      if (hit >= 0) { from = hit; to = Math.min(pn.length, hit + qn.length); }
    }
  }
  // j 優先；但 q 必須大致對得上，否則 j 可能是舊資料
  const mm = /^(\d+)-(\d+)$/.exec(range);
  if (mm) {
    const a = Number(mm[1]), b = Number(mm[2]);
    if (a >= 0 && b > a && b <= pn.length) {
      const piece = pn.slice(a, b);
      const qn = foldVariants(Array.from(quote).filter((c) => HAN_RE.test(c)).join(''));
      if (!qn || piece.slice(0, Math.min(12, qn.length)) === qn.slice(0, Math.min(12, qn.length))) {
        from = a; to = b;
      }
    }
  }

  // 擴到句子邊界（前後各找 60 字內的句號／分號），讓引文讀得通
  let a = rawAt[from] ?? 0;
  let b = (rawAt[Math.max(0, to - 1)] ?? raw.length - 1) + 1;
  const back = raw.slice(Math.max(0, a - 80), a);
  const bi = Math.max(back.lastIndexOf('。'), back.lastIndexOf('！'), back.lastIndexOf('？'), back.lastIndexOf('；'));
  if (bi >= 0) a = Math.max(0, a - 80) + bi + 1;
  const fwd = raw.slice(b, b + 80);
  const fi = [fwd.indexOf('。'), fwd.indexOf('！'), fwd.indexOf('？')].filter((x) => x >= 0).sort((x, y) => x - y)[0];
  if (fi !== undefined) b = b + fi + 1;
  if (b - a > 900) b = a + 900;

  const piece = raw.slice(a, b);
  const markFrom = raw.slice(a, rawAt[from] ?? a).replace(/<[^>]*>/g, '').split('').filter((c) => HAN_RE.test(c)).length;
  const markTo = markFrom + Math.max(0, to - from);
  const book = await bookAt(r, idx, va).catch(() => ({ title: '', no: '' }));
  const head = (label || book.title || db) + (book.title && label ? ' · ' + book.title : '');
  return {
    html: '<div class="embedDoc">'
      + '<div class="embedHead"><span class="embedSrc">' + esc(head) + '</span>'
      + '<span class="embedPage">' + esc(anchor) + '</span></div>'
      + '<div class="embedText reflow">' + lineHtml(piece, markFrom, markTo) + '</div>'
      + '</div>',
    title: head,
  };
}

export async function previewForeign(db: string, anchor: string, quote?: string, j?: string) {
  const r = await readerFor(db);
  if (!r) return 'no db';
  const va = await anchorVa(r, anchor);
  if (va == null) return 'no va';
  const out = await renderForeign(db, va, anchor, quote, j);
  const dm = /data-q="([^"]+)"/.exec(out.html);
  return { mark: out.html.includes('<mark'), dbg: (globalThis as any).__xrefLast ?? null, dataQ: dm ? dm[1].slice(0, 40) : null, xrefSnippet: (out.html.match(/<a[^>]*data-xref[^>]*>/) || [''])[0].slice(0, 120), head: out.html.slice(0, 120) };
}

export function xrefDebug() {
  const bySrc: Record<string, number> = {};
  for (const e of allEntries) bySrc[e.src] = (bySrc[e.src] ?? 0) + 1;
  return {
    main: reader?.header.dbname ?? '',
    slots: openDbs.map((s) => ({ name: s.name, file: s.file.name })),
    foreign: [...foreignReaders.keys()],
    linked: [...linkedDbs],
    revKeys: revIndex.size,
    revSample: [...revIndex.keys()].filter((k) => k.includes('49p15')).slice(0, 12),
    allEntries: allEntries.length,
    bySrc,
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

/** 伺服器端重排：重算 items（含次數、同書省略書名）後換掉 chips，比只搬 DOM 可靠。 */
async function resortRevBar(box: HTMLElement, mode: RevSort): Promise<void> {
  const host = box.dataset.revhost ?? '';
  const page = box.dataset.revpage ?? '';
  const holder = box.querySelector<HTMLElement>('.revChips');
  if (!host || !page || !holder) return;
  // 先亮起按鈕，讓讀者知道有反應；資料是非同步重算的。
  box.querySelectorAll<HTMLElement>('[data-revsort]').forEach((b) => b.classList.toggle('active', b.dataset.revsort === mode));
  const items = await reverseItemsForPage(host, page, mode);
  if (!items.length) return;
  holder.innerHTML = revButtonsHtml(items);
  relabelRevRows();
}

/** 依 data-* 重排一排反鏈按鈕，重新套用「一次 10 顆」的分批。 */
function sortRevBox(box: HTMLElement, mode: RevSort): void {
  const holder = box.querySelector<HTMLElement>('.revChips') ?? box;
  const chips = [...holder.querySelectorAll<HTMLElement>('.xrefRev')];
  const num = (el: HTMLElement, k: string): number => Number(el.dataset[k] ?? 0) || 0;
  const srcOf = (el: HTMLElement): string => (el.dataset.rrev ?? '').split('|')[0] ?? '';
  chips.sort((a, b) => {
    if (mode === 'src') return srcOf(a).localeCompare(srcOf(b)) || num(a, 'srcva') - num(b, 'srcva') || num(b, 'count') - num(a, 'count');
    if (mode === 'host') return num(a, 'hostva') - num(b, 'hostva') || srcOf(a).localeCompare(srcOf(b)) || num(a, 'srcva') - num(b, 'srcva');
    return num(b, 'count') - num(a, 'count') || srcOf(a).localeCompare(srcOf(b)) || num(a, 'srcva') - num(b, 'srcva');
  });
  holder.querySelectorAll('.xrefRev,[data-revmore]').forEach((el) => el.remove());
  chips.forEach((el, i) => { el.classList.toggle('is-hidden', i >= REV_BATCH); holder.append(el); });
  const rest = Math.max(0, chips.length - REV_BATCH);
  if (rest) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'mini xrefMore';
    more.dataset.revmore = String(rest);
    more.title = '再顯示 ' + Math.min(rest, REV_BATCH) + ' 條';
    more.textContent = '＋' + rest;
    holder.append(more);
  }
  box.querySelectorAll<HTMLElement>('[data-revsort]').forEach((b) => b.classList.toggle('active', b.dataset.revsort === mode));
  relabelRevRows();
}

export function initXref(): void {
  setForeignRender(renderForeign);
  if (bound) return;
  bound = true;
  // 版面一變（右欄換頁、中間換頁、視窗縮放）就重算「每一行第一顆按鈕」的書名
  {
    let t = 0;
    const soon = (): void => { window.clearTimeout(t); t = window.setTimeout(() => relabelRevRows(), 60); };
    for (const id of ['textBody', 'docText']) {
      const box = document.getElementById(id);
      if (box) new MutationObserver(soon).observe(box, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    }
    window.addEventListener('resize', soon);
  }
  document.addEventListener('click', (ev) => {
    // 反鏈排序：頻次／來源序／目標序（2026-10-28）
    const sortBtn = (ev.target as Element | null)?.closest?.('[data-revsort]') as HTMLElement | null;
    if (sortBtn) {
      ev.preventDefault();
      ev.stopPropagation();
      const box = sortBtn.closest('.xrefRevBar') as HTMLElement | null;
      if (box) void resortRevBar(box, (sortBtn.dataset.revsort as RevSort) || 'freq');
      return;
    }
    // 完整反鏈清單抽屜
    const listBtn = (ev.target as Element | null)?.closest?.('[data-revlisthost]') as HTMLElement | null;
    if (listBtn) {
      ev.preventDefault();
      ev.stopPropagation();
      document.dispatchEvent(new CustomEvent('accelon26:revlist', {
        detail: { host: listBtn.dataset.revlisthost ?? '', page: listBtn.dataset.revlistpage ?? '', name: listBtn.dataset.revlistname ?? '' },
      }));
      return;
    }
    // 引用分布熱圖
    const heatBtn = (ev.target as Element | null)?.closest?.('[data-revheat]') as HTMLElement | null;
    if (heatBtn) {
      ev.preventDefault();
      ev.stopPropagation();
      document.dispatchEvent(new CustomEvent('accelon26:heat', {
        detail: { host: heatBtn.dataset.revheat ?? '', src: heatBtn.dataset.revsrc || undefined },
      }));
      return;
    }
    // 「＋N」：同一組反鏈再放一批（超過 10 顆才分批，作者 2026-10-28）
    const more = (ev.target as Element | null)?.closest?.('[data-revmore]') as HTMLElement | null;
    if (more) {
      ev.preventDefault();
      ev.stopPropagation();
      const box = more.parentElement;
      if (!box) return;
      box.querySelectorAll<HTMLElement>('.xrefRev.is-hidden').forEach((el, i) => {
        if (i < 10) el.classList.remove('is-hidden');
      });
      const left = box.querySelectorAll('.xrefRev.is-hidden').length;
      if (left > 0) more.textContent = '＋' + left;
      else more.remove();
      relabelRevRows();
      return;
    }
    const rev = (ev.target as Element | null)?.closest?.('[data-rrev]') as HTMLElement | null;
    if (rev) {
      ev.preventDefault();
      ev.stopPropagation();
      const [db, vaStr] = (rev.dataset.rrev ?? '').split('|');
      if (!db || !vaStr) return;
      const va = Number(vaStr);
      const inList = !!rev.closest('#revList');
      if (inList) setTimeout(() => { const box = document.getElementById('revList'); if (box) box.hidden = true; }, 50);
      // 回連結指回「主庫」（例如中間讀印順、右欄讀大正，按鈕指回印順的另一個地方）：
      // 直接在中間開一個新分頁，不必按 Ctrl（作者 2026-10-28）。指到別的庫才放右欄。
      if (reader && db === reader.header.dbname) {
        const label = rev.dataset.rrevLabel ?? '';
        void linkTo(va, label, 1, { newTab: true, exact: false, name: label, noMark: false, phrase: rev.dataset.rquote || undefined });
        return;
      }
      ensureRightPane();
      openForeignTab(db, va, rev.dataset.rrevLabel ?? db, ev.ctrlKey || ev.metaKey, rev.dataset.rpage || undefined, rev.dataset.rcite || rev.dataset.rquote || undefined);
      return;
    }
    const a = (ev.target as Element | null)?.closest?.('a[data-xref]') as HTMLElement | null;
    if (!a) return;
    ev.preventDefault();
    ev.stopPropagation();
    const fromRight = !!a.closest('#textBody');
    void handleXref(a.dataset.xref ?? '', fromRight, ev.ctrlKey || ev.metaKey,
      (a.dataset.q || (fromRight ? '' : quoteNear(a))), a.dataset.j || undefined);
  }, true);
  // 主庫換了（或第一次載入）就重建反連表
  document.addEventListener('accelon26:db', () => { revKey = ''; void buildReverseIfPossible(); });
  // 熱圖關閉：✕、點背景、Esc
  document.getElementById('revHeatClose')?.addEventListener('click', () => {
    const box = document.getElementById('revHeat');
    if (box) box.hidden = true;
  });
  document.getElementById('revHeat')?.addEventListener('click', (ev) => {
    if (ev.target === ev.currentTarget) (ev.currentTarget as HTMLElement).hidden = true;
  });
  window.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      const box = document.getElementById('revHeat');
      if (box && !box.hidden) box.hidden = true;
    }
  });
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
