/**
 * 注疏索引（study block，作者 2026-10-29）。
 *
 * 不用 <樹> 表達注疏群：直接列「經文 → 注疏名稱 → 大正頁鏈結」。
 * `study` 容器的 `index` block 由 build/jingqun/make-study-index.ts 產生。
 */
import { $, escapeHtml, reader } from './viewer';
import { openTaishoAt, anchorVa } from './xref';
import { linkTo } from './link';
import { activeSlot, openDbs, switchTo } from './dbs';

interface Target { db: string; page: string; range: string; label: string }
interface Group {
  book: string;
  chapter: string;
  page: string;
  rel: number;
  end: number;
  quote: string;
  n: number;
  targets: Target[];
}

let groups: Group[] = [];
let loadedFor: unknown = null;
let open = false;

function render(): void {
  const list = $('#studyIndexList');
  const sub = $('#studyIndexSub');
  const status = $('#studyIndexStatus');
  if (!list) return;
  const q = ($('#studyIndexFilter') as HTMLInputElement | null)?.value.trim().toLowerCase() ?? '';
  const shown = q
    ? groups.filter((g) => (g.book + ' ' + g.chapter + ' ' + g.quote + ' ' + g.page + ' ' +
        g.targets.map((t) => t.label).join(' ')).toLowerCase().includes(q))
    : groups;
  if (sub) sub.textContent = `${shown.length}／${groups.length} 群`;
  if (status) status.textContent = '點注疏名稱開右欄目標；點「經文」回到這一頁。';
  if (!shown.length) {
    list.innerHTML = '<p class="studyIdxEmpty">沒有符合的注疏群。</p>';
    return;
  }
  let html = '';
  let lastBook = '';
  let lastChapter = '';
  for (const g of shown) {
    if (g.book !== lastBook) {
      lastBook = g.book;
      lastChapter = '';
      html += `<div class="studyIdxBook">${escapeHtml(g.book)}</div>`;
    }
    if (g.chapter !== lastChapter) {
      lastChapter = g.chapter;
      if (g.chapter) html += `<div class="studyIdxChapter">${escapeHtml(g.chapter)}</div>`;
    }
    const quote = g.quote.length > 150 ? g.quote.slice(0, 150) + '…' : g.quote;
    html += `<div class="studyIdxRow">
      <div class="studyIdxQuote"><span class="studyIdxPage">${escapeHtml(g.page)}</span>${escapeHtml(quote)}</div>
      <div class="studyIdxTargets">
        <button type="button" class="studyIdxJump" data-jump="${escapeHtml(g.page)}">經文</button>
        ${g.targets.map((t) => `<button type="button" data-db="${escapeHtml(t.db)}" data-page="${escapeHtml(t.page)}" data-range="${escapeHtml(t.range)}" data-label="${escapeHtml(t.label)}">${escapeHtml(t.label)}</button>`).join('')}
      </div>
    </div>`;
  }
  list.innerHTML = html;
}

async function load(): Promise<void> {
  const list = $('#studyIndexList');
  if (!list) return;
  if (!reader) {
    list.innerHTML = '<p class="studyIdxEmpty">尚未開啟資料庫。</p>';
    return;
  }
  if (loadedFor === reader && groups.length) { render(); return; }
  list.innerHTML = '<p class="dim">正在讀取注疏索引…</p>';
  try {
    const bytes = await reader.readBlock('study', 0);
    const text = new TextDecoder().decode(bytes);
    const data = JSON.parse(text) as { groups?: Group[] };
    groups = Array.isArray(data.groups) ? data.groups : [];
    loadedFor = reader;
  } catch {
    groups = [];
    loadedFor = reader;
    list.innerHTML = '<p class="studyIdxEmpty">這個 adb 沒有注疏索引（study block）。</p>';
    return;
  }
  render();
}

export function refreshStudyIndexButton(): void {
  const btn = $('#studyIndexBtn') as HTMLButtonElement | null;
  if (!btn) return;
  // 只要工作階段裡有 study 庫就保留按鈕；即使現在正在看 taisho，也不讓它消失。
  btn.hidden = !openDbs.some((d) =>
    d.name === '大正藏研究' || /taisho-study/i.test(d.file.name));
}

export function openStudyIndex(): void {
  const study = openDbs.find((d) =>
    d.name === '大正藏研究' || /taisho-study/i.test(d.file.name));
  if (study && activeSlot()?.id !== study.id) {
    switchTo(study.id, true);
    // switchTo 會同步換 reader；等一拍讓畫面與 reader 都穩定。
    setTimeout(() => { open = true; showAndLoad(); }, 0);
    return;
  }
  open = true;
  showAndLoad();
}

function showAndLoad(): void {
  const back = $('#studyIndexBackdrop');
  const box = $('#studyIndexBox');
  if (back) back.hidden = false;
  if (box) box.hidden = false;
  void load();
}

export function closeStudyIndex(): void {
  open = false;
  const back = $('#studyIndexBackdrop');
  const box = $('#studyIndexBox');
  if (back) back.hidden = true;
  if (box) box.hidden = true;
}

export function initStudyIndex(): void {
  $('#studyIndexBtn')?.addEventListener('click', openStudyIndex);
  $('#studyIndexClose')?.addEventListener('click', closeStudyIndex);
  $('#studyIndexBackdrop')?.addEventListener('click', closeStudyIndex);
  $('#studyIndexFilter')?.addEventListener('input', render);
  window.addEventListener('accelon-db-changed', refreshStudyIndexButton);
  $('#studyIndexList')?.addEventListener('click', (ev) => {
    const el = (ev.target as Element | null)?.closest?.('button') as HTMLButtonElement | null;
    if (!el) return;
    const jump = el.dataset.jump;
    if (jump) {
      void (async () => {
        const va = reader ? await anchorVa(reader, jump) : null;
        if (va == null) return;
        closeStudyIndex();
        await linkTo(va, jump, 1, { exact: false, name: jump });
      })();
      return;
    }
    const db = el.dataset.db;
    const page = el.dataset.page;
    if (!db || !page) return;
    void openTaishoAt(db, page, el.dataset.label ?? page, el.dataset.range ?? '').then(closeStudyIndex);
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && open) {
      ev.preventDefault();
      closeStudyIndex();
    }
  });
  refreshStudyIndexButton();
}
