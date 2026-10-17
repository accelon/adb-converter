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

/** 名詞分頁用：把查詢字串換成「同組任一字」的樣式（`.` 仍是任一字元） */
export function variantNamePattern(text: string): RegExp | null {
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
  return used ? new RegExp(body) : null;
}

/** 診斷：表的規模（測試／hover 用） */
export function variantTableStats(): { groups: number; chars: number } {
  const groups = VARIANT_GROUPS.split('|').filter(Boolean);
  let chars = 0;
  for (const g of groups) chars += [...g].length;
  return { groups: groups.length, chars };
}
