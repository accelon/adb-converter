/**
 * 本文分頁與捲動：session、分頁（page）、本文渲染、字級。
 *
 * Split out of viewer.ts (ADBVIEW-HANDOVER 3.2). Shared state is read from
 * ./viewer and the other split modules as ESM live bindings; a module OWNS the
 * state it declares, and other modules get/set it through that module's exports.
 */
import { $, displayName, docs, escapeHtml, fmtInt, mapper, reader, session, setStatus } from './viewer';
import { PAGE } from './panes';
import { cursorPending, paintTreeActive, pinnedHit, setCursorPending, setPinnedHit, syncCursorFromScroll } from './link';
import { paintHit } from './paint';

/** true once the document font has been auto-fitted for this database */
let docFontSized = false;

/**
 * The middle pane, session state.
 *
 * One "document session" = the text of ONE directory node's realm (or a whole
 * `<檔>` when the link came from the document list / a token) plus the page
 * (網頁分頁, NOT the book's 葉/folio) that is currently loaded. Ctrl+clicking a
 * linking control opens another session in a new tab instead of replacing the
 * one on screen.
 *
 * Paging exists because loading a whole window is what made the pane sluggish:
 * a page is a couple of hundred screen lines, so a link costs a bounded amount
 * of text and DOM instead of thousands of rows.
 */
interface DocSession {
  id: number;
  /** the node whose text this tab shows ([from, to) in VA; to <= from = whole doc) */
  realm: { from: number; to: number };
  /** label of that node, or the `<檔>` name */
  name: string;
  /** 0-based page of the realm that is loaded in the DOM */
  page: number;
  /** the `<檔>` the realm lives in */
  doc: DocRow;
  pinned: {
    va: number; text: string; token: string; units: number; line: number;
    exact?: boolean;
    /** what `exact` should paint, when it differs from the tab label (全文 pane) */
    phrase?: string;
    /** link without painting anything (原書分頁) */
    noMark?: boolean;
  } | null;
  /** last rendered page (per session, so switching tabs does not re-read) */
  cache: { page: number; dt: Awaited<ReturnType<VaPaMapper['docText']>>; key: string } | null;
}

let docTabs: DocSession[] = [];

let docActive = 0;

let docSeq = 0;

/** how many hard lines one page holds (the "load only this page" budget) */
const PAGE_LINES = 200;

/** the lines of the page currently in the DOM, used by autoFitFont */
let lastDocLines: string[] = [];

/** one paint retry per target line per tab (see paintHit) */
const paintAsked = new Map<number, number>();

/** cost of the last link (diagnostics: state().lastLink) */
let lastLink: { va: number; ensureMs: number; totalMs: number; rows: number } | null = null;

/** what the pager buttons did (diagnostics: state().pagerLog) */
const pagerLog: string[] = [];

const docSession = (): DocSession | null => docTabs[docActive] ?? null;

/** the whole-database realm (used when no document row owns the VA) */
function wholeRealm(): { from: number; to: number } {
  return { from: 0, to: reader?.header.maxBlockOffset ?? 0 };
}

/** the `<檔>` that owns a VA (single-file databases have none → one whole doc) */
function docOfVa(va: number): DocRow {
  const i = docs.findIndex((d) => va >= d.vaStart && va < d.vaEnd);
  if (i >= 0) return docs[i];
  // A VA can drift a few units past the end of its `<檔>` (fgdict does at every
  // file boundary), so fall back to the nearest document that starts before it —
  // better than a synthetic whole-database row whose line count disagrees with
  // the line table.
  let best = -1;
  for (let k = 0; k < docs.length; k++) {
    if (docs[k].vaStart <= va && (best < 0 || docs[k].vaStart > docs[best].vaStart)) best = k;
  }
  if (best >= 0) return docs[best];
  return { i: -1, name: reader?.header.dbname ?? '', vaStart: 0, vaEnd: reader?.header.maxBlockOffset ?? 0 };
}

/** scroll the 文件 pane to the row of a VA (no content change) */
function scrollToVa(va: number): void {
  if (!mapper) return;
  document.getElementById('L' + mapper.edgeLine(va))?.scrollIntoView({ block: 'center' });
}

/** first line index whose end is at or past `va` */
function edgeLine(va: number): number {
  return mapper ? mapper.edgeLine(va) : 0;
}

/**
 * First line index inside a realm. A heading's VA is its own tag, so its line
 * ends at (or before) that VA: when the edge line ends exactly at the realm
 * start, the realm really begins on the NEXT line.
 */
function realmFirstLine(realm: { from: number; to: number }): number {
  return mapper ? mapper.lineOfVa(realm.from) : 0;
}

/** last line of a realm: the last line that STARTS before the realm ends */
function realmLastLine(realm: { from: number; to: number }, first: number): number {
  const v = mapper?.linesVirtual ?? [];
  if (!v.length) return first;
  const cut = edgeLine(Math.max(realm.from, realm.to - 1));
  if (cut < first) return first;
  // a line whose VA equals the realm end belongs to the NEXT realm
  const at = mapper!.lineStartOf(cut);
  return v[cut] >= realm.to && at >= realm.to && cut > first ? cut - 1 : cut;
}

const boundsCache = new Map<string, { first: number; last: number }>();

const realmKey = (realm: { from: number; to: number }) => realm.from + ':' + realm.to;

/** the inclusive line range of a realm, plus its page count */
function boundsOfRealm(realm: { from: number; to: number }): { first: number; last: number; total: number; pages: number } {
  const key = realmKey(realm);
  let b = boundsCache.get(key);
  if (!b) {
    const first = realmFirstLine(realm);
    b = { first, last: realmLastLine(realm, first) };
    boundsCache.set(key, b);
  }
  const total = Math.max(0, b.last - b.first + 1);
  return { first: b.first, last: b.last, total, pages: Math.max(1, Math.ceil(total / PAGE_LINES)) };
}

/** the line range of one page of a realm (0-based page) */
function pageBounds(realm: { from: number; to: number }, page: number): { first: number; last: number; total: number; pages: number } {
  const b = boundsOfRealm(realm);
  const p = Math.max(0, Math.min(page, b.pages - 1));
  const first = Math.min(b.last, b.first + p * PAGE_LINES);
  const last = Math.min(b.last, first + PAGE_LINES - 1);
  return { first, last, total: b.total, pages: b.pages };
}

/** the page of a realm that contains a line (used to follow a hit) */
function pageOfLine(realm: { from: number; to: number }, line: number): number {
  const b = boundsOfRealm(realm);
  if (line <= b.first) return 0;
  return Math.max(0, Math.min(b.pages - 1, Math.floor((line - b.first) / PAGE_LINES)));
}

/** the session showing exactly this realm, if there is one */
function sessionForRealm(realm: { from: number; to: number }): DocSession | null {
  return docTabs.find((t) => t.realm.from === realm.from && t.realm.to === realm.to) ?? null;
}

/** find (or open) the tab for a realm. `fresh` forces a new tab. */
function sessionFor(realm: { from: number; to: number }, name: string, fresh = false): DocSession {
  if (!fresh) {
    const same = sessionForRealm(realm);
    if (same) return same;
  }
  const s: DocSession = { id: ++docSeq, realm, name, page: 0, doc: docOfVa(realm.from), pinned: null, cache: null };
  docTabs.push(s);
  return s;
}

/**
 * Read one page of a session's realm. The VA range passed to `docText` is the
 * realm itself, so its `total` is the node's own line count while only one page
 * is ever rendered.
 */
async function fetchPage(pageFirst: number, pageLast: number): Promise<Awaited<ReturnType<VaPaMapper['docText']>>> {
  const first = Math.max(0, pageFirst);
  const last = Math.max(first, pageLast);
  // The VA span is derived from the PAGE's lines, not from a `<檔>`: a directory
  // node may span several files (yinshun's 書 do), and passing one file's range
  // would clamp the page to a single line.
  const v = mapper!.linesVirtual;
  const vaStart = first > 0 ? (v[first - 1] ?? 0) : 0;
  const vaEnd = (v[last] ?? reader!.header.maxBlockOffset) + 1;
  return mapper!.docText(vaStart, vaEnd, last - first + 1, undefined, { first, last });
}

/**
 * Make sure the DOM holds the page that contains `targetLine` (or the session's
 * current page) and render it. The returned `auto` is true when the page had to
 * move to follow a hit.
 */
async function ensurePage(s: DocSession, targetLine?: number): Promise<{ auto: boolean; ms: number }> {
  if (!mapper) return { auto: false, ms: 0 };
  let auto = false;
  if (targetLine !== undefined && targetLine >= 0) {
    const p = pageOfLine(s.realm, targetLine);
    if (p !== s.page) { s.page = p; auto = true; }
  }
  const b = pageBounds(s.realm, s.page);
  s.page = Math.max(0, Math.min(s.page, b.pages - 1));
  const key = s.doc.i + ':' + b.first + '-' + b.last;
  const t0 = performance.now();
  if (!s.cache || s.cache.key !== key) {
    const dt = await fetchPage(b.first, b.last);
    s.cache = { page: s.page, dt, key };
  }
  // Following a hit: the mapper's line numbers and the rendered page can disagree
  // by a line at a document boundary (fgdict), so snap the pinned line ONTO the
  // page it was followed to. This must NOT happen when the reader turns a page —
  // otherwise paging away from the pinned hit would drag the pane straight back.
  const nums = s.cache.dt.lineNumbers;
  if (targetLine !== undefined && s.pinned && nums.length) {
    if (s.pinned.line < nums[0]) s.pinned.line = nums[0];
    else if (s.pinned.line > nums[nums.length - 1]) s.pinned.line = nums[nums.length - 1];
  }
  renderDoc(s);
  return { auto, ms: performance.now() - t0 };
}

/** true when the shown page already covers a line (so a link can just scroll) */
function showsLine(s: DocSession | null, line: number): boolean {
  const n = s?.cache?.dt.lineNumbers;
  return !!n && n.length > 0 && line >= n[0] && line <= n[n.length - 1];
}

/** render one page: tab strip, header, rows, pager. */
function renderDoc(s: DocSession): void {
  const dt = s.cache?.dt;
  if (!dt) return;
  lastDocLines = dt.lines;
  // The pinned line is marked HERE (synchronously) so the row exists with its
  // hitLine class the moment the page is in the DOM; paintHit only adds the mark.
  // the pinned line is marked only while it is ON this page (see ensurePage)
  const rows = dt.lines.map((line, k) => {
    const n = dt.lineNumbers[k];
    const cls = 'docLine' + (s.pinned && n === s.pinned.line ? ' hitLine' : '');
    return '<div class="' + cls + '" id="L' + n + '"><span class="lineText">' + escapeHtml(line) + '</span></div>';
  }).join('');
  const b = pageBounds(s.realm, s.page);
  const nFirst = dt.lineNumbers[0] ?? 0;
  const nLast = dt.lineNumbers[dt.lineNumbers.length - 1] ?? 0;
  $('#docText').innerHTML = '<div class="docHead">' + escapeHtml(displayName(s.name))
    + '<span class="dim">第 ' + fmtInt(s.page + 1) + ' / ' + fmtInt(b.pages) + ' 頁（每頁 ' + fmtInt(PAGE_LINES) + ' 行）'
    + ' · 行 ' + fmtInt(nFirst) + '–' + fmtInt(nLast) + ' / 此節點共 ' + fmtInt(b.total) + ' 行'
    + ' · source 區塊 ' + dt.blockFirst + '–' + dt.blockLast + ' · ' + fmtInt(dt.text.length) + ' 字</span></div>'
    + '<div class="docBody">' + rows + '</div>';
  renderDocTabs(s);
  renderPager(s, b);
  const body = document.querySelector<HTMLElement>('#docText .docBody');
  body?.scrollTo(0, 0);
  // the middle-line cursor follows the pane, so re-read it after every render and
  // after every programmatic scroll (paintHit) — throttled to one frame
  if (body && !docScrollWired.has(body)) {
    docScrollWired.add(body);
    body.addEventListener('scroll', scheduleCursorSync, { passive: true });
  }
  if (s.pinned) void paintHit(s.pinned.va, s.pinned.units);
  else if (dt.lineNumbers.length) document.getElementById('L' + nFirst)?.scrollIntoView({ block: 'start' });
  scheduleCursorSync();
}

/** the .docBody elements that already carry the scroll listener (one per render) */
const docScrollWired = new WeakSet<Element>();

function scheduleCursorSync(): void {
  if (cursorPending) return;
  setCursorPending(true);
  requestAnimationFrame(() => {
    setCursorPending(false);
    syncCursorFromScroll();
  });
}

/** a short tab label (the full name stays in the tooltip) */
function shortLabel(name: string, max = 8): string {
  const t = displayName(name).trim();
  return t.length > max ? t.slice(0, max) + '…' : t;
}

/** the document tab strip: one chip per linked node, ✕ to close, ＋ for a new one */
function renderDocTabs(s: DocSession): void {
  const bar = $('#docTabs');
  const strip = $('#docTabStrip');
  if (!bar || !strip) return;
  // The strip shows as soon as one tab exists, so the ＋ (and therefore the
  // Ctrl+click alternative for a new tab) is always reachable.
  bar.hidden = docTabs.length < 1;
  strip.innerHTML = docTabs.map((t, i) =>
    '<span class="docTab' + (i === docActive ? ' active' : '') + '" data-i="' + i + '" title="' + escapeHtml(t.name) + '">'
    + '<span class="docTabName">' + escapeHtml(shortLabel(t.name, 8)) + '</span>'
    + '<span class="docTabClose" data-close="' + i + '" title="關閉分頁">✕</span></span>').join('');
  strip.querySelectorAll<HTMLElement>('.docTab').forEach((el) => {
    el.onclick = (ev) => {
      const close = (ev.target as HTMLElement | null)?.closest('.docTabClose') as HTMLElement | null;
      if (close) { ev.stopPropagation(); closeDocTab(Number(close.dataset.close)); return; }
      const i = Number(el.dataset.i);
      if (i !== docActive && docTabs[i]) void switchDocTab(i);
    };
  });
  const add = $('#docTabAdd') as HTMLButtonElement | null;
  if (add) add.onclick = () => {
    const r = docSession()?.realm ?? wholeRealm();
    const n = sessionFor(r, '新分頁', true);
    docActive = docTabs.indexOf(n);
    void ensurePage(n, s.cache?.dt?.lineNumbers[0]);
  };
}

/** switch to an already loaded tab (no re-read) */
async function switchDocTab(i: number): Promise<void> {
  const t = docTabs[i];
  if (!t) return;
  docActive = i;
  setPinnedHit(t.pinned);
  if (t.cache) renderDoc(t);
  else await ensurePage(t);
  paintTreeActive();
}

/** close a tab; the remaining tabs keep their own page */
function closeDocTab(i: number): void {
  if (i < 0 || i >= docTabs.length) return;
  docTabs.splice(i, 1);
  if (!docTabs.length) {
    setPinnedHit(null);
    $('#docText').innerHTML = '<p class="dim">點左側節點／摘要，會載入該處的本文（一頁一頁載入）。</p>';
    const tabs = $('#docTabs') as HTMLElement | null;
    if (tabs) tabs.hidden = true;
    const strip = $('#docTabStrip');
    if (strip) strip.innerHTML = '';
    const pager = $('#docPager') as HTMLElement | null;
    if (pager) pager.hidden = true;
    return;
  }
  docActive = Math.max(0, Math.min(docActive > i ? docActive - 1 : docActive, docTabs.length - 1));
  void switchDocTab(docActive);
  paintTreeActive();
}

/** the page (網頁分頁) controls at the bottom of the pane */
function renderPager(s: DocSession, b: { first: number; last: number; total: number; pages: number }): void {
  const bar = $('#docPager');
  if (!bar) return;
  bar.hidden = b.pages < 2;
  const prev = $('#pagePrev') as HTMLButtonElement | null;
  const next = $('#pageNext') as HTMLButtonElement | null;
  // Resolve the session AT CLICK TIME: an async render of an older tab must not be
  // able to leave the pager wired to a tab that is no longer on screen.
  const step = (delta: number, ev: MouseEvent) => {
    const cur = docSession();
    if (!cur) return;
    const pb = pageBounds(cur.realm, cur.page);
    const to = cur.page + delta;
    pagerLog.push('step ' + delta + ' tab=' + docTabs.indexOf(cur) + ' page=' + cur.page + '/' + pb.pages + ' to=' + to);
    if (pagerLog.length > 10) pagerLog.shift();
    if (to < 0 || to > pb.pages - 1) return;
    void goPage(cur, to, !ev.shiftKey);
  };
  if (prev) {
    prev.setAttribute('aria-disabled', s.page <= 0 ? 'true' : 'false');
    prev.onclick = (ev) => step(-1, ev as MouseEvent);
  }
  if (next) {
    next.setAttribute('aria-disabled', s.page >= b.pages - 1 ? 'true' : 'false');
    next.onclick = (ev) => step(1, ev as MouseEvent);
  }
  const info = $('#pageInfo');
  if (info) info.textContent = '第 ' + fmtInt(s.page + 1) + ' / ' + fmtInt(b.pages) + ' 頁　行 ' + fmtInt(b.first) + '–' + fmtInt(b.last) + '（共 ' + fmtInt(b.total) + ' 行）　' + displayName(s.name).slice(0, 40);
}

/**
 * Turn one page. The page's first line is kept at the top (shift+click keeps the
 * exact scroll offset instead), so paging walks the text instead of resetting.
 */
async function goPage(s: DocSession, page: number, keepLine: boolean): Promise<void> {
  const keep = keepLine ? s.cache?.dt?.lineNumbers[0] : undefined;
  s.page = page;
  await ensurePage(s);
  if (keep !== undefined) document.getElementById('L' + keep)?.scrollIntoView({ block: 'start' });
  const b = pageBounds(s.realm, s.page);
  setStatus(displayName(s.name) + '：第 ' + fmtInt(s.page + 1) + ' / ' + fmtInt(b.pages) + ' 頁（頁＝網頁分頁，每頁 ' + fmtInt(PAGE_LINES) + ' 行）', 'info');
}

/**
 * Wrap the hit's character range in <mark> inside the already rendered rows.
 * `units` > 1 paints a whole phrase (search); omitted means "one element".
 *
 * If a span's line is not on the page currently in the DOM, the pane is moved to
 * the page that holds it — otherwise the second half of a word cut by a hard
 * break (or a hit just past the page edge) would silently stay unpainted.
 */
/**
 * Mark `phrase` inside a rendered line by plain text search.
 *
 * Used when the mapper's span disagrees with the line table: the walk's VA scale
 * drifts from the stored one (fgdict by >1000 VA), so the exact span cannot be
 * trusted, but the phrase the reader searched for is still findable in the line.
 */

// ------------------------------------------------------------ document font
/**
 * Document font size. Lines are hard-wrapped source lines, so the reader's
 * question is "how large can the text be without soft-wrapping most lines".
 * 13j's lines are quite short (p90 = 53 code units) while yinshun's are longer
 * (p90 = 45, p99 = 88), so the useful size depends on the pane width — hence
 * `autoFitFont`, which measures the widest line that 90% of lines stay under and
 * solves for the font size that fits it.
 */
const DOCFS_KEY = 'adbview.docfs';

const DOCFS_DEFAULT = 16;

const DOCFS_MIN = 10;

const DOCFS_MAX = 40;

/** never auto-shrink below this: readability beats "no wrapping at any cost" */
const DOCFS_READABLE_MIN = 14;

function readDocFont(): number {
  const raw = localStorage.getItem(DOCFS_KEY);
  const n = raw === null || raw === '' ? NaN : Number(raw);   // Number('') is 0!
  return Number.isFinite(n) && n >= DOCFS_MIN && n <= DOCFS_MAX ? Math.round(n) : DOCFS_DEFAULT;
}

function setDocFont(px: number) {
  const size = Math.max(DOCFS_MIN, Math.min(DOCFS_MAX, Math.round(px)));
  document.documentElement.style.setProperty('--fsdoc', size + 'px');
  localStorage.setItem(DOCFS_KEY, String(size));
  const el = document.getElementById('fsValue');
  if (el) el.textContent = String(size);
  return size;
}

/**
 * Pick the largest font size at which ~90% of the lines in the current document
 * fit the MIDDLE COLUMN.
 *
 * The width must be measured inside the text pane, not on the page: the panes
 * are grid columns, so a probe appended to `document.body` measures the page's
 * available width and ignores the left/right columns entirely. Appending the
 * probe to the document body element keeps it inside the pane, so the side
 * columns, splitters and its scrollbar are all excluded automatically.
 *
 * Glyph widths are measured rather than guessed (Latin and CJK differ a lot),
 * and the probe is measured at a neutral 100px so the stored size does not feed
 * back into the calculation.
 */
const PROBE_FS = 100;

/** the numbers behind the last auto-fit (diagnostics) */
let lastFit: Record<string, number | boolean> | null = null;

const DOC_TEXT_FAMILY = '"Microsoft JhengHei", "Segoe UI", system-ui, sans-serif';

function autoFitFont(sample?: string[]): number {
  // The DOM only holds ONE page, so the numbers must come from the WHOLE document
  // (its line table) whenever it is available: otherwise the font would change as
  // the reader pages through the text. `lines` is the fallback.
  const lines = sample ?? lastDocLines;
  const doc = mapper && mapper.lineCount > 0 ? mapper : null;
  // p90 is the line that must fit (the reader's "no wrapping" line); the cap is a
  // little wider so a rare outlier line (yinshun has 96-unit lines against p90 =
  // 45) cannot drag the whole document down to the readable floor.
  const target = doc && !sample ? doc.lineLengthPercentile(0.9, 200_000) : 0;
  // The cap is "ordinary long", not "the longest line": 15% over the p90 line. A
  // line beyond it is a genuine outlier and scrolls sideways instead of dragging
  // the whole document down to the readable floor.
  const capLen = doc && !sample ? Math.max(target, Math.round(target * 1.15)) : 0;
  const realProbe = pickProbeLine(lines, capLen);
  const probeText = realProbe.text;
  const probeLen = probeText.length || 1;
  const capLine = Math.max(probeLen, capLen, target, doc ? 0 : longestOf(lines));

  // Measurement needs BOTH: a probe that is not clamped by the pane (otherwise
  // the text saturates at the pane width and the scale factor comes out far too
  // large — that is what produced a nonsense 40px), and a width that IS read from
  // the pane, so the side columns are excluded.
  const containingBlockWidth = docTextWidth();
  if (containingBlockWidth < 80) return readDocFont();
  const measure = makeTextMeasurer();

  const measured = measure(probeText);
  const scaled = Math.floor((PROBE_FS * containingBlockWidth) / measured);
  const capped = Math.floor((PROBE_FS * containingBlockWidth) / (measured * (capLine / probeLen)));
  const size = Math.max(DOCFS_READABLE_MIN, Math.min(scaled, capped));
  lastFit = { width: containingBlockWidth, target, capLen, capLine, probeLen, measured, real: realProbe.real, scaled, capped, size };
  const fitted = setDocFont(Math.max(DOCFS_MIN, Math.min(DOCFS_MAX, size)));
  pendingProbeCleanup?.();
  pendingProbeCleanup = null;
  return fitted;
}

/** the longest of a list of lines (fallback when the mapper is unavailable) */
function longestOf(lines: string[]): number {
  return lines.reduce((a, b) => Math.max(a, b.length), 0);
}

/**
 * The line the font is measured against: the longest REAL text line available,
 * capped at the document's "ordinary long line" length.
 *
 * Real text matters: a synthetic run of CJK is up to ~25% wider per character
 * than a line of prose (punctuation and Latin are narrower), so measuring a
 * made-up line would shrink the font more than the reader needs. Cached lines
 * from the current page are preferred because they cost nothing to read; the
 * synthetic run is only the last resort (a page of one-character lines).
 */
function pickProbeLine(lines: string[], capLen: number): { text: string; real: boolean } {
  const limit = capLen > 0 ? capLen : Math.max(8, longestOf(lines));
  let best = '';
  for (const l of lines) {
    if (l.length > best.length && l.length <= limit) best = l;
  }
  if (best.length >= 8) return { text: best, real: true };
  return { text: '字'.repeat(Math.max(8, limit)), real: false };
}

/**
 * A text ruler: measures a string in the document font at PROBE_FS, in a
 * detached container that imposes no width constraint. Measuring inside the text
 * pane does not work — the pane's `overflow` clamps the probe, so the measured
 * width saturates at the pane width and the scale factor explodes.
 */
function makeTextMeasurer(): (text: string) => number {
  const host = document.createElement('div');
  host.style.cssText =
    'position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none;'
    + 'white-space:pre;display:inline-block;contain:layout style;';
  const probe = document.createElement('span');
  probe.style.cssText = `display:inline-block;white-space:pre;font:${PROBE_FS}px/1 ${DOC_TEXT_FAMILY}`;
  host.appendChild(probe);
  document.body.appendChild(host);
  const out = (text: string): number => {
    probe.textContent = text;
    const w = probe.getBoundingClientRect().width;
    return w > 1 ? w : text.length * PROBE_FS;      // fall back to a full-width guess
  };
  pendingProbeCleanup = () => host.remove();
  return out;
}

/** removes the last measuring host (called after each auto-fit run) */
let pendingProbeCleanup: (() => void) | null = null;

function fitDebugInfo() {
  const body = document.querySelector<HTMLElement>('#docText .docBody');
  const measure = makeTextMeasurer();
  const w20 = measure('字'.repeat(20));
  const wLong = measure('字'.repeat(54));
  pendingProbeCleanup?.();
  pendingProbeCleanup = null;
  const avail = docTextWidth();
  return {
    bodyWidth: body?.clientWidth ?? 0,
    docTextWidth: avail,
    probe20: Math.round(w20),
    probe54: Math.round(wLong),
    scaled: Math.round((PROBE_FS * avail) / w20),
    p90: mapper ? mapper.lineLengthPercentile(0.9, 200_000) : 0,
    longest: Math.max(0, ...lastDocLines.map((l) => l.length)),
    sample: lastDocLines.length,
    fontSize: readDocFont(),
  };
}

/**
 * Inner width available for a line of text in the middle column: the document
 * body's client width (which already excludes the side columns and its own
 * scrollbar) minus the row's own gap and padding.
 */
function docTextWidth(): number {
  const body = document.querySelector<HTMLElement>('#docText .docBody');
  if (!body) return 0;
  const row = document.querySelector<HTMLElement>('#docText .docLine');
  const gutter = row
    ? row.offsetWidth - row.clientWidth + (row.firstElementChild
      ? parseFloat(getComputedStyle(row).columnGap || getComputedStyle(row).gap || '0') || 0
      : 0)
    : 8;
  return Math.max(1, body.clientWidth - gutter);
}

// (lastDocLines lives with the document session state, above)

/** a link opened or reused a tab */
export const setDocActive = (i: number): void => { docActive = i; };
export const setLastLink = (v: { va: number; ensureMs: number; totalMs: number; rows: number } | null): void => { lastLink = v; };
export const setDocFontSized = (b: boolean): void => { docFontSized = b; };

/** a fresh database invalidates every open tab and every derived page cache */
export function resetDocPane(): void {
  docTabs = [];
  docActive = 0;
  docFontSized = false;
  boundsCache.clear();
  paintAsked.clear();
  lastDocLines = [];
  lastLink = null;
  pagerLog.length = 0;
}

import { DocRow } from './adb';

import { VaPaMapper } from './vapa';

export { DOCFS_DEFAULT, DOCFS_KEY, DOCFS_MAX, DOCFS_MIN, DOCFS_READABLE_MIN, DOC_TEXT_FAMILY, DocSession, PAGE_LINES, PROBE_FS, autoFitFont, boundsCache, boundsOfRealm, closeDocTab, docActive, docFontSized, docOfVa, docScrollWired, docSeq, docSession, docTabs, docTextWidth, edgeLine, ensurePage, fetchPage, fitDebugInfo, goPage, lastDocLines, lastFit, lastLink, longestOf, makeTextMeasurer, pageBounds, pageOfLine, pagerLog, paintAsked, pendingProbeCleanup, pickProbeLine, readDocFont, realmFirstLine, realmKey, realmLastLine, renderDoc, renderDocTabs, renderPager, scheduleCursorSync, scrollToVa, sessionFor, sessionForRealm, setDocFont, shortLabel, showsLine, switchDocTab, wholeRealm };
