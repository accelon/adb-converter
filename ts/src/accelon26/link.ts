/**
 * 聯動：把 VA 變成「打開某個 realm 的本文並捲到某行」，以及游標高亮。
 *
 * Split out of viewer.ts (ACCELON26-HANDOVER 3.2). Shared state is read from
 * ./viewer and the other split modules as ESM live bindings; a module OWNS the
 * state it declares, and other modules get/set it through that module's exports.
 */
import { $, displayName, docs, fmtInt, mapper, reader, setStatus } from './viewer';
import { dirActive, dirTrees, renderDirTree, scrollDirTreeToVa, tagVas, treeOrder } from './scopes';
import { activeDocCtx, boundsOfRealm, ctxOf, docActive, docOfVa, docSession, docTabs, ensurePage, lastLink, ownsActiveDb, pageBounds, renderDocTabs, sessionFor, sessionForRealm, setDocActive, setDocFontSized, setLastLink, tabCountOfDb, wholeRealm } from './doc-pane';
import { type DocCtx, isActiveDocCtx } from './doc-ctx';
import type { AdbReader } from './adb';
import type { VaPaMapper } from './vapa';
import { noteLink } from './engine-stats';
import { activeSlot, dbShortName, openDbs, switchTo } from './dbs';
import { splitWordKey } from './word-hl';
import { anchorVa } from './page-text';

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
async function linkTo(va: number, token: string, units: number | undefined, opts: { newTab?: boolean; exact?: boolean; phrase?: string; noMark?: boolean; name?: string; mode?: 'reuse' | 'node' | 'hit'; realm?: { from: number; to: number }; ctx?: DocCtx | null; alignTop?: boolean } = {}): Promise<void> {
  // 連結是從「左欄那一庫」發起的（目錄、摘要、全文、詞典…），所以預設用 active ctx；
  // 呼叫端要指定別的庫時可以自己給 ctx（作者 2026-11-01）。
  const ctx = opts.ctx ?? activeDocCtx();
  const mp: VaPaMapper | null = ctx?.mapper ?? null;
  if (!ctx || !mp) return;
  // A caller that hands in its own realm AND paints by TEXT (名詞／全文 rows) does
  // not need the element: `elementAt` has to WALK every line up to the VA, and on
  // fgdict the cursor can be 200k lines behind (measured: clicking 法王家 after
  // reading entry #748 looked dead for seconds). The line table already says where
  // to go and `exact` paints by matching the term inside the line.
  const el = opts.realm && opts.exact ? null : await mp.elementAt(va);
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

  const doc = docOfVa(ctx, va);
  // 「這個庫還沒有本文分頁」才把 realm 擴成節點；別庫的分頁不算
  const useNode = !!node && (opts.mode === 'node' || tabCountOfDb(ctx.dbId) === 0);
  // Without a node the realm is the owning `<檔>` — NOT the whole VA space: in a
  // multi-document database the page range must be expressed in that document's
  // lines, or every page would be clamped to a single line.
  const whole: { from: number; to: number } = ctx.docs.length ? { from: doc.vaStart, to: doc.vaEnd } : wholeRealm(ctx);
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
  // 2026-10-31：檔名（Ys.xml）或 dbname（ys）也不要當分頁名——沒有可讀的名字時用
  // 該庫的短名（ys → 印順；fuyan → 福嚴）。
  const docLabel = doc?.name && !/\.xml$/i.test(doc.name) ? doc.name : '';
  const dbLabel = dbShortName(ctx.dbName) || displayName(ctx.dbCName || '');
  // `#詞` 只給 word-hl 用，不進分頁名／狀態列（`vedic?rv...#puruṣa` → `rv...`）。
  const tokenBase = splitWordKey(token).base;
  const name = opts.name || tokenBase
    || (useNode ? node!.name : (el?.element.text || docLabel || dbLabel || ''));
  // 只有「同一個庫的分頁」才能被重用／接手；別庫的分頁不能拿來裝這一庫的內容
  const curAll = docSession();
  const cur = curAll && (ctxOf(curAll)?.dbId ?? 0) === ctx.dbId ? curAll : null;
  const existing = sessionForRealm(ctx, realm);
  // Requirement 三: Ctrl/Cmd opens a NEW document tab, a PLAIN click UPDATES the tab
  // in view. The old rule opened a tab whenever the current one did not already cover
  // the realm, so walking the 目錄 (or the 全文 list) without Ctrl piled up one tab per
  // node that was visited.
  let s: DocSession;
  if (opts.newTab) {
    s = sessionFor(ctx, realm, name, true);
  } else if (existing) {
    s = existing;                 // this realm already has a tab: focus that one
  } else if (cur) {
    s = cur;                      // adopt the new realm in the tab being read
    s.realm = realm;
    s.page = 0;
    s.cache = null;               // the cached page belongs to the old realm
  } else {
    s = sessionFor(ctx, realm, name, false);
  }

  // 從歷史版本分頁點目錄／TOC／任何連結：這個分頁回到正常內文（退出歷史）
  if (s.history) { s.history = undefined; s.cache = null; }
  s.ctx = ctx;                    // 這個分頁畫哪一庫的文字（作者 2026-11-01）
  // 新的連結＝新的閱讀範圍：退出「連續閱讀」，恢復節點視窗（2026-11-05）
  s.continuous = false;
  s.nodeRealm = undefined;
  s.nodeLine = undefined;
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
  const rb = boundsOfRealm(ctx, realm);
  // the LINE comes from the line table, not from the mapper's walk: the walk drifts
  // on fgdict and a tag click would land one line high (or on another entry)
  let line = mp.lineOfVa(va);
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
  // 頁跳轉要讓那一行**貼齊頂端**（厚觀法師 2026-11-12：「107 頁的第一行應該是（圖二）」）：
  // 原本一律 block:'center'，目標行落在視窗中央，上方就看得到前一頁的圖，讀者以為跳錯頁。
  let scrollEl: HTMLElement | null = document.getElementById('L' + s.pinned.line);
  if (opts.alignTop && scrollEl) {
    // 頁標記本身不帶文字，而且常常落在上一塊的尾巴（空行、圖、段落末）：
    // 往下找「第一個真正有字、又不是圖」的那一行，那才是使用者眼中的頁首。
    let n: Element | null = scrollEl;
    for (let k = 0; k < 12 && n; k++) {
      const t = (n.textContent || '').replace(/\s/g, '');
      if (t && !n.querySelector('svg')) break;
      n = n.nextElementSibling;
    }
    if (n instanceof HTMLElement) {
      scrollEl = n;
      s.pinned.line = Number((n.id || '').replace(/^L/, '')) || s.pinned.line;
    }
  }
  scrollEl?.scrollIntoView({ block: opts.alignTop ? 'start' : 'center' });
  // 目錄游標只跟「左欄那一庫」的本文連動。跳過來的那一節要**立刻**亮（作者 2026-11-06）：
  // 以前只等本文捲動後的 syncCursorFromScroll，沒有捲動時要等尾端「載入更多」的 2 秒計時器，
  // 短節點還會亮成下一個節點。
  if (isActiveDocCtx(ctx)) {
    const target = deepestNode(va);
    if (target) cursorNode = target;
    paintTreeActive();
  }
  const totalMs = performance.now() - tLink;
  setLastLink({ va, ensureMs: Math.round(ensureMs), totalMs: Math.round(totalMs), rows: s.cache?.dt?.lines.length ?? 0 });
  // 本文標題顯示「上一輪引擎耗時」：取文字這一段（含確保頁面）
  noteLink({ ms: totalMs, ensureMs, rows: s.cache?.dt?.lines.length ?? 0, va });
  // 字級完全交給讀者（docTools 的下拉；作者 2026-10 拿掉「不換行」自動字級）：
  // 這裡不再自動改字級，預設就是 DOCFS_DEFAULT。
  setDocFontSized(true);
  // label carries the directory node's name (a tag click has no text of its own)
  const what = s.name || tokenBase || el?.element.text || '';
  const totalRows = boundsOfRealm(ctx, s.realm).total;
  const pageInfo = s.cache
    ? '（共 ' + fmtInt(totalRows) + ' 行，第 ' + fmtInt(s.page + 1) + ' / ' + fmtInt(pageBounds(ctx, s.realm, s.page).pages) + ' 頁' + (auto ? '，自動跟隨命中' : '') + '）'
    : '';
  setStatus(displayName(what) + '：第 ' + fmtInt(line) + ' 行' + pageInfo, 'info');
}

/** a search/summary link: the same action, plus the "snippet" token name */
async function revealHit(va: number, token: string, units?: number, opts: { newTab?: boolean; exact?: boolean; phrase?: string; noMark?: boolean; name?: string; mode?: 'reuse' | 'node' | 'hit'; realm?: { from: number; to: number }; ctx?: DocCtx | null; alignTop?: boolean } = {}): Promise<void> {
  return linkTo(va, token, units, opts);
}

/**
 * 右欄「圖片」Ctrl/Cmd+點縮圖（作者 2026-10-29）：打開「使用這張圖」的本文並捲到那一行。
 *
 * 不掃內文：`attributes/圖.n` 的值就是資源名，第 i 個值對應 `tags/圖` 的第 i 個 VA
 * （與「跳至」讀 `頁.id` 同一個做法）。
 */
export async function revealImageUse(name: string): Promise<boolean> {
  if (!reader) return false;
  const av = await reader.attributeValues('圖.n');
  if (!av?.values.length) return false;
  const i = av.values.indexOf(name);
  if (i < 0) return false;
  const vas = await tagVas('圖');
  const va = vas[i];
  if (va === undefined) return false;
  await revealHit(va, name, 1, { mode: 'hit' });
  setStatus(`已跳到使用「${name}」的那一行`, 'info');
  return true;
}

/** the public "show the document containing line `line`" entry point (文件 list) */
async function showLine(line: number, va: number, units?: number): Promise<void> {
  const ctx = activeDocCtx();
  if (!ctx) return;
  const d = docOfVa(ctx, va);
  $('#docs').querySelectorAll('.docItem').forEach((el) => el.classList.toggle('active', Number((el as HTMLElement).dataset.i) === d.i));
  const s = sessionFor(ctx, { from: d.vaStart, to: d.vaEnd }, d.name, false);
  if (s.history) { s.history = undefined; s.cache = null; }
  s.ctx = ctx;
  s.doc = d;
  s.pinned = { va, text: '', token: d.name, units: Math.max(1, units ?? 1), line };
  pinnedHit = s.pinned;
  setDocActive(docTabs.indexOf(s));
  await ensurePage(s, line);
}

/** the tree node that the MIDDLE of the document pane currently sits on */
let cursorNode: TreeNode | null = null;

/**
 * 目錄樹目前的游標狀態（作者 2026-11-05 回報「一捲動目錄樹 current 就不見了」）。
 *
 * `paintTreeActive()` 只切換**已掛載**的列；目錄是虛擬捲動（`virtual-list.ts`），
 * 往下捲會掛上新的一批列，那批列重新長出來時沒有 current／ancestor 的 class。
 * 所以把狀態存在這裡，列在 `html()` 產生時就問 `treeRowClasses(va)`。
 */
let cursorVa: number | null = null;
let cursorPath = new Set<number>();

/** 這一列要加的 class（' current'／' ancestor'／''）；虛擬列重掛時也拿得到 */
export function treeRowClasses(va: number): string {
  if (cursorVa === null) return '';
  if (va === cursorVa) return ' current';
  return cursorPath.has(va) ? ' ancestor' : '';
}

let cursorPending = false;

/**
 * Light the tree for the scroll cursor WITHOUT re-rendering it.
 *
 * The rendered rows can be thousands (an expanded dictionary) and the tree must
 * not move or expand by itself, so this only toggles classes: the cursor node is
 * `current` and every rendered ancestor of it is `ancestor`.
 */
function paintTreeActive(): void {
  // 目錄游標只屬於「左欄那一庫」：跨庫分頁的 VA 拿去查只會亮錯節點
  if (!ownsActiveDb(docSession())) { cursorVa = null; cursorPath = new Set(); return; }
  const box = $('#dirTree');
  const d = dirTrees[dirActive];
  const path = new Set<number>();
  if (d && cursorNode) {
    for (let va: number | undefined = cursorNode.va; va !== undefined; va = d.parentOf.get(va)) {
      path.add(va);
      if (path.size > 64) break;
    }
  }
  cursorVa = cursorNode ? cursorNode.va : null;
  cursorPath = path;
  if (!box) return;
  box.querySelectorAll<HTMLElement>('.tRow').forEach((el) => {
    const va = Number(el.dataset.va);
    const isCursor = cursorVa !== null && va === cursorVa;
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
  const s = docSession();
  if (!body || !ownsActiveDb(s)) return;
  const mp = ctxOf(s)?.mapper ?? mapper;
  if (!mp) return;
  const mid = body.scrollTop + body.clientHeight / 2;
  // 剛跳到某一節時，先亮「那一節」（作者 2026-11-06）：只要釘選的那一行還在中間附近，
  // 就不要被視窗中線帶去下一個節點。短節點（手冊 5.4 只有 3 行）以前會亮成 5.5。
  if (s?.pinned && typeof s.pinned.line === 'number') {
    const row = document.getElementById('L' + s.pinned.line);
    if (row) {
      const top = row.offsetTop;
      const bottom = top + row.offsetHeight;
      // 還看得到釘選的那一行（±30% 視窗）→ 就以它那一節為準
      const band = body.clientHeight * 0.3;
      const viewTop = body.scrollTop - band;
      const viewBottom = body.scrollTop + body.clientHeight + band;
      if (bottom > viewTop && top < viewBottom) {
        const node = deepestNode(s.pinned.va ?? 0);
        if (node && node !== cursorNode) { cursorNode = node; paintTreeActive(); }
        return;
      }
    }
  }
  let midLine = -1;
  for (const row of body.querySelectorAll<HTMLElement>('.docLine')) {
    const top = row.offsetTop;
    if (top <= mid && mid < top + row.offsetHeight) { midLine = Number(row.id.slice(1)); break; }
  }
  if (midLine < 0) return;
  const node = deepestNode(mp.linesVirtual[midLine] ?? 0);
  if (node === cursorNode) return;
  cursorNode = node;
  paintTreeActive();
}

/** 把目錄的游標節點指到包含 va 的節點（書籤回位用；作者 2026-10-31）。 */
export function focusTreeNode(va: number): void {
  const n = deepestNode(va);
  if (!n) return;
  cursorNode = n;
  paintTreeActive();
}

/** 目前本文中間那一行屬於哪個目錄節點（沒有 DOM 就退回釘選的 VA／頁首） */
function cursorNodeOf(s: DocSession): TreeNode | null {
  const mp = ctxOf(s)?.mapper ?? null;
  const body = document.querySelector<HTMLElement>('#docText .docBody');
  if (mp && body) {
    const mid = body.scrollTop + body.clientHeight / 2;
    for (const row of body.querySelectorAll<HTMLElement>('.docLine')) {
      const top = row.offsetTop;
      if (top <= mid && mid < top + row.offsetHeight) {
        return deepestNode(mp.linesVirtual[Number(row.id.slice(1))] ?? 0);
      }
    }
  }
  if (typeof s.pinned?.va === 'number') return deepestNode(s.pinned.va);
  return deepestNode(s.realm.from);
}

/**
 * 在目錄中顯示目前位置（header 的 🌲）。
 *
 * 作者 2026-11-01 的規格：這是**唯一**會因為本文而切換 adb 的動作。分頁屬於別的庫時
 * 先把 adb 切到那一庫（左欄目錄、摘要就變成那一庫的），再展開到目前位置。
 */
async function revealCursorInTree(): Promise<void> {
  const s0 = docSession();
  if (s0) {
    const want = ctxOf(s0)?.dbId ?? 0;
    if (want && activeSlot()?.id !== want) {
      const at = docTabs.indexOf(s0);
      // 切庫後由 dbs 選分頁；shared 模式要指定「就是這一個分頁」
      switchTo(want, false, at >= 0 ? at : undefined);
    }
  }
  const s = docSession();
  if (!s || !ownsActiveDb(s)) return;
  cursorNode = cursorNodeOf(s);
  const d = dirTrees[dirActive];
  if (!d || !cursorNode) return;
  for (let va: number | undefined = d.parentOf.get(cursorNode.va); va !== undefined; va = d.parentOf.get(va)) {
    d.open.add(va);
  }
  await renderDirTree();
  // 目錄可能是 74,219 列的虛擬清單：直接捲到索引，不用把列一列一列掛進來。
  scrollDirTreeToVa(cursorNode.va);
  paintTreeActive();
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

/** 下（1）／上（-1）一個節點：先找同 VA 的節點，找不到就用 VA 比較找最近的（作者 2026-10-31）。 */
function neighborNode(dir: 1 | -1): TreeNode | null {
  const s = docSession();
  if (!s) return null;
  const order = treeOrder();
  if (!order.length) return null;
  const from = s.realm.from;
  const at = order.findIndex((n) => n.va === from);
  if (at >= 0) return order[at + dir] ?? null;
  // 這一頁的 realm 不是節點起點（整本書、跨頁、或終端節點）：用 VA 找最近的節點。
  // 以前只認 indexOf(realm.from)，找不到就讓上下頁變灰——「經常不能點」就是這樣來的。
  let best: TreeNode | null = null;
  if (dir > 0) {
    for (const n of order) if (n.va > from) { best = n; break; }
  } else {
    for (const n of order) if (n.va < from) best = n;
  }
  return best;
}

/** 這一頁所屬文件的下（1）／上（-1）一份文件（跨書用）。 */
function docNeighbor(ctx: DocCtx | null, dir: 1 | -1): { vaStart: number; name: string } | null {
  const s = docSession();
  const list = ctx?.docs ?? [];
  if (!s || !list.length) return null;
  const d = docOfVa(ctx, s.realm.from);
  const i = list.findIndex((x) => x.vaStart === d?.vaStart);
  if (i < 0) return null;
  const nd = list[i + dir];
  return nd ? { vaStart: nd.vaStart, name: nd.name } : null;
}

/** 有沒有上／下一個 text node（pager 要不要顯示、按鈕要不要亮）；跨書也算。 */
export function hasRealmNeighbor(ctx: DocCtx | null, dir: 1 | -1): boolean {
  return !!neighborNode(dir) || !!docNeighbor(ctx, dir);
}

/**
 * 換到上（-1）／下（1）一個節點的本文。回傳有沒有換成。
 * 走的是跟點目錄列同一條路（`revealHit` + `mode: 'node'`），所以分頁／塗紅／
 * 游標的行為完全一致。節點用完了就換下一份文件（書），讓使用者可以從頭翻到尾。
 *
 * 上／下鄰居來自目錄樹（左欄那一庫），所以只有「左欄那一庫」的分頁才能跨節點。
 */
export async function stepRealm(dir: 1 | -1): Promise<boolean> {
  const s = docSession();
  if (!s) return false;
  const ctx = ctxOf(s);
  if (!ownsActiveDb(s)) return false;
  const target = neighborNode(dir);
  if (target) {
    await revealHit(target.va, target.label || '#' + target.index, 1, { mode: 'node' });
    return true;
  }
  const doc = docNeighbor(ctx, dir);
  if (!doc) return false;
  await revealHit(doc.vaStart, doc.name, 1, { mode: 'node' });
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
 * 建表，之後 O(1) 查。索引跟著 **reader 物件**（＝那一庫的 ctx.reader）快取，
 * 所以跨庫分頁的 `<聯>` 用的是它自己那一庫的詞頭表（作者 2026-11-01）。
 */
let entryIndexSource: unknown = null;
let entryIndex: { names: string[]; vas: number[]; homographs: string[] } | null = null;

async function buildEntryIndex(rd: AdbReader): Promise<{ names: string[]; vas: number[]; homographs: string[] } | null> {
  const tags = rd.containers.get('tags');
  if (!tags) return null;
  for (const tag of ['詞', '字', '詞目', '字頭', 'term', 'entry']) {
    const ti = tags.names.indexOf(tag);
    if (ti < 0) continue;
    try {
      const names = await rd.cachedStrings(tag);
      if (!names.length) continue;
      const vas = await rd.decodeBlockList('tags', ti);
      if (vas.length !== names.length) continue;
      const av = await rd.attributeValues(tag + '.a').catch(() => null);
      const homographs = names.map((_, i) => String(av?.values?.[i] ?? ''));
      return { names, vas, homographs };
    } catch {
      /* 這個標籤沒有名稱表，換下一個 */
    }
  }
  return null;
}

/**
 * 把一個詞頭解析成 VA 並聯動本文（`<聯 n=…>` 的點擊入口）。
 * `ctxIn` 省略時用「本文目前顯示的那個分頁」那一庫（跨庫分頁才不會查錯庫）。
 */
export async function linkToEntry(word: string, ctxIn?: DocCtx | null, newTab = false, homograph = ''): Promise<boolean> {
  const ctx = ctxIn ?? ctxOf(docSession()) ?? activeDocCtx();
  const rd = ctx?.reader ?? null;
  if (!ctx || !rd || !word) return false;
  if (entryIndexSource !== rd) {
    entryIndexSource = rd;
    entryIndex = await buildEntryIndex(rd);
  }
  if (!entryIndex) return false;
  let at = -1;
  for (let i = 0; i < entryIndex.names.length; i++) {
    if (entryIndex.names[i] !== word) continue;
    if (homograph && entryIndex.homographs[i] !== homograph) continue;
    at = i;
    break;
  }
  if (at < 0) {
    setStatus(`「${word}」${homograph ? `（${homograph}）` : ''}不在本庫的詞頭表`, 'warn');
    return false;
  }
  await linkTo(entryIndex.vas[at], word, 1, { mode: 'node', exact: true, ctx, newTab });
  return true;
}

let entryLinksBound = false;

/**
 * `<節聯>`：把通用節點錨點（`W-V#kp`／`W#kp`／頁 id／塊.段）解析成 VA，
 * 捲動本文到該節點（linkTo 自帶行高亮＋目錄游標跟隨），**不嵌入、不佔面板**。
 * `n=` 同庫；`i="db?anchor"` 跨庫——該庫已開在 slot 就切過去再跳，
 * 沒開就提示（ybh 回函 §3：不靜默、不死按鈕）。查不到 → warn「不在庫內」。
 */
export async function linkToNode(anchor: string, dbName = '', newTab = false, label = ''): Promise<boolean> {
  if (!anchor) return false;
  let ctx = ctxOf(docSession()) ?? activeDocCtx();
  const cur = (ctx?.reader ?? reader)?.header.dbname ?? '';
  if (dbName && dbName.toLowerCase() !== cur.toLowerCase()) {
    const want = dbName.toLowerCase();
    const base = (n: string): string => n.replace(/\.adb$/i, '').toLowerCase();
    const slot = openDbs.find((d) =>
      String((d.core as { reader?: { header?: { dbname?: string } } } | undefined)?.reader?.header?.dbname ?? '').toLowerCase() === want
      || base(String(d.file?.name ?? '')) === want);
    if (!slot) { setStatus(`請先開啟 ${dbName}.adb（同一個瀏覽器工作階段），再點這條節聯。`, 'warn'); return false; }
    switchTo(slot.id);
    ctx = ctxOf(docSession()) ?? activeDocCtx();
  }
  const rd = ctx?.reader ?? null;
  if (!ctx || !rd) return false;
  const va = await anchorVa(rd, anchor);
  if (va == null) {
    setStatus(`「${anchor}」不在庫內（${cur || dbName || '本庫'}）`, 'warn');
    return false;
  }
  await linkTo(va, label || anchor, 1, { mode: 'node', exact: true, ctx, newTab });
  return true;
}

/** 文件區的委派監聽：`a[data-entry]` → linkToEntry（只綁一次） */
export function initEntryLinks(): void {
  if (entryLinksBound) return;
  entryLinksBound = true;
  document.addEventListener(
    'click',
    (ev) => {
      const el = ev.target as Element | null;
      // `<節聯>`：data-link="node"（renderer 長出），目标由 linkToNode 解析
      const na = el?.closest?.('a[data-link="node"],a[data-node]') as HTMLElement | null;
      if (na) {
        ev.preventDefault();
        ev.stopPropagation();
        void linkToNode(na.dataset.node ?? '', na.dataset.nodedb ?? '',
          na.dataset.newtab === '1' || ev.ctrlKey || ev.metaKey, (na.textContent ?? '').trim());
        return;
      }
      const a = el?.closest?.('a[data-link="entry"],a[data-entry],a[data-entry-newtab]') as HTMLElement | null;
      if (!a) return;
      ev.preventDefault();
      ev.stopPropagation();
      // 點的是「本文裡」的 `<聯>`／`_名`：跟著本文分頁那一庫走（跨庫分頁也不會查錯庫）
      const newTab = a.dataset.newtab === '1' || a.hasAttribute('data-entry-newtab')
        || ev.ctrlKey || ev.metaKey;
      const target = a.dataset.entry || (a.textContent ?? '').trim();
      void linkToEntry(target, ctxOf(docSession()), newTab, a.dataset.homograph || '');
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

