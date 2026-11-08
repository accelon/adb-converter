/**
 * Several .adb files open at once (max MAX_DBS).
 *
 * Every database is a SLOT holding one snapshot per module (the snapshot/restore
 * pairs each module exports). Switching a slot saves the state of the database being left and restores the
 * target; closing a slot drops it — its document tabs live inside the slot, so
 * "close the database" also closes every 本文分頁 that used it.
 *
 * The header shows one chip per open database (#dbTabs, always in insertion order) and a
 * 📁 picker (#dbPickBtn) to its left whose FIRST item is 「加入 adb」 (file:// only; the
 * desktop build lists the working folder at startup). Click a chip to switch to
 * it; the ACTIVE chip carries the ✕ that closes it (and every tab that used it).
 */
import { $, escapeHtml, fmtBytes, fmtInt, openFile, restoreCore, snapshotCore } from './viewer';
import { AdbReader, BlobIO, type AdbSource, type DocRow } from './adb';
import type { VaPaMapper } from './vapa';
import type { SearchSession } from './search';
import { setActiveDocDbId, setDocCtxResolver, type DocCtx } from './doc-ctx';
import { activateTabById, activateTabForDb, activeTabId, closeTabsForDb, dropPageImages, restoreDocPane, setDocActive, setDocTabsChangedHook, sharedDocTabsOn, showEmptyDoc, snapshotDocPane, tabCountOfDb } from './doc-pane';
import { restorePanes, snapshotPanes } from './panes';
import { restoreScopes, snapshotScopes } from './scopes';
import { restoreSummary, snapshotSummary } from './summary';
import { restoreLink, snapshotLink } from './link';
import { restoreTextPane, snapshotTextPane } from './text-pane';
import { SHORT_DB_NAMES } from './short-titles';
import { backendKind } from './backend';
import { desktopSources, hostState } from './host';
import { discardAll, editCount, findSession, hasEdits, onEditsChange, sourceKey } from './edit-session';

export const MAX_DBS = 5;

// ---------------------------------------------------------------- 晶片短名（2026-10-30）
/**
 * `dbChip` 顯示短名；下拉清單的 `.dbPickName` 仍是完整庫名。
 *
 * 短名的來源依序：adb 檔頭的 `<集 b="印順">…</集>` → 下面寫死的缺省 → 庫名。
 * 現在先寫死（taisho 沒有 集.b 就是「大正」）；下次 rebuild 把 `b=` 放進 集 標籤，
 * 這裡就會自動改用檔頭的值，不必再改程式。
 */

const shortFromHead = new Map<string, string>();
const shortAsked = new Set<string>();
const dbBase = (n: string): string => n.replace(/\.adb$/i, '').toLowerCase();

function slotKey(d: DbSlot): string {
  const r = (d.core as { reader?: AdbReader } | undefined)?.reader;
  return (r?.header.dbname || dbBase(d.file.name)).toLowerCase();
}

/** 某個 dbname 的短名（給標籤用；沒有就回空字串）。 */
export function dbShortName(dbname: string): string {
  const k = (dbname || '').toLowerCase();
  return (k ? shortFromHead.get(k) ?? SHORT_DB_NAMES[k] : '') ?? '';
}

/** 晶片上的名字（同步；檔頭的 集.b 讀到後會蓋過去）。 */
function chipName(d: DbSlot): string {
  const r = (d.core as { reader?: AdbReader } | undefined)?.reader;
  // dbname 與檔名都試（有的庫 dbname 不是檔名，例如 ys.adb）
  const keys = [r?.header.dbname ?? '', dbBase(d.file.name)]
    .map((s) => s.toLowerCase()).filter(Boolean);
  for (const k of keys) {
    const s = shortFromHead.get(k) ?? SHORT_DB_NAMES[k];
    if (s) return s;
  }
  return d.name;
}

/** 讀每個庫檔頭的 `<集 … b="短名" …>`；讀到就重畫一次晶片列。 */
function collectShortNames(): void {
  for (const d of openDbs) {
    const key = slotKey(d);
    if (shortAsked.has(key)) continue;
    const r = (d.core as { reader?: AdbReader } | undefined)?.reader;
    if (!r) continue;                 // reader 還沒好，下次再問
    shortAsked.add(key);
    void (async () => {
      let b = '';
      try {
        const head = await r.sourceText(0);
        for (const m of head.matchAll(/<集(?:\s[^>]*)?>/g)) {
          const a = /\sb\s*=\s*"([^"]*)"/.exec(m[0]);
          if (a?.[1]?.trim()) { b = a[1].trim(); break; }
        }
      } catch { /* 讀不到就用缺省 */ }
      if (b && shortFromHead.get(key) !== b) {
        shortFromHead.set(key, b);
        renderDbTabs();
      }
    })();
  }
}

export interface DbSlot {
  id: number;
  name: string;
  file: AdbSource;
  /** MRU stamp: the largest is the most recently used (eviction takes the smallest) */
  usedAt: number;
  /** 這個庫最後看的本文分頁 id（shared 模式下切庫時要回到那一個） */
  docTabId?: number;
  core: unknown; docPane: unknown; scopes: unknown; summary: unknown; link: unknown; panes: unknown; text: unknown;
}

/** `core` 快照的形狀（viewer.snapshotCore）；只有 ctx 解析會用到這幾欄 */
interface CoreSnap {
  reader?: AdbReader | null;
  mapper?: VaPaMapper | null;
  session?: SearchSession | null;
  docs?: DocRow[];
  currentFile?: string;
  currentSource?: AdbSource | null;
}

/**
 * One .adb the reader has picked (or dropped) in this session. Only its HEADER is
 * read — the dropdown lists databases that are not loaded yet.
 */
export interface CatalogEntry {
  key: string;          // file identity: name + size + mtime
  file: AdbSource;
  name: string;         // 庫名 from the header
  /** adb id＝檔頭 dbname（`13j`、`ys`）；選單的預設排序鍵（作者 2026-11-01） */
  dbname?: string;
  usedAt: number;
}

export const openDbs: DbSlot[] = [];
/** every database this session has offered (see CatalogEntry) */
export const catalog: CatalogEntry[] = [];
const fileKey = (f: AdbSource): string => f.name + ':' + f.size + ':' + f.lastModified;

/**
 * 這個環境認得的「庫名」有哪些（頁行引用 `y38p7a8` 要靠它分辨前綴；作者 2026-11-01）。
 *
 * 來源：已開啟的庫（檔頭 dbname ＋ 檔名）與 catalog（dbname ＋ 檔名）。
 * 目前 active 的庫排最前面，同分時優先它。
 */
export function dbNameCandidates(): string[] {
  const out: string[] = [];
  const put = (n: string): void => {
    const v = (n ?? '').toLowerCase();
    if (v && !out.includes(v)) out.push(v);
  };
  const dbOf = (d: { core?: unknown }): string =>
    ((d.core as { reader?: { header?: { dbname?: string } } } | undefined)?.reader?.header?.dbname ?? '');
  const base = (n: string): string => n.replace(/\.adb$/i, '');
  const active = activeSlot();
  if (active) { put(dbOf(active)); put(base(active.file.name)); }
  for (const d of openDbs) { put(dbOf(d)); put(base(d.file.name)); }
  for (const e of catalog) { put(e.dbname ?? ''); put(base(e.file.name)); }
  return out;
}
let useSeq = 0;
/** diagnostics: what each save/restore saw (state().dbLog) */
export const dbLog: string[] = [];
let activeId = 0;
let seq = 0;
/** which slot's state is currently in the globals (0 = none) */
let loadedId = 0;

type Hooks = { refresh: () => void; clear: () => void };
let hooks: Hooks = { refresh: () => {}, clear: () => {} };
/** ui.ts registers what "redraw everything" and "no database left" mean */
export function setDbHooks(h: Hooks): void { hooks = h; }

export const activeSlot = (): DbSlot | null => openDbs.find((d) => d.id === activeId) ?? null;
export const loadedSlot = (): DbSlot | null => openDbs.find((d) => d.id === loadedId) ?? null;

/**
 * 由 slot 的 core 快照組出 `DocCtx`（作者 2026-11-01）。
 *
 * 本文分頁的 ctx 只存參考，不能序列化；快照裡每個分頁只帶 `dbId`，還原時
 * 用這個函式從還開著的 slot 重新解析（見 `doc-pane.restoreDocPane`）。
 * 這裡只讀 `slot.core`（不用全域），所以「正在載入別庫」的途中呼叫也正確。
 */
function ctxOfSlot(id: number): DocCtx | null {
  const slot = openDbs.find((d) => d.id === id);
  const core = slot?.core as CoreSnap | null | undefined;
  if (!slot || !core?.reader || !core.mapper) return null;
  return {
    dbId: slot.id,
    reader: core.reader,
    mapper: core.mapper,
    session: core.session ?? null,
    docs: core.docs ?? [],
    dbName: core.reader.header.dbname ?? slot.name,
    dbCName: core.reader.header.dbcname ?? '',
    file: core.currentSource ?? slot.file,
    fileName: core.currentFile || slot.file.name,
  };
}

setDocCtxResolver(ctxOfSlot);
// 本文分頁屬於哪幾庫變了 → dbChip 的 owner 標記要跟著更新（作者 2026-11-01）
setDocTabsChangedHook(() => { try { renderDbTabs(); } catch { /* boot 期間還沒有 #dbTabs */ } });

/**
 * Snapshot the database the globals currently belong to, if any.
 *
 * The picker fires `change` twice for one file, so openFile can run again after the
 * first run already reset the globals: saving then would overwrite a GOOD snapshot
 * (a database with a document tab open) with the empty state of the next load.
 * `loadedId` tells us whether the globals still are that database's.
 */
/**
 * After saveLoaded() the globals are no longer any slot's: between the save and the
 * new slot's registration they are being reset, and a second (duplicate) open must
 * not snapshot that half-cleared state over a good one.
 */
export function detachLoaded(): void { loadedId = 0; }

export function saveLoaded(): void {
  const cur = loadedSlot();
  if (cur) saveInto(cur);
}

/** the same file, already open (name + size + mtime): switch to it instead of reloading */
export function alreadyOpen(file: AdbSource, name: string): DbSlot | null {
  return openDbs.find((d) => d.name === name && d.file.name === file.name
    && d.file.size === file.size && d.file.lastModified === file.lastModified) ?? null;
}

/** copy every module's current state into the slot */
export function saveInto(slot: DbSlot): void {
  dbLog.push('save ' + slot.name + ' tabs=' + ((snapshotDocPane() as any).docTabs?.length ?? -1));
  if (dbLog.length > 40) dbLog.shift();
  slot.core = snapshotCore();
  slot.docTabId = activeTabId();          // 切回來時選回這一個分頁（shared 模式）
  slot.docPane = snapshotDocPane();
  slot.scopes = snapshotScopes();
  slot.summary = snapshotSummary();
  slot.link = snapshotLink();
  slot.panes = snapshotPanes();
  slot.text = snapshotTextPane();   // 右欄「文字內容」分頁也屬於這個庫
}
function loadFrom(slot: DbSlot): void {
  dbLog.push('load ' + slot.name + ' tabs=' + ((slot.docPane as any)?.docTabs?.length ?? -1));
  if (dbLog.length > 40) dbLog.shift();
  restoreCore(slot.core);
  if (!sharedDocTabsOn()) restoreDocPane(slot.docPane);
  restoreScopes(slot.scopes);
  restoreSummary(slot.summary);
  restoreLink(slot.link);
  restorePanes(slot.panes);
  restoreTextPane(slot.text);
  activeId = slot.id;
  loadedId = slot.id;
  // 「左欄那一庫」換人了：本文分頁的 ctx 判斷（麵包屑／目錄游標／反鏈）靠這個
  setActiveDocDbId(slot.id);
}

/** the loaded slot of a catalog entry, if it is loaded */
export const slotOf = (e: CatalogEntry): DbSlot | null =>
  openDbs.find((s) => fileKey(s.file) === e.key && s.name === e.name) ?? null;

/**
 * remember a picked file (the caller already peeked its header for the name)
 *
 * `dbname`／`dbcname` 是 adb 檔頭的 id 與中文名（作者 2026-11-01：選單要按
 * 「adb id」排序，而且要顯示 id）；呼叫端有讀到檔頭就傳進來，沒有的話用
 * `AdbSource` 上帶的（桌面宿主會給）。
 */
export function catalogAdd(file: AdbSource, name: string, dbname?: string): CatalogEntry {
  const key = fileKey(file);
  const hit = catalog.find((e) => e.key === key && e.name === name);
  if (hit) {
    if (!hit.dbname && (dbname || file.dbname)) hit.dbname = dbname || file.dbname;
    return hit;
  }
  const e: CatalogEntry = { key, file, name, dbname: dbname || file.dbname, usedAt: ++useSeq };
  catalog.push(e);
  renderDbPick();
  return e;
}

/**
 * Header peek (a few KiB) so the dropdown can name a file that is NOT loaded yet —
 * this is what "只讀 header 就好" means. A file that is not an .adb keeps its name so
 * the reader can see what failed.
 */
export async function catalogAddFile(file: AdbSource): Promise<CatalogEntry> {
  const key = fileKey(file);
  const hit = catalog.find((e) => e.key === key);
  if (hit) return hit;
  let name = file.name;
  let dbname = file.dbname;
  try {
    const probe = await AdbReader.open(new BlobIO(file));
    dbname = probe.header.dbname || dbname;
    name = probe.header.dbcname || probe.header.dbname || file.name;
  } catch { /* keep the file name */ }
  return catalogAdd(file, name, dbname);
}

/**
 * The picker at the top right（作者 2026-10）：`#dbPickBtn`（黃色資料夾）按一下才展開
 * `#dbPickMenu`，列出這次工作階段見過的每一個 adb（已載入的在前、最近用過的在前），
 * 目前這一個標成 `.active`。選一個就 `openCatalogEntry()`（切換或載入）。
 */
let pickOpen = false;

/** 選單現在開著嗎（診斷／測試用） */
export function dbPickOpen(): boolean { return pickOpen; }

/** 開／關選單；`force` 省略＝切換。`focus`＝用鍵盤開的，聚焦第一項（Alt+O）。 */
export function setDbPickOpen(force?: boolean, focus = false): void {
  pickOpen = force ?? !pickOpen;
  renderDbPick();
  if (pickOpen && focus) requestAnimationFrame(() => focusPickItem(0));
}

/** 把焦點移到清單第 i 項（方向鍵／Alt+O 用）。 */
export function focusPickItem(i = 0): void {
  const items = [...document.querySelectorAll<HTMLElement>('#dbPickMenu .dbPickItem')];
  if (!items.length) return;
  items[Math.max(0, Math.min(items.length - 1, i))]?.focus();
}

/** 目前 active 的那個 catalog key（`state().dbPick` 用） */
export function activeCatalogKey(): string {
  const s = activeSlot();
  if (!s) return '';
  return catalog.find((x) => slotOf(x) === s)?.key ?? '';
}

// ---- adb 選單的「字數」（作者 2026-10）----------------------------------------
// 精確字數要把 source 容器每一塊 bzip2 解壓再數 code unit —— jc 有 15,838 塊，
// 太費時（作者 2026-10：「dblist 使用 max VA 顯示字數，不要抓本文去算字數」）。
// 所以改用 adb 檔頭 offset 96 的 **max VA**（最大的文字位置）：只讀 4 個位元組，
// 跟精確值差 1–7%，選單只要「大概多大」就夠了。
// 只有選單打開時才排隊，一次算一個，算好直接把那一格填上（不重畫整個選單）。
const charCache = new Map<string, number>();
const charQueue: CatalogEntry[] = [];
let charBusy = false;

function queueChars(e: CatalogEntry): void {
  if (charCache.has(e.key) || charQueue.some((q) => q.key === e.key)) return;
  charQueue.push(e);
  if (!charBusy) void drainChars();
}

async function drainChars(): Promise<void> {
  charBusy = true;
  try {
    while (charQueue.length) {
      const e = charQueue.shift()!;
      if (charCache.has(e.key)) continue;
      const n = await maxVaOf(e.file);
      if (n !== null && n > 0) {
        charCache.set(e.key, n);
        paintChars(e.key);
      }
    }
  } finally {
    charBusy = false;
  }
}

/**
 * 「字數」＝ adb 檔頭 offset 96 的 max VA（i32，最大的文字位置）。
 * 只讀檔頭 256 位元組，比解壓整本快上幾個數量級（作者 2026-10）。
 */
async function maxVaOf(file: AdbSource): Promise<number | null> {
  try {
    const hdr = new Uint8Array(await file.slice(0, 256).arrayBuffer());
    if (hdr.length < 100) return null;
    const n = new DataView(hdr.buffer, hdr.byteOffset, hdr.byteLength).getInt32(96, true);
    return n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** 只改那一格的字（選單不重畫，捲動位置才不會跳掉）。 */
function paintChars(key: string): void {
  const n = charCache.get(key);
  if (n === undefined) return;
  const cell = document.querySelector<HTMLElement>(`#dbPickMenu .dbPickChars[data-key="${CSS.escape(key)}"]`);
  if (cell) cell.textContent = fmtInt(n);
}

/** 檔案時間 → 2026-10-18（建置日期；選單只有日期，時分不重要）。 */
function fmtDate(ms: number): string {
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return '—';
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/** 檔案時間 → 2026-10-29 19:24（hover 的版本資訊要含時分）。 */
function fmtDateTime(ms: number): string {
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return '—';
  return fmtDate(ms) + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

/* ---- 選單排序（作者 2026-11-01） -----------------------------------------------
 *
 * 使用者可以按「adb id」「檔名」「建置日期」「大小」升冪／降冪排；**預設 adb id、
 * 字母序**（A→Z）。點同一個表頭再點一次就反向；換一個表頭時，id／檔名從升冪開始，
 * 日期／大小從降冪開始（新／大的在前，這是大家看這種表時的直覺）。
 * 選擇存 localStorage（`accelon26.dbPickSort`），下次打開還一樣。
 */
export type DbPickSortKey = 'id' | 'file' | 'chars' | 'size' | 'date';

interface DbPickSort { k: DbPickSortKey; d: 1 | -1 }

const DBPICK_SORT_KEY = 'accelon26.dbPickSort';
const SORT_KEYS: DbPickSortKey[] = ['id', 'file', 'chars', 'size', 'date'];

function readDbPickSort(): DbPickSort {
  try {
    const raw = localStorage.getItem(DBPICK_SORT_KEY);
    if (!raw) return { k: 'id', d: 1 };
    const o = JSON.parse(raw) as { k?: string; d?: number };
    const k = SORT_KEYS.includes(o?.k as DbPickSortKey) ? o!.k as DbPickSortKey : 'id';
    return { k, d: o?.d === -1 ? -1 : 1 };
  } catch {
    return { k: 'id', d: 1 };
  }
}

let dbPickSort: DbPickSort = { k: 'id', d: 1 };
let dbPickSortLoaded = false;

function sortOf(): DbPickSort {
  if (!dbPickSortLoaded) { dbPickSort = readDbPickSort(); dbPickSortLoaded = true; }
  return dbPickSort;
}

/** 目前選單的排序（診斷／測試用） */
export function dbPickSortState(): { k: DbPickSortKey; d: 1 | -1 } { return { ...sortOf() }; }

/** 改排序並重畫（表頭點擊用；同一個鍵再點＝反向） */
export function setDbPickSort(k: DbPickSortKey, dir?: 1 | -1): void {
  const cur = sortOf();
  const d: 1 | -1 = dir ?? (cur.k === k ? (cur.d === 1 ? -1 : 1) : (k === 'date' || k === 'size' ? -1 : 1));
  dbPickSort = { k, d };
  dbPickSortLoaded = true;
  try { localStorage.setItem(DBPICK_SORT_KEY, JSON.stringify(dbPickSort)); } catch { /* 私密模式 */ }
  renderDbPick();
}

/** 檔名（桌面版 path 的 basename；網頁版就是 File.name） */
function fileNameOf(e: CatalogEntry): string {
  const f = e.file.path ? (e.file.path.split(/[\\/]/).pop() ?? e.file.name) : e.file.name;
  return f;
}

const numOr = (v: number | undefined, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/** 排序用的比較函式；同值時用 adb id／檔名當次序，才不會每次重畫順序都不同。 */
function compareCatalog(a: CatalogEntry, b: CatalogEntry, s: DbPickSort): number {
  const by = (x: number, y: number): number => (x === y ? 0 : x < y ? -1 : 1) * s.d;
  let r = 0;
  switch (s.k) {
    case 'file':
      r = by(fileNameOf(a).localeCompare(fileNameOf(b), 'en', { numeric: true, sensitivity: 'base' }), 0);
      break;
    case 'chars':
      r = by(numOr(charCache.get(a.key), -1), numOr(charCache.get(b.key), -1));
      break;
    case 'size':
      r = by(a.file.size, b.file.size);
      break;
    case 'date':
      r = by(a.file.lastModified, b.file.lastModified);
      break;
    default: {   // id
      const ai = (a.dbname || '').toLowerCase();
      const bi = (b.dbname || '').toLowerCase();
      r = by(ai === bi ? 0 : ai < bi ? -1 : 1, 0);
      break;
    }
  }
  if (r !== 0) return r;
  // 次序固定：adb id → 檔名（不管主排序是升還是降，這裡一律升冪）
  const ai = (a.dbname || '').toLowerCase();
  const bi = (b.dbname || '').toLowerCase();
  if (ai !== bi) return ai < bi ? -1 : 1;
  return fileNameOf(a).localeCompare(fileNameOf(b), 'en', { numeric: true, sensitivity: 'base' });
}

export function renderDbPick(): void {
  const menu = $('#dbPickMenu');
  const btn = $('#dbPickBtn');
  const active = activeSlot();
  const sort = sortOf();
  const shown = [...catalog].sort((a, b) => compareCatalog(a, b, sort));
  // 同一個庫名可能有兩個檔案（13j.adb 與 1839.adb 都叫十三經）：表格第一欄就是檔名，
  // 不必再在標籤後面接檔名（作者 2026-10-18 改成表格）。
  if (menu) {
    // 第一項「加入 adb」＝原本 header 的 ＋（作者 2026-10）。只有 file:// 版需要：
    // 桌面版（Wails）啟動時就把工作目錄裡的 adb 全列出來了。
    const addItem = needsAddItem()
      ? '<tr class="dbPickItem dbPickAdd" data-add="1" tabindex="0" title="開啟 .adb（最多同時 5 個）"><td colspan="6">＋ 加入 adb</td></tr>'
      : '';
    // 「取得更多 ADB」（作者 2026-10-29）：桌面版直接從官網公開資料庫下載；
    // 一般使用者就看得到，不必先開瀏覽器。離線時變暗但**不隱藏**。
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    const storeRow = hostState().available
      ? `<tr class="dbPickItem dbPickAdd" data-store="1" tabindex="0"${offline ? ' aria-disabled="true"' : ''}`
        + ` title="${offline ? '目前離線；連上網路後才能取得更多 ADB' : '從官網公開資料庫下載更多 .adb'}"><td colspan="6">⬇ 取得更多 ADB</td></tr>`
      : '';
    // 「加入 Obsidian」（作者 2026-10-25）：vault → adb，就在這裡轉。網頁版下載到
    // 「下載」資料夾，桌面版寫到執行檔旁邊；兩邊完成後都會更新下面的清單。
    // 2026-10-29：只有進階模式才顯示，避免一般使用者被轉檔選項干擾。
    const advanced = document.body.classList.contains('advanced');
    const obsidianRows = advanced && vaultAddHandlers
      ? '<tr class="dbPickItem dbPickAdd" data-vault="dir" tabindex="0"'
        + ' title="把一個 Obsidian vault（整個資料夾）轉成 .adb"><td colspan="6">＋ 加入 Obsidian（資料夾）</td></tr>'
        + '<tr class="dbPickItem dbPickAdd" data-vault="zip" tabindex="0"'
        + ' title="把 Obsidian vault 的 .zip 轉成 .adb"><td colspan="6">＋ 加入 Obsidian（.zip）</td></tr>'
      : '';
    const rows = shown.map((e) => {
      const s = slotOf(e);
      // 「檔名」＝桌面版 path 的 basename（不含 .adb）；網頁版就是 File.name
      const base = fileNameOf(e).replace(/\.adb$/i, '');
      const chars = charCache.get(e.key);
      const cls = 'dbPickItem' + (s && s === active ? ' active' : '') + (s ? ' loaded' : '');
      // adb id（檔頭 dbname）：網頁版選檔時沒有讀到就顯示「—」
      const id = (e.dbname || '').trim();
      return `<tr class="${cls}" data-key="${escapeHtml(e.key)}" data-name="${escapeHtml(e.name)}" data-id="${escapeHtml(id)}"`
        + ` data-size="${e.file.size}" data-date="${e.file.lastModified}" tabindex="0"`
        + ` title="${escapeHtml(e.file.name)}${s ? '' : '（尚未載入，選了才讀）'}">`
        + `<td class="dbPickId">${escapeHtml(id || '—')}</td>`
        + `<td class="dbPickFile">${escapeHtml(base)}</td>`
        + `<td class="dbPickName">${escapeHtml(e.name)}</td>`
        + `<td class="dbPickChars" data-key="${escapeHtml(e.key)}">${chars === undefined ? '…' : fmtInt(chars)}</td>`
        + `<td class="dbPickSize">${fmtBytes(e.file.size)}</td>`
        + `<td class="dbPickDate">${fmtDate(e.file.lastModified)}</td></tr>`;
    }).join('');
    // 表頭：點一下就照那一欄排序，再點一次反向（作者 2026-11-01）。
    // 預設 adb id、升冪（A→Z）；日期／大小換過去時先給降冪（新／大的在前）。
    const th = (k: DbPickSortKey, label: string, title: string): string => {
      const on = sort.k === k;
      const arrow = on ? (sort.d === 1 ? '▲' : '▼') : '';
      return `<th class="dbPickSortCell${on ? ' on' : ''}" data-sort="${k}" title="${title}">`
        + `<button type="button" class="dbPickSortBtn">${label}<span class="dbPickArrow">${arrow}</span></button></th>`;
    };
    menu.innerHTML = shown.length
      ? '<table class="dbPickTable"><thead><tr>'
        + th('id', 'ID', 'adb id（檔頭 dbname）／點一下排序、再點一下反向')
        + th('file', '檔名', '檔名（不含 .adb）／點一下排序、再點一下反向')
        + '<th>庫名</th>'
        + th('chars', '字數', '取自 adb 檔頭的 max VA（最大的文字位置），是近似值；點一下排序')
        + th('size', '大小', '檔案大小／點一下排序、再點一下反向')
        + th('date', '建置日期', '檔案時間（建置日期）／點一下排序、再點一下反向')
        + '</tr></thead>'
        + '<tbody>' + storeRow + addItem + obsidianRows + rows + '</tbody></table>'
      : (storeRow || addItem || obsidianRows
        ? '<table class="dbPickTable"><tbody>' + storeRow + addItem + obsidianRows + '</tbody></table>'
        : '<div class="dbPickEmpty">（這個資料夾沒有 .adb）</div>');
    // 表頭排序（停止冒泡，不然會被外面的「點空白處收起」收掉）
    menu.querySelectorAll<HTMLElement>('.dbPickSortCell').forEach((cell) => {
      cell.onclick = (ev) => {
        ev.stopPropagation();
        const k = cell.dataset.sort as DbPickSortKey | undefined;
        if (k) setDbPickSort(k);
      };
    });
    menu.querySelectorAll<HTMLElement>('.dbPickItem[data-store]').forEach((el) => {
      el.onclick = (ev) => {
        ev.stopPropagation();
        if (el.getAttribute('aria-disabled') === 'true') return;
        setDbPickOpen(false);
        adbStoreHandler?.();
      };
    });
    menu.querySelectorAll<HTMLElement>('.dbPickItem[data-add]').forEach((el) => {
      el.onclick = (ev) => {
        ev.stopPropagation();
        pickAddFile();
      };
    });
    menu.querySelectorAll<HTMLElement>('.dbPickItem[data-vault]').forEach((el) => {
      el.onclick = (ev) => {
        ev.stopPropagation();
        setDbPickOpen(false);
        const kind = el.dataset.vault === 'zip' ? 'zip' : 'dir';
        vaultAddHandlers?.[kind]?.();
      };
    });
    menu.querySelectorAll<HTMLElement>('.dbPickItem[data-key]').forEach((el) => {
      const open = (ev: Event) => {
        ev.stopPropagation();
        setDbPickOpen(false);
        const e = catalog.find((x) => x.key === el.dataset.key);
        if (e) void openCatalogEntry(e);
      };
      el.onclick = open;
      el.onkeydown = (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(ev); }
      };
    });
    // 鍵盤：↑↓／Home／End 移動，Enter 開，Esc 收起（2026-10-30）
    menu.onkeydown = (ev) => {
      const items = [...menu.querySelectorAll<HTMLElement>('.dbPickItem')];
      const at = items.indexOf(document.activeElement as HTMLElement);
      if (ev.key === 'ArrowDown') { ev.preventDefault(); items[Math.min(items.length - 1, at + 1)]?.focus(); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); items[Math.max(0, at - 1)]?.focus(); }
      else if (ev.key === 'Home') { ev.preventDefault(); items[0]?.focus(); }
      else if (ev.key === 'End') { ev.preventDefault(); items[items.length - 1]?.focus(); }
      else if (ev.key === 'Escape') { ev.preventDefault(); setDbPickOpen(false); ($('#dbPickBtn') as HTMLElement | null)?.focus(); }
    };
    // 貼在 📁 正下方、**向右展開**（作者 2026-10-18）：寬度最多到視窗右緣（留 12px），
    // 所以庫名再長也只會在格子裡省略，不會溢出畫面任何一邊。
    const wrap = menu.parentElement;
    if (wrap) {
      const left = wrap.getBoundingClientRect().left;
      const room = Math.max(260, Math.min(54 * 16, window.innerWidth - left - 12));
      menu.style.maxWidth = room + 'px';
    }
    menu.hidden = !pickOpen;
    // 打開選單才開始算字數（背景、一次一個）；算好會自己填進那一格。
    if (pickOpen) for (const e of shown) queueChars(e);
  }
  if (btn) {
    btn.classList.toggle('on', pickOpen);
    btn.title = `adb（${shown.length} 個已開啟過）：按一下選一個（最多同時保留 ${MAX_DBS} 個）（Alt+O）`;
  }
  // 沒有打開任何 adb 時不必顯示放大鏡（作者 2026-10）
  const allBtn = $('#searchAllBtn') as HTMLButtonElement | null;
  if (allBtn) allBtn.hidden = catalog.length === 0;
}

/**
 * 下拉裡要不要「加入 adb」那一項？只有 file:// 版要（作者 2026-10）：
 * 桌面版啟動時已經把工作目錄的 adb 全列進 catalog 了。
 *
 * 用 `hostState().available`（桌面宿主探測成功的旗標）當主要依據：`backendKind()`
 * 需要先開一個庫才有 reader，開機第一次畫選單時它還回 'ts'，會讓桌面版多出一項。
 */
export function needsAddItem(): boolean {
  if (hostState().available) return false;
  return backendKind() !== 'go';
}

/** catalog 是不是空的（還沒開過任何 adb）——file:// 版第一次按 📁 就直接開檔案挑選。 */
export function catalogEmpty(): boolean {
  return catalog.length === 0;
}

/**
 * 「加入 Obsidian」的兩個入口（資料夾／.zip）由 vault-import.ts 註冊。
 *
 * 這裡只放註冊表、不 import 那支模組：dbPick 的選單歸 dbs.ts 畫，而轉檔要用到
 * viewer／openFile，直接互相 import 會成環。選單按下時呼叫註冊進來的函式。
 */
export interface VaultAddHandlers {
  dir: () => void;
  zip: () => void;
}
let vaultAddHandlers: VaultAddHandlers | null = null;
export function setVaultAddHandlers(h: VaultAddHandlers | null): void { vaultAddHandlers = h; }
export const vaultAddReady = (): boolean => !!vaultAddHandlers;

/** 「取得更多 ADB」由 adb-store.ts 註冊；與 Obsidian 同一個理由，避免循環 import。 */
let adbStoreHandler: (() => void) | null = null;
export function setAdbStoreHandler(h: (() => void) | null): void { adbStoreHandler = h; }

/**
 * 重新列一次桌面宿主工作目錄裡的 .adb（「加入 Obsidian」寫完檔案後要更新清單）。
 * 網頁版沒有宿主，回空陣列。
 */
export async function refreshHostDbs(): Promise<AdbSource[]> {
  const srcs = await desktopSources();
  for (const s of srcs) catalogAdd(s, s.name);
  renderDbPick();
  return srcs;
}

/**
 * 開檔案挑選視窗（作者 2026-10-18）：「＋ 加入 adb」與「清單是空的時候按 📁」共用，
 * 省得使用者按了 📁 還要再按一次「＋ 加入 adb」。
 */
export function pickAddFile(): void {
  setDbPickOpen(false);
  const input = $('#file') as HTMLInputElement | null;
  if (!input) return;
  input.value = '';
  input.click();
}

/** the open slot with the smallest MRU stamp (never `except`) */
function worstSlot(except: DbSlot | null): DbSlot | null {
  let out: DbSlot | null = null;
  for (const s of openDbs) {
    if (s === except) continue;
    if (!out || s.usedAt < out.usedAt) out = s;
  }
  return out;
}

/**
 * A pick from the dropdown: switch to it when it is already loaded, otherwise load it.
 * When five are open the LEAST RECENTLY USED one gives way — its 本文分頁 live inside
 * its slot, so they go with it (that is the documented meaning of closing a database).
 */
export async function openCatalogEntry(e: CatalogEntry): Promise<void> {
  e.usedAt = ++useSeq;
  const slot = slotOf(e);
  if (slot) {
    slot.usedAt = ++useSeq;
    switchTo(slot.id, true);    // 從下拉選的：跳到 dbTabs 最左
    return;
  }
  while (openDbs.length >= MAX_DBS) {
    const lru = worstSlot(null);
    if (!lru) break;
    dbLog.push('evict ' + lru.name);
    closeDb(lru.id);
  }
  await openFile(e.file);
  renderDbPick();
}

/** diagnostics: the dropdown's contents */
export const catalogState = (): { name: string; file: string; open: boolean }[] =>
  catalog.map((e) => ({ name: e.name, file: e.file.name, open: !!slotOf(e) }));

/** called by openFile once the new database is loaded and rendered */
export function registerOpenDb(file: AdbSource, name: string): { ok: boolean; replaced?: boolean } {
  const slot: DbSlot = { id: ++seq, name, file, usedAt: ++useSeq, core: null, docPane: null, scopes: null, summary: null, link: null, panes: null, text: null };
  saveInto(slot);
  // 同一個 **dbname**（檔頭 id）才是同一個庫；顯示名相同不算。
  // 說文解字注的章節版／卷字版 dbcname 都是「說文解字注」，但 dbname 是
  // swjz／swjzz——用 name 去重會讓第二版把第一版取代掉（作者 2026-11-06：
  // 兩個 edition 要能同時開著測互鏈）。
  const key = slotKey(slot);
  const same = openDbs.findIndex((d) => slotKey(d) === key);
  if (same >= 0) {
    // 同名的舊庫被新檔取代：它的本文分頁畫的是舊檔的 reader，一起關掉
    const old = openDbs[same];
    closeTabsForDb(old.id);
    dropPageImages((old.core as CoreSnap | null | undefined)?.reader ?? null);
    openDbs[same] = slot;
  } else openDbs.unshift(slot);      // 最後開啟的放 dbTabs 的最左邊
  // At most MAX_DBS stay: the least recently USED one goes (its 本文分頁 go with it).
  while (openDbs.length > MAX_DBS) {
    const lru = worstSlot(slot);
    if (!lru) break;
    dbLog.push('evict ' + lru.name);
    closeTabsForDb(lru.id);
    dropPageImages((lru.core as CoreSnap | null | undefined)?.reader ?? null);
    openDbs.splice(openDbs.indexOf(lru), 1);
  }
  activeId = slot.id;
  loadedId = slot.id;
  setActiveDocDbId(slot.id);
  renderDbTabs();
  renderDbPick();
  // A DIFFERENT file carrying the same database name REPLACES that chip (two chips
  // with one name could not be told apart). The caller tells the reader so the
  // vanished tabs of the old file are not a mystery.
  return { ok: true, replaced: same >= 0 };
}

/**
 * One chip per open database, in `openDbs` order: a newly opened database goes to the
 * LEFT (作者 2026-10), the others keep their relative order (switching only restyles
 * them, the buttons do not jump). The ✕ sits on the active chip so closing is always in
 * the same place relative to the name that is in use. At most MAX_DBS are kept — the
 * least recently used one is evicted when a sixth is opened.
 */
export function renderDbTabs(): void {
  const box = $('#dbTabs');
  if (!box) return;
  collectShortNames();               // 檔頭的 集.b 是非同步的；讀到會再重畫
  const active = activeSlot();
  // 同一個顯示名可能有多個 edition（說文解字注的章節版／卷字版）：晶片加上
  // dbname 才分得出來（作者 2026-11-06）。
  const nameCount = new Map<string, number>();
  for (const d of openDbs) nameCount.set(d.name, (nameCount.get(d.name) ?? 0) + 1);
  const SAVE_SVG = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 2h9l3 3v9H2V2zm2 1v4h7V3H4zm0 7v4h8v-4H4z"/></svg>';
  box.innerHTML = openDbs.map((d) => {
    const on = d === active;
    const n = editCount(findSession(sourceKey(d.file)));
    const dup = (nameCount.get(d.name) ?? 0) > 1;
    const label = chipName(d) + (dup ? '·' + slotKey(d) : '');
    const edit = n
      ? '<span class="dbChipEdit" data-save="' + d.id + '" title="' + n + ' 頁修訂：點一下產生新 ADB">' + SAVE_SVG + n + ' 頁修訂</span>'
      : '';
    // hover 顯示這個庫的版本資訊（作者 2026-10-29）：檔名、大小與建置日期
    // （檔案的修改時間；桌面版是磁碟上的 .adb，網頁版是下載下來的檔案）。
    const built = fmtDateTime(d.file.lastModified);
    const title = `${d.name}\n${d.file.name}（${fmtBytes(d.file.size)}）`
      + (built !== '—' ? `\n建置日期 ${built}` : '');
    // owner（作者 2026-11-01）：這個庫有本文分頁（跨庫分頁並存時，一眼看出誰有分頁）。
    // 只是一圈淡外框／小圓點，**不改變 active**。
    const hasTabs = tabCountOfDb(d.id) > 0;
    return '<span class="dbChip' + (on ? ' active' : '') + (hasTabs ? ' owner' : '') + '" data-id="' + d.id + '" title="' + escapeHtml(title) + '">'
      + escapeHtml(label) + edit
      + '<span class="dbChipClose" data-close="' + d.id + '" title="關閉（含它的所有本文分頁）">✕</span>'
      + '</span>';
  }).join('');
  box.querySelectorAll<HTMLElement>('.dbChip').forEach((el) => {
    el.onclick = (ev) => {
      const saveId = Number((ev.target as HTMLElement)?.closest('.dbChipEdit')?.getAttribute('data-save') ?? 0);
      if (saveId) {
        ev.stopPropagation();
        window.dispatchEvent(new CustomEvent('accelon26:rebuild', { detail: { id: saveId } }));
        return;
      }
      const closeId = Number((ev.target as HTMLElement)?.closest('.dbChipClose')?.getAttribute('data-close') ?? 0);
      if (closeId) { void closeDb(closeId); return; }
      const id = Number(el.dataset.id);
      const cur = activeSlot();
      if (!cur || cur.id !== id) switchTo(id);     // clicking the active one does nothing
    };
  });
  tabsExtra?.();   // 例：資料庫更新的「New」按鈕（adb-update.ts 註冊）
}
/**
 * Switch to a slot. `front` moves it to the LEFT of dbTabs — the dropdown uses that
 * ("一使用就跳到最左" means: choosing from the adb dropdown). Clicking a CHIP must never
 * reorder anything ("切換 active 時不要亂跳"), it only restyles.
 */
export function switchTo(id: number, front = false, activateTab?: number): void {
  const target = openDbs.find((d) => d.id === id);
  const cur = activeSlot();
  if (!target) return;
  target.usedAt = ++useSeq;        // 「保留最後使用的 5 個」
  if (front) {
    const at = openDbs.indexOf(target);
    if (at > 0) { openDbs.splice(at, 1); openDbs.unshift(target); }
  }
  if (target === cur) { renderDbTabs(); renderDbPick(); return; }
  if (cur) saveInto(cur);
  loadFrom(target);
  if (sharedDocTabsOn()) {
    // 共享分頁：本文分頁條保留，選回「這個庫最後看的那一個」；沒有就顯示提示
    if (activateTab != null && activateTab >= 0) setDocActive(activateTab);
    else if (!activateTabById(target.docTabId ?? 0) && !activateTabForDb(target.id)) {
      showEmptyDoc('這個庫還沒有開啟本文；點左側目錄或摘要就會載入。');
    }
  }
  hooks.refresh();
  renderDbTabs();
  renderDbPick();
  window.dispatchEvent(new Event('accelon-db-changed'));
}

export function closeDb(id: number): void {
  const at = openDbs.findIndex((d) => d.id === id);
  if (at < 0) return;
  const slot = openDbs[at];
  const es = findSession(sourceKey(slot.file));
  const n = editCount(es);
  if (n > 0 && !window.confirm('「' + slot.name + '」有 ' + n + ' 頁修訂，關閉會丟失。仍要關閉？')) return;
  if (es) discardAll(es);
  const wasActive = openDbs[at] === activeSlot();
  // 關庫＝連它的本文分頁一起關（作者 2026-11-01）：分頁的 ctx 持有這一庫的
  // reader／mapper，桌面版是 mmap，關掉之後再畫會炸；Blob 也不會釋放。
  const closed = closeTabsForDb(slot.id);
  dropPageImages((slot.core as CoreSnap | null | undefined)?.reader ?? null);
  openDbs.splice(at, 1);
  if (closed) dbLog.push('close ' + slot.name + ' tabs=' + closed);
  if (wasActive) {
    // the most recently used of what is left becomes active
    const next = openDbs.reduce<DbSlot | null>((a, d) => (!a || d.usedAt > a.usedAt ? d : a), null);
    if (next) { loadFrom(next); hooks.refresh(); }
    else { setActiveDocDbId(0); hooks.clear(); }
  }
  renderDbTabs();
  renderDbPick();
  window.dispatchEvent(new Event('accelon-db-changed'));
}

// 修訂數變動：dbChip 的「n 頁修訂」即時更新
onEditsChange(() => { try { renderDbTabs(); } catch { /* boot */ } });

/** ✕ next to the active database's name */
export function closeActiveDb(): void {
  const a = activeSlot();
  if (a) closeDb(a.id);
}

// ---- #dbTabs 的額外按鈕（作者 2026-10-29）------------------------------------
//
// 資料庫更新的「New」按鈕要住在 #dbTabs 裡；但 renderDbTabs() 每次都重畫整個
// innerHTML，所以由 adb-update.ts 註冊一個「畫完再補上」的 hook，不在 dbs.ts
// import 它（避免 dbs → adb-update → dbs 的循環）。
let tabsExtra: (() => void) | null = null;
export function setDbTabsExtra(fn: (() => void) | null): void { tabsExtra = fn; }

/**
 * 「開著哪幾個庫／哪一個是 active」**不在這裡存**（作者 2026-11-01）。
 *
 * 以前每次開庫／切庫／關庫都寫一次 settings.json；作者要求「平時不必一直存，
 * 只有退出 exe 之前再存設定」。所以改成離開 exe 時由 `ui.ts` 的 `saveOnExit()`
 * 一次寫進 localStorage（`open-set.ts` 的 `writeOpenSetNow()`，同步、關窗也寫得進去）。
 */

const normPath = (p: string): string => p.replace(/\\/g, '/').toLowerCase();

/** 依完整路徑找 catalog 裡的那一筆（桌面版的 file.path；網頁版沒有 path）。 */
export function catalogByPath(path: string): CatalogEntry | null {
  return catalog.find((e) => !!e.file.path && normPath(e.file.path) === normPath(path)) ?? null;
}

/**
 * 更新完成後把 catalog 的那一筆換成新檔（大小／時間／Blob 都變了）。顯示名跟著
 * 新檔頭（通常是同一個庫名），key 換成新的（openFile 的 catalogAdd 才不會重複一筆）。
 */
export function replaceCatalogFile(path: string, file: AdbSource): CatalogEntry | null {
  const e = catalogByPath(path);
  if (!e) return null;
  e.file = file;
  e.key = fileKey(file);
  if (file.name) e.name = file.name;   // 新檔的庫名（通常是同一個）
  renderDbPick();
  return e;
}

// 離線／上線時更新「取得更多 ADB」的變暗狀態（不隱藏）。
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => renderDbPick());
  window.addEventListener('offline', () => renderDbPick());
}

