/**
 * 建置「單檔 HTML」的共用部分（build-viewer.ts 與 build-desktop.ts 都呼叫這支）。
 *
 * 兩個產物（file:// 版與桌面內嵌版）本來是同一份 HTML，差別只在讀檔的管道
 * （Blob.slice vs 宿主的 mmap），所以組裝只有這裡一份，避免兩邊走鐘。
 *
 * 圖示（作者 2026-10）：ts/src/accelon26/appicon.png 以 **data URI** 內嵌成 favicon ——
 * 單檔 HTML 不能依賴旁邊的檔案，data URI 才真的「一個檔案帶著走」。同一個 PNG 也是
 * exe 的圖示來源（tools/release.ts 用它產生 .ico → .syso）。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const here = import.meta.dir;
export const APPICON_PNG = resolve(here, '../src/accelon26/appicon.png');

/** favicon／apple-touch-icon 的 <link>（讀不到圖示就回空字串，頁面照樣可用）。 */
export function appIconLinks(): string {
  try {
    const b64 = readFileSync(APPICON_PNG).toString('base64');
    const uri = `data:image/png;base64,${b64}`;
    // 只要 rel="icon" 一個：apple-touch-icon 是 iOS 加主畫面用的，這裡用不到，
    // 而每個 link 都是同一份 data URI（19 KiB），多一個就多 19 KiB。
    return `<link rel="icon" type="image/png" href="${uri}">`;
  } catch {
    return '';
  }
}

/** 建置時間（About 頁的「版本」；桌面版以宿主回報的 exe 時間為準）。 */
export function buildInfo(): { buildTime: string; buildTimeText: string } {
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const text = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}`;
  return { buildTime: now.toISOString(), buildTimeText: text };
}

/** 組出單檔 HTML（bundle ＋ favicon ＋ template）。 */
export async function buildSingleFileHtml(): Promise<{ html: string; jsKiB: string; iconKiB: string }> {
  const built = await Bun.build({
    entrypoints: [resolve(here, '../src/accelon26/viewer.ts')],
    target: 'browser',
    format: 'iife',
    minify: false,
    sourcemap: 'none',
  });
  if (!built.success || !built.outputs.length) {
    for (const log of built.logs) console.error(log);
    throw new Error('bundle failed');
  }
  const js = await built.outputs[0].text();
  const template = readFileSync(resolve(here, '../src/accelon26/accelon26.template.html'), 'utf8');
  const links = appIconLinks();
  const html = template
    .replace('/*__VIEWER_BUNDLE__*/', () => js)
    .replace('<!--__APPICON__-->', () => links)
    // 建置時間：About 頁顯示用（桌面版另外有宿主回報的 exe 時間，會蓋過這個）
    .replace('<!--__BUILD_TIME__-->', () => `<script>window.__ACCELON_BUILD__=${JSON.stringify(buildInfo())};</script>`);
  return {
    html,
    jsKiB: (js.length / 1024).toFixed(1),
    iconKiB: (links.length / 1024).toFixed(1),
  };
}
