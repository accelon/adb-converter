/** `authorAdb({ dropNumeric: true })`：純數字 token 仍佔 VA，但不進 tokens。 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorAdb } from '../src/adbauthor';
import { AdbReader, SyncIO } from '../src/accelon26/adb';

describe('dropNumeric', () => {
  test('目錄編號不進索引，文字 token 仍在', async () => {
    const lines = ['dhamma 1.1.1 0206 vinaya'];
    const res = await authorAdb({
      dbname: 'dn',
      dbcname: '數字測試',
      lines,
      fullTextIndex: true,
      dropNumeric: true,
      log: () => {},
    });
    const file = join(mkdtempSync(join(tmpdir(), 'drop-num-')), 't.adb');
    writeFileSync(file, res.file);
    const r = await AdbReader.open(new SyncIO(file));
    const names = (await r.tokens()).map((t) => t.name);
    expect(names).toContain('dhamma');
    expect(names).toContain('vinaya');
    expect(names).not.toContain('1.1.1');
    expect(names).not.toContain('0206');
    expect(r.header.lineCount).toBe(1);
  });

  test('dropPunct 排除句讀，文字 token 仍在', async () => {
    const lines = ['dhamma। vinaya॥'];
    const res = await authorAdb({
      dbname: 'dp',
      dbcname: '句讀測試',
      lines,
      fullTextIndex: true,
      dropPunct: '।॥',
      log: () => {},
    });
    const file = join(mkdtempSync(join(tmpdir(), 'drop-punct-')), 't.adb');
    writeFileSync(file, res.file);
    const r = await AdbReader.open(new SyncIO(file));
    const names = (await r.tokens()).map((t) => t.name);
    expect(names).toContain('dhamma');
    expect(names).toContain('vinaya');
    expect(names).not.toContain('।');
    expect(names).not.toContain('॥');
  });
});
