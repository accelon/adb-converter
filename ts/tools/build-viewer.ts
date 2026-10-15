/**
 * Build the mockup into ONE self-contained HTML file.
 *
 *   bun run tools/build-viewer.ts [-o ../build/adbview.html]
 *
 * Why a single file with an inline classic script: on file:// an ES module is
 * blocked by CORS ("Origin 'null'"), and fetch() cannot read sibling files at
 * all. One HTML with everything inlined opens by double click, and the database
 * comes from a file picker (File API -> Blob.slice, which does random access).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const out = resolve(opt('o', resolve(import.meta.dir, '../../build/adbview.html')));
const here = import.meta.dir;

const built = await Bun.build({
  entrypoints: [resolve(here, '../src/adbview/viewer.ts')],
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

const template = readFileSync(resolve(here, '../src/adbview/adbview.template.html'), 'utf8');
const html = template.replace('/*__VIEWER_BUNDLE__*/', () => js);

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html, 'utf8');
console.log(`wrote ${out}  (${(html.length / 1024).toFixed(1)} KiB, script ${(js.length / 1024).toFixed(1)} KiB)`);
console.log('open it by double click (file://) and pick an .adb, or serve it over http.');
