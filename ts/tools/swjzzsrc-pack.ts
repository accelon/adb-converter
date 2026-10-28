/**
 * 把 swjzzsrc2adb.ts 產生的文字打包成 `swjzzsrc.adb`（說文解字注引用書目）。
 *
 *   bun run ts/tools/swjzzsrc-pack.ts <text.txt> <out.adb>
 *
 * 與 swjz-pack 的差別：
 *   * 這是一本「很多書」的語料庫：第一層是 `<書>`，所以目錄樹宣告 `s="*" t="書"`。
 *   * 仍然有 `$字`（說文解字的字頭）→ 會被當成詞典型 adb，`caches/字` 一定要齊。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { authorAdb } from '../src/adbauthor';

const [, , textFile, outFile] = process.argv;
if (!textFile || !outFile) {
  console.error('usage: bun run ts/tools/swjzzsrc-pack.ts <text.txt> <out.adb>');
  process.exit(2);
}

const DBNAME = 'swjzzsrc';
const DBCNAME = '說文解字注引用書目';

const VALID_TAGS = [
  '檔', '集', '隱', '樹',
  '書', '卷', '部', '篇', '字', '條',
  '說文', '反切', '徐鉉', '注',
];
const CACHED_TAGS = ['書', '卷', '部', '篇', '字'];

const text = readFileSync(textFile, 'utf8');
const lines = text.split('\n');
while (lines.length && lines[lines.length - 1] === '') lines.pop();
const over = lines.filter((l) => l.length * 2 > 8192);
if (over.length) {
  console.error(`${over.length} 行超過 4,096 字（MAXLINELEN），行表會錯位`);
  for (const l of over.slice(0, 5)) console.error('  ' + l.slice(0, 60) + '…');
  process.exit(1);
}

const t0 = Date.now();
const res = await authorAdb({
  dbname: DBNAME,
  dbcname: DBCNAME,
  lines,
  resources: [],
  dbtype: 2,
  validTags: VALID_TAGS,
  cachedTags: CACHED_TAGS,
  log: (m) => console.error(m),
});
writeFileSync(outFile, res.file);

const missing = VALID_TAGS.filter((t) => !res.tagNames.includes(t));
const extra = res.tagNames.filter((t) => !VALID_TAGS.includes(t) && !t.startsWith('/'));
console.error(`wrote ${basename(outFile)}: ${(res.file.length / 1048576).toFixed(2)} MiB, ${res.lines} lines, ` +
  `${res.tokens} tokens/${res.tokenHits} hits, ${res.tagNames.length} tags, ` +
  `${res.srcBlocks} src blocks, maxVA=${res.maxBlockOffset}, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.error('tags: ' + res.tagNames.join(' '));
console.error('caches: ' + res.cachedKeys.join(' '));
if (missing.length) console.error('WARN 沒有命中的標記: ' + missing.join(' '));
if (extra.length) console.error('WARN 意料外的標記: ' + extra.join(' '));
