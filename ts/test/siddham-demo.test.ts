/**
 * 悉曇／蘭札測試頁的資料與碼位換算（siddham-demo.ts、siddham-demo-data.ts）。
 *
 *   bun run test/siddham-demo.test.ts
 *
 * 這裡只驗「碼位公式、佔位展開、兩段經文的字數」——字形本身要在瀏覽器看
 * （設置 → 悉曇・蘭札）。
 */
import { SANSKRIT_SAMPLES } from '../src/accelon26/siddham-demo-data';
import { expandSanskrit, sanskritPua } from '../src/accelon26/siddham-demo';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + name + (detail ? '  ' + detail : '')); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
};

// ---- 碼位公式（cbeta_sanskrit.csv 的 pua 欄） ------------------------------
ok('SD-D5B5 → U+1075B5', sanskritPua('SD-D5B5') === 0x1075b5);
ok('SD-A440 → U+104440', sanskritPua('SD-A440') === 0x104440);
ok('RJ-CCBA → U+10CCBA', sanskritPua('RJ-CCBA') === 0x10ccba);
ok('RJ-C943 → U+10C943', sanskritPua('RJ-C943') === 0x10c943);
ok('不知道的碼回 null', sanskritPua('XX-1234') === null && sanskritPua('SD-123') === null);
ok('大寫十六進位', sanskritPua('SD-A5A9') === 0x1045a9);

// ---- 佔位展開 --------------------------------------------------------------
ok('展開一個佔位', expandSanskrit('⟦SD-D5B5⟧') === '\u{1075B5}');
ok('展開混合文字', expandSanskrit('想⟦RJ-CCBA⟧唵') === '想\u{10CCBA}唵');
ok('不認得的佔位原樣留著', expandSanskrit('⟦ZZ-0000⟧') === '⟦ZZ-0000⟧');
ok('展開後沒有殘留佔位', !expandSanskrit('⟦SD-A5A9⟧⟦RJ-C943⟧').includes('⟦'));

// ---- 兩段經文 --------------------------------------------------------------
const sid = SANSKRIT_SAMPLES.find((s) => s.font === 'siddham')!;
const ran = SANSKRIT_SAMPLES.find((s) => s.font === 'ranjana')!;
ok('有悉曇與蘭札兩段', !!sid && !!ran);
ok('悉曇：T21n1213_p0072b08', sid.source === 'T21n1213_p0072b08');
ok('蘭札：X23n0446_p0762b05', ran.source === 'X23n0446_p0762b05');

const glyphs = (lines: string[]) => lines.join('').match(/⟦[A-Z]{2}-[0-9A-F]{4}⟧/g) ?? [];
ok('悉曇 251 字、18 行', glyphs(sid.lines).length === 251 && sid.lines.length === 18,
  `${glyphs(sid.lines).length} 字 / ${sid.lines.length} 行`);
ok('蘭札 5 字、5 行（RJ-CBC2 出現兩次）', glyphs(ran.lines).length === 5 && ran.lines.length === 5,
  `${glyphs(ran.lines).length} 字 / ${ran.lines.length} 行`);

const bad = [...glyphs(sid.lines), ...glyphs(ran.lines)]
  .map((x) => x.slice(1, -1))
  .filter((id) => sanskritPua(id) == null);
ok('所有梵字碼都認得', bad.length === 0, bad.join(','));

ok('所有展開結果都在第 16 平面', [...glyphs(sid.lines), ...glyphs(ran.lines)].every((x) => {
  const cp = sanskritPua(x.slice(1, -1))!;
  return cp >= 0x100000 && cp <= 0x10fffd;
}));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
