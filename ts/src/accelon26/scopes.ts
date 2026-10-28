/**
 * 搜尋 scheme／左欄分頁：目錄樹、名詞、頻次（全文）、原書分頁、西文。
 *
 * Split out of viewer.ts (ACCELON26-HANDOVER 3.2). Shared state is read from
 * ./viewer and the other split modules as ESM live bindings; a module OWNS the
 * state it declares, and other modules get/set it through that module's exports.
 */
import { $, altKey, currentFile, currentSource, displayName, docs, escapeHtml, fmtBytes, fmtInt, mapper, mods, newTabKey, openFile, opening, reader, session, tokens } from './viewer';
import { advanced, showTab } from './ui';
import { showToken } from './panes';
import { paintTreeActive, revealHit } from './link';
import { jumpTaishoCite, parseTaishoCite } from './xref';
import { setJumpRange } from './jump-band';
import { growUntil, mounted, renderChunked } from './lazy-list';
import { lastResult, showNodeHits } from './summary';
import { parseQuery, namePattern } from './query';
import { variantNamePattern, variantSearchOn } from './variants';
import { computeTierContext, setTierContext, tierContext } from './render_accelon3';
import { tagColorOf } from './tag-style';
import { diffPage, findSession, onEditsChange, sourceKey } from './edit-session';
import { decodeXmlEntities } from '../xml-entities';


function editSessionNow() {
  return currentSource ? findSession(sourceKey(currentSource)) : undefined;
}

/**
 * The DEEPEST tree node for each actually changed line.
 *
 * A page edit covers ~200 lines, which may contain many child nodes; marking by
 * realm overlap painted every child (and all ancestors). Here each changed line
 * is mapped to its owning node, so only the edited node is red.
 */
function editedNodeVas(es: ReturnType<typeof editSessionNow>): Set<number> {
  const out = new Set<number>();
  if (!es || !es.edits.size) return out;
  const v = mapper?.linesVirtual;
  if (!v || !v.length) return out;
  for (const e of es.edits.values()) {
    for (const c of diffPage(e).changes) {
      const line = Math.max(0, Number(c.line) || 0);
      const va = line > 0 ? (v[line - 1] ?? 0) + 1 : 0;
      const node = nodeContainingVa(va);
      if (node) out.add(node.va);
    }
  }
  return out;
}

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

/** 目錄樹全部節點的 DFS 順序（上一頁／下一頁跨節點時用；建樹時順便填好） */
let dirOrder: TreeNode[] = [];

/** where the background directory-tree build spends its time (diagnostics) */
let treePhases: Record<string, number> = {};

let dirActive = 0;

let dirError = '';

let dirLoading = false;

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

/** `<樹>` element text per instance VA — read once per database, then reused. */
const treeCaptions = new Map<number, string>();

/**
 * Fill `SearchTree.caption` from the `<樹>…</樹>` element text.
 *
 * The author's pane name (`ss.caption := removetag(getnNodeValue(dn))`); `s=` cannot
 * express it — taisho's seven trees are 經目／書名／分書頻次／分卷／分卷頻次／西文／
 * 反連結, and two pairs of them share the same `s=`. Costs one line read per
 * declaration, all of them in the first source block, and runs on the background
 * path — the tab set does not wait for it.
 */
async function fillTreeCaptions(trees: SearchTree[]): Promise<void> {
  if (!mapper) return;
  const missing = trees.filter((t) => !treeCaptions.has(t.va));
  if (missing.length) {
    const vas = await tagVas('樹');
    for (const t of missing) {
      let cap = '';
      try { cap = await wrappedText('樹', t.va, vas, 24); } catch { /* leave empty */ }
      treeCaptions.set(t.va, cap);
    }
  }
  for (const t of trees) if (t.caption === undefined) t.caption = treeCaptions.get(t.va) ?? '';
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
  // 分頁名＝`<樹>` 自己的文字（作者：`ss.caption := removetag(getnNodeValue(dn))`）。
  await fillTreeCaptions(declared);
  // Only the 目錄 pane's own tree is built — it is the last consumer. The search
  // grouping reads the indexer's own string tables now (search.ts groupNames →
  // caches/<tag>), so nothing else needs a walked tree. A database without `s="*"`
  // has no 目錄 pane at all, and per the author (2026-10 「可以拿掉背景建樹」) nothing
  // is built for it: fgdict's 88k tree instances were ~160 ms of background work for
  // a pane that cannot be opened.
  // the 目錄 pane is the EXACT `s="*"` tree (syncTreeTabs: /^\*$/); `*u=文` / `*詞`
  // are 頻次／全文 panes with their own scopes and never enter dirTrees
  const wanted = declared.filter((t) => /^\*$/.test(t.scope) && t.tiers.length > 0);
  if (!wanted.length) {
    dirTrees = [];
    dirActive = -1;
    phase.skipped = 1;          // diagnostics: nothing to build for this database
    syncTreeTabs();
    phase.trees = performance.now() - tTree0;
    treePhases = phase;
    return;
  }
  for (const t of wanted) {
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
    // 更深層的名字：breadcrumb 與「同層」選單會用到**還沒畫到**的節點，空名字
    // 會顯示成 `#136`（論語的 570 個「字」就是這樣）。`caches/<tag>` 是索引器
    // 已經存好的字串表，一次容器解析就能補滿；沒有表（名稱要回讀內文）就跳過，
    // 免得為了沒人看到的節點去解 source。上限 5000 筆，大庫不受影響。
    await fillCachedLabels(roots);
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
  // Every entry built above IS a full-text (`s="*"`) tree: 頻次 and 西文 have their own
  // panes driven by their own scopes and never look at dirTrees.
  dirActive = dirTrees.length ? 0 : -1;
  // 內文渲染要知道「每個標籤在第幾層」與「樹有幾層」——從剛建好的樹算一次（有界走訪）。
  setTierContext(dirTrees.length ? computeTierContext(dirTrees[0].roots) : null);
  // 文件順序（DFS）：上一頁／下一頁在邊界時要跳到「上／下一個 text node」
  dirOrder = dirTrees.length ? [...iterNodes(dirTrees[0].roots)] : [];
  syncTreeTabs();
  // Render only when the 目錄 pane exists AND is on screen. fgdict declares no
  // `s="*"` (so the tab is hidden) and its folio tree holds 88k instances: building
  // those rows into a hidden pane cost ~6 s of the main thread. The pane renders
  // lazily, when the reader switches to it.
  const tRender = performance.now();
  phase.rendered = dirPaneShown() ? 1 : 0;
  if (phase.rendered) await renderDirTree();
  phase.render = performance.now() - tRender;
  phase.trees = performance.now() - tTree0;
  treePhases = phase;
}

/**
 * 用 `caches/<tag>`（索引器存好的字串表）補齊還沒解名字的節點。
 *
 * 目錄樹只先解第一層（`entryLabelsOnly`），深層的名字等畫到那一列才解。可是
 * breadcrumb、「同層」選單與搜尋分組都會碰到沒畫到的節點，那時標籤就是空的
 * （顯示成 `#136`）。有快取表就一次補滿：一個容器解析換 570 個名字，比回讀
 * source 便宜得多。沒有表就維持惰性解名。
 */
async function fillCachedLabels(roots: TreeNode[]): Promise<void> {
  if (!reader) return;
  const byTag = new Map<string, TreeNode[]>();
  let missing = 0;
  for (const node of iterNodes(roots)) {
    if (!node.label) missing++;
    const list = byTag.get(node.tag);
    if (list) list.push(node);
    else byTag.set(node.tag, [node]);
  }
  if (!missing) return;
  for (const [tag, nodes] of byTag) {
    if (!nodes.some((n) => !n.label)) continue;
    if (nodes.length > 5000) continue;           // 大庫不為了沒人看的節點花這個記憶體
    let names: string[];
    let vas: number[];
    try {
      names = await reader.cachedStrings(tag);
      vas = await tagVas(tag);
    } catch {
      continue;
    }
    if (!names.length || names.length !== vas.length) continue;
    for (const node of nodes) {
      if (node.label) continue;
      const i = lowerBound(vas, node.va);
      if (vas[i] === node.va && names[i]) node.label = names[i];
    }
  }
}

function countNodes(ns: TreeNode[]): number {  let n = 0;
  for (const x of ns) n += 1 + countNodes(x.children);
  return n;
}

/**
 * The left column's tabs are declared by the database's `<樹>` tags — one pane per
 * SCOPE KIND, captioned with the `<樹>` element's own text:
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
 *
 * Two declarations can share a kind — taisho's 經目 + 分卷 are both `s="*"`, its
 * 分書頻次 + 分卷頻次 are `*書`/`*卷`. One pane cannot show both at once, so the pane
 * gets a picker (syncTreePickers); the declarations are never silently dropped.
 */
const DEFAULT_TAB_LABEL: Record<string, string> = {
  dir: '目錄', terms: '名詞', freq: '頻次', folio: '原書分頁', latin: '西文',
};

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
  // It must be the DECLARATIONS and not `dirTrees`: that array only ever holds the
  // `s="*"` trees, so taking the tab set from it hid every other pane the moment the
  // background build finished (taisho declares 7 trees and showed only 目錄).
  const declared = (session?.trees ?? []) as SearchTree[];
  const src = declared.length ? declared : dirTrees.map((d) => d.tree);
  const present = new Map<string, { scope: string; caption: string }>();   // kind -> first declaration
  for (const t of src) {
    const k = kindOf(t.scope);
    if (k && !present.has(k)) present.set(k, { scope: t.scope, caption: t.caption ?? '' });
  }
  for (const kind of ['dir', 'terms', 'freq', 'folio', 'latin']) {
    const hit = present.get(kind);
    const btn = $(`#colLeft .tabBtn[data-tab="${kind}"]`) as HTMLButtonElement | null;
    if (!btn) continue;
    btn.hidden = !hit;
    if (hit) {
      // `*u=…` counts hits per attribute segment (頻次), `*tag` per tag (全文) — but
      // the declared `<樹>` text wins when it has one (taisho: 分書頻次)
      btn.textContent = hit.caption
        || (kind === 'freq' ? (/^\*u=/.test(hit.scope) ? '頻次' : '全文') : DEFAULT_TAB_LABEL[kind]);
      btn.title = 's="' + hit.scope + '"' + (hit.caption ? '｜' + hit.caption : '');
    }
  }
  // 跳至不看樹宣告：只要庫裡有 <頁> 實例就出現（作者 2026-10）
  const jumpBtn = $('#colLeft .tabBtn[data-tab="jump"]') as HTMLButtonElement | null;
  if (jumpBtn) {
    const has = hasPageTags();
    jumpBtn.hidden = !has;
    if (has) jumpBtn.title = '依 <頁 id> 跳到某一頁（例：49p15、20p0065a）';
  }
  syncTreePickers(declared);
  // keep the active tab sane: a dictionary has no 目錄 pane at all
  const active = $('#colLeft .tabBtn.active') as HTMLButtonElement | null;
  if (!active || active.hidden) {
    const first = ['dir', 'terms', 'freq', 'folio', 'latin'].find((k) => present.has(k))
      ?? (hasPageTags() ? 'jump' : undefined);
    if (first) showTab(first, 'left');
  }
}

/**
 * Pickers for the panes whose kind is declared more than once.
 *
 *   #dirPick   every `s="*"` tree that produced instances（taisho：經目／分卷）
 *   #freqPick  every `*…` tree（taisho：分書頻次／分卷頻次）
 *
 * Both stay hidden when the database declares only one, so 13j／yinshun／fgdict look
 * exactly as they did.
 */
function syncTreePickers(trees: SearchTree[]) {
  const dirWrap = $('#dirPickWrap') as HTMLElement | null;
  const dirSel = $('#dirPick') as HTMLSelectElement | null;
  if (dirWrap && dirSel) {
    dirWrap.hidden = dirTrees.length < 2;
    if (dirTrees.length > 1) {
      dirSel.innerHTML = dirTrees
        .map((d, i) => `<option value="${i}"${i === dirActive ? ' selected' : ''}>${escapeHtml(d.tree.caption || d.tree.scope)}</option>`)
        .join('');
    }
  }
  const freqWrap = $('#freqPickWrap') as HTMLElement | null;
  const freqSel = $('#freqPick') as HTMLSelectElement | null;
  if (freqWrap && freqSel) {
    const list = trees.filter((t) => /^\*./.test(t.scope));      // `*u=文` / `*書`, not the bare `*`
    freqWrap.hidden = list.length < 2;
    if (list.length > 1) {
      if (freqTree < 0) freqTree = trees.indexOf(list[0]);
      freqSel.innerHTML = list
        .map((t) => `<option value="${trees.indexOf(t)}"${trees.indexOf(t) === freqTree ? ' selected' : ''}>${escapeHtml(t.caption || t.scope)}</option>`)
        .join('');
    }
  }
}

/** 目錄 pane: switch to another `s="*"` tree of the same database（taisho 的 分卷） */
export function selectDirTree(i: number) {
  if (i < 0 || i >= dirTrees.length || i === dirActive) return;
  dirActive = i;
  const d = dirTrees[i];
  setTierContext(computeTierContext(d.roots));
  dirOrder = [...iterNodes(d.roots)];
  void renderDirTree();
}

/** 頻次 pane: switch to another `*…` tree of the same database */
export function selectFreqTree(i: number) {
  const trees = session?.trees ?? [];
  if (i < 0 || i >= trees.length || !/^\*./.test(trees[i].scope)) return;
  freqTree = i;
  void renderFreq();
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

/**
 * Can the badges be counted EXACTLY?
 *
 * Only when the result list was cut off at `maxHits` AND the query is a single clause
 * (`+`／`−`／`*` are resolved by `rankClauses`, whose counts cannot be recomputed from
 * the posting lists alone). When the list is complete, `realmHits` is already exact
 * and costs nothing.
 */
function exactCounting(): boolean {
  const res = lastResult;
  return !!res && !!session && !!res.truncated && !res.multi;
}

/** realm counts for the CURRENT query, counted from the posting lists */
const realmCounts = new Map<string, number>();
let realmTotal = -1;
let realmQuery = '';

function realmKey(from: number, to: number): string {
  return (lastResult?.query ?? '') + '|' + from + '|' + to;
}

/** sync read of an already counted realm (the render pass fills it in `prepare`) */
function cachedRealmCount(from: number, to: number): number {
  const n = realmCounts.get(realmKey(from, to));
  if (n !== undefined) return n;
  // not prepared yet (a row mounted outside the prepare slice): fall back to the
  // list, which is an undercount but never a lie about *where* hits are
  return realmHits(from, to);
}

/** exact hit count of `[from, to)` (memoised per query) */
async function realmCount(from: number, to: number): Promise<number> {
  const res = lastResult;
  if (!res || !session) return 0;
  if (realmQuery !== res.query) { realmCounts.clear(); realmTotal = -1; realmQuery = res.query; }
  const key = realmKey(from, to);
  const hit = realmCounts.get(key);
  if (hit !== undefined) return hit;
  const stat = await session.rangeStats(res.query, from, to);
  // a newer query may have won while we counted: do not poison the new cache
  if (lastResult !== res) return stat.count;
  realmCounts.set(key, stat.count);
  if (realmCounts.size > 20000) realmCounts.clear();
  return stat.count;
}

/** total hits of the current query (exact when it was truncated) */
async function searchTotal(): Promise<number> {
  const res = lastResult;
  if (!res) return 0;
  if (!res.truncated || res.multi) return res.hits.length;
  if (realmQuery !== res.query) { realmCounts.clear(); realmTotal = -1; realmQuery = res.query; }
  if (realmTotal >= 0) return realmTotal;
  const stat = await session!.rangeStats(res.query, 0, reader?.header.maxBlockOffset ?? 0);
  if (lastResult === res) realmTotal = stat.count;
  return stat.count;
}

/**
 * Hits of the current query — the EXACT number when the result list was truncated
 * (taisho 佛: 567,678, not 5,000). Diagnostics/tests read it through `state()`.
 */
export function hitTotal(): number {
  if (!lastResult) return 0;
  return realmTotal >= 0 && realmQuery === lastResult.query ? realmTotal : lastResult.hits.length;
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

/**
 * The 目錄 pane exists only for a database that declares s="*" (fgdict declares none and
 * lands on 名詞 instead). Without it there is no 目錄樹 to show — and per the author
 * (2026-10) none should be built into the DOM at all.
 */
export function dirPaneShown(): boolean {
  const btn = $('#colLeft .tabBtn[data-tab="dir"]') as HTMLElement | null;
  return !!btn && !btn.hidden && getComputedStyle(btn).display !== 'none';
}

async function renderDirTree(): Promise<void> {
  const box = $('#dirTree');
  // 沒有 s="*" 就沒有目錄樹：面板本來就藏著，連列都不必掛進 DOM。
  // 清空是為了不讓上一個資料庫的列留在裡面（萬一之後有誰把它揭露出來）。
  if (!dirPaneShown()) {
    box.innerHTML = '';
    const head0 = $('#dirMeta');
    if (head0) head0.textContent = '';
    return;
  }
  const d = dirTrees[dirActive];
  if (!d || !mapper) {
    box.innerHTML = dirLoading
      ? '<p class="dim">目錄樹建立中…（讀取各層標籤）</p>'
      : '<p class="dim">此庫沒有 <code>&lt;樹&gt;</code> 宣告。</p>';
    return;
  }
  const rows = flattenTree(d.roots, (n) => d.open.has(n.va));
  d.loaded = true;
  const editedSet = editedNodeVas(editSessionNow());
  // While a search is active the badge is ALWAYS the hit count of this node's realm
  // (`[va, vaEnd)`) — the same number whether the node is open or collapsed. The
  // child count is only shown when there is no search to report on.
  const searching = !!lastResult;
  // The result list holds at most 5,000 hits (a PREFIX in VA order — taisho 佛 occurs
  // 567,678 times, so the list stops at VA 954,553 and 55 of 56 冊 would read 0).
  // The realm's count therefore comes from the posting lists (`rangeStats`), which is
  // also what the 命中數 badge promises (HANDOVER §4 五).
  const exact = exactCounting();
  const totalHits = exact ? await searchTotal() : (lastResult?.hits.length ?? 0);
  // Rows are mounted a CHUNK at a time (lazy-list): fgdict's tree is 6,966 rows /
  // ~35k DOM nodes, and building it in one go blocked the main thread for ~390 ms.
  // `min: mounted(box)` keeps an already opened tree as far open as it was.
  await renderChunked(box, rows, {
    // an already open tree stays as far open as the reader had scrolled it
    min: mounted(box),
    // Labels are resolved for the ROWS BEING DRAWN (the entry tier first, a node's
    // children when it is expanded) instead of for every node up front.
    prepare: async (slice) => {
      for (const r of slice) {
        const n = r.node;
        if (exact) await realmCount(n.va, n.vaEnd);
        if (d.labels.has(n.va)) continue;
        n.label = n.label || (await labelFor(n.tag, n.va, n.vaEnd));
        d.labels.set(n.va, n.label);
      }
    },
    html: (r) => {
      const n = r.node;
      const open = d.open.has(n.va);
      const twisty = r.hasChildren ? (open ? '▾' : '▸') : '·';
      const hits = searching ? (exact ? cachedRealmCount(n.va, n.vaEnd) : realmHits(n.va, n.vaEnd)) : 0;
      let badge = '';
      if (searching) {
        if (hits > 0) badge = hitBadge(hits, totalHits, '此節點範圍內 ', '；點一下顯示這些命中');
      } else if (r.hasChildren && !open) {
        badge = `<span class="tCount">${fmtInt(n.children.length)}</span>`;
      }
      const edited = editedSet.has(n.va);
      return `<div class="tRow${edited ? ' edited' : ''}" data-va="${n.va}">
      <span class="tTwisty">${twisty}</span>
      <span class="tDot" style="background:${depthColor(n.depth, n.tag)}"></span>
      <span class="tTag">${escapeHtml(n.tag)}</span>
      <span class="tName">${escapeHtml(d.labels.get(n.va) || '#' + n.index)}</span>
      ${badge}
    </div>`;
    },
    bind: (el, r) => {
      const node = r.node;
      const va = node.va;
      const hasKids = !!node.children.length;
      const setOpen = (open: boolean) => {
        if (open) {
          d.open.add(va);
        } else {
          // Collapsing closes the WHOLE branch: otherwise an expanded subtree pops
          // back open the next time this node is expanded.
          d.open.delete(va);
          for (const x of iterNodes(node.children)) d.open.delete(x.va);
        }
        void renderDirTree();
      };
      const openAll = () => {
        for (const x of iterNodes(node.children)) d.open.add(x.va);
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
        const label = node.label || `VA ${va}`;
        const wantsNewTab = newTabKey(ev);

        // 點 tCount：顯示該節點命中的摘要（功能二：輸入只更新摘要，這裡才是看命中）
        if (onCount) {
          // the count must be the realm's real hit count: the result list stops at
          // 5,000, and `cachedRealmCount` has the exact number the badge showed
          void showNodeHits({ from: va, to: node.vaEnd }, label, cachedRealmCount(va, node.vaEnd));
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
        // 箭頭收合時只收合，不動本文；點名稱／色塊仍是「跳到這個節點」。
        // 可開就開並聯動本文（作者 2026-10-25）。
        if (open) {
          if (t?.closest('.tTwisty')) { setOpen(false); return; }
          link();
          return;
        }
        if (hasKids) setOpen(true);
        link();
      };
    },
  });
  paintTreeActive();
  const head = $('#dirMeta');
  if (head) {
    // 進階模式才顯示（作者 2026-10：一般讀者不必看層級／節點數／scope）
    head.hidden = !advanced;
    if (!advanced) {
      head.textContent = '';
    } else {
      const t = d.tree;
      head.textContent = `${t.tiers.join(' › ')}${t.terminalTier >= 0 ? `（${t.tiers[t.terminalTier]} 為末層）` : ''}`
        + `　${fmtInt(d.nodes)} 節點／展開 ${fmtInt(rows.length)} 列`
        + (t.fullText ? '　s="*" 全文' : `　s="${t.scope}"`);
    }
  }
}

/**
 * 再點一次 active 的「目錄」分頁：把所有子孫收起來，整棵樹只留第一層
 * （作者 2026-10）。展開狀態記在 `d.open`，清空它再重畫即可。
 */
function collapseDirTree(): void {
  const d = dirTrees[dirActive];
  if (!d) return;
  d.open.clear();
  void renderDirTree();
  const box = $('#dirTree');
  if (box) box.scrollTop = 0;
}


/**
 * Depth colour: HSV with the hue rotating over the levels and the value held at
 * ~30%, so depth reads at a glance while every row keeps the same height and
 * indent (no file-manager style growing whitespace).
 */
function depthColor(depth: number, tag?: string): string {
  // 作者 2026-10-22：標籤樣式有自訂顏色就用它（目錄色點與本文標題同色）；
  // 沒有才回到主題的 tag 色相／深度。
  const custom = tag ? tagColorOf(tag) : null;
  if (custom) return custom;
  // 顏色是**主題變數**（作者 2026-10：不要寫死；換 theme 只要改 CSS 的 --tag-N）。
  // 內文的標題底色也用同一組變數，所以 tDot 與標題一定同色。
  // 作者 2026-10-18：色號跟著**標籤**（章、節 即使同一層也不同色）；沒有 tagChroma 才退回深度。
  const idx = tag ? tierContext().tagChroma?.get(tag) : undefined;
  const n = (((idx ?? depth) % 8) + 8) % 8;
  return `var(--tag-${n}, hsl(${((idx ?? depth) * 55) % 360}, 55%, 32%))`;
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

/**
 * VA 落在哪個節點的範圍裡（最深的那一個）；沒有樹就 null。
 *
 * 作者 2026-10-22：改用 `search.nodeOwningVa`（`<檔>` 邊界優先）——舊的寫法是
 * 直接比 `va < n.vaEnd`，而節點的 `vaEnd` 會跨進下一個 `<檔>` 的檔頭 4 個 VA，
 * 於是本文 realm 從檔頭開始時（摘要把命中設成整個 `<檔>`），breadcrumb 會把
 * 「華雨集第二冊」的命中說成「華雨集第一」。
 */
function nodeContainingVa(va: number): TreeNode | null {
  const d = dirTrees[dirActive];
  if (!d) return null;
  return nodeOwningVa(d.roots, va, docs);
}

/** 整個目錄樹的 DFS 順序（文件順序）；供上一頁／下一頁跨節點用 */
export function treeOrder(): TreeNode[] {
  return dirOrder;
}

/** 目錄節點的最小描述（breadcrumb／兄弟清單用） */
export interface TrailNode {
  va: number;
  tag: string;
  depth: number;
  label: string;
}

const asTrail = (n: TreeNode): TrailNode => ({ va: n.va, tag: n.tag, depth: n.depth, label: n.label || '#' + n.index });

/** 精確找到某個 VA 的節點（breadcrumb 的兄弟清單要它的父節點） */
export function nodeAt(va: number): TreeNode | null {
  const d = dirTrees[dirActive];
  if (!d) return null;
  return findNode(d.roots, va);
}

/**
 * 某個節點的兄弟（含自己）；沒有父節點＝最上層，回傳所有根節點。
 * 作者 2026-10：breadcrumb 點下去要下拉出「同一層的所有節點」，並突顯目前這一個。
 */
export function siblingsOf(va: number): TrailNode[] {
  const d = dirTrees[dirActive];
  if (!d) return [];
  const node = findNode(d.roots, va);
  if (!node) return [];
  const parentVa = d.parentOf.get(node.va);
  const list = parentVa === undefined ? d.roots : (findNode(d.roots, parentVa)?.children ?? []);
  return list.map(asTrail);
}

/**
 * 目前 VA 所在節點的祖先（由外到內，不含自己）。
 *
 * 作者 2026-10：點「丁一 請說」時，本文上方也要顯示「丙一 開示 次第」「乙一 般若
 * 道次第」「甲二 正宗分」——就是往上找比較大的標題。
 */
export function ancestorTrail(va: number): TrailNode[] {
  const d = dirTrees[dirActive];
  if (!d) return [];
  let cur = nodeContainingVa(va);
  if (!cur) return [];
  const out: TrailNode[] = [];
  for (let guard = 0; guard < 40; guard++) {
    const parentVa = d.parentOf.get(cur.va);
    if (parentVa === undefined) break;
    const p = findNode(d.roots, parentVa);
    if (!p) break;
    out.unshift(asTrail(p));
    cur = p;
  }
  return out;
}

/** 目前 VA 落在哪個節點（breadcrumb 只有祖先時，最後一項用得到） */
export function currentNodeAt(va: number): TrailNode | null {
  const n = nodeContainingVa(va);
  return n ? asTrail(n) : null;
}

// ------------------------------------------------------------------ 頻次（segments）
/**
 * The `s="*u=文"` tab: hits grouped by the segment tag (yinshun: `<文>`), sorted by
 * hit count. With no query it lists the segments themselves (the name is the text
 * inside the tags); with a query it takes the search's hits, counts them per
 * segment, sorts by that count and hides the zero-hit ones — the "一次不必看太多"
 * view the format was designed for.
 */
/** 頻次／全文 pane: same stale-render guard as the 名詞 pane. */
let freqSeq = 0;
/** total hits of the 頻次 pane's own query (exact even when the list was truncated) */
let freqTotal = -1;

async function renderFreq() {
  const meta = $('#freqMeta');
  const list = $('#freqList');
  if (!reader || !mapper || !session) { list.innerHTML = '<p class="dim">尚未開啟資料庫。</p>'; return; }
  const seq = ++freqSeq;
  freqTotal = -1;
  const segs = await freqSegments();
  if (seq !== freqSeq) return;
  if (!segs.length) {
    meta.textContent = '';
    list.innerHTML = '<p class="dim">此庫沒有 <code>&lt;樹 s="*u=…"&gt;</code> 可用的分段。</p>';
    return;
  }
  // A tag-name scope (`*詞`) wraps every segment with one tag, so the segment name
  // is exactly what that tag wraps; an attribute scope (`*u=文`) needs the
  // leading-text heuristic instead.
  const spec = freqScope().replace(/^\*/, '').trim();
  const segTag = spec && spec.indexOf('=') < 0 ? spec : undefined;
  // 頻次 has its OWN input: the two panes are independent searches.
  const q = ($('#freqQuery') as HTMLInputElement).value.trim();
  /** the rows on screen — a click needs their VA range for the 摘要 scope */
  let rows: { from: number; to: number; name: string; count: number; firstHit?: number }[] = [];
  let res: SearchResult | null = null;
  if (!q) {
    // names are a source walk each, so they are resolved per mounted chunk
    rows = segs.map((s) => ({ ...s, count: 0 }));
    meta.textContent = `${fmtInt(segs.length)} 段：未輸入條件，列出段名（捲動分批載入全部）`;
  } else {
    // searchAuto: 單詞組走舊引擎，多詞組／運算子走 BM25（s="*u=文" 與 s="*詞" 都適用）
    res = await searchAutoVia(session, reader?.io ?? null, q);
    if (seq !== freqSeq) return;              // a newer query already started
    const counts = segs.map((s) => ({ ...s, count: 0, firstHit: -1 }));
    const exactFreq = !!res.truncated && !res.multi;
    if (exactFreq) {
      // 5,000 筆只是 VA 順序的前綴：分段計數要回到 posting 清單，否則後面的段全是 0
      for (const c of counts) {
        const st = await session!.rangeStats(res.query, c.from, c.to);
        if (seq !== freqSeq) return;
        c.count = st.count;
        if (st.first >= 0) c.firstHit = st.first;
      }
    } else {
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
    }
    const withHits = counts.filter((c) => c.count > 0);
    rows = withHits.sort((a, b) => b.count - a.count);
    const total = exactFreq ? counts.reduce((s, c) => s + c.count, 0) : res.hits.length;
    freqTotal = total;
    meta.textContent = `「${q}」${fmtInt(total)} 筆命中，分布於 ${fmtInt(withHits.length)} / ${fmtInt(segs.length)} 段`
      + '（依命中數排序，0 不顯示）';
  }
  const total = freqTotal >= 0 ? freqTotal : (res?.hits.length ?? 0);
  // One row per segment, mounted a chunk at a time (yinshun has 6,978 of them): the
  // list stays complete, the DOM holds only what the reader is looking at.
  await renderChunked(list, rows, {
    prepare: (slice) => (seq === freqSeq ? nameSegs(slice, segTag) : undefined),
    html: (s) => `<div class="snippet" data-va="${s.from}">
        <div><b>${escapeHtml(displayName(s.name))}</b>${s.count > 0 ? ' ' + hitBadge(s.count, total) : ''}</div></div>`,
    bind: (el, s) => {
      const name = () => displayName(s.name) || '段';
      // The tab is named after the SEGMENT (法王家) but the jump goes to the first
      // HIT inside it, where the QUERY (法王) is what gets painted.
      el.onclick = (ev) => {
        const at = s.firstHit !== undefined && s.firstHit >= 0 ? s.firstHit : s.from;
        // 以「標籤名」分段的 scope（`*詞`）＝段就是那一個 <詞> 實例，內文只顯示
        // 這一段（作者 2026-10）；`*u=文` 這種屬性分段仍然開整個 <檔>。
        const realm = segTag ? { from: s.from, to: s.to } : undefined;
        void revealHit(at, q || name(), 1, { ...(mods(ev) ?? {}), exact: true, phrase: q || undefined, name: name(), realm });
        // the 摘要 pane follows the row that was clicked, scoped to that segment
        void showNodeHits({ from: s.from, to: s.to }, name(), s.count, res, q || undefined);
      };
    },
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
  const mode = ($('#latinMode') as HTMLSelectElement | null)?.value ?? 'any';
  const hit = q ? inRange.filter((t) => modeMatch(displayName(t.name), q, mode)) : inRange;
  const hex = (n: number) => 'U+' + n.toString(16).toUpperCase().padStart(4, '0');
  meta.textContent = `${hex(from)}–${hex(to)} 範圍內 ${fmtInt(inRange.length)} 個 token`
    + (q ? `；「${q}」${MODE_NAMES[mode] ?? '任意'} 符合 ${fmtInt(hit.length)} 個` : '（捲動分批載入全部）');
  if (!hit.length) {
    list.innerHTML = '<p class="dim">沒有符合的 token。</p>';
    return;
  }
  await renderChunked(list, hit, {
    html: (t) => `<div class="snippet" data-i="${t.i}">
      <div><b>${escapeHtml(displayName(t.name))}</b> <span class="dim">${fmtBytes(t.bytes)}</span></div></div>`,
    bind: (el, t) => {
      el.onclick = () => void showToken(t);
    },
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
  const spec = freqScope().replace(/^\*/, '').trim();
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
  const plain = text.slice(at, end).replace(/^<[^>]*>/, '').replace(/<[^>]*>/g, '').trim();
  return decodeXmlEntities(plain).slice(0, maxChars);
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
 * 頻次 pane's tree: the reader's pick when the database declares several `*…` trees
 * (taisho: 分書頻次 `*書` / 分卷頻次 `*卷`), else the first declaration.
 */
let freqTree = -1;

function freqScope(): string {
  const trees = session?.trees ?? [];
  const pick = freqTree >= 0 ? trees[freqTree] : undefined;
  if (pick && /^\*./.test(pick.scope)) return pick.scope;
  return trees.find((t) => /^\*./.test(t.scope))?.scope ?? '';
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
/** Option labels for the 開頭／中間／結尾 filter (名詞 and 西文 share it). */
const MODE_NAMES: Record<string, string> = { any: '任意', start: '開頭', mid: '中間', end: '結尾' };

/**
 * The 開頭／中間／結尾 position filter: where does `q` sit inside `name`?
 * `任意` accepts any occurrence.
 */
function modeMatch(name: string, q: string, mode: string): boolean {
  if (!q || !name.includes(q)) return false;
  const atStart = name.startsWith(q);
  const atEnd = name.endsWith(q);
  if (mode === 'start') return atStart;
  if (mode === 'end') return atEnd;
  if (mode === 'mid') return !atStart && !atEnd;
  return true;
}

/** 名詞 pane: 每次重畫遞增。非同步工作（字串表、內文走訪）回來時若序號變了，
 *  那一輪的結果就是過期的，直接丟掉 —— 否則舊查詢會蓋掉新查詢的清單。 */
let termsSeq = 0;

async function renderTerms(): Promise<void> {
  const meta = $('#termsMeta');
  const list = $('#termsList');
  if (!reader || !session) { list.innerHTML = '<p class="dim">尚未開啟資料庫。</p>'; return; }
  const seq = ++termsSeq;
  const tag = treeScope(/^\$/).replace(/^\$/, '').trim();
  const segs = tag ? await tagSegments(tag) : [];
  if (seq !== termsSeq) return;                 // a newer query already started
  if (!segs.length) {
    meta.textContent = '';
    const c = $('#termsCount');
    if (c) { c.textContent = ''; c.hidden = true; }
    list.innerHTML = '<p class="dim">此庫沒有 <code>&lt;樹 s="$…"&gt;</code> 的詞條。</p>';
    return;
  }
  const names = await reader.cachedStrings(tag);
  if (seq !== termsSeq) return;
  const usable = names.length === segs.length;
  // 三態 toggle（作者 2026-10）：開頭 → 中間 → 結尾，沒有「任意」
  const modeEl = $('#termsMode') as HTMLButtonElement | null;
  const mode = modeEl?.dataset.mode ?? 'start';
  if (modeEl) modeEl.disabled = !usable;
  const modeName = MODE_NAMES[mode] ?? '開頭';
  const q = ($('#termsQuery') as HTMLInputElement).value.trim();
  const countEl = $('#termsCount');
  const advancedOn = document.body.classList.contains('advanced');

  /** `idx` = this row's position in `segs`, the ONLY index the string table may be used with. */
  type TermRow = { from: number; to: number; idx: number; name: string; count: number };
  // 多詞組（+／-／*，空白分隔）：詞條名要同時滿足所有必要詞、不含排除詞。
  const parsed = parseQuery(q);
  const multiQ = parsed.clauses.length > 1 || parsed.hasOperators;
  const nameOk = (n: string): boolean => {
    // 繁簡通檢：詞條名也要通（「菩萨」找得到「菩薩」）
    const matchOne = (needle: string): boolean => {
      if (variantSearchOn()) {
        const re = variantNamePattern(needle);
        if (re) return re.test(n);
      }
      const re = namePattern(needle, mode);
      return re ? re.test(n) : n.includes(needle);
    };
    if (!multiQ) {
      if (!variantSearchOn() && !namePattern(q, mode)) return modeMatch(n, q, mode);
      return matchOne(q);
    }
    // 多詞組也吃「開頭／中間／結尾」模式（否則 `法王 -大慈` 會用 includes 比對，
    // 列出的詞條比單詞查詢還多 —— 作者 2026-10 回報）
    const matchMode = (needle: string): boolean =>
      variantSearchOn() ? matchOne(needle) : modeMatch(n, needle, mode);
    let any = false;
    for (const c of parsed.clauses) {
      const m = matchMode(c.text);
      if (c.role === 'excluded') { if (m) return false; }
      else if (c.role === 'required') { if (!m) return false; any = true; }
      else if (m) any = true;
    }
    return parsed.clauses.some((c) => c.role !== 'excluded') ? any : true;
  };

  /**
   * 依輸入詞把詞條名塗紅（作者 2026-10）：
   *   * 純文字 → 所有出現位置都塗（`法王` 在「大乘法王」只塗「法王」）
   *   * 含 `.` 萬用字元 → 用同一個樣式（含開頭／結尾錨點）比對到的片段塗紅
   * 找不到可比對的片段（例如繁簡通檢的異體字）就原文照印，寧可不上色也不標錯位置。
   */
  const markName = (name: string, needle: string): string => {
    if (!needle) return escapeHtml(name);
    const ranges: [number, number][] = [];
    const re = namePattern(needle, mode);
    if (re) {
      const g = new RegExp(re.source, 'g');
      for (const m of name.matchAll(g)) {
        if (!m[0]) continue;
        ranges.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
        if (ranges.length > 40) break;
      }
    } else {
      let at = name.indexOf(needle);
      while (at >= 0 && ranges.length < 40) {
        ranges.push([at, at + needle.length]);
        at = name.indexOf(needle, at + needle.length);
      }
    }
    if (!ranges.length) return escapeHtml(name);
    let out = '';
    let from = 0;
    for (const [s, e] of ranges) {
      if (s < from) continue;                       // 重疊（萬用字元）就跳過
      out += escapeHtml(name.slice(from, s)) + `<mark class="kw">${escapeHtml(name.slice(s, e))}</mark>`;
      from = e;
    }
    return out + escapeHtml(name.slice(from));
  };
  /** 要塗紅的字：多詞組時用第一個必要詞（`法王 -大慈` → 塗「法王」） */
  const markNeedle = multiQ
    ? (parsed.clauses.find((c) => c.role !== 'excluded')?.text ?? '')
    : q;
  const hits: TermRow[] = [];
  if (usable && q) {
    // pure table scan: no source read, no full-text search, no VA walk
    for (let i = 0; i < names.length; i++) {
      const n = names[i];
      if (!nameOk(n)) continue;
      hits.push({ from: segs[i].from, to: segs[i].to, idx: i, name: n, count: 0 });
      if (hits.length >= 2000) break;
    }
  }

  let items: TermRow[] = [];
  let res: SearchResult | null = null;
  /** 一般模式只把「符合幾個詞條」的**數字**放進 #termsMode 按鈕裡（作者 2026-10-18：
      不寫「個詞條」）；詳細統計留在進階模式的 #termsMeta。 */
  const setMeta = (brief: string, full: string) => {
    if (countEl) { countEl.textContent = brief; countEl.hidden = !brief; }
    if (meta) { meta.textContent = full; meta.hidden = !advancedOn; }
  };
  if (!q) {
    items = segs.map((s, i) => ({ from: s.from, to: s.to, idx: i, name: '', count: 0 }));
    setMeta(fmtInt(segs.length),
      `${fmtInt(segs.length)} 個詞條（<${tag}> 包住的字）：未輸入條件，捲動分批載入全部`);
  } else if (usable) {
    items = hits;
    setMeta(fmtInt(hits.length),
      multiQ
        ? `「${q}」：${fmtInt(hits.length)} 個詞條符合（共 ${fmtInt(segs.length)} 個；+ 必須、− 排除）`
        : `「${q}」${modeName}：${fmtInt(hits.length)} 個詞條符合`
          + `（共 ${fmtInt(segs.length)} 個；只比對 <${tag}> 包住的字）`);
  } else {
    // no string table in this database: fall back to the full-text search + names
    res = await searchAutoVia(session, reader?.io ?? null, q);
    if (seq !== termsSeq) return;
    let counts: number[];
    if (res.truncated && !res.multi) {
      // the result is a 5,000-hit prefix; per-entry counts come from the postings
      counts = [];
      for (const s of segs) {
        const st = await session!.rangeStats(res.query, s.from, s.to);
        if (seq !== termsSeq) return;
        counts.push(st.count);
      }
    } else {
      counts = countHitsPerSegment(segs, res.hits);
    }
    const withHits = segs.map((s, i) => ({ ...s, idx: i, name: '', count: counts[i] }))
      .filter((s) => s.count > 0)
      .sort((a, b) => b.count - a.count);
    items = withHits;
    setMeta(fmtInt(withHits.length),
      `「${q}」：${fmtInt(withHits.length)} 個詞條有命中（此庫沒有 <${tag}> 字串表，先用內文搜尋）`);
  }
  if (!items.length) {
    list.innerHTML = '<p class="dim">沒有符合的詞條。</p>';
    return;
  }
  // Mounted a chunk at a time: fgdict has 22,648 詞條, so the list is complete but
  // the DOM only ever holds what the reader is looking at.
  await renderChunked(list, items, {
    // The indexer already STORED the innerText of every instance as a string table
    // (caches/詞 for fgdict, 22,648 entries in instance order); a database without it
    // falls back to a bounded source walk, per mounted chunk only.
    prepare: (slice, from, to) => {
      if (seq !== termsSeq) return;            // this chunk belongs to an older query
      if (usable) {
        // 只補「還沒有名字」的列，而且用那一列自己在 segs 裡的位置取名字。
        // （舊寫法用 slice 的位移去取 names[…]，所以一輸入查詢，清單就變成
        //  字典最前面的 N 個詞條 —— 「查法王卻列出 一、一一、一一心識」。）
        for (let i = from; i < to; i++) {
          const row = slice[i - from];
          if (!row.name) row.name = names[row.idx] ?? '';
        }
      } else {
        return nameSegs(slice, tag);
      }
    },
    html: (h) => `<div class="snippet" data-va="${h.from}">
        ${h.count > 0 ? `<div class="snippetHead">${fmtInt(h.count)} 筆</div>` : ''}
        <div><b>${markName(displayName(h.name), markNeedle)}</b></div></div>`,
    bind: (el, h) => {
      // pass the TERM as the token: it is what the status shows and what the painter
      // marks inside the line.
      // 詞條＝閱讀單位（作者 2026-10）：`$詞` 這個 scope 讓 <詞> 成為內文分界，
      // 所以內文只顯示「這個 <詞> 實例的 realm」（VA 到下一筆 <詞>，也就是整個詞條），
      // 不是整個 <檔>。`s="*"` 的目錄維持原本的節點 realm。
      el.onclick = (ev) => void revealHit(h.from, displayName(h.name) || tag, 1, {
        ...(mods(ev) ?? {}), exact: true, realm: { from: h.from, to: h.to },
      });
    },
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
  meta.textContent = `${fmtInt(entries.length)} 個原書分頁`
    + (q ? `；「${q}」符合 ${fmtInt(hit.length)} 個` : '（可輸入頁碼；捲動分批載入全部）');
  if (!hit.length) {
    list.innerHTML = '<p class="dim">沒有符合的頁碼。</p>';
    return;
  }
  await renderChunked(list, hit, {
    html: (e) => `<div class="snippet${q && e.label === q ? ' active' : ''}" data-va="${e.va}">
      <div><b>${escapeHtml(e.label)}</b></div></div>`,
    bind: (el, e) => {
      // 原書分頁 is a milestone, not a hit: jump to the <頁> node itself
      // (mode:'node' gives the page its own realm, so the tab is named 1/2/… and a
      // repeat click reuses it instead of opening a second tab) and paint nothing.
      el.onclick = (ev) => { setJumpRange(null); void revealHit(e.va, e.label, 1, { ...(mods(ev) ?? {}), mode: 'node', noMark: true }); };
    },
  });
}
/* ------------------------------------------------------------------ 跳至（頁 id）
 *
 * 原書分頁（folio）要資料庫自己宣告 `<樹 s="頁.n">` 才出現；很多庫有 `<頁 id=…>` 卻沒宣告。
 * 這一頁改成直接讀 `attributes/頁.id`，所以「有 <頁> 標記的 adb」都有跳至可用。
 * 頁 id 是讀者認得的座標（大正藏 `49p15`、印順 `20p0065a`），輸入片段就能找。
 */
let jumpCache: { label: string; va: number }[] | null = null;

/** 這個庫有沒有 `<頁>` 實例（有的話左欄才顯示「跳至」分頁） */
export function hasPageTags(): boolean {
  return !!reader?.containers.get('tags')?.names.includes('頁');
}

async function jumpEntries(): Promise<{ label: string; va: number }[]> {
  if (jumpCache) return jumpCache;
  if (!reader) return [];
  const av = await reader.attributeValues('頁.id');
  const tagsC = reader.containers.get('tags');
  if (!av?.values?.length || !av.pointers || !tagsC) return [];
  const at = tagsC.names.indexOf('頁');
  if (at < 0) return [];
  const vas = await reader.decodeBlockList('tags', at);
  const out: { label: string; va: number }[] = [];
  for (let i = 0; i < av.values.length; i++) {
    const ptr = av.pointers[i];
    if (tagsC.names[(ptr >>> 24) & 0xff] !== '頁') continue;
    const va = vas[(ptr & 0xffffff) - 1];
    if (va === undefined) continue;
    out.push({ label: av.values[i], va });
  }
  jumpCache = out;
  return out;
}

/** 符合程度：完全相同 → 開頭 → 結尾（例：`0065a` 對 `20p0065a`）→ 中間 */
function jumpRank(label: string, q: string): number {
  if (label === q) return 0;
  if (label.startsWith(q)) return 1;
  if (label.endsWith(q)) return 2;
  return 3;
}

/**
 * 跳至：列出（符合的）頁 id；`enter` 為真時直接跳到最接近的一頁。
 * 捲動分批載入，行為與原書分頁一致。
 */
export async function renderJump(enter = false): Promise<void> {
  const meta = $('#jumpMeta');
  const list = $('#jumpList');
  if (!reader) { list.innerHTML = '<p class="dim">尚未開啟資料庫。</p>'; return; }
  const q = ($('#jumpQuery') as HTMLInputElement | null)?.value.trim() ?? '';
  // 大正藏引用（作者 2026-10-28）：
  //   「大正2，206a15-b13」「2，206a15」「大正二，206a15-b13」
  //   「(CBETA 2025.R1, T02, no. 99, p. 1a7-9)」「T02, no. 99, p. 1a7-9」
  // 這一種直接跳頁並把整段塗上色帶，不走下面的頁 id 清單。
  const cite = parseTaishoCite(q);
  if (cite) {
    const tail = cite.endCol
      ? `–${cite.endPage ?? cite.page}${cite.endCol}${cite.endLine ?? ''}`
      : (cite.endLine != null ? `–${cite.endLine}` : '');
    meta.textContent = `大正 ${cite.vol} 冊 ${cite.page}${cite.col}${cite.line}${tail}：按 Enter 跳到這一段`;
    list.innerHTML = '';
    if (enter) await jumpTaishoCite(cite);
    return;
  }
  const entries = await jumpEntries();
  if (!entries.length) {
    meta.textContent = '';
    list.innerHTML = '<p class="dim">此庫沒有 <code>&lt;頁 id="…"&gt;</code> 的頁標記。</p>';
    return;
  }
  let hit = entries;
  if (q) {
    hit = entries.filter((e) => e.label.includes(q));
    hit.sort((a, b) => jumpRank(a.label, q) - jumpRank(b.label, q)
      || a.label.localeCompare(b.label, 'en', { numeric: true }));
  }
  const go = (e: { label: string; va: number }) => {
    setJumpRange(null);            // 換頁就收起上一段的大正藏色帶
    void revealHit(e.va, e.label, 1, { mode: 'node', noMark: true });
  };
  if (enter && hit.length) { go(hit[0]); return; }
  meta.textContent = `${fmtInt(entries.length)} 頁`
    + (q ? `；「${q}」符合 ${fmtInt(hit.length)} 頁（Enter 跳到最接近的一頁）` : '（輸入頁 id 的一部份即可；Enter 直接跳）');
  if (!hit.length) {
    list.innerHTML = '<p class="dim">沒有符合的頁 id。</p>';
    return;
  }
  await renderChunked(list, hit, {
    html: (e) => `<div class="snippet${q && e.label === q ? ' active' : ''}" data-va="${e.va}">
      <div><b>${escapeHtml(e.label)}</b></div></div>`,
    bind: (el, e) => {
      el.onclick = (ev) => { setJumpRange(null); void revealHit(e.va, e.label, 1, { ...(mods(ev) ?? {}), mode: 'node', noMark: true }); };
    },
  });
}

/** mount every row of the current tree (tests assert on the whole list) */
export async function growTreeFully(): Promise<number> {  const box = $('#dirTree');
  if (!box) return 0;
  await growUntil(box, () => !box.querySelector('.moreRows'));
  return box.querySelectorAll('.tRow').length;
}

export const setDirLoading = (b: boolean): void => { dirLoading = b; };
export const setDirError = (s: string): void => { dirError = s; };

/** a fresh database drops every built tree and its caches */
export function resetScopes(): void {
  dirTrees = [];
  dirOrder = [];
  dirError = '';
  dirActive = 0;
  freqTree = -1;
  treeCaptions.clear();      // keyed by VA: a VA is another node in another database
  folioCache = null;
  jumpCache = null;
  labelTables.clear();
  treePhases = {};
  setTierContext(null);      // 換庫：上一個庫的層級不能留在渲染器裡
}

import { SearchResult, SearchTree, TreeNode, buildTree, flattenTree, loadInstanceAttrs, loadTree, loadTrees, nodeOwningVa, parseScope } from './search';
import { searchAutoVia } from './backend';

// 修訂數變動：目錄樹已掛載的節點名稱即時轉紅（不重畫，保留捲動位置）
onEditsChange(() => {
  const edited = editedNodeVas(editSessionNow());
  document.querySelectorAll<HTMLElement>('#dirTree .tRow[data-va]').forEach((row) => {
    const n = findNode(dirOrder, Number(row.dataset.va));
    row.classList.toggle('edited', !!n && edited.has(n.va));
  });
});

/** the trees of ONE database (labelTables is a pure cache: dropped on switch) */
function snapshotScopes() {
  return { dirTrees, dirActive, dirError, treePhases, folioCache, jumpCache, freqTree };
}
function restoreScopes(s: any): void {
  dirTrees = s.dirTrees ?? [];
  dirActive = s.dirActive ?? 0;
  dirError = s.dirError ?? '';
  treePhases = s.treePhases ?? {};
  folioCache = s.folioCache ?? null;
  jumpCache = s.jumpCache ?? null;
  freqTree = s.freqTree ?? -1;
  labelTables.clear();
  dirLoading = false;
}
export { DirTree, collapseDirTree, countHitsPerSegment, countNodes, depthColor, dirActive, dirError, dirLoading, dirTrees, findNode, folioCache, folioEntries, freqSegments, hitBadge, labelFor, labelTableFor, labelTables, loadDirectoryTrees, lowerBound, nameSegs, realmHits, renderDirTree, renderFolio, renderFreq, renderLatin, renderTerms, restoreScopes, snapshotScopes, syncTreeTabs, tagSegments, tagVas, treePhases, treeScope, wrappedText };
