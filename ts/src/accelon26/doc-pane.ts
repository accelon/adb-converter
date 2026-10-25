/**
 * 本文分頁與捲動：session、分頁（page）、本文渲染、字級。
 *
 * Split out of viewer.ts (ACCELON26-HANDOVER 3.2). Shared state is read from
 * ./viewer and the other split modules as ESM live bindings; a module OWNS the
 * state it declares, and other modules get/set it through that module's exports.
 */
import { $, currentFile, currentSource, displayName, docs, escapeHtml, fmtInt, mapper, reader, session, setStatus } from './viewer';
import { PAGE } from './panes';
import { cursorPending, hasRealmNeighbor, paintTreeActive, pinnedHit, revealHit, setCursorPending, setPinnedHit, stepRealm, syncCursorFromScroll } from './link';
import { paintHit } from './paint';
import { Accelon3Renderer, LEVEL_MAX_SCALE, LEVEL_STEP_PX, renderPageBlocks, tagChromaIndex, tierContext, type RenderBlock } from './render_accelon3';
import { ancestorTrail, currentNodeAt, siblingsOf } from './scopes';
import { tagColorOf } from './tag-style';
import { kwMarks } from './kw-marks';
import { getUserId } from './user-id';
import { displayConverter, type SimMode } from './lossless';
import { isDictDb } from './db-kind';
import { diffPage, discardPage, hasEditsInRange, onEditsChange, pageEditAt, pageKey, sessionFor as editSessionFor, stagePage, type DbEditSession, type PageEdit } from './edit-session';
import { charDiff } from './char-diff';
import { mountPageEditor, type PageEditor } from './editor';

/**
 * 進階模式的「顯示原始文件」：打開＝不渲染（原始的 XML 文字），預設關閉＝渲染成 HTML。
 * 作者 2026-10。這是閱讀偏好，存在 localStorage（`accelon26.showraw`）。
 */
const RAW_KEY = 'accelon26.showraw';

// 「原始文件」已取消（2026-10-24，改成鉛筆編輯）；舊設定不再生效。
let renderRaw = false;
try { localStorage.removeItem(RAW_KEY); } catch { /* 私密模式 */ }

export function renderRawOn(): boolean {
  return renderRaw;
}

/** 切換渲染／原始；呼叫端負責重畫（doc-pane 與 text-pane 各有一份） */
export function setRenderRaw(on: boolean): void {
  renderRaw = !!on;
  try { localStorage.setItem(RAW_KEY, on ? '1' : '0'); } catch { /* 私密模式 */ }
}

/* ------------------------------------------------------------- inline images */
/**
 * `<圖 n="…"/>` → blob URL。
 *
 * 圖檔存在 adb 的 `resources` 容器（未壓縮，一張圖一個 block），所以一張圖只要
 * 一次 `resourceBytes()` 就能換成 URL；同一頁重畫時直接用快取。換庫（reader 換人）
 * 就整批撤銷 —— blob URL 不撤銷會一直佔著記憶體。
 */
const imageUrls = new Map<string, string>();
let imageUrlsDb: unknown = null;
let imageNameIndex: Map<string, number> | null = null;

/** 這一頁用到的圖先解好；渲染本身是同步的，所以只能先做 */
async function resolvePageImages(lines: readonly string[]): Promise<void> {
  if (!reader) return;
  if (imageUrlsDb !== reader) {
    for (const url of imageUrls.values()) URL.revokeObjectURL(url);
    imageUrls.clear();
    imageNameIndex = null;
    imageUrlsDb = reader;
  }
  const names = new Set<string>();
  for (const line of lines) {
    for (const m of line.matchAll(/<圖[^>]*?\bn\s*=\s*"([^"]*)"/g)) names.add(m[1]);
  }
  if (!names.size) return;
  if (!imageNameIndex) {
    const c = reader.containers.get('resources');
    imageNameIndex = new Map();
    for (let i = 0; i < (c?.count ?? 0); i++) imageNameIndex.set(c!.names[i], i);
  }
  for (const name of names) {
    if (imageUrls.has(name)) continue;
    const i = imageNameIndex.get(name);
    if (i === undefined) continue;
    const { bytes } = await reader.resourceBytes(i);
    const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
    const type = ext === 'svg' ? 'image/svg+xml' : ext === 'jpg' ? 'image/jpeg' : `image/${ext || 'png'}`;
    imageUrls.set(name, URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer], { type })));
  }
}

/** 給渲染器的查表函式（渲染是同步的，查不到就畫佔位方塊） */
function imageUrlOf(name: string): string | null {
  return imageUrls.get(name) ?? null;
}

/** 重畫目前這一頁（切換渲染模式用） */
export function rerenderDoc(): void {  const s = docSession();
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
  /** 這一頁正在編輯（CodeMirror） */
  editing?: boolean;
  /** 回到這一頁時自動進編輯態（使用者按「完成」後暫時關掉） */
  autoEdit?: boolean;
  /** 閱讀模式顯示這一頁的修訂 diff（新增綠、刪除紅） */
  showDiff?: boolean;
  /** 正在看某一筆歷史版本（唯讀；不允許進入編輯） */
  history?: { revisionId: string; first: number; last: number; doc: string; oldLines: string[]; newLines: string[]; focus?: number };
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
  // page (or tab/db) changed: keep what the user typed, then leave edit mode;
  // the target page auto-enters edit mode below if it already has a revision.
  if (activeEditor && (activeEditor.s !== s || activeEditor.first !== b.first || activeEditor.last !== b.last)) {
    stageActiveEditor();
    s.editing = false;
    s.autoEdit = true;
  }
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
  const dtNow = s.cache.dt;
  const rr = pageRangeOf(dtNow);
  const es = editSessionOf();
  if (!s.history && editAllowed() && !s.editing && s.autoEdit !== false && es && pageEditAt(es, rr.first, rr.last)) s.editing = true;
  const nums = dtNow.lineNumbers;
  if (targetLine !== undefined && s.pinned && nums.length) {
    if (s.pinned.line < nums[0]) s.pinned.line = nums[0];
    else if (s.pinned.line > nums[nums.length - 1]) s.pinned.line = nums[nums.length - 1];
  }
  // `<圖>` 要用的圖檔先解成 blob URL（渲染是同步的，見 resolvePageImages）
  await resolvePageImages(dtNow.lines);
  renderDoc(s);
  saveLastReadNow();
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

/** breadcrumb 的顏色：標籤樣式有自訂就用它，否則用主題的 tag 字色（作者 2026-10-22） */
const trailColor = (tag: string, depth: number): string =>
  tagColorOf(tag) ?? `var(--tag-text-${tagChromaIndex(tag, depth)})`;

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
      + ` style="--tagtext:${trailColor(a.tag, a.depth)}">${short}<span class="trailCaret">▾</span></button>`
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
        + ` style="--tagtext:${trailColor(self.tag, self.depth)}">${short}<span class="trailCaret">▾</span></button>`
        + `</span><span class="trailCount">同層 ${sibs.length}</span></span>`;
    } else {
      sibHtml = '<span class="trailSibs">' + sibs.map((n) => {
        const full = escapeHtml(n.label);
        const short = escapeHtml(trailLabel(n.label));
        const style = `--tagtext:${trailColor(n.tag, n.depth)}`;
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
        item.style.setProperty('--tagtext', trailColor(n.tag, n.depth));
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

/**
 * 編輯態（作者 2026-10-24）：目前頁面的 CodeMirror 實例。
 *
 * 只留一個：換頁／換分頁／換庫之前一定先 stageActiveEditor()，把內容寫回
 * edit-session（記憶體），所以使用者不需要按「儲存」也不會丟。
 */
let activeEditor: {
  ed: PageEditor;
  first: number;
  last: number;
  oldLines: string[];
  s: DocSession;
  key: string;
  docName: string;
} | null = null;

let stageTimer = 0;

/* ---------------------------------------------------------------- last read
 * 每一份 adb（用檔名＋大小當 key，所以 13j.adb 與 13j-v1.adb 各自記）記住最後
 * 閱讀的節點／頁。localStorage 跟著 origin 走，換 accelon26 版本也還在。
 */
const LAST_READ_KEY = 'accelon26.lastRead.v1';

interface LastRead {
  name: string;
  from: number;
  to: number;
  page: number;
  /** 該頁第一行（base 行號），用來在行表有變時重新找頁 */
  line: number;
  at: number;
}

function lastReadKey(f: { name: string; size: number }): string {
  return f.name + ':' + f.size;
}

function readLastRead(): Record<string, LastRead> {
  try {
    const raw = localStorage.getItem(LAST_READ_KEY);
    const v = raw ? JSON.parse(raw) : {};
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

function writeLastRead(map: Record<string, LastRead>): void {
  try {
    const entries = Object.entries(map).sort((a, b) => (b[1]?.at ?? 0) - (a[1]?.at ?? 0)).slice(0, 300);
    localStorage.setItem(LAST_READ_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch { /* 私密模式／配額 */ }
}

/** Save the active document tab + page. Safe to call often. */
export function saveLastReadNow(): void {
  const s = docSession();
  if (!s || !currentSource || s.history) return;
  try {
    const b = pageBounds(s.realm, s.page);
    const map = readLastRead();
    map[lastReadKey(currentSource)] = {
      name: s.name,
      from: s.realm.from,
      to: s.realm.to,
      page: s.page,
      line: b.first,
      at: Date.now(),
    };
    writeLastRead(map);
  } catch { /* 不要讓閱讀位置影響本文 */ }
}

/** Restore the last tab/page of this exact file (name + size), if any. */
export async function restoreLastRead(file: { name: string; size: number }): Promise<boolean> {
  if (!reader || docTabs.length) return false;
  const rec = readLastRead()[lastReadKey(file)];
  if (!rec) return false;
  const max = reader.header.maxBlockOffset || 0;
  if (!(Number.isFinite(rec.from) && Number.isFinite(rec.to) && rec.from >= 0 && rec.to > rec.from && rec.from <= max + 1)) return false;
  try {
    const s = sessionFor({ from: rec.from, to: rec.to }, rec.name || file.name);
    s.page = Math.max(0, Number(rec.page) || 0);
    s.autoEdit = true;
    docActive = docTabs.indexOf(s);
    setPinnedHit(null);
    await ensurePage(s, Number.isFinite(rec.line) ? rec.line : undefined);
    paintTreeActive();
    return true;
  } catch {
    return false;
  }
}



/** 進入編輯前在本文選取的文字（用來把 caret／選取區捲進視窗） */
let pendingDocSelection: { startLine: number; endLine: number; text: string; startText: string } | null = null;
let pendingSelectionUse = false;


function lineElementOf(node: Node | null): HTMLElement | null {
  const el = node && node.nodeType === 1 ? (node as Element) : (node?.parentElement ?? null);
  return (el?.closest?.('.docLine[id^="L"]') as HTMLElement | null) ?? null;
}

/** 記住本文目前的選取（在按鉛筆之前），不用在 click 之後才抓（那時已經收合）。 */
export function rememberDocSelection(): void {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
  const range = sel.getRangeAt(0);
  const root = document.getElementById('docText');
  if (!root || !root.contains(range.commonAncestorContainer)) return;
  const startEl = lineElementOf(range.startContainer);
  const endEl = lineElementOf(range.endContainer);
  if (!startEl || !startEl.id.startsWith('L')) return;
  const startLine = Number(startEl.id.slice(1));
  const endLine = endEl && endEl.id.startsWith('L') ? Number(endEl.id.slice(1)) : startLine;
  const startText = startEl.querySelector('.lineText')?.textContent ?? '';
  pendingDocSelection = { startLine, endLine, text: range.toString(), startText };
}

/** 把 CodeMirror 的 caret／選取移到剛剛在本文選取的那一行，並置中。 */
function scrollEditorToSelection(view: any, pageLines: number[], sel: { startLine: number; text: string; startText: string }): void {
  const idx = pageLines.indexOf(sel.startLine);
  if (idx < 0) return;
  const doc = view.state.doc;
  const line = doc.line(Math.max(1, Math.min(doc.lines, idx + 1)));
  const first = (sel.text || '').split('\n')[0] || sel.startText || '';
  let at = 0;
  if (first) {
    const p = line.text.indexOf(first);
    if (p >= 0) at = p;
  }
  const anchor = line.from + at;
  const head = Math.min(line.to, anchor + Math.max(1, first.length));
  const CM = (globalThis as any).CM;
  try {
    view.dispatch({ selection: { anchor, head }, effects: CM.EditorView.scrollIntoView(anchor, { y: 'center' }) });
  } catch {
    view.dispatch({ selection: { anchor, head } });
  }
}

// 選取時就記住（鉛筆的 mousedown 也會再抓一次，避免 click 前選取被收合）
document.addEventListener('selectionchange', () => {
  if (document.querySelector('.cm-editor')) return;
  rememberDocSelection();
});

function editAllowed(): boolean {
  return document.body.classList.contains('advanced') && !!getUserId();
}

function editSessionOf(): DbEditSession | null {
  return currentSource ? editSessionFor(currentSource, currentFile || currentSource.name) : null;
}

function pageRangeOf(dt: Awaited<ReturnType<VaPaMapper['docText']>>): { first: number; last: number } {
  return { first: dt.lineNumbers[0] ?? 0, last: dt.lineNumbers[dt.lineNumbers.length - 1] ?? 0 };
}

function docNameOf(s: DocSession): string {
  // 目錄節點名稱（樹已依 s="$tag" / s="*tag" 的優先序解析）比 <檔> 檔名更適合當修訂清單
  return s.name || s.doc?.name || '';
}

function setEditControls(s: DocSession | null): void {
  const btn = document.getElementById('editBtn') as HTMLButtonElement | null;
  const history = !!s?.history;
  if (btn) {
    btn.hidden = history;
    const on = !!s?.editing;
    btn.classList.toggle('on', on);
    btn.title = !getUserId()
      ? '請先在「關於」設定修訂者 ID'
      : (on ? '完成編輯（內容已自動暫存）' : '編輯這一頁（修錯字；離開會自動暫存）');
  }
  const toggle = document.getElementById('diffToggle') as HTMLElement | null;
  const box = document.getElementById('showDiff') as HTMLInputElement | null;
  let has = false;
  const dt = s?.cache?.dt;
  if (s && dt && !s.editing) {
    const es = editSessionOf();
    if (es) {
      const r = pageRangeOf(dt);
      has = !!pageEditAt(es, r.first, r.last);
    }
  }
  if (toggle) toggle.hidden = history || !has;
  if (box) box.checked = !history && has && !!s?.showDiff;
}

function noticeEditor(msg: string): void {
  const el = document.getElementById('editNotice');
  if (!el) return;
  el.textContent = msg;
  window.setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 2600);
}

/** Read the editor text into the session WITHOUT destroying the editor. */
function saveActiveEditorText(): void {
  const a = activeEditor;
  if (!a) return;
  const es = editSessionOf();
  if (!es) return;
  try {
    stagePage(es, a.first, a.last, a.oldLines, a.ed.getLines(), a.docName);
  } catch (e) {
    setStatus('暫存失敗：' + (e as Error).message, 'err');
  }
}

function destroyActiveEditor(): void {
  const a = activeEditor;
  activeEditor = null;
  if (!a) { (window as any).__accelon26EditView = null; return; }
  (window as any).__accelon26EditView = null;
  try { a.ed.destroy(); } catch { /* already gone */ }
}

/** Stage and remove the editor (page/session/db is changing). */
export function stageActiveEditor(): void {
  if (!activeEditor) return;
  saveActiveEditorText();
  destroyActiveEditor();
}

/** Called by the db chip save button before a rebuild. */
export function flushEdit(): void {
  saveActiveEditorText();
}


/** Open one page of a historical revision as a read-only diff tab. */
export async function openHistoryPage(detail: { revisionId: string; page: any }): Promise<void> {
  if (!reader || !mapper) return;
  const p = detail.page ?? {};
  const first = Math.max(0, Number(p.first) || 0);
  const last = Math.max(first, Number(p.last) || first);
  const v = mapper.linesVirtual;
  const va = first > 0 ? (v[first - 1] ?? 0) + 1 : 0;
  const doc = docOfVa(va);
  const realm = { from: doc.vaStart, to: doc.vaEnd || reader.header.maxBlockOffset };
  stageActiveEditor();
  const label = (detail.revisionId ? detail.revisionId + ' · ' : '') + (p.doc || doc.name || '歷史');
  // 歷史版本只留一個分頁：換頁／換版本都覆用同一個 docTab
  const existing = docTabs.find((t) => t.history && t === docSession()) ?? docTabs.find((t) => t.history);
  const samePage = !!existing?.history
    && existing.history.revisionId === detail.revisionId
    && existing.history.first === first;
  const totalChanges = Array.isArray(p.changes) ? p.changes.length : 0;
  const focus = totalChanges
    ? (samePage ? ((existing!.history!.focus ?? 0) + 1) % totalChanges : 0)
    : 0;
  const history = {
    revisionId: detail.revisionId,
    first, last,
    doc: p.doc || doc.name || '',
    oldLines: Array.isArray(p.oldLines) ? p.oldLines : [],
    newLines: Array.isArray(p.newLines) ? p.newLines : [],
    focus,
  };
  if (existing) {
    existing.realm = realm;
    existing.doc = doc;
    existing.name = label;
    existing.history = history;
    existing.page = 0;
    existing.cache = null;
    existing.pinned = null;
    existing.editing = false;
    existing.showDiff = false;
    existing.autoEdit = false;
    docActive = docTabs.indexOf(existing);
    setPinnedHit(null);
    await ensurePage(existing, first);
    paintTreeActive();
    return;
  }
  const s = sessionFor(realm, label, true);
  s.history = history;
  s.page = 0;
  s.editing = false;
  s.showDiff = false;
  s.autoEdit = false;
  docActive = docTabs.indexOf(s);
  setPinnedHit(null);
  await ensurePage(s, first);
  paintTreeActive();
}

export function enterEdit(s: DocSession, fromSelection = false): void {
  if (s.history) {
    setStatus('歷史版本只能檢視，不能編輯', 'err');
    return;
  }
  if (!document.body.classList.contains('advanced')) {
    setStatus('請先開啟進階模式才能編輯', 'err');
    return;
  }
  if (!getUserId()) {
    setStatus('請先在「關於」設定修訂者 ID，才能編輯', 'err');
    return;
  }
  if (!s || !s.cache?.dt) return;
  if (reader && reader.header.size > 50 * 1024 * 1024) {
    setStatus('這個 adb 超過 50 MB，網頁版暫不支援編輯（桌面版或 Go 版再處理）', 'err');
    return;
  }
  if (s.cache.dt.lines.some((l) => l.includes('\n') || l.includes('\r'))) {
    setStatus('這一頁的行內含換行字元，CodeMirror 會改變行界，暫不開放編輯', 'err');
    return;
  }
  stageActiveEditor();
  if (fromSelection) {
    if (!pendingDocSelection) rememberDocSelection();
    pendingSelectionUse = !!pendingDocSelection;
  }
  s.editing = true;
  s.autoEdit = true;
  renderDoc(s);
}

export function exitEdit(s: DocSession): void {
  stageActiveEditor();
  s.editing = false;
  s.autoEdit = false;
  renderDoc(s);
}

/** 取消本頁：丟掉這一頁的修訂，回到 base 內容。 */
export function cancelPageEdit(s: DocSession): void {
  const dt = s.cache?.dt;
  if (!dt) return;
  const r = pageRangeOf(dt);
  const es = editSessionOf();
  destroyActiveEditor();
  if (es) discardPage(es, r.first, r.last);
  s.editing = false;
  s.autoEdit = false;
  renderDoc(s);
}

function scheduleStage(): void {
  window.clearTimeout(stageTimer);
  stageTimer = window.setTimeout(() => saveActiveEditorText(), 420);
}

/** The editor view for one page (header + toolbar + CodeMirror). */
function renderEditPage(s: DocSession, dt: Awaited<ReturnType<VaPaMapper['docText']>>): void {
  const b = pageBounds(s.realm, s.page);
  const r = pageRangeOf(dt);
  const key = pageKey(r.first, r.last);
  if (activeEditor && activeEditor.s === s && activeEditor.key === key
    && document.body.contains(activeEditor.ed.view.dom)) {
    renderDocTabs(s);
    renderPager(s, b);
    setEditControls(s);
    return;
  }
  stageActiveEditor();
  const nFirst = dt.lineNumbers[0] ?? 0;
  const nLast = dt.lineNumbers[dt.lineNumbers.length - 1] ?? 0;
  const es = editSessionOf();
  const staged = es ? pageEditAt(es, r.first, r.last) : undefined;
  const lines = staged ? staged.newLines : dt.lines;
  $('#docText').innerHTML = '<div class="docTop">'
    + (isDictDb(mapper)
      ? ''
      : '<div class="docHead docHeadEditing">' + escapeHtml(displayName(s.name))
        + '<span class="dim">第 ' + fmtInt(s.page + 1) + ' / ' + fmtInt(b.pages) + ' 頁 · 行 '
        + fmtInt(nFirst) + '–' + fmtInt(nLast) + ' · <b style="color:var(--gold)">編輯中</b></span></div>')
    + renderAncestorTrail(s)
    + '</div>'
    + '<div id="docEditor">'
    + '<div class="editBar">'
    + '<button type="button" class="mini" id="editDone" title="完成這一頁（自動暫存）">完成</button>'
    + '<button type="button" class="mini" id="editCancel" title="丟掉這一頁的修改">取消本頁</button>'
    + '<span class="editNotice" id="editNotice"></span></div>'
    + '<div class="cmHost" id="cmHost"></div>'
    + '</div>';
  renderDocTabs(s);
  renderPager(s, b);
  wireTrail();
  setEditControls(s);
  const host = document.getElementById('cmHost');
  if (!host) return;
  const ed = mountPageEditor(host, lines.slice(), { onChange: scheduleStage, onNotice: noticeEditor });
  activeEditor = { ed, first: r.first, last: r.last, oldLines: dt.lines.slice(), s, key, docName: docNameOf(s) };
  if (pendingSelectionUse) {
    const sel = pendingDocSelection;
    pendingSelectionUse = false;
    pendingDocSelection = null;
    if (sel) scrollEditorToSelection(ed.view, dt.lineNumbers, sel);
  }
  // diagnostics / headless tests
  (window as any).__accelon26EditView = ed.view;
  (document.getElementById('editDone') as HTMLButtonElement | null)?.addEventListener('click', () => exitEdit(s));
  (document.getElementById('editCancel') as HTMLButtonElement | null)?.addEventListener('click', () => cancelPageEdit(s));
  // the editor owns the keyboard; Esc = 完成
  ed.view.dom.addEventListener('keydown', (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') { ev.preventDefault(); exitEdit(s); }
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') {
      ev.preventDefault();
      saveActiveEditorText();
      noticeEditor('已暫存');
    }
  });
}

/** One changed line as a char-level run: same normal, removed red, added green. */
function charDiffHtml(oldLine: string, newLine: string): string {
  return charDiff(oldLine, newLine).map((s) => {
    if (s.kind === 'del') return '<span class="diff-del-inner">' + escapeHtml(s.text) + '</span>';
    if (s.kind === 'ins') return '<span class="diff-ins-inner">' + escapeHtml(s.text) + '</span>';
    return escapeHtml(s.text);
  }).join('');
}

function diffRow(kind: 'context' | 'del' | 'ins' | 'char', no: string, sign: string, html: string, change?: number): string {
  const attr = change === undefined ? '' : ' data-change="' + change + '"';
  return '<div class="diffRow ' + kind + '"' + attr + '><span class="diffNo">' + no
    + '</span><span class="diffSign">' + sign + '</span><span class="diffText">' + html + '</span></div>';
}

/** 歷史版本：自動顯示 diff，不需要（也不受）「顯示修訂」toggle。 */
function renderHistoryPage(s: DocSession, dt: Awaited<ReturnType<VaPaMapper['docText']>>): void {
  const h = s.history!;
  const newLines = h.newLines.length ? h.newLines : dt.lines;
  const edit: PageEdit = {
    first: h.first,
    last: h.last,
    oldLines: h.oldLines.length ? h.oldLines : dt.lines,
    newLines,
    docName: h.doc,
  };
  renderDiffPage(s, dt, edit, { historyId: h.revisionId, focus: h.focus ?? 0 });
}

/** 閱讀模式的修訂檢視：新增綠、刪除紅，完全不呼叫 paintHit（不塗搜尋關鍵字）。 */
function renderDiffPage(s: DocSession, dt: Awaited<ReturnType<VaPaMapper['docText']>>, edit: PageEdit, opts?: { historyId?: string; focus?: number }): void {
  const b = pageBounds(s.realm, s.page);
  const nFirst = dt.lineNumbers[0] ?? 0;
  const nLast = dt.lineNumbers[dt.lineNumbers.length - 1] ?? 0;
  const changes = diffPage(edit).changes;
  const hist = !!opts?.historyId;
  const totalChanges = changes.length;
  const focus = Math.max(0, Math.min(totalChanges ? totalChanges - 1 : 0, Number(opts?.focus) || 0));
  const info = hist ? '修改 ' + totalChanges + ' 處 · diff ' + (totalChanges ? focus + 1 : 0) + '/' + totalChanges : '';
  let added = 0, removed = 0;
  const rows: string[] = [];
  let oi = 0;
  let ni = 0;
  let changeIndex = 0;
  const first = edit.first;
  // 歷史頁的 first/last 是 base 0-based；列表顯示 1-based，標題也一致
  const shownFirst = hist ? edit.first + 1 : nFirst;
  const shownLast = hist ? edit.last + 1 : nLast;
  const badge = hist ? '歷史版本 ' + escapeHtml(opts!.historyId!) + ' · 唯讀' : '修訂檢視';
  const context = (text: string, no: number) => diffRow('context', String(no), ' ', escapeHtml(text));
  for (const c of changes) {
    const rel = Math.max(0, Math.min(edit.oldLines.length, c.line - first));
    while (oi < rel) {
      rows.push(context(edit.oldLines[oi], first + oi + 1));
      oi++;
      ni++;
    }
    if (c.kind === 'replace') {
      const oldLine = c.oldLine ?? edit.oldLines[oi] ?? '';
      const newLine = c.newLine ?? edit.newLines[ni] ?? '';
      rows.push(diffRow('char', String(first + oi + 1), '~', charDiffHtml(oldLine, newLine), changeIndex++));
      oi++;
      ni++;
    } else if (c.kind === 'delete') {
      const oldLine = c.oldLine ?? edit.oldLines[oi] ?? '';
      rows.push(diffRow('del', String(first + oi + 1), '-', escapeHtml(oldLine), changeIndex++));
      removed++;
      oi++;
    } else {
      const newLine = c.newLine ?? edit.newLines[ni] ?? '';
      rows.push(diffRow('ins', '', '+', escapeHtml(newLine), changeIndex++));
      added++;
      ni++;
    }
  }
  while (oi < edit.oldLines.length) {
    rows.push(context(edit.oldLines[oi], first + oi + 1));
    oi++;
    ni++;
  }
  $('#docText').innerHTML = '<div class="docTop">'
    + (isDictDb(mapper)
      ? ''
      : '<div class="docHead">' + escapeHtml(displayName(s.name))
        + '<span class="dim">第 ' + fmtInt(s.page + 1) + ' / ' + fmtInt(b.pages) + ' 頁'
        + (hist ? '' : ' · 行 ' + fmtInt(shownFirst) + '–' + fmtInt(shownLast))
        + ' · <b style="color:' + (hist ? 'var(--history-fg)' : 'var(--warn)') + '">' + badge + '</b>'
        + (hist ? '<span class="diffHeaderInfo">' + info + '</span>' : '')
        + '</span></div>')
    + renderAncestorTrail(s)
    + '</div>'
    + (hist ? '' : '<div class="diffLegend">修訂檢視：'
      + (added ? '<b class="add">新增 ' + added + ' 行</b> · ' : '')
      + (removed ? '<b class="del">刪除 ' + removed + ' 行</b> · ' : '')
      + '修改 ' + totalChanges + ' 處</div>')
    + '<div class="diffView">' + rows.join('') + '</div>';
  lastDocLines = dt.lines;
  renderDocTabs(s);
  if (hist) {
    const pager = document.getElementById('docPager');
    if (pager) pager.hidden = true;
  } else {
    renderPager(s, b);
  }
  wireTrail();
  setEditControls(s);
  const view = document.querySelector<HTMLElement>('.diffView');
  if (view) {
    // 一般修訂跳到第一個差異；歷史版本跳到 focus 指定的那一處
    const target = view.querySelector<HTMLElement>('[data-change="' + (hist ? focus : 0) + '"]')
      ?? view.querySelector<HTMLElement>('.diffRow.char, .diffRow.del, .diffRow.ins');
    if (target) {
      const vr = view.getBoundingClientRect();
      const rr = target.getBoundingClientRect();
      view.scrollTop += rr.top - vr.top - Math.max(0, (view.clientHeight - rr.height) / 2);
    } else {
      view.scrollTop = 0;
    }
  }
}

/** 標題的頁碼／行數／source 資訊：平時隱藏，hover 標題才用浮層顯示（不佔 breadcrumb 的寬度）。 */
let docMetaTip: HTMLElement | null = null;
function hideDocMetaTip(): void {
  docMetaTip?.remove();
  docMetaTip = null;
}
function wireDocMetaTips(): void {
  hideDocMetaTip();
  document.querySelectorAll<HTMLElement>('#docText .docHeadReading').forEach((head) => {
    const meta = head.querySelector<HTMLElement>('.docMeta');
    if (!meta) return;
    head.addEventListener('mouseenter', () => {
      const text = (meta.textContent || '').trim();
      if (!text) return;
      hideDocMetaTip();
      const tip = document.createElement('div');
      tip.className = 'docMetaTip';
      tip.textContent = text;
      document.body.appendChild(tip);
      const r = head.getBoundingClientRect();
      const tw = tip.offsetWidth, th = tip.offsetHeight;
      const left = Math.min(Math.max(8, r.left), window.innerWidth - tw - 8);
      let top = r.bottom + 6;
      if (top + th > window.innerHeight - 8) top = Math.max(8, r.top - th - 6);
      tip.style.left = Math.round(left) + 'px';
      tip.style.top = Math.round(top) + 'px';
      docMetaTip = tip;
    });
    head.addEventListener('mouseleave', hideDocMetaTip);
  });
}
window.addEventListener('scroll', hideDocMetaTip, true);
window.addEventListener('resize', hideDocMetaTip);

/** render one page: tab strip, header, rows, pager. */
function renderDoc(s: DocSession): void {  const dt = s.cache?.dt;
  if (!dt) return;
  if (s.editing && !editAllowed()) s.editing = false;
  setEditControls(s);
  if (s.editing) { renderEditPage(s, dt); return; }
  if (s.history) { renderHistoryPage(s, dt); return; }
  const esNow = editSessionOf();
  const rrNow = pageRangeOf(dt);
  const pageEdit = esNow ? pageEditAt(esNow, rrNow.first, rrNow.last) : undefined;
  if (s.showDiff && pageEdit) { renderDiffPage(s, dt, pageEdit); return; }
  // 離開編輯後，閱讀模式要看到「改過的文字」：把這一頁的 PageEdit.newLines
  // 疊回 base 的 dt。行數不變（改錯字）是常態；有插刪行時重新編 lineNumbers。
  let viewDt = dt;
  if (pageEdit) {
    const start = Math.max(0, pageEdit.first - rrNow.first);
    const oldCount = pageEdit.last - pageEdit.first + 1;
    const lines = dt.lines.slice();
    if (start <= lines.length) lines.splice(start, Math.min(oldCount, lines.length - start), ...pageEdit.newLines);
    const lineNumbers = lines.length === dt.lineNumbers.length
      ? dt.lineNumbers
      : lines.map((_, i) => (dt.lineNumbers[0] ?? rrNow.first) + i);
    viewDt = { ...dt, lines, lineNumbers };
  }
  lastDocLines = viewDt.lines;
  // The pinned line is marked HERE (synchronously) so the row exists with its
  // hitLine class the moment the page is in the DOM; paintHit only adds the mark.
  // the pinned line is marked only while it is ON this page (see ensurePage)
  // 原書分行（作者 2026-10）：硬換行要不要保留。false＝文字連著排（見 renderPageBlocks）。
  // 「顯示原書頁碼」（作者 2026-10）：`<頁>`／`<_頁>` 要不要渲染（頁碼與頁分隔都算）。
  const blocks = renderRaw
    ? viewDt.lines.map((line, k) => ({ kind: 'line' as const, lines: [{ no: viewDt.lineNumbers[k], html: escapeHtml(simConverter() ? simConverter()!(line) : line), raw: line, visible: true, heading: false }] }))
    : renderPageBlocks(viewDt.lines, viewDt.lineNumbers, {
      hardBreaks, marks: hardBreaks ? [] : kwMarks(), convert: simConverter(), pageMarks: pageMarksOn(),
      imageUrl: imageUrlOf,
    });
  const rows = renderBlocks(blocks, s);
  const b = pageBounds(s.realm, s.page);
  const nFirst = viewDt.lineNumbers[0] ?? 0;
  const nLast = viewDt.lineNumbers[viewDt.lineNumbers.length - 1] ?? 0;
  // 詞典型 adb 不顯示 docHead（作者 2026-10）：詞條名稱已經在分頁標題上，
  // 而第一個詞條字串通常就是命中、會被塗紅 —— 再放一次就變成同一個詞顯示三次。
  // 標題（.docHead）與 breadcrumb 排在同一行（作者 2026-10-18）：.docTop 是 flex row，
  // 標題保留原本的語意（h 區的 .docHead），路徑接在它後面、不另起一列。
  const headTitle = displayName(s.name);
  // 標題和分頁標籤一樣時就不必再顯示一次，把橫向空間留給 breadcrumb
  const showHead = !isDictDb(mapper) && headTitle !== shortLabel(s.name);
  $('#docText').innerHTML = '<div class="docTop">'
    + (showHead
      ? '<div class="docHead docHeadReading">' + escapeHtml(headTitle)
        + '<span class="dim docMeta">第 ' + fmtInt(s.page + 1) + ' / ' + fmtInt(b.pages) + ' 頁（每頁 ' + fmtInt(PAGE_LINES) + ' 行）'
        + ' · 行 ' + fmtInt(nFirst) + '–' + fmtInt(nLast) + ' / 此節點共 ' + fmtInt(b.total) + ' 行'
        + ' · source 區塊 ' + dt.blockFirst + '–' + dt.blockLast + ' · ' + fmtInt(dt.text.length) + ' 字</span></div>'
      : '')
    + renderAncestorTrail(s)
    + '</div>'
    + '<div class="docBody' + (hardBreaks ? '' : ' reflow') + '">' + rows + '</div>';
  renderDocTabs(s);
  renderPager(s, b);
  wireTrail();
  wireDocMetaTips();
  const body = document.querySelector<HTMLElement>('#docText .docBody');
  body?.scrollTo(0, 0);
  // the middle-line cursor follows the pane, so re-read it after every render and
  // after every programmatic scroll (paintHit) — throttled to one frame
  if (body && !docScrollWired.has(body)) {
    docScrollWired.add(body);
    body.addEventListener('scroll', scheduleCursorSync, { passive: true });
  }
  if (s.pinned) void paintHit(s.pinned.va, s.pinned.units);
  else if (viewDt.lineNumbers.length) document.getElementById('L' + nFirst)?.scrollIntoView({ block: 'start' });
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
  const es = editSessionOf();
  strip.innerHTML = docTabs.map((t, i) => {
    const rb = boundsOfRealm(t.realm);
    const dirty = hasEditsInRange(es, rb.first, rb.last);
    return '<span class="docTab' + (i === docActive ? ' active' : '') + (dirty ? ' dirty' : '') + (t.history ? ' history' : '') + '" data-i="' + i + '" title="' + escapeHtml(t.name) + '">'
      + '<span class="docTabName">' + escapeHtml(shortLabel(t.name, 8)) + '</span>'
      + '<span class="docTabClose" data-close="' + i + '" title="關閉分頁">✕</span></span>';
  }).join('');
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
  stageActiveEditor();
  t.autoEdit = true;
  docActive = i;
  setPinnedHit(t.pinned);
  if (t.cache) renderDoc(t);
  else await ensurePage(t);
  paintTreeActive();
  saveLastReadNow();
}

/** close a tab; the remaining tabs keep their own page */
function closeDocTab(i: number): void {
  if (i < 0 || i >= docTabs.length) return;
  if (docTabs[i] && activeEditor?.s === docTabs[i]) stageActiveEditor();
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
  destroyActiveEditor();
  docTabs = [];
  docActive = 0;
  docFontSized = false;
  boundsCache.clear();
  paintAsked.clear();
  lastDocLines = [];
  lastLink = null;
  pagerLog.length = 0;
}

// 修訂數變動：docTab 的紅底即時更新（dbChip 由 dbs.ts 自己訂閱）
onEditsChange(() => {
  const s = docSession();
  if (s) { renderDocTabs(s); setEditControls(s); }
});

import { DocRow } from './adb';

import { VaPaMapper } from './vapa';
import { updateDocLogo } from './logo';

/** everything the document pane keeps for ONE database */
function snapshotDocPane() {
  // the CodeMirror view is not serialisable; write its text into the session first
  stageActiveEditor();
  saveLastReadNow();
  return { docTabs, docActive, docSeq, lastDocLines, lastLink, lastFit };
}
function restoreDocPane(s: any): void {
  destroyActiveEditor();
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
