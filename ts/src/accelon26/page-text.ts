/**
 * 頁文字與頁座標的共用層（2026-11-01）。
 *
 * 這一支**不碰 DOM**，只吃 `AdbReader`，所以閱讀器（xref）與各 adb 工作區的
 * 產生器（fuyan 的 `taisho-pages.ts`／`ys-pages.ts`、ys 的 `addj.ts` 等）都可以
 * import，不必各自重寫「頁 id → VA → 區塊 → 純漢字」。
 *
 * 座標規則：漢字逐 code point（`han.ts`），回傳的是「純漢字字串」；
 * `j`／`off` 就是這個字串的索引。
 */
import type { AdbReader } from './adb';
import { hanChars } from './han';

export interface AnchorIndex {
  values: string[];
  pointers: Int32Array;
  vas: number[];
  tags: string[];
  bv: number[];
  bookVas: number[];
  juanVas: number[];
  volVas: number[];
  lianVas: number[];
}

const indexCache = new Map<AdbReader, AnchorIndex>();

/** 頁 id 表：`attributes/頁.id` → pointer → `tags/頁` 的 VA（每個 reader 快取一次）。 */
export async function anchorIndex(r: AdbReader): Promise<AnchorIndex | null> {
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
  // 沒有 `<頁>` 標籤的庫（sz 系列）：退回 `塊.段` 定位
  if (!idx) return locatorVa(r, anchor);
  const i = idx.values.indexOf(anchor);
  if (i < 0) return locatorVa(r, anchor);
  const ptr = idx.pointers[i];
  if (idx.tags[(ptr >>> 24) & 0xff] !== '頁') return locatorVa(r, anchor);
  return idx.vas[(ptr & 0xffffff) - 1] ?? null;
}

/** `標籤.屬性` → 值 → VA 清單（走 attributes 的共用鏈，和 anchorIndex 同一套） */
async function attrVas(r: AdbReader, tag: string, attr: string): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  const tagsC = r.containers.get('tags');
  const ti = tagsC?.names.indexOf(tag) ?? -1;
  if (!tagsC || ti < 0) return out;
  const av = await r.attributeValues(`${tag}.${attr}`).catch(() => null);
  if (!av || !av.pointers) return out;
  const vas = await r.decodeBlockList('tags', ti);
  for (let k = 0; k < av.values.length; k++) {
    const ptr = av.pointers[k];
    const va = vas[(ptr & 0xffffff) - 1];
    if (va == null) continue;
    const key = av.values[k];
    const list = out.get(key) ?? [];
    list.push(va);
    out.set(key, list);
  }
  for (const list of out.values()) list.sort((a, b) => a - b);
  return out;
}

/**
 * 定位字串 `塊.段[:句]`（`a6.7`／`a6.7:3`）→ VA：不用 `<頁>` 標籤，直接查
 * `attributes/塊.id` 與 `attributes/段.n`，取「同一個塊裡的第一個該段」。
 * （作者 2026-11-02 定案：跨庫用 `ck.n` 跳；`:` 後面是「句」，1 起算。）
 *
 * 句＝`<段>` 所在的那一行算第 1 句，往後每行加 1（一個 adb 行就是一句）。
 * 行界用 `lines.virtual`（每一行的起始 VA），所以不需要額外的 `<句>` 標籤。
 */
/**
 * `塊.段[:句][#詞]`：`d1.7`、`d1.7:3`、`d1.7:3#2`。
 * `#詞` 是句內第 k 個詞（1 起算，用空白切），解析時只影響回傳的「位置說明」，
 * VA 仍停在該句——詞的醒目提示由閱讀端自己切文字（見 sz `docs/addressing.md` §8）。
 */
const LOCATOR_RE = /^([a-z][a-z0-9_-]*)\.([0-9]+)(?::([0-9]+))?(?:#([0-9]+))?$/;
const lineVasCache = new WeakMap<AdbReader, number[]>();
const segVasCache = new WeakMap<AdbReader, number[]>();

/** 所有 `<段>` 的 VA（遞增），用來找「下一段」的界 */
async function allSegVas(r: AdbReader): Promise<number[]> {
  let v = segVasCache.get(r);
  if (!v) {
    const tagsC = r.containers.get('tags');
    const ti = tagsC?.names.indexOf('段') ?? -1;
    v = ti < 0 ? [] : await r.decodeBlockList('tags', ti);
    segVasCache.set(r, v);
  }
  return v;
}

async function lineVas(r: AdbReader): Promise<number[]> {
  let v = lineVasCache.get(r);
  if (!v) {
    v = await r.linesVirtual();
    lineVasCache.set(r, v);
  }
  return v;
}

/** 第一個「行末 VA ≥ va」的行（二分）：lines.virtual[i] 是第 i 行最後一個 token 的 VA */
function lineOf(vas: number[], va: number): number {
  let lo = 0;
  let hi = vas.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (vas[mid] >= va) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

async function locatorVa(r: AdbReader, anchor: string): Promise<number | null> {
  const m = LOCATOR_RE.exec(anchor);
  if (!m) return null;
  const chunks = (await attrVas(r, '塊', 'id')).get(m[1]) ?? [];
  const segs = (await attrVas(r, '段', 'n')).get(m[2]) ?? [];
  if (!chunks.length || !segs.length) return null;
  for (let k = 0; k < chunks.length; k++) {
    const start = chunks[k];
    const end = k + 1 < chunks.length ? chunks[k + 1] : Number.POSITIVE_INFINITY;
    const at = segs.findIndex((v) => v > start && v < end);
    if (at < 0) continue;
    const hit = segs[at];
    const j = m[3] ? Number(m[3]) : 1;
    if (j <= 1) return hit;
    const vas = await lineVas(r);
    const li = lineOf(vas, hit); // 段標記所在的行
    // 「下一段」要拿全部段標記的序列（同一個 n 會在每本書重複出現）
    const all = await allSegVas(r);
    const pos = lineOf(all, hit);
    const nextVa = all[pos + 1] ?? Number.POSITIVE_INFINITY;
    const lastLine = lineOf(vas, nextVa - 1); // 這一段的最後一行
    const lineK = Math.min(li + j - 1, lastLine);
    if (lineK <= 0) return hit;
    const startVa = vas[lineK - 1] + 1;
    return startVa > hit ? startVa : hit; // 單行段或超界：夾回段首
  }
  return null;
}

/** VA → `塊.段:句`（sz 的 cs／譯本；有 `塊.id`、`段.n` 的庫才有）。 */
export async function locatorAtVa(
  r: AdbReader,
  va: number,
): Promise<{ block: string; seg: string; sentence: number } | null> {
  const blockMap = await attrVas(r, '塊', 'id');
  const blocks: { va: number; id: string }[] = [];
  for (const [id, vas] of blockMap) for (const v of vas) blocks.push({ va: v, id });
  if (!blocks.length) return null;
  blocks.sort((a, b) => a.va - b.va);
  let bi = -1;
  for (let i = 0; i < blocks.length; i++) { if (blocks[i].va <= va) bi = i; else break; }
  if (bi < 0) return null;
  const block = blocks[bi];
  const next = blocks[bi + 1]?.va ?? Number.POSITIVE_INFINITY;
  const segMap = await attrVas(r, '段', 'n');
  const segs: { va: number; n: string }[] = [];
  for (const [n, vas] of segMap) for (const v of vas) segs.push({ va: v, n });
  segs.sort((a, b) => a.va - b.va);
  let si = -1;
  for (let i = 0; i < segs.length; i++) {
    if (segs[i].va >= block.va && segs[i].va <= va && segs[i].va < next) si = i;
    if (segs[i].va > va) break;
  }
  if (si < 0) return null;
  const seg = segs[si];
  const lines = await lineVas(r);
  const line = lineOf(lines, va);
  const segLine = lineOf(lines, seg.va);
  return { block: block.id, seg: seg.n, sentence: Math.max(1, line - segLine + 1) };
}

/** VA 落在哪一個 source 區塊 */
export function blockOf(idx: AnchorIndex, va: number): number {
  let blk = 0;
  for (let k = 0; k < idx.bv.length; k++) { if (idx.bv[k] <= va) blk = k; else break; }
  return blk;
}

/**
 * 目標頁的純漢字序列（`j`／`off` 的座標就是這個字串的索引）。
 *
 * - 從 `<頁 id="…">` 之後起算；
 * - 讀到下一個 `<頁 ` 為止；
 * - 跳過 `<…>` 標籤，只留漢字（`hanChars`，逐 code point）。
 */
export async function pageHanTextOf(r: AdbReader, anchor: string): Promise<string> {
  const idx = await anchorIndex(r);
  if (!idx) return '';
  const va = await anchorVa(r, anchor);
  if (va == null) return '';
  const blk0 = blockOf(idx, va);
  let blk = blk0;
  let blockText = await r.sourceText(blk);
  let startAt = Math.max(0, va - idx.bv[blk]);
  // 頁標記可能落在隔壁區塊（VA 指到頁內第一行），所以往前後幾個區塊找
  for (const off of [0, -1, 1, -2, 2, -3, 3]) {
    const b = blk0 + off;
    if (b < 0 || b >= idx.bv.length) continue;
    const t = off === 0 ? blockText : await r.sourceText(b);
    const k = t.indexOf('<頁 id="' + anchor + '"');
    if (k >= 0) { blk = b; blockText = t; startAt = k; break; }
  }
  let raw = blockText.slice(startAt);
  for (let b = blk + 1; raw.length < 20000 && b < idx.bv.length; b++) raw += await r.sourceText(b);
  const cut = raw.indexOf('<頁 ');
  if (cut > 0) raw = raw.slice(0, cut);
  return hanChars(raw).join('');
}
