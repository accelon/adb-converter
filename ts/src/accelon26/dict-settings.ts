/**
 * 「查字典」的偏好（作者 2026-10-22；2026-10-28 取消自動查）
 *
 *   * 2026-10-28 起不再有點本文／選取十字以下自動查；改由本文選取選單的
 *     「查字典」明確觸發（見 bookmarks.ts 與 dict-pane.ts 的 openDictLookup）。
 *   * 詞典順序：儲存的是**adb 檔名**（例如 `fgdict.adb`），不是 catalog 的 key
 *     ——key 含 size/mtime，重建 adb 就變了；檔名和標籤樣式的 adb 鍵一致。
 *     下回啟動時，找不到的檔名直接略過，**不警告**（作者指定）。
 *   * 只列出 c="isdict"（作者 2026-10-26）：辭典順序清單只留 `<集 c="… isdict …">`
 *     的庫，查詢也只查這些。預設關（顯示並查全部詞典型 adb，
 *     含沒標 isdict 的佛光大辭典）。
 *
 * 這是「這台電腦」的介面偏好，和主題／繁簡一樣存 localStorage；不放 settings.json
 * （settings.json v1 只放可分享的標籤樣式）。
 */

const ORDER_KEY = 'accelon26.dict.order';
const ISDICT_KEY = 'accelon26.dict.isdictonly';

/** 詞典檔名的順序（可能包含目前不存在的檔名；查詢時會略過） */
export function dictOrder(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(ORDER_KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    return raw.filter((s): s is string => typeof s === 'string' && s.length > 0);
  } catch {
    return [];
  }
}

/** 存檔名順序；去掉重複與空字串，保留「目前找不到」的檔名（下次檔案回來還在原位） */
export function setDictOrder(files: string[]): void {
  const seen = new Set<string>();
  const clean: string[] = [];
  for (const f of files) {
    if (typeof f !== 'string' || !f || seen.has(f)) continue;
    seen.add(f);
    clean.push(f);
  }
  try {
    localStorage.setItem(ORDER_KEY, JSON.stringify(clean));
  } catch {
    /* 同上 */
  }
}

/**
 * 只列出（也只查）`<集 c="… isdict …">` 的庫？（預設關）
 * 勾選時：辭典順序清單只留有 isdict 標記的辭典，點字／選取查詢也只查這些；
 * 過濾期間的上下移動仍只在看得到的列之間交換。
 */
export function dictOnlyIsdict(): boolean {
  try {
    return localStorage.getItem(ISDICT_KEY) === '1';
  } catch {
    return false;
  }
}

export function setDictOnlyIsdict(on: boolean): void {
  try {
    localStorage.setItem(ISDICT_KEY, on ? '1' : '0');
  } catch {
    /* 同上 */
  }
}

/**
 * 依已存的檔名順序排列目前清單：
 *   * 已存的檔名有對應的項目 → 依序排前面；
 *   * 找不到的檔名 → 直接略過（不警告）；
 *   * 清單裡有、但順序裡沒有的項目（新加入的詞典）→ 排最後。
 *
 * `order` 可以注入（測試用）；預設讀 localStorage。
 */
export function orderByFile<T extends { file: string }>(list: T[], order: string[] = dictOrder()): T[] {
  const byFile = new Map(list.map((x) => [x.file, x]));
  const out: T[] = [];
  for (const f of order) {
    const x = byFile.get(f);
    if (!x) continue;                 // 下回找不到：略過，不警告
    out.push(x);
    byFile.delete(f);
  }
  for (const x of list) {
    if (byFile.has(x.file)) out.push(x);
  }
  return out;
}
