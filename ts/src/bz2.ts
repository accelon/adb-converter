/**
 * Pluggable bzip2 block decoders.
 *
 * Every source block of an .adb file is an independent bzip2 stream, so a
 * decoder only has to expose "one stream -> one buffer". Three backends:
 *
 *   ffi  native libbz2 through bun:ffi (fastest)
 *   js   vendored pure JS decoder (no dependency at all, ~3x slower)
 */
import { existsSync } from 'node:fs';
import { dlopen, type Library } from 'bun:ffi';
// @ts-expect-error vendored plain JS module
import { bzip2 } from './vendor/bzip2.js';

/** libbz2: destination buffer too small. */
export const BZ_OUTBUFF_FULL = -8;

export type DecoderKind = 'auto' | 'ffi' | 'js';

export interface BlockDecoder {
  readonly name: string;
  /**
   * Decompress one bzip2 stream into `dest`.
   * @returns number of bytes written, or -1 when `dest` is too small.
   */
  decode(src: Uint8Array, dest: Uint8Array): number;
  close(): void;
}

export function libbz2Candidates(): string[] {
  const out: string[] = [];
  if (process.env.ABX_LIBBZ2) out.push(process.env.ABX_LIBBZ2);
  if (process.platform === 'win32') {
    out.push(
      'C:\\Program Files\\Git\\mingw64\\bin\\libbz2-1.dll',
      'C:\\Program Files\\Git\\mingw64\\libexec\\git-core\\libbz2-1.dll',
      'libbz2-1.dll',
      'libbz2.dll',
      'bz2.dll',
    );
  } else if (process.platform === 'darwin') {
    out.push('/opt/homebrew/lib/libbz2.dylib', '/usr/local/lib/libbz2.dylib', 'libbz2.dylib');
  } else {
    out.push(
      '/usr/lib/x86_64-linux-gnu/libbz2.so.1.0',
      '/usr/lib/libbz2.so.1',
      'libbz2.so.1.0',
      'libbz2.so.1',
    );
  }
  return out;
}

class FfiDecoder implements BlockDecoder {
  readonly name = 'libbz2 (bun:ffi)';
  private lib: Library;
  private fn: (dest: Uint8Array, destLen: Uint32Array, src: Uint8Array, srcLen: number, small: number, verbosity: number) => number;
  private destLen = new Uint32Array(1);

  constructor(path: string) {
    this.lib = dlopen(path, {
      BZ2_bzBuffToBuffDecompress: {
        args: ['ptr', 'ptr', 'ptr', 'uint32_t', 'int32_t', 'int32_t'],
        returns: 'int32_t',
      },
    });
    this.fn = this.lib.symbols.BZ2_bzBuffToBuffDecompress as never;
  }

  decode(src: Uint8Array, dest: Uint8Array): number {
    this.destLen[0] = dest.length;
    const rc = this.fn(dest, this.destLen, src, src.length, 0, 0);
    if (rc === 0) return this.destLen[0];
    if (rc === BZ_OUTBUFF_FULL) return -1;
    throw new Error(`libbz2 BZ2_bzBuffToBuffDecompress failed (rc=${rc})`);
  }

  close(): void {
    this.lib.close();
  }
}

class JsDecoder implements BlockDecoder {
  readonly name = 'pure JS (vendor/bzip2.js)';
  decode(src: Uint8Array, dest: Uint8Array): number {
    let pos = 0;
    let overflow = false;
    bzip2.simple(src, (byte: number) => {
      if (pos < dest.length) dest[pos++] = byte;
      else overflow = true;
    });
    return overflow ? -1 : pos;
  }
  close(): void {}
}

export interface DecoderChoice {
  decoder: BlockDecoder;
  /** non fatal notes, e.g. why the fallback was used */
  notes: string[];
}

/**
 * bzip2 encoder through the same libbz2 the Delphi program used
 * (srcpack.pas: TBZCompressionStream.Create(bs9, output) = blockSize100k 9,
 * verbosity 0, default work factor), so a rebuilt source block is byte
 * identical to the original one.
 */
export class Bz2Encoder {
  readonly name: string;
  private lib: Library;
  private fn: (
    dest: Uint8Array,
    destLen: Uint32Array,
    src: Uint8Array,
    srcLen: number,
    blockSize100k: number,
    verbosity: number,
    workFactor: number,
  ) => number;
  private destLen = new Uint32Array(1);

  constructor(path: string) {
    this.lib = dlopen(path, {
      BZ2_bzBuffToBuffCompress: {
        args: ['ptr', 'ptr', 'ptr', 'uint32_t', 'int32_t', 'int32_t', 'int32_t'],
        returns: 'int32_t',
      },
    });
    this.fn = this.lib.symbols.BZ2_bzBuffToBuffCompress as never;
    this.name = `libbz2 encoder (${path.replace(/^.*[\\/]/, '')})`;
  }

  /** Compress one block; the result is a complete bzip2 stream. */
  encode(src: Uint8Array, blockSize100k = 9, verbosity = 0, workFactor = 0): Uint8Array {
    // libbz2 wants room for the stream plus a small margin
    const cap = src.length + Math.ceil(src.length / 100) + 600;
    const dest = new Uint8Array(cap);
    this.destLen[0] = dest.length;
    const rc = this.fn(dest, this.destLen, src, src.length, blockSize100k, verbosity, workFactor);
    if (rc !== 0) throw new Error(`libbz2 BZ2_bzBuffToBuffCompress failed (rc=${rc})`);
    return dest.subarray(0, this.destLen[0]);
  }

  close(): void {
    this.lib.close();
  }
}

/** Create a bzip2 encoder, or null when no libbz2 is available. */
export function createEncoder(): { encoder: Bz2Encoder | null; notes: string[] } {
  const notes: string[] = [];
  for (const path of libbz2Candidates()) {
    const local = path.includes('\\') || path.includes('/');
    if (local && !existsSync(path)) continue;
    try {
      return { encoder: new Bz2Encoder(path), notes };
    } catch (e) {
      notes.push(`libbz2 candidate ${path} unusable for compression: ${(e as Error).message}`);
    }
  }
  notes.push('no libbz2 found: writing an adb needs it (compression cannot fall back to JS)');
  return { encoder: null, notes };
}

export function createDecoder(kind: DecoderKind = 'auto'): DecoderChoice {
  const notes: string[] = [];
  if (kind !== 'js') {
    for (const path of libbz2Candidates()) {
      const local = path.includes('\\') || path.includes('/');
      if (local && !existsSync(path)) continue;
      try {
        return { decoder: new FfiDecoder(path), notes };
      } catch (e) {
        notes.push(`libbz2 candidate ${path} unusable: ${(e as Error).message}`);
      }
    }
    if (kind === 'ffi') {
      throw new Error(
        'no usable libbz2 found. Set ABX_LIBBZ2=/path/to/libbz2, or use --decoder js (slower).\n' +
          notes.join('\n'),
      );
    }
    notes.push('no libbz2 found, falling back to the pure JS decoder (slower)');
  }
  return { decoder: new JsDecoder(), notes };
}
