/**
 * 漢字位置統一用 code point 計算（2026-11-01）。
 *
 *   bun run test/han.test.ts
 *
 * 背景：擴充 B 區的字（如「𩜁」U+29A41）在 UTF-16 是代理對；以前逐 code unit
 * 的 `[\u3400-\u9fff]` 測不到，會少算 1 個字，`j` 色帶就偏。
 */
import { HAN_RE, isHan, hanChars, hanCount, cpToUnit } from '../src/accelon26/han';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + name + (detail ? '  ' + detail : '')); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
};

const S = '羯𩜁伽恭御陀'; // BMP 5 ＋ 擴充 B 1
ok('hanCount 把代理對算 1 個字', hanCount(S) === 6, String(hanCount(S)));
ok('hanCount 逐 code point（不是 7）', hanCount(S) !== 7, '');
ok('isHan("𩜁") 為真', isHan('𩜁'), '');
ok('isHan(半個代理對) 為假', !isHan('\uD865'), '');
ok('hanChars 不含標點', hanChars('羯𩜁、伽').join('') === '羯𩜁伽', hanChars('羯𩜁、伽').join(''));
ok('hanCount 會去掉標籤', hanCount('<b>羯𩜁</b>伽') === 3, String(hanCount('<b>羯𩜁</b>伽')));

// code point 索引 → UTF-16 位移
ok('cpToUnit 0 → 0', cpToUnit('羯𩜁伽', 0) === 0, '');
ok('cpToUnit 1 → 1', cpToUnit('羯𩜁伽', 1) === 1, '');
ok('cpToUnit 2 → 3（𩜁 佔 2）', cpToUnit('羯𩜁伽', 2) === 3, String(cpToUnit('羯𩜁伽', 2)));
ok('cpToUnit 3 → 4', cpToUnit('羯𩜁伽', 3) === 4, String(cpToUnit('羯𩜁伽', 3)));

// `\p{Script=Han}` 一定要有 u flag
ok('HAN_RE 有 u flag', HAN_RE.unicode === true, String(HAN_RE.unicode));
ok('HAN_RE 測單一 code point', HAN_RE.test('𩜁'), '');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
