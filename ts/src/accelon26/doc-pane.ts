/**
 * 本文分頁與捲動：session、分頁（page）、本文渲染、字級。
 *
 * Split out of viewer.ts (ACCELON26-HANDOVER 3.2). Shared state is read from
 * ./viewer and the other split modules as ESM live bindings; a module OWNS the
 * state it declares, and other modules get/set it through that module's exports.
 */
import { $, currentFile, currentSource, displayName, docs, escapeHtml, fmtInt, mapper, reader, session, setStatus } from './viewer';
import { activeDocDbId, isActiveDocCtx, resolveDocCtx, type DocCtx } from './doc-ctx';
import { PAGE, openImageView } from './panes';
import { cursorPending, hasRealmNeighbor, nodeContaining, paintTreeActive, pinnedHit, revealHit, setCursorPending, setPinnedHit, stepRealm, syncCursorFromScroll } from './link';
import { paintHit } from './paint';
import { Accelon3Renderer, LEVEL_MAX_SCALE, LEVEL_STEP_PX, renderPageBlocks, tableHtml, tagChromaIndex, tierContext, type RenderBlock } from './render_accelon3';
import { upgradeDocGlyphs } from './glyph';
import { ancestorTrail, currentNodeAt, siblingsOf } from './scopes';
import { tagColorOf } from './tag-style';
import { kwMarks } from './kw-marks';
import { highlightWordIn } from './word-hl';
import { getUserId } from './user-id';
import { displayConverter, type SimMode } from './lossless';
import { isDictDb, isNoIndent } from './db-kind';
import { diffPage, discardPage, hasEditsInRange, onEditsChange, pageEditAt, pageKey, sessionFor as editSessionFor, stagePage, type DbEditSession, type PageEdit } from './edit-session';
import { SHORT_DB_NAMES } from './short-titles';
import { charDiff } from './char-diff';
import { decodeXmlEntities } from '../xml-entities';
import { mountPageEditor, type PageEditor } from './editor';
import './reading-pane';   // 精讀模式（🙏／F4）：它只依賴 adb／vapa，不會造成循環
import { isHan } from './han';

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
 * 一次 `resourceBytes()` 就能換成 URL；同一頁重畫時直接用快取。
 *
 * 快取**跟著 reader 走**（作者 2026-11-01）：以前只有一份、換庫就整批撤銷，
 * 但跨庫分頁可以並存，A 庫與 B 庫的圖得分開留著。關庫時由 `dropPageImages()`
 * 撤銷（blob URL 不撤銷會一直佔著記憶體）。
 */
interface PageImages {
  urls: Map<string, string>;
  svgs: Map<string, string>;
  /** 資源名 → resources 容器的第幾個 block（第一次用才建） */
  index: Map<string, number> | null;
}

const pageImages = new WeakMap<AdbReader, PageImages>();
/** 目前這一頁的圖集：渲染是同步的，所以 `imageUrlOf` / `svgTextOf` 只讀這一份 */
let imageSet: PageImages | null = null;

function pageImagesOf(rd: AdbReader): PageImages {
  let set = pageImages.get(rd);
  if (!set) {
    set = { urls: new Map(), svgs: new Map(), index: null };
    pageImages.set(rd, set);
  }
  return set;
}

/** 關庫時撤銷這一庫的圖（blob URL 不會自己回收） */
export function dropPageImages(rd: AdbReader | null | undefined): void {
  if (!rd) return;
  const set = pageImages.get(rd);
  if (!set) return;
  for (const url of set.urls.values()) URL.revokeObjectURL(url);
  set.urls.clear();
  set.svgs.clear();
  set.index = null;
  pageImages.delete(rd);
  if (imageSet === set) imageSet = null;
}

/** 這一頁用到的圖先解好；渲染本身是同步的，所以只能先做 */
async function resolvePageImages(ctx: DocCtx | null, lines: readonly string[]): Promise<void> {
  const rd = ctx?.reader;
  if (!rd) return;
  const set = pageImagesOf(rd);
  const names = new Set<string>();
  for (const line of lines) {
    // `n=`／`id=`／`f=` 都是圖檔名（f= 是 Delphi 的 FILE 屬性，taixu 的表格掃描用它）
    for (const m of line.matchAll(/<圖[^>]*?\b(?:n|id|f)\s*=\s*"([^"]*)"/g)) names.add(decodeXmlEntities(m[1]));
  }
  if (names.size) {
    if (!set.index) {
      const c = rd.containers.get('resources');
      set.index = new Map();
      for (let i = 0; i < (c?.count ?? 0); i++) set.index.set(c!.names[i], i);
    }
    for (const name of names) {
      if (set.urls.has(name) || set.svgs.has(name)) continue;
      const i = set.index.get(name);
      if (i === undefined) continue;
      const { bytes } = await rd.resourceBytes(i);
      const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
      if (ext === 'svg') {
        // SVG：留原文（下面 inline 進 DOM），不建 blob URL
        set.svgs.set(name, new TextDecoder('utf-8').decode(bytes));
        continue;
      }
      const type = ext === 'jpg' ? 'image/jpeg' : `image/${ext || 'png'}`;
      set.urls.set(name, URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer], { type })));
    }
  }
  // 全部解完才指定：渲染拿到的就是剛剛這一頁的那一份
  imageSet = set;
}

/** 給渲染器的查表函式（渲染是同步的，查不到就畫佔位方塊） */
function imageUrlOf(name: string): string | null {
  return imageSet?.urls.get(name) ?? null;
}

/** SVG 原文（有就 inline，沒有就退回 blob URL／佔位方塊） */
function svgTextOf(name: string): string | null {
  return imageSet?.svgs.get(name) ?? null;
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

const TERM_KEY = 'accelon26.termMode';

/** <术> 術語的外語顯示方式（作者 2026-10-31） */
export type TermMode = 'orig' | 'hover' | 'inline' | 'off';

let termMode: TermMode = (() => {
  try {
    const v = localStorage.getItem(TERM_KEY);
    return v === 'inline' || v === 'off' ? v : 'hover';
  } catch { return 'hover'; }
})();

export function termModeOf(): TermMode {
  return termMode;
}

export function setTermMode(m: TermMode): void {
  // 'hover' 也要留住（2026-11-06）：以前這裡漏了它，設定頁選 hover 會被存成 orig，
  // auto 的 <术>（a="1"）就不畫虛線、也沒有外語提示。
  termMode = m === 'inline' || m === 'off' || m === 'orig' || m === 'hover' ? m : 'orig';
  try { localStorage.setItem(TERM_KEY, termMode); } catch { /* 私密模式 */ }
}
export function pageMarksOn(): boolean {
  return pageMarks;
}

export function setPageMarks(on: boolean): void {
  pageMarks = !!on;
  try { localStorage.setItem(PAGE_MARKS_KEY, on ? '1' : '0'); } catch { /* 私密模式 */ }
}

// ------------------------------------------ 罕用字改用字形庫（作者 2026-11-06）
//
// 開（預設）＝ 本文的 Unicode Extension 漢字疊上字形庫的 SVG（`.gw`，原字留著，
// 所以選取／複製／塗紅／`#N` 都不變）。字庫載不到（網頁版）就什麼都不做。
// 實作在 `glyph.ts`；這裡只保存開關，重畫時決定要不要叫它。
const GLYPH_KEY = 'accelon26.glyphs';

let glyphsOn = (() => { try { return localStorage.getItem(GLYPH_KEY) !== '0'; } catch { return true; } })();

export function glyphsEnabled(): boolean {
  return glyphsOn;
}

export function setGlyphsEnabled(on: boolean): void {
  glyphsOn = !!on;
  try { localStorage.setItem(GLYPH_KEY, on ? '1' : '0'); } catch { /* 私密模式 */ }
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
  /**
   * 這一頁再往下多渲染幾頁（0＝只有本頁 200 行）。
   *
   * 厚觀法師 2026-11-12「引用複製不能往下捲」：連續閱讀雖然叫連續，其實還是
   * 200 行一頁，滾到底就是頁底，拖選只能選到那一行為止。往下滾時把這個數字
   * 加一，渲染窗口就跟著長一頁，滾動條變長、內容接下去，選取再用
   * captureDocSelection／applyDocSelection 接回去。
   */
  win?: number;
  /** the `<檔>` the realm lives in */
  doc: DocRow;
  /**
   * 這個分頁畫哪一庫的文字（作者 2026-11-01）。
   *
   * 只存**參考**：同一個庫的分頁指到同一份 reader／mapper，不複製。
   * 本文區一切（頁界、行、xref 錨點、編輯工作階段）都從這裡取，
   * 不再讀全域的 `reader`／`mapper` —— 那是「左欄那一庫」。
   */
  ctx: DocCtx;
  /** 離開這個分頁時的捲動位置與選取區（切回分頁要回到原處；見 renderDoc 的 pendingView） */
  scrollTop?: number;
  sel?: DocSelection | null;
  pinned: {
    va: number; text: string; token: string; units: number; line: number;
    exact?: boolean;
    /** what `exact` should paint, when it differs from the tab label (全文 pane) */
    phrase?: string;
    /** link without painting anything (原書分頁) */
    noMark?: boolean;
  } | null;
  /** last rendered page (per session, so switching tabs does not re-read) */
  cache: { page: number; dt: Awaited<ReturnType<VaPaMapper['docText']>>; key: string; bounds?: { first: number; last: number; total: number; pages: number } } | null;
  /**
   * 「連續閱讀」之前的節點 realm（2026-11-05）：按鈕切換到整本視窗後，再按一次回到
   * 這個範圍。不進快照（還原時用 `nodeContaining` 重算）。
   */
  nodeRealm?: { from: number; to: number };
  /** 連續閱讀是從哪一行開始的（按「回到本節」要回到那一行，不是視窗頂端） */
  nodeLine?: number;
  /** 這個分頁是不是「連續閱讀」中（整本往後讀，頁尾補到段落結束） */
  continuous?: boolean;
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

/**
 * 下一次 `renderDoc` 要還原的「看的地方」：捲動位置＋選取區（作者 2026-11-01）。
 *
 * 用在：切分頁、切庫還原快照、開檔還原上次閱讀狀態。有它時 `renderDoc` 會
 * 告訴 `paintHit` 不要自己捲到釘選那一行（否則剛還原的位置會被搶走）。
 */
let pendingView: { scrollTop?: number; sel?: DocSelection | null } | null = null;

/** one paint retry per target line per tab (see paintHit) */
const paintAsked = new Map<number, number>();

/** cost of the last link (diagnostics: state().lastLink) */
let lastLink: { va: number; ensureMs: number; totalMs: number; rows: number } | null = null;

/** what the pager buttons did (diagnostics: state().pagerLog) */
const pagerLog: string[] = [];

const docSession = (): DocSession | null => docTabs[docActive] ?? null;

/**
 * 「左欄那一庫」的 ctx：由全域 `reader`／`mapper`／`session`／`docs` 組出來。
 *
 * 分頁沒有自己的 ctx 時（例如舊快照還原、`＋` 新分頁）就用這一個；正常情況下
 * 每個分頁建立時就已經帶著自己的 ctx（見 link.ts 的 `linkTo`／`sessionFor`）。
 */
export function activeDocCtx(): DocCtx | null {
  const rd = reader;
  const mp = mapper;
  if (!rd || !mp) return null;
  return {
    dbId: activeDocDbId(),
    reader: rd,
    mapper: mp,
    session,
    docs,
    dbName: rd.header.dbname ?? '',
    dbCName: rd.header.dbcname ?? '',
    file: currentSource,
    fileName: currentFile,
  };
}

/** 分頁自己的 ctx；沒有就退回 active 那一庫（舊快照／極早期建立的分頁） */
const ctxOf = (s: DocSession | null | undefined): DocCtx | null => s?.ctx ?? activeDocCtx();

/** 這個分頁是不是「左欄那一庫」的分頁（決定麵包屑、目錄游標、反鏈要不要畫） */
export const ownsActiveDb = (s: DocSession | null | undefined): boolean =>
  isActiveDocCtx(ctxOf(s));

/* ---------------------------------------------- inline 圖：點一下放大（作者 2026-10-29／2026-11-06）
 *
 * 正文的 `<圖>` 有兩種：inline `<svg>`（小篆字形、SVG 圖版）與 `<img class="inlineImg">`
 * （點陣圖版，例如 tx 的掃描圖）。點一下都交給右欄「圖片」用的同一個 #imgView
 * （滾輪縮放、拖曳、0/1、存檔）。
 * SVG 的檔名由 `aria-label` 帶；img 用 `alt`／`title`（renderer 寫的是資源名）。
 * hover 顯示檔名是 renderer 寫的 `title`。
 */
let inlineImgBound = false;

/**
 * 把 inline `<svg>` 序列化成可以獨立存檔的 SVG 檔（2026-11-09）。
 *
 * innerHTML 建出來的 `<svg>` 沒有 `xmlns`，直接 `XMLSerializer` 存成 .svg 之後，
 * 用瀏覽器或向量軟體打開會說格式錯誤（厚觀法師 2026-11-08 回報「下載 SVG 出現錯誤」）。
 * 這裡補上 `xmlns`／`xmlns:xlink`，並把 `width`／`height` 從 viewBox 補出來。
 */
function serializeSvgElement(svg: SVGSVGElement): string {
  let text = new XMLSerializer().serializeToString(svg);
  const open = text.match(/^<svg\b([^>]*)>/i);
  if (open && !/\bxmlns=/.test(open[1])) {
    const vb = (svg.getAttribute('viewBox') || '').trim().split(/\s+/).map(Number);
    let extra = ' xmlns="http://www.w3.org/2000/svg"';
    if (!/\bxmlns:xlink=/.test(open[1])) extra += ' xmlns:xlink="http://www.w3.org/1999/xlink"';
    if (vb.length === 4 && !/\bwidth=/.test(open[1])) {
      extra += ` width="${vb[2]}" height="${vb[3]}"`;
    }
    text = text.replace(open[0], `<svg${open[1]}${extra}>`);
  }
  return text;
}

function bindInlineImageZoom(): void {
  if (inlineImgBound) return;
  inlineImgBound = true;
  document.addEventListener('click', (ev) => {
    const el = ev.target as Element | null;
    const svg = el?.closest?.('#docText svg.inlineSvg') as SVGSVGElement | null;
    // 圖上的注號（厚觀法師 2026-11-12）：點它要跳到釋文，不是把圖放大。
    // notes.ts 的處理也在 document 上，stopPropagation 擋不住同層的其他監聽，
    // 所以在這裡先讓開。
    if (svg && el?.closest?.('a.noteRef')) return;
    if (svg) {
      // 不要讓點圖同時觸發文字的「選取／查字典」手勢
      ev.preventDefault();
      ev.stopPropagation();
      const name = svg.getAttribute('aria-label') || 'inline.svg';
      const text = serializeSvgElement(svg);
      const bytes = new TextEncoder().encode(text);
      const url = URL.createObjectURL(new Blob([bytes], { type: 'image/svg+xml' }));
      openImageView(name, url, bytes);
      return;
    }
    const img = el?.closest?.('#docText img.inlineImg') as HTMLImageElement | null;
    if (!img) return;
    ev.preventDefault();
    ev.stopPropagation();
    const name = img.getAttribute('alt') || img.getAttribute('title') || 'inline.png';
    const src = img.currentSrc || img.src;
    if (!src) return;
    // blob URL 與頁面同源，file:// 下也 fetch 得到；抓不到 bytes 仍可看圖（存檔走 URL）
    void fetch(src)
      .then((r) => r.arrayBuffer())
      .then((b) => new Uint8Array(b))
      .catch(() => new Uint8Array())
      .then((bytes) => openImageView(name, src, bytes));
  }, true);
}

/* ---------------------------------------------- 行的頁位置（debug，作者 2026-10-29）
 *
 * 連排（原書分行關閉）時看不出這一行在原書哪一頁；選項打開後，滑過本文行就浮出
 * 「頁 8p0052a ・ 第 40433 行」。預設關閉——這只是校對用的。
 */
const LINE_TIP_KEY = 'accelon26.lineTip';
let lineTipOn = false;
try { lineTipOn = localStorage.getItem(LINE_TIP_KEY) === '1'; } catch { /* 私密模式 */ }

/** `<頁>` 的 VA → 頁 id（與「跳至」同一份資料，只建一次；**每個 reader 一份**） */
const pageIdxCache = new WeakMap<AdbReader, { va: number; id: string }[]>();

/** 這一庫的 `<頁>` 標籤 VA（`scopes.tagVas` 讀的是全域 reader，這裡要跟 ctx 走） */
async function tagVasIn(ctx: DocCtx | null, tag: string): Promise<number[]> {
  const rd = ctx?.reader;
  if (!rd) return [];
  const at = rd.containers.get('tags')?.names.indexOf(tag) ?? -1;
  if (at < 0) return [];
  return (await rd.decodeBlockList('tags', at)).slice().sort((a, b) => a - b);
}

async function ensurePageIndex(ctx: DocCtx | null): Promise<{ va: number; id: string }[]> {
  const rd = ctx?.reader;
  if (!rd) return [];
  const hit = pageIdxCache.get(rd);
  if (hit) return hit;
  const av = await rd.attributeValues('頁.id');
  const vas = await tagVasIn(ctx, '頁');
  const list: { va: number; id: string }[] = [];
  if (av?.values.length && vas.length) {
    for (let i = 0; i < av.values.length && i < vas.length; i++) list.push({ va: vas[i], id: av.values[i] });
    list.sort((a, b) => a.va - b.va);
  }
  pageIdxCache.set(rd, list);
  return list;
}

/** 這一行落在哪一頁：頁 VA 遞增，二分搜尋最後一個 ≤ 該行 VA 的頁 */
function pageAtLine(idx: { va: number; id: string }[], mp: VaPaMapper | null, line: number): string {
  if (!idx.length || !mp) return '';
  const va = mp.linesVirtual[line] ?? 0;
  let lo = 0, hi = idx.length - 1, at = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (idx[mid].va <= va) { at = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return at >= 0 ? idx[at].id : '';
}

let lineTipEl: HTMLElement | null = null;
function lineTipBox(): HTMLElement {
  if (!lineTipEl) {
    lineTipEl = document.createElement('div');
    lineTipEl.id = 'lineTip';
    lineTipEl.className = 'lineTip';
    lineTipEl.hidden = true;
    document.body.appendChild(lineTipEl);
  }
  return lineTipEl;
}
function hideLineTip(): void { if (lineTipEl) lineTipEl.hidden = true; }
function showLineTip(x: number, y: number, text: string): void {
  const el = lineTipBox();
  el.textContent = text;
  el.style.left = Math.min(window.innerWidth - 16, x + 14) + 'px';
  el.style.top = (y + 16) + 'px';
  el.hidden = false;
}

export function lineTipEnabled(): boolean { return lineTipOn; }
export function setLineTip(on: boolean): void {
  lineTipOn = !!on;
  try { localStorage.setItem(LINE_TIP_KEY, on ? '1' : '0'); } catch { /* 私密模式 */ }
  if (!on) hideLineTip();
}

let lineTipBound = false;
function bindLineTip(): void {
  if (lineTipBound) return;
  lineTipBound = true;
  const box = $('#docText');
  if (!box) return;
  box.addEventListener('mousemove', (ev) => {
    // 只在「連排」（原書分行關閉）＋選項打開時顯示：原書分行時頁碼本來就看得到
    if (!lineTipOn || hardBreaksOn()) { hideLineTip(); return; }
    const lineEl = (ev.target as Element | null)?.closest?.('.docLine') as HTMLElement | null;
    if (!lineEl || !lineEl.id.startsWith('L')) { hideLineTip(); return; }
    const line = Number(lineEl.id.slice(1));
    if (!Number.isFinite(line)) { hideLineTip(); return; }
    void ensurePageIndex(docSession()?.ctx ?? null).then((idx) => {
      if (!lineTipOn) return;
      const page = pageAtLine(idx, docSession()?.ctx?.mapper ?? null, line);
      showLineTip(ev.clientX, ev.clientY, (page ? `頁 ${page} ・ ` : '') + `第 ${line} 行`);
    });
  });
  box.addEventListener('mouseleave', hideLineTip);
}

// `<彈 t="…">文字</彈>`：hover 超過 1 秒才顯示 t 的內容（t 不進正文）。
let tanTipEl: HTMLElement | null = null;
let tanTimer = 0;
let tanTarget: HTMLElement | null = null;
function tanTipBox(): HTMLElement {
  if (!tanTipEl) {
    tanTipEl = document.createElement('div');
    tanTipEl.className = 'tanTip';
    tanTipEl.hidden = true;
    document.body.appendChild(tanTipEl);
  }
  return tanTipEl;
}
function hideTanTip(): void {
  window.clearTimeout(tanTimer);
  tanTarget = null;
  if (tanTipEl) tanTipEl.hidden = true;
}
function showTanTip(el: HTMLElement): void {
  const text = el.dataset.tip ?? '';
  if (!text) return;
  const box = tanTipBox();
  box.textContent = text;
  // 提示字級跟正文那一段一致（作者 2026-11-06：<彈> 的字太小）
  box.style.fontSize = getComputedStyle(el).fontSize;
  const r = el.getBoundingClientRect();
  box.style.left = Math.min(window.innerWidth - 16, Math.max(8, r.left)) + 'px';
  box.style.top = Math.min(window.innerHeight - 16, r.bottom + 6) + 'px';
  box.hidden = false;
}
let tanBound = false;
function bindTanTips(): void {
  if (tanBound) return;
  tanBound = true;
  const box = $('#docText');
  if (!box) return;
  box.addEventListener('mouseover', (ev) => {
    const el = (ev.target as Element | null)?.closest?.('.tan') as HTMLElement | null;
    if (!el) return;
    if (tanTarget === el) return;
    window.clearTimeout(tanTimer);
    if (tanTipEl) tanTipEl.hidden = true;
    tanTarget = el;
    tanTimer = window.setTimeout(() => {
      if (tanTarget === el) showTanTip(el);
    }, 1000);
  });
  box.addEventListener('mouseout', (ev) => {
    const el = (ev.target as Element | null)?.closest?.('.tan') as HTMLElement | null;
    if (!el) return;
    const to = ev.relatedTarget as Node | null;
    if (to && el.contains(to)) return;
    if (tanTarget === el) hideTanTip();
  });
  box.addEventListener('mouseleave', hideTanTip);
  window.addEventListener('scroll', hideTanTip, true);
  window.addEventListener('accelon26:rerender', hideTanTip);
}

/**
 * 滾到某一行（腳注連動用，作者 2026-10-26）：不塗紅、不釘選。
 * 行號不屬於目前分頁的 `<檔>` 時，用**行號**找那個檔（不能拿 lineStartOf 的 VA 去
 * 比 docOfVa：manual 這種庫的 tags VA 與行表 VA 不在同一個空間，會挑錯檔）。
 */
export async function revealDocLine(line: number): Promise<void> {
  // 腳注連動跟著「目前這個本文分頁」的庫走（跨庫分頁時不能用左欄那一庫的行表）
  const ctx = ctxOf(docSession()) ?? activeDocCtx();
  const mp = ctx?.mapper;
  const rd = ctx?.reader;
  if (!ctx || !mp || !rd) return;
  const cur = docSession();
  const curB = cur ? boundsOfRealm(ctxOf(cur), cur.realm) : null;
  let s = cur;
  if (!s || !curB || line < curB.first || line > curB.last) {
    const list = ctx.docs;
    const hit = list.find((d, i) => {
      const first = mp.lineOfVa(d.vaStart);
      const last = i + 1 < list.length ? mp.lineOfVa(list[i + 1].vaStart) - 1 : rd.header.lineCount - 1;
      return line >= first && line <= last;
    });
    if (hit) s = sessionFor(ctx, { from: hit.vaStart, to: hit.vaEnd }, hit.name, false);
  }
  if (!s) return;
  s.pinned = null;
  setPinnedHit(null);
  setDocActive(docTabs.indexOf(s));
  const b = boundsOfRealm(ctxOf(s), s.realm);
  const target = Math.max(b.first, Math.min(b.last, line));
  await ensurePage(s, target);
  requestAnimationFrame(() => document.getElementById('L' + target)?.scrollIntoView({ block: 'center' }));
}

/**
 * 跳至的色帶：把 adb 行 [from, to] 塗上 `jumpHit`，並捲到起點。
 * `null` 清掉。呼叫端（xref 的大正藏引用）只需要給行號。
 */
export function markLineRange(from: number | null, to?: number): void {
  clearCharBand();          // 行色帶與字元色帶不並存
  setJumpRange(from, to);
  const band = jumpRange();
  (window as unknown as { __lastJumpBand?: unknown }).__lastJumpBand = band;
  const box = document.getElementById('docText') ?? document.getElementById('textBody');
  if (!box) return;
  box.querySelectorAll<HTMLElement>('.docLine').forEach((el) => {
    el.classList.toggle('jumpHit', inJumpRange(Number(el.id.slice(1))));
  });
  if (band) {
    requestAnimationFrame(() =>
      document.getElementById('L' + band.from)?.scrollIntoView({ block: 'center' }));
  }
}

// ---------------------------------------------------------------- 字元級色帶（2026-10-30）
/**
 * 「跳至」貼上字元級位置（`db?頁 j=a-b`）時，只塗那幾個字。
 *
 * 用 CSS Custom Highlight（`::highlight(accelonCharBand)`）而不是包 `<mark>`：
 * 本文會重畫，包節點會把重畫弄壞；Highlight 只拿著一個 Range，重畫時清掉就好。
 */
const CHAR_BAND = 'accelonCharBand';

export interface CharBand {
  fromLine: number; fromHan: number; toLine: number; toHan: number;
}

type HighlightCtor = new (...ranges: Range[]) => unknown;
type HighlightRegistry = { set(name: string, h: unknown): void; delete(name: string): void; get(name: string): unknown };

function highlightApi(): { registry: HighlightRegistry; ctor: HighlightCtor } | null {
  const g = globalThis as unknown as { CSS?: { highlights?: HighlightRegistry }; Highlight?: HighlightCtor };
  if (g.CSS?.highlights && g.Highlight) return { registry: g.CSS.highlights, ctor: g.Highlight };
  return null;
}

/** 這一行第 k 個漢字之前的 DOM 位置；k 等於總數時回最後一個漢字之後。 */
function domPosInLine(el: HTMLElement, k: number, after = false): { node: Node; offset: number } | null {
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let count = 0;
  let last: { node: Node; offset: number } | null = null;
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const s = n.nodeValue ?? '';
    // 逐 code point 走（代理對算一個字），但回傳的 offset 仍是 code unit 索引。
    for (let i = 0; i < s.length; ) {
      const cp = s.codePointAt(i)!;
      const ch = String.fromCodePoint(cp);
      const width = cp > 0xffff ? 2 : 1;
      if (isHan(ch)) {
        // after=true：回傳「這個漢字之後」的位置（給色帶終點，含最後一個字；作者 2026-10-31）
        if (count === k) return { node: n, offset: after ? i + width : i };
        count++;
        last = { node: n, offset: i + width };
      }
      i += width;
    }
  }
  return k >= count ? last : null;
}

export function clearCharBand(): void {
  highlightApi()?.registry.delete(CHAR_BAND);
  (window as unknown as { __lastCharBand?: unknown }).__lastCharBand = null;
}

/* ------------------------------------------------- 選取區（作者 2026-11-01）
 *
 * 「閱讀狀態」匯出要記住**使用者選了哪一段**（回報問題時才定位得到）。選取的 DOM
 * 位置（節點＋offset）換一個執行環境就沒意義，所以存成「行號＋行內第幾個漢字」：
 * 和字元色帶（`CharBand`）同一套座標，`domPosInLine()` 已經能把它換回 DOM 位置。
 *
 * 約定：`fromHan` ＝ 起點前有幾個漢字（0-based，指向第一個被選的字）；
 * `toHan` ＝ **最後一個被選的漢字索引**（含），與 `domPosInLine(..., after=true)`
 * 的語意一致（那裡傳的是要「含進去」的那個字）。
 */
export interface DocSelection {
  fromLine: number;
  fromHan: number;
  toLine: number;
  toHan: number;
  /** 選到的文字（原樣） */
  text: string;
  /** 起點那一行的文字（人看／核對用；太長會截斷） */
  fromText?: string;
  /**
   * 同一行時的**字元位移**（在該行 `.lineText` 的文字裡，0-based）。
   * 比漢字索引精確：漢字索引會把選取邊界的標點（。、，）丟掉，這裡不會。
   * 只有 `fromLine === toLine` 才有意義；還原時先試這個，對不上才退回漢字索引。
   */
  fromCode?: number;
  toCode?: number;
}

/** 一行裡的所有文字節點，以及它們在「整行文字」中的 code-unit 起點 */
function lineRuns(el: HTMLElement): { node: Text; start: number }[] {
  const out: { node: Text; start: number }[] = [];
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let at = 0;
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    out.push({ node: n as Text, start: at });
    at += (n.nodeValue ?? '').length;
  }
  return out;
}

/** (節點, offset) → 這一行裡的「字元位移」與「前面有幾個漢字」 */
function pointOf(el: HTMLElement, node: Node, offset: number): { code: number; han: number } {
  const runs = lineRuns(el);
  const text = runs.map((r) => r.node.nodeValue ?? '').join('');
  let code = -1;
  for (const r of runs) if (r.node === node) { code = r.start + offset; break; }
  if (code < 0) {
    // 端點不是文字節點（整行被選、或選在 element 邊界）：用 Range 量字數
    const r = document.createRange();
    try {
      r.selectNodeContents(el);
      r.setEnd(node, offset);
      code = r.toString().length;
    } catch {
      code = 0;
    }
  }
  const cut = Math.max(0, Math.min(code, text.length));
  let han = 0;
  for (let i = 0; i < cut;) {
    const cp = text.codePointAt(i)!;
    if (isHan(String.fromCodePoint(cp))) han++;
    i += cp > 0xffff ? 2 : 1;
  }
  return { code: cut, han };
}

/** 字元位移 → DOM 位置（在該行的文字裡，0-based；給選取區精確還原用） */
function domPosAtCode(el: HTMLElement, code: number): { node: Node; offset: number } | null {
  const runs = lineRuns(el);
  if (!runs.length) return null;
  let at = 0;
  for (const r of runs) {
    const len = (r.node.nodeValue ?? '').length;
    if (code <= at + len) return { node: r.node, offset: Math.max(0, Math.min(len, code - at)) };
    at += len;
  }
  const last = runs[runs.length - 1];
  return { node: last.node, offset: (last.node.nodeValue ?? '').length };
}

/** 本文目前的選取（沒有選取、或選取不在本文區就回 null） */
export function captureDocSelection(): DocSelection | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  const root = document.getElementById('docText');
  if (!root || !root.contains(range.commonAncestorContainer)) return null;
  const startEl = lineElementOf(range.startContainer);
  if (!startEl) return null;
  const endEl = lineElementOf(range.endContainer) ?? startEl;
  const fromLine = Number(startEl.id.slice(1));
  const toLine = Number(endEl.id.slice(1));
  if (!Number.isFinite(fromLine) || !Number.isFinite(toLine)) return null;
  const from = pointOf(startEl, range.startContainer, range.startOffset);
  const end = pointOf(endEl, range.endContainer, range.endOffset);
  // 終點是「結束位置之前有幾個漢字」，最後一個被選的字是它的前一個
  // （`toHan` 用「含進去」的語意，和 domPosInLine(..., after=true) 一致）。
  const toHan = Math.max(from.han, end.han - 1);
  const fromText = (startEl.querySelector('.lineText')?.textContent ?? startEl.textContent ?? '').slice(0, 120);
  return {
    fromLine, fromHan: from.han, toLine, toHan,
    text: range.toString(), fromText,
    // 同一行才有字元位移（跨行時 end 的位移是另一行的事，不能混用）
    ...(fromLine === toLine ? { fromCode: from.code, toCode: end.code } : {}),
  };
}

/** 把選取還原到「行號＋行內漢字」；回傳有沒有成功 */
export function applyDocSelection(sel: DocSelection, opts: { scroll?: boolean } = {}): boolean {
  const fromEl = document.getElementById('L' + sel.fromLine);
  if (!fromEl) return false;
  const toEl = document.getElementById('L' + sel.toLine) ?? fromEl;
  // 先試「同一行的字元位移」（精確，連標點都對）；不行才退回漢字索引。
  let a: { node: Node; offset: number } | null = null;
  let b: { node: Node; offset: number } | null = null;
  if (sel.fromLine === sel.toLine && Number.isFinite(sel.fromCode) && Number.isFinite(sel.toCode)) {
    const ca = domPosAtCode(fromEl, Number(sel.fromCode));
    const cb = domPosAtCode(fromEl, Number(sel.toCode));
    if (ca && cb) {
      // 驗一下：這一行的這段文字要和存下來的完全一樣，否則就是行變了 → 退回漢字索引
      const probe = document.createRange();
      try {
        probe.setStart(ca.node, ca.offset);
        probe.setEnd(cb.node, cb.offset);
        if (probe.toString() === sel.text) { a = ca; b = cb; }
      } catch { /* 用下面的漢字索引 */ }
    }
  }
  if (!a || !b) {
    a = domPosInLine(fromEl, Math.max(0, sel.fromHan));
    b = domPosInLine(toEl, Math.max(0, sel.toHan), true) ?? a;
  }
  if (!a || !b) return false;
  const range = document.createRange();
  try {
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset);
  } catch {
    return false;
  }
  const s = window.getSelection();
  s?.removeAllRanges();
  s?.addRange(range);
  if (opts.scroll !== false) {
    const el = a.node.nodeType === 1 ? (a.node as Element) : a.node.parentElement;
    el?.closest?.('.docLine')?.scrollIntoView({ block: 'center' });
  }
  return true;
}

/** 塗上字元級色帶（同一份文件只會有一條）；回傳實際塗到的文字。 */
export function highlightCharBand(band: CharBand): string {
  clearCharBand();
  const fromEl = document.getElementById('L' + band.fromLine);
  const toEl = document.getElementById('L' + band.toLine);
  if (!fromEl || !toEl) return '';
  const a = domPosInLine(fromEl, Math.max(0, band.fromHan));
  const b = domPosInLine(toEl, Math.max(band.fromHan, band.toHan), true);
  if (!a || !b) return '';
  const range = document.createRange();
  try {
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset);
  } catch {
    return '';
  }
  const text = range.toString();
  const api = highlightApi();
  if (api) api.registry.set(CHAR_BAND, new api.ctor(range));
  else {
    // 沒有 Custom Highlight（很舊的 WebView）：退回原生選取，至少看得到
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }
  (window as unknown as { __lastCharBand?: unknown }).__lastCharBand = { ...band, text };
  const el = a.node.nodeType === 1 ? (a.node as Element) : a.node.parentElement;
  requestAnimationFrame(() => el?.closest?.('.docLine')?.scrollIntoView({ block: 'center' }));
  return text;
}

/** the whole-database realm (used when no document row owns the VA) */
function wholeRealm(ctx: DocCtx | null = activeDocCtx()): { from: number; to: number } {
  return { from: 0, to: ctx?.reader?.header.maxBlockOffset ?? 0 };
}

/** the `<檔>` that owns a VA (single-file databases have none → one whole doc) */
function docOfVa(ctx: DocCtx | null, va: number): DocRow {
  const list = ctx?.docs ?? [];
  const i = list.findIndex((d) => va >= d.vaStart && va < d.vaEnd);
  if (i >= 0) return list[i];
  // A VA can drift a few units past the end of its `<檔>` (fgdict does at every
  // file boundary), so fall back to the nearest document that starts before it —
  // better than a synthetic whole-database row whose line count disagrees with
  // the line table.
  let best = -1;
  for (let k = 0; k < list.length; k++) {
    if (list[k].vaStart <= va && (best < 0 || list[k].vaStart > list[best].vaStart)) best = k;
  }
  if (best >= 0) return list[best];
  const rd = ctx?.reader;
  return { i: -1, name: rd?.header.dbname ?? '', vaStart: 0, vaEnd: rd?.header.maxBlockOffset ?? 0 };
}

/** scroll the 文件 pane to the row of a VA (no content change) */
function scrollToVa(ctx: DocCtx | null, va: number): void {
  const mp = ctx?.mapper;
  if (!mp) return;
  document.getElementById('L' + mp.edgeLine(va))?.scrollIntoView({ block: 'center' });
}

/** first line index whose end is at or past `va` */
function edgeLine(ctx: DocCtx | null, va: number): number {
  return ctx?.mapper ? ctx.mapper.edgeLine(va) : 0;
}

/**
 * First line index inside a realm. A heading's VA is its own tag, so its line
 * ends at (or before) that VA: when the edge line ends exactly at the realm
 * start, the realm really begins on the NEXT line.
 */
function realmFirstLine(ctx: DocCtx | null, realm: { from: number; to: number }): number {
  return ctx?.mapper ? ctx.mapper.lineOfVa(realm.from) : 0;
}

/** last line of a realm: the last line that STARTS before the realm ends */
function realmLastLine(ctx: DocCtx | null, realm: { from: number; to: number }, first: number): number {
  const mp = ctx?.mapper;
  const v = mp?.linesVirtual ?? [];
  if (!mp || !v.length) return first;
  const cut = edgeLine(ctx, Math.max(realm.from, realm.to - 1));
  if (cut < first) return first;
  // a line whose VA equals the realm end belongs to the NEXT realm
  const at = mp.lineStartOf(cut);
  return v[cut] >= realm.to && at >= realm.to && cut > first ? cut - 1 : cut;
}

/**
 * 頁界快取。key **一定要帶 dbId**（作者 2026-11-01）：不同庫會有相同的
 * `from:to`，只用 realm 當 key 會互相污染，跨庫分頁就會拿到別庫的頁數。
 */
const boundsCache = new Map<string, { first: number; last: number }>();

const realmKey = (realm: { from: number; to: number }): string => realm.from + ':' + realm.to;

const boundsKey = (ctx: DocCtx | null, realm: { from: number; to: number }): string =>
  (ctx?.dbId ?? 0) + ':' + realmKey(realm);

/** the inclusive line range of a realm, plus its page count */
function boundsOfRealm(ctx: DocCtx | null, realm: { from: number; to: number }): { first: number; last: number; total: number; pages: number } {
  const key = boundsKey(ctx, realm);
  let b = boundsCache.get(key);
  if (!b) {
    const first = realmFirstLine(ctx, realm);
    b = { first, last: realmLastLine(ctx, realm, first) };
    boundsCache.set(key, b);
  }
  const total = Math.max(0, b.last - b.first + 1);
  return { first: b.first, last: b.last, total, pages: Math.max(1, Math.ceil(total / PAGE_LINES)) };
}

/** the line range of one page of a realm (0-based page) */
function pageBounds(ctx: DocCtx | null, realm: { from: number; to: number }, page: number): { first: number; last: number; total: number; pages: number } {
  const b = boundsOfRealm(ctx, realm);
  const p = Math.max(0, Math.min(page, b.pages - 1));
  const first = Math.min(b.last, b.first + p * PAGE_LINES);
  const last = Math.min(b.last, first + PAGE_LINES - 1);
  return { first, last, total: b.total, pages: b.pages };
}

/** the page of a realm that contains a line (used to follow a hit) */
function pageOfLine(ctx: DocCtx | null, realm: { from: number; to: number }, line: number): number {
  const b = boundsOfRealm(ctx, realm);
  if (line <= b.first) return 0;
  return Math.max(0, Math.min(b.pages - 1, Math.floor((line - b.first) / PAGE_LINES)));
}

/**
 * 這個 realm 是不是整本（`<檔>`）？連續閱讀與搜尋結果分頁都是整本；
 * 只有整本視窗才把頁尾補到段落結束（節點視窗的邊界是節點本身，不能越界）。
 */
function isWholeDocRealm(ctx: DocCtx | null, realm: { from: number; to: number }): boolean {
  if (!ctx) return false;
  const doc = docOfVa(ctx, realm.from);
  return !!doc && doc.vaEnd > doc.vaStart && realm.from <= doc.vaStart && realm.to >= doc.vaEnd;
}

/** 行末是不是段落結束：句號／括號／問號，或這一行自己帶 `<段/>`（換段） */
const PARA_END_RE = /[。．.!?！？…」』】〕〉》）\]]$/;
function lineEndsParagraph(raw: string): boolean {
  if (!raw) return true;
  if (raw.includes('<段/>') || raw.includes('<段>')) return true;
  const text = raw.replace(/<[^>]*>/g, '').trimEnd();
  if (!text) return true;
  return PARA_END_RE.test(text);
}

/**
 * 連續閱讀的頁尾（作者 2026-11-05）：第 200 行的行末不是句號／括號／問號時，往下多讀
 * 幾行，直到這一段結束（最多 40 行）——跨小條目複製才不會斷在半句話。
 */
async function pageEndAtParagraph(ctx: DocCtx, last: number, realmLast: number): Promise<number> {
  const mp = ctx.mapper;
  if (!mp) return last;
  const cap = Math.min(realmLast, last + 40);
  let end = last;
  while (end < cap) {
    if (lineEndsParagraph(await mp.lineText(end))) break;
    end++;
  }
  return end;
}

/**
 * 頁尾不要切在 `<表>`／`<圖文字>` 中間（作者 2026-11-06）：最後 40 行裡有沒收尾的
 * 表格區塊時，往下補到收標籤（最多 80 行）。太長（超過 80 行）就放棄，照原樣切。
 */
const BLOCK_OPEN_RE = /<(表|圖文字)(?=[\s>])/g;
const BLOCK_CLOSE_RE = /<\/(表|圖文字)>/g;
async function pageEndAtBlock(ctx: DocCtx, first: number, last: number, realmLast: number): Promise<number> {
  const mp = ctx.mapper;
  if (!mp) return last;
  let open = 0;
  for (let i = Math.max(first, last - 40); i <= last; i++) {
    const t = await mp.lineText(i);
    open += (t.match(BLOCK_OPEN_RE) ?? []).length - (t.match(BLOCK_CLOSE_RE) ?? []).length;
  }
  if (open <= 0) return last;
  const cap = Math.min(realmLast, last + 80);
  for (let end = last + 1; end <= cap; end++) {
    const t = await mp.lineText(end);
    open += (t.match(BLOCK_OPEN_RE) ?? []).length - (t.match(BLOCK_CLOSE_RE) ?? []).length;
    if (open <= 0) return end;
  }
  return last;
}

/** 「連續閱讀」要切到哪一種 realm：'doc'＝整本、'node'＝回到節點、null＝這庫不用切 */
function realmToggleTarget(ctx: DocCtx | null, realm: { from: number; to: number }, continuous = false): 'doc' | 'node' | null {
  if (!ctx?.mapper) return null;
  const doc = docOfVa(ctx, realm.from);
  if (!doc || doc.vaEnd <= doc.vaStart) return null;
  return continuous || isWholeDocRealm(ctx, realm) ? 'node' : 'doc';
}

/**
 * the session showing exactly this realm — **of the same database**.
 * 不同庫可能有完全相同的 realm，所以要比 dbId。
 */
function sessionForRealm(ctx: DocCtx | null, realm: { from: number; to: number }): DocSession | null {
  const id = ctx?.dbId ?? 0;
  return docTabs.find((t) => t.ctx?.dbId === id && t.realm.from === realm.from && t.realm.to === realm.to) ?? null;
}

/** find (or open) the tab for a realm. `fresh` forces a new tab. */
function sessionFor(ctx: DocCtx | null, realm: { from: number; to: number }, name: string, fresh = false): DocSession {
  const use = ctx ?? activeDocCtx();
  if (!fresh) {
    const same = sessionForRealm(use, realm);
    if (same) return same;
  }
  if (!use) throw new Error('sessionFor：沒有開啟任何 adb');
  const s: DocSession = {
    id: ++docSeq, realm, name, page: 0, doc: docOfVa(use, realm.from), ctx: use, pinned: null, cache: null,
  };
  docTabs.push(s);
  return s;
}

/**
 * Read one page of a session's realm. The VA range passed to `docText` is the
 * realm itself, so its `total` is the node's own line count while only one page
 * is ever rendered.
 */
async function fetchPage(ctx: DocCtx | null, pageFirst: number, pageLast: number): Promise<Awaited<ReturnType<VaPaMapper['docText']>>> {
  const mp = ctx?.mapper;
  const rd = ctx?.reader;
  if (!mp || !rd) throw new Error('fetchPage：沒有開啟任何 adb');
  const first = Math.max(0, pageFirst);
  const last = Math.max(first, pageLast);
  // The VA span is derived from the PAGE's lines, not from a `<檔>`: a directory
  // node may span several files (yinshun's 書 do), and passing one file's range
  // would clamp the page to a single line.
  const v = mp.linesVirtual;
  const vaStart = first > 0 ? (v[first - 1] ?? 0) : 0;
  const vaEnd = (v[last] ?? rd.header.maxBlockOffset) + 1;
  return mp.docText(vaStart, vaEnd, last - first + 1, undefined, { first, last });
}

/**
 * Make sure the DOM holds the page that contains `targetLine` (or the session's
 * current page) and render it. The returned `auto` is true when the page had to
 * move to follow a hit.
 */
async function ensurePage(s: DocSession, targetLine?: number): Promise<{ auto: boolean; ms: number }> {
  const ctx = ctxOf(s);
  if (!ctx?.mapper) return { auto: false, ms: 0 };
  let auto = false;
  if (targetLine !== undefined && targetLine >= 0) {
    const p = pageOfLine(ctx, s.realm, targetLine);
    if (p !== s.page) { s.page = p; auto = true; }
  }
  const b = pageBounds(ctx, s.realm, s.page);
  s.page = Math.max(0, Math.min(s.page, b.pages - 1));
  // 連續閱讀（或整本視窗）的頁尾補到段落結束（作者 2026-11-05）：不然第 200 行可能斷在
  // 半句話，跨小條目複製就會少一截。只在整本視窗做，節點視窗的邊界是節點本身。
  const whole = s.continuous || isWholeDocRealm(ctx, s.realm);
  const realmLast = boundsOfRealm(ctx, s.realm).last;
  // 往下滾過頁底時，把渲染窗口多接幾頁（見 DocSession.win）
  const winLast = Math.min(b.last + (s.win ?? 0) * PAGE_LINES, realmLast);
  const lastPara = whole
    ? await pageEndAtParagraph(ctx, winLast, realmLast)
    : winLast;
  // 表格區塊整塊留在同一頁（作者 2026-11-06）
  const last = await pageEndAtBlock(ctx, b.first, lastPara, realmLast);
  // page (or tab/db) changed: keep what the user typed, then leave edit mode;
  // the target page auto-enters edit mode below if it already has a revision.
  if (activeEditor && (activeEditor.s !== s || activeEditor.first !== b.first || activeEditor.last !== last)) {
    stageActiveEditor();
    s.editing = false;
    s.autoEdit = true;
  }
  const key = s.doc.i + ':' + b.first + '-' + last;
  const t0 = performance.now();
  if (!s.cache || s.cache.key !== key) {
    const dt = await fetchPage(ctx, b.first, last);
    s.cache = { page: s.page, dt, key, bounds: { ...b, last } };
  }
  // Following a hit: the mapper's line numbers and the rendered page can disagree
  // by a line at a document boundary (fgdict), so snap the pinned line ONTO the
  // page it was followed to. This must NOT happen when the reader turns a page —
  // otherwise paging away from the pinned hit would drag the pane straight back.
  const dtNow = s.cache.dt;
  const rr = pageRangeOf(dtNow);
  const es = editSessionOf(ctx);
  if (!s.history && editAllowed() && !s.editing && s.autoEdit !== false && es && pageEditAt(es, rr.first, rr.last)) s.editing = true;
  const nums = dtNow.lineNumbers;
  if (targetLine !== undefined && s.pinned && nums.length) {
    if (s.pinned.line < nums[0]) s.pinned.line = nums[0];
    else if (s.pinned.line > nums[nums.length - 1]) s.pinned.line = nums[nums.length - 1];
  }
  // `<圖>` 要用的圖檔先解成 blob URL（渲染是同步的，見 resolvePageImages）
  await resolvePageImages(ctx, dtNow.lines);
  renderDoc(s);
  setupGrowOnScroll();
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
 *   * 每一層最多取 **N 個字**（設定頁「路徑字數」，預設 6；0＝不限）
 *
 * 完整標籤仍留在 `title` 與下拉選單裡（下拉不節略）。
 */
const TRAIL_SEP = /[\s\u3000、，。：；·｜|／/\-—–_~]+/;

/** 同層節點超過這個數量就改成下拉（作者 2026-10-18）：像「書」那一層有上百本，
 *  全部排成晶片會把本文整個擠掉。 */
const MAX_INLINE_SIBS = 5;

/** breadcrumb 的顏色：標籤樣式有自訂就用它，否則用主題的 tag 字色（作者 2026-10-22） */
const trailColor = (tag: string, depth: number, label?: string): string =>
  tagColorOf(tag) ?? `var(--tag-text-${tagChromaIndex(tag, depth, undefined, label)})`;

/**
 * breadcrumb 每層最多幾個字（作者 2026-10-31；fuyan 的節點名很長）。
 * 設 0＝不限。完整名稱仍留在 hover 的 title 與下拉選單（下拉不節略）。
 */
const TRAIL_MAX_KEY = 'accelon26.trailMax';

function readTrailMax(): number {
  try {
    const v = Number(localStorage.getItem(TRAIL_MAX_KEY));
    if (Number.isFinite(v) && v >= 0) return Math.trunc(v);
  } catch { /* 私密模式 */ }
  return 6;
}

let trailMax = readTrailMax();

export function trailMaxOf(): number {
  return trailMax;
}

export function setTrailMax(n: number): void {
  trailMax = Math.max(0, Math.trunc(n) || 0);
  try { localStorage.setItem(TRAIL_MAX_KEY, String(trailMax)); } catch { /* 私密模式 */ }
  rerenderDoc();
}

export function trailLabel(text: string): string {
  const full = (text ?? '').trim();
  if (!full) return '';
  const head = full.split(TRAIL_SEP).map((p) => p.trim()).find((p) => p.length > 0) ?? '';
  const base = head || full;
  const chars = [...base];
  if (!trailMax || chars.length <= trailMax) return base;
  return chars.slice(0, trailMax).join('') + '…';
}

/**
 * breadcrumb 要從哪一個 VA 往上找祖先（作者 2026-10-29；2026-11-01 修）。
 *
 * 由目錄點進來時 `realm` 就是那個節點、`pinned.va` 也是它，兩者相同。
 * 由摘要／全文／聯跳進來時 `realm` 是整個 `<檔>`（這樣才能繼續往下讀），
 * 只看 `realm.from` 就會永遠停在「書」那一層——要改看**命中所在的 VA**，
 * 才會出現「書 › 章 › 節」與目前那一節的兄弟。
 *
 * **命中的那一行不一定在這一頁**：13j 沒有 `<檔>`，realm 是整個庫，往後翻幾頁
 * 就到別章了。那時麵包屑要跟著**畫面上這一頁**，否則會出現「麵包屑說乾、本文是
 * 繫辭下」（作者 2026-11-01 回報「切換 adb／頁籤時 breadcrumb 與本文不一致」——
 * 切頁籤會重畫，把不一致一起帶回來，所以看起來「時好時壞、無法重複」）。
 * 因此呼叫端會把這一頁的 VA 傳進來（`anchorVa`）。
 */
function trailAnchor(s: DocSession, anchorVa?: number): number {
  if (typeof anchorVa === 'number') return anchorVa;
  return typeof s.pinned?.va === 'number' ? s.pinned.va : s.realm.from;
}

/**
 * 跨庫分頁的提示條（作者 2026-11-01）：本文屬於別的 adb 時不畫麵包屑。
 *
 * 麵包屑、目錄游標、反鏈全部取自**左欄那一庫**的目錄樹與 `<頁>`；拿別庫的 VA
 * 去查只會得到錯的節點。所以這裡改成一句提示，並提供「切到該庫的目錄」的按鈕
 * （＝按 header 的 🌲，走同一條路，不另外發明切庫邏輯）。
 */
function foreignTrailBar(s: DocSession): string {
  const ctx = ctxOf(s);
  if (!ctx) return '';
  const name = escapeHtml(ctx.dbCName || ctx.dbName || '別的庫');
  const db = escapeHtml(ctx.dbName || '');
  return '<nav class="docTrail docTrailForeign" id="docTrail" aria-label="本文來源">'
    + '<span class="trailForeign" title="' + (db ? leftArrowTitle(db) : '') + '">本文來自 '
    + '<b>' + name + '</b></span>'
    + '<button type="button" class="mini trailForeignGo" id="docTrailReveal"'
    + ' title="把 adb 切到「' + name + '」，並在目錄中展開目前位置（同 header 的 🌲）">🌲 到它的目錄</button>'
    + '</nav>';
}

const leftArrowTitle = (db: string): string => db + '：左欄的目錄與摘要仍屬於目前的 adb';

function renderAncestorTrail(s: DocSession, anchorVa?: number): string {
  // 跨庫分頁：路徑屬於左欄那一庫，不畫（改成提示條）
  if (!ownsActiveDb(s)) return foreignTrailBar(s);
  const anchor = trailAnchor(s, anchorVa);
  const anc = ancestorTrail(anchor);
  const self = currentNodeAt(anchor);
  const items = anc.map((a) => {
    const full = escapeHtml(a.label);
    const short = escapeHtml(trailLabel(a.label));
    return `<span class="trailWrap" data-va="${a.va}">`
      + `<button type="button" class="trail" data-va="${a.va}" data-tag="${escapeHtml(a.tag)}"`
      + ` title="「${full}」：點一下換同一層的其他節點"`
      + ` style="--tagtext:${trailColor(a.tag, a.depth, a.label)}">${short}<span class="trailCaret">▾</span></button>`
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
        + ` style="--tagtext:${trailColor(self.tag, self.depth, self.label)}">${short}<span class="trailCaret">▾</span></button>`
        + `</span></span>`;
    } else {
      sibHtml = '<span class="trailSibs">' + sibs.map((n) => {
        const full = escapeHtml(n.label);
        const short = escapeHtml(trailLabel(n.label));
        const style = `--tagtext:${trailColor(n.tag, n.depth, n.label)}`;
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

/**
 * 圖上自己帶注號時，圖前那一列「只有 [13][14]…」的注號要收起來（厚觀法師 2026-11-12）。
 *
 * 05B 的表格是另一份〈圖表文檔〉做的，那份的腳註參照在「摘出來另存」時斷了，
 * 所以注號不在圖上、只在正文裡排成一列疊在圖的上方。補回圖上之後（見
 * `src/patch_fig_note_marks.py`），那一列就重複了。
 *
 * 只收「整列只有注號」而且「下一塊是**自己帶注號**的圖」——別本書的圖沒有注號，
 * 照舊顯示，不會把讀者唯一的入口吃掉。
 */
/**
 * 圖前那行 `[13][14]…` 要不要收起來。
 *
 * 厚觀法師 2026-11-12 15:07 第 3 項曾要求「本文中的腳註序號 13-16 也要顯示出來」，
 * 當時那批號還沒畫到圖上（資料有、畫面沒有），所以那行是唯一入口，改成一律顯示。
 *
 * 22:13 第一項他問：「〔圖表 35-36〕表格內已經有 13-17 的腳註了，表格上方的〔13〕
 * 至〔17〕還要重複放嗎？」——號已經回到圖上，那一列就是重複了（還佔了五行高度）。
 * 所以判準改成：**圖上（svg 的 data-note）涵蓋這一列全部的號 → 收起**；
 * 圖上沒有號的照舊顯示，不會把讀者唯一的入口吃掉。
 */
function noteRowsToHide(blocks: RenderBlock[]): Set<number> {
  const out = new Set<number>();
  for (let i = 0; i + 1 < blocks.length; i++) {
    const a = blocks[i];
    const b = blocks[i + 1];
    if (a.kind !== 'line' || a.lines.length !== 1 || b.kind === 'table') continue;
    const line = a.lines[0];
    if (!/<a class="noteRef"/.test(line.html)) continue;
    const text = line.html.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]*>/g, '').replace(/[\s\u3000]/g, '');
    if (!/^(\[\d+\])+$/.test(text)) continue;
    const nums = Array.from(line.html.matchAll(/data-note="(\d+)"/g), (m) => m[1]);
    if (!nums.length) continue;
    const bHtml = b.lines.map((l) => l.html).join('');
    if (/<svg/.test(bHtml)) {
      const onFig = new Set(Array.from(bHtml.matchAll(/data-note="(\d+)"/g), (m) => m[1]));
      if (nums.every((n) => onFig.has(n))) out.add(line.no);
      continue;
    }
    if (!/class="noteRef"/.test(bHtml)) continue;
    out.add(line.no);
  }
  return out;
}

/** 把一頁的版面塊變成 HTML：保留硬換行＝每行一列；不保留＝整段連排 */
function renderBlocks(blocks: RenderBlock[], s: DocSession): string {
  const merged = noteRowsToHide(blocks);
  const mergedCls = (no: number) => (merged.has(no) ? ' noteRefsMerged' : '');

  return blocks.map((block) => {
    if (block.kind === 'table' && block.table) {
      return tableHtml(block.table, (no) => [
        s.pinned && no === s.pinned.line ? 'hitLine' : '',
        inJumpRange(no) ? 'jumpHit' : '',
      ].filter(Boolean).join(' '));
    }
    if (block.kind === 'pre') {
      return '<div class="figText">' + block.lines.map((l) => {
        const cls = 'docLine' + (s.pinned && l.no === s.pinned.line ? ' hitLine' : '') + (inJumpRange(l.no) ? ' jumpHit' : '');
        return '<div class="' + cls + '" id="L' + l.no + (l.idSuffix ?? '') + '" data-src="' + escapeHtml(l.raw) + '"' + (l.style ? ' style="' + escapeHtml(l.style) + '"' : '') + '>'
          + '<div class="lineText">' + l.html + '</div></div>';
      }).join('') + '</div>';
    }
    if (block.kind === 'line') {
      const l = block.lines[0];
      const cls = 'docLine' + mergedCls(l.no) + (l.cls ? ' ' + l.cls : '') + (s.pinned && l.no === s.pinned.line ? ' hitLine' : '') + (inJumpRange(l.no) ? ' jumpHit' : '');
      return '<div class="' + cls + '" id="L' + l.no + (l.idSuffix ?? '') + '" data-src="' + escapeHtml(l.raw) + '"' + (l.style ? ' style="' + escapeHtml(l.style) + '"' : '') + '>'
        + '<div class="lineText">' + l.html + '</div></div>';
    }
    const inner = block.lines.map((l, i) => {
      const cls = 'docLine' + mergedCls(l.no) + (l.cls ? ' ' + l.cls : '') + (s.pinned && l.no === s.pinned.line ? ' hitLine' : '') + (inJumpRange(l.no) ? ' jumpHit' : '');
      // 英文行接起來要留一個空白，中文不用（作者 2026-10：把硬換行去掉）
      const prev = i > 0 ? block.lines[i - 1].raw : '';
      const join = i > 0 && /[A-Za-z0-9]$/.test(prev) && /^[A-Za-z0-9]/.test(l.raw) ? ' ' : '';
      return join + '<span class="' + cls + '" id="L' + l.no + (l.idSuffix ?? '') + '" data-src="' + escapeHtml(l.raw) + '"' + (l.style ? ' style="' + escapeHtml(l.style) + '"' : '') + '>'
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
  // 跨庫分頁的提示條：按鈕等於按 header 的 🌲（切庫＋展開目錄都在那裡）
  const go = document.getElementById('docTrailReveal');
  if (go) {
    go.onclick = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      (document.getElementById('treeReveal') as HTMLButtonElement | null)?.click();
    };
    return;
  }
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
        item.style.setProperty('--tagtext', trailColor(n.tag, n.depth, n.label));
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
  /** 大型 adb：只看原始文件，不能暫存 */
  readOnly: boolean;
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
  /**
   * 捲動位置與選取區（作者 2026-11-01）。
   *
   * **只在離開 exe 之前寫一次**（`saveLastReadNow({ view: true })`）：平時重畫／切頁
   * 只更新上面幾個欄位，不會覆蓋這兩個（除非換了頁或換了節點，那時它們已經失效）。
   * 選取區用「行號＋行內第幾個漢字」，跨執行環境也認得。
   */
  scrollTop?: number;
  sel?: DocSelection | null;
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

/**
 * Save the active document tab + page. Safe to call often.
 *
 * `opts.view`（作者 2026-11-01）：連**捲動位置與選取區**一起存 —— 只有「離開 exe 之前」
 * 才這樣呼叫（`beforeunload`／Wails 的 WindowClosing），平時不要一直寫。
 * 不帶 `view` 時反過來要**保留**上一次存下來的 view，但只有「頁與節點都沒變」才保留
 * （換頁／換節點之後那個捲動位置與選取區已經沒有意義）。
 */
export function saveLastReadNow(opts: { view?: boolean } = {}): void {
  const s = docSession();
  // 閱讀位置是「每個檔案」的，所以要用分頁自己那一庫的檔（跨庫分頁不會寫錯庫）
  const ctx = ctxOf(s);
  const src = ctx?.file ?? null;
  if (!s || !src || s.history) return;
  try {
    const b = pageBounds(ctx, s.realm, s.page);
    const map = readLastRead();
    const key = lastReadKey(src);
    const prev = map[key];
    // 沒帶 view 時：只保留「同一頁、同一節點」的舊 view（換頁／換節點就不再生效）
    const keepView = !!prev && prev.page === s.page && prev.from === s.realm.from && prev.to === s.realm.to;
    map[key] = {
      name: s.name,
      from: s.realm.from,
      to: s.realm.to,
      page: s.page,
      line: b.first,
      at: Date.now(),
      ...(opts.view
        ? {
          scrollTop: document.querySelector<HTMLElement>('#docText .docBody')?.scrollTop ?? 0,
          sel: captureDocSelection(),
        }
        : keepView ? { scrollTop: prev.scrollTop, sel: prev.sel } : {}),
    };
    writeLastRead(map);
  } catch { /* 不要讓閱讀位置影響本文 */ }
}

/** Restore the last tab/page of this exact file (name + size), if any. */
export async function restoreLastRead(file: { name: string; size: number }): Promise<boolean> {
  const ctx = activeDocCtx();
  if (!ctx || docTabs.length) return false;
  const rec = readLastRead()[lastReadKey(file)];
  if (!rec) return false;
  const max = ctx.reader.header.maxBlockOffset || 0;
  if (!(Number.isFinite(rec.from) && Number.isFinite(rec.to) && rec.from >= 0 && rec.to > rec.from && rec.from <= max + 1)) return false;
  try {
    const s = sessionFor(ctx, { from: rec.from, to: rec.to }, rec.name || file.name);
    s.page = Math.max(0, Number(rec.page) || 0);
    s.autoEdit = true;
    docActive = docTabs.indexOf(s);
    setPinnedHit(null);
    // 先排好「要還原的捲動位置與選取區」，ensurePage → renderDoc 會用它
    // （paintHit 也會因為它而不再自己捲到釘選那一行）。
    if (typeof rec.scrollTop === 'number' || rec.sel) {
      pendingView = { scrollTop: typeof rec.scrollTop === 'number' ? rec.scrollTop : undefined, sel: rec.sel ?? undefined };
    }
    await ensurePage(s, Number.isFinite(rec.line) ? rec.line : undefined);
    paintTreeActive();
    return true;
  } catch {
    pendingView = null;
    return false;
  }
}



/** 進入編輯前在本文選取的文字（用來把 caret／選取區捲進視窗）。
 *  `hasSelection`：true＝有選取區（進編輯後選中同一段）；false＝只有「視窗中線那行」
 *  （進編輯後大致捲到那裡、不選取，作者 2026-11-10）。 */
let pendingDocSelection: { startLine: number; endLine: number; text: string; startText: string; hasSelection: boolean } | null = null;
let pendingSelectionUse = false;


function lineElementOf(node: Node | null): HTMLElement | null {
  const el = node && node.nodeType === 1 ? (node as Element) : (node?.parentElement ?? null);
  return (el?.closest?.('.docLine[id^="L"]') as HTMLElement | null) ?? null;
}

/** 目前本文「視窗中線」那一行（`syncCursorFromScroll` 同一套中線規則）。
 *  中線落在內容之後（頁面很短）時，退回最後一行。 */
function midlineLine(): number {
  const body = document.querySelector<HTMLElement>('#docText .docBody');
  if (!body) return -1;
  const rows = [...body.querySelectorAll<HTMLElement>('.docLine[id^="L"]')];
  if (!rows.length) return -1;
  const mid = body.scrollTop + body.clientHeight / 2;
  let last = -1;
  for (const row of rows) {
    const top = row.offsetTop;
    const n = Number(/^L(\d+)/.exec(row.id)?.[1]);
    if (!Number.isFinite(n)) continue;
    last = n;
    if (top <= mid && mid < top + row.offsetHeight) return n;
  }
  // 中線在所有行之後（短頁）：退回最後一行
  return last;
}

/** 記住本文目前的選取（在按鉛筆之前），不用在 click 之後才抓（那時已經收合）。
 *  沒有選取區時，退而記住「視窗中線那行」，進編輯後大致捲到那裡（作者 2026-11-10）。 */
export function rememberDocSelection(): void {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
    // 無選取：只記中線行當錨點，方便進編輯後大致定位
    const mid = midlineLine();
    if (mid > 0) pendingDocSelection = { startLine: mid, endLine: mid, text: '', startText: '', hasSelection: false };
    return;
  }
  const range = sel.getRangeAt(0);
  const root = document.getElementById('docText');
  if (!root || !root.contains(range.commonAncestorContainer)) return;
  const startEl = lineElementOf(range.startContainer);
  const endEl = lineElementOf(range.endContainer);
  if (!startEl || !startEl.id.startsWith('L')) return;
  const startLine = Number(startEl.id.slice(1));
  const endLine = endEl && endEl.id.startsWith('L') ? Number(endEl.id.slice(1)) : startLine;
  const startText = startEl.querySelector('.lineText')?.textContent ?? '';
  pendingDocSelection = { startLine, endLine, text: range.toString(), startText, hasSelection: true };
}

/** 把 CodeMirror 的 caret／選取移到剛剛在本文選取的那一行，並置中。
 *  有選取區→選中同一段文字；無選取→只把 caret 移到那一行開頭（大致定位），
 *  並提示可用選取區加快定位（作者 2026-11-10）。 */
function scrollEditorToSelection(view: any, pageLines: number[], sel: { startLine: number; text: string; startText: string; hasSelection: boolean }): void {
  const idx = pageLines.indexOf(sel.startLine);
  if (idx < 0) return;
  const doc = view.state.doc;
  const line = doc.line(Math.max(1, Math.min(doc.lines, idx + 1)));
  const raw = line.text;
  const CM = (globalThis as any).CM;
  const caretOnly = (at: number): void => {
    const caret = line.from + at;
    try {
      view.dispatch({ selection: { anchor: caret }, effects: CM.EditorView.scrollIntoView(caret, { y: 'center' }) });
    } catch {
      view.dispatch({ selection: { anchor: caret } });
    }
  };
  const first = (sel.text || '').split('\n')[0] || sel.startText || '';
  if (!sel.hasSelection || !first) {
    caretOnly(0);
    noticeEditor('已捲到該行；先選取本文一段再進編輯，可直接選中同一段文字，定位更快');
    return;
  }
  // 選取文字在閱讀模式是「渲染後的純文字」，但編輯器裡是原始 XML（夾 <粗> 等標記），
  // 直接 indexOf 會落空。做法：剝掉整行標籤得純文字，用選取文字的前幾個漢字當錨點
  // 在純文字裡定位，再把純文字位置映射回原始位置（作者 2026-11-10）。
  const hanRun = first.replace(/[^\u3400-\u9fff\uf900-\ufaff]/g, '');
  const plain = raw.replace(/<[^>]*>/g, '').replace(/\s+/g, '');
  const rawAtOf = (plainPos: number): number => {
    // 原始字串裡第 plainPos 個「非標籤、非空白」字元的 index
    let k = 0, tag = false;
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      if (c === '<') tag = true;
      else if (c === '>') tag = false;
      else if (!tag && !/\s/.test(c)) {
        if (k === plainPos) return i;
        k++;
      }
    }
    return -1;
  };
  let at = -1;
  for (let n = Math.min(8, hanRun.length); n >= 2; n--) {
    const p = plain.indexOf(hanRun.slice(0, n));
    if (p >= 0) { at = rawAtOf(p); break; }
  }
  if (at < 0) {
    caretOnly(0);
    noticeEditor('已捲到該行（選取文字跨行或標記過密，未精確對位）；可選取本行內一段再試');
    return;
  }
  // 選取跨度：從 anchor 起，跨過 hanRun.length 個非標記字元（含中間夾的標記）
  let head = raw.length;
  {
    let k = 0, tag = false;
    for (let i = at; i < raw.length; i++) {
      const c = raw[i];
      if (c === '<') tag = true;
      else if (c === '>') tag = false;
      else if (!tag && !/\s/.test(c)) {
        k++;
        if (k >= hanRun.length) { head = i + 1; break; }
      }
    }
  }
  const anchor = line.from + at;
  const headPos = line.from + Math.min(head, raw.length);
  try {
    view.dispatch({ selection: { anchor, head: headPos }, effects: CM.EditorView.scrollIntoView(anchor, { y: 'center' }) });
  } catch {
    view.dispatch({ selection: { anchor, head: headPos } });
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

/** 大型 adb 的編輯上限（作者 2026-11-06：超過就只看原始文件，唯讀、不存檔） */
export const EDIT_SIZE_LIMIT = 50 * 1024 * 1024;

/** 這個分頁那一庫是不是「唯讀檢視」的大小 */
function isReadOnlyEdit(s: DocSession | null | undefined): boolean {
  if (!s) return false;
  const rd = ctxOf(s)?.reader;
  return !!rd && rd.header.size > EDIT_SIZE_LIMIT;
}

/**
 * 這個分頁所屬檔案的編輯工作階段。
 *
 * 編輯工作階段是**按檔案**開的，所以不能用全域的 `currentSource`：跨庫分頁
 * 要拿它自己那一庫的檔（作者 2026-11-01）。
 */
function editSessionOf(ctx?: DocCtx | null): DbEditSession | null {
  const c = ctx === undefined ? (ctxOf(docSession()) ?? activeDocCtx()) : ctx;
  if (!c?.file) return null;
  return editSessionFor(c.file, c.fileName || c.file.name);
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
    const readOnly = isReadOnlyEdit(s);
    btn.classList.toggle('on', on);
    btn.classList.toggle('readonly', readOnly);
    btn.title = readOnly
      ? (on ? '關閉唯讀的原始文件' : '唯讀檢視原始文件（adb 超過 50 MB，不能存檔）')
      : !getUserId()
        ? '請先在「關於」設定修訂者 ID'
        : (on ? '完成編輯（內容已自動暫存）' : '編輯這一頁（修錯字；離開會自動暫存）');
    btn.setAttribute('aria-label', readOnly ? '唯讀檢視原始文件' : (on ? '完成編輯' : '編輯這一頁'));
  }
  const toggle = document.getElementById('diffToggle') as HTMLElement | null;
  const box = document.getElementById('showDiff') as HTMLInputElement | null;
  let has = false;
  const dt = s?.cache?.dt;
  if (s && dt && !s.editing) {
    const es = editSessionOf(ctxOf(s));
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
  if (!a || a.readOnly) return;
  const es = editSessionOf(ctxOf(a.s));
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
  // 修訂歷史是「左欄那一庫」的功能（歷史清單由它的 rev-list 產生）
  const ctx = ctxOf(docSession()) ?? activeDocCtx();
  if (!ctx?.mapper || !ctx.reader) return;
  const p = detail.page ?? {};
  const first = Math.max(0, Number(p.first) || 0);
  const last = Math.max(first, Number(p.last) || first);
  const v = ctx.mapper.linesVirtual;
  const va = first > 0 ? (v[first - 1] ?? 0) + 1 : 0;
  const doc = docOfVa(ctx, va);
  const realm = { from: doc.vaStart, to: doc.vaEnd || ctx.reader.header.maxBlockOffset };
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
  const s = sessionFor(ctx, realm, label, true);
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

// 精讀模式切換時重畫正文（發自 reading-pane.ts，避免互相 import）
window.addEventListener('accelon26:rerender', () => {
  const s = docSession();
  if (s) renderDoc(s);
 });

export function enterEdit(s: DocSession, fromSelection = false): void {
  if (s.history) {
    setStatus('歷史版本只能檢視，不能編輯', 'err');
    return;
  }
  if (!document.body.classList.contains('advanced')) {
    setStatus('請先開啟進階模式才能編輯', 'err');
    return;
  }
  if (!s || !s.cache?.dt) return;
  // 超過 50 MB：仍然進編輯模式看原始文件，但只讀、不能暫存／存檔（作者 2026-11-06）
  const readOnly = isReadOnlyEdit(s);
  if (!readOnly && !getUserId()) {
    setStatus('請先在「關於」設定修訂者 ID，才能編輯', 'err');
    return;
  }
  if (!readOnly && s.cache.dt.lines.some((l) => l.includes('\n') || l.includes('\r'))) {
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
  if (readOnly) setStatus('這個 adb 超過 50 MB：唯讀檢視原始文件，不能存檔', 'info');
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
  const es = editSessionOf(ctxOf(s));
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
  const ctx = ctxOf(s);
  const readOnly = isReadOnlyEdit(s);
  const b = pageBounds(ctx, s.realm, s.page);
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
  const es = editSessionOf(ctx);
  const staged = es ? pageEditAt(es, r.first, r.last) : undefined;
  const lines = staged ? staged.newLines : dt.lines;
  $('#docText').innerHTML = '<div class="docTop">'
    + (isDictDb(ctx?.mapper ?? null)
      ? ''
      : '<div class="docHead docHeadEditing">' + escapeHtml(displayName(s.name))
        + '<span class="dim">第 ' + fmtInt(s.page + 1) + ' / ' + fmtInt(b.pages) + ' 頁 · 行 '
        + fmtInt(nFirst) + '–' + fmtInt(nLast) + ' · <b style="color:var(--gold)">'
        + (readOnly ? '唯讀原始文件（adb 超過 50 MB）' : '編輯中') + '</b></span></div>')
    + renderAncestorTrail(s)
    + '</div>'
    + '<div id="docEditor">'
    + '<div class="editBar">'
    + '<button type="button" class="mini" id="editDone" title="'
    + (readOnly ? '關閉原始文件檢視' : '完成這一頁（自動暫存）') + '">'
    + (readOnly ? '關閉' : '完成') + '</button>'
    + (readOnly ? '' : '<button type="button" class="mini" id="editCancel" title="丟掉這一頁的修改">取消本頁</button>')
    + (readOnly ? '<span class="editReadOnly">唯讀 · adb 超過 50 MB，不能存檔</span>' : '')
    + '<span class="editNotice" id="editNotice"></span></div>'
    + '<div class="cmHost" id="cmHost"></div>'
    + '</div>';
  renderDocTabs(s);
  renderPager(s, b);
  wireTrail();
  setEditControls(s);
  const host = document.getElementById('cmHost');
  if (!host) return;
  const ed = mountPageEditor(host, lines.slice(), { readOnly, onChange: scheduleStage, onNotice: noticeEditor });
  activeEditor = { ed, first: r.first, last: r.last, oldLines: dt.lines.slice(), s, key, docName: docNameOf(s), readOnly };
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
      if (readOnly) { noticeEditor('唯讀，不能存檔'); return; }
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
  const b = pageBounds(ctxOf(s), s.realm, s.page);
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
    + (isDictDb(ctxOf(s)?.mapper ?? null)
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

/** renderDoc 被要求畫「已經不是畫面上那一個」的分頁幾次（非同步競態診斷；應該是 0） */
let staleRenders = 0;

export const staleRenderCount = (): number => staleRenders;

/** 上一次 renderDoc 用的麵包屑錨點（VA）；診斷／測試用（`trailInfo()` 會讀它） */
let lastTrailVa = 0;
export const trailAnchorVa = (): number => lastTrailVa;

/** render one page: tab strip, header, rows, pager. */
function renderDoc(s: DocSession): void {
  const dt = s.cache?.dt;
  if (!dt) return;
  // 非同步競態：`ensurePage` 在 await 之前是 A 分頁，回來時使用者已經切到 B。
  // 用 A 的資料畫畫面會讓「分頁條／本文／麵包屑」對不起來（作者 2026-11-01 回報的
  // 「切換 adb／頁籤時不一致」之一）。不是畫面上那一頁就不要畫，記一次診斷。
  if (docTabs[docActive] !== s) { staleRenders++; return; }
  // 精讀模式（作者 2026-11-03）：正文區改掛唯讀 CodeMirror（ruby 在字上方），
  // 版面其餘部分（左欄目錄、右欄頁籤）照 accelon26 原樣，不另開覆蓋層。
  // 精讀模式（作者 2026-11-03）：正文區改掛唯讀 CodeMirror；不 import reading-pane
  // （ui → reading-pane → doc-pane 的循環會讓 boot 炸掉，改用 window 上的 hook）。
  if (document.body.classList.contains('reading')) {
    (window as unknown as { __readingMount?: (sel: string, lines: readonly string[]) => void }).__readingMount?.('#docText', dt.lines);
    return;
  }
  const ctx = ctxOf(s);
  // 「回到這個分頁時看的地方（捲動＋選取）」只給這一次渲染用；編輯／diff／歷史那幾條
  // 提早 return 的分支就用不到，直接丟掉（不要留給下一次別的渲染）。
  const want = pendingView;
  pendingView = null;
  const wantScrollTop = typeof want?.scrollTop === 'number' ? want.scrollTop : null;
  clearCharBand();          // 重畫就沒有那條字元色帶了（Range 指向舊節點）
  bindInlineImageZoom();
  bindLineTip();
  bindTanTips();
  if (s.editing && !isReadOnlyEdit(s) && !editAllowed()) s.editing = false;
  setEditControls(s);
  if (s.editing) { renderEditPage(s, dt); return; }
  if (s.history) { renderHistoryPage(s, dt); return; }
  const esNow = editSessionOf(ctx);
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
      svgText: svgTextOf,
      // tx／taixu 的舊資料：整張圖版用 `<圖 f>`、沒有 t="圖版"（見 render_accelon3）
      untaggedFigures: /^(tx|taixu)$/.test(ctx?.reader.header.dbname ?? ''),
      // 詞典型：`<字>`／`<詞>` 在連排模式要另起一段（作者 2026-11-06）
      dictEntries: isDictDb(ctx?.mapper ?? null),
      // 段首縮排：**由書稿的 `<集 c="noindent">` 決定，不看庫名**（作者 2026-11-14）。
      // 《福嚴講義》紙本正文頂格（厚觀法師 2026-11-14）、其他書照舊空兩格（陳裕文 2026-11-13）。
      indent: !isNoIndent(ctx?.mapper ?? null),
      termMode: termModeOf(),
    });
  const rows = renderBlocks(blocks, s);
  // 連續閱讀的頁尾可能補到段落結束（見 ensurePage），pager 的「行 a–b」要用實際那一頁。
  const b = s.cache?.bounds ?? pageBounds(ctx, s.realm, s.page);
  const nFirst = viewDt.lineNumbers[0] ?? 0;
  const nLast = viewDt.lineNumbers[viewDt.lineNumbers.length - 1] ?? 0;
  // 麵包屑跟著「這一頁」：釘選的那一行在這一頁就用它（點節點進來時才是那個節點），
  // 不在（往後翻過頁了）就用這一頁的第一行，否則會出現「麵包屑說乾、本文是繫辭下」。
  const trailVa = (() => {
    const pin = s.pinned;
    if (pin && typeof pin.va === 'number' && pin.line >= nFirst && pin.line <= nLast) return pin.va;
    const mp = ctx?.mapper;
    return mp && Number.isFinite(nFirst) ? (mp.linesVirtual[nFirst] ?? s.realm.from) : s.realm.from;
  })();
  lastTrailVa = trailVa;
  // 詞典型 adb 不顯示 docHead（作者 2026-10）：詞條名稱已經在分頁標題上，
  // 而第一個詞條字串通常就是命中、會被塗紅 —— 再放一次就變成同一個詞顯示三次。
  // 不再顯示 .docHead（作者 2026-10-31）：它有時出現、有時不出現（和分頁標籤同名時
  // 會省略），版面不穩定；完整標題改放在 docTabs 的 hover（title）。
  $('#docText').innerHTML = '<div class="docTop">'
    + renderAncestorTrail(s, trailVa)
    + '</div>'
    + '<div class="docBody' + (hardBreaks ? '' : ' reflow') + '">' + rows + '</div>';
  renderDocTabs(s);
  renderPager(s, b);
  wireTrail();
  wireDocMetaTips();
  setupEndFooter(s);
  // 字形庫（作者 2026-11-06）：本文的 Ext 漢字疊上 SVG。**非阻塞**：字庫要 async 載入，
  // 第一次載完會回頭把已經畫好的這一頁補上（`upgradeDocGlyphs`）。
  if (glyphsOn) void upgradeDocGlyphs();
  const body = document.querySelector<HTMLElement>('#docText .docBody');
  if (body) {
    if (wantScrollTop != null) body.scrollTop = wantScrollTop;
    else body.scrollTo(0, 0);
  }
  // 中間這一頁若被別的庫（印順）引用過，就在標題下畫「回連結」按鈕（作者 2026-10-28）
  // 跨庫分頁不畫：反鏈表是「左欄那一庫」的（頁 id 屬於別的庫，查起來是空的）
  if (ownsActiveDb(s)) void paintReverseBar();
  // the middle-line cursor follows the pane, so re-read it after every render and
  // after every programmatic scroll (paintHit) — throttled to one frame
  if (body && !docScrollWired.has(body)) {
    docScrollWired.add(body);
    body.addEventListener('scroll', scheduleCursorSync, { passive: true });
  }
  // 還原「看的地方」：paintHit 會把 DOM 改寫（包 <mark>），所以選取區一定要等它做完
  // 才設，否則 Range 的端點會被拆掉。
  const settleView = (): void => {
    if (!want) return;
    const b2 = document.querySelector<HTMLElement>('#docText .docBody');
    if (b2 && wantScrollTop != null) b2.scrollTop = wantScrollTop;
    if (want.sel) applyDocSelection(want.sel, { scroll: false });
    if (ownsActiveDb(s)) scheduleCursorSync();
  };
  if (s.pinned) {
    // noScroll：不要自己捲到釘選那一行，不然剛還原的捲動位置會被搶走
    void paintHit(ctx, s.pinned.va, s.pinned.units, { noScroll: !!want }).then(() => {
      settleView();
      // 詞級定位（`#N`／`#詞`）：paintHit 完成後 DOM 才是最終版，這時才加 word-hl。
      // `s.pinned.token` 保留完整位址（含 `#`），由 word-hl.ts 解析。
      highlightWordIn(document.getElementById('docText'), s.pinned?.token, s.pinned?.line);
    });
  } else {
    if (viewDt.lineNumbers.length && !want) document.getElementById('L' + nFirst)?.scrollIntoView({ block: 'start' });
    settleView();
  }
  // 目錄游標只跟「左欄那一庫」的本文連動
  if (ownsActiveDb(s) && !want) scheduleCursorSync();
  void updateDocLogo();   // 有文字就把 logo 收起來
}

/** the .docBody elements that already carry the scroll listener (one per render) */
const docScrollWired = new WeakSet<Element>();

/**
 * 中間的「回連結」：**嵌在經文裡被引用的那一行**（作者 2026-10-28）。
 *
 * 同一頁可能被引用好幾次，每一條都知道大正藏原文（`聯.q`）；把那段原文在這一頁的
 * 行文裡找出來，按鈕就貼在那一行的行首。找不到原文的（或頁面上根本沒有那一段）
 * 退回頁首的 `<頁>` 分隔後面，一條都不會丟。
 */
async function paintReverseBar(): Promise<void> {
  const body = document.querySelector<HTMLElement>('#docText .docBody');
  if (!body) return;
  document.querySelectorAll('#docText .xrefRevInline').forEach((el) => el.remove());
  // 一個文件可能含很多頁（整部經）；回連結要掛在「那一頁」，不是文件第一頁。
  const markers = [...body.querySelectorAll<HTMLElement>('.pageBreak[data-page], .pageMark[data-page]')];
  if (!markers.length) return;
  const lines = [...body.querySelectorAll<HTMLElement>('.docLine')];
  const lineIdx = new Map<HTMLElement, number>();
  lines.forEach((el, i) => lineIdx.set(el, i));
  const markerLine = markers.map((m) => lineIdx.get(m.closest('.docLine') as HTMLElement) ?? 0);
  for (let mi = 0; mi < markers.length; mi++) {
    const pageId = markers[mi].dataset.page ?? '';
    if (!pageId) continue;
    const from = markerLine[mi];
    const to = mi + 1 < markers.length ? markerLine[mi + 1] : lines.length;
    const pageLines = lines.slice(from, to);
    if (!pageLines.length) continue;
    let items: RevItem[] = [];
    try {
      items = await reverseItemsOf(pageId);
    } catch { continue; }
    if (!items.length || !body.isConnected) continue;
    // 行文（去掉標籤、只留漢字）→ 每一行在這一頁字串裡的起點
    const keys = pageLines.map((el) => cjkOnly(el.dataset.src ?? el.textContent ?? ''));
    const text = keys.join('');
    const starts: number[] = [];
    for (let i = 0, at = 0; i < keys.length; i++) { starts.push(at); at += keys[i].length; }
    const lineAt = (pos: number): number => {
      let lo = 0, hi = starts.length - 1, k = 0;
      while (lo <= hi) { const m = (lo + hi) >> 1; if (starts[m] <= pos) { k = m; lo = m + 1; } else hi = m - 1; }
      return k;
    };
    const hits = new Map<number, RevItem[]>();   // 這一行 → 按鈕
    const rest: RevItem[] = [];
    for (const it of items) {
      const q = cjkOnly(it.tq);
      let at = -1;
      for (const n of [14, 10, 8]) {
        if (q.length < n) continue;
        at = text.indexOf(q.slice(0, n));
        if (at >= 0) break;
      }
      if (at < 0) { rest.push(it); continue; }
      const li = lineAt(at);
      const arr = hits.get(li);
      if (arr) arr.push(it); else hits.set(li, [it]);
    }
    for (const [li, list] of hits) {
      const host = pageLines[li]?.querySelector('.lineText') ?? pageLines[li];
      host?.insertAdjacentHTML('afterbegin', '<span class="xrefRevInline">' + revButtonsHtml(list) + '</span>');
    }
    if (rest.length) {
      const html = '<span class="xrefRevInline" title="這一頁的引用（未能定位到某一行）">⇐'
        + revButtonsHtml(rest) + '</span>';
      markers[mi].insertAdjacentHTML('afterend', html);
    }
  }
}


/** 只留漢字（與 `<聯 q="…">` 的比對基礎一致） */
function cjkOnly(s: string): string {
  return s.replace(/<[^>]*>/g, '').replace(/[^\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/g, '');
}

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

/**
 * 分頁標籤要給讀者看的名字（作者 2026-10-31）：`Ys.xml` 這種 XML 檔名、或 `ys`
 * 這種 dbname，換成庫的短名（ys → 印順、fuyan → 福嚴）。
 */
function readableDocName(ctx: DocCtx | null, name: string): string {
  const t = displayName(name).trim();
  const db = (ctx?.dbName ?? activeDocCtx()?.dbName ?? '').toLowerCase();
  const short = db ? SHORT_DB_NAMES[db] : '';
  if (!t) return short;
  if (/\.xml$/i.test(t) || t.toLowerCase() === db) return short || t;
  return t;
}

/** 有本文分頁的庫變了（dbChip 的 owner 標記要重畫）；由 dbs.ts 註冊，避免循環 import */
let tabsChangedHook: (() => void) | null = null;
export function setDocTabsChangedHook(fn: (() => void) | null): void { tabsChangedHook = fn; }
let lastDbSig = '';

/** 分頁的「屬於哪幾庫」有變化才通知（每次重畫都通知會讓 dbChip 一直重建） */
function noteDbOwners(): void {
  const sig = docTabs.map((t) => ctxOf(t)?.dbId ?? 0).join(',');
  if (sig === lastDbSig) return;
  lastDbSig = sig;
  try { tabsChangedHook?.(); } catch { /* boot 期間還沒有 dbTabs */ }
}

/** the document tab strip: one chip per linked node, ✕ to close, ＋ for a new one */
function renderDocTabs(s: DocSession): void {
  const bar = $('#docTabs');
  const strip = $('#docTabStrip');
  if (!bar || !strip) return;
  // The strip shows as soon as one tab exists, so the ＋ (and therefore the
  // Ctrl+click alternative for a new tab) is always reachable.
  bar.hidden = docTabs.length < 1;
  // 每個分頁的髒點要看**它自己那一庫**的修訂工作階段（跨庫分頁不能共用一個 es）
  const editSessions = new Map<number, DbEditSession | null>();
  const esOf = (t: DocSession): DbEditSession | null => {
    const id = t.ctx?.dbId ?? 0;
    if (!editSessions.has(id)) editSessions.set(id, editSessionOf(ctxOf(t)));
    return editSessions.get(id) ?? null;
  };
  strip.innerHTML = docTabs.map((t, i) => {
    const tctx = ctxOf(t);
    const rb = boundsOfRealm(tctx, t.realm);
    const dirty = hasEditsInRange(esOf(t), rb.first, rb.last);
    const label = readableDocName(tctx, t.name);
    // hover 補充「這個分頁屬於哪一個 adb」：adb 名＋中文名（作者 2026-11-01）
    const dbName = tctx?.dbName || '';
    const dbCName = tctx?.dbCName || '';
    const dbInfo = dbName ? `${dbName}${dbCName ? '（' + dbCName + '）' : ''}` : '';
    const title = dbInfo ? `${label}｜${dbInfo}` : label;
    // 不是左欄那一庫的分頁多一個 inForeign 標記（淡色外框），一眼看得出那是別庫的
    const foreign = tctx && !isActiveDocCtx(tctx) ? ' foreign' : '';
    return '<span class="docTab' + (i === docActive ? ' active' : '') + (dirty ? ' dirty' : '') + (t.history ? ' history' : '') + foreign + '" data-i="' + i + '" title="' + escapeHtml(title) + '">'
      + '<span class="docTabName" title="' + escapeHtml(title) + '">' + escapeHtml(shortLabel(label, 8)) + '</span>'
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
    // 新分頁跟著目前分頁那一庫（沒有分頁時跟左欄那一庫）
    const cctx = ctxOf(s) ?? activeDocCtx();
    if (!cctx) return;
    const r = s?.realm ?? wholeRealm(cctx);
    const n = sessionFor(cctx, r, '新分頁', true);
    docActive = docTabs.indexOf(n);
    void ensurePage(n, s?.cache?.dt?.lineNumbers[0]);
  };
  noteDbOwners();
}

/**
 * 切到某個分頁（作者 2026-11-01：**只換本文，不換 adb**）。
 *
 * 分頁自己帶著 ctx，所以這裡不需要（也不可以）呼叫 `switchTo`：左欄目錄、摘要、
 * dbChip 都留在原來的庫。要切庫是 header 的 🌲（見 `revealCursorInTree`）。
 */
async function switchDocTab(i: number): Promise<void> {
  const t = docTabs[i];
  if (!t) return;
  stageActiveEditor();
  // 記住離開的分頁捲到哪裡、選了什麼，回來時原地不動（跨庫分頁常來回切）
  const cur = docSession();
  if (cur && cur !== t) {
    cur.scrollTop = document.querySelector<HTMLElement>('#docText .docBody')?.scrollTop ?? cur.scrollTop;
    cur.sel = captureDocSelection() ?? cur.sel;
  }
  t.autoEdit = true;
  docActive = i;
  setPinnedHit(t.pinned);
  pendingView = (typeof t.scrollTop === 'number' || t.sel)
    ? { scrollTop: typeof t.scrollTop === 'number' ? t.scrollTop : undefined, sel: t.sel ?? undefined }
    : null;
  if (t.cache) renderDoc(t);
  else await ensurePage(t);
  // 目錄游標只在「同一個庫」時有意義
  if (ownsActiveDb(t)) paintTreeActive();
  saveLastReadNow();
  renderDocTabs(t);      // 跨庫分頁的外框／owner 標記要跟著換
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
/**
 * 「連續閱讀」開關（作者 2026-11-05）：小節點只有十幾行，跨條目選取／複製很不方便。
 * 開啟＝從目前這一行往上留 20 行，之後連續讀到整本結束（200 行一頁、頁尾補到段落結束）；
 * 再按一次＝回到剛才那個節點、那一行。
 */
async function enterContinuous(s: DocSession, line: number, anchor?: ScrollAnchor, flashFrom?: number): Promise<void> {
  const ctx = ctxOf(s);
  if (!ctx?.mapper) return;
  const doc = docOfVa(ctx, s.realm.from);
  if (!doc || doc.vaEnd <= doc.vaStart) return;
  // 上面留 20 行上下文，但不要越過目前閱讀單位的開頭：短條目（例如 hanyudazidian
  // 的「目」）若借了上一條的尾巴，讀者捲到頂就看不到自己的開頭（作者 2026-11-06）。
  const realmStart = ctx.mapper.lineOfVa(s.realm.from);
  const fromLine = Math.max(0, Math.min(line, Math.max(realmStart, line - 20)));
  const fromVa = fromLine > 0 ? (ctx.mapper.linesVirtual[fromLine - 1] + 1) : doc.vaStart;
  s.nodeRealm = s.realm;
  s.nodeLine = line;
  s.realm = { from: Math.max(doc.vaStart, fromVa), to: doc.vaEnd };
  s.continuous = true;
  s.win = 0;
  s.cache = null;
  await ensurePage(s, line);
  // 從讀窗底部「自動載入更多」時，把原本置頂的那一行留在原位；用 offset 還原，
  // 不是 scrollIntoView(block:'start')，否則畫面會往上跳一大段（作者 2026-11-06）。
  if (anchor) restoreScrollAnchor(anchor);
  // 新塞進來一大段時，閃一下第一行，告訴讀者從哪裡開始讀（作者 2026-11-06）
  if (flashFrom != null) flashNewText(flashFrom);
}

async function toggleReadingRealm(s: DocSession): Promise<void> {
  const ctx = ctxOf(s);
  if (!ctx?.mapper) return;
  const target = realmToggleTarget(ctx, s.realm, s.continuous);
  if (!target) return;
  const cur = s.cache?.dt?.lineNumbers[0] ?? s.pinned?.line ?? 0;
  if (target === 'doc') {
    await enterContinuous(s, cur);
    return;
  }
  const line = s.nodeLine ?? cur;
  const va = ctx.mapper.linesVirtual[line] ?? s.realm.from;
  // 別庫的分頁（跨庫並存）沒有左欄目錄可查；只有自己存過的 nodeRealm 能用
  const node = s.nodeRealm ?? (ownsActiveDb(s) ? nodeContaining(va)?.realm : null);
  if (!node || node.to <= node.from) return;
  s.realm = node;
  s.continuous = false;
  s.cache = null;
  await ensurePage(s, s.nodeLine ?? cur);
}

/* ---- 讀窗到底：訊息 → 2 秒後自動載入更多／點一下立刻載入（作者 2026-11-05） ---- */

let endFooterTimer: number | null = null;
let endFooterCheck: (() => void) | null = null;
let endFooterBody: HTMLElement | null = null;

function clearEndTimer(): void {
  if (endFooterTimer != null) { window.clearTimeout(endFooterTimer); endFooterTimer = null; }
}

function clearEndFooter(): void {
  clearEndTimer();
  if (endFooterCheck && endFooterBody) endFooterBody.removeEventListener('scroll', endFooterCheck);
  if (endFooterCheck) window.removeEventListener('resize', endFooterCheck);
  endFooterCheck = null;
  endFooterBody = null;
  document.getElementById('docEnd')?.remove();
}

/** 自動載入前記住「畫面上最上面那一行」與它距讀窗頂端的偏移，載入後原樣還原 */
interface ScrollAnchor { line: number; offset: number }

function topVisibleAnchor(body: HTMLElement): ScrollAnchor | null {
  const top = body.getBoundingClientRect().top;
  for (const el of body.querySelectorAll<HTMLElement>('[id^="L"]')) {
    const r = el.getBoundingClientRect();
    if (r.bottom > top + 1) {
      const n = Number(el.id.slice(1));
      return Number.isFinite(n) ? { line: n, offset: r.top - top } : null;
    }
  }
  return null;
}

/** 還原同一行在原來的垂直位置（不是 align-to-top，才不會為了載入更多把畫面往上跳） */
function restoreScrollAnchor(anchor: ScrollAnchor): void {
  const body = document.querySelector<HTMLElement>('#docText .docBody');
  const el = document.getElementById('L' + anchor.line);
  if (!body || !el) return;
  const offset = el.getBoundingClientRect().top - body.getBoundingClientRect().top;
  body.scrollTop += offset - anchor.offset;
}

/** 新載入文字的頭一行閃 2 秒（作者 2026-11-06）：一大段突然塞進來，讀者要知道從哪讀起 */
let newTextFlashTimer = 0;
function flashNewText(from: number): void {
  if (newTextFlashTimer) { window.clearTimeout(newTextFlashTimer); newTextFlashTimer = 0; }
  for (const el of document.querySelectorAll<HTMLElement>('#docText .docLine.newTextFlash')) {
    el.classList.remove('newTextFlash');
  }
  // 亮一整句／一小段，而不是只有一行：從新文字的第一行往後收，遇到句末或空行就停。
  // 新載入的常常是條目標題（`<字>`），下一行才是釋文，所以至少會亮到第一句。
  const els: HTMLElement[] = [];
  for (let n = from; n < from + 12; n++) {
    const hit = document.getElementById('L' + n);
    const el = hit ? (hit.classList.contains('docLine') ? hit : hit.closest<HTMLElement>('.docLine') ?? hit) : null;
    if (!el) break;
    const text = el.textContent?.trim() ?? '';
    if (!text) break;
    els.push(el);
    if (/[。！？!?…」』”’]$/.test(text)) break;
  }
  if (!els.length) return;
  const body = els[0].closest<HTMLElement>('.docBody');
  const fr = els[0].getBoundingClientRect();
  const lr = els[els.length - 1].getBoundingClientRect();
  if (body) {
    const br = body.getBoundingClientRect();
    // 只把新段落推到「看得到、下面留一點」的位置（不是整頁置中），減少畫面移動
    const topPad = 60, bottomPad = 100;
    if (lr.bottom > br.bottom - bottomPad) {
      body.scrollTo({ top: body.scrollTop + lr.bottom - (br.bottom - bottomPad), behavior: 'smooth' });
    } else if (fr.top < br.top + topPad) {
      body.scrollTo({ top: body.scrollTop + fr.top - (br.top + topPad), behavior: 'smooth' });
    }
  }
  // 下一個 frame 再加 class，動畫才會從頭播
  requestAnimationFrame(() => {
    for (const el of els) el.classList.add('newTextFlash');
    newTextFlashTimer = window.setTimeout(() => {
      for (const el of els) el.classList.remove('newTextFlash');
      newTextFlashTimer = 0;
    }, 2000);
  });
}

async function loadMoreFromEnd(s: DocSession): Promise<void> {
  const body = document.querySelector<HTMLElement>('#docText .docBody');
  const anchor = body ? topVisibleAnchor(body) : null;
  const line = s.cache?.dt?.lineNumbers[0] ?? s.pinned?.line ?? 0;
  const lastLine = s.cache?.dt?.lineNumbers.at(-1);
  await enterContinuous(s, line, anchor ?? undefined, lastLine == null ? undefined : lastLine + 1);
}

let growEl: HTMLElement | null = null;
let growing = false;

/**
 * 連續閱讀時往下滾過頁底，就再渲染下一頁接上去（厚觀法師 2026-11-12
 * 「引用複製不能往下捲」）。一頁只有 200 行，滾到底就是頁底，不是書底；
 * 以前只能按「下一頁」，拖選也就斷在那裡。窗口往下長一頁，滾動條變長、
 * 內容接下去，選取事後再接回去。
 */
function setupGrowOnScroll(): void {
  const body = document.querySelector<HTMLElement>('#docText .docBody');
  if (!body || growEl === body) return;
  growEl = body;
  body.addEventListener('scroll', () => {
    if (growing) return;
    const s = docSession();
    if (!s) return;
    if (body.scrollHeight - body.scrollTop - body.clientHeight > 240) return;   // 還沒到底
    const ctx = ctxOf(s);
    if (!ctx) return;
    const realmLast = boundsOfRealm(ctx, s.realm).last;
    const shown = s.cache?.dt.lineNumbers.at(-1) ?? 0;
    if (shown >= realmLast) return;                                            // 整本都出來了
    growing = true;
    const sel = captureDocSelection();
    const keepTop = body.scrollTop;          // 重畫會把捲動位置歸零，先記住
    s.win = (s.win ?? 0) + 1;
    void ensurePage(s)
      .then(() => {
        const nb = document.querySelector<HTMLElement>('#docText .docBody');
        if (nb) nb.scrollTop = keepTop;      // 內容接在下面，停在原來的地方
        if (sel) applyDocSelection(sel, { scroll: false });
      })
      .finally(() => { growing = false; });
  }, { passive: true });
}

function startEndTimer(s: DocSession): void {
  clearEndTimer();
  endFooterTimer = window.setTimeout(() => {
    endFooterTimer = null;
    // 舊版在這裡「有選取就不載入」，怕重畫把選取洗掉。結果是死結：用滑鼠
    // 拉到頁底就開始選 → 一直有選取 → 永遠不載入 → 就捲不下去，選不到下面的
    // 段落（厚觀法師 2026-11-12「引用複製不能往下捲」，他給的兩個場景都是如此）。
    // 改成：先記住選取（行號＋行內漢字），載入完再接回去。
    const sel = captureDocSelection();
    clearEndFooter();
    void loadMoreFromEnd(s).then(() => { if (sel) applyDocSelection(sel, { scroll: false }); });
  }, 2000);
}

/**
 * 讀窗到底的訊息：只在「這一頁是 realm 的最後一頁、而且整本後面還有文字」時出現。
 * 訊息真的進入畫面才開始 2 秒計時；離開畫面就取消。點一下立刻載入。
 */
function setupEndFooter(s: DocSession): void {
  clearEndFooter();
  const ctx = ctxOf(s);
  const body = document.querySelector<HTMLElement>('#docText .docBody');
  if (!ctx || !body) return;
  const b = pageBounds(ctx, s.realm, s.page);
  if (s.page < b.pages - 1) return;                       // 還有下一頁：pager 會處理
  const inner = boundsOfRealm(ctx, s.realm);
  const doc = docOfVa(ctx, s.realm.from);
  if (!doc || doc.vaEnd <= doc.vaStart) return;
  const docBounds = boundsOfRealm(ctx, { from: doc.vaStart, to: doc.vaEnd });
  if (inner.last >= docBounds.last) return;               // 已經到整本結尾
  const el = document.createElement('div');
  el.className = 'docEnd';
  el.id = 'docEnd';
  el.innerHTML = '<span>本讀窗到底了</span><span class="docEndHint">2 秒後自動載入更多；點一下立刻載入</span>';
  el.onclick = () => { clearEndFooter(); void loadMoreFromEnd(s); };
  body.appendChild(el);
  // 訊息真的在可視範圍才計時；捲動時重算（停在訊息上 2 秒才自動載入，一離開就取消）
  const inside = (): boolean => {
    const eb = el.getBoundingClientRect();
    const bb = body.getBoundingClientRect();
    return eb.top < bb.bottom && eb.bottom > bb.top;
  };
  const check = (): void => { if (inside()) startEndTimer(s); else clearEndTimer(); };
  endFooterCheck = check;
  endFooterBody = body;
  body.addEventListener('scroll', check, { passive: true });
  window.addEventListener('resize', check);
  requestAnimationFrame(check);
}

function renderPager(s: DocSession, b: { first: number; last: number; total: number; pages: number }): void {
  const bar = $('#docPager');
  if (!bar) return;
  const ctx = ctxOf(s);
  // 小節（少於一頁）也要能翻到上／下一個節點：作者 2026-10「對小內文頁，
  // 上一頁／下一頁變得沒作用了」。所以「有鄰居」時 pager 不能藏起來。
  // 上下鄰居來自目錄樹，只有「左欄那一庫」的分頁才算得出來。
  const sameDb = ownsActiveDb(s);
  const neighborPrev = sameDb && hasRealmNeighbor(ctx, -1);
  const neighborNext = sameDb && hasRealmNeighbor(ctx, 1);
  const toggle = realmToggleTarget(ctx, s.realm, s.continuous);
  bar.hidden = b.pages < 2 && !neighborPrev && !neighborNext && !toggle;
  const more = $('#pageMore') as HTMLButtonElement | null;
  if (more) {
    more.hidden = !toggle;
    if (toggle) {
      more.textContent = toggle === 'node' ? '回到本節' : '連續閱讀';
      more.title = toggle === 'node'
        ? '回到目前位置所在的條目（離開整本連續閱讀）'
        : '整本連續閱讀：每頁 200 行，頁尾補到段落結束，方便跨小條目選取／複製';
      more.onclick = () => { void toggleReadingRealm(s); };
    }
  }
  const prev = $('#pagePrev') as HTMLButtonElement | null;
  const next = $('#pageNext') as HTMLButtonElement | null;
  // Resolve the session AT CLICK TIME: an async render of an older tab must not be
  // able to leave the pager wired to a tab that is no longer on screen.
  const step = (delta: number, ev: MouseEvent) => {
    const cur = docSession();
    if (!cur) return;
    const pb = pageBounds(ctxOf(cur), cur.realm, cur.page);
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
  s.win = 0;                       // 換頁就回到一頁的窗口
  await ensurePage(s);
  if (keep !== undefined) document.getElementById('L' + keep)?.scrollIntoView({ block: 'start' });
  const b = pageBounds(ctxOf(s), s.realm, s.page);
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

// 拉丁字母與數字統一用 Times New Roman（厚觀法師 2026-11-14 16:32）：
// 先前堆疊裡只有 JhengHei／Segoe UI，梵文的 ā ī ṃ ṣ ṭ 等字缺字→瀏覽器逐字
// 回退到系統 serif（法師看到的是 Cambria），同一個詞裡的字來自兩套字型，
// 字距不均、看起來斷斷續續。TNR 放在中文字型**前面**：TNR 不含漢字，
// 漢字與中文標點仍回退到 JhengHei，只有拉丁／數字改用 TNR。
const DOC_TEXT_FAMILY = '"Accelon Box", "Accelon Siddham Uni", "Accelon Siddham Extra", "Accelon Ranjana", "Times New Roman", "Microsoft JhengHei", "Segoe UI", system-ui, sans-serif';

function autoFitFont(sample?: string[]): number {
  // The DOM only holds ONE page, so the numbers must come from the WHOLE document
  // (its line table) whenever it is available: otherwise the font would change as
  // the reader pages through the text. `lines` is the fallback.
  const lines = sample ?? lastDocLines;
  // 字級是跟著「畫面上這一頁」的庫算的（跨庫分頁要看那一庫的行長分布）
  const mp = ctxOf(docSession())?.mapper ?? activeDocCtx()?.mapper ?? null;
  const doc = mp && mp.lineCount > 0 ? mp : null;
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
    p90: (ctxOf(docSession())?.mapper ?? activeDocCtx()?.mapper)?.lineLengthPercentile(0.9, 200_000) ?? 0,
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

/* ---- 共享 docTab（作者 2026-11-01）--------------------------------------------
 * 預設關閉：每個 adb 自己一組本文分頁（切庫時整組換掉）。
 * 開啟後：所有 adb 共用同一條分頁；每個分頁記住自己的 ctx，點分頁**只換本文、不換 adb**
 * （要切庫按 header 的 🌲）。設定存在 localStorage，切換 adb 不會被重設。
 */
const SHARED_TABS_KEY = 'accelon26.shareddoctabs';
export function sharedDocTabsOn(): boolean {
  try { return localStorage.getItem(SHARED_TABS_KEY) === '1'; } catch { return false; }
}
export function setSharedDocTabs(on: boolean): void {
  try { localStorage.setItem(SHARED_TABS_KEY, on ? '1' : '0'); } catch { /* 無痕模式 */ }
}

/** 切庫後找一個屬於這個 adb 的分頁；沒有就回 false。 */
export function activateTabForDb(dbId: number): boolean {
  const i = docTabs.findIndex((t) => ctxOf(t)?.dbId === dbId);
  if (i < 0) return false;
  docActive = i;
  return true;
}

/** 目前分頁的 id（0＝沒有）；切庫後用它回到「那一庫最後看的分頁」。 */
export function activeTabId(): number {
  return docSession()?.id ?? 0;
}

/** 用分頁 id 選回分頁；已經被關掉就回 false。 */
export function activateTabById(id: number): boolean {
  if (!id) return false;
  const i = docTabs.findIndex((t) => t.id === id);
  if (i < 0) return false;
  docActive = i;
  return true;
}

/** 這一庫的分頁有沒有「目前」這一個（沒有的話切庫要顯示空本文）。 */
export function activeTabBelongsTo(dbId: number): boolean {
  return (ctxOf(docSession())?.dbId ?? 0) === dbId;
}

/** 有本文分頁的庫（dbChip 的 owner 標記／state() 診斷用；不動 active）。 */
export function tabDbIds(): number[] {
  return [...new Set(docTabs.map((t) => ctxOf(t)?.dbId ?? 0).filter((id) => id > 0))];
}

/** 這個庫有幾個本文分頁（跨庫分頁挑選用）。 */
export function tabCountOfDb(dbId: number): number {
  return docTabs.filter((t) => ctxOf(t)?.dbId === dbId).length;
}

/**
 * 關庫時把這個庫的分頁一起關掉（作者 2026-11-01）。
 *
 * 分頁的 ctx 持有那一個 reader／mapper；桌面版是 mmap，關庫後再畫會炸，
 * Blob 也不會釋放。所以關庫＝連它的本文分頁一起關。
 */
export function closeTabsForDb(dbId: number): number {
  if (!dbId) return 0;
  const keep: DocSession[] = [];
  let removed = 0;
  let activeGone = false;
  docTabs.forEach((t, i) => {
    if (ctxOf(t)?.dbId !== dbId) { keep.push(t); return; }
    removed++;
    if (i === docActive) activeGone = true;
    if (activeEditor?.s === t) stageActiveEditor();
    if (t.ctx?.reader) dropPageImages(t.ctx.reader);
  });
  if (!removed) return 0;
  docTabs = keep;
  if (activeGone || docActive >= docTabs.length) docActive = docTabs.length ? 0 : -1;
  if (!docTabs.length) {
    showEmptyDoc('點左側節點／摘要，會載入該處的本文（一頁一頁載入）。');
    noteDbOwners();
    return removed;
  }
  // 目前分頁還在：重畫（分頁條要去掉被關掉的那幾個）
  renderDocTabs(docSession() ?? docTabs[0]);
  noteDbOwners();
  return removed;
}

/** 這個庫還沒有本文分頁：保留分頁條，只把本文區換成提示。 */
export function showEmptyDoc(msg: string): void {
  docActive = -1;
  setPinnedHit(null);
  const el = document.getElementById('docText');
  if (el) el.innerHTML = '<p class="dim">' + msg + '</p>';
  const pager = document.getElementById('docPager') as HTMLElement | null;
  if (pager) pager.hidden = true;
  const strip = document.getElementById('docTabStrip');
  // 分頁條保留（可以點別庫的分頁），只是沒有 active
  strip?.querySelectorAll('.docTab').forEach((n) => n.classList.remove('active'));
  const bar = document.getElementById('docTabs') as HTMLElement | null;
  if (bar) bar.hidden = docTabs.length < 1;
  void updateDocLogo();
}

/**
 * `openFile` 收尾：決定分頁條要不要顯示。
 *
 * 共享分頁開啟時，別的庫的本文分頁要留著（作者 2026-11-01）——以前這裡一律
 * 清空分頁條，跨庫分頁就消失了。沒有分頁才整條收起來。
 */
export function refreshDocTabsAfterOpen(): void {
  const bar = document.getElementById('docTabs') as HTMLElement | null;
  const strip = document.getElementById('docTabStrip');
  if (!docTabs.length) {
    if (bar) bar.hidden = true;
    if (strip) strip.innerHTML = '';
    const pager = document.getElementById('docPager') as HTMLElement | null;
    if (pager) pager.hidden = true;
    return;
  }
  renderDocTabs(docSession() ?? docTabs[0]);
  // 這個庫還沒有本文分頁（共享分頁）：分頁條留著，本文區顯示提示
  if (docActive < 0) showEmptyDoc('這個庫還沒有開啟本文；點左側目錄或摘要就會載入。');
}

/** a fresh database invalidates every open tab and every derived page cache */
export function resetDocPane(): void {
  destroyActiveEditor();
  // 共享 docTab：換庫不清分頁（每個分頁自己帶 ctx；切庫後由 dbs 選分頁）
  if (!sharedDocTabsOn()) {
    docTabs = [];
    docActive = 0;
  } else {
    docActive = -1;
  }
  docFontSized = false;
  boundsCache.clear();
  paintAsked.clear();
  lastDocLines = [];
  lastLink = null;
  setJumpRange(null);
  clearCharBand();
  pagerLog.length = 0;
  noteDbOwners();
}

// 修訂數變動：docTab 的紅底即時更新（dbChip 由 dbs.ts 自己訂閱）
onEditsChange(() => {
  const s = docSession();
  if (s) { renderDocTabs(s); setEditControls(s); }
});

import { AdbReader, DocRow } from './adb';

import { VaPaMapper } from './vapa';
import { updateDocLogo } from './logo';
import { RevItem, revButtonsHtml, reverseItemsOf } from './xref';
import { inJumpRange, jumpRange, setJumpRange } from './jump-band';

/** everything the document pane keeps for ONE database */
function snapshotDocPane() {
  // the CodeMirror view is not serialisable; write its text into the session first
  stageActiveEditor();
  saveLastReadNow();
  // 作者 2026-11-01：切換 adb 時要把閱讀位置帶回來（同一個分頁、同一頁內的捲動與選取區）
  const scrollTop = document.querySelector<HTMLElement>('#docText .docBody')?.scrollTop ?? 0;
  const sel = captureDocSelection();
  return { docTabs, docActive, docSeq, lastDocLines, lastLink, lastFit, scrollTop, sel };
}

/**
 * 還原某一庫的分頁。
 *
 * ctx 不是可序列化的狀態（它是 reader／mapper 的參考），所以每個分頁只帶 `dbId`；
 * 這裡用 `resolveDocCtx` 從還開著的 slot 重新解析。解析不到的（那個庫已經關了）
 * 就把分頁丟掉 —— 留著它只會在下次重畫時碰到已關閉的 reader。
 */
function restoreDocPane(s: any): void {
  destroyActiveEditor();
  const tabs: DocSession[] = [];
  for (const t of (s?.docTabs ?? []) as DocSession[]) {
    const dbId = t?.ctx?.dbId ?? 0;
    const ctx = dbId ? resolveDocCtx(dbId) : null;
    if (!ctx) continue;
    tabs.push({ ...t, ctx });
  }
  docTabs = tabs;
  docActive = Math.max(-1, Math.min(Number(s?.docActive ?? 0) || 0, docTabs.length - 1));
  docSeq = s?.docSeq ?? 0;
  lastDocLines = s?.lastDocLines ?? [];
  lastLink = s?.lastLink ?? null;
  lastFit = s?.lastFit ?? null;
  pendingView = (typeof s?.scrollTop === 'number' || s?.sel)
    ? { scrollTop: typeof s?.scrollTop === 'number' ? s.scrollTop : undefined, sel: s?.sel ?? undefined }
    : null;
  boundsCache.clear();
  paintAsked.clear();
  docFontSized = true;          // the size is a reader preference, not per database
  noteDbOwners();
}

export { DOCFS_DEFAULT, DOCFS_KEY, DOCFS_MAX, DOCFS_MIN, DOCFS_READABLE_MIN, DOC_TEXT_FAMILY, DocSession, PAGE_LINES, PROBE_FS, applySideFonts, autoFitFont, boundsCache, boundsOfRealm, closeDocTab, docActive, docFontSized, docOfVa, docScrollWired, docSeq, docSession, docTabs, docTextWidth, edgeLine, ensurePage, fetchPage, fitDebugInfo, goPage, lastDocLines, lastFit, lastLink, longestOf, makeTextMeasurer, pageBounds, pageOfLine, pagerLog, paintAsked, pendingProbeCleanup, pickProbeLine, readDocFont, readSideFont, realmFirstLine, realmKey, realmLastLine, renderDoc, renderDocTabs, renderPager, restoreDocPane, scheduleCursorSync, scrollToVa, sessionFor, sessionForRealm, setDocFont, setSideFont, shortLabel, showsLine, snapshotDocPane, switchDocTab, wholeRealm, ctxOf };


