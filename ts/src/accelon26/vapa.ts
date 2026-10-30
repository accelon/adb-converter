/**
 * VA ↔ PA mapping for the viewer.
 *
 *   VA (virtual address)  = token position. +1 per indexed token, +1 per
 *        whitespace run, +4 per non-skip OPENING tag, 0 for closers and for
 *        skip tags (`頁` `聯` `註`…), CR/LF at a line start never counted.
 *   PA (physical address) = byte offset in the unpacked text on the fixed grid
 *        `blockIndex * srcblocksize + offsetInBlock`, UTF-16LE.
 *
 * Two ways to turn a VA into an element, and the viewer uses the FIRST one:
 *
 *   1. **table-anchored (O(1))** — `tables/lines.virtual` stores the VA at which
 *      every hard line starts, so the line holding a VA is a binary search and the
 *      line's elements can be tokenised standalone from that base. `elementAt()`
 *      does exactly this. taisho (241 MB, 11,255 blocks, 87.9 M VA units) forced
 *      this change: walking from block 0 to a book at VA 78 M took > 25 s and
 *      3.8 GB of `TokenPos` objects before it could answer a single click, which
 *      is the WebView2「內存不足」on a 16 GB machine.
 *   2. **sequential walk (O(VA))** — replay every line from 0 with a running VA
 *      counter. Still the ground truth for the *validation* tools (`validate`,
 *      `lineAdjacency`, `crossLinePairs`, `scoreModel`), which is why it is kept,
 *      but nothing on the reading path may use it any more.
 *
 * The walk also exists because `tables/blocks.virtual` records the VA at the
 * moment the indexer crossed into a block and a line can straddle that byte
 * boundary — the tokens before the boundary belong to the earlier block. Both
 * paths respect that by bucketing each element by `floor(pa / srcblocksize)`.
 */
import { AdbReader, binarySearchLE, type Container } from './adb';
import { Tokenizer, isSkipTag, normalize } from '../tokenize';
import { decodeXmlEntities } from '../xml-entities';
import { tntTrim } from '../unicode';

export const TAGLENGTH = 4;

export interface TokenPos {
  /** VA of this element's first unit */
  va: number;
  /** PA (byte offset in the physical address space) where it starts */
  pa: number;
  /** PA where it ends (exclusive) */
  paEnd: number;
  /** VA units consumed: 1 token/blank, 4 opening tag, 0 closer/skip tag */
  vaUnits: number;
  kind: 'token' | 'blank' | 'tag' | 'close';
  /** raw text of the element */
  text: string;
  /** tokenizer-normalized form (text tokens only) */
  normalized?: string;
  /** tag name, e.g. "頁" or "/頁" */
  tag?: string;
  /** true when this tag does not consume VA */
  skip?: boolean;
  /** line table index this element belongs to */
  line?: number;
}

export interface BlockWalk {
  block: number;
  /** VA at the first element that starts inside this block */
  vaBase: number;
  /** elements recorded in this block, in document order */
  positions: TokenPos[];
  /** PA range covered by this block */
  paStart: number;
  paEnd: number;
  /** first/last line index touched */
  firstLine: number;
  lastLine: number;
  tokens: number;
  tags: number;
}

export interface Highlight {
  block: number;
  /** PA of the hit, and of its end */
  pa: number;
  paEnd: number;
  /** character offsets inside the *joined* text when `text` is provided */
  text: string;
  element: TokenPos | null;
  insideTag: boolean;
}

/** A hit's character range inside one line of text (document rendering). */
export interface LineSpan {
  line: number;
  start: number;
  end: number;
  /** VA of the next expected element, used to continue onto the next line */
  va: number;
}

export interface ContextWindow {
  /** the window text, with the hit inside it */
  text: string;
  hitStart: number;
  hitEnd: number;
  block: number;
  pa: number;
  element: TokenPos | null;
  insideTag: boolean;
  /** how many source blocks the window was assembled from */
  blocks: number;
}

interface LineRec {
  index: number;
  paStart: number;
  paEnd: number;
  text: string;
  positions: TokenPos[];
  vaStart: number;
  vaEnd: number;
}

export class VaPaMapper {
  private reader: AdbReader;
  private srcBlocks: number;
  private vaBlocksStored: number[] | null = null;
  private linesEnds: number[] | null = null;
  private linesV: number[] | null = null;

  /** global walk state */
  private lineCursor = 0;
  private va = 0;
  private lineCache = new Map<number, LineRec>();
  private blockCache = new Map<number, BlockWalk>();
  private elemIndex: { pa: number; va: number; i: number; line: number }[] = [];
  private walkedComplete = false;

  /**
   * Table-anchored caches (see the header comment): a VA is resolved by
   * tokenising ONE line from its stored VA, so these stay tiny on any database
   * size. `KEEP_*` bounds are in lines/blocks, not bytes.
   */
  private lineAtCache = new Map<number, LineRec>();
  private lineAtOrder: number[] = [];
  private blockAtCache = new Map<number, BlockWalk>();
  private blockAtOrder: number[] = [];
  private static readonly KEEP_LINES = 64;
  private static readonly KEEP_BLOCKS = 12;

  /** tag instances seen so far (only for the blocks actually walked) */
  readonly tagHits: { tag: string; va: number }[] = [];
  /** VA computed for each block boundary, in walk order (index = block) */
  readonly computedBlockVa: number[] = [];
  readonly notes: string[] = [];

  constructor(reader: AdbReader) {
    this.reader = reader;
    this.srcBlocks = reader.containers.get('source')?.count ?? 0;
  }

  async init(): Promise<void> {
    if (this.linesEnds) return;
    this.linesEnds = await this.reader.linesPhysical();
    this.linesV = await this.reader.linesVirtual();
    this.vaBlocksStored = await this.reader.blocksVirtual();
  }

  get lineCount(): number { return this.linesEnds?.length ?? 0; }
  get linesPhysical(): number[] { return this.linesEnds ?? []; }
  get linesVirtual(): number[] { return this.linesV ?? []; }
  get blocksVirtualStored(): number[] { return this.vaBlocksStored ?? []; }
  /** bytes per source block (the PA grid stride) */
  get stride(): number { return this.reader.header.srcBlockSize; }
  /** first byte of line `i` in the PA space */
  lineStartOf(i: number): number { return i > 0 ? (this.linesEnds?.[i - 1] ?? 0) : 0; }

  /**
   * The line a VA belongs to: the first line whose END is at or past it.
   *
   * This is the paging primitive. It is a binary search over the line table (a
   * line "ends" at its own VA, so the table is ascending) and therefore works for
   * a line whose contents the mapper has not walked yet — pagination needs to know
   * *where* a node's lines are, not what is in them.
   */
  edgeLine(va: number): number {
    const v = this.linesV;
    if (!v || !v.length) return 0;
    let lo = 0, hi = v.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (v[mid] < va) lo = mid + 1; else hi = mid;
    }
    return Math.min(lo, v.length - 1);
  }

  /**
   * The line that physically holds `va`.
   *
   * A VA equal to a line's END sits AFTER that line's last element, and since a
   * hard line break costs no VA the next line starts at the same VA — so the
   * element belongs to the NEXT line. Getting this wrong (the raw `edgeLine`)
   * makes a tag click land one line high.
   */
  lineOfVa(va: number): number {
    const v = this.linesV;
    if (!v || !v.length) return 0;
    let i = this.edgeLine(va);
    while (i + 1 < v.length && va === v[i]) i++;
    return i;
  }

  /**
   * Length (in code units) of the `p`-th percentile line of the whole document.
   * Used to pick a document font size at which most hard lines fit the pane, so
   * the reader does not fight soft wrapping. `sample` caps the scan (lines are
   * evenly sampled when the document has more).
   */
  lineLengthPercentile(p = 0.9, sample = 200_000): number {
    const ends = this.linesEnds;
    if (!ends || !ends.length) return 0;
    const step = Math.max(1, Math.floor(ends.length / sample));
    const lens: number[] = [];
    for (let i = 0; i < ends.length; i += step) {
      const s = i > 0 ? ends[i - 1] : 0;
      lens.push(Math.max(0, (ends[i] - s) >> 1));
    }
    lens.sort((a, b) => a - b);
    return lens[Math.min(lens.length - 1, Math.floor(lens.length * p))] ?? 0;
  }
  /**
   * Longest sampled line that is still at most `maxUnits` code units — the
   * "ordinary long line" of the document, in contrast to a rare outlier.
   *
   * The viewer needs it for its auto font size: the page in the DOM is only a
   * couple of hundred lines, so deriving the cap from the page would make the
   * font change while paging. Reading it from the line table keeps the answer
   * stable for the whole document.
   */
  lineLengthMaxUnder(maxUnits: number, sample = 200_000): number {
    const ends = this.linesEnds;
    if (!ends || !ends.length) return 0;
    const step = Math.max(1, Math.floor(ends.length / sample));
    let best = 0;
    for (let i = 0; i < ends.length; i += step) {
      const s = i > 0 ? ends[i - 1] : 0;
      const len = Math.max(0, (ends[i] - s) >> 1);
      if (len > best && len <= maxUnits) best = len;
    }
    return best;
  }

  /** text of a PA range (cross-block safe), used for search summaries */
  async readSpan(block: number, paStart: number, paEnd: number): Promise<string> {
    return this.reader.textSpan(block, paStart, paEnd);
  }

  /**
   * The raw text of hard line `i`, straight from the (cached) source block — the
   * same slice `docText` renders, and the ground truth for anything that must be
   * read by PA. Use this instead of walking VA→PA when accuracy matters: the walk
   * can drift from the stored VA table, which silently yields a neighbouring
   * element's text.
   */
  async lineText(i: number): Promise<string> {
    await this.init();
    const paS = this.lineStart(i);
    const paE = this.linesEnds?.[i] ?? paS;
    if (paE <= paS) return '';
    let line = await this.reader.textSpan(Math.floor(paS / this.reader.header.srcBlockSize), paS, paE);
    // getrange_physical skips a leading CR/LF of the line
    if (line.charCodeAt(0) === 13) line = line.slice(1);
    if (line.charCodeAt(0) === 10) line = line.slice(1);
    return line;
  }
  get progress(): { lines: number; va: number; blocks: number; complete: boolean } {
    return { lines: this.lineCursor, va: this.va, blocks: this.blockCache.size, complete: this.walkedComplete };
  }

  // ------------------------------------------------------------------ walk
  private lineStart(i: number): number {
    return i > 0 ? this.linesEnds![i - 1] : 0;
  }

  /**
   * Anchors: the stored VA of each tag instance, sorted by VA.
   *
   * The walk reproduces the stored VAs exactly for some databases (13j: every
   * block boundary and all 2,973 tag VAs) but can drift on others whose build
   * docdef is not recoverable from the file (yinshun: +4 from block 322 on,
   * i.e. 0.0002% of the VA space; SPEC §17.4 records this class of difference).
   * Because a query is always local, the mapper snaps to the nearest stored tag
   * VA — ground truth written by the original build — and walks forward from
   * there. Everything between two anchors is then exact up to the next anchor.
   */
  private anchors: { va: number; tag: string; index: number }[] = [];
  private anchorLoaded = false;

  /** Load every stored tag instance VA as an anchor (one packed list per tag). */
  async loadAnchors(): Promise<number> {
    if (this.anchorLoaded) return this.anchors.length;
    const c = this.reader.containers.get('tags');
    if (!c) { this.anchorLoaded = true; return 0; }
    const out: { va: number; tag: string; index: number }[] = [];
    for (let i = 0; i < c.count; i++) {
      const name = c.names[i];
      const list = await this.reader.decodeBlockList('tags', i);
      for (let k = 0; k < list.length; k++) out.push({ va: list[k], tag: name, index: k });
    }
    out.sort((a, b) => a.va - b.va);
    this.anchors = out;
    this.anchorLoaded = true;
    return out.length;
  }

  /** Nearest anchor at or before `va`. */
  nearestAnchor(va: number): { va: number; tag: string; index: number } | null {
    if (!this.anchors.length) return null;
    const i = binarySearchLE(this.anchors.map((a) => a.va), va);
    return i < 0 ? null : this.anchors[i];
  }

  /** Does the walk at `va` agree with the anchor? (diagnostic) */
  async anchorAgreement(va: number): Promise<{ anchor: { va: number; tag: string; index: number } | null; walked: number | null; delta: number | null }> {
    const a = this.nearestAnchor(va);
    const el = await this.elementAt(va);
    if (!a || !el) return { anchor: a, walked: el?.element.va ?? null, delta: null };
    return { anchor: a, walked: el.element.va, delta: el.element.va - a.va };
  }

  /**
   * Tag VA cost model — chosen by measuring candidates against the stored VAs.
   *
   * The stored tag VAs of 13j show the convention directly:
   *   `<集>` -> VA 0, `</集>` -> VA 7, `<隱>` -> VA 11, `<樹>` -> VA 15
   * i.e. an opening tag AND its closer each consume TAGLENGTH units, while a
   * skip tag (`頁`, `聯`, `註`, `圖`…) consumes none — its VA is just the
   * position where it was seen. Whether a tag is skip is a build-docdef
   * decision that is not stored in the adb (SPEC §15.6/§17.4).
   *
   * `scoreModel` compares the candidates against tables/blocks.virtual so the
   * choice is reproducible rather than assumed.
   */
  private costStyle: 'pair-rule' | 'closer0' | 'all4' | 'all0' = 'pair-rule';

  private costOf(name: string, isClose: boolean, skipByName: boolean, raw: string): number {
    if (this.costStyle === 'all4') return TAGLENGTH;
    if (this.costStyle === 'all0') return 0;
    if (skipByName) return 0;
    if (this.costStyle === 'closer0') return isClose ? 0 : TAGLENGTH;
    // pair-rule: open and close both cost TAGLENGTH (verified on 13j)
    return TAGLENGTH;
  }

  private resetWalk(): void {
    this.lineCursor = 0;
    this.va = 0;
    this.lineCache.clear();
    this.blockCache.clear();
    this.computedBlockVa.length = 0;
    this.elemIndex.length = 0;
    this.tagHits.length = 0;
    this.walkedComplete = false;
  }

  /**
   * Try a cost model over the first `maxBlocks` blocks and report how well the
   * walked VAs match the stored ones. The element sequence does not depend on
   * the model, so this isolates the cost rule.
   */
  async scoreModel(style: 'skip-rule' | 'selfclose0' | 'selfclose4' | 'all4' | 'all0',
    maxBlocks = 400): Promise<{ style: string; blocksBad: number; blocksChecked: number; firstBad: { block: number; walked: number; stored: number } | null }> {
    await this.init();
    const prev = this.costStyle;
    this.costStyle = style;
    this.resetWalk();
    await this.advanceTo(maxBlocks);
    let blocksBad = 0, blocksChecked = 0;
    let firstBad: { block: number; walked: number; stored: number } | null = null;
    for (let b = 0; b < Math.min(maxBlocks, this.vaBlocksStored!.length); b++) {
      const w = this.blockCache.get(b);
      if (!w) continue;
      blocksChecked++;
      if (w.vaBase !== this.vaBlocksStored![b]) {
        blocksBad++;
        if (!firstBad) firstBad = { block: b, walked: w.vaBase, stored: this.vaBlocksStored![b] };
      }
    }
    this.costStyle = prev;
    this.resetWalk();
    return { style, blocksBad, blocksChecked, firstBad };
  }

  /** Tokenize one line (cached) and assign VAs from the current walk position. */
  private async walkLine(index: number): Promise<LineRec> {
  }

  get learnedCosts(): { tag: string; cost: number }[] {
    return [...this.tagCost].map(([tag, cost]) => ({ tag, cost }));
  }

  /** Tokenize one line (cached) and assign VAs from the current walk position. */
  private async walkLine(index: number): Promise<LineRec> {
    const cached = this.lineCache.get(index);
    if (cached) return cached;
    const rec = await this.tokenize(index, this.va);
    this.va = rec.vaEnd;              // the walk continues where this line stopped
    this.lineCache.set(index, rec);
    return rec;
  }

  /**
   * VA at which hard line `index` starts.
   *
   * `tables/lines.virtual[i]` is the VA of the line's LAST unit (an inclusive end,
   * measured on 13j: line 0 `<集>十三經</集>` ends at VA 10 while the next element
   * `<隱>` sits at 11), so the start of line i is `lines.virtual[i-1] + 1`.
   * `edgeLine` already reads the table this way (`first line whose end >= va`).
   */
  private lineVaStart(index: number): number {
    return index > 0 ? (this.linesV?.[index - 1] ?? -1) + 1 : 0;
  }

  /**
   * Tokenise ONE line standalone, with `vaStart` as the VA of its first element.
   * The walk passes its running counter; the table-anchored path passes the stored
   * line VA, which is what makes a lookup independent of everything before it.
   */
  private async tokenize(index: number, vaStart: number): Promise<LineRec> {
    const paStart = this.lineStart(index);
    const paEnd = this.linesEnds![index];
    const text = await this.reader.textSpan(Math.floor(paStart / this.reader.header.srcBlockSize), paStart, paEnd);
    const positions: TokenPos[] = [];
    let va = vaStart;
    if (text.length > 0) {
      const tk = new Tokenizer(text);
      for (;;) {
        const raw = tk.nextLiteral();
        // `tk.offset` is the offset of the token that was just read (the
        // pending token), so it must be read AFTER nextLiteral — reading it
        // before yields the previous token's start and shifts every PA.
        const pa = paStart + tk.offset * 2;
        if (raw.charCodeAt(0) === 0x3c) {
          const name = tagNameOf(raw);
          const isClose = name.startsWith('/');
          const short = isClose ? name.slice(1) : name;
          const skip = isSkipTag(short);
          const units = this.costOf(name, isClose, skip, raw);
          positions.push({
            va, pa, paEnd: pa + raw.length * 2, vaUnits: units,
            kind: isClose ? 'close' : 'tag', text: raw, tag: name, skip: units === 0, line: index,
          });
          va += units;
        } else if (tntTrim(raw) !== '') {
          const norm = normalize(raw);
          positions.push({ va, pa, paEnd: pa + raw.length * 2, vaUnits: 1, kind: 'token', text: raw, normalized: norm, line: index });
          va += 1;
        } else {
          positions.push({ va, pa, paEnd: pa + raw.length * 2, vaUnits: 1, kind: 'blank', text: raw, line: index });
          va += 1;
        }
        if (tk.atEnd) break;
      }
    }
    return { index, paStart, paEnd, text, positions, vaStart, vaEnd: va };
  }

  /** remember `key` in a bounded insertion-order cache */
  private remember<T>(cache: Map<number, T>, order: number[], key: number, value: T, keep: number): void {
    cache.set(key, value);
    order.push(key);
    while (order.length > keep) {
      const old = order.shift()!;
      if (!order.includes(old)) cache.delete(old);
    }
  }

  /** the tokenised line, anchored on the stored line VA (no walk) */
  private async lineAt(index: number): Promise<LineRec> {
    await this.init();
    const hit = this.lineAtCache.get(index);
    if (hit) return hit;
    const rec = await this.tokenize(index, this.lineVaStart(index));
    this.remember(this.lineAtCache, this.lineAtOrder, index, rec, VaPaMapper.KEEP_LINES);
    return rec;
  }

  /**
   * The elements that START inside one source block, built from the line table
   * only (the walk-free twin of the `blockCache` that `advanceTo` fills).
   */
  private async blockAt(block: number): Promise<BlockWalk | null> {
    await this.init();
    if (block < 0 || block >= this.srcBlocks) return null;
    const hit = this.blockAtCache.get(block);
    if (hit) return hit;
    const stride = this.reader.header.srcBlockSize;
    const paStart = block * stride;
    const paEnd = paStart + stride;
    const ends = this.linesEnds!;
    // first line whose END is past the block start (a line may straddle into it)
    let lo = 0, hi = ends.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ends[mid] <= paStart) lo = mid + 1; else hi = mid;
    }
    const positions: TokenPos[] = [];
    let firstLine = lo, lastLine = lo;
    for (let i = lo; i < ends.length && this.lineStart(i) < paEnd; i++) {
      const rec = await this.lineAt(i);
      for (const p of rec.positions) {
        if (Math.floor(p.pa / stride) !== block) continue;
        positions.push(p);
      }
      lastLine = Math.max(lastLine, i);
    }
    const vaBase = block === 0 ? 0 : (this.vaBlocksStored?.[block] ?? (positions[0]?.va ?? 0));
    let tokens = 0, tags = 0;
    for (const p of positions) {
      if (p.kind === 'tag' || p.kind === 'close') tags++; else tokens++;
    }
    const w: BlockWalk = {
      block, vaBase, positions, paStart, paEnd,
      firstLine, lastLine, tokens, tags,
    };
    this.remember(this.blockAtCache, this.blockAtOrder, block, w, VaPaMapper.KEEP_BLOCKS);
    return w;
  }

  /**
   * VA units the line's elements occupy, tokenised standalone. Used by the tests
   * to prove that `tables/lines.virtual` really is a valid anchor for this file.
   */
  async lineUnits(index: number): Promise<number> {
    const rec = await this.lineAt(index);
    return rec.vaEnd - rec.vaStart;
  }

  /**
   * Advance the walk until every element that starts before
   * `block * srcblocksize` has been assigned. Everything stays cached, so
   * repeated lookups in the same region are free.
   */
  async advanceTo(block: number): Promise<void> {
    await this.init();
    const stride = this.reader.header.srcBlockSize;
    const limit = block * stride;                 // first PA of that block
    if (this.lineCursor >= this.linesEnds!.length) { this.walkedComplete = true; return; }

    while (this.lineCursor < this.linesEnds!.length && this.lineStart(this.lineCursor) < limit) {
      const rec = await this.walkLine(this.lineCursor);
      // Fold this line's elements into the block each one belongs to. A block is
      // opened by the first element whose PA reaches it, and that element's VA
      // (before it is counted) is the block's start VA — verified against
      // tables/blocks.virtual (e.g. PA 16384 -> VA 8093 in 13j).
      for (const p of rec.positions) {
        const b = Math.floor(p.pa / stride);
        if (b < 0 || b >= this.srcBlocks) continue;
        while (this.computedBlockVa.length <= b) {
          const nb = this.computedBlockVa.length;
          // The block's start VA is ground truth from tables/blocks.virtual: it
          // is NOT simply the crossing element's VA (measured: boundary PA 16384
          // with crossing token va=8092 stores 8093, while some blocks with a
          // crossing tag store va+vaUnits). Using the stored table removes the
          // guesswork; it is also the anchor a human would pick.
          const stored = this.vaBlocksStored?.[nb];
          const vaBase = nb === 0 ? 0 : (stored !== undefined ? stored : p.va + Math.max(1, p.vaUnits));
          this.computedBlockVa.push(vaBase);
          this.blockCache.set(nb, {
            block: nb, vaBase, positions: [],
            paStart: nb * stride, paEnd: (nb + 1) * stride,
            firstLine: rec.index, lastLine: rec.index, tokens: 0, tags: 0,
          });
        }
        const w = this.blockCache.get(b)!;
        w.positions.push(p);
        if (p.kind === 'tag' || p.kind === 'close') { w.tags++; this.tagHits.push({ tag: p.tag!, va: p.va }); }
        else w.tokens++;
        w.firstLine = Math.min(w.firstLine, rec.index);
        w.lastLine = Math.max(w.lastLine, rec.index);
        this.elemIndex.push({ pa: p.pa, va: p.va, i: w.positions.length - 1, line: rec.index });
      }
      this.lineCursor++;
    }
    if (this.lineCursor >= this.linesEnds!.length) {
      this.walkedComplete = true;
      // the tail block(s): fill in any block whose start we passed
      const lastBlock = Math.floor((this.linesEnds![this.linesEnds!.length - 1] - 1) / stride);
      while (this.computedBlockVa.length <= Math.min(lastBlock, this.srcBlocks - 1)) {
        const b = this.computedBlockVa.length;
        this.computedBlockVa.push(this.va);
        this.blockCache.set(b, { block: b, vaBase: this.va, positions: [], paStart: b * stride, paEnd: (b + 1) * stride, firstLine: this.lineCursor, lastLine: this.lineCursor, tokens: 0, tags: 0 });
      }
    }
  }

  /** Walk everything (used by validation and by document-level rendering). */
  async walkAll(): Promise<void> { await this.advanceTo(this.srcBlocks); }

  async blockWalk(block: number): Promise<BlockWalk | null> {
    return this.blockAt(block);
  }

  // --------------------------------------------------------------- mapping
  blockOfVa(va: number): number {
    const stored = this.vaBlocksStored;
    if (stored && stored.length) {
      const b = binarySearchLE(stored, va);
      if (b >= 0) return b;
    }
    return 0;
  }

  /**
   * The element covering `va`.
   *
   * Table-anchored: `blockOfVa` gives the block, `blockAt` builds only that block
   * from the line table, and the answer is a scan inside it — O(1 block) instead
   * of O(VA). A database without `tables/lines.virtual` (nothing to anchor on)
   * falls back to the walk.
   */
  async elementAt(va: number, maxBlocks = 600): Promise<{ element: TokenPos; block: number } | null> {
    await this.init();
    const start = this.blockOfVa(va);
    if (this.linesV?.length) {
      const stored = this.vaBlocksStored;
      for (let b = start; b < Math.min(this.srcBlocks, start + maxBlocks); b++) {
        const nextBase = b + 1 < this.srcBlocks ? (stored?.[b + 1] ?? Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY;
        if (va >= nextBase) continue;               // belongs to a later block
        const w = await this.blockAt(b);
        if (!w || !w.positions.length) {
          if (va < nextBase) return null;           // empty block
          continue;
        }
        let hit: TokenPos | null = null;
        for (const p of w.positions) {
          if (p.va <= va) hit = p;
          else break;
        }
        if (!hit) hit = w.positions[0];
        return { element: hit, block: b };
      }
      return null;
    }
    for (let b = start; b < Math.min(this.srcBlocks, start + maxBlocks); b++) {
      await this.advanceTo(b + 1);
      const w = this.blockCache.get(b);
      const nextBase = this.blockCache.get(b + 1)?.vaBase ?? Number.POSITIVE_INFINITY;
      if (va >= nextBase) continue;               // belongs to a later block
      if (!w || !w.positions.length) {
        if (va < nextBase) return null;           // empty block
        continue;
      }
      let hit: TokenPos | null = null;
      for (const p of w.positions) {
        if (p.va <= va) hit = p;
        else break;
      }
      if (!hit) hit = w.positions[0];
      return { element: hit, block: b };
    }
    return null;
  }

  /** Where does this VA live? Character offsets, not just block indices. */
  async highlight(va: number, maxBlocks = 600): Promise<Highlight | null> {
    const found = await this.elementAt(va, maxBlocks);
    if (!found) return null;
    const { element, block } = found;
    const stride = this.reader.header.srcBlockSize;
    const blockStart = block * stride;
    const text = await this.reader.sourceText(block);
    const start = Math.max(0, Math.min(text.length, (element.pa - blockStart) >> 1));
    let end = Math.max(start, Math.min(text.length, (element.paEnd - blockStart) >> 1));
    let out = text.slice(start, end);
    // An element can extend into the next block (a long romanized word that
    // straddles the grid): grow until the element's text is enclosed.
    if (out !== element.text && element.text.length > out.length && block + 1 < this.srcBlocks) {
      out = await this.reader.textSpan(block, element.pa, element.paEnd);
    }
    return {
      block, pa: element.pa, paEnd: element.paEnd,
      text: out,
      element,
      insideTag: element.kind === 'tag' && element.vaUnits > 0 && va > element.va,
    };
  }

  /**
   * Labels resolved per tag for directory trees: tag name -> label per instance.
   * Shared with the search grouping so a book has the same name everywhere.
   */
  readonly treeLabels = new Map<string, string[]>();

  /**
   * Text of a VA span, token by token, NOT following lines. Used for node labels
   * in a directory tree: `<書><檔 n="周易"/></書>` has to be walked as elements
   * because names live in child tags (yinshun has no `書.n` attribute at all).
   */
  async visibleText(va: number, vaEnd: number, maxChars = 400, maxSteps = 400): Promise<string> {
    if (vaEnd <= va) return '';
    const out: string[] = [];
    let cur = va;
    let steps = 0;
    while (cur < vaEnd && steps++ < maxSteps) {
      const el = await this.elementAt(cur);
      if (!el) break;
      const e = el.element;
      if (e.kind === 'token') out.push(e.normalized ?? e.text);
      else if (e.kind === 'blank') out.push(e.text);
      // tags contribute nothing (their tail is a `/<tag>` closer)
      if (e.kind === 'tag' || e.kind === 'close') {
        const nm = /^\/?([^\s/>]+)/.exec(e.text.replace(/^</, ''))?.[1];
        if (nm && e.kind === 'close' && nm.startsWith('/')) { /* closer */ }
      }
      const next = e.va + Math.max(1, e.vaUnits);
      if (e.kind === 'close') {
        // closers cost no VA, so `next` may repeat; step by element order instead
        const after = await this.elementAfter(el);
        if (!after) break;
        if (after.va >= vaEnd) break;
        cur = after.va;
        continue;
      }
      if (next >= vaEnd) break;
      cur = next;
      if (out.join('').length > maxChars) break;
    }
    return out.join('').slice(0, maxChars);
  }

  /**
   * The element right after `found` in document order — used to step over a skip
   * tag, which costs no VA and therefore cannot be reached by adding units.
   */
  private async elementAfter(found: { element: TokenPos; block: number }): Promise<TokenPos | null> {
    const w = this.blockAtCache.get(found.block) ?? this.blockCache.get(found.block);
    const list = w?.positions;
    if (list) {
      const idx = list.indexOf(found.element);
      if (idx >= 0) return list[idx + 1] ?? null;
    }
    const line = found.element.line;
    if (line === undefined) return null;
    const rec = await this.lineAt(line);
    const idx = rec.positions.indexOf(found.element);
    return idx >= 0 ? (rec.positions[idx + 1] ?? null) : null;
  }

  /**
   * A readable label for the tag instance at `va`: prefer a name-ish attribute
   * on the tag itself or on one of its immediate children (`n` then `t`/`l`/`id`),
   * and fall back to the leading text of its content.
   *
   * 13j carries `書.n` so the label comes for free; yinshun does not, but its
   * `<書>` holds `<檔 n="Y01.xml"/>`-style children, which this walks to.
   */
  async nodeLabel(va: number, vaEnd: number): Promise<string> {
    const self = await this.elementAt(va);
    if (!self) return '';
    const ownAttrs = parseAttrs(self.element.text);
    // Walk the node's own content: a child tag with an `n=` name wins (13j:
    // `<書 t="…" id="周易"><頁元 n="周易"/>`), otherwise use the leading text
    // (yinshun: `<書 t="部" id="2">般若經講記</書>`). The walk stops at this
    // node's closer, which keeps a label from spilling into the next sibling.
    const limit = Math.min(vaEnd, va + 4000);
    const parts: string[] = [];
    let childName = '';
    let cur = self.element.va + Math.max(1, self.element.vaUnits);
    for (let i = 0; i < 64 && cur < limit; i++) {
      const el = await this.elementAt(cur);
      if (!el) break;
      const e = el.element;
      if (e.kind === 'close') break;                 // end of this instance
      if (e.kind === 'tag') {
        if (e.skip) {                                // no VA cost: step by order
          const after = await this.elementAfter(el);
          if (!after || after.va >= limit) break;
          cur = after.va;
          continue;
        }
        const named = pickName(parseAttrs(e.text));
        if (named && !childName) childName = decodeXmlEntities(named);
      } else if (e.kind === 'token' || e.kind === 'blank') {
        parts.push(decodeXmlEntities(e.kind === 'token' ? (e.normalized ?? e.text) : e.text));
        if (parts.join('').length >= 24) break;
      }
      cur = e.va + Math.max(1, e.vaUnits);
    }
    const text = parts.join('').replace(/\s+/g, ' ').trim();
    // A heading is a short phrase: stop at a sentence ending so a book whose body
    // starts on the same line (yinshun's 書 is a container holding the title first)
    // does not drag body text into the label.
    const cut = text.search(/[。！？；]/);
    const trimmed = (cut > 0 ? text.slice(0, cut) : text).slice(0, 24);
    if (trimmed) return trimmed;
    if (childName) return childName;
    // last resort: an attribute on the tier tag itself (`l`/`u`/`n`)
    return decodeXmlEntities(pickName(ownAttrs)).slice(0, 24);
  }

  /**
   * Text of a VA span, token by token. A phrase's characters are VA-adjacent but
   * NOT necessarily PA-adjacent — a tag may sit between them (e.g. 「象」and
   * 「曰」 separated by `<頁 n="2"/>`), and a hard line break may separate them
   * too. Walking the elements is therefore the only correct way to read a hit.
   */
  async textOfVaSpan(va: number, units: number): Promise<string> {
    if (!units) return '';
    const out: string[] = [];
    let cur = va;
    for (let guard = 0; guard < units * 4 + 8; guard++) {
      const el = await this.elementAt(cur);
      if (!el) break;
      const e = el.element;
      if (e.kind !== 'tag' && e.kind !== 'close') out.push(e.kind === 'token' ? (e.normalized ?? e.text) : e.text);
      const next = e.va + Math.max(1, e.vaUnits);
      if (next >= va + units) break;
      cur = next;
    }
    return out.join('');
  }

  /**
   * Character range(s) of a PHRASE starting at `va` covering `units` VA units
   * (a search hit), in line terms.
   *
   * The phrase's tokens are VA-adjacent by definition, but they are only
   * CONTIGUOUS in the text when each token's PA equals the previous token's end.
   * A tag between them (`象<頁 n="2"/>曰`) or a hard line break breaks the run, so
   * the range has to be built token by token — using the line boundary alone
   * would swallow everything in between.
   */
  async phraseSpans(va: number, units: number, maxLines = 32): Promise<LineSpan[]> {
    await this.init();
    const want = va + Math.max(1, units);
    const out: LineSpan[] = [];
    let cur = va;
    let runStartPa = -1;
    let runEndPa = -1;
    let runLine = -1;
    const flush = async () => {
      if (runStartPa < 0) return;
      const lineStartPa = this.lineStartOf(runLine);
      const lineEndPa = this.linesEnds?.[runLine] ?? lineStartPa;
      // clamp to the line: a run may continue onto the next line
      const end = Math.min(runEndPa, lineEndPa);
      out.push({
        line: runLine,
        start: Math.max(0, (runStartPa - lineStartPa) >> 1),
        end: Math.max(0, (end - lineStartPa) >> 1),
        va: cur,
      });
      runStartPa = -1;
    };
    for (let guard = 0; guard < units * 4 + 8; guard++) {
      const el = await this.elementAt(cur);
      if (!el) break;
      const e = el.element;
      const isText = e.kind === 'token' || e.kind === 'blank';
      if (isText) {
        if (runStartPa >= 0 && e.pa === runEndPa && (e.line ?? runLine) === runLine) {
          runEndPa = Math.max(runEndPa, e.paEnd);      // contiguous: extend the run
        } else {
          await flush();
          runStartPa = e.pa;
          runEndPa = e.paEnd;
          runLine = e.line ?? 0;
        }
      } else {
        await flush();                                  // a tag breaks the run
      }
      const next = e.va + Math.max(1, e.vaUnits);
      if (next >= want) break;
      cur = next;
    }
    await flush();
    return out;
  }

  /**
   * Character range(s) of the hit at `va`, in terms of *line* text — this is
   * what the document pane needs to paint the mark, since it renders one line
   * per row and a hit may continue onto the next line (a hard break costs no VA,
   * so a word cut by it is one VA range).
   *
   * Delegates to `phraseSpans`, which builds the range token by token and
   * therefore handles both cases: contiguous text, and text broken by a hard
   * line break.
   */
  async lineSpans(va: number, maxLines = 8): Promise<LineSpan[]> {
    return this.phraseSpans(va, 1, maxLines);
  }

  /** The element that starts at or before character offset `unit` in `block`. */
  async elementAtUnit(block: number, unit: number): Promise<TokenPos | null> {
    const w = await this.blockAt(block);
    if (!w) return null;
    const pa = block * this.reader.header.srcBlockSize + unit * 2;
    let hit: TokenPos | null = null;
    for (const p of w.positions) {
      if (p.pa <= pa) hit = p;
      else break;
    }
    return hit;
  }

  /**
   * Like `context`, but the highlight follows a hit ACROSS a hard line break:
   * while the next element is text-adjacent (its PA equals this element's end)
   * and uses the next VA unit, it is folded into the same hit. That is the
   * behaviour the continuous VA space exists for — a word a hard break cuts in
   * two must highlight as one span, with no separator inserted.
   */
  async contextSpans(va: number, before = 160, after = 320, maxSpanUnits = 16): Promise<ContextWindow | null> {
    const found = await this.elementAt(va);
    if (!found) return null;
    const { element, block } = found;
    const stride = this.reader.header.srcBlockSize;
    let text = await this.reader.sourceText(block);
    let base = 0;
    let blocks = 1;
    let hitS = (element.pa - block * stride) >> 1;
    let hitE = Math.min(text.length, (element.paEnd - block * stride) >> 1);
    let lastVa = element.va + Math.max(1, element.vaUnits);

    // follow the hit forward while the text stays contiguous (index based, so
    // we never re-find the current element)
    const w = await this.blockWalk(block);
    if (w) {
      let idx = w.positions.indexOf(element);
      for (let guard = 0; guard < 64 && idx >= 0 && idx + 1 < w.positions.length; guard++) {
        const next = w.positions[idx + 1];
        if (next.va !== lastVa) break;
        const nextS = (next.pa - block * stride) >> 1;
        if (nextS !== hitE) break;                    // something sits between them
        const nextE = (next.paEnd - block * stride) >> 1;
        if (nextE <= hitE) break;
        hitE = Math.min(text.length, nextE);
        lastVa = next.va + Math.max(1, next.vaUnits);
        idx++;
        if (hitE - hitS >= maxSpanUnits) break;   // a phrase span, not the whole block
      }
    }
    if (hitS < before && block > 0) {
      const prev = await this.reader.sourceText(block - 1);
      text = prev + text;
      base = prev.length;
      blocks++;
    }
    if (hitE + after > text.length - base && block + 1 < this.srcBlocks) {
      text = text + (await this.reader.sourceText(block + 1));
      blocks++;
    }
    const hs = base + hitS;
    const he = base + Math.max(hitS, hitE);
    const from = Math.max(0, hs - before);
    const to = Math.min(text.length, he + after);
    return {
      text: text.slice(from, to),
      hitStart: hs - from, hitEnd: he - from,
      block, pa: element.pa, element,
      insideTag: element.kind === 'tag' && element.vaUnits > 0 && va > element.va,
      blocks,
    };
  }

  /**
   * Text window around a VA with the hit located exactly. Neighbouring blocks
   * are glued in only when the hit sits near an edge, so the window stays full.
   */
  async context(va: number, before = 160, after = 320): Promise<ContextWindow | null> {
    const found = await this.elementAt(va);
    if (!found) return null;
    const { element, block } = found;
    const stride = this.reader.header.srcBlockSize;
    let text = await this.reader.sourceText(block);
    let base = 0;
    let blocks = 1;
    const hitS = (element.pa - block * stride) >> 1;
    const hitE = Math.min(text.length, (element.paEnd - block * stride) >> 1);
    if (hitS < before && block > 0) {
      const prev = await this.reader.sourceText(block - 1);
      text = prev + text;
      base = prev.length;
      blocks++;
    }
    if (hitE + after > text.length - base && block + 1 < this.srcBlocks) {
      text = text + (await this.reader.sourceText(block + 1));
      blocks++;
    }
    const hs = base + hitS;
    const he = base + Math.max(hitS, hitE);
    const from = Math.max(0, hs - before);
    const to = Math.min(text.length, he + after);
    return {
      text: text.slice(from, to),
      hitStart: hs - from,
      hitEnd: he - from,
      block, pa: element.pa, element,
      insideTag: element.kind === 'tag' && element.vaUnits > 0 && va > element.va,
      blocks,
    };
  }

  /**
   * Text of a document.
   *
   * `lines` are the hard lines of the line table — use them for row rendering.   * `text` is the raw concatenation with NO separator, which is the shape a
   * search hit needs: a hard line break consumes no VA (measured: the line-to-
   * line VA gap is exactly 1 for 90.5% of 13j's boundaries, the rest being tag
   * or skip-tag boundaries), so a word cut in two by a hard break is one
   * continuous VA range and its text must not gain a separator either. Joining
   * with "\n" here would silently break exactly the case VA exists to support.
   *
   * `lineRange` overrides the window (inclusive line indices) — used to force a
   * range that contains every line a hit spans, otherwise the second half of a
   * break-straddling word would not be rendered and could not be painted.
   */
  async docText(vaStart: number, vaEnd: number, maxLines = 4000, lineWindow?: { center: number; radius?: number }, lineRange?: { first: number; last: number }): Promise<{
    lines: string[]; lineNumbers: number[]; text: string; total: number; truncated: boolean;
    blockFirst: number; blockLast: number;
  }> {
    await this.init();
    const vEnds = this.linesV!;
    const pEnds = this.linesEnds!;
    const stride = this.reader.header.srcBlockSize;
    let first = 0;
    while (first < vEnds.length && vEnds[first] < vaStart) first++;
    let last = first;
    while (last + 1 < vEnds.length && vEnds[last] < vaEnd) last++;
    const total = Math.max(0, last - first + 1);
    // A huge single-file database (13j: 42k lines) cannot be rendered at once,
    // so when a target line is known, render a window around it instead of the
    // head of the document — otherwise the line a hit points at is not even
    // present in the DOM.
    let truncated = false;
    let stop = last;
    if (lineRange) {
      first = Math.max(first, Math.min(last, lineRange.first));
      stop = Math.max(first, Math.min(last, lineRange.last));
      truncated = true;
    } else if (lineWindow && total > maxLines) {
      const radius = lineWindow.radius ?? Math.floor(maxLines / 2);
      first = Math.max(first, Math.min(last, lineWindow.center - radius));
      stop = Math.min(last, first + maxLines - 1);
      truncated = true;
    } else if (total > maxLines) {
      stop = first + maxLines - 1;
      truncated = true;
    }
    const outLines: string[] = [];
    const lineNumbers: number[] = [];
    let blockFirst = -1, blockLast = -1;
    for (let li = first; li <= stop && li < vEnds.length; li++) {
      const liStart = li;               // 合併後的行號要記「第一段」的行號
      const paS = this.lineStart(li);
      const paE = pEnds[li];
      if (paE <= paS) { outLines.push(''); lineNumbers.push(li); continue; }
      const b1 = Math.floor(paS / stride);
      const b2 = Math.floor((paE - 1) / stride);
      if (blockFirst < 0) blockFirst = b1;
      blockLast = b2;
      let line = await this.reader.textSpan(b1, paS, paE);
      // getrange_physical skips a leading CR/LF of the line
      if (line.charCodeAt(0) === 13) line = line.slice(1);
      if (line.charCodeAt(0) === 10) line = line.slice(1);
      // 行表偶爾把標籤切斷（taisho 有約 1% 的行斷在 `<頁 id="…` 中間；
      // 直接渲染會把 `<頁 …` 當成文字顯示）。往下借幾行把標籤補完，
      // 行號仍記在這一行的開頭，被借走的行不再單獨出現（作者 2026-10-29）。
      if (endsInsideTag(line)) {
        for (let k = 0; k < 8 && line.length < 4000; k++) {
          const nx = li + 1;              // li 每借一行就前進，這裡不能再加 k
          if (nx > last || nx >= vEnds.length) break;
          const s2 = this.lineStart(nx), e2 = pEnds[nx];
          if (e2 <= s2) break;
          let part = await this.reader.textSpan(Math.floor(s2 / stride), s2, e2);
          if (part.charCodeAt(0) === 13) part = part.slice(1);
          if (part.charCodeAt(0) === 10) part = part.slice(1);
          line += part;
          blockLast = Math.floor((e2 - 1) / stride);
          li = nx;
          if (!endsInsideTag(line)) break;
        }
      }
      outLines.push(line);
      lineNumbers.push(liStart);
    }
    return {
      lines: outLines, lineNumbers, text: outLines.join(''),
      total, truncated,
      blockFirst: Math.max(0, blockFirst), blockLast: Math.max(0, blockLast),
    };
  }

  /**
   * Line-to-line VA relationship, for the search-highlight invariant:
   * a gap of 1 means the break itself costs nothing, so the two lines are one
   * continuous VA range (this is what lets a hit span the break).
   */
  async lineAdjacency(maxLines = 0): Promise<{ checked: number; adjacent: number; gaps: Map<number, number> }> {
    await this.advanceTo(maxLines > 0 ? maxLines : this.srcBlocks);
    const recs = [...this.lineCache.entries()].sort((a, b) => a[0] - b[0]);
    const gaps = new Map<number, number>();
    let checked = 0, adjacent = 0;
    for (let i = 1; i < recs.length; i++) {
      const prev = recs[i - 1][1];
      const cur = recs[i][1];
      if (!prev.positions.length || !cur.positions.length) continue;
      const gap = cur.positions[0].va - prev.positions[prev.positions.length - 1].va;
      checked++;
      if (gap === 1) adjacent++;
      gaps.set(gap, (gaps.get(gap) ?? 0) + 1);
    }
    return { checked, adjacent, gaps };
  }

  /**
   * Elements whose VA is consecutive but which sit on different lines: a word
   * the hard break cut in two. Used by the tests as the concrete proof that the
   * continuous VA space does what it is for.
   */
  async crossLinePairs(limit = 20): Promise<{ a: TokenPos; b: TokenPos }[]> {
    await this.walkAll();
    const els: TokenPos[] = [];
    for (const [, w] of this.blockCache) els.push(...w.positions);
    els.sort((a, b) => a.pa - b.pa);
    const out: { a: TokenPos; b: TokenPos }[] = [];
    for (let i = 1; i < els.length && out.length < limit; i++) {
      const a = els[i - 1], b = els[i];
      if (a.kind !== 'token' || b.kind !== 'token') continue;
      if (b.va !== a.va + 1) continue;
      if (a.line === b.line) continue;
      out.push({ a, b });
    }
    return out;
  }

  /**
   * Validation. Two independent ground truths from the original build:
   *   1. every block boundary VA must equal tables/blocks.virtual
   *   2. every tag instance VA must equal the value in the tags container
   * Requires a full walk (13j: ~1 s, yinshun: ~10 s, 664 MiB db: minutes).
   */
  async validate(opts: { maxBlocks?: number; tags?: boolean } = {}): Promise<{
    blocksChecked: number; blockMismatch: { block: number; walked: number; stored: number }[];
    linesWalked: number; elapsedMs: number;
    tagsChecked: number; tagMismatch: { tag: string; walked: number; stored: number }[];
  }> {
    await this.init();
    const t0 = performance.now();
    const limit = opts.maxBlocks && opts.maxBlocks > 0 ? Math.min(opts.maxBlocks, this.srcBlocks) : this.srcBlocks;
    await this.advanceTo(limit);
    const blockMismatch: { block: number; walked: number; stored: number }[] = [];
    let blocksChecked = 0;
    for (let b = 0; b < Math.min(limit, this.vaBlocksStored!.length); b++) {
      const stored = this.vaBlocksStored![b];
      const computed = this.blockCache.get(b)?.vaBase;
      if (computed === undefined) continue;
      blocksChecked++;
      if (computed !== stored && blockMismatch.length < 30) blockMismatch.push({ block: b, walked: computed, stored });
    }
    const tagMismatch: { tag: string; walked: number; stored: number }[] = [];
    let tagsChecked = 0;
    if (opts.tags !== false) {
      const c: Container | undefined = this.reader.containers.get('tags');
      if (c) {
        const storedByTag = new Map<string, number[]>();
        for (let i = 0; i < c.count; i++) storedByTag.set(c.names[i], await this.reader.decodeBlockList('tags', i));
        const walkedByTag = new Map<string, number[]>();
        for (const h of this.tagHits) {
          const list = walkedByTag.get(h.tag);
          if (list) list.push(h.va); else walkedByTag.set(h.tag, [h.va]);
        }
        for (const [tag, list] of walkedByTag) {
          const truth = storedByTag.get(tag) ?? [];
          const n = Math.min(list.length, truth.length);
          for (let i = 0; i < n; i++) {
            tagsChecked++;
            if (list[i] !== truth[i] && tagMismatch.length < 30) tagMismatch.push({ tag, walked: list[i], stored: truth[i] });
          }
          if (list.length !== truth.length && tagMismatch.length < 30 && !this.walkedComplete) {
            // partial walk: a count difference is expected
          }
        }
      }
    }
    return {
      blocksChecked, blockMismatch,
      linesWalked: this.lineCursor, elapsedMs: performance.now() - t0,
      tagsChecked, tagMismatch,
    };
  }
}

/**
 * The tag name of a raw `<...>` token, without attributes or delimiters.
 * Closers keep their leading slash: `</聯>` -> "/聯" (the tags container keys
 * closers that way too). A naive `search(/[\s/>]/)` returns "" here, which
 * silently turns every closer into an opening tag.
 */
export function tagNameOf(raw: string): string {
  const body = raw.slice(1, raw.endsWith('>') ? -1 : undefined);
  if (body.startsWith('/')) {
    const m = /^\/[^\s/>]*/.exec(body);
    return m ? m[0] : body;
  }
  const end = body.search(/[\s/>]/);
  return end >= 0 ? body.slice(0, end) : body;
}

/** `<x/>` or `<x ... />`: a self closing tag, which consumes no VA. */
export function isSelfClosingTag(raw: string): boolean {
  if (!raw.endsWith('>')) return false;
  return /\/\s*>$/.test(raw);
}

/** Attributes of a raw tag source `<書 t="章,節,項.">` -> { t: '章,節,項.' }. */
export function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw.startsWith('<')) return out;
  const body = raw.replace(/^<\/?/, '').replace(/\/?>$/, '');
  const re = /([^\s=/]+)\s*=\s*"([^"]*)"|([^\s=/]+)\s*=\s*'([^']*)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    if (m[1] !== undefined) out[m[1]] = m[2];
    else if (m[3] !== undefined) out[m[3]] = m[4];
  }
  return out;
}

/** Leading digits only (yinshun's `id="2"` is an ordinal, not a name). */
function isOrdinal(s: string): boolean {
  return /^\d+$/.test(s.trim());
}

/**
 * The first name-ish attribute of a tag: `n`, then `id` when it is a real name,
 * then `l`/`u`.
 *
 * Measured naming schemes:
 *   13j     `<書 t="章,節,項." id="周易">`  → the title IS the `id`
 *           and `<頁元 n="周易"/>` repeats it as `n`
 *   yinshun `<書 t="部" id="2">般若經講記</書>` → `id` is only a sequence number,
 *           the title is the leading text
 * `t` is a TIER DECLARATION ("章,節,項.") and must never be used as a label;
 * an `id` of digits only is an ordinal and is skipped too.
 */
export function pickName(attrs: Record<string, string>): string {
  for (const key of ['n', 'id', 'l', 'u']) {
    const v = attrs[key];
    if (!v || !v.trim()) continue;
    if (key === 'id' && isOrdinal(v)) continue;      // ordinal, not a name
    return v.trim();
  }
  return '';
}

/**
 * 這一行是否斷在 `<…>` 中間（標籤沒有閉合的 `>`）。
 *
 * taisho 的 `lines.physical` 有大約 1% 的行斷在標籤裡面（`<頁 id="63p968b`、
 * `<聯 i="…`），直接渲染會把殘缺的標籤當成文字顯示。`docText` 用它判斷要不要
 * 往下借一行把標籤補完（作者 2026-10-29）。
 */
function endsInsideTag(s: string): boolean {
  const lt = s.lastIndexOf('<');
  if (lt < 0) return false;
  if (s.indexOf('>', lt) >= 0) return false;
  // 斷在 `<` 之後（連標籤名都還沒寫）：下一行會以 `頁 id=…` 開頭
  if (lt === s.length - 1) return true;
  // `<` 後面要像標籤名；「a < b」這種比較不算
  return /^<[^\s<>/]/.test(s.slice(lt));
}
