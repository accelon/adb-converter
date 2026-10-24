/**
 * 在瀏覽器裡重建 adb（file:// 版）。只用到：
 *   - 既有的 TS 索引器（src/index-builder.ts）
 *   - bzip2 wasm（src/bzip2-wasm.ts，libbz2 1.0.8）
 *   - 本目錄的 adb-bytes.ts（packed list / container / header）
 *
 * 這條路徑刻意不碰 Node 的 Buffer／fs，所以能直接 bundle 進單檔 HTML。
 */
import { blockRange, decodePackedList, type AdbReader, type Container } from './adb';
import { buildIndex, type BuiltIndex } from '../index-builder';
import { parseTag } from '../tokenize';
import { findTagEnd, isGarbageTag } from '../xmlrepair';
import { delphiQuickSort } from '../sort';
import { bz2Compress } from '../bzip2-wasm';
import {
  assembleAdb, buildContainer, encodePackedList, patchHeader, stringBlocks, utf8Bytes, utf16leBytes,
  BO_WITH_POINTER, BO_NAMED, BO_SORTED, BO_UNICODE, BO_BLOCKS, BO_HITS,
} from './adb-bytes';
import type { PageEdit, RevisionRecord } from './edit-session';

const dv = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

export interface BuildParams {
  validTags: Set<string>;
  dualTags: Set<string>;
  cachedTags: Set<string>;
  dropPunct: string;
  ignoreBlank: boolean;
}

export interface BuildProgress {
  (phase: string, done: number, total: number): void;
}

/** All lines of the open adb, in the line-table order. */
export async function readAllLines(reader: AdbReader): Promise<string[]> {
  const ends = await reader.linesPhysical();
  const src = reader.containers.get('source');
  if (!src) throw new Error('這個 adb 沒有 source 容器');
  const parts: string[] = [];
  for (let b = 0; b < src.count; b++) parts.push(await reader.sourceText(b));
  const text = parts.join('');
  const lines: string[] = [];
  for (let i = 0; i < ends.length; i++) {
    lines.push(text.slice(i ? ends[i - 1] >> 1 : 0, ends[i] >> 1));
  }
  return lines;
}

/** Same document split as dumpXML: a line that starts with <檔 opens a new file. */
export function splitDocuments(lines: readonly string[]): string[][] {
  const docs: string[][] = [];
  let cur: string[] = [];
  for (const line of lines) {
    if (line.startsWith('<檔') && cur.length) { docs.push(cur); cur = []; }
    cur.push(line);
  }
  if (cur.length) docs.push(cur);
  return docs.length ? docs : [lines as string[]];
}

function collectTagNames(lines: readonly string[], into: Set<string>): void {
  for (const line of lines) {
    let i = 0;
    while ((i = line.indexOf('<', i)) >= 0) {
      const end = findTagEnd(line, i);
      if (end < 0) { i++; continue; }
      const raw = line.slice(i + 1, end);
      if (!isGarbageTag(raw)) {
        try {
          const t = parseTag(raw);
          into.add(t.name);
          into.add(t.shortName);
        } catch { /* malformed tag: ignore */ }
      }
      i = end + 1;
    }
  }
}

const paramsCache = new Map<string, BuildParams>();

export async function inferParams(
  reader: AdbReader,
  baseLines: readonly string[],
  cacheKey: string,
  progress?: BuildProgress,
): Promise<BuildParams> {
  const hit = paramsCache.get(cacheKey);
  if (hit) return hit;
  const tags = reader.containers.get('tags');
  const tokens = reader.containers.get('tokens');
  const caches = reader.containers.get('caches');
  const stored = new Set(tokens?.names ?? []);
  const validTags = new Set<string>();
  const dualTags = new Set<string>();
  for (const n of tags?.names ?? []) {
    validTags.add(n);
    validTags.add(n.startsWith('/') ? n.slice(1) : n);
    if (n.startsWith('/')) dualTags.add(n.slice(1));
  }
  collectTagNames(baseLines, validTags);
  const cachedTags = new Set(caches?.names ?? []);
  progress?.('分析建庫參數', 0, 1);
  const baseBuilt = buildIndex(splitDocuments(baseLines), {
    srcBlockSize: reader.header.srcBlockSize,
    ignoreBlank: (reader.header.dbType & 1) !== 0,
    validTags,
    indexedTags: null,
    dualTags,
    cachedTags,
    cachedFromStart: true,
  });
  // Single character tokens my build produces but the stored index does not have:
  // this is the build-time punctuation filter (see README/HANDOVER).
  let dropPunct = '';
  for (const k of baseBuilt.tokens.keys()) {
    if (k.length === 1 && !stored.has(k)) dropPunct += k;
  }
  progress?.('分析建庫參數', 1, 1);
  const params: BuildParams = {
    validTags,
    dualTags,
    cachedTags,
    dropPunct,
    ignoreBlank: (reader.header.dbType & 1) !== 0,
  };
  paramsCache.set(cacheKey, params);
  return params;
}

interface PackedSource {
  blocks: Uint8Array[];
  linesPhysical: number[];
  totalBytes: number;
}

async function packSourceAsync(
  lines: readonly string[],
  srcBlockSize: number,
  progress?: BuildProgress,
): Promise<PackedSource> {
  const blocks: Uint8Array[] = [];
  const raw: Uint8Array[] = [];
  const linesPhysical: number[] = [];
  let buf = new Uint8Array(srcBlockSize);
  let used = 0;
  let total = 0;
  const flush = () => {
    if (used === 0) return;
    raw.push(buf.slice(0, used));
    used = 0;
  };
  for (const line of lines) {
    const bytes = utf16leBytes(line);
    total += bytes.length;
    linesPhysical.push(total);
    let off = 0;
    let len = bytes.length;
    while (len > 0) {
      const take = Math.min(srcBlockSize - used, len);
      buf.set(bytes.subarray(off, off + take), used);
      used += take;
      off += take;
      len -= take;
      if (used === srcBlockSize) flush();
    }
  }
  flush();
  for (let i = 0; i < raw.length; i++) {
    blocks.push(await bz2Compress(raw[i], 9));
    if ((i & 15) === 0) {
      progress?.('壓縮內文', i, raw.length);
      await new Promise<void>((r) => setTimeout(r, 0));
    }
  }
  progress?.('壓縮內文', raw.length, raw.length);
  return { blocks, linesPhysical, totalBytes: total };
}

async function nameFeatureOf(reader: AdbReader, c: Container): Promise<number> {
  if (!(c.feature & BO_NAMED)) return BO_UNICODE;
  const rawCount = c.ends ? c.ends.length : c.count;
  if (!rawCount) return BO_UNICODE;
  const start = blockRange(c, rawCount - 1).start;
  return dv(await reader.io.read(start, 16)).getUint32(0, true);
}

async function rawBlocks(reader: AdbReader, c: Container): Promise<Uint8Array[]> {
  const rawCount = c.ends ? c.ends.length : c.count;
  const named = (c.feature & BO_NAMED) !== 0;
  const out: Uint8Array[] = [];
  for (let i = 0; i < rawCount; i++) {
    if (named && i === rawCount - 1) continue;
    const r = blockRange(c, i);
    out.push(await reader.io.read(r.start, r.end - r.start));
  }
  return out;
}

async function copyContainer(reader: AdbReader, name: string): Promise<Uint8Array | null> {
  const c = reader.containers.get(name);
  if (!c) return null;
  return buildContainer({
    feature: c.feature,
    blocks: await rawBlocks(reader, c),
    names: c.names,
    nameFeature: await nameFeatureOf(reader, c),
    pointers: c.pointers ? Array.from(c.pointers) : null,
  });
}

interface OuterInfo { feature: number; nameFeature: number; }

async function outerInfo(reader: AdbReader): Promise<OuterInfo> {
  const h = await reader.io.read(256, 16);
  const v = dv(h);
  const feature = v.getUint32(0, true);
  const total = v.getUint32(8, true);
  const blockSize = v.getInt32(12, true);
  const dataStart = 272;
  let nameStart = 0;
  if (blockSize > 0) {
    const count = Math.floor(total / blockSize);
    nameStart = dataStart + (count - 1) * blockSize;
  } else {
    const listStart = dataStart + total;
    const added = dv(await reader.io.read(listStart, 4)).getUint32(0, true);
    const size = 4 + Math.floor(added / 512) * 8 + added;
    const ends = decodePackedList(await reader.io.read(listStart, size));
    if (ends.length >= 2) nameStart = dataStart + ends[ends.length - 2];
  }
  if (!nameStart) return { feature, nameFeature: BO_UNICODE };
  const nameFeature = dv(await reader.io.read(nameStart, 16)).getUint32(0, true);
  return { feature, nameFeature };
}

function hitsContainer(names: string[], values: number[][], nameFeature: number): Uint8Array {
  return buildContainer({
    feature: BO_NAMED | BO_HITS,
    blocks: values.map((v) => encodePackedList(v)),
    names,
    nameFeature,
  });
}

const byCodeUnit = (a: string, b: string): number => {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i), y = b.charCodeAt(i);
    if (x !== y) return x - y;
  }
  return a.length - b.length;
};

function attributesContainer(built: BuiltIndex, tagNames: string[], sorted: boolean): Uint8Array | null {
  let keys = [...built.attributes.keys()];
  if (sorted) {
    keys = keys.filter((k) => {
      const attr = k.slice(k.indexOf('.') + 1);
      return attr.startsWith('id') || attr.startsWith('i');
    });
    keys.sort(byCodeUnit);
  }
  if (!keys.length) return null;
  const blocks: Uint8Array[] = [];
  for (const key of keys) {
    let recs = built.attributes.get(key)!;
    if (sorted) {
      recs = [...recs];
      delphiQuickSort(recs, (a, b) => byCodeUnit(a.value, b.value));
    }
    blocks.push(buildContainer({
      feature: BO_UNICODE | BO_WITH_POINTER | (sorted ? BO_SORTED : 0),
      blocks: stringBlocks(recs.map((r) => r.value)),
      pointers: recs.map((r) => (((tagNames.indexOf(r.tag) < 0 ? 0 : tagNames.indexOf(r.tag)) << 24) | r.ordinal) | 0),
    }));
  }
  return buildContainer({
    feature: BO_NAMED | BO_BLOCKS | (sorted ? BO_SORTED : 0),
    blocks,
    names: keys,
    nameFeature: BO_UNICODE | (sorted ? BO_SORTED : 0),
  });
}

function cacheContainer(built: BuiltIndex, tagNames: string[], keys: string[]): Uint8Array {
  const blocks = keys.map((key) => {
    const recs = built.caches.get(key) ?? [];
    return buildContainer({
      feature: BO_UNICODE | BO_WITH_POINTER,
      blocks: stringBlocks(recs.map((r) => r.value)),
      pointers: recs.map((r) => (((tagNames.indexOf(r.tag) < 0 ? 0 : tagNames.indexOf(r.tag)) << 24) | r.ordinal) | 0),
    });
  });
  return buildContainer({ feature: BO_NAMED | BO_BLOCKS, blocks, names: keys, nameFeature: BO_UNICODE });
}

export interface BuildOptions {
  reader: AdbReader;
  /** merged lines (base + every page edit) */
  lines: string[];
  /** the original lines, for build-parameter inference */
  baseLines: string[];
  edits: PageEdit[];
  key: string;
  revision?: RevisionRecord;
  progress?: BuildProgress;
}

/** Build a complete .adb in memory. */
export async function buildAdb(opts: BuildOptions): Promise<Uint8Array> {
  const { reader, lines, baseLines, edits, key, progress } = opts;
  const params = await inferParams(reader, baseLines, key, progress);
  collectTagNames(lines, params.validTags);
  progress?.('建立索引', 0, 1);
  const built = buildIndex(splitDocuments(lines), {
    srcBlockSize: reader.header.srcBlockSize,
    ignoreBlank: params.ignoreBlank,
    validTags: params.validTags,
    indexedTags: null,
    dropPunct: params.dropPunct,
    dualTags: params.dualTags,
    cachedTags: params.cachedTags,
    cachedFromStart: true,
  });
  progress?.('建立索引', 1, 1);

  const src = await packSourceAsync(lines, reader.header.srcBlockSize, progress);

  const tokensC = reader.containers.get('tokens');
  const tagsC = reader.containers.get('tags');
  const tablesC = reader.containers.get('tables');
  const cachesC = reader.containers.get('caches');

  const storedTokens = tokensC?.names ?? [];
  const storedTags = tagsC?.names ?? [];
  const storedTokenSet = new Set(storedTokens);
  const storedTagSet = new Set(storedTags);

  const tokenNames = storedTokens.filter((n) => built.tokens.has(n));
  const newTokens = [...built.tokens.keys()].filter((n) => !storedTokenSet.has(n)).sort(byCodeUnit);
  tokenNames.push(...newTokens);

  const tagNames = storedTags.filter((n) => built.tags.has(n));
  for (const n of built.tags.keys()) if (!storedTagSet.has(n)) tagNames.push(n);

  const tableValues: Record<string, number[]> = {
    doclengths: built.docLengths,
    'lines.physical': src.linesPhysical,
    'lines.virtual': built.linesVirtual,
    'blocks.virtual': built.blocksVirtual,
    'tags.virtual': built.tagsVirtual,
  };
  const tableNames = (tablesC?.names ?? Object.keys(tableValues)).filter((n) => tableValues[n] !== undefined);

  const cacheKeys = [...(cachesC?.names ?? [])];
  for (const n of built.caches.keys()) if (!cacheKeys.includes(n)) cacheKeys.push(n);

  const parts = new Map<string, Uint8Array>();
  parts.set('source', buildContainer({ feature: 0, blocks: src.blocks }));
  parts.set('tokens', hitsContainer(tokenNames, tokenNames.map((k) => built.tokens.get(k) ?? []), tokensC ? await nameFeatureOf(reader, tokensC) : BO_UNICODE));
  parts.set('tags', hitsContainer(tagNames, tagNames.map((k) => built.tags.get(k) ?? []), tagsC ? await nameFeatureOf(reader, tagsC) : BO_UNICODE));
  parts.set('tables', hitsContainer(tableNames, tableNames.map((k) => tableValues[k] ?? []), tablesC ? await nameFeatureOf(reader, tablesC) : BO_UNICODE));

  const attrPlain = attributesContainer(built, tagNames, false);
  if (attrPlain) parts.set('attributes', attrPlain);
  const attrSorted = attributesContainer(built, tagNames, true);
  if (attrSorted) parts.set('attributes.sorted', attrSorted);
  if (cacheKeys.length) parts.set('caches', cacheContainer(built, tagNames, cacheKeys));

  // containers that cannot be derived from the text: copy raw
  for (const name of ['resources', 'topics', 'attributes', 'attributes.sorted']) {
    if (parts.has(name)) continue;
    const copy = await copyContainer(reader, name);
    if (copy) parts.set(name, copy);
  }

  // revisions: keep every earlier block, append this build's record
  const revisionsC = reader.containers.get('revisions');
  const revBlocks = revisionsC ? await rawBlocks(reader, revisionsC) : [];
  const revNames = revisionsC ? revisionsC.names.slice() : [];
  if (opts.revision) {
    revNames.push(opts.revision.id);
    revBlocks.push(utf8Bytes(JSON.stringify(opts.revision)));
  }
  if (revBlocks.length && revNames.length) {
    parts.set('revisions', buildContainer({
      feature: revisionsC?.feature ?? (BO_NAMED | BO_BLOCKS),
      blocks: revBlocks,
      names: revNames,
      nameFeature: revisionsC ? await nameFeatureOf(reader, revisionsC) : BO_UNICODE,
    }));
  }

  const outerNames: string[] = [...reader.order];
  if (parts.has('revisions') && !outerNames.includes('revisions')) outerNames.push('revisions');
  // anything unknown but present in the original is preserved verbatim
  for (const name of outerNames) {
    if (parts.has(name)) continue;
    const copy = await copyContainer(reader, name);
    if (copy) parts.set(name, copy);
  }

  const outerBlocks: Uint8Array[] = [];
  const keptNames: string[] = [];
  for (const name of outerNames) {
    const b = parts.get(name);
    if (!b) continue;
    outerBlocks.push(b);
    keptNames.push(name);
  }
  const outer = await outerInfo(reader);
  const newOuter = buildContainer({
    feature: outer.feature,
    blocks: outerBlocks,
    names: keptNames,
    nameFeature: outer.nameFeature | (outer.feature & BO_SORTED),
  });

  const headerRaw = await reader.io.read(0, 256);
  const h = reader.header;
  let andTagId = 0;
  if (h.andTagId > 0 && storedTags[h.andTagId]) {
    const at = tagNames.indexOf(storedTags[h.andTagId]);
    if (at >= 0) andTagId = at;
  }
  if (!andTagId) {
    andTagId = tagNames.indexOf('頁');
    if (andTagId < 0) andTagId = tagNames.indexOf('PN');
    if (andTagId < 0) andTagId = 0;
  }
  const newHeader = patchHeader(headerRaw, {
    linecount: lines.length,
    maxblockoffset: built.maxBlockOffset,
    tagcount: built.tagCount,
    andtagid: andTagId,
  });
  void edits;
  return assembleAdb(newHeader, newOuter);
}

export interface RevisionInfo {
  id: string;
  blob: Uint8Array;
}

/** Read the revisions container (for the 修訂 pane). */
export async function readRevisions(reader: AdbReader): Promise<RevisionInfo[]> {
  const c = reader.containers.get('revisions');
  if (!c) return [];
  const out: RevisionInfo[] = [];
  for (let i = 0; i < c.count; i++) {
    const r = blockRange(c, i);
    out.push({ id: c.names[i] ?? String(i + 1), blob: await reader.io.read(r.start, r.end - r.start) });
  }
  return out;
}