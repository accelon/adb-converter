/**
 * 把 k2adb 產生的高麗藏文字打包成 goryeo.adb。
 *
 *   bun run ts/tools/goryeo-pack.ts <text.txt> <out.adb> [logo.png]
 *
 * 2026-10-30 起對照表不再內嵌在這裡：它已抽成獨立的 `goryeo_taisho.adb`
 * （見 goryeo-taisho-pack.ts），所以 goryeo.adb 只剩經文，換版時不必重下
 * 2.2 MiB 的對照表。accelon3／accelon26 讀取、檢索都不受影響。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { authorAdb } from '../src/adbauthor';

const [, , textFile, outFile, logoPath] = process.argv;
if (!textFile || !outFile) {
  console.error('usage: bun run ts/tools/goryeo-pack.ts <text.txt> <out.adb> [logo.png]');
  process.exit(2);
}

const text = readFileSync(textFile, 'utf8');
const lines = text.split('\n');
while (lines.length && lines[lines.length - 1] === '') lines.pop();

const resources = [];
if (logoPath && existsSync(logoPath)) {
  resources.push({ name: 'goryeo_logo.png', bytes: readFileSync(logoPath) });
}

const t0 = Date.now();
const res = await authorAdb({
  dbname: 'goryeo',
  dbcname: '高麗大藏經',
  lines,
  resources,
  dbtype: 4,
  log: (m) => console.error(m),
});
writeFileSync(outFile, res.file);
console.error(
  `wrote ${basename(outFile)}: ${(res.file.length / 1048576).toFixed(1)} MiB, ${res.lines} lines, ` +
    `${res.tokens} tokens/${res.tokenHits} hits, ${res.tagNames.length} tags, ` +
    `${((Date.now() - t0) / 1000).toFixed(1)}s`,
);
