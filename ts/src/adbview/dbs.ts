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
import { $, escapeHtml, restoreCore, snapshotCore } from './viewer';
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
  file: File;
  core: unknown; docPane: unknown; scopes: unknown; summary: unknown; link: unknown; panes: unknown; text: unknown;
}

export const openDbs: DbSlot[] = [];
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
export function alreadyOpen(file: File, name: string): DbSlot | null {
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

/** called by openFile once the new database is loaded and rendered */
export function registerOpenDb(file: File, name: string): { ok: boolean; reason?: string; replaced?: boolean } {
  const same = openDbs.findIndex((d) => d.name === name);
  if (same < 0 && openDbs.length >= MAX_DBS) {
    return { ok: false, reason: '最多同時開啟 ' + MAX_DBS + ' 個資料庫（先關掉一個）' };
  }
  const slot: DbSlot = { id: ++seq, name, file, core: null, docPane: null, scopes: null, summary: null, link: null, panes: null, text: null };
  saveInto(slot);
  if (same >= 0) openDbs[same] = slot;
  else openDbs.push(slot);
  activeId = slot.id;
  loadedId = slot.id;
  renderDbTabs();
  // A DIFFERENT file carrying the same database name REPLACES that chip (two chips
  // with one name could not be told apart). The caller tells the reader so the
  // vanished tabs of the old file are not a mystery.
  return { ok: true, replaced: same >= 0 };
}

/**
 * One chip per open database, ALWAYS in insertion order: making another one active
 * only restyles them (the buttons must not jump around). The ✕ sits on the active
 * chip so closing is always in the same place relative to the name that is in use.
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
export function switchTo(id: number): void {
  const target = openDbs.find((d) => d.id === id);
  const cur = activeSlot();
  if (!target || target === cur) return;
  if (cur) saveInto(cur);
  loadFrom(target);
  hooks.refresh();
  renderDbTabs();
}

export function closeDb(id: number): void {
  const at = openDbs.findIndex((d) => d.id === id);
  if (at < 0) return;
  const wasActive = openDbs[at] === activeSlot();
  openDbs.splice(at, 1);
  if (wasActive) {
    const next = openDbs[openDbs.length - 1];
    if (next) { loadFrom(next); hooks.refresh(); }
    else hooks.clear();
  }
  renderDbTabs();
}

/** ✕ next to the active database's name */
export function closeActiveDb(): void {
  const a = activeSlot();
  if (a) closeDb(a.id);
}
