/**
 * lc.adb 驗收：文字沒被鏈結改動、頁碼不變、caches 不變，
 * 以及每個 `<聯 i="taisho?頁碼" q="…">` 的頁碼存在、q 前 8 個漢字在那一頁。
 *
 *   bun run lc/validate.ts
 */
import { readFileSync } from 'node:fs';
import { readAdbText } from '../ts/src/adbtext';
import { AdbReader, SyncIO } from '../ts/src/accelon26/adb';
import { VaPaMapper } from '../ts/src/accelon26/vapa';

const ROOT = 'D:/2026/adb-converter';
const OLD = `${ROOT}/build/lc-base.adb`;
const NEW = `${ROOT}/build/lc.adb`;
const TAISHO = `${ROOT}/accelon3/taisho.adb`;

const oldT = readAdbText(OLD);
const newT = readAdbText(NEW);
const strip = (s: string): string => s.replace(/<[^>]*>/g, '');
console.log('lines', oldT.lines.length, newT.lines.length);
console.log('text same', strip(oldT.lines.join('\n')) === strip(newT.lines.join('\n')));
console.log('dbname', oldT.header.dbname, '->', newT.header.dbname, 'andtagid', oldT.header.andTagId, '->', newT.header.andTagId);
console.log('tags', oldT.tagNames.length, '->', newT.tagNames.length);

const oldR = await AdbReader.open(new SyncIO(OLD));
const newR = await AdbReader.open(new SyncIO(NEW));
const oa = await oldR.attributeValues('頁.id');
const na = await newR.attributeValues('頁.id');
console.log('頁.id', oa?.values.length, na?.values.length, oa?.values.every((v, i) => v === na?.values[i]) ? 'same' : 'DIFF');
const oc = oldR.containers.get('caches')!.names;
const nc = newR.containers.get('caches')!.names;
console.log('caches keys', oc.length, nc.length, JSON.stringify(oc) === JSON.stringify(nc) ? 'same' : 'DIFF');
for (const k of oc) {
  const a = await oldR.cachedStrings(k);
  const b = await newR.cachedStrings(k);
  if (a.length !== b.length || !a.every((v, i) => v === b[i])) console.log('  cache DIFF', k, a.length, b.length);
}

// 錨點驗證
const tr = await AdbReader.open(new SyncIO(TAISHO));
const tagC = tr.containers.get('tags')!;
const pv = Int32Array.from(await tr.decodeBlockList('tags', tagC.names.indexOf('頁')));
const ids = (await tr.attributeValues('頁.id'))!.values;
const idSet = new Set(ids);
const mapper = new VaPaMapper(tr);
await mapper.init();
const av = await newR.attributeValues('聯.i');
const qv = await newR.attributeValues('聯.q');
const isHan = (c: string): boolean => /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(c);
const han = (s: string): string => Array.from(s.replace(/<[^>]*>/g, '')).filter(isHan).join('');
let missPage = 0, qBad = 0, checked = 0;
for (let k = 0; k < (av?.values.length ?? 0); k++) {
  const v = av!.values[k];
  const p = v.slice(v.indexOf('?') + 1);
  if (!idSet.has(p)) { missPage++; continue; }
  const qh = han(qv?.values[k] ?? '');
  if (qh.length < 4) continue;
  const idx = ids.indexOf(p);
  const c = await mapper.context(pv[idx], 0, 1600);
  if (!han(c?.text ?? '').includes(qh.slice(0, 8))) {
    qBad++;
    if (qBad < 5) console.log('  q miss', p, qh.slice(0, 20));
  }
  checked++;
}
console.log('anchors', av?.values.length, 'checked', checked, 'missPage', missPage, 'qBad', qBad);

const text = readFileSync(`${ROOT}/build/lc-linked.txt`, 'utf8');
let bad = 0;
for (const line of text.split('\n')) {
  let d = 0;
  for (const m of line.matchAll(/<(\/?)聯\b[^>]*>/g)) d += m[1] ? -1 : 1;
  if (d !== 0) bad++;
}
console.log('unbalanced lines', bad);
let nested = 0;
for (const m of text.matchAll(/<聯[^>]*>(?:(?!<\/聯>)[\s\S])*?<聯/g)) nested++;
console.log('nested', nested);
process.exit(0);
