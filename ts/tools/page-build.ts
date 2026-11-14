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
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const here = import.meta.dir;
export const APPICON_PNG = resolve(here, '../src/accelon26/appicon.png');

/** 內嵌梵字字型（悉曇／蘭札；作者 2026-10-31）。
 *
 * 經文裡的梵字是 Unicode 第 16 平面私用區（U+100000–U+10FFFD），系統字型
 * 一定沒有；所以把 CBETA 原字型改寫 cmap、子集化後以 **data URI** 放進單檔
 * HTML。桌面版（wails/assets/index.html）也吃同一份，不必另外安裝字型。
 * 讀不到字型檔就回空字串，頁面照樣可用（只是梵字會變豆腐）。
 */
export function fontFaceCss(): string {
  const dir = resolve(here, '../src/accelon26/fonts');
  const fonts: Array<[family: string, file: string, range: string]> = [
    // 2026-11-01：CBETA 的 Siddam（415.6 KiB）換成 Noto Sans Siddham（48.7 KiB）＋
    // 81 個 Noto 排不出來的字（從 CBETA 抽出，12.1 KiB）。
    ['Accelon Siddham Uni', 'accelon-siddham-unicode.woff2', 'U+11580-115FF'],
    ['Accelon Siddham Extra', 'accelon-siddham-extra.woff2', 'U+FA000-10AFFF'],
    ['Accelon Ranjana', 'accelon-ranjana.woff2', 'U+100000-10FFFD'],
    // 製表符（U+2500–257F）：JhengHei／TNR 的框線字元只有 0.709em，漢字與全形
    // 空格是 1em，用字元排的圖（《中觀論頌講記》5p34 的科判圖）每往右一格就少
    // 4.66px，整張圖會散（厚觀法師 2026-11-14 20:07 回報）。這支只有 22 個
    // 幾何字形、1em 寬，見 build-box-font.py。
    ['Accelon Box', 'accelon-box.woff2', 'U+2500-257F'],
  ];
  const out: string[] = [];
  for (const [family, file, range] of fonts) {
    const p = resolve(dir, file);
    if (!existsSync(p)) continue;
    const b64 = readFileSync(p).toString('base64');
    // Ranjana 的字身比 Siddham 小很多（glyph 約 0.6em）；用 size-adjust 放大，
    // 讓它和漢字／悉曇並排時視覺大小一致（作者 2026-10-31）。
    const adjust = family === 'Accelon Ranjana' ? 'size-adjust:160%;' : '';
    out.push(
      `@font-face{font-family:'${family}';src:url(data:font/woff2;base64,${b64}) format('woff2');` +
        `font-weight:400;font-style:normal;font-display:swap;${adjust}unicode-range:${range};}`,
    );
  }
  return out.join('\n');
}

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
export async function buildSingleFileHtml(): Promise<{ html: string; jsKiB: string; iconKiB: string; fontKiB: string }> {
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
  // CodeMirror 6: vendored, loaded as a classic script before the viewer bundle.
  let cm = '';
  try {
    cm = readFileSync(resolve(here, '../src/vendor/codemirror/codemirror.js'), 'utf8')
      .replace(/<\/script/gi, '<\\/script');
  } catch {
    cm = '/* CodeMirror bundle not built: run tools/build-codemirror.ts */';
  }
  const links = appIconLinks();
  const fontCss = fontFaceCss();
  const html = template
    .replace('/*__VIEWER_BUNDLE__*/', () => js)
    .replace('/*__CM_BUNDLE__*/', () => cm)
    .replace('<!--__APPICON__-->', () => links)
    .replace('/*__FONTS__*/', () => fontCss)
    // 建置時間：About 頁顯示用（桌面版另外有宿主回報的 exe 時間，會蓋過這個）
    .replace('<!--__BUILD_TIME__-->', () => `<script>window.__ACCELON_BUILD__=${JSON.stringify(buildInfo())};</script>`);
  return {
    html,
    jsKiB: (js.length / 1024).toFixed(1),
    iconKiB: (links.length / 1024).toFixed(1),
    fontKiB: (fontCss.length / 1024).toFixed(1),
  };
}
