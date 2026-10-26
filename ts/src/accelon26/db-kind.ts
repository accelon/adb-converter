/**
 * 這是哪一種資料庫？（作者 2026-10）
 *
 * 詞典型 adb 的本文**不需要 `docHead`**：詞條名稱已經在分頁標題上，而且第一個詞條字串
 * 通常就是搜尋命中、會被塗紅 —— 再放一次標題就變成同一個詞顯示三次。
 *
 * 作者指定的判定：**有 `$詞`（`<樹 s="$詞">`）就算詞典型**；`c="isdict"` 只是補充
 * （會漏掉像佛光大辭典這種沒標 isdict 的庫）。最後再加一道保險：詞／字標籤有現成且
 * 對得上的名稱表（就是詞條表）也算。
 *
 * 判定只看來源文字的前幾行（開啟後一次、快取在 mapper 上），成本可忽略。
 */
import type { VaPaMapper } from './vapa';
import type { AdbReader } from './adb';

const dictCache = new WeakMap<VaPaMapper, boolean>();

/** 來源前幾行就夠了：`<集>` 與 `<樹>` 都宣告在最前面 */
const HEAD_LINES = 16;

/** 詞條標籤的候選（`$詞` 宣告會優先） */
const ENTRY_TAGS = ['詞', '字', '詞條', '字頭'];

/** 來源前幾行（`<集>` 與 `<樹>` 都宣告在最前面）；讀不到回空字串 */
async function headText(m: VaPaMapper): Promise<string> {
  let head = '';
  try {
    for (let i = 0; i < HEAD_LINES; i++) {
      const line = await m.lineText(i);
      if (!line) continue;
      head += line + '\n';
      if (head.length > 4096) break;
      // <樹> 宣告通常在前 6 行；看到第一個內容標籤就不用再讀
      if (i >= 3 && /<(書|章|節|詞|字)\b/.test(head)) break;
    }
  } catch {
    /* 讀不到就用結構判定 */
  }
  return head;
}

/** `<集 c="… isdict …">` 的 c 屬性裡有沒有獨立的 isdict 字（作者 2026-10 的標記） */
function isdictInHead(head: string): boolean {
  // 注意：JS 的 `\b` 只認 ASCII 單字字元，`<集` 的 `集` 是非 ASCII → `<集\b` 永遠不匹配，
  // 所以這裡用「空白或 >」當邊界（作者 2026-10 踩過的坑）。
  const ji = /<集(?:\s[^>]*)?>/.exec(head);
  const cAttr = ji ? /\sc\s*=\s*"([^"]*)"/.exec(ji[0]) : null;
  return !!cAttr && /(^|\s)isdict(\s|$)/.test(cAttr[1].trim());
}

/**
 * 只問「`集 c` 有沒有 isdict」——設定頁的「只列出 c="isdict"」用。
 * 和 detectDictDb 不同：沒有 `$詞` 樹、沒有詞條表的庫也可能是 isdict，這裡只回報標記本身。
 */
export async function detectIsdict(m: VaPaMapper): Promise<boolean> {
  return isdictInHead(await headText(m));
}

export async function detectDictDb(m: VaPaMapper): Promise<boolean> {
  const head = await headText(m);
  const isdict = isdictInHead(head);
  // **有 $詞 就算詞典型**（$詞／$字／$詞條／$字頭）
  const decl = [...head.matchAll(/<樹(?:\s[^>]*)?\ss\s*=\s*"\$([^".\s]+)/g)].map((x) => x[1]);
  let entryTable = false;
  const reader = (m as unknown as { reader?: AdbReader }).reader;
  const tags = reader?.containers.get('tags');
  if (!isdict && !decl.length && reader && tags) {
    // 最後一道保險：詞／字 標籤有現成且對得上的名稱表（就是詞條表）
    for (const tag of ENTRY_TAGS) {
      const ti = tags.names.indexOf(tag);
      if (ti < 0) continue;
      try {
        const names = await reader.cachedStrings(tag);
        if (names.length >= 50 && names.length === (await reader.decodeBlockList('tags', ti)).length) {
          entryTable = true;
          break;
        }
      } catch {
        /* 沒有名稱表就跳過 */
      }
    }
  }
  const dict = isdict || decl.length > 0 || entryTable;
  dictCache.set(m, dict);
  return dict;
}

/** 這個 mapper 對應的庫是不是詞典型（沒偵測過 → false，之後會補上） */
export function isDictDb(m: VaPaMapper | null | undefined): boolean {
  return !!m && dictCache.get(m) === true;
}

/** 測試／診斷用：直接指定 */
export function setDictDb(m: VaPaMapper, on: boolean): void {
  dictCache.set(m, !!on);
}
