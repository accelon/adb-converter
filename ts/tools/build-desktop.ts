/**
 * Build the DESKTOP assets (the Wails3 host embeds them).
 *
 *   bun run tools/build-desktop.ts
 *
 * It builds the SAME single-file HTML as tools/build-viewer.ts (see page-build.ts) and
 * writes it to wails/assets/index.html, which the Go host embeds with
 * `//go:embed all:assets`. Only the I/O plumbing differs: on the desktop the page reads
 * through the host's mmap'd ranges (ts/src/accelon26/host.ts) instead of Blob.slice().
 *
 * The HTML build stays the default product — this script is only run when the desktop
 * host is being built (see wails/README.md for `go build`).
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { buildSingleFileHtml } from './page-build';

const here = import.meta.dir;
const out = resolve(here, '../../wails/assets/index.html');

const { html, jsKiB, iconKiB } = await buildSingleFileHtml();
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html, 'utf8');
console.log(`wrote ${out}  (${(html.length / 1024).toFixed(1)} KiB, script ${jsKiB} KiB, icon ${iconKiB} KiB)`);
console.log('now publish/build the host:  cd ts && bun run tools/release.ts --no-build');
