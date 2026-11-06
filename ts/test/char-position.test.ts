/**
 * 字元級位置解析（`#` 新語法＋舊 `j=` 相容）。
 *
 *   bun run test/char-position.test.ts
 */
import { findCharPosition, formatCharPosition, parseCharPosition } from '../src/accelon26/char-position';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + '  ' + detail); }
};
const same = (p: unknown, q: unknown) => JSON.stringify(p) === JSON.stringify(q);

const hash = parseCharPosition('yl38p4#12-34');
ok('# 頁 id（yl38p4）＋起訖', same(hash, { db: '', anchor: 'yl38p4', a: 12, b: 34 }), JSON.stringify(hash));

const single = parseCharPosition('yl38p4#12');
ok('# 單字：a=b', same(single, { db: '', anchor: 'yl38p4', a: 12, b: 12 }), JSON.stringify(single));

const db = parseCharPosition('fuyan?yl38p4#4-22');
ok('db?頁#a-b', same(db, { db: 'fuyan', anchor: 'yl38p4', a: 4, b: 22 }), JSON.stringify(db));

const legacy = parseCharPosition('fuyan?yl38p4 j=12-34');
ok('舊 j= end 不含 → 換成含（12..33）', same(legacy, { db: 'fuyan', anchor: 'yl38p4', a: 12, b: 33 }), JSON.stringify(legacy));

const one = parseCharPosition('foo?L123#5');
ok('L 行錨點', same(one, { db: 'foo', anchor: 'L123', a: 5, b: 5 }), JSON.stringify(one));

const tag = parseCharPosition('cyd?詞1#0-3');
ok('舊詞書錨點相容（詞1）', same(tag, { db: 'cyd', anchor: '詞1', a: 0, b: 3 }), JSON.stringify(tag));
const name = parseCharPosition('cyd?一毛不拔#0-3');
ok('詞書名稱錨點（一毛不拔）', same(name, { db: 'cyd', anchor: '一毛不拔', a: 0, b: 3 }), JSON.stringify(name));
const tagCite = findCharPosition('《成語典》：「一毛不拔」(cyd?一毛不拔#0-3)');
ok('引用字串抓詞書名稱錨點', same(tagCite, { db: 'cyd', anchor: '一毛不拔', a: 0, b: 3 }), JSON.stringify(tagCite));

const cite = '《空之探究講義》：「一」( yl38p4 ) yl38p4#4-22';
ok('引用字串抓尾端 token', same(findCharPosition(cite), { db: '', anchor: 'yl38p4', a: 4, b: 22 }), JSON.stringify(findCharPosition(cite)));
ok('純引用沒有 token → null', findCharPosition('《空之探究講義》：「一」( yl38p4 )') === null);
ok('大正引用不被當字元位置', findCharPosition('T02, no. 99, p. 1a7-9') === null);
ok('純頁 id 不被當字元位置', parseCharPosition('yl38p4') === null && findCharPosition('yl38p4') === null);
ok('format 單字不帶 dash', formatCharPosition({ anchor: 'yl38p4', a: 4, b: 4 }) === 'yl38p4#4');
ok('format 範圍帶 dash', formatCharPosition({ anchor: 'yl38p4', a: 4, b: 22 }) === 'yl38p4#4-22');
ok('format 不含 j=', !formatCharPosition({ anchor: 'yl38p4', a: 4, b: 22 }).includes('j='));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
