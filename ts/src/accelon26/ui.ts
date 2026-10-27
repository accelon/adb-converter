/**
 * 版面與 wiring：欄寬、分隔線、分頁切換、進階模式、boot。
 *
 * Split out of viewer.ts (ACCELON26-HANDOVER 3.2). Shared state is read from
 * ./viewer and the other split modules as ESM live bindings; a module OWNS the
 * state it declares, and other modules get/set it through that module's exports.
 */
import { $, currentFile, docs, fmtInt, lastOpen, mapper, openFile, opening, reader, session, setStatus, tokens, statusText } from './viewer';
import { type AdbSource } from './adb';
import { DOCFS_DEFAULT, applySideFonts, autoFitFont, boundsOfRealm, docActive, docSession, docTabs, ensurePage, enterEdit, exitEdit, fitDebugInfo, flushEdit, hardBreaksOn, lastDocLines, lastFit, lastLink, pageBounds, pagerLog, readDocFont, readSideFont, openHistoryPage, pageMarksOn, rememberDocSelection, renderDoc, renderDocTabs, renderRawOn, rerenderDoc, saveLastReadNow, setDocFont, setHardBreaks, setPageMarks, setRenderRaw, setSideFont, setSimMode, simModeOf, stepFontSize, syncFontButtons } from './doc-pane';
import { renderTextPane } from './text-pane';
import { cursorNode, initEntryLinks, lastReveal, nodeLabelOf, pinnedHit, revealCursorInTree, revealHit, showLine } from './link';
import { initNoteLinks } from './notes';
import { appendTokenRows, renderDocs, renderHeader, renderMeta, renderRevisions, renderTokens, showToken, tokenList, tokenOffset, vapaProbe } from './panes';
import { collapseDirTree, dirActive, dirError, dirLoading, dirTrees, hitTotal, renderDirTree, renderFolio, renderFreq, renderLatin, renderTerms, selectDirTree, selectFreqTree, syncTreeTabs, treePhases, growTreeFully } from './scopes';
import { SNIPPET_LIMIT, lastQuery, lastResult, renderSnippets, runSearch, searchSeq, showMoreSnippets, snippetScope, snippetShown } from './summary';
import { backendKind, goQueryCount, lastGoAnswer } from './backend';
import { isDictDb } from './db-kind';
import { closeSearchAll, initSearchAll, openSearchAll, runSearchAll, searchAllState } from './allsearch';
import { dictLookupAt, dictPaneState, initDictPane } from './dict-pane';
import { listDicts, type DictListEntry } from './dict-lookup';
import { autoDictOn, dictOnlyIsdict, dictOrder, orderByFile, selectionDictOn, setAutoDict, setDictOnlyIsdict, setDictOrder, setSelectionDict } from './dict-settings';
import { setDictHooks } from './dict-hooks';
import { initTour, openTourMenu, play as playTour, startTour, stopTour, tourState } from './tour';
import { toggleInspect } from './inspect';
import { getUserId, setUserId } from './user-id';
import { desktopRevealInFolder, desktopSources } from './host';
import {
  BODY_KEY, GROUP_ID, GROUP_TAGS, STRUCTURAL_TAGS, activeDb, bodyStyleOf, counts as tagStyleCounts,
  defaultFontOf, entryOf, fontFamilyOf, memberIndex, notifyTagStyles, onActiveDbChange,
  onTagStyleChange, rampColor, resetTagStyles, setEntry, type TagStyle,
} from './tag-style';
import {
  exportSettingsFile, importSettingsFile, initSettings as initTagSettings, installedFonts,
  saveSettingsSoon, settingsError, settingsLocation, settingsVersion,
} from './settings';
import { tagChromaIndex } from './render_accelon3';
import type { TreeNode } from './search';

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
  if (col === 'right' && name === 'revisions') void renderRevisions();
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
  const dictAuto = $('#setDictAuto') as HTMLInputElement | null;
  if (dictAuto) dictAuto.checked = autoDictOn();
  const dictSelection = $('#setDictSelection') as HTMLInputElement | null;
  if (dictSelection) dictSelection.checked = selectionDictOn();
  const dictOnly = $('#dictOnlyIsdict') as HTMLInputElement | null;
  if (dictOnly) dictOnly.checked = dictOnlyIsdict();
}

function showSettings(open: boolean): void {
  settingsOpen = open;
  const box = $('#settingsBox') as HTMLElement | null;
  const back = $('#settingsBackdrop') as HTMLElement | null;
  if (box) box.hidden = !open;
  if (back) back.hidden = !open;
  if (open) { updateSettingsUi(); setSettingsPane(settingsPane); }
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
  wireTagStyle();
}

/* ================================================================== 標籤樣式（作者 2026-10-22）
 *
 * 設置 → 標籤樣式：全域／此資料庫、每個標籤的顏色／大小／字型、天干地支 22 層，
 * 以及 settings.json 的位置與匯出／匯入。資料模型在 tag-style.ts、讀寫在 settings.ts；
 * 這裡只做 DOM 與事件。
 */

type TagScope = 'global' | 'adb';
let settingsPane = 'ui';
let tagScope: TagScope = 'adb';
let tagFonts: [string, string][] | null = null;
let tagFontSource: 'desktop' | 'builtin' | null = null;
let tagFontsRequested = false;
let tagInitRequested = false;
let tagFullyInit = false;

/** 目前本文字級（pt）；標籤的大小是它的百分比 */
/** 目前 scope 的本文 pt：本文自訂字級 → 文件字級（兩者都以 pt 表示） */
const bodyPt = (): number => {
  const { base } = scopedEntry(BODY_KEY);
  return base?.size ?? readDocFont() * 0.75;
};

/** 網頁版（沒有宿主）用的內建字型清單；桌面版會換成系統已安裝的字型 */
const BUILTIN_FONTS: [string, string][] = [
  ['', '本文'],
  ['PMingLiU', '細明體'],
  ['MingLiU', '新細明體'],
  ['DFKai-SB', '標楷體'],
  ['Microsoft JhengHei', '微軟正黑體'],
  ['SimSun', '宋體'],
  ['KaiTi', '楷體'],
  ['Source Han Serif TC', '思源宋體'],
  ['Source Han Sans TC', '思源黑體'],
  ['Noto Serif CJK TC', 'Noto Serif TC'],
  ['Noto Sans CJK TC', 'Noto Sans TC'],
];
const FONT_LABELS: Record<string, string> = Object.fromEntries(BUILTIN_FONTS.filter(([v]) => v));

const tagAll = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T[] =>
  [...root.querySelectorAll<T>(sel)];

const escHtml = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

/** 自動配色／大小：設定頁的顯示與「自訂」的起點（實際 auto 由 renderer 算） */
function tagDepthMap(): Map<string, number> {
  const map = new Map<string, number>();
  const d = dirTrees[dirActive];
  if (!d) return map;
  const walk = (ns: TreeNode[]): void => {
    for (const n of ns) {
      const cur = map.get(n.tag);
      if (cur === undefined || n.depth < cur) map.set(n.tag, n.depth);
      walk(n.children);
    }
  };
  walk(d.roots);
  return map;
}
function tagDepth(tag: string, depths = tagDepthMap()): number {
  const d = depths.get(tag);
  if (d !== undefined) return d;
  const i = memberIndex(tag);
  if (i >= 0) return i < 10 ? 2 : 3;
  return 2;
}
const autoSizePct = (depth: number): number => Math.min(180, Math.round((100 + depth * 12.5) * 10) / 10);

let colorProbe: HTMLElement | null = null;
function probeHex(cssColor: string): string {
  if (!colorProbe) {
    colorProbe = document.createElement('span');
    colorProbe.style.cssText = 'position:absolute;left:-9999px;visibility:hidden';
    document.body.appendChild(colorProbe);
  }
  colorProbe.style.color = cssColor;
  const c = getComputedStyle(colorProbe).color;
  const m = c.match(/rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/);
  if (!m) return '#909090';
  return '#' + [1, 2, 3].map((i) => Number(m[i]).toString(16).padStart(2, '0')).join('');
}
function autoColorHex(tag: string, depth: number): string {
  return probeHex(`var(--tag-text-${tagChromaIndex(tag, depth)})`);
}
function autoBodyColorHex(): string {
  return probeHex('var(--fg)');
}
const isHex = (s: string | undefined | null): boolean => !!s && /^#[0-9a-f]{6}$/i.test(s);

function tagFontList(): [string, string][] {
  return tagFonts ?? BUILTIN_FONTS;
}
function fontOptionsHtml(sel: string, fallback: boolean): string {
  const base = fallback ? [['', '無'], ...tagFontList().slice(1)] : tagFontList().slice();
  if (fallback && sel === '') {
    // 空字串＝沒有第二種
  }
  if (sel && !base.some(([v]) => v === sel)) base.push([sel, FONT_LABELS[sel] ?? sel]);
  return base.map(([v, label]) => `<option value="${escHtml(v)}"${v === sel ? ' selected' : ''}>${escHtml(label)}</option>`).join('');
}

function ensureTagFonts(): void {
  if (tagFontsRequested) return;
  tagFontsRequested = true;
  void installedFonts().then((list) => {
    if (list.length) {
      tagFonts = [['', '本文'], ...list.map((n): [string, string] => [n, FONT_LABELS[n] ?? n])];
      tagFontSource = 'desktop';
    } else {
      tagFonts = BUILTIN_FONTS;
      tagFontSource = 'builtin';
    }
    if (settingsOpen && settingsPane === 'tags') renderTagStylePane();
  }).catch(() => {
    tagFonts = BUILTIN_FONTS;
    tagFontSource = 'builtin';
    if (settingsOpen && settingsPane === 'tags') renderTagStylePane();
  });
}

function setSettingsPane(name: string): void {
  settingsPane = name || 'ui';
  tagAll('#setTabs .setTab').forEach((b) => b.classList.toggle('active', b.dataset.setpane === settingsPane));
  tagAll('#setBody .setPane').forEach((p) => { (p as HTMLElement).hidden = p.dataset.setpane !== settingsPane; });
  if (settingsPane === 'tags') renderTagStylePane();
  else if (settingsPane === 'dict') void renderDictOrder();
}

/* ---------------------------------------------------------- 查字典（作者 2026-10-22）
 *
 * 設置 → 介面：自動查字典的兩個開關；設置 → 辭典順序（作者 2026-10-26 獨立成頁）：
 * 順序清單。順序存**檔名**；清單只列目前 catalog 裡真的是詞典的 adb；找不到的檔名
 * 在查詢時直接略過（不警告）。勾「只列出 c="isdict"」時，清單與查詢都只留 isdict 的辭典。
 */
let dictRows: DictListEntry[] = [];
let dictSeq = 0;

/** 目前清單裡看得到的列（「只列出 c="isdict"」時濾掉沒有標記的） */
function visibleDictRows(): number[] {
  const only = dictOnlyIsdict();
  const out: number[] = [];
  dictRows.forEach((d, i) => { if (!only || d.isdict) out.push(i); });
  return out;
}

function paintDictOrder(): void {
  const box = $('#dictOrderList');
  if (!box) return;
  if (!dictRows.length) {
    box.innerHTML = '<div class="note">目前沒有詞典型 adb（有 <code>&lt;樹 s="$詞"&gt;</code> 宣告的庫）。</div>';
    return;
  }
  const shown = visibleDictRows();
  if (!shown.length) {
    box.innerHTML = '<div class="note">沒有 <code>c="isdict"</code> 的詞典；取消勾選可看到全部。</div>';
    return;
  }
  box.innerHTML = shown.map((i, k) => {
    const d = dictRows[i];
    return `<div class="dictOrderRow" data-dict-file="${escHtml(d.file)}">
    <span class="idx">${k + 1}</span>
    <span class="dn">${escHtml(d.name)}</span>
    <span class="df">${escHtml(d.file)}</span>
    ${d.isdict ? '<span class="di" title="集 c 有 isdict">isdict</span>' : ''}
    <span class="de">${fmtInt(d.entries)} 條</span>
    <span class="dictMoves">
      <button type="button" class="setBtn" data-dict-up="${i}" title="往上移（先查）"${k === 0 ? ' disabled' : ''}>↑</button>
      <button type="button" class="setBtn" data-dict-down="${i}" title="往下移（後查）"${k === shown.length - 1 ? ' disabled' : ''}>↓</button>
    </span>
  </div>`;
  }).join('');
}

/** 存目前清單的順序；這一輪沒找到的舊檔名留在最後（查詢時略過，不警告） */
function saveDictOrder(): void {
  const current = dictRows.map((d) => d.file);
  const stale = dictOrder().filter((f) => !current.includes(f));
  setDictOrder([...current, ...stale]);
}

/** 重新掃描 catalog 裡的詞典；套用已存順序，新詞典排最後並存檔 */
async function renderDictOrder(force = false): Promise<void> {
  const box = $('#dictOrderList');
  if (!box) return;
  const seq = ++dictSeq;
  if (force || !dictRows.length) box.innerHTML = '<div class="note">讀取詞典中…</div>';
  const list = await listDicts().catch(() => [] as DictListEntry[]);
  if (seq !== dictSeq) return;
  dictRows = orderByFile(list);
  // 作者 2026-10-22：列出目前有的詞典就存起來
  saveDictOrder();
  paintDictOrder();
}

function wireDictOrder(): void {
  const auto = $('#setDictAuto') as HTMLInputElement | null;
  auto?.addEventListener('change', () => {
    setAutoDict(auto.checked);
    setStatus(auto.checked ? '查字典：開啟' : '查字典：關閉', 'info');
  });
  const selection = $('#setDictSelection') as HTMLInputElement | null;
  selection?.addEventListener('change', () => {
    setSelectionDict(selection.checked);
    setStatus(selection.checked ? '選取區自動查：開啟' : '選取區自動查：關閉', 'info');
  });
  $('#dictRefresh')?.addEventListener('click', () => { void renderDictOrder(true); });
  // 只列出 c="isdict"（作者 2026-10-26）：清單與查詢一起過濾（dictLookup 也看這個旗標）
  const only = $('#dictOnlyIsdict') as HTMLInputElement | null;
  only?.addEventListener('change', () => {
    setDictOnlyIsdict(only.checked);
    paintDictOrder();
    setStatus(only.checked ? '辭典順序：只列出並只查 c="isdict"' : '辭典順序：列出並查全部辭典', 'info');
  });
  $('#dictOrderList')?.addEventListener('click', (ev) => {
    const b = (ev.target as HTMLElement)?.closest('button[data-dict-up],button[data-dict-down]') as HTMLButtonElement | null;
    if (!b) return;
    const up = b.dataset.dictUp !== undefined;
    const i = Number(up ? b.dataset.dictUp : b.dataset.dictDown);
    if (!Number.isInteger(i) || i < 0 || i >= dictRows.length) return;
    // 只在「看得到的列」之間交換：勾了 isdict 時，沒列出的辭典位置不動
    const shown = visibleDictRows();
    const at = shown.indexOf(i);
    const j = at < 0 ? undefined : shown[at + (up ? -1 : 1)];
    if (j === undefined) return;
    [dictRows[i], dictRows[j]] = [dictRows[j], dictRows[i]];
    saveDictOrder();
    paintDictOrder();
    setStatus('辭典順序已更新', 'info');
  });
}

function setTagScope(s: TagScope): void {
  if (s === 'adb' && !activeDb().file) return;
  tagScope = s;
  renderTagStylePane();
}

/** 這一列在目前 scope 下看到的「自己」與「繼承來源」；global scope 不偷看 adb 的值 */
function scopedEntry(key: string): { own?: TagStyle; base?: TagStyle; inherited: boolean } {
  const own = entryOf(tagScope, key);
  const global = tagScope === 'adb' ? entryOf('global', key) : undefined;
  const base = own ?? global;
  return { own, base, inherited: !own && !!global };
}

/** 標籤樣式的「自訂」起點：把目前 scope 生效的值抄成一份完整條目 */
function seedTagStyle(key: string): TagStyle {
  const { base } = scopedEntry(key);
  if (key === BODY_KEY) {
    const out: TagStyle = {
      color: base?.color && isHex(base.color) ? base.color : autoBodyColorHex(),
      font: base?.font ?? '',
      font2: base?.font2 ?? '',
    };
    if (base?.size !== undefined) out.size = base.size;   // 保留既有本文字級（pt）
    return out;
  }
  const depths = tagDepthMap();
  const autoTag = key === GROUP_ID ? GROUP_TAGS[0] : key;
  const depth = tagDepth(key, depths);
  const color = base && isHex(base.color) ? base.color : autoColorHex(autoTag, depth);
  return {
    color,
    size: base?.size ?? Math.round(autoSizePct(depth)),
    // 作者 2026-10-22：自訂 <經> 時把預設楷體一起帶進條目，之後仍可改成別的字型
    font: base?.font ?? defaultFontOf(key) ?? '',
    font2: base?.font2 ?? '',
  };
}

function rowHtml(key: string, kind: 'body' | 'tag' | 'group', depths: Map<string, number>): string {
  const { own: ownEntry, base, inherited } = scopedEntry(key);
  const editable = !!ownEntry;
  const ro = editable ? '' : ' disabled';
  const baseSize = bodyPt();
  let colorCss = '';
  let colorInput = '';
  let font = '';
  let font2 = '';
  let sizeLabel = '';
  let sampleText = key;
  let samplePct = 0;
  let meta = '';
  let sizeDisabled = !editable;
  let sizeMin = 50, sizeMax = 300, sizeStep = 5;
  let sizeValue = 0;

  if (kind === 'body') {
    colorCss = ownEntry?.color || base?.color || 'var(--fg)';
    colorInput = isHex(base?.color) ? base!.color! : autoBodyColorHex();
    font = base?.font ?? '';
    font2 = base?.font2 ?? '';
    sampleText = '本文';
    meta = '整篇正文';
    sizeValue = Math.round(baseSize);
    sizeLabel = `${sizeValue}pt`;
    sizeDisabled = false;
    sizeMin = 8; sizeMax = 30; sizeStep = 1;
  } else if (kind === 'group') {
    const depth = tagDepth(GROUP_TAGS[0], depths);
    const baseColor = base?.color ?? null;
    colorCss = baseColor && isHex(baseColor) ? rampColor(baseColor, 0) : `var(--tag-text-${tagChromaIndex(GROUP_TAGS[0], depth)})`;
    colorInput = isHex(base?.color) ? base!.color! : autoColorHex(GROUP_TAGS[0], depth);
    const size = base?.size ?? Math.round(autoSizePct(depth));
    samplePct = size;
    sizeValue = size;
    sizeLabel = `${Math.round(size)}%`;
    sampleText = GROUP_TAGS[0];
    font = base?.font ?? '';
    font2 = base?.font2 ?? '';
    meta = '天干地支・22 層（每層 +30°）';
  } else {
    const depth = tagDepth(key, depths);
    colorCss = base?.color || `var(--tag-text-${tagChromaIndex(key, depth)})`;
    colorInput = isHex(base?.color) ? base!.color! : autoColorHex(key, depth);
    const size = base?.size ?? Math.round(autoSizePct(depth));
    samplePct = size;
    sizeValue = size;
    sizeLabel = `${Math.round(size)}%`;
    font = base?.font ?? defaultFontOf(key) ?? '';
    font2 = base?.font2 ?? '';
    if (!base?.font && defaultFontOf(key)) meta = `預設${defaultFontOf(key)}`;
  }

  const samplePt = samplePct ? (baseSize * samplePct / 100) : baseSize;
  const style = `color:${colorCss};font-family:${fontFamilyOf({ font: font || null, font2: font2 || null })};font-size:${samplePt.toFixed(1)}pt`;
  const name = `<span class="tchip" data-pct="${samplePct || ''}" style="${style}">${escHtml(sampleText)}</span>`
    + (meta ? `<span class="tMeta">${escHtml(meta)}</span>` : '');
  const src = ownEntry
    ? (tagScope === 'adb' ? '此庫' : '全域')
    : (inherited ? (tagScope === 'adb' ? '繼承全域' : '全域') : (kind === 'body' ? '預設' : '自動'));
  const srcCls = ownEntry ? (tagScope === 'adb' ? 'adb' : 'global') : (inherited ? 'global' : 'auto');
  const offLabel = kind === 'body'
    ? (tagScope === 'adb' ? '繼承全域' : '預設')
    : (tagScope === 'adb' ? '繼承全域' : '自動');
  const hexLabel = ownEntry ? (ownEntry.color ?? '自動') : (inherited ? '繼承' : (kind === 'body' ? '預設' : '自動'));
  return `<div class="tagRow${ownEntry ? ' own' : ''}${kind === 'group' ? ' groupRow' : ''}${kind === 'body' ? ' bodyRow' : ''}"
      data-key="${escHtml(key)}" data-kind="${kind}">
    <div class="tName">${name}</div>
    <div class="modeSeg">
      <button type="button" data-act="inherit" class="${ownEntry ? '' : 'on'}">${offLabel}</button>
      <button type="button" data-act="own" class="${ownEntry ? 'on' : ''}">自訂</button>
    </div>
    <div class="ctl${editable ? '' : ' disabled'}">
      <input type="color" value="${colorInput}" data-field="color"${ro}>
      <span class="val hex">${hexLabel}</span>
    </div>
    <div class="ctl sizeCtl${sizeDisabled ? ' disabled' : ''}">
      <input type="range" min="${sizeMin}" max="${sizeMax}" step="${sizeStep}" value="${Math.round(sizeValue)}" data-field="size"${sizeDisabled ? ' disabled' : ''}>
      <span class="val sizeVal">${sizeLabel}</span>
    </div>
    <div class="ctl fontCtl${editable ? '' : ' disabled'}">
      <select data-field="font"${ro}>${fontOptionsHtml(font, false)}</select>
      <select data-field="font2"${ro}>${fontOptionsHtml(font2, true)}</select>
    </div>
    <div class="src">
      <span class="srcTag ${srcCls}">${src}</span>
      ${ownEntry ? '<button type="button" class="mini" data-act="reset">重設</button>' : ''}
    </div>
  </div>`;
}

function renderTagTable(): void {
  const host = $('#tagTable');
  if (!host) return;
  const depths = tagDepthMap();
  let h = '<div class="tagHead"><span>標籤</span><span>樣式</span><span>顏色</span><span>大小（本文 pt／標籤 %）</span><span>字型（第一／第二 fallback）</span><span>來源</span></div>';
  // 作者 2026-10-22：本文置頂；示範字直接長在每一列（不再有預覽）
  h += rowHtml(BODY_KEY, 'body', depths);
  const known = STRUCTURAL_TAGS as readonly string[];
  for (const t of known) h += rowHtml(t, 'tag', depths);
  h += rowHtml(GROUP_ID, 'group', depths);
  const others = [...depths.entries()]
    .filter(([t]) => !known.includes(t) && memberIndex(t) < 0)
    .sort((a, b) => a[0].localeCompare(b[0], 'zh-Hant'));
  if (others.length) {
    h += '<div class="tagSectionHead" style="margin:8px 0 2px"><b>此庫的其他標籤</b><span>目錄樹用到、不在內置清單的標籤</span></div>';
    for (const [t] of others) h += rowHtml(t, 'tag', depths);
  }
  host.innerHTML = h;
}

/** 字型清單來源（取代原本預覽卡的字型說明） */
function renderTagFontSource(): void {
  const source = tagFontSource === 'desktop'
    ? '桌面版：系統已安裝字型'
    : tagFontSource === 'builtin' ? '網頁版：內建字型' : '字型清單載入中…';
  const n = tagFonts ? tagFonts.length - 1 : 0;
  const el = $('#tagFontSource');
  if (el) el.textContent = `字型清單：${source}（${n} 個）；第二種字型只在第一種缺字時用到。`;
}

/** 把本文的顏色／字型／字級套到中欄（字級以 pt 為單位，沒自訂時用文件字級） */
function applyBodyStyleToDoc(): void {
  const b = bodyStyleOf();
  const root = document.documentElement;
  if (b?.color) root.style.setProperty('--doc-body-color', b.color);
  else root.style.removeProperty('--doc-body-color');
  if (b && (b.font || b.font2)) root.style.setProperty('--doc-body-font', fontFamilyOf(b));
  else root.style.removeProperty('--doc-body-font');
  if (b?.size != null) root.style.setProperty('--doc-body-size', `${b.size}pt`);
  else root.style.removeProperty('--doc-body-size');
}

/** 本文 pt 改了：每一列的示範字級（pt）跟著重算，不必重建整張表 */
function updateTagSampleSizes(): void {
  const base = bodyPt();
  tagAll('#tagTable .tagRow').forEach((row) => {
    const chip = row.querySelector('.tchip') as HTMLElement | null;
    if (!chip) return;
    const pct = Number(chip.dataset.pct || '0');
    chip.style.fontSize = `${(pct ? base * pct / 100 : base).toFixed(1)}pt`;
  });
  const sv = document.querySelector('#tagTable .tagRow[data-kind="body"] .sizeVal');
  if (sv) sv.textContent = `${Math.round(base)}pt`;
}

function renderTagStore(): void {
  const loc = settingsLocation();
  const path = $('#tagStorePath');
  const badge = $('#tagStoreBadge');
  const note = $('#tagStoreNote');
  const status = $('#tagStoreStatus');
  const reveal = $('#tagReveal') as HTMLButtonElement | null;
  if (path) path.textContent = loc ? loc.path : '（尚未決定）';
  const ver = $('#tagStoreVersion');
  if (ver) ver.textContent = `v${settingsVersion()}`;
  if (badge) {
    badge.innerHTML = !loc ? '' : loc.kind === 'localStorage'
      ? '<span class="okchip">瀏覽器</span>'
      : loc.kind === 'exe' ? '<span class="okchip">可寫入</span>' : '<span class="warnchip">退路</span>';
  }
  if (note) {
    note.textContent = !loc ? '設定檔位置讀取中…'
      : loc.kind === 'localStorage' ? '網頁版存在 localStorage；用「匯出」可以存成 settings.json 帶走。'
        : (loc.note || (loc.kind === 'exe' ? '與 accelon26.exe 同一個資料夾，可以直接備份／分享。' : 'exe 資料夾不可寫，改存使用者設定資料夾。'));
  }
  if (reveal) reveal.hidden = !loc || loc.kind === 'localStorage';
  if (status) status.textContent = settingsError();
  if (!loc && !tagInitRequested) {
    tagInitRequested = true;
    void initTagSettings().then(() => renderTagStore());
  }
}

function renderTagStylePane(): void {
  const db = activeDb();
  if (!db.file && tagScope === 'adb') tagScope = 'global';
  tagAll('#tagScopeSeg button').forEach((b) => {
    const btn = b as HTMLButtonElement;
    btn.classList.toggle('active', b.dataset.tagScope === tagScope);
    btn.disabled = b.dataset.tagScope === 'adb' && !db.file;
  });
  const now = $('#tagScopeNow');
  if (now) {
    now.innerHTML = tagScope === 'adb'
      ? `此資料庫：<b>${escHtml(db.name || db.file)}</b> <span class="dim">（${escHtml(db.file)}）</span>`
      : '全域預設：<b>出廠預設值</b>';
  }
  const path = $('#tagScopePath');
  if (path) {
    path.innerHTML = tagScope === 'adb' && db.file
      ? `<code>profiles.adb["${escHtml(db.file)}"]</code>`
      : '<code>profiles.global</code>';
  }
  const n = tagStyleCounts();
  const hasTree = !!dirTrees[dirActive];
  const banner = $('#tagBanner');
  if (banner) {
    banner.innerHTML = tagScope === 'adb'
      ? `<span>ⓘ</span><span><b>此庫目前 ${n.adb} 個自訂、其餘繼承全域。</b> 在這裡改的只影響這一本書；按「繼承全域」可以還原。`
        + (hasTree ? '' : ' <span class="dim">（此庫沒有目錄樹，只列出預設標籤。）</span>') + '</span>'
      : `<span>ⓘ</span><span><b>全域是出廠預設，所有資料庫都繼承它。</b> 這裡改了會影響還沒自訂的庫。`
        + (hasTree ? '' : ' <span class="dim">（此庫沒有目錄樹，只列出預設標籤。）</span>') + '</span>';
  }
  renderTagTable();
  renderTagFontSource();
  renderTagStore();
  if (!tagFullyInit) {
    tagFullyInit = true;
    void initTagSettings().then(() => {
      if (settingsOpen && settingsPane === 'tags') renderTagStylePane();
    }).catch(() => { /* 讀不到就用預設 */ });
  }
}

function onTagTableClick(ev: Event): void {
  const btn = (ev.target as HTMLElement)?.closest('button[data-act]') as HTMLButtonElement | null;
  if (!btn) return;
  const row = btn.closest('[data-key]') as HTMLElement | null;
  const key = row?.dataset.key;
  if (!key) return;
  const label = key === BODY_KEY ? '本文' : key === GROUP_ID ? '天干地支' : key;
  if (btn.dataset.act === 'own') {
    setEntry(tagScope, key, seedTagStyle(key));
    setStatus(`標籤樣式：${label} 已自訂`, 'info');
  } else {
    setEntry(tagScope, key, null);
    setStatus(`標籤樣式：${label} 回到${tagScope === 'adb' ? '全域' : (key === BODY_KEY ? '預設' : '自動')}`, 'info');
  }
  saveSettingsSoon();
  renderTagStylePane();
}

function onTagTableField(ev: Event): void {
  const el = ev.target as HTMLInputElement | HTMLSelectElement | null;
  const field = el?.dataset?.field;
  if (!el || !field) return;
  const row = el.closest('[data-key]') as HTMLElement | null;
  const key = row?.dataset.key;
  if (!key) return;
  const live = ev.type === 'input';

  // 本文的字級：建立在本文條目（pt；per-adb 也可以），沒自訂時用文件字級
  if (key === BODY_KEY && field === 'size') {
    const raw = Number((el as HTMLInputElement).value);
    if (!Number.isFinite(raw)) return;
    const pt = Math.max(8, Math.min(30, Math.round(raw)));
    const { base } = scopedEntry(BODY_KEY);
    setEntry(tagScope, BODY_KEY, { ...(base ?? {}), size: pt }, { silent: live });
    saveSettingsSoon();
    applyBodyStyleToDoc();
    updateTagSampleSizes();
    const sv = row.querySelector('.sizeVal');
    if (sv) sv.textContent = `${pt}pt`;
    setStatus(`本文字級：${pt}pt`, 'info');
    if (!live) { notifyTagStyles(); renderTagStylePane(); }
    return;
  }

  const entry = entryOf(tagScope, key);
  if (!entry) return;                      // 只有自訂的列可以改（本文的字級除外）
  const next: TagStyle = { ...entry };
  if (field === 'color') next.color = (el as HTMLInputElement).value;
  if (field === 'size') next.size = Number((el as HTMLInputElement).value);
  if (field === 'font') next.font = (el as HTMLSelectElement).value;
  if (field === 'font2') next.font2 = (el as HTMLSelectElement).value;
  setEntry(tagScope, key, next, { silent: live });
  saveSettingsSoon();

  const chip = row.querySelector('.tchip') as HTMLElement | null;
  if (field === 'color' && chip) {
    if (key === GROUP_ID && next.color) chip.style.color = rampColor(next.color, 0);
    else chip.style.color = next.color || 'var(--fg)';
    if (key === BODY_KEY) applyBodyStyleToDoc();
  }
  if (field === 'size' && chip) {
    const pct = next.size ?? entry.size ?? 0;
    chip.style.fontSize = `${(bodyPt() * pct / 100).toFixed(1)}pt`;
    const sv = row.querySelector('.sizeVal');
    if (sv) sv.textContent = `${Math.round(pct)}%`;
  }
  if ((field === 'font' || field === 'font2') && chip) {
    const f = next.font ?? (key === BODY_KEY ? null : defaultFontOf(key)) ?? null;
    chip.style.fontFamily = fontFamilyOf({ font: f, font2: next.font2 ?? null });
    if (key === BODY_KEY) applyBodyStyleToDoc();
  }
  const hex = row.querySelector('.hex');
  if (hex) hex.textContent = next.color || '自動';
  if (!live) {
    notifyTagStyles();
    renderTagStylePane();
  }
}

function wireTagStyle(): void {
  tagAll('#setTabs .setTab').forEach((b) => b.addEventListener('click', () => setSettingsPane(b.dataset.setpane || 'tags')));
  tagAll('#tagScopeSeg button').forEach((b) => b.addEventListener('click', () => setTagScope(b.dataset.tagScope as TagScope)));
  $('#tagTable')?.addEventListener('click', onTagTableClick);
  $('#tagTable')?.addEventListener('input', onTagTableField);
  $('#tagTable')?.addEventListener('change', onTagTableField);
  $('#tagExport')?.addEventListener('click', () => { exportSettingsFile(); setStatus('已匯出 accelon26-settings.json', 'info'); });
  const importInput = $('#tagImportFile') as HTMLInputElement | null;
  $('#tagImport')?.addEventListener('click', () => importInput?.click());
  importInput?.addEventListener('change', () => {
    const f = importInput.files?.[0];
    if (!f) return;
    void importSettingsFile(f).then((r) => {
      if (r.ok) {
        setStatus(`已匯入 ${f.name}（v${r.version ?? 1}）`, 'info');
        notifyTagStyles();
        renderTagStylePane();
      } else {
        setStatus('匯入失敗：' + (r.error || '未知錯誤'), 'err');
      }
    });
    importInput.value = '';
  });
  $('#tagReveal')?.addEventListener('click', () => {
    const loc = settingsLocation();
    if (!loc || loc.kind === 'localStorage') return;
    void desktopRevealInFolder(loc.path);
  });
  ensureTagFonts();
  wireDictOrder();
  applyBodyStyleToDoc();
  onTagStyleChange(() => {
    applyBodyStyleToDoc();
    rerenderDoc();
    if (dirTrees.length) void renderDirTree();
  });
  onActiveDbChange(() => {
    applyBodyStyleToDoc();
    if (settingsOpen && settingsPane === 'tags') renderTagStylePane();
  });
  void initTagSettings().then(() => {
    if (settingsOpen && settingsPane === 'tags') renderTagStylePane();
  });
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
  // 只有進階模式能編輯：關掉進階時先暫存並離開編輯態（修訂仍留著）
  if (!on) { const s = docSession(); if (s?.editing) exitEdit(s); }
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
 * reads just the headers) and opens one of them. On `file://` this is a no-op, so
 * one page serves both builds.
 *
 * 先開哪一本（作者 2026-10-18）：**優先有 logo 圖的庫**（例如 yinshun.adb，中間才有
 * 那張大圖），都沒有才開第一個。判斷只讀檔頭＋資源名稱表（`hasLogoResource`），
 * 不算「已載入」。
 */
async function bootDesktop(): Promise<void> {
  // 左上角：桌面版顯示建置時間（hover hint），有新版本時閃動、點擊更新，更新後顯示改版說明。
  // 網頁版沒有宿主，initDesktopBrand 直接返回（左上角就只是一行標題）。
  void initDesktopBrand((msg, kind) => setStatus(msg, kind ?? 'info'));
  void initDesktopWindowKeys();   // F11 全螢幕／Esc 回視窗（全螢幕時沒有標題列）
  const srcs = await refreshHostDbs();
  if (!srcs.length) return;
  if (!openDbs.length) await openPicked([await pickStartupDb(srcs)]);
}

/** 啟動要開的那一個：第一個有自帶 logo 的庫；都沒有就第一個。
 *  只探前 12 個（每個都只讀檔頭＋資源名稱表）；資料夾裡幾十個 adb 時不會拖慢啟動。 */
async function pickStartupDb(srcs: AdbSource[]): Promise<AdbSource> {
  for (const s of srcs.slice(0, 12)) {
    if (await hasLogoResource(s)) return s;
  }
  return srcs[0];
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
  // 設置（齒輪）：主題、進階模式、繁簡通檢、文字顯示
  initVariants();
  initSettings();
  // 主題（作者 2026-10-18）：暗色系／亮色系／春綠／秋黃，預設暗色系
  initTheme((name) => setStatus('主題：' + THEME_LABEL[name], 'info'));
  // 搜尋所有 adb（放大鏡，作者 2026-10）
  initSearchAll();
  // 右欄「詞典」分頁：點本文就查詞條（作者 2026-10）
  initDictPane();
  // 本文的 `<聯 n="詞">`（別名／參見）點擊後聯動到該詞條（作者 2026-10）
  initEntryLinks();
  // 本文的 `<註 n>` ↔ `<釋 n>` 腳注連動（作者 2026-10-26）
  initNoteLinks();
  setDictHooks.current = () => { setSide('right', true); showTab('dict', 'right'); };
  // 操作導覽（🎬）：劇本 → 宏 → 播放器，見 tour.ts 與 ts/tour/*.tour
  initTour(TOUR_APP);
  // 軟件說明（About）：點左上角 accelon26 開啟，順便檢查更新
  initAbout();
  // 加入 Obsidian（作者 2026-10-25）：vault → adb，選單與兩個隱藏 input 都在這裡接線
  initVaultImport();
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
  // 「原始文件」已取消（作者 2026-10-24），改成鉛筆：進入／離開這一頁的編輯態。
  const editBtn = $('#editBtn') as HTMLButtonElement | null;
  if (editBtn) {
    // mousedown 在瀏覽器收合選取之前先記住本文選取，進編輯後才能捲到它
    editBtn.addEventListener('mousedown', () => rememberDocSelection(), true);
    editBtn.onclick = () => {
      const s = docSession();
      if (!s) return;
      if (s.editing) exitEdit(s); else enterEdit(s, true);
    };
  }
  const showDiff = $('#showDiff') as HTMLInputElement | null;
  if (showDiff) showDiff.onchange = () => {
    const s = docSession();
    if (!s) return;
    s.showDiff = showDiff.checked;
    renderDoc(s);
  };
  // 設定／測試仍可能呼叫 raw；有舊元素才綁（新介面沒有）
  const showRaw = $('#showRaw') as HTMLInputElement | null;
  if (showRaw) {
    showRaw.checked = renderRawOn();
    showRaw.onchange = () => {
      setRenderRaw(showRaw.checked);
      rerenderDoc();
      void renderTextPane();
      setStatus(showRaw.checked ? '顯示原始文件（不渲染標籤）' : '渲染標籤（預設）', 'info');
    };
  }  // 「不換行（自動字級）」按鈕已移除（作者 2026-10：讓讀者自己用上面的下拉調整字級）。
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
      // file:// 版而且還沒開過任何 adb：直接開檔案挑選（作者 2026-10-18），
      // 不必先展開空選單再按「＋ 加入 adb」。
      if (catalogEmpty() && needsAddItem()) { pickAddFile(); return; }
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

  // dbChip 的「n 頁修訂」按鈕 → 產生新 ADB（file:// 版下載 blob）；F2 也走這裡
  const requestRebuild = (): void => {
    const slot = activeSlot();
    if (!reader || !slot) { setStatus('請先開啟 adb 再重建', 'err'); return; }
    const modal = document.getElementById('editModal');
    if (modal && !modal.hidden) return;   // 已經在重建／回滾流程
    flushEdit();
    const es = findSession(sourceKey(slot.file));
    if ((!es || editCount(es) === 0) && !extraRevisions(reader).length) {
      setStatus('目前沒有未產生的修訂；請先編輯或匯入 revisions 再用 F2', 'err');
      return;
    }
    void rebuildAndDownload(reader, { id: slot.id, name: slot.name, file: slot.file }, {
      status: (msg, kind) => setStatus(msg, kind ?? 'info'),
      openFile: (f) => openFile(f),
      // 桌面版覆蓋原檔後：關掉舊的庫，用宿主的新檔頭重新開啟（作者 2026-10-27）
      reloadPath: async (path) => {
        closeDb(slot.id);
        const fresh = (await desktopSources()).find((s) => s.path === path);
        if (!fresh) return false;
        await openFile(fresh);
        return true;
      },
    });
  };
  window.addEventListener('accelon26:rebuild', (ev) => {
    const id = Number((ev as CustomEvent).detail?.id ?? 0);
    const slot = openDbs.find((d) => d.id === id);
    if (!slot) return;
    if (activeSlot()?.id !== id) switchTo(id);
    requestRebuild();
  });

  // 功能鍵（作者 2026-10-25）：F1 導覽、F2 重建、F3 編輯、F9 元素檢查
  const anyModalOpen = (): boolean => ['settingsBox', 'allSearchBox', 'aboutBox', 'editModal']
    .some((id) => { const el = document.getElementById(id); return !!el && !el.hidden; });
  const toggleEditHotkey = (): void => {
    const s = docSession();
    if (!s) { setStatus('目前沒有本文分頁', 'err'); return; }
    if (s.history) { setStatus('歷史版本只能檢視，不能編輯', 'err'); return; }
    if (s.editing) exitEdit(s);
    else enterEdit(s);
  };
  window.addEventListener('keydown', (ev) => {
    if (ev.defaultPrevented || ev.repeat || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    switch (ev.key) {
      case 'F1':
        ev.preventDefault();
        startTour(true);   // 熱鍵固定從導覽第一頁開始
        break;
      case 'F2':
        ev.preventDefault();
        if (!anyModalOpen()) requestRebuild();
        break;
      case 'F3':
        ev.preventDefault();
        if (!anyModalOpen()) toggleEditHotkey();
        break;
      case 'F9':
        ev.preventDefault();
        toggleInspect((msg, kind) => setStatus(msg, kind ?? 'info'));
        break;
    }
  }, true);
  // 修訂頁點某一頁：開一個歷史版本分頁，自動顯示 diff（唯讀）
  window.addEventListener('accelon26:history', (ev) => {
    const detail = (ev as CustomEvent).detail;
    if (detail?.page) void openHistoryPage(detail);
  });
  // 修訂頁的「退回上一版」按鈕
  window.addEventListener('accelon26:rollback', () => {
    const slot = activeSlot();
    if (!slot || !reader) return;
    flushEdit();
    void rollbackAndDownload(reader, { id: slot.id, name: slot.name, file: slot.file }, {
      status: (msg, kind) => setStatus(msg, kind ?? 'info'),
      openFile: (f) => openFile(f),
    });
  });
  // headless 測試／診斷：直接回傳重建結果（不觸發下載）
  (window as any).__accelon26EditBuild = async () => {
    const slot = activeSlot();
    if (!reader || !slot) return null;
    flushEdit();
    const res = await runRebuild(reader, { id: slot.id, name: slot.name, file: slot.file }, { status: (m, k) => setStatus(m, k ?? 'info') });
    return res ? { filename: res.filename, revisionId: res.revisionId, pages: res.pages, size: res.bytes.length } : null;
  };
  (window as any).__accelon26OpenBuilt = async () => {
    const slot = activeSlot();
    if (!reader || !slot) return null;
    flushEdit();
    const res = await runRebuild(reader, { id: slot.id, name: slot.name, file: slot.file }, { status: (m, k) => setStatus(m, k ?? 'info') });
    if (!res) return null;
    const file = new File([res.bytes as unknown as BlobPart], res.filename, { type: 'application/octet-stream', lastModified: Date.now() }) as unknown as AdbSource;
    await openFile(file);
    return { name: res.filename, size: res.bytes.length, revisionId: res.revisionId };
  };
  // 有未產生的修訂就攔一下關閉（瀏覽器只允許顯示制式訊息）
  window.addEventListener('beforeunload', (ev) => {
    saveLastReadNow();
    const dirty = openDbs.some((d) => editCount(findSession(sourceKey(d.file))) > 0);
    if (!dirty) return;
    ev.preventDefault();
    ev.returnValue = '';
  });


  // #行號（可帶 @db）＝跳到那一行；輸入時不搜尋，等 Enter（作者 2026-10-25）
  const lineJumpTarget = (q: string): { line: number; db: string | null } | null => {
    const m = /^#(?:L)?(\d+)(?:@([^\s@]+))?$/i.exec(q.trim());
    return m ? { line: Number(m[1]), db: m[2] || null } : null;
  };
  const jumpToLine = async (target: { line: number; db: string | null }): Promise<void> => {
    if (!reader || !mapper) { setStatus('請先開啟 adb', 'err'); return; }
    const now = (reader.header.dbname || '').toLowerCase();
    if (target.db && target.db.toLowerCase() !== now) {
      setStatus('這一行屬於 ' + target.db + '；請先開啟或切換到那個庫', 'err');
      return;
    }
    const v = mapper.linesVirtual;
    if (target.line < 0 || target.line >= v.length) {
      setStatus('沒有第 ' + fmtInt(target.line) + ' 行', 'err');
      return;
    }
    // 目前分頁的 realm 已經包含這一行就留在原分頁，不要為此另開整個檔的分頁
    const act = docSession();
    if (act && !act.history) {
      const b = boundsOfRealm(act.realm);
      if (target.line >= b.first && target.line <= b.last) {
        await ensurePage(act, target.line);
        requestAnimationFrame(() => document.getElementById('L' + target.line)?.scrollIntoView({ block: 'center' }));
        setStatus('跳到第 ' + fmtInt(target.line) + ' 行', 'info');
        return;
      }
    }
    await showLine(target.line, v[target.line]);
    requestAnimationFrame(() => document.getElementById('L' + target.line)?.scrollIntoView({ block: 'center' }));
    setStatus('跳到第 ' + fmtInt(target.line) + ' 行', 'info');
  };
  // live search: re-run on every keystroke (posting lists are cached per token)
  const query = $('#query') as HTMLInputElement;
  let timer: number | undefined;
  query.oninput = () => {
    window.clearTimeout(timer);
    // #行號：等 Enter，不要邊打邊查
    if (lineJumpTarget(query.value)) return;
    timer = window.setTimeout(() => void runSearch(query.value), 120);
  };
  query.onkeydown = (ev) => {
    if (ev.key === 'Enter') {
      window.clearTimeout(timer);
      const jump = lineJumpTarget(query.value);
      if (jump) { ev.preventDefault(); void jumpToLine(jump); return; }
      void runSearch(query.value);
    }
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
    // 按鈕裡除了模式名還有「符合詞條數」（#termsCount，由 scopes.ts 寫）；
    // 所以只改名字那個 span，不能覆寫整個按鈕的 textContent。
    const nameEl = document.getElementById('termsModeName');
    const show = () => {
      const m = termsMode.dataset.mode ?? 'start';
      const label = LABEL[m] ?? '開頭';
      if (nameEl) nameEl.textContent = label;
      else termsMode.textContent = label;
      termsMode.title = `比對位置：${label}（按一下切換 開頭 → 中間 → 結尾）`;
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
  // 一個 pane 有多棵 <樹> 時的下拉（taisho：經目／分卷、分書頻次／分卷頻次）
  const dirPick = $('#dirPick') as HTMLSelectElement | null;
  if (dirPick) dirPick.onchange = () => selectDirTree(Number(dirPick.value));
  const freqPick = $('#freqPick') as HTMLSelectElement | null;
  if (freqPick) freqPick.onchange = () => selectFreqTree(Number(freqPick.value));
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
  // 「關於」預設在啟動時顯示（作者 2026-10-18）：它現在也是操作導覽的入口。
  // 放在最後，因為這一頁會讀取 logo／版本，也會順便檢查更新。
  showAboutOnStartup();
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
  /** 標籤樣式：測試／診斷用（清空後存檔；正常使用者在設置頁操作） */
  resetTagStyles: () => { resetTagStyles(); saveSettingsSoon(); },
  /** 搜尋所有 adb */
  openSearchAll, closeSearchAll, runSearchAll, searchAllState,
  /** 詞典分頁 */
  dictLookupAt, dictPaneState,
  /** 操作導覽（🎬）：劇本 → 宏 → 播放器 */
  openTourMenu, playTour: (id: string, from?: number) => playTour(id, from), stopTour, tourState,
  /** 加入 Obsidian（vault → adb）：診斷／測試用（最近一次的檔名、大小、sha256） */
  vaultImport: vaultImportState,
  /** 軟件說明（About） */
  openAbout, closeAbout, aboutState,
  /** 修訂者 ID（About 頁／測試） */
  setUserId, userId: getUserId,
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
    theme: themeOf(),
    /** 標籤樣式（作者 2026-10-22）：設定頁的分頁與「哪一本 adb」 */
    tagStyles: tagStyleCounts(),
    settings: (() => { const l = settingsLocation(); return l ? { kind: l.kind, path: l.path } : null; })(),
    settingsError: settingsError(),
    /** 查字典（作者 2026-10-22；2026-10-24 加選取自動查） */
    dictAuto: autoDictOn(),
    dictSelection: selectionDictOn(),
    dictOrder: dictOrder(),
    dictOnlyIsdict: dictOnlyIsdict(),
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
    /** 總命中數：結果被 maxHits 截斷時仍然是精確值（taisho「佛」＝567,678） */
    hitTotal: hitTotal(),
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
    dirActive,
    dirTreeCount: dirTrees.length,
    // the `<樹>` declarations of this database (the tab set), then the trees that were
    // actually built for the 目錄 pane — taisho declares 7 and builds 2 of them
    scopes: (session?.trees ?? []).map((t) => t.scope),
    treeNames: (session?.trees ?? []).map((t) => t.caption ?? ''),
    builtScopes: dirTrees.map((d) => d.tree.scope),
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

import { MAX_DBS, activeCatalogKey, activeSlot, catalogAdd, catalogAddFile, catalogEmpty, catalogState, closeDb, dbLog, dbPickOpen, needsAddItem, openDbs, pickAddFile, refreshHostDbs, renderDbPick, setDbHooks, setDbPickOpen, switchTo } from './dbs';
import { editCount, findSession, sourceKey } from './edit-session';
import { extraRevisions } from './revisions-store';
import { rebuildAndDownload, rollbackAndDownload, runRebuild } from './rebuild-ui';
import { initTextPane, renderTextPane, resetTextPane, textState } from './text-pane';
import { initVaultImport, vaultImportState } from './vault-import';
import { hasLogoResource, hideDocLogo, logoState, updateDocLogo } from './logo';
import { hostState } from './host';
import { setVariantSearch, variantSearchOn } from './variants';
import { aboutState, closeAbout, initAbout, openAbout, showAboutOnStartup } from './about';
import { initTheme, THEME_LABEL, themeOf } from './theme';
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
  void renderHeader();
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
  for (const sel of ['#meta', '#headerText', '#capacity', '#docs', '#resources', '#dirTree', '#termsList',
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

