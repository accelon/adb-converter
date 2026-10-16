/**
 * Several .adb files open at once (max MAX_DBS).
 *
 * Every database is a SLOT holding one snapshot per module (the snapshot/restore
 * pairs each module exports). Switching a slot saves the state of the database being left and restores the
 * target; closing a slot drops it — its document tabs live inside the slot, so
 * "close the database" also closes every 本文分頁 that used it.
 *
 * The header shows one chip per open database (#dbTabs, always in insertion order) and a
 * fixed ＋ button (#dbAdd) to its left that opens another file. Click a chip to switch to
 * it; the ACTIVE chip carries the ✕ that closes it (and every tab that used it).
 */
import { $, escapeHtml, openFile, restoreCore, snapshotCore } from './viewer';
import { AdbReader, BlobIO, type AdbSource } from './adb';
import { restoreDocPane, snapshotDocPane } from './doc-pane';
import { restorePanes, snapshotPanes } from './panes';
import { restoreScopes, snapshotScopes } from './scopes';
import { restoreSummary, snapshotSummary } from './summary';
import { restoreLink, snapshotLink } from './link';
import { restoreTextPane, snapshotTextPane } from './text-pane';

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
 * The dropdown (#dbPick) at the top right: every database this session has offered.
 * Loaded ones come first (most recently used first), then the ones that are only
 * known by header; the ACTIVE database is what the box displays.
 */
export function renderDbPick(): void {
  const sel = $('#dbPick') as HTMLSelectElement | null;
  if (!sel) return;
  const active = activeSlot();
  const shown = [...catalog].sort((a, b) => {
    const ao = slotOf(a) ? 1 : 0, bo = slotOf(b) ? 1 : 0;
    if (ao !== bo) return bo - ao;
    return b.usedAt - a.usedAt;
  });
  // two different files can carry the same 庫名 (13j.adb and 1839.adb are both 十三經):
  // show the file name so the reader can tell them apart
  const dup = new Map<string, number>();
  for (const e of catalog) dup.set(e.name, (dup.get(e.name) ?? 0) + 1);
  sel.innerHTML = shown.length
    ? shown.map((e) => {
      const s = slotOf(e);
      const label = e.name + ((dup.get(e.name) ?? 0) > 1 ? '｜' + e.file.name : '') + (s ? '' : '（未載入）');
      return '<option value="' + e.key + '"' + (s && s === active ? ' selected' : '') + '>'
        + escapeHtml(label) + '</option>';
    }).join('')
    : '<option value="">（用 ＋ 開啟 .adb）</option>';
  sel.onchange = () => {
    const e = catalog.find((x) => x.key === sel.value);
    if (e) void openCatalogEntry(e);
  };
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
