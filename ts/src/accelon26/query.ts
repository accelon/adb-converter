/**
 * 查詢語法：多個「詞組」＋布林／鄰近運算子。
 *
 *   A B            兩個詞組（各自是詞組，內部仍要求相鄰）
 *   +A B           A 必須出現（required），B 可選（optional）
 *   A -B           A 可選，B 不能出現（excluded）
 *   A*B            A 與 B 必須相距不超過 PROXIMITY_TOKENS 個 token
 *   +A*B           A、B 都必須出現，而且距離受限
 *   菩.心          單字萬用字元：`.` 前後都是漢字時 ＝ 任意一個 token
 *                  （一個詞組最多 MAX_WILDCARDS 個；其餘的 `.` 是 skipword，直接丟掉）
 *
 * 規則（作者 2026-10）：「以空格或運算子分開詞組」——空白、`+`、`-`、`*` 都是分隔，
 * 而 `+`／`-`／`*` 是**前綴**：作用在緊接在後面的那一個詞組上。
 * `.` 不是分隔，它留在詞組裡面（`菩.提.心` ＝ 菩＋任一字＋提＋任一字＋心）；
 * 歷史上 `.` 會被索引，但它其實是 skipword，所以只有「前後都是漢字」時才當萬用字元，
 * 其他位置的 `.` 一律丟掉。
 *
 * 沒有 `+` 的詞組是 optional：只要求「至少一個」命中，命中的詞組越多、BM25 分數越高。
 * 只有 `+` 的詞組才是硬性 AND —— 這樣 "緣起 性空"（OR，重排）與 "緣起+性空"（AND）
 * 才會有不同的結果集，這也是作者要分辨的那兩種查法。
 */

/** `*` 的距離上限：與上一個詞組不得超過這麼多個 token */
export const PROXIMITY_TOKENS = 20;

export type ClauseRole = 'required' | 'optional' | 'excluded';

export interface QueryClause {
  /** 使用者打的字（可能是多個 token 的詞組，例如「緣起」＝緣＋起） */
  text: string;
  role: ClauseRole;
  /**
   * 這個詞組被 `*` 綁到前一個詞組（`A*B` 的 B）。
   * `nearOf` 是它綁住的那一個 clause 的索引，-1 表示沒有。
   */
  nearPrev: boolean;
  nearOf: number;
}

export interface ParsedQuery {
  /** 使用者原本輸入的字串 */
  raw: string;
  clauses: QueryClause[];
  /** 有 `*`、`+`、`-` 嗎？（用來決定要不要走多詞組引擎） */
  hasOperators: boolean;
  /** 有單字萬用字元 `.` 嗎？（同樣要走多詞組引擎，舊的片語引擎不認得它） */
  wildcard: boolean;
}

/** 一個詞組裡最多允許幾個單字萬用字元（作者 2026-10：最多 10 次） */
export const MAX_WILDCARDS = 10;

/**
 * 整理一個詞組的字面：
 *
 *   * 最前面／最後面的 `.` 沒有意義（沒有東西可以「間隔」）→ 直接去掉
 *   * 中間的 `.` 最多保留 `MAX_WILDCARDS` 個，多出來的忽略
 *   * `.` 不一定要連續：`阿.羅.漢` ＝ 阿＋任一字＋羅＋任一字＋漢（5 個 token）
 *
 * 回傳整理後的文字；全部被去掉時回空字串（呼叫端就跳過這個詞組）。
 */
/** 漢字（含擴充 A／B、相容表意文字、CJK 部首補充）：`.` 只在這種字的兩側才有作用 */
export function isHan(ch: string | undefined): boolean {
  if (!ch) return false;
  const cp = ch.codePointAt(0)!;
  return (cp >= 0x3400 && cp <= 0x4dbf)     // 擴充 A
    || (cp >= 0x4e00 && cp <= 0x9fff)       // 基本區
    || (cp >= 0xf900 && cp <= 0xfaff)       // 相容表意文字
    || (cp >= 0x20000 && cp <= 0x2fa1f);    // 擴充 B～相容補充
}

/**
 * 整理一個詞組的字面（作者 2026-10）：
 *
 *   * `.` **只有在「前後都是漢字」時才是萬用字元**（`菩.心`）；其餘的 `.` 一律丟掉
 *     —— 歷史上 `.` 會被索引，其實它應該當 skipword 扔掉，所以查詢裡不把它當 token。
 *     例：`菩.心` → 萬用字元；`a.b`、`菩.a`、`.菩.心.` → 那些 `.` 全部丟掉（`ab`、`菩a`、`菩.心`）。
 *   * 連續的 `.` 合成一段（`菩..心` ＝ 兩個萬用字元，四個 token），最多 `MAX_WILDCARDS` 個。
 *   * 開頭／結尾的 `.` 沒有前後漢字，自然被丟掉。
 */
export function normalizeClause(text: string): { text: string; wild: boolean } {
  const chars = [...text.trim()];
  const out: string[] = [];
  let wild = 0;
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] !== '.') { out.push(chars[i]); continue; }
    // 一段連續的 `.`
    let j = i;
    while (j < chars.length && chars[j] === '.') j++;
    const prev = out[out.length - 1];
    const next = chars[j];
    // 前後都是漢字才算萬用字元；否則這是 skipword，整段丟掉
    if (isHan(prev) && isHan(next) && wild < MAX_WILDCARDS) {
      const n = Math.min(j - i, MAX_WILDCARDS - wild);
      for (let k = 0; k < n; k++) out.push('.');
      wild += n;
    }
    i = j - 1;
  }
  const s = out.join('');
  return { text: s, wild: s.includes('.') };
}

/**
 * 把輸入切成詞組。
 *
 * 純函式、不做 tokenizer（tokenizer 在 search.ts 用索引的同一套規則做），
 * 所以這裡只處理「詞組」這一層，回傳的字串原樣保留（含 Latin 大小寫）。
 */
export function parseQuery(text: string): ParsedQuery {
  const raw = text ?? '';
  const clauses: QueryClause[] = [];
  let buf = '';
  let role: ClauseRole | null = null;
  let near = false;
  let hasOperators = false;

  const flush = () => {
    const { text: t } = normalizeClause(buf.trim());
    buf = '';
    if (!t) { role = null; near = false; return; }
    clauses.push({ text: t, role: role ?? 'optional', nearPrev: near, nearOf: near && clauses.length ? clauses.length - 1 : -1 });
    role = null;
    near = false;
  };

  for (const ch of raw) {
    if (ch === ' ' || ch === '\t' || ch === '\u3000' || ch === '\n' || ch === '\r') { flush(); continue; }
    if (ch === '*') { flush(); near = true; hasOperators = true; continue; }
    if (ch === '+') { flush(); role = 'required'; hasOperators = true; continue; }
    if (ch === '-') { flush(); role = 'excluded'; hasOperators = true; continue; }
    buf += ch;
  }
  flush();
  return { raw, clauses, hasOperators, wildcard: clauses.some((c) => splitWildcard(c.text).wild) };
}

/** 顯示用的查詢摘要：「緣起 +性空 -無明」 */
export function formatQuery(q: ParsedQuery): string {
  return q.clauses
    .map((c) => (c.nearPrev ? '*' : '') + (c.role === 'required' ? '+' : c.role === 'excluded' ? '-' : '') + c.text)
    .join(' ');
}

/** 有正面詞組（required／optional）嗎？只有排除詞的查詢沒有結果可言。 */
export function positiveClauses(q: ParsedQuery): QueryClause[] {
  return q.clauses.filter((c) => c.role !== 'excluded');
}

/**
 * 詞組排序用的顏色索引：每個正面詞組一個色相（HSV），
 * 讓「不同的 keyword 塗紅」看得出差異（paint.ts 與摘要卡片共用）。
 */
export function clauseHue(index: number, total: number): number {
  if (total <= 1) return 0;                 // 只有一個詞組：用原本的紅色
  return Math.round((index * 300) / Math.max(1, total));   // 0..300 度，避開紅色重複
}

/**
 * 單字萬用字元 `.`：`菩.心` ＝ 菩 ＋ 任意一個 token ＋ 心（作者 2026-10）。
 *
 * 呼叫前應先 `normalizeClause()`（它會把「前後不是漢字」的 `.` 當 skipword 丟掉），
 * 所以這裡只要單純用 `.` 切開。真正的 token 化在 search.ts（用索引同一套 tokenizer）。
 */
export function splitWildcard(text: string): { parts: string[]; wild: boolean } {
  const parts = text.split('.');
  const wild = parts.length > 1 && parts.some((p) => p.length > 0);
  return { parts: wild ? parts : [text], wild };
}

/**
 * 名詞分頁（詞條名比對）用的樣式：`.` ＝ 任一個字元（作者 2026-10）。
 * 回傳 null 表示「沒有萬用字元」，呼叫端可以走原本的 `includes()`。
 *
 * `mode`（開頭／中間／結尾）會加上對應的錨點，讓萬用字元查詢也吃三態 toggle：
 *   start → `^body`、end → `body$`、mid／any → 不錨定。
 */
export function namePattern(text: string, mode: string = 'any'): RegExp | null {
  const { text: t } = normalizeClause(text);       // 前後的 `.` 沒有意義
  const { parts, wild } = splitWildcard(t);
  if (!wild) return null;
  const body = parts.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.');
  const anchored = mode === 'start' ? '^' + body : mode === 'end' ? body + '$' : body;
  return new RegExp(anchored);
}
