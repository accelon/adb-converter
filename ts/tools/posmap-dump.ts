/**
 * 把 posmap.db 的 align 表匯出成 goryeo.adb 內嵌用的一份二進位索引。
 *
 *   bun run ts/tools/posmap-dump.ts <posmap.db> <out.bin> [taisho.lines.tsv] [goryeo.lines.tsv]
 *
 * 行號檔（sidecar）由 tei2adb -lines / k2adb -lines 產生，每行 "sutra<TAB>juan<TAB>line"，
 * line 是該卷第一行在 adb 裡的 0-based 行號；用來把「游標所在行」換成位址、把位址換成行。
 *
 * 佈局（little-endian v2）：
 *   magic  "GYPOS2\0\0"
 *   u32    count
 *   每筆（依 t_vol,t_start_seq 排序）：
 *     4B tsutra ascii   2B tjuan
 *     4B ksutra ascii   2B kjuan
 *     1B t_vol  4B t_start  4B t_end
 *     1B k_vol  4B k_start  4B k_end
 *     4B t_line 4B k_line      （0xFFFFFFFF = 沒有行號）
 *     4B len    然後 len bytes 的 AlignBody（原樣）
 */
import { Database } from 'bun:sqlite';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const [, , dbPath = 'D:\\2023\\tripitaka-migrator\\posmap.db', out = 'build/posmap.bin',
  tLinesPath = 'build/taisho.lines.tsv', kLinesPath = 'build/goryeo.lines.tsv'] = process.argv;

function loadLines(path: string): Map<string, number> {
  const m = new Map<string, number>();
  if (!existsSync(path)) return m;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (!line) continue;
    const [s, j, l] = line.split('\t');
    m.set(`${s}/${j}`, Number(l));
  }
  return m;
}
const tLines = loadLines(tLinesPath);
const kLines = loadLines(kLinesPath);
console.log(`line sidecars: T=${tLines.size} K=${kLines.size}`);

const db = new Database(dbPath, { readonly: true });
const rows = db.query(`
  SELECT tsutra, tjuan, ksutra, kjuan, t_vol, k_vol,
         t_start_seq, t_end_seq, k_start_seq, k_end_seq, data
  FROM align ORDER BY t_vol, t_start_seq, tjuan`).all() as any[];
console.log('align rows:', rows.length);

const blobs = rows.map((r) => new Uint8Array(r.data as Uint8Array));
const total = 8 + 4 + rows.reduce((a, _r, i) => a + 44 + blobs[i].length, 0);
const buf = new Uint8Array(total);
const dv = new DataView(buf.buffer);
let p = 0;
for (const ch of 'GYPOS2\0\0') buf[p++] = ch.charCodeAt(0);
dv.setUint32(p, rows.length, true); p += 4;

const put = (s: string, n: number) => {
  for (let i = 0; i < n; i++) buf[p++] = i < s.length ? s.charCodeAt(i) & 0xff : 0;
};
let missingT = 0, missingK = 0;

for (let i = 0; i < rows.length; i++) {
  const r = rows[i];
  put(String(r.tsutra), 4);
  dv.setUint16(p, r.tjuan, true); p += 2;
  put(String(r.ksutra), 4);
  dv.setUint16(p, r.kjuan, true); p += 2;
  buf[p++] = r.t_vol;
  dv.setUint32(p, r.t_start_seq, true); p += 4;
  dv.setUint32(p, r.t_end_seq, true); p += 4;
  buf[p++] = r.k_vol;
  dv.setUint32(p, r.k_start_seq, true); p += 4;
  dv.setUint32(p, r.k_end_seq, true); p += 4;
  const tl = tLines.get(`${r.tsutra}/${r.tjuan}`);
  const kl = kLines.get(`${r.ksutra}/${r.kjuan}`);
  if (tl === undefined) missingT++;
  if (kl === undefined) missingK++;
  dv.setUint32(p, tl ?? 0xffffffff, true); p += 4;
  dv.setUint32(p, kl ?? 0xffffffff, true); p += 4;
  dv.setUint32(p, blobs[i].length, true); p += 4;
  buf.set(blobs[i], p); p += blobs[i].length;
}

writeFileSync(out, buf);
console.log(`wrote ${out}: ${(total / 1048576).toFixed(2)} MiB (missing line: T=${missingT} K=${missingK})`);
db.close();
