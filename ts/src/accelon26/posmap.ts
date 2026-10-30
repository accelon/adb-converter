/**
 * 大正藏 ⇄ 高麗藏 字元級換址（accelon26 專用）。
 *
 * 資料來自 `goryeo_taisho.adb` 的 `align/posmap` 區塊（posmap-dump.ts 匯出）：
 * 每卷一筆 AlignBody，內含兩側的行幾何（lineSeq / lineStart）與 1:1 對應段（runs）。
 * 換址不需要文本：
 *
 *   位址 → 行索引 → 該卷漢字位移 → 對應段 → 另一側漢字位移 → 行 → 位址
 *
 * 這裡只依賴 adb 容器（`AdbReader.readBlock('align', 0)`），可在瀏覽器與 Bun 執行。
 * 區塊可以是原樣的 GYPOS2，也可以是 raw DEFLATE（GYPOSZ，1.8 MB）——`PosMap.parse`
 * 自己判別。
 */
import { inflateRaw } from '../inflate';

export type Side = "T" | "K";

export interface Address {
  side: Side;
  vol: number;
  page: number;
  col: number;
  line: number;
  off: number;
}

export interface SideGeom {
  vol: number;
  lineSeq: Int32Array;
  lineStart: Int32Array;
  nLines: number;
  han: number;
}

export interface AlignBody {
  t: SideGeom;
  k: SideGeom;
  tBody: Int32Array;
  kBody: Int32Array;
  tPre: number; tPost: number; kPre: number; kPost: number;
  runs: Int32Array;
  coarse: boolean;
}

export interface AlignRec extends AlignBody {
  tsutra: string; tjuan: number; ksutra: string; kjuan: number;
  tvol: number; kvol: number;
  tstart: number; tend: number; kstart: number; kend: number;
  tline: number; kline: number;
  blob: Uint8Array;
}

export interface ConvertResult {
  ok: boolean;
  input: string;
  t: Address | null;
  k: Address | null;
  tsutra: string; tjuan: number; ksutra: string; kjuan: number;
  exact: boolean;
  adjust: string;
  note: string;
}

// ---------------------------------------------------------------- 位址格式
const COL_LETTERS = "abcdefg";
const ADDR_RE = /^\s*([KTkt])\s*(\d{1,4})\s*p\s*(\d{1,4})\s*([a-gA-G])\s*(\d{1,4})\s*(?:\.\s*(\d{1,3}))?\s*$/;

export function parseAddress(s: string): Address | null {
  const m = ADDR_RE.exec(s);
  if (!m) return null;
  const digits = m[5];
  let line: number, off: number;
  if (m[6] !== undefined) { line = Number(digits); off = Number(m[6]); }
  else if (digits.length <= 2) { line = Number(digits); off = 0; }
  else { line = Number(digits.slice(0, 2)); off = Number(digits.slice(2)); }
  const a: Address = {
    side: m[1].toUpperCase() as Side,
    vol: Number(m[2]), page: Number(m[3]),
    col: m[4].toLowerCase().charCodeAt(0) - 97,
    line, off,
  };
  if (a.vol < 1 || a.page > 9999 || a.col < 0 || a.col > 6) return null;
  if (a.line < 0 || a.line > 99 || off < 0 || off > 999) return null;
  return a;
}

/**
 * 寬鬆位址輸入（給「對照」分頁與選取選單）：
 *
 *   T05p0002c0405   posmap 的完整寫法
 *   T5p2c           欄以內省略＝該欄第 1 行第 0 字
 *   T5p2c.5         點號後面是字內偏置
 *   5p2c            省略藏別（用 defaultSide）
 *   Tv01p0002       DIA 圖版 id（`v01` 是第一冊）
 *   K01p0001a0105
 */
const LOOSE_RE = /^\s*([KTkt])?\s*(?:[vV])?\s*(\d{1,3})\s*[pP]\s*(\d{1,4})\s*([a-gA-G])?\s*(\d{0,4})\s*(?:\.\s*(\d{1,3}))?\s*$/;

export function parseLooseAddress(input: string, defaultSide: Side = 'T'): Address | null {
  const m = LOOSE_RE.exec(input ?? '');
  if (!m) return null;
  const side = (m[1] ? m[1].toUpperCase() : defaultSide) as Side;
  const vol = Number(m[2]);
  const page = Number(m[3]);
  const col = m[4] ? m[4].toLowerCase().charCodeAt(0) - 97 : 0;
  const digits = m[5] ?? '';
  let line = 1, off = 0;
  if (m[6] !== undefined) { line = digits ? Number(digits) : 1; off = Number(m[6]); }
  else if (digits.length === 0) { line = 1; off = 0; }
  else if (digits.length <= 2) { line = Number(digits); off = 0; }
  else { line = Number(digits.slice(0, 2)); off = Number(digits.slice(2)); }
  if (vol < 1 || vol > 999 || page < 1 || page > 9999) return null;
  if (col < 0 || col > 6 || line < 0 || line > 99 || off < 0 || off > 999) return null;
  return { side, vol, page, col, line, off };
}

/** seq（page*1000+col*100+line）→ 位址。 */
export function addressOfSeq(side: Side, vol: number, seq: number, off = 0): Address {
  const rem = seq % 1000;
  return { side, vol, page: (seq - rem) / 1000, col: Math.floor(rem / 100), line: rem % 100, off };
}

/** 位址 → seq。 */
export function seqOfAddress(a: Address): number {
  return a.page * 1000 + a.col * 100 + a.line;
}

export function formatAddress(a: Address): string {
  const vol = String(a.vol).padStart(2, "0");
  const page = String(a.page).padStart(4, "0");
  const col = COL_LETTERS[a.col] ?? "?";
  const line = String(a.line).padStart(2, "0");
  const tail = a.off >= 100 ? `${line}.${String(a.off).padStart(3, "0")}` : line + String(a.off).padStart(2, "0");
  return `${a.side}${vol}p${page}${col}${tail}`;
}

// ---------------------------------------------------------------- 解碼

function decodeU32(b: Uint8Array, pos: number): { value: number; pos: number } {
  let value = 0, shift = 1;
  for (;;) {
    const c = b[pos++];
    value += (c & 0x7f) * shift;
    if ((c & 0x80) === 0) break;
    shift *= 128;
  }
  return { value, pos };
}

function readGeom(b: Uint8Array, pos: number): { g: SideGeom; pos: number } {
  let r = decodeU32(b, pos); const vol = r.value; pos = r.pos;
  r = decodeU32(b, pos); const n = r.value; pos = r.pos;
  r = decodeU32(b, pos); const han = r.value; pos = r.pos;
  const lineSeq = new Int32Array(n);
  let prev = 0;
  for (let i = 0; i < n; i++) { r = decodeU32(b, pos); pos = r.pos; prev += r.value; lineSeq[i] = prev; }
  const lineStart = new Int32Array(n + 1);
  let acc = 0;
  for (let i = 0; i < n; i++) { lineStart[i] = acc; r = decodeU32(b, pos); pos = r.pos; acc += r.value; }
  lineStart[n] = acc;
  return { g: { vol, lineSeq, lineStart, nLines: n, han }, pos };
}

export function decodeAlign(blob: Uint8Array): AlignBody {
  let pos = 0;
  const ver = blob[pos++];
  if (ver !== 1) throw new Error(`posmap 資料版本不符：${ver}`);
  const flags = blob[pos++];
  let r = readGeom(blob, pos); const t = r.g; pos = r.pos;
  r = readGeom(blob, pos); const k = r.g; pos = r.pos;
  const num = () => { const x = decodeU32(blob, pos); pos = x.pos; return x.value; };
  const tBody = Int32Array.from([num(), num()]);
  const tPre = num(), tPost = num();
  const kBody = Int32Array.from([num(), num()]);
  const kPre = num(), kPost = num();
  const nRuns = num();
  const runs = new Int32Array(nRuns * 3);
  let pt = 0, pk = 0;
  for (let i = 0; i < nRuns; i++) {
    const t0 = pt + num(), k0 = pk + num(), len = num();
    runs[i * 3] = t0; runs[i * 3 + 1] = k0; runs[i * 3 + 2] = len;
    pt = t0 + len; pk = k0 + len;
  }
  return { t, k, tBody, kBody, tPre, tPost, kPre, kPost, runs, coarse: (flags & 1) !== 0 };
}

// ---------------------------------------------------------------- 行／對應段

export function findLine(g: SideGeom, seq: number): [number, boolean] {
  const a = g.lineSeq;
  if (g.nLines === 0) return [0, false];
  let lo = 0, hi = g.nLines - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid] <= seq) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (a[ans] === seq) return [ans, true];
  if (ans + 1 < g.nLines && Math.abs(a[ans + 1] - seq) < Math.abs(a[ans] - seq)) return [ans + 1, false];
  return [ans, false];
}

export function lineIndexAt(g: SideGeom, off: number): number {
  const s = g.lineStart;
  let lo = 0, hi = g.nLines - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (s[mid] <= off) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

export function mapOffset(runs: Int32Array, tOff: number): [number, boolean] {
  const n = runs.length / 3;
  if (n === 0) return [0, false];
  let lo = 0, hi = n - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (runs[mid * 3] <= tOff) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (ans < 0) return [runs[1], false];
  const t0 = runs[ans * 3], k0 = runs[ans * 3 + 1], len = runs[ans * 3 + 2];
  if (tOff < t0 + len) return [k0 + (tOff - t0), true];
  return [k0 + len, false];
}

export function mapOffsetRev(runs: Int32Array, kOff: number): [number, boolean] {
  const n = runs.length / 3;
  if (n === 0) return [0, false];
  let lo = 0, hi = n - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (runs[mid * 3 + 1] <= kOff) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (ans < 0) return [runs[0], false];
  const t0 = runs[ans * 3], k0 = runs[ans * 3 + 1], len = runs[ans * 3 + 2];
  if (kOff < k0 + len) return [t0 + (kOff - k0), true];
  return [t0 + len, false];
}

const seqOf = (page: number, col: number, line: number) => page * 1000 + col * 100 + line;
const pclOfSeq = (seq: number) => { const rem = seq % 1000; return { page: (seq - rem) / 1000, col: Math.floor(rem / 100), line: rem % 100 }; };

function geomAddress(side: Side, g: SideGeom, off: number): Address {
  const li = lineIndexAt(g, off);
  const p = pclOfSeq(g.lineSeq[li]);
  return { side, vol: g.vol, page: p.page, col: p.col, line: p.line, off: Math.max(0, Math.min(off - g.lineStart[li], 999)) };
}

function resolveInput(g: SideGeom, page: number, col: number, line: number, off: number) {
  const seq = seqOf(page, col, line);
  const [li, hit] = findLine(g, seq);
  const lineHan = g.lineStart[li + 1] - g.lineStart[li];
  const o = Math.max(0, Math.min(off, lineHan));
  return { li, hit, charOff: g.lineStart[li] + o };
}

// ---------------------------------------------------------------- 索引

const MAGIC = "GYPOS2\0\0";
/** 壓縮版 `align/posmap` 的包裝：8B magic ＋ u32 rawLen ＋ raw DEFLATE（RFC 1951）。 */
export const ZMAGIC = "GYPOSZ\1\0";

export function isCompressedPosMap(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  for (let i = 0; i < 8; i++) if (bytes[i] !== ZMAGIC.charCodeAt(i)) return false;
  return true;
}

/**
 * 把 `align/posmap` 區塊解成 GYPOS2（未壓縮）位元組。
 *
 * 這個區塊有兩種存法（同一份資料）：
 *   "GYPOS2\0\0" …              posmap.bin 原樣（建置中間檔、舊檔）
 *   "GYPOSZ\1\0" u32 rawLen …   raw DEFLATE；13.2 MB → 1.8 MB，inflate 約 80 ms
 * 讀的那一端不要知道是哪一種。
 */
export function decodePosMapBytes(bytes: Uint8Array): Uint8Array {
  if (!isCompressedPosMap(bytes)) return bytes;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const rawLen = dv.getUint32(8, true);
  const out = inflateRaw(bytes.subarray(12));
  if (rawLen && out.length !== rawLen) throw new Error(`posmap 解壓長度不符：${out.length} vs ${rawLen}`);
  return out;
}

export class PosMap {
  private recs: AlignRec[] = [];
  private byT: number[] = [];
  private byK: number[] = [];
  private byTLine: number[] = [];
  private byKLine: number[] = [];
  private bodies = new Map<AlignRec, AlignBody>();

  static parse(input: Uint8Array): PosMap {
    const bytes = decodePosMapBytes(input);
    const pm = new PosMap();
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let p = 0;
    for (let i = 0; i < 8; i++) if (bytes[p++] !== MAGIC.charCodeAt(i)) throw new Error('bad posmap magic');
    const n = dv.getUint32(p, true); p += 4;
    const text = (len: number) => {
      let s = '';
      for (let i = 0; i < len; i++) { const c = bytes[p++]; if (c) s += String.fromCharCode(c); }
      return s;
    };
    for (let i = 0; i < n; i++) {
      const tsutra = text(4);
      const tjuan = dv.getUint16(p, true); p += 2;
      const ksutra = text(4);
      const kjuan = dv.getUint16(p, true); p += 2;
      const tvol = bytes[p++];
      const tstart = dv.getUint32(p, true); p += 4;
      const tend = dv.getUint32(p, true); p += 4;
      const kvol = bytes[p++];
      const kstart = dv.getUint32(p, true); p += 4;
      const kend = dv.getUint32(p, true); p += 4;
      const tline = dv.getUint32(p, true); p += 4;
      const kline = dv.getUint32(p, true); p += 4;
      const len = dv.getUint32(p, true); p += 4;
      const blob = bytes.subarray(p, p + len); p += len;
      pm.recs.push({ tsutra, tjuan, ksutra, kjuan, tvol, kvol, tstart, tend, kstart, kend, tline, kline, blob } as AlignRec);
    }
    pm.byT = pm.recs.map((_, i) => i).sort((a, b) => pm.recs[a].tvol - pm.recs[b].tvol || pm.recs[a].tstart - pm.recs[b].tstart);
    pm.byK = pm.recs.map((_, i) => i).sort((a, b) => pm.recs[a].kvol - pm.recs[b].kvol || pm.recs[a].kstart - pm.recs[b].kstart);
    pm.byTLine = pm.recs.map((_, i) => i).filter((i) => pm.recs[i].tline !== 0xffffffff).sort((a, b) => pm.recs[a].tline - pm.recs[b].tline);
    pm.byKLine = pm.recs.map((_, i) => i).filter((i) => pm.recs[i].kline !== 0xffffffff).sort((a, b) => pm.recs[a].kline - pm.recs[b].kline);
    return pm;
  }

  get count(): number { return this.recs.length; }

  private bodyOf(rec: AlignRec): AlignBody {
    let b = this.bodies.get(rec);
    if (!b) { b = decodeAlign(rec.blob); this.bodies.set(rec, b); }
    return b;
  }

  /**
   * 位址所在那一卷、該側的行幾何（沒有對照就回 null）。
   *
   * UI 由「頁／欄」推算欄內行號時要用：頁標記可能不在行首（前面還有上一欄的字，
   * 或卷首的卷題），要知道幾何的第一行有幾個漢字才分得清那一行屬不屬於這一欄。
   */
  geomAt(side: Side, vol: number, seq: number): SideGeom | null {
    const rec = side === 'T' ? this.findByT(vol, seq) : this.findByK(vol, seq);
    if (!rec) return null;
    const body = this.bodyOf(rec);
    const g = side === 'T' ? body.t : body.k;
    return g.nLines ? g : null;
  }

  /** 這一卷某一側第一行（該頁該欄）的漢字數；沒有就回 -1。 */
  firstLineHan(side: Side, vol: number, page: number, col: number): number {
    return this.firstLineOf(side, vol, page, col)?.han ?? -1;
  }

  /**
   * 這一頁這一欄「第一個有字的行」：pcl 行號與該行漢字數。
   *
   * 頁的第一行不一定是第 1 行（高麗藏的頁首可能是第 2 行，K.db 沒有第 1 行），
   * 所以由對照表的幾何反查，不要假設 1。
   */
  firstLineOf(side: Side, vol: number, page: number, col: number): { line: number; han: number } | null {
    const base = seqOf(page, col, 0);
    const g = this.geomAt(side, vol, base);
    if (!g) return null;
    let lo = 0, hi = g.nLines - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (g.lineSeq[mid] >= base) { ans = mid; hi = mid - 1; } else lo = mid + 1;
    }
    if (ans < 0) return null;
    const seq = g.lineSeq[ans];
    if (Math.floor(seq / 1000) !== page || Math.floor((seq % 1000) / 100) !== col) return null;
    return { line: seq % 100, han: g.lineStart[ans + 1] - g.lineStart[ans] };
  }

  /**
   * 這一頁這一欄的第 `colChar` 個漢字落在哪一行：回傳 pcl 行號與行內偏置。
   *
   * 由「欄內漢字位移」而不是「adb 行號」來定位，是因為兩藏（甚至同一藏的兩個
   * 版本）斷行不同：位址的頁／欄是共通的，欄內第幾個字才是穩定的座標。
   * 超出這一欄就夾到最後一行。
   */
  columnLineOf(side: Side, vol: number, page: number, col: number, colChar: number): { line: number; off: number } | null {
    const base = seqOf(page, col, 0);
    const g = this.geomAt(side, vol, base);
    if (!g) return null;
    let lo = 0, hi = g.nLines - 1, start = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (g.lineSeq[mid] >= base) { start = mid; hi = mid - 1; } else lo = mid + 1;
    }
    if (start < 0) return null;
    const want = Math.max(0, colChar);
    let acc = 0;
    let last = start;
    for (let i = start; i < g.nLines; i++) {
      const seq = g.lineSeq[i];
      if (Math.floor(seq / 1000) !== page || Math.floor((seq % 1000) / 100) !== col) break;
      const han = g.lineStart[i + 1] - g.lineStart[i];
      if (want < acc + han || (want === acc && han > 0)) {
        return { line: seq % 100, off: Math.min(want - acc, han) };
      }
      acc += han;
      last = i;
    }
    const seq = g.lineSeq[last];
    return { line: seq % 100, off: g.lineStart[last + 1] - g.lineStart[last] };
  }

  findByT(vol: number, seq: number): AlignRec | null {
    return this.find(this.byT, 't', vol, seq);
  }
  findByK(vol: number, seq: number): AlignRec | null {
    return this.find(this.byK, 'k', vol, seq);
  }

  private find(order: number[], side: 't' | 'k', vol: number, seq: number): AlignRec | null {
    const r = this.recs;
    let lo = 0, hi = order.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const x = r[order[mid]];
      const v = side === 't' ? x.tvol : x.kvol;
      const s = side === 't' ? x.tstart : x.kstart;
      if (v < vol || (v === vol && s <= seq)) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (ans < 0) return null;
    const x = r[order[ans]];
    const v = side === 't' ? x.tvol : x.kvol;
    const e = side === 't' ? x.tend : x.kend;
    return v === vol && seq <= e ? x : null;
  }

  /** 由 adb 的 0-based 行號求位址；hanPrefix = 該行游標前方的漢字數 */
  addressOfLine(side: Side, line: number, hanPrefix = 0): { addr: Address; rec: AlignRec } | null {    const order = side === 'T' ? this.byTLine : this.byKLine;
    if (!order.length) return null;
    let lo = 0, hi = order.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const rec = this.recs[order[mid]];
      const l = side === 'T' ? rec.tline : rec.kline;
      if (l <= line) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (ans < 0) return null;
    const rec = this.recs[order[ans]];
    const start = side === 'T' ? rec.tline : rec.kline;
    const body = this.bodyOf(rec);
    const g = side === 'T' ? body.t : body.k;
    const li = line - start;
    if (li < 0 || li >= g.nLines) return null;
    const seq = g.lineSeq[li];
    const page = Math.floor(seq / 1000);
    const col = Math.floor((seq % 1000) / 100);
    const ln = seq % 100;
    const hanMax = g.lineStart[li + 1] - g.lineStart[li];
    const off = Math.max(0, Math.min(hanPrefix, hanMax));
    return { addr: { side, vol: g.vol, page, col, line: ln, off }, rec };
  }

  /** 位址 → adb 行號（找不到回 null） */
  lineOfAddress(side: Side, addr: Address): number | null {
    const seq = seqOf(addr.page, addr.col, addr.line);
    const rec = side === 'T' ? this.findByT(addr.vol, seq) : this.findByK(addr.vol, seq);
    if (!rec) return null;
    const start = side === 'T' ? rec.tline : rec.kline;
    if (start === 0xffffffff) return null;
    const body = this.bodyOf(rec);
    const g = side === 'T' ? body.t : body.k;
    const [li] = findLine(g, seq);
    return start + li;
  }

  convert(addr: Address): ConvertResult {
    const seq = seqOf(addr.page, addr.col, addr.line);
    const rec = addr.side === 'T' ? this.findByT(addr.vol, seq) : this.findByK(addr.vol, seq);
    if (!rec) {
      return { ok: false, input: formatAddress(addr), t: null, k: null, tsutra: '', tjuan: 0, ksutra: '', kjuan: 0, exact: false, adjust: 'none', note: '此位址不在對照範圍內' };
    }
    const body = this.bodyOf(rec);
    const srcGeom = addr.side === 'T' ? body.t : body.k;
    const dstGeom = addr.side === 'T' ? body.k : body.t;
    if (srcGeom.nLines === 0) {
      return { ok: false, input: formatAddress(addr), t: null, k: null, tsutra: rec.tsutra, tjuan: rec.tjuan, ksutra: rec.ksutra, kjuan: rec.kjuan, exact: false, adjust: 'none', note: '該卷在這一側沒有資料' };
    }
    const inp = resolveInput(srcGeom, addr.page, addr.col, addr.line, addr.off);
    const notes: string[] = [];
    let adjust = 'none';
    const bodySrc = addr.side === 'T' ? body.tBody : body.kBody;
    const bodyDst = addr.side === 'T' ? body.kBody : body.tBody;
    let x = inp.charOff;
    if (x < bodySrc[0]) { x = bodySrc[0]; adjust = 'preface'; notes.push('輸入落在序文，已移到該卷正文第一字'); }
    else if (x > bodySrc[1]) { x = bodySrc[1]; adjust = 'appendix'; notes.push('輸入落在附文，已移到該卷正文最後一字的右邊'); }
    const [y0, exact] = addr.side === 'T' ? mapOffset(body.runs, x) : mapOffsetRev(body.runs, x);
    let y = y0;
    if (y < bodyDst[0]) y = bodyDst[0];
    if (y > bodyDst[1]) y = bodyDst[1];
    if (!exact) notes.push(addr.side === 'T' ? '該處是單邊插文，高麗藏無對應字，已取最接近的位置' : '該處是單邊插文，大正藏無對應字，已取最接近的位置');
    if (body.coarse) notes.push('本卷對齊粗略，轉換結果僅供參考');
    const srcAddr = geomAddress(addr.side, srcGeom, x);
    const dstAddr = geomAddress(addr.side === 'T' ? 'K' : 'T', dstGeom, y);
    const t = addr.side === 'T' ? srcAddr : dstAddr;
    const k = addr.side === 'T' ? dstAddr : srcAddr;
    if (!inp.hit) {
      const p = pclOfSeq(srcGeom.lineSeq[inp.li]);
      notes.push(`來源無 ${String(addr.page).padStart(4, '0')}${COL_LETTERS[addr.col]}${String(addr.line).padStart(2, '0')} 此行，已取最接近的 ${String(p.page).padStart(4, '0')}${COL_LETTERS[p.col]}${String(p.line).padStart(2, '0')}`);
    }
    return {
      ok: true, input: formatAddress(addr), t, k,
      tsutra: rec.tsutra, tjuan: rec.tjuan, ksutra: rec.ksutra, kjuan: rec.kjuan,
      exact, adjust, note: notes.join('；'),
    };
  }
}

/** 從 adb 讀取 `align/posmap` 並建立索引（accelon26 用）。 */
export async function loadPosMap(reader: { readBlock(name: string, index: number): Promise<Uint8Array>; readBlockCount?(name: string): number }): Promise<PosMap> {
  const bytes = await reader.readBlock('align', 0);
  return PosMap.parse(bytes);
}
