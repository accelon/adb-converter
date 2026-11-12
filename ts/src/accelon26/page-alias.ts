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
  if (db.toLowerCase() !== ALIAS_DB) return [];
  const m = matchCode(q);
  if (!m) return [];
  const prefix = BOOK_PREFIX['hg0' + m.code];
  if (!prefix) return [];
  return [`${prefix}p${m.page}${m.tail ?? ''}`];
}

/** 認得的代號但這個庫裡沒有那本書：回書名（給「找不到」的訊息用），否則是空字串。 */
export function pageAliasMissing(q: string, db = ''): string {
  if (db.toLowerCase() !== ALIAS_DB) return '';
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
