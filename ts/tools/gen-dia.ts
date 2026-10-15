#!/usr/bin/env bun
/**
 * Generate ts/src/dia.ts from the Delphi source (diacritic.pas), which fills the
 * global `dia[]` table used by isAlpha() and normalize():
 *
 *   dia[i] := widechar(i) for all i, then a long list of dia[$00C0]:=$0041 ...
 *
 * Only the non identity entries are emitted.
 *
 * usage: bun run tools/gen-dia.ts [sourcecode/diacritic.pas] [ts/src/dia.ts]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..', '..');
const srcPath = process.argv[2] ?? join(root, 'build', 'pas', 'diacritic.pas');
const outPath = process.argv[3] ?? join(import.meta.dir, '..', 'src', 'dia.ts');

const text = readFileSync(srcPath, 'utf8');
const re = /dia\[\$([0-9A-Fa-f]+)\]\s*:=\s*#\$([0-9A-Fa-f]+)/g;
const map = new Map<number, number>();
for (const m of text.matchAll(re)) {
  const from = parseInt(m[1], 16);
  const to = parseInt(m[2], 16);
  if (from !== to) map.set(from, to);
}
if (map.size === 0) throw new Error(`no dia[] assignments found in ${srcPath}`);

const entries = [...map.entries()].sort((a, b) => a[0] - b[0]);
const body = entries.map(([from, to]) => `  [0x${from.toString(16)}, 0x${to.toString(16)}],`).join('\n');
const out = `/**
 * Diacritic translation table, generated from the Delphi source
 * (diacritic.pas, unit diacritic) by tools/gen-dia.ts. Do not edit by hand.
 *
 * dia[c] maps a western character to its base form; characters not listed map
 * to themselves. isAlpha() treats c as alphabetic when dia[c] !== c, so this
 * table also decides which western letters start a token.
 *
 * ${entries.length} non identity entries.
 */
export const DIA = new Map<number, number>([
${body}
]);

/** dia[c] for a code unit, falling back to the identity mapping. */
export function dia(c: number): number {
  return DIA.get(c) ?? c;
}
`;
writeFileSync(outPath, out);
console.log(`wrote ${outPath}: ${entries.length} non identity entries (range 0x${entries[0][0].toString(16)}..0x${entries[entries.length - 1][0].toString(16)})`);
