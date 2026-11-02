/**
 * 日文庫（kmj）的「索引分詞」與「閱讀端 VA 換算」必須一致（2026-11-03）。
 *
 * 實際踩過：索引端用 `Intl.Segmenter('ja')` 把「話題」當**一個** token，
 * 但 `VaPaMapper` 用預設逐字切，於是 postings 裡的 VA 被算成「て」——
 * token 頁籤點下去塗錯字、搜尋命中跳錯位置。
 *
 * 這一支用 `authorAdb({ japanese: true })` 做一個小 adb，比對：
 *   tokens 容器裡有「話題」、沒有單字「題」；
 *   每個「話題」posting 的 VA，`VaPaMapper.elementAt()` 也必須是「話題」。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorAdb } from '../src/adbauthor';
import { AdbReader, SyncIO } from '../src/accelon26/adb';
import { VaPaMapper } from '../src/accelon26/vapa';
import { Tokenizer, tokenProfileOf } from '../src/tokenize';

const LINES = [
  '<檔 n="kmj"><集>日譯</集></檔>',
  'さて、この話題が生じた。',
  'ときに世尊は、彼らのこの話題を知って、近づいた。',
  'これは問題である。',
];

async function openJa(): Promise<AdbReader> {
  const res = await authorAdb({
    dbname: 'kmj',
    dbcname: '日譯',
    lines: LINES,
    fullTextIndex: true,
    japanese: true,
    log: () => {},
  });
  const file = join(mkdtempSync(join(tmpdir(), 'ja-align-')), 'kmj.adb');
  writeFileSync(file, res.file);
  return await AdbReader.open(new SyncIO(file));
}

describe('日文分詞與 VA 換算', () => {
  test('索引裡「話題」是一個 token，沒有單字「題」', async () => {
    const r = await openJa();
    const names = (await r.tokens()).map((t) => t.name);
    expect(names).toContain('話題');
    expect(names).toContain('問題');
    expect(names).not.toContain('題');
  });

  test('tokenProfileOf：只有 kmj 開日文詞典', () => {
    expect(tokenProfileOf('kmj').japanese).toBe(true);
    expect(tokenProfileOf('KMJ').japanese).toBe(true);
    expect(tokenProfileOf('cs').japanese).toBe(false);
    expect(tokenProfileOf(undefined).japanese).toBe(false);
  });

  test('日文切詞：一個詞一個 token，不是逐字', () => {
    const ja: string[] = [];
    const tk = new Tokenizer('この話題が生じた。', { japanese: true });
    for (;;) { const s = tk.nextLiteral(); if (!s) break; ja.push(s); if (tk.atEnd) break; }
    expect(ja).toContain('話題');
    const per: string[] = [];
    const tk2 = new Tokenizer('この話題が生じた。');
    for (;;) { const s = tk2.nextLiteral(); if (!s) break; per.push(s); if (tk2.atEnd) break; }
    expect(per).not.toContain('話題');
  });

  test('每個「話題」posting 的 VA，VaPaMapper.elementAt 也必須是「話題」', async () => {
    const r = await openJa();
    const toks = await r.tokens();
    const i = toks.findIndex((t) => t.name === '話題');
    expect(i).toBeGreaterThanOrEqual(0);
    const vas = await r.decodeBlockList('tokens', i);
    expect(vas.length).toBe(2);
    const m = new VaPaMapper(r);
    await m.init();
    for (const va of vas) {
      const el = await m.elementAt(va);
      expect(el?.element.text).toBe('話題');
      const line = m.lineOfVa(va);
      expect(line).toBeGreaterThan(0);
    }
  });
});
