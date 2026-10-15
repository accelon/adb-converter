/**
 * Decode a run of consecutive source blocks into one buffer.
 * Shared by the worker threads and by the single threaded fallback.
 */
import type { BlockDecoder } from './bz2';

/** Text model: how the decoded blocks are laid out and cleaned up. */
export type TextModel = 'delphi' | 'adbjs';

export interface ChunkJob {
  /** compressed bytes of every block of this chunk, concatenated */
  src: Uint8Array;
  /** cumulative END offsets of each block inside `src` */
  ends: number[];
  /** expected decompressed size of a single block (header srcblocksize) */
  hint: number;
  /** global index of the first block of this chunk */
  firstBlock: number;
  /** total number of source blocks of the file */
  blockCount: number;
  /** see TextModel */
  model: TextModel;
}

export interface ChunkResult {
  out: Uint8Array;
  blocks: number;
}

/**
 * adbjs emulation: its JS decoder decodes every source block on its own, so
 *   - a leading U+FEFF of a block is swallowed by TextDecoder, and
 *   - a UTF-16 surrogate pair straddling a block boundary becomes two U+FFFD.
 * The substitution is 2 bytes for 2 bytes, the BOM drop removes 2 bytes; both
 * change the stream the line offsets are applied to, so they are only used in
 * the `adbjs` model. Accelon3 itself concatenates code units unchanged.
 */
export function patchBlockEdges(buf: Uint8Array, start: number, end: number, hasPrev: boolean, hasNext: boolean): void {
  if (end - start < 2) return;
  if (hasPrev) {
    const u = buf[start] | (buf[start + 1] << 8);
    if (u >= 0xdc00 && u < 0xe000) {
      buf[start] = 0xfd;
      buf[start + 1] = 0xff;
    }
  }
  if (hasNext) {
    const i = end - 2;
    const u = buf[i] | (buf[i + 1] << 8);
    if (u >= 0xd800 && u < 0xdc00) {
      buf[i] = 0xfd;
      buf[i + 1] = 0xff;
    }
  }
}

/**
 * Every block is an independent bzip2 stream, so they are decoded one by one.
 *
 * Layout (`delphi`): block i is placed at byte offset `i*srcblocksize` of the
 * physical address space, exactly like srcpack.getrange_physical which indexes
 * blocks with `addr div srcblocksize`. A block shorter than srcblocksize leaves
 * zero padding, which the line splitter removes again per block, reproducing
 * the `widestring(p)` (NUL terminated) semantics.
 *
 * Layout (`adbjs`): blocks are concatenated tightly, which is what the JS port
 * does and only differs when a non final block is short.
 */
export function decodeChunk(dec: BlockDecoder, job: ChunkJob, scratchRef: { buf: Uint8Array }): ChunkResult {
  const count = job.ends.length;
  const stride = Math.max(job.hint | 0, 1);
  const min = Math.max(stride, 1 << 16);
  const grid = job.model === 'delphi';
  let out = new Uint8Array(grid ? count * stride : Math.max(count * stride, min));
  let pos = 0;
  let prev = 0;
  for (let i = 0; i < count; i++) {
    const end = job.ends[i];
    const src = job.src.subarray(prev, end);
    prev = end;
    if (scratchRef.buf.length < min) scratchRef.buf = new Uint8Array(min);
    let got = dec.decode(src, scratchRef.buf);
    while (got === -1) {
      scratchRef.buf = new Uint8Array(scratchRef.buf.length * 2);
      got = dec.decode(src, scratchRef.buf);
    }
    let start = 0;
    if (job.model === 'adbjs') {
      if (got >= 2 && scratchRef.buf[0] === 0xff && scratchRef.buf[1] === 0xfe) start = 2;
      const idx = job.firstBlock + i;
      patchBlockEdges(scratchRef.buf, start, got, idx > 0, idx < job.blockCount - 1);
    }
    const piece = scratchRef.buf.subarray(start, got);
    if (grid) {
      if (piece.length > stride) {
        throw new Error(
          `source block ${job.firstBlock + i} decompressed to ${piece.length} bytes, more than srcblocksize ` +
            `${stride}; the physical address grid would be wrong (use --text adbjs for this database)`,
        );
      }
      out.set(piece, i * stride);
    } else {
      if (pos + piece.length > out.length) {
        const bigger = new Uint8Array(Math.max(out.length * 2, pos + piece.length));
        bigger.set(out.subarray(0, pos));
        out = bigger;
      }
      out.set(piece, pos);
      pos += piece.length;
    }
  }
  const len = grid ? count * stride : pos;
  return { out: len === out.length ? out : out.slice(0, len), blocks: count };
}
