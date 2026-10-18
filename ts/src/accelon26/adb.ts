/**
 * Browser-side .adb reader — no node:fs, no server, no sidecar.
 *
 * Runs in three places off one `AdbIO`:
 *   - the page, over a `File` (Blob.slice = random access, file:// works)
 *   - Bun tests, over a local file (SyncIO)
 *   - later, over HTTP Range if a server ever gets added (HttpIO)
 *
 * The parser never asks for more than it needs, which is what keeps a 664 MiB
 * database out of the page (byte accounting: adbviewer-http.md §1).
 *
 * Coordinate systems (SPEC.md §7, §15.2):
 *   PA (physical address) = byte offset in the unpacked text on the fixed grid
 *        `blockIndex * srcblocksize + offsetInBlock`, UTF-16LE.
 *   VA (virtual address)  = token position: +1 per indexed token, +1 per
 *        whitespace run, +4 per non-skip OPENING tag, 0 for closers and skip
 *        tags, CR/LF at a line start not counted.
 */
import { bzip2 } from '../vendor/bzip2.js';
import { isAllHan } from '../han.js';

export const FILE_HEADER_SIZE = 256;
export const ROMBLOCK_HEADER_SIZE = 16;
export const SIGNATURE = '\r\nAccelon Search Engine\r\ndesigned by C.S.Yap';
export const MILE_DISTANCE = 512;
export const BO_WITH_POINTER = 0x40000000;
export const BO_SORTED = 0x20000000;
export const BO_NAMED = 0x10000000;
export const TAGLENGTH = 4;

export const CLASS_HAN = 0, CLASS_LATIN = 1, CLASS_DIGIT = 2, CLASS_OTHER = 3;
export const CLASS_NAMES = ['han', 'latin', 'digit', 'other'];
export const CLASS_LABELS = ['漢字', '英數', '數字', '其他'];

/**
 * The byte source `BlobIO` needs: `size` plus `slice(start, end).arrayBuffer()`.
 * A browser `Blob`/`File` and the desktop host's mmap-backed file both satisfy it.
 */
export interface ByteSource {
  readonly size: number;
  slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> };
  /**
   * Optional: the source can decompress a bzip2 block itself. The desktop host does
   * (Go's compress/bzip2 — see wails/decompress.go), a browser Blob cannot, so the
   * viewer falls back to its own bzip2 in that case.
   */
  decompressText?(offset: number, length: number): Promise<string>;
  /**
   * Optional: the source can answer index queries itself (the desktop host does — Go
   * decodes the posting lists, does the phrase AND and the grouping; see
   * wails/search.go). A browser Blob cannot, so the viewer uses its own implementation.
   */
  postings?(token: string): Promise<number[]>;
  /** 完整查詢語法（多詞組／運算子／萬用字元）由來源回答（桌面宿主） */
  searchQuery?(query: string, maxHits: number, groups?: string[]): Promise<unknown>;
}

/**
 * A database source: something with an identity (name + size + mtime, which is what
 * "is this the file I already opened?" compares) and bytes. A picked `File` and the
 * desktop host's file are interchangeable here, so no viewer code has to know which
 * build it is running in.
 */
export interface AdbSource extends ByteSource {
  readonly name: string;
  readonly lastModified: number;
  /** 桌面宿主給的絕對路徑（file:// 版沒有；字數統計要靠它走 Go 的批次解壓） */
  readonly path?: string;
}

/** One `read` primitive is the whole transport contract. */
export interface AdbIO {
  readonly size: number;
  /**
   * 桌面版的絕對路徑（`main.AdbHost` 的白名單只認工作目錄裡的 .adb）。
   * `<input type="file">` 與 file:// 都沒有這個東西 —— 導出功能要靠它。
   */
  readonly path?: string;
  read(offset: number, length: number): Promise<Uint8Array>;
  /** native bzip2, when the transport has one (desktop host); absent on file:// */
  decompressText?(offset: number, length: number): Promise<string>;
  /** index queries answered by the transport (desktop host); absent on file:// */
  postings?(token: string): Promise<number[]>;
  searchQuery?(query: string, maxHits: number, groups?: string[]): Promise<unknown>;
  close?(): void;
}

const dv = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

export class BlobIO implements AdbIO {
  readonly size: number;
  /** 桌面版的絕對路徑（file://／<input type=file> 沒有）；導出功能要用 */
  readonly path?: string;
  /**
   * I/O accounting. `blob.slice().arrayBuffer()` is the only way to read a local
   * file from `file://`, and it is expensive per call, so both the number of
   * reads and the bytes matter when profiling a slow open.
   */
  reads = 0;
  bytes = 0;
  ms = 0;
  maxRead = 0;
  /** reads served from the chunk cache instead of the blob */
  cached = 0;
  constructor(private blob: ByteSource) {
    this.size = blob.size;
    // 桌面版才有絕對路徑（file:// 與 <input type=file> 的 File 沒有 path）
    const p = (blob as AdbSource).path;
    if (p) this.path = p;
    // the host decompresses in Go when it can; file:// has no such capability
    if (blob.decompressText) this.decompressText = blob.decompressText.bind(blob);
    if (blob.postings) this.postings = blob.postings.bind(blob);
    if (blob.searchQuery) this.searchQuery = blob.searchQuery.bind(blob);
  }

  /** native bzip2 for one block, when the source offers it (see ByteSource) */
  decompressText?: (offset: number, length: number) => Promise<string>;
  /** index queries answered by the source (desktop host) */
  postings?: (token: string) => Promise<number[]>;
  searchQuery?: (query: string, maxHits: number, groups?: string[]) => Promise<unknown>;

  /**
   * Metadata (container name tables, attribute tables) is read in thousands of
   * small pieces. Measured on yinshun: 10,489 blob reads of 0.89 MiB total cost
   * 3.4 s — i.e. ~0.33 ms per call regardless of size, so the cost is the CALL,
   * not the bytes. Chunking trades those calls for a few large ones: the first
   * access to a 128 KiB window reads it whole and later small reads are sliced
   * out of memory.
   */
  private chunks = new Map<number, Uint8Array>();
  private static CHUNK = 128 * 1024;

  async read(offset: number, length: number): Promise<Uint8Array> {
    const end = Math.min(offset + length, this.size);
    if (offset >= this.size || end <= offset) return new Uint8Array(0);
    if (length <= BlobIO.CHUNK / 4) {
      const base = offset - (offset % BlobIO.CHUNK);
      let chunk = this.chunks.get(base);
      if (!chunk) {
        const cEnd = Math.min(base + BlobIO.CHUNK, this.size);
        const t0 = performance.now();
        chunk = new Uint8Array(await this.blob.slice(base, cEnd).arrayBuffer());
        this.reads++;
        this.bytes += chunk.byteLength;
        this.maxRead = Math.max(this.maxRead, chunk.byteLength);
        this.ms += performance.now() - t0;
        if (this.chunks.size > 64) this.chunks.clear();   // bounded cache
        this.chunks.set(base, chunk);
      } else {
        this.cached++;
      }
      if (end <= base + chunk.byteLength) return chunk.subarray(offset - base, end - base);
    }
    const t0 = performance.now();
    const out = new Uint8Array(await this.blob.slice(offset, end).arrayBuffer());
    this.reads++;
    this.bytes += out.byteLength;
    this.maxRead = Math.max(this.maxRead, out.byteLength);
    this.ms += performance.now() - t0;
    return out;
  }
}

/** Bun/Node reader used by tests; identical bytes, synchronous underneath. */
export class SyncIO implements AdbIO {
  readonly size: number;
  private fd: number;
  private fs: typeof import('node:fs');
  constructor(path: string) {
    this.fs = require('node:fs');
    this.fd = this.fs.openSync(path, 'r');
    this.size = this.fs.statSync(path).size;
  }
  async read(offset: number, length: number): Promise<Uint8Array> {
    const end = Math.min(offset + length, this.size);
    const n = Math.max(0, end - offset);
    const buf = new Uint8Array(n);
    let done = 0;
    while (done < n) {
      const got = this.fs.readSync(this.fd, buf, done, n - done, offset + done);
      if (got <= 0) break;
      done += got;
    }
    return done === n ? buf : buf.subarray(0, done);
  }
  close() { this.fs.closeSync(this.fd); }
}

export interface AdbHeader {
  dbname: string; dbcname: string; version: number; compression: number;
  srcBlockSize: number; maxBlockOffset: number; andTagId: number; lineCount: number;
  dbType: number; protection: number; tagCount: number; features: number;
  crc32: number; size: number; isDictionary: boolean;
}

export interface Container {
  name: string;
  start: number;
  dataStart: number;
  totalBlockSize: number;
  blockSize: number;
  feature: number;
  count: number;
  listStart: number;
  ends: number[] | null;
  names: string[];
  pointers: Int32Array | null;
}

const latin1 = new TextDecoder('latin1');

/**
 * UTF-16LE decode that keeps unpaired surrogates intact.
 *
 * `TextDecoder('utf-16le')` is NOT safe here: Bun's implementation replaces a
 * lone surrogate with U+FFFD, and browsers have historically differed. 18 of 93
 * databases have token names containing a lone surrogate (e.g. 13j token #15),
 * and the viewer must expose the same code units the adb stores.
 */
export function decodeUtf16(bytes: Uint8Array): string {
  const units = bytes.length >> 1;
  if (units === 0) return '';
  const CHUNK = 4096;
  if (units <= CHUNK) {
    const cs: number[] = new Array(units);
    for (let i = 0; i < units; i++) cs[i] = bytes[i * 2] | (bytes[i * 2 + 1] << 8);
    return String.fromCharCode(...cs);
  }
  let out = '';
  for (let at = 0; at < units; at += CHUNK) {
    const n = Math.min(CHUNK, units - at);
    const cs: number[] = new Array(n);
    for (let i = 0; i < n; i++) cs[i] = bytes[(at + i) * 2] | (bytes[(at + i) * 2 + 1] << 8);
    out += String.fromCharCode(...cs);
  }
  return out;
}

export function decodePackedList(buf: Uint8Array): number[] {
  const view = dv(buf);
  const added = view.getUint32(0, true);
  let off = 4 + Math.floor(added / MILE_DISTANCE) * 8;
  const end = off + added;
  const out: number[] = [];
  let v = 0;
  while (off < end) {
    let delta = 0, shift = 0, c = buf[off];
    do {
      delta += (c & 0x7f) * Math.pow(2, shift);
      shift += 7;
      off++;
      if (off < end) c = buf[off];
    } while (c >= 0x80 && off < end && shift < 32);
    v += delta;
    out.push(v);
  }
  return out;
}

/**
 * Number of packed-list entries without materialising the values.
 * The milestone table is NOT usable for this: measured wrong in 1,321 of 1,333
 * applicable blocks of yinshun (adbviewer-sidecar.md §2.2).
 */
export function countPackedList(buf: Uint8Array): number {
  const added = dv(buf).getUint32(0, true);
  const payload = 4 + Math.floor(added / MILE_DISTANCE) * 8;
  const end = payload + added;
  let off = payload;
  let count = 0;
  while (off < end) {
    off++;
    while (off < end && buf[off] >= 0x80) off++;
    count++;
  }
  return count;
}

export function packedListSize(added: number): number {
  return 4 + Math.floor(added / MILE_DISTANCE) * 8 + added;
}

function cstr(b: Uint8Array, from: number, to: number): string {
  let end = from;
  while (end < to && b[end] !== 0) end++;
  return latin1.decode(b.subarray(from, end));
}

export function parseHeader(h: Uint8Array, size: number): AdbHeader | null {
  if (cstr(h, 32, 80) !== SIGNATURE) return null;
  const v = dv(h);
  const dbcnameRaw = decodeUtf16(h.subarray(128, 192));
  const z = dbcnameRaw.indexOf('\0');
  const dbType = v.getInt32(108, true);
  return {
    dbname: cstr(h, 0, 32),
    dbcname: z < 0 ? dbcnameRaw : dbcnameRaw.slice(0, z),
    version: v.getInt32(84, true), compression: v.getInt32(88, true),
    srcBlockSize: v.getInt32(92, true), maxBlockOffset: v.getInt32(96, true),
    andTagId: v.getInt32(100, true), lineCount: v.getInt32(104, true),
    dbType, protection: v.getInt32(112, true), tagCount: v.getInt32(116, true),
    features: v.getInt32(120, true), crc32: v.getUint32(252, true), size,
    isDictionary: (dbType & 2) !== 0,
  };
}

export function blockRange(c: Container, i: number): { start: number; end: number } {
  if (c.ends) return { start: c.dataStart + (i > 0 ? c.ends[i - 1] : 0), end: c.dataStart + c.ends[i] };
  return { start: c.dataStart + i * c.blockSize, end: c.dataStart + (i + 1) * c.blockSize };
}

export function blockSize(c: Container, i: number): number {
  const r = blockRange(c, i);
  return r.end - r.start;
}

export function nameTableBytes(c: Container): number {
  if (c.ends && c.ends.length) return c.ends[c.ends.length - 1] - (c.ends.length > 1 ? c.ends[c.ends.length - 2] : 0);
  return c.blockSize;
}

export interface Counters {
  db: string; dbcname: string; size: number;
  version: number; compression: number; srcBlockSize: number;
  distinctTokens: number; totalTagHits: number; virtualLength: number;
  lines: number; srcBlocks: number; tagKinds: number;
  documents: number;
  resources: number; isDictionary: boolean;
}

export interface TokenRow {
  i: number;
  name: string;
  bytes: number;
  cls: number;
  dirty: boolean;
}

export interface DocRow { i: number; name: string; vaStart: number; vaEnd: number }

export class AdbReader {
  header!: AdbHeader;
  containers = new Map<string, Container>();
  order: string[] = [];
  readonly io: AdbIO;   // public: SearchSession asks it for host-answered queries
  /** decoded source blocks (bzip2 output, NUL-trimmed) */
  private srcTextCache = new Map<number, string>();

  private constructor(io: AdbIO) { this.io = io; }

  static async open(io: AdbIO): Promise<AdbReader> {
    const r = new AdbReader(io);
    const head = await io.read(0, FILE_HEADER_SIZE);
    const header = parseHeader(head, io.size);
    if (!header) throw new Error('not an .adb file (signature mismatch)');
    r.header = header;
    const top = await r.parseContainer(256, '');
    r.order = [...top.names];
    for (const n of r.order) {
      const at = top.names.indexOf(n);
      r.containers.set(n, await r.parseContainer(blockRange(top, at).start, n));
    }
    return r;
  }

  /**
   * Parse one container. Only three kinds of read, whatever the container size:
   *   16 B header  -> totalBlockSize / blockSize
   *   4 B + list   -> the packed length list (lawtw tokens: 250 KiB for 240k blocks)
   *   the nested name table block
   * The payload is never read here — that is the point.
   */
  private async parseContainer(start: number, name: string): Promise<Container> {
    const h = await this.io.read(start, ROMBLOCK_HEADER_SIZE);
    const v = dv(h);
    const feature = v.getUint32(0, true);
    const totalBlockSize = v.getUint32(8, true);
    const blockSize = v.getInt32(12, true);
    const dataStart = start + ROMBLOCK_HEADER_SIZE;
    let ends: number[] | null = null;
    let count = 0;
    let listStart = 0;
    let added = 0;
    if (blockSize === 0) {
      listStart = dataStart + totalBlockSize;
      added = dv(await this.io.read(listStart, 4)).getUint32(0, true);
      ends = decodePackedList(await this.io.read(listStart, packedListSize(added)));
      count = ends.length;
    } else {
      count = Math.floor(totalBlockSize / blockSize);
    }
    let pointers: Int32Array | null = null;
    if (feature & BO_WITH_POINTER) {
      const n = ends ? ends.length : count;
      const at = blockSize === 0 ? listStart + packedListSize(added) : dataStart + totalBlockSize;
      const buf = await this.io.read(at, n * 4);
      pointers = new Int32Array(n);
      for (let i = 0; i < n; i++) pointers[i] = dv(buf).getInt32(i * 4, true);
    }
    const c: Container = { name, start, dataStart, totalBlockSize, blockSize, feature, count, listStart, ends, names: [], pointers };
    if (feature & BO_NAMED) {
      if (ends && ends.length >= 2) {
        const nbStart = dataStart + ends[ends.length - 2];
        const nb = await this.parseContainer(nbStart, name + '#names');
        const n = nb.ends ? nb.ends.length : nb.count;
        for (let i = 0; i < n; i++) {
          const r = nb.ends
            ? { start: nb.dataStart + (i > 0 ? nb.ends[i - 1] : 0), end: nb.dataStart + nb.ends[i] }
            : { start: nb.dataStart + i * nb.blockSize, end: nb.dataStart + (i + 1) * nb.blockSize };
          const len = r.end - r.start - 2;
          if (len > 0) c.names.push(decodeUtf16(await this.io.read(r.start, len)));
        }
        c.count = count - 1;
      } else if (!ends) {
        const begin = (count - 1) * blockSize;
        const raw = decodeUtf16(await this.io.read(dataStart + begin, blockSize));
        for (const s of raw.split('\0')) if (s) c.names.push(s);
        c.count = count - 1;
      }
    }
    return c;
  }

  async readBlock(container: string, index: number): Promise<Uint8Array> {
    const c = this.containers.get(container);
    if (!c) throw new Error(`no container ${container}`);
    if (index < 0 || index >= c.count) throw new Error(`${container}[${index}] out of range 0..${c.count - 1}`);
    const r = blockRange(c, index);
    return this.io.read(r.start, r.end - r.start);
  }

  async decodeBlockList(container: string, index: number): Promise<number[]> {
    return decodePackedList(await this.readBlock(container, index));
  }

  async blockListCount(container: string, index: number): Promise<number> {
    return countPackedList(await this.readBlock(container, index));
  }

  async resourceBytes(index: number): Promise<{ name: string; bytes: Uint8Array }> {
    const c = this.containers.get('resources');
    if (!c) throw new Error('no resources container');
    const r = blockRange(c, index);
    return { name: c.names[index], bytes: await this.io.read(r.start, r.end - r.start) };
  }

  /** Decode one source block to a string, trimmed at the first NUL code unit.
   *  Decoding is the expensive part (pure JS bzip2), so results are cached. */
  async sourceText(index: number): Promise<string> {
    const hit = this.srcTextCache.get(index);
    if (hit !== undefined) return hit;
    const c = this.containers.get('source');
    if (!c) throw new Error('no source container');
    const text = await this.blockText(index);
    // Bounded cache: a reader who keeps jumping around would otherwise keep every
    // decoded block of a 24 MB database alive, and the resulting GC churn is felt
    // as jank on every link. 256 blocks ≈ 4 MB of strings.
    if (this.srcTextCache.size >= 256) {
      const oldest = this.srcTextCache.keys().next().value;
      if (oldest !== undefined) this.srcTextCache.delete(oldest);
    }
    this.srcTextCache.set(index, text);
    return text;
  }

  /** Drop cached decoded source blocks (bounded memory). */
  clearTextCache(): void { this.srcTextCache.clear(); }
  get textCacheSize(): number { return this.srcTextCache.size; }

  /**
   * Text of the *physical address space* range [paStart, paEnd), in code units.
   *
   * The PA space is a fixed grid of `srcblocksize` bytes per source block, and
   * the indexer's line table is laid out on it — a line may straddle a block
   * boundary. Because every block is a separate bzip2 stream with its own NUL
   * terminator, reading such a line means concatenating the decoded blocks, not
   * reading raw bytes across the compressed boundary.
   */
  async physicalText(paStart: number, paEnd: number): Promise<string> {
    const stride = this.header.srcBlockSize;
    const b1 = Math.floor(paStart / stride);
    const b2 = Math.floor((paEnd - 1) / stride);
    const parts: string[] = [];
    for (let b = b1; b <= b2; b++) {
      if (b < 0 || b >= (this.containers.get('source')?.count ?? 0)) continue;
      parts.push(await this.sourceText(b));
    }
    const from = paStart - b1 * stride;   // offset inside the concatenated text
    return parts.join('').slice(from >> 1, (from + (paEnd - paStart)) >> 1);
  }

  /**
   * Text of a PA range that starts inside `block`, using the decoded text cache.
   * A line may straddle into the next block; then only the part that exists is
   * returned (the grid and the decoded blocks agree, verified on the corpus).
   */
  async textSpan(block: number, paStart: number, paEnd: number): Promise<string> {
    const stride = this.header.srcBlockSize;
    const lo = block * stride;
    const text = await this.sourceText(block);
    const from = (paStart - lo) >> 1;
    const want = (paEnd - paStart) >> 1;
    if (from + want <= text.length) return text.slice(from, from + want);
    const rest = text.slice(from);
    if (paEnd <= lo + stride) return rest;      // the tail simply is not stored
    const next = await this.sourceText(block + 1);
    return rest + next.slice(0, Math.max(0, from + want - text.length));
  }

  /** Raw bytes of a PA range (no decompression applied). */
  async physicalBytes(paStart: number, paEnd: number): Promise<Uint8Array> {
    const stride = this.header.srcBlockSize;
    const out = new Uint8Array(Math.max(0, paEnd - paStart));
    for (let b = Math.floor(paStart / stride); b <= Math.floor((paEnd - 1) / stride); b++) {
      if (b < 0) continue;
      const raw = await this.readBlock('source', b);
      const bytes = this.header.compression === 0 ? raw : this.bunzip(raw);
      const base = b * stride;
      const from = Math.max(paStart, base);
      const to = Math.min(paEnd, base + bytes.length);
      if (to <= from) continue;
      out.set(bytes.subarray(from - base, to - base), from - paStart);
    }
    return out;
  }

  /** UTF-16LE bytes → string, trimmed at the first NUL code unit */
  private unitText(bytes: Uint8Array): string {
    const units = Math.floor(bytes.length / 2);
    let end = units;
    for (let i = 0; i < units; i++) {
      if (bytes[i * 2] === 0 && bytes[i * 2 + 1] === 0) { end = i; break; }
    }
    return decodeUtf16(bytes.subarray(0, end * 2));
  }

  /**
   * The text of one source block. The desktop host decompresses AND decodes UTF-16 in
   * Go (one call, no base64 of the expanded bytes); everywhere else the vendored JS
   * bzip2 does the work.
   */
  private async blockText(index: number): Promise<string> {
    if (this.header.compression === 0) return this.unitText(await this.readBlock('source', index));
    const c = this.containers.get('source');
    if (this.io.decompressText && c) {
      const r = blockRange(c, index);
      return this.io.decompressText(r.start, r.end - r.start);
    }
    return this.unitText(this.bunzip(await this.readBlock('source', index)));
  }

  private bunzip(src: Uint8Array): Uint8Array {
    let pos = 0;
    const out = new Uint8Array(Math.max(this.header.srcBlockSize + 4, 1 << 16));
    let overflow = false;
    bzip2.simple(src, (byte: number) => {
      if (pos < out.length) out[pos++] = byte;
      else overflow = true;
    });
    if (overflow) throw new Error('bzip2 block decompressed beyond srcblocksize');
    return out.subarray(0, pos);
  }

  async tableList(name: string): Promise<number[]> {
    const c = this.containers.get('tables');
    if (!c) throw new Error('no tables container');
    const at = c.names.indexOf(name);
    if (at < 0) throw new Error(`no table ${name}`);
    return this.decodeBlockList('tables', at);
  }

  async blocksVirtual(): Promise<number[]> { return this.tableList('blocks.virtual'); }
  async linesVirtual(): Promise<number[]> { return this.tableList('lines.virtual'); }
  async linesPhysical(): Promise<number[]> { return this.tableList('lines.physical'); }

  async counters(): Promise<Counters> {
    const h = this.header;
    const tok = this.containers.get('tokens');
    const tags = this.containers.get('tags');
    const tabs = this.containers.get('tables');
    const res = this.containers.get('resources');
    const src = this.containers.get('source');
    let documents = 0;
    if (tabs) {
      const at = tabs.names.indexOf('doclengths');
      if (at >= 0) documents = await this.blockListCount('tables', at);
    }
    return {
      db: h.dbname, dbcname: h.dbcname, size: h.size,
      version: h.version, compression: h.compression, srcBlockSize: h.srcBlockSize,
      distinctTokens: tok?.count ?? 0,
      totalTagHits: h.tagCount,
      virtualLength: h.maxBlockOffset,
      lines: h.lineCount,
      srcBlocks: src?.count ?? 0,
      tagKinds: tags?.count ?? 0,
      documents,
      resources: res?.count ?? 0,
      isDictionary: h.isDictionary,
    };
  }

  /**
   * Every token with its posting byte length and class. All of it comes from
   * the name table plus the length list: no posting payload is read.
   * Rows are in the adb's own order (UTF-16 code unit order).
   */
  tokens(): TokenRow[] {
    const c = this.containers.get('tokens');
    if (!c) return [];
    const rows: TokenRow[] = new Array(c.count);
    for (let i = 0; i < c.count; i++) {
      const name = c.names[i] ?? '';
      rows[i] = {
        i, name,
        bytes: c.ends ? c.ends[i] - (i > 0 ? c.ends[i - 1] : 0) : c.blockSize,
        cls: tokenClass(name),
        dirty: isDirtyName(name),
      };
    }
    return rows;
  }

  classStats(): { count: number[]; bytes: number[] } {
    const count = [0, 0, 0, 0];
    const bytes = [0, 0, 0, 0];
    for (const r of this.tokens()) { count[r.cls]++; bytes[r.cls] += r.bytes; }
    return { count, bytes };
  }

  /**
   * The `檔` (FILE) tag with its VA range. Names follow SPEC §10:
   * caches → `檔.id` → `檔.n` → read the tag itself back from the source text.
   */
  async documents(): Promise<DocRow[]> {
    const h = this.header;
    const c = this.containers.get('tags');
    if (!c) return [];
    const at = c.names.indexOf('檔');
    if (at < 0) return [];
    const va = await this.decodeBlockList('tags', at);
    const names = await this.docNames(va);
    const out: DocRow[] = [];
    for (let i = 0; i < va.length; i++) {
      out.push({
        i,
        name: names[i] || `檔 #${i + 1}`,
        vaStart: va[i],
        vaEnd: i + 1 < va.length ? va[i + 1] : h.maxBlockOffset,
      });
    }
    return out;
  }

  private async docNames(va: number[]): Promise<string[]> {
    const n = va.length;
    const caches = this.containers.get('caches');
    if (caches) {
      const ci = caches.names.indexOf('檔');
      if (ci >= 0) {
        const inner = await this.parseContainer(blockRange(caches, ci).start, 'caches/檔');
        if (inner.count >= n) {
          const out: string[] = [];
          for (let i = 0; i < n; i++) out.push(await this.innerString(inner, i));
          if (out.some((s) => s)) return out;
        }
      }
    }
    for (const key of ['檔.id', '檔.n']) {
      const av = await this.attributeValues(key);
      if (av && av.values.length >= n) {
        const out = av.values.slice(0, n).map((s) => (s ? s[0].toUpperCase() + s.slice(1) : ''));
        if (out.some((s) => s)) return out;
      }
    }
    const bv = await this.blocksVirtual();
    const out: string[] = [];
    for (let i = 0; i < n; i++) out.push(await this.tagTextAtVa(va[i], bv, '檔'));
    return out;
  }

  /**
   * A cached string table from the `caches` container, by name (`詞`, `書`, `檔`…).
   *
   * The indexer already extracted these (for fgdict: the innerText of every
   * `<詞>`), so reading the table is ONE container parse — whereas slicing the
   * same text out of `source` costs a bzip2 decode per block touched.
   */
  async cachedStrings(key: string): Promise<string[]> {
    const caches = this.containers.get('caches');
    const ci = caches?.names.indexOf(key) ?? -1;
    if (!caches || ci < 0) return [];
    const inner = await this.innerContainer('caches', ci);
    return this.innerStrings(inner);
  }

  /** A block that is itself a container (attributes/*, caches/*). */
  async innerContainer(container: string, index: number): Promise<Container> {
    const c = this.containers.get(container);
    if (!c) throw new Error(`no container ${container}`);
    return this.parseContainer(blockRange(c, index).start, `${container}/${c.names[index]}`);
  }

  private async innerString(inner: Container, i: number): Promise<string> {
    const r = blockRange(inner, i);
    if (r.end - r.start < 2) return '';
    return decodeUtf16(await this.io.read(r.start, r.end - r.start - 2));
  }

  /**
   * Every block of an inner container in ONE read.
   *
   * A container's data region is contiguous, but the per-block accessor issues one
   * `io.read` per block — and `caches/詞` holds 22,648 blocks (fgdict's headwords),
   * `attributes/頁.n` 6,959. That is one await per entry (~1 s on fgdict) to move
   * ~300 KiB. Read the region once and cut the blocks out of the buffer instead:
   * the same bytes over one round trip.
   */
  private async innerStrings(inner: Container): Promise<string[]> {
    const out: string[] = [];
    if (inner.count <= 0) return out;
    const buf = await this.io.read(inner.dataStart, inner.totalBlockSize);
    for (let i = 0; i < inner.count; i++) {
      const r = blockRange(inner, i);
      const a = r.start - inner.dataStart;
      const b = r.end - inner.dataStart;
      out.push(b - a < 2 ? '' : decodeUtf16(buf.subarray(a, b - 2)));
    }
    return out;
  }

  /**
   * Values of `<tag>.<attr>`, plus the pointers that say WHICH tag instance each
   * value belongs to.
   *
   * The pointer's low 24 bits are the 1-based tag index (`0x04000001` = tag id 4,
   * instance 1) and the high byte is a tag id, so `tags` can be derived from any
   * value — including a singleton table. That is what makes it possible to read
   * `t=` per instance from the attributes container instead of scanning the
   * source text for it.
   */
  async attributeValues(key: string): Promise<{ values: string[]; pointers: Int32Array | null; tags: string[] } | null> {
    const c = this.containers.get('attributes');
    if (!c) return null;
    const at = c.names.indexOf(key);
    if (at < 0) return null;
    const inner = await this.innerContainer('attributes', at);
    const values = await this.innerStrings(inner);
    // high byte -> tag name (for singletons where the tag string is empty)
    const tags = inner.names.map((n) => n || '<unknown>');
    if (inner.pointers) {
      for (let i = 0; i < inner.pointers.length; i++) {
        const p = inner.pointers[i];
        const tagId = inner.names[p >>> 24];
        if (tagId) tags[i] = tagId;
      }
    }
    return { values, pointers: inner.pointers, tags };
  }

  /** The `n="..."` value of the `<tag ...>` whose VA is `va` (SPEC §10 step 4). */
  private async tagTextAtVa(va: number, blocksVirtual: number[], tag: string): Promise<string> {
    const blk = binarySearchLE(blocksVirtual, va);
    if (blk < 0) return '';
    const text = await this.sourceText(blk);
    const idx = text.indexOf('<' + tag);
    if (idx < 0) return '';
    const open = text.indexOf('"', idx);
    if (open < 0) return '';
    const close = text.indexOf('"', open + 1);
    return close < 0 ? text.slice(idx) : text.slice(open + 1, close);
  }

  /** Document text: decode only the source blocks the VA range spans. */
  async docText(d: DocRow, blocksVirtual: number[], maxBlocks = 200): Promise<{ first: number; last: number; text: string; truncated: boolean }> {
    const first = Math.max(0, binarySearchLE(blocksVirtual, d.vaStart));
    let last = d.vaEnd > 0 ? binarySearchLE(blocksVirtual, d.vaEnd - 1) : first;
    if (last < first) last = first;
    const truncated = last - first + 1 > maxBlocks;
    const end = truncated ? first + maxBlocks - 1 : last;
    const parts: string[] = [];
    for (let b = first; b <= end; b++) parts.push(await this.sourceText(b));
    return { first, last, text: parts.join(''), truncated };
  }
}

export function tokenClass(name: string): number {
  if (isAllHan(name)) return CLASS_HAN;
  const c = name.charCodeAt(0);
  if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) return CLASS_LATIN;
  if (c >= 48 && c <= 57) return CLASS_DIGIT;
  return CLASS_OTHER;
}

export function isDirtyName(name: string): boolean {
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c === 0) return true;
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = name.charCodeAt(i + 1);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
}

export function binarySearchLE(xs: ArrayLike<number>, target: number): number {
  let lo = 0, hi = xs.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= target) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}
