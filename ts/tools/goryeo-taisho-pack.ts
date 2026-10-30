/**
 * 把 goryeo.adb 內嵌的「高麗藏 ⇄ 大正藏」逐字對照表抽出來，做成獨立的
 * `goryeo_taisho.adb`（2026-10-30）。
 *
 *   bun run ts/tools/goryeo-taisho-pack.ts [--goryeo build/goryeo.adb]
 *        [--posmap-bin build/posmap.bin] [--t-juaninfo …] [--k-juaninfo …]
 *        [--out build/goryeo_taisho.adb]
 *
 * 產物內容：
 *   align/posmap   原 goryeo.adb 的 `align/posmap` 區塊（位元組原樣搬過來）
 *   map/index      給 UI 用的卷目錄：兩側經號／卷號／卷題／起訖（6,357 筆）
 *   文字           只有檔頭，宣告 `<樹 m="taisho">`（左欄「對照」分頁）
 *
 * 卷題與卷界來自 tripitaka-migrator 的 juaninfo.tsv（兩藏的起點與 posmap 的
 * tstart/kstart 完全一致，已核對 6,357 卷）。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { authorAdb } from '../src/adbauthor';
import { buildContainer, BO_NAMED, BO_UNICODE } from '../src/accelon26/adb-bytes';
import { AdbReader } from '../src/accelon26/adb';
import { PosMap, ZMAGIC } from '../src/accelon26/posmap';

const args = process.argv.slice(2);
const ROOT = resolve(import.meta.dir, '../..');
const opt = (name: string, dflt: string): string => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? resolve(args[i + 1]) : resolve(ROOT, dflt);
};

const GORYEO = opt('goryeo', 'build/goryeo.adb');
const POSMAP_BIN = opt('posmap-bin', 'build/posmap.bin');
const T_JUANINFO = opt('t-juaninfo', 'D:/2023/tripitaka-migrator/t-txt/juaninfo.tsv');
const K_JUANINFO = opt('k-juaninfo', 'D:/2023/tripitaka-migrator/k-txt/juaninfo.tsv');
const OUT = opt('out', 'build/goryeo_taisho.adb');

interface JuanInfo { title: string; vol: number; start: number; end: number }

/** "0001a01" → page*1000 + col*100 + line */
function pclSeq(s: string): number | null {
  const m = /^(\d{1,4})([a-g])(\d{1,2})$/.exec(s.trim());
  if (!m) return null;
  const page = Number(m[1]);
  const col = m[2].charCodeAt(0) - 97;
  const line = Number(m[3]);
  if (page < 1 || page > 9999 || col < 0 || col > 6 || line < 0 || line > 99) return null;
  return page * 1000 + col * 100 + line;
}

/**
 * juaninfo.tsv → { "經號/卷": 卷題、冊、起訖 }。
 * 大正藏的「經名」只在該經的第一卷出現，所以要往下補；高麗藏的卷題每一卷都有。
 */
function loadJuanInfo(path: string, kind: 'T' | 'K'): Map<string, JuanInfo> {
  const out = new Map<string, JuanInfo>();
  if (!existsSync(path)) {
    console.error(`缺 ${path}（卷題會退回「經號 卷N」）`);
    return out;
  }
  const rows = readFileSync(path, 'utf8').split(/\r?\n/).slice(1).filter(Boolean);
  let prevSutra = '', carry = '';
  const sutraTitle = new Map<string, string>();
  for (const row of rows) {
    const c = row.split('\t');
    const sutra = (c[0] ?? '').trim().padStart(4, '0');
    const vol = Number(c[1]);
    // 卷題尾巴的 ^p／^half〔別名〕… 都是 migrator 的標記，不是書名（作者 2026-10-30）
    let title = (c[2] ?? '').replace(/\^.*$/, '').trim();
    const juan = Number(c[3]);
    const start = pclSeq(c[4] ?? '');
    const end = pclSeq(c[5] ?? '');
    if (sutra !== prevSutra) { prevSutra = sutra; carry = title || carry; }
    else if (title) carry = title;
    else title = carry;
    if (title) sutraTitle.set(sutra, title);
    if (start == null || !juan) continue;
    out.set(`${sutra}/${juan}`, { title, vol, start, end: end ?? start });
  }
  // 75 個大正藏卷的卷號與 TEI 檔名不一致（沒有 juaninfo 列）：卷題仍可由經號取得。
  for (const [key, j] of [...out]) {
    if (j.title) continue;
    const sutra = key.slice(0, 4);
    const t = sutraTitle.get(sutra);
    if (t) out.set(key, { ...j, title: t });
  }
  void kind;
  return out;
}

// ---------------------------------------------------------------- 對照表

let alignBytes: Uint8Array;
if (existsSync(GORYEO)) {
  const file = readFileSync(GORYEO);
  const io = {
    size: file.length,
    read: async (off: number, len: number) =>
      new Uint8Array(file.buffer, file.byteOffset + off, len),
  };
  const r = await AdbReader.open(io as never);
  if (!r.containers.get('align')) {
    console.error(`${GORYEO} 沒有 align 容器（已經抽出來過了？），改用 ${POSMAP_BIN}`);
    alignBytes = new Uint8Array(readFileSync(POSMAP_BIN));
  } else {
    alignBytes = await r.readBlock('align', 0);
    console.error(`align/posmap 取自 ${GORYEO}：${(alignBytes.length / 1048576).toFixed(1)} MiB`);
  }
} else {
  alignBytes = new Uint8Array(readFileSync(POSMAP_BIN));
  console.error(`align 取自 ${POSMAP_BIN}：${(alignBytes.length / 1048576).toFixed(1)} MiB`);
}

const pm = PosMap.parse(alignBytes);
const recs = (pm as unknown as { recs: { tsutra: string; tjuan: number; ksutra: string; kjuan: number; tvol: number; kvol: number; tstart: number; tend: number; kstart: number; kend: number }[] }).recs;
console.error(`對照表 ${recs.length} 卷`);

const T = loadJuanInfo(T_JUANINFO, 'T');
const K = loadJuanInfo(K_JUANINFO, 'K');

// ---------------------------------------------------------------- map/index

const strings: string[] = [];
const stringAt = new Map<string, number>();
const str = (s: string): number => {
  const hit = stringAt.get(s);
  if (hit !== undefined) return hit;
  const i = strings.length;
  strings.push(s);
  stringAt.set(s, i);
  return i;
};

const REC_BYTES = 40;
const map = new Uint8Array(12 + recurse() + recs.length * REC_BYTES);
function recurse(): number {
  // 先算字串表大小（u32 長度 + UTF-16LE）
  let n = 4;                                   // nStr
  const seen = new Set<string>();
  for (const r of recs) {
    const t = T.get(`${r.tsutra}/${r.tjuan}`)?.title ?? '';
    const k = K.get(`${r.ksutra}/${r.kjuan}`)?.title ?? '';
    for (const s of [t, k]) { if (!seen.has(s)) { seen.add(s); n += 4 + s.length * 2; } }
  }
  return n;
}

let missT = 0, missK = 0;
{
  const dv = new DataView(map.buffer);
  let p = 0;
  for (const ch of 'GYMAP1\0\0') map[p++] = ch.charCodeAt(0);
  dv.setUint32(p, recs.length, true); p += 4;
  // 先寫 nStr 佔位，稍後回填
  const strCountAt = p; p += 4;
  const strBase = p;
  // 先收集所有字串（保持固定順序），再寫表
  let q = strBase;
  for (const r of recs) {
    for (const s of [T.get(`${r.tsutra}/${r.tjuan}`)?.title ?? '', K.get(`${r.ksutra}/${r.kjuan}`)?.title ?? '']) {
      str(s);
    }
  }
  for (const s of strings) {
    dv.setUint32(q, s.length, true); q += 4;
    for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); map[q++] = c & 0xff; map[q++] = c >>> 8; }
  }
  dv.setUint32(strCountAt, strings.length, true);
  p = q;
  for (const r of recs) {
    const ti = T.get(`${r.tsutra}/${r.tjuan}`);
    const ki = K.get(`${r.ksutra}/${r.kjuan}`);
    if (!ti?.title) missT++;
    if (!ki?.title) missK++;
    dv.setUint32(p, str(ti?.title ?? ''), true); p += 4;
    dv.setUint32(p, str(ki?.title ?? ''), true); p += 4;
    for (let i = 0; i < 4; i++) map[p++] = r.tsutra.charCodeAt(i) & 0xff;
    for (let i = 0; i < 4; i++) map[p++] = r.ksutra.charCodeAt(i) & 0xff;
    dv.setUint16(p, r.tjuan, true); p += 2;
    dv.setUint16(p, r.kjuan, true); p += 2;
    map[p++] = r.tvol;
    map[p++] = r.kvol;
    dv.setUint16(p, 0, true); p += 2;           // flags（保留）
    dv.setUint32(p, r.tstart, true); p += 4;
    dv.setUint32(p, r.tend, true); p += 4;
    dv.setUint32(p, r.kstart, true); p += 4;
    dv.setUint32(p, r.kend, true); p += 4;
  }
  if (p !== map.length) throw new Error(`map/index 長度不符：寫了 ${p}，預期 ${map.length}`);
}
console.error(`map/index ${(map.length / 1024).toFixed(0)} KiB，${strings.length} 個卷題（缺 T=${missT} K=${missK}）`);

// ---------------------------------------------------------------- 打包

/**
 * `align/posmap` 存成 raw DEFLATE（GYPOSZ）：12.6 MiB → 1.8 MiB。
 *
 * 這與 migrator 的 `public/posmap.pos`（zstd）是同一份資料的兩種包法；讀的一方
 * 由 posmap.ts 的 `decodePosMapBytes` 判別（原樣 GYPOS2 也吃）。瀏覽器端用
 * `src/inflate.ts` 的 inflateRaw，13 MB 約 80 ms。
 */
const NO_COMPRESS = args.includes('--no-compress');
function compressAlign(raw: Uint8Array): Uint8Array {
  if (NO_COMPRESS) return raw;
  const deflated = new Uint8Array(deflateRawSync(raw, { level: 9 }));
  const out = new Uint8Array(12 + deflated.length);
  for (let i = 0; i < 8; i++) out[i] = ZMAGIC.charCodeAt(i);
  new DataView(out.buffer).setUint32(8, raw.length, true);
  out.set(deflated, 12);
  return out;
}
const storedAlign = compressAlign(alignBytes);
console.error(
  `align/posmap ${(alignBytes.length / 1048576).toFixed(1)} MiB → ${(storedAlign.length / 1048576).toFixed(2)} MiB` +
  `（${((storedAlign.length / alignBytes.length) * 100).toFixed(1)}%${NO_COMPRESS ? '，--no-compress' : '，raw DEFLATE'}）`,
);

const align = buildContainer({
  feature: BO_NAMED,
  blocks: [storedAlign],
  names: ['posmap'],
  nameFeature: BO_UNICODE,
});
const mapC = buildContainer({
  feature: BO_NAMED,
  blocks: [map],
  names: ['index'],
  nameFeature: BO_UNICODE,
});

const header =
  '<檔 n="goryeo_taisho.xml"><集 c="hidden">高麗⇄大正</集><英文名>Goryeo ⇄ Taisho</英文名>'
  + '本庫只放「高麗藏 ⇄ 大正藏」的逐字對照表（6,357 卷），經文仍在 goryeo.adb 與 taisho.adb。'
  + '左欄「高麗⇄大正」可以選一卷或直接輸入位址（例：T05p0002c0405、K01p0001a0105），換算另一藏的位置。'
  + '<隱><樹 m="taisho">高麗⇄大正</樹></隱></檔>';

const t0 = Date.now();
const res = await authorAdb({
  dbname: 'goryeo_taisho',
  dbcname: '高麗⇄大正',
  lines: [header, '<段/>'],
  dbtype: 4,
  extraContainers: { align, map: mapC },
  log: (m) => console.error(m),
});
writeFileSync(OUT, res.file);
console.error(
  `wrote ${basename(OUT)}（${(res.file.length / 1048576).toFixed(2)} MiB，` +
  `align ${(storedAlign.length / 1048576).toFixed(2)} MiB，map ${(map.length / 1024).toFixed(0)} KiB，` +
  `${((Date.now() - t0) / 1000).toFixed(1)}s）`,
);
