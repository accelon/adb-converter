/**
 * Author a NEW .adb from lines of Accelon XML — runtime neutral.
 *
 * The Node CLI (`src/adbauthor.ts`) and the browser (「加入 Obsidian」) both build
 * databases, so the container layout lives here once, in terms of `Uint8Array`
 * and an **async** compressor:
 *
 *   source  packed text, srcblocksize bytes per block, one bzip2 stream each
 *   tokens  named boHits, sorted by UTF-16 code unit
 *   tags    named boHits, first use order (the Delphi tags.sorted=false)
 *   tables  doclengths / lines.physical / lines.virtual / blocks.virtual / tags.virtual
 *   attributes / attributes.sorted   `<tag>.<attr>` values + owning docnodes
 *   caches  the innerText of every tag made cached by a `t=` / `s="*…"` declaration
 *   resources  raw bytes (images), sorted by name
 *
 * The caller supplies the compressor: Node uses libbz2 through bun:ffi, the
 * browser uses the bundled bzip2 wasm (src/bzip2-wasm.ts). Everything else is
 * identical, so a database authored in the browser is byte-for-byte the one the
 * CLI would have produced from the same lines.
 */
import { buildIndex } from './index-builder';
import {
  assembleAdb, buildContainer, concatBytes, encodePackedList, makeHeaderBytes, stringBlocks, utf16leBytes,
  BO_BLOCKS, BO_HITS, BO_NAMED, BO_SORTED, BO_UNICODE, BO_WITH_POINTER,
} from './accelon26/adb-bytes';

export interface AuthorResource {
  /** name inside the container, e.g. `Pasted image 20260221.png` */
  name: string;
  bytes: Uint8Array;
}

export interface AuthorInput {
  /** 32 byte ASCII header name */
  dbname: string;
  /** display name (up to 31 chars) */
  dbcname: string;
  /** one entry = one line of the database text (no CR/LF inside) */
  lines: readonly string[];
  resources?: readonly AuthorResource[];
  dbtype?: number;
  features?: number;
  srcBlockSize?: number;
  /** single characters to drop from the token index (build time punctuation filter) */
  dropPunct?: string;
  /**
   * 從第一個實例起就快取的標記（舊庫的 docdef 宣告在 adb 之外，文字裡看不到）。
   * 重建時把舊 `caches` 的鍵傳進來，目錄樹才會跟原庫一致。
   */
  cachedTags?: readonly string[];
  /**
   * 自閉合也要記一筆 close hit 的標記。舊庫的 docdef 會把某些成對標記
   * （例如太虛的 `平裝`／`精裝`）寫成 `<x/>` 但仍索引 `/x`。
   */
  dualSelfClosingTags?: readonly string[];
  /**
   * 只承認這些標記（舊庫 docdef 的 validTags）。正文裡用 `<…>` 包書名之類的
   * 寫法（于淩波用 `<大唐西域記>`）就不會被當成新標記，標記表才不會暴增。
   */
  validTags?: readonly string[];
  /** bzip2 one source block (16 KiB of UTF-16LE) */
  compress: (block: Uint8Array) => Promise<Uint8Array> | Uint8Array;
  /** coarse progress for the UI; may be called many times */
  onProgress?: (phase: string, done: number, total: number) => void;
  /** extra outer containers (name → already-built container bytes), placed after resources */
  extraContainers?: Record<string, Uint8Array>;
}

export interface AuthorOutcome {
  bytes: Uint8Array;
  lines: number;
  tokens: number;
  tokenHits: number;
  tagNames: string[];
  cachedKeys: string[];
  maxBlockOffset: number;
  textBytes: number;
  srcBlocks: number;
  resources: number;
  resourceBytes: number;
}

/** the Delphi writer stores sorted containers ascending by UTF-16 code unit */
export function byCodeUnit(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x !== y) return x - y;
  }
  return a.length - b.length;
}

/** packed source blocks + the cumulative byte end of every line (srcpack.pas) */
export async function packSourceBlocks(
  lines: readonly string[],
  srcBlockSize: number,
  compress: AuthorInput['compress'],
  onProgress?: AuthorInput['onProgress'],
): Promise<{ blocks: Uint8Array[]; linesPhysical: number[]; totalBytes: number }> {
  const raw: Uint8Array[] = [];
  const linesPhysical: number[] = [];
  let buf = new Uint8Array(srcBlockSize);
  let used = 0;
  let total = 0;
  const flush = (): void => {
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
  const blocks: Uint8Array[] = [];
  for (let i = 0; i < raw.length; i++) {
    blocks.push(await compress(raw[i]));
    onProgress?.('壓縮內文', i + 1, raw.length);
    // keep the UI responsive in the browser (60 blocks ≈ 60 frames)
    if ((i & 7) === 7) await new Promise((r) => setTimeout(r, 0));
  }
  return { blocks, linesPhysical, totalBytes: total };
}

/** one named boHits container: one packed list of virtual addresses per key */
function hitsContainer(names: readonly string[], values: readonly number[][], nameFeature: number): Uint8Array {
  return buildContainer({
    feature: BO_NAMED | BO_HITS,
    blocks: values.map((v) => encodePackedList(v)),
    names: names as string[],
    nameFeature,
  });
}

export async function authorAdbBytes(input: AuthorInput): Promise<AuthorOutcome> {
  const srcBlockSize = input.srcBlockSize ?? 16384;
  const progress = input.onProgress;
  for (const line of input.lines) {
    if (line.includes('\n') || line.includes('\r')) {
      throw new Error('a line contains CR/LF: ' + JSON.stringify(line.slice(0, 40)) + '…');
    }
  }

  progress?.('建立索引', 0, 1);
  const built = buildIndex([[...input.lines]], {
    srcBlockSize,
    ignoreBlank: (input.dbtype ?? 0) === 1,
    validTags: input.validTags ? new Set(input.validTags) : null,
    indexedTags: null,
    dropPunct: input.dropPunct,
    dualIndexSelfClosing: false,
    dualTags: input.dualSelfClosingTags ? new Set(input.dualSelfClosingTags) : null,
    // no static set: `t=` / `s="*…"` declarations in the text decide what is cached
    cachedTags: input.cachedTags ? new Set(input.cachedTags) : null,
    cachedFromStart: true,
  });
  progress?.('建立索引', 1, 1);

  const tagNames = [...built.tags.keys()];
  const tokenNames = [...built.tokens.keys()].sort(byCodeUnit);
  const tableValues: Record<string, number[]> = {
    doclengths: built.docLengths,
    'lines.physical': built.linesPhysical,
    'lines.virtual': built.linesVirtual,
    'blocks.virtual': built.blocksVirtual,
    'tags.virtual': built.tagsVirtual,
  };
  const tableNames = Object.keys(tableValues).sort(byCodeUnit);

  const src = await packSourceBlocks(input.lines, srcBlockSize, input.compress, progress);

  /** attributes / caches: one inner container per key (values + owning docnodes) */
  const recordsContainer = (
    recs: Map<string, { tag: string; ordinal: number; value: string }[]>,
    keys: string[],
    sorted: boolean,
  ): Uint8Array | null => {
    if (!keys.length) return null;
    return buildContainer({
      feature: BO_NAMED | BO_BLOCKS | (sorted ? BO_SORTED : 0),
      blocks: keys.map((key) => {
        const list = recs.get(key) ?? [];
        return buildContainer({
          feature: BO_UNICODE | BO_WITH_POINTER | (sorted ? BO_SORTED : 0),
          blocks: stringBlocks(list.map((r) => r.value)),
          pointers: list.map((r) => ((tagNames.indexOf(r.tag) << 24) | r.ordinal) | 0),
        });
      }),
      names: keys,
      nameFeature: BO_UNICODE | (sorted ? BO_SORTED : 0),
    });
  };

  const parts = new Map<string, Uint8Array>();
  parts.set('source', buildContainer({ feature: 0, blocks: src.blocks }));
  parts.set('tokens', hitsContainer(tokenNames, tokenNames.map((k) => built.tokens.get(k) ?? []), BO_UNICODE | BO_SORTED));
  parts.set('tags', hitsContainer(tagNames, tagNames.map((k) => built.tags.get(k) ?? []), BO_UNICODE));
  parts.set('tables', hitsContainer(tableNames, tableNames.map((k) => tableValues[k] ?? []), BO_UNICODE | BO_SORTED));

  const attrKeys = [...built.attributes.keys()].sort(byCodeUnit);
  const attrs = recordsContainer(built.attributes, attrKeys, false);
  if (attrs) parts.set('attributes', attrs);
  const sortedKeys = attrKeys.filter((k) => {
    const attr = k.slice(k.indexOf('.') + 1);
    return attr.startsWith('id') || attr.startsWith('i');
  });
  const attrsSorted = recordsContainer(built.attributes, sortedKeys, true);
  if (attrsSorted) parts.set('attributes.sorted', attrsSorted);

  const cachedKeys = [...built.caches.keys()];
  const caches = recordsContainer(built.caches, cachedKeys, false);
  if (caches) parts.set('caches', caches);

  const resources = [...(input.resources ?? [])];
  if (resources.length) {
    progress?.('打包圖片', 0, 1);
    const order = resources.map((_, i) => i).sort((a, b) => byCodeUnit(resources[a].name, resources[b].name));
    parts.set('resources', buildContainer({
      feature: BO_NAMED | BO_SORTED,
      blocks: order.map((i) => resources[i].bytes),
      names: order.map((i) => resources[i].name),
      nameFeature: BO_UNICODE,
    }));
    progress?.('打包圖片', 1, 1);
  }

  for (const [name, bytes] of Object.entries(input.extraContainers ?? {})) parts.set(name, bytes);
  const outerNames = [
    'source', 'tokens', 'tags', 'tables', 'attributes', 'attributes.sorted', 'caches', 'resources',
    ...Object.keys(input.extraContainers ?? {}),
  ].filter((n) => parts.has(n));
  const outer = buildContainer({
    feature: BO_NAMED,
    blocks: outerNames.map((n) => parts.get(n)!),
    names: outerNames,
    nameFeature: BO_UNICODE,
  });

  const pageTag = tagNames.indexOf('頁');
  const header = makeHeaderBytes({
    dbname: input.dbname,
    dbcname: input.dbcname,
    linecount: input.lines.length,
    tagcount: built.tagCount,
    maxblockoffset: built.maxBlockOffset,
    dbtype: input.dbtype ?? 0,
    features: input.features ?? 0,
    andtagid: pageTag < 0 ? 0 : pageTag,
    srcblocksize: srcBlockSize,
  });

  progress?.('組裝檔案', 0, 1);
  const bytes = assembleAdb(header, outer);
  progress?.('組裝檔案', 1, 1);
  return {
    bytes: concatBytes([bytes]),               // a plain copy: callers may keep it
    lines: input.lines.length,
    tokens: built.tokens.size,
    tokenHits: built.tokenHits,
    tagNames,
    cachedKeys,
    maxBlockOffset: built.maxBlockOffset,
    textBytes: src.totalBytes,
    srcBlocks: src.blocks.length,
    resources: resources.length,
    resourceBytes: resources.reduce((a, r) => a + r.bytes.length, 0),
  };
}

