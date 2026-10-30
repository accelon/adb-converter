/**
 * `goryeo_taisho.adb` 的 `map/index`：一卷一筆的兩藏目錄（給左欄「對照」用）。
 *
 * 二進位格式（little-endian，magic `GYMAP1`）：
 *
 *   magic  8B  "GYMAP1\0\0"
 *   u32        count
 *   u32        nStr
 *   nStr ×     u32 長度 + UTF-16LE 字串（卷題）
 *   count × 40B：
 *     4B tsutra ascii   4B ksutra ascii
 *     2B tjuan          2B kjuan
 *     1B tvol           1B kvol
 *     2B flags（保留）
 *     4B tstart 4B tend 4B kstart 4B kend   // page*1000+col*100+line
 *
 * 兩側卷題各自來自 juaninfo.tsv；找不到時是空字串（UI 顯示「經號 卷N」）。
 * 這個容器只有 goryeo_taisho.adb 有；對照表本身仍在 `align/posmap`。
 */

export interface MapRow {
  index: number;
  tTitle: string;
  kTitle: string;
  tsutra: string;
  tjuan: number;
  ksutra: string;
  kjuan: number;
  tvol: number;
  kvol: number;
  tstart: number;
  tend: number;
  kstart: number;
  kend: number;
}

const MAGIC = 'GYMAP1\0\0';

function readString(bytes: Uint8Array, dv: DataView, at: number): { s: string; pos: number } {
  const len = dv.getUint32(at, true);
  let p = at + 4;
  const units = new Uint16Array(len);
  for (let i = 0; i < len; i++) { units[i] = bytes[p] | (bytes[p + 1] << 8); p += 2; }
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < units.length; i += CHUNK) s += String.fromCharCode.apply(null, units.subarray(i, i + CHUNK) as unknown as number[]);
  return { s, pos: p };
}

export function parseMapIndex(bytes: Uint8Array): MapRow[] {
  for (let i = 0; i < 8; i++) if (bytes[i] !== MAGIC.charCodeAt(i)) throw new Error('map/index: magic 不符');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = dv.getUint32(8, true);
  const nStr = dv.getUint32(12, true);
  let p = 16;
  const strings: string[] = [];
  // 卷題尾巴的 `^p`／`^half〔別名〕…` 是 migrator 的標記，不是書名（2026-10-30）；
  // 舊的 goryeo_taisho.adb 也順手清掉。
  for (let i = 0; i < nStr; i++) { const r = readString(bytes, dv, p); strings.push(r.s.replace(/\^.*$/, '').trim()); p = r.pos; }
  const rows: MapRow[] = [];
  const ascii4 = (q: number) => String.fromCharCode(bytes[q], bytes[q + 1], bytes[q + 2], bytes[q + 3]);
  for (let i = 0; i < count; i++) {
    const tTitle = strings[dv.getUint32(p, true)] ?? ''; p += 4;
    const kTitle = strings[dv.getUint32(p, true)] ?? ''; p += 4;
    const tsutra = ascii4(p); p += 4;
    const ksutra = ascii4(p); p += 4;
    const tjuan = dv.getUint16(p, true); p += 2;
    const kjuan = dv.getUint16(p, true); p += 2;
    const tvol = bytes[p++];
    const kvol = bytes[p++];
    p += 2;                                   // flags
    const tstart = dv.getUint32(p, true); p += 4;
    const tend = dv.getUint32(p, true); p += 4;
    const kstart = dv.getUint32(p, true); p += 4;
    const kend = dv.getUint32(p, true); p += 4;
    rows.push({ index: i, tTitle, kTitle, tsutra, tjuan, ksutra, kjuan, tvol, kvol, tstart, tend, kstart, kend });
  }
  return rows;
}

/** 從 adb 讀 `map/index`（沒有這個容器就回 null）。 */
export async function loadMapIndex(reader: { containers: Map<string, unknown>; readBlock(name: string, index: number): Promise<Uint8Array> }): Promise<MapRow[] | null> {
  if (!reader.containers.get('map')) return null;
  return parseMapIndex(await reader.readBlock('map', 0));
}
