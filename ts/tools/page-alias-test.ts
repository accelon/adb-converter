#!/usr/bin/env bun
/**
 * 講記代號 → 頁 id（厚觀法師 2026-11-12）：`HG02p93`／`2p93` 要能當頁 id 用。
 *
 *   cd ts && bun run tools/page-alias-test.ts
 *
 * 只驗純字串轉換（不開瀏覽器）：這一步錯了，跳頁就會跳到別的書。
 */
import { pageAliasForms, pageAliasMissing, pageIdFromQuote } from '../src/accelon26/page-alias';

let fail = 0;
const eq = (name: string, got: unknown, want: unknown): void => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) { console.log('  ok   ' + name); return; }
  fail++;
  console.log('  FAIL ' + name + '\n       got  ' + a + '\n       want ' + b);
};

// fuyan：HG02→38（空之探究講義）、HG03→9（中觀今論講義）、HG05→5（中觀論頌講記）、HG06→6（十住毘婆沙論講義）
eq('HG02p93', pageAliasForms('HG02p93', 'fuyan'), ['38p93']);
eq('hg02p93（小寫）', pageAliasForms('hg02p93', 'fuyan'), ['38p93']);
eq('HG2p93（省 0）', pageAliasForms('HG2p93', 'fuyan'), ['38p93']);
eq('2p93（只打編號）', pageAliasForms('2p93', 'fuyan'), ['38p93']);
eq('HG02p.93（帶點）', pageAliasForms('HG02p.93', 'fuyan'), ['38p93']);
eq('HG03p52', pageAliasForms('HG03p52', 'fuyan'), ['9p52']);
eq('HG05p52a（帶欄號）', pageAliasForms('HG05p52a', 'fuyan'), ['5p52a']);
eq('全形ＨＧ０２ｐ９３', pageAliasForms('ＨＧ０２ｐ９３', 'fuyan'), ['38p93']);
// 2026-11-14 收進第四本《十住毘婆沙論講義》，代號 HG06、頁 id 前綴 6
eq('HG06p93', pageAliasForms('HG06p93', 'fuyan'), ['6p93']);
eq('HG6p93（省 0）', pageAliasForms('HG6p93', 'fuyan'), ['6p93']);
eq('6p93（只打編號）', pageAliasForms('6p93', 'fuyan'), ['6p93']);
eq('HG06p705（末頁）', pageAliasForms('HG06p705', 'fuyan'), ['6p705']);
eq('HG06p93b（帶欄號）', pageAliasForms('HG06p93b', 'fuyan'), ['6p93b']);
// 不是 fuyan 的庫不要動：ys 的 38p7a8 是真的第 38 部書，不能被當成 HG02
eq('別的庫不吃代號', pageAliasForms('HG02p93', 'ys'), []);
// 本來就是頁 id 的寫法，原樣不動（交給一般的頁 id 比對）
eq('38p107 不受影響', pageAliasForms('38p107', 'fuyan'), []);
eq('8p52a 不受影響', pageAliasForms('8p52a', 'fuyan'), []);
eq('目錄路徑不受影響', pageAliasForms('1.2.3', 'fuyan'), []);
// 認得代號、但這本書不在庫裡：要說得出書名
eq('HG01《成佛之道》', pageAliasMissing('HG01p5', 'fuyan'), 'HG01《成佛之道》');
eq('HG04《大智度論》', pageAliasMissing('HG04p5', 'fuyan'), 'HG04《大智度論》');
eq('HG07《法華經》', pageAliasMissing('HG07p5', 'fuyan'), 'HG07《法華經》');
eq('HG08《維摩經》', pageAliasMissing('HG08p5', 'fuyan'), 'HG08《維摩經》');
eq('已在庫裡的不算缺（HG02）', pageAliasMissing('HG02p5', 'fuyan'), '');
eq('已在庫裡的不算缺（HG06）', pageAliasMissing('HG06p5', 'fuyan'), '');
eq('看不懂的字串不算缺', pageAliasMissing('zzz', 'fuyan'), '');

// 引用複製貼回搜尋框：靠書名補前綴（法師 2026-11-12）
eq('引用複製（十住）', pageIdFromQuote('《十住毘婆沙論講義》：「菩薩於此不應驚怖」（p.93）', 'fuyan'), '6p93');
eq('引用複製（十住腳註頁）', pageIdFromQuote('《十住毘婆沙論講義》：「…」（pp.704-705）', 'fuyan'), '6p704');
eq('引用複製（空之探究，未受影響）', pageIdFromQuote('《空之探究講義》：「由於十遍處……」（p.93）', 'fuyan'), '38p93');
eq('引用複製（別的庫不猜）', pageIdFromQuote('《十住毘婆沙論講義》：「…」（p.93）', 'ys'), null);

console.log(fail ? `\n${fail} 項失敗` : '\n全部通過');
process.exit(fail ? 1 : 0);
