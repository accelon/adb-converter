/**
 * 書目登錄（book catalog）— 打包進 accelon26 的小型 metadata。
 *
 * 它只回答「這本書是什麼、adb 叫什麼、有哪些別名」，不存正文、不存連結。
 * xref 的目標用 book_id；實際開書時由 adb 檔名／collection 決定。
 */
import raw from './book-catalog.json';
import type { BookCatalogEntry, WorkCatalogEntry } from './book-catalog-types';

const data = raw as { schema: number; books: BookCatalogEntry[]; works?: WorkCatalogEntry[] };

/** 全部書目（依 id 排序，generator 已排序）。 */
export const BOOK_CATALOG: readonly BookCatalogEntry[] = data.books;

/** 全部 work（書名身份，例如《易》→ yijing）。 */
export const WORK_CATALOG: readonly WorkCatalogEntry[] = data.works ?? [];

/** 去掉書名常見標點、空白與大小寫差異；只給比對用，不改顯示。 */
export function normalizeBookName(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/[《》〈〉「」『』【】〔〕()（）\[\]…·、，,。．.\s]/g, '')
    .toLowerCase();
}

const byId = new Map(BOOK_CATALOG.map((b) => [b.id, b]));
const byAlias = new Map<string, BookCatalogEntry[]>();
for (const b of BOOK_CATALOG) {
  const keys = new Set([b.id, b.adb.replace(/\.adb$/i, ''), ...b.aliases].map(normalizeBookName));
  for (const k of keys) {
    if (!k) continue;
    const list = byAlias.get(k);
    if (list) list.push(b);
    else byAlias.set(k, [b]);
  }
}

const byWorkId = new Map(WORK_CATALOG.map((w) => [w.id, w]));
const byWorkAlias = new Map<string, WorkCatalogEntry[]>();
for (const w of WORK_CATALOG) {
  const keys = new Set([w.id, w.title, ...w.aliases].map(normalizeBookName));
  for (const k of keys) {
    if (!k) continue;
    const list = byWorkAlias.get(k);
    if (list) list.push(w);
    else byWorkAlias.set(k, [w]);
  }
}

export function bookById(id: string): BookCatalogEntry | null {
  return byId.get(id) ?? byId.get(id.replace(/\.adb$/i, '')) ?? null;
}

/** 找出所有符合的書；同一書名可能對應不同版本，所以回傳陣列。 */
export function findBooks(query: string): BookCatalogEntry[] {
  const q = normalizeBookName(query);
  if (!q) return [];
  const exactId = byId.get(query) ?? byId.get(query.replace(/\.adb$/i, ''));
  if (exactId) return [exactId];
  return [...(byAlias.get(q) ?? [])];
}

/** 只有唯一命中才回傳；書名有版本歧義時回 null，交由呼叫端處理。 */
export function resolveBook(query: string): BookCatalogEntry | null {
  const hits = findBooks(query);
  return hits.length === 1 ? hits[0] : null;
}

export function bookTitle(id: string): string {
  return bookById(id)?.title ?? id;
}

export function workById(id: string): WorkCatalogEntry | null {
  return byWorkId.get(id) ?? null;
}

/** 用書名／別名找 work；《易》《周易》《易經》都會回到 yijing。 */
export function findWorks(query: string): WorkCatalogEntry[] {
  const q = normalizeBookName(query);
  if (!q) return [];
  const exact = byWorkId.get(query);
  if (exact) return [exact];
  return [...(byWorkAlias.get(q) ?? [])];
}

/** 只有唯一命中才回 work；同名／多版本時回 null。 */
export function resolveWork(query: string): WorkCatalogEntry | null {
  const hits = findWorks(query);
  return hits.length === 1 ? hits[0] : null;
}

/** 這個 adb 目前承載哪些 work（例：13j → 易、尚書、詩經…）。 */
export function worksOfBook(adbId: string): WorkCatalogEntry[] {
  return WORK_CATALOG.filter((w) => w.editions.some((e) => e.adb === adbId));
}

export function catalogCount(): number {
  return BOOK_CATALOG.length;
}

export function workCount(): number {
  return WORK_CATALOG.length;
}
