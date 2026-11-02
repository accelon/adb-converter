/**
 * Node side of authoring: build a .adb from lines of Accelon XML, in memory.
 *
 * The layout itself lives in `src/author-core.ts` (shared with the browser, where
 * 「加入 Obsidian」 authors a database too). This module only supplies the Node
 * bzip2 encoder (libbz2 through bun:ffi) and hands back a Buffer.
 *
 * `rebuild-adb.ts` rebuilds an EXISTING database (it needs a donor header and
 * container order); this is the from-scratch path.
 */
import { authorAdbBytes, byCodeUnit } from './author-core';
import { createEncoder } from './bz2';

export { byCodeUnit };

export interface ResourceInput {
  /** name inside the container, e.g. `lunyu/images/001.png` */
  name: string;
  bytes: Buffer;
}

export interface AuthorInput {
  dbname: string;
  dbcname: string;
  /** one entry = one line of the database text (no CR/LF inside) */
  lines: string[];
  resources?: ResourceInput[];
  dbtype?: number;
  features?: number;
  srcBlockSize?: number;
  /** single characters to drop from the token index (build time punctuation filter) */
  dropPunct?: string;
  /** pure numeric tokens (目錄編號／頁碼) 不進索引 */
  dropNumeric?: boolean;
  /** true = 日文庫（kmj）：漢字／假名用 ICU 日文詞典切詞 */
  japanese?: boolean;
  /** 從第一個實例起就快取的標記（重建舊庫時沿用它的 `caches` 鍵） */
  cachedTags?: readonly string[];
  /** 自閉合但仍要索引 close hit 的成對標記（舊 docdef 的寫法） */
  dualSelfClosingTags?: readonly string[];
  /** 只承認這些標記（舊 docdef 的 validTags；正文用 `<…>` 包書名時很重要） */
  validTags?: readonly string[];
  /**
   * false = 不建全文索引：tags／lines／blocks 的 VA 照舊（tags 讀得到），
   * 但不存 `tokens` 容器（沒有 token 清單與 postings），搜尋為空。
   * 給還沒有 tokenizer 的語種或「只要閱讀、不要全文檢索」的庫用。
   */
  fullTextIndex?: boolean;
  log?: (msg: string) => void;
  extraContainers?: Record<string, Uint8Array>;
}

export interface AuthorResult {
  file: Buffer;
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

export async function authorAdb(input: AuthorInput): Promise<AuthorResult> {
  const log = input.log ?? (() => {});
  const { encoder, notes } = createEncoder();
  if (!encoder) throw new Error(`no bzip2 encoder: ${notes.join('; ')}`);
  try {
    const out = await authorAdbBytes({
      dbname: input.dbname,
      dbcname: input.dbcname,
      lines: input.lines,
      resources: (input.resources ?? []).map((r) => ({ name: r.name, bytes: new Uint8Array(r.bytes) })),
      dbtype: input.dbtype,
      features: input.features,
      srcBlockSize: input.srcBlockSize,
      dropPunct: input.dropPunct,
      dropNumeric: input.dropNumeric,
      japanese: input.japanese,
      cachedTags: input.cachedTags,
      dualSelfClosingTags: input.dualSelfClosingTags,
      validTags: input.validTags,
      fullTextIndex: input.fullTextIndex,
      extraContainers: input.extraContainers,
      compress: (block) => encoder.encode(block),
      onProgress: (phase, done, total) => {
        if (phase === '壓縮內文' && done === total && total > 0) {
          let bytes = 0;
          for (const l of input.lines) bytes += l.length * 2;
          log(`text ${(bytes / 1048576).toFixed(2)} MiB in ${total} block(s)`);
        }
      },
    });
    return {
      file: Buffer.from(out.bytes),
      lines: out.lines,
      tokens: out.tokens,
      tokenHits: out.tokenHits,
      tagNames: out.tagNames,
      cachedKeys: out.cachedKeys,
      maxBlockOffset: out.maxBlockOffset,
      textBytes: out.textBytes,
      srcBlocks: out.srcBlocks,
      resources: out.resources,
      resourceBytes: out.resourceBytes,
    };
  } finally {
    encoder.close();
  }
}

