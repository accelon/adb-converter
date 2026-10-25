/**
 * ZIP central directory parser, runtime neutral.
 *
 * Only what a vault export needs: entry names, method, payload location. The
 * inflate step is left to the caller — Node uses `node:zlib`, the browser uses
 * `DecompressionStream('deflate-raw')` — so the tricky part (end-of-central-
 * directory scanning, the UTF-8 name flag, GBK names from Chinese Windows) is
 * written once.
 */

export interface ZipEntryMeta {
  /** path inside the archive, '/' separated, no leading slash */
  name: string;
  isDir: boolean;
  /** 0 = stored, 8 = deflate */
  method: number;
  /** byte offset of the entry's payload inside the archive */
  dataStart: number;
  compSize: number;
  rawSize: number;
}

const EOCD = 0x06054b50;
const CEN = 0x02014b50;
const LOC = 0x04034b50;

/** Decode an entry name: UTF-8 when the flag says so, else GBK, else cp437. */
export function decodeZipName(raw: Uint8Array, utf8: boolean): string {
  const dec = (label: string): string | null => {
    try {
      return new TextDecoder(label).decode(raw);
    } catch {
      return null;
    }
  };
  if (utf8) return dec('utf-8') ?? asciiOf(raw);
  return dec('gbk') ?? dec('cp437') ?? asciiOf(raw);
}

function asciiOf(raw: Uint8Array): string {
  let s = '';
  for (let i = 0; i < raw.length; i++) s += String.fromCharCode(raw[i]);
  return s;
}

/** Parse the central directory. Throws when the buffer is not a zip. */
export function scanZip(buf: Uint8Array): ZipEntryMeta[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const u32 = (i: number): number => dv.getUint32(i, true);
  const u16 = (i: number): number => dv.getUint16(i, true);

  // end of central directory: scan backwards over the (max 64 KiB) comment
  let eocd = -1;
  const min = Math.max(0, buf.length - 0x10000 - 22);
  for (let i = buf.length - 22; i >= min; i--) {
    if (u32(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip: no end of central directory');
  const count = u16(eocd + 10);
  const cdSize = u32(eocd + 12);
  const cdOffset = u32(eocd + 16);
  if (cdOffset + cdSize > buf.length) throw new Error('zip: central directory out of range');

  const out: ZipEntryMeta[] = [];
  let at = cdOffset;
  for (let i = 0; i < count; i++) {
    if (u32(at) !== CEN) throw new Error(`zip: bad central directory entry #${i}`);
    const flags = u16(at + 8);
    const method = u16(at + 10);
    const compSize = u32(at + 20);
    const rawSize = u32(at + 24);
    const nameLen = u16(at + 28);
    const extraLen = u16(at + 30);
    const commentLen = u16(at + 32);
    const localAt = u32(at + 42);
    const name = decodeZipName(buf.subarray(at + 46, at + 46 + nameLen), (flags & 0x800) !== 0);
    at += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) {
      out.push({ name: name.slice(0, -1), isDir: true, method, dataStart: 0, compSize: 0, rawSize: 0 });
      continue;
    }
    if (u32(localAt) !== LOC) throw new Error(`zip: bad local header for ${name}`);
    const lNameLen = u16(localAt + 26);
    const lExtraLen = u16(localAt + 28);
    out.push({
      name,
      isDir: false,
      method,
      dataStart: localAt + 30 + lNameLen + lExtraLen,
      compSize,
      rawSize,
    });
  }
  return out;
}
