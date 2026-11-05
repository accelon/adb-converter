/**
 * 表格區塊：把正文裡的兩種表格寫法解析成同一份資料。
 *
 *   1. **管線表**（新語法，建議）：
 *        <表>
 *        表1　三種譯法
 *        項目 | 梵語 | 次數
 *        :--- | :---: | ---:
 *        涅槃 | nirvāṇa | 12
 *        </表>
 *
 *   2. **框線字藝術**（既有語料，例如 taixu 的 `<圖文字>`）：
 *        ┌──────┬──────┐
 *        │ 華文 │ 梵文 │
 *        ├──────┼──────┤
 *        │ 小學 │ 古梵文 │
 *        └──────┴──────┘
 *
 * 兩者都只做「結構解析」，不做語意推斷。**寧可拒絕，不要出半張表**：
 * 解析失敗就交回 null，呼叫端退回原本的顯示（純文字／等寬）。
 *
 * 為什麼框線表不看字元位置：OCR 出來的藝術表，框線與內容的顯示寬度經常不一致
 * （taixu L112039 的 ┌──┐ 只有內容的一半寬），可靠資訊只有「每列有幾個 │」。
 * 代價是「視覺列 ≠ 邏輯列」——原圖裡換行的同一個儲存格，這裡會拆成兩列。
 */

/** 一列：`cells` 是已正規化的格；`page` 有值時表示這一列其實是原書頁碼（整列合併） */
export interface TableRow {
  cells: string[];
  page?: string;
  /** 這一行在輸入陣列裡的索引（呼叫端據此對回絕對行號） */
  at: number;
}

export interface TableData {
  cols: number;
  header: { cells: string[]; at: number } | null;
  rows: TableRow[];
  /** `<表>` 區塊裡第一行不含管線的文字＝表說明 */
  caption?: { text: string; at: number };
}

/* ------------------------------------------------------------------ *
 * 格內文字
 * ------------------------------------------------------------------ */

/** 藝術表用空白撐排，那不是內容：全形空白與連續空白收成一個，漢字之間的空格去掉 */
export function cleanCell(raw: string): string {
  let s = raw.replace(/[\s\u3000]+/g, ' ').trim();
  s = s.replace(/(?<=[\u3400-\u9fff\u3040-\u30ff\u3005])\s+(?=[\u3400-\u9fff\u3040-\u30ff\u3005])/g, '');
  return s;
}

/* ------------------------------------------------------------------ *
 * 管線表
 * ------------------------------------------------------------------ */

/** 把一行切成格：`|` 只在標籤外、實體外才算分隔；`\|` 是字面的管線 */
export function splitPipeRow(line: string): string[] {
  const out: string[] = [];
  let cell = '';
  let i = 0;
  const s = line;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\' && s[i + 1] === '|') { cell += '|'; i += 2; continue; }
    if (ch === '<') {
      // 標籤整段照抄（屬性裡可能有 |）
      const gt = s.indexOf('>', i + 1);
      if (gt > i) { cell += s.slice(i, gt + 1); i = gt + 1; continue; }
    }
    if (ch === '&') {
      const semi = s.indexOf(';', i + 1);
      if (semi > i && !s.slice(i + 1, semi).includes('|')) { cell += s.slice(i, semi + 1); i = semi + 1; continue; }
    }
    if (ch === '|') { out.push(cell); cell = ''; i++; continue; }
    cell += ch;
    i++;
  }
  out.push(cell);
  // 首尾的管線只是框，不產生空格
  const t = s.trim();
  if (t.startsWith('|') && out.length && out[0].trim() === '') out.shift();
  if (t.endsWith('|') && out.length && out[out.length - 1].trim() === '') out.pop();
  return out.map((c) => c.trim());
}

/** `---`、`:---:`、`---:` 這一類對齊列（至少一個 -，只能有 | : - 空白） */
export function isPipeAlignRow(line: string): boolean {
  const t = line.trim();
  if (!t.includes('-')) return false;
  if (!/^[|:\-\s]+$/.test(t)) return false;
  return /-{2,}/.test(t);
}

/** 對齊列 → 每欄的對齊（給之後的 CSS 用；目前只記錄，不強制） */
export function pipeAligns(line: string, cols: number): ('l' | 'c' | 'r')[] {
  const cells = splitPipeRow(line);
  const out: ('l' | 'c' | 'r')[] = [];
  for (let i = 0; i < cols; i++) {
    const c = (cells[i] ?? '').trim();
    const l = c.startsWith(':');
    const r = c.endsWith(':');
    out.push(l && r ? 'c' : r ? 'r' : 'l');
  }
  return out;
}

/** 只有頁碼標籤的一行（`<頁 id="17p135"/>`） */
function pageOf(line: string): string | null {
  const t = line.trim();
  const m = /^<頁(?=[\s/>])[^>]*\/>$/.exec(t) ?? /^<頁(?=[\s>])[^>]*>([\s\S]*)<\/頁>$/.exec(t);
  if (!m) return null;
  const id = /\b(?:id|n)\s*=\s*"([^"]*)"/.exec(t)?.[1] ?? '';
  return id || '頁';
}

/** 表說明：只收掉多餘的空格，全形空白保留（「表1　三種譯法」不要被黏成「表1 三種」） */
export function cleanCaption(raw: string): string {
  return raw.replace(/[ \t]+/g, ' ').trim();
}

function parsePipe(lines: string[]): TableData | null {
  const rows: TableRow[] = [];
  let header: TableData['header'] = null;
  let caption: TableData['caption'];
  let cols = 0;

  // 表頭分隔列只對「它上面那一列」有意義，而且要嘛在第一列之後、要嘛在說明之後
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    const page = pageOf(t);
    if (page) { rows.push({ cells: [], page, at: i }); continue; }
    const cells = splitPipeRow(t);
    const hasPipe = t.includes('|');
    if (!hasPipe) {
      // 表格開始前的一行純文字＝表說明；已經有列了就不是表格
      if (!rows.length && !header && !caption) { caption = { text: cleanCaption(t), at: i }; continue; }
      return null;
    }
    if (isPipeAlignRow(t)) {
      if (rows.length && !header) {
        const first = rows.pop()!;
        header = { cells: first.cells, at: first.at };
      }
      continue;
    }
    if (cells.length < 2) return null;
    if (!cols) cols = cells.length;
    else if (cells.length !== cols) return null;
    rows.push({ cells: cells.map(cleanCell), at: i });
  }
  if (!cols || rows.length < 1) return null;
  if (rows.filter((r) => !r.page).length < 2 && !header) return null;
  return { cols, header, rows, caption };
}

/* ------------------------------------------------------------------ *
 * 框線字藝術
 * ------------------------------------------------------------------ */

const TOP = /^┌[─┬]+┐$/;
const MID = /^├[─┼]+┤$/;
const BOT = /^└[─┴]+┘$/;
const count = (s: string, ch: string) => s.split(ch).length - 1;

function parseBox(lines: string[]): TableData | null {
  const start = lines.findIndex((l) => TOP.test(l.trim()));
  if (start < 0) return null;
  const cols = count(lines[start].trim(), '┬') + 1;
  if (cols < 2) return null;

  let header: TableData['header'] = null;
  const rows: TableRow[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    if (BOT.test(t)) {
      if (count(t, '┴') + 1 !== cols) return null;
      if (rows.filter((r) => !r.page).length < 1) return null;
      return { cols, header, rows };
    }
    if (MID.test(t)) {
      if (count(t, '┼') + 1 !== cols) return null;
      if (!header && rows.length === 1) {
        const first = rows.pop()!;
        header = { cells: first.cells, at: first.at };
      }
      continue;
    }
    if (TOP.test(t)) return null;
    const page = pageOf(t);
    if (page) { rows.push({ cells: [], page, at: i }); continue; }
    // 內容列：以 │ 開頭結尾，中間可以有更多 │
    if (!t.startsWith('│') || !t.endsWith('│') || t.length < 2) return null;
    const cells = t.slice(1, -1).split('│');
    if (cells.length !== cols) return null;
    rows.push({ cells: cells.map(cleanCell), at: i });
  }
  return null; // 找不到底框
}

/* ------------------------------------------------------------------ *
 * 入口
 * ------------------------------------------------------------------ */

/** 解析一個區塊的內文行；兩種寫法都試，都不成立就回 null */
export function parseTableBlock(lines: string[]): TableData | null {
  const pipe = parsePipe(lines);
  if (pipe && pipe.rows.some((r) => !r.page)) return pipe;
  return parseBox(lines);
}
