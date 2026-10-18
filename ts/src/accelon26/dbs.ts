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
import { $, escapeHtml, fmtInt, openFile, restoreCore, snapshotCore } from './viewer';
import { AdbReader, BlobIO, type AdbSource } from './adb';
import { restoreDocPane, snapshotDocPane } from './doc-pane';
import { restorePanes, snapshotPanes } from './panes';
import { restoreScopes, snapshotScopes } from './scopes';
import { restoreSummary, snapshotSummary } from './summary';
import { restoreLink, snapshotLink } from './link';
import { restoreTextPane, snapshotTextPane } from './text-pane';
import { backendKind } from './backend';
import { hostState } from './host';

export const MAX_DBS = 5;

export interface DbSlot {
  id: number;
  name: string;
  file: AdbSource;
  /** MRU stamp: the largest is the most recently used (eviction takes the smallest) */
  usedAt: number;
  core: unknown; docPane: unknown; scopes: unknown; summary: unknown; link: unknown; panes: unknown; text: unknown;
}

/**
 * One .adb the reader has picked (or dropped) in this session. Only its HEADER is
 * read — the dropdown lists databases that are not loaded yet.
 */
export interface CatalogEntry {
  key: string;          // file identity: name + size + mtime
  file: AdbSource;
  name: string;         // 庫名 from the header
  usedAt: number;
}

export const openDbs: DbSlot[] = [];
/** every database this session has offered (see CatalogEntry) */
export const catalog: CatalogEntry[] = [];
const fileKey = (f: AdbSource): string => f.name + ':' + f.size + ':' + f.lastModified;
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
  restoreDocPane(slot.docPane);
  restoreScopes(slot.scopes);
  restoreSummary(slot.summary);
  restoreLink(slot.link);
  restorePanes(slot.panes);
  restoreTextPane(slot.text);
  activeId = slot.id;
  loadedId = slot.id;
}

/** the loaded slot of a catalog entry, if it is loaded */
export const slotOf = (e: CatalogEntry): DbSlot | null =>
  openDbs.find((s) => fileKey(s.file) === e.key && s.name === e.name) ?? null;

/** remember a picked file (the caller already peeked its header for the name) */
export function catalogAdd(file: AdbSource, name: string): CatalogEntry {
  const key = fileKey(file);
  const hit = catalog.find((e) => e.key === key && e.name === name);
  if (hit) return hit;
  const e: CatalogEntry = { key, file, name, usedAt: ++useSeq };
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
  try {
    const probe = await AdbReader.open(new BlobIO(file));
    name = probe.header.dbcname || probe.header.dbname || file.name;
  } catch { /* keep the file name */ }
  return catalogAdd(file, name);
}

/**
 * The picker at the top right（作者 2026-10）：`#dbPickBtn`（黃色資料夾）按一下才展開
 * `#dbPickMenu`，列出這次工作階段見過的每一個 adb（已載入的在前、最近用過的在前），
 * 目前這一個標成 `.active`。選一個就 `openCatalogEntry()`（切換或載入）。
 */
let pickOpen = false;

/** 選單現在開著嗎（診斷／測試用） */
export function dbPickOpen(): boolean { return pickOpen; }

/** 開／關選單；`force` 省略＝切換 */
export function setDbPickOpen(force?: boolean): void {
  pickOpen = force ?? !pickOpen;
  renderDbPick();
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

export function renderDbPick(): void {
  const menu = $('#dbPickMenu');
  const btn = $('#dbPickBtn');
  const active = activeSlot();
  const shown = [...catalog].sort((a, b) => {
    const ao = slotOf(a) ? 1 : 0, bo = slotOf(b) ? 1 : 0;
    if (ao !== bo) return bo - ao;
    return b.usedAt - a.usedAt;
  });
  // 同一個庫名可能有兩個檔案（13j.adb 與 1839.adb 都叫十三經）：表格第一欄就是檔名，
  // 不必再在標籤後面接檔名（作者 2026-10-18 改成表格）。
  if (menu) {
    // 第一項「加入 adb」＝原本 header 的 ＋（作者 2026-10）。只有 file:// 版需要：
    // 桌面版（Wails）啟動時就把工作目錄裡的 adb 全列出來了。
    const addItem = needsAddItem()
      ? '<tr class="dbPickItem dbPickAdd" data-add="1" tabindex="0" title="開啟 .adb（最多同時 5 個）"><td colspan="4">＋ 加入 adb</td></tr>'
      : '';
    const rows = shown.map((e) => {
      const s = slotOf(e);
      // 「adb 名」＝檔名去掉 .adb。桌面宿主的 AdbSource.name 是庫名，真正的檔名在 path。
      const fname = e.file.path ? (e.file.path.split(/[\\/]/).pop() ?? e.file.name) : e.file.name;
      const base = fname.replace(/\.adb$/i, '');
      const chars = charCache.get(e.key);
      const cls = 'dbPickItem' + (s && s === active ? ' active' : '');
      return `<tr class="${cls}" data-key="${escapeHtml(e.key)}" data-name="${escapeHtml(e.name)}" tabindex="0"`
        + ` title="${escapeHtml(e.file.name)}${s ? '' : '（尚未載入，選了才讀）'}">`
        + `<td class="dbPickFile">${escapeHtml(base)}</td>`
        + `<td class="dbPickName">${escapeHtml(e.name)}</td>`
        + `<td class="dbPickChars" data-key="${escapeHtml(e.key)}">${chars === undefined ? '…' : fmtInt(chars)}</td>`
        + `<td class="dbPickDate">${fmtDate(e.file.lastModified)}</td></tr>`;
    }).join('');
    menu.innerHTML = shown.length
      ? '<table class="dbPickTable"><thead><tr><th>檔名</th><th>庫名</th>' +
        '<th title="取自 adb 檔頭的 max VA（最大的文字位置），是近似值">字數</th><th>建置日期</th></tr></thead>'
        + '<tbody>' + addItem + rows + '</tbody></table>'
      : (addItem
        ? '<table class="dbPickTable"><tbody>' + addItem + '</tbody></table>'
        : '<div class="dbPickEmpty">（這個資料夾沒有 .adb）</div>');
    menu.querySelectorAll<HTMLElement>('.dbPickItem[data-add]').forEach((el) => {
      el.onclick = (ev) => {
        ev.stopPropagation();
        pickAddFile();
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
    btn.title = `adb（${shown.length} 個已開啟過）：按一下選一個（最多同時保留 ${MAX_DBS} 個）`;
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
  const same = openDbs.findIndex((d) => d.name === name);
  const slot: DbSlot = { id: ++seq, name, file, usedAt: ++useSeq, core: null, docPane: null, scopes: null, summary: null, link: null, panes: null, text: null };
  saveInto(slot);
  if (same >= 0) openDbs[same] = slot;
  else openDbs.unshift(slot);      // 最後開啟的放 dbTabs 的最左邊
  // At most MAX_DBS stay: the least recently USED one goes (its 本文分頁 go with it).
  while (openDbs.length > MAX_DBS) {
    const lru = worstSlot(slot);
    if (!lru) break;
    dbLog.push('evict ' + lru.name);
    openDbs.splice(openDbs.indexOf(lru), 1);
  }
  activeId = slot.id;
  loadedId = slot.id;
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
  const active = activeSlot();
  box.innerHTML = openDbs.map((d) => {
    const on = d === active;
    return '<span class="dbChip' + (on ? ' active' : '') + '" data-id="' + d.id + '" title="' + escapeHtml(d.name) + '">'
      + escapeHtml(d.name)
      + '<span class="dbChipClose" data-close="' + d.id + '" title="關閉（含它的所有本文分頁）">✕</span>'
      + '</span>';
  }).join('');
  box.querySelectorAll<HTMLElement>('.dbChip').forEach((el) => {
    el.onclick = (ev) => {
      const closeId = Number((ev.target as HTMLElement)?.closest('.dbChipClose')?.getAttribute('data-close') ?? 0);
      if (closeId) { void closeDb(closeId); return; }
      const id = Number(el.dataset.id);
      const cur = activeSlot();
      if (!cur || cur.id !== id) switchTo(id);     // clicking the active one does nothing
    };
  });
}
/**
 * Switch to a slot. `front` moves it to the LEFT of dbTabs — the dropdown uses that
 * ("一使用就跳到最左" means: choosing from the adb dropdown). Clicking a CHIP must never
 * reorder anything ("切換 active 時不要亂跳"), it only restyles.
 */
export function switchTo(id: number, front = false): void {
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
  hooks.refresh();
  renderDbTabs();
  renderDbPick();
}

export function closeDb(id: number): void {
  const at = openDbs.findIndex((d) => d.id === id);
  if (at < 0) return;
  const wasActive = openDbs[at] === activeSlot();
  openDbs.splice(at, 1);
  if (wasActive) {
    // the most recently used of what is left becomes active
    const next = openDbs.reduce<DbSlot | null>((a, d) => (!a || d.usedAt > a.usedAt ? d : a), null);
    if (next) { loadFrom(next); hooks.refresh(); }
    else hooks.clear();
  }
  renderDbTabs();
  renderDbPick();
}

/** ✕ next to the active database's name */
export function closeActiveDb(): void {
  const a = activeSlot();
  if (a) closeDb(a.id);
}
