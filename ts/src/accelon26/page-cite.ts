/**
 * 「頁行」引用（作者 2026-11-01）：讓 ys、fuyan 這種沒有大正卷號的庫也能直接跳到某一行。
 *
 *   y38p7a8   ys 第 38 部書第 7 頁 a 欄第 8 行
 *   y38p7     同上，跳到**頁首**
 *   y38       同上，跳到**書首**（第 38 部書的第一頁）
 *   yl38p24   yl38 這一個庫的第 24 頁（庫名本身帶數字；沒有書號）
 *
 * 讀法：`<庫前綴><書號>p<頁號>[<欄><行>]`，其中每一段都可以省略：
 *   * 庫前綴＝庫的 dbname 或檔名開頭。有兩種比法（先試前面的）：
 *       (a) **完整庫名**：`yl38p24`（庫名 yl38）、`ys38p7a8`（庫名 ys）
 *       (b) **庫名的字母開頭**（庫名不含數字時）：`y38p7a8`（y→ys）、`f1p7a3`（f→fuyan）
 *     庫名帶數字（`yl38`）只用 (a)，免得 `y38…` 被誤認。
 *   * 書號＝該庫 `<書>` 的第幾部（1 起）；省略時頁號算**整個庫**（不綁書）。
 *   * 頁號＝第幾頁（1 起，照文件順序；同一頁的 a/b/c 欄算**一頁**）。
 *   * 欄、行都可以省略；**沒有分欄的頁一律視為 a 欄**（fuyan 就是這樣）。
 *
 * 這個模組只做語法，不碰 adb／DOM（`resolvePageCite`／`jumpPageCite` 在 `xref.ts`）。
 */
export interface PageCite {
  /** 正規化後的字串 */
  raw: string;
  /** 庫（小寫；完整庫名或庫名的字母開頭） */
  db: string;
  /** 第幾部書（1 起；沒有就是「整庫算頁」） */
  book?: number;
  /** 第幾頁（1 起；沒有就跳到書首／第一頁） */
  page?: number;
  /** 欄（小寫；沒有分欄＝`a`） */
  col: string;
  /** 第幾行（1 起；沒有就是頁首） */
  line?: number;
}

/** 庫名之後的部分：`[書號][p頁號][欄行]` */
const REST_RE = /^(?:(\d{1,4}))?(?:p\.?(\d{1,5}))?(?:([a-c])(\d{1,3})?)?$/i;

interface Rest { book?: number; page?: number; col: string; line?: number }

function parseRest(rest: string): Rest | null {
  if (!rest) return null;
  const m = REST_RE.exec(rest);
  if (!m) return null;
  const book = m[1] !== undefined ? Number(m[1]) : undefined;
  const page = m[2] !== undefined ? Number(m[2]) : undefined;
  const line = m[4] !== undefined ? Number(m[4]) : undefined;
  if (book !== undefined && book < 1) return null;
  if (page !== undefined && page < 1) return null;
  if (line !== undefined && line < 1) return null;
  return { book, page, col: (m[3] ?? 'a').toLowerCase(), line };
}

/**
 * 解析「頁行」引用。
 *
 * `names` 是這個環境認得的庫名（dbname 與檔名；順序不影響結果，只影響同分的取捨）。
 * 傳空陣列時只能辨認「完整庫名」（(a)），因為縮寫要靠實際有哪些庫才不會亂猜。
 */
export function parsePageCite(raw: string, names: string[] = []): PageCite | null {
  const s = (raw ?? '')
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))   // 全形→半形
    .replace(/\s+/g, '');
  if (!s) return null;
  const lower = s.toLowerCase();
  const pool = [...new Set(names.map((n) => (n ?? '').toLowerCase()).filter(Boolean))];
  // (a) 完整庫名：長的名字先試（`yl38` 比 `yl3` 更具體）
  for (const n of [...pool].sort((a, b) => b.length - a.length)) {
    if (!lower.startsWith(n)) continue;
    const rest = parseRest(lower.slice(n.length));
    if (rest) return { raw: s, db: n, ...rest };
  }
  // (b) 庫名的字母開頭（1–3 個字母）。庫名含數字的（yl38）不參與，免得 `y38…` 被吃掉。
  let best: { db: string; k: number; rest: Rest } | null = null;
  for (const n of pool) {
    if (/\d/.test(n)) continue;
    const letters = n.replace(/[^a-z]/g, '');
    for (let k = Math.min(3, letters.length); k >= 1; k--) {
      const ab = letters.slice(0, k);
      if (!lower.startsWith(ab)) continue;
      const rest = parseRest(lower.slice(k));
      if (rest && (!best || k > best.k)) best = { db: n, k, rest };
    }
  }
  if (best) return { raw: s, db: best.db, ...best.rest };
  return null;
}

/** 提示／cheat card 用的語法說明 */
export const PAGE_CITE_HINT = 'y38p7a8＝ys 第 38 部書第 7 頁 a 欄第 8 行；'
  + '少了 a8 就是頁首（y38p7），少了 p7 就是書首（y38）；'
  + '庫名本身帶數字就寫全名（yl38p24＝yl38 第 24 頁）；沒有分欄的頁一律當 a 欄';

/**
 * 頁 id → 「頁」與「欄」。
 *
 * ys：`1pa001a`（卷1、頁001、欄 a）→ 頁 `1pa001`、欄 `a`；`bcd` 這種不是欄。
 * fuyan／yl38：`05B-p000`、`yl38p24`（沒有分欄）→ 頁就是整個 id、欄 `a`。
 * 判準：**id 以 `數字＋[a-c]` 結尾**才算「頁＋欄」，其餘整個 id 當一頁。
 */
export function splitPageCol(id: string): { key: string; col: string } {
  const m = /^(.*\d)([a-c])$/i.exec(id);
  if (m) return { key: m[1], col: m[2].toLowerCase() };
  return { key: id, col: 'a' };
}
