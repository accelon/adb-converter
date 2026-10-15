/**
 * The exporter: .adb -> XML (+ resources), streaming and multi threaded.
 *
 * Pipeline
 *   read chunk of compressed source blocks  ->  worker pool (bzip2)  ->  in
 *   order consumer  ->  line splitting  ->  `<檔` file splitting  ->  disk
 *
 * Peak memory is bounded by `window` chunks (default 2 per worker), because
 * chunks are read ahead but written out strictly in file order.
 */
import { closeSync, openSync, statSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import {
  blockOffsetByName,
  blockRange,
  decodePackedList,
  packedListSize,
  parseBlockSet,
  parseHeader,
  readAt,
  type AdbHeader,
  type BlockSet,
} from './format';
import { DecodePool, defaultJobs } from './pool';
import type { TextModel } from './decode';
import { LineSplitter, XmlWriter, sanitizeName, type OutputFile } from './textstream';
import type { DecoderKind } from './bz2';

export interface ExportOptions {
  outDir: string;
  /** also extract the `resources` container */
  all?: boolean;
  jobs?: number;
  decoder?: DecoderKind;
  stdout?: boolean;
  noOverwrite?: boolean;
  /** target compressed bytes per work chunk */
  chunkBytes?: number;
  /** in flight chunks = jobs * windowFactor */
  windowFactor?: number;
  /** absolute number of chunks in flight (overrides windowFactor) */
  window?: number;
  /** measure only, write nothing */
  discard?: boolean;
  /**
   * Text model: delphi (default) follows srcpack.pas - physical address grid,
   * per block NUL termination, leading CR/LF skipped, code units concatenated
   * unchanged. dbjs reproduces the JS port byte for byte (tight layout, per
   * block BOM drop, surrogate halves at block edges turned into U+FFFD).
   */
  text?: TextModel;
  progress?: boolean;
  log?: (msg: string) => void;
  /** share one decoder pool across files; the caller keeps ownership */
  pool?: DecodePool;
}

export interface ExportResult {
  input: string;
  header: AdbHeader;
  xmlFiles: OutputFile[];
  resourceFiles: OutputFile[];
  inBytes: number;
  sourceBytes: number;
  textBytes: number;
  outBytes: number;
  lines: number;
  blocks: number;
  chunks: number;
  ms: number;
  decoder: string;
  workers: number;
  warnings: string[];
}

interface Chunk {
  first: number;
  last: number;
  start: number;
  end: number;
}

function planChunks(bs: BlockSet, count: number, targetBytes: number): Chunk[] {
  const chunks: Chunk[] = [];
  let i = 0;
  while (i < count) {
    const start = blockRange(bs, i).start;
    let end = start;
    let j = i;
    while (j < count) {
      end = blockRange(bs, j).end;
      j++;
      if (end - start >= targetBytes) break;
    }
    chunks.push({ first: i, last: j - 1, start, end });
    i = j;
  }
  return chunks;
}

export interface AdbInfo {
  header: AdbHeader;
  outer: BlockSet;
  sources: BlockSet | null;
  tables: BlockSet | null;
  resources: BlockSet | null;
  lineEnds: number[];
  blockCount: number;
}

/** Read everything except the bulk text blocks. Cheap, used by `inspect`. */
export function inspectAdb(path: string): AdbInfo {
  const fd = openSync(path, 'r');
  try {
    const header = parseHeader(readAt(fd, 0, 256));
    if (!header) throw new Error(`${path}: not an Accelon3 .adb file (bad signature)`);
    const outer = parseBlockSet(fd, 256);
    const sourceStart = blockOffsetByName(outer, 'source');
    const sources = sourceStart ? parseBlockSet(fd, sourceStart) : null;
    const tablesStart = blockOffsetByName(outer, 'tables');
    const tables = tablesStart ? parseBlockSet(fd, tablesStart) : null;
    const resourcesStart = blockOffsetByName(outer, 'resources');
    const resources = resourcesStart ? parseBlockSet(fd, resourcesStart) : null;
    let lineEnds: number[] = [];
    if (tables) {
      const at = blockOffsetByName(tables, 'lines.physical');
      if (at) lineEnds = decodePackedList(readAt(fd, at, packedListSize(fd, at)));
    }
    const blockCount = sources ? (sources.lengths ? sources.lengths.length : sources.count) : 0;
    return { header, outer, sources, tables, resources, lineEnds, blockCount };
  } finally {
    closeSync(fd);
  }
}

export async function exportAdb(path: string, opts: ExportOptions): Promise<ExportResult> {
  const t0 = performance.now();
  const warnings: string[] = [];
  const log = opts.log ?? (() => {});
  const fd = openSync(path, 'r');
  let pool: DecodePool | null = null;
  let ownsPool = true;
  try {
    const inBytes = statSync(path).size;
    const header = parseHeader(readAt(fd, 0, 256));
    if (!header) throw new Error(`${path}: not an Accelon3 .adb file (bad signature)`);
    if (header.compression !== 1) {
      warnings.push(`compression flag is ${header.compression} (expected 1 = bzip2 blocks)`);
    }

    const outer = parseBlockSet(fd, 256);
    const sourceStart = blockOffsetByName(outer, 'source');
    if (!sourceStart) throw new Error(`${path}: no 'source' block in the top level container`);
    const sources = parseBlockSet(fd, sourceStart);
    const blocks = sources.lengths ? sources.lengths.length : sources.count;

    const tablesStart = blockOffsetByName(outer, 'tables');
    let lineEnds: number[] = [];
    if (tablesStart) {
      const tables = parseBlockSet(fd, tablesStart);
      const at = blockOffsetByName(tables, 'lines.physical');
      if (at) lineEnds = decodePackedList(readAt(fd, at, packedListSize(fd, at)));
      else warnings.push("tables container has no 'lines.physical' block");
    } else {
      warnings.push("no 'tables' container: cannot split lines");
    }
    if (lineEnds.length !== header.lineCount) {
      warnings.push(`header.lineCount=${header.lineCount} but lines.physical has ${lineEnds.length} entries`);
    }

    // sanity check the block framing before spawning workers
    if (blocks > 0) {
      const first = blockRange(sources, 0);
      const magic = readAt(fd, first.start, 3);
      if (magic.toString('latin1') !== 'BZh') {
        warnings.push(`first source block does not start with the bzip2 magic (got ${JSON.stringify(magic.toString('latin1'))})`);
      }
    }

    const jobs = Math.max(1, opts.jobs ?? defaultJobs());
    ownsPool = !opts.pool;
    pool = opts.pool ?? new DecodePool(jobs, opts.decoder ?? 'auto');
    warnings.push(...pool.notes);

    const writer = new XmlWriter({
      outDir: opts.outDir,
      dbname: header.dbname,
      stdout: opts.stdout,
      noOverwrite: opts.noOverwrite,
      discard: opts.discard,
    });
    const delphi = (opts.text ?? 'delphi') === 'delphi';
    const splitter = new LineSplitter(lineEnds, writer, 1 << 20, {
      stripNul: delphi,
      skipCrLf: delphi,
      keepBom: delphi,
    });

    // Split into enough chunks to keep every worker busy, but never smaller
    // than a single block and never bigger than the requested target.
    const sourceSpan = blocks > 0 ? blockRange(sources, blocks - 1).end - blockRange(sources, 0).start : 0;
    const targetChunk = Math.max(
      1,
      Math.min(opts.chunkBytes ?? 8 << 20, Math.ceil(sourceSpan / Math.max(1, pool.size * 2))),
    );
    const chunks = planChunks(sources, blocks, targetChunk);
    const window = Math.max(2, opts.window ?? pool.size * (opts.windowFactor ?? 2));
    const pending = new Map<number, ReturnType<DecodePool['submit']>>();
    const sourceBytes = chunks.length ? chunks[chunks.length - 1].end - chunks[0].start : 0;
    let next = 0;
    let consumedBytes = 0;
    let lastReport = 0;

    for (let consumed = 0; consumed < chunks.length; consumed++) {
      while (next < chunks.length && pending.size < window) {
        const c = chunks[next];
        const src = readAt(fd, c.start, c.end - c.start);
        const ends: number[] = [];
        for (let k = c.first; k <= c.last; k++) ends.push(blockRange(sources, k).end - c.start);
        pending.set(
          next,
          pool.submit({ src, ends, hint: header.srcBlockSize, firstBlock: c.first, blockCount: blocks, model: opts.text ?? 'delphi' }),
        );
        next++;
      }
      const chunk = chunks[consumed];
      const res = await pending.get(consumed)!;
      pending.delete(consumed);
      splitter.push(Buffer.from(res.out.buffer, res.out.byteOffset, res.out.byteLength));
      consumedBytes += chunk.end - chunk.start;
      if (opts.progress) {
        const now = performance.now();
        if (now - lastReport > 500 || consumed === chunks.length - 1) {
          lastReport = now;
          const pct = sourceBytes ? ((consumedBytes / sourceBytes) * 100).toFixed(1) : '?';
          process.stderr.write(
            `\r  ${path}: ${pct}% (${(consumedBytes / 1048576).toFixed(0)}/${(sourceBytes / 1048576).toFixed(0)} MiB source)`,
          );
          if (consumed === chunks.length - 1) process.stderr.write('\n');
        }
      }
    }
    splitter.finish();
    const xmlFiles = writer.finish();
    if (splitter.stats.tailBytes > 0) {
      warnings.push(
        `${splitter.stats.tailBytes} bytes of decoded text past the last line offset were dropped (same as the reference exporter)`,
      );
    }

    // resources are optional, unnamed containers are possible
    const resourceFiles: OutputFile[] = [];
    const resourcesStart = blockOffsetByName(outer, 'resources');
    if (opts.all && resourcesStart && !opts.discard) {
      if (opts.stdout) throw new Error('--stdout cannot be combined with --all (multiple outputs)');
      const resources = parseBlockSet(fd, resourcesStart);
      const n = resources.lengths ? resources.lengths.length : resources.count;
      const used = new Set<string>();
      for (let i = 0; i < n; i++) {
        const r = blockRange(resources, i);
        let name = resources.names[i] ? sanitizeName(resources.names[i]) : `resource-${String(i).padStart(4, '0')}.bin`;
        while (used.has(name)) name = name.replace(/(\.[^.]*)?$/, '~1$1');
        used.add(name);
        const buf = readAt(fd, r.start, r.end - r.start);
        const out = join(opts.outDir, name);
        const wfd = openSync(out, 'w');
        writeSync(wfd, buf);
        closeSync(wfd);
        resourceFiles.push({ name, bytes: buf.length });
      }
      if (resources.names.length === 0 && n > 0) {
        warnings.push('resources container has no name table, files were named resource-####.bin');
      }
    }

    const ms = performance.now() - t0;
    log(`  decoded ${blocks} blocks in ${chunks.length} chunks with ${pool.workerCount} worker(s) using ${writer.files.length} output file(s)`);
    return {
      input: path,
      header,
      xmlFiles,
      resourceFiles,
      inBytes,
      sourceBytes,
      textBytes: splitter.stats.bytes,
      outBytes: writer.bytes,
      lines: splitter.stats.lines,
      blocks,
      chunks: chunks.length,
      ms,
      decoder: pool.inline ? 'inline' : 'worker',
      workers: pool.workerCount,
      warnings,
    };
  } finally {
    if (pool && ownsPool) await pool.destroy();
    closeSync(fd);
  }
}
