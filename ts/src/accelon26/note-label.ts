/**
 * 註號的**顯示**形式（作者 2026-11-02）＋「跳到註／釋」的查詢語法。
 *
 * 一、顯示：新的 adb（ys）把註號寫成 `<註 n="章.註@冊">`，例如 `11.001@38`：
 * `@` 前面是紙本註號（章.註），`@` 後面是冊號——冊號只是為了讓整個 adb 唯一，
 * **不該出現在畫面上**。舊 adb 是 `n="38.160"`（沒有 `@`），照原樣顯示。
 *
 *   noteLabel('11.001@38') === '11.001'
 *   noteLabel('38.160')    === '38.160'
 *
 * **查表／比對一律用完整的 n（含 `@冊`）**。
 *
 * 二、跳到註／釋（作者 2026-11-02）：照 Markdown 腳注的寫法，用 `[^…]` 前綴，
 * 這樣不會和頁 id（`49p15`）、大正引用、頁行引用（`yl38p24`）混在一起：
 *
 *   [^11.001]     跳到正文裡的 `<註>`（引用處）
 *   [^11.001]:    跳到 `<釋>`（注文；Markdown 的定義寫法）
 *   [^11.001@38]  同上，但冊號也給（跨冊同號時保證唯一）
 *
 * `11.001` 本身**不是**註的語法（那可能是頁 id 或搜尋詞）。
 */

/** 顯示用的註號：切掉 `@冊` */
export function noteLabel(n: string): string {
  if (!n) return '';
  const at = n.indexOf('@');
  return at > 0 ? n.slice(0, at) : n;
}

/** `[^註號]` 的查詢 → { key, to }；不是這種語法回 null */
export interface NoteQuery {
  /** 使用者打的註號（可能含 `@冊`） */
  key: string;
  /** 顯示用的紙本註號 */
  label: string;
  /** ref＝跳到 `<註>`；body＝跳到 `<釋>`（`]` 後面多一個 `:`） */
  to: 'ref' | 'body';
}

const NOTE_QUERY_RE = /^\s*\[\^([^\]\s]+)\]\s*(:?)\s*$/;

export function parseNoteQuery(text: string): NoteQuery | null {
  const m = NOTE_QUERY_RE.exec(text ?? '');
  if (!m) return null;
  const key = m[1].trim();
  if (!key) return null;
  return { key, label: noteLabel(key), to: m[2] === ':' ? 'body' : 'ref' };
}

/** 提示卡要顯示的語法說明 */
export const NOTE_QUERY_HINT = '[^11.001] 跳到註、[^11.001]: 跳到釋文（舊 adb 直接寫 [^38.160]）';
