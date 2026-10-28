#!/usr/bin/env bun
/**
 * 把說文小篆字型（BeiShiDaShuoWenXiaoZhuan-1.ttf）轉成每字一個 SVG，放進 adb 的 resources。
 *
 *   bun run ts/tools/seal-svg.ts --ttf <字型> --big5 <big5.tsv> --out <目錄> [--chars-from <adb 或 txt>]
 *
 * 為什麼要自己解 TTF：
 *   * 這個字型的 cmap 是 **Big5 碼**（0x8140、0x81A1…）塞進 platform 3/encoding 4，
 *     opentype.js 會直接判「No valid cmap sub-tables」，所以自己讀 cmap format 4，
 *     先用 Big5 對照表把 Unicode 換成碼，再查 gid。
 *   * 只需要 glyf 的二次曲線 → SVG path，用不到 kerning / GSUB / hinting。
 *
 * 產出：
 *   <out>/<name>.svg      每個字一個檔（name 預設是 U+XXXX）
 *   <out>/../seal-manifest.tsv  name → 字
 */
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const TTF = resolve(opt('ttf', 'D:/2026/swjzz/BeiShiDaShuoWenXiaoZhuan-1.ttf'));
const BIG5 = resolve(opt('big5', 'D:/2026/swjzz/big5.tsv'));
const OUT = resolve(opt('out', 'D:/2026/swjzz/build/seal'));
const FROM = opt('chars-from', '');
const PREFIX = opt('prefix', 'seal/');

const buf = readFileSync(TTF);
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

// ── sfnt 目錄 ────────────────────────────────────────────────────────────
const tables: Record<string, { off: number; len: number }> = {};
for (let i = 0, n = dv.getUint16(4); i < n; i++) {
  const o = 12 + i * 16;
  const name = String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3]);
  tables[name] = { off: dv.getUint32(o + 8), len: dv.getUint32(o + 12) };
}
const upem = dv.getUint16(tables.head.off + 18);
const longLoca = dv.getInt16(tables.head.off + 50) === 1;
const numGlyphs = dv.getUint16(tables.maxp.off + 4);

// ── cmap (format 4，Big5 碼) ─────────────────────────────────────────────
const cmapOff = tables.cmap.off + dv.getUint32(tables.cmap.off + 8);   // 第一筆編碼記錄的 offset（cmap 開頭 + offset）
const segX2 = dv.getUint16(cmapOff + 6);
const seg = segX2 / 2;
const endO = cmapOff + 14;
const startO = endO + segX2 + 2;
const deltaO = startO + segX2;
const rangeO = deltaO + segX2;

function gidOfCode(code: number): number {
  let lo = 0, hi = seg - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const end = dv.getUint16(endO + mid * 2);
    if (code > end) { lo = mid + 1; continue; }
    const start = dv.getUint16(startO + mid * 2);
    if (code < start) { hi = mid - 1; continue; }
    const delta = dv.getInt16(deltaO + mid * 2);
    const ro = dv.getUint16(rangeO + mid * 2);
    if (ro === 0) return (code + delta) & 0xffff;
    const gi = rangeO + mid * 2 + ro + (code - start) * 2;
    const g = dv.getUint16(gi);
    return g ? (g + delta) & 0xffff : 0;
  }
  return 0;
}

// ── loca / glyf ─────────────────────────────────────────────────────────
function glyphRange(gid: number): [number, number] {
  const loca = tables.loca.off;
  const a = longLoca ? dv.getUint32(loca + gid * 4) : dv.getUint16(loca + gid * 2) * 2;
  const b = longLoca ? dv.getUint32(loca + (gid + 1) * 4) : dv.getUint16(loca + (gid + 1) * 2) * 2;
  return [tables.glyf.off + a, tables.glyf.off + b];
}

interface Pt { x: number; y: number; on: boolean }

/** 取一個字形的輪廓（含 composite 遞迴），座標是字型單位（y 向上）。 */
function outline(gid: number, depth = 0): Pt[][] {
  if (depth > 5 || gid <= 0 || gid >= numGlyphs) return [];
  const [start, end] = glyphRange(gid);
  if (end <= start) return [];
  let p = start;
  const nContours = dv.getInt16(p); p += 2;
  p += 8;                                   // xMin yMin xMax yMax
  if (nContours >= 0) {
    const ends: number[] = [];
    for (let i = 0; i < nContours; i++) { ends.push(dv.getUint16(p)); p += 2; }
    const instrLen = dv.getUint16(p); p += 2 + instrLen;
    const nPts = nContours ? ends[nContours - 1] + 1 : 0;
    const flags: number[] = [];
    while (flags.length < nPts) {
      const f = dv.getUint8(p++);
      flags.push(f);
      if (f & 8) {
        let r = dv.getUint8(p++);
        while (r-- > 0) flags.push(f);
      }
    }
    const xs: number[] = [];
    let x = 0;
    for (const f of flags) {
      if (f & 2) { const d = dv.getUint8(p++); x += f & 16 ? d : -d; }
      else if (!(f & 16)) { x += dv.getInt16(p); p += 2; }
      xs.push(x);
    }
    const ys: number[] = [];
    let y = 0;
    for (const f of flags) {
      if (f & 4) { const d = dv.getUint8(p++); y += f & 32 ? d : -d; }
      else if (!(f & 32)) { y += dv.getInt16(p); p += 2; }
      ys.push(y);
    }
    const out: Pt[][] = [];
    let s = 0;
    for (const e of ends) {
      const c: Pt[] = [];
      for (let i = s; i <= e; i++) c.push({ x: xs[i], y: ys[i], on: (flags[i] & 1) !== 0 });
      if (c.length) out.push(c);
      s = e + 1;
    }
    return out;
  }
  // composite
  const out: Pt[][] = [];
  for (;;) {
    const flags = dv.getUint16(p); p += 2;
    const g2 = dv.getUint16(p); p += 2;
    let dx: number, dy: number;
    if (flags & 1) { dx = dv.getInt16(p); dy = dv.getInt16(p + 2); p += 4; }
    else { dx = dv.getInt8(p); dy = dv.getInt8(p + 1); p += 2; }
    let a = 1, b = 0, c2 = 0, d = 1;
    const f2 = (v: number) => v / 16384;
    if (flags & 8) { a = d = f2(dv.getInt16(p)); p += 2; }
    else if (flags & 0x40) { a = f2(dv.getInt16(p)); d = f2(dv.getInt16(p + 2)); p += 4; }
    else if (flags & 0x80) {
      a = f2(dv.getInt16(p)); b = f2(dv.getInt16(p + 2));
      c2 = f2(dv.getInt16(p + 4)); d = f2(dv.getInt16(p + 6)); p += 8;
    }
    for (const cont of outline(g2, depth + 1)) {
      out.push(cont.map((pt) => ({ x: a * pt.x + c2 * pt.y + dx, y: b * pt.x + d * pt.y + dy, on: pt.on })));
    }
    if (!(flags & 0x20)) break;
  }
  return out;
}

/** 輪廓 → SVG path（二次曲線；y 已翻成 SVG 座標）。 */
function toPath(contours: Pt[][]): string {
  const f = (n: number) => Math.round(n);
  const Y = (y: number) => upem - y;
  let d = '';
  for (const c of contours) {
    if (c.length < 2) continue;
    // 找一個 on-curve 起點；全是 off-curve 就取第一個中點
    let startIdx = c.findIndex((p) => p.on);
    let startPt: { x: number; y: number };
    if (startIdx < 0) {
      const a = c[0], b = c[1 % c.length];
      startPt = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      startIdx = 0;
      c.splice(0, 0, { ...startPt, on: true });
    } else {
      startPt = { x: c[startIdx].x, y: c[startIdx].y };
    }
    d += `M${f(startPt.x)} ${f(Y(startPt.y))}`;
    const n = c.length;
    let i = startIdx + 1;
    let guard = 0;
    while (i < startIdx + n + 1 && guard++ < n + 2) {
      const pt = c[i % n];
      const nxt = c[(i + 1) % n];
      if (pt.on) {
        d += `L${f(pt.x)} ${f(Y(pt.y))}`;
        i++;
      } else {
        const end = nxt.on ? nxt : { x: (pt.x + nxt.x) / 2, y: (pt.y + nxt.y) / 2 };
        d += `Q${f(pt.x)} ${f(Y(pt.y))} ${f(end.x)} ${f(Y(end.y))}`;
        i += nxt.on ? 2 : 1;
      }
    }
    d += 'Z';
  }
  return d;
}

function svgFor(ch: string): { svg: string; gid: number } | null {
  const code = big5Of(ch.codePointAt(0)!);
  if (!code) return null;
  const gid = gidOfCode(code);
  if (!gid) return null;
  const contours = outline(gid);
  const path = toPath(contours);
  if (!path) return null;
  // 用字形自己的 bbox 當 viewBox（這套篆形常常超出 em 框，用 em 框會被切掉）
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const c of contours) for (const pt of c) {
    if (pt.x < x0) x0 = pt.x;
    if (pt.x > x1) x1 = pt.x;
    if (pt.y < y0) y0 = pt.y;
    if (pt.y > y1) y1 = pt.y;
  }
  if (!Number.isFinite(x0)) return null;
  const pad = 24;
  const w = Math.max(1, x1 - x0 + pad * 2);
  const h = Math.max(1, y1 - y0 + pad * 2);
  const vb = `${Math.round(x0 - pad)} ${Math.round(upem - y1 - pad)} ${Math.round(w)} ${Math.round(h)}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}">`
    + `<path d="${path}" fill="currentColor"/></svg>`;
  return { svg, gid };
}

// ── Big5 對照 ────────────────────────────────────────────────────────────
const big5 = new Map<number, number>();
for (const line of readFileSync(BIG5, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  const [cp, code] = line.split('\t').map((x) => parseInt(x, 16));
  if (Number.isFinite(cp) && Number.isFinite(code)) big5.set(cp, code);
}
function big5Of(cp: number): number | undefined { return big5.get(cp); }

// ── 要轉哪些字 ──────────────────────────────────────────────────────────
let chars: string[] = [];
if (FROM) {
  const text = readFileSync(FROM, 'utf8');
  chars = [...text];
} else {
  chars = [...big5.keys()].map((cp) => String.fromCodePoint(cp));
}
chars = [...new Set(chars)];
mkdirSync(OUT, { recursive: true });

let made = 0, miss = 0;
const manifest: string[] = [];
for (const ch of chars) {
  if ([...ch].length !== 1) continue;
  if (/[\u0000-\u007F\u3000-\u303F\uFF00-\uFFEF]/.test(ch)) continue;   // 標點與 ASCII 不做
  const r = svgFor(ch);
  if (!r) { miss++; continue; }
  const name = 'U' + ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0');
  writeFileSync(`${OUT}/${name}.svg`, r.svg, 'utf8');
  manifest.push(`${name}\t${ch}\t${r.gid}\t${PREFIX}${name}.svg`);
  made++;
}
writeFileSync(`${OUT}/../seal-manifest.tsv`, manifest.join('\n') + '\n', 'utf8');
console.log(`字型 ${TTF}  upem ${upem}  glyphs ${numGlyphs}`);
console.log(`轉出 ${made} 個 SVG、字型沒有 ${miss} 個（共試 ${chars.length}）`);
console.log(`wrote ${OUT}/*.svg + ../seal-manifest.tsv`);
