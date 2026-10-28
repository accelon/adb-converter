/**
 * 把 swjz2adb.ts 產生的文字打包成 swjzz.adb（《說文解字注》，kanji-database 版）。
 *
 *   bun run ts/tools/swjz-pack.ts <text.txt> <out.adb>
 *
 * 與其他 pack 不同的只有三件事：
 *   1. `dbtype = 2`（DBTYPE_DICTIONARY）＋ `<集 c="isdict">`：accelon26 的「詞典」分頁會查它。
 *   2. `cachedTags` 一定要含 `字`：詞典查詢靠 `caches/字` 這張現成名稱表做二分搜尋，
 *      它與 `tags/字` 的命中數必須一樣多（所以 cache 要從第一個實例就開始）。
 *   3. `validTags` 只認轉換器自己會產生的標記；漏一個就會靜默少一批 tag hit，
 *      所以下面順便把實際 tag 表印出來比對。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { authorAdb } from '../src/adbauthor';

const [, , textFile, outFile, dbArg, dbcArg] = process.argv;
if (!textFile || !outFile) {
  console.error('usage: bun run ts/tools/swjz-pack.ts <text.txt> <out.adb> [dbname] [dbcname] [資源目錄]');
  process.exit(2);
}

const DBNAME = dbArg ?? 'swjzz';
const DBCNAME = dbcArg ?? '說文解字注';
/** 第 6 個參數：要放進 resources 的目錄（小篆 SVG），檔名會變成 `seal/<檔名>` */
const RES_DIR = process.argv[6] ?? '';

/** 轉換器會產生的全部標記（`<檔>`／`<集>`／`<隱>`／`<樹>` 也要在內）。 */
const VALID_TAGS = [
  '檔', '集', '隱', '樹',
  '卷', '節', '部', '部目', '字',
  '說文', '說文異', '段注', '篆', '注', '構形', '圖',
  '部數', '卷數', '篇末', '補遺', '作者', '出版',
];
/** 要快取的標記：`字`（詞條名稱表）＋目錄樹的三層名稱。 */
const CACHED_TAGS = ['字', '部', '卷', '節', '部目'];

/** 資源：`<資源目錄>/*.svg` → `seal/<檔名>`（與 seal-manifest.tsv 的名稱一致） */
const resources: { name: string; bytes: Buffer }[] = [];
if (RES_DIR) {
  const { readdirSync } = await import('node:fs');
  for (const f of readdirSync(RES_DIR).sort()) {
    if (!/\.svg$/i.test(f)) continue;
    resources.push({ name: `seal/${f}`, bytes: readFileSync(`${RES_DIR}/${f}`) });
  }
  console.error(`resources ${resources.length} 個（${RES_DIR}）`);
}

const text = readFileSync(textFile, 'utf8');
const lines = text.split('\n');
while (lines.length && lines[lines.length - 1] === '') lines.pop();
const over = lines.filter((l) => l.length * 2 > 8192);
if (over.length) {
  console.error(`${over.length} 行的長度超過 4,096 字（MAXLINELEN），行表會錯位：`);
  for (const l of over.slice(0, 5)) console.error('  ' + l.slice(0, 60) + '…');
  process.exit(1);
}

const t0 = Date.now();
const res = await authorAdb({
  dbname: DBNAME,
  dbcname: DBCNAME,
  lines,
  resources,
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
