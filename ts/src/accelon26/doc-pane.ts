/**
 * 本文分頁與捲動：session、分頁（page）、本文渲染、字級。
 *
 * Split out of viewer.ts (ACCELON26-HANDOVER 3.2). Shared state is read from
 * ./viewer and the other split modules as ESM live bindings; a module OWNS the
 * state it declares, and other modules get/set it through that module's exports.
 */
import { $, displayName, docs, escapeHtml, fmtInt, mapper, reader, session, setStatus } from './viewer';
import { PAGE } from './panes';
import { cursorPending, hasRealmNeighbor, paintTreeActive, pinnedHit, revealHit, setCursorPending, setPinnedHit, stepRealm, syncCursorFromScroll } from './link';
import { paintHit } from './paint';
import { Accelon3Renderer, LEVEL_MAX_SCALE, LEVEL_STEP_PX, renderPageBlocks, tierContext, type RenderBlock } from './render_accelon3';
import { ancestorTrail, currentNodeAt, siblingsOf } from './scopes';
import { kwMarks } from './kw-marks';
import { displayConverter, type SimMode } from './lossless';
import { isDictDb } from './db-kind';

/**
 * 進階模式的「顯示原始文件」：打開＝不渲染（原始的 XML 文字），預設關閉＝渲染成 HTML。
 * 作者 2026-10。這是閱讀偏好，存在 localStorage（`accelon26.showraw`）。
 */
const RAW_KEY = 'accelon26.showraw';

let renderRaw = (() => { try { return localStorage.getItem(RAW_KEY) === '1'; } catch { return false; } })();

export function renderRawOn(): boolean {
  return renderRaw;
}

/** 切換渲染／原始；呼叫端負責重畫（doc-pane 與 text-pane 各有一份） */
export function setRenderRaw(on: boolean): void {
  renderRaw = !!on;
  try { localStorage.setItem(RAW_KEY, on ? '1' : '0'); } catch { /* 私密模式 */ }
}

/** 重畫目前這一頁（切換渲染模式用） */
export function rerenderDoc(): void {
  const s = docSession();
  if (s) renderDoc(s);
}

/**
 * 原書分行（作者 2026-10）：保留原書的硬換行（預設），或把文字連著排。
 *
 * 關閉時：`<頁>` 變成行內小字頁碼（不再是分隔線）、每一行不再斷行，只有「標題」與
 * 「空行（連續兩個以上的換行）」才換段。關鍵字在**渲染前**就包好（見 renderPageBlocks）。
 */
const HB_KEY = 'accelon26.hardbreaks';

let hardBreaks = (() => { try { return localStorage.getItem(HB_KEY) !== '0'; } catch { return true; } })();

export function hardBreaksOn(): boolean {
  return hardBreaks;
}

export function setHardBreaks(on: boolean): void {
  hardBreaks = !!on;
  try { localStorage.setItem(HB_KEY, on ? '1' : '0'); } catch { /* 私密模式 */ }
}

// ------------------------------------------ 顯示原書頁碼（作者 2026-10）
//
// 開（預設）＝`<頁>`／`<_頁>`／`頁元` 照常渲染（硬換行模式是右靠分隔＋頁碼，
// 連排模式是行內 `〔n〕`）。關＝**整個標籤不渲染**：沒有頁碼、也沒有頁分隔。
const PAGE_MARKS_KEY = 'accelon26.pagemarks';

let pageMarks = (() => { try { return localStorage.getItem(PAGE_MARKS_KEY) !== '0'; } catch { return true; } })();

export function pageMarksOn(): boolean {
  return pageMarks;
}

export function setPageMarks(on: boolean): void {
  pageMarks = !!on;
  try { localStorage.setItem(PAGE_MARKS_KEY, on ? '1' : '0'); } catch { /* 私密模式 */ }
}

/**
 * 顯示字體模式（作者 2026-10）：0 原樣、1 無損簡體、2 強制簡體。
 * 只影響畫面上的字；索引、搜尋、塗紅比對仍用原文。
 */
const SIM_KEY = 'accelon26.simmode';

let simMode: SimMode = (() => {
  try {
    const n = Number(localStorage.getItem(SIM_KEY));
    return n === 1 || n === 2 ? n : 0;
  } catch { return 0; }
})();

export function simModeOf(): SimMode {
  return simMode;
}

export function setSimMode(mode: SimMode): void {
  simMode = mode === 1 || mode === 2 ? mode : 0;
  try { localStorage.setItem(SIM_KEY, String(simMode)); } catch { /* 私密模式 */ }
}

/** 顯示轉換函式（原樣時回 null） */
export function simConverter(): ((s: string) => string) | null {
  return displayConverter(simMode);
}

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

/**
 * 本文上方的 **breadcrumb**（作者 2026-10）：把「目前本文」的所有祖先節點排成一條路徑，
 * 字級同內文、顏色同標題（`--tag-text-N`）。
 *
 * 點任一項 → 下拉出它**同一層的所有節點（siblings）**，並突顯目前這一個
 * （也就是本文的直系祖先）；點別的節點就跳到那一節的本文。
 *
 * 沒有祖先（本文本身就是最上層的節點）時，放上自己一項 —— 這樣還是可以換兄弟節點。
 */
/**
 * breadcrumb 上顯示的短標籤（作者 2026-10）：
 *   * 標籤裡有分隔符（空白、全形空白、`、，。：；·｜／/ - — _`）→ 只取**分隔符之前**那段
 *     （例：「甲二　正宗分」→「甲二」）
 *   * 沒有分隔符 → 最多取 **5 個字**
 *
 * 完整標籤仍留在 `title` 與下拉選單裡（下拉不節略）。
 */
const TRAIL_SEP = /[\s\u3000、，。：；·｜|／/\-—–_~]+/;

/** 同層節點超過這個數量就改成下拉（作者 2026-10-18）：像「書」那一層有上百本，
 *  全部排成晶片會把本文整個擠掉。 */
const MAX_INLINE_SIBS = 5;

export function trailLabel(text: string): string {
  const full = (text ?? '').trim();
  if (!full) return '';
  const head = full.split(TRAIL_SEP).map((p) => p.trim()).find((p) => p.length > 0) ?? '';
  if (head && head !== full) return head;
  const chars = [...full];
  return chars.length <= 5 ? full : chars.slice(0, 5).join('');
}

function renderAncestorTrail(s: DocSession): string {
  const anc = ancestorTrail(s.realm.from);
  const self = currentNodeAt(s.realm.from);
  const items = anc.map((a) => {
    const full = escapeHtml(a.label);
    const short = escapeHtml(trailLabel(a.label));
    return `<span class="trailWrap" data-va="${a.va}">`
      + `<button type="button" class="trail" data-va="${a.va}" data-tag="${escapeHtml(a.tag)}"`
      + ` title="「${full}」：點一下換同一層的其他節點"`
      + ` style="--tagtext:var(--tag-text-${a.depth % 8})">${short}<span class="trailCaret">▾</span></button>`
      + '</span>';
  });
  // 目前文件內容的 siblings（作者 2026-10）：直接排在路徑後面，短標籤、可點就換節。
  // 作者 2026-10-18：同層超過 MAX_INLINE_SIBS 個（例如點書名 → 同層幾百本書）就改成
  // **一個下拉**，只顯示目前這一節＋「同層 N」，否則整排書名會把本文擠掉。
  const sibs = self ? siblingsOf(self.va) : [];
  let sibHtml = '';
  if (self && sibs.length > 1) {
    if (sibs.length > MAX_INLINE_SIBS) {
      const full = escapeHtml(self.label);
      const short = escapeHtml(trailLabel(self.label));
      sibHtml = `<span class="trailSibs"><span class="trailWrap">`
        + `<button type="button" class="trail trailMore" data-va="${self.va}" data-tag="${escapeHtml(self.tag)}"`
        + ` title="「${full}」：同層 ${sibs.length} 個節點，點一下選"`
        + ` style="--tagtext:var(--tag-text-${self.depth % 8})">${short}<span class="trailCaret">▾</span></button>`
        + `</span><span class="trailCount">同層 ${sibs.length}</span></span>`;
    } else {
      sibHtml = '<span class="trailSibs">' + sibs.map((n) => {
        const full = escapeHtml(n.label);
        const short = escapeHtml(trailLabel(n.label));
        const style = `--tagtext:var(--tag-text-${n.depth % 8})`;
        if (n.va === self.va) {
          return `<span class="trailSib cur" data-va="${n.va}" title="「${full}」（目前這一節）" style="${style}">${short}</span>`;
        }
        return `<button type="button" class="trailSib" data-va="${n.va}" data-tag="${escapeHtml(n.tag)}"`
          + ` title="「${full}」：點一下換到這一節" style="${style}">${short}</button>`;
      }).join('') + '</span>';
    }
  }
  if (!items.length && !sibHtml) return '';
  const sep = items.length && sibHtml ? '<span class="trailSep">｜</span>' : '';
  return '<nav class="docTrail" id="docTrail" aria-label="本文路徑">'
    + items.join('<span class="trailSep">›</span>') + sep + sibHtml + '</nav>';
}

/** 把一頁的版面塊變成 HTML：保留硬換行＝每行一列；不保留＝整段連排 */
function renderBlocks(blocks: RenderBlock[], s: DocSession): string {
  return blocks.map((block) => {
    if (block.kind === 'line') {
      const l = block.lines[0];
      const cls = 'docLine' + (s.pinned && l.no === s.pinned.line ? ' hitLine' : '');
      return '<div class="' + cls + '" id="L' + l.no + '" data-src="' + escapeHtml(l.raw) + '">'
        + '<div class="lineText">' + l.html + '</div></div>';
    }
    const inner = block.lines.map((l, i) => {
      const cls = 'docLine' + (s.pinned && l.no === s.pinned.line ? ' hitLine' : '');
      // 英文行接起來要留一個空白，中文不用（作者 2026-10：把硬換行去掉）
      const prev = i > 0 ? block.lines[i - 1].raw : '';
      const join = i > 0 && /[A-Za-z0-9]$/.test(prev) && /^[A-Za-z0-9]/.test(l.raw) ? ' ' : '';
      return join + '<span class="' + cls + '" id="L' + l.no + '" data-src="' + escapeHtml(l.raw) + '">'
        + '<span class="lineText">' + l.html + '</span></span>';
    }).join('');
    const tag = block.kind === 'heading' ? 'div' : 'p';
    const cls = block.kind === 'heading' ? 'docPara docParaHeading' : 'docPara';
    return '<' + tag + ' class="' + cls + '">' + inner + '</' + tag + '>';
  }).join('');
}

/**
 * breadcrumb 的互動（作者 2026-10）：
 *   * 點**祖先**那一格 → 下拉同一層的所有 siblings（完整標籤，不節略），目前這一個突顯
 *   * 點**後面的 sibling 晶片** → 直接換到那一節的本文（不用先開選單）
 */
function wireTrail(): void {
  const nav = document.getElementById('docTrail');
  if (!nav) return;
  const closeMenus = () => nav.querySelectorAll('.trailMenu').forEach((m) => m.remove());
  // sibling 晶片：直接就換節
  nav.querySelectorAll<HTMLElement>('.trailSib[data-tag]').forEach((chip) => {
    chip.onclick = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      closeMenus();
      const va = Number(chip.dataset.va);
      const label = chip.title.replace(/^「|」.*$/g, '');
      void revealHit(va, label, 1, { mode: 'node' });
    };
  });
  nav.querySelectorAll<HTMLElement>('.trail').forEach((btn) => {
    const wasActive = btn.classList.contains('active');
    btn.onclick = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const wrap = btn.parentElement;
      const open = wrap?.querySelector('.trailMenu');
      closeMenus();
      if (open || !wrap) return;                       // 再點同一個＝收起來
      const selfVa = Number(btn.dataset.va);
      const sibs = siblingsOf(selfVa);
      if (sibs.length < 2) return;                     // 只有自己一個，沒得換
      const menu = document.createElement('div');
      menu.className = 'trailMenu';
      menu.id = 'trailMenu';
      for (const n of sibs) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'trailItem' + (n.va === selfVa ? ' active' : '');
        item.dataset.va = String(n.va);
        item.dataset.tag = n.tag;
        item.textContent = n.label;
        item.style.setProperty('--tagtext', `var(--tag-text-${n.depth % 8})`);
        item.onclick = (e2) => {
          e2.stopPropagation();
          closeMenus();
          void revealHit(n.va, n.label, 1, { mode: 'node' });
        };
        menu.appendChild(item);
      }
      wrap.appendChild(menu);
      // 點空白處收起來
      window.setTimeout(() => {
        const off = (e: MouseEvent) => {
          if (!menu.contains(e.target as Node)) {
            menu.remove();
            document.removeEventListener('click', off, true);
          }
        };
        document.addEventListener('click', off, true);
      }, 0);
    };
    void wasActive;
  });
}

/** render one page: tab strip, header, rows, pager. */
function renderDoc(s: DocSession): void {  const dt = s.cache?.dt;
  if (!dt) return;
  lastDocLines = dt.lines;
  // The pinned line is marked HERE (synchronously) so the row exists with its
  // hitLine class the moment the page is in the DOM; paintHit only adds the mark.
  // the pinned line is marked only while it is ON this page (see ensurePage)
  // 原書分行（作者 2026-10）：硬換行要不要保留。false＝文字連著排（見 renderPageBlocks）。
  // 「顯示原書頁碼」（作者 2026-10）：`<頁>`／`<_頁>` 要不要渲染（頁碼與頁分隔都算）。
  const blocks = renderRaw
    ? dt.lines.map((line, k) => ({ kind: 'line' as const, lines: [{ no: dt.lineNumbers[k], html: escapeHtml(simConverter() ? simConverter()!(line) : line), raw: line, visible: true, heading: false }] }))
    : renderPageBlocks(dt.lines, dt.lineNumbers, {
      hardBreaks, marks: hardBreaks ? [] : kwMarks(), convert: simConverter(), pageMarks: pageMarksOn(),
    });
  const rows = renderBlocks(blocks, s);
  const b = pageBounds(s.realm, s.page);
  const nFirst = dt.lineNumbers[0] ?? 0;
  const nLast = dt.lineNumbers[dt.lineNumbers.length - 1] ?? 0;
  // 詞典型 adb 不顯示 docHead（作者 2026-10）：詞條名稱已經在分頁標題上，
  // 而第一個詞條字串通常就是命中、會被塗紅 —— 再放一次就變成同一個詞顯示三次。
  // 標題（.docHead）與 breadcrumb 排在同一行（作者 2026-10-18）：.docTop 是 flex row，
  // 標題保留原本的語意（h 區的 .docHead），路徑接在它後面、不另起一列。
  $('#docText').innerHTML = '<div class="docTop">'
    + (isDictDb(mapper)
      ? ''
      : '<div class="docHead">' + escapeHtml(displayName(s.name))
        + '<span class="dim">第 ' + fmtInt(s.page + 1) + ' / ' + fmtInt(b.pages) + ' 頁（每頁 ' + fmtInt(PAGE_LINES) + ' 行）'
        + ' · 行 ' + fmtInt(nFirst) + '–' + fmtInt(nLast) + ' / 此節點共 ' + fmtInt(b.total) + ' 行'
        + ' · source 區塊 ' + dt.blockFirst + '–' + dt.blockLast + ' · ' + fmtInt(dt.text.length) + ' 字</span></div>')
    + renderAncestorTrail(s)
    + '</div>'
    + '<div class="docBody' + (hardBreaks ? '' : ' reflow') + '">' + rows + '</div>';
  renderDocTabs(s);
  renderPager(s, b);
  wireTrail();
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
  void updateDocLogo();   // 有文字就把 logo 收起來
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
    void updateDocLogo();   // 分頁全關了：本文區又空了
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
  // 小節（少於一頁）也要能翻到上／下一個節點：作者 2026-10「對小內文頁，
  // 上一頁／下一頁變得沒作用了」。所以「有鄰居」時 pager 不能藏起來。
  const neighborPrev = hasRealmNeighbor(-1);
  const neighborNext = hasRealmNeighbor(1);
  bar.hidden = b.pages < 2 && !neighborPrev && !neighborNext;
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
    if (to < 0) { void stepRealm(-1); return; }             // 邊界：換到上一個 text node
    if (to > pb.pages - 1) { void stepRealm(1); return; }   // 邊界：換到下一個 text node
    void goPage(cur, to, !ev.shiftKey);
  };
  if (prev) {
    prev.setAttribute('aria-disabled', s.page <= 0 && !neighborPrev ? 'true' : 'false');
    prev.onclick = (ev) => step(-1, ev as MouseEvent);
  }
  if (next) {
    next.setAttribute('aria-disabled', s.page >= b.pages - 1 && !neighborNext ? 'true' : 'false');
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
const DOCFS_KEY = 'accelon26.docfs';

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
  syncFontButtons();
  return size;
}

// ------------------------------------------------ 左欄／右欄的字級（作者 2026-10）
/**
 * 側欄字級：`docTools` 的三個下拉之一（正文／左欄／右欄）。
 * 左欄＝目錄樹、名詞、全文、原書分頁、西文（含 token 瀏覽）；
 * 右欄＝摘要、META、容量、文件、圖片、文字內容。
 * 存 localStorage（`accelon26.fs.left`／`accelon26.fs.right`），套在 CSS 變數上。
 */
const SIDE_FS_KEY = { left: 'accelon26.fs.left', right: 'accelon26.fs.right' } as const;

const SIDE_FS_DEFAULT = 13;

const SIDE_FS_MIN = 9;

const SIDE_FS_MAX = 32;

function readSideFont(side: 'left' | 'right'): number {
  const raw = localStorage.getItem(SIDE_FS_KEY[side]);
  const n = raw === null || raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) && n >= SIDE_FS_MIN && n <= SIDE_FS_MAX ? Math.round(n) : SIDE_FS_DEFAULT;
}

function setSideFont(side: 'left' | 'right', px: number): number {
  const size = Math.max(SIDE_FS_MIN, Math.min(SIDE_FS_MAX, Math.round(px)));
  document.documentElement.style.setProperty(side === 'left' ? '--fs-left' : '--fs-right', size + 'px');
  localStorage.setItem(SIDE_FS_KEY[side], String(size));
  syncFontButtons();
  return size;
}

/** 開機時把兩個側欄的字級還原（正文由 setDocFont 負責） */
function applySideFonts(): void {
  setSideFont('left', readSideFont('left'));
  setSideFont('right', readSideFont('right'));
}

// ---------------------------------- 字級按鈕（作者 2026-10，取代下拉選單）
/** 每按一下增減的像素（作者 2026-10-18：2 → 1，調起來更細） */
export const FONT_STEP = 1;

/** 字級按鈕的範圍：12–32px（超過上限就回到最小值） */
export const FONT_MIN = 12;

export const FONT_MAX = 32;

/**
 * 按一下字級按鈕：
 *   * 一般：**+1px**；加完超過 32px 就回到 **12px**
 *   * 按住 Alt：**−1px**；到最小值（12px）就停住，不再變化
 *
 * 回傳套用後的字級。三顆按鈕（左／中／右）共用這一支，差別只在 `kind`。
 */
export function stepFontSize(kind: 'left' | 'body' | 'right', down: boolean): number {
  const cur = kind === 'body' ? readDocFont() : readSideFont(kind);
  const next = down
    ? Math.max(FONT_MIN, cur - FONT_STEP)
    : cur + FONT_STEP > FONT_MAX ? FONT_MIN : cur + FONT_STEP;
  const applied = kind === 'body' ? setDocFont(next) : setSideFont(kind, next);
  syncFontButtons();
  return applied;
}

/** 三顆字級按鈕的提示文字（顯示目前 px 與操作方式） */
export function syncFontButtons(): void {
  const set = (id: string, px: number, label: string) => {
    const btn = document.getElementById(id) as HTMLElement | null;
    if (!btn) return;
    btn.dataset.px = String(px);
    btn.title = `${label}字級 ${px}px：點一下 +${FONT_STEP}px、按住 Alt 點 −${FONT_STEP}px（${FONT_MIN}–${FONT_MAX}px）`;
  };
  set('fsLeftPick', readSideFont('left'), '左欄');
  set('fsBodyPick', readDocFont(), '正文');
  set('fsRightPick', readSideFont('right'), '右欄');
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
import { updateDocLogo } from './logo';

/** everything the document pane keeps for ONE database */
function snapshotDocPane() {
  return { docTabs, docActive, docSeq, lastDocLines, lastLink, lastFit };
}
function restoreDocPane(s: any): void {
  docTabs = s.docTabs ?? [];
  docActive = s.docActive ?? 0;
  docSeq = s.docSeq ?? 0;
  lastDocLines = s.lastDocLines ?? [];
  lastLink = s.lastLink ?? null;
  lastFit = s.lastFit ?? null;
  boundsCache.clear();
  paintAsked.clear();
  docFontSized = true;          // the size is a reader preference, not per database
}
export { DOCFS_DEFAULT, DOCFS_KEY, DOCFS_MAX, DOCFS_MIN, DOCFS_READABLE_MIN, DOC_TEXT_FAMILY, DocSession, PAGE_LINES, PROBE_FS, applySideFonts, autoFitFont, boundsCache, boundsOfRealm, closeDocTab, docActive, docFontSized, docOfVa, docScrollWired, docSeq, docSession, docTabs, docTextWidth, edgeLine, ensurePage, fetchPage, fitDebugInfo, goPage, lastDocLines, lastFit, lastLink, longestOf, makeTextMeasurer, pageBounds, pageOfLine, pagerLog, paintAsked, pendingProbeCleanup, pickProbeLine, readDocFont, readSideFont, realmFirstLine, realmKey, realmLastLine, renderDoc, renderDocTabs, renderPager, restoreDocPane, scheduleCursorSync, scrollToVa, sessionFor, sessionForRealm, setDocFont, setSideFont, shortLabel, showsLine, snapshotDocPane, switchDocTab, wholeRealm };
