/**
 * 右欄「文字內容」分頁 — a SECOND reading pane, for reference only.
 *
 * It is deliberately its own module because the RENDERING is going to change: today a
 * line is drawn as plain text (the line table through `mapper.docText`), next the XML
 * tags inside a line will become HTML. Nothing here touches the left tree or the
 * cursor — the reader's rule is that only the MIDDLE pane drives those, and this pane
 * is a copy to compare against.
 *
 * Who fills it: Ctrl+點 a tree node, or Ctrl+點 (複製) / Shift+點 (搬移) a 本文分頁.
 */
import { $, displayName, escapeHtml, fmtInt, mapper, reader } from './viewer';
import { PAGE_LINES, boundsOfRealm, closeDocTab, docTabs, hardBreaksOn, pageBounds, pageMarksOn, renderRawOn } from './doc-pane';
import { renderPageBlocks } from './render_accelon3';
import { isDictDb } from './db-kind';
import { dirActive, dirTrees, findNode } from './scopes';

export interface TextTab {
  id: number; label: string; realm: { from: number; to: number }; page: number;
  /** 跨庫內容（<聯 i="db?anchor">）：這一個分頁畫的是別庫的某個 VA */
  foreign?: { db: string; va: number; anchor?: string; quote?: string; j?: string };
}

/** 由 xref.ts 注入：把別庫的 VA 畫成 HTML（避免 text-pane 依賴 AdbReader） */
export type ForeignRender = (db: string, va: number, anchor?: string, quote?: string, j?: string) => Promise<{ html: string; title: string }>;
let foreignRender: ForeignRender | null = null;
let ensureRight: (() => void) | null = null;
/** 由 ui.ts 注入：把右欄打開（點聯時如果側欄收起來了） */
export function setEnsureRight(fn: () => void): void { ensureRight = fn; }
export function ensureRightPane(): void { ensureRight?.(); }
export function setForeignRender(fn: ForeignRender): void { foreignRender = fn; }

type OpenInMainFn = (db: string, opts: { va?: number; anchor?: string; label?: string }) => Promise<boolean>;
let openInMainFn: OpenInMainFn | null = null;
/** ui.ts 註冊：Ctrl+點右欄跨庫分頁 → 切到那個庫、在中間開啟同一頁（2026-10-30）。 */
export function setOpenInMain(fn: OpenInMainFn): void { openInMainFn = fn; }

let textTabs: TextTab[] = [];
let textActive = 0;
let seq = 0;
let cache: { key: string; dt: any } | null = null;
let lastText: { ms: number; rows: number; lines: number; blockFirst?: number; blockLast?: number } | null = null;

const realmKey = (r: { from: number; to: number }) => r.from + ':' + r.to;
const EMPTY = '<p class="dim">在目錄樹 Ctrl+點節點，或在下方本文分頁 Ctrl+點（複製）／Shift+點（搬到這裡），就會把那段文字放到這裡比對。<br>這一欄純參考：不會連動左邊的樹。</p>';

function shorten(s: string, max = 8): string {
  const t = displayName(s).trim();
  return t.length > max ? t.slice(0, max) + '…' : t;
}

/** the tab strip (and the 文字內容 tab itself) only shows when there is something in it */
function syncTextTab(): void {
  const btn = $('#colRight .tabBtn[data-tab="text"]') as HTMLElement | null;
  if (btn) btn.hidden = textTabs.length === 0;
  const strip = $('#textTabs');
  if (!strip) return;
  strip.innerHTML = textTabs.map((t, i) =>
    '<span class="docTab' + (i === textActive ? ' active' : '') + '" data-i="' + i + '" title="' + escapeHtml(t.label) + '">'
    + '<span class="docTabName">' + escapeHtml(shorten(t.label, t.foreign ? 16 : 8)) + '</span>'
    + '<span class="docTabClose" data-close="' + i + '" title="關閉">✕</span></span>').join('');
  strip.querySelectorAll<HTMLElement>('.docTab').forEach((el) => {
    el.onclick = (ev) => {
      const close = (ev.target as HTMLElement | null)?.closest('.docTabClose') as HTMLElement | null;
      if (close) { ev.stopPropagation(); closeTextTab(Number(close.dataset.close)); return; }
      const i = Number(el.dataset.i);
      const t = textTabs[i];
      // Ctrl/⌘+點跨庫分頁：切到那個庫，在中間開啟同一頁
      if ((ev.ctrlKey || ev.metaKey) && t?.foreign) {
        ev.preventDefault();
        void openInMainFn?.(t.foreign.db, { va: t.foreign.va, anchor: t.foreign.anchor, label: t.label });
        return;
      }
      if (i !== textActive) { textActive = i; void renderTextPane(); }
    };
  });
}

/**
 * Put a realm's text in the right column and show it. The same realm reuses its tab
 * (comparing one node against another should not pile up duplicates).
 */
export async function openTextTab(realm: { from: number; to: number }, label: string): Promise<void> {
  if (!reader || !mapper) return;
  ensureRightPane();
  const at = textTabs.findIndex((t) => realmKey(t.realm) === realmKey(realm));
  if (at >= 0) textActive = at;
  else { textTabs.push({ id: ++seq, label, realm, page: 0 }); textActive = textTabs.length - 1; }
  syncTextTab();
  const btn = $('#colRight .tabBtn[data-tab="text"]') as HTMLButtonElement | null;
  // clicking the tab is what switches the right column (boot() wired it to showTab)
  if (btn) { btn.hidden = false; btn.click(); }
  else await renderTextPane();
}

/**
 * 把別庫的一段文字放進右欄（<聯 i="db?anchor">）。
 * newTab=false 時沿用既有的跨庫分頁；true（Ctrl）就再開一個。
 */
export function openForeignTab(db: string, va: number, label: string, newTab = false, anchor?: string, quote?: string, j?: string): void {
  ensureRightPane();
  if (!newTab) {
    const at = textTabs.findIndex((t) => t.foreign);
    if (at >= 0) {
      textTabs[at] = { ...textTabs[at], label, foreign: { db, va, anchor, quote, j } };
      textActive = at;
      syncTextTab();
      const btn0 = $('#colRight .tabBtn[data-tab="text"]') as HTMLButtonElement | null;
      if (btn0) { btn0.hidden = false; btn0.click(); } else void renderTextPane();
      return;
    }
  }
  textTabs.push({ id: ++seq, label, realm: { from: 0, to: 0 }, page: 0, foreign: { db, va, anchor, quote, j } });
  textActive = textTabs.length - 1;
  syncTextTab();
  const btn = $('#colRight .tabBtn[data-tab="text"]') as HTMLButtonElement | null;
  if (btn) { btn.hidden = false; btn.click(); } else void renderTextPane();
}

export function closeTextTab(i: number): void {
  if (i < 0 || i >= textTabs.length) return;
  textTabs.splice(i, 1);
  if (!textTabs.length) {
    textActive = 0;
    cache = null;
    const body = $('#textBody');
    if (body) body.innerHTML = EMPTY;
    const pager = $('#textPager') as HTMLElement | null;
    if (pager) pager.hidden = true;
    syncTextTab();
    return;
  }
  textActive = Math.max(0, Math.min(textActive > i ? textActive - 1 : textActive, textTabs.length - 1));
  void renderTextPane();
}

/**
 * Draw the active tab's page. This is the ONLY place that decides how a line looks,
 * which is the point of the module: the XML→HTML rendering will land here.
 */
export async function renderTextPane(): Promise<void> {
  const body = $('#textBody');
  if (!body) return;
  syncTextTab();
  const t = textTabs[textActive];
  if (t?.foreign) {
    if (!foreignRender) { body.innerHTML = EMPTY; return; }
    body.innerHTML = '<p class="dim">載入中…</p>';
    const fr = await foreignRender(t.foreign.db, t.foreign.va, t.foreign.anchor, t.foreign.quote, t.foreign.j);
    body.innerHTML = fr.html;
    const pager0 = $('#textPager') as HTMLElement | null;
    if (pager0) pager0.hidden = true;
    // 有塗紅就把那一段捲到視窗中央（回印順時直接看到引註）
    const hit = body.querySelector('mark.xrefHit') as HTMLElement | null;
    if (hit) hit.scrollIntoView({ block: 'center' });
    else body.scrollTo(0, 0);
    return;
  }
  if (!t || !mapper || !reader) { body.innerHTML = EMPTY; return; }
  const b = boundsOfRealm(t.realm);
  const pb = pageBounds(t.realm, t.page);
  t.page = Math.max(0, Math.min(t.page, pb.pages - 1));
  // the VA span comes from the PAGE's lines (a node can span several files)
  const v = mapper.linesVirtual;
  const vaStart = pb.first > 0 ? (v[pb.first - 1] ?? 0) : 0;
  const vaEnd = (v[pb.last] ?? reader.header.maxBlockOffset) + 1;
  const key = realmKey(t.realm) + ':' + pb.first + '-' + pb.last;
  const t0 = performance.now();
  if (!cache || cache.key !== key) {
    cache = { key, dt: await mapper.docText(vaStart, vaEnd, pb.last - pb.first + 1, undefined, { first: pb.first, last: pb.last }) };
  }
  const dt = cache.dt;
  lastText = { ms: performance.now() - t0, rows: dt.lines.length, lines: b.total, blockFirst: dt.blockFirst, blockLast: dt.blockLast };
  const nums: number[] = dt.lineNumbers;
  // 詞典型 adb 不顯示 docHead（作者 2026-10，同 doc-pane 的理由）
  const head = isDictDb(mapper)
    ? ''
    : '<div class="docHead">' + escapeHtml(displayName(t.label))
      + '<span class="dim">第 ' + fmtInt(t.page + 1) + ' / ' + fmtInt(pb.pages) + ' 頁'
      + ' · 行 ' + fmtInt(nums[0] ?? 0) + '–' + fmtInt(nums[nums.length - 1] ?? 0) + ' / 此節點共 ' + fmtInt(b.total) + ' 行'
      + ' · ' + fmtInt(dt.text.length) + ' 字</span></div>';
  // 一頁的版面：保留硬換行＝每行一列；不保留＝整段連排（作者 2026-10）
  const blocks = renderRawOn()
    ? dt.lines.map((line, i) => ({ kind: 'line' as const, lines: [{ no: nums[i] ?? 0, html: escapeHtml(line), raw: line, visible: true, heading: false }] }))
    : renderPageBlocks(dt.lines, nums, { hardBreaks: hardBreaksOn(), pageMarks: pageMarksOn() });
  const rows = blocks.map((block) => {
    if (block.kind === 'line') {
      return '<div class="docLine"><div class="lineText">' + block.lines[0].html + '</div></div>';
    }
    const inner = block.lines
      .map((l) => '<span class="docLine"><span class="lineText">' + l.html + '</span></span>')
      .join('');
    const tag = block.kind === 'heading' ? 'div' : 'p';
    return '<' + tag + ' class="' + (block.kind === 'heading' ? 'docPara docParaHeading' : 'docPara') + '">' + inner + '</' + tag + '>';
  });
  body.innerHTML = head + '<div class="docBody' + (hardBreaksOn() ? '' : ' reflow') + '">' + rows.join('') + '</div>';
  const pager = $('#textPager') as HTMLElement | null;
  if (pager) {
    pager.hidden = pb.pages < 2;
    const info = $('#textPageInfo');
    if (info) info.textContent = '第 ' + fmtInt(t.page + 1) + ' / ' + fmtInt(pb.pages) + ' 頁（每頁 ' + fmtInt(PAGE_LINES) + ' 行）';
    const prev = $('#textPrev') as HTMLButtonElement | null;
    const next = $('#textNext') as HTMLButtonElement | null;
    if (prev) { prev.onclick = () => { t.page = Math.max(0, t.page - 1); void renderTextPane(); }; prev.setAttribute('aria-disabled', String(t.page <= 0)); }
    if (next) { next.onclick = () => { t.page = Math.min(pb.pages - 1, t.page + 1); void renderTextPane(); }; next.setAttribute('aria-disabled', String(t.page >= pb.pages - 1)); }
  }
  body.scrollTo(0, 0);
}

/** diagnostics for tests/state() */
export const textState = () => ({
  tabs: textTabs.map((t) => ({ label: t.label, from: t.realm.from, to: t.realm.to, page: t.page })),
  active: textActive,
  last: lastText,
});

export function resetTextPane(): void {
  textTabs = [];
  textActive = 0;
  cache = null;
  lastText = null;
  const body = $('#textBody');
  if (body) body.innerHTML = EMPTY;
  const pager = $('#textPager') as HTMLElement | null;
  if (pager) pager.hidden = true;
  syncTextTab();
}

function snapshotTextPane() { return { textTabs, textActive, seq }; }
function restoreTextPane(s: any): void {
  textTabs = s?.textTabs ?? [];
  textActive = s?.textActive ?? 0;
  seq = s?.seq ?? 0;
  cache = null;
  lastText = null;
}
export { snapshotTextPane, restoreTextPane };

/**
 * Ctrl+點 the tree = put that node's text in the right column, and NOTHING else: the
 * middle pane keeps showing whatever the reader was reading (they asked for the right
 * column as a second, unmoving reference).
 *
 * The listener is on CAPTURE so it runs before the row's own click handler (which
 * would link the middle pane and repaint the tree).
 */
export function initTextPane(): void {
  const tree = $('#dirTree');
  tree?.addEventListener('click', (ev) => {
    if (!(ev.ctrlKey || ev.metaKey)) return;
    const row = (ev.target as HTMLElement | null)?.closest('.tRow') as HTMLElement | null;
    if (!row) return;
    const va = Number(row.dataset.va);
    const d = dirTrees[dirActive];
    const node = d ? findNode(d.roots, va) : null;
    const name = (node?.label || row.querySelector('.tName')?.textContent || '').trim() || ('VA ' + va);
    ev.preventDefault();
    ev.stopPropagation();
    void openTextTab({ from: va, to: node?.vaEnd ?? va + 1 }, name);
  }, true);

  // Ctrl+點 / Shift+點 a 本文分頁: copy / move it into the right column. Capture again,
  // so the tab strip's own handler (switch tab) never sees the modified click.
  const strip = $('#docTabStrip');
  strip?.addEventListener('click', (ev) => {
    if (!(ev.ctrlKey || ev.metaKey || ev.shiftKey)) return;
    if ((ev.target as HTMLElement | null)?.closest('.docTabClose')) return;
    const el = (ev.target as HTMLElement | null)?.closest('.docTab') as HTMLElement | null;
    if (!el) return;
    const i = Number(el.dataset.i);
    const tab = docTabs[i];
    if (!tab) return;
    ev.preventDefault();
    ev.stopPropagation();
    void openTextTab(tab.realm, tab.name);
    // Shift = 搬移：the middle pane gives the tab up (it is the same text, compared)
    if (ev.shiftKey) closeDocTab(i);
  }, true);
}
