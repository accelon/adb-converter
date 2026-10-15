/**
 * Structural analysis of an .adb file (metainfo only, cheap by default).
 *
 * Everything here follows the Delphi implementation:
 *   - basetype.pas   TDbHeader
 *   - romblock.pas   TROMBlocks (blocks[i] = [len[i-1], len[i]), last block = names)
 *   - lists.pas      TPackedList (entry count = number of hits)
 *   - srcpack.pas    source blocks / lines.physical / lines.virtual
 *   - adb.pas        tokens = one block per token, tags = one block per tag,
 *                    resources = one block per file
 */
import { closeSync, openSync, statSync } from 'node:fs';
import {
  blockOffsetByName,
  blockRange,
  countPackedList,
  decodePackedList,
  parseBlockSet,
  parseHeader,
  packedListSize,
  readAt,
  FILE_HEADER_SIZE,
  type AdbHeader,
  type BlockSet,
} from './format';
import { createDecoder } from './bz2';

export interface ContainerInfo {
  name: string;
  blocks: number;
  dataBytes: number;
  blockBytes?: number;
  /** a few block names, for orientation */
  sampleNames: string[];
  named: boolean;
}

export interface TokenEntry {
  token: string;
  hits: number;
}

export interface TokenStats {
  distinct: number;
  totalHits: number;
  /** distinct tokens / hits by character length */
  byLength: { len: number; distinct: number; hits: number }[];
  unigram: { distinct: number; hits: number };
  /** breakdown of the single character tokens */
  unigramClasses: { cjk: number; ascii: number; digit: number; other: number };
  top: TokenEntry[];
  longest: TokenEntry[];
}

export interface TagInfo {
  name: string;
  hits: number;
}

export interface ResourceInfo {
  name: string;
  bytes: number;
}

export interface DocEntry {
  /** 1-based hit number, i.e. the TDocNode sequence */
  n: number;
  name: string;
  startVA: number;
  endVA: number;
}

export interface DocumentInfo {
  /** the tag that delimits documents (`檔` by convention) */
  tag: string;
  count: number;
  /** names came from the caches container (the getnNodeValue fast path) */
  named: boolean;
  sample: DocEntry[];
}

export interface AdbMeta {
  file: string;
  size: number;
  header: AdbHeader;
  containers: ContainerInfo[];
  tables: {
    linesPhysical: number;
    linesVirtual: number;
    blocksVirtual: number;
    tagsVirtual: number;
    docLengths: number;
  };
  text: {
    blocks: number;
    compressedBytes: number;
    expectedBytes: number;
    lastBlockBytes: number;
    lineCount: number;
    textBytes: number;
    chars: number;
    blocksNotFull: number;
  };
  tokens: TokenStats;
  tags: TagInfo[];
  documents: DocumentInfo | null;
  /** the 集 (COLLECTION) tag, present in every database as the root unit */
  collection: DocumentInfo | null;
  resources: {
    count: number;
    bytes: number;
    images: number;
    imageBytes: number;
    byExtension: { ext: string; count: number; bytes: number }[];
    sample: ResourceInfo[];
  };
  warnings: string[];
  ms: number;
}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.tif', '.tiff', '.svg', '.ico', '.wmf', '.emf']);

const classify = (s: string): 'cjk' | 'ascii' | 'digit' | 'other' => {
  const cp = s.codePointAt(0) ?? 0;
  if (cp >= 0x30 && cp <= 0x39) return 'digit';
  if (cp < 0x80) return 'ascii';
  if (
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0x20000 && cp <= 0x3ffff)
  ) {
    return 'cjk';
  }
  return 'other';
};

/** Read a whole container data region when it is reasonably small. */
function readContainerData(fd: number, bs: BlockSet, limit = 512 << 20): Buffer | null {
  if (bs.totalBlockSize > limit) return null;
  return readAt(fd, bs.dataStart, bs.totalBlockSize);
}

/** Offset of data block `i` inside the container data region. */
function startOf(bs: BlockSet, i: number): number {
  if (!bs.lengths) return i * bs.blockSize;
  return i > 0 ? bs.lengths[i - 1] : 0;
}

/** Length of every data block of `bs`, without reading the block bodies. */
function blockLengths(bs: BlockSet): number[] {
  if (bs.lengths) {
    const out = new Array<number>(bs.lengths.length);
    let prev = 0;
    for (let i = 0; i < bs.lengths.length; i++) {
      out[i] = bs.lengths[i] - prev;
      prev = bs.lengths[i];
    }
    return out;
  }
  return new Array<number>(bs.count).fill(bs.blockSize);
}

/**
 * Byte length of a NUL terminated UTF-16LE string.
 *
 * NOTE: a plain indexOf(0) is wrong here - every ASCII character has a 0x00
 * high byte (e.g. `<` is 3C 00), so only an aligned 00 00 pair terminates.
 */
function utf16NulLength(buf: Buffer): number {
  for (let i = 0; i + 1 < buf.length; i += 2) {
    if (buf[i] === 0 && buf[i + 1] === 0) return i;
  }
  return buf.length & ~1;
}

/**
 * Node values (file names, collection titles) are resolved exactly like
 * TAccelonDB.getnNodeValue: the caches container block named after the tag
 * holds one cached string per hit; an empty entry falls back to the `.id`
 * attribute, then to the `.n` attribute (both live in the attributes
 * container, whose blocks carry the owning docnode in the pointer table).
 */
function resolveTagNames(
  fd: number,
  outer: BlockSet,
  tagName: string,
  tagIndex: number,
): { names: Map<number, string>; source: string } {
  const names = new Map<number, string>();
  const readValue = (buf: Buffer): string => buf.toString('utf16le', 0, utf16NulLength(buf));

  let source = 'none';
  const cachesOff = blockOffsetByName(outer, 'caches');
  if (cachesOff) {
    const caches = parseBlockSet(fd, cachesOff);
    const ci = caches.names.indexOf(tagName);
    if (ci >= 0) {
      const cr = blockRange(caches, ci);
      const cache = parseBlockSet(fd, cr.start);
      const cl = blockLengths(cache);
      const cdata = readContainerData(fd, cache);
      for (let i = 0; i < cache.count; i++) {
        const s = startOf(cache, i);
        const len = cl[i];
        const buf = cdata ? cdata.subarray(s, s + len) : readAt(fd, cache.dataStart + s, len);
        names.set(i + 1, readValue(buf));
      }
      if (names.size) source = 'caches';
    }
  }

  const attrOff = blockOffsetByName(outer, 'attributes');
  if (attrOff) {
    const attributes = parseBlockSet(fd, attrOff);
    for (const attrName of [`${tagName}.id`, `${tagName}.n`]) {
      const ai = attributes.names.indexOf(attrName);
      if (ai < 0) continue;
      const ar = blockRange(attributes, ai);
      const block = parseBlockSet(fd, ar.start);
      const bl = blockLengths(block);
      const bdata = readContainerData(fd, block);
      let used = 0;
      for (let i = 0; i < block.count; i++) {
        const docnode = block.pointers ? block.pointers[i] : -1;
        if (docnode < 0) continue;
        if (((docnode >>> 24) & 0xff) !== tagIndex) continue; // only hits of this tag
        const seq = docnode & 0xffffff;
        if (names.get(seq)) continue; // already have a non empty value
        const s = startOf(block, i);
        const len = bl[i];
        const buf = bdata ? bdata.subarray(s, s + len) : readAt(fd, block.dataStart + s, len);
        const v = readValue(buf);
        if (!v) continue;
        names.set(seq, v);
        used++;
      }
      if (used && source === 'none') source = attrName;
    }
  }
  return { names, source };
}

/**
 * Last resort of TAccelonDB.getnNodeValue: read the node value from the source
 * text ("retrieve from source, Slow!"). A tag hit's virtual address points at
 * the tag itself, so `<tag ... n="value">` can be read right there. Only the
 * block containing the hit is decompressed (and cached), so this stays cheap.
 */
function namesFromTagText(
  fd: number,
  sources: BlockSet,
  header: AdbHeader,
  tagName: string,
  hits: number[],
): Map<number, string> {
  const names = new Map<number, string>();
  const stride = Math.max(1, header.srcBlockSize || 16384);
  const { decoder } = createDecoder('auto');
  const scratch = new Uint8Array(stride * 2 + 16);
  const cache = new Map<number, Buffer>();
  const readBlock = (bi: number): Buffer | null => {
    const cached = cache.get(bi);
    if (cached) return cached;
    if (bi < 0 || bi >= sources.count) return null;
    const r = blockRange(sources, bi);
    const src = readAt(fd, r.start, r.end - r.start);
    const got = decoder.decode(src, scratch);
    if (got === -1) throw new Error(`block ${bi} does not fit the scratch buffer`);
    const buf = Buffer.from(scratch.subarray(0, got));
    cache.set(bi, buf);
    return buf;
  };
  // NOTE: no \b after the tag name - it is a non ASCII word character, so a
  // word boundary would never match a Chinese tag name such as 檔.
  const atTag = new RegExp(`^<${tagName}[^>]*n="([^"]*)"`);
  const anyName = /n="([^"]*)"/;
  for (let n = 1; n <= hits.length; n++) {
    const va = hits[n - 1];
    if (va < 0) continue;
    const buf = readBlock(Math.floor(va / stride));
    if (!buf) continue;
    const off = va % stride;
    const window = buf.subarray(off, Math.min(buf.length, off + 256));
    const text = window.toString('utf16le', 0, utf16NulLength(window));
    const m = text.match(atTag) ?? text.match(anyName);
    if (m && m[1]) names.set(n, m[1]);
  }
  decoder.close();
  return names;
}

export interface AnalyzeOptions {
  /** decompress every source block to check the text block statistics */
  deep?: boolean;
  /** how many entries the token/tag top lists keep */
  top?: number;
  onProgress?: (msg: string) => void;
  /** stop after this many tokens (debugging on huge databases) */
  tokenLimit?: number;
}

export function analyzeAdb(path: string, opts: AnalyzeOptions = {}): AdbMeta {
  const t0 = performance.now();
  const top = opts.top ?? 15;
  const warnings: string[] = [];
  const fd = openSync(path, 'r');
  try {
    const size = statSync(path).size;
    const header = parseHeader(readAt(fd, 0, FILE_HEADER_SIZE));
    if (!header) throw new Error(`${path}: not an Accelon3 .adb file (bad signature)`);
    if (header.compression !== 1) warnings.push(`compression=${header.compression} (1 = bzip2 per block, 0 = stored)`);

    const outer = parseBlockSet(fd, FILE_HEADER_SIZE);
    const containers: ContainerInfo[] = [];
    for (let i = 0; i < outer.names.length; i++) {
      const at = blockRange(outer, i).start;
      const child = parseBlockSet(fd, at);
      containers.push({
        name: outer.names[i],
        blocks: child.count,
        dataBytes: child.totalBlockSize,
        blockBytes: child.blockSize || undefined,
        named: (child.feature & 0x10000000) !== 0,
        sampleNames: child.names.slice(0, 4),
      });
      opts.onProgress?.(`container ${outer.names[i]}: ${child.count} blocks, ${child.totalBlockSize} bytes`);
    }

    // ---- source blocks / lines -------------------------------------------------
    const sourceOff = blockOffsetByName(outer, 'source');
    if (!sourceOff) throw new Error(`${path}: no 'source' container`);
    const sources = parseBlockSet(fd, sourceOff);
    const srcLengths = blockLengths(sources);
    const tablesOff = blockOffsetByName(outer, 'tables');
    if (!tablesOff) throw new Error(`${path}: no 'tables' container`);
    const tables = parseBlockSet(fd, tablesOff);
    const tableList = (name: string): number[] => {
      const at = blockOffsetByName(tables, name);
      if (!at) return [];
      return decodePackedList(readAt(fd, at, packedListSize(fd, at)));
    };
    const linesPhysical = tableList('lines.physical');
    const linesVirtual = tableList('lines.virtual');
    const blocksVirtual = tableList('blocks.virtual');
    const tagsVirtual = tableList('tags.virtual');
    const docLengths = tableList('doclengths');

    const textBytes = linesPhysical.length ? linesPhysical[linesPhysical.length - 1] : 0;
    const text: AdbMeta['text'] = {
      blocks: srcLengths.length,
      compressedBytes: srcLengths.reduce((a, b) => a + b, 0),
      expectedBytes: srcLengths.length * Math.max(0, header.srcBlockSize),
      lastBlockBytes: srcLengths.length ? srcLengths[srcLengths.length - 1] : 0,
      lineCount: header.lineCount,
      textBytes,
      chars: Math.floor(textBytes / 2),
      blocksNotFull: 0,
    };
    if (opts.deep) {
      // the Delphi reader addresses text by a fixed stride (addr div srcblocksize),
      // so a non final block shorter than srcblocksize is worth flagging
      const { decoder } = createDecoder('auto');
      const scratch = new Uint8Array(Math.max(header.srcBlockSize, 1 << 16) * 2);
      let notFull = 0;
      for (let i = 0; i < srcLengths.length; i++) {
        const r = blockRange(sources, i);
        const src = readAt(fd, r.start, r.end - r.start);
        const got = decoder.decode(src, scratch);
        if (got === -1) throw new Error(`source block ${i} does not fit the scratch buffer`);
        if (got !== header.srcBlockSize && i !== srcLengths.length - 1) notFull++;
      }
      decoder.close();
      text.blocksNotFull = notFull;
      if (notFull) warnings.push(`${notFull} non final source blocks are shorter than srcblocksize`);
    }
    if (linesPhysical.length !== linesVirtual.length) {
      warnings.push(`lines.physical=${linesPhysical.length} != lines.virtual=${linesVirtual.length}`);
    }
    if (linesPhysical.length !== header.lineCount) {
      warnings.push(`lines.physical=${linesPhysical.length} != header.linecount=${header.lineCount}`);
    }

    // ---- tokens (one block per token, each a packed list of virtual addresses) --
    const tokensOff = blockOffsetByName(outer, 'tokens');
    const tokenStats: TokenStats = {
      distinct: 0,
      totalHits: 0,
      byLength: [],
      unigram: { distinct: 0, hits: 0 },
      unigramClasses: { cjk: 0, ascii: 0, digit: 0, other: 0 },
      top: [],
      longest: [],
    };
    if (tokensOff) {
      const tokens = parseBlockSet(fd, tokensOff);
      const data = readContainerData(fd, tokens);
      const lens = blockLengths(tokens);
      const lenMap = new Map<number, { distinct: number; hits: number }>();
      const topList: TokenEntry[] = [];
      const longest: TokenEntry[] = [];
      const limit = Math.min(tokens.count, opts.tokenLimit ?? tokens.count);
      for (let i = 0; i < limit; i++) {
        const len = lens[i];
        const start = startOf(tokens, i);
        let hits: number;
        if (data) {
          hits = countPackedList(data.subarray(start, start + len));
        } else {
          hits = countPackedList(readAt(fd, tokens.dataStart + start, len));
        }
        const name = tokens.names[i] ?? `#${i}`;
        tokenStats.totalHits += hits;
        const chars = [...name].length;
        const bucket = lenMap.get(chars) ?? { distinct: 0, hits: 0 };
        bucket.distinct++;
        bucket.hits += hits;
        lenMap.set(chars, bucket);
        if (chars === 1) {
          tokenStats.unigram.distinct++;
          tokenStats.unigram.hits += hits;
          const cp = name.codePointAt(0) ?? 0;
          if (cp >= 0x30 && cp <= 0x39) tokenStats.unigramClasses.digit++;
          else if (cp < 0x80) tokenStats.unigramClasses.ascii++;
          else if ((cp >= 0x3400 && cp <= 0x9fff) || (cp >= 0xf900 && cp <= 0xfaff) || cp >= 0x20000) tokenStats.unigramClasses.cjk++;
          else tokenStats.unigramClasses.other++;
        }
        topList.push({ token: name, hits });
        if (name.length > 1) longest.push({ token: name, hits });
      }
      tokenStats.distinct = limit;
      tokenStats.byLength = [...lenMap.entries()]
        .map(([len, v]) => ({ len, ...v }))
        .sort((a, b) => a.len - b.len);
      tokenStats.top = topList.sort((a, b) => b.hits - a.hits).slice(0, top);
      tokenStats.longest = longest.sort((a, b) => [...b.token].length - [...a.token].length || b.hits - a.hits).slice(0, top);
    }

    // ---- tags (one block per tag name, each a packed list of virtual addresses)
    const tagsOff = blockOffsetByName(outer, 'tags');
    const tagInfos: TagInfo[] = [];
    if (tagsOff) {
      const tags = parseBlockSet(fd, tagsOff);
      const data = readContainerData(fd, tags);
      const lens = blockLengths(tags);
      for (let i = 0; i < tags.count; i++) {
        const len = lens[i];
        const start = startOf(tags, i);
        const hits = data
          ? countPackedList(data.subarray(start, start + len))
          : countPackedList(readAt(fd, tags.dataStart + start, len));
        tagInfos.push({ name: tags.names[i] ?? `#${i}`, hits });
      }
      tagInfos.sort((a, b) => b.hits - a.hits);
    }

    // ---- resources (one block per file, stored uncompressed) -------------------
    const resOff = blockOffsetByName(outer, 'resources');
    const resources: AdbMeta['resources'] = { count: 0, bytes: 0, images: 0, imageBytes: 0, byExtension: [], sample: [] };
    if (resOff) {
      const res = parseBlockSet(fd, resOff);
      const lens = blockLengths(res);
      const ext = new Map<string, { count: number; bytes: number }>();
      for (let i = 0; i < lens.length; i++) {
        const name = res.names[i] ?? `resource-${i}`;
        const dot = name.lastIndexOf('.');
        const e = dot >= 0 ? name.slice(dot).toLowerCase() : '(none)';
        const b = ext.get(e) ?? { count: 0, bytes: 0 };
        b.count++;
        b.bytes += lens[i];
        ext.set(e, b);
        resources.count++;
        resources.bytes += lens[i];
        if (IMAGE_EXT.has(e)) {
          resources.images++;
          resources.imageBytes += lens[i];
        }
        if (resources.sample.length < 8) resources.sample.push({ name, bytes: lens[i] });
      }
      resources.byExtension = [...ext.entries()]
        .map(([e, v]) => ({ ext: e, ...v }))
        .sort((a, b) => b.bytes - a.bytes);
    }

    // ---- documents: the 檔 (FILE) tag's hit list gives each document range,
    //      and the caches container holds the node value (file name) per hit ----
    let documents: DocumentInfo | null = null;
    {
      const docTag = '檔';
      const tagsOff = blockOffsetByName(outer, 'tags');
      if (tagsOff) {
        const tags = parseBlockSet(fd, tagsOff);
        const ti = tags.names.indexOf(docTag);
        if (ti >= 0) {
          const tr = blockRange(tags, ti);
          const hits = decodePackedList(readAt(fd, tr.start, tr.end - tr.start));
          const count = hits.length; // one stored value per hit, n is 1-based
          let { names } = resolveTagNames(fd, outer, docTag, ti);
          let nonEmpty = 0;
          for (let n = 1; n <= count; n++) if (names.get(n)) nonEmpty++;
          if (nonEmpty === 0) {
            // the .n/.id attribute values may be empty for this tag; then the
            // name lives inline in the tag text, which is getnNodeValue's last
            // resort ("retrieve from source, Slow!")
            try {
              const inline = namesFromTagText(fd, sources, header, docTag, hits);
              if (inline.size) names = inline;
            } catch {
              /* keep the empty names */
            }
          }
          for (let n = 1; n <= count; n++) if (names.get(n)) nonEmpty++;
          const sample: DocEntry[] = [];
          for (let n = 1; n <= count && sample.length < top; n++) {
            sample.push({
              n,
              name: names.get(n) ?? '',
              startVA: hits[n - 1],
              endVA: n < hits.length ? hits[n] : header.maxBlockOffset,
            });
          }
          documents = { tag: docTag, count, named: nonEmpty > 0, sample };
        }
      }
    }

    // ---- root collection (集): always present, useful as a title source ----
    let collection: DocumentInfo | null = null;
    {
      const tagsOff2 = blockOffsetByName(outer, 'tags');
      if (tagsOff2) {
        const tags2 = parseBlockSet(fd, tagsOff2);
        const ci = tags2.names.indexOf('集');
        if (ci >= 0) {
          const cr = blockRange(tags2, ci);
          const hits = decodePackedList(readAt(fd, cr.start, cr.end - cr.start));
          const count = hits.length;
          const { names } = resolveTagNames(fd, outer, '集', ci);
          const sample: DocEntry[] = [];
          for (let n = 1; n <= count && sample.length < top; n++) {
            sample.push({
              n,
              name: names.get(n) ?? '',
              startVA: hits[n - 1],
              endVA: n < hits.length ? hits[n] : header.maxBlockOffset,
            });
          }
          collection = { tag: '集', count, named: sample.some((s) => s.name), sample };
        }
      }
    }

    return {
      file: path,
      size,
      header,
      containers,
      tables: {
        linesPhysical: linesPhysical.length,
        linesVirtual: linesVirtual.length,
        blocksVirtual: blocksVirtual.length,
        tagsVirtual: tagsVirtual.length,
        docLengths: docLengths.length,
      },
      text,
      tokens: tokenStats,
      tags: tagInfos,
      documents,
      collection,
      resources,
      warnings,
      ms: performance.now() - t0,
    };
  } finally {
    closeSync(fd);
  }
}
