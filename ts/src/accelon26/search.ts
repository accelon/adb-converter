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
import { parseQuery, splitWildcard, PROXIMITY_TOKENS } from './query';
import { variantGroupOf, variantSearchOn } from './variants';
import type { VaPaMapper } from './vapa';

/** `.` 在詞組樣式裡代表「任意一個 token」 */
const WILD = null;

/** binary search: does the ascending list contain `v`? */
function hasVa(list: number[], v: number): boolean {
  let lo = 0, hi = list.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid] === v) return true;
    if (list[mid] < v) lo = mid + 1; else hi = mid - 1;
  }
  return false;
}

/**
 * 詞組比對，支援單字萬用字元：`lists` 裡的 `null` ＝ `.`（任意一個 token）。
 * 沒有萬用字元時退回 `phraseMatch`（同一套規則，只是快一點）。
 */
export function phraseMatchPattern(lists: (number[] | null)[], limit = 1_000_000): PhraseHit[] {
  if (!lists.length) return [];
  if (lists.every((l) => l !== null)) return phraseMatch(lists as number[][], limit);
  const n = lists.length;
  // 用第一個「有實際 token」的清單當錨點，回推詞組起點
  const anchorAt = lists.findIndex((l) => l !== null);
  if (anchorAt < 0) return [];
  const out: PhraseHit[] = [];
  for (const va of lists[anchorAt]!) {
    const start = va - anchorAt;
    if (start < 0) continue;
    let ok = true;
    for (let i = 0; i < n; i++) {
      const l = lists[i];
      if (!l || i === anchorAt) continue;
      if (!hasVa(l, start + i)) { ok = false; break; }
    }
    if (ok) {
      out.push({ va: start, units: n });
      if (out.length >= limit) break;
    }
  }
  return out;
}

export interface PhraseHit {
  /** VA of the first token of the match */
  va: number;
  /** how many VA units the match covers (= number of tokens) */
  units: number;
  /** multi-clause search: which clause produced this hit (paint colour) */
  clause?: number;
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
  /**
   * 沒有任何實例宣告 `t=` 的時候，**用 `<樹 t="…">` 的層級順序當階層**。
   *
   * jc（中醫笈成）就是這樣：`<樹 s="*" t="書名,章,節,項,目,條">` 宣告了六層，但
   * 1,358 個 `<書名>`、17,189 個 `<章>`… 自己都沒有 `t=`。那時 `buildTree` 會把每一層
   * 都當成根，目錄就變成「書名／章／節」混在一起的一長條（作者 2026-10 回報：
   * 一打開看到的是一本書的內目，不是書單）。
   *
   * 注意只往**下一層**要：`inst.children = chain[depth+1…]`，不含自己那一層
   * （含自己會讓 書名 宣告 書名 當子節點，樹會爆開 —— 這是舊的坑）。
   */
  if (out.length && !out.some((i) => i.children.length)) {
    for (const inst of out) {
      const rest = chain.slice(inst.depth + 1).filter((t) => t !== inst.tag);
      inst.children = [...new Set(rest)];
      inst.childTerminal = false;
    }
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
  /** 多詞組 + BM25 的結果（單詞組查詢沒有這個欄位） */
  multi?: MultiResult;
}

/**
 * Incremental search state. A query is extended character by character, so the
 * posting lists already fetched are reused and only a new token costs a read.
 */

// --------------------------------------------------------------- multi-clause search
/**
 * 一個「文件」＝一段文字的分割單位。BM25 的 df／tf／文件長度都以它為準：
 *
 *   s="*u=文"   以 `<tag u="文">` 的實例分段（yinshun：6,978 個 節）
 *   s="*詞"     以 `<詞>` 的實例分段（fgdict：22,648 個詞條）
 *   s="$詞"     同上（名詞分頁的詞條）
 *   s="*"       沒有這種宣告時退回分群標籤（13j：13 本 書）
 *
 * 文件長度＝**tag 位置的 VA 差值**（`to - from`），不必讀本文 —— 這是作者指定要
 * 省下來的開銷：VA 就是 token 位置，差值就是 token 數。
 */
export interface Segment { from: number; to: number; }

/** 一個詞組（= 使用者打的一個詞，內部可能有多個 token，仍要求相鄰） */
export interface MultiClause {
  text: string;
  /** tokenizer 切出來的 token（詞組內相鄰）；有 `.` 時只含實際 token */
  tokens: string[];
  role: 'required' | 'optional' | 'excluded';
  /** 被 `*` 綁住的詞組索引（-1 = 沒有） */
  nearOf: number;
  /** 這個詞組含單字萬用字元 `.`（塗色／摘要要用 VA span，不能只靠文字） */
  wildcard: boolean;
  /** 索引裡完全沒有的 token */
  missing: string[];
  /** 詞組出現次數（whole corpus） */
  occurrences: number;
  /** 含有這個詞組的文件數（document frequency） */
  df: number;
  /** BM25 的 idf */
  idf: number;
  /** 顏色索引（正面詞組的順序；排除詞為 -1） */
  colorIndex: number;
}

/**
 * 一個詞組的**原始命中**：TS 後端與 Go 後端共用的契約（作者 2026-10）。
 *
 * 後端只負責「這個詞組出現在哪些 VA」，檔案分段、BM25、塗色順序都在前端／
 * `rankClauses()` 做。Go 端（`wails/query.go`）回傳同樣形狀的 JSON。
 */
export interface ClauseHits {
  text: string;
  tokens: string[];
  role: 'required' | 'optional' | 'excluded';
  nearOf: number;
  wildcard: boolean;
  missing: string[];
  occurrences: number;
  /** 每個命中的起始 VA 與覆蓋 token 數（最多 maxHits 筆） */
  hits: PhraseHit[];
  colorIndex: number;
}

export interface MultiDoc {
  from: number;
  to: number;
  /** 文件長度（VA 差值＝token 數） */
  dl: number;
  score: number;
  /** 這個文件裡各正面詞組的命中次數（與 clauses 的 colorIndex 對齊） */
  tf: number[];
}

export interface MultiHit {
  va: number;
  units: number;
  /** 產生這個命中的詞組在 clauses 裡的索引（塗色用） */
  clause: number;
}

export interface MultiResult {
  query: string;
  /** 詞組（含排除詞），順序＝使用者輸入的順序 */
  clauses: MultiClause[];
  /** 排序後的文件（分數高的在前）；只保留前 `docLimit` 個 */
  docs: MultiDoc[];
  /** 符合條件的文件總數（不受 docLimit 影響） */
  docCount: number;
  /** 命中（依文件排名、再依 VA）；只保留被選中的文件 */
  hits: MultiHit[];
  /** 文件總數（分段數） */
  segments: number;
  /** 這些文件是怎麼切出來的（attr:／tag:／hier:／page:／group:／whole） */
  segmentSource: string;
  /** 分群統計（依第一個正面詞組的命中；沒有分群標籤就是空陣列） */
  groups: SearchGroup[];
  /** 平均文件長度（token） */
  avgdl: number;
  missing: string[];
  truncated: boolean;
  ms: number;
  /** BM25 是否真的有意義（只有一個文件時分數沒有鑑別力） */
  ranked: boolean;
  /** 診斷：文件長度是 VA 差值（不讀本文） */
  lengthFromVa: true;
}

const BM25_K1 = 1.2;
const BM25_B = 0.75;

/** 相鄰兩個分界相距小於這麼多 token 就不算新文件（書→它的第一章、章→它的第一節） */
export const MIN_SEG_GAP = 100;
/**
 * 可接受的文件平均長度（token）：**1 KB ~ 8 KB 都算好**（作者 2026-10）。
 * 書／章／節 只要落在這個範圍就採用 —— 它比 <頁> 好，因為一份文件是「一節」，
 * 而不是被紙本頁碼切斷的一段話。
 */
export const MIN_AVG_DOC = 1024;
export const MAX_AVG_DOC = 8192;
/** 結構分界的層級：由粗到細（書 → 書＋章 → 書＋章＋節） */
export const SEG_HIER_LEVELS: string[][] = [['書'], ['書', '章'], ['書', '章', '節']];
/** 最細的結構分界（文件地圖／測試用） */
export const SEG_HIER_TAGS = SEG_HIER_LEVELS[SEG_HIER_LEVELS.length - 1];
/** 最後的細分界 */
export const SEG_PAGE_TAGS = ['頁', '_頁'];

export class SearchSession {
  private reader: AdbReader;
  private cache = new Map<string, SearchTokenState>();
  private tokensC: Container | null;
  /** trees declared by <樹> tags */
  trees: SearchTree[] = [];
  /** postings of the grouping tag of the first full-text tree */
  private groupTag = '';

  /** 分群標籤（`backend.ts` 需要，唯讀） */
  get groupTagName(): string { return this.groupTag; }
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

  /** 上一次查詢實際查了哪些 token、各自的 posting list 有多長（診斷／hover 提示用） */
  private lastLookups: { token: string; postings: number; fromHost: boolean }[] = [];

  /** 見 lastLookups（複本，避免外部改到內部狀態） */
  lookups(): { token: string; postings: number; fromHost: boolean }[] {
    return this.lastLookups.map((x) => ({ ...x }));
  }

  private noteLookup(token: string, len: number, fromHost: boolean): void {
    const at = this.lastLookups.findIndex((x) => x.token === token);
    const rec = { token, postings: len, fromHost };
    if (at >= 0) this.lastLookups[at] = rec;
    else this.lastLookups.push(rec);
  }

  /**
   * A token's posting list. 繁簡通檢開著時，一個漢字會換成它那一組的所有寫法，
   * posting 取聯集（作者 2026-10：「菩薩」與「菩萨」要找到同一批位置）。
   */
  async lookup(token: string): Promise<SearchTokenState> {
    const group = variantSearchOn() ? variantGroupOf(token) : '';
    if (group.length < 2) return this.rawLookup(token);
    const key = '\u0001' + group;          // 合併結果按「整組」快取
    const merged = this.cache.get(key);
    if (merged) return merged;
    const all: number[] = [];
    for (const ch of group) {
      const st = await this.rawLookup(ch);
      for (const va of st.postings) all.push(va);
    }
    all.sort((a, b) => a - b);
    const postings = all.filter((v, i) => i === 0 || v !== all[i - 1]);
    const state: SearchTokenState = { token, block: -1, postings };
    this.cache.set(key, state);
    return state;
  }

  /** 單一 token 的 posting（沒有繁簡展開） */
  private async rawLookup(token: string): Promise<SearchTokenState> {
    const hit = this.cache.get(token);
    if (hit) {
      this.noteLookup(token, hit.postings.length, hit.block < 0 && !!this.reader.io.postings);
      return hit;
    }
    const hostPostings = this.reader.io.postings;
    if (hostPostings) {
      const postings = await hostPostings.call(this.reader.io, token);
      const state: SearchTokenState = { token, block: -1, postings };
      this.cache.set(token, state);
      this.noteLookup(token, postings.length, true);
      return state;
    }
    const c = this.tokensC;
    let state: SearchTokenState = { token, block: -1, postings: [] };
    if (c) {
      const at = tokenIndexByName(c, token);
      if (at >= 0) state = { token, block: at, postings: await this.reader.decodeBlockList('tokens', at) };
    }
    this.cache.set(token, state);
    this.noteLookup(token, state.postings.length, false);
    return state;
  }

  /** Run a query; reuses every posting list already fetched. */
  /**
   * 單一詞組的結果（`SearchResult`，給摘要／目錄徽章用）：**不排名**，全部命中照 VA 排，
   * 附上分群統計。作者 2026-10 重構：資料來源是 `ClauseHits`（與多詞組、Go 後端共用），
   * 不再有「舊片語引擎」那一條路。
   */
  async singleResult(parsed: ParsedQuery, clauses: ClauseHits[], maxHits: number, t0: number): Promise<SearchResult> {
    const positive = clauses.filter((c) => c.role !== 'excluded');
    const hits = positive
      .flatMap((c) => c.hits)
      .sort((a, b) => a.va - b.va)
      .slice(0, maxHits);
    const missing = [...new Set(clauses.flatMap((c) => c.missing))];
    const tokens: SearchTokenState[] = clauses.flatMap((c) =>
      c.tokens.map((t) => ({ token: t, block: -1, postings: [] as number[] })));
    return {
      query: parsed.raw,
      tokens,
      hits,
      missing,
      truncated: hits.length >= maxHits,
      groups: await this.groupStats(hits),
      groupTag: this.groupTag,
      ms: performance.now() - t0,
    };
  }

  /** 分群統計（`groupHits`）：沒有分群標籤或沒有命中就空陣列 */
  async groupStats(hits: PhraseHit[]): Promise<SearchGroup[]> {
    if (!hits.length || !this.groupVa?.length) return [];
    const names = await this.groupNames();
    return groupHits(hits, this.groupVa, this.reader.header.maxBlockOffset, names);
  }

  /** 單一詞組查詢（等於 `searchAuto` 收到「一個詞、沒有運算子」時走的那一條） */
  async search(query: string, maxHits = 5000): Promise<SearchResult> {
    const t0 = performance.now();
    this.lastLookups = [];
    const parsed = parseQuery(query);
    const clauses = await this.clauseHits(query, maxHits);
    return this.singleResult(parsed, clauses, maxHits, t0);
  }

  // ------------------------------------------------------ BM25 / 多詞組
  private segCache: Segment[] | null = null;
  private segSource = '';

  /**
   * 這個資料庫的「文件」分割（見 Segment 的說明）。
   *
   * 優先序（作者 2026-10）：
   *   1. `*u=值`（屬性分段）／`*tag`／`$tag`（詞條分段）—— scope 自己宣告的文件單位
   *   2. 沒有宣告時退回結構標籤 **書／章／節**（三者都算分界，但相鄰兩個分界
   *      距離小於 `MIN_SEG_GAP`（100 token）就不算新文件 —— 書和它的第一章、
   *      章和它的第一節之間不是兩份文件）。層級由粗到細試（書 → 書＋章 → 書＋章＋節），
   *      取第一個平均長度 ≤ `MAX_AVG_DOC`（8KB）的；**1KB–8KB 都算好**（作者 2026-10）。
   *   3. 連最細的結構層級都還是太粗（平均 > 8KB）→ 才改用 **頁／_頁**
   *   4. 都沒有 → 分群標籤（例如 13j 的 13 本 書）→ 整個庫
   *
   * 只讀 tags／attributes 容器，不掃本文；文件長度一律用 VA 差值。
   */
  async segments(): Promise<Segment[]> {
    if (this.segCache) return this.segCache;
    const maxVa = this.reader.header.maxBlockOffset;
    const tagsC = this.reader.containers.get('tags');
    const instancesOf = async (tag: string): Promise<number[]> => {
      const at = tagsC?.names.indexOf(tag) ?? -1;
      if (at < 0) return [];
      return (await this.reader.decodeBlockList('tags', at)).slice().sort((a, b) => a - b);
    };
    const fromVas = (vas: number[]): Segment[] =>
      vas.map((from, i) => ({ from, to: i + 1 < vas.length ? vas[i + 1] : maxVa }));
    /** 多個標籤的實例合在一起，套用「相距 < MIN_SEG_GAP 不算新文件」的規則 */
    const segmentsOfTags = async (tags: string[]): Promise<Segment[]> => {
      const vas: number[] = [];
      for (const tag of tags) vas.push(...(await instancesOf(tag)));
      if (!vas.length) return [];
      vas.sort((a, b) => a - b);
      const cuts: number[] = [];
      for (const va of vas) {
        if (cuts.length && va - cuts[cuts.length - 1] < MIN_SEG_GAP) continue;
        cuts.push(va);
      }
      return cuts.length ? fromVas(cuts) : [];
    };
    const avgLen = (s: Segment[]) =>
      s.length ? s.reduce((a, x) => a + Math.max(1, x.to - x.from), 0) / s.length : 0;

    // 1) scope 自己宣告的文件單位
    let segs: Segment[] = [];
    let source = '';
    const attrTree = this.trees.find((t) => /^\*\w+=(\S+)$/.test(t.scope));
    if (attrTree) {
      const m = /^\*(\w+)=(\S+)$/.exec(attrTree.scope)!;
      const attrName = m[1].split('.').pop()!.trim();
      const attrValue = m[2].trim();
      const attrs = this.reader.containers.get('attributes');
      const hitTags = new Set<string>();
      for (const key of attrs?.names ?? []) {
        const dot = key.lastIndexOf('.');
        if (dot <= 0 || key.slice(dot + 1) !== attrName) continue;
        const av = await this.reader.attributeValues(key);
        if (av?.values?.some((v) => v.trim() === attrValue)) hitTags.add(key.slice(0, dot));
      }
      const vas: number[] = [];
      for (const tag of hitTags) vas.push(...(await instancesOf(tag)));
      vas.sort((a, b) => a - b);
      if (vas.length) { segs = fromVas(vas); source = 'attr:' + attrTree.scope; }
    }
    if (!segs.length) {
      for (const re of [/^\*(\S+)$/, /^\$(\S+)$/]) {
        const tree = this.trees.find((t) => re.test(t.scope) && !/^\*$/.test(t.scope));
        if (!tree) continue;
        const tag = re.exec(tree.scope)![1].trim();
        if (tagsC && !tagsC.names.includes(tag)) continue;
        const vas = await instancesOf(tag);
        if (vas.length) { segs = fromVas(vas); source = 'tag:' + tree.scope; break; }
      }
    }
    // 2) 書／章／節（100 token 門檻）：由粗到細，挑第一個「平均長度 ≤ MAX_AVG_DOC（8KB）」
    //    的層級 —— 寧可粗一點（一節一份文件）也不要用 <頁> 把一段話切斷。
    if (!segs.length) {
      const levels: { tags: string[]; segs: Segment[]; avg: number }[] = [];
      for (const tags of SEG_HIER_LEVELS) {
        const s = await segmentsOfTags(tags);
        if (s.length >= 2) levels.push({ tags, segs: s, avg: avgLen(s) });
      }
      const pick = levels.find((l) => l.avg <= MAX_AVG_DOC);
      if (pick) {
        segs = pick.segs;
        source = 'hier:' + pick.tags.join('/');
      } else {
        const pages = await segmentsOfTags(SEG_PAGE_TAGS);
        if (pages.length >= 2) {
          segs = pages; source = 'page:' + SEG_PAGE_TAGS.join('/');
        } else if (levels.length) {
          const finest = levels[levels.length - 1];
          segs = finest.segs; source = 'hier:' + finest.tags.join('/');   // 頁也沒有：就用結構標籤
        }
      }
    }
    // 3) 分群標籤 → 整個庫
    if (!segs.length && this.groupVa?.length) { segs = fromVas(this.groupVa); source = 'group:' + this.groupTag; }
    if (!segs.length) { segs = [{ from: 0, to: maxVa }]; source = 'whole'; }
    this.segCache = segs;
    this.segSource = source;
    return segs;
  }

  /** 這個文件分割是怎麼來的（診斷／測試用）：attr:／tag:／hier:／page:／group:／whole */
  async segmentSource(): Promise<string> {
    if (!this.segSource) await this.segments();
    return this.segSource || 'whole';
  }

  /**
   * 多詞組 + BM25。
   *
   * 回傳的 `docs` 依分數排序（分數相同時按 VA），`hits` 也依照這個順序排，
   * 所以摘要清單自然是「最相關的文件先」。
   */
  /**
   * 詞組的**原始命中**（`ClauseHits`）——TS 後端與 Go 後端共用的契約：
   * 只回答「每個詞組出現在哪些 VA、有多少筆、哪些 token 不在索引裡」，
   * 檔案分段與 BM25 排名留給 `rankClauses()`。
   *
   * `wildcard` 的詞組用 `null` 當「任意一個 token」（`.`），交給
   * `phraseMatchPattern()`；`variants` 開啟時 `lookup()` 會把同組字的 posting 併起來。
   */
  async clauseHits(query: string, maxHits = 1_000_000): Promise<ClauseHits[]> {
    const parsed = parseQuery(query);
    const out: ClauseHits[] = [];
    let colorIndex = 0;
    for (const c of parsed.clauses) {
      // 單字萬用字元：`菩.心` ＝ 菩 ＋ 任意一個 token ＋ 心（作者 2026-10）
      const { parts, wild } = splitWildcard(c.text);
      const tokens = wild ? parts.flatMap((p) => queryTokens(p)) : queryTokens(c.text);
      const clause: ClauseHits = {
        text: c.text, tokens, role: c.role, nearOf: c.nearOf, wildcard: wild,
        missing: [], occurrences: 0, hits: [],
        colorIndex: c.role === 'excluded' ? -1 : colorIndex++,
      };
      const lists: (number[] | null)[] = [];
      let absent = false;
      const pushToken = async (t: string): Promise<void> => {
        const st = await this.lookup(t);
        if (!st.postings.length) { clause.missing.push(t); absent = true; }
        lists.push(st.postings);
      };
      if (!wild) {
        for (const t of tokens) await pushToken(t);
      } else {
        // parts[i] 之間各插一個 WILD（`.`）；空片段（開頭／結尾的 `.`）不產生 token
        for (let i = 0; i < parts.length; i++) {
          if (i > 0) lists.push(WILD);
          for (const t of queryTokens(parts[i])) await pushToken(t);
        }
      }
      clause.hits = !lists.length || absent ? [] : phraseMatchPattern(lists, maxHits);
      clause.occurrences = clause.hits.length;
      out.push(clause);
    }
    return out;
  }

  /** `clauseHits()` ＋ 匯總缺失的 token（測試與 Go 後端比對用） */
  async searchClauses(query: string, maxHits = 2000): Promise<{ clauses: ClauseHits[]; missing: string[] }> {
    const clauses = await this.clauseHits(query, maxHits);
    const missing = [...new Set(clauses.flatMap((c) => c.missing))];
    return { clauses, missing };
  }

  /**
   * 用「已經算好的詞組命中」排名：分段 → 候選文件 → `*` 鄰近 → 排除 → BM25。
   *
   * 這一段不碰索引（只讀 `segs` 與 `clauses`），所以 Go 後端只要回傳同樣形狀的
   * `ClauseHits[]`，就能用同一支程式得到完全相同的結果（作者 2026-10）。
   */
  async rankClauses(
    parsed: ParsedQuery,
    clauses: ClauseHits[],
    segs: Segment[],
    maxHits: number,
    docLimit: number,
    t0: number,
  ): Promise<MultiResult> {
    const segFrom = segs.map((s) => s.from);
    const segDoc = (va: number): number => binarySearchLE(segFrom, va);
    const missing = [...new Set(clauses.flatMap((c) => c.missing))];

    // 1) 每個詞組轉成 MultiClause（加上 df／idf）
    const per: { clause: MultiClause; occ: PhraseHit[]; byDoc: Map<number, number> }[] = [];
    for (const c of clauses) {
      const clause: MultiClause = {
        text: c.text, tokens: c.tokens, role: c.role, nearOf: c.nearOf, wildcard: c.wildcard,
        missing: c.missing, occurrences: c.occurrences, df: 0, idf: 0, colorIndex: c.colorIndex,
      };
      const occ = c.hits;
      const byDoc = new Map<number, number>();
      for (const h of occ) {
        const d = segDoc(h.va);
        if (d >= 0) byDoc.set(d, (byDoc.get(d) ?? 0) + 1);
      }
      clause.df = byDoc.size;
      clause.idf = Math.log(1 + (segs.length - clause.df + 0.5) / (clause.df + 0.5));
      per.push({ clause, occ, byDoc });
    }

    // 2) 候選文件：必要詞組的交集，否則可選詞組的聯集
    const positive = per.filter((p) => p.clause.role !== 'excluded');
    const required = positive.filter((p) => p.clause.role === 'required');
    const cand = new Set<number>();
    if (required.length) {
      for (const d of required[0].byDoc.keys()) {
        if (required.every((p) => p.byDoc.has(d))) cand.add(d);
      }
    } else {
      for (const p of positive) for (const d of p.byDoc.keys()) cand.add(d);
    }

    // 3) `A*B`：兩個詞組的出現位置距離 ≤ PROXIMITY_TOKENS（且落在同一個文件）
    for (const p of per) {
      if (p.clause.nearOf < 0 || p.clause.role === 'excluded') continue;
      const prev = per[p.clause.nearOf];
      if (!prev) continue;
      const ok = new Set<number>();
      const b = p.occ;
      let j = 0;
      for (const hit of prev.occ) {
        while (j < b.length && b[j].va < hit.va - PROXIMITY_TOKENS) j++;
        for (let k = j; k < b.length && b[k].va <= hit.va + PROXIMITY_TOKENS; k++) {
          const d = segDoc(hit.va);
          if (d >= 0 && d === segDoc(b[k].va)) ok.add(d);
        }
      }
      for (const d of [...cand]) if (!ok.has(d)) cand.delete(d);
    }

    // 4) 排除詞
    for (const p of per.filter((x) => x.clause.role === 'excluded')) {
      for (const d of p.byDoc.keys()) cand.delete(d);
    }

    // 5) BM25（文件長度＝tag 位置的 VA 差值，不讀本文）
    const total = segs.reduce((s, x) => s + Math.max(1, x.to - x.from), 0);
    const avgdl = Math.max(1, total / segs.length);
    const docs: MultiDoc[] = [];
    for (const d of cand) {
      const seg = segs[d];
      const dl = Math.max(1, seg.to - seg.from);
      let score = 0;
      const tf: number[] = [];
      for (const p of positive) {
        const f = p.byDoc.get(d) ?? 0;
        tf[p.clause.colorIndex] = f;
        if (!f) continue;
        score += p.clause.idf * ((f * (BM25_K1 + 1)) / (f + BM25_K1 * (1 - BM25_B + (BM25_B * dl) / avgdl)));
      }
      docs.push({ from: seg.from, to: seg.to, dl, score, tf });
    }
    docs.sort((a, b) => b.score - a.score || a.from - b.from);

    // 6) 命中：只留前 docLimit 個文件，依文件排名 → VA
    const keep = new Map<number, number>();          // doc from -> rank
    docs.slice(0, docLimit).forEach((doc, i) => keep.set(doc.from, i));
    const ranked: { va: number; units: number; clause: number; rank: number }[] = [];
    for (const p of positive) {
      const ci = per.indexOf(p);
      for (const h of p.occ) {
        const d = segDoc(h.va);
        if (d < 0) continue;
        const rank = keep.get(segs[d].from);
        if (rank === undefined) continue;
        ranked.push({ va: h.va, units: h.units, clause: ci, rank });
      }
    }
    ranked.sort((a, b) => (a.rank - b.rank) || (a.va - b.va));
    const truncated = ranked.length > maxHits;
    return {
      query: parsed.raw,
      clauses: per.map((p) => p.clause),
      docs: docs.slice(0, docLimit),
      docCount: docs.length,
      hits: ranked.slice(0, maxHits).map(({ va, units, clause }) => ({ va, units, clause })),
      segments: segs.length,
      segmentSource: await this.segmentSource(),
      groups: await this.groupStats(positive[0]?.occ ?? []),
      avgdl,
      missing,
      truncated,
      ms: performance.now() - t0,
      ranked: segs.length > 1,
      lengthFromVa: true,
    };
  }

  async searchMulti(query: string, maxHits = 5000, docLimit = 300): Promise<MultiResult> {
    const t0 = performance.now();
    this.lastLookups = [];
    const parsed = parseQuery(query);
    const segs = await this.segments();
    const clauses = await this.clauseHits(query, maxHits);
    return this.rankClauses(parsed, clauses, segs, maxHits, docLimit, t0);
  }

  /**
   * 依查詢語法自動選引擎：
   *   單一詞組、沒有運算子 → 舊的片語引擎（行為完全不變，還有分群與宿主查詢）
   *   有空白／`+`／`-`／`*`  → 多詞組 + BM25
   *
   * 回傳的物件刻意長得跟 `SearchResult` 一樣，UI 不需要分支。
   */
  async searchAuto(query: string): Promise<SearchResult> {
    const parsed = parseQuery(query);
    const multi = parsed.clauses.length > 1 || parsed.hasOperators || parsed.wildcard;
    if (!multi) return this.search(query);
    const m = await this.searchMulti(query);
    return {
      query,
      tokens: m.clauses.flatMap((c) => c.tokens.map((t) => ({ token: t, block: -1, postings: [] as number[] }))),
      hits: m.hits,
      missing: m.missing,
      truncated: m.truncated,
      groups: m.groups,
      groupTag: this.groupTag,
      ms: m.ms,
      multi: m,
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
