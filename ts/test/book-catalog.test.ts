/** 書目登錄（book-catalog）基本契約。 */
import { BOOK_CATALOG, WORK_CATALOG, bookById, catalogCount, findBooks, findWorks, normalizeBookName, resolveBook, resolveWork, worksOfBook } from '../src/accelon26/book-catalog';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + '  ' + detail); }
};

ok('catalog 有書', catalogCount() > 20, String(catalogCount()));
ok('id 不重複', new Set(BOOK_CATALOG.map((b) => b.id)).size === BOOK_CATALOG.length);
const cyd = bookById('cyd');
ok('bookById(cyd)', cyd?.title === '成語典' && cyd.adb === 'cyd.adb', JSON.stringify(cyd));
ok('別名查成語典', findBooks('成語典').some((b) => b.id === 'cyd'));
ok('唯一命中 resolveBook', resolveBook('成語典')?.id === 'cyd');
const thirteen = findBooks('十三經');
ok('同名書保留多版本', thirteen.length >= 2 && resolveBook('十三經') === null, thirteen.map((b) => b.id).join(','));
ok('normalize 去書名標點', normalizeBookName('《成語典》') === '成語典', normalizeBookName('《成語典》'));

ok('work 有十三經各書', WORK_CATALOG.length >= 13, String(WORK_CATALOG.length));
const yi = resolveWork('《易》');
ok('《易》→ yijing', yi?.id === 'yijing', JSON.stringify(yi));
ok('周易也是 yijing', resolveWork('周易')?.id === 'yijing');
ok('yijing 指向 13j 的周易', yi?.editions.some((e) => e.adb === '13j' && e.book === '周易') === true, JSON.stringify(yi?.editions));
ok('13j 含易', worksOfBook('13j').some((w) => w.id === 'yijing'));
ok('書名與 adb 分開：孟子是 work，13j 是載體', resolveWork('孟子')?.editions[0]?.adb === '13j');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
