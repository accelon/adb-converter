import { readFileSync, writeFileSync } from 'node:fs';

// 序文與附錄都放在 ys/ 目錄，重建時不再依賴 yinshun.adb
const readBlock = (p: string) =>
  readFileSync(p, 'utf8')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

// 附錄的表格靠行首空格對齊，所以只去行尾空白，不 trim 行首
const readAppendix = (p: string) =>
  readFileSync(p, 'utf8')
    .split(/\r?\n/)
    .map((s) => s.replace(/\s+$/, ''))
    .filter((s) => s.trim().length > 0);

const fw = readBlock('D:/2026/adb-converter/ys/ys-foreword.txt');
const app = readAppendix('D:/2026/adb-converter/ys/appendix.txt');

const text = readFileSync('D:/2026/adb-converter/build/ys-text.txt', 'utf8');
const lines = text.split('\n');
if (lines[lines.length - 1] === '') lines.pop();
const header = lines[0];
const rest = lines.slice(1);
const out = [header, ...fw, ...rest, ...app].join('\n') + '\n';
writeFileSync('D:/2026/adb-converter/build/ys-text-full.txt', out);
console.log('foreword lines', fw.length, 'appendix lines', app.length, 'total', out.split('\n').length - 1);
