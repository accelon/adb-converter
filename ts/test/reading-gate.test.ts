/** 精讀模式只准 `<集 g="…">` 的 vedic 群使用（2026-11-06）。 */
(globalThis as unknown as { window?: unknown }).window = globalThis;
const { readingGroupInHeader } = await import('../src/accelon26/reading-pane');

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + '  ' + detail); }
};

ok('有 <集 g>：允許', readingGroupInHeader('<檔><集 g="vedic">吠陀</集></檔>'));
ok('有 <集 g="1">：允許', readingGroupInHeader('<檔><集 g="1">吠陀</集></檔>'));
ok('沒有 g：不允許', !readingGroupInHeader('<檔><集>成語典</集></檔>'));
ok('g 只在正文（不在第一個檔頭）不算', !readingGroupInHeader('<檔><集>成語典</集></檔><檔><集 g="x">正文</集></檔>'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
