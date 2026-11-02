/**
 * 註號的**顯示**形式（作者 2026-11-02）。
 *
 * 新的 adb（ys）把註號寫成 `<註 n="章.註@冊">`，例如 `11.001@38`：
 * `@` 前面是紙本註號（章.註），`@` 後面是冊號——冊號只是為了讓整個 adb 唯一，
 * **不該出現在畫面上**。舊 adb 是 `n="38.160"`（沒有 `@`），照原樣顯示。
 *
 *   noteLabel('11.001@38') === '11.001'
 *   noteLabel('38.160')    === '38.160'
 *
 * **查表／比對一律用完整的 n（含 `@冊`）**：跨冊可能有相同的章.註，
 * 拿 label 當 key 會撞號。
 */
export function noteLabel(n: string): string {
  if (!n) return '';
  const at = n.indexOf('@');
  return at > 0 ? n.slice(0, at) : n;
}

/** 使用者輸入的註號 → 可能的完整 n 清單（先給原樣，再給目前這本書的候選） */
export function noteInputCandidates(input: string): string[] {
  const s = (input ?? '').trim();
  if (!s) return [];
  return [s];
}
