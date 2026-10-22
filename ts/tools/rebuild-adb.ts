#!/usr/bin/env bun
/**
 * Rebuild an .adb from the XML produced by tools/extract.ts and compare it with
 * the original database.
 *
 *   bun run tools/rebuild-adb.ts <extractdir> --from <original.adb> [-o new.adb]
 *                               [--drop-punct "().,"] [--keep-original-blocks]
 *
 * What is rebuilt from the XML:
 *   source             repacked and recompressed (bzip2 bs9)
 *   tokens / tags      the inverted index, from the TypeScript indexer
 *   tables             doclengths, lines.physical/virtual, blocks.virtual, tags.virtual
 *   header             copied and patched, crc32 recomputed
 *
 * Containers that cannot be derived from the text alone (attributes, caches,
 * resources) are copied from the original unless --keep-original-blocks is off,
 * in which case they are left empty. Key order inside the tokens/tags/tables
 * containers is taken from the original (reproducing the Delphi sort comparator
 * is still on the list).
 */
import { closeSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  blockOffsetByName,
  blockRange,
  parseBlockSet,
  parseHeader,
  readAt,
  FILE_HEADER_SIZE,
  type BlockSet,
} from '../src/format';
import { createEncoder } from '../src/bz2';
import { buildIndex } from '../src/index-builder';
import { assembleAdb, blockContainer, hitsContainer, packSource, patchHeader } from '../src/adbwrite';
import { BO_SORTED, buildContainer, BO_NAMED, BO_UNICODE } from '../src/romblock';
import { BO_BLOCKS, BO_WITH_POINTER, stringBlocks } from '../src/romblock';
import { delphiQuickSort } from '../src/sort';
import { resourcesFromDir } from '../src/resources';
import { findTagEnd } from '../src/xmlrepair';

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('-') && !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--from');
const from = args.includes('--from') ? args[args.indexOf('--from') + 1] : null;
const out = args.includes('-o') ? args[args.indexOf('-o') + 1] : null;
const dropPunct = args.includes('--drop-punct') ? args[args.indexOf('--drop-punct') + 1] : undefined;
if (!dir) {
  console.error(
    'usage: bun run tools/rebuild-adb.ts <extractdir> [--from <original.adb>] [-o new.adb] ' +
      '[--drop-punct "().,"] [--dual-closing]',
  );
  process.exit(2);
}

// ------------------------------------------------------------ read the XML
interface Manifest {
  files: { name: string; repairs?: Record<string, number> }[];
  documents: number;
  totals?: { renamed?: Record<string, string> };
  /** raw 256 byte header of the original: lets a standalone build keep dbtype,
   *  features, serial, andtagid ... which the text alone cannot express */
  cachedTags?: string[];
  tagKeys?: string[];
  dualClosing?: 'blanket' | 'nonskip';
  singleCharTokens?: string;
  headerBase64?: string;
  /** outer container names/feature, so the rebuilt file keeps the same layout */
  outerNames?: string[];
  outerFeature?: number;
}
const manifest: Manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
let text = '';
let ampEscapes = 0;
let ltEscapes = 0;
const docs: string[] = [];
for (const f of manifest.files) {
  let doc = readFileSync(join(dir, f.name), 'utf8');
  doc = doc.replace(/^<adb\b[^>]*>/, '');
  doc = doc.replace(/<\/adb>$/, '');
  ampEscapes += f.repairs?.amp ?? 0;
  ltEscapes += f.repairs?.lt ?? 0;
  docs.push(doc);
}
// The repairs are partly reversible: the manifest records the renamed element /
// attribute names and we know the indexer appended the missing close tag of the
// 檔 separator at the end of the last document.
const renamed = manifest.totals?.renamed ?? {};
const unrename = new Map(Object.entries(renamed).map(([orig, safe]) => [safe, orig]));
for (let i = 0; i < docs.length; i++) {
  const isLast = i === docs.length - 1;
  if (isLast) docs[i] = docs[i].replace(/<\/檔>\s*$/, '');
  docs[i] = docs[i].replace(/<(\/?)([A-Za-z_][^\s/>]*)/g, (m, slash: string, name: string) => {
    const orig = unrename.get(name);
    return orig ? `<${slash}${orig}` : m;
  });
}
text = docs.join('\n');
// undo the escapes this build introduced (only the ones that were counted)
if (ltEscapes) text = text.replace(/&lt;/g, '<');
if (ampEscapes) text = text.replace(/&amp;/g, '&');
const lines = text.split('\n');
// tables/doclengths has one entry per source file; every XML document is one
// source file (the 檔 separator starts a document), so keep the line ranges
const perFileLines: string[][] = [];
{
  let at = 0;
  for (const d of docs) {
    const n = d.split('\n').length;
    perFileLines.push(lines.slice(at, at + n));
    at += n;
  }
  if (at < lines.length) perFileLines.push(lines.slice(at));
}

// ------------------------------------------- the original (optional) + header
// With --from the original supplies the header, the container layout, the key
// order and the containers that cannot be derived from the text alone
// (attributes/caches). Without it everything comes from the extract manifest,
// so a database can be built from the XML directory alone.
const fd = from ? openSync(from, 'r') : -1;
const headerBytes = manifest.headerBase64
  ? Buffer.from(manifest.headerBase64, 'base64')
  : fd >= 0
    ? readAt(fd, 0, FILE_HEADER_SIZE)
    : null;
if (!headerBytes) throw new Error('no header available: pass --from or use a manifest with headerBase64');
const header = parseHeader(headerBytes)!;
if (!header) throw new Error('the header could not be parsed');
const outer: Pick<BlockSet, 'names' | 'feature'> = from
  ? parseBlockSet(fd, FILE_HEADER_SIZE)
  : { names: manifest.outerNames ?? ['source', 'tokens', 'tags', 'tables'], feature: manifest.outerFeature ?? 0x10000000 };
const containerOf = (name: string): BlockSet | null => {
  if (fd < 0) return null;
  const at = blockOffsetByName(outer as BlockSet, name);
  return at ? parseBlockSet(fd, at) : null;
};
/** raw bytes of every data block of a container (name block excluded) */
function rawBlocks(bs: BlockSet): Buffer[] {
  const rawCount = bs.lengths ? bs.lengths.length : bs.count;
  const named = (bs.feature & BO_NAMED) !== 0;
  const out: Buffer[] = [];
  for (let i = 0; i < rawCount; i++) {
    if (named && i === rawCount - 1) continue;
    const r = blockRange(bs, i);
    out.push(readAt(fd, r.start, r.end - r.start));
  }
  return out;
}
/** feature word of a container's nested name block (as the original wrote it) */
function nameFeatureOf(bs: BlockSet | null): number {
  if (!bs || fd < 0) return BO_UNICODE;
  const rawCount = bs.lengths ? bs.lengths.length : bs.count;
  if (!(bs.feature & BO_NAMED) || rawCount === 0) return BO_UNICODE;
  return parseBlockSet(fd, blockRange(bs, rawCount - 1).start).feature;
}
// attributes/attributes.sorted are generated from the XML (below); caches and
// topics still come from the original until the cache port is done
// caches is generated below too, but the original is preferred while the last
// content difference in the cache lines is being tracked down
const copyNames = ['caches', 'topics', 'resources'];
const copied = new Map<string, Buffer>();
for (const name of copyNames) {
  const bs = containerOf(name);
  if (bs) copied.set(name, buildContainer({
    feature: bs.feature,
    blocks: rawBlocks(bs),
    names: bs.names,
    nameFeature: nameFeatureOf(bs),
    pointers: bs.pointers ? [...bs.pointers] : null,
  }));
}

// --------------------------------------------------------------- build index
// docdef.validate() accepted every tag that ended up in the tags container, so
// the original's tag names are the declared set. A standalone build passes the
// names seen in the XML, in first use order.
const validTags = new Set<string>();
const adbTags = containerOf('tags');
for (const n of adbTags?.names ?? []) {
  validTags.add(n);
  validTags.add(n.startsWith('/') ? n.slice(1) : n);
}
console.error(`reconstructed ${lines.length} lines from ${manifest.files.length} xml file(s)`);
const tokensBlock0 = containerOf('tokens');
// --infer derives the build parameters from the original instead of asking for
// them: the punctuation filter is the set of single character tokens my indexer
// produced that the stored index does not have, and the dual indexing mode is
// visible from whether the stored tags contain `/` + a skipped tag name.
const SKIP_TAG_NAMES = ['頁', '聯', '註', '維', '粗', '亮', '連'];
const infer = args.includes('--infer');
let dualMode: boolean | 'nonskip' | undefined = manifest.dualClosing === 'blanket'
  ? true
  : manifest.dualClosing === 'nonskip'
    ? 'nonskip'
    : undefined;
if (args.includes('--dual-closing') || args.includes('--dual-closing-nonskip')) dualMode = args.includes('--dual-closing')
  ? true
  : args.includes('--dual-closing-nonskip')
    ? 'nonskip'
    : undefined;
let dropPunctFinal = dropPunct;
if (infer) {
  if (!dualMode && adbTags) {
    dualMode = SKIP_TAG_NAMES.some((t) => adbTags.names.includes('/' + t)) ? true : 'nonskip';
  }
}
// the caches container names ARE the docdef cached tag set (index.pas:925) and
// are the only place that information is stored
const cachesBlock0 = containerOf('caches');
const cachedKeys = cachesBlock0 ? cachesBlock0.names : (manifest.cachedTags ?? []);
// per tag dual indexing: x has a /x key in the stored container
const storedTagKeys = adbTags ? adbTags.names : (manifest.tagKeys ?? []);
const dualTags = storedTagKeys.length
  ? new Set(storedTagKeys.filter((n) => n.startsWith('/')).map((n) => n.slice(1)))
  : null;
const cachedTags = cachedKeys.length ? new Set(cachedKeys) : null;
// Tags the text itself declares as cached (`t="a,b"`, `s="*a,b"`, `s="$..."`)
// only become cached at that point in the build, so they must not start out
// cached: subtract them from the static set and let the indexer add them back
// when the declaring tag is reached (index.pas:992/1006).
const dynamicCached = new Set<string>();
for (const line of perFileLines.flat()) {
  for (const m of line.matchAll(/\b([ts])=(["'])([^"']*)\2/g)) {
    // only a declaration that really sits inside a tag counts (a plain regex
    // over the line also matches text and attributes of other tags)
    const open = line.lastIndexOf('<', m.index ?? 0);
    if (open < 0 || findTagEnd(line, open) < (m.index ?? 0)) continue;
    let value = m[3];
    if (m[1] === 's') {
      const lead = value.slice(0, 1);
      if ((lead === '*' && value.length > 1) || lead === '$') value = value.slice(1);
      else continue;
    }
    for (const decl of value.split(',')) {
      const name = decl.trim();
      if (name) dynamicCached.add(name);
    }
  }
}
const cachedTagsFinal = cachedTags
  ? new Set([...cachedTags].filter((n) => !dynamicCached.has(n)))
  : null;
const buildOnce = (dp?: string) =>
  buildIndex(perFileLines, {
    srcBlockSize: header.srcBlockSize,
    ignoreBlank: (header.dbType & 1) !== 0,
    validTags: validTags.size ? validTags : null,
    indexedTags: null,
    dropPunct: dp,
    dualIndexSelfClosing: dualMode,
    dualTags,
    cachedTags,
    // the container names are the union of the static docdef flags and the
    // dynamic t=/s= declarations; a fully faithful model needs them separated
    cachedFromStart: true,
  });
let built = buildOnce(dropPunctFinal);
if (!tokensBlock0 && manifest.singleCharTokens !== undefined && !dropPunctFinal) {
  // standalone: the manifest lists the single character tokens the build kept
  const stored = new Set([...manifest.singleCharTokens]);
  const dropped = [...built.tokens.keys()].filter((k) => k.length === 1 && !stored.has(k)).join('');
  if (dropped) {
    dropPunctFinal = dropped;
    built = buildOnce(dropped);
  }
}
if (infer && tokensBlock0 && !dropPunctFinal) {
  const stored = new Set(tokensBlock0.names);
  const dropped = [...built.tokens.keys()].filter((k) => k.length === 1 && !stored.has(k)).join('');
  if (dropped) {
    dropPunctFinal = dropped;
    built = buildOnce(dropped);
    console.error(`inferred --drop-punct "${dropped}" and dual mode ${String(dualMode)}`);
  } else if (!dualMode) {
    console.error(`inferred dual mode ${String(dualMode)}`);
  }
}
console.error(
  `index: ${built.tokens.size} tokens / ${built.tokenHits} hits, voff=${built.maxBlockOffset}, ` +
    `tags=${built.tags.size}, blanks=${built.blanks}, droppedPunct=${built.droppedPunct}`,
);

// ------------------------------------------------------------------- assemble
const { encoder, notes } = createEncoder();
if (!encoder) {
  console.error(notes.join('\n'));
  process.exit(1);
}
const src = packSource(lines, header.srcBlockSize, encoder);
encoder.close();
console.error(`source: ${src.blocks.length} blocks, ${(src.totalBytes / 1048576).toFixed(2)} MiB of text`);

const tableValues: Record<string, number[]> = {
  doclengths: built.docLengths,
  'lines.physical': src.linesPhysical,
  'lines.virtual': built.linesVirtual,
  'blocks.virtual': built.blocksVirtual,
  'tags.virtual': built.tagsVirtual,
};
const tablesBlock = containerOf('tables');
const tokensBlock = containerOf('tokens');
const tagBlock = containerOf('tags');
/** the Delphi writer stores sorted containers ascending by UTF-16 code unit
 *  (verified against every tokens/tables container of 13j and yinshun) */
const byCodeUnit = (a: string, b: string): number => {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x !== y) return x - y;
  }
  return a.length - b.length;
};
// tokens: puthitslist(..., FORCE_SORTED)   tables: tables.sorted
// tags:   puthitslist(..., tags.sorted=false) -> first use order (Map order)
// The stored order is used when the original is available (it is verified to be
// reproducible that way); the derived order is the standalone fallback.
const derive = (args.includes('--derive-order') ? args[args.indexOf('--derive-order') + 1] : 'none').split(',');
const derived = (name) => derive.includes(name) || derive.includes('all');
const tableNames = tablesBlock && !derived('tables') ? tablesBlock.names : [...Object.keys(tableValues)].sort(byCodeUnit);
const tokenNames = tokensBlock && !derived('tokens') ? tokensBlock.names : [...built.tokens.keys()].sort(byCodeUnit);
// the stored tag order decides the block index of every tag, which is the high
// 8 bits of every docnode in attributes/caches: prefer it over first use order
const tagRank = new Map(storedTagKeys.map((n, i) => [n, i]));
const tagNames =
  tagBlock && !derived('tags')
    ? tagBlock.names
    : [...built.tags.keys()].sort((a, b) => (tagRank.get(a) ?? 1e9) - (tagRank.get(b) ?? 1e9));

const parts = new Map<string, Buffer>();
/** index.pas writeLists(): the attributes container is boBlocks|boNamed, every
 *  inner list is boUnicode|boWithPointer with the owning docnodes as pointers;
 *  attributes.sorted keeps only the id/i* attributes and sorts them. */
function attributesContainer(sorted: boolean): Buffer | null {
  let keys = [...built.attributes.keys()];
  if (sorted) {
    keys = keys.filter((k) => {
      const attr = k.slice(k.indexOf('.') + 1);
      return attr.startsWith('id') || attr.startsWith('i');
    });
    keys.sort(byCodeUnit);
  }
  if (!keys.length) return null;
  const blocks: Buffer[] = [];
  for (const key of keys) {
    let recs = built.attributes.get(key)!;
    if (sorted) {
      // Delphi sorts this list with its own quicksort (unstable): reproduce it
      recs = [...recs];
      delphiQuickSort(recs, (a, b) => byCodeUnit(a.value, b.value));
    }
    blocks.push(
      buildContainer({
        feature: BO_UNICODE | BO_WITH_POINTER | (sorted ? BO_SORTED : 0),
        blocks: stringBlocks(recs.map((r) => r.value)),
        pointers: recs.map((r) => ((tagNames.indexOf(r.tag) << 24) | r.ordinal) | 0),
      }),
    );
  }
  return buildContainer({
    feature: BO_NAMED | BO_BLOCKS | (sorted ? BO_SORTED : 0),
    blocks,
    names: keys,
    nameFeature: BO_UNICODE | (sorted ? BO_SORTED : 0),
  });
}
parts.set('source', buildContainer({ feature: 0, blocks: src.blocks }));
parts.set('tokens', hitsContainer(tokenNames, tokenNames.map((k) => built.tokens.get(k) ?? []), 0, tokensBlock ? nameFeatureOf(tokensBlock) : BO_UNICODE | BO_SORTED));
parts.set('tags', hitsContainer(tagNames, tagNames.map((k) => built.tags.get(k) ?? []), 0, tagBlock ? nameFeatureOf(tagBlock) : BO_UNICODE));
parts.set('tables', hitsContainer(tableNames, tableNames.map((k) => tableValues[k] ?? []), 0, tablesBlock ? nameFeatureOf(tablesBlock) : BO_UNICODE | BO_SORTED));
const cachePlain = cachedKeys.length
  ? buildContainer({
      feature: BO_NAMED | BO_BLOCKS,
      blocks: cachedKeys.map((key) => {
        const recs = built.caches.get(key) ?? [];
        return buildContainer({
          feature: BO_UNICODE | BO_WITH_POINTER,
          blocks: stringBlocks(recs.map((r) => r.value)),
          // index.pas uses tags.getnode(tag.shortname): the docnode belongs to the
          // open tag's list, not to '/name'
          pointers: recs.map((r) => ((tagNames.indexOf(r.tag) << 24) | r.ordinal) | 0),
        });
      }),
      names: cachedKeys,
      nameFeature: BO_UNICODE,
    })
  : null;
if (cachePlain && !copied.has('caches')) parts.set('caches', cachePlain);
const attrPlain = attributesContainer(false);
if (attrPlain) parts.set('attributes', attrPlain);
const attrSorted = attributesContainer(true);
if (attrSorted) parts.set('attributes.sorted', attrSorted);
for (const [name, buf] of copied) parts.set(name, buf);
if (!parts.has('resources')) {
  const res = resourcesFromDir(dir, byCodeUnit);
  if (res) {
    parts.set('resources', res.buffer);
  }
}

const outerBlocks: Buffer[] = [];
const outerNames: string[] = [];
for (const name of outer.names) {
  const buf = parts.get(name);
  if (!buf) {
    console.error(`  (no container built for "${name}")`);
    continue;
  }
  outerBlocks.push(buf);
  outerNames.push(name);
}
const newHeader = patchHeader(headerBytes, {
  dbname: 0, dbcname: 128, linecount: 104, dbtype: 108, srcblocksize: 92, andtagid: 100,
  maxblockoffset: 96, tagcount: 116, features: 120, compression: 88, version: 84,
}, {
  linecount: lines.length,
  maxblockoffset: built.maxBlockOffset,
  tagcount: built.tagCount,
  // index.pas endbuilding: the page tag index is a block index into THIS tags
  // container, so a subset build must recompute it from the tag name
  andtagid: (() => {
    const names = adbTags ? adbTags.names : storedTagKeys;
    let at = header.andTagId > 0 && names[header.andTagId] ? tagNames.indexOf(names[header.andTagId]) : -1;
    if (at < 0) at = tagNames.indexOf('頁');
    if (at < 0) at = tagNames.indexOf('PN');
    return at < 0 ? 0 : at;
  })(),
});
const newOuter = buildContainer({ feature: outer.feature, blocks: outerBlocks, names: outerNames, nameFeature: nameFeatureOf(outer) | (outer.feature & BO_SORTED) });
const file = assembleAdb(newHeader, newOuter);

// ------------------------------------------------------------------ compare
// A standalone build (no --from) has nothing to compare against: report the
// size and succeed, instead of the "FAIL ... original 0 B" of a byte diff.
if (fd < 0) {
  if (out) {
    writeFileSync(out, file);
    console.log(`built ${out}: ${file.length} B (standalone, ${lines.length} lines)`);
  }
  process.exitCode = 0;
} else {
  const original = readFileSync(from!);
  const same = file.length === original.length && file.equals(original);
  console.log(`${same ? 'ok  ' : 'FAIL'} rebuild ${from}: original ${original.length} B, rebuilt ${file.length} B`);
  if (!same) {
    let at = 0;
    while (at < Math.min(original.length, file.length) && original[at] === file[at]) at++;
    console.log(`     first difference at byte ${at}: original 0x${original[at]?.toString(16)} rebuilt 0x${file[at]?.toString(16)}`);
    for (const name of outer.names) {
      const buf = parts.get(name);
      if (!buf) continue;
      const bs = containerOf(name);
      if (!bs) continue;
      const r = blockRange(outer, outer.names.indexOf(name));
      const orig = readAt(fd, r.start, r.end - r.start);
      console.log(`     ${name.padEnd(18)} original ${String(orig.length).padStart(9)} B  rebuilt ${String(buf.length).padStart(9)} B  ${orig.equals(buf) ? 'ok' : 'DIFF'}`);
    }
  }
  if (out) {
    writeFileSync(out, file);
    console.log(`wrote ${out}`);
  }
  closeSync(fd);
  process.exitCode = same ? 0 : 1;
}
