/**
 * 聯動：把 VA 變成「打開某個 realm 的本文並捲到某行」，以及游標高亮。
 *
 * Split out of viewer.ts (ACCELON26-HANDOVER 3.2). Shared state is read from
 * ./viewer and the other split modules as ESM live bindings; a module OWNS the
 * state it declares, and other modules get/set it through that module's exports.
 */
import { $, displayName, docs, fmtInt, mapper, reader, setStatus } from './viewer';
import { dirActive, dirTrees, renderDirTree, treeOrder } from './scopes';
import { growUntil } from './lazy-list';
import { autoFitFont, boundsOfRealm, docActive, docOfVa, docSession, docTabs, ensurePage, lastLink, pageBounds, renderDocTabs, sessionFor, sessionForRealm, setDocActive, setDocFontSized, setLastLink, wholeRealm } from './doc-pane';
import { noteLink } from './engine-stats';

/** the hit the middle pane is currently showing (VA + its element text) */
let pinnedHit: { va: number; text: string; token: string; units: number; line: number; exact?: boolean; phrase?: string; noMark?: boolean } | null = null;

let lastReveal = '';

/**
 * The deepest directory node that owns a VA (its realm is the node's range).
 *
 * 作者 2026-10-22：VA → 節點改成 `nodeOwningVa`（`<檔>` 邊界優先）。範圍判定原本
 * 會把檔頭 4 個 VA 算成前一本書，游標高亮與「上一頁／下一頁」因此跟著指錯。
 * Siblings are disjoint and VA-ascending, so the descent is a binary search per
 * level — O(depth × log width) instead of walking every node (fgdict has 29,614
 * of them, and this runs on every link AND on every scroll settle).
 */
function deepestNode(va: number, roots = dirTrees[dirActive]?.roots ?? []): TreeNode | null {
  return nodeOwningVa(roots, va, docs);
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

/**
 * Point the document pane at a VA (the "聯動本文" action).
 *
 * `opts.newTab` (Ctrl/Cmd) opens a fresh tab. `opts.mode === 'node'` forces the
 * realm to be the directory node that contains the VA even when the current tab
 * already covers it (a terminal node has an empty realm, so it must not become
 * the tab's realm). Otherwise the current tab is kept when it already contains
 * the hit, which is what keeps clicks inside one chapter in one tab.
 */
async function linkTo(va: number, token: string, units: number | undefined, opts: { newTab?: boolean; exact?: boolean; phrase?: string; noMark?: boolean; name?: string; mode?: 'reuse' | 'node' | 'hit'; realm?: { from: number; to: number } } = {}): Promise<void> {
  if (!mapper) return;
  // A caller that hands in its own realm AND paints by TEXT (名詞／全文 rows) does
  // not need the element: `elementAt` has to WALK every line up to the VA, and on
  // fgdict the cursor can be 200k lines behind (measured: clicking 法王家 after
  // reading entry #748 looked dead for seconds). The line table already says where
  // to go and `exact` paints by matching the term inside the line.
  const el = opts.realm && opts.exact ? null : await mapper.elementAt(va);
  const node = nodeContaining(va);
  // A tree link carries everything it needs from the NODE (its realm), so a failed
  // element lookup must not swallow it: on a drifting database `elementAt` returns
  // null for tag VAs the tree knows perfectly well (yinshun's last 書 did), and the
  // click then did nothing at all — Ctrl+click included.
  // Same for a row that hands in its own realm (名詞／全文 of a `$詞`/`*詞` scope):
  // fgdict has empty blocks inside its big documents, and `elementAt` then returns
  // null even though the LINE TABLE knows exactly where the VA is. Bailing out there
  // made the second row of a 全文 list click-dead.
  if (!el && !node && !opts.realm) { setStatus('VA ' + fmtInt(va) + '：找不到對應位置', 'err'); return; }
  const u = Math.max(1, units ?? el?.element.vaUnits ?? 1);

  const doc = docOfVa(va);
  const useNode = !!node && (opts.mode === 'node' || !docTabs.length);
  // Without a node the realm is the owning `<檔>` — NOT the whole VA space: in a
  // multi-document database the page range must be expressed in that document's
  // lines, or every page would be clamped to a single line.
  const whole: { from: number; to: number } = docs.length ? { from: doc.vaStart, to: doc.vaEnd } : wholeRealm();
  // A node may drift a few VA units past its `<檔>`'s boundary (fgdict does); the
  // page range is computed from the line table, so the realm must be clamped to
  // the document that is actually read, or the page would clamp to one line.
  // `opts.realm` wins over both: the 名詞／全文 panes of a `$詞`/`*詞` scope hand in
  // the clicked `<詞>` instance, because there the term IS the reading unit
  // (作者 2026-10). `s="*"` links keep using the tree node / whole document.
  const raw = opts.realm ?? (useNode ? node!.realm : whole);
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
  const name = opts.name || token || (useNode ? node!.name : (el?.element.text || doc.name || reader?.header.dbname || ''));
  const cur = docSession();
  const existing = sessionForRealm(realm);
  // Requirement 三: Ctrl/Cmd opens a NEW document tab, a PLAIN click UPDATES the tab
  // in view. The old rule opened a tab whenever the current one did not already cover
  // the realm, so walking the 目錄 (or the 全文 list) without Ctrl piled up one tab per
  // node that was visited.
  let s: DocSession;
  if (opts.newTab) {
    s = sessionFor(realm, name, true);
  } else if (existing) {
    s = existing;                 // this realm already has a tab: focus that one
  } else if (cur) {
    s = cur;                      // adopt the new realm in the tab being read
    s.realm = realm;
    s.page = 0;
    s.cache = null;               // the cached page belongs to the old realm
  } else {
    s = sessionFor(realm, name, false);
  }

  // 從歷史版本分頁點目錄／TOC／任何連結：這個分頁回到正常內文（退出歷史）
  if (s.history) { s.history = undefined; s.cache = null; }
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
    va, text: el?.element.text ?? '', token, units: u, line,
    exact: !!opts.exact || !!opts.phrase, phrase: opts.phrase, noMark: !!opts.noMark,
  };
  pinnedHit = s.pinned;
  lastReveal = `va=${va} units=${u} element=${el ? el.element.va + '/' + el.element.vaUnits : 'node'}`;
  setDocActive(docTabs.indexOf(s));

  const tLink = performance.now();
  const auto = (await ensurePage(s, line)).auto;
  const ensureMs = performance.now() - tLink;
  // Bring the linked line into the viewport: a page holds up to 200 lines and the
  // target can sit below the fold (the 原書分頁 marker is the common case).
  document.getElementById('L' + s.pinned.line)?.scrollIntoView({ block: 'center' });
  paintTreeActive();
  const totalMs = performance.now() - tLink;
  setLastLink({ va, ensureMs: Math.round(ensureMs), totalMs: Math.round(totalMs), rows: s.cache?.dt?.lines.length ?? 0 });
  // 本文標題顯示「上一輪引擎耗時」：取文字這一段（含確保頁面）
  noteLink({ ms: totalMs, ensureMs, rows: s.cache?.dt?.lines.length ?? 0, va });
  // 字級完全交給讀者（docTools 的下拉；作者 2026-10 拿掉「不換行」自動字級）：
  // 這裡不再自動改字級，預設就是 DOCFS_DEFAULT。
  setDocFontSized(true);
  // label carries the directory node's name (a tag click has no text of its own)
  const what = s.name || token || el?.element.text || '';
  const totalRows = boundsOfRealm(s.realm).total;
  const pageInfo = s.cache
    ? '（共 ' + fmtInt(totalRows) + ' 行，第 ' + fmtInt(s.page + 1) + ' / ' + fmtInt(pageBounds(s.realm, s.page).pages) + ' 頁' + (auto ? '，自動跟隨命中' : '') + '）'
    : '';
  setStatus(displayName(what) + '：第 ' + fmtInt(line) + ' 行' + pageInfo, 'info');
}

/** a search/summary link: the same action, plus the "snippet" token name */
async function revealHit(va: number, token: string, units?: number, opts: { newTab?: boolean; exact?: boolean; phrase?: string; noMark?: boolean; name?: string; mode?: 'reuse' | 'node' | 'hit'; realm?: { from: number; to: number } } = {}): Promise<void> {
  return linkTo(va, token, units, opts);
}

/** the public "show the document containing line `line`" entry point (文件 list) */
async function showLine(line: number, va: number, units?: number): Promise<void> {
  if (!mapper || !reader) return;
  const d = docOfVa(va);
  $('#docs').querySelectorAll('.docItem').forEach((el) => el.classList.toggle('active', Number((el as HTMLElement).dataset.i) === d.i));
  const s = sessionFor({ from: d.vaStart, to: d.vaEnd }, d.name, false);
  if (s.history) { s.history = undefined; s.cache = null; }
  s.doc = d;
  s.pinned = { va, text: '', token: d.name, units: Math.max(1, units ?? 1), line };
  pinnedHit = s.pinned;
  setDocActive(docTabs.indexOf(s));
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
  // rows are mounted a chunk at a time (lazy-list), so the row to reveal may not be
  // in the DOM yet: mount further chunks until it is (a row deep in a 6,966-row tree)
  const sel = '#dirTree .tRow[data-va="' + cursorNode.va + '"]';
  await growUntil($('#dirTree'), () => !!document.querySelector(sel));
  const row = $(sel) as HTMLElement | null;
  row?.scrollIntoView({ block: 'center' });
}

export const setPinnedHit = (h: any): void => { pinnedHit = h; };
export const setCursorPending = (b: boolean): void => { cursorPending = b; };

/**
 * 目前本文所在的節點在文件順序中的位置（DFS）；找不到就 -1。
 * 「上一頁／下一頁」走到節點邊界時，用它換到上／下一個 text node（作者 2026-10）。
 *
 * 作者 2026-10-22：節點一樣由 `deepestNode`（`<檔>` 邊界優先）決定。整個 `<檔>`
 * 的 realm 從檔頭開始，舊的範圍判定會把它算成前一冊的最後一節，於是「下一頁」
 * 跳到正在讀的這一冊的開頭。
 */
function orderIndex(realmFrom: number): number {
  const order = treeOrder();
  if (!order.length) return -1;
  const node = deepestNode(realmFrom);
  return node ? order.indexOf(node) : -1;
}

/** 有沒有上／下一個 text node（pager 要不要顯示、按鈕要不要亮） */
export function hasRealmNeighbor(dir: 1 | -1): boolean {
  const s = docSession();
  if (!s || !treeOrder().length) return false;
  const at = orderIndex(s.realm.from);
  if (at < 0) return false;
  return !!treeOrder()[at + dir];
}

/**
 * 換到上（-1）／下（1）一個節點的本文。回傳有沒有換成。
 * 走的是跟點目錄列同一條路（`revealHit` + `mode: 'node'`），所以分頁／塗紅／
 * 游標的行為完全一致。
 */
export async function stepRealm(dir: 1 | -1): Promise<boolean> {
  const s = docSession();
  if (!s) return false;
  const order = treeOrder();
  const at = orderIndex(s.realm.from);
  if (at < 0) return false;
  const target = order[at + dir];
  if (!target) return false;
  await revealHit(target.va, target.label || '#' + target.index, 1, { mode: 'node' });
  return true;
}

/** a fresh database clears the pinned hit and the tree cursor */
export function resetLink(): void {
  pinnedHit = null;
  lastReveal = '';
  cursorNode = null;
  cursorPending = false;
  entryIndexSource = null;
  entryIndex = null;
}

/* ------------------------------------------------------------ entry links */
/**
 * `<聯 n="詞條">` 的目標解析。
 *
 * Accelon 的 LINK 標籤只存名字（`n=`），不是位置；這裡用詞典型資料庫現成的
 * `caches/詞`（詞頭字串表，與 `tags` 容器的第 i 個命中一一對應）做一次線性
 * 建表，之後 O(1) 查。索引跟著 `reader` 物件快取，換庫或關庫就重建。
 */
let entryIndexSource: unknown = null;
let entryIndex: { names: string[]; vas: number[] } | null = null;

async function buildEntryIndex(): Promise<{ names: string[]; vas: number[] } | null> {
  if (!reader) return null;
  const tags = reader.containers.get('tags');
  if (!tags) return null;
  for (const tag of ['詞', '字', '詞目', '字頭', 'term', 'entry']) {
    const ti = tags.names.indexOf(tag);
    if (ti < 0) continue;
    try {
      const names = await reader.cachedStrings(tag);
      if (!names.length) continue;
      const vas = await reader.decodeBlockList('tags', ti);
      if (vas.length !== names.length) continue;
      return { names, vas };
    } catch {
      /* 這個標籤沒有名稱表，換下一個 */
    }
  }
  return null;
}

/** 把一個詞頭解析成 VA 並聯動本文（`<聯 n=…>` 的點擊入口） */
export async function linkToEntry(word: string): Promise<boolean> {
  if (!reader || !word) return false;
  if (entryIndexSource !== reader) {
    entryIndexSource = reader;
    entryIndex = await buildEntryIndex();
  }
  if (!entryIndex) return false;
  const at = entryIndex.names.indexOf(word);
  if (at < 0) {
    setStatus(`「${word}」不在本庫的詞頭表`, 'warn');
    return false;
  }
  await linkTo(entryIndex.vas[at], word, 1, { mode: 'node', exact: true });
  return true;
}

let entryLinksBound = false;

/** 文件區的委派監聽：`a[data-entry]` → linkToEntry（只綁一次） */
export function initEntryLinks(): void {
  if (entryLinksBound) return;
  entryLinksBound = true;
  document.addEventListener(
    'click',
    (ev) => {
      const el = ev.target as Element | null;
      const a = el?.closest?.('a[data-entry]') as HTMLElement | null;
      if (!a) return;
      ev.preventDefault();
      ev.stopPropagation();
      void linkToEntry(a.dataset.entry ?? a.getAttribute('data-entry') ?? '');
    },
    true,
  );
}

import { TreeNode, nodeOwningVa } from './search';

function snapshotLink() {
  return { pinnedHit, lastReveal, cursorNode };
}
function restoreLink(s: any): void {
  pinnedHit = s.pinnedHit ?? null;
  lastReveal = s.lastReveal ?? '';
  cursorNode = s.cursorNode ?? null;
  cursorPending = false;
}
export { cursorNode, cursorPending, deepestNode, lastReveal, linkTo, nodeContaining, nodeLabelOf, paintTreeActive, pinnedHit, restoreLink, revealCursorInTree, revealHit, showLine, snapshotLink, syncCursorFromScroll };
