/**
 * 已存輸入（saved inputs）：使用者存下來的「位置」與「查詢詞」，下次不必重打。
 *
 *   localStorage: accelon26.savedInputs.v1
 *   {
 *     positions: Record<dbname, SavedItem[]>,   // 位置（屬於某庫）
 *     terms:     Record<dbname, SavedItem[]>,   // per adb 查詢詞
 *     global:    SavedItem[]                    // 全域查詢詞（跨庫共用）
 *   }
 *
 * 只存「文字」，不存 VA／座標：書籤存 va 是為了同庫精準定位；本功能目的是「免重打」，
 * 存字串最穩，跨版本、跨庫都不會壞。點下去貼回搜尋框，走既有的語法解析即可。
 *
 * 這個模組只做資料與持久化，不碰 UI（仿 bookmarks.ts 的儲存慣例）。
 */
export type Bucket = 'pos' | 'db' | 'global';

export interface SavedItem {
  id: string;
  text: string;
  label?: string;
  at: number;
}

interface SavedStore {
  positions: Record<string, SavedItem[]>;
  terms: Record<string, SavedItem[]>;
  global: SavedItem[];
}

const KEY = 'accelon26.savedInputs.v1';
/** 每一桶最多保留幾筆（最舊的先汰除）。 */
const CAP = 100;

function emptyStore(): SavedStore {
  return { positions: {}, terms: {}, global: [] };
}

function load(): SavedStore {
  let raw: string | null = null;
  try { raw = localStorage.getItem(KEY); } catch { return emptyStore(); }
  if (!raw) return emptyStore();
  try {
    const o = JSON.parse(raw) as Partial<SavedStore>;
    return {
      positions: o.positions && typeof o.positions === 'object' ? o.positions : {},
      terms: o.terms && typeof o.terms === 'object' ? o.terms : {},
      global: Array.isArray(o.global) ? o.global : [],
    };
  } catch { return emptyStore(); }
}

function save(s: SavedStore): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* 無痕模式／配額不足 */ }
}

function bucketOf(s: SavedStore, dbname: string, bucket: Bucket): SavedItem[] {
  if (bucket === 'global') return s.global;
  const map = bucket === 'pos' ? s.positions : s.terms;
  return map[dbname] ?? [];
}

function setBucket(s: SavedStore, dbname: string, bucket: Bucket, list: SavedItem[]): void {
  if (bucket === 'global') { s.global = list; return; }
  const map = bucket === 'pos' ? s.positions : s.terms;
  if (list.length) map[dbname] = list; else delete map[dbname];
}

function newId(): string {
  try {
    const c = (globalThis as { crypto?: Crypto }).crypto;
    if (c?.randomUUID) return c.randomUUID();
  } catch { /* 不支援就用時間＋隨機 */ }
  return 'si' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** 讀某一桶（回傳複本，呼叫端改不到內部狀態）。 */
export function list(dbname: string, bucket: Bucket): SavedItem[] {
  return bucketOf(load(), dbname, bucket).slice();
}

/** 新增（同 text 去重、時間後蓋），每桶上限 CAP。回傳新項目。 */
export function add(dbname: string, bucket: Bucket, text: string, label?: string): SavedItem {
  const t = text.trim();
  const s = load();
  const item: SavedItem = { id: newId(), text: t, at: Date.now() };
  if (label) item.label = label;
  const old = bucketOf(s, dbname, bucket).filter((x) => x.text !== t);
  const next = [item, ...old].slice(0, CAP);
  setBucket(s, dbname, bucket, next);
  save(s);
  return item;
}

export function remove(dbname: string, bucket: Bucket, id: string): void {
  const s = load();
  setBucket(s, dbname, bucket, bucketOf(s, dbname, bucket).filter((x) => x.id !== id));
  save(s);
}

/** 清空某一桶（bucket='global' 時 dbname 忽略）。 */
export function clear(dbname: string, bucket: Bucket): void {
  const s = load();
  setBucket(s, dbname, bucket, []);
  save(s);
}

/** 匯出全部（JSON 字串）。 */
export function exportAll(): string {
  return JSON.stringify(load(), null, 2);
}

/** 匯入並合併（以 text 去重；不覆蓋既有）。 */
export function importAll(json: string): void {
  let incoming: Partial<SavedStore>;
  try { incoming = JSON.parse(json) as Partial<SavedStore>; } catch { return; }
  const s = load();
  const merge = (cur: SavedItem[], addList: SavedItem[] | undefined): SavedItem[] => {
    const seen = new Set(cur.map((x) => x.text));
    const out = [...cur];
    for (const x of addList ?? []) {
      if (!x || typeof x.text !== 'string' || !x.text.trim()) continue;
      if (seen.has(x.text)) continue;
      seen.add(x.text);
      out.push({ id: x.id || newId(), text: x.text, label: x.label, at: x.at || Date.now() });
    }
    return out.slice(0, CAP);
  };
  for (const db of Object.keys(incoming.positions ?? {})) {
    s.positions[db] = merge(s.positions[db] ?? [], incoming.positions?.[db]);
  }
  for (const db of Object.keys(incoming.terms ?? {})) {
    s.terms[db] = merge(s.terms[db] ?? [], incoming.terms?.[db]);
  }
  s.global = merge(s.global, incoming.global);
  save(s);
}

/**
 * 這句話看起來像「位置」嗎？（給「位置」分頁判斷能不能存）
 * 只做保守比對：頁 id、字元級位置、行號、大正引用、頁行；其餘視為查詢詞。
 */
export function isPosition(text: string): boolean {
  const q = text.trim();
  if (!q) return false;
  if (/^(?:[\w.-]+\?)?[a-z]*\d+p[\da-z-]+$/i.test(q)) return true;   // 8p848c、yl38p107、y38p107
  if (/[\w?].*#[0-9]+(?:[-–—][0-9]+)?$/.test(q)) return true;        // taisho?5p2c#12-34
  if (/^#L\d+(?:@[\w.-]+)?$/i.test(q)) return true;                  // #L123@taisho
  if (/^\d{1,3}p\d{1,4}[a-c]?$/i.test(q)) return true;               // 18p14c（大正頁）
  if (/^T\d{1,3}n\d{3,4}/i.test(q)) return true;                     // T18n0890_p0014c
  if (/^[a-z]?\d+p\d+[a-z]\d*$/i.test(q)) return true;               // 頁行 y38p7a8
  return false;
}