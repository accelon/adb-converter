/**
 * 編輯工作階段的單元測試（無瀏覽器）：
 *   bun run test/edit-session.test.ts
 */
import { applyEdits, diffPage, discardAll, hasEditsInRange, makeRevision, pageEditAt, sessionFor, stagePage, type PageEdit } from '../src/accelon26/edit-session';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + name + (detail ? '  ' + detail : '')); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
};

const file = { name: 'x.adb', size: 1, lastModified: 1 } as any;
const s = sessionFor(file, 'x');

const old0 = ['a', 'b', 'c', 'd'];
stagePage(s, 0, 3, old0, ['a', 'B', 'c', 'd'], 'doc');
ok('stage stores edit', !!pageEditAt(s, 0, 3));
ok('range hit', hasEditsInRange(s, 1, 1));
ok('range miss', !hasEditsInRange(s, 4, 9));
stagePage(s, 0, 3, old0, old0, 'doc');
ok('editing back to base removes the edit', !pageEditAt(s, 0, 3));

const base = Array.from({ length: 20 }, (_, i) => 'L' + i);
const e1: PageEdit = { first: 0, last: 4, oldLines: base.slice(0, 5), newLines: ['X', ...base.slice(0, 5)], docName: 'a' };
const e2: PageEdit = { first: 10, last: 14, oldLines: base.slice(10, 15), newLines: base.slice(10, 14), docName: 'b' };
const merged = applyEdits(base, [e1, e2]);
ok('net line count unchanged (one insert, one delete)', merged.length === 20, String(merged.length));
ok('first page content', merged[0] === 'X' && merged[1] === 'L0');
ok('later page base indices still valid', merged[11] === 'L10' && merged[14] === 'L13' && merged[15] === 'L15');
ok('deleted page shrank', merged[14] === 'L13');

const d = diffPage({ first: 5, last: 6, oldLines: ['abcdef', 'keep'], newLines: ['abXdef'], docName: 'd' });
ok('one replace', d.changes.length === 2, JSON.stringify(d.changes));
ok('replace at char 2', d.changes[0].kind === 'replace' && d.changes[0].at === 2 && d.changes[0].oldText === 'c' && d.changes[0].newText === 'X');
ok('line number is base line', d.changes[0].line === 5);
const ins = diffPage({ first: 0, last: 0, oldLines: ['a'], newLines: ['a', 'b'], docName: 'i' });
ok('insert line', ins.changes.some((c) => c.kind === 'insert' && c.newLine === 'b'));
const del = diffPage({ first: 0, last: 1, oldLines: ['a', 'b'], newLines: ['a'], docName: 'd' });
ok('delete line', del.changes.some((c) => c.kind === 'delete' && c.oldLine === 'b'));

stagePage(s, 0, 3, old0, ['a', 'B', 'c', 'd'], 'doc');
const rev = makeRevision(s, { name: 'x', size: 1, lineCount: 4, headerCrc: 7 }, 'v1', null);
ok('revision format', rev.format === 'accelon26-revision/1');
ok('revision page count', rev.pages.length === 1);
ok('revision old lines kept', JSON.stringify(rev.pages[0].oldLines) === JSON.stringify(old0));
ok('revision parent', rev.parent === null);
discardAll(s);
ok('discardAll', !pageEditAt(s, 0, 3));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
