/**
 * 多語詞彙表（`glossary` 容器，2026-10-31）。
 *
 * ys.adb 在打包時把 `<术 sk|pi|tb="外語">漢詞</术>` 整理成一份去重清單，放進
 * 外層容器 `glossary`（1 個 block、未壓縮 UTF-8 JSON Lines）：
 *
 *   ["GLOSSARY1", 4107]
 *   ["sk","svabhāva","自性",12]
 *
 * 這個模組只負責「讀 + 正規化 + 比對」；畫面在 scopes.ts 的 renderGlossary()。
 *
 * 比對規則（作者 2026-10-31）：
 *   - 顯示時保留外語原樣（含變音符號），不經過 tokenizer；
 *   - 輸入可以省略變音符號、不分大小寫（foldGlossary）；
 *   - 中文查詢比對漢詞（子字串），外語查詢比對 fold 後的外語（子字串）。
 */
import type { AdbReader } from './adb';
import { toSimplified } from './lossless';

export interface GlossRow {
  lang: string;
  foreign: string;
  han: string;
  count: number;
  /** 第一次出現的行號（1 起；舊資料沒有就是 0） */
  line: number;
  /** 第一次出現所屬的頁 id（舊資料沒有就是空字串） */
  page: string;
  /** 該頁第幾個漢字（0 起；舊資料沒有就是 -1） */
  off: number;
  /** 該行第幾個漢字（0 起；頁碼對不上時退回行內定位） */
  hanline: number;
  /** 預先算好的比對鍵（外語去變音符號、小寫、去空白） */
  fold: string;
  /** 預先轉好的強制簡體（漢詞）；輸入也轉簡體後比對 */
  simp: string;
}

const cache = new WeakMap<AdbReader, GlossRow[]>();

/** 去掉變音符號、大小寫與空白／連字號，只給「輸入比對」用；顯示不要用它。 */
export function foldGlossary(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[\s\-'’.]/g, '');
}

/** 讀 `glossary` 容器；沒有這個容器（舊的 ys.adb）回 null。 */
export async function loadGlossary(r: AdbReader): Promise<GlossRow[] | null> {
  const hit = cache.get(r);
  if (hit) return hit;
  const c = r.containers.get('glossary');
  if (!c || c.count < 1) return null;
  const bytes = await r.readBlock('glossary', 0);
  const text = new TextDecoder('utf-8').decode(bytes);
  const rows: GlossRow[] = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let a: unknown;
    try { a = JSON.parse(s); } catch { continue; }
    if (!Array.isArray(a) || a[0] === 'GLOSSARY1') continue;
    const lang = String(a[0] ?? '');
    const foreign = String(a[1] ?? '');
    const han = String(a[2] ?? '');
    if (!foreign || !han) continue;
    rows.push({ lang, foreign, han, count: Number(a[3]) || 1, line: Number(a[4]) || 0, page: String(a[5] ?? ''), off: a[6] === undefined ? -1 : Number(a[6]) || 0, hanline: a[7] === undefined ? -1 : Number(a[7]) || 0, fold: foldGlossary(foreign), simp: toSimplified(han, 2) });
  }
  cache.set(r, rows);
  return rows;
}

/** 這個庫有沒有詞彙表（決定要不要顯示「詞彙」分頁）。 */
export function hasGlossary(r: AdbReader | null | undefined): boolean {
  return !!r?.containers.get('glossary');
}

export const GLOSS_LANG_NAME: Record<string, string> = {
  sk: '梵語',
  pi: '巴利語',
  tb: '藏語',
};

/** 一個詞彙列是否符合查詢：漢詞子字串，或外語 fold 後子字串。 */
export function matchGlossary(row: GlossRow, query: string): boolean {
  const q = query.trim();
  if (!q) return true;
  if (row.han.includes(q)) return true;
  const fq = foldGlossary(q);
  return fq.length > 0 && foldGlossary(row.foreign).includes(fq);
}

/** 詞彙列前面的小圈圈：梵／巴／藏（作者 2026-10-31）。 */
export const GLOSS_LANG_BADGE: Record<string, string> = { sk: '梵', pi: '巴', tb: '藏' };

/**
 * 位置比對（2026-10-31，作者指定，漢語外語通用）：
 *   any＝任意、start＝開頭、mid＝中間（不是開頭也不是結尾）、end＝結尾。
 * 中文用漢詞比對；外語用 fold 後的値比對（輸入可省略變音符號）。
 */
export function matchGlossaryAt(row: GlossRow, query: string, mode: string): boolean {
  const q = query.trim();
  if (!q) return true;
  const hit = (name: string, needle: string): boolean => {
    if (!needle || !name.includes(needle)) return false;
    const atStart = name.startsWith(needle);
    const atEnd = name.endsWith(needle);
    if (mode === 'start') return atStart;
    if (mode === 'end') return atEnd;
    if (mode === 'mid') return !atStart && !atEnd;
    return true;
  };
  // 預先算好的鍵（2026-10-31）：漢詞用強制簡體、外語用 fold；沒有就先算，保持相容。
  const simp = row.simp ?? toSimplified(row.han, 2);
  if (hit(simp, toSimplified(q, 2))) return true;
  const fq = foldGlossary(q);
  const fold = row.fold ?? foldGlossary(row.foreign);
  return fq ? hit(fold, fq) : false;
}
