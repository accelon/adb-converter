import { openAdb } from './engine';
import { writeFileSync } from 'node:fs';

const db = await openAdb('D:/accelon3/cyd.adb');
const re = /<詞[^>]*>([^<]{4})<\/詞>/g;
const seen = new Set<string>();
for (let i = 0; i < db.lines; i++) {
  const s = await db.raw(i);
  let m;
  while ((m = re.exec(s))) {
    const w = m[1];
    if (/^[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]{4}$/.test(w)) seen.add(w);
  }
}
const arr = [...seen].sort();
writeFileSync('D:/2026/bigram/out/cyd_idioms.txt', arr.join('\n') + '\n', 'utf8');
console.log('idioms', arr.length);
