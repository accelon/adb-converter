/**
 * 把 k2adb 產生的高麗藏文字打包成 goryeo.adb，並把位置對照表放進 `align` 容器。
 *
 *   bun run ts/tools/goryeo-pack.ts <text.txt> <out.adb> <posmap.bin> [logo.png]
 *
 * 額外的 `align/posmap` 區塊存的是 posmap-dump.ts 產生的二進位索引；
 * accelon3 不認識這個容器，會直接忽略（閱讀、檢索照常）；只有 accelon26 會用它換址。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { authorAdb } from '../src/adbauthor';
import { buildContainer, BO_NAMED, BO_UNICODE } from '../src/accelon26/adb-bytes';

const [, , textFile, outFile, mapFile, logoPath] = process.argv;
if (!textFile || !outFile || !mapFile) {
  console.error('usage: bun run ts/tools/goryeo-pack.ts <text.txt> <out.adb> <posmap.bin> [logo.png]');
  process.exit(2);
}

const text = readFileSync(textFile, 'utf8');
const lines = text.split('\n');
while (lines.length && lines[lines.length - 1] === '') lines.pop();

const mapBytes = new Uint8Array(readFileSync(mapFile));
const align = buildContainer({
  feature: BO_NAMED,
  blocks: [mapBytes],
  names: ['posmap'],
  nameFeature: BO_UNICODE,
});

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
  extraContainers: { align },
  log: (m) => console.error(m),
});
writeFileSync(outFile, res.file);
console.error(
  `wrote ${basename(outFile)}: ${(res.file.length / 1048576).toFixed(1)} MiB, ${res.lines} lines, ` +
    `${res.tokens} tokens/${res.tokenHits} hits, ${res.tagNames.length} tags, ` +
    `align ${(mapBytes.length / 1048576).toFixed(1)} MiB, ` +
    `${((Date.now() - t0) / 1000).toFixed(1)}s`,
);
