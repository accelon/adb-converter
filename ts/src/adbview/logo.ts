/**
 * The database's own logo, shown while the 本文 pane has nothing in it.
 *
 * The image is INSIDE the .adb (the `resources` container — yinshun carries
 * `yinshun_logo.png` at its root): the resource table is the only place a database can
 * carry a picture, and nothing is read from disk beside the file. Databases without
 * one (13j, fgdict) simply show nothing.
 */
import { $, reader } from './viewer';

const IMG_EXT = /\.(png|jpe?g|gif|svg|webp|bmp)$/i;
const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  svg: 'image/svg+xml', webp: 'image/webp', bmp: 'image/bmp',
};

let forReader: unknown = null;
let at = -1;
let url: string | null = null;
let base = '';
let loading = false;

/** the .adb file's own name (without extension) — set by openFile */
export function setLogoBase(name: string): void {
  base = name.replace(/\.[^.]+$/, '');
  forReader = null;
}

/** the resource index of <dbname>_logo.* / <file>_logo.*, or -1 */
function findLogo(): number {
  const names = ((reader as unknown as { containers: Map<string, { names?: string[] }> })
    ?.containers.get('resources')?.names ?? []) as string[];
  if (!names.length) return -1;
  const bases: string[] = [];
  const db = reader?.header.dbname;
  if (db) bases.push(db);
  if (base) bases.push(base);
  for (const b of bases) {
    const esc = b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const want = new RegExp('(^|/)' + esc + '_logo\\.', 'i');
    const i = names.findIndex((n) => want.test(n) && IMG_EXT.test(n));
    if (i >= 0) return i;
  }
  return -1;
}

/**
 * Show the logo exactly when the middle pane has no line to show, and hide it the
 * moment there is text. Called after a load, after a database switch and after every
 * document render (which is also what closes the last tab).
 */
export async function updateDocLogo(): Promise<void> {
  const box = $('#docLogo');
  const img = $('#docLogoImg') as HTMLImageElement | null;
  if (!box || !img || loading) return;
  if (!reader || document.querySelector('#docText .docLine')) { box.hidden = true; return; }
  if (forReader !== reader) {
    forReader = reader;
    at = findLogo();
    if (url) { URL.revokeObjectURL(url); url = null; }
  }
  if (at < 0 || !reader) { box.hidden = true; return; }
  if (!url) {
    loading = true;
    try {
      const r = await reader.resourceBytes(at);
      const ext = (r.name.split('.').pop() ?? '').toLowerCase();
      url = URL.createObjectURL(new Blob([r.bytes.slice().buffer as ArrayBuffer], { type: MIME[ext] ?? 'image/png' }));
      img.alt = reader.header.dbcname || reader.header.dbname;
    } finally {
      loading = false;
    }
  }
  if (img.getAttribute('src') !== url) img.src = url;
  box.hidden = false;
}

/** diagnostics: which resource is the logo ('' = this database has none) and is it shown */
export const logoState = () => ({
  name: at >= 0 ? (((reader as unknown as { containers: Map<string, { names?: string[] }> })
    ?.containers.get('resources')?.names ?? [])[at] ?? '') : '',
  at,
  shown: !($('#docLogo') as HTMLElement | null)?.hidden,
});
