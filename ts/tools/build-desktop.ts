/**
 * Build the DESKTOP assets (the Wails3 host embeds them).
 *
 *   bun run tools/build-desktop.ts
 *
 * It builds the SAME single-file HTML as tools/build-viewer.ts and writes it to
 * wails/assets/index.html, which the Go host embeds with `//go:embed all:assets`.
 * Only the I/O plumbing differs: on the desktop the page reads through the host's
 * mmap'd ranges (ts/src/adbview/host.ts) instead of Blob.slice().
 *
 * The HTML build stays the default product — this script is only run when the desktop
 * host is being built (see wails/README.md for `go build`).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const here = import.meta.dir;
const out = resolve(here, '../../wails/assets/index.html');

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
console.log('now publish/build the host:  cd ts && bun run tools/release.ts --no-build');
