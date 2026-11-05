/**
 * cs-lex.adb 的詞條解析與詞形還原（2026-11-03）。
 *
 * 不開瀏覽器：用 authorAdb 做一個最小的 cs-lex（`<條 w iast>` ＋譯詞行），
 * 走一次真正的 source 掃描；ruby 的畫面端另有 CDP 測試。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorAdb } from '../src/adbauthor';
import { AdbReader, SyncIO } from '../src/accelon26/adb';
import { lemmaOf, parseCsLex } from '../src/accelon26/cs-lex';

const LINES = [
  '<檔 n="cs-lex"><集>巴利詞庫（測試）</集></檔>',
  '<隱><樹 s="*" t="區,書,塊.">目錄</樹></隱>',
  '<區 id="dn" t="書.">(dīgha)</區>',
  '<書 id="dn1" t="塊.">(dn1)</書>',
  '<塊 id="d1" w="dn1">(dn1)</塊>',
  '<條 id="l000001" w="bhikkhu" iast="bhikkhu">(bhikkhu)</條>',
  'sc-en：mendicant、monk',
  'yh：比丘、僧',
  'kmj：比丘、僧',
  '<條 id="l000002" w="dhamma" iast="dhamma">(dhamma)</條>',
  'sc-en：teaching',
  'yh：法',
];

describe('cs-lex：詞條與詞形', () => {
  test('<條 w iast> ＋ 譯詞行 → Map；lemmaOf 去掉屈折', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cs-lex-test-'));
    const file = join(dir, 'cs-lex.adb');
    const res = await authorAdb({
      dbname: 'cs-lex', dbcname: '巴利詞庫（測試）', lines: LINES, fullTextIndex: false,
    });
    writeFileSync(file, Buffer.from(res.file));
    const r = await AdbReader.open(new SyncIO(file));
    const lex = await parseCsLex(r);

    expect(lex.size).toBe(2);
    const bhikkhu = lex.get('bhikkhu')!;
    expect(bhikkhu.lemma).toBe('bhikkhu');
    expect(bhikkhu.iast).toBe('bhikkhu');
    expect(bhikkhu.by['yh']).toEqual(['比丘', '僧']);
    expect(bhikkhu.by['kmj']).toEqual(['比丘', '僧']);

    // 原形、可切的字尾（s）都要找回同一個 lemma；查不到回空字串。
    expect(lemmaOf(lex, 'dhamma')).toBe('dhamma');
    expect(lemmaOf(lex, 'dhammas')).toBe('dhamma');
    expect(lemmaOf(lex, 'nope')).toBe('');
  });

  test('舊格式 <塊 w iast> 也吃（沒有 <條> 時）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cs-lex-old-'));
    const file = join(dir, 'cs-lex.adb');
    const res = await authorAdb({
      dbname: 'cs-lex', dbcname: '巴利詞庫（舊格式）',
      lines: [
        '<檔 n="cs-lex"><集>舊格式</集></檔>',
        '<隱><樹 s="*" t="區,書,塊.">目錄</樹></隱>',
        '<區 id="dn" t="書.">(dīgha)</區>',
        '<書 id="dn1" t="塊.">(dn1)</書>',
        '<塊 id="w1" w="nibbāna" iast="nibbāna">(nibbāna)</塊>',
        'yh：涅槃',
      ],
      fullTextIndex: false,
    });
    writeFileSync(file, Buffer.from(res.file));
    const r = await AdbReader.open(new SyncIO(file));
    const lex = await parseCsLex(r);
    expect(lex.size).toBe(1);
    expect(lex.get('nibbāna')?.by['yh']).toEqual(['涅槃']);
  });
});
