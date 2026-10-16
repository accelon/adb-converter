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
import { PAGE_LINES, boundsOfRealm, closeDocTab, docTabs, pageBounds } from './doc-pane';
import { dirActive, dirTrees, findNode } from './scopes';

export interface TextTab { id: number; label: string; realm: { from: number; to: number }; page: number }

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
    + '<span class="docTabName">' + escapeHtml(shorten(t.label)) + '</span>'
    + '<span class="docTabClose" data-close="' + i + '" title="關閉">✕</span></span>').join('');
  strip.querySelectorAll<HTMLElement>('.docTab').forEach((el) => {
    el.onclick = (ev) => {
      const close = (ev.target as HTMLElement | null)?.closest('.docTabClose') as HTMLElement | null;
      if (close) { ev.stopPropagation(); closeTextTab(Number(close.dataset.close)); return; }
      const i = Number(el.dataset.i);
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
  const at = textTabs.findIndex((t) => realmKey(t.realm) === realmKey(realm));
  if (at >= 0) textActive = at;
  else { textTabs.push({ id: ++seq, label, realm, page: 0 }); textActive = textTabs.length - 1; }
  syncTextTab();
  const btn = $('#colRight .tabBtn[data-tab="text"]') as HTMLButtonElement | null;
  // clicking the tab is what switches the right column (boot() wired it to showTab)
  if (btn) { btn.hidden = false; btn.click(); }
  else await renderTextPane();
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
  const head = '<div class="docHead">' + escapeHtml(displayName(t.label))
    + '<span class="dim">第 ' + fmtInt(t.page + 1) + ' / ' + fmtInt(pb.pages) + ' 頁'
    + ' · 行 ' + fmtInt(nums[0] ?? 0) + '–' + fmtInt(nums[nums.length - 1] ?? 0) + ' / 此節點共 ' + fmtInt(b.total) + ' 行'
    + ' · ' + fmtInt(dt.text.length) + ' 字</span></div>';
  body.innerHTML = head + '<div class="docBody">'
    + dt.lines.map((line: string) => '<div class="docLine"><span class="lineText">' + escapeHtml(line) + '</span></div>').join('')
    + '</div>';
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
