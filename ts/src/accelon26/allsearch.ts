/**
 * 搜尋所有 adb（作者 2026-10；2026-11-01 加三種模式）
 *
 * header 的 `#searchAllBtn`（放大鏡）打開 `#allSearchBox`，三選一：
 *   * **索引**：原本的行為——逐庫用 token 索引查，一個庫查完就更新一次清單，
 *     最後按命中數排序。
 *   * **單庫萬用**：萬用字元掃描，只掃目前打開的這個庫。
 *   * **全庫萬用**：萬用字元掃描，掃清單上的每一庫。
 *
 * 萬用字元（`wildcard.ts`）：`？`＝恰好一個漢字、`＊`＝1–4 個漢字，只比對漢字；
 * 至少要有一個字（單獨的 `？`／`＊` 一律拒絕）。掃描會先用 pattern 裡的漢字查索引
 * 縮小要掃的段落，但還是慢，所以有**進度條（已掃／剩餘／找到幾筆）**與**中斷**。
 * 結果除了每個庫的命中數，還列出**命中的字串**（次數多的在前）——研究上要看的
 * 就是「某字前後可能出現哪些字」。
 *
 * 這支刻意**不切換目前的分頁**：它自己開暫時的 `AdbReader`（只讀檔頭與索引），
 * 掃完（或中斷）就丟掉，不會動到 `openDbs` 的 5 個名額。
 */
import { AdbReader, BlobIO, type AdbSource } from './adb';
import { SearchSession } from './search';
import { catalog, openCatalogEntry } from './dbs';
import { $, escapeHtml, jumpToAdbLine, setStatus } from './viewer';
import {
  abortWildSearch, parseWildcard, startWildSearch, wildState, wildcardHint,
  type WildPattern, type WildRun,
} from './wildcard';

/** 一個庫的查詢結果（清單一列） */
export interface AllSearchHit {
  key: string;
  name: string;
  file: string;
  hits: number;
  ms: number;
  state: 'pending' | 'running' | 'done' | 'error';
  error?: string;
}

export type AllSearchMode = 'index' | 'single' | 'all';

const MODE_KEY = 'accelon26.allSearchMode';

let hits: AllSearchHit[] = [];
let open = false;
let runSeq = 0;
let busy = false;
/** 清單被重畫的次數（作者指定的「每查一個 adb 更新一次」——測試用它當證據） */
let renderCount = 0;
let mode: AllSearchMode = 'index';
let lastWild: WildRun | null = null;

const modeOf = (v: unknown): AllSearchMode => (v === 'single' || v === 'all' ? v : 'index');

function readMode(): AllSearchMode {
  try { return modeOf(localStorage.getItem(MODE_KEY)); } catch { return 'index'; }
}

/** 目前模式（診斷／測試用） */
export function allSearchMode(): AllSearchMode { return mode; }

export function allSearchOpen(): boolean { return open; }

export function searchAllState(): {
  open: boolean; busy: boolean; mode: AllSearchMode; query: string; renderCount: number;
  rows: { name: string; file: string; hits: number; state: string; ms: number }[];
  wild: {
    phase: string; db: string; blocksDone: number; blocksTotal: number;
    hits: number; forms: number; ms: number;
  } | null;
} {
  const w = wildState();
  return {
    open,
    busy,
    mode,
    renderCount,
    query: ($('#allSearchQuery') as HTMLInputElement | null)?.value ?? '',
    rows: hits.map((h) => ({ name: h.name, file: h.file, hits: h.hits, state: h.state, ms: h.ms })),
    wild: w.progress.phase === 'idle' ? null : {
      phase: w.progress.phase, db: w.progress.db,
      blocksDone: w.progress.blocksDone, blocksTotal: w.progress.blocksTotal,
      hits: w.progress.hits, forms: w.progress.forms, ms: w.progress.ms,
    },
  };
}

function show(on: boolean): void {
  open = on;
  const box = $('#allSearchBox');
  const back = $('#allSearchBackdrop');
  if (box) box.hidden = !on;
  if (back) back.hidden = !on;
  if (on) {
    const q = $('#allSearchQuery') as HTMLInputElement | null;
    q?.focus();
    q?.select();
    syncModeUi();
    renderList();
  }
}

export function openSearchAll(): void {
  // 標題顯示「搜尋 n 個數據庫」（作者 2026-10）
  const title = $('#allSearchTitle');
  if (title) title.textContent = `搜尋 ${catalog.length} 個數據庫`;
  show(true);
}
export function closeSearchAll(): void { show(false); }

/** 切模式：更新按鈕、提示、進度區塊與輸入框的 placeholder（作者 2026-11-01） */
export function setAllSearchMode(next: AllSearchMode, opts: { rerun?: boolean } = {}): void {
  mode = modeOf(next);
  try { localStorage.setItem(MODE_KEY, mode); } catch { /* 私密模式 */ }
  syncModeUi();
  const q = $('#allSearchQuery') as HTMLInputElement | null;
  if (q) {
    q.placeholder = mode === 'index'
      ? '查詢詞（例：比丘、緣起 性空）'
      : '萬用字元（例：？象、白＊、＊心）';
  }
  renderList();
  if (opts.rerun && q?.value.trim()) void runSearchAll(q.value);
}

function syncModeUi(): void {
  document.querySelectorAll<HTMLElement>('#allSearchMode button').forEach((b) => {
    b.classList.toggle('on', b.dataset.mode === mode);
  });
  const hint = $('#allSearchHint');
  if (hint) {
    hint.hidden = mode === 'index';
    hint.textContent = mode === 'index' ? '' : wildcardHint();
  }
  const go = $('#allSearchGo') as HTMLButtonElement | null;
  if (go) go.textContent = mode === 'index' ? '搜尋全部' : (mode === 'single' ? '掃描這個庫' : '掃描全部');
  const stop = $('#allSearchStop') as HTMLButtonElement | null;
  if (stop) stop.hidden = !busy;
  const prog = $('#allSearchProg');
  if (prog) prog.hidden = mode === 'index';
}

/**
 * 把查詢帶進**左欄目前 active 的分頁**（作者 2026-10）。
 * 每個分頁各有自己的輸入框（dir 用 `#query`、名詞 `#termsQuery`、頻次 `#freqQuery`…），
 * 使用者當時在看哪一頁，搜尋結果就帶到那一頁。
 */
const TAB_INPUT: Record<string, string> = {
  dir: 'query',
  terms: 'termsQuery',
  freq: 'freqQuery',
  folio: 'folioQuery',
  jump: 'jumpQuery',
  latin: 'latinQuery',
};

function carryQueryToActiveTab(text: string): string {
  const active = document.querySelector('#colLeft .tabBtn.active') as HTMLElement | null;
  const tab = active?.dataset.tab ?? '';
  const id = TAB_INPUT[tab] ?? 'query';
  const input = document.getElementById(id) as HTMLInputElement | null;
  if (!input) return tab || 'dir';
  input.value = text;
  input.dispatchEvent(new Event('input'));
  return tab || 'dir';
}

/** 把清單畫出來：進行中的列顯示「查詢中…」，完成的顯示命中數 */
function renderList(): void {
  const list = $('#allSearchList');
  if (!list) return;
  renderCount++;
  // 完成的最前面、依命中數排；還沒查完的照原順序排在後面（作者：每查一個就更新一次）
  const done = hits.filter((h) => h.state === 'done' || h.state === 'error')
    .sort((a, b) => b.hits - a.hits || a.name.localeCompare(b.name));
  const pending = hits.filter((h) => h.state === 'pending' || h.state === 'running');
  const rows = [...done, ...pending];
  const dup = new Map<string, number>();
  for (const h of hits) dup.set(h.name, (dup.get(h.name) ?? 0) + 1);
  const showName = (h: AllSearchHit) => h.name + ((dup.get(h.name) ?? 0) > 1 ? '｜' + h.file : '');
  list.innerHTML = rows.map((h) => {
    const cls = 'allSearchRow' + (h.state === 'done' ? ' done' : '');
    if (h.state === 'pending' || h.state === 'running') {
      return `<div class="${cls}" data-key="${escapeHtml(h.key)}">`
        + `<span class="n">${escapeHtml(showName(h))}</span>`
        + `<span class="t">${h.state === 'running' ? '查詢中…' : '排隊中'}</span></div>`;
    }
    if (h.state === 'error') {
      return `<div class="${cls}" data-key="${escapeHtml(h.key)}">`
        + `<span class="n">${escapeHtml(showName(h))}</span>`
        + `<span class="t">失敗：${escapeHtml(h.error ?? '')}</span></div>`;
    }
    return `<button type="button" class="${cls}" data-key="${escapeHtml(h.key)}" title="打開 ${escapeHtml(h.file)} 並用這個查詢細看">`
      + `<span class="n">${escapeHtml(showName(h))}</span>`
      + `<span class="c${h.hits ? '' : ' zero'}">${h.hits.toLocaleString('en-US')}</span>`
      + `<span class="t">${Math.round(h.ms)} ms</span></button>`;
  }).join('');
  list.querySelectorAll<HTMLElement>('.allSearchRow[data-key]').forEach((row) => {
    if (row.tagName !== 'BUTTON') return;
    row.onclick = async () => {
      const h = hits.find((x) => x.key === row.dataset.key);
      if (!h) return;
      const entry = catalog.find((e) => e.key === h.key);
      const qtext = ($('#allSearchQuery') as HTMLInputElement | null)?.value ?? '';
      closeSearchAll();
      // 先等庫真的開好，再把查詢帶進主輸入框（否則會被開庫的清場蓋掉）
      if (entry) await openCatalogEntry(entry);
      // 帶到左欄「目前 active 的那個分頁」的輸入框（作者 2026-10）
      const tab = qtext ? carryQueryToActiveTab(qtext) : '';
      setStatus(`已在「${h.name}」查詢：${qtext}（左欄分頁：${tab}）`, 'info');
    };
  });
}

/* ------------------------------------------------- 萬用字元的進度與結果 */

const fmtInt = (n: number): string => n.toLocaleString('en-US');

function paintProgress(p: WildRun['progress']): void {
  const box = $('#allSearchProg');
  const fill = $('#allSearchBarFill') as HTMLElement | null;
  const text = $('#allSearchProgText');
  const stop = $('#allSearchStop') as HTMLButtonElement | null;
  if (box) box.hidden = false;
  const total = p.blocksTotal;
  const pct = total > 0 ? Math.min(100, Math.round((p.blocksDone / total) * 100)) : (p.phase === 'done' ? 100 : 0);
  if (fill) fill.style.width = pct + '%';
  if (stop) stop.hidden = p.phase !== 'scanning';
  if (!text) return;
  const remain = Math.max(0, total - p.blocksDone);
  const head = p.phase === 'scanning'
    ? `掃描中：${p.db}（第 ${p.dbIndex + 1} / ${p.dbTotal} 個庫）`
    : p.phase === 'aborted' ? '已中斷' : '掃描完成';
  const seg = total > 0
    ? `已掃 ${fmtInt(p.blocksDone)} / ${fmtInt(total)} 段（剩 ${fmtInt(remain)}）`
    : '';
  text.textContent = `${head}　找到 ${fmtInt(p.hits)} 筆（${fmtInt(p.forms)} 種字串）`
    + (seg ? `　${seg}` : '') + (p.ms ? `　${(p.ms / 1000).toFixed(1)} 秒` : '');
}

/** 命中的字串清單：次數多的在前；點一下打開那個庫、跳到第一次出現 */
function paintForms(state: WildRun): void {
  const box = $('#allSearchForms');
  if (!box) return;
  const forms = state.forms.slice(0, 300);
  box.innerHTML = forms.map((f, i) => `<button type="button" class="allSearchForm" data-i="${i}"`
    + ` title="打開「${escapeHtml(f.dbName)}」跳到第一次出現（第 ${fmtInt(f.line)} 行）">`
    + `<b>${escapeHtml(f.text)}</b><span>${fmtInt(f.count)}</span>`
    + `<span class="db">${escapeHtml(f.dbName)}</span></button>`).join('');
  box.querySelectorAll<HTMLElement>('.allSearchForm').forEach((el) => {
    el.onclick = async () => {
      const f = state.forms[Number(el.dataset.i)];
      if (!f) return;
      const entry = catalog.find((e) => e.key === f.dbKey);
      closeSearchAll();
      if (entry) await openCatalogEntry(entry);
      jumpToAdbLine(f.line);
      setStatus(`「${f.text}」第一次出現在「${f.dbName}」第 ${fmtInt(f.line)} 行`, 'info');
    };
  });
}

/** 萬用字元模式要掃哪些庫的預覽（給提示文字用） */
function wildTargetsText(): string {
  if (mode === 'single') {
    const t = $('#docTabs .docChip.active')?.textContent ?? '';
    void t;
    return '只掃目前打開的那個庫';
  }
  return `掃清單上 ${catalog.length} 個庫`;
}

function renderWild(state: WildRun): void {
  lastWild = state;
  // 每個庫的命中數也用同一份清單顯示（跟索引模式一樣好讀）
  hits = state.dbs.map((d) => ({
    key: d.key, name: d.name, file: d.file, hits: d.hits, ms: d.ms,
    state: d.state === 'error' ? 'error' : (d.state === 'running' || d.state === 'pending' ? d.state : 'done'),
    error: d.error,
  }));
  renderList();
  paintProgress(state.progress);
  paintForms(state);
  const msg = $('#allSearchMsg');
  if (msg && state.progress.phase !== 'scanning') {
    const withHits = state.dbs.filter((d) => d.hits > 0).length;
    msg.textContent = `${mode === 'single' ? '單庫' : '全庫'}萬用：${state.dbs.length} 個庫、`
      + `${withHits} 個有命中、合計 ${fmtInt(state.progress.hits)} 筆（${fmtInt(state.progress.forms)} 種字串）`
      + `　${(state.progress.ms / 1000).toFixed(1)} 秒`
      + (state.progress.phase === 'aborted' ? '（已中斷）' : '');
  }
}

/* ---------------------------------------------------------------- 執行 */

/** 查一個庫的命中數（暫時的 reader，查完就放掉） */
async function countInDb(file: AdbSource, query: string): Promise<number> {
  const reader = await AdbReader.open(new BlobIO(file));
  try {
    const session = new SearchSession(reader);
    await session.init();
    const res = await session.search(query);
    return res.hits.length;
  } finally {
    reader.io.close?.();
  }
}

/**
 * 「索引」模式：依序查每一個庫，**每查完一個就更新清單**（作者指定的行為）。
 * 再按一次「搜尋全部」會取消前一次（`runSeq`），避免兩輪結果交錯。
 */
async function runIndexSearch(text: string): Promise<void> {
  const seq = ++runSeq;
  busy = true;
  syncBusyUi();
  const msg = $('#allSearchMsg');
  hits = catalog.map((e) => ({
    key: e.key, name: e.name, file: e.file.name, hits: 0, ms: 0, state: 'pending',
  }));
  renderList();
  let doneCount = 0;
  let total = 0;
  for (const h of hits) {
    if (seq !== runSeq) return;                  // 被新的查詢取代
    const entry = catalog.find((e) => e.key === h.key);
    if (!entry) continue;
    h.state = 'running';
    if (msg) msg.textContent = `查詢中：${h.name}（${doneCount + 1} / ${hits.length}）`;
    renderList();
    const t0 = performance.now();
    try {
      h.hits = await countInDb(entry.file, text);
      h.state = 'done';
    } catch (e) {
      h.state = 'error';
      h.error = (e as Error).message.slice(0, 40);
      h.hits = 0;
    }
    h.ms = performance.now() - t0;
    doneCount++;
    total += h.hits;
    if (seq !== runSeq) return;
    renderList();
  }
  busy = false;
  syncBusyUi();
  if (msg) {
    const withHits = hits.filter((h) => h.hits > 0).length;
    msg.textContent = `查完了：${hits.length} 個庫、${withHits} 個有命中、合計 ${total.toLocaleString('en-US')} 筆（點一列打開該庫）`;
  }
  setStatus(`搜尋所有 adb：「${text}」→ ${total.toLocaleString('en-US')} 筆`, 'info');
}

function syncBusyUi(): void {
  const go = $('#allSearchGo') as HTMLButtonElement | null;
  if (go) go.disabled = busy;
  const stop = $('#allSearchStop') as HTMLButtonElement | null;
  if (stop) stop.hidden = !busy;
}

/** 萬用字元模式：掃描（有進度、可中斷） */
async function runWildSearch(pat: WildPattern): Promise<void> {
  const myMode = mode;
  busy = true;
  syncBusyUi();
  const msg = $('#allSearchMsg');
  if (msg) msg.textContent = `掃描中…（${myMode === 'single' ? '單庫' : '全庫'}，${pat.describe}）`;
  const forms = $('#allSearchForms');
  if (forms) forms.innerHTML = '';
  hits = [];
  renderList();
  const t0 = performance.now();
  try {
    const out = await startWildSearch(pat, {
      scope: myMode === 'single' ? 'single' : 'all',
      onProgress: (st) => { if (mode === myMode) renderWild(st); },
    });
    if (mode !== myMode) return;
    renderWild(out);
    setStatus(`萬用「${pat.raw}」：${out.progress.hits.toLocaleString('en-US')} 筆／`
      + `${out.progress.forms.toLocaleString('en-US')} 種字串（${((performance.now() - t0) / 1000).toFixed(1)} 秒`
      + `${out.progress.phase === 'aborted' ? '，已中斷' : ''}）`, 'info');
  } catch (e) {
    if (msg) msg.textContent = '掃描失敗：' + (e as Error).message;
    setStatus('掃描失敗：' + (e as Error).message, 'err');
  } finally {
    busy = false;
    syncBusyUi();
    syncModeUi();
  }
}

/** 使用者按「搜尋全部」／Enter：依目前模式走索引或萬用 */
export async function runSearchAll(query: string): Promise<void> {
  const text = query.trim();
  if (!text) return;
  if (mode === 'index') { await runIndexSearch(text); return; }
  const pat = parseWildcard(text);
  if (!pat.ok) {
    const msg = $('#allSearchMsg');
    if (msg) msg.textContent = '萬用樣式有問題：' + (pat.error ?? '');
    setStatus('萬用樣式有問題：' + (pat.error ?? ''), 'err');
    return;
  }
  if (mode === 'single' && !(wildState().dbs ?? []).length) {
    // 單庫模式需要先開一個庫；startWildSearch 會回空清單，這裡先講清楚
    const hasDb = catalog.length > 0;
    if (!hasDb) { setStatus('單庫萬用：請先開啟一個 adb', 'err'); return; }
  }
  await runWildSearch(pat);
}

/** 中斷目前掃描（作者：隨時可以停） */
export function stopSearchAll(): void {
  abortWildSearch();
  const stop = $('#allSearchStop') as HTMLButtonElement | null;
  if (stop) stop.hidden = true;
}

/** 開機接線（按鈕、模式、關閉、Esc） */
export function initSearchAll(): void {
  mode = readMode();
  ($('#searchAllBtn') as HTMLButtonElement | null)?.addEventListener('click', () => openSearchAll());
  ($('#allSearchClose') as HTMLElement | null)?.addEventListener('click', () => closeSearchAll());
  ($('#allSearchBackdrop') as HTMLElement | null)?.addEventListener('click', () => closeSearchAll());
  document.querySelectorAll<HTMLElement>('#allSearchMode button').forEach((b) => {
    b.addEventListener('click', () => setAllSearchMode(modeOf(b.dataset.mode)));
  });
  ($('#allSearchGo') as HTMLButtonElement | null)?.addEventListener('click', () => {
    const q = ($('#allSearchQuery') as HTMLInputElement | null)?.value ?? '';
    void runSearchAll(q);
  });
  ($('#allSearchStop') as HTMLButtonElement | null)?.addEventListener('click', () => stopSearchAll());
  ($('#allSearchQuery') as HTMLInputElement | null)?.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      const q = (ev.target as HTMLInputElement).value;
      void runSearchAll(q);
    }
    if (ev.key === 'Escape') { ev.stopPropagation(); closeSearchAll(); }
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && open) { ev.stopPropagation(); closeSearchAll(); }
  }, true);
  syncModeUi();
}
