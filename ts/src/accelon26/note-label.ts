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

/** 註／釋查詢（`[註號` 或 `]註號`）→ { key, to }；不是這種語法回 null */
export interface NoteQuery {
  /** 使用者打的註號（可能含 `@冊`） */
  key: string;
  /** 顯示用的紙本註號 */
  label: string;
  /** ref＝跳到 `<註>`（前綴 `[`）；body＝跳到 `<釋>`（前綴 `]`） */
  to: 'ref' | 'body';
}

/**
 * 一個字元的前綴（作者 2026-11-02 定案，省掉 `^` 與結尾的 `]`）：
 *
 *   [11.001    跳到 `<註>`（正文的引用；`[` 像 Markdown 腳注的開頭）
 *   ]11.001    跳到 `<釋>`（注文；`]` 像 Markdown 腳注定義的結尾）
 *
 * 冊號可給可不給（`[11.001@38`）；舊 adb 直接寫 `[38.160`。
 * 一定要有前綴：`11.001` 看起來就是目錄路徑（`1.2.3`）。
 */
const NOTE_QUERY_RE = /^\s*([[])\s*([^\]\s]+)\s*$|^\s*(\])\s*([^\]\s]+)\s*$/;

export function parseNoteQuery(text: string): NoteQuery | null {
  const m = NOTE_QUERY_RE.exec(text ?? '');
  if (!m) return null;
  const prefix = m[1] ?? m[3];
  const key = (m[2] ?? m[4] ?? '').trim();
  if (!key) return null;
  return { key, label: noteLabel(key), to: prefix === ']' ? 'body' : 'ref' };
}

/** 提示卡要顯示的語法說明 */
export const NOTE_QUERY_HINT = '[11.001 跳到註、]11.001 跳到釋文（舊 adb 直接寫 [38.160）';
