/**
 * 聯動：把 VA 變成「打開某個 realm 的本文並捲到某行」，以及游標高亮。
 *
 * Split out of viewer.ts (ADBVIEW-HANDOVER 3.2). Shared state is read from
 * ./viewer and the other split modules as ESM live bindings; a module OWNS the
 * state it declares, and other modules get/set it through that module's exports.
 */
import { $, displayName, docs, fmtInt, mapper, reader, setStatus } from './viewer';
import { dirActive, dirTrees, renderDirTree } from './scopes';
import { DOCFS_KEY, autoFitFont, boundsOfRealm, docActive, docFontSized, docOfVa, docSession, docTabs, ensurePage, lastLink, pageBounds, renderDocTabs, sessionFor, setDocActive, setDocFontSized, setLastLink, wholeRealm } from './doc-pane';

/** the hit the middle pane is currently showing (VA + its element text) */
let pinnedHit: { va: number; text: string; token: string; units: number; line: number; exact?: boolean; phrase?: string; noMark?: boolean } | null = null;

let lastReveal = '';

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
  setDocActive(docTabs.indexOf(s));

  const tLink = performance.now();
  const auto = (await ensurePage(s, line)).auto;
  // Bring the linked line into the viewport: a page holds up to 200 lines and the
  // target can sit below the fold (the 原書分頁 marker is the common case).
  document.getElementById('L' + s.pinned.line)?.scrollIntoView({ block: 'center' });
  const ensureMs = performance.now() - tLink;
  paintTreeActive();
  setLastLink({ va, ensureMs: Math.round(ensureMs), totalMs: Math.round(performance.now() - tLink), rows: s.cache?.dt?.lines.length ?? 0 });
  // On the first render of a database, keep the user's size but otherwise pick
  // one that keeps most hard lines from soft-wrapping.
  if (!docFontSized) {
    setDocFontSized(true);
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
  const row = $('#dirTree .tRow[data-va="' + cursorNode.va + '"]') as HTMLElement | null;
  row?.scrollIntoView({ block: 'center' });
}

export const setPinnedHit = (h: any): void => { pinnedHit = h; };
export const setCursorPending = (b: boolean): void => { cursorPending = b; };

/** a fresh database clears the pinned hit and the tree cursor */
export function resetLink(): void {
  pinnedHit = null;
  lastReveal = '';
  cursorNode = null;
  cursorPending = false;
}

import { TreeNode } from './search';

export { cursorNode, cursorPending, deepestNode, lastReveal, linkTo, nodeContaining, nodeLabelOf, paintTreeActive, pinnedHit, revealCursorInTree, revealHit, showLine, syncCursorFromScroll };
