#!/usr/bin/env bun
/**
 * 對照表的「文字級」驗證（2026-10-30）。
 *
 *   cd ts && bun run tools/map-check.ts [--n 40] [--goryeo ../build/goryeo.adb]
 *                                      [--taisho D:/accelon3/taisho.adb]
 *
 * 做法：抽 N 卷，在正文中段取一個漢字位移，用對照表換到另一側，然後把兩側
 * 「那一頁那一欄」的漢字從頁標記起算，比對來源位置之後的 8 個字是否出現在
 * 目標欄裡（異體字折疊後比對）。這正是 UI 的 addressAtLine 走的路：
 * 頁／欄 + 欄內第幾個漢字。
 *
 * 這一項驗的是「換址把人帶到對的頁與欄」——圖版網址需要的精度。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AdbReader } from '../src/accelon26/adb';
import { PosMap, decodeAlign, lineIndexAt, mapOffset, mapOffsetRev, type Address, type Side } from '../src/accelon26/posmap';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const ROOT = resolve(import.meta.dir, '../..');
const N = Number(opt('n', '40'));
const GORYEO = resolve(opt('goryeo', resolve(ROOT, 'build/goryeo.adb')));
const TAISHO = resolve(opt('taisho', 'D:/accelon3/taisho.adb'));
const MAP = resolve(opt('map', resolve(ROOT, 'build/goryeo_taisho.adb')));

const HAN = /[\u3400-\u9fff\uf900-\ufaff]/;
const COL = 'abcdefg';
const hanChars = (s: string) => [...s.replace(/<[^>]*>/g, '')].filter((c) => HAN.test(c));
const FOLD: Record<string, string> = {
  眞: '真', 峯: '峰', 陁: '陀', 恱: '悦', 敎: '教', 卽: '即', 衆: '眾', 爲: '為',
  著: '着', 麁: '粗', 隣: '鄰', 淨: '净', 淸: '清', 牀: '床', 閒: '閑', 鉢: '缽',
};
const fold = (s: string) => [...s].map((c) => FOLD[c] ?? c).join('');

function ioFor(path: string) {
  const bytes = readFileSync(path);
  return { size: bytes.length, read: async (off: number, len: number) => new Uint8Array(bytes.buffer, bytes.byteOffset + off, len) };
}

interface SideReader { r: AdbReader; lp: number[]; lv: number[]; pageVa: Map<string, number> }

async function openSide(path: string): Promise<SideReader> {
  const r = await AdbReader.open(ioFor(path) as never);
  const av = await r.attributeValues('頁.id');
  const tc = r.containers.get('tags');
  const at = tc?.names.indexOf('頁') ?? -1;
  if (!av?.pointers || !tc || at < 0) throw new Error('no 頁 ids in ' + path);
  const vas = await r.decodeBlockList('tags', at);
  const pageVa = new Map<string, number>();
  for (let i = 0; i < av.values.length; i++) pageVa.set(av.values[i], vas[(av.pointers[i] & 0xffffff) - 1]);
  return { r, lp: await r.linesPhysical(), lv: await r.linesVirtual(), pageVa };
}

const lineStart = (s: SideReader, i: number) => (i > 0 ? s.lp[i - 1] : 0);
const lineText = (s: SideReader, i: number) => (i >= 0 && i < s.lp.length ? s.r.physicalText(lineStart(s, i), s.lp[i]) : Promise.resolve(''));

function lineOfVa(s: SideReader, va: number): number {
  // 與 VaPaMapper.lineOfVa 相同：line table 存的是每一行的「結尾 VA」
  let lo = 0, hi = s.lv.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (s.lv[m] < va) lo = m + 1; else hi = m; }
  let i = Math.min(lo, s.lv.length - 1);
  while (i + 1 < s.lv.length && va === s.lv[i]) i++;
  return i;
}

/** 頁標記那一行、這一欄的字從行內第幾個漢字開始 */
async function columnStart(s: SideReader, pageId: string): Promise<{ markLine: number; startHan: number } | null> {
  const va = s.pageVa.get(pageId);
  if (va == null) return null;
  const markLine = lineOfVa(s, va);
  const text = await lineText(s, markLine);
  const at = text.indexOf(`<頁 id="${pageId}"`);
  if (at < 0) return { markLine, startHan: 0 };
  const close = text.indexOf('>', at);
  const before = text.slice(0, at);
  const body = close >= 0 ? text.slice(close + 1) : '';
  const hanBefore = hanChars(before).length;
  const hanAfter = hanChars(body).length;
  const title = /<卷(?:\s[^>]*)?>([^<]*)<\/卷>\s*$/.exec(before);
  const juanHan = title ? hanChars(title[1]).length : 0;
  return { markLine, startHan: hanAfter > 0 ? hanBefore : Math.max(0, hanBefore - juanHan) };
}

/** 這一欄從頭開始 want 個漢字（遇到下一個頁標記就停） */
async function columnChars(s: SideReader, pageId: string, want: number, skip = 0): Promise<string> {
  const st = await columnStart(s, pageId);
  if (!st) return '';
  const out: string[] = [];
  for (let i = st.markLine; i < st.markLine + 60 && out.length < want + skip; i++) {
    const t = await lineText(s, i);
    if (i > st.markLine && /<頁 id="/.test(t)) break;
    const chars = hanChars(t);
    for (let j = i === st.markLine ? st.startHan : 0; j < chars.length && out.length < want + skip; j++) out.push(chars[j]);
  }
  return fold(out.slice(skip).join(''));
}

const mapR = await AdbReader.open(ioFor(MAP) as never);
const pm = PosMap.parse(await mapR.readBlock('align', 0));
const recs = (pm as unknown as { recs: { tsutra: string; tjuan: number; ksutra: string; kjuan: number; tvol: number; kvol: number; blob: Uint8Array }[] }).recs;
const T = await openSide(TAISHO);
const K = await openSide(GORYEO);

const pclOf = (seq: number) => {
  const rem = seq % 1000;
  return { page: (seq - rem) / 1000, col: Math.floor(rem / 100), line: rem % 100 };
};
const seqOf = (a: { page: number; col: number; line: number }) => a.page * 1000 + a.col * 100 + a.line;

function addressAt(side: Side, g: { vol: number; lineSeq: Int32Array; lineStart: Int32Array; nLines: number }, off: number): Address {
  const li = lineIndexAt(g as never, off);
  const p = pclOf(g.lineSeq[li]);
  return { side, vol: g.vol, page: p.page, col: p.col, line: p.line, off: Math.max(0, Math.min(off - g.lineStart[li], 999)) };
}

const step = Math.max(1, Math.floor(recs.length / N));
const picks: number[] = [];
for (let i = 0; i < recs.length; i += step) picks.push(i);
if (!picks.includes(0)) picks.unshift(0);

const DIR = (opt('dir', 'tk') === 'kt' ? 'kt' : 'tk') as 'tk' | 'kt';
const from = DIR === 'tk' ? { g: T, side: 'T' as Side, sIdx: 't' as const } : { g: K, side: 'K' as Side, sIdx: 'k' as const };
const to = DIR === 'tk' ? { g: K, side: 'K' as Side, sIdx: 'k' as const } : { g: T, side: 'T' as Side, sIdx: 't' as const };

let checked = 0, colOk = 0;
const bad: string[] = [];
for (const i of picks.slice(0, N)) {
  const rec = recs[i];
  const body = decodeAlign(rec.blob);
  const sg = body[from.sIdx];
  const dg = body[to.sIdx];
  if (!sg.nLines || !dg.nLines) continue;
  const bodyFrom = from.side === 'T' ? body.tBody : body.kBody;
  const x = Math.max(bodyFrom[0], Math.floor((bodyFrom[0] + bodyFrom[1]) / 2));
  const y = from.side === 'T' ? mapOffset(body.runs, x)[0] : mapOffsetRev(body.runs, x)[0];
  const aFrom = addressAt(from.side, sg, x);
  const aTo = addressAt(to.side, dg, y);
  // 來源位置在這一欄是第幾個漢字（幾何的欄首字元位移）
  const seq0 = seqOf({ page: aFrom.page, col: aFrom.col, line: 0 });
  let firstIdx = -1;
  for (let k = 0; k < sg.nLines; k++) if (sg.lineSeq[k] >= seq0) { firstIdx = k; break; }
  if (firstIdx < 0) continue;
  const colChar = x - sg.lineStart[firstIdx];
  const fromId = `${aFrom.vol}p${aFrom.page}${COL[aFrom.col]}`;
  const toId = `${aTo.vol}p${aTo.page}${COL[aTo.col]}`;
  const seg = (await columnChars(from.g, fromId, 8, Math.max(0, colChar))).slice(0, 8);
  const toCol = await columnChars(to.g, toId, 400);
  checked++;
  if (seg.length >= 4 && toCol.includes(seg)) colOk++;
  else bad.push(`${from.side}${aFrom.vol}p${aFrom.page}${COL[aFrom.col]}${aFrom.line}+${aFrom.off} (欄內 ${colChar}) ⇄ ${to.side}${aTo.vol}p${aTo.page}${COL[aTo.col]}${aTo.line}+${aTo.off}\n    來源: ${seg}\n    目標欄: ${toCol.slice(0, 44)}`);
}

console.log(`[${DIR}] checked ${checked} 卷：頁欄文字對上 ${colOk}（${((colOk / Math.max(1, checked)) * 100).toFixed(1)}%）`);
for (const b of bad.slice(0, 8)) console.log('  ' + b);
if (checked === 0 || colOk < checked * 0.9) { console.error('FAIL: 頁欄文字對照成功率 < 90%'); process.exit(1); }
console.log('ok: 換址落在正確的頁與欄（文字相符）');
