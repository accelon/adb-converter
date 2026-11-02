/**
 * lex.adb 的詞條解析與「中文反查」（2026-11-03）。
 *
 * 這一支不開瀏覽器：`lex-index.ts` 是純資料，`buildHanIndex`／`hanCandidates`
 * 直接吃行陣列；最後一個 test 再用 `authorAdb` 真的做一個小 lex.adb，
 * 走一次 source 掃描（畫面端的 `.word` 單擊另有 browser 測試，見 HANDOVER §29）。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorAdb } from '../src/adbauthor';
import { AdbReader, SyncIO } from '../src/accelon26/adb';
import { buildHanIndex, foldHan, hanCandidates, hanIndex, parseLexEntry } from '../src/accelon26/lex-index';

/** 照 sz `src/decomp/build-lexicon-adb.ts` 的格式做一份最小的 lex.adb 行。 */
const LINES = [
  '<檔 n="lex"><集>巴利詞解</集></檔>',
  '<隱><樹 s="*" t="區,書,塊.">目錄</樹></隱>',
  '<區 id="d" t="書.">(d)</區>',
  '<書 id="dh" t="塊.">(dh)</書>',
  '<塊 id="w000001" w="dhamma">(dhamma)</塊>',
  '3,867 次',
  '法',
  '詞件：dhamma',
  '格位：主 · 属',
  '<塊 id="w000002" w="saddhamma">(saddhamma)</塊>',
  '2,100 次',
  '善法',
  '詞件：sad + dhamma',
  '<塊 id="w000003" w="nibbāna">(nibbāna)</塊>',
  '900 次',
  '義項：涅槃',
];

describe('lex-index：詞條解析', () => {
  test('一個詞條的幾行 → 欄位（次數／中文／詞件／格位）', () => {
    const entry = parseLexEntry(LINES.slice(4, 9));
    expect(entry.word).toBe('dhamma');
    expect(entry.count).toBe('3,867');
    expect(entry.gloss).toBe('法');
    expect(entry.parts).toBe('dhamma');
    expect(entry.cases).toBe('主 · 属');
  });

  test('沒有中文釋義時 gloss 是 undefined（不會把「義項：」當中文）', () => {
    const entry = parseLexEntry(LINES.slice(13, 16));
    expect(entry.word).toBe('nibbāna');
    expect(entry.gloss).toBeUndefined();
    expect(entry.senses).toEqual(['涅槃']);
  });

  test('詞形外層的括號會被剝掉，實體會解碼', () => {
    const entry = parseLexEntry(['<塊 w="a&amp;b">（a&amp;b）</塊>', '3 次', '甲 &lt; 乙']);
    expect(entry.word).toBe('a&b');
    expect(entry.gloss).toBe('甲 < 乙');
  });
});

describe('lex-index：中文反查', () => {
  test('中文行 → 巴利詞與次數；沒有中文的詞不入表', () => {
    const index = buildHanIndex(LINES);
    expect([...index.keys()].sort()).toEqual(['善法', '法']);
    expect(index.get('法')).toEqual([{ word: 'dhamma', gloss: '法', count: '3,867' }]);
    expect(index.get('善法')?.[0].word).toBe('saddhamma');
  });

  test('整段相同優先於子字串（「法」不會帶出「善法」）', () => {
    const index = buildHanIndex(LINES);
    expect(hanCandidates(index, '法').map((x) => x.word)).toEqual(['dhamma']);
    expect(hanCandidates(index, '善').map((x) => x.word)).toEqual(['saddhamma']);
  });

  test('選取帶句讀／空白也能比對', () => {
    expect(foldHan('「法」，')).toBe('法');
    const index = buildHanIndex(LINES);
    expect(hanCandidates(index, ' 「法」 。').map((x) => x.word)).toEqual(['dhamma']);
  });

  test('查不到就是空陣列（抽屜顯示「沒有這個中文詞條」）', () => {
    const index = buildHanIndex(LINES);
    expect(hanCandidates(index, '涅槃')).toEqual([]);
    expect(hanCandidates(index, '   ')).toEqual([]);
    // 長選取裡只夾到單字釋義（法／善法）不算命中，否則「任意長句」都會冒出幾十個詞
    expect(hanCandidates(index, '一切有為法皆空')).toEqual([]);
  });

  test('選取帶前後字：「呵责羯磨品」也找得到「呵责羯磨」', () => {
    const index = buildHanIndex([
      '<塊 id="w000001" w="tajjanīyakammaṃ">(tajjanīyakammaṃ)</塊>',
      '278 次',
      '呵责羯磨',
    ]);
    expect(hanCandidates(index, '呵责羯磨品').map((x) => x.word)).toEqual(['tajjanīyakammaṃ']);
    expect(hanCandidates(index, '呵责').map((x) => x.word)).toEqual(['tajjanīyakammaṃ']);
  });
});

describe('lex-index：真的讀一個 lex.adb', () => {
  test('掃 source 建反查表（走 AdbReader，不是只有字串）', async () => {
    const res = await authorAdb({
      dbname: 'lex',
      dbcname: '巴利詞解',
      lines: LINES,
      fullTextIndex: false,
      log: () => {},
    });
    const file = join(mkdtempSync(join(tmpdir(), 'lex-pane-')), 'lex.adb');
    writeFileSync(file, res.file);
    const r = await AdbReader.open(new SyncIO(file));
    const index = await hanIndex(r);
    expect(index.get('法')?.[0]).toMatchObject({ word: 'dhamma', count: '3,867' });
    expect(hanCandidates(index, '善法').map((x) => x.word)).toEqual(['saddhamma']);
    // 同一個 reader 第二次呼叫走快取，結果一致
    expect(await hanIndex(r)).toBe(index);
  });
});
