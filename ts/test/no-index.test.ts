/**
 * `authorAdb({ fullTextIndex: false })` — 純容器 adb：
 *   - 仍有 source／tags／tables／attributes／caches，tags 與頁碼讀得到
 *   - **沒有** `tokens` 容器（不存 token 清單與 postings）
 *   - lines／maxVA 與有索引的版本完全相同（VA 照樣前進）
 *
 *   bun run test/no-index.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorAdb } from '../src/adbauthor';
import { AdbReader, SyncIO } from '../src/accelon26/adb';

const LINES = [
  '<集 t="集">測試集</集>',
  '<冊 id="1">第一冊</冊>',
  '<書 id="n1">一部書</書>',
  '<頁 id="1p1a"/>',
  '甲乙丙丁',
  '<頁 id="1p1b"/>',
  '戊己庚辛',
];

async function build(fullTextIndex: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'no-index-'));
  const file = join(dir, 't.adb');
  const res = await authorAdb({
    dbname: 'ni',
    dbcname: '無索引測試',
    lines: LINES,
    fullTextIndex,
    log: () => {},
  });
  writeFileSync(file, res.file);
  return { file, res };
}

describe('no full-text index', () => {
  test('沒有 tokens 容器，但 tags／頁／行都讀得到', async () => {
    const { file, res } = await build(false);
    const r = await AdbReader.open(new SyncIO(file));
    expect(res.tokens).toBe(0);
    expect(r.hasFullTextIndex).toBe(false);
    expect(r.containers.has('tokens')).toBe(false);
    expect(r.tokens().length).toBe(0);
    expect(r.header.lineCount).toBe(LINES.length);

    const pages = await r.attributeValues('頁.id');
    expect(pages?.values).toEqual(['1p1a', '1p1b']);
    expect(await r.sourceText(0)).toContain('甲乙丙丁');

    const tags = r.containers.get('tags')!;
    expect(tags.names).toContain('頁');
    expect(tags.names).toContain('書');
  });

  test('VA 與有索引的版本完全相同', async () => {
    const a = await build(true);
    const b = await build(false);
    const ra = await AdbReader.open(new SyncIO(a.file));
    const rb = await AdbReader.open(new SyncIO(b.file));

    expect(rb.header.lineCount).toBe(ra.header.lineCount);
    expect(rb.header.maxBlockOffset).toBe(ra.header.maxBlockOffset);
    expect(await rb.linesVirtual()).toEqual(await ra.linesVirtual());
    expect(await rb.linesPhysical()).toEqual(await ra.linesPhysical());

    // tags 的 VA 也要一模一樣（tags 讀得到，目錄／頁碼才不會歪）。
    const tagVa = async (r: AdbReader, name: string) => {
      const c = r.containers.get('tags')!;
      const at = c.names.indexOf(name);
      return at < 0 ? [] : r.decodeBlockList('tags', at);
    };
    expect(await tagVa(rb, '書')).toEqual(await tagVa(ra, '書'));
    expect(await tagVa(rb, '頁')).toEqual(await tagVa(ra, '頁'));

    expect(ra.hasFullTextIndex).toBe(true);
    expect(ra.tokens().length).toBeGreaterThan(0);
    expect(rb.hasFullTextIndex).toBe(false);
  });
});
