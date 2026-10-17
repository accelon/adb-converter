/**
 * 搜尋所有 adb（作者 2026-10）
 *
 * header 的 `#searchAllBtn`（放大鏡）打開 `#allSearchBox`：輸入查詢 → 「搜尋全部」→
 * **一個庫查完就更新一次清單**（所以慢的庫不會擋住快的庫），最後按命中數由多到少排序。
 * 使用者再點某一列打開那個庫、把查詢帶進主搜尋框細看。
 *
 * 這支刻意**不切換目前的分頁**：它自己開一個暫時的 `AdbReader`（只讀檔頭＋tokens），
 * 查完就丟掉，所以不會動到 `openDbs` 的 5 個名額，也不會干擾讀者的本文。
 */
import { AdbReader, BlobIO, type AdbSource } from './adb';
import { SearchSession } from './search';
import { catalog, openCatalogEntry } from './dbs';
import { $, escapeHtml, setStatus } from './viewer';

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

let hits: AllSearchHit[] = [];
let open = false;
let runSeq = 0;
let busy = false;
/** 清單被重畫的次數（作者指定的「每查一個 adb 更新一次」——測試用它當證據） */
let renderCount = 0;

export function allSearchOpen(): boolean { return open; }

export function searchAllState(): {
  open: boolean; busy: boolean; query: string; renderCount: number;
  rows: { name: string; file: string; hits: number; state: string; ms: number }[];
} {
  return {
    open,
    busy,
    renderCount,
    query: ($('#allSearchQuery') as HTMLInputElement | null)?.value ?? '',
    rows: hits.map((h) => ({ name: h.name, file: h.file, hits: h.hits, state: h.state, ms: h.ms })),
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
 * 依序查每一個庫，**每查完一個就更新清單**（作者指定的行為）。
 * 再按一次「搜尋全部」會取消前一次（`runSeq`），避免兩輪結果交錯。
 */
export async function runSearchAll(query: string): Promise<void> {
  const text = query.trim();
  if (!text) return;
  const seq = ++runSeq;
  busy = true;
  const btn = $('#allSearchGo') as HTMLButtonElement | null;
  if (btn) btn.disabled = true;
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
  if (btn) btn.disabled = false;
  if (msg) {
    const withHits = hits.filter((h) => h.hits > 0).length;
    msg.textContent = `查完了：${hits.length} 個庫、${withHits} 個有命中、合計 ${total.toLocaleString('en-US')} 筆（點一列打開該庫）`;
  }
  setStatus(`搜尋所有 adb：「${text}」→ ${total.toLocaleString('en-US')} 筆`, 'info');
}

/** 開機接線（按鈕、關閉、Esc） */
export function initSearchAll(): void {
  ($('#searchAllBtn') as HTMLButtonElement | null)?.addEventListener('click', () => openSearchAll());
  ($('#allSearchClose') as HTMLElement | null)?.addEventListener('click', () => closeSearchAll());
  ($('#allSearchBackdrop') as HTMLElement | null)?.addEventListener('click', () => closeSearchAll());
  ($('#allSearchGo') as HTMLButtonElement | null)?.addEventListener('click', () => {
    const q = ($('#allSearchQuery') as HTMLInputElement | null)?.value ?? '';
    void runSearchAll(q);
  });
  ($('#allSearchQuery') as HTMLInputElement | null)?.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      const q = (ev.target as HTMLInputElement).value;
      void runSearchAll(q);
    }
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && open) { ev.stopPropagation(); closeSearchAll(); }
  }, true);
}
