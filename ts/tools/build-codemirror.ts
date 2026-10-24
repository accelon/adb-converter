#!/usr/bin/env bun
/**
 * Regenerate the vendored CodeMirror 6 bundle.
 *
 * This is a DEVELOPMENT-ONLY tool: the viewer still has zero runtime npm
 * dependencies. It needs the CodeMirror packages installed under ts/node_modules:
 *
 *   cd ts
 *   npm install --no-save @codemirror/state @codemirror/view @codemirror/commands
 *   bun run tools/build-codemirror.ts
 *
 * The output (src/vendor/codemirror/codemirror.js) is a classic IIFE that sets
 * window.CM, because the single-file HTML cannot use ES modules on file://.
 */
import { copyFileSync, existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const here = import.meta.dir;
const root = resolve(here, '..');
const out = resolve(root, 'src/vendor/codemirror');
const entryDir = resolve(root, '.cache');
const entry = resolve(entryDir, 'codemirror-entry.js');
if (!existsSync(resolve(root, 'node_modules/@codemirror/view'))) {
  console.error('missing @codemirror packages: run the npm install line in this file first');
  process.exit(2);
}
mkdirSync(entryDir, { recursive: true });
mkdirSync(out, { recursive: true });
writeFileSync(entry, [
  "import { EditorState, StateField, StateEffect, RangeSet, RangeSetBuilder, Compartment, Annotation, Transaction } from '@codemirror/state';",
  "import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, rectangularSelection, crosshairCursor, placeholder, Decoration, ViewPlugin, WidgetType, gutter, GutterMarker } from '@codemirror/view';",
  "import { history, historyKeymap, defaultKeymap, indentWithTab } from '@codemirror/commands';",
  "window.CM = { EditorState, StateField, StateEffect, RangeSet, RangeSetBuilder, Compartment, Annotation, Transaction, EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, rectangularSelection, crosshairCursor, placeholder, Decoration, ViewPlugin, WidgetType, gutter, GutterMarker, history, historyKeymap, defaultKeymap, indentWithTab };",
].join('\n'));
const built = await Bun.build({ entrypoints: [entry], target: 'browser', format: 'iife', minify: true, sourcemap: 'none' });
rmSync(entryDir, { recursive: true, force: true });
if (!built.success || !built.outputs.length) {
  for (const log of built.logs) console.error(log);
  process.exit(1);
}
const js = await built.outputs[0].text();
writeFileSync(resolve(out, 'codemirror.js'), js);
for (const p of ['state', 'view', 'commands']) {
  const lic = resolve(root, 'node_modules/@codemirror/' + p + '/LICENSE');
  if (existsSync(lic)) copyFileSync(lic, resolve(out, 'LICENSE-' + p));
}
writeFileSync(resolve(out, 'VERSION.txt'), 'CodeMirror 6 (state/view/commands), vendored ' + new Date().toISOString().slice(0, 10) + '\n');
console.log('wrote ' + resolve(out, 'codemirror.js') + ' (' + (js.length / 1024).toFixed(0) + ' KiB)');
