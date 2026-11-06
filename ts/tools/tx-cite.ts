/**
 * tx-cite.ts — 只改 tx.adb 檔頭 `<引>` 的引用格式，其餘原樣重建
 *
 *   bun run ts/tools/tx-cite.ts [--src D:/accelon3/tx.adb] [--out build/tx.adb]
 *
 * 背景（作者 2026-11-06）：`<引>` 目前是「(太虛大師全書 $*頁;)」，複製引用會變成
 * 「(太虛大師全書 19p226)」。改成「($URL;)」後，閱讀器複製引用是 `(tx?19p226#12-34)`。
 * `<摘要頭>` 不動。
 *
 * 原始 `build/taixu-original.adb` 已不在工作區，所以用現有的 `tx.adb` 當來源：
 * 文字、頁 id、<聯>、資源全部照原樣，只換檔頭那一行後重新打包。
 */
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AdbReader, SyncIO } from '../src/accelon26/adb';
import { authorAdb } from '../src/adbauthor';
import { readAdbText } from '../src/adbtext';

const args = process.argv.slice(2);
const opt = (n: string, d = ''): string => {
  const i = args.indexOf('--' + n);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};
const ROOT = resolve(import.meta.dir, '../..');
const SRC = resolve(opt('src', 'D:/accelon3/tx.adb'));
const OUT = resolve(opt('out', resolve(ROOT, 'build/tx.adb')));
const FROM = '(太虛大師全書 $*頁;)';
const TO = '($URL;)';

if (!existsSync(SRC)) {
  console.error('找不到來源：' + SRC);
  process.exit(2);
}

const adb = readAdbText(SRC);
const lines = adb.lines.slice();
let patched = 0;
for (let i = 0; i < lines.length; i++) {
  if (!lines[i].includes('<引>') || !lines[i].includes(FROM)) continue;
  lines[i] = lines[i].replace(FROM, TO);
  patched++;
  break;
}
if (!patched) {
  console.error('檔頭 <引> 找不到「' + FROM + '」，沒有改。');
  process.exit(1);
}
console.log('檔頭 <引> → ' + TO);

const r = await AdbReader.open(new SyncIO(SRC));
const h = r.header;
const resC = r.containers.get('resources');
const resources: { name: string; bytes: Buffer }[] = [];
if (resC) {
  for (let i = 0; i < resC.count; i++) {
    resources.push({ name: resC.names[i], bytes: Buffer.from(await r.readBlock('resources', i)) });
  }
}
const cachedTags = (r.containers.get('caches')?.names ?? []).slice();
const srcTags = (r.containers.get('tags')?.names ?? []).slice();
const validTags = [...new Set([...srcTags.filter((n) => !n.startsWith('/')), '聯'])];
const closeSet = new Set(srcTags.filter((n) => n.startsWith('/')).map((n) => n.slice(1)));
const dualSelfClosingTags: string[] = [];
for (const t of srcTags.filter((n) => !n.startsWith('/'))) {
  if (!closeSet.has(t)) continue;
  const selfRe = new RegExp(`<${t}(?=[\\s/>])[^>]*/>`);
  let hasSelf = false, hasClose = false;
  for (const line of lines) {
    if (!hasSelf && selfRe.test(line)) hasSelf = true;
    if (!hasClose && line.includes(`</${t}>`)) hasClose = true;
    if (hasSelf && hasClose) break;
  }
  if (hasSelf && !hasClose) dualSelfClosingTags.push(t);
}
const out = await authorAdb({
  dbname: h.dbname,
  dbcname: h.dbcname,
  dbtype: h.dbType,
  features: h.features,
  srcBlockSize: h.srcBlockSize,
  lines,
  resources,
  cachedTags,
  dualSelfClosingTags,
  validTags,
  log: (m) => console.error(m),
});
writeFileSync(OUT, Buffer.from(out.file));
console.log(`打包 ${OUT}（${(out.file.length / 1048576).toFixed(2)} MiB，${out.lines} 行）`);
r.close?.();

const chk = await AdbReader.open(new SyncIO(OUT));
const pageAttr = await chk.attributeValues('頁.id');
const iAttr = await chk.attributeValues('聯.i');
console.log(`驗收：頁.id ${pageAttr?.values.length ?? 0}、聯.i ${iAttr?.values.length ?? 0}`);
chk.close?.();
