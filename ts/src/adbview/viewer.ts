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
  type AdbHeader, type Container, type DocRow, type TokenRow,
} from './adb';
import { VaPaMapper, parseAttrs } from './vapa';
import {
  SearchSession, searchSummary, loadTrees, loadTree, buildTree, flattenTree, parseScope, loadInstanceAttrs,
  type SearchResult, type TreeNode, type SearchTree,
} from './search';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

let reader: AdbReader | null = null;
let mapper: VaPaMapper | null = null;
let session: SearchSession | null = null;
let tokens: TokenRow[] = [];
let docs: DocRow[] = [];
let blocksVirtual: number[] = [];
let currentDoc: DocRow | null = null;
let showAllClasses = false;
/** true while a database load is in flight (guards a double `change` event) */
let opening = false;

/** the hit the middle pane is currently showing (VA + its element text) */
let pinnedHit: { va: number; text: string; token: string; units: number; line: number; exact?: boolean; phrase?: string; noMark?: boolean } | null = null;
let lastReveal = '';

/** search state */
let lastResult: SearchResult | null = null;
/**
 * The result the 摘要 pane currently shows. Normally the same as `lastResult`, but
 * the 頻次／全文 pane runs its OWN search (its own input), so a click there scopes
 * the summary to that result instead of the 目錄 query.
 */
let summaryResult: SearchResult | null = null;
let searchSeq = 0;
/** index into result.groups, -1 = all groups */
let activeGroup = -1;
/**
 * How many summaries the 摘要 pane shows after an input update. The requirement
 * is "只更新摘要（顯示最前面 30 筆）": typing must not touch the document, and
 * the rest of the hits are revealed by clicking a node's 命中數 badge.
 */
const SNIPPET_LIMIT = 30;
let snippetShown = SNIPPET_LIMIT;
/** when a node's 命中數 was clicked, the 摘要 pane is scoped to that node */
let snippetScope: { realm: { from: number; to: number }; label: string } | null = null;
/** the query that scope belongs to: re-running the SAME query keeps it */
let snippetScopeQuery = '';

/** directory tree state (one entry per `<樹>` declaration) */
interface DirTree {
  tree: SearchTree;
  roots: TreeNode[];
  nodes: number;
  labels: Map<number, string>;
  open: Set<number>;
  /** child VA -> parent VA, for lighting the ancestors of the scroll cursor */
  parentOf: Map<number, number>;
  loaded: boolean;
}
let dirTrees: DirTree[] = [];
/** where the background directory-tree build spends its time (diagnostics) */
let treePhases: Record<string, number> = {};
let dirActive = 0;
let dirError = '';
let dirLoading = false;

const fmtInt = (n: number) => n.toLocaleString('en-US');
const fmtBytes = (n: number) => {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KiB';
  return (n / 1048576).toFixed(2) + ' MiB';
};
const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/** Show a name that may contain lone surrogates / embedded NULs sensibly. */
function displayName(name: string): string {
  const nul = name.indexOf('\0');
  const cut = nul >= 0 ? name.slice(0, nul) : name;
  const units = [...cut].map((ch) => {
    const c = ch.charCodeAt(0);
    if (c >= 0xd800 && c <= 0xdfff) return '\u25a1';
    if (c < 0x20) return '\u2400' + String.fromCharCode(c + 0x40);
    return ch;
  }).join('');
  return nul >= 0 ? units + '…' : units;
}

function setStatus(msg: string, kind: 'info' | 'err' | 'busy' = 'info') {
  const el = $('#status');
  el.textContent = msg;
  el.className = 'status ' + kind;
}

function containerSummary(c: Container) {
  return `${c.count} blocks · ${fmtBytes(c.totalBlockSize)}` + (c.blockSize ? ` · fixed ${c.blockSize}` : ' · var');
}

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
let lastOpen: {
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

async function openFile(file: File) {
  // A load may be triggered twice by the picker (the browser fires `change`, and
  // callers often dispatch one as well). Without this guard the second run would
  // rebuild and discard the directory trees the first one produced.
  if (opening) return;
  opening = true;
  dirTrees = [];
  dirError = '';
  docFontSized = false;
  // a new database invalidates every derived line/VA cache and every open tab
  boundsCache.clear();
  paintAsked.clear();
  folioCache = null;
  labelTables.clear();
  cursorNode = null;
  docTabs = [];
  docActive = 0;
  pinnedHit = null;
  lastReveal = '';
  const T0 = performance.now();
  const io = new BlobIO(file);
  try {
    setStatus(`讀取 ${file.name} …`, 'busy');
    const t0 = performance.now();
    reader = await AdbReader.open(io);
    const openMs = performance.now() - t0;

    const h = reader.header;
    // the file picker is only needed before a database is open; afterwards the
    // Chinese name in the header is the way to open another one
    document.body.classList.add('loaded');
    const nameBtn = $('#dbname') as HTMLButtonElement;
    nameBtn.hidden = false;
    nameBtn.textContent = h.dbcname || h.dbname;
    renderMeta(reader, openMs, 0, 0, 0);
    renderContainers(reader);

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
    const t2b = performance.now();
    const anchorCount = await mapper.loadAnchors();
    void anchorCount;                      // kept for the meta pane / diagnostics
    const anchorMs = performance.now() - t2b;
    session = new SearchSession(reader);

    const t3 = performance.now();
    docs = await reader.documents();
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
    dirLoading = true;
    lastTreeMs = 0;
    const tTree = performance.now();
    void loadDirectoryTrees().catch((e) => {
      dirError = String((e as Error)?.stack ?? e);
      console.error('directory tree failed', e);
      void renderDirTree();
    }).finally(() => {
      dirLoading = false;
      lastTreeMs = performance.now() - tTree;
      if (lastOpen) lastOpen.treeMs = lastTreeMs;
      void renderDirTree();
    });
    lastResult = null;
    summaryResult = null;
    snippetScope = null;
    snippetScopeQuery = '';
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
}

// -------------------------------------------------------------- full text search
/**
 * Live search. Each keystroke re-runs the query; the posting list of every token
 * already seen is cached by `SearchSession`, so typing one more character only
 * costs the new token's block read plus the phrase pass.
 */
async function runSearch(query: string) {
  if (!session || !mapper) return;
  const seq = ++searchSeq;
  void renderFreq();   // the 頻次 tab re-groups on every search
  const q = query.trim();
  if (!q) {
    lastResult = null;
    summaryResult = null;
    snippetScope = null;
    snippetShown = SNIPPET_LIMIT;
    refreshTreeHits();   // no search: the badges go back to the child counts
    $('#searchList').innerHTML = '';
    $('#searchMeta').textContent = '';
    $('#searchMore').textContent = '';
    return;
  }
  const res = await session.search(q);
  if (seq !== searchSeq) return;          // a newer keystroke won
  // A keystroke may land while a node-scoped summary is on screen (the debounce
  // can outlive a click). The same query keeps the scope — that re-search was
  // already in flight when 命中數 was clicked — only a DIFFERENT query drops it.
  if (snippetScope && snippetScopeQuery !== q) {
    snippetScope = null;
    snippetScopeQuery = '';
  }
  lastResult = res;
  summaryResult = res;
  snippetShown = SNIPPET_LIMIT;
  refreshTreeHits();   // the badges are hit counts: repaint them with THIS result
  await renderSearchResult(res, seq);
}

async function renderSearchResult(res: SearchResult, seq: number) {
  const meta = $('#searchMeta');
  activeGroup = -1;
  const scoped = snippetScope && snippetScopeQuery === res.query ? snippetScope : null;
  if (snippetScope && !scoped) {
    snippetScope = null;
    snippetScopeQuery = '';
  }
  if (res.missing.length) {
    meta.textContent = `「${res.query}」：索引中沒有 ${res.missing.map((m) => `「${m}」`).join('、')}`;
    $('#searchList').innerHTML = '';
    $('#searchMore').textContent = '';
    return;
  }
  if (scoped) {
    // a node's 命中數 is the active scope: keep its header even when the SAME
    // query is re-run (the debounce may land just after the click)
    await showNodeHits(scoped.realm, scoped.label, realmHits(scoped.realm.from, scoped.realm.to));
    return;
  }
  const groupInfo = res.groups.length ? `，分 ${fmtInt(res.groups.filter((g) => g.count).length)} 群（依 ${res.groupTag}）` : '';
  const nodeHint = '<span class="dim">｜輸入只更新摘要，本文要點目錄節點的命中數或摘要</span>';
  meta.innerHTML = escapeHtml(`${res.tokens.map((t) => t.token).join(' + ')}（詞組，${fmtInt(res.hits.length)} 筆命中${res.truncated ? ' 以上' : ''}${groupInfo}，${res.ms.toFixed(0)} ms）`) + nodeHint;
  await renderSnippets(seq);
}

/**
 * The 摘要 pane: the first `snippetShown` hits of the current result. With no
 * scope it lists the whole result (top 30 after an input update); with a scope
 * (a directory node's 命中數 was clicked) only that node's realm is shown.
 *
 * Typing MUST NOT move the document: this function therefore never links to the
 * text. Only a click on a summary card (or the 命中數 badge) does.
 */
async function renderSnippets(seq: number) {
  const res = summaryResult ?? lastResult;
  if (!res || !mapper) return;
  const list = $('#searchList');
  const realm = snippetScope?.realm;
  let pool = activeGroup >= 0 ? res.hits.filter((h) => inGroup(res, h.va, activeGroup)) : res.hits;
  if (realm) pool = pool.filter((h) => h.va >= realm.from && h.va < realm.to);
  const show = pool.slice(0, snippetShown);
  const cards: string[] = [];
  for (const hit of show) {
    const s = await searchSummary(mapper, hit.va, hit.units);
    if (seq !== searchSeq) return;        // superseded while building snippets
    if (!s) { cards.push(`<div class="snippet"><div class="snippetHead">VA ${fmtInt(hit.va)}：無法定位</div></div>`); continue; }
    const before = escapeHtml(s.text.slice(0, s.start));
    const mid = escapeHtml(s.text.slice(s.start, s.end));
    const after = escapeHtml(s.text.slice(s.end));
    cards.push(`<div class="snippet" data-va="${hit.va}" data-units="${hit.units}">
        <div>${before}<mark>${mid}</mark>${after}</div>
      </div>`);
  }
  list.innerHTML = cards.join('');
  list.querySelectorAll<HTMLElement>('.snippet').forEach((el) => {
    el.onclick = (ev) => {
      list.querySelectorAll('.snippet').forEach((x) => x.classList.toggle('active', x === el));
      // the summary is the reader's context: make sure the right column is visible
      setSide('right', true);
      showTab('sum', 'right');
      // Ctrl (Cmd) + click opens the hit in a NEW document tab
      void revealHit(
        Number(el.dataset.va),
        (summaryResult ?? lastResult)?.tokens.map((t) => t.token).join('') ?? '',
        Number(el.dataset.units),
        mods(ev),
      );
    };
  });
  const more = $('#searchMore');
  const scopeNote = snippetScope ? `「${displayName(snippetScope.label)}」內 ` : (activeGroup >= 0 ? '此群 ' : '');
  more.textContent = pool.length > show.length
    ? `顯示前 ${fmtInt(show.length)} 筆（${scopeNote}共 ${fmtInt(pool.length)} 筆）；捲到底載入更多`
    : `${scopeNote}共 ${fmtInt(pool.length)} 筆`;
  // No auto-jump: the document is linked by an explicit click (requirement 一).
}

/**
 * Repaint the directory tree's hit badges after the query changed.
 *
 * The badges are the search hit counts, so they must move with the input; they used
 * to stay on the previous query (or on the child count) until a node was reopened.
 * Only the rendered rows are rebuilt, and only when the 目錄 pane is on screen.
 */
function refreshTreeHits(): void {
  const btn = $('#colLeft .tabBtn[data-tab="dir"]') as HTMLElement | null;
  if (!btn || btn.hidden || getComputedStyle(btn).display === 'none' || !dirTrees.length) return;
  if (!$('#dirTree')) return;
  void renderDirTree();
}

/**
 * Show the hits of ONE directory node in the 摘要 pane (a click on its 命中數).
 *
 * The node's VA range is the filter, and the label travels with the scope so the
 * header can say which node is being shown.
 */
async function showNodeHits(
  realm: { from: number; to: number },
  label: string,
  count: number,
  res: SearchResult | null = lastResult,
  query?: string,
): Promise<void> {
  setSide('right', true);       // the summary must be visible to be useful
  showTab('sum', 'right');
  const meta = $('#searchMeta');
  if (!res) {
    meta.textContent = `「${displayName(label)}」：尚未輸入搜尋詞`;
    return;
  }
  // The pane shows THIS result: 頻次／全文 searches on its own input, so its rows
  // must not be filtered against a 目錄 query that may be a different word.
  summaryResult = res;
  snippetScope = { realm, label };
  // the query the user is searching for RIGHT NOW: a debounced search of the same
  // text may still be in flight, and it must keep this scope rather than replace
  // the pane with the unscoped result
  snippetScopeQuery = (query ?? ($('#query') as HTMLInputElement | null)?.value ?? res.query).trim();
  snippetShown = SNIPPET_LIMIT;
  meta.innerHTML = `「${escapeHtml(displayName(label))}」範圍內 <b>${fmtInt(count)}</b> 筆命中（共 ${fmtInt(res.hits.length)} 筆；點摘要才會聯動本文）`;
  // pass a LIVE sequence number: a re-search may be in flight, and renderSnippets
  // drops its work when the sequence has moved on
  await renderSnippets(searchSeq);
}

/** true when `va` falls inside group `gi`'s VA range */
function inGroup(res: SearchResult, va: number, gi: number): boolean {
  const g = res.groups[gi];
  return !!g && va >= g.from && va < g.to;
}

function renderMeta(r: AdbReader, openMs: number, tokenMs: number, layoutMs: number, docsMs: number) {
  const h: AdbHeader = r.header;
  const rows: [string, string][] = [
    ['檔名', h.dbname], ['顯示名', h.dbcname], ['檔案大小', fmtBytes(h.size)],
    ['壓縮', h.compression === 0 ? '無' : 'bzip2（每塊獨立）'],
    ['source 塊大小', fmtBytes(h.srcBlockSize)],
    ['source 塊數', fmtInt(r.containers.get('source')?.count ?? 0)],
    ['VA 總長', fmtInt(h.maxBlockOffset)], ['行數', fmtInt(h.lineCount)],
    ['tag 命中（header）', fmtInt(h.tagCount)],
    ['版本 / 類型', `v${h.version} / ${h.isDictionary ? '字典庫' : '一般'}${(h.dbType & 4) ? ' · hidden' : ''}`],
    ['CRC32', h.version >= 0x50902 ? h.crc32.toString(16) : `${h.crc32.toString(16)}（v < 0x50902，未校驗）`],
  ];
  $('#meta').innerHTML = `<table>${rows.map(([k, v]) => `<tr><th>${k}</th><td>${escapeHtml(String(v))}</td></tr>`).join('')}</table>
    <p class="note">開啟 ${openMs.toFixed(0)} ms ｜ token 索引 ${tokenMs.toFixed(0)} ms ｜ VA 表 ${layoutMs.toFixed(0)} ms ｜ 文件清單 ${docsMs.toFixed(0)} ms</p>`;

  // 容量 tab
  const c = r.containers;
  const cap: [string, string, string][] = [];
  for (const n of r.order) {
    const x = c.get(n)!;
    cap.push([n, fmtInt(x.count) + ' 塊', fmtBytes(x.totalBlockSize)]);
  }
  cap.push(['tokens 名稱表', '', fmtBytes((c.get('tokens')?.totalBlockSize ?? 0) - ((c.get('tokens')?.ends?.[(c.get('tokens')?.count ?? 1) - 1] ?? 0)))]);
  cap.push(['文字總量', fmtInt(h.lineCount) + ' 行', '']);
  cap.push(['VA 空間', fmtInt(h.maxBlockOffset), '']);
  $('#capacity').innerHTML = `<table class="cap"><tr><th>容器</th><th>區塊</th><th>大小</th></tr>
    ${cap.map(([a, b, d]) => `<tr><td>${escapeHtml(a)}</td><td>${escapeHtml(b)}</td><td>${escapeHtml(d)}</td></tr>`).join('')}</table>`;
}

function renderContainers(r: AdbReader) {
  $('#containers').innerHTML = r.order.map((n) => {
    const x = r.containers.get(n)!;
    return `<li><b>${n}</b> <span class="dim">${containerSummary(x)}</span></li>`;
  }).join('');
}

const THUMB_LIMIT = 48;

async function renderResources() {
  const c = reader?.containers.get('resources');
  const box = $('#resources');
  if (!c || !c.count) { box.innerHTML = '<p class="dim">（此庫沒有 resources）</p>'; return; }
  const n = Math.min(c.count, THUMB_LIMIT);
  box.innerHTML = `<p class="note">${fmtInt(c.count)} 個資源，${fmtBytes(c.totalBlockSize)}（未壓縮，可直接讀單一資源）</p>
    <p class="note" id="thumbNote">載入前 ${n} 張縮圖…</p>`;
  const list = document.createElement('div');
  list.className = 'thumbGrid';
  box.appendChild(list);
  for (let i = 0; i < n; i++) {
    const { name, bytes } = await reader!.resourceBytes(i);
    const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
    const cell = document.createElement('div');
    cell.className = 'thumb';
    cell.title = name;
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].includes(ext)) {
      const url = URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer], { type: 'image/' + (ext === 'svg' ? 'svg+xml' : ext) }));
      cell.innerHTML = `<img src="${url}" alt="">`;
    } else {
      cell.innerHTML = `<div class="dim">${escapeHtml(ext || '?')}</div>`;
    }
    const label = document.createElement('span');
    label.textContent = name.split('/').pop() ?? name;
    cell.appendChild(label);
    list.appendChild(cell);
    if ((i & 15) === 15) await new Promise((r) => setTimeout(r, 0));
  }
  const note = $('#thumbNote');
  if (note) note.textContent = c.count > n ? `已載入前 ${n} 張（共 ${c.count}）` : `已載入 ${n} 張`;
}

// ------------------------------------------------------------------ documents
function renderDocs() {
  const box = $('#docs');
  if (!docs.length) { box.innerHTML = '<p class="dim">（無 檔 標籤：單檔庫；可直接用下方搜尋結果定位）</p>'; return; }
  box.innerHTML = docs.map((d) => `<button class="docItem" data-i="${d.i}">
      <span class="docName">${escapeHtml(displayName(d.name))}</span>
      <span class="dim">VA ${fmtInt(d.vaStart)}</span></button>`).join('');
  box.querySelectorAll<HTMLButtonElement>('.docItem').forEach((el) => {
    el.onclick = () => {
      const i = Number(el.dataset.i);
      const d = docs[i];
      if (!d) return;
      // find the first line of that document and show it (no hit to paint)
      const line = mapper!.linesVirtual.findIndex((v) => v >= d.vaStart);
      void showLine(line < 0 ? 0 : line, d.vaStart);
    };
  });
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

/** Ctrl (or Cmd on a Mac) held on an event: open the link in a NEW tab. */
const newTabKey = (ev?: { ctrlKey?: boolean; metaKey?: boolean }): boolean =>
  !!ev && (!!ev.ctrlKey || !!ev.metaKey);
/** Alt held on an event: the old "expand every descendant" (setOpenAll). */
const altKey = (ev?: { altKey?: boolean }): boolean => !!ev && !!ev.altKey;
/** the modifiers a programmatic link should honour */
const mods = (ev?: { ctrlKey?: boolean; metaKey?: boolean }): { newTab?: boolean } | undefined =>
  newTabKey(ev) ? { newTab: true } : undefined;

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

/**
 * The deepest directory node that contains a VA (its realm is the node's range).
 *
 * Siblings are disjoint and VA-ascending, so this is a descent with a binary
 * search per level — O(depth × log width) instead of walking every node (fgdict
 * has 29,614 of them, and this runs on every link AND on every scroll settle).
 */
function deepestNode(va: number, roots = dirTrees[dirActive]?.roots ?? []): TreeNode | null {
  let cur: TreeNode | null = null;
  let list = roots;
  for (let guard = 0; guard < 32 && list.length; guard++) {
    let lo = 0, hi = list.length - 1, at = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].va <= va) { at = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (at < 0) break;
    const n = list[at];
    if (va >= n.vaEnd) break;
    cur = n;
    list = n.children;
  }
  return cur;
}

/** a node's display name (labels are resolved lazily per tree) */
function nodeLabelOf(node: TreeNode): string {
  const d = dirTrees[dirActive];
  return (d && (d.labels.get(node.va) || node.label)) || '#' + node.index;
}

function nodeContaining(va: number): { realm: { from: number; to: number }; name: string; node: TreeNode } | null {
  const n = deepestNode(va);
  return n ? { realm: { from: n.va, to: n.vaEnd }, name: nodeLabelOf(n), node: n } : null;
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
 * Point the document pane at a VA (the "聯動本文" action).
 *
 * `opts.newTab` (Ctrl/Cmd) opens a fresh tab. `opts.mode === 'node'` forces the
 * realm to be the directory node that contains the VA even when the current tab
 * already covers it (a terminal node has an empty realm, so it must not become
 * the tab's realm). Otherwise the current tab is kept when it already contains
 * the hit, which is what keeps clicks inside one chapter in one tab.
 */
async function linkTo(va: number, token: string, units: number | undefined, opts: { newTab?: boolean; exact?: boolean; phrase?: string; noMark?: boolean; name?: string; mode?: 'reuse' | 'node' | 'hit' } = {}): Promise<void> {
  if (!mapper) return;
  const el = await mapper.elementAt(va);
  if (!el) { setStatus('VA ' + fmtInt(va) + '：找不到對應位置', 'err'); return; }
  const u = Math.max(1, units ?? el.element.vaUnits);

  const doc = docOfVa(va);
  const node = nodeContaining(va);
  const firstLink = docTabs.length === 0;
  const useNode = !!node && (opts.mode === 'node' || !docTabs.length);
  // Without a node the realm is the owning `<檔>` — NOT the whole VA space: in a
  // multi-document database the page range must be expressed in that document's
  // lines, or every page would be clamped to a single line.
  const whole: { from: number; to: number } = docs.length ? { from: doc.vaStart, to: doc.vaEnd } : wholeRealm();
  // A node may drift a few VA units past its `<檔>`'s boundary (fgdict does); the
  // page range is computed from the line table, so the realm must be clamped to
  // the document that is actually read, or the page would clamp to one line.
  const raw = useNode ? node!.realm : whole;
  const realm = {
    from: Math.max(raw.from, whole.from),
    to: Math.min(raw.to, whole.to),
  };
  if (realm.to <= realm.from) { realm.from = whole.from; realm.to = whole.to; }
  // The tab label must mean something to a reader: the node that was linked, or the
  // TERM/token that was clicked. The XML file name (Fgdict1.xml) is an implementation
  // detail, so it is only the last resort.
  // The clicked label wins: it is what the reader pointed at, and on a drifting
  // database the node's own label can be a neighbouring entry's text.
  const name = opts.name || token || (useNode ? node!.name : (el.element.text || doc.name || reader?.header.dbname || ''));
  const cur = docSession();
  const covers = !!cur && realm.to > realm.from && realm.from >= cur.realm.from && realm.to <= cur.realm.to;
  // Ctrl/Cmd means "open a NEW document tab" (requirement 三): it must open one even
  // when the current tab already covers the realm, otherwise the key silently does
  // nothing on a node inside the tab being read.
  const s = opts.newTab
    ? sessionFor(realm, name, true)
    : (firstLink || !covers ? sessionFor(realm, name, false) : cur!);

  s.doc = doc;
  // A reused tab is renamed to what was just clicked: the pane now shows THAT node/
  // segment/page, and the label must say so (it used to keep the first link's name).
  if (s.name !== name) {
    s.name = name;
    renderDocTabs(s);
  }
  // The mapper's walk can drift a few VAs from the stored VA table (fgdict and
  // yinshun both do), so an element's line may fall outside the realm's line
  // range. Snap it back inside, or the page would not contain the pinned line.
  const rb = boundsOfRealm(realm);
  // the LINE comes from the line table, not from the mapper's walk: the walk drifts
  // on fgdict and a tag click would land one line high (or on another entry)
  let line = mapper.lineOfVa(va);
  if (line < rb.first || line > rb.last) line = rb.first;
  // `exact` paints a phrase by TEXT inside the line (the only walk-independent way
  // on fgdict); `phrase` paints something other than the label (全文 pane: label
  // 法王家, hit 法王); `noMark` links to a spot without painting (原書分頁).
  s.pinned = {
    va, text: el.element.text, token, units: u, line,
    exact: !!opts.exact || !!opts.phrase, phrase: opts.phrase, noMark: !!opts.noMark,
  };
  pinnedHit = s.pinned;
  lastReveal = `va=${va} units=${u} element=${el.element.va}/${el.element.vaUnits}`;
  docActive = docTabs.indexOf(s);

  const tLink = performance.now();
  const auto = (await ensurePage(s, line)).auto;
  // Bring the linked line into the viewport: a page holds up to 200 lines and the
  // target can sit below the fold (the 原書分頁 marker is the common case).
  document.getElementById('L' + s.pinned.line)?.scrollIntoView({ block: 'center' });
  const ensureMs = performance.now() - tLink;
  paintTreeActive();
  lastLink = { va, ensureMs: Math.round(ensureMs), totalMs: Math.round(performance.now() - tLink), rows: s.cache?.dt?.lines.length ?? 0 };
  // On the first render of a database, keep the user's size but otherwise pick
  // one that keeps most hard lines from soft-wrapping.
  if (!docFontSized) {
    docFontSized = true;
    if (localStorage.getItem(DOCFS_KEY) === null) autoFitFont();
  }
  // label carries the directory node's name (a tag click has no text of its own)
  const what = s.name || token || el.element.text;
  const totalRows = boundsOfRealm(s.realm).total;
  const pageInfo = s.cache
    ? '（共 ' + fmtInt(totalRows) + ' 行，第 ' + fmtInt(s.page + 1) + ' / ' + fmtInt(pageBounds(s.realm, s.page).pages) + ' 頁' + (auto ? '，自動跟隨命中' : '') + '）'
    : '';
  setStatus(displayName(what) + '：第 ' + fmtInt(line) + ' 行' + pageInfo, 'info');
}

/** a search/summary link: the same action, plus the "snippet" token name */
async function revealHit(va: number, token: string, units?: number, opts: { newTab?: boolean; exact?: boolean; phrase?: string; noMark?: boolean; name?: string; mode?: 'reuse' | 'node' | 'hit' } = {}): Promise<void> {
  return linkTo(va, token, units, opts);
}

/** the public "show the document containing line `line`" entry point (文件 list) */
async function showLine(line: number, va: number, units?: number): Promise<void> {
  if (!mapper || !reader) return;
  const d = docOfVa(va);
  $('#docs').querySelectorAll('.docItem').forEach((el) => el.classList.toggle('active', Number((el as HTMLElement).dataset.i) === d.i));
  const s = sessionFor({ from: d.vaStart, to: d.vaEnd }, d.name, false);
  s.doc = d;
  s.pinned = { va, text: '', token: d.name, units: Math.max(1, units ?? 1), line };
  pinnedHit = s.pinned;
  docActive = docTabs.indexOf(s);
  await ensurePage(s, line);
}

/** the tree node that the MIDDLE of the document pane currently sits on */
let cursorNode: TreeNode | null = null;
let cursorPending = false;

/**
 * Light the tree for the scroll cursor WITHOUT re-rendering it.
 *
 * The rendered rows can be thousands (an expanded dictionary) and the tree must
 * not move or expand by itself, so this only toggles classes: the cursor node is
 * `current` and every rendered ancestor of it is `ancestor`.
 */
function paintTreeActive(): void {
  const box = $('#dirTree');
  if (!box) return;
  const d = dirTrees[dirActive];
  const path = new Set<number>();
  if (d && cursorNode) {
    for (let va: number | undefined = cursorNode.va; va !== undefined; va = d.parentOf.get(va)) {
      path.add(va);
      if (path.size > 64) break;
    }
  }
  box.querySelectorAll<HTMLElement>('.tRow').forEach((el) => {
    const va = Number(el.dataset.va);
    const isCursor = !!cursorNode && va === cursorNode.va;
    el.classList.toggle('current', isCursor);
    el.classList.toggle('ancestor', !isCursor && path.has(va));
  });
}

/**
 * The line in the vertical MIDDLE of the document pane drives the tree highlight
 * (the first line would light up the node that is scrolling out of view).
 */
function syncCursorFromScroll(): void {
  const body = document.querySelector<HTMLElement>('#docText .docBody');
  if (!body || !mapper) return;
  const mid = body.scrollTop + body.clientHeight / 2;
  let midLine = -1;
  for (const row of body.querySelectorAll<HTMLElement>('.docLine')) {
    const top = row.offsetTop;
    if (top <= mid && mid < top + row.offsetHeight) { midLine = Number(row.id.slice(1)); break; }
  }
  if (midLine < 0) return;
  const node = deepestNode(mapper.linesVirtual[midLine] ?? 0);
  if (node === cursorNode) return;
  cursorNode = node;
  paintTreeActive();
}

/** reopen the tree along the cursor path and scroll that row into view (button) */
async function revealCursorInTree(): Promise<void> {
  const d = dirTrees[dirActive];
  if (!d || !cursorNode) return;
  for (let va: number | undefined = d.parentOf.get(cursorNode.va); va !== undefined; va = d.parentOf.get(va)) {
    d.open.add(va);
  }
  await renderDirTree();
  const row = $('#dirTree .tRow[data-va="' + cursorNode.va + '"]') as HTMLElement | null;
  row?.scrollIntoView({ block: 'center' });
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
  cursorPending = true;
  requestAnimationFrame(() => {
    cursorPending = false;
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
  pinnedHit = t.pinned;
  if (t.cache) renderDoc(t);
  else await ensurePage(t);
  paintTreeActive();
}

/** close a tab; the remaining tabs keep their own page */
function closeDocTab(i: number): void {
  if (i < 0 || i >= docTabs.length) return;
  docTabs.splice(i, 1);
  if (!docTabs.length) {
    pinnedHit = null;
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
function markPhraseInLine(line: number | undefined, phrase: string | undefined, va: number): boolean {
  if (line === undefined || !phrase) return false;
  const node = document.getElementById('L' + line)?.querySelector<HTMLElement>('.lineText')?.firstChild;
  if (!node || node.nodeType !== Node.TEXT_NODE) return false;
  const text = node.textContent ?? '';
  const at = text.indexOf(phrase);
  if (at < 0) return false;
  const range = document.createRange();
  range.setStart(node, at);
  range.setEnd(node, at + phrase.length);
  const mark = document.createElement('mark');
  mark.className = 'docHit';
  mark.dataset.va = String(va);
  try {
    range.surroundContents(mark);
  } catch {
    return false;
  }
  mark.scrollIntoView({ block: 'center' });
  return true;
}

/**
 * Paint `phrase` in the rendered page, starting at `fromLine` and wrapping once.
 *
 * `markPhraseInLine` only looks at the one line the link computed, and on a database
 * whose VA walk drifts (fgdict) that line can be the segment's heading rather than
 * the hit's own line — the query would then silently stay unpainted. The page is
 * always the page that holds the hit, so searching it finds the phrase.
 */
function markPhraseOnPage(phrase: string | undefined, va: number, fromLine: number): boolean {
  if (!phrase) return false;
  const rows = [...document.querySelectorAll<HTMLElement>('#docText .docLine')];
  if (!rows.length) return false;
  const lineOf = (el: HTMLElement) => Number((el.id || '').replace(/^L/, ''));
  const start = Math.max(0, rows.findIndex((r) => lineOf(r) === fromLine));
  for (let i = start; i < rows.length; i++) if (markPhraseInLine(lineOf(rows[i]), phrase, va)) return true;
  for (let i = 0; i < start; i++) if (markPhraseInLine(lineOf(rows[i]), phrase, va)) return true;
  return false;
}

async function paintHit(va: number, units?: number): Promise<void> {
  const s = docSession();
  if (!mapper || !s) return;
  // A node-label link (名詞 / 原書分頁) names the node itself, so marking its text in
  // the line the reader was sent to is walk-independent — and on a drifting database
  // (fgdict) it is the ONLY correct answer: the span path painted an unrelated
  // character on the right line. Search hits and token clicks keep the span path,
  // where the token name can differ from the source text (yinshun normalizes) and
  // the same phrase may occur several times in one line.
  // 原書分頁 only jumps: the `<頁>` marker is a milestone, not a hit, so nothing is
  // painted (linkTo has already scrolled its line into view).
  if (s.pinned?.noMark) return;
  if (s.pinned?.exact) {
    const phrase = s.pinned.phrase ?? s.pinned.token;
    if (markPhraseInLine(s.pinned.line, phrase, va)) return;
    // the linked line can be the segment's heading (fgdict drift): the page holds the
    // hit, so look for the phrase on the page before giving up on marking it
    if (markPhraseOnPage(phrase, va, s.pinned.line)) return;
  }
  let spans = units && units > 1 ? await mapper.phraseSpans(va, units) : await mapper.lineSpans(va);
  if (!spans.length) {
    // A heading TAG carries no inline text span (lineSpans skips tags), so a
    // directory click on `<戊 u="文">` would produce no mark AND no scroll.
    const el = await mapper.elementAt(va);
    if (el?.element.line !== undefined) scrollToVa(va);
    return;
  }
  // The page is chosen by the LINK (linkTo follows the hit explicitly), never by
  // the painter: if the hit is not on the page now on screen, there is simply
  // nothing to mark. Moving the page here made 上一頁／下一頁 impossible.
  if (spans.some((x) => !document.getElementById('L' + x.line))) {
    // The walk's spans can disagree with the line table (fgdict drifts by >1000 VA,
    // so its element lookup returns the wrong text). The reader was sent to the
    // table line, so mark the searched phrase inside THAT line instead.
    markPhraseInLine(s.pinned?.line, s.pinned?.phrase ?? s.pinned?.token, va);
    return;
  }
  let firstMark: HTMLElement | null = null;
  for (const sp of spans) {
    const row = document.getElementById('L' + sp.line);
    const span = row?.querySelector<HTMLElement>('.lineText');
    if (!span) continue;
    const textNode = span.firstChild;
    if (!textNode || textNode.nodeType !== Node.TEXT_NODE) continue;
    const text = textNode.textContent ?? '';
    const start = Math.max(0, Math.min(text.length, sp.start));
    const end = Math.max(start, Math.min(text.length, sp.end));
    if (end <= start) continue;
    const range = document.createRange();
    range.setStart(textNode, start);
    range.setEnd(textNode, end);
    const mark = document.createElement('mark');
    mark.className = 'docHit';
    mark.dataset.va = String(va);
    try {
      range.surroundContents(mark);
    } catch {
      continue;
    }
    if (!firstMark) firstMark = mark;
  }
  (firstMark ?? document.getElementById('L' + (spans[0]?.line ?? 0)))?.scrollIntoView({ block: 'center' });
  scheduleCursorSync();
}

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

// ------------------------------------------------------------------ directory tree
/**
 * Load the `<樹>` trees: tier instances, then the nesting. Labels are filled in
 * once per tree (a label means walking source text for an `n=` child tag, since
 * yinshun has no `書.n` attribute). One `<樹>` declaration becomes one tab.
 */
/**
 * Per-tag label table, taken from the CONTAINERS instead of the source.
 *
 * A label used to cost a VA→PA walk per node (`mapper.nodeLabel`), and fgdict's
 * folio tree has 6,966 instances — that walk was the ~1 s delay before the 名詞
 * pane could appear. The values are already stored: `caches/<tag>` in instance
 * order (fgdict's 書 = 7 book titles), else the `<tag>.n` / `<tag>.id` attribute
 * table (fgdict's 頁.n = the 6,959 page labels). Both cost ONE container read, so
 * the source walk is kept only as the last resort (yinshun stores neither).
 */
const labelTables = new Map<string, { vas: number[]; names: string[] } | null>();

async function labelTableFor(tag: string): Promise<{ vas: number[]; names: string[] } | null> {
  const known = labelTables.get(tag);
  if (known !== undefined) return known;
  const vas = await tagVas(tag);
  let names = vas.length ? await reader!.cachedStrings(tag) : [];
  if (names.length !== vas.length) {
    for (const attr of ['n', 'id']) {
      const m = await loadInstanceAttrs(reader!, tag, attr);
      if (!m.size) continue;
      names = vas.map((_, i) => m.get(i) ?? '');
      if (names.some(Boolean)) break;
    }
  }
  // Always keep the VA list: when the values are not stored (yinshun has neither
  // `caches/<tag>` nor `<tag>.n`), the caller resolves the label from the LINE TABLE
  // with `wrappedText` — one line read instead of `nodeLabel`'s VA walk (~150 µs).
  const table = vas.length ? { vas, names: names.length === vas.length ? names : [] } : null;
  labelTables.set(tag, table);
  return table;
}

/**
 * One node's label: the stored table first, then the text its tag wraps (read from
 * the LINE TABLE — \`nodeLabel\` walks the VA space and costs ~150 µs per node).
 */
async function labelFor(tag: string, va: number, vaEnd: number): Promise<string> {
  const table = await labelTableFor(tag);
  if (table) {
    const i = lowerBound(table.vas, va);
    if (table.vas[i] === va && table.names[i]) return table.names[i];
    const wrapped = await wrappedText(tag, va, table.vas);
    if (wrapped) return wrapped;
  }
  return (await mapper!.nodeLabel(va, vaEnd)) || '';
}

async function loadDirectoryTrees() {
  // Guard against a second call: openFile can be re-entered (e.g. a drop while a
  // load is still running) and re-running would discard the trees already built.
  if (dirTrees.length) return;
  if (!reader) return;
  const tTree0 = performance.now();
  const phase: Record<string, number> = { trees: 0, load: 0, build: 0, instances: 0 };
  treePhases = phase;
  const declared = session?.trees?.length ? session.trees : await loadTrees(reader);
  for (const t of declared) {
    if (!t.tiers.length) continue;
    // The indexer may have stored the tier-1 names as a string table (`caches/書`
    // for fgdict: 7 entries in instance order). When the table lines up with the
    // instances exactly, use it — it is the same text nodeLabel hunts for, but one
    // container parse instead of a source walk per node.
    const firstTag = t.tiers[0] ?? '';
    const firstVas = firstTag ? await tagVas(firstTag) : [];
    const firstNames = firstTag ? await reader.cachedStrings(firstTag) : [];
    const namesOk = firstNames.length > 0 && firstNames.length === firstVas.length;
    const tLoad = performance.now();
    const instances = await loadTree(reader, t, {
      // Only the ENTRY tier is labelled here: yinshun's deeper tiers are ~20,000
      // labels ≈ 2.7 s, and nobody sees them until a node is expanded. The renderer
      // resolves a row's label when it draws it (and fills `d.labels` for the row).
      entryLabelsOnly: true,
      label: async (va, vaEnd, _attrs, tag) => {
        if (namesOk) {
          const i = lowerBound(firstVas, va);
          if (firstVas[i] === va && firstNames[i]) return firstNames[i];
        }
        return labelFor(tag, va, vaEnd);
      },
    });
    phase.load += performance.now() - tLoad;
    phase.instances += instances.length;
    if (!instances.length) continue;
    const tBuild = performance.now();
    const roots = buildTree(instances);
    // loadTree stops labelling after MAX_LABEL_NODES (fgdict has 29,614 instances,
    // so its last two books lost their names). The cached string table is free, so
    // fill the first-tier labels again from it.
    if (namesOk) {
      for (const node of iterNodes(roots)) {
        if (node.tag !== firstTag) continue;
        const i = lowerBound(firstVas, node.va);
        if (firstVas[i] === node.va && firstNames[i]) node.label = firstNames[i];
      }
    }
    // share the labels with the search grouping, so a book has one name
    const byTag = new Map<string, string[]>();
    for (const node of iterNodes(roots)) {
      const list = byTag.get(node.tag) ?? [];
      list.push(node.label || `#${node.index}`);
      byTag.set(node.tag, list);
    }
    for (const [tag, labels] of byTag) mapper.treeLabels.set(tag, labels);
    const parentOf = new Map<number, number>();
    for (const n of iterNodes(roots)) for (const c of n.children) parentOf.set(c.va, n.va);
    phase.build += performance.now() - tBuild;
    dirTrees.push({
      tree: t, roots, nodes: countNodes(roots),
      labels: new Map<number, string>(), open: new Set<number>(), loaded: false,
      parentOf,
    });
  }
  // The 目錄 pane shows the FULL-TEXT tree (`s="*"`); 頻次 and 西文 have their own
  // panes driven by their own scopes. Fall back to the first tree with tiers.
  dirActive = dirTrees.findIndex((d) => d.tree.fullText && d.tree.tiers.length > 0);
  if (dirActive < 0) dirActive = dirTrees.findIndex((d) => d.tree.tiers.length > 0);
  if (dirActive < 0) dirActive = 0;
  syncTreeTabs();
  // Render only when the 目錄 pane exists AND is on screen. fgdict declares no
  // `s="*"` (so the tab is hidden) and its folio tree holds 88k instances: building
  // those rows into a hidden pane cost ~6 s of the main thread. The pane renders
  // lazily, when the reader switches to it.
  const dirBtn = $('#colLeft .tabBtn[data-tab="dir"]') as HTMLElement | null;
  const tRender = performance.now();
  phase.rendered = dirBtn && !dirBtn.hidden ? 1 : 0;
  if (phase.rendered) await renderDirTree();
  phase.render = performance.now() - tRender;
  phase.trees = performance.now() - tTree0;
  treePhases = phase;
}

function countNodes(ns: TreeNode[]): number {
  let n = 0;
  for (const x of ns) n += 1 + countNodes(x.children);
  return n;
}

/**
 * The left column's tabs are declared by the database's `<樹>` tags — one tab per
 * declaration, named after the scope:
 *
 *   s="*"          → 目錄        the tier tree + full-text search
 *   s="$詞"        → 名詞        the `<詞>` instances as a term list (dictionary lookup)
 *   s="*u=文"      → 頻次        hits per `<tag u="文">` segment, sorted by count
 *   s="*詞"        → 全文        hits per `<詞>` segment (tag-name segment)
 *   s="頁.n"       → 原書分頁    the `<頁>` instances labelled by their `n` attribute
 *   s="~00602000"  → 西文        the codepoint slice
 *
 * A database that declares fewer trees gets fewer tabs, and the first available one
 * becomes the active pane (fgdict has no `s="*"` tree, so it lands on 名詞).
 */
function syncTreeTabs() {
  const kindOf = (scope: string): string => {
    if (/^\*$/.test(scope)) return 'dir';
    if (/^\$/.test(scope)) return 'terms';
    if (/^\*u=/.test(scope) || /^\*[^u]/.test(scope)) return 'freq';
    if (/^~/.test(scope)) return 'latin';
    if (/^[^*/~$]+\.[^.]+$/.test(scope)) return 'folio';
    return '';
  };
  // The tab set comes from the `<樹>` DECLARATIONS, which are known immediately —
  // the instances behind them (and their labels) are built in the background. So the
  // reader's pane can appear at once instead of waiting for the tree to finish.
  const scopes = dirTrees.length
    ? dirTrees.map((d) => d.tree.scope)
    : (session?.trees ?? []).map((t) => t.scope);
  const present = new Map<string, string>();          // kind -> scope
  for (const scope of scopes) {
    const k = kindOf(scope);
    if (k && !present.has(k)) present.set(k, scope);
  }
  for (const kind of ['dir', 'terms', 'freq', 'folio', 'latin']) {
    const scope = present.get(kind);
    const btn = $(`#colLeft .tabBtn[data-tab="${kind}"]`) as HTMLButtonElement | null;
    if (!btn) continue;
    btn.hidden = !scope;
    if (scope) {
      // `*u=…` counts hits per attribute segment (頻次), `*tag` per tag (全文)
      btn.textContent = kind === 'freq' ? (/^\*u=/.test(scope) ? '頻次' : '全文') : btn.textContent;
      btn.title = 's="' + scope + '"';
    }
  }
  // keep the active tab sane: a dictionary has no 目錄 pane at all
  const active = $('#colLeft .tabBtn.active') as HTMLButtonElement | null;
  if (!active || active.hidden) {
    const first = ['dir', 'terms', 'freq', 'folio', 'latin'].find((k) => present.has(k));
    if (first) showTab(first, 'left');
  }
}
/**
 * Hits inside a node's realm `[from, to)`.
 *
 * `phraseMatch` returns the hits in ascending VA order, so the first index is a
 * binary search and the count is a short forward scan — cheap enough to run for
 * every rendered row.
 */
function realmHits(from: number, to: number): number {
  const hits = lastResult?.hits;
  if (!hits?.length) return 0;
  // hits are VA-ascending, so the count is the difference of two lower bounds —
  // a node with thousands of hits must not cost a scan on every rendered row
  const lower = (v: number) => {
    let lo = 0, hi = hits.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (hits[mid].va < v) lo = mid + 1; else hi = mid;
    }
    return lo;
  };
  return lower(to) - lower(from);
}

/** Compact directory tree: 30% colours per depth, no growing whitespace. */
/**
 * The graded hit badge, shared by the tree (<`tCount`>) and the 頻次／全文 list.
 *
 * Graded by BOTH the share of the whole result and the absolute count, so the
 * heaviest nodes shout and a big number never looks small.
 */
function hitBadge(count: number, total: number, where = '', hint = ''): string {
  const share = total ? count / total : 0;
  const shareTier = share >= 0.3 ? 4 : share >= 0.1 ? 3 : share >= 0.03 ? 2 : 1;
  const absTier = count >= 1000 ? 4 : count >= 300 ? 3 : count >= 50 ? 2 : 1;
  const tier = Math.max(shareTier, absTier);
  const big = count >= 1000 ? ' big' : '';
  const title = `${where}${fmtInt(count)} 筆命中（占全體 ${(share * 100).toFixed(1)}%${hint}）`;
  return `<span class="tCount hit t${tier}${big}" title="${title}">${fmtInt(count)}</span>`;
}

async function renderDirTree() {
  const box = $('#dirTree');
  const d = dirTrees[dirActive];
  if (!d || !mapper) {
    box.innerHTML = dirLoading
      ? '<p class="dim">目錄樹建立中…（讀取各層標籤）</p>'
      : '<p class="dim">此庫沒有 <code>&lt;樹&gt;</code> 宣告。</p>';
    return;
  }
  const rows = flattenTree(d.roots, (n) => d.open.has(n.va));
  // Labels are resolved for the ROWS BEING DRAWN (the entry tier first, a node's
  // children when it is expanded) instead of for every node up front.
  for (const r of rows) {
    const n = r.node;
    if (d.labels.has(n.va)) continue;
    // the row's text comes from `d.labels`, so it must be filled even when the node
    // already carries a label
    n.label = n.label || (await labelFor(n.tag, n.va, n.vaEnd));
    d.labels.set(n.va, n.label);
  }
  d.loaded = true;
  // While a search is active the badge is ALWAYS the hit count of this node's realm
  // (`[va, vaEnd)`) — the same number whether the node is open or collapsed. The
  // child count is only shown when there is no search to report on.
  const searching = !!lastResult;
  const totalHits = lastResult?.hits.length ?? 0;
  box.innerHTML = rows.map((r) => {
    const n = r.node;
    const open = d.open.has(n.va);
    const twisty = r.hasChildren ? (open ? '▾' : '▸') : '·';
    const hits = searching ? realmHits(n.va, n.vaEnd) : 0;
    let badge = '';
    if (searching) {
      if (hits > 0) badge = hitBadge(hits, totalHits, '此節點範圍內 ', '；點一下顯示這些命中');
    } else if (r.hasChildren && !open) {
      badge = `<span class="tCount">${fmtInt(n.children.length)}</span>`;
    }
    return `<div class="tRow" data-va="${n.va}">
      <span class="tTwisty">${twisty}</span>
      <span class="tDot" style="background:${depthColor(n.depth)}"></span>
      <span class="tTag">${escapeHtml(n.tag)}</span>
      <span class="tName">${escapeHtml(d.labels.get(n.va) || `#${n.index}`)}</span>
      ${badge}
    </div>`;
  }).join('');
  paintTreeActive();
  box.querySelectorAll<HTMLElement>('.tRow').forEach((el) => {
    const va = Number(el.dataset.va);
    const node = findNode(d.roots, va);
    const hasKids = !!node?.children.length;
    const setOpen = (open: boolean) => {
      if (open) {
        d.open.add(va);
      } else {
        // Collapsing closes the WHOLE branch: otherwise an expanded subtree pops
        // back open the next time this node is expanded.
        d.open.delete(va);
        for (const x of iterNodes(node?.children ?? [])) d.open.delete(x.va);
      }
      void renderDirTree();
    };
    const openAll = () => {
      for (const x of iterNodes(node!.children)) d.open.add(x.va);
      d.open.add(va);
      void renderDirTree();
    };
    // Hit zones come from `closest`, not `ev.target.classList`: the click may
    // land on a text node inside the span.
    //   tTwisty / tDot / tName  開得起來就開，並聯動本文；開著就只關，不動本文
    //   Ctrl/Cmd + 上述任一       聯動本文時改開一個新的本文分頁
    //   Alt + tTwisty/tName        展開全部子孫（舊版是 Ctrl）
    //   tCount                    顯示該節點命中的摘要（不移動本文）
    el.onclick = (ev) => {
      const t = ev.target as HTMLElement | null;
      const onCount = !!t?.closest('.tCount');
      const onNode = !!t?.closest('.tTwisty') || !!t?.closest('.tDot') || !!t?.closest('.tName');
      if (!onCount && !onNode) return;
      const label = node?.label || `VA ${va}`;
      const wantsNewTab = newTabKey(ev);

      // 點 tCount：顯示該節點命中的摘要（功能二：輸入只更新摘要，這裡才是看命中）
      if (onCount) {
        void showNodeHits({ from: va, to: node?.vaEnd ?? va }, label, realmHits(va, node?.vaEnd ?? va));
        void revealHit(va, label, 1, { newTab: wantsNewTab, mode: 'node' });
        return;
      }

      // 聯動本文（點色塊/名稱/開合箭頭都是同一個「打開並聯動」動作）
      const link = () => void revealHit(va, label, 1, { newTab: wantsNewTab, mode: 'node' });
      const open = d.open.has(va);

      if (altKey(ev) && (t?.closest('.tTwisty') || t?.closest('.tName'))) {
        // Alt：展開全部子孫（舊版是 Ctrl）；沒有子節點時退回一般開合
        if (hasKids) { openAll(); link(); return; }
      }
      // 可開就開；已開就只關（收合整枝）。無論開或關，點的是節點本身，
      // 都要聯動本文（點節點名／色塊／箭頭＝同一個「打開並聯動」動作）。
      if (open) setOpen(false);
      else if (hasKids) setOpen(true);
      link();
    };
  });
  const head = $('#dirMeta');
  if (head) {
    const t = d.tree;
    head.textContent = `${t.tiers.join(' › ')}${t.terminalTier >= 0 ? `（${t.tiers[t.terminalTier]} 為末層）` : ''}`
      + `　${fmtInt(d.nodes)} 節點／展開 ${fmtInt(rows.length)} 列`
      + (t.fullText ? '　s="*" 全文' : `　s="${t.scope}"`);
  }
}

/**
 * Depth colour: HSV with the hue rotating over the levels and the value held at
 * ~30%, so depth reads at a glance while every row keeps the same height and
 * indent (no file-manager style growing whitespace).
 */
function depthColor(depth: number): string {
  const hue = (depth * 55) % 360;
  const sat = depth === 0 ? 0.3 : 0.55;
  return `hsl(${hue}, ${Math.round(sat * 100)}%, 32%)`;
}

function* iterNodes(ns: TreeNode[]): Generator<TreeNode> {
  for (const n of ns) { yield n; yield* iterNodes(n.children); }
}

function findNode(ns: TreeNode[], va: number): TreeNode | null {
  for (const n of ns) {
    if (n.va === va) return n;
    const hit = findNode(n.children, va);
    if (hit) return hit;
  }
  return null;
}

function renderTokens(stats: { count: number[]; bytes: number[] }, ms: number) {
  const total = stats.count.reduce((a, b) => a + b, 0);
  const list = showAllClasses ? tokens : tokens.filter((t) => t.cls === 0);
  const head = escapeHtml(reader!.header.dbname);
  $('#tokenSummary').innerHTML = `
    <div class="kv"><span>distinct tokens</span><b>${fmtInt(total)}</b></div>
    <div class="kv"><span>已列出</span><b>${fmtInt(list.length)}</b>${showAllClasses ? '' : ' <span class="dim">(僅漢字)</span>'}</div>
    <div class="kv"><span>索引建立</span><b>${ms.toFixed(0)} ms</b></div>`;
  $('#tokenClasses').innerHTML = CLASS_LABELS.map((label, ci) => `
    <button class="clsChip ${showAllClasses || ci === 0 ? '' : 'dim'}" data-cls="${ci}">
      ${label} <b>${fmtInt(stats.count[ci])}</b> <span class="dim">${fmtBytes(stats.bytes[ci])}</span>
    </button>`).join('') + `<button class="clsChip" id="toggleAll">${showAllClasses ? '只顯示漢字' : '全部載入'}</button>`;
  $('#tokenClasses').querySelectorAll<HTMLButtonElement>('.clsChip[data-cls]').forEach((el) => {
    el.onclick = () => {
      const cls = Number(el.dataset.cls);
      showAllClasses = true;
      hideAllExcept(cls);
      renderTokenList(tokens.filter((t) => t.cls === cls), `${CLASS_LABELS[cls]} 共 ${fmtInt(stats.count[cls])} 個`);
    };
  });
  const toggle = $('#toggleAll') as HTMLButtonElement;
  toggle.onclick = () => {
    showAllClasses = !showAllClasses;
    renderTokens(stats, ms);
    renderTokenList(showAllClasses ? tokens : tokens.filter((t) => t.cls === 0), head);
  };
  hideAllExcept(-1);
  renderTokenList(list, head);
}

/** chip visual state for a single-class view (-1 = all) */
function hideAllExcept(cls: number) {
  $('#tokenClasses').querySelectorAll<HTMLButtonElement>('.clsChip[data-cls]').forEach((el) => {
    el.classList.toggle('dim', cls >= 0 && Number(el.dataset.cls) !== cls);
  });
}

// ------------------------------------------------------------------ 頻次（segments）
/**
 * The `s="*u=文"` tab: hits grouped by the segment tag (yinshun: `<文>`), sorted by
 * hit count. With no query it lists the segments themselves (the name is the text
 * inside the tags); with a query it takes the search's hits, counts them per
 * segment, sorts by that count and hides the zero-hit ones — the "一次不必看太多"
 * view the format was designed for.
 */
async function renderFreq() {
  const meta = $('#freqMeta');
  const list = $('#freqList');
  if (!reader || !mapper || !session) { list.innerHTML = '<p class="dim">尚未開啟資料庫。</p>'; return; }
  const segs = await freqSegments();
  if (!segs.length) {
    meta.textContent = '';
    list.innerHTML = '<p class="dim">此庫沒有 <code>&lt;樹 s="*u=…"&gt;</code> 可用的分段。</p>';
    return;
  }
  // A tag-name scope (`*詞`) wraps every segment with one tag, so the segment name
  // is exactly what that tag wraps; an attribute scope (`*u=文`) needs the
  // leading-text heuristic instead.
  const spec = treeScope(/^\*./).replace(/^\*/, '').trim();
  const segTag = spec && spec.indexOf('=') < 0 ? spec : undefined;
  // 頻次 has its OWN input: the two panes are independent searches.
  const q = ($('#freqQuery') as HTMLInputElement).value.trim();
  /** the rows on screen — a click needs their VA range for the 摘要 scope */
  let rows: { from: number; to: number; name: string; count: number; firstHit?: number }[] = [];
  let res: SearchResult | null = null;
  if (!q) {
    // names are a source walk each, so only the shown slice is resolved
    const slice = segs.slice(0, 200);
    await nameSegs(slice, segTag);
    rows = slice.map((s) => ({ ...s, count: 0 }));
    meta.textContent = `${fmtInt(segs.length)} 段：未輸入條件，列出段名`
      + (segs.length > slice.length ? `（僅列前 ${slice.length}）` : '');
    list.innerHTML = rows.map((s) => `<div class="snippet" data-va="${s.from}"><div><b>${
      escapeHtml(displayName(s.name))}</b></div></div>`).join('');
  } else {
    res = await session.search(q);
    const counts = segs.map((s) => ({ ...s, count: 0, firstHit: -1 }));
    for (const h of res.hits) {
      let lo = 0, hi = counts.length - 1, at = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (counts[mid].from <= h.va) { at = mid; lo = mid + 1; } else hi = mid - 1;
      }
      if (at >= 0 && h.va < counts[at].to) {
        counts[at].count++;
        // remember WHERE the word is: the segment start is its heading, and marking
        // the query there would find nothing (the hit lives further inside)
        if (counts[at].firstHit < 0) counts[at].firstHit = h.va;
      }
    }
    const withHits = counts.filter((c) => c.count > 0);
    const shown = withHits.sort((a, b) => b.count - a.count).slice(0, 200);
    await nameSegs(shown, segTag);
    rows = shown;
    const total = res.hits.length;
    meta.textContent = `「${q}」${fmtInt(total)} 筆命中，分布於 ${fmtInt(withHits.length)} / ${fmtInt(segs.length)} 段`
      + `（依命中數排序，0 不顯示${shown.length < withHits.length ? `，僅列前 ${shown.length}` : ''}）`;
    // The count rides on the SAME line as the name: as its own line it pushed the
    // name down and hid the ranking (the badge is the tree's graded one).
    list.innerHTML = shown.map((s) => `<div class="snippet" data-va="${s.from}">
        <div><b>${escapeHtml(displayName(s.name))}</b> ${hitBadge(s.count, total)}</div></div>`).join('')
      || '<p class="dim">沒有命中。</p>';
  }
  list.querySelectorAll<HTMLElement>('.snippet').forEach((el) => {
    el.onclick = (ev) => {
      const va = Number(el.dataset.va);
      const row = rows.find((h) => h.from === va);
      const name = (el.querySelector('b')?.textContent ?? '').trim();
      // The tab is named after the SEGMENT (法王家) but the jump goes to the first
      // HIT inside it, where the QUERY (法王) is what gets painted.
      const at = row && row.firstHit !== undefined && row.firstHit >= 0 ? row.firstHit : va;
      // token = what gets painted (the query), name = the tab label (the segment)
      void revealHit(at, q || name, 1, { ...(mods(ev) ?? {}), exact: true, phrase: q || undefined, name });
      // the 摘要 pane follows the row that was clicked, scoped to that segment
      if (row) void showNodeHits({ from: row.from, to: row.to }, name, row.count, res, q || undefined);
    };
  });
}

/**
 * The `s="~…"` tab (西文): the tokens of the database restricted to the code-point
 * range the scope names. With no input it lists them; with input it filters by
 * substring, and clicking one jumps to its first occurrence.
 */
async function renderLatin() {
  const meta = $('#latinMeta');
  const list = $('#latinList');
  if (!reader) { list.innerHTML = '<p class="dim">尚未開啟資料庫。</p>'; return; }
  const scope = treeScope(/^~/);
  const range = scope ? parseScope(scope).codepoints : undefined;
  if (!range) {
    meta.textContent = '';
    list.innerHTML = '<p class="dim">此庫沒有 <code>&lt;樹 s="~…"&gt;</code> 宣告。</p>';
    return;
  }
  const [from, to] = range;
  const inRange = tokens.filter((t) => {
    const cp = displayName(t.name).codePointAt(0) ?? 0;
    return cp >= from && cp <= to;
  });
  const q = ($('#latinQuery') as HTMLInputElement).value.trim();
  const hit = q ? inRange.filter((t) => displayName(t.name).includes(q)) : inRange;
  const shown = hit.slice(0, 600);
  const hex = (n: number) => 'U+' + n.toString(16).toUpperCase().padStart(4, '0');
  meta.textContent = `${hex(from)}–${hex(to)} 範圍內 ${fmtInt(inRange.length)} 個 token`
    + (q ? `；「${q}」符合 ${fmtInt(hit.length)} 個` : '')
    + (shown.length < hit.length ? `（僅列前 ${shown.length}）` : '');
  list.innerHTML = shown.map((t) => `<div class="snippet" data-i="${t.i}">
      <div><b>${escapeHtml(displayName(t.name))}</b> <span class="dim">${fmtBytes(t.bytes)}</span></div></div>`).join('')
    || '<p class="dim">沒有符合的 token。</p>';
  list.querySelectorAll<HTMLElement>('.snippet').forEach((el) => {
    el.onclick = () => {
      const t = tokens.find((x) => x.i === Number(el.dataset.i));
      if (t) void showToken(t);
    };
  });
}

/**
 * The segments of a `s="*…"` scope that names one.
 *
 * Two different forms, per the format (and confirmed by the author):
 *
 *   s="*u=文"  → ATTRIBUTE FILTER. `parseTAV` splits `attr=value`, so this picks
 *                the instances carrying `u="文"` — in yinshun the 節-level headings
 *                (`<戊 u="文">`, `<庚 u="文">` …), 6,978 of them across 40 tags.
 *   s="*文"    → TAG NAME. The instances of the `<文>` tag itself (12 in yinshun).
 *
 * Both are answered from the `attributes` / `tags` containers, so neither needs a
 * source scan; names are resolved later and only for the rows actually shown.
 */
async function freqSegments(): Promise<{ from: number; to: number; name: string }[]> {
  if (!reader || !mapper) return [];
  const spec = treeScope(/^\*./).replace(/^\*/, '').trim();
  if (!spec) return [];
  const eq = spec.indexOf('=');
  const attrName = eq > 0 ? spec.slice(0, eq).split('.').pop()!.trim() : '';
  const attrValue = eq > 0 ? spec.slice(eq + 1).trim() : '';
  const tagName = eq > 0 ? '' : spec;
  const attrs = reader.containers.get('attributes');
  const tagsC = reader.containers.get('tags');
  if (!tagsC) return [];
  const tags = new Set<string>();
  if (attrName && attrValue) {
    // attr=value: every `<tag>.<attr>` table whose values contain the value
    for (const key of attrs?.names ?? []) {
      const dot = key.lastIndexOf('.');
      if (dot <= 0 || key.slice(dot + 1) !== attrName) continue;
      const av = await reader.attributeValues(key);
      if (av?.values?.some((v) => v.trim() === attrValue)) tags.add(key.slice(0, dot));
    }
  } else if (tagName) {
    tags.add(tagName);
  }
  const vas: number[] = [];
  for (const tag of tags) {
    const at = tagsC.names.indexOf(tag);
    if (at >= 0) vas.push(...(await reader.decodeBlockList('tags', at)));
  }
  vas.sort((a, b) => a - b);
  const out: { from: number; to: number; name: string }[] = [];
  for (let i = 0; i < vas.length; i++) {
    const from = vas[i];
    const to = i + 1 < vas.length ? vas[i + 1] : reader.header.maxBlockOffset;
    // names are resolved later, and only for the rows actually shown: this set can
    // be thousands of segments and each name is a source walk.
    out.push({ from, to, name: '' });
  }
  return out;
}

/** resolve the display names of the given segments (bounded to the shown slice) */
async function nameSegs(segs: { from: number; to: number; name: string }[], tag?: string): Promise<void> {
  if (!mapper) return;
  if (tag) {
    // The indexer already STORED the innerText of every instance as a string table
    // (`caches/詞` for fgdict, 22,648 entries in instance order). Reading it is one
    // container parse; slicing the same text out of `source` costs a bzip2 decode
    // per block touched, so the cache wins whenever it is present and complete.
    const vas = await tagVas(tag);
    const cached = reader ? await reader.cachedStrings(tag) : [];
    const usable = cached.length === vas.length;
    for (const s of segs) {
      if (s.name) continue;
      if (usable) {
        const i = lowerBound(vas, s.from);
        if (vas[i] === s.from && cached[i]) { s.name = cached[i]; continue; }
      }
      const wrapped = await wrappedText(tag, s.from, vas);
      s.name = wrapped || (await mapper.nodeLabel(s.from, s.to)) || `VA ${s.from}`;
    }
    return;
  }
  for (const s of segs) {
    if (!s.name) s.name = (await mapper.nodeLabel(s.from, s.to)) || `VA ${s.from}`;
  }
}

/** the VA of every instance of one tag (from the `tags` container, ascending) */
async function tagVas(tag: string): Promise<number[]> {
  if (!reader) return [];
  const c = reader.containers.get('tags');
  const at = c?.names.indexOf(tag) ?? -1;
  if (at < 0) return [];
  return (await reader.decodeBlockList('tags', at)).slice().sort((a, b) => a - b);
}

/**
 * The instances of one tag as VA segments. Read straight from the `tags`
 * container, so a 22,648-entry dictionary needs no source scan.
 */
async function tagSegments(tag: string): Promise<{ from: number; to: number; name: string }[]> {
  if (!reader) return [];
  const vas = await tagVas(tag);
  const max = reader.header.maxBlockOffset;
  return vas.map((va, i) => ({ from: va, to: i + 1 < vas.length ? vas[i + 1] : max, name: '' }));
}

/** first index whose value is >= v (values ascending) */
function lowerBound(xs: number[], v: number): number {
  let lo = 0, hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] < v) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/**
 * The text WRAPPED by `<tag>…</tag>` for one instance — sliced out of the cached
 * source block, NOT derived from a VA→PA walk.
 *
 * fgdict's `<詞>一</詞>` is the headword, but the mapper's walk drifts here, so
 * `nodeLabel` returned a neighbouring entry's tail (measured: `<詞>一</詞>`
 * came out as 「』」 一一」). The source text is the ground truth: the line table
 * says which lines hold the instance, the `tags` container says which `<tag>`
 * occurrence on that line this one is, and the block cache supplies the text.
 */
async function wrappedText(tag: string, va: number, tagVasList: number[], maxChars = 60): Promise<string> {
  if (!mapper) return '';
  const line = mapper.edgeLine(va);
  const lineVaStart = line > 0 ? (mapper.linesVirtual[line - 1] ?? 0) : 0;
  let ordinal = 0;
  for (let i = lowerBound(tagVasList, lineVaStart); i < tagVasList.length && tagVasList[i] < va; i++) ordinal++;
  const open = '<' + tag;
  const close = '</' + tag;
  let text = await mapper.lineText(line);
  let at = -1;
  for (let k = 0; k <= ordinal; k++) {
    at = text.indexOf(open, at + 1);
    if (at < 0) return '';
  }
  let end = text.indexOf(close, at);
  // a headword may be split by a hard line break (which costs no VA): keep reading
  for (let more = line + 1; end < 0 && more < line + 6; more++) {
    text += await mapper.lineText(more);
    end = text.indexOf(close, at);
  }
  if (end < 0) return '';
  return text.slice(at, end).replace(/^<[^>]*>/, '').replace(/<[^>]*>/g, '').trim().slice(0, maxChars);
}

/** hits per segment (segments are VA-ascending and disjoint) */
function countHitsPerSegment(segs: { from: number; to: number }[], hits: readonly { va: number }[]): number[] {
  const counts = new Array<number>(segs.length).fill(0);
  for (const h of hits) {
    let lo = 0, hi = segs.length - 1, at = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (segs[mid].from <= h.va) { at = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (at >= 0 && h.va < segs[at].to) counts[at]++;
  }
  return counts;
}

/** the raw `s=` of the first declared tree whose scope matches */
function treeScope(re: RegExp): string {
  const built = dirTrees.find((d) => re.test(d.tree.scope))?.tree.scope;
  if (built) return built;
  // the panes render before the trees are built, so fall back to the declarations
  return (session?.trees ?? []).find((t) => re.test(t.scope))?.scope ?? '';
}

/**
 * 名詞 (`s="$詞"`): the terms the `<詞>` tags wrap, matched the way the format's
 * scheme does — **only against the innerText**, with the position as the mode:
 *
 *   開頭 (^)   the term STARTS with the query
 *   中間       the query occurs inside but neither at the start nor at the end
 *   結尾 ($)   the term ENDS with the query
 *   全部       anywhere
 *
 * The names come from the indexer's own string table (`caches/詞`, 22,648 entries in
 * instance order) — one container parse. Slicing them out of `source` instead costs
 * a bzip2 decode per block touched, and the mapper's VA walk drifts on fgdict.
 */
async function renderTerms(): Promise<void> {
  const meta = $('#termsMeta');
  const list = $('#termsList');
  if (!reader || !session) { list.innerHTML = '<p class="dim">尚未開啟資料庫。</p>'; return; }
  const tag = treeScope(/^\$/).replace(/^\$/, '').trim();
  const segs = tag ? await tagSegments(tag) : [];
  if (!segs.length) {
    meta.textContent = '';
    list.innerHTML = '<p class="dim">此庫沒有 <code>&lt;樹 s="$…"&gt;</code> 的詞條。</p>';
    return;
  }
  const names = await reader.cachedStrings(tag);
  const usable = names.length === segs.length;
  const modeEl = $('#termsMode') as HTMLSelectElement | null;
  const mode = modeEl?.value ?? 'any';
  if (modeEl) modeEl.disabled = !usable;
  const modeName = { any: '全部', start: '開頭', mid: '中間', end: '結尾' }[mode] ?? '全部';
  const q = ($('#termsQuery') as HTMLInputElement).value.trim();

  const hits: { from: number; name: string; count: number }[] = [];
  if (usable && q) {
    // pure table scan: no source read, no full-text search, no VA walk
    for (let i = 0; i < names.length; i++) {
      const n = names[i];
      if (!n || !n.includes(q)) continue;
      const atStart = n.startsWith(q);
      const atEnd = n.endsWith(q);
      if (mode === 'start' && !atStart) continue;
      if (mode === 'end' && !atEnd) continue;
      if (mode === 'mid' && (atStart || atEnd)) continue;
      hits.push({ from: segs[i].from, name: n, count: 0 });
      if (hits.length >= 2000) break;
    }
  }

  if (!q) {
    const slice = segs.slice(0, 200);
    if (usable) for (let i = 0; i < slice.length; i++) slice[i].name = names[i] ?? '';
    else await nameSegs(slice, tag);
    meta.textContent = `${fmtInt(segs.length)} 個詞條（<${tag}> 包住的字）：未輸入條件，列出前 ${fmtInt(slice.length)} 個`;
    list.innerHTML = slice.map((s) => `<div class="snippet" data-va="${s.from}">
        <div><b>${escapeHtml(displayName(s.name))}</b></div></div>`).join('');
  } else if (usable) {
    const shown = hits.slice(0, 300);
    meta.textContent = `「${q}」${modeName}：${fmtInt(hits.length)} 個詞條符合`
      + `（共 ${fmtInt(segs.length)} 個；只比對 <${tag}> 包住的字）`
      + (hits.length > shown.length ? `；僅列前 ${fmtInt(shown.length)}` : '');
    list.innerHTML = shown.map((h) => `<div class="snippet" data-va="${h.from}">
        <div><b>${escapeHtml(displayName(h.name))}</b></div></div>`).join('')
      || '<p class="dim">沒有符合的詞條。</p>';
  } else {
    // no string table in this database: fall back to the full-text search + names
    const res = await session.search(q);
    const counts = countHitsPerSegment(segs, res.hits);
    const withHits = segs.map((s, i) => ({ ...s, count: counts[i] })).filter((s) => s.count > 0)
      .sort((a, b) => b.count - a.count).slice(0, 200);
    await nameSegs(withHits, tag);
    const byName = withHits.filter((s) => displayName(s.name).includes(q));
    const out = byName.length ? byName : withHits;
    meta.textContent = `「${q}」：${fmtInt(withHits.length)} 個詞條有命中（此庫沒有 <${tag}> 字串表，先用內文搜尋）`;
    list.innerHTML = out.map((s) => `<div class="snippet" data-va="${s.from}">
        <div class="snippetHead">${fmtInt(s.count)} 筆</div>
        <div><b>${escapeHtml(displayName(s.name))}</b></div></div>`).join('')
      || '<p class="dim">沒有命中。</p>';
  }
  list.querySelectorAll<HTMLElement>('.snippet').forEach((el) => {
    // pass the TERM as the token: it is what the status shows and what the painter
    // marks inside the line
    const name = (el.querySelector('b')?.textContent ?? tag).trim();
    el.onclick = (ev) => void revealHit(Number(el.dataset.va), name, 1, { ...(mods(ev) ?? {}), exact: true });
  });
}

/** the `頁.n` folio list: label + the VA of that `<頁>` instance (cached) */
let folioCache: { label: string; va: number }[] | null = null;

async function folioEntries(): Promise<{ label: string; va: number }[]> {
  if (folioCache) return folioCache;
  const spec = treeScope(/^[^*/~$]+\.[^.]+$/);
  const dot = spec.lastIndexOf('.');
  if (!reader || dot <= 0) return [];
  const av = await reader.attributeValues(spec);
  const tagsC = reader.containers.get('tags');
  if (!av?.values?.length || !tagsC) return [];
  const byTag = new Map<string, number[]>();
  const out: { label: string; va: number }[] = [];
  for (let i = 0; i < av.values.length; i++) {
    const t = av.tags[i] || spec.slice(0, dot);
    const inst = ((av.pointers?.[i] ?? 0) & 0xffffff) - 1;
    if (inst < 0) continue;
    let list = byTag.get(t);
    if (!list) {
      const at = tagsC.names.indexOf(t);
      if (at < 0) continue;
      list = await reader.decodeBlockList('tags', at);
      byTag.set(t, list);
    }
    const va = list[inst];
    if (va === undefined) continue;
    out.push({ label: av.values[i], va });
  }
  out.sort((a, b) => a.label.localeCompare(b.label, 'en', { numeric: true }));
  folioCache = out;
  return out;
}

/**
 * 原書分頁 (`s="頁.n"`): the `<頁>` instances labelled by their `n` attribute.
 * Pick a folio from the list or type its label; either way the text jumps there.
 */
async function renderFolio(): Promise<void> {
  const meta = $('#folioMeta');
  const list = $('#folioList');
  if (!reader) { list.innerHTML = '<p class="dim">尚未開啟資料庫。</p>'; return; }
  const entries = await folioEntries();
  if (!entries.length) {
    meta.textContent = '';
    list.innerHTML = '<p class="dim">此庫沒有 <code>&lt;樹 s="標籤.屬性"&gt;</code> 的原書分頁。</p>';
    return;
  }
  const q = ($('#folioQuery') as HTMLInputElement).value.trim();
  let hit = entries;
  if (q) {
    const rank = (l: string) => (l === q ? 0 : l.startsWith(q) ? 1 : 2);
    hit = entries.filter((e) => e.label.includes(q));
    hit.sort((a, b) => rank(a.label) - rank(b.label));   // exact match first
  }
  const shown = hit.slice(0, 300);
  meta.textContent = `${fmtInt(entries.length)} 個原書分頁`
    + (q ? `；「${q}」符合 ${fmtInt(hit.length)} 個` : `（可輸入頁碼，列出前 ${fmtInt(shown.length)} 個）`)
    + (shown.length < hit.length ? `；僅列前 ${fmtInt(shown.length)}` : '');
  list.innerHTML = shown.map((e) => `<div class="snippet${q && e.label === q ? ' active' : ''}" data-va="${e.va}">
      <div><b>${escapeHtml(e.label)}</b></div></div>`).join('')
    || '<p class="dim">沒有符合的頁碼。</p>';
  list.querySelectorAll<HTMLElement>('.snippet').forEach((el) => {
    const label = (el.textContent ?? '').trim();
    // 原書分頁 is a milestone, not a hit: jump to the <`頁`> node itself
    // (mode:'node' gives the page its own realm, so the tab is named 1/2/… and a
    // repeat click reuses it instead of opening a second tab) and paint nothing.
    el.onclick = (ev) => void revealHit(Number(el.dataset.va), label, 1, { ...(mods(ev) ?? {}), mode: 'node', noMark: true });
  });
}

const PAGE = 300;
let tokenOffset = 0;
let tokenList: TokenRow[] = [];

function renderTokenList(list: TokenRow[], title: string) {
  tokenList = list;
  tokenOffset = 0;
  $('#tokenTitle').textContent = `${title} · 列出 ${fmtInt(list.length)} 個`;
  $('#tokenRows').innerHTML = '';
  appendTokenRows();
}

function appendTokenRows() {
  const body = $('#tokenRows');
  const end = Math.min(tokenOffset + PAGE, tokenList.length);
  const frag = document.createDocumentFragment();
  for (let i = tokenOffset; i < end; i++) {
    const t = tokenList[i];
    const row = document.createElement('div');
    row.className = 'tokenRow';
    row.innerHTML = `<span class="tokName">${escapeHtml(displayName(t.name))}</span>
      <span class="tokSize">${fmtBytes(t.bytes)}</span>
      ${t.dirty ? '<span class="dirty" title="名稱含未配對代理或內嵌 NUL">!</span>' : ''}`;
    row.onclick = () => void showToken(t);
    frag.appendChild(row);
  }
  body.appendChild(frag);
  tokenOffset = end;
  $('#tokenMore').textContent = tokenOffset < tokenList.length
    ? `還有 ${fmtInt(tokenList.length - tokenOffset)} 個（捲到底自動載入）` : '（已全部列出）';
}

/**
 * Clicking a token jumps straight to its first posting in the document. The
 * posting list pane was removed: it only duplicated what the search summaries
 * already show, so a token click now goes directly to the text.
 */
async function showToken(t: TokenRow, targetVa?: number) {
  setStatus(`讀取 ${JSON.stringify(displayName(t.name))} 的 posting list …`, 'busy');
  const t0 = performance.now();
  const va = await reader!.decodeBlockList('tokens', t.i);
  const ms = performance.now() - t0;
  setStatus(`${displayName(t.name)}：${fmtInt(va.length)} 筆 posting（${ms.toFixed(1)} ms）`, 'info');
  if (!va.length) return;
  const first = targetVa !== undefined && va.includes(targetVa) ? targetVa : va[0];
  await revealHit(first, t.name);
}

function binarySearch(xs: number[], v: number): number {
  let lo = 0, hi = xs.length - 1, best = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (xs[m] <= v) { best = m; lo = m + 1; } else hi = m - 1; }
  return best;
}

async function vapaProbe(va: number): Promise<unknown> {
  if (!mapper) return null;
  const ctx = await mapper.contextSpans(va, 60, 120);
  return ctx ? { block: ctx.block, pa: ctx.pa, hit: ctx.text.slice(ctx.hitStart, ctx.hitEnd), kind: ctx.element?.kind, tag: ctx.element?.tag ?? null } : null;
}

// -------------------------------------------------------------------- wiring
/**
 * Column widths: default left / middle / right = 25 / 50 / 25 (percent), but the
 * RIGHT column starts hidden — the token pane is only needed once you look
 * something up. Dragging a splitter below MIN_SIDE (15%) hides that side;
 * the header buttons toggle them. Everything is stored in localStorage.
 */
const COLS_KEY = 'adbview.cols.v2';
const MIN_SIDE = 15;
const MAX_SIDE = 60;
const DEFAULT_COLS = { left: 25, right: 25 };

function readCols(): { left: number; right: number } {
  try {
    const raw = JSON.parse(localStorage.getItem(COLS_KEY) ?? '');
    if (typeof raw?.left === 'number' && typeof raw?.right === 'number') {
      return { left: raw.left, right: raw.right };
    }
  } catch { /* fall through to defaults */ }
  return { ...DEFAULT_COLS };
}

function applyCols() {
  // persist on first run so the setting exists even before the user drags
  if (localStorage.getItem(COLS_KEY) === null) {
    localStorage.setItem(COLS_KEY, JSON.stringify({ ...DEFAULT_COLS }));
  }
  const { left, right } = readCols();
  const root = document.documentElement.style;
  const l = left < MIN_SIDE ? 0 : left;
  const r = right < MIN_SIDE ? 0 : right;
  root.setProperty('--left', l + 'fr');
  root.setProperty('--right', r + 'fr');
  root.setProperty('--center', (100 - l - r) + 'fr');
  ($('#toggleLeft') as HTMLButtonElement).classList.toggle('off', l === 0);
  ($('#toggleRight') as HTMLButtonElement).classList.toggle('off', r === 0);
}

function saveCols(left: number, right: number) {
  // anything below the minimum is stored as 0, i.e. hidden — so the persisted
  // state and the rendered state always agree
  const norm = (v: number) => (v < MIN_SIDE ? 0 : Math.min(MAX_SIDE, v));
  localStorage.setItem(COLS_KEY, JSON.stringify({ left: norm(left), right: norm(right) }));
  applyCols();
}

function setSide(side: 'left' | 'right', visible: boolean) {
  const c = readCols();
  if (side === 'left') c.left = visible ? (c.left < MIN_SIDE ? 25 : c.left) : 0;
  else c.right = visible ? (c.right < MIN_SIDE ? 25 : c.right) : 0;
  saveCols(c.left, c.right);
}

function toggleSide(side: 'left' | 'right') {
  const c = readCols();
  setSide(side, (side === 'left' ? c.left : c.right) < MIN_SIDE);
}

/** Drag a splitter; returns the new percentage for that side. */
function attachSplitter(el: HTMLElement, side: 'left' | 'right') {
  let dragging = false;
  let startX = 0;
  let startPct = 0;
  const pctOfDrag = (clientX: number) => {
    const dxPct = ((clientX - startX) / window.innerWidth) * 100;
    // dragging the right-hand splitter to the right shrinks the right column
    const raw = side === 'left' ? startPct + dxPct : startPct - dxPct;
    return Math.max(0, Math.min(MAX_SIDE, raw));
  };
  el.addEventListener('pointerdown', (ev) => {
    dragging = true;
    startX = ev.clientX;
    const c = readCols();
    startPct = side === 'left' ? c.left : c.right;
    el.setPointerCapture(ev.pointerId);
    el.classList.add('dragging');
    document.body.classList.add('colDragging');
    ev.preventDefault();
  });
  el.addEventListener('pointermove', (ev) => {
    if (!dragging) return;
    const pct = pctOfDrag(ev.clientX);
    // live preview; below the minimum the side visually collapses
    const shown = pct < MIN_SIDE ? 0 : pct;
    const c = readCols();
    const root = document.documentElement.style;
    if (side === 'left') {
      root.setProperty('--left', shown + 'fr');
      root.setProperty('--center', (100 - shown - (c.right < MIN_SIDE ? 0 : c.right)) + 'fr');
    } else {
      root.setProperty('--right', shown + 'fr');
      root.setProperty('--center', (100 - shown - (c.left < MIN_SIDE ? 0 : c.left)) + 'fr');
    }
  });
  const finish = (ev: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    el.classList.remove('dragging');
    document.body.classList.remove('colDragging');
    try { el.releasePointerCapture(ev.pointerId); } catch { /* already released */ }
    const pct = pctOfDrag(ev.clientX);
    // below 15% → snap shut (hidden), otherwise keep the dragged width
    const value = pct < MIN_SIDE ? 0 : Math.round(pct);
    const c = readCols();
    if (side === 'left') saveCols(value, c.right);
    else saveCols(c.left, value);
  };
  el.addEventListener('pointerup', finish);
  el.addEventListener('pointercancel', finish);
  // double click = reset that side to 25%
  el.addEventListener('dblclick', () => setSide(side, true));
}

/**
 * Switch the tab of ONE column. The two columns have independent tab sets
 * (left: 全文搜尋 / token; right: 目錄 / META / 容量 / 文件 / 圖片), so the tab
 * name alone is ambiguous and a column selector is required.
 */
function showTab(name: string, col: 'left' | 'right' = 'left') {
  const root = col === 'left' ? $('#colLeft') : $('#colRight');
  if (!root) return;
  // A tab this database does not declare (e.g. 頻次 when there is no `s="*u=…"`
  // tree) is hidden and must never become the active pane.
  const btn = root.querySelector<HTMLElement>(`.tabBtn[data-tab="${name}"]`);
  if (btn && (btn.hidden || getComputedStyle(btn).display === 'none')) return;
  root.querySelectorAll('.tabBtn').forEach((b) => b.classList.toggle('active', (b as HTMLElement).dataset.tab === name));
  root.querySelectorAll('.tabPane').forEach((p) => p.classList.toggle('active', (p as HTMLElement).dataset.tab === name));
  if (col === 'right' && dirTrees.length) void renderDirTree();   // built lazily
  // left panes are built on demand: each one walks its own tree/attribute table
  if (col === 'left') {
    if (name === 'freq') void renderFreq();
    else if (name === 'terms') void renderTerms();
    else if (name === 'folio') void renderFolio();
    else if (name === 'latin') void renderLatin();
  }
}

// ------------------------------------------------------------------ advanced mode
/**
 * Advanced mode reveals the token browser (left) and everything except the
 * directory (right). The default is the reader's view: search summaries, the
 * document, and this database's default directory tree.
 */
const ADV_KEY = 'adbview.advanced';
let advanced = false;

function readAdvanced(): boolean {
  return localStorage.getItem(ADV_KEY) === '1';
}

/** The left tab a reader lands on: the first shown tab that is not 進階-only. */
function defaultLeftTab(): string {
  const btns = [...document.querySelectorAll<HTMLElement>('#colLeft .tabBtn')];
  const first = btns.find((b) => getComputedStyle(b).display !== 'none' && !b.classList.contains('advOnly'));
  return first?.dataset.tab ?? 'dir';
}

function setAdvanced(on: boolean) {
  advanced = on;
  localStorage.setItem(ADV_KEY, on ? '1' : '0');
  document.body.classList.toggle('advanced', on);
  const btn = $('#advToggle') as HTMLButtonElement | null;
  if (btn) {
    // icon-only button: the state is the styling, the meaning is the tooltip
    btn.classList.toggle('on', on);
    btn.title = on
      ? '進階模式（開）：token 瀏覽與檔案資訊分頁已顯示'
      : '進階模式（關）：只顯示搜尋摘要與目錄';
  }
  // leave a tab that is no longer available. The advanced-only tabs (token, META,
  // 容量, 文件, 圖片) disappear with the mode, and a database without `s="*"` has no
  // 目錄 at all (fgdict lands on 名詞) — so the fallback is the database's own first
  // reader-facing tab, not a hard-coded 'dir'.
  if (!on) {
    const activeLeft = $('#colLeft .tabBtn.active') as HTMLElement | null;
    if (!activeLeft || getComputedStyle(activeLeft).display === 'none') showTab(defaultLeftTab(), 'left');
    if (!$('#colRight .tabPane.active')?.getAttribute('data-tab')?.includes('sum')) showTab('sum', 'right');
  }
}

function boot() {
  applyCols();
  attachSplitter($('#splitLeft'), 'left');
  attachSplitter($('#splitRight'), 'right');
  $('#toggleLeft').onclick = () => toggleSide('left');
  $('#toggleRight').onclick = () => toggleSide('right');
  ($('#advToggle') as HTMLButtonElement).onclick = () => setAdvanced(!advanced);
  // 🪾 left of the 文件內容 title: only on demand does the tree open up to the node
  // the document pane is sitting on, and scroll it into view
  const treeReveal = $('#treeReveal') as HTMLButtonElement | null;
  if (treeReveal) treeReveal.onclick = () => { void revealCursorInTree(); };
  setAdvanced(readAdvanced());
  window.addEventListener('resize', applyCols);

  // document font size
  setDocFont(readDocFont());
  $('#fsUp').onclick = () => setDocFont(readDocFont() + 2);
  $('#fsDown').onclick = () => setDocFont(readDocFont() - 2);
  $('#fsReset').onclick = () => setDocFont(DOCFS_DEFAULT);
  $('#fsAuto').onclick = () => {
    const size = autoFitFont();
    setStatus(`自動字級：${size}px（讓 90% 的行不軟換行）`, 'info');
  };

  // opening another database: the file picker before the first one, the Chinese
  // name button afterwards
  const fileInput = $('#file') as HTMLInputElement;
  fileInput.onchange = () => { const f = fileInput.files?.[0]; if (f) void openFile(f); };
  ($('#dbname') as HTMLButtonElement).onclick = () => {
    fileInput.value = '';
    fileInput.click();
  };

  // live search: re-run on every keystroke (posting lists are cached per token)
  const query = $('#query') as HTMLInputElement;
  let timer: number | undefined;
  query.oninput = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void runSearch(query.value), 120);
  };
  query.onkeydown = (ev) => {
    if (ev.key === 'Enter') { window.clearTimeout(timer); void runSearch(query.value); }
    if (ev.key === 'Escape') { query.value = ''; void runSearch(''); }
  };
  $('#queryClear').onclick = () => { query.value = ''; void runSearch(''); query.focus(); };
  $('#searchList').addEventListener('scroll', (ev) => {
    const el = ev.target as HTMLElement;
    if (!lastResult) return;
    const pool = snippetScope
      ? lastResult.hits.filter((h) => h.va >= snippetScope!.realm.from && h.va < snippetScope!.realm.to).length
      : lastResult.hits.length;
    if (el.scrollTop + el.clientHeight > el.scrollHeight - 200 && snippetShown < pool) {
      snippetShown += SNIPPET_LIMIT;
      void renderSnippets(searchSeq);
    }
  });

  // 頻次 and 西文 have their OWN inputs (the two panes are independent searches);
  // both re-render on input, with the same small debounce as the 目錄 box.
  const wireOwnSearch = (inputSel: string, clearSel: string, run: () => void) => {
    const input = $(inputSel) as HTMLInputElement | null;
    if (!input) return;
    let t: number | undefined;
    input.oninput = () => {
      window.clearTimeout(t);
      t = window.setTimeout(run, 120);
    };
    input.onkeydown = (ev) => {
      if (ev.key === 'Enter') { window.clearTimeout(t); run(); }
      if (ev.key === 'Escape') { input.value = ''; run(); }
    };
    const clear = $(clearSel) as HTMLButtonElement | null;
    if (clear) clear.onclick = () => { input.value = ''; run(); input.focus(); };
  };
  wireOwnSearch('#freqQuery', '#freqClear', () => void renderFreq());
  wireOwnSearch('#latinQuery', '#latinClear', () => void renderLatin());
  wireOwnSearch('#termsQuery', '#termsClear', () => void renderTerms());
  wireOwnSearch('#folioQuery', '#folioClear', () => void renderFolio());
  const termsMode = $('#termsMode') as HTMLSelectElement | null;
  if (termsMode) termsMode.onchange = () => void renderTerms();

  // every left pane is built on demand — showTab() dispatches to its renderer
  $('#colLeft').querySelectorAll<HTMLElement>('.tabBtn').forEach((b) => {
    b.onclick = () => showTab(b.dataset.tab!, 'left');
  });
  $('#colRight').querySelectorAll<HTMLElement>('.tabBtn').forEach((b) => { b.onclick = () => showTab(b.dataset.tab!, 'right'); });
  showTab('dir', 'left');
  showTab('dir', 'left');          // 目錄：搜尋 + 目錄樹

  $('#tokenRows')?.addEventListener('scroll', (ev) => {
    const el = ev.target as HTMLElement;
    if (el.scrollTop + el.clientHeight > el.scrollHeight - 300 && tokenOffset < tokenList.length) appendTokenRows();
  });
  const drop = document.body;
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('dragging'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('dragging'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('dragging');
    const f = e.dataTransfer?.files?.[0];
    if (f) void openFile(f);
  });
  setStatus('請選擇或拖入 .adb 檔案（13j / yinshun 皆可直接開啟）', 'info');
}

document.addEventListener('DOMContentLoaded', boot);

/** Test seam: the same functions the UI calls, reachable from DevTools. */
(window as unknown as Record<string, unknown>).__adbview = {
  openFile, showLine, showToken, revealHit, vapaProbe, showTab, toggleSide,
  setSide, resetCols: () => saveCols(DEFAULT_COLS.left, DEFAULT_COLS.right),
  setCols: (left: number, right: number) => saveCols(left, right),
  cols: () => ({ ...readCols(), css: {
    left: document.documentElement.style.getPropertyValue('--left'),
    center: document.documentElement.style.getPropertyValue('--center'),
    right: document.documentElement.style.getPropertyValue('--right'),
  } }),
  status: () => $('#status').textContent,
  setDocFont, autoFitFont, docFont: () => readDocFont(),
  setAdvanced, isAdvanced: () => advanced,
  openBreakdown: () => lastOpen,
  /** diagnostics: what a tree tier instance looks like at its VA */
  treeDebug: async (va: number) => {
    const el = await mapper!.elementAt(va);
    return el ? { kind: el.element.kind, text: el.element.text, tag: el.element.tag } : null;
  },
  treeTrace: () => (loadTree as unknown as { trace?: string[] }).trace ?? null,
  /** diagnostics for the "no wrapping" calculation */
  fitDebug: fitDebugInfo,
  /** diagnostics: what the painter would mark for the pinned hit */
  pinnedSpans: async () => (pinnedHit && mapper ? mapper.phraseSpans(pinnedHit.va, pinnedHit.units) : null),
  debugDoc: () => {
    const body = document.querySelector<HTMLElement>('#docText .docBody');
    return {
      rows: document.querySelectorAll('#docText .docLine').length,
      ids: [...document.querySelectorAll('#docText .docLine')].map((x) => x.id).join(','),
      markLines: [...document.querySelectorAll('#docText mark.docHit')].map((m) => m.closest('.docLine')?.id).join(','),
      clientWidth: body?.clientWidth ?? 0,
      scrollWidth: body?.scrollWidth ?? 0,
      longestLine: Math.max(0, ...lastDocLines.map((l) => l.length)),
      sample: lastDocLines.length,
    };
  },
  state: () => ({
    db: reader?.header.dbname ?? null,
    tokens: tokens.length,
    docs: docs.length,
    listed: tokenList.length,
    pinned: pinnedHit,
    lastReveal,
    docFont: readDocFont(),
    advanced,
    rightTab: $('#colRight .tabBtn.active')?.getAttribute('data-tab') ?? null,
    leftTab: $('#colLeft .tabBtn.active')?.getAttribute('data-tab') ?? null,
    treePhases,
    dirActive,
    dirRows: document.querySelectorAll('#dirTree .tRow').length,
    // the middle pane: one entry per linked node (Ctrl+click opens another)
    docTab: docActive,
    docTabs: docTabs.map((t) => ({
      name: t.name, from: t.realm.from, to: t.realm.to, page: t.page,
      pagelines: t.cache?.dt?.lines.length ?? 0,
    })),
    docPage: docSession() ? docSession()!.page + 1 : 0,
    docPages: docSession() ? pageBounds(docSession()!.realm, docSession()!.page).pages : 0,
    docTabPages: docSession() ? boundsOfRealm(docSession()!.realm).pages : 0,
    docPageLines: docSession()?.cache?.dt?.lines.length ?? 0,
    docRealm: docSession()?.realm ?? null,
    pagerHidden: ($('#docPager') as HTMLElement | null)?.hidden ?? null,
    docStrip: document.querySelectorAll('#docTabStrip .docTab').length,
    snippetScope: snippetScope ? { from: snippetScope.realm.from, to: snippetScope.realm.to, label: snippetScope.label } : null,
    lastLink,
    pagerLog: pagerLog.slice(-4),
    cursorNode: cursorNode ? { va: cursorNode.va, tag: cursorNode.tag, name: nodeLabelOf(cursorNode) } : null,
    textCache: reader ? reader.textCacheSize : 0,
    lastFit,
    dirOpen: dirTrees[dirActive] ? dirTrees[dirActive].open.size : 0,
    scopes: dirTrees.map((d) => d.tree.scope),
    freqHidden: ($('#colLeft .tabBtn[data-tab="freq"]') as HTMLButtonElement | null)?.hidden ?? null,
    dirInfo: dirTrees[dirActive]
      ? {
        tiers: dirTrees[dirActive].tree.tiers,
        scope: dirTrees[dirActive].tree.scope,
        nodes: dirTrees[dirActive].nodes,
        roots: dirTrees[dirActive].roots.length,
        firstRoot: {
          tag: dirTrees[dirActive].roots[0]?.tag,
          va: dirTrees[dirActive].roots[0]?.va,
          kids: dirTrees[dirActive].roots[0]?.children.length,
        },
        kidsTotal: dirTrees[dirActive].roots.reduce((a, r) => a + r.children.length, 0),
      }
      : null,
    dirError,
    dirLoading,
    marks: document.querySelectorAll('#docText mark.docHit').length,
    docRows: document.querySelectorAll('#docText .docLine').length,
    classes: reader ? reader.classStats() : null,
    mapper: mapper ? mapper.progress : null,
    cols: readCols(),
    tab: document.querySelector('.tabBtn.active')?.getAttribute('data-tab') ?? null,
  }),
};
