/**
 * 繁簡通檢：把「同一個字的不同寫法」合併成一份 posting。
 *
 * 資料來自 `variant-data.ts`（`tools/gen-variants.ts` 從 `vendor/Unihan_Variants.txt`
 * 產生的分組字串）。查詢時每個漢字換成它那一組的所有字，再把它們的 posting list
 * 聯集起來 —— 對索引來說「菩薩」與「菩萨」就是同一個詞。
 *
 * 這個設定是**系統級**的（作者 2026-10）：一個開關對所有 adb 都生效，存在
 * localStorage（`accelon26.variants`），切換後要重新跑一次查詢。
 */
import { VARIANT_GROUPS } from './variant-data';

/** 漢字（與 query.ts 的 isHan 同一組範圍） */
function isHan(ch: string | undefined): boolean {
  if (!ch) return false;
  const cp = ch.codePointAt(0)!;
  return (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x4e00 && cp <= 0x9fff)
    || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0x20000 && cp <= 0x2fa1f);
}

/** 字 → 它那一組的全部字（含自己）；沒有變體就是空字串 */
let groupIndex: Map<string, string> | null = null;

function index(): Map<string, string> {
  if (groupIndex) return groupIndex;
  const m = new Map<string, string>();
  for (const group of VARIANT_GROUPS.split('|')) {
    if (!group) continue;
    for (const ch of group) m.set(ch, group);
  }
  groupIndex = m;
  return m;
}

/** 「萨」→「萨薩」；沒有變體（或不是漢字）→ '' */
export function variantGroupOf(token: string): string {
  if (!token || [...token].length !== 1) return '';
  return index().get(token) ?? '';
}

/**
 * 一個 token 的所有寫法（含自己）。只有「單一漢字」才展開 —— 拉丁詞、
 * 多字 token（例如 `<123>`）維持原樣。
 */
export function expandToken(token: string): string[] {
  const group = variantGroupOf(token);
  if (group.length > 1) return [...group];
  return [token];
}

/** 這個 token 有沒有變體（診斷用） */
export function hasVariants(token: string): boolean {
  return variantGroupOf(token).length > 1;
}

// ------------------------------------------------------------------ 開關
let enabled = false;

export function variantSearchOn(): boolean {
  return enabled;
}

export function setVariantSearch(on: boolean): void {
  enabled = !!on;
}

// ------------------------------------------------------ 查不到時自動通檢
/**
 * 「查不到時自動繁簡通檢」（作者 2026-11-17）：通檢預設可以關著，但讀者打的字
 * （例如簡體「唯识」）在库里**一筆都找不到**時，自動開一次通檢再查（找到「唯識」）。
 * 這是系統級開關，存在 localStorage（`accelon26.variantAuto`），預設開。
 * 與上面的「輸入通檢」是兩回事：那個是每筆查詢都展開；這個只在「0 筆」時兜底。
 */
let autoEnabled = true;

export function variantAutoOn(): boolean {
  return autoEnabled;
}

export function setVariantAuto(on: boolean): void {
  autoEnabled = !!on;
}

/** 查詢裡有沒有「可繁簡展開」的漢字——沒有就別白跑一次通檢 */
export function queryHasVariants(text: string): boolean {
  for (const ch of text) if (variantGroupOf(ch).length > 1) return true;
  return false;
}

/** 名詞分頁用：把查詢字串換成「同組任一字」的樣式（`.` 仍是任一字元）。
 *  `mode`（開頭／結尾）加錨點，讓繁簡通檢也吃「開頭／中間／結尾」三態（作者 2026-11：
 *  通檢開著時「開頭」模式原本被忽略、退化成「含字」）。mid／any 不錨定。 */
export function variantNamePattern(text: string, mode: string = 'any'): RegExp | null {
  const chars = [...text];
  if (!chars.length) return null;
  let body = '';
  let used = false;
  for (const ch of chars) {
    if (ch === '.') { body += '.'; continue; }
    const group = variantGroupOf(ch);
    if (!isHan(ch) || group.length < 2) { body += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); continue; }
    used = true;
    body += '[' + [...group].map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('') + ']';
  }
  if (!used) return null;
  const anchored = mode === 'start' ? '^' + body : mode === 'end' ? body + '$' : body;
  return new RegExp(anchored);
}

/** 診斷：表的規模（測試／hover 用） */
export function variantTableStats(): { groups: number; chars: number } {
  const groups = VARIANT_GROUPS.split('|').filter(Boolean);
  let chars = 0;
  for (const g of groups) chars += [...g].length;
  return { groups: groups.length, chars };
}
