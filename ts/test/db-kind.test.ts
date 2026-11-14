/**
 * `<集 c="…">` 旗標的解析（作者 2026-11-14）
 *
 * 段首縮排改成「由書稿標記決定」之後，`c` 就是體例旗標的落點：
 *   `c="noindent"` → 《福嚴講義》正文頂格（厚觀法師 2026-11-14）
 *   `c="isdict"`   → 詞典型
 * 沒宣告 → 全部照舊（縮排、不是詞典型）。
 */
import { collectionFlags } from '../src/accelon26/db-kind';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log('  ok  ', name); }
  else { fail++; console.log('  FAIL', name, extra === undefined ? '' : JSON.stringify(extra)); }
};

// 真的會出現在各庫的寫法
const fuyan = '<檔 n="fuyan.xml"><集 c="noindent">福嚴講義</集>';
const ys = '<檔 n="ys.xml"><集 l="圖集,註釋群,編目資訊">印順法師佛學著作集</集>';
const taisho = '<檔 n="taisho.xml"><集 c="hidden">大正新脩大藏經</集>';
const fgdict = '<檔 n="fgdict.xml">\n<集>佛光大辭典</集>';

ok('fuyan：c="noindent" → noindent', collectionFlags(fuyan).includes('noindent'));
ok('fuyan：沒有 isdict（不會被誤判成詞典型）', !collectionFlags(fuyan).includes('isdict'));
ok('ys：只有 l= → 沒有任何 c 旗標', collectionFlags(ys).length === 0, collectionFlags(ys));
ok('taisho：c="hidden"', collectionFlags(taisho).join(',') === 'hidden');
ok('fgdict：<集> 無屬性 → 空', collectionFlags(fgdict).length === 0);
ok('沒有 <集> → 空', collectionFlags('<檔 n="x.xml"><書 id="x">書</書>').length === 0);
ok('多個旗標（空白分隔）', collectionFlags('<集 c="isdict  noindent">X</集>').join(',') === 'isdict,noindent');
ok('旗標在字首（不是靠 \b 邊界）', collectionFlags('<集 c="noindent isdict">X</集>').includes('isdict'));
ok('只認整字：noindentation 不算', !collectionFlags('<集 c="noindentation">X</集>').includes('noindent'));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
