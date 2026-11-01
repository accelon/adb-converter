/** `time-format.ts` 的單元測試（下載剩餘時間，作者 2026-10-31）。 */
import { etaOf, fmtEta } from '../src/accelon26/time-format';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
};

ok('1時02分03秒', fmtEta(3723) === '1時02分03秒', fmtEta(3723));
ok('12分03秒（不顯示 0時）', fmtEta(723) === '12分03秒', fmtEta(723));
ok('3秒（不顯示 0分）', fmtEta(3) === '3秒', fmtEta(3));
ok('0秒', fmtEta(0) === '0秒', fmtEta(0));
ok('負數／NaN → 空字串', fmtEta(-1) === '' && fmtEta(Number.NaN) === '');
ok('etaOf：50/100、25 B/s → 2秒', etaOf(50, 100, 25) === '2秒', etaOf(50, 100, 25));
ok('etaOf：速度 0 → 空字串', etaOf(50, 100, 0) === '');
ok('etaOf：已經下完 → 空字串', etaOf(100, 100, 10) === '');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
