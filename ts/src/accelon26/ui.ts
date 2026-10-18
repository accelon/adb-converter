/**
 * 版面與 wiring：欄寬、分隔線、分頁切換、進階模式、boot。
 *
 * Split out of viewer.ts (ACCELON26-HANDOVER 3.2). Shared state is read from
 * ./viewer and the other split modules as ESM live bindings; a module OWNS the
 * state it declares, and other modules get/set it through that module's exports.
 */
import { $, docs, fmtInt, lastOpen, mapper, openFile, opening, reader, setStatus, tokens, statusText } from './viewer';
import { type AdbSource } from './adb';
import { DOCFS_DEFAULT, applySideFonts, autoFitFont, boundsOfRealm, docActive, docSession, docTabs, ensurePage, fitDebugInfo, hardBreaksOn, lastDocLines, lastFit, lastLink, pageBounds, pagerLog, readDocFont, readSideFont, pageMarksOn, renderDocTabs, renderRawOn, rerenderDoc, setDocFont, setHardBreaks, setPageMarks, setRenderRaw, setSideFont, setSimMode, simModeOf, stepFontSize, syncFontButtons } from './doc-pane';
import { renderTextPane } from './text-pane';
import { cursorNode, lastReveal, nodeLabelOf, pinnedHit, revealCursorInTree, revealHit, showLine } from './link';
import { appendTokenRows, renderContainers, renderDocs, renderMeta, renderTokens, showToken, tokenList, tokenOffset, vapaProbe } from './panes';
import { collapseDirTree, dirActive, dirError, dirLoading, dirTrees, renderDirTree, renderFolio, renderFreq, renderLatin, renderTerms, syncTreeTabs, treePhases, growTreeFully } from './scopes';
import { SNIPPET_LIMIT, lastQuery, lastResult, renderSnippets, runSearch, searchSeq, showMoreSnippets, snippetScope, snippetShown } from './summary';
import { backendKind, goQueryCount, lastGoAnswer } from './backend';
import { isDictDb } from './db-kind';
import { closeSearchAll, initSearchAll, openSearchAll, runSearchAll, searchAllState } from './allsearch';
import { dictLookupAt, dictPaneState, initDictPane } from './dict-pane';
import { setDictHooks } from './dict-hooks';
import { initTour, openTourMenu, play as playTour, stopTour, tourState } from './tour';

// -------------------------------------------------------------------- wiring
/**
 * Column widths: default left / middle / right = 25 / 50 / 25 (percent), but the
 * RIGHT column starts hidden — the token pane is only needed once you look
 * something up. Dragging a splitter below MIN_SIDE (15%) hides that side;
 * the header buttons toggle them. Everything is stored in localStorage.
 */
const COLS_KEY = 'accelon26.cols.v2';

const MIN_SIDE = 15;

const MAX_SIDE = 60;

const DEFAULT_COLS = { left: 25, right: 25 };

/** 中間欄的下限；兩側相加超過時按比例縮，免得 grid 出現負的 fr。 */
const CENTER_MIN = 20;

/**
 * 一個側欄的寬度有兩份：現在顯示的（0＝收起）與**上一次顯示時真的用過的寬度**。
 * 作者 2026-10：按 ◧／◨ 收起再打開要回到「上回調整的寬度」，不是回到 25% 預設。
 */
type Cols = { left: number; right: number; last: { left: number; right: number } };

function readCols(): Cols {
  try {
    const raw = JSON.parse(localStorage.getItem(COLS_KEY) ?? '');
    if (typeof raw?.left === 'number' && typeof raw?.right === 'number') {
      // 舊格式（沒有 last）就用存下來的寬度當「上回的寬度」——那正是讀者調過的值
      const shown = (side: 'left' | 'right') =>
        (raw[side] >= MIN_SIDE ? Math.min(MAX_SIDE, raw[side]) : DEFAULT_COLS[side]);
      return {
        left: raw.left,
        right: raw.right,
        last: {
          left: typeof raw?.last?.left === 'number' ? raw.last.left : shown('left'),
          right: typeof raw?.last?.right === 'number' ? raw.last.right : shown('right'),
        },
      };
    }
  } catch { /* fall through to defaults */ }
  return { left: DEFAULT_COLS.left, right: DEFAULT_COLS.right, last: { ...DEFAULT_COLS } };
}

/** 把兩側寬度寫進 CSS 變數（中間欄至少 CENTER_MIN；收起的側欄記 0）。回傳實際生效的值。 */
function layoutCols(left: number, right: number) {
  let l = left < MIN_SIDE ? 0 : left;
  let r = right < MIN_SIDE ? 0 : right;
  const room = 100 - CENTER_MIN;
  if (l + r > room && l + r > 0) {
    const k = room / (l + r);
    l = Math.floor(l * k);
    r = Math.floor(r * k);
  }
  const root = document.documentElement.style;
  root.setProperty('--left', l + 'fr');
  root.setProperty('--right', r + 'fr');
  root.setProperty('--center', (100 - l - r) + 'fr');
  ($('#toggleLeft') as HTMLButtonElement).classList.toggle('off', l === 0);
  ($('#toggleRight') as HTMLButtonElement).classList.toggle('off', r === 0);
  return { l, r };
}

function applyCols() {
  // persist on first run so the setting exists even before the user drags
  if (localStorage.getItem(COLS_KEY) === null) {
    localStorage.setItem(COLS_KEY, JSON.stringify({ ...DEFAULT_COLS, last: { ...DEFAULT_COLS } }));
  }
  const { left, right } = readCols();
  layoutCols(left, right);
}

function saveCols(left: number, right: number) {
  // anything below the minimum is stored as 0, i.e. hidden — so the persisted
  // state and the rendered state always agree
  const norm = (v: number) => (v < MIN_SIDE ? 0 : Math.min(MAX_SIDE, v));
  const l = norm(left);
  const r = norm(right);
  // 0 不代表「讀者要的寬度是 0」：收起時保留上一次顯示的寬度，打開才回得去
  const prev = readCols();
  const last = { left: l || prev.last.left, right: r || prev.last.right };
  localStorage.setItem(COLS_KEY, JSON.stringify({ left: l, right: r, last }));
  applyCols();
}

function setSide(side: 'left' | 'right', visible: boolean) {
  const c = readCols();
  if (visible) {
    // 顯示時回到「上回調整的寬度」（作者 2026-10），沒有記錄才用預設
    const shown = Math.min(MAX_SIDE, Math.max(MIN_SIDE, c.last[side] || DEFAULT_COLS[side]));
    if (side === 'left') c.left = shown;
    else c.right = shown;
  } else if (side === 'left') c.left = 0;
  else c.right = 0;
  saveCols(c.left, c.right);
}

/** 雙擊分隔線＝那一側回到預設寬度（不是回到上回的寬度）。 */
function resetSide(side: 'left' | 'right') {
  const c = readCols();
  if (side === 'left') saveCols(DEFAULT_COLS.left, c.right);
  else saveCols(c.left, DEFAULT_COLS.right);
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
    if (side === 'left') layoutCols(shown, c.right);
    else layoutCols(c.left, shown);
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
    // 存「實際畫出來的」寬度：中間欄的 20% 下限可能把拖曳值縮小，兩者不能走鐘
    const eff = layoutCols(side === 'left' ? value : c.left, side === 'left' ? c.right : value);
    saveCols(eff.l, eff.r);
  };
  el.addEventListener('pointerup', finish);
  el.addEventListener('pointercancel', finish);
  // double click = reset that side to the default width (NOT the last width)
  el.addEventListener('dblclick', () => resetSide(side));
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
  // the right column's 文字內容 pane draws itself (text-pane owns that rendering)
  if (col === 'right' && name === 'text') void renderTextPane();
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
const ADV_KEY = 'accelon26.advanced';

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

/**
 * 繁簡通檢（作者 2026-10）：**系統級**開關，對所有 adb 生效（存 localStorage）。
 * 開著時，查詢的每個漢字都會換成它那一組的所有寫法（繁／簡／異體），
 * posting 取聯集 —— 見 `variants.ts` 與 `SearchSession.lookup()`。
 */
const VAR_KEY = 'accelon26.variants';

function readVariants(): boolean {
  return localStorage.getItem(VAR_KEY) === '1';
}

function setVariants(on: boolean) {
  setVariantSearch(on);
  localStorage.setItem(VAR_KEY, on ? '1' : '0');
  updateSettingsUi();
  // 已經有查詢就重跑一次，讓讀者立刻看到差別（沒有查詢就只更新開關）
  if (lastQuery) void runSearch(lastQuery);
  const lt = $('#colLeft .tabBtn.active') as HTMLElement | null;
  if (lt && !lt.hidden) showTab(lt.dataset.tab!, 'left');
}

/** 開機時只還原設定，不重跑查詢 */
function initVariants(): void {
  setVariantSearch(readVariants());
  updateSettingsUi();
}

function toggleVariants(): boolean {
  setVariants(!variantSearchOn());
  return variantSearchOn();
}

// ---------------------------------------------------------------- 設置（齒輪）
/**
 * 設置彈窗（作者 2026-10）：原本的 🧑‍💻 與「繁簡」按鈕都收進來。
 *
 * 三組設定都立即生效（存在 localStorage）：
 *   介面   —— 進階模式（token 瀏覽／META 等分頁）
 *   繁簡   —— 輸入通檢（查詢時把各寫法合併）、文字顯示（原樣／無損簡體／強制簡體）
 */
let settingsOpen = false;

export function settingsState(): { open: boolean; advanced: boolean; variants: boolean; simMode: number } {
  return { open: settingsOpen, advanced, variants: variantSearchOn(), simMode: simModeOf() };
}

/**
 * 文字顯示的範例（作者 2026-10）：三種模式各列一行、逐字比較，
 * **不一樣的字**用黃色底線標出來，讓「無損」與「強制」的差別一眼看見；
 * 目前選的那一列會突顯，切換設定時立刻重畫。
 */
const SIM_DEMO = '王后與後代，頭髮乾燥，臺灣的醫生後來又發心。';

function escapeDemo(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderSimDemo(mode: 0 | 1 | 2): void {
  const box = $('#simDemo');
  if (!box) return;
  const labels = ['保持原樣', '無損簡體', '強制簡體'];
  const texts = [0, 1, 2].map((m) => toSimplified(SIM_DEMO, m as 0 | 1 | 2));
  const base = [...texts[0]];
  box.innerHTML = texts.map((text, m) => {
    const chars = [...text].map((ch, i) => (ch === base[i] ? escapeDemo(ch) : `<em>${escapeDemo(ch)}</em>`)).join('');
    return `<div class="simRow${m === mode ? ' active' : ''}" data-mode="${m}">`
      + `<span class="simLabel">${labels[m]}</span><span class="simText">${chars}</span></div>`;
  }).join('');
}

/** 把目前設定反映到彈窗（也順便更新齒輪的提示狀態） */
function updateSettingsUi(): void {
  const adv = $('#setAdvanced') as HTMLInputElement | null;
  if (adv) adv.checked = advanced;
  const v = $('#setVariants') as HTMLInputElement | null;
  if (v) v.checked = variantSearchOn();
  const pm = $('#setPageMarks') as HTMLInputElement | null;
  if (pm) pm.checked = pageMarksOn();
  const mode = simModeOf();
  document.querySelectorAll<HTMLElement>('#simSeg button').forEach((b) => {
    b.classList.toggle('active', Number(b.dataset.mode) === mode);
  });
  renderSimDemo(mode);
  const stats = $('#setStats');
  if (stats) {
    const st = simplifiedStats();
    const label = mode === 0 ? '原樣' : mode === 1 ? '無損簡體' : '強制簡體';
    stats.textContent = `文字顯示：${label}（表 ${mode === 1 ? st.safe : st.force} 組）`;
  }
  const btn = $('#settingsBtn') as HTMLButtonElement | null;
  if (btn) {
    const custom = advanced || variantSearchOn() || simModeOf() !== 0;
    btn.classList.toggle('on', custom);
    btn.title = custom ? '設置（有不是預設的設定）' : '設置（進階模式、繁簡通檢、文字顯示）';
  }
}

function showSettings(open: boolean): void {
  settingsOpen = open;
  const box = $('#settingsBox') as HTMLElement | null;
  const back = $('#settingsBackdrop') as HTMLElement | null;
  if (box) box.hidden = !open;
  if (back) back.hidden = !open;
  if (open) updateSettingsUi();
}

export function openSettings(): void {
  showSettings(true);
  ($('#settingsClose') as HTMLElement | null)?.focus();
}

export function closeSettings(): void {
  showSettings(false);
}

function initSettings(): void {
  ($('#settingsBtn') as HTMLButtonElement | null)?.addEventListener('click', () => openSettings());
  ($('#settingsClose') as HTMLElement | null)?.addEventListener('click', () => closeSettings());
  ($('#settingsDone') as HTMLElement | null)?.addEventListener('click', () => closeSettings());
  ($('#settingsBackdrop') as HTMLElement | null)?.addEventListener('click', () => closeSettings());
  ($('#setAdvanced') as HTMLInputElement | null)?.addEventListener('change', (ev) => {
    setAdvanced((ev.target as HTMLInputElement).checked);
  });
  ($('#setVariants') as HTMLInputElement | null)?.addEventListener('change', (ev) => {
    setVariants((ev.target as HTMLInputElement).checked);
  });
  // 顯示原書頁碼（作者 2026-10）：`<頁>`／`<_頁>` 要不要渲染
  ($('#setPageMarks') as HTMLInputElement | null)?.addEventListener('change', (ev) => {
    const on = (ev.target as HTMLInputElement).checked;
    setPageMarks(on);
    rerenderDoc();
    void renderTextPane();
    updateSettingsUi();
    setStatus(on ? '顯示原書頁碼：開' : '顯示原書頁碼：關（不渲染 <頁>／<_頁>）', 'info');
  });
  document.querySelectorAll<HTMLElement>('#simSeg button').forEach((b) => {
    b.addEventListener('click', () => setSimDisplay(Number(b.dataset.mode) as 0 | 1 | 2));
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && settingsOpen) { ev.stopPropagation(); closeSettings(); }
  }, true);
  updateSettingsUi();
}

/** 文字顯示三態：0 原樣、1 無損簡體、2 強制簡體（只影響畫面，不影響搜尋） */
function setSimDisplay(mode: 0 | 1 | 2): void {
  setSimMode(mode);
  updateSettingsUi();
  rerenderDoc();
  void renderTextPane();
  setStatus(mode === 0 ? '文字顯示：保持原樣' : mode === 1 ? '文字顯示：無損簡體（合併字保留原樣）' : '文字顯示：強制簡體', 'info');
}

function setAdvanced(on: boolean) {
  advanced = on;
  localStorage.setItem(ADV_KEY, on ? '1' : '0');
  document.body.classList.toggle('advanced', on);
  updateSettingsUi();
  // leave a tab that is no longer available. The advanced-only tabs (token, META,
  // 容量, 文件, 圖片) disappear with the mode, and a database without `s="*"` has no
  // 目錄 at all (fgdict lands on 名詞) — so the fallback is the database's own first
  // reader-facing tab, not a hard-coded 'dir'.
  if (!on) {
    const activeLeft = $('#colLeft .tabBtn.active') as HTMLElement | null;
    if (!activeLeft || getComputedStyle(activeLeft).display === 'none') showTab(defaultLeftTab(), 'left');
    if (!$('#colRight .tabPane.active')?.getAttribute('data-tab')?.includes('sum')) showTab('sum', 'right');
  }
  // 目錄的 meta 列只在進階模式顯示（作者 2026-10）：正在看目錄就重畫一次
  const dirBtn = $('#colLeft .tabBtn[data-tab="dir"]') as HTMLElement | null;
  if (dirBtn && !dirBtn.hidden && dirBtn.classList.contains('active')) void renderDirTree();
}

/** identity of a pick, used to recognise the SAME pick fired twice */
const pickSig = (fs: AdbSource[]) => fs.map((f) => f.name + ':' + f.size + ':' + f.lastModified).join('|');
let picking: AdbSource[] | null = null;     // the pick currently loading, if any
let queuedPick: AdbSource[] | null = null;  // a genuinely new pick that arrived meanwhile

/**
 * Take a pick: every file enters the dropdown's catalogue (header read only) and the
 * ones that fit are loaded right away.
 *
 * The file input fires `change` twice for one pick (and the browser tests dispatch
 * one more). Running the list twice would race itself: the second run sees
 * `openFile() === 'busy'` for everything. So a pick that is still on the way in is
 * remembered, and the same pick is ignored.
 */
async function openPicked(files: AdbSource[]): Promise<void> {
  if (picking) {
    if (files.length === picking.length && pickSig(files) === pickSig(picking)) return;
    queuedPick = files;      // a real second pick: run it once this one settles
    return;
  }
  picking = files;
  try {
    // Every picked file goes into the dropdown's catalogue (header read only). The ones
    // that fit are loaded right away; the rest wait there for the reader to choose —
    // choosing one then evicts the least recently used database (author 2026-10).
    for (const f of files) await catalogAddFile(f);
    // ONE file = the reader wants to see it now: it opens even when five are already
    // open (the least recently used gives way). A multi-file pick loads while there is
    // room and leaves the rest in the dropdown.
    const always = files.length === 1;
    for (const f of files) {
      if (!always && openDbs.length >= MAX_DBS) break;
      const r = await openFile(f);
      dbLog.push('pick ' + f.name + ' -> ' + r);
      if (dbLog.length > 40) dbLog.shift();
    }
  } finally {
    picking = null;
  }
  const next = queuedPick;
  queuedPick = null;
  if (next) await openPicked(next);
}

/**
 * Desktop build only: the exe lists every .adb in its working directory (the host
 * reads just the headers) and opens the first one. On `file://` this is a no-op, so
 * one page serves both builds.
 */
async function bootDesktop(): Promise<void> {
  // 左上角：桌面版顯示建置時間（hover hint），有新版本時閃動、點擊更新，更新後顯示改版說明。
  // 網頁版沒有宿主，initDesktopBrand 直接返回（左上角就只是一行標題）。
  void initDesktopBrand((msg, kind) => setStatus(msg, kind ?? 'info'));
  void initDesktopWindowKeys();   // F11 全螢幕／Esc 回視窗（全螢幕時沒有標題列）
  const srcs = await desktopSources();
  if (!srcs.length) return;
  for (const s of srcs) catalogAdd(s, s.name);
  renderDbPick();
  if (!openDbs.length) await openPicked([srcs[0]]);
}

/**
 * 「操作導覽」可以做的事（作者 2026-10）。
 *
 * 播放器（tour.ts）**刻意不 import 這一支**：它只認得這個介面，所以不會有
 * ui → tour → ui 的循環，也不會為了加一個導覽動作就要改播放器。劇本裡能用的
 * 動作就是在這裡註冊的這些（`tools/build-tours.ts` 也照同一份名字做靜態檢查）。
 */
const TOUR_APP = {
  tab: (col: 'L' | 'R', name: string) => showTab(name, col === 'L' ? 'left' : 'right'),
  side: (col: 'L' | 'R', on: boolean) => setSide(col === 'L' ? 'left' : 'right', on),
  set: (key: string, value: string): boolean => {
    const on = value === '1' || value === 'on' || value === 'true' || value === '開';
    const box = (id: string, v: boolean) => {
      const e = document.getElementById(id) as HTMLInputElement | null;
      if (e) e.checked = v;
    };
    switch (key) {
      case 'advanced': setAdvanced(on); return true;
      case 'variants': setVariants(on); return true;
      case 'pagemarks': setPageMarks(on); box('setPageMarks', on); rerenderDoc(); void renderTextPane(); return true;
      case 'hardbreaks': setHardBreaks(on); box('showHardBreaks', on); rerenderDoc(); void renderTextPane(); return true;
      case 'raw': setRenderRaw(on); box('showRaw', on); rerenderDoc(); void renderTextPane(); return true;
      case 'simmode': setSimDisplay(Math.max(0, Math.min(2, Number(value) || 0)) as 0 | 1 | 2); return true;
      default: return false;
    }
  },
  call: async (name: string, arg: string): Promise<unknown> => {
    switch (name) {
      case 'openSettings': openSettings(); return true;
      case 'closeSettings': closeSettings(); return true;
      case 'openSearchAll': openSearchAll(); return true;
      case 'closeSearchAll': closeSearchAll(); return true;
      case 'openAbout': void openAbout(); return true;
      case 'runSearchAll': await runSearchAll(arg); return true;
      case 'dictLookup': await dictLookupAt(arg); return true;
      case 'search': await runSearch(arg); return true;
      default: return false;
    }
  },
  // `api:` 條件讀 state()；這是測試／診斷用的同一份快照，不是第二套狀態
  state: (): Record<string, unknown> => {
    const api = (window as unknown as { __accelon26?: { state?: () => Record<string, unknown> } }).__accelon26;
    return api?.state?.() ?? {};
  },
};

function boot() {
  applyCols();
  attachSplitter($('#splitLeft'), 'left');
  attachSplitter($('#splitRight'), 'right');
  $('#toggleLeft').onclick = () => toggleSide('left');
  $('#toggleRight').onclick = () => toggleSide('right');
  // 設置（齒輪）：進階模式、繁簡通檢、文字顯示
  initVariants();
  initSettings();
  // 搜尋所有 adb（放大鏡，作者 2026-10）
  initSearchAll();
  // 右欄「詞典」分頁：點本文就查詞條（作者 2026-10）
  initDictPane();
  setDictHooks.current = () => { setSide('right', true); showTab('dict', 'right'); };
  // 操作導覽（🎬）：劇本 → 宏 → 播放器，見 tour.ts 與 ts/tour/*.tour
  initTour(TOUR_APP);
  // 軟件說明（About）：點左上角 accelon26 開啟，順便檢查更新
  initAbout();
  // 🪾 left of the 文件內容 title: only on demand does the tree open up to the node
  // the document pane is sitting on, and scroll it into view
  const treeReveal = $('#treeReveal') as HTMLButtonElement | null;
  if (treeReveal) treeReveal.onclick = () => { void revealCursorInTree(); };
  setAdvanced(readAdvanced());
  window.addEventListener('resize', applyCols);

  // 字級：三顆按鈕（正文／左欄／右欄）——點一下 +2px、Alt+點 −2px（作者 2026-10）
  applySideFonts();
  setDocFont(readDocFont());                  // 套用儲存的字級，也同步按鈕提示
  const wireFontButton = (id: string, kind: 'left' | 'body' | 'right') => {
    const btn = document.getElementById(id) as HTMLButtonElement | null;
    if (!btn) return;
    btn.onclick = (ev) => {
      const px = stepFontSize(kind, ev.altKey);
      setStatus(`${id === 'fsBodyPick' ? '正文' : id === 'fsLeftPick' ? '左欄' : '右欄'}字級 ${px}px`, 'info');
    };
  };
  wireFontButton('fsBodyPick', 'body');
  wireFontButton('fsLeftPick', 'left');
  wireFontButton('fsRightPick', 'right');
  syncFontButtons();
  // 「原書分行」：保留原書的硬換行（預設開）；取消＝文字連著排、<頁> 變成行內頁碼
  const showHardBreaks = $('#showHardBreaks') as HTMLInputElement;
  showHardBreaks.checked = hardBreaksOn();
  showHardBreaks.onchange = () => {
    setHardBreaks(showHardBreaks.checked);
    rerenderDoc();
    void renderTextPane();
    setStatus(showHardBreaks.checked ? '原書分行：保留原書的硬換行' : '原書分行：關閉（文字連著排，只有標題與空行換段）', 'info');
  };
  // 「顯示原始文件」（進階模式）：打開＝不渲染，預設關閉＝渲染成 HTML
  const showRaw = $('#showRaw') as HTMLInputElement;
  showRaw.checked = renderRawOn();
  showRaw.onchange = () => {
    setRenderRaw(showRaw.checked);
    rerenderDoc();
    void renderTextPane();
    setStatus(showRaw.checked ? '顯示原始文件（不渲染標籤）' : '渲染標籤（預設）', 'info');
  };  // 「不換行（自動字級）」按鈕已移除（作者 2026-10：讓讀者自己用上面的下拉調整字級）。
  // autoFitFont() 仍留在 `window.__accelon26` 供診斷使用。

  // opening another database: the file picker before the first one, the Chinese
  // name button afterwards
  const fileInput = $('#file') as HTMLInputElement;
  // The picker accepts several files at once. They are opened one after another (each
  // openFile is async and rewrites the globals), and only the first MAX_DBS that fit are
  // kept — the rest are reported, not silently dropped.
  fileInput.onchange = () => {
    const picked = [...(fileInput.files ?? [])];
    if (picked.length) void openPicked(picked);
  };
  // 「加入 adb」是 adb 下拉（📁）的第一項，由 dbs.ts 的 renderDbPick 產生；
  // header 不再有獨立的 ＋ 按鈕（作者 2026-10）。file:// 版才有這一項，
  // 桌面版啟動時就把工作目錄的 adb 列好了。
  // adb 清單（作者 2026-10）：黃色資料夾按鈕按一下才展開，點空白處收起來
  const pickBtn = $('#dbPickBtn') as HTMLButtonElement | null;
  if (pickBtn) {
    pickBtn.onclick = (ev) => {
      ev.stopPropagation();
      setDbPickOpen();
    };
    document.addEventListener('click', (ev) => {
      if (!dbPickOpen()) return;
      const wrap = document.querySelector('.dbPickWrap');
      if (wrap && !wrap.contains(ev.target as Node)) setDbPickOpen(false);
    });
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && dbPickOpen()) setDbPickOpen(false);
    });
  }
  setDbHooks({ refresh: refreshAll, clear: clearDbUi });

  // live search: re-run on every keystroke (posting lists are cached per token)
  const query = $('#query') as HTMLInputElement;
  let timer: number | undefined;
  query.oninput = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void runSearch(query.value), 120);
  };
  query.onkeydown = (ev) => {
    if (ev.key === 'Enter') { window.clearTimeout(timer); void runSearch(query.value); }
    // Escape must NOT clear the box (author, 2026-10): the ✕ is the way to clear, and
    // Escape is how you leave the field without losing the query. `<input type="search">`
    // clears ITSELF on Escape (Chromium default action), so the event has to be stopped.
    if (ev.key === 'Escape') ev.preventDefault();
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
      // Escape must NOT clear the box (author, 2026-10) — use the ✕. Without
      // preventDefault the `type="search"` field clears itself (Chromium default).
      if (ev.key === 'Escape') ev.preventDefault();
    };
    const clear = $(clearSel) as HTMLButtonElement | null;
    if (clear) clear.onclick = () => { input.value = ''; run(); input.focus(); };
  };
  wireOwnSearch('#freqQuery', '#freqClear', () => void renderFreq());
  wireOwnSearch('#latinQuery', '#latinClear', () => void renderLatin());
  wireOwnSearch('#termsQuery', '#termsClear', () => void renderTerms());
  wireOwnSearch('#folioQuery', '#folioClear', () => void renderFolio());
  const termsMode = $('#termsMode') as HTMLButtonElement | null;
  if (termsMode) {
    // 三態 toggle（作者 2026-10）：開頭 → 中間 → 結尾 → 開頭，不用下拉
    const CYCLE = ['start', 'mid', 'end'];
    const LABEL: Record<string, string> = { start: '開頭', mid: '中間', end: '結尾' };
    const show = () => {
      const m = termsMode.dataset.mode ?? 'start';
      termsMode.textContent = LABEL[m] ?? '開頭';
      termsMode.title = `比對位置：${LABEL[m]}（按一下切換 開頭 → 中間 → 結尾）`;
    };
    show();
    termsMode.onclick = () => {
      const cur = termsMode.dataset.mode ?? 'start';
      const next = CYCLE[(CYCLE.indexOf(cur) + 1) % CYCLE.length];
      termsMode.dataset.mode = next;
      show();
      void renderTerms();
    };
  }
  const latinMode = $('#latinMode') as HTMLSelectElement | null;
  if (latinMode) latinMode.onchange = () => void renderLatin();

  // every left pane is built on demand — showTab() dispatches to its renderer
  $('#colLeft').querySelectorAll<HTMLElement>('.tabBtn').forEach((b) => {
    b.onclick = () => {
      // 再點一次「已經 active」的目錄分頁：把所有子孫收起來，只留第一層
      // （作者 2026-10）。其他分頁再點一次沒有特別行為。
      const again = b.classList.contains('active');
      showTab(b.dataset.tab!, 'left');
      if (again && b.dataset.tab === 'dir') collapseDirTree();
    };
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
  initTextPane();   // Ctrl+點樹節點／本文分頁 → 右欄文字內容
  renderDbPick();   // 下拉第一項是「加入 adb」（file:// 版）
  void bootDesktop();   // desktop build: catalogue + open the adbs next to the exe
  setStatus('請選擇或拖入 .adb 檔案（13j / yinshun 皆可直接開啟）', 'info');
  installDebugApi();
}

document.addEventListener('DOMContentLoaded', boot);

/** Test seam: the same functions the UI calls, reachable from DevTools. */
export function installDebugApi(): void {
(window as unknown as Record<string, unknown>).__accelon26 = {
  openFile, showLine, showToken, revealHit, vapaProbe, showTab, toggleSide,
  setSide, resetCols: () => saveCols(DEFAULT_COLS.left, DEFAULT_COLS.right),
  setCols: (left: number, right: number) => saveCols(left, right),
  /** 繁簡通檢：回傳切換後的值 */
  setVariants, toggleVariants, variantsOn: () => variantSearchOn(),
  /** 顯示原始文件（不渲染）：測試／指令用 */
  setRenderRaw, renderRawOn, rerenderDoc,
  /** 原書分行（保留硬換行／連著排） */
  setHardBreaks, hardBreaksOn,
  /** 顯示原書頁碼（<頁>／<_頁> 要不要渲染） */
  setPageMarks: (on: boolean) => { setPageMarks(on); rerenderDoc(); void renderTextPane(); },
  pageMarksOn,
  /** 設置彈窗 */
  openSettings, closeSettings, settingsState,
  /** 搜尋所有 adb */
  openSearchAll, closeSearchAll, runSearchAll, searchAllState,
  /** 詞典分頁 */
  dictLookupAt, dictPaneState,
  /** 操作導覽（🎬）：劇本 → 宏 → 播放器 */
  openTourMenu, playTour: (id: string, from?: number) => playTour(id, from), stopTour, tourState,
  /** 軟件說明（About） */
  openAbout, closeAbout, aboutState,
  cols: () => ({ ...readCols(), css: {
    left: document.documentElement.style.getPropertyValue('--left'),
    center: document.documentElement.style.getPropertyValue('--center'),
    right: document.documentElement.style.getPropertyValue('--right'),
  } }),
  status: () => statusText(),
  /** mount every 目錄樹 row (rows are mounted lazily; tests assert on the whole tree) */
  growTree: growTreeFully,
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
    dbLog,
    dbs: openDbs.map((d: any) => ({ name: d.name, tabs: d.docPane?.docTabs?.length ?? -1, docs: d.core?.docs?.length ?? -1 })),
    tokens: tokens.length,
    docs: docs.length,
    listed: tokenList.length,
    pinned: pinnedHit,
    lastReveal,
    docFont: readDocFont(),
    advanced,
    rightTab: $('#colRight .tabBtn.active')?.getAttribute('data-tab') ?? null,
    text: textState(),
    catalog: catalogState(),
    host: hostState(),
    hostSearch: lastGoAnswer,   // 桌面版：上一次由 Go 回答的查詢（網頁版 null）
    dbPick: activeCatalogKey(),
    dbPickOpen: dbPickOpen(),
    logo: logoState(),
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
    searchQuery: lastQuery,   // the query that produced lastResult (tests wait on it)
    /** 繁簡通檢是否開著（系統級） */
    variants: variantSearchOn(),
    /** 是否顯示原始文件（進階模式；false＝渲染成 HTML） */
    renderRaw: renderRawOn(),
    /** 原書分行（true＝保留硬換行；false＝文字連著排） */
    hardBreaks: hardBreaksOn(),
    /** 文字顯示：0 原樣、1 無損簡體、2 強制簡體 */
    simMode: simModeOf(),
    /** 後端：'go'（桌面宿主的 wails/query.go）或 'ts'（網頁版自己算） */
    backend: backendKind(reader?.io ?? null),
    /** Go 後端已經回答了幾個查詢（file:// 永遠 0） */
    goQueries: goQueryCount(),
    /** 詞典型 adb（`集 c="isdict"` 或 `$詞` 樹）：本文不顯示 docHead */
    dict: isDictDb(mapper),
    /** 多詞組 + BM25 的診斷（單詞組查詢是 null） */
    multi: lastResult?.multi ? {
      clauses: lastResult.multi.clauses.map((c) => ({
        text: c.text, role: c.role, nearOf: c.nearOf, idf: c.idf, df: c.df,
        occurrences: c.occurrences, colorIndex: c.colorIndex, wildcard: c.wildcard,
      })),
      segments: lastResult.multi.segments,
      hits: lastResult.multi.hits.length,
      truncated: lastResult.multi.truncated,
      docs: lastResult.multi.docCount,
      avgdl: Math.round(lastResult.multi.avgdl),
      ms: Math.round(lastResult.multi.ms),
    } : null,
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

import { MAX_DBS, activeCatalogKey, catalogAdd, catalogAddFile, catalogState, dbLog, dbPickOpen, openDbs, renderDbPick, setDbHooks, setDbPickOpen } from './dbs';
import { initTextPane, renderTextPane, resetTextPane, textState } from './text-pane';
import { hideDocLogo, logoState, updateDocLogo } from './logo';
import { desktopSources, hostState } from './host';
import { setVariantSearch, variantSearchOn } from './variants';
import { aboutState, closeAbout, initAbout, openAbout } from './about';
import { simplifiedStats, toSimplified } from './lossless';
import { initDesktopBrand } from './update-ui';
import { initDesktopWindowKeys } from './window-keys';

export { ADV_KEY, COLS_KEY, DEFAULT_COLS, MAX_SIDE, MIN_SIDE, advanced, applyCols, attachSplitter, boot, defaultLeftTab, readAdvanced, readCols, saveCols, setAdvanced, setSide, showTab, toggleSide };

/**
 * Redraw everything from the (restored) globals — used after switching database.
 * Every pane is re-rendered by its own showTab(), so no state is guessed here.
 */
function refreshAll(): void {
  if (!reader) { clearDbUi(); return; }
  renderMeta(reader, lastOpen?.parseMs ?? 0, 0, 0, 0);
  renderContainers(reader);
  renderDocs();
  renderTokens(reader.classStats(), 0);
  syncTreeTabs();
  void updateDocLogo();          // 本文區還空著就顯示這個庫自己的 logo
  // The tree belongs to the database's state, so it is re-shown after a switch — but only
  // for a database that declares s="*" (renderDirTree clears the box otherwise). Rows are
  // mounted a CHUNK at a time (lazy-list): fgdict's 6,966 rows used to be built
  // synchronously in the switch (measured 390 ms), now only a screenful is.
  void renderDirTree();
  const cur = docSession();
  renderDocTabs(cur);
  if (cur) void ensurePage(cur);
  // The panes redraw THEMSELVES through showTab(), which is also what rebuilds the
  // summary and the tree: rendering them here as well did every expensive thing twice
  // (a full search for 頻次, 22k cached strings for 名詞, the tree rows) on each switch.
  const lt = $('#colLeft .tabBtn.active')?.getAttribute('data-tab');
  if (lt) showTab(lt, 'left');
  else { $('#dirTree').innerHTML = '<p class="dim">此庫沒有左欄分頁。</p>'; }
  const rt = $('#colRight .tabBtn.active')?.getAttribute('data-tab');
  if (rt) showTab(rt, 'right');
  setStatus(`${reader.header.dbcname || reader.header.dbname}：${fmtInt(tokens.length)} 詞、${fmtInt(docs.length)} 文件`, 'info');
}

/** no database left: empty every pane so nothing of the closed file is shown */
function clearDbUi(): void {
  document.body.classList.remove('loaded');
  renderDocs();
  for (const sel of ['#meta', '#containers', '#capacity', '#docs', '#resources', '#dirTree', '#termsList',
    '#freqList', '#folioList', '#latinList', '#searchList', '#tokenRows']) {
    const el = $(sel);
    if (el) el.innerHTML = '<p class="dim">尚未開啟資料庫。</p>';
  }
  resetTextPane();
  $('#docText').innerHTML = '<p class="dim">尚未開啟資料庫。</p>';
  // 關庫：中間的 logo 不可以留著（作者 2026-10）。這裡**不能**再叫 updateDocLogo()：
  // 它會因為 reader 還指著剛關掉的那個庫、而且 #docText 已經沒有 .docLine，又把 logo 打開。
  hideDocLogo();
  renderDocTabs(null);
  ($('#docTabs') as HTMLElement | null)!.hidden = true;
  setStatus('已關閉資料庫', 'info');
}
