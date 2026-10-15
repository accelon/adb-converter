/**
 * Minimal zero-dependency static server for .adb + viewer.
 *
 *   bun run tools/serve-adb.ts [--port 8787] [--root .] [--cors '*']
 *
 * Why it exists: an .adb cannot be read lazily with a naive static server.
 * The container layout is [16B header][data][packed length list], and the block
 * NAME table is the last data block, so "list every token" would mean fetching
 * the whole `tokens` container (10 MiB for yinshun, 328 MiB for sbqs-04).
 * With HTTP Range support the browser can read 16-byte headers and single
 * 10 KiB blocks instead. This server adds the three things a plain file server
 * cannot do:
 *
 *   GET /api/adb/:id/items                    header + container map (no payload)
 *   GET /api/adb/:id/tokens                   token index (names + hit counts)
 *   GET /api/adb/:id/block/:container/:index  one raw block  (source = decompressed)
 *   GET /api/adb/:id/text?block=&from=&to=    decoded text window of a source block
 *   GET /api/db/:file                         raw bytes WITH Range support
 *
 * Everything else is served from disk (viewer assets, extracted XML, resources).
 */
import { openSync, closeSync, readSync, statSync, existsSync } from 'node:fs';
import { join, resolve, normalize } from 'node:path';
import { gzipSync, brotliCompressSync, constants } from 'node:zlib';
import { dlopen } from 'bun:ffi';
import { isAllHan } from '../src/han';

const args = process.argv.slice(2);
const opt = (name: string, def: string) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const PORT = Number(opt('port', '8787'));
const ROOT = resolve(opt('root', '.'));
const CORS = opt('cors', '*');
const HOST = opt('host', '127.0.0.1');
/** --js-decoder: skip libbz2 and use the vendored pure JS decoder (~3x slower). */
const USE_JS_DECODER = args.includes('--js-decoder');

// ---------------------------------------------------------------- .adb reader
const FILE_HEADER_SIZE = 256;
const ROMBLOCK_HEADER_SIZE = 16;
const SIGNATURE = '\r\nAccelon Search Engine\r\ndesigned by C.S.Yap';
const MILE_DISTANCE = 512;
const BO_WITH_POINTER = 0x40000000;
const BO_NAMED = 0x10000000;

function readAt(fd: number, offset: number, length: number): Uint8Array {
  const buf = new Uint8Array(length);
  let done = 0;
  while (done < length) {
    const n = readSync(fd, buf, done, length - done, offset + done);
    if (n <= 0) throw new Error(`unexpected EOF at ${offset + done}`);
    done += n;
  }
  return buf;
}

const dvOf = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

function cstr(b: Uint8Array, from: number, to: number): string {
  let end = from;
  while (end < to && b[end] !== 0) end++;
  return new TextDecoder('latin1').decode(b.subarray(from, end));
}

interface Container {
  name: string;
  start: number; dataStart: number; totalBlockSize: number; blockSize: number;
  feature: number; count: number; listStart: number;
  ends: number[] | null; names: string[]; pointers: Int32Array | null;
}

function packedListSize(fd: number, offset: number): number {
  const added = dvOf(readAt(fd, offset, 4)).getUint32(0, true);
  return 4 + Math.floor(added / MILE_DISTANCE) * 8 + added;
}

function decodePackedList(buf: Uint8Array): number[] {
  const dv = dvOf(buf);
  const added = dv.getUint32(0, true);
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

function countPackedList(buf: Uint8Array): number {
  const added = dvOf(buf).getUint32(0, true);
  const end = 4 + Math.floor(added / MILE_DISTANCE) * 8 + added;
  let off = 4 + Math.floor(added / MILE_DISTANCE) * 8;
  let count = 0;
  while (off < end) {
    off++;
    while (off < end && buf[off] >= 0x80) off++;
    count++;
  }
  return count;
}

/** Parse one container. `withNames` reads the (small) nested name container. */
function parseContainer(fd: number, start: number, name = ''): Container {
  const h = readAt(fd, start, ROMBLOCK_HEADER_SIZE);
  const dv = dvOf(h);
  const feature = dv.getUint32(0, true);
  const totalBlockSize = dv.getUint32(8, true);
  const blockSize = dv.getInt32(12, true);
  const dataStart = start + ROMBLOCK_HEADER_SIZE;
  let ends: number[] | null = null;
  let count = 0;
  let listStart = 0;
  if (blockSize === 0) {
    listStart = dataStart + totalBlockSize;
    const size = packedListSize(fd, listStart);
    ends = decodePackedList(readAt(fd, listStart, size));
    count = ends.length;
  } else {
    count = Math.floor(totalBlockSize / blockSize);
  }
  let pointers: Int32Array | null = null;
  if (feature & BO_WITH_POINTER) {
    const n = ends ? ends.length : count;
    const at = blockSize === 0 ? listStart + packedListSize(fd, listStart) : dataStart + totalBlockSize;
    const buf = readAt(fd, at, n * 4);
    pointers = new Int32Array(n);
    for (let i = 0; i < n; i++) pointers[i] = dvOf(buf).getInt32(i * 4, true);
  }
  const names: string[] = [];
  if (feature & BO_NAMED) {
    if (ends && ends.length >= 2) {
      // the last data block is a nested container holding UTF-16LE names
      const nbStart = dataStart + ends[ends.length - 2];
      const nb = parseContainer(fd, nbStart);
      const n = nb.ends ? nb.ends.length : nb.count;
      for (let i = 0; i < n; i++) {
        const end = nb.ends ? nb.ends[i] : (i + 1) * nb.blockSize;
        const begin = nb.ends ? (i > 0 ? nb.ends[i - 1] : 0) : i * nb.blockSize;
        const len = end - begin - 2; // trailing UTF-16 NUL
        if (len > 0) names.push(new TextDecoder('utf-16le').decode(readAt(fd, nb.dataStart + begin, len)));
      }
      count--;
    } else if (!ends) {
      const begin = (count - 1) * blockSize;
      const raw = new TextDecoder('utf-16le').decode(readAt(fd, dataStart + begin, blockSize));
      for (const s of raw.split('\0')) if (s) names.push(s);
      count--;
    }
  }
  return { name, start, dataStart, totalBlockSize, blockSize, feature, count, listStart, ends, names, pointers };
}

function blockRange(c: Container, i: number): { start: number; end: number } {
  if (c.ends) return { start: c.dataStart + (i > 0 ? c.ends[i - 1] : 0), end: c.dataStart + c.ends[i] };
  return { start: c.dataStart + i * c.blockSize, end: c.dataStart + (i + 1) * c.blockSize };
}

interface Db {
  id: string; path: string; size: number; mtimeMs: number; etag: string; fd: number;
  header: Record<string, unknown>;
  top: Container;
  containers: Map<string, Container>;
  // lazily built token index (names + posting byte lengths; no payload decode)
  tokenIndex?: { body: Uint8Array; bytes: number; classes: number[]; hanBytes: number };
}

const dbs = new Map<string, Db>();

function openDb(id: string, path: string): Db {
  const st = statSync(path);
  const fd = openSync(path, 'r');
  const hb = readAt(fd, 0, FILE_HEADER_SIZE);
  const signature = cstr(hb, 32, 80);
  if (signature !== SIGNATURE) { closeSync(fd); throw new Error('not an adb (bad signature)'); }
  const dv = dvOf(hb);
  const header = {
    dbname: cstr(hb, 0, 32),
    dbcname: (() => { const s = new TextDecoder('utf-16le').decode(hb.subarray(128, 192)); const z = s.indexOf('\0'); return z < 0 ? s : s.slice(0, z); })(),
    signature, version: dv.getInt32(84, true), compression: dv.getInt32(88, true),
    srcBlockSize: dv.getInt32(92, true), maxBlockOffset: dv.getInt32(96, true),
    andTagId: dv.getInt32(100, true), lineCount: dv.getInt32(104, true),
    dbType: dv.getInt32(108, true), protection: dv.getInt32(112, true),
    tagCount: dv.getInt32(116, true), features: dv.getInt32(120, true),
    crc32: dv.getUint32(252, true), size: st.size,
  };
  const top = parseContainer(fd, 256, '');
  const containers = new Map<string, Container>();
  for (const n of top.names) containers.set(n, parseContainer(fd, blockRange(top, top.names.indexOf(n)).start, n));
  const etag = `"${st.size.toString(16)}-${Math.round(st.mtimeMs).toString(16)}"`;
  const db: Db = { id, path, size: st.size, mtimeMs: st.mtimeMs, etag, fd, header, top, containers };
  dbs.set(id, db);
  return db;
}

/** Decode one compressed container block with libbz2 (bun:ffi). */
let decodeFn: ((src: Uint8Array, dest: Uint8Array) => number) | null = null;
let decoderNote = 'not initialised';
function initDecoder() {
  if (decodeFn) return;
  if (USE_JS_DECODER) { initJsDecoder(); return; }
  const candidates = [
    process.env.ABX_LIBBZ2,
    'C:\\Program Files\\Git\\mingw64\\bin\\libbz2-1.dll',
    'C:\\Program Files\\Git\\mingw64\\libexec\\git-core\\libbz2-1.dll',
    'libbz2-1.dll', 'libbz2.dll',
    '/usr/lib/x86_64-linux-gnu/libbz2.so.1.0', '/usr/lib/libbz2.so.1', 'libbz2.so.1',
  ].filter(Boolean) as string[];
  const notes: string[] = [];
  for (const p of candidates) {
    if ((p.includes('\\') || p.includes('/')) && !existsSync(p)) continue;
    try {
      const lib = dlopen(p, {
        BZ2_bzBuffToBuffDecompress: { args: ['ptr', 'ptr', 'ptr', 'uint32_t', 'int32_t', 'int32_t'], returns: 'int32_t' },
      });
      const fn = lib.symbols.BZ2_bzBuffToBuffDecompress as
        (d: Uint8Array, dl: Uint32Array, s: Uint8Array, sl: number, small: number, verbosity: number) => number;
      const lenBuf = new Uint32Array(1);
      decodeFn = (src, dest) => {
        lenBuf[0] = dest.length;
        const rc = fn(dest, lenBuf, src, src.length, 0, 0);
        if (rc === 0) return lenBuf[0];
        if (rc === -8) return -1; // BZ_OUTBUFF_FULL
        throw new Error('libbz2 rc=' + rc);
      };
      decoderNote = 'libbz2 ' + p;
      return;
    } catch (e) {
      notes.push(`${p}: ${(e as Error).message}`);
    }
  }
  decoderNote = 'unavailable: ' + notes[0]?.slice(0, 120);
  // Not fatal: /counts, /items, /tokens, /classes and /layout are all derived
  // from container headers and the packed length list, so they work without a
  // native bzip2. Only /block/source/<i> needs one.
}

/** Pure JS fallback (ts/src/vendor/bzip2.js, MIT) — no native library needed. */
function initJsDecoder() {
  if (decodeFn) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { bzip2 } = require('../src/vendor/bzip2.js');
    decodeFn = (src: Uint8Array, dest: Uint8Array) => {
      let pos = 0;
      let overflow = false;
      bzip2.simple(src, (byte: number) => {
        if (pos < dest.length) dest[pos++] = byte;
        else overflow = true;
      });
      return overflow ? -1 : pos;
    };
    decoderNote = 'pure JS (vendor/bzip2.js)';
  } catch (e) {
    decoderNote = 'js decoder failed: ' + (e as Error).message;
  }
}

const blockCache = new Map<string, Uint8Array>();
let blockCacheBytes = 0;
const BLOCK_CACHE_LIMIT = 64 * 1024 * 1024;

function cacheGet(k: string) { return blockCache.get(k); }
function cachePut(k: string, v: Uint8Array) {
  if (blockCacheBytes + v.length > BLOCK_CACHE_LIMIT) {
    // drop the oldest entries until it fits
    for (const key of blockCache.keys()) {
      const old = blockCache.get(key)!;
      blockCache.delete(key);
      blockCacheBytes -= old.length;
      if (blockCacheBytes + v.length <= BLOCK_CACHE_LIMIT) break;
    }
  }
  blockCache.set(k, v);
  blockCacheBytes += v.length;
}

function decodeSourceBlock(db: Db, index: number): Uint8Array {
  const key = `${db.id}:source:${index}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  const src = db.containers.get('source');
  if (!src) throw new Error('no source container');
  if (index < 0 || index >= src.count) throw new Error(`source block ${index} out of range (0..${src.count - 1})`);
  const r = blockRange(src, index);
  const raw = readAt(db.fd, r.start, r.end - r.start);
  const stride = (db.header.srcBlockSize as number) + 4;
  let out: Uint8Array;
  if ((db.header.compression as number) === 0) {
    out = raw;
  } else {
    initDecoder();
    if (!decodeFn) {
      throw new Error('this container is bzip2 compressed and no libbz2 is available; '
        + 'set ABX_LIBBZ2=/path/to/libbz2 (the token index and counters do not need it)');
    }
    let dest = new Uint8Array(stride);
    let got = decodeFn!(raw, dest);
    while (got === -1) { dest = new Uint8Array(dest.length * 2); got = decodeFn!(raw, dest); }
    out = dest.subarray(0, got);
  }
  cachePut(key, out);
  return out;
}

/**
 * Token class byte, mirroring ts/src/han.ts so the viewer does not have to
 * re-derive the CJK ranges. The UI loads `han` first; `latin`/`digit`/`other`
 * are collapsed to a count until the user asks for them.
 */
const CLASS_HAN = 0, CLASS_LATIN = 1, CLASS_DIGIT = 2, CLASS_OTHER = 3;
function tokenClass(name: string): number {
  if (isAllHan(name)) return CLASS_HAN;
  const c = name.charCodeAt(0);
  if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) return CLASS_LATIN;
  if (c >= 48 && c <= 57) return CLASS_DIGIT;
  return CLASS_OTHER;
}

/**
 * Token index payload (little endian). Everything here comes from container
 * headers plus the packed length list: NO posting payload is read or decoded.
 *
 *   u32 count
 *   repeat count times:
 *     u16 units            code units of the name (no NUL)
 *     u16*units            name, UTF-16LE, byte-preserving (lone surrogates intact)
 *     varint postingBytes  byte length of that token's posting list
 *     u8  cls              CLASS_*
 *
 * postingBytes is the length-list derived size of block i, i.e.
 * `ends[i] - (i ? ends[i-1] : 0)`, which is a proxy for the posting count
 * (measured rank correlation ≈ 1.0; see build/probe-size-proxy.ts). The packed
 * list adds 4 + milestone bytes, ~1–8% for large postings; a 1-hit list is 5
 * bytes, so tiny postings read larger than they are — inherent to the quantity.
 * It is stored as a varint because it IS the packed list's own delta, so the
 * stored value is exactly the number of bytes the adb spends on that posting.
 *
 * Cost: one length-list parse per container. Measured 13j 3 ms, yinshun 1 ms,
 * lawtw 12 ms, sbqs-04 3 ms — versus 16 / 49 / 1098 / 674 ms to count exactly.
 */
function tokenIndex(db: Db): { body: Uint8Array; bytes: number; classes: number[]; hanBytes: number } {
  if (db.tokenIndex) return db.tokenIndex;
  const tok = db.containers.get('tokens');
  if (!tok) throw new Error('no tokens container');
  const parts: Uint8Array[] = [];
  let bytes = 0;
  const classes = [0, 0, 0, 0];
  let hanBytes = 0;
  const head = new Uint8Array(4);
  dvOf(head).setUint32(0, tok.count, true);
  parts.push(head);
  for (let i = 0; i < tok.count; i++) {
    const name = tok.names[i] ?? '';
    const units = name.length;
    const nameBuf = new Uint8Array(units * 2);
    for (let k = 0; k < units; k++) dvOf(nameBuf).setUint16(k * 2, name.charCodeAt(k), true);
    const r = blockRange(tok, i);
    const size = r.end - r.start;
    bytes += size;
    const cls = tokenClass(name);
    classes[cls]++;
    if (cls === CLASS_HAN) hanBytes += size;
    const lenBuf = new Uint8Array(2);
    dvOf(lenBuf).setUint16(0, units, true);
    const vb: number[] = [];
    let v = size;
    do { const low = v % 128; v = Math.floor(v / 128); vb.push(v > 0 ? low | 0x80 : low); } while (v > 0);
    parts.push(lenBuf, nameBuf, Uint8Array.from(vb), Uint8Array.of(cls));
  }
  const body = Buffer.concat(parts as unknown as Uint8Array[]);
  db.tokenIndex = { body, bytes, classes, hanBytes };
  return db.tokenIndex;
}

// ------------------------------------------------------------------ HTTP glue
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.adb': 'application/octet-stream',
  '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};

interface ByteRange { start: number; end: number } // inclusive

/**
 * Parse a Range header (RFC 9110 §14.1.1).
 *   null -> unsatisfiable (416)
 *   []   -> no usable range: missing, malformed, or not `bytes=` -> serve 200
 */
function parseRange(header: string | null, size: number): ByteRange[] | null {
  if (!header) return [];
  const m = /^bytes=(.*)$/i.exec(header.trim());
  if (!m) return [];
  const out: ByteRange[] = [];
  for (const part of m[1].split(',')) {
    const s = part.trim();
    if (!s) return [];
    const mm = /^(\d*)-(\d*)$/.exec(s);
    if (!mm) return []; // unknown range unit / malformed -> ignore the header
    const [, a, b] = mm;
    if (a === '' && b === '') return [];
    let start: number, end: number;
    if (a === '') {
      const n = Number(b);
      if (n <= 0) return null;
      start = Math.max(0, size - n);
      end = size - 1;
    } else {
      start = Number(a);
      end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
      if (start >= size) return null; // starts past EOF -> unsatisfiable
      if (start > end) return [];     // last-pos < first-pos -> invalid, ignore
    }
    out.push({ start, end });
  }
  return out.length ? out : [];
}

function corsHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': CORS,
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    // Range and If-Range must be listed or a cross-origin range fetch fails preflight
    'Access-Control-Allow-Headers': 'Range, If-Range, If-None-Match, Content-Type',
    'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length, ETag, X-Adb-*',
    'Vary': 'Origin',
    ...extra,
  };
}

function fileResponse(path: string, req: Request, opts: { etag?: string; download?: string } = {}): Response {
  const st = statSync(path);
  const etag = opts.etag ?? `"${st.size.toString(16)}-${Math.round(st.mtimeMs).toString(16)}"`;
  const base: Record<string, string> = {
    'Accept-Ranges': 'bytes',
    'ETag': etag,
    'Last-Modified': new Date(st.mtimeMs).toUTCString(),
    'Cache-Control': 'public, max-age=31536000, immutable',
    ...corsHeaders(),
  };
  if (opts.download) base['Content-Disposition'] = `inline; filename="${opts.download}"`;
  if (req.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers: base });

  const rangeHeader = req.headers.get('range');
  const ifRange = req.headers.get('if-range');
  // If-Range: serve the whole file when the validator no longer matches
  const rangeOk = rangeHeader && (!ifRange || ifRange === etag);
  const ranges = rangeOk ? parseRange(rangeHeader, st.size) : [];

  if (ranges === null) {
    return new Response(null, { status: 416, headers: { ...base, 'Content-Range': `bytes */${st.size}` } });
  }
  if (ranges.length === 0) {
    // no/invalid range -> full body (a 200 tells the client Range was ignored)
    const fd = openSync(path, 'r');
    const buf = readAt(fd, 0, st.size);
    closeSync(fd);
    return new Response(buf, { status: 200, headers: { ...base, 'Content-Type': MIME['.adb'] ?? 'application/octet-stream', 'Content-Length': String(st.size) } });
  }
  if (ranges.length === 1) {
    const { start, end } = ranges[0];
    const fd = openSync(path, 'r');
    const buf = readAt(fd, start, end - start + 1);
    closeSync(fd);
    return new Response(buf, {
      status: 206,
      headers: {
        ...base,
        'Content-Type': MIME[path.slice(path.lastIndexOf('.')).toLowerCase()] ?? 'application/octet-stream',
        'Content-Range': `bytes ${start}-${end}/${st.size}`,
        'Content-Length': String(end - start + 1),
      },
    });
  }
  // multiple ranges -> multipart/byteranges
  const boundary = 'ADBBOUNDARY' + Math.random().toString(16).slice(2);
  const fd = openSync(path, 'r');
  const chunks: Uint8Array[] = [];
  for (const { start, end } of ranges) {
    chunks.push(new TextEncoder().encode(
      `\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\nContent-Range: bytes ${start}-${end}/${st.size}\r\n\r\n`));
    chunks.push(readAt(fd, start, end - start + 1));
  }
  chunks.push(new TextEncoder().encode(`\r\n--${boundary}--\r\n`));
  closeSync(fd);
  const body = Buffer.concat(chunks as unknown as Uint8Array[]);
  return new Response(body, {
    status: 206,
    headers: {
      ...base,
      'Content-Type': `multipart/byteranges; boundary=${boundary}`,
      'Content-Length': String(body.length),
    },
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders() },
  });
}

/** Compress an octet-stream response when the client accepts it. */
function binary(body: Uint8Array, headers: Record<string, string>, accept: string): Response {
  if (/\bbr\b/.test(accept)) {
    const out = brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } });
    return new Response(out, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Encoding': 'br', ...headers, ...corsHeaders() } });
  }
  if (/\bgzip\b/.test(accept)) {
    const out = gzipSync(body, { level: 6 });
    return new Response(out, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Encoding': 'gzip', ...headers, ...corsHeaders() } });
  }
  return new Response(body, { headers: { 'Content-Type': 'application/octet-stream', ...headers, ...corsHeaders() } });
}

// ------------------------------------------------------------------- routing
const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  idleTimeout: 60,
  async fetch(req) {
    const url = new URL(req.url);
    const path = decodeURIComponent(url.pathname);

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return new Response('method not allowed', { status: 405, headers: corsHeaders({ Allow: 'GET, HEAD, OPTIONS' }) });
    }

    try {
      const res = await route(req, url, path);
      // HEAD: same headers, no body
      return req.method === 'HEAD' ? new Response(null, { status: res.status, headers: res.headers }) : res;
    } catch (e) {
      return json({ error: (e as Error).message }, 500);
    }
  },
});

async function route(req: Request, url: URL, path: string): Promise<Response> {
  // ---- dynamic API ---------------------------------------------------
  let m = /^\/api\/adb\/([^/]+)\/items$/.exec(path);
  if (m) {
    const db = resolveDb(m[1]);
    return json({
      header: db.header,
      containers: Object.fromEntries([...db.containers].map(([n, c]) => [n, {
        start: c.start, dataStart: c.dataStart, totalBlockSize: c.totalBlockSize,
        blockSize: c.blockSize, feature: c.feature, count: c.count, listStart: c.listStart,
      }])),
      containerOrder: db.top.names,
      decoder: decoderNote,
    });
  }
  m = /^\/api\/adb\/([^/]+)\/counts$/.exec(path);
  if (m) {
    const db = resolveDb(m[1]);
    const tok = db.containers.get('tokens');
    const tags = db.containers.get('tags');
    const tabs = db.containers.get('tables');
    const res = db.containers.get('resources');
    const src = db.containers.get('source');
    const H = db.header as Record<string, number>;
    // 檔 (FILE) tag = documents. tables.ends[i]-ends[i-1] gives the doclengths
    // length without touching the payload, the same free quantity as above.
    let documents = 0;
    const dl = tabs?.names.indexOf('doclengths') ?? -1;
    if (dl >= 0 && tabs!.ends) {
      documents = tabs!.ends[dl] - (dl > 0 ? tabs!.ends[dl - 1] : 0);
    }
    const out = {
      db: H.dbname, dbcname: db.header.dbcname, size: db.size,
      version: H.version, compression: H.compression, srcBlockSize: H.srcBlockSize,
      // header-only counters (no container payload needed)
      distinctTokens: tok?.count ?? 0,
      totalTagHits: H.tagCount,          // header.tagCount = tables/tags.virtual entries
      virtualLength: H.maxBlockOffset,
      lines: H.lineCount,
      dbType: H.dbType, isDictionary: (H.dbType & 2) !== 0,
      srcBlocks: src?.count ?? 0,
      tagKinds: tags?.count ?? 0,
      documents,
      resources: res?.count ?? 0,
      containers: db.top.names.length,
      decoder: decoderNote,
    };
    const etag = db.etag + '-counts';
    if (req.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers: corsHeaders({ ETag: etag }) });
    return json(out);
  }

  m = /^\/api\/adb\/([^/]+)\/classes$/.exec(path);
  if (m) {
    // Per-class token counts and posting bytes. Derived from the length list only.
    const db = resolveDb(m[1]);
    const t = tokenIndex(db);
    const [han, latin, digit, other] = t.classes;
    return json({
      count: t.classes.reduce((a, b) => a + b, 0),
      postingBytes: t.bytes,
      han, latin, digit, other, hanBytes: t.hanBytes,
      classes: { han: CLASS_HAN, latin: CLASS_LATIN, digit: CLASS_DIGIT, other: CLASS_OTHER },
    });
  }

  m = /^\/api\/adb\/([^/]+)\/tokens$/.exec(path);
  if (m) {
    const db = resolveDb(m[1]);
    const t = tokenIndex(db);
    const tok = db.containers.get('tokens')!;
    const units = tok.names.reduce((a, s) => a + s.length, 0);
    return binary(t.body, {
      'X-Adb-Tokens': String(tok.count),
      'X-Adb-PostingBytes': String(t.bytes),
      'X-Adb-Units': String(units),
      'X-Adb-Han': String(t.classes[CLASS_HAN]),
      'X-Adb-HanBytes': String(t.hanBytes),
      'X-Adb-Latin': String(t.classes[CLASS_LATIN]),
      'X-Adb-Digit': String(t.classes[CLASS_DIGIT]),
      'X-Adb-Other': String(t.classes[CLASS_OTHER]),
      'X-Adb-Decoder': decoderNote,
      'Cache-Control': 'no-cache',
      'ETag': db.etag + '-tokens',
    }, req.headers.get('accept-encoding') ?? '');
  }

  // debug helper: the cumulative block end offsets of a container. The viewer
  // does not need it (it gets the same numbers from /items), but the contract
  // test uses it to derive e.g. the name table size.
  m = /^\/api\/adb\/([^/]+)\/debug\/lengths\/([^/]+)$/.exec(path);
  if (m) {
    const db = resolveDb(m[1]);
    const c = db.containers.get(m[2]);
    if (!c) return json({ error: `no container ${m[2]}` }, 404);
    return json({ container: c.name, count: c.count, blockSize: c.blockSize, lengths: c.ends ?? [] });
  }

  m = /^\/api\/adb\/([^/]+)\/block\/([^/]+)\/(\d+)$/.exec(path);  if (m) {
    const db = resolveDb(m[1]);
    const c = db.containers.get(m[2]);
    if (!c) return json({ error: `no container ${m[2]}` }, 404);
    const i = Number(m[3]);
    const r = blockRange(c, i);
    if (m[2] === 'source') {
      const buf = decodeSourceBlock(db, i);
      return new Response(buf, {
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Adb-Block': `${i}`,
          'X-Adb-Container': c.name,
          'X-Adb-Compressed': String(c.feature),
          'X-Adb-Pa': String(r.start - c.dataStart),
          ...corsHeaders(),
        },
      });
    }
    const buf = readAt(db.fd, r.start, r.end - r.start);
    return new Response(buf, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Adb-Block': `${i}`, 'X-Adb-Container': c.name,
        ...corsHeaders(),
      },
    });
  }

  m = /^\/api\/adb\/([^/]+)\/layout$/.exec(path);
  if (m) {
    const db = resolveDb(m[1]);
    // tables/blocks.virtual as raw u32 (the VA -> source block map)
    const tab = db.containers.get('tables');
    if (!tab) return json({ error: 'no tables' }, 404);
    const at = tab.names.indexOf('blocks.virtual');
    if (at < 0) return json({ error: 'no blocks.virtual' }, 404);
    const r = blockRange(tab, at);
    const vals = decodePackedList(readAt(db.fd, r.start, r.end - r.start));
    const out = new Uint8Array(8 + vals.length * 4);
    dvOf(out).setUint32(0, vals.length, true);
    dvOf(out).setUint32(4, db.header.srcBlockSize as number, true);
    for (let i = 0; i < vals.length; i++) dvOf(out).setUint32(8 + i * 4, vals[i], true);
    return binary(out, { 'ETag': db.etag + '-layout', 'X-Adb-Blocks': String(vals.length) },
      req.headers.get('accept-encoding') ?? '');
  }

  // ---- raw bytes with Range ----------------------------------------
  m = /^\/api\/db\/(.+)$/.exec(path);
  if (m) {
    const p = safeJoin(ROOT, m[1]);
    if (!p || !existsSync(p)) return new Response('not found', { status: 404, headers: corsHeaders() });
    return fileResponse(p, req);
  }

  // ---- static ------------------------------------------------------
  const p = safeJoin(ROOT, path === '/' ? '/index.html' : path);
  if (!p || !existsSync(p) || statSync(p).isDirectory()) {
    return new Response('not found: ' + path, { status: 404, headers: corsHeaders() });
  }
  return fileResponse(p, req);
}

function resolveDb(id: string): Db {
  const cached = dbs.get(id);
  if (cached) return cached;
  const p = safeJoin(ROOT, id + '.adb') ?? safeJoin(ROOT, id);
  if (!p || !existsSync(p)) throw new Error(`adb not found: ${id}`);
  return openDb(id, p);
}

function safeJoin(root: string, rel: string): string | null {
  const p = normalize(join(root, rel));
  return p.startsWith(root) ? p : null;
}

console.log(`abx server on http://${HOST}:${PORT}  root=${ROOT}  cors=${CORS}`);
console.log('  GET /api/db/<file>                         raw bytes, Range supported');
console.log('  GET /api/adb/<id>/counts                   header-only counters (first paint)');
console.log('  GET /api/adb/<id>/classes                  tokens per class (han/latin/digit/other)');
console.log('  GET /api/adb/<id>/items                    header + container map');
console.log('  GET /api/adb/<id>/tokens                   token index (names + hit counts)');
console.log('  GET /api/adb/<id>/layout                   blocks.virtual as u32[]');
console.log('  GET /api/adb/<id>/block/<container>/<i>    one block (source = decompressed)');
console.log('  id = a file name relative to root without .adb, e.g. "13j" or "yinshun/yinshun"');

export { server, parseRange, parseContainer, decodeSourceBlock };
