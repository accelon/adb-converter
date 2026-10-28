/**
 * 右側「反鏈清單」抽屜（2026-10-28）：反鏈那一排遇到 100+ 條時的完整清單。
 *
 * 由 bar 的「清單」按鈕打開；按來源書分組、可搜尋，三種排序（頻次／來源序／目標序）。
 * 點一列直接回 foreign 頁（沿用 xref 的 data-rrev 委派）。
 */
import { reverseItemsForPage, sortRevItems, type RevItem, type RevSort } from './xref';

let hostDb = '';
let pageId = '';
let hostName = '';
let mode: RevSort = 'freq';
let items: RevItem[] = [];
let fixedItems: RevItem[] | null = null;
let inited = false;
let loading = false;

const $id = <T extends HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function revRowHtml(it: RevItem): string {
  const rawQuote = it.tq || it.quote || it.cite || '';
  const qm = /\bq="([^"]+)"/.exec(rawQuote);
  const quote = (qm ? qm[1] : rawQuote)
    .replace(/<[^>]*>/g, '')
    .replace(/[<>]/g, '')
    .trim();
  return '<button class="revListRow" type="button" data-rrev="' + esc(it.src + '|' + it.va) + '"'
    + ' data-rrev-label="' + esc(it.full + ' ' + it.pageId) + '" data-rpage="' + esc(it.pageId) + '"'
    + ' data-rcite="' + esc(it.cite) + '" data-rquote="' + esc(it.quote) + '">'
    + '<span class="revListBook">' + esc(it.full) + '</span>'
    + '<span class="revListPage">' + esc(it.pageId) + '</span>'
    + (it.count > 1 ? '<span class="revListN">×' + it.count + '</span>' : '')
    + (quote ? '<span class="revListQuote">' + esc(quote.slice(0, 90)) + '</span>' : '')
    + '</button>';
}

function paint(): void {
  const body = $id('revListBody');
  const sub = $id('revListSub');
  if (!body) return;
  if (sub) sub.textContent = (hostName || hostDb) + (pageId ? ' ' + pageId : '') + ' · ' + items.length + ' 筆';
  const q = ($id<HTMLInputElement>('revListFilter')?.value ?? '').trim();
  const shown = q
    ? items.filter((it) => (it.full + ' ' + it.pageId + ' ' + (it.quote || '') + ' ' + (it.cite || '')).includes(q))
    : items;
  let last = '';
  const rows: string[] = [];
  for (const it of shown) {
    if (it.full !== last) {
      rows.push('<div class="revListGroup">' + esc(it.full) + '</div>');
      last = it.full;
    }
    rows.push(revRowHtml(it));
  }
  body.innerHTML = rows.join('') || '<p class="dim">沒有符合的反鏈。</p>';
  document.querySelectorAll<HTMLElement>('#revList [data-revsort]').forEach((b) => b.classList.toggle('active', b.dataset.revsort === mode));
}

async function load(): Promise<void> {
  if (loading) return;
  if (fixedItems) { items = sortRevItems(fixedItems, mode); paint(); return; }
  if (!hostDb || !pageId) return;
  loading = true;
  const body = $id('revListBody');
  if (body) body.innerHTML = '<p class="dim">載入中…</p>';
  try {
    items = await reverseItemsForPage(hostDb, pageId, mode);
    paint();
  } finally {
    loading = false;
  }
}

export async function openRevList(host: string, page: string, name = ''): Promise<void> {
  hostDb = host;
  pageId = page;
  hostName = name;
  fixedItems = null;
  mode = 'freq';
  const box = $id('revList');
  if (box) box.hidden = false;
  const input = $id<HTMLInputElement>('revListFilter');
  if (input) input.value = '';
  await load();
}

/** 由熱圖格子打開：直接給現成的 items，不再查頁。 */
export function openRevListItems(title: string, list: RevItem[]): void {
  hostDb = '';
  pageId = '';
  hostName = title;
  fixedItems = list;
  items = sortRevItems(list, 'freq');
  mode = 'freq';
  const box = $id('revList');
  if (box) box.hidden = false;
  const input = $id<HTMLInputElement>('revListFilter');
  if (input) input.value = '';
  paint();
}

export function closeRevList(): void {
  const box = $id('revList');
  if (box) box.hidden = true;
}

export function initRevList(): void {
  if (inited) return;
  inited = true;
  $id('revListClose')?.addEventListener('click', closeRevList);
  $id('revList')?.addEventListener('click', (ev) => {
    if (ev.target === ev.currentTarget) closeRevList();
  });
  $id<HTMLInputElement>('revListFilter')?.addEventListener('input', paint);
  document.querySelectorAll<HTMLElement>('#revList [data-revsort]').forEach((b) => {
    b.addEventListener('click', () => {
      mode = (b.dataset.revsort as RevSort) || 'freq';
      void load();
    });
  });
  document.addEventListener('accelon26:revlist', (ev) => {
    const d = (ev as CustomEvent<{ host?: string; page?: string; name?: string }>).detail ?? {};
    if (d.host && d.page) void openRevList(d.host, d.page, d.name ?? '');
  });
  // 點一列後，讓 xref 的 data-rrev 委派去導航，再把抽屜收起
  $id('revListBody')?.addEventListener('click', (ev) => {
    if ((ev.target as Element | null)?.closest?.('[data-rrev]')) setTimeout(closeRevList, 50);
  });
  window.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      const box = $id('revList');
      if (box && !box.hidden) closeRevList();
    }
  });
}
