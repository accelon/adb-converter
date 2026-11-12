#!/usr/bin/env bun
/**
 * 講記代號 → 頁 id（厚觀法師 2026-11-12）：`HG02p93`／`2p93` 要能當頁 id 用。
 *
 *   cd ts && bun run tools/page-alias-test.ts
 *
 * 只驗純字串轉換（不開瀏覽器）：這一步錯了，跳頁就會跳到別的書。
 */
import { pageAliasForms, pageAliasMissing } from '../src/accelon26/page-alias';

let fail = 0;
const eq = (name: string, got: unknown, want: unknown): void => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) { console.log('  ok   ' + name); return; }
  fail++;
  console.log('  FAIL ' + name + '\n       got  ' + a + '\n       want ' + b);
};

// fuyan：HG02→38（空之探究講義）、HG03→9（中觀今論講義）、HG05→5（中觀論頌講記）
eq('HG02p93', pageAliasForms('HG02p93', 'fuyan'), ['38p93']);
eq('hg02p93（小寫）', pageAliasForms('hg02p93', 'fuyan'), ['38p93']);
eq('HG2p93（省 0）', pageAliasForms('HG2p93', 'fuyan'), ['38p93']);
eq('2p93（只打編號）', pageAliasForms('2p93', 'fuyan'), ['38p93']);
eq('HG02p.93（帶點）', pageAliasForms('HG02p.93', 'fuyan'), ['38p93']);
eq('HG03p52', pageAliasForms('HG03p52', 'fuyan'), ['9p52']);
eq('HG05p52a（帶欄號）', pageAliasForms('HG05p52a', 'fuyan'), ['5p52a']);
eq('全形ＨＧ０２ｐ９３', pageAliasForms('ＨＧ０２ｐ９３', 'fuyan'), ['38p93']);
// 不是 fuyan 的庫不要動：ys 的 38p7a8 是真的第 38 部書，不能被當成 HG02
eq('別的庫不吃代號', pageAliasForms('HG02p93', 'ys'), []);
// 本來就是頁 id 的寫法，原樣不動（交給一般的頁 id 比對）
eq('38p107 不受影響', pageAliasForms('38p107', 'fuyan'), []);
eq('8p52a 不受影響', pageAliasForms('8p52a', 'fuyan'), []);
eq('目錄路徑不受影響', pageAliasForms('1.2.3', 'fuyan'), []);
// 認得代號、但這本書不在庫裡：要說得出書名
eq('HG01《成佛之道》', pageAliasMissing('HG01p5', 'fuyan'), 'HG01《成佛之道》');
eq('HG04《大智度論》', pageAliasMissing('HG04p5', 'fuyan'), 'HG04《大智度論》');
eq('已在庫裡的不算缺', pageAliasMissing('HG02p5', 'fuyan'), '');
eq('看不懂的字串不算缺', pageAliasMissing('zzz', 'fuyan'), '');

console.log(fail ? `\n${fail} 項失敗` : '\n全部通過');
process.exit(fail ? 1 : 0);
