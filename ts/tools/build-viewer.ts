/**
 * Build the mockup into ONE self-contained HTML file.
 *
 *   bun run tools/build-viewer.ts [-o D:\\accelon3\\accelon26.html]（預設就寫到 D:\\accelon3）
 *
 * Why a single file with an inline classic script: on file:// an ES module is
 * blocked by CORS ("Origin 'null'"), and fetch() cannot read sibling files at
 * all. One HTML with everything inlined opens by double click, and the database
 * comes from a file picker (File API -> Blob.slice, which does random access).
 * The favicon is inlined as a data URI too (ts/src/accelon26/appicon.png).
 *
 * 產物名稱（作者 2026-10）：`accelon26.html` —— 和執行檔同名，讀者不會在
 * 「accelon26.html」與「accelon26.exe」之間猜哪個是同一份東西。viewer 模組本身仍叫
 * accelon26（`ts/src/accelon26/`），改的只是產物檔名。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { buildSingleFileHtml } from './page-build';

const args = process.argv.slice(2);
// 接受 `--o 值` 或 `-o 值`（fuyan 2026-11-13 回報：舊實作只認 `--o`，
// 照表頭 `-o …` 敲會被忽略、靜默寫回預設路徑）。
const opt = (n: string, d: string) => {
  let i = args.indexOf('--' + n);
  if (i < 0) i = args.indexOf('-' + n);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('-') ? args[i + 1] : d;
};
// 作者 2026-10-31（說了很多次）：viewer 一律寫到 D:/accelon3（本機部署位置），
// 不是 repo 的 build/。要換位置用 -o 或 ACCELON3_DIR。
const DEPLOY_DIR = process.env.ACCELON3_DIR || 'D:/accelon3';
const out = resolve(opt('o', resolve(DEPLOY_DIR, 'accelon26.html')));

const { html, jsKiB, iconKiB, fontKiB } = await buildSingleFileHtml();
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html, 'utf8');
console.log(`wrote ${out}  (${(html.length / 1024).toFixed(1)} KiB, script ${jsKiB} KiB, icon ${iconKiB} KiB, fonts ${fontKiB} KiB)`);
console.log('open it by double click (file://) and pick an .adb, or serve it over http.');
