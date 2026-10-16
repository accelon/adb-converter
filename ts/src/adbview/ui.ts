/**
 * 版面與 wiring：欄寬、分隔線、分頁切換、進階模式、boot。
 *
 * Split out of viewer.ts (ADBVIEW-HANDOVER 3.2). Shared state is read from
 * ./viewer and the other split modules as ESM live bindings; a module OWNS the
 * state it declares, and other modules get/set it through that module's exports.
 */
import { $, docs, lastOpen, mapper, openFile, opening, reader, setStatus, tokens } from './viewer';
import { DOCFS_DEFAULT, autoFitFont, boundsOfRealm, docActive, docSession, docTabs, fitDebugInfo, lastDocLines, lastFit, lastLink, pageBounds, pagerLog, readDocFont, setDocFont } from './doc-pane';
import { cursorNode, lastReveal, nodeLabelOf, pinnedHit, revealCursorInTree, revealHit, showLine } from './link';
import { appendTokenRows, showToken, tokenList, tokenOffset, vapaProbe } from './panes';
import { dirActive, dirError, dirLoading, dirTrees, renderDirTree, renderFolio, renderFreq, renderLatin, renderTerms, treePhases } from './scopes';
import { SNIPPET_LIMIT, lastResult, renderSnippets, runSearch, searchSeq, showMoreSnippets, snippetScope, snippetShown } from './summary';

// -------------------------------------------------------------------- wiring
/**
 * Column widths: default left / middle / right = 25 / 50 / 25 (percent), but the
 * RIGHT column starts hidden — the token pane is only needed once you look
 * something up. Dragging a splitter below MIN_SIDE (15%) hides that side;
 * the header buttons toggle them. Everything is stored in localStorage.
 */
const COLS_KEY = 'adbview.cols.v2';

const MIN_SIDE = 15;

const MAX_SIDE = 60;

const DEFAULT_COLS = { left: 25, right: 25 };

function readCols(): { left: number; right: number } {
  try {
    const raw = JSON.parse(localStorage.getItem(COLS_KEY) ?? '');
    if (typeof raw?.left === 'number' && typeof raw?.right === 'number') {
      return { left: raw.left, right: raw.right };
    }
  } catch { /* fall through to defaults */ }
  return { ...DEFAULT_COLS };
}

function applyCols() {
  // persist on first run so the setting exists even before the user drags
  if (localStorage.getItem(COLS_KEY) === null) {
    localStorage.setItem(COLS_KEY, JSON.stringify({ ...DEFAULT_COLS }));
  }
  const { left, right } = readCols();
  const root = document.documentElement.style;
  const l = left < MIN_SIDE ? 0 : left;
  const r = right < MIN_SIDE ? 0 : right;
  root.setProperty('--left', l + 'fr');
  root.setProperty('--right', r + 'fr');
  root.setProperty('--center', (100 - l - r) + 'fr');
  ($('#toggleLeft') as HTMLButtonElement).classList.toggle('off', l === 0);
  ($('#toggleRight') as HTMLButtonElement).classList.toggle('off', r === 0);
}

function saveCols(left: number, right: number) {
  // anything below the minimum is stored as 0, i.e. hidden — so the persisted
  // state and the rendered state always agree
  const norm = (v: number) => (v < MIN_SIDE ? 0 : Math.min(MAX_SIDE, v));
  localStorage.setItem(COLS_KEY, JSON.stringify({ left: norm(left), right: norm(right) }));
  applyCols();
}

function setSide(side: 'left' | 'right', visible: boolean) {
  const c = readCols();
  if (side === 'left') c.left = visible ? (c.left < MIN_SIDE ? 25 : c.left) : 0;
  else c.right = visible ? (c.right < MIN_SIDE ? 25 : c.right) : 0;
  saveCols(c.left, c.right);
}

function toggleSide(side: 'left' | 'right') {
  const c = readCols();
  setSide(side, (side === 'left' ? c.left : c.right) < MIN_SIDE);
}

/** Drag a splitter; returns the new percentage for that side. */
function attachSplitter(el: HTMLElement, side: 'left' | 'right') {
  let dragging = false;
  let startX = 0;
  let startPct = 0;
  const pctOfDrag = (clientX: number) => {
    const dxPct = ((clientX - startX) / window.innerWidth) * 100;
    // dragging the right-hand splitter to the right shrinks the right column
    const raw = side === 'left' ? startPct + dxPct : startPct - dxPct;
    return Math.max(0, Math.min(MAX_SIDE, raw));
  };
  el.addEventListener('pointerdown', (ev) => {
    dragging = true;
    startX = ev.clientX;
    const c = readCols();
    startPct = side === 'left' ? c.left : c.right;
    el.setPointerCapture(ev.pointerId);
    el.classList.add('dragging');
    document.body.classList.add('colDragging');
    ev.preventDefault();
  });
  el.addEventListener('pointermove', (ev) => {
    if (!dragging) return;
    const pct = pctOfDrag(ev.clientX);
    // live preview; below the minimum the side visually collapses
    const shown = pct < MIN_SIDE ? 0 : pct;
    const c = readCols();
    const root = document.documentElement.style;
    if (side === 'left') {
      root.setProperty('--left', shown + 'fr');
      root.setProperty('--center', (100 - shown - (c.right < MIN_SIDE ? 0 : c.right)) + 'fr');
    } else {
      root.setProperty('--right', shown + 'fr');
      root.setProperty('--center', (100 - shown - (c.left < MIN_SIDE ? 0 : c.left)) + 'fr');
    }
  });
  const finish = (ev: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    el.classList.remove('dragging');
    document.body.classList.remove('colDragging');
    try { el.releasePointerCapture(ev.pointerId); } catch { /* already released */ }
    const pct = pctOfDrag(ev.clientX);
    // below 15% → snap shut (hidden), otherwise keep the dragged width
    const value = pct < MIN_SIDE ? 0 : Math.round(pct);
    const c = readCols();
    if (side === 'left') saveCols(value, c.right);
    else saveCols(c.left, value);
  };
  el.addEventListener('pointerup', finish);
  el.addEventListener('pointercancel', finish);
  // double click = reset that side to 25%
  el.addEventListener('dblclick', () => setSide(side, true));
}

/**
 * Switch the tab of ONE column. The two columns have independent tab sets
 * (left: 全文搜尋 / token; right: 目錄 / META / 容量 / 文件 / 圖片), so the tab
 * name alone is ambiguous and a column selector is required.
 */
function showTab(name: string, col: 'left' | 'right' = 'left') {
  const root = col === 'left' ? $('#colLeft') : $('#colRight');
  if (!root) return;
  // A tab this database does not declare (e.g. 頻次 when there is no `s="*u=…"`
  // tree) is hidden and must never become the active pane.
  const btn = root.querySelector<HTMLElement>(`.tabBtn[data-tab="${name}"]`);
  if (btn && (btn.hidden || getComputedStyle(btn).display === 'none')) return;
  root.querySelectorAll('.tabBtn').forEach((b) => b.classList.toggle('active', (b as HTMLElement).dataset.tab === name));
  root.querySelectorAll('.tabPane').forEach((p) => p.classList.toggle('active', (p as HTMLElement).dataset.tab === name));
  if (col === 'right' && dirTrees.length) void renderDirTree();   // built lazily
  // left panes are built on demand: each one walks its own tree/attribute table
  if (col === 'left') {
    if (name === 'freq') void renderFreq();
    else if (name === 'terms') void renderTerms();
    else if (name === 'folio') void renderFolio();
    else if (name === 'latin') void renderLatin();
  }
}

// ------------------------------------------------------------------ advanced mode
/**
 * Advanced mode reveals the token browser (left) and everything except the
 * directory (right). The default is the reader's view: search summaries, the
 * document, and this database's default directory tree.
 */
const ADV_KEY = 'adbview.advanced';

let advanced = false;

function readAdvanced(): boolean {
  return localStorage.getItem(ADV_KEY) === '1';
}

/** The left tab a reader lands on: the first shown tab that is not 進階-only. */
function defaultLeftTab(): string {
  const btns = [...document.querySelectorAll<HTMLElement>('#colLeft .tabBtn')];
  const first = btns.find((b) => getComputedStyle(b).display !== 'none' && !b.classList.contains('advOnly'));
  return first?.dataset.tab ?? 'dir';
}

function setAdvanced(on: boolean) {
  advanced = on;
  localStorage.setItem(ADV_KEY, on ? '1' : '0');
  document.body.classList.toggle('advanced', on);
  const btn = $('#advToggle') as HTMLButtonElement | null;
  if (btn) {
    // icon-only button: the state is the styling, the meaning is the tooltip
    btn.classList.toggle('on', on);
    btn.title = on
      ? '進階模式（開）：token 瀏覽與檔案資訊分頁已顯示'
      : '進階模式（關）：只顯示搜尋摘要與目錄';
  }
  // leave a tab that is no longer available. The advanced-only tabs (token, META,
  // 容量, 文件, 圖片) disappear with the mode, and a database without `s="*"` has no
  // 目錄 at all (fgdict lands on 名詞) — so the fallback is the database's own first
  // reader-facing tab, not a hard-coded 'dir'.
  if (!on) {
    const activeLeft = $('#colLeft .tabBtn.active') as HTMLElement | null;
    if (!activeLeft || getComputedStyle(activeLeft).display === 'none') showTab(defaultLeftTab(), 'left');
    if (!$('#colRight .tabPane.active')?.getAttribute('data-tab')?.includes('sum')) showTab('sum', 'right');
  }
}

function boot() {
  applyCols();
  attachSplitter($('#splitLeft'), 'left');
  attachSplitter($('#splitRight'), 'right');
  $('#toggleLeft').onclick = () => toggleSide('left');
  $('#toggleRight').onclick = () => toggleSide('right');
  ($('#advToggle') as HTMLButtonElement).onclick = () => setAdvanced(!advanced);
  // 🪾 left of the 文件內容 title: only on demand does the tree open up to the node
  // the document pane is sitting on, and scroll it into view
  const treeReveal = $('#treeReveal') as HTMLButtonElement | null;
  if (treeReveal) treeReveal.onclick = () => { void revealCursorInTree(); };
  setAdvanced(readAdvanced());
  window.addEventListener('resize', applyCols);

  // document font size
  setDocFont(readDocFont());
  $('#fsUp').onclick = () => setDocFont(readDocFont() + 2);
  $('#fsDown').onclick = () => setDocFont(readDocFont() - 2);
  $('#fsReset').onclick = () => setDocFont(DOCFS_DEFAULT);
  $('#fsAuto').onclick = () => {
    const size = autoFitFont();
    setStatus(`自動字級：${size}px（讓 90% 的行不軟換行）`, 'info');
  };

  // opening another database: the file picker before the first one, the Chinese
  // name button afterwards
  const fileInput = $('#file') as HTMLInputElement;
  fileInput.onchange = () => { const f = fileInput.files?.[0]; if (f) void openFile(f); };
  ($('#dbname') as HTMLButtonElement).onclick = () => {
    fileInput.value = '';
    fileInput.click();
  };

  // live search: re-run on every keystroke (posting lists are cached per token)
  const query = $('#query') as HTMLInputElement;
  let timer: number | undefined;
  query.oninput = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void runSearch(query.value), 120);
  };
  query.onkeydown = (ev) => {
    if (ev.key === 'Enter') { window.clearTimeout(timer); void runSearch(query.value); }
    if (ev.key === 'Escape') { query.value = ''; void runSearch(''); }
  };
  $('#queryClear').onclick = () => { query.value = ''; void runSearch(''); query.focus(); };
  $('#searchList').addEventListener('scroll', (ev) => {
    const el = ev.target as HTMLElement;
    if (!lastResult) return;
    const pool = snippetScope
      ? lastResult.hits.filter((h) => h.va >= snippetScope!.realm.from && h.va < snippetScope!.realm.to).length
      : lastResult.hits.length;
    if (el.scrollTop + el.clientHeight > el.scrollHeight - 200 && snippetShown < pool) showMoreSnippets();
  });

  // 頻次 and 西文 have their OWN inputs (the two panes are independent searches);
  // both re-render on input, with the same small debounce as the 目錄 box.
  const wireOwnSearch = (inputSel: string, clearSel: string, run: () => void) => {
    const input = $(inputSel) as HTMLInputElement | null;
    if (!input) return;
    let t: number | undefined;
    input.oninput = () => {
      window.clearTimeout(t);
      t = window.setTimeout(run, 120);
    };
    input.onkeydown = (ev) => {
      if (ev.key === 'Enter') { window.clearTimeout(t); run(); }
      if (ev.key === 'Escape') { input.value = ''; run(); }
    };
    const clear = $(clearSel) as HTMLButtonElement | null;
    if (clear) clear.onclick = () => { input.value = ''; run(); input.focus(); };
  };
  wireOwnSearch('#freqQuery', '#freqClear', () => void renderFreq());
  wireOwnSearch('#latinQuery', '#latinClear', () => void renderLatin());
  wireOwnSearch('#termsQuery', '#termsClear', () => void renderTerms());
  wireOwnSearch('#folioQuery', '#folioClear', () => void renderFolio());
  const termsMode = $('#termsMode') as HTMLSelectElement | null;
  if (termsMode) termsMode.onchange = () => void renderTerms();

  // every left pane is built on demand — showTab() dispatches to its renderer
  $('#colLeft').querySelectorAll<HTMLElement>('.tabBtn').forEach((b) => {
    b.onclick = () => showTab(b.dataset.tab!, 'left');
  });
  $('#colRight').querySelectorAll<HTMLElement>('.tabBtn').forEach((b) => { b.onclick = () => showTab(b.dataset.tab!, 'right'); });
  showTab('dir', 'left');
  showTab('dir', 'left');          // 目錄：搜尋 + 目錄樹

  $('#tokenRows')?.addEventListener('scroll', (ev) => {
    const el = ev.target as HTMLElement;
    if (el.scrollTop + el.clientHeight > el.scrollHeight - 300 && tokenOffset < tokenList.length) appendTokenRows();
  });
  const drop = document.body;
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('dragging'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('dragging'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('dragging');
    const f = e.dataTransfer?.files?.[0];
    if (f) void openFile(f);
  });
  setStatus('請選擇或拖入 .adb 檔案（13j / yinshun 皆可直接開啟）', 'info');
  installDebugApi();
}

document.addEventListener('DOMContentLoaded', boot);

/** Test seam: the same functions the UI calls, reachable from DevTools. */
export function installDebugApi(): void {
(window as unknown as Record<string, unknown>).__adbview = {
  openFile, showLine, showToken, revealHit, vapaProbe, showTab, toggleSide,
  setSide, resetCols: () => saveCols(DEFAULT_COLS.left, DEFAULT_COLS.right),
  setCols: (left: number, right: number) => saveCols(left, right),
  cols: () => ({ ...readCols(), css: {
    left: document.documentElement.style.getPropertyValue('--left'),
    center: document.documentElement.style.getPropertyValue('--center'),
    right: document.documentElement.style.getPropertyValue('--right'),
  } }),
  status: () => $('#status').textContent,
  setDocFont, autoFitFont, docFont: () => readDocFont(),
  setAdvanced, isAdvanced: () => advanced,
  openBreakdown: () => lastOpen,
  /** diagnostics: what a tree tier instance looks like at its VA */
  treeDebug: async (va: number) => {
    const el = await mapper!.elementAt(va);
    return el ? { kind: el.element.kind, text: el.element.text, tag: el.element.tag } : null;
  },
  treeTrace: () => (loadTree as unknown as { trace?: string[] }).trace ?? null,
  /** diagnostics for the "no wrapping" calculation */
  fitDebug: fitDebugInfo,
  /** diagnostics: what the painter would mark for the pinned hit */
  pinnedSpans: async () => (pinnedHit && mapper ? mapper.phraseSpans(pinnedHit.va, pinnedHit.units) : null),
  debugDoc: () => {
    const body = document.querySelector<HTMLElement>('#docText .docBody');
    return {
      rows: document.querySelectorAll('#docText .docLine').length,
      ids: [...document.querySelectorAll('#docText .docLine')].map((x) => x.id).join(','),
      markLines: [...document.querySelectorAll('#docText mark.docHit')].map((m) => m.closest('.docLine')?.id).join(','),
      clientWidth: body?.clientWidth ?? 0,
      scrollWidth: body?.scrollWidth ?? 0,
      longestLine: Math.max(0, ...lastDocLines.map((l) => l.length)),
      sample: lastDocLines.length,
    };
  },
  state: () => ({
    db: reader?.header.dbname ?? null,
    tokens: tokens.length,
    docs: docs.length,
    listed: tokenList.length,
    pinned: pinnedHit,
    lastReveal,
    docFont: readDocFont(),
    advanced,
    rightTab: $('#colRight .tabBtn.active')?.getAttribute('data-tab') ?? null,
    leftTab: $('#colLeft .tabBtn.active')?.getAttribute('data-tab') ?? null,
    treePhases,
    dirActive,
    dirRows: document.querySelectorAll('#dirTree .tRow').length,
    // the middle pane: one entry per linked node (Ctrl+click opens another)
    docTab: docActive,
    docTabs: docTabs.map((t) => ({
      name: t.name, from: t.realm.from, to: t.realm.to, page: t.page,
      pagelines: t.cache?.dt?.lines.length ?? 0,
    })),
    docPage: docSession() ? docSession()!.page + 1 : 0,
    docPages: docSession() ? pageBounds(docSession()!.realm, docSession()!.page).pages : 0,
    docTabPages: docSession() ? boundsOfRealm(docSession()!.realm).pages : 0,
    docPageLines: docSession()?.cache?.dt?.lines.length ?? 0,
    docRealm: docSession()?.realm ?? null,
    pagerHidden: ($('#docPager') as HTMLElement | null)?.hidden ?? null,
    docStrip: document.querySelectorAll('#docTabStrip .docTab').length,
    snippetScope: snippetScope ? { from: snippetScope.realm.from, to: snippetScope.realm.to, label: snippetScope.label } : null,
    lastLink,
    pagerLog: pagerLog.slice(-4),
    cursorNode: cursorNode ? { va: cursorNode.va, tag: cursorNode.tag, name: nodeLabelOf(cursorNode) } : null,
    textCache: reader ? reader.textCacheSize : 0,
    lastFit,
    dirOpen: dirTrees[dirActive] ? dirTrees[dirActive].open.size : 0,
    scopes: dirTrees.map((d) => d.tree.scope),
    freqHidden: ($('#colLeft .tabBtn[data-tab="freq"]') as HTMLButtonElement | null)?.hidden ?? null,
    dirInfo: dirTrees[dirActive]
      ? {
        tiers: dirTrees[dirActive].tree.tiers,
        scope: dirTrees[dirActive].tree.scope,
        nodes: dirTrees[dirActive].nodes,
        roots: dirTrees[dirActive].roots.length,
        firstRoot: {
          tag: dirTrees[dirActive].roots[0]?.tag,
          va: dirTrees[dirActive].roots[0]?.va,
          kids: dirTrees[dirActive].roots[0]?.children.length,
        },
        kidsTotal: dirTrees[dirActive].roots.reduce((a, r) => a + r.children.length, 0),
      }
      : null,
    dirError,
    dirLoading,
    marks: document.querySelectorAll('#docText mark.docHit').length,
    docRows: document.querySelectorAll('#docText .docLine').length,
    classes: reader ? reader.classStats() : null,
    mapper: mapper ? mapper.progress : null,
    cols: readCols(),
    tab: document.querySelector('.tabBtn.active')?.getAttribute('data-tab') ?? null,
  }),
};
}

import { loadTree } from './search';

export { ADV_KEY, COLS_KEY, DEFAULT_COLS, MAX_SIDE, MIN_SIDE, advanced, applyCols, attachSplitter, boot, defaultLeftTab, readAdvanced, readCols, saveCols, setAdvanced, setSide, showTab, toggleSide };
