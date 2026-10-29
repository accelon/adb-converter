/**
 * 把 tei2adb 產生的文字（一行一個 adb 行）打包成 .adb。
 *
 *   bun run ts/tools/tei-pack.ts <text.txt> <out.adb> [dbname] [dbcname] [logo.png] [posmap.bin] [study-index.json]
 *
 * source / tokens / tags / tables / attributes / attributes.sorted / caches
 * 全部由 authorAdb 從文字重建（與 accelon3 的 indexer 同一個佈局）。
 * logo 會以 `<dbname>_logo.png` 的名稱放進 resources（reader 靠這個名字認庫的 logo）。
 * study-index.json 會放進 `study` 容器的 `index` block（study 型 adb 專用）。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { authorAdb } from '../src/adbauthor';
import { buildContainer, BO_NAMED, BO_UNICODE } from '../src/accelon26/adb-bytes';

const [, , textFile, outFile, dbname = 'taisho', dbcname = '大正新脩大藏經', logoPath = 'logo/taisho_logo.png', mapFile = 'build/posmap.bin', studyIndexFile = 'build/jingqun/study-index.json'] = process.argv;
if (!textFile || !outFile) {
  console.error('usage: bun run ts/tools/tei-pack.ts <text.txt> <out.adb> [dbname] [dbcname] [logo.png]');
  process.exit(2);
}

const text = readFileSync(textFile, 'utf8');
const lines = text.split('\n');
while (lines.length && lines[lines.length - 1] === '') lines.pop();

const resources = [];
if (existsSync(logoPath)) {
  resources.push({ name: `${dbname}_logo.png`, bytes: readFileSync(logoPath) });
  console.error(`logo ${logoPath} → ${dbname}_logo.png (${resources[0].bytes.length} bytes)`);
} else {
  console.error(`logo not found: ${logoPath} (skipped)`);
}

const extraContainers: Record<string, Uint8Array> = {};
if (mapFile && existsSync(mapFile)) {
  const mapBytes = new Uint8Array(readFileSync(mapFile));
  extraContainers.align = buildContainer({ feature: BO_NAMED, blocks: [mapBytes], names: ['posmap'], nameFeature: BO_UNICODE });
  console.error(`align ${(mapBytes.length / 1048576).toFixed(1)} MiB from ${mapFile}`);
}
if (dbname === 'study' && studyIndexFile && existsSync(studyIndexFile)) {
  const bytes = new Uint8Array(readFileSync(studyIndexFile));
  extraContainers.study = buildContainer({
    feature: BO_NAMED, blocks: [bytes], names: ['index'], nameFeature: BO_UNICODE,
  });
  console.error(`study index ${(bytes.length / 1024).toFixed(0)} KiB from ${studyIndexFile}`);
}

const t0 = Date.now();
const res = await authorAdb({
  dbname,
  dbcname,
  lines,
  resources,
  dbtype: 4,
  extraContainers,
  log: (m) => console.error(m),
});
writeFileSync(outFile, res.file);
console.error(
  `wrote ${basename(outFile)}: ${(res.file.length / 1048576).toFixed(1)} MiB, ${res.lines} lines, ` +
    `${res.tokens} tokens/${res.tokenHits} hits, ${res.tagNames.length} tags, ` +
    `${res.resources} resource(s) ${res.resourceBytes} bytes, ` +
    `maxVA=${res.maxBlockOffset}, ${((Date.now() - t0) / 1000).toFixed(1)}s`,
);
