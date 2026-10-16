/**
 * Several .adb files open at once (max MAX_DBS).
 *
 * Every database is a SLOT holding one snapshot per module (the snapshot/restore
 * pairs each module exports). Switching a slot saves the state of the database being left and restores the
 * target; closing a slot drops it — its document tabs live inside the slot, so
 * "close the database" also closes every 本文分頁 that used it.
 *
 * The header shows the active database's name (#dbname) plus one chip per other open
 * database (#dbTabs): click a chip to switch, ✕ on a chip (or #dbClose) to close.
 */
import { $, escapeHtml, restoreCore, snapshotCore } from './viewer';
import { restoreDocPane, snapshotDocPane } from './doc-pane';
import { restorePanes, snapshotPanes } from './panes';
import { restoreScopes, snapshotScopes } from './scopes';
import { restoreSummary, snapshotSummary } from './summary';
import { restoreLink, snapshotLink } from './link';

export const MAX_DBS = 5;

export interface DbSlot {
  id: number;
  name: string;
  file: File;
  core: unknown; docPane: unknown; scopes: unknown; summary: unknown; link: unknown; panes: unknown;
}

export const openDbs: DbSlot[] = [];
let activeId = 0;
let seq = 0;

type Hooks = { refresh: () => void; clear: () => void };
let hooks: Hooks = { refresh: () => {}, clear: () => {} };
/** ui.ts registers what "redraw everything" and "no database left" mean */
export function setDbHooks(h: Hooks): void { hooks = h; }

export const activeSlot = (): DbSlot | null => openDbs.find((d) => d.id === activeId) ?? null;

/** copy every module's current state into the slot */
export function saveInto(slot: DbSlot): void {
  slot.core = snapshotCore();
  slot.docPane = snapshotDocPane();
  slot.scopes = snapshotScopes();
  slot.summary = snapshotSummary();
  slot.link = snapshotLink();
  slot.panes = snapshotPanes();
}
function loadFrom(slot: DbSlot): void {
  restoreCore(slot.core);
  restoreDocPane(slot.docPane);
  restoreScopes(slot.scopes);
  restoreSummary(slot.summary);
  restoreLink(slot.link);
  restorePanes(slot.panes);
  activeId = slot.id;
}

/** called by openFile once the new database is loaded and rendered */
export function registerOpenDb(file: File, name: string): { ok: boolean; reason?: string } {
  const same = openDbs.findIndex((d) => d.name === name);
  if (same < 0 && openDbs.length >= MAX_DBS) {
    return { ok: false, reason: '最多同時開啟 ' + MAX_DBS + ' 個資料庫（先關掉一個）' };
  }
  const slot: DbSlot = { id: ++seq, name, file, core: null, docPane: null, scopes: null, summary: null, link: null, panes: null };
  saveInto(slot);
  if (same >= 0) openDbs[same] = slot;
  else openDbs.push(slot);
  activeId = slot.id;
  renderDbTabs();
  return { ok: true };
}

export function renderDbTabs(): void {
  const box = $('#dbTabs');
  const nameBtn = $('#dbname') as HTMLButtonElement | null;
  const closeBtn = $('#dbClose') as HTMLButtonElement | null;
  const active = activeSlot();
  if (nameBtn) {
    nameBtn.hidden = !active;
    if (active) { nameBtn.textContent = active.name; nameBtn.title = active.name + '（目前；點此開啟其他 .adb）'; }
  }
  if (closeBtn) closeBtn.hidden = !active;
  if (!box) return;
  box.innerHTML = openDbs.filter((d) => d !== active)
    .map((d) => '<span class="dbChip" data-id="' + d.id + '" title="切換到 ' + escapeHtml(d.name) + '">'
      + escapeHtml(d.name)
      + '<span class="dbChipClose" data-close="' + d.id + '" title="關閉（含它的所有本文分頁）">✕</span></span>')
    .join('');
  box.querySelectorAll<HTMLElement>('.dbChip').forEach((el) => {
    el.onclick = (ev) => {
      const closeId = Number((ev.target as HTMLElement)?.closest('.dbChipClose')?.getAttribute('data-close') ?? 0);
      if (closeId) { void closeDb(closeId); return; }
      void switchTo(Number(el.dataset.id));
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
