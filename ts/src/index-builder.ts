/**
 * Faithful port of the Delphi indexer (index.pas: TIndexer.parse / addtoken /
 * dotag / addbuffer) for the token and tag inverted indexes.
 *
 * The virtual address (VA) bookkeeping is the heart of it:
 *
 *   addtoken   hits.add(voff); inc(voff)                  one VA per indexed token
 *   dotag      TagsVirtualAddress.add(voff)               one entry per valid tag
 *              (if putindex) taghits.add(voff)
 *              if not tag.skip then inc(voff, TAGLENGTH)  TAGLENGTH = 4
 *   blank run  (not ignoreblank) inc(voff)                one VA per blank run
 *   per line   linesPhysical.add(bytes); linesVirtual.add(voff-1)
 *   per block  blocksVirtual.add(voff) when the token crosses into a new block
 *   end        header.maxblockoffset := voff
 */
import { Tokenizer, normalize, parseTag } from './tokenize';
import { tntTrim } from './unicode';

export const TAGLENGTH = 4;
/** index.pas: MAXCACHELINE truncation for cached tags */
export const MAXCACHELINE = 256;  // basetype.pas:202
export const MAXLINELEN = 8192;

export interface BuiltIndex {
  /** token -> ascending virtual addresses (no dedup: THits.add appends) */
  tokens: Map<string, number[]>;
  /** tag name -> ascending virtual addresses (the `tags` container) */
  tags: Map<string, number[]>;
  /** `<tag>.<attribute>` -> values plus the owning docnode parts (index.pas:972) */
  attributes: Map<string, { tag: string; ordinal: number; value: string }[]>;
  /** tag short name -> cache lines with their docnode parts (index.pas:925) */
  caches: Map<string, { tag: string; ordinal: number; value: string }[]>;
  /** tables/tags.virtual: one entry per valid tag instance */
  tagsVirtual: number[];
  /** tables/blocks.virtual: VA of the first token of every source block */
  blocksVirtual: number[];
  /** tables/lines.physical: cumulative BYTE end offset of every line */
  linesPhysical: number[];
  /** tables/lines.virtual: VA of the end of every line (voff-1) */
  linesVirtual: number[];
  /** tables/doclengths: cumulative bytes per source file */
  docLengths: number[];
  /** header.maxblockoffset (final voff) */
  maxBlockOffset: number;
  /** header.tagcount (valid tags that are indexed) */
  tagCount: number;
  /** number of token hits written */
  tokenHits: number;
  /** number of blank runs that consumed a VA */
  blanks: number;
  /** tags rejected by the definition (docdef.validate failed) */
  invalidTags: number;
  /** single characters dropped by the build time punctuation filter */
  droppedPunct: number;
  /** tokens the tokenizer produced that are refused by addtoken */
  badTokens: number;
  totalTokenLength: number;
}

export interface BuildIndexOptions {
  srcBlockSize: number;
  /** header.dbtype & 1 */
  ignoreBlank?: boolean;
  /** docdef.validate(): only these tag names exist; null = accept everything */
  validTags?: Set<string> | null;
  /** docdef putindex: only these get a hit list; null = all valid tags */
  indexedTags?: Set<string> | null;
  onProgress?: (lines: number, voff: number) => void;
  /**
   * Build time punctuation filter: single character tokens in this set consume
   * their virtual address but are removed from the index afterwards (the Delphi
   * builder did this through the onTidyToken hook / an older skippunc pass, and
   * the setting differs per database: yinshun indexes (, kangxi and 13j do not).
   */
  dropPunct?: string;
  /** dotag writes self closing tags into the close list too; the docdef tag
   *  format (tfDontCare) decides that and is NOT stored in the adb, so this is
   *  off by default and the tag index is compared without it */
  /** true = every self closing tag is dual indexed (yinshun.adb); 'nonskip'
   *  = only tags that are not skipped (13j.adb). The build definition decides
   *  this per tag and it is not stored in the adb. */
  dualIndexSelfClosing?: boolean | 'nonskip';
  /** the exact set of tags that are dual indexed: x is in the set when the
   *  stored tags container also has a /x key (per tag tfDontCare) */
  dualTags?: Set<string> | null;
  /**
   * docdef `cached` tags: while such a tag is open every token is accumulated
   * and stored as its cache line when it closes (index.pas:925). The set is NOT
   * stored in the adb either; the caches container names are the same set.
   */
  cachedTags?: Set<string> | null;
  /** true = cachedTags is the initial set (older builds); false = only the
   *  dynamic s= declarations decide (index.pas:992) */
  cachedFromStart?: boolean;
}

function push(map: Map<string, number[]>, key: string, value: number): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** Delphi: trim() removes characters <= #32 from both ends. */
function pascalTrim(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && s.charCodeAt(a) <= 0x20) a++;
  while (b > a && s.charCodeAt(b - 1) <= 0x20) b--;
  return s.slice(a, b);
}

/** index.pas:858 trimcacheline - drop tags, cut at CR/；/。 (with an ellipsis)
 *  and trim the result. */
export function trimCacheLine(input: string): string {
  let s = input.replace(/<[^>]*>/g, '');
  for (const stop of ['\r', '\uff1b', '\u3002']) {
    const p = s.indexOf(stop);
    if (p > 0) s = s.slice(0, p) + '\u2026';
  }
  return pascalTrim(s);
}

/**
 * @param lines the text of every line, in order (TIndexer.addbuffer receives
 *   one TWideStringList per source file; the VA counter is global)
 */
export function buildIndex(files: string[][], opts: BuildIndexOptions): BuiltIndex {
  const tagLength = TAGLENGTH;
  const ignoreBlank = !!opts.ignoreBlank;
  // line index (global) at which each source file ends
  const fileEnds = new Set<number>();
  {
    let acc = 0;
    for (const f of files) {
      acc += f.length;
      fileEnds.add(acc - 1);
    }
  }

  const tokens = new Map<string, number[]>();
  const tags = new Map<string, number[]>();
  const attributes = new Map<string, { tag: string; ordinal: number; value: string }[]>();
  const caches = new Map<string, { tag: string; ordinal: number; value: string }[]>();
  // index.pas:992 - a tag bearing s="*a,b" or s="$..." declares those tags as
  // cached from that point on; the docdef's cached flag comes from exactly this
  const cachedSet = new Set<string>();
  let docache = false;
  let cacheText = '';
  const tagsVirtual: number[] = [];
  const blocksVirtual: number[] = [];
  const linesPhysical: number[] = [];
  const linesVirtual: number[] = [];
  const docLengths: number[] = [];
  let voff = 0;
  let totalParsedBytes = 0;
  let tagCount = 0;
  let tokenHits = 0;
  let blanks = 0;
  let invalidTags = 0;
  let badTokens = 0;
  let droppedPunct = 0;
  let totalTokenLength = 0;

  const addToken = (token: string): void => {
    if (token === '' || token.charCodeAt(0) === 0) return;
    if (token === '<' || token === '>' || token === '&') {
      badTokens++;
      return;
    }
    if (opts.dropPunct && token.length === 1 && opts.dropPunct.includes(token)) {
      // the hit is removed after indexing, so the virtual address is still used
      droppedPunct++;
      voff++;
      return;
    }
    push(tokens, token, voff);
    totalTokenLength += token.length;
    tokenHits++;
    voff++;
  };

  const dotag = (tagText: string): void => {
    // index.pas: fulltag:=copy(fulltag,2,length-2) removes < and >
    const inner = tagText.slice(1, tagText.length - 1);
    const tag = parseTag(inner);
    if (opts.validTags) {
      // docdef.validate() compares against the declared tag names
      if (!opts.validTags.has(tag.name) && !opts.validTags.has(tag.shortName)) {
        invalidTags++;
        return;
      }
    }
    // virtual to physical mapping (recorded for every valid tag)
    tagsVirtual.push(voff);

    if (opts.indexedTags) {
      if (!opts.indexedTags.has(tag.name) && !opts.indexedTags.has(tag.shortName)) return;
    }
    push(tags, tag.name, voff);
    // index.pas: "add 'virtual' end tag for mix single/pair tag" - a self
    // closing tag (kind = tkBoth, i.e. written as `<x ... />`) also gets a hit
    // in the close tag's hit list. Verified against 13j.adb: skipped tags
    // (`頁` etc., isSkiptag) do NOT get the extra entry.
    if (tag.kind === 'both' && (opts.dualTags
      ? opts.dualTags.has(tag.shortName)
      : opts.dualIndexSelfClosing === true || (opts.dualIndexSelfClosing === 'nonskip' && !tag.skip))) {
      push(tags, tag.name.startsWith('/') ? tag.name.slice(1) : '/' + tag.name, voff);
    }

    // attributes (index.pas: docnode := tags.getnode(tag.name) then one entry
    // per attribute with a non empty value; the `i` (linkto) value is cut at #)
    if (tag.attributes.length) {
      const ordinal = tags.get(tag.name)!.length; // 1-based instance number
      for (const attr of tag.attributes) {
        if (attr.value === '') continue; // empty values are not stored
        let value = attr.value;
        if (attr.name === 'i') {
          const hash = value.indexOf('#');
          if (hash > 0) value = value.slice(0, hash);
        }
        // index.pas:992 - `s="*a,b"` / `s="$..."` declares those tags cached
        // from this point on (the current tag's own cache block already ran)
        if (attr.name === 's') {
          const lead = attr.value.slice(0, 1);
          if ((lead === '*' && attr.value.length > 1) || lead === '$') {
            for (const decl of attr.value.slice(1).split(',')) if (decl) cachedSet.add(decl.trim());
          }
        }
        // index.pas:1006 - a `t=` attribute lists tags that become cached from
        // this point on (CreateChildTag(value, ' cached')); `l=` only declares
        // them as valid tags. `s=` does the same with a `*`/`$` prefixed list.
        if (attr.name === 't' || attr.name === 'l' || attr.name === 's') {
          const lead = attr.value.slice(0, 1);
          const list =
            attr.name === 's'
              ? (lead === '*' && attr.value.length > 1) || lead === '$'
                ? attr.value.slice(1)
                : ''
              : attr.value;
          if (list) {
            for (const decl of list.split(',')) {
              const name = decl.trim();
              if (!name) continue;
              if (attr.name !== 'l') cachedSet.add(name);
            }
          }
        }
        const key = `${tag.name}.${attr.name}`;
        const list = attributes.get(key);
        const rec = { tag: tag.name, ordinal, value };
        if (list) list.push(rec);
        else attributes.set(key, [rec]);
      }
    }
    if (!tag.skip) voff += tagLength;
    tagCount++;

    // cache line (index.pas:925): only cached, non single tags
    const short = tag.shortName;
    if (cachedSet.has(short) || (opts.cachedTags && opts.cachedTags.has(short) && opts.cachedFromStart)) {
      // the docnode is taken BEFORE this instance is counted (index.pas:936)
      const ordinal = (tags.get(short)?.length ?? 0);
      if (tag.kind === 'open') {
        docache = true;
      } else if (tag.kind === 'close') {
        docache = false;
        cacheText = cacheText.slice(0, MAXCACHELINE);
        const list = caches.get(short);
        const rec = { tag: short, ordinal, value: trimCacheLine(cacheText) };
        if (list) list.push(rec);
        else caches.set(short, [rec]);
        cacheText = '';
      } else {
        const list = caches.get(short);
        // index.pas calls getnode() before taghits.add for a self closing tag, so
        // the docnode carries the count BEFORE this instance
        const rec = { tag: short, ordinal: Math.max(0, ordinal - 1), value: '' };
        if (list) list.push(rec);
        else caches.set(short, [rec]);
      }
    }
  };

  const allLines = files.length === 1 ? files[0] : ([] as string[]).concat(...files);
  for (let li = 0; li < allLines.length; li++) {
    const line = allLines[li];
    // addbuffer: len := length(s)*2, capped at MAXLINELEN for the source packer
    let len = line.length * 2;
    if (len > MAXLINELEN) len = MAXLINELEN;

    if (len > 0) {
      const tk = new Tokenizer(line);
      for (;;) {
        const poff = totalParsedBytes + tk.offset * 2;
        if (Math.floor(poff / opts.srcBlockSize) + 1 > blocksVirtual.length) {
          blocksVirtual.push(voff);
        }
        const raw = tk.nextLiteral();
        if (raw.charCodeAt(0) === 0x3c) {
          dotag(raw);
        } else {
          // index.pas: if docache then cache := cache + token;  (the raw token,
          // before trim/normalize, and blanks are included)
          if (docache) cacheText += raw;
          if (tntTrim(raw) !== '') {
            addToken(normalize(raw));
          } else if (!ignoreBlank) {
            voff++;
            blanks++;
          }
        }
        if (tk.atEnd) break;
      }
    }

    linesPhysical.push(totalParsedBytes + len);
    linesVirtual.push(voff - 1);
    totalParsedBytes += len;
    if (opts.onProgress && (li & 0x3fff) === 0) opts.onProgress(li, voff);
    // addbuffer is called once per source file: doclengths records the running
    // byte total at the end of each of them
    if (fileEnds.has(li)) docLengths.push(totalParsedBytes);
  }
  if (docLengths.length === 0) docLengths.push(totalParsedBytes);

  return {
    tokens,
    tags,
    attributes,
    caches,
    tagsVirtual,
    blocksVirtual,
    linesPhysical,
    linesVirtual,
    docLengths,
    maxBlockOffset: voff,
    tagCount,
    tokenHits,
    blanks,
    invalidTags,
    badTokens,
    droppedPunct,
    totalTokenLength,
  };
}
