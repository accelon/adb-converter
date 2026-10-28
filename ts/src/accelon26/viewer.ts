/**
 * adb viewer — browser entry point (single file, works from file://).
 *
 * Layout: LEFT = token list + posting list, MIDDLE = document text (hard line
 * breaks), RIGHT = tabbed meta / capacity / documents / images. Clicking a token
 * (or one of its posting VAs) jumps the middle pane to that place in the text
 * and paints only that token — no separate hit list.
 */
import {
  AdbReader, BlobIO, CLASS_LABELS,
  type AdbHeader, type Container, type DocRow, type TokenRow, type AdbSource } from './adb';
import { VaPaMapper, parseAttrs } from './vapa';
import { detectDictDb } from './db-kind';
import {
  SearchSession, searchSummary, loadTrees, loadTree, buildTree, flattenTree, parseScope, loadInstanceAttrs,
  type SearchResult, type TreeNode, type SearchTree,
} from './search';
import { alreadyOpen, catalogAdd, detachLoaded, registerOpenDb, saveLoaded, switchTo } from './dbs';
import { showTab } from './ui';
import { appendTokenRows, renderDocs, renderHeader, renderMeta, renderResources, renderTokens, showToken, tokenList, tokenOffset, vapaProbe } from './panes';
import { dirActive, dirError, dirLoading, dirTrees, folioCache, labelTables, loadDirectoryTrees, renderDirTree, renderFolio, renderFreq, renderLatin, renderTerms, resetScopes, setDirError, setDirLoading, syncTreeTabs, treePhases } from './scopes';
import { SNIPPET_LIMIT, lastResult, renderSnippets, resetSummary, runSearch, searchSeq, showNodeHits, snippetScope, snippetScopeQuery, snippetShown, summaryResult } from './summary';
import { cursorNode, lastReveal, nodeLabelOf, paintTreeActive, pinnedHit, resetLink, revealCursorInTree, revealHit, showLine } from './link';
import { resetTextPane } from './text-pane';
import { setLogoBase, updateDocLogo } from './logo';
import { DOCFS_DEFAULT, DOCFS_KEY, autoFitFont, boundsCache, boundsOfRealm, docActive, docFontSized, docOfVa, docSession, docTabs, ensurePage, fitDebugInfo, lastDocLines, lastFit, lastLink, pageBounds, pagerLog, paintAsked, readDocFont, renderDocTabs, resetDocPane, restoreLastRead, sessionFor, setDocFont, wholeRealm } from './doc-pane';
import { paintHit } from './paint';
import { resetEngineStats } from './engine-stats';
import { setActiveDb } from './tag-style';

export const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

export let reader: AdbReader | null = null;
export let mapper: VaPaMapper | null = null;
export let session: SearchSession | null = null;
export let tokens: TokenRow[] = [];
export let docs: DocRow[] = [];
/** 目前打開的 adb 檔名（settings.json 的 profiles.adb 鍵；作者 2026-10-22） */
export let currentFile = '';
/** 目前這份 adb 的 File/Blob 身分（file:// 版沒有 path，編輯工作階段靠它當 key） */
export let currentSource: AdbSource | null = null;
let blocksVirtual: number[] = [];
let currentDoc: DocRow | null = null;
/** true while a database load is in flight (guards a double `change` event) */
export let opening = false;



export const fmtInt = (n: number) => n.toLocaleString('en-US');
export const fmtBytes = (n: number) => {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KiB';
  return (n / 1048576).toFixed(2) + ' MiB';
};
export const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/** Show a name that may contain lone surrogates / embedded NULs sensibly. */
export function displayName(name: string): string {
  const nul = name.indexOf('\0');
  const cut = nul >= 0 ? name.slice(0, nul) : name;
  const units = [...cut].map((ch) => {
    // `[...s]` 給的是「字」（可能是代理對）；只有長度 1 的才是真正的孤代理。
    // 舊寫法用 ch.charCodeAt(0) 判斷，於是所有增補平面字（𢁓、𠀀…）都被當成
    // 孤代理換成 □——swjz 的 2,009 個字頭就是這樣變成豆腐塊的（2026-10-28 修）。
    if (ch.length === 1) {
      const c = ch.charCodeAt(0);
      if (c >= 0xd800 && c <= 0xdfff) return '\u25a1';
      if (c < 0x20) return '\u2400' + String.fromCharCode(c + 0x40);
    }
    return ch;
  }).join('');
  return nul >= 0 ? units + '…' : units;
}

let lastStatus = '';

/**
 * The header's status line.
 *
 * Only errors and "working…" reach the reader (author 2026-10: 用戶不需要「庫名：N 詞、
 * M 文件」這類資訊). The running commentary is still REMEMBERED — `statusText()` is what
 * `__accelon26.status()` / `state().status` report, so tests and diagnostics keep seeing
 * the last message while the header stays clean.
 */
export function setStatus(msg: string, kind: 'info' | 'err' | 'busy' = 'info') {
  lastStatus = msg;
  const el = $('#status');
  if (!el) return;
  if (kind === 'info') {
    el.hidden = true;
    el.textContent = '';
    el.className = 'status';
    return;
  }
  el.hidden = false;
  el.textContent = msg;
  el.className = 'status ' + kind;
}

/** the last message, whether or not it was shown (diagnostics/tests) */
export const statusText = (): string => lastStatus;


// ------------------------------------------------------------------- open
/**
 * Open cost, broken down.
 *
 * `file://` can only read a local file through `Blob.slice().arrayBuffer()`, so
 * the interesting numbers are how many reads happen, how many bytes they move,
 * and which phase issues them. `openMs` used to cover only the container header;
 * the token index, the length tables and the document list are measured
 * separately here because on a 24 MB database they dominate.
 */
export let lastOpen: {
  file: string; bytes: number; reads: number; cached: number; ioMs: number; maxRead: number;
  parseMs: number; tokenMs: number; layoutMs: number; anchorMs: number;
  docsMs: number; treeMs: number; totalMs: number;
} | null = null;
/**
 * Background directory-tree time. Kept outside `lastOpen` because the tree now
 * finishes BEFORE the object is built (it used to take ~1 s and always landed
 * after), which would leave `treeMs` reading a misleading 0.
 */
let lastTreeMs = 0;

export async function openFile(file: AdbSource): Promise<'opened' | 'existing' | 'refused' | 'busy'> {
  // A load may be triggered twice by the picker (the browser fires `change`, and
  // callers often dispatch one as well). Without this guard the second run would
  // rebuild and discard the directory trees the first one produced.
  if (opening) return 'busy';
  // Peek at the header FIRST (only the container headers; the heavy loading happens
  // below). The same peek is what the dropdown needs, so the file is remembered in the
  // catalogue here — there is no cap: a sixth database evicts the least recently used.
  {
    let probe;
    try {
      probe = await AdbReader.open(new BlobIO(file));
    } catch (e) {
      // not an .adb (or unreadable): report it instead of rejecting out of openFile
      setStatus('開啟失敗：' + (e as Error).message, 'err');
      return 'refused';
    }
    const wantName = probe.header.dbcname || probe.header.dbname;
    catalogAdd(file, wantName);
    // The picker fires `change` twice for one pick, and the second run would load the
    // file again — discarding the snapshot of the database being left (its tabs were
    // lost that way). If this exact file is already open, just switch to it.
    const known = alreadyOpen(file, wantName);
    if (known) {
      switchTo(known.id);
      setStatus(wantName + '：已經開啟，切換過去', 'info');
      return 'existing';
    }
  }
  opening = true;
  // Opening a database REPLACES the active one: snapshot it first, or the tabs and
  // searches the reader made in it would be lost (the slot would still hold the
  // state from its own load).
  saveLoaded();
  detachLoaded();          // the globals are nobody's until the new slot registers
  // only now: snapshotDocPane above needed the OLD source to stage its editor
  currentSource = file;
  // a new database invalidates every derived cache, tree, tab and cursor. Each
  // module owns its state, so it owns its reset too (imported bindings are live
  // and read-only from here).
  resetScopes();
  resetDocPane();
  resetTextPane();
  resetLink();
  resetEngineStats();     // 標題上的「上一輪耗時」不跨資料庫
  const T0 = performance.now();
  const io = new BlobIO(file);
  let opened = false;
  try {
    setStatus(`讀取 ${file.name} …`, 'busy');
    const t0 = performance.now();
    reader = await AdbReader.open(io);
    const openMs = performance.now() - t0;

    const h = reader.header;
    // the file picker is only needed before a database is open; afterwards the
    // Chinese name in the header is the way to open another one
    document.body.classList.add('loaded');
    // the database's name lives in its chip (#dbTabs), rendered by registerOpenDb below
    renderMeta(reader, openMs, 0, 0, 0);
    void renderHeader();

    // token index: the tokens container's names + each token's packed list header
    const t1 = performance.now();
    tokens = reader.tokens();
    const tokenMs = performance.now() - t1;
    const stats = reader.classStats();

    const t2 = performance.now();
    mapper = new VaPaMapper(reader);
    await mapper.init();
    blocksVirtual = mapper.blocksVirtualStored;
    const layoutMs = performance.now() - t2;
    // 詞典型 adb？本文不顯示 docHead（作者 2026-10：同一個詞不要顯示三次）
    await detectDictDb(mapper);
    const t2b = performance.now();
    const anchorCount = await mapper.loadAnchors();
    void anchorCount;                      // kept for the meta pane / diagnostics
    const anchorMs = performance.now() - t2b;
    session = new SearchSession(reader);

    const t3 = performance.now();
    docs = await reader.documents();
    currentFile = file.name;
    // 設定頁「此資料庫」與 settings.json 的 profiles.adb 鍵（作者 2026-10-22：檔名）
    setActiveDb(currentFile, h.dbcname || h.dbname || currentFile);
    const docsMs = performance.now() - t3;
    await session.init();
    // The reader's pane is chosen from the `<樹>` declarations right away; the
    // instances behind it are built in the background.
    syncTreeTabs();

    renderMeta(reader, openMs, tokenMs, layoutMs, docsMs);
    renderTokens(stats, tokenMs);
    renderDocs();
    // Directory trees are built in the BACKGROUND: a label means walking source
    // text per node, and on yinshun (3 trees, 132 nodes) that must not delay the
    // document pane. The 目錄 tab shows a notice until they are ready.
    setDirLoading(true);
    lastTreeMs = 0;
    const tTree = performance.now();
    void loadDirectoryTrees().catch((e) => {
      setDirError(String((e as Error)?.stack ?? e));
      console.error('directory tree failed', e);
      void renderDirTree();
    }).finally(() => {
      setDirLoading(false);
      lastTreeMs = performance.now() - tTree;
      if (lastOpen) lastOpen.treeMs = lastTreeMs;
      void renderDirTree();
    });
    resetSummary();
    ($('#query') as HTMLInputElement).value = '';
    $('#searchList').innerHTML = '';
    $('#searchMeta').textContent = '';
    showTab('dir', 'left');
    showTab('sum', 'right');       // 摘要 pane hosts the full-text search results

    const totalMs = performance.now() - T0;
    lastOpen = {
      file: file.name,
      bytes: io.bytes,
      reads: io.reads,
      cached: io.cached,
      ioMs: io.ms,
      maxRead: io.maxRead,
      parseMs: openMs,
      tokenMs,
      layoutMs,
      anchorMs,
      docsMs,
      treeMs: lastTreeMs,
      totalMs,
    };
    // Keep the status line clean for readers: the technical breakdown lives in
    // `state()` / `openBreakdown()` (and the browser tests print it).
    setStatus(`${h.dbcname || h.dbname}：${fmtInt(tokens.length)} 詞、${fmtInt(docs.length)} 文件`, 'info');
    console.log('[open]', lastOpen);
    renderMeta(reader, openMs, tokenMs, layoutMs, docsMs);
    void renderResources();
    setLogoBase(file.name);        // <file>_logo.png lives in this database's resources
    const dbName = h.dbcname || h.dbname;
    if (registerOpenDb(file, dbName).replaced) {
      setStatus(`${dbName}：${file.name} 取代了同名的庫（它的舊分頁已關閉）`, 'info');
    }
    void updateDocLogo();          // 本文區還空著 → 顯示這個庫自己的 logo
    opened = true;
  } catch (e) {
    setStatus('開啟失敗：' + (e as Error).message, 'err');
    console.error(e);
  } finally {
    opening = false;
    const tabs = $('#docTabs') as HTMLElement | null;
    if (tabs) { tabs.hidden = true; }
    const strip = $('#docTabStrip');
    if (strip) strip.innerHTML = '';
    const pager = $('#docPager') as HTMLElement | null;
    if (pager) pager.hidden = true;
  }
  if (opened) {
    // 最後閱讀頁：finally 清空 docTabs 之後才還原，否則會被 Hide 掉
    try { await restoreLastRead(file); } catch { /* 壞資料就當作沒有 */ }
    return 'opened';
  }
  return 'refused';
}

















/** Ctrl (or Cmd on a Mac) held on an event: open the link in a NEW tab. */
export const newTabKey = (ev?: { ctrlKey?: boolean; metaKey?: boolean }): boolean =>
  !!ev && (!!ev.ctrlKey || !!ev.metaKey);
/** Alt held on an event: the old "expand every descendant" (setOpenAll). */
export const altKey = (ev?: { altKey?: boolean }): boolean => !!ev && !!ev.altKey;
/** the modifiers a programmatic link should honour */
export const mods = (ev?: { ctrlKey?: boolean; metaKey?: boolean }): { newTab?: boolean } | undefined =>
  newTabKey(ev) ? { newTab: true } : undefined;

/** the viewer's own per-database state (each module snapshots its own) */
export function snapshotCore() {
  return { reader, mapper, session, tokens, docs, currentFile, currentSource, blocksVirtual, currentDoc, lastOpen, lastTreeMs };
}
export function restoreCore(s: any): void {
  reader = s.reader ?? null;
  mapper = s.mapper ?? null;
  session = s.session ?? null;
  tokens = s.tokens ?? [];
  docs = s.docs ?? [];
  currentFile = s.currentFile ?? '';
  currentSource = s.currentSource ?? null;
  setActiveDb(currentFile, reader?.header.dbcname || reader?.header.dbname || currentFile);
  blocksVirtual = s.blocksVirtual ?? [];
  currentDoc = s.currentDoc ?? null;
  lastOpen = s.lastOpen ?? null;
  lastTreeMs = s.lastTreeMs ?? 0;
}
