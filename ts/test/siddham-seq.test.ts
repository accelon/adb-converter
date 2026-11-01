/**
 * SAT 的悉曇連字碼（`&SDxxxxx;`）在顯示時要換成 Unicode 序列。
 *
 *   bun run test/siddham-seq.test.ts
 *
 * 只換畫面：adb 的 raw 文字仍是 `&SDxxxxx;`，VA 也不變（見 gaiji-va.test.ts）。
 */
import { renderPageLines } from '../src/accelon26/render_accelon3';
import { siddhamSequence } from '../src/accelon26/siddham-seq';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + name + (detail ? '  ' + detail : '')); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
};

// rdhla = ra + virama + dha + virama + la
const RDHLA = '\u{115A8}\u{115BF}\u{115A0}\u{115BF}\u{115A9}';
ok('SDFF878 → rdhla 序列', siddhamSequence('SDFF878') === RDHLA, JSON.stringify(siddhamSequence('SDFF878')));
ok('SD-M5C7 → 單一悉曇字', siddhamSequence('SD-M5C7') === '\u{115C7}', '');

const html = renderPageLines(['&SDFF878;'], 0)[0]!;
ok('渲染成 sdSeq span', html.includes('class="sdSeq"') && html.includes('data-code="SDFF878"'), html);
ok('span 內是序列', html.includes(RDHLA), html);
ok('不再顯示 &amp;SDFF878;', !html.includes('&amp;SDFF878;'), html);

const one = renderPageLines(['&SD-M5C7;'], 0)[0]!;
ok('單字碼也換', one.includes('\u{115C7}') && one.includes('data-code="SD-M5C7"'), one);

const unknown = renderPageLines(['&SDZZZZZ;'], 0)[0]!;
ok('不認識的碼照舊顯示實體', unknown.includes('&amp;SDZZZZZ;'), unknown);

const amp = renderPageLines(['a &amp; b'], 0)[0]!;
ok('一般 &amp; 不受影響', amp.includes('a &amp; b'), amp);

// CBETA 梵字 PUA（U+FA000+XXXX）：顯示時換成 Noto 序列
const pua = renderPageLines(['\u{104440}'], 0)[0]!;
ok('PUA 梵字換成序列', pua.includes('class="sdSeq"') && pua.includes('\u{1158E}'), pua);

const puaNoSeq = renderPageLines(['\u{F0001}'], 0)[0]!;
ok('沒有序列的 PUA 照舊（CB 缺字）', puaNoSeq.includes('\u{F0001}'), puaNoSeq);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
