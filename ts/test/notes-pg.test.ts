/**
 * 注號 pg 配對（厚觀法師 2026-11-17 UID 299：法華點注號跳別品注文）。
 *
 *   bun test test/notes-pg.test.ts
 *
 * 法華每品注號從 1 重起：同一個 n 在全書有幾十條，只有 pg 相同的那條才是同一品。
 */
import { noteTagAt } from '../src/accelon26/note-tag';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + name + (detail ? '  ' + detail : '')); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
};

const L1 = '<段界/><釋 n="148" pg="7p124">注文甲</釋>';
ok('同 pg 命中', !!noteTagAt(L1, '釋', '148', '7p124'));
ok('不同 pg 不取', !noteTagAt(L1, '釋', '148', '7p300'));

const L2 = '<段界/><釋 n="148" pg="7p124">甲</釋><釋 n="148" pg="7p300">乙</釋>';
const h2 = noteTagAt(L2, '釋', '148', '7p300');
ok('一行兩條：取 pg 相符那條', !!h2 && L2.slice(h2!.end).startsWith('乙'), h2 ? 'end=' + h2.end : '');

const L3 = '<段界/><釋 n="148">無 pg</釋>';
ok('無 pg 標籤當退路（wantPg 有但只能退而求其次）', !!noteTagAt(L3, '釋', '148', '7p124'));
const L4 = '<段界/><釋 n="148">無 pg</釋><釋 n="148" pg="7p300">乙</釋>';
const h4 = noteTagAt(L4, '釋', '148', '7p300');
ok('pg 相符優先於無 pg', !!h4 && L4.slice(h4!.end).startsWith('乙'), h4 ? 'end=' + h4.end : '');

const h5 = noteTagAt(L2, '釋', '148');
ok('wantPg 空＝舊行為（第一條）', !!h5 && L2.slice(h5!.end).startsWith('甲'));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
