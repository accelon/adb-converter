/**
 * `authorAdb` — build a database from plain lines, then read it back with the
 * same container parser the exporter uses.
 *
 * The point is not the layout (FORMAT.md already pins that) but the pieces the
 * authoring path must get right on its own: the header (no donor database), the
 * tag/hit tables, the `t=` driven caches (tree labels) and the attribute table
 * the 目錄 tree reads its tiers from.
 */
import { describe, expect, test } from 'bun:test';
import { closeSync, mkdtempSync, openSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorAdb } from '../src/adbauthor';
import { readZip } from '../src/zipread';
import {
  FILE_HEADER_SIZE,
  blockOffsetByName,
  blockRange,
  decodePackedList,
  parseBlockSet,
  parseHeader,
  readAt,
} from '../src/format';

const LINES = [
  '<集 t="集">測試集</集>',
  '<隱><樹 s="*" t="篇">目錄</樹></隱>',
  '<篇 t="章">第一篇</篇>',
  '<章>第一章</章>',
  '甲乙<聯 n="甲">甲</聯>丙',
  '<篇 t="字">字詞</篇>',
  '<字>甲</字>',
  '甲字說明',
];

/** decode the string table of a caches/<tag> block (UTF-16LE + NUL each) */
function innerStrings(fd: number, at: number): string[] {
  const c = parseBlockSet(fd, at)!;
  const out: string[] = [];
  for (let i = 0; i < c.count; i++) {
    const r = blockRange(c, i);
    const bytes = readAt(fd, r.start, r.end - r.start);
    let end = bytes.length - (bytes.length % 2);
    for (let k = 0; k + 1 < bytes.length; k += 2) {
      if (bytes[k] === 0 && bytes[k + 1] === 0) { end = k; break; }
    }
    out.push(bytes.subarray(0, end).toString('utf16le'));
  }
  return out;
}

describe('authorAdb', () => {
  const built = (async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adbauthor-'));
    const file = join(dir, 't.adb');
    const result = await authorAdb({
      dbname: 'test',
      dbcname: '測試資料庫',
      lines: LINES,
      resources: [{ name: 'a.png', bytes: Buffer.from([1, 2, 3]) }],
    });
    writeFileSync(file, result.file);
    return { file, result };
  })();

  test('header is written from scratch', async () => {
    const { file } = await built;
    const fd = openSync(file, 'r');
    const h = parseHeader(readAt(fd, 0, FILE_HEADER_SIZE))!;
    closeSync(fd);
    expect(h).not.toBeNull();
    expect(h.dbname).toBe('test');
    expect(h.dbcname).toBe('測試資料庫');
    expect(h.version).toBe(0);
    expect(h.compression).toBe(1);
    expect(h.srcBlockSize).toBe(16384);
    expect(h.lineCount).toBe(LINES.length);
    expect(h.maxBlockOffset).toBeGreaterThan(0);
    expect(h.tagCount).toBeGreaterThan(0);
    expect(h.dbType).toBe(0);
  });

  test('tag hits match the text', async () => {
    const { file, result } = await built;
    const fd = openSync(file, 'r');
    const outer = parseBlockSet(fd, FILE_HEADER_SIZE)!;
    const tags = parseBlockSet(fd, blockOffsetByName(outer, 'tags')!)!;
    const hits = (name: string): number[] => {
      const at = tags.names.indexOf(name);
      return at < 0 ? [] : decodePackedList(readAt(fd, blockRange(tags, at).start, blockRange(tags, at).end - blockRange(tags, at).start));
    };
    // two <篇>, each an open + a close hit
    expect(hits('篇').length).toBe(2);
    expect(hits('/篇').length).toBe(2);
    expect(hits('章').length).toBe(1);
    expect(hits('字').length).toBe(1);
    // 聯 is a skip tag: it is indexed but costs no virtual address
    expect(hits('聯').length).toBe(1);
    expect(result.tokenHits).toBeGreaterThan(5);
    closeSync(fd);
  });

  test('t= declarations produce the cache lines the tree labels use', async () => {
    const { file } = await built;
    const fd = openSync(file, 'r');
    const outer = parseBlockSet(fd, FILE_HEADER_SIZE)!;
    const caches = parseBlockSet(fd, blockOffsetByName(outer, 'caches')!)!;
    expect(caches.names).toEqual(['集', '篇', '章', '字']);
    const block = (tag: string) => {
      const at = caches.names.indexOf(tag);
      const r = blockRange(caches, at);
      return innerStrings(fd, r.start);
    };
    expect(block('集')).toEqual(['測試集']);
    expect(block('篇')).toEqual(['第一篇', '字詞']);
    expect(block('章')).toEqual(['第一章']);
    expect(block('字')).toEqual(['甲']);
    closeSync(fd);
  });

  test('attributes keep the per-instance t= the tree is built from', async () => {
    const { file } = await built;
    const fd = openSync(file, 'r');
    const outer = parseBlockSet(fd, FILE_HEADER_SIZE)!;
    const attrs = parseBlockSet(fd, blockOffsetByName(outer, 'attributes')!)!;
    expect(attrs.names).toContain('篇.t');
    expect(attrs.names).toContain('樹.t');
    const at = attrs.names.indexOf('篇.t');
    const r = blockRange(attrs, at);
    expect(innerStrings(fd, r.start)).toEqual(['章', '字']);
    closeSync(fd);
  });

  test('resources are stored verbatim and sorted', async () => {
    const { file, result } = await built;
    const fd = openSync(file, 'r');
    const outer = parseBlockSet(fd, FILE_HEADER_SIZE)!;
    const res = parseBlockSet(fd, blockOffsetByName(outer, 'resources')!)!;
    expect(res.names).toEqual(['a.png']);
    expect([...readAt(fd, blockRange(res, 0).start, 3)]).toEqual([1, 2, 3]);
    expect(result.resources).toBe(1);
    closeSync(fd);
  });

  test('cachedTags seeds the cache set from the first instance (old docdef)', async () => {
    // 舊庫的 docdef 宣告在 adb 之外：重建時把舊 caches 的鍵傳進來，這些標記
    // 從第一個實例就要有 cache（不必等文字裡的 t= 宣告）。
    const result = await authorAdb({
      dbname: 'seed', dbcname: '種子', lines: ['<節>甲</節>', '<節>乙</節>'],
      cachedTags: ['節'],
    });
    const dir = mkdtempSync(join(tmpdir(), 'adbauthor-seed-'));
    const file = join(dir, 's.adb');
    writeFileSync(file, result.file);
    const fd = openSync(file, 'r');
    const outer = parseBlockSet(fd, FILE_HEADER_SIZE)!;
    const caches = parseBlockSet(fd, blockOffsetByName(outer, 'caches')!)!;
    expect(caches.names).toEqual(['節']);
    const r = blockRange(caches, 0);
    expect(innerStrings(fd, r.start)).toEqual(['甲', '乙']);
    closeSync(fd);
  });

  test('dualSelfClosingTags also indexes /x for a self-closing <x/>', async () => {
    const result = await authorAdb({
      dbname: 'dual', dbcname: '雙收尾', lines: ['<平裝 id="1"/>', '正文'],
      dualSelfClosingTags: ['平裝'],
    });
    const dir = mkdtempSync(join(tmpdir(), 'adbauthor-dual-'));
    const file = join(dir, 'd.adb');
    writeFileSync(file, result.file);
    const fd = openSync(file, 'r');
    const outer = parseBlockSet(fd, FILE_HEADER_SIZE)!;
    const tags = parseBlockSet(fd, blockOffsetByName(outer, 'tags')!)!;
    expect(tags.names).toContain('平裝');
    expect(tags.names).toContain('/平裝');
    closeSync(fd);
  });

  test('validTags rejects prose <書名> so the tag table does not explode', async () => {
    const result = await authorAdb({
      dbname: 'valid', dbcname: '白名單', lines: ['唐玄奘在 <大唐西域記> 中說'],
      validTags: ['書'],
    });
    const dir = mkdtempSync(join(tmpdir(), 'adbauthor-valid-'));
    const file = join(dir, 'v.adb');
    writeFileSync(file, result.file);
    const fd = openSync(file, 'r');
    const outer = parseBlockSet(fd, FILE_HEADER_SIZE)!;
    const tags = parseBlockSet(fd, blockOffsetByName(outer, 'tags')!)!;
    expect(tags.names).not.toContain('大唐西域記');
    expect(tags.names).toEqual([]);
    closeSync(fd);
  });

  test('a line containing CR/LF is refused', async () => {
    await expect(
      authorAdb({ dbname: 'x', dbcname: 'x', lines: ['ok', 'bad\nline'] }),
    ).rejects.toThrow(/CR\/LF/);
  });
});

/** a stored-only (method 0) zip, enough to exercise the reader */
function makeStoredZip(entries: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const cds: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);            // version needed
    local.writeUInt16LE(0x800, 6);         // UTF-8 name flag
    local.writeUInt16LE(0, 8);             // method: stored
    local.writeUInt32LE(e.data.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, e.data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x800, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt32LE(e.data.length, 20);
    cd.writeUInt32LE(e.data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    cds.push(cd, name);
    offset += 30 + name.length + e.data.length;
  }
  const cdBuf = Buffer.concat(cds);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, eocd]);
}

describe('readZip', () => {
  test('reads UTF-8 names and stored bytes', () => {
    const zip = makeStoredZip([
      { name: '書/第一章.md', data: Buffer.from('子曰', 'utf8') },
      { name: 'a.png', data: Buffer.from([0x89, 0x50]) },
    ]);
    const entries = readZip(zip);
    expect(entries.map((e) => e.name)).toEqual(['書/第一章.md', 'a.png']);
    expect(entries[0].bytes.toString('utf8')).toBe('子曰');
    expect([...entries[1].bytes]).toEqual([0x89, 0x50]);
  });

  test('rejects junk', () => {
    expect(() => readZip(Buffer.alloc(64))).toThrow(/not a zip/);
  });
});
