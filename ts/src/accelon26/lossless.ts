/**
 * 顯示用的「無損簡體」（作者 2026-10）。
 *
 * Canonical: agent-norms/lossless-simplified/lossless.ts
 * 目的：讓習慣讀簡體的人也讀得順，但**不要因為簡化而誤解個別字**（作者舉例：中醫）。
 * 所以分成三種顯示模式：
 *
 *   0 原樣        —— 不動
 *   1 無損簡體    —— 只做「一對一」的繁→簡；多對一的（發／髮→发、乾／幹→干、裡／裏→里、
 *                    臺→台）保留原字。轉完仍然看得出原文是哪個字。
 *   2 強制簡體    —— 全部轉（Unihan kSimplifiedVariant）。
 *
 * 資料在 `simplified-data.ts`（`gen-lossless.ts` 從 Unihan_Variants.txt 產生，
 * 每兩個字一組「繁體,簡體」）。只做顯示：索引、搜尋、塗紅比對都還是在原文上。
 */
import { FORCE_PAIRS, SAFE_PAIRS } from './simplified-data';

/** 0＝原樣、1＝無損簡體、2＝強制簡體 */
export type SimMode = 0 | 1 | 2;

function parsePairs(pairs: string): Map<string, string> {
  const m = new Map<string, string>();
  for (let i = 0; i + 1 < pairs.length; i += 2) m.set(pairs[i], pairs[i + 1]);
  return m;
}

let safeMap: Map<string, string> | null = null;
let forceMap: Map<string, string> | null = null;

function maps(): { safe: Map<string, string>; force: Map<string, string> } {
  if (!safeMap) safeMap = parsePairs(SAFE_PAIRS);
  if (!forceMap) forceMap = parsePairs(FORCE_PAIRS);
  return { safe: safeMap, force: forceMap };
}

/** 單字轉換（不是漢字、或這個模式不轉 → 原樣） */
export function simplifyChar(ch: string, mode: SimMode): string {
  if (!mode) return ch;
  const { safe, force } = maps();
  return (mode === 1 ? safe.get(ch) : force.get(ch)) ?? ch;
}

/** 字串轉換（逐字；不動標點、數字、拉丁字母） */
export function toSimplified(text: string, mode: SimMode): string {
  if (!mode || !text) return text;
  let out = '';
  for (const ch of text) out += simplifyChar(ch, mode);
  return out;
}

/** 這個字在無損模式下會轉嗎（測試／診斷用） */
export function losslessConverts(ch: string): boolean {
  return maps().safe.has(ch);
}

/** 表的大小（診斷用） */
export function simplifiedStats(): { safe: number; force: number } {
  const { safe, force } = maps();
  return { safe: safe.size, force: force.size };
}

/** 給渲染器用的轉換函式（mode 0 回傳 null，呼叫端可省一次字串掃描） */
export function displayConverter(mode: SimMode): ((s: string) => string) | null {
  return mode ? (s: string) => toSimplified(s, mode) : null;
}
