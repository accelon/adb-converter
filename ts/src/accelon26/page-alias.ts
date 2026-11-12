/**
 * 「講記代號 → 頁 id 前綴」的別名（厚觀法師 2026-11-12）。
 *
 * 法師為八本講記編了代號（HG01 成佛之道、HG02 空之探究、HG03 中觀今論、
 * HG04 大智度論、HG05 中論、HG06 十住毘婆沙論、HG07 法華經、HG08 維摩經），
 * 每一章的腳注都用 `HG02.xxx` 這種寫法。他問：跳頁能不能只打 `HG02p93`／`2p93`，
 * 不必記資料庫內部那個 `38p93`。
 *
 * 這個模組只做「字串 → 字串」，不碰 adb／DOM：認得的代號回傳對應的頁 id 寫法
 * （`HG02p93` → `38p93`），其餘一律回空陣列，呼叫端照原樣處理。
 *
 * 前綴是**這個資料庫裡實際的頁 id 開頭**（fuyan 的頁 id 就直接寫成 `38p93`），
 * 不是法師的編號：HG02→38、HG03→9、HG05→5。目前只有這三本在 fuyan 裡，
 * 其餘代號沒有對應的書，故意不猜（猜錯比不認得糟）。要加書就在這張表補一筆。
 */
const BOOK_PREFIX: Record<string, string> = {
  hg02: '38',   // 《空之探究講義》
  hg03: '9',    // 《中觀今論講義》
  hg05: '5',    // 《中觀論頌講記》
};

/** 法師給的八個代號（回「這本書還沒進來」時要說得出書名，不能只說看不懂）。 */
const BOOK_TITLE: Record<string, string> = {
  hg01: '《成佛之道》',
  hg02: '《空之探究講義》',
  hg03: '《中觀今論講義》',
  hg04: '《大智度論》',
  hg05: '《中觀論頌講記》',
  hg06: '《十住毘婆沙論》',
  hg07: '《法華經》',
  hg08: '《維摩經》',
};

/** 這個庫的 dbname 才吃代號：fuyan 是同一個 adb 裝三本書，頁 id 前綴才需要代號。 */
const ALIAS_DB = 'fuyan';

/**
 * 把 `HG02p93`／`hg2p93`／`2p93` 這種寫法展開成這個庫認得的頁 id 寫法。
 *
 * 回傳**候選字串**（呼叫端再拿它去比對實際的頁 id，比不到就當作沒這回事）：
 *   - 代號寫法本身也留著（`HG02p93`），方便以後頁 id 真的改用代號時照樣能用；
 *   - 只展開有登記過的代號，未登記的回空陣列。
 */
export function pageAliasForms(q: string, db = ''): string[] {
  if (!isAliasDb(db)) return [];
  const m = matchCode(q);
  if (!m) return [];
  const prefix = BOOK_PREFIX['hg0' + m.code];
  if (!prefix) return [];
  return [`${prefix}p${m.page}${m.tail ?? ''}`];
}

/**
 * 書名 → 頁 id 前綴（fuyan 一個庫裝三本，頁 id 前綴＝書 id 去掉 `yl`：yl38→38、yl5→5、yl9→9）。
 * 資料來源是 `out/fuyan.txt` 的 `<書 id="yl38">空之探究講義</書>`，不是法師的 HG 代號。
 */
const BOOK_PAGE_PREFIX: [string, string][] = [
  ['空之探究講義', '38'],
  ['中觀論頌講記', '5'],
  ['中觀今論講義', '9'],
];

/**
 * 「引用複製」貼回搜尋框（厚觀法師 2026-11-12「字元級引用複製，我們都可以直接跳」）。
 *
 * 引用出來的文字長這樣：
 *
 *   《空之探究講義》：「由於十遍處……」（p.93）
 *
 * 裡面的頁碼是**紙本頁碼**（`p.93`），不是頁 id（`38p93`），所以光靠 `embeddedPage()`
 * 認不出來——它找的是頁 id 本身。這裡用書名補上前面那一段，再交給 `anchorVa` 驗證。
 * 認不出書名／頁碼就回 null，呼叫端照原樣（當搜尋字串）處理。
 */
export function pageIdFromQuote(q: string, db = ''): string | null {
  if (!isAliasDb(db)) return null;
  const s = (q ?? '').normalize('NFC');
  const book = BOOK_PAGE_PREFIX.find(([t]) => s.includes(t));
  if (!book) return null;
  const m = /pp?\.\s*(\d{1,4})(?:\s*[-–—~]\s*\d{1,4})?/i.exec(s)
    ?? /[（(]\s*(\d{1,4})\s*[）)]/.exec(s);
  if (!m) return null;
  return `${book[1]}p${m[1]}`;
}

/**
 * 這段字串看起來像「引用複製」貼回來的整段，或字元級位置？
 *
 * Enter 時要先試跳頁：搜尋也命中得到，但命中的是「某一段」，讀者要的是「那一頁」。
 * 只認兩種明顯的形狀，一般搜尋字串不會被吃掉：
 *   - `fuyan?38p93#12-34`（字元級位置）
 *   - 《書名》…（p.93）／pp.92-93（引用複製；大正藏那種 `(T02, 206a15)` 另外走）
 */
export function looksLikeQuote(q: string): boolean {
  const s = (q ?? '').trim();
  if (!s) return false;
  if (/[?#]\s*\d+\s*(?:[-–—]\s*\d+)?\s*$/.test(s)) return true;
  return /《[^》]{2,24}》/.test(s) && /pp?\.\s*\d{1,4}/i.test(s);
}

/** 這個庫吃不吃講記代號（dbname／檔名／中文書名任一個指向 fuyan 就算）。 */
function isAliasDb(db: string): boolean {
  const s = (db ?? '').trim().toLowerCase();
  return s === ALIAS_DB || s.includes(ALIAS_DB) || s.includes('福嚴');
}

/** 認得的代號但這個庫裡沒有那本書：回書名（給「找不到」的訊息用），否則是空字串。 */
export function pageAliasMissing(q: string, db = ''): string {
  if (!isAliasDb(db)) return '';
  const m = matchCode(q);
  if (!m) return '';
  if (BOOK_PREFIX['hg0' + m.code]) return '';
  return `HG0${m.code}${BOOK_TITLE['hg0' + m.code] ?? ''}`;
}

/** `HG02p93`／`hg2p93`／`2p93` → { code: 2, page: '93', tail: '' } */
function matchCode(q: string): { code: number; page: string; tail?: string } | null {
  const s = (q ?? '')
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))  // 全形→半形
    .replace(/\s+/g, '');
  // HG02p93 / hg2p93 / 2p93（`p` 也可以寫成 `p.`）；尾端允許 `a` 這種欄號
  const m = /^(?:hg0?([1-8])|([1-8]))p\.?(\d{1,5})((?:[a-c]\d{0,3})?)$/i.exec(s);
  if (!m) return null;
  return { code: Number(m[1] ?? m[2]), page: m[3], tail: m[4] || undefined };
}
