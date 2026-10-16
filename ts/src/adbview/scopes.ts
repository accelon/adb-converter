/**
 * 搜尋 scheme／左欄分頁：目錄樹、名詞、頻次（全文）、原書分頁、西文。
 *
 * Split out of viewer.ts (ADBVIEW-HANDOVER 3.2). Shared state is read from
 * ./viewer and the other split modules as ESM live bindings; a module OWNS the
 * state it declares, and other modules get/set it through that module's exports.
 */
import { $, altKey, displayName, escapeHtml, fmtBytes, fmtInt, mapper, mods, newTabKey, openFile, opening, reader, session, tokens } from './viewer';
import { showTab } from './ui';
import { showToken } from './panes';
import { paintTreeActive, revealHit } from './link';
import { lastResult, showNodeHits } from './summary';

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
  const mode = ($('#latinMode') as HTMLSelectElement | null)?.value ?? 'any';
  const hit = q ? inRange.filter((t) => modeMatch(displayName(t.name), q, mode)) : inRange;
  const shown = hit.slice(0, 600);
  const hex = (n: number) => 'U+' + n.toString(16).toUpperCase().padStart(4, '0');
  meta.textContent = `${hex(from)}–${hex(to)} 範圍內 ${fmtInt(inRange.length)} 個 token`
    + (q ? `；「${q}」${MODE_NAMES[mode] ?? '任意'} 符合 ${fmtInt(hit.length)} 個` : '')
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
  const modeName = MODE_NAMES[mode] ?? '任意';
  const q = ($('#termsQuery') as HTMLInputElement).value.trim();

  const hits: { from: number; name: string; count: number }[] = [];
  if (usable && q) {
    // pure table scan: no source read, no full-text search, no VA walk
    for (let i = 0; i < names.length; i++) {
      const n = names[i];
      if (!modeMatch(n, q, mode)) continue;
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

export const setDirLoading = (b: boolean): void => { dirLoading = b; };
export const setDirError = (s: string): void => { dirError = s; };

/** a fresh database drops every built tree and its caches */
export function resetScopes(): void {
  dirTrees = [];
  dirError = '';
  dirActive = 0;
  folioCache = null;
  labelTables.clear();
  treePhases = {};
}

import { SearchResult, SearchTree, TreeNode, buildTree, flattenTree, loadInstanceAttrs, loadTree, loadTrees, parseScope } from './search';

/** the trees of ONE database (labelTables is a pure cache: dropped on switch) */
function snapshotScopes() {
  return { dirTrees, dirActive, dirError, treePhases, folioCache };
}
function restoreScopes(s: any): void {
  dirTrees = s.dirTrees ?? [];
  dirActive = s.dirActive ?? 0;
  dirError = s.dirError ?? '';
  treePhases = s.treePhases ?? {};
  folioCache = s.folioCache ?? null;
  labelTables.clear();
  dirLoading = false;
}
export { DirTree, countHitsPerSegment, countNodes, depthColor, dirActive, dirError, dirLoading, dirTrees, findNode, folioCache, folioEntries, freqSegments, hitBadge, labelFor, labelTableFor, labelTables, loadDirectoryTrees, lowerBound, nameSegs, realmHits, renderDirTree, renderFolio, renderFreq, renderLatin, renderTerms, restoreScopes, snapshotScopes, syncTreeTabs, tagSegments, tagVas, treePhases, treeScope, wrappedText };
