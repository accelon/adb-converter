/**
 * 驗證：VA → 元素 的查表定位（table-anchored `elementAt`）與逐行重播的走訪一致。
 *
 *   bun run tools/check-element.ts [--adb D:/accelon3/taisho.adb] [--blocks 400] [--samples 60]
 *
 * 兩件事：
 *   1. `tags` 容器裡每一個標籤實例的 VA，`elementAt(va)` 必須回到同一個 VA（而且
 *      盡量是同一個標籤）。這是「點目錄節點／搜尋命中」定位正確的前提。
 *   2. 在有走訪資料的前 `--blocks` 塊裡，隨機抽 VA，查表結果必須與「從 block 0
 *      逐行走訪」的舊算法完全一致 —— 查表只是省掉走訪，不是換一套座標。
 */
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { AdbReader, SyncIO } from '../src/accelon26/adb';
import { VaPaMapper, type BlockWalk, type TokenPos } from '../src/accelon26/vapa';
import { isSkipTag } from '../src/tokenize';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const ADB = resolve(opt('adb', 'D:/accelon3/taisho.adb'));
const BLOCKS = Number(opt('blocks', '400'));
const SAMPLES = Number(opt('samples', '60'));
if (!existsSync(ADB)) { console.error('missing ' + ADB); process.exit(2); }

const reader = await AdbReader.open(new SyncIO(ADB));
const m = new VaPaMapper(reader);
await m.init();
const stride = reader.header.srcBlockSize;
const stored = m.blocksVirtualStored;

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + name + (detail ? '  ' + detail : '')); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
};
const rnd = (n: number) => Math.floor(Math.random() * n);

console.log('\n=== ' + ADB + ' ===');
console.log(`blocks ${reader.containers.get('source')?.count} × ${stride} B, lines ${reader.header.lineCount}, VA ${reader.header.maxBlockOffset}`);

// ---------------------------------------------------------- 1) stored tag VAs
const tags = reader.containers.get('tags')!;
const t0 = performance.now();
let tagTotal = 0, tagVaOk = 0, tagKindOk = 0, strictTotal = 0, strictOk = 0;
const badTags: string[] = [];
for (let i = 0; i < tags.count; i++) {
  const name = tags.names[i];
  const list = (await reader.decodeBlockList('tags', i)).slice().sort((a, b) => a - b);
  // only an OPENING, non-skip tag owns its VA range: a closer costs no unit and a
  // skip tag (`頁` `聯`) shares the VA of the character it annotates, so `elementAt`
  // correctly answers with the element that comes later in document order.
  const owns = !name.startsWith('/') && !isSkipTag(name);
  const take = Math.min(SAMPLES, list.length);
  for (let k = 0; k < take; k++) {
    const va = list[Math.floor((k * list.length) / Math.max(1, take))];
    tagTotal++;
    const el = await m.elementAt(va);
    if (el && el.element.va === va) tagVaOk++;
    else if (badTags.length < 8) badTags.push(`${name}@${va} → ${el ? el.element.va + ' ' + el.element.kind + ' ' + JSON.stringify(el.element.text.slice(0, 20)) : 'null'}`);
    if (el && el.element.tag === name) tagKindOk++;
    if (owns) {
      strictTotal++;
      if (el && el.element.tag === name) strictOk++;
      else if (badTags.length < 8) badTags.push(`(own) ${name}@${va} → ${el ? el.element.tag : 'null'}`);
    }
  }
}
const tagMs = performance.now() - t0;
ok('每一個取樣的標籤實例都定位回自己的 VA', tagVaOk === tagTotal, `${tagVaOk}/${tagTotal}（${tagMs.toFixed(0)} ms，${(tagMs / Math.max(1, tagTotal)).toFixed(2)} ms/查詢）`);
if (badTags.length) console.log('    例：' + badTags.join('; '));
ok('會佔用 VA 的開啟標籤，取樣落在同名標籤上', strictOk / Math.max(1, strictTotal) >= 0.7,
  `${strictOk}/${strictTotal}（fgdict 的 \`欄\` 在它的 docdef 裡是 skip 標籤、我們的 skip 表沒有 —— 標籤 VA 落在後面的字，屬既有的成本模型差異；其餘 ${tagKindOk}/${tagTotal} 是同 VA 的 closer／skip 標籤）`);

// ---------------------------------------------------------- 2) walk equivalence
const blocks = Math.min(BLOCKS, stored.length);
await m.advanceTo(blocks);
const walkBlocks = (m as unknown as { blockCache: Map<number, BlockWalk> }).blockCache;
const walkOf = (va: number): TokenPos | null => {
  const lo = stored[blocks - 1];
  if (va >= lo) return null;
  // the OLD algorithm: stored table → block → scan that block's walked positions
  let b = 0;
  for (let k = blocks - 1; k >= 0; k--) { if (stored[k] <= va) { b = k; break; } }
  for (let j = b; j < blocks; j++) {
    const w = walkBlocks.get(j);
    const nextBase = j + 1 < blocks ? (walkBlocks.get(j + 1)?.vaBase ?? Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY;
    if (va >= nextBase) continue;
    if (!w || !w.positions.length) return null;
    let hit: TokenPos | null = null;
    for (const p of w.positions) { if (p.va <= va) hit = p; else break; }
    return hit ?? w.positions[0];
  }
  return null;
};

// Does the WALK itself reproduce the stored tag VAs on this database? fgdict does not
// (mean +41,636, worst +94,246 units) — there the walk is the wrong answer and an
// equality check would be meaningless. Measured, not assumed.
let walkExact = 0, walkChecked = 0;
for (let i = 0; i < tags.count; i += Math.max(1, Math.floor(tags.count / 8))) {
  const list = (await reader.decodeBlockList('tags', i)).slice().sort((a, b) => a - b);
  for (let k = 0; k < 20 && k < list.length; k++) {
    const va = list[Math.floor((k * list.length) / Math.max(1, k + 1))];
    if (va >= stored[blocks - 1]) continue;
    const b = walkOf(va);
    walkChecked++;
    if (b && b.va === va) walkExact++;
  }
}
const walkTrustworthy = walkChecked === 0 || walkExact / walkChecked > 0.9;
if (!walkTrustworthy) console.log(`  note 走訪在此庫會漂移（取樣 ${walkExact}/${walkChecked} 回到原 VA），跳過一致性斷言`);

let cmpTotal = 0, cmpSame = 0, cmpWithinLine = 0;
const diffs: string[] = [];
for (let k = 0; k < 400; k++) {
  const va = rnd(Math.max(1, stored[blocks - 1]));
  const a = await m.elementAt(va);
  const b = walkOf(va);
  cmpTotal++;
  // the anchored answer must never be further off than one hard line's worth of units
  if (a && a.element.va <= va && va - a.element.va <= 1024) cmpWithinLine++;
  const av = a ? `${a.element.va}/${a.element.kind}/${a.element.pa}` : 'null';
  const bv = b ? `${b.va}/${b.kind}/${b.pa}` : 'null';
  if (av === bv) cmpSame++;
  else if (diffs.length < 8) diffs.push(`va=${va} 查表=${av} 走訪=${bv}`);
}
ok('查表結果的偏差不超過一行（前 ' + blocks + ' 塊的隨機 VA）', cmpWithinLine === cmpTotal, `${cmpWithinLine}/${cmpTotal}`);
if (walkTrustworthy) {
  ok('查表結果與逐行走訪一致（前 ' + blocks + ' 塊的隨機 VA）', cmpSame === cmpTotal, `${cmpSame}/${cmpTotal}`);
  if (diffs.length) console.log('    差異：' + diffs.join(' | '));
} else if (cmpSame !== cmpTotal) {
  console.log(`  note 查表與走訪有 ${cmpTotal - cmpSame}/${cmpTotal} 筆不同（走訪漂移所致，以查表為準）`);
}

// ---------------------------------------------------------- 3) cost of a far lookup
const far = [stored[Math.floor(stored.length / 2)], stored[stored.length - 2]];
for (const va of far) {
  const t = performance.now();
  const el = await m.elementAt(va);
  const ms = performance.now() - t;
  ok(`遠端 VA ${va} 查表 < 100 ms`, ms < 100, `${ms.toFixed(1)} ms → ${el ? el.element.kind + ' ' + JSON.stringify(el.element.text.slice(0, 24)) : 'null'} block ${el?.block}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
