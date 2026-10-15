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
  SearchSession, searchSummary, loadTrees, loadTree, buildTree, flattenTree, parseScope,
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
let pinnedHit: { va: number; text: string; token: string; units: number } | null = null;
let lastReveal = '';

/** search state */
let lastResult: SearchResult | null = null;
let searchSeq = 0;
/** index into result.groups, -1 = all groups */
let activeGroup = -1;
const SNIPPET_LIMIT = 60;
let snippetShown = SNIPPET_LIMIT;

/** directory tree state (one entry per `<樹>` declaration) */
interface DirTree {
  tree: SearchTree;
  roots: TreeNode[];
  nodes: number;
  labels: Map<number, string>;
  open: Set<number>;
  loaded: boolean;
}
let dirTrees: DirTree[] = [];
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

async function openFile(file: File) {
  // A load may be triggered twice by the picker (the browser fires `change`, and
  // callers often dispatch one as well). Without this guard the second run would
  // rebuild and discard the directory trees the first one produced.
  if (opening) return;
  opening = true;
  dirTrees = [];
  dirError = '';
  docFontSized = false;
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

    renderMeta(reader, openMs, tokenMs, layoutMs, docsMs);
    renderTokens(stats, tokenMs);
    renderDocs();
    // Directory trees are built in the BACKGROUND: a label means walking source
    // text per node, and on yinshun (3 trees, 132 nodes) that must not delay the
    // document pane. The 目錄 tab shows a notice until they are ready.
    dirLoading = true;
    const tTree = performance.now();
    void loadDirectoryTrees().catch((e) => {
      dirError = String((e as Error)?.stack ?? e);
      console.error('directory tree failed', e);
      void renderDirTree();
    }).finally(() => {
      dirLoading = false;
      if (lastOpen) lastOpen.treeMs = performance.now() - tTree;
      void renderDirTree();
    });
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
      treeMs: 0,
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
    $('#searchList').innerHTML = '';
    $('#searchMeta').textContent = '';
    $('#searchMore').textContent = '';
    return;
  }
  const res = await session.search(q);
  if (seq !== searchSeq) return;          // a newer keystroke won
  lastResult = res;
  snippetShown = SNIPPET_LIMIT;
  await renderSearchResult(res, seq);
}

async function renderSearchResult(res: SearchResult, seq: number) {
  const meta = $('#searchMeta');
  if (res.missing.length) {
    meta.textContent = `「${res.query}」：索引中沒有 ${res.missing.map((m) => `「${m}」`).join('、')}`;
    $('#searchList').innerHTML = '';
    $('#searchMore').textContent = '';
    return;
  }
  const groupInfo = res.groups.length ? `，分 ${fmtInt(res.groups.filter((g) => g.count).length)} 群（依 ${res.groupTag}）` : '';
  meta.textContent = `${res.tokens.map((t) => t.token).join(' + ')}（詞組，${fmtInt(res.hits.length)} 筆命中${res.truncated ? ' 以上' : ''}${groupInfo}，${res.ms.toFixed(0)} ms）`;
  activeGroup = -1;
  await renderSnippets(seq);
}

async function renderSnippets(seq: number) {
  const res = lastResult;
  if (!res || !mapper) return;
  const list = $('#searchList');
  const pool = activeGroup >= 0 ? res.hits.filter((h) => inGroup(res, h.va, activeGroup)) : res.hits;
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
      const va = Number(el.dataset.va);
      const units = Number(el.dataset.units);
      const target = ev.target as HTMLElement;
      // clicking the highlighted phrase jumps to that exact occurrence
      void revealHit(va, lastResult?.tokens.map((t) => t.token).join('') ?? '', units);
      if (target.tagName === 'MARK') void paintHit(va, units);
    };
  });
  const more = $('#searchMore');
  more.textContent = pool.length > show.length
    ? `顯示前 ${fmtInt(show.length)} 筆（${activeGroup >= 0 ? '此群 ' : ''}共 ${fmtInt(pool.length)} 筆）；捲到底載入更多`
    : `${activeGroup >= 0 ? '此群 ' : ''}共 ${fmtInt(pool.length)} 筆`;
  // auto-select and jump to the first hit (with its phrase length — without
  // `units` the painter would only mark the first character)
  const first = list.querySelector<HTMLElement>('.snippet');
  if (first && pool.length) {
    first.classList.add('active');
    await revealHit(pool[0].va, res.tokens.map((t) => t.token).join(''), pool[0].units);
  }
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

/** docText cache so a hit can jump without re-splitting the whole document */
let docCache: { doc: DocRow; dt: Awaited<ReturnType<VaPaMapper['docText']>>; key: string } | null = null;

async function loadDoc(d: DocRow, center?: number, lineRange?: { first: number; last: number }) {
  const key = center !== undefined ? 'c' + center : lineRange ? `r${lineRange.first}-${lineRange.last}` : 'all';
  if (docCache && docCache.doc.i === d.i && docCache.key === key) return docCache.dt;
  const dt = await mapper!.docText(
    d.vaStart, d.vaEnd, 3000,
    center !== undefined ? { center, radius: 1500 } : undefined,
    lineRange,
  );
  docCache = { doc: d, dt, key };
  return dt;
}

/**
 * Show the document that contains line `line`, windowed around it, then paint
 * the hit at `va`. Works for both multi-file databases (pick the owning 檔) and
 * single-file ones (13j, 42k lines: window the whole thing).
 */
async function showLine(line: number, va: number, units?: number) {
  if (!mapper || !reader) return;
  const idx = docs.findIndex((d) => {
    const vEnd = mapper!.linesVirtual[line] ?? 0;
    return vEnd >= d.vaStart && vEnd < d.vaEnd;
  });
  let d: DocRow;
  if (docs.length && idx >= 0) {
    d = docs[idx];
    $('#docs').querySelectorAll('.docItem').forEach((el) => el.classList.toggle('active', Number((el as HTMLElement).dataset.i) === d.i));
  } else {
    d = { i: -1, name: reader.header.dbname, vaStart: 0, vaEnd: reader.header.maxBlockOffset };
  }
  // the window must contain every line the hit spans, not just its first line —
  // a word cut by a hard break lives on two lines
  const spans = units && units > 1 ? await mapper.phraseSpans(va, units) : await mapper.lineSpans(va);
  const lines = spans.map((s) => s.line);
  const first = lines.length ? Math.min(line, ...lines) : line;
  const last = lines.length ? Math.max(line, ...lines) : line;
  const t0 = performance.now();
  const dt = await loadDoc(d, line, last > first ? { first, last } : undefined);
  renderDocText(d, dt, line, va, units);
  // On the first render of a database, keep the user's size but otherwise pick
  // one that keeps most hard lines from soft-wrapping.
  if (!docFontSized) {
    docFontSized = true;
    if (localStorage.getItem(DOCFS_KEY) === null) autoFitFont();
  }
  setStatus(`${displayName(d.name)}：第 ${fmtInt(line)} 行（共 ${fmtInt(dt.total)} 行，${(performance.now() - t0).toFixed(0)} ms）`, 'info');
}

/** true once the document font has been auto-fitted for this database */
let docFontSized = false;

/**
 * Render the line rows, mark the target line, and paint the token at `va`.
 *
 * The mark is applied per line via character offsets (mapper.lineSpans), so a
 * token that a hard line break cuts in two is painted on both rows with nothing
 * inserted between them — which is the whole reason VA is continuous.
 */
function renderDocText(d: DocRow, dt: Awaited<ReturnType<VaPaMapper['docText']>>, highlightLine?: number, hitVa?: number, units?: number) {
  lastDocLines = dt.lines;
  const rows = dt.lines.map((line, k) => {
    const n = dt.lineNumbers[k];
    const cls = 'docLine' + (n === highlightLine ? ' hitLine' : '');
    return `<div class="${cls}" id="L${n}"><span class="lineText">${escapeHtml(line)}</span></div>`;
  }).join('');
  $('#docText').innerHTML = `<div class="docHead">${escapeHtml(displayName(d.name))}
      <span class="dim">行 ${fmtInt(dt.lineNumbers[0] ?? 0)}–${fmtInt(dt.lineNumbers[dt.lineNumbers.length - 1] ?? 0)}${dt.truncated ? `（共 ${fmtInt(dt.total)} 行，視窗 ${fmtInt(dt.lines.length)} 行）` : `（共 ${fmtInt(dt.total)} 行）`} · source 區塊 ${dt.blockFirst}–${dt.blockLast} · ${fmtInt(dt.text.length)} 字</span></div>
    <div class="docBody">${rows}</div>`;
  if (highlightLine !== undefined && hitVa !== undefined) void paintHit(hitVa, units);
  else if (highlightLine !== undefined) {
    document.getElementById('L' + highlightLine)?.scrollIntoView({ block: 'center' });
  }
}

/**
 * Wrap the hit's character range in <mark> inside the already rendered rows.
 * `units` > 1 paints a whole phrase (search); omitted means "one element".
 *
 * If a span's line is not in the DOM (the window was computed before), the
 * document is re-rendered with a range that covers every span — otherwise the
 * second half of a word cut by a hard break would silently stay unpainted.
 */
async function paintHit(va: number, units?: number) {
  if (!mapper) return;
  const spans = units && units > 1
    ? await mapper.phraseSpans(va, units)
    : await mapper.lineSpans(va);
  // A headiing TAG carries no inline text span (`lineSpans` skips tags), so a
  // directory click on `<戊 u="文">` used to produce no mark AND no scroll — the
  // view stayed on whatever was shown before. Fall back to the line it sits on.
  if (!spans.length) {
    const el = await mapper.elementAt(va);
    const line = el?.element.line;
    if (line !== undefined) document.getElementById('L' + line)?.scrollIntoView({ block: 'center' });
    return;
  }
  if (spans.some((s) => !document.getElementById('L' + s.line))) {
    const d = docCache?.doc;
    if (d) {
      const lines = spans.map((s) => s.line);
      const first = Math.min(...lines);
      const last = Math.max(...lines);
      const dt = await mapper.docText(d.vaStart, d.vaEnd, 3000, undefined, { first, last });
      docCache = { doc: d, dt, key: `r${first}-${last}` };
      renderDocText(d, dt, docCacheLine(dt, spans), va, units);
      return;
    }
  }
  let firstMark: HTMLElement | null = null;
  for (const s of spans) {
    const row = document.getElementById('L' + s.line);
    const span = row?.querySelector<HTMLElement>('.lineText');
    if (!span) continue;
    const textNode = span.firstChild;
    if (!textNode || textNode.nodeType !== Node.TEXT_NODE) continue;
    const text = textNode.textContent ?? '';
    const start = Math.max(0, Math.min(text.length, s.start));
    const end = Math.max(start, Math.min(text.length, s.end));
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
}

/** the line to mark as `hitLine` after a re-render (the first span's line) */
function docCacheLine(dt: Awaited<ReturnType<VaPaMapper['docText']>>, spans: { line: number }[]): number {
  const wanted = new Set(spans.map((s) => s.line));
  for (const n of dt.lineNumbers) if (wanted.has(n)) return n;
  return dt.lineNumbers[0] ?? 0;
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
const DOC_TEXT_FAMILY = '"Microsoft JhengHei", "Segoe UI", system-ui, sans-serif';

function autoFitFont(sample?: string[]): number {
  // Widest line that 90% of the document stays within. The window on screen may
  // be tiny (a jump can render just a couple of rows), so prefer the whole
  // document when the mapper knows it.
  const lines = sample ?? lastDocLines;
  let target = 0;
  if (!sample && mapper && mapper.lineCount) target = mapper.lineLengthPercentile(0.9, 200_000);
  if (!target) {
    const lens = (lines.length ? lines : ['字'.repeat(24)]).map((l) => l.length).sort((a, b) => a - b);
    target = Math.max(8, lens[Math.min(lens.length - 1, Math.floor(lens.length * 0.9))]);
  }
  const reps = (lines.length ? lines : []).filter((l) => l.length <= target && l.length > 0);
  const probeText = reps.length ? reps.reduce((a, b) => (b.length > a.length ? b : a)) : '字'.repeat(target);
  const probeLen = probeText.length || 1;
  const longest = lines.reduce((a, b) => Math.max(a, b.length), 0);

  // Measurement needs BOTH: a probe that is not clamped by the pane (otherwise
  // the text saturates at the pane width and the scale factor comes out far too
  // large — that is what produced a nonsense 40px), and a width that IS read from
  // the pane, so the side columns are excluded.
  const containingBlockWidth = docTextWidth();
  if (containingBlockWidth < 80) return readDocFont();
  const measure = makeTextMeasurer();

  const measured = measure(probeText);
  // Scale so the representative line fits on ONE line. The cap considers only
  // "ordinary long" lines (up to 1.4 × the p90 target): a rare outlier line
  // (yinshun has single lines of 96 code units against p90 = 45) must not drag
  // the whole document down to the readable floor — it scrolls sideways instead.
  const scaled = Math.floor((PROBE_FS * containingBlockWidth) / measured);
  const capLen = Math.max(probeLen, Math.round(target * 1.4));
  const capLine = lines
    .filter((l) => l.length > 0 && l.length <= capLen)
    .reduce((a, b) => Math.max(a, b.length), 0);
  const capped = capLine > 0
    ? Math.floor((PROBE_FS * containingBlockWidth) / (measured * (capLine / probeLen)))
    : scaled;
  const size = Math.max(DOCFS_READABLE_MIN, Math.min(scaled, capped));
  const fitted = setDocFont(Math.max(DOCFS_MIN, Math.min(DOCFS_MAX, size)));
  pendingProbeCleanup?.();
  pendingProbeCleanup = null;
  return fitted;
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

/** the lines currently rendered, used by autoFitFont */
let lastDocLines: string[] = [];

// ------------------------------------------------------------------ directory tree
/**
 * Load the `<樹>` trees: tier instances, then the nesting. Labels are filled in
 * once per tree (a label means walking source text for an `n=` child tag, since
 * yinshun has no `書.n` attribute). One `<樹>` declaration becomes one tab.
 */
async function loadDirectoryTrees() {
  // Guard against a second call: openFile can be re-entered (e.g. a drop while a
  // load is still running) and re-running would discard the trees already built.
  if (dirTrees.length) return;
  if (!reader) return;
  const declared = session?.trees?.length ? session.trees : await loadTrees(reader);
  for (const t of declared) {
    if (!t.tiers.length) continue;
    const instances = await loadTree(reader, t, {
      attrsAt: async (va) => {
        const el = await mapper!.elementAt(va);
        return el ? parseAttrs(el.element.text) : {};
      },
      label: (va, vaEnd) => mapper!.nodeLabel(va, vaEnd),
    });
    if (!instances.length) continue;
    const roots = buildTree(instances);
    // share the labels with the search grouping, so a book has one name
    const byTag = new Map<string, string[]>();
    for (const node of iterNodes(roots)) {
      const list = byTag.get(node.tag) ?? [];
      list.push(node.label || `#${node.index}`);
      byTag.set(node.tag, list);
    }
    for (const [tag, labels] of byTag) mapper.treeLabels.set(tag, labels);
    dirTrees.push({
      tree: t, roots, nodes: countNodes(roots),
      labels: new Map<number, string>(), open: new Set<number>(), loaded: false,
    });
  }
  // The 目錄 pane shows the FULL-TEXT tree (`s="*"`); 頻次 and 西文 have their own
  // panes driven by their own scopes. Fall back to the first tree with tiers.
  dirActive = dirTrees.findIndex((d) => d.tree.fullText && d.tree.tiers.length > 0);
  if (dirActive < 0) dirActive = dirTrees.findIndex((d) => d.tree.tiers.length > 0);
  if (dirActive < 0) dirActive = 0;
  syncTreeTabs();
  await renderDirTree();
}

function countNodes(ns: TreeNode[]): number {
  let n = 0;
  for (const x of ns) n += 1 + countNodes(x.children);
  return n;
}

/**
 * The left column's tabs are declared by the database's `<樹>` tags:
 *
 *   s="*"          → 目錄   full-text search + the directory tree
 *   s="*u=文"      → 頻次   hits grouped by `<文>`, sorted by hit count
 *   s="~00602000"  → 西文   the U+0060..U+2000 (Latin-ish) slice
 *
 * A database that declares fewer trees simply gets fewer tabs.
 */
function syncTreeTabs() {
  // Left-column tabs are decided by the SCOPE of each `<樹>`, not by their order:
  //   s="*u=…" → 頻次（by segment）   s="~…" → 西文   s="*" → 目錄
  // The trees no longer get chips of their own: each one IS a left-column tab.
  const freqBtn = $('#colLeft .tabBtn[data-tab="freq"]') as HTMLButtonElement | null;
  const latinBtn = $('#colLeft .tabBtn[data-tab="latin"]') as HTMLButtonElement | null;
  if (freqBtn) freqBtn.hidden = !dirTrees.some((d) => /^\*u=/.test(d.tree.scope));
  if (latinBtn) latinBtn.hidden = !dirTrees.some((d) => /^~/.test(d.tree.scope));
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
  let lo = 0, hi = hits.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (hits[mid].va < from) lo = mid + 1; else hi = mid;
  }
  let n = 0;
  for (let i = lo; i < hits.length && hits[i].va < to; i++) n++;
  return n;
}

/** Compact directory tree: 30% colours per depth, no growing whitespace. */
async function renderDirTree() {
  const box = $('#dirTree');
  const d = dirTrees[dirActive];
  if (!d || !mapper) {
    box.innerHTML = dirLoading
      ? '<p class="dim">目錄樹建立中…（讀取各層標籤）</p>'
      : '<p class="dim">此庫沒有 <code>&lt;樹&gt;</code> 宣告。</p>';
    return;
  }
  if (!d.loaded) {
    for (const node of iterNodes(d.roots)) {
      if (d.labels.has(node.va)) continue;
      d.labels.set(node.va, node.label || (await mapper.nodeLabel(node.va, node.vaEnd)));
    }
    d.loaded = true;
  }
  const rows = flattenTree(d.roots, (n) => d.open.has(n.va));
  box.innerHTML = rows.map((r) => {
    const n = r.node;
    const open = d.open.has(n.va);
    const twisty = r.hasChildren ? (open ? '▾' : '▸') : '·';
    // When a search is active the badge shows the hits inside this node's REALM
    // (`[va, vaEnd)`); otherwise it shows the number of collapsed children.
    const hits = realmHits(n.va, n.vaEnd);
    const badge = hits > 0
      ? `<span class="tCount hit" title="此節點範圍內 ${fmtInt(hits)} 筆命中">${fmtInt(hits)}</span>`
      : (r.hasChildren && !open ? `<span class="tCount">${fmtInt(n.children.length)}</span>` : '');
    return `<div class="tRow" data-va="${n.va}">
      <span class="tTwisty">${twisty}</span>
      <span class="tDot" style="background:${depthColor(n.depth)}"></span>
      <span class="tTag">${escapeHtml(n.tag)}</span>
      <span class="tName">${escapeHtml(d.labels.get(n.va) || `#${n.index}`)}</span>
      ${badge}
    </div>`;
  }).join('');
  box.querySelectorAll<HTMLElement>('.tRow').forEach((el) => {
    const va = Number(el.dataset.va);
    const node = findNode(d.roots, va);
    const hasKids = !!node?.children.length;
    const toggle = () => {
      if (d.open.has(va)) {
        // Collapsing closes the WHOLE branch: otherwise a Ctrl-expanded subtree
        // pops back open the next time this node is expanded.
        d.open.delete(va);
        for (const x of iterNodes(node?.children ?? [])) d.open.delete(x.va);
      } else {
        d.open.add(va);
      }
      void renderDirTree();
    };
    const openAll = () => {
      for (const x of iterNodes(node!.children)) d.open.add(x.va);
      d.open.add(va);
      void renderDirTree();
    };
    // Hit zone comes from `closest`, not `ev.target.classList`: the click may land
    // on a text node inside the span, and the row also holds the count badge.
    //   name          -> toggle the directory
    //   Ctrl/Cmd+name -> expand every descendant
    //   colour block / tag name / count -> jump the document to this node
    el.onclick = (ev) => {
      const t = ev.target as HTMLElement | null;
      const onTwisty = !!t?.closest('.tTwisty');
      const onName = !!t?.closest('.tName');
      if (onTwisty || onName) {
        if (!hasKids) return;
        if ((ev.ctrlKey || ev.metaKey) && onName) openAll();
        else toggle();
        return;
      }
      void revealHit(va, node?.label || `VA ${va}`, 1);
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
  // 頻次 has its OWN input: the two panes are independent searches.
  const q = ($('#freqQuery') as HTMLInputElement).value.trim();
  if (!q) {
    // names are a source walk each, so only the shown slice is resolved
    const slice = segs.slice(0, 200);
    await nameSegs(slice);
    meta.textContent = `${fmtInt(segs.length)} 段：未輸入條件，列出段名`
      + (segs.length > slice.length ? `（僅列前 ${slice.length}）` : '');
    list.innerHTML = slice.map((s) => `<div class="snippet" data-va="${s.from}"><div><b>${
      escapeHtml(displayName(s.name))}</b></div></div>`).join('');
  } else {
    const res = await session.search(q);
    const counts = segs.map((s) => ({ ...s, count: 0 }));
    for (const h of res.hits) {
      let lo = 0, hi = counts.length - 1, at = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (counts[mid].from <= h.va) { at = mid; lo = mid + 1; } else hi = mid - 1;
      }
      if (at >= 0 && h.va < counts[at].to) counts[at].count++;
    }
    const shown = counts.filter((c) => c.count > 0).sort((a, b) => b.count - a.count).slice(0, 200);
    await nameSegs(shown);
    meta.textContent = `「${q}」${fmtInt(res.hits.length)} 筆命中，分布於 ${fmtInt(counts.filter((c) => c.count > 0).length)} / ${fmtInt(segs.length)} 段`
      + `（依命中數排序，0 不顯示${shown.length < counts.filter((c) => c.count > 0).length ? `，僅列前 ${shown.length}` : ''}）`;
    list.innerHTML = shown.map((s) => `<div class="snippet" data-va="${s.from}">
        <div class="snippetHead">${fmtInt(s.count)} 筆</div>
        <div><b>${escapeHtml(displayName(s.name))}</b></div></div>`).join('')
      || '<p class="dim">沒有命中。</p>';
  }
  list.querySelectorAll<HTMLElement>('.snippet').forEach((el) => {
    el.onclick = () => void revealHit(Number(el.dataset.va), $('#freqQuery') ? '頻次' : '', 1);
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
  const tree = dirTrees.find((d) => /^~/.test(d.tree.scope))?.tree;
  const range = tree ? parseScope(tree.scope).codepoints : undefined;
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
  const tree = dirTrees.find((d) => /^\*./.test(d.tree.scope))?.tree;
  const spec = (tree?.scope ?? '').replace(/^\*/, '').trim();
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
async function nameSegs(segs: { from: number; to: number; name: string }[]): Promise<void> {
  if (!mapper) return;
  for (const s of segs) {
    if (!s.name) s.name = (await mapper.nodeLabel(s.from, s.to)) || `VA ${s.from}`;
  }
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

/** Jump to a hit in the text and paint only that token. */
async function revealHit(va: number, token: string, units?: number) {
  if (!mapper) return;
  const t0 = performance.now();
  const el = await mapper.elementAt(va);
  if (!el) { setStatus(`VA ${fmtInt(va)}：找不到對應位置`, 'err'); return; }
  pinnedHit = { va, text: el.element.text, token, units: Math.max(1, units ?? el.element.vaUnits) };
  lastReveal = `va=${va} units=${units} element=${el.element.va}/${el.element.vaUnits}`;
  await showLine(el.element.line ?? 0, va, units);
  setStatus(`${displayName(token)}：VA ${fmtInt(va)} → 行 ${fmtInt(el.element.line ?? 0)}（區塊 ${el.block}，${(performance.now() - t0).toFixed(0)} ms）`, 'info');
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
  // leave a tab that is no longer available
  if (!on) {
    if (!$('#colLeft .tabBtn.active')?.getAttribute('data-tab')?.includes('search')) showTab('dir', 'left');
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
    if (el.scrollTop + el.clientHeight > el.scrollHeight - 200 && snippetShown < lastResult.hits.length) {
      snippetShown += SNIPPET_LIMIT;
      void renderSnippets(searchSeq);
    }
  });

  $('#colLeft').querySelectorAll<HTMLElement>('.tabBtn').forEach((b) => {
    b.onclick = () => {
      showTab(b.dataset.tab!, 'left');
      // the 頻次 pane is built on demand (it walks the segment tag's instances)
      if (b.dataset.tab === 'freq') void renderFreq();
    };
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
    dirActive,
    dirRows: document.querySelectorAll('#dirTree .tRow').length,
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
