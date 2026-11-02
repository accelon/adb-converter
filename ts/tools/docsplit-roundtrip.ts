/**
 * `docsplit` 格式的來回驗證（作者 2026-11-02）：算好的讀窗起點 → `encodePackedList`
 * → `decodePackedList` → 必須完全相同，並報告打包後的大小。
 *
 *   bun run tools/docsplit-roundtrip.ts [ys|yl38|ccc]
 *
 * 現有的 adb 都還沒有 `docsplit`（重建時才寫），所以順便確認「沒有就用當場算」那條路。
 */
import { AdbReader, SyncIO } from '../src/accelon26/adb';
import { VaPaMapper } from '../src/accelon26/vapa';
import { buildDocsplit, docsplitStarts, doclensOf, estimatePackedBytes } from '../src/accelon26/read-window';
import { encodePackedList } from '../src/accelon26/adb-bytes';
import { decodePackedList } from '../src/accelon26/adb';

const db = process.argv[2] ?? 'yl38';
const dir = db === 'ccc' ? 'D:/2026/sz/accelon26' : 'D:/accelon3';
/** 目錄節點用哪些標籤、深度多少（閱讀器用真正的樹；這裡用簡表） */
const SPEC: Record<string, [string, number][]> = {
  ys: [['書', 0], ['章', 1], ['節', 2], ['項', 3]],
  yl38: [['章', 0], ['節', 1]],
  ccc: [['書', 0], ['小節', 1], ['塊', 2]],
};

const r = await AdbReader.open(new SyncIO(`${dir}/${db}.adb`));
const m = new VaPaMapper(r);
await m.init();
const tagsC = r.containers.get('tags');
const nodes: { va: number; depth: number }[] = [];
for (const [tag, depth] of SPEC[db] ?? [['書', 0]]) {
  const ti = tagsC?.names.indexOf(tag) ?? -1;
  if (ti < 0) continue;
  for (const va of await r.decodeBlockList('tags', ti)) nodes.push({ va, depth });
}

const t0 = performance.now();
const { starts } = await buildDocsplit(r, m, nodes, { lens: false });
const ms = performance.now() - t0;
const packed = encodePackedList(starts);
const back = decodePackedList(packed);
const same = JSON.stringify(back) === JSON.stringify(starts);
const lens = starts.map((v, i) => (starts[i + 1] ?? r.header.lineCount) - v);

console.log(`${db}：行 ${r.header.lineCount.toLocaleString()}、節點 ${nodes.length} → 讀窗 ${starts.length}`);
console.log(`docsplit：encode ${packed.length} bytes（估算 ${estimatePackedBytes(starts)}）→ 解回 ${back.length} 個，完全相同=${same}`);
console.log(`doclens（每窗行數，示範用）：約 ${estimatePackedBytes(lens)} bytes`);
console.log(`計算時間 ${(ms / 1000).toFixed(1)} 秒；前 8 窗起點 ${starts.slice(0, 8).join(', ')}`);
console.log(`現有 adb 沒有 docsplit=${(await docsplitStarts(r)) === null}、沒有 doclens=${(await doclensOf(r)) === null}（重建時才寫）`);
if (!same) process.exit(1);
