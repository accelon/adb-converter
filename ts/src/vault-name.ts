/**
 * The file name a user types in 「加入 Obsidian」 — DOM free so it can be tested.
 *
 * Accepts `lunyu`, `lunyu.adb`, `論語`, `論語.ADB`, with or without spaces; what
 * comes out is the stem to show, the file name to write (always `.adb`) and the
 * header `dbname` (ASCII only, because the adb header field is ASCII/NUL padded).
 */

/** Windows rejects these; control characters are never useful in a name */
const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f]/g;

export interface VaultFileName {
  /** what the reader sees, without `.adb` */
  stem: string;
  /** the file that is written (always ends with `.adb`) */
  file: string;
  /** the ASCII name stored in the adb header (≤ 31 bytes) */
  dbname: string;
}

/**
 * `lunyu`、`lunyu.adb`、`論語`、`論語.ADB` 都接受。
 *
 * 檔名可以任意（中文、空白）；adb 檔頭的 dbname 只能 ASCII —— 取英數部分，
 * 沒有就記成 `adb`（畫面上的庫名是 dbcname＝書名，不受影響）。
 *
 * Returns null for an empty / punctuation-only name (the dialog shows a hint).
 */
export function normalizeVaultName(raw: string): VaultFileName | null {
  // 先去掉 .adb 再看剩下的名字：`.adb`、`..`、空白都算「沒有名字」
  let stem = raw.trim().replace(ILLEGAL, '');
  if (/\.adb$/i.test(stem)) stem = stem.slice(0, -4);
  stem = stem.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  if (!stem) return null;
  stem = stem.slice(0, 60);
  const dbname = stem
    .replace(/[^0-9A-Za-z._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 31) || 'adb';
  return { stem, file: stem + '.adb', dbname };
}

/** suggested name: the ASCII part of the vault's name (empty when it has none) */
export function suggestStem(label: string, hint?: string): string {
  const ascii = (s: string) => s.replace(/[^0-9A-Za-z]+/g, '-').replace(/^-+|-+$/g, '');
  return ascii(label) || ascii((hint ?? '').replace(/\.zip$/i, '')) || '';
}
