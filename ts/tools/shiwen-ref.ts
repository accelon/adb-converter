#!/usr/bin/env bun
/**
 * 把 shuowen.org 的《說文解字》開放資料（一字一 JSON）整理成一份比對用的參考表。
 *
 *   bun run ts/tools/shiwen-ref.ts <data目錄> <out.json>
 *
 * 例：
 *   bun run ts/tools/shiwen-ref.ts D:\2026\swjzz\src\shuowen-master\data D:\2026\swjzz\build\shiwen-ref.json
 *
 * 產出兩份工具都會用：
 *   * `swjz2adb.ts --ref`：逐條核對段注本的說文片段，核不到就標 `<說文異>`
 *   * `swjzzsrc2adb.ts`：建引用書目裡的「說文解字（大徐本）」
 */
import { buildShiwenRef, saveShiwenRef } from '../src/swjz-ref';

const [, , dataDir, outPath] = process.argv;
if (!dataDir || !outPath) {
  console.error('usage: bun run ts/tools/shiwen-ref.ts <data目錄> <out.json>');
  process.exit(2);
}
const t0 = Date.now();
const { ref, files } = buildShiwenRef(dataDir);
saveShiwenRef(outPath, ref);
const heads = Object.keys(ref).length;
const vars = Object.values(ref).filter((e) => e.vars.length).length;
console.error(`wrote ${outPath}: ${files} 個 JSON、${heads} 個字頭（${vars} 條有重文）`
  + `、${((Date.now() - t0) / 1000).toFixed(1)}s`);
