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
const rawLines = text.split('\n');
while (rawLines.length && rawLines[rawLines.length - 1] === '') rawLines.pop();

/**
 * 一行最多 4,000 字（作者 2026-10-29）。
 *
 * index-builder 的 `lines.physical` 是照 Delphi `addbuffer` 寫的：`len` 以
 * MAXLINELEN（8192 bytes = 4,096 字）截斷，但內文仍寫入整行。只要有一行超過，
 * 之後每一行的位移都會短少，行表與內文從此錯開——taisho 的 6,745,532 行裡只有
 * 第 4,479,231 行是 5,427 字，就造成後面 2.27M 行有 69,454 行斷在標籤內
 * （`<頁 id="63p967` 被切成兩行，閱讀器把它當文字顯示）。
 *
 * 所以打包前先把超長行切開：不切進 `<…>` 標籤，也不切開代理對（🙂 這種字）。
 */
const MAXCHARS = 4000;
function splitLongLine(line: string): string[] {
  if (line.length <= MAXCHARS) return [line];
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    let end = Math.min(line.length, i + MAXCHARS);
    if (end < line.length) {
      const lt = line.lastIndexOf('<', end - 1);
      if (lt >= i && line.indexOf('>', lt) >= end) end = lt;      // 退到標籤之前
      const hi = line.charCodeAt(end - 1);
      if (hi >= 0xd800 && hi <= 0xdbff) end--;                    // 不要切開代理對
      if (end <= i) end = Math.min(line.length, i + MAXCHARS);    // 保險
    }
    out.push(line.slice(i, end));
    i = end;
  }
  return out;
}
const lines = rawLines.flatMap(splitLongLine);
if (lines.length !== rawLines.length) console.error(`long lines split: ${lines.length - rawLines.length} extra line(s)`);

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
