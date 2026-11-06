/**
 * 「字元級位置」的解析（不碰 DOM，方便單元測試）。
 *
 * 新寫法（2026-11-06 作者定案）：
 *
 *   taisho?5p2c#12-34    頁 id ＋ 這一頁第 12–34 個漢字（起訖都算）
 *   taisho?5p2c#12       只標第 12 個字
 *   fuyan?yl38p4#12-34   頁 id 不必是 `<數字>p<數字>` 形式
 *   foo?L123#5-12        沒有 <頁> 的庫：行號 ＋ 這一行的第 5–12 個漢字
 *
 * 舊 `j=` 寫法只留作相容解析；新產出的一律用 `#`。
 */
export interface CharPosition {
  db: string;
  anchor: string;
  /** 起點漢字索引（0 起，含） */
  a: number;
  /** 終點漢字索引（0 起，含） */
  b: number;
}

/** 頁 id：`L123`、一般頁 id，或詞書的 `詞1`／`字1`（tag＋id）。 */
const HAN_ANCHOR = '[\\p{Script=Han}][\\p{Script=Han}A-Za-z0-9_.:·（）()、-]*';
const ANCHOR_RE = `(?:L[0-9]+|[A-Za-z0-9][A-Za-z0-9_.-]*[0-9][A-Za-z0-9_.-]*|${HAN_ANCHOR})`;
const DB_RE = '([A-Za-z0-9_.-]+)';

const CHAR_POS_HASH_RE = new RegExp(
  `^\\s*(?:${DB_RE}\\?)?\\s*(${ANCHOR_RE})\\s*#\\s*([0-9]+)\\s*(?:[-–—]\\s*([0-9]+))?\\s*$`, 'iu');
const CHAR_POS_J_RE = new RegExp(
  `^\\s*(?:${DB_RE}\\?)?\\s*(${ANCHOR_RE})\\s*j\\s*=\\s*([0-9]+)\\s*(?:[-–—]\\s*([0-9]+))?\\s*$`, 'iu');
/** 掃描整段引用字串裡的最後一個 `#起-止`。 */
const CHAR_POS_TOKEN_RE = new RegExp(
  `(?:^|[^A-Za-z0-9_.-])(?:${DB_RE}\\?)?(${ANCHOR_RE})\\s*#\\s*([0-9]+)(?:\\s*[-–—]\\s*([0-9]+))?`, 'giu');

function posFromMatch(m: RegExpExecArray, legacyEndExclusive: boolean): CharPosition {
  const a = Number(m[3]);
  const rawB = m[4] === undefined ? a : Number(m[4]);
  // 舊 `j=` 的 end 不含（例如選一個字會寫 12-13）；`#` 的起訖都算。
  const b = legacyEndExclusive ? Math.max(a, rawB - 1) : rawB;
  return { db: m[1] ?? '', anchor: m[2], a: Math.min(a, b), b: Math.max(a, b) };
}

/** 整串就是一個位置（新 `#` 或舊 `j=`）。 */
export function parseCharPosition(s: string): CharPosition | null {
  const text = s ?? '';
  const hash = CHAR_POS_HASH_RE.exec(text);
  if (hash) return posFromMatch(hash, false);
  const legacy = CHAR_POS_J_RE.exec(text);
  if (legacy) return posFromMatch(legacy, true);
  return null;
}

/**
 * 從「一段引用字串」裡找位置 token；整串不是純位置時用這個。
 * 取最後一個 `#` token：引用複製會把 token 接在尾端。
 */
export function findCharPosition(s: string): CharPosition | null {
  const full = parseCharPosition(s);
  if (full) return full;
  let last: RegExpExecArray | null = null;
  for (const m of (s ?? '').matchAll(CHAR_POS_TOKEN_RE)) last = m as RegExpExecArray;
  return last ? posFromMatch(last, false) : null;
}

/** 顯示用：`頁#a` 或 `頁#a-b`（起訖都算）。 */
export function formatCharPosition(pos: Pick<CharPosition, 'anchor' | 'a' | 'b'>): string {
  return `${pos.anchor}#${pos.a}${pos.b > pos.a ? `-${pos.b}` : ''}`;
}
