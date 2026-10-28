/**
 * 一次性：從 yinshun.adb 取出五篇舊版卷首資料（保留原有分行），寫成 ys/appendix.txt。
 * 之後重建只看這份檔案，不再需要 yinshun.adb。
 */
import { AdbReader, BlobIO } from '../ts/src/accelon26/adb';
import { readAllLines } from '../ts/src/accelon26/rebuild-browser';

const r = await AdbReader.open(new BlobIO(Bun.file('D:/accelon3/yinshun.adb')));
const lines = await readAllLines(r);

const start = lines.findIndex((l) => l.startsWith('<檔') && l.includes('yinshunfoundation'));
if (start < 0) throw new Error('no yinshunfoundation 檔');
const endTag = lines.findIndex((l, i) => i > start && l.startsWith('</檔>'));
const body = lines.slice(start, endTag < 0 ? undefined : endTag);

// drop the 檔/書 header of the donor, keep everything from the first <頁> on
const firstPage = body.findIndex((l) => l.startsWith('<頁 '));
if (firstPage < 0) throw new Error('no <頁>');
const pages = body.slice(firstPage).map((l) => l.trimEnd());

const head = [
  '<檔 n="appendix.xml">',
  '<書 l="附錄" t="章,節." id="99">附錄（舊版卷首資料）</書>',
  '<卷 n="1">1</卷>',
  '<頁元 n="附錄" t="頁.">舊版卷首</頁元>',
];
const out = [...head, ...pages];
while (out.length && out[out.length - 1] === '') out.pop();
const over = out.map((l, i) => [i, l.length]).filter(([, n]) => n > 4000);
console.log('lines', out.length, 'max', Math.max(...out.map((l) => l.length)), 'over4000', over.length, over.slice(0, 5));
await Bun.write('D:/2026/adb-converter/ys/appendix.txt', out.join('\n') + '\n');
