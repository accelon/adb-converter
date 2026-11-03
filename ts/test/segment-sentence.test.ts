/**
 * `句` 的單位是「段內第 j 個**有文字的行**」，空白行不算（sz `docs/addressing.md` 2026-11-03 定案）。
 *
 * 各譯本段內空行很多（ccc 23,727、kmj 31,942、yh 15,342；cs 1,082 段內空行、影響 432 段）。
 * 若照「行號相減」算句，`:句` 會整段位移。這一支用一個有段內空行的小 adb 把它釘住。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorAdb } from '../src/adbauthor';
import { AdbReader, SyncIO } from '../src/accelon26/adb';
import { anchorVa, locatorAtVa } from '../src/accelon26/page-text';

const LINES = [
  '<檔 n="t"><集>測試</集></檔>',
  '<塊 id="d1">(d1)</塊>',
  '<段 n="1"/>alpha',
  '',
  'beta',
  '<段 n="2"/>gamma',
  'delta',
];

async function open(): Promise<AdbReader> {
  const res = await authorAdb({ dbname: 't', dbcname: '測試', lines: LINES, fullTextIndex: true, log: () => {} });
  const file = join(mkdtempSync(join(tmpdir(), 'seg-sent-')), 't.adb');
  writeFileSync(file, res.file);
  return await AdbReader.open(new SyncIO(file));
}

async function vaOf(r: AdbReader, token: string): Promise<number> {
  const toks = await r.tokens();
  const i = toks.findIndex((t) => t.name === token);
  expect(i).toBeGreaterThanOrEqual(0);
  const vas = await r.decodeBlockList('tokens', i);
  return vas[0];
}

describe('句 = 段內第 j 個有文字的行（空行不算）', () => {
  test('VA → 句：段內空行不佔句號', async () => {
    const r = await open();
    expect((await locatorAtVa(r, await vaOf(r, 'alpha')))?.sentence).toBe(1);
    expect((await locatorAtVa(r, await vaOf(r, 'beta')))?.sentence).toBe(2);
  });

  test('VA → 句：下一段重新從 1 起算', async () => {
    const r = await open();
    const at = await locatorAtVa(r, await vaOf(r, 'gamma'));
    expect(at?.seg).toBe('2');
    expect(at?.sentence).toBe(1);
    expect((await locatorAtVa(r, await vaOf(r, 'delta')))?.sentence).toBe(2);
  });

  test('句 → VA：`:2` 要跳到 beta，不是空行', async () => {
    const r = await open();
    expect(await anchorVa(r, 'd1.1:2')).toBe(await vaOf(r, 'beta'));
    expect(await anchorVa(r, 'd1.2:2')).toBe(await vaOf(r, 'delta'));
  });
});
