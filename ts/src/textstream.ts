/**
 * Turning the decoded text stream into XML files.
 *
 * Two independent concerns:
 *
 *  LineSplitter  the `lines.physical` packed list holds END offsets (in bytes)
 *                of every line inside the concatenated UTF-16LE text. Lines do
 *                NOT respect compressed block boundaries (verified on 13j.adb:
 *                only 13 of 42173 lines end on a block boundary), so the split
 *                has to run over the reassembled stream.
 *
 *  XmlWriter     the reference exporter splits the XML text on every `<檔`
 *                (file) tag and writes one file per tag plus a `.lst` index.
 *                We reproduce that, but streaming: text is only buffered in
 *                ~1 M char windows, and a tag may straddle a window boundary.
 */
import { closeSync, existsSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';

const TAG = '<檔';
const TAG_LOOKAHEAD = 200; // chars, same window the reference uses for n="..."
const FLUSH_CHARS = 1 << 20;

export interface TextSink {
  pushText(s: string): void;
}

export interface LineStats {
  lines: number;
  /** total decoded UTF-16LE bytes fed in */
  bytes: number;
  /** bytes of decoded text that no line offset refers to (data loss indicator) */
  tailBytes: number;
  /** text was shorter than the last line offset (truncated input) */
  shortfall: number;
  maxLineBytes: number;
}

/** Split the reassembled UTF-16LE text into lines and hand them to a sink. */
export interface LineSplitterOptions {
  /**
   * Drop U+0000 code units. With the delphi text model the physical grid has
   * zero padding after a short block, and srcpack takes every block as a NUL
   * terminated widestring, so the padding is not text.
   */
  stripNul?: boolean;
  /**
   * srcpack.getrange_physical skips a CR and then a LF at the very start of a
   * line (`if p^=#13 then inc(p); if p^=#10 then inc(p)`).
   */
  skipCrLf?: boolean;
  /** TextDecoder strips a leading BOM of every decode() call unless told not to */
  keepBom?: boolean;
}

export class LineSplitter {
  readonly stats: LineStats = { lines: 0, bytes: 0, tailBytes: 0, shortfall: 0, maxLineBytes: 0 };
  private decoder: TextDecoder;
  private carry: Buffer = Buffer.alloc(0);
  private k = 0;
  /** global UTF-16 byte offset of carry[0] */
  private pos = 0;
  private batch: string[] = [];
  private batchChars = 0;
  private needSep = false;
  private readonly stripNul: boolean;
  private readonly skipCrLf: boolean;

  constructor(
    private readonly lineEnds: number[],
    private readonly sink: TextSink,
    private readonly batchLimit = 1 << 20,
    opts: LineSplitterOptions = {},
  ) {
    this.stripNul = !!opts.stripNul;
    this.skipCrLf = !!opts.skipCrLf;
    this.decoder = new TextDecoder('utf-16le', { ignoreBOM: !!opts.keepBom });
  }

  push(chunk: Buffer): void {
    // A boundary can fall anywhere, so carry the incomplete tail over.
    if (this.carry.length > 0) {
      chunk = Buffer.concat([this.carry, chunk]);
      this.carry = Buffer.alloc(0);
    }
    if (this.lineEnds.length === 0) {
      this.stats.tailBytes += chunk.length; // no line table: reference drops it too
      return;
    }
    let cursor = 0;
    while (this.k < this.lineEnds.length) {
      const end = this.lineEnds[this.k] - this.pos;
      if (end > chunk.length) break;
      if (end < cursor) {
        // overlapping/decreasing offsets: emit an empty line, stay in sync
        this.emit('');
        this.k++;
        continue;
      }
      const size = end - cursor;
      if (size > this.stats.maxLineBytes) this.stats.maxLineBytes = size;
      if (size === 0) this.emit('');
      else this.emit(this.decodeLine(chunk, cursor, end));
      cursor = end;
      this.k++;
    }
    if (cursor > 0) {
      this.pos += cursor;
      // copy the (small) remainder so we do not pin the big chunk buffer
      this.carry = Buffer.from(chunk.subarray(cursor));
    } else if (chunk.length > 0) {
      this.carry = Buffer.from(chunk);
    }
  }

  /** Apply the per block NUL rule and the leading CR/LF skip, then decode. */
  private decodeLine(buf: Buffer, from: number, to: number): string {
    let line = buf.subarray(from, to);
    if (this.stripNul) line = stripNulCodeUnits(line);
    if (this.skipCrLf) {
      if (line.length >= 2 && line[0] === 0x0d && line[1] === 0x00) line = line.subarray(2);
      if (line.length >= 2 && line[0] === 0x0a && line[1] === 0x00) line = line.subarray(2);
    }
    return this.decoder.decode(line);
  }

  private emit(line: string): void {
    this.batch.push(line);
    this.batchChars += line.length + 1;
    this.stats.lines++;
    if (this.batchChars >= this.batchLimit) this.flushBatch();
  }

  private flushBatch(): void {
    if (this.batch.length === 0) return;
    const text = (this.needSep ? '\n' : '') + this.batch.join('\n');
    this.needSep = true;
    this.batch = [];
    this.batchChars = 0;
    this.sink.pushText(text);
  }

  finish(): void {
    this.stats.bytes = this.pos + this.carry.length;
    if (this.k < this.lineEnds.length) {
      this.stats.shortfall = this.lineEnds[this.lineEnds.length - 1] - this.stats.bytes;
      // The reference slices a JS string, so a line range that runs past the end
      // of the text is clamped instead of being dropped: the remaining bytes
      // complete the current line and every further line is empty.
      this.emit(this.carry.length > 0 ? this.decoder.decode(this.carry) : '');
      this.k++;
      this.carry = Buffer.alloc(0);
      while (this.k < this.lineEnds.length) {
        this.emit('');
        this.k++;
      }
    } else if (this.carry.length > 0) {
      // text past the last line offset: the reference drops it as well
      this.stats.tailBytes += this.carry.length;
    }
    this.carry = Buffer.alloc(0);
    this.flushBatch();
  }
}

const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]/g;

/**
 * Remove U+0000 code units from a UTF-16LE byte range.
 *
 * A NUL *byte* is not a NUL *code unit*: every ASCII character has a 0x00 high
 * byte (`<` is 3C 00), so only an aligned 00 00 pair is a terminator/padding.
 * Returns the input unchanged (no copy) when there is nothing to strip.
 */
export function stripNulCodeUnits(buf: Buffer): Buffer {
  let first = -1;
  for (let i = 0; i + 1 < buf.length; i += 2) {
    if (buf[i] === 0 && buf[i + 1] === 0) {
      first = i;
      break;
    }
  }
  if (first < 0) return buf;
  const out = Buffer.allocUnsafe(buf.length - 2);
  let n = buf.copy(out, 0, 0, first);
  for (let i = first + 2; i + 1 < buf.length; i += 2) {
    if (buf[i] === 0 && buf[i + 1] === 0) continue;
    out[n++] = buf[i];
    out[n++] = buf[i + 1];
  }
  return out.subarray(0, n);
}
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function sanitizeName(name: string): string {
  let s = name.replace(ILLEGAL, '_').replace(/[. ]+$/, '');
  if (!s) s = 'unnamed';
  const dot = s.lastIndexOf('.');
  const stem = dot > 0 ? s.slice(0, dot) : s;
  if (RESERVED.test(stem)) s = '_' + s;
  if (s.length > 120) {
    const ext = dot > 0 ? s.slice(dot) : '';
    s = s.slice(0, 120 - ext.length) + ext;
  }
  return s;
}

export interface XmlWriterOptions {
  outDir: string;
  dbname: string;
  /** write the single XML stream to stdout instead of a file */
  stdout?: boolean;
  /** refuse to replace existing files */
  noOverwrite?: boolean;
  /** measure only: encode everything but write nothing */
  discard?: boolean;
}

export interface OutputFile {
  name: string;
  bytes: number;
}

/** Streams the joined XML text into one file per `<檔>` tag (usually just one). */
export class XmlWriter implements TextSink {
  readonly files: OutputFile[] = [];
  bytes = 0;
  private chunks: string[] = [];
  private pendingChars = 0;
  private fd = -1;
  private currentName = '';
  private used = new Map<string, number>();
  private tagCount = 0;
  private finished = false;
  private currentBytes = 0;

  constructor(private readonly opts: XmlWriterOptions) {
    this.currentName = sanitizeName(opts.dbname + '.xml');
  }

  pushText(s: string): void {
    this.chunks.push(s);
    this.pendingChars += s.length;
    if (this.pendingChars >= FLUSH_CHARS) this.flush(false);
  }

  /** @param final when true, a truncated tag window is accepted as is */
  private flush(final: boolean): void {
    if (this.pendingChars === 0) return;
    const text = this.chunks.length === 1 ? this.chunks[0] : this.chunks.join('');
    this.chunks = [];
    this.pendingChars = 0;
    /** start of the text that still belongs to the current file */
    let contentStart = 0;
    /** where the next tag search resumes (always right after a `<檔`) */
    let searchFrom = 0;
    for (;;) {
      const at = text.indexOf(TAG, searchFrom);
      if (at < 0) {
        const unwritten = text.length - contentStart;
        const keep = final ? 0 : Math.min(TAG.length - 1, unwritten);
        this.write(text.slice(contentStart, text.length - keep));
        if (keep > 0) this.deferFrom(text, text.length - keep);
        return;
      }
      const win = text.slice(at, at + TAG_LOOKAHEAD);
      if (!final && !win.includes('">') && text.length - at < TAG_LOOKAHEAD) {
        // not enough text yet to name the new file: keep it buffered
        this.write(text.slice(contentStart, at));
        this.deferFrom(text, at);
        return;
      }
      this.write(text.slice(contentStart, at));
      const name = this.extractName(win, this.tagCount);
      this.tagCount++;
      this.rotate(name);
      contentStart = at;
      searchFrom = at + TAG.length;
    }
  }

  private deferFrom(text: string, at: number): void {
    this.chunks.push(text.slice(at));
    this.pendingChars = text.length - at;
  }

  private extractName(win: string, tagIndex: number): string {
    let tagline = win;
    const close = tagline.indexOf('">');
    if (close >= 0) tagline = tagline.slice(0, close + 2);
    const m = tagline.match(/n="(.+?)"/);
    return m ? m[1] : `${this.opts.dbname}.${tagIndex}.xml`;
  }

  private unique(name: string): string {
    const base = sanitizeName(name);
    const n = this.used.get(base) ?? 0;
    this.used.set(base, n + 1);
    if (n === 0) return base;
    const dot = base.lastIndexOf('.');
    return dot > 0 ? `${base.slice(0, dot)}~${n}${base.slice(dot)}` : `${base}~${n}`;
  }

  private rotate(name: string): void {
    this.closeCurrent();
    this.currentName = this.unique(name);
  }

  private open(): number {
    if (this.fd >= 0) return this.fd;
    if (this.opts.stdout) {
      this.fd = 1;
      return this.fd;
    }
    const path = join(this.opts.outDir, this.currentName);
    if (this.opts.noOverwrite && existsSync(path)) {
      throw new Error(`refusing to overwrite ${path} (--no-overwrite)`);
    }
    this.fd = openSync(path, 'w');
    this.currentBytes = 0;
    return this.fd;
  }

  private write(text: string): void {
    if (text.length === 0) return;
    const buf = Buffer.from(text, 'utf8');
    if (this.opts.discard) {
      this.bytes += buf.length;
      this.currentBytes += buf.length;
      return;
    }
    const fd = this.open();
    writeSync(fd, buf);
    this.bytes += buf.length;
    this.currentBytes += buf.length;
  }

  private closeCurrent(): void {
    if (this.fd >= 0) {
      if (this.fd !== 1) closeSync(this.fd);
      this.files.push({ name: this.currentName, bytes: this.currentBytes });
      this.fd = -1;
      this.currentBytes = 0;
    }
  }

  /** Flush everything and, when the db produced several files, write the .lst index. */
  finish(): OutputFile[] {
    if (this.finished) return this.files;
    this.finished = true;
    this.flush(true);
    this.closeCurrent();
    if (this.files.length === 0) this.files.push({ name: this.currentName, bytes: 0 });
    if (this.files.length > 1 && !this.opts.stdout && !this.opts.discard) {
      const lst = this.files.map((f) => f.name).join('\n');
      const name = sanitizeName(this.opts.dbname + '.lst');
      const fd = openSync(join(this.opts.outDir, name), 'w');
      writeSync(fd, Buffer.from(lst, 'utf8'));
      closeSync(fd);
      this.files.push({ name, bytes: Buffer.byteLength(lst) });
    }
    return this.files;
  }
}
