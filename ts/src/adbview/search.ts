/**
 * Search helpers for the viewer, kept out of the UI code.
 *
 * The semantics follow the Delphi search engine (search.pas):
 *
 *   TSearch.construct tokenizes the user's query with the SAME tokenizer the
 *   index was built with, and inserts an implicit OP_AND between consecutive
 *   tokens. `TPhraseHits.nextmatch` then requires the tokens to be *adjacent in
 *   the virtual address space*:
 *
 *       if pls[ntoken-1].curvalue = pls[0].curvalue + ntoken-1 then match
 *
 *   i.e. a query of two characters is a PHRASE, not a bag of words. Because VA
 *   is continuous across hard line breaks (a break costs no VA), such a phrase
 *   matches even when the two characters ended up on different lines.
 *
 *   bun run test/search.test.ts [--adb ...]
 */
import { AdbReader, type Container } from './adb';
import { parseAttrs } from './vapa';
import { normalize, Tokenizer } from '../tokenize';
import { tntTrim, isPunctuation, isWhitespace } from '../unicode';
import type { VaPaMapper } from './vapa';

export interface PhraseHit {
  /** VA of the first token of the match */
  va: number;
  /** how many VA units the match covers (= number of tokens) */
  units: number;
}

/**
 * All positions where `lists[0..n-1]` appear consecutively in VA space.
 *
 * Port of search.pas `TPhraseHits.nextmatch`: advance the first list, bring each
 * later list up to its predecessor, and accept when the last equals the first
 * plus the token count minus one.
 */
export function phraseMatch(lists: number[][], limit = 1_000_000): PhraseHit[] {
  if (!lists.length) return [];
  if (lists.length === 1) return lists[0].slice(0, limit).map((va) => ({ va, units: 1 }));
  const n = lists.length;
  const idx = new Array(n).fill(0);
  const out: PhraseHit[] = [];
  const last = lists[n - 1];
  for (const start of lists[0]) {
    let target = start;
    let ok = true;
    for (let i = 1; i < n; i++) {
      idx[i] = lowerBound(lists[i], target, idx[i]);
      if (idx[i] >= lists[i].length) { ok = false; break; }
      target = lists[i][idx[i]];
    }
    if (ok && target === start + n - 1) {
      out.push({ va: start, units: n });
      if (out.length >= limit) break;
    }
    void last;
  }
  return out;
}

/** First index >= from whose value is >= target (list is ascending). */
function lowerBound(xs: number[], target: number, from = 0): number {
  let lo = from, hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] < target) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/** Tokenize a query the way the index was built. Spaces separate tokens. */
export function queryTokens(query: string): string[] {
  const out: string[] = [];
  const tk = new Tokenizer(query);
  for (;;) {
    const raw = tk.nextLiteral();
    if (raw.length === 0) break;
    if (tntTrim(raw) !== '') out.push(normalize(raw));
    if (tk.atEnd) break;
  }
  return out;
}

/** Look up a token string in a named container (binary search over names). */
export function tokenIndexByName(container: Container, name: string): number {
  if (!container.names.length) return -1;
  // container.names is in UTF-16 code unit order, same as the search key
  let lo = 0, hi = container.names.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const cmp = compareUtf16(container.names[mid], name);
    if (cmp === 0) return mid;
    if (cmp < 0) lo = mid + 1; else hi = mid - 1;
  }
  return -1;
}

/** Compare two strings by UTF-16 code unit, the order the adb stores. */
export function compareUtf16(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = a.charCodeAt(i) - b.charCodeAt(i);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

export interface SearchTokenState {
  token: string;
  /** block index in the tokens container, -1 when not indexed */
  block: number;
  postings: number[];
}

/**
 * A `s=` scope, as explained by the format author:
 *
 *   "*"           full text — the search we already have
 *   "~00602000"   only tokens whose code point starts in U+0060..U+2000
 *                 (i.e. a code-point range restriction on what is searched)
 *   "$詞"         all text wrapped by `<詞>`, and `tofind` may appear at the
 *                 start, middle or end of the wrapper
 *   "*u=文"       segment the results by `<文>`: the summary shows the SEGMENT
 *                 NAME (the text between `<文>` and `</文>`) and how many hits
 *                 that segment contains
 */
export type ScopeKind = 'full' | 'range' | 'segment' | 'wrapper' | 'other';

export interface Scope {
  kind: ScopeKind;
  /** raw s= value */
  raw: string;
  /** range scope: [from, to] as code points */
  codepoints?: [number, number];
  /** wrapper/segment scope: the tag name (詞 / 文) */
  tag?: string;
  /** true for full text and segment scopes, which cover the whole corpus */
  fullText: boolean;
}

export function parseScope(s: string): Scope {
  const raw = s ?? '';
  const seg = /^\*u=(\S+)$/.exec(raw);
  if (seg) return { kind: 'segment', raw, tag: seg[1], fullText: true };
  if (raw.startsWith('*')) return { kind: 'full', raw, fullText: true };
  const range = /^~([0-9a-fA-F]{2,8})$/.exec(raw);
  if (range) {
    const hex = range[1];
    const half = Math.max(2, Math.floor(hex.length / 2));
    const from = Number.parseInt(hex.slice(0, half), 16);
    const to = Number.parseInt(hex.slice(half), 16);
    return { kind: 'range', raw, codepoints: [from, to], fullText: false };
  }
  const wrap = /^\$(\S+)$/.exec(raw);
  if (wrap) return { kind: 'wrapper', raw, tag: wrap[1], fullText: false };
  return { kind: 'other', raw, fullText: false };
}

/**
 * A search tree declared by a `<樹>` tag.
 *
 *   <樹 s="*" t="書"/>
 *      s  scope:   see parseScope
 *      t  tiers:   the ENTRY tier. "書"    -> group by the <書> instance, then
 *                  follow each instance's own `t=` downward
 *                  "書." -> the trailing dot means terminal: do NOT descend
 *
 * One <樹> instance = one tree; several of them become several tabs.
 */
export interface SearchTree {
  /** index of the <樹> instance in the tags container */
  index: number;
  /** the raw s= value */
  scope: string;
  /** parsed scope */
  scopeInfo: Scope;
  /** true when this tree covers the whole text (full or segment scope) */
  fullText: boolean;
  /** tier tag names, in order */
  tiers: string[];
  /** tier index whose tag is terminal (from a trailing "."), -1 when none */
  terminalTier: number;
  /** VA of the <樹> tag instance itself */
  va: number;
}

/** Parse a `t=` value: "章,節,項." -> tiers [章,節,項] with 項 terminal. */
export function parseTiers(t: string): { tiers: string[]; terminalTier: number } {
  const raw = (t ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  let terminalTier = -1;
  const tiers = raw.map((name, i) => {
    if (name.endsWith('.')) {
      terminalTier = i;
      return name.slice(0, -1);
    }
    return name;
  });
  return { tiers, terminalTier };
}

/** Read every `<樹>` instance and its s= / t= attributes. */
export async function loadTrees(reader: AdbReader): Promise<SearchTree[]> {
  const tags = reader.containers.get('tags');
  if (!tags) return [];
  const at = tags.names.indexOf('樹');
  if (at < 0) return [];
  const va = await reader.decodeBlockList('tags', at);
  // attribute tables are indexed by instance order; a table may be shorter when
  // only some instances carry the attribute
  const s = await reader.attributeValues('樹.s');
  const t = await reader.attributeValues('樹.t');
  const out: SearchTree[] = [];
  for (let i = 0; i < va.length; i++) {
    const scope = s?.values[i] ?? s?.values[0] ?? '';
    const tiersRaw = t?.values[i] ?? t?.values[0] ?? '';
    const { tiers, terminalTier } = parseTiers(tiersRaw);
    const scopeInfo = parseScope(scope);
    out.push({
      index: i,
      scope,
      scopeInfo,
      fullText: scopeInfo.fullText,
      tiers,
      terminalTier,
      va: va[i] ?? 0,
    });
  }
  return out;
}

export interface SearchGroup {
  /** value of the grouping tag, e.g. "周易" */
  name: string;
  /** VA range of that tag instance: [from, to) */
  from: number;
  to: number;
  /** how many hits fall inside */
  count: number;
}

/**
 * Group search hits by the instances of `tag`.
 *
 * Every hit VA falls inside exactly one instance range: the instances' VAs are
 * ascending, so the range is found with a binary search — the same lookup the
 * engine uses to place a hit in its tree.
 */
export function groupHits(hits: PhraseHit[], tagVa: number[], maxVa: number, names?: string[]): SearchGroup[] {
  if (!tagVa.length) return [];
  const groups: SearchGroup[] = tagVa.map((from, i) => ({
    name: names?.[i] ?? `#${i + 1}`,
    from,
    to: i + 1 < tagVa.length ? tagVa[i + 1] : maxVa,
    count: 0,
  }));
  for (const h of hits) {
    const i = binarySearchLE(tagVa, h.va);
    if (i < 0) continue;
    // a hit before the first instance of the group has no group; it is counted
    // in the first one only when it really lies inside its VA range
    if (h.va >= groups[i].from && h.va < groups[i].to) groups[i].count++;
  }
  return groups;
}

/** Largest index whose value is <= target (values ascending); -1 when none. */
export function binarySearchLE(xs: number[], target: number): number {
  let lo = 0, hi = xs.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= target) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

// ------------------------------------------------------------------ directory tree
/**
 * One node of a `<樹>` directory tree.
 *
 * `depth` is the ABSOLUTE tier index (0 = first tier tag, e.g. 書), not a
 * nesting counter: measured on 13j, the first `<章>` (VA 45) sits inside the
 * first `<書>` (VA 29), so tiers always nest in order and depth is the tier.
 */
export interface TreeNode {
  /** tier index in `tiers` */
  depth: number;
  /** the tag of this node, e.g. 章 */
  tag: string;
  /** VA of the opening tag */
  va: number;
  /** VA just past this node's content (start of the next instance) */
  vaEnd: number;
  /** label resolved from the data (`n=` attribute or a name child tag) */
  label: string;
  /** 1-based occurrence of this instance among the same tag, in VA order */
  index: number;
  children: TreeNode[];
}

export interface TreeInstance {
  tag: string;
  depth: number;
  va: number;
  vaEnd: number;
  /** label resolved from the data (see VaPaMapper.nodeLabel) */
  label: string;
  /** child tier tag names declared by this instance's own `t=` (recursive trees) */
  children: string[];
  /** true when this instance's `t=` ends with "." (terminal: stop descending) */
  childTerminal: boolean;
  /** 0-based instance index within its tag's list (matches the attribute pointers) */
  index: number;
}

/** Per-instance attribute lookup: `<tag>.<attr>` values keyed by instance index. */
export async function loadInstanceAttrs(
  reader: AdbReader,
  tag: string,
  attr: string,
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const av = await reader.attributeValues(`${tag}.${attr}`);
  if (!av?.pointers) return out;
  for (let i = 0; i < av.values.length && i < av.pointers.length; i++) {
    // Low 24 bits are the 1-based tag instance index; the value order follows the
    // pointer order, so the index must come from the pointer, not from `i`.
    out.set((av.pointers[i] & 0xffffff) - 1, av.values[i]);
  }
  return out;
}

/**
 * Tier tag instances that take part in the tree, in document order.
 *
 * Only the `t=` tiers are read (e.g. 章,節,項), and a trailing "." marks the
 * last tier — nothing deeper is scanned. Each tier's tag list comes straight
 * from the `tags` container, so this is one packed-list read per tier.
 */
/**
 * Load a whole tree, level by level.
 *
 * The tier declaration is PER INSTANCE, so the levels cannot be known up front:
 * 13j's `<樹 t="書">` only names 書, but each `<書 t="章,節,項.">` then names its
 * own children, and `<章 t="節">` names the next level. So this walks breadth
 * first — load the current level's tag lists, read every instance's `t=`, load
 * the tiers they declare — until a level declares nothing (or a trailing "."
 * makes it terminal).
 */
export async function loadTree(
  reader: AdbReader,
  tree: SearchTree,
  opts: {
    label?: (va: number, vaEnd: number, attrs: Record<string, string>, tag: string) => Promise<string>;
    /** label only the entry tier now; the caller resolves deeper tiers as it draws them */
    entryLabelsOnly?: boolean;
    attrsAt?: (va: number) => Promise<Record<string, string>>;
  } = {},
): Promise<TreeInstance[]> {
  const tags = reader.containers.get('tags');
  if (!tags || !tree.tiers.length) return [];
  const start = parseTiers(tree.tiers.join(','));
  const maxVa = reader.header.maxBlockOffset;
  const out: TreeInstance[] = [];
  const readAttrs = opts.attrsAt ?? (async () => ({}));
  const tagVas = async (tag: string): Promise<number[]> => {
    const at = tags.names.indexOf(tag);
    return at < 0 ? [] : reader.decodeBlockList('tags', at);
  };
  /** per-instance `t=` from the attributes container (no source scanning) */
  const tierAttrs = new Map<string, Map<number, string>>();
  const tiersFor = async (tag: string, index: number): Promise<string> => {
    let table = tierAttrs.get(tag);
    if (!table) { table = await loadInstanceAttrs(reader, tag, 't'); tierAttrs.set(tag, table); }
    return table.get(index) ?? '';
  };

  /**
   * Walk the tier chain. **Every instance may declare its own `t=`** — if it does
   * not, that instance's branch stops descending (until the next instance of the
   * same tag). The first instance of a tag that declares something also seeds the
   * chain so the deeper tiers get loaded at all.
   */
  const chain: string[] = [];
  {
    let frontier = start.terminalTier >= 0
      ? start.tiers.slice(0, start.terminalTier + 1)
      : [...start.tiers];
    const seen = new Set(frontier);
    for (let level = 0; level < 12 && frontier.length; level++) {
      chain.push(...frontier);
      const next = new Set<string>();
      for (const tag of frontier) {
        const va = await tagVas(tag);
        for (let i = 0; i < va.length; i++) {
          const own = parseTiers(await tiersFor(tag, i));
          for (const t of own.tiers) {
            // A declared tier that is already in the chain would make the tree
            // fold back on itself (yinshun declares 經/組/文/甲… which reappear
            // higher up), so such a declaration is ignored and the branch ends.
            if (seen.has(t)) continue;
            next.add(t);
          }
        }
      }
      frontier = [...next];
      for (const t of frontier) seen.add(t);
    }
  }
  // load every instance of every tier in the chain, with its depth = chain level
  const chainLevel = new Map<string, number>();
  chain.forEach((tag, i) => { if (!chainLevel.has(tag)) chainLevel.set(tag, i); });
  for (const [tag, depth] of chainLevel) {
    const va = await tagVas(tag);
    for (let i = 0; i < va.length; i++) {
      out.push({
        tag, depth, va: va[i],
        vaEnd: i + 1 < va.length ? va[i + 1] : maxVa,
        label: '', children: [], childTerminal: false, index: i,
      });
    }
  }
  /**
   * PER-INSTANCE declaration with a TAG-LEVEL default.
   *
   * The declaration is authored once — among 13j's 13 books only
   * `<書 t="章,節,項." id="周易">` carries `t=` — and then applies to every
   * instance of that tag unless the instance declares its own. Without the default
   * 12 of 13 books would expand to nothing, even though their ranges hold 章/節.
   * `descend` carries the tiers to look for directly under the instance; for an
   * instance with no declaration of its own the CALLER passes its own down (see
   * `buildTree`), which is how 節/項 end up under a 章 that never declared them.
   */
  const defaultTiers = new Map<string, { tiers: string[]; terminal: boolean }>();
  for (const inst of out) {
    const own = parseTiers(await tiersFor(inst.tag, inst.index));
    if (own.tiers.length && !defaultTiers.has(inst.tag)) defaultTiers.set(inst.tag, own);
    const use = own.tiers.length ? own : defaultTiers.get(inst.tag);
    inst.children = use?.tiers ?? [];
    inst.childTerminal = use?.terminal ?? false;
  }

  out.sort((a, b) => a.va - b.va || a.depth - b.depth);
  // NOTE: a node's `children` stays empty when its own tag carries no `t=` —
  // that is what makes it a leaf. The tree-level `t=` belongs to the <樹>
  // declaration itself and must NOT be inherited by every instance (doing that
  // made each 書 declare 書 as its own child and exploded the tree).
  const MAX_LABEL_NODES = 20_000;
  for (let i = 0; i < out.length; i++) {
    const inst = out[i];
    if (opts.label && i < MAX_LABEL_NODES && (opts.entryLabelsOnly ? inst.depth === 0 : true)) {
      const attrs = await readAttrs(inst.va);
      inst.label = await opts.label(inst.va, inst.vaEnd, attrs, inst.tag);
    }
  }
  return out;
}


/**
 * Build the tree from tier instances, using the tier chain and document order.
 *
 * Every tag in an adb is a SIBLING (only `<檔>` nests, for XML validation), so the
 * markup itself carries no hierarchy — which is exactly what lets the same data
 * be shown as different trees. The hierarchy comes from the `t=` chain:
 *
 *   <樹 t="書">          the entry tier
 *   <書 t="章,節,項.">   the first `<書>` declares the next three tiers
 *   →  L1=書 → L2=章 → L3=節 → L4=項          (measured on 13j)
 *
 * A node therefore belongs to the most recent instance of the PREVIOUS tier in
 * document order ("最近的前一個上層"), not to whatever markup happens to enclose
 * it. Terminal tiers (trailing ".") are kept as the last level and nothing
 * deeper is read.
 */
export function buildTree(instances: TreeInstance[]): TreeNode[] {
  if (!instances.length) return [];
  const byTag = new Map<string, TreeInstance[]>();
  for (const inst of instances) {
    const list = byTag.get(inst.tag) ?? [];
    list.push(inst);
    byTag.set(inst.tag, list);
  }
  for (const list of byTag.values()) list.sort((a, b) => a.va - b.va);
  const counters = new Map<string, number>();
  let maxVa = 0;
  for (const inst of instances) maxVa = Math.max(maxVa, inst.vaEnd);

  /**
   * Parent = the most recent instance of the parent TAG, walking the declarations.
   *
   * `t="章,節,項."` names the tier AND its following siblings: the FIRST entry is
   * the direct child, the rest are the sibling slots that belong to the same
   * parent. An instance without `t=` has no children at all (per the format), and
   * a tag appearing in another instance's declaration is never a root.
   */
  const materialize = (
    inst: TreeInstance,
    depth: number,
    parentLimit: number,
    ownList: TreeInstance[],
    ownIdx: number,
    inherited: string[],
  ): TreeNode => {
    const index = (counters.get(inst.tag) ?? 0) + 1;
    counters.set(inst.tag, index);
    const node: TreeNode = {
      depth, tag: inst.tag, va: inst.va, vaEnd: inst.vaEnd,
      label: inst.label, index, children: [],
    };
    const isLastOfTag = ownIdx + 1 >= ownList.length;
    const ownEnd = Math.min(isLastOfTag ? maxVa : ownList[ownIdx + 1].va, parentLimit);
    node.vaEnd = Math.max(inst.va, ownEnd);
    // Which tiers to look for directly under this node: its own declaration, else
    // the one inherited from its ancestor. `<書 t="章,節,項.">` names the child tier
    // (章) AND its sibling slots (節, 項); a 章 with no `t=` of its own must still
    // reach those slots, so the declaration is passed down.
    const descend = inst.children.length ? inst.children : inherited;
    if (descend.length) {
      const slots = descend.slice(1);
      let cur = inst.va + 1;
      const guard = 1_000_000;
      for (let n = 0; n < guard; n++) {
        let best: { child: TreeInstance; list: TreeInstance[]; idx: number } | null = null;
        for (const tag of [descend[0], ...slots]) {
          const list = byTag.get(tag);
          if (!list) continue;
          const idx = lowerBoundVa(list, cur);
          const cand = idx < list.length ? list[idx] : null;
          if (!cand || cand.va >= node.vaEnd) continue;
          if (!best || cand.va < best.child.va) best = { child: cand, list, idx };
        }
        if (!best) break;
        node.children.push(materialize(best.child, depth + 1, node.vaEnd, best.list, best.idx, descend));
        cur = Math.max(best.child.va + 1, best.child.vaEnd);
      }
    }
    if (node.children.length) {
      node.va = Math.min(node.va, node.children[0].va);
      node.vaEnd = Math.max(node.vaEnd, node.children[node.children.length - 1].vaEnd);
    }
    return node;
  };

  // A tag named in SOME instance's `t=` is a child of that family, never a root.
  const declared = new Set<string>();
  for (const inst of instances) for (const t of inst.children ?? []) declared.add(t);
  const roots: TreeNode[] = [];
  for (const [tag, list] of byTag) {
    if (declared.has(tag)) continue;
    for (let i = 0; i < list.length; i++) roots.push(materialize(list[i], 0, maxVa, list, i, []));
  }
  if (!roots.length) {
    for (const [tag, list] of byTag) {
      for (let i = 0; i < list.length; i++) roots.push(materialize(list[i], list[i].depth, maxVa, list, i, []));
    }
  }
  // siblings may touch at the edges but must not swallow each other
  const fixRange = (ns: TreeNode[]): void => {
    for (let i = 0; i < ns.length; i++) {
      const n = ns[i];
      fixRange(n.children);
      const nextStart = i + 1 < ns.length ? ns[i + 1].va : n.vaEnd;
      n.vaEnd = Math.max(n.va, Math.min(n.vaEnd, nextStart));
    }
  };
  fixRange(roots);
  roots.sort((a, b) => a.va - b.va);
  return roots;
}

function lowerBoundVa(list: TreeInstance[], target: number): number {
  let lo = 0, hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].va < target) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/** Flat view of a tree, for rendering without recursion. */
export interface FlatNode {
  node: TreeNode;
  /** row index of the parent, -1 for roots */
  parent: number;
  hasChildren: boolean;
  /** bookkeeping for the renderer: which ancestor is the last of its level */
  lastFlags: boolean[];
}

export function flattenTree(
  roots: TreeNode[],
  open: (n: TreeNode) => boolean,
): FlatNode[] {
  const out: FlatNode[] = [];
  const walk = (nodes: TreeNode[], parent: number, lastFlags: boolean[]) => {
    nodes.forEach((node, i) => {
      const last = i === nodes.length - 1;
      const flags = [...lastFlags, last];
      const index = out.length;
      out.push({ node, parent, hasChildren: node.children.length > 0, lastFlags: flags });
      if (node.children.length && open(node)) walk(node.children, index, flags);
    });
  };
  walk(roots, -1, []);
  return out;
}

export interface SearchResult {
  query: string;
  tokens: SearchTokenState[];
  hits: PhraseHit[];
  /** true when some token of the query is not in the index at all */
  missing: string[];
  /** true when the hit list was cut off at maxHits */
  truncated: boolean;
  /** hits per instance of the grouping tag, when the database declares a tree */
  groups: SearchGroup[];
  /** the tag the groups are keyed by (the first full-text tree's first tier) */
  groupTag: string;
  ms: number;
}

/**
 * Incremental search state. A query is extended character by character, so the
 * posting lists already fetched are reused and only a new token costs a read.
 */
/** diagnostics: what the last host-answered search cost (state().hostSearch) */
export let lastHostSearch: {
  tokens: number; hits: number; lookupMs: number; andMs: number; groupMs: number; parallel: boolean; ms: number;
} | null = null;

export class SearchSession {
  private reader: AdbReader;
  private cache = new Map<string, SearchTokenState>();
  private tokensC: Container | null;
  /** trees declared by <樹> tags */
  trees: SearchTree[] = [];
  /** postings of the grouping tag of the first full-text tree */
  private groupTag = '';
  private groupVa: number[] | null = null;

  constructor(reader: AdbReader) {
    this.reader = reader;
    this.tokensC = reader.containers.get('tokens') ?? null;
  }

  /**
   * Read the `<樹>` declarations and resolve the grouping tag of the first
   * full-text tree (`s="*"`); its first tier (e.g. 書) is what the search
   * summaries are grouped by.
   */
  async init(): Promise<void> {
    this.trees = await loadTrees(this.reader);
    const tree = this.trees.find((t) => t.fullText && t.tiers.length) ?? this.trees.find((t) => t.tiers.length);
    this.groupTag = tree?.tiers[0] ?? '';
    const c = this.reader.containers.get('tags');
    if (c && this.groupTag) {
      const at = c.names.indexOf(this.groupTag);
      if (at >= 0) this.groupVa = await this.reader.decodeBlockList('tags', at);
    }
  }

  /**
   * Display names of the grouping-tag instances.
   *
   * `loadTrees` already resolved labels from the data where it can (13j: the
   * `<書>` instance's own `<頁元 n="周易"/>`; yinshun: no attribute table at all,
   * the title is the element's leading text). `reader.treeLabels` caches those.
   * Only when the tree was never walked do we fall back to an attribute table.
   */
  async groupNames(): Promise<string[]> {
    if (!this.groupTag) return [];
    // 1) The indexer already STORED the innerText of every instance as a string table
    //    (caches/書 for all three databases: 13j 13, yinshun 44, fgdict 7 — each
    //    exactly the instance count). One container parse, no source read, and it is
    //    the same table the 目錄 tree's labels were resolved from.
    const table = await this.reader.cachedStrings(this.groupTag);
    if (table.length && table.length === (this.groupVa?.length ?? 0)) return table;
    // 2) a tree walk may already have resolved them (free when it did)
    const fromTree = this.reader.treeLabels?.get(this.groupTag);
    if (fromTree?.length) return fromTree;
    // 3) last resort: the attribute table
    for (const key of [this.groupTag + '.n', this.groupTag + '.id']) {
      const av = await this.reader.attributeValues(key);
      if (av?.values.length) return av.values;
    }
    return [];
  }

  get grouping(): { tag: string; instances: number } {
    return { tag: this.groupTag, instances: this.groupVa?.length ?? 0 };
  }

  clear(): void { this.cache.clear(); }

  /** Posting list of one token (cached; one block read on a miss). */
  /**
   * A token's posting list. On the desktop the HOST answers it (Go decodes the packed
   * list straight out of the mmap); everywhere else the packed list is decoded here.
   */
  async lookup(token: string): Promise<SearchTokenState> {
    const hit = this.cache.get(token);
    if (hit) return hit;
    const hostPostings = this.reader.io.postings;
    if (hostPostings) {
      const postings = await hostPostings.call(this.reader.io, token);
      const state: SearchTokenState = { token, block: -1, postings };
      this.cache.set(token, state);
      return state;
    }
    const c = this.tokensC;
    let state: SearchTokenState = { token, block: -1, postings: [] };
    if (c) {
      const at = tokenIndexByName(c, token);
      if (at >= 0) state = { token, block: at, postings: await this.reader.decodeBlockList('tokens', at) };
    }
    this.cache.set(token, state);
    return state;
  }

  /** Run a query; reuses every posting list already fetched. */
  async search(query: string, maxHits = 5000): Promise<SearchResult> {
    const t0 = performance.now();
    const wanted = queryTokens(query);
    // THE DESKTOP HOST answers the whole index query in one call: it resolves the
    // tokens, decodes their posting lists (in parallel), does the phrase AND and the
    // grouping (wails/search.go). Tokenising stays here — that is language, not index.
    const hostSearch = this.reader.io.searchTokens;
    if (hostSearch && this.groupTag) {
      const out = await hostSearch.call(this.reader.io, wanted, this.groupTag, maxHits) as {
        hits?: { va: number; units: number }[];
        missing?: string[];
        truncated?: boolean;
        groups?: { name: string; from: number; to: number; count: number }[];
        lookupMs?: number; andMs?: number; groupMs?: number; parallel?: boolean;
      } | null;
      const hits = (out?.hits ?? []).map((h) => ({ va: h.va, units: h.units }));
      lastHostSearch = {
        tokens: wanted.length,
        hits: hits.length,
        lookupMs: out?.lookupMs ?? -1,
        andMs: out?.andMs ?? -1,
        groupMs: out?.groupMs ?? -1,
        parallel: !!out?.parallel,
        ms: performance.now() - t0,
      };
      return {
        query,
        tokens: wanted.map((t) => ({ token: t, block: -1, postings: [] })),
        hits,
        missing: out?.missing ?? [],
        truncated: !!out?.truncated,
        groups: (out?.groups ?? []).map((g) => ({ name: g.name, from: g.from, to: g.to, count: g.count })),
        groupTag: this.groupTag,
        ms: performance.now() - t0,
      };
    }
    const tokens: SearchTokenState[] = [];
    const missing: string[] = [];
    for (const t of wanted) {
      const st = await this.lookup(t);
      if (!st.postings.length) missing.push(t);
      tokens.push(st);
    }
    const hits = missing.length || !tokens.length
      ? []
      : phraseMatch(tokens.map((t) => t.postings), maxHits);
    let groups: SearchGroup[] = [];
    if (hits.length && this.groupVa && this.groupVa.length) {
      const names = await this.groupNames();
      groups = groupHits(hits, this.groupVa, this.reader.header.maxBlockOffset, names);
    }
    return {
      query, tokens, hits, missing,
      truncated: hits.length >= maxHits,
      groups,
      groupTag: this.groupTag,
      ms: performance.now() - t0,
    };
  }
}

/**
 * Search summary: the text around a hit, bounded by punctuation (or a length
 * cap), with the matched range marked. Reads at most two source blocks.
 */
export async function searchSummary(
  mapper: VaPaMapper,
  va: number,
  units: number,
  opts: { limit?: number; maxLeft?: number; phrase?: string } = {},
): Promise<{ text: string; start: number; end: number; line: number } | null> {
  // Drift-free path: when the caller knows WHAT was searched for, anchor the snippet
  // on the LINE TABLE (exact) and find the phrase by text. Everything below is
  // anchored on the mapper's walk, which drifts on some databases (fgdict by >1000
  // VA) — searching 法喜 then displayed and marked 帖見 instead.
  if (opts.phrase) {
    const line = await mapper.lineOfVa(va);
    const lineText = await mapper.lineText(line);
    const at = lineText ? lineText.indexOf(opts.phrase) : -1;
    if (at >= 0) {
      const pad = 30;
      const from = Math.max(0, at - pad);
      const to = Math.min(lineText.length, at + opts.phrase.length + pad);
      return { text: lineText.slice(from, to), start: at - from, end: at - from + opts.phrase.length, line };
    }
  }
  const el = await mapper.elementAt(va);
  if (!el) return null;
  const line = el.element.line ?? 0;
  const stride = mapper.stride;
  // Anchor the window on the block that actually CONTAINS the hit: the line may
  // start in an earlier block, and anchoring there put the hit outside the read
  // window (measured: 6 of 400 hits on yinshun produced an empty snippet with
  // start=80/end=0).
  const hitBlock = Math.floor(el.element.pa / stride);
  const limit = opts.limit ?? 160;
  const maxLeft = opts.maxLeft ?? 80;
  const from = Math.max(0, el.element.pa - maxLeft * 2);
  const read = await mapper.readSpan(hitBlock, from, from + (maxLeft + limit) * 4);
  const hitStartIn = Math.max(0, (el.element.pa - from) >> 1);
  // The match length is a CHARACTER count, not a token count: one Latin token
  // ("buddha") is one VA unit but six characters.
  const phraseText = await mapper.textOfVaSpan(va, units);
  const hitEndIn = Math.min(read.length, hitStartIn + Math.max(1, phraseText.length || units));
  let a = hitStartIn;
  let b = Math.max(hitEndIn, hitStartIn + 1);
  // extend right until punctuation or the cap
  while (b < read.length && b - hitStartIn < limit && !isPunctuation(read.charCodeAt(b))) b++;
  // extend left until punctuation, whitespace run, or the cap
  let steps = 0;
  while (a > 0 && hitStartIn - a < maxLeft && steps < maxLeft) {
    if (isPunctuation(read.charCodeAt(a - 1))) break;
    a--;
    steps++;
  }
  let text = read.slice(a, b);
  // trim leading/trailing whitespace without shifting the mark
  let lead = 0;
  while (lead < text.length && isWhitespace(text.charCodeAt(lead))) lead++;
  let tail = 0;
  while (tail < text.length - lead && isWhitespace(text.charCodeAt(text.length - 1 - tail))) tail++;
  text = text.slice(lead, text.length - tail);
  const start = Math.max(0, Math.min(text.length, hitStartIn - a - lead));
  // Mark exactly the VISIBLE phrase length. A skip tag between two characters of
  // the phrase (`太<頁 id="…"/>虛`) occupies PA space in the middle of the range
  // but contributes no visible text, so using the PA length painted the tag
  // source. `textOfVaSpan` already knows the visible text.
  const end = Math.max(start, Math.min(text.length, start + Math.max(1, phraseText.length || units)));
  // A snippet that does not contain the hit is worse than no snippet: fall back
  // to the raw hit text so the summary is never empty.
  if (!text.trim() || end <= start) {
    const fallback = phraseText || el.element.text;
    return { text: fallback, start: 0, end: fallback.length, line };
  }
  return { text, start, end, line };
}
