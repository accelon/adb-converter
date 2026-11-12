/**
 * 「忽略標點的找字」——搜尋與摘要上色用（作者 2026-11-12）。
 *
 * 為什麼需要：跨標點搜尋（`search.ts` 的 `PunctSkip`）命中「涅槃、寂靜」時，
 * 查詢字串是「涅槃寂靜」，畫面上一行卻是「涅槃、寂靜」——`indexOf(needle)`
 * 找不到，塗紅與摘要就整段不上色。搜尋結果對、畫面沒顏色，比搜不到更難解釋。
 *
 * 做法：兩邊都先把「可跨的標點」去掉再比對，命中後把**原文**的起迄位置還原
 * （中間的標點自然被包進區間），所以塗紅會連標點一起蓋住，正是讀者看到的那一段。
 */

/** 去標點的字串，以及「摺疊後第 i 個字在原文的位置」。 */
export interface Folded {
  folded: string;
  map: number[];
}

const isP = (ch: string): boolean => isCrossablePunct(ch.codePointAt(0) ?? 0);

/**
 * **可以跨過去的標點**——只認「句中停頓」與「包裹用的引號、書名號、括號」。
 *
 * 為什麼不是所有標點：`．`（U+FF0E）、`·`、`／` 這類是**間隔符**，前後本來就是
 * 兩件事（古籍的「朱熹．四書集注」），跨過去搜尋會把兩句黏成一個假命中
 * （13j 實測：搜「之信」多出 7 筆「之．信」）。`。！？…` 是句末，同理不跨。
 *
 * 搜尋端（`search.ts` 的 `PunctSkip`）與 Go 後端（`wails/search.go` 的
 * `isPunctRune` 旁的白名單）必須用同一份判準。
 */
const CROSS_SINGLE = new Set([
  '，', '、', '；', '：', '（', '）', '｛', '｝',
  ',', ';', ':', '(', ')', '[', ']', '{', '}',
]);

export function isCrossablePunct(cp: number): boolean {
  const ch = String.fromCodePoint(cp);
  if (CROSS_SINGLE.has(ch)) return true;
  // 〈〉《》「」『』【】〔〕〖〗…（CJK 標題／引號／括號）
  if (cp >= 0x3008 && cp <= 0x301f) return true;
  // 直排與兼容形式的引號、括號
  if (cp >= 0xfe30 && cp <= 0xfe4f) return true;
  return false;
}

/** 去掉單字標點；`map[i]` 是摺疊字串第 i 個字在原文的 UTF-16 位移。 */
export function foldPunct(text: string): Folded {
  let folded = '';
  const map: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (isP(ch)) continue;
    folded += ch;
    map.push(i);
  }
  return { folded, map };
}

/**
 * 在 `text` 裡找 `needle`（兩邊都比對「去標點」後的字串）。
 * 回傳原文的 `[start, end)`；`all` 為 true 時回傳每一次出現。
 * 找不到回空陣列。
 */
export function findPunctLoose(
  text: string,
  needle: string,
  all = false,
): { start: number; end: number }[] {
  const foldedNeedle = foldPunct(needle).folded;
  if (!foldedNeedle) return [];
  const { folded, map } = foldPunct(text);
  const out: { start: number; end: number }[] = [];
  let from = 0;
  for (;;) {
    const at = folded.indexOf(foldedNeedle, from);
    if (at < 0) break;
    const start = map[at];
    const last = at + foldedNeedle.length - 1;
    const end = map[last] + 1;
    if (end > start) out.push({ start, end });
    from = at + foldedNeedle.length;
    if (!all) break;
  }
  return out;
}

/** 有沒有跨過標點（嚴格比對失敗、寬鬆比對成功才算）。 */
export function crossesPunct(text: string, needle: string): boolean {
  if (text.includes(needle)) return false;
  return findPunctLoose(text, needle).length > 0;
}

/**
 * 在**帶標記的原文**裡找 `phrase`（忽略標籤，也忽略標點）。
 *
 * 摘要（`searchSummary`）拿到的是含 `<术>`、`<頁/>` 等的原始行，可見文字才是
 * 讀者看到的東西。這裡先把標籤當透明、把標點摺掉再比對，命中時回傳**原文**的
 * `[start, end)`（含中間的標籤與標點），呼叫端才能切出正確的卡片與塗紅範圍。
 */
export function findLooseInMarkup(
  raw: string,
  phrase: string,
  from = 0,
): { start: number; end: number } | null {
  const needle = foldPunct(phrase).folded;
  if (!needle) return null;
  // 可見字元（跳過標籤）→ 原文位置
  let visible = '';
  const pos: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '<') {
      const gt = raw.indexOf('>', i);
      if (gt > i) { i = gt; continue; }
    }
    visible += raw[i];
    pos.push(i);
  }
  const { folded, map } = foldPunct(visible);
  let searchFrom = 0;
  if (from > 0) {
    while (searchFrom < map.length && pos[map[searchFrom]] < from) searchFrom++;
  }
  const at = folded.indexOf(needle, searchFrom);
  if (at < 0) return null;
  return { start: pos[map[at]], end: pos[map[at + needle.length - 1]] + 1 };
}
