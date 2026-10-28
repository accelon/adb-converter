/**
 * The database's own logo, shown while the 本文 pane has nothing in it.
 *
 * The image is INSIDE the .adb (the `resources` container — yinshun carries
 * `yinshun_logo.png` at its root): the resource table is the only place a database can
 * carry a picture, and nothing is read from disk beside the file. Databases without
 * one (13j, fgdict) simply show nothing.
 */
import { $, currentFile, reader } from './viewer';
import { AdbReader, BlobIO, type AdbSource } from './adb';

const IMG_EXT = /\.(png|jpe?g|gif|svg|webp|bmp)$/i;
const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  svg: 'image/svg+xml', webp: 'image/webp', bmp: 'image/bmp',
};

let forReader: unknown = null;
let at = -1;
let gen = 0;
let url: string | null = null;
let base = '';
let loading = false;

/** the .adb file's own name (without extension) — set by openFile */
export function setLogoBase(name: string): void {
  base = name.replace(/\.[^.]+$/, '');
  forReader = null;
  at = -1;
  gen++;                       // 讓還在解碼的舊 logo 作廢
  if (url) { URL.revokeObjectURL(url); url = null; }
}

/** the resource index of <dbname>_logo.* / <file>_logo.*, or -1 */
function findLogo(): number {
  const names = ((reader as unknown as { containers: Map<string, { names?: string[] }> })
    ?.containers.get('resources')?.names ?? []) as string[];
  if (!names.length) return -1;
  const bases: string[] = [];
  const db = reader?.header.dbname;
  if (db) bases.push(db);
  if (base && !bases.includes(base)) bases.push(base);
  const fileBase = (currentFile.split(/[\\/]/).pop() ?? '').replace(/\.[^.]+$/, '');
  if (fileBase && !bases.includes(fileBase)) bases.push(fileBase);
  for (const b of bases) {
    const esc = b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const want = new RegExp('(^|/)' + esc + '_logo\\.', 'i');
    const i = names.findIndex((n) => want.test(n) && IMG_EXT.test(n));
    if (i >= 0) return i;
  }
  return -1;
}

/**
 * 這一個 .adb 有沒有自己的 logo 圖（`<dbname>_logo.*` 或 `<檔名>_logo.*`）——
 * 啟動時「優先打開有 logo 的庫」用的（作者 2026-10-18，例如 yinshun.adb）。
 * 只讀檔頭與容器名稱表，不載入資料，也不碰全域的 `reader`。
 */
export async function hasLogoResource(file: AdbSource): Promise<boolean> {
  try {
    const r = await AdbReader.open(new BlobIO(file));
    const names = r.containers.get('resources')?.names ?? [];
    if (!names.length) return false;
    const fileBase = (file.path ? (file.path.split(/[\\/]/).pop() ?? file.name) : file.name).replace(/\.[^.]+$/, '');
    for (const b of [r.header.dbname, fileBase]) {
      if (!b) continue;
      const esc = b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const want = new RegExp('(^|/)' + esc + '_logo\\.', 'i');
      if (names.some((n) => want.test(n) && IMG_EXT.test(n))) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Show the logo exactly when the middle pane has no line to show, and hide it the
 * moment there is text. Called after a load, after a database switch and after every
 * document render (which is also what closes the last tab).
 */
export async function updateDocLogo(): Promise<void> {
  const box = $('#docLogo');
  const img = $('#docLogoImg') as HTMLImageElement | null;
  if (!box || !img) return;
  // 作者 2026-10：關掉資料庫時 `reader` 已經沒有意義 —— 立刻收起，不要因為
  // `loading`（上一個庫的 logo 還在解碼）就提早 return 而把圖留在中間。
  if (!reader) { hideDocLogo(); return; }
  if (document.querySelector('#docText .docLine')) { box.hidden = true; return; }
  // 切庫時 reader 會換；不要讓「上一個庫」的解碼結果蓋掉新的圖。
  const want = reader;
  if (forReader !== want) {
    forReader = want;
    at = findLogo();
    if (url) { URL.revokeObjectURL(url); url = null; }
  }
  if (at < 0) { box.hidden = true; return; }
  if (url) {
    if (img.getAttribute('src') !== url) img.src = url;
    box.hidden = false;
    return;
  }
  if (loading) return;         // 解碼完成時 finally 會再叫一次
  const my = ++gen;
  loading = true;
  try {
    const r = await want.resourceBytes(at);
    if (my !== gen || reader !== want) return;   // 期間已切庫
    const ext = (r.name.split('.').pop() ?? '').toLowerCase();
    if (url) URL.revokeObjectURL(url);
    url = URL.createObjectURL(new Blob([r.bytes.slice().buffer as ArrayBuffer], { type: MIME[ext] ?? 'image/png' }));
    img.alt = want.header.dbcname || want.header.dbname;
  } finally {
    loading = false;
    if (reader !== want) void updateDocLogo();   // 幫新庫補畫
    else if (url) { if (img.getAttribute('src') !== url) img.src = url; box.hidden = false; }
  }
}

/** 立刻收起中間的 logo（關掉資料庫時用；作者 2026-10） */
export function hideDocLogo(): void {
  const box = $('#docLogo');
  if (box) box.hidden = true;
}

/** diagnostics: which resource is the logo ('' = this database has none) and is it shown */
export const logoState = () => ({
  name: at >= 0 ? (((reader as unknown as { containers: Map<string, { names?: string[] }> })
    ?.containers.get('resources')?.names ?? [])[at] ?? '') : '',
  at,
  shown: !($('#docLogo') as HTMLElement | null)?.hidden,
});
