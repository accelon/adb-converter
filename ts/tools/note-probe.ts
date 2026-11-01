/**
 * 一次性診斷：同一節重複的 `n`（yl38 每節都從 1 編號）→ `<釋 n>` 到底有幾條、各在哪一頁，
 * 以及「同頁優先」的挑法會挑到哪一條（作者 2026-11-01 的 hover／click 不一致）。
 *
 *   bun run tools/note-probe.ts --adb D:\accelon3\yl38.adb --n 45 --page yl38p24
 */
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { AdbReader, SyncIO } from '../src/accelon26/adb';
import { VaPaMapper } from '../src/accelon26/vapa';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const ADB = resolve(opt('adb', resolve(import.meta.dir, '../../accelon3/yl38.adb')));
const N = opt('n', '45');
const PAGE = opt('page', 'yl38p24');
if (!existsSync(ADB)) { console.error('missing ' + ADB); process.exit(2); }

const r = await AdbReader.open(new SyncIO(ADB));
const m = new VaPaMapper(r);
await m.init();

const tagsC = r.containers.get('tags')!;
const vasOf = async (tag: string): Promise<number[]> => {
  const ti = tagsC.names.indexOf(tag);
  return ti < 0 ? [] : (await r.decodeBlockList('tags', ti)).slice().sort((a, b) => a - b);
};
const mapOf = async (tag: string, attr: string): Promise<Map<string, number[]>> => {
  const ti = tagsC.names.indexOf(tag);
  const out = new Map<string, number[]>();
  const av = await r.attributeValues(attr);
  const vas = ti < 0 ? [] : await r.decodeBlockList('tags', ti);
  for (let k = 0; k < (av?.values.length ?? 0); k++) {
    const p = av!.pointers[k];
    if (((p >>> 24) & 0xff) !== ti) continue;
    const va = vas[(p & 0xffffff) - 1];
    if (va == null) continue;
    const arr = out.get(av!.values[k]);
    if (arr) arr.push(va); else out.set(av!.values[k], [va]);
  }
  for (const a of out.values()) a.sort((x, y) => x - y);
  return out;
};

const pagePairs: [number, string][] = [];
{
  const pi = tagsC.names.indexOf('頁');
  const av = await r.attributeValues('頁.id');
  const vas = await r.decodeBlockList('tags', pi);
  for (let k = 0; k < (av?.values.length ?? 0); k++) {
    const p = av!.pointers[k];
    if (((p >>> 24) & 0xff) !== pi) continue;
    const va = vas[(p & 0xffffff) - 1];
    if (va == null) continue;
    pagePairs.push([va, av!.values[k]]);
  }
  pagePairs.sort((a, b) => a[0] - b[0]);
}
const pageOf = (va: number): string => {
  let lo = 0, hi = pagePairs.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (pagePairs[mid][0] <= va) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans >= 0 ? pagePairs[ans][1] : '';
};
const lineOf = (va: number): number => {
  const v = m.linesVirtual;
  let lo = 0, hi = v.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (v[mid] <= va) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
};

const refs = await mapOf('註', '註.n');
const bodies = await mapOf('釋', '釋.n');
const refList = refs.get(N) ?? [];
const bodyList = bodies.get(N) ?? [];
console.log(`<註 n="${N}"> ${refList.length} 條：`);
for (const va of refList) console.log(`  va=${va} line=${lineOf(va)} page=${pageOf(va)}`);
console.log(`<釋 n="${N}"> ${bodyList.length} 條：`);
for (const va of bodyList) {
  const line = lineOf(va);
  const t = (await m.lineText(line)).replace(/<[^>]*>/g, '').slice(0, 40);
  console.log(`  va=${va} line=${line} page=${pageOf(va)}  ${t}`);
}

// 模擬 pickVa（同頁優先）：以 --page 那一頁的 <註> 為起點
const fromVa = refList.find((va) => pageOf(va) === PAGE) ?? refList[0];
if (fromVa === undefined) { console.log('沒有這個 n 的 <註>'); process.exit(0); }
const pg = pageOf(fromVa);
const same = bodyList.filter((v) => pageOf(v) === pg);
console.log(`\n起點：va=${fromVa} page=${pg}；同頁候選 ${same.length} 條`);
let lo = 0, hi = same.length - 1, at = -1;
while (lo <= hi) {
  const mid = (lo + hi) >> 1;
  if (same[mid] <= fromVa) { at = mid; lo = mid + 1; } else hi = mid - 1;
}
const picked = same.length ? (at + 1 < same.length ? same[at + 1] : same[same.length - 1]) : -1;
console.log(`pickVa(preferAfter) → ${picked}（line ${picked >= 0 ? lineOf(picked) : -1}, page ${picked >= 0 ? pageOf(picked) : ''}）`);
if (picked >= 0) console.log('  文字：' + (await m.lineText(lineOf(picked))).replace(/<[^>]*>/g, '').slice(0, 60));
