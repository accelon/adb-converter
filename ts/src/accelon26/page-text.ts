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
  if (!idx) return null;
  const i = idx.values.indexOf(anchor);
  if (i < 0) return null;
  const ptr = idx.pointers[i];
  if (idx.tags[(ptr >>> 24) & 0xff] !== '頁') return null;
  return idx.vas[(ptr & 0xffffff) - 1] ?? null;
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
