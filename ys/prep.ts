import { readFileSync, writeFileSync } from 'node:fs';

// 序文與附錄都放在 ys/ 目錄，重建時不再依賴 yinshun.adb
const readBlock = (p: string) =>
  readFileSync(p, 'utf8')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

const fw = readBlock('D:/2026/adb-converter/ys/ys-foreword.txt');
const app = readBlock('D:/2026/adb-converter/ys/appendix.txt');

const text = readFileSync('D:/2026/adb-converter/build/ys-text.txt', 'utf8');
const lines = text.split('\n');
if (lines[lines.length - 1] === '') lines.pop();
const header = lines[0];
const rest = lines.slice(1);
const out = [header, ...fw, ...rest, ...app].join('\n') + '\n';
writeFileSync('D:/2026/adb-converter/build/ys-text-full.txt', out);
console.log('foreword lines', fw.length, 'appendix lines', app.length, 'total', out.split('\n').length - 1);
