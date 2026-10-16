/**
 * Build the mockup into ONE self-contained HTML file.
 *
 *   bun run tools/build-viewer.ts [-o ../build/adbview.html]
 *
 * Why a single file with an inline classic script: on file:// an ES module is
 * blocked by CORS ("Origin 'null'"), and fetch() cannot read sibling files at
 * all. One HTML with everything inlined opens by double click, and the database
 * comes from a file picker (File API -> Blob.slice, which does random access).
 * The favicon is inlined as a data URI too (ts/src/adbview/appicon.png).
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { buildSingleFileHtml } from './page-build';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const out = resolve(opt('o', resolve(import.meta.dir, '../../build/adbview.html')));

const { html, jsKiB, iconKiB } = await buildSingleFileHtml();
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html, 'utf8');
console.log(`wrote ${out}  (${(html.length / 1024).toFixed(1)} KiB, script ${jsKiB} KiB, icon ${iconKiB} KiB)`);
console.log('open it by double click (file://) and pick an .adb, or serve it over http.');
