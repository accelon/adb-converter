/**
 * 編輯工作階段：每一頁的 old/new lines 先留在這裡，按「存檔」才一次重建 adb。
 *
 * key 用檔名＋大小＋mtime（file:// 的 File 沒有 path），所以同一份 adb 的所有
 * docTab 共用一份修訂；換庫、換分頁都不會丟。
 */
import type { AdbSource } from './adb';
import { getUserId } from './user-id';

export interface PageEdit {
  /** base 版本的行號（0-based，含頭尾） */
  first: number;
  last: number;
  /** base 版本的原文，合併與 diff 都以它為準 */
  oldLines: string[];
  /** 使用者改完的內容 */
  newLines: string[];
  /** 這頁屬於哪個 <檔>／節點（只給修訂頁顯示） */
  docName: string;
}

export interface DbEditSession {
  key: string;
  name: string;
  file: AdbSource;
  edits: Map<string, PageEdit>;
  /** 已產生過的修訂數（從 adb 的 revisions 容器讀到的 + 本次） */
  revisions: number;
  /** 測試／工具可指定；一般由 getUserId() 決定 */
  editor?: string;
}

const sessions = new Map<string, DbEditSession>();
const listeners = new Set<() => void>();

export function sourceKey(f: AdbSource): string {
  return (f.path ?? '') + '|' + f.name + '|' + f.size + '|' + f.lastModified;
}

export function sessionFor(file: AdbSource, name: string): DbEditSession {
  const key = sourceKey(file);
  let s = sessions.get(key);
  if (!s) {
    s = { key, name, file, edits: new Map(), revisions: 0 };
    sessions.set(key, s);
  } else {
    s.name = name;
    s.file = file;
  }
  return s;
}

export function findSession(key: string): DbEditSession | undefined {
  return sessions.get(key);
}

export function onEditsChange(fn: () => void): void {
  listeners.add(fn);
}
function notify(): void {
  for (const fn of listeners) fn();
}

export function pageKey(first: number, last: number): string {
  return first + ':' + last;
}

export function pageEditAt(s: DbEditSession | null | undefined, first: number, last: number): PageEdit | undefined {
  return s ? s.edits.get(pageKey(first, last)) : undefined;
}

export function pageEditFor(s: DbEditSession | null | undefined, first: number, last: number): PageEdit | undefined {
  return s ? s.edits.get(pageKey(first, last)) : undefined;
}

/**
 * Stage one page. Passing the original lines again (or lines that come back equal)
 * removes the edit, so 「取消本頁」 and undo-to-base both work.
 */
export function stagePage(
  s: DbEditSession,
  first: number,
  last: number,
  oldLines: string[],
  newLines: string[],
  docName: string,
): boolean {
  const key = pageKey(first, last);
  if (!s.editor) s.editor = getUserId();   // 記下開始編輯時的修訂者
  const existing = s.edits.get(key);
  const base = existing ? existing.oldLines : oldLines;
  if (sameLines(base, newLines)) {
    if (existing) { s.edits.delete(key); notify(); return true; }
    return false;
  }
  s.edits.set(key, { first, last, oldLines: base, newLines: newLines.slice(), docName });
  notify();
  return true;
}

export function discardPage(s: DbEditSession, first: number, last: number): void {
  if (s.edits.delete(pageKey(first, last))) notify();
}

export function discardAll(s: DbEditSession): void {
  if (!s.edits.size) return;
  s.edits.clear();
  notify();
}

export function editCount(s: DbEditSession | undefined): number {
  return s?.edits.size ?? 0;
}

export function hasEdits(s: DbEditSession | undefined): boolean {
  return !!s && s.edits.size > 0;
}

/** any staged edit whose base range touches [first,last] (docTab red) */
export function hasEditsInRange(s: DbEditSession | undefined, first: number, last: number): boolean {
  if (!s) return false;
  for (const e of s.edits.values()) {
    if (e.first <= last && e.last >= first) return true;
  }
  return false;
}

export function sortedEdits(s: DbEditSession): PageEdit[] {
  return [...s.edits.values()].sort((a, b) => b.first - a.first);
}

function sameLines(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Apply every page edit to the base lines. Edits are applied bottom-up so a page
 * that grows or shrinks never moves the base indices of the pages below it.
 */
export function applyEdits(base: readonly string[], edits: Iterable<PageEdit>): string[] {
  const out = base.slice();
  for (const e of [...edits].sort((a, b) => b.first - a.first)) {
    const got = out.slice(e.first, e.last + 1);
    if (!sameLines(got, e.oldLines)) {
      throw new Error('這一頁的原文已變動，請重新載入：行 ' + (e.first + 1) + '–' + (e.last + 1));
    }
    out.splice(e.first, e.last - e.first + 1, ...e.newLines);
  }
  return out;
}

export type ChangeKind = 'replace' | 'insert' | 'delete';

export interface LineChange {
  /** base 版本的行號（0-based；insert 用插入點） */
  line: number;
  kind: ChangeKind;
  /** replace 時：共同前綴長度與被換掉的字串 */
  at?: number;
  oldText?: string;
  newText?: string;
  oldLine?: string;
  newLine?: string;
}

export interface PageDiff {
  first: number;
  last: number;
  doc: string;
  oldLineCount: number;
  newLineCount: number;
  changes: LineChange[];
}

/** 一行裡真正不同的那一段（共同前綴／後綴外的部分）。 */
function charDiff(oldLine: string, newLine: string): { at: number; oldText: string; newText: string } {
  let p = 0;
  const max = Math.min(oldLine.length, newLine.length);
  while (p < max && oldLine[p] === newLine[p]) p++;
  let s = 0;
  while (s < max - p && oldLine[oldLine.length - 1 - s] === newLine[newLine.length - 1 - s]) s++;
  return {
    at: p,
    oldText: oldLine.slice(p, oldLine.length - s),
    newText: newLine.slice(p, newLine.length - s),
  };
}

/** 行級 LCS（頁面通常 200 行，DP 足夠）；超過 600 行就退回逐行比對。 */
function alignLines(oldLines: readonly string[], newLines: readonly string[]): Array<[number | -1, number | -1]> {
  const n = oldLines.length, m = newLines.length;
  if (n * m > 600 * 600) {
    const out: Array<[number | -1, number | -1]> = [];
    for (let i = 0; i < Math.max(n, m); i++) out.push([i < n ? i : -1, i < m ? i : -1]);
    return out;
  }
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: Array<[number | -1, number | -1]> = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) { out.push([i, j]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push([i, -1]); i++; }
    else { out.push([-1, j]); j++; }
  }
  while (i < n) out.push([i++, -1]);
  while (j < m) out.push([-1, j++]);
  return out;
}

export function diffPage(e: PageEdit): PageDiff {
  const changes: LineChange[] = [];
  const oldL = e.oldLines, newL = e.newLines;
  // trim equal head/tail first: a typo in the middle then becomes ONE replace
  let p = 0;
  while (p < Math.min(oldL.length, newL.length) && oldL[p] === newL[p]) p++;
  let s = 0;
  while (s < Math.min(oldL.length, newL.length) - p
    && oldL[oldL.length - 1 - s] === newL[newL.length - 1 - s]) s++;
  const oldMid = oldL.slice(p, oldL.length - s);
  const newMid = newL.slice(p, newL.length - s);
  const n = Math.max(oldMid.length, newMid.length);
  for (let i = 0; i < n; i++) {
    const line = e.first + p + i;
    if (i < oldMid.length && i < newMid.length) {
      const oldLine = oldMid[i], newLine = newMid[i];
      if (oldLine === newLine) continue;
      const d = charDiff(oldLine, newLine);
      changes.push({ line, kind: 'replace', at: d.at, oldText: d.oldText, newText: d.newText, oldLine, newLine });
    } else if (i < oldMid.length) {
      changes.push({ line, kind: 'delete', oldLine: oldMid[i] });
    } else {
      changes.push({ line, kind: 'insert', newLine: newMid[i] });
    }
  }
  return {
    first: e.first, last: e.last, doc: e.docName,
    oldLineCount: oldL.length, newLineCount: newL.length,
    changes,
  };
}

/**
 * Reverse one stored revision on the current (merged) lines. Pages are restored
 * bottom-up, using the recorded newLineCount as the length of the current page.
 */
export function revertRevision(current: readonly string[], rev: any): string[] {
  const out = current.slice();
  const pages = Array.isArray(rev?.pages) ? rev.pages.slice() : [];
  pages.sort((a: any, b: any) => Number(b.first) - Number(a.first));
  for (const p of pages) {
    if (!Array.isArray(p.oldLines)) throw new Error('revision 缺少 oldLines，無法回滾');
    const n = Number.isFinite(p.newLineCount) ? Number(p.newLineCount) : p.oldLines.length;
    out.splice(Number(p.first), n, ...p.oldLines);
  }
  return out;
}

export interface RevisionRecord {
  format: 'accelon26-revision/1';
  id: string;
  parent: string | null;
  createdAt: string;
  /** 修訂者 ID（About 頁設定；舊資料可能沒有） */
  editor?: string;
  /** 這一筆 revision 內容的 SHA-256（含 sha256: 前綴；舊資料可能沒有） */
  hash?: string;
  base: {
    name: string;
    size: number;
    lineCount: number;
    headerCrc: number;
  };
  pages: Array<PageDiff & { oldLines: string[]; newLines: string[] }>;
}

export function makeRevision(
  s: DbEditSession,
  base: { name: string; size: number; lineCount: number; headerCrc: number },
  id: string,
  parent: string | null,
): RevisionRecord {
  const pages = sortedEdits(s).reverse().map((e) => ({ ...diffPage(e), oldLines: e.oldLines, newLines: e.newLines }));
  return {
    format: 'accelon26-revision/1',
    id,
    parent,
    createdAt: new Date().toISOString(),
    editor: s.editor || getUserId(),
    base,
    pages,
  };
}