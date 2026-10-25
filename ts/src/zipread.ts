/**
 * Minimal ZIP reader for Node/Bun (no dependencies): central directory + inflate.
 *
 * The directory parsing lives in `zip-dir.ts` (shared with the browser, which
 * inflates with `DecompressionStream`). Here we only add `node:zlib`.
 */
import { inflateRawSync } from 'node:zlib';
import { scanZip } from './zip-dir';

export interface ZipEntry {
  /** path inside the archive, '/' separated, no leading slash */
  name: string;
  isDir: boolean;
  bytes: Buffer;
}

export function readZip(buf: Buffer): ZipEntry[] {
  const out: ZipEntry[] = [];
  for (const e of scanZip(buf)) {
    if (e.isDir) {
      out.push({ name: e.name, isDir: true, bytes: Buffer.alloc(0) });
      continue;
    }
    const data = buf.subarray(e.dataStart, e.dataStart + e.compSize);
    let bytes: Buffer;
    if (e.method === 0) bytes = Buffer.from(data);
    else if (e.method === 8) bytes = inflateRawSync(data);
    else throw new Error(`zip: unsupported compression method ${e.method} for ${e.name}`);
    if (e.rawSize && bytes.length !== e.rawSize) {
      throw new Error(`zip: ${e.name} inflated to ${bytes.length} bytes, expected ${e.rawSize}`);
    }
    out.push({ name: e.name, isDir: false, bytes });
  }
  return out;
}
