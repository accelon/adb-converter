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
import { SearchSession } from '../src/accelon26/search';
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

describe('詞內（sub-token）查：Enter 才回退', () => {
  test('桌面版不能走 Go 後端（它逐字切查詢，話題會變 話＋題）', async () => {
    const r = await openJa();
    expect(new SearchSession(r).usesJapanese).toBe(true);
    // 非日文庫仍可走 Go
    const res = await authorAdb({ dbname: '13j', dbcname: '十三經', lines: ['<檔 n="x"><集>甲</集></檔>', '子曰'], fullTextIndex: true, log: () => {} });
    const file = join(mkdtempSync(join(tmpdir(), 'ja-align-')), 'x.adb');
    writeFileSync(file, res.file);
    const r2 = await AdbReader.open(new SyncIO(file));
    expect(new SearchSession(r2).usesJapanese).toBe(false);
  });

  test('單字「題」直接搜是 0 筆（不是 bug，是詞索引的先天限制）', async () => {
    const r = await openJa();
    const res = await new SearchSession(r).search('題');
    expect(res.hits.length).toBe(0);
    expect(res.missing).toContain('題');
  });

  test('subtokenNames：列出含「題」的詞，整詞本身不算候選', async () => {
    const s = new SearchSession(await openJa());
    const names = await s.subtokenNames('題');
    expect(names.sort()).toEqual(['問題', '話題']);
    expect(await s.subtokenNames('話題')).toEqual([]);
  });

  test('subtokenSearch：posting 聯集（話題×2＋問題×1 = 3 筆）', async () => {
    const r = await openJa();
    const res = await new SearchSession(r).subtokenSearch('題');
    expect(res.hits.length).toBe(3);
    // 三筆都落在含「題」的詞上
    const m = new VaPaMapper(r);
    await m.init();
    const texts: string[] = [];
    for (const h of res.hits) {
      const el = await m.elementAt(h.va);
      texts.push(el?.element.text ?? '');
    }
    expect(texts.sort()).toEqual(['問題', '話題', '話題']);
  });
});
