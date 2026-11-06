import { openAdb } from './engine';
const db = await openAdb('manual.adb');
console.log(db.title, 'lines=' + db.lines, 'tags=' + db.tags.length);
const toc = await db.toc();
console.log('toc', toc.slice(0, 3));
const res = await db.search('表格', 3);
console.log('search', res.total, res.hits.map((h) => h.line));
console.log('line 131:', await db.line(131));
