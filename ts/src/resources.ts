/**
 * Build the `resources` container from the files an extract run wrote.
 *
 * resources is a named, sorted container whose data blocks are the raw file
 * bytes (index.pas: writeresources -> boSorted|boNamed, format bits 0). The
 * block name is the path relative to the extract output directory, e.g.
 * `images/mc0198.png`, exactly as stored in the original database.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildContainer, BO_NAMED, BO_SORTED, BO_UNICODE } from './romblock';

export function resourcesFromDir(
  dir: string,
  byCodeUnit: (a: string, b: string) => number,
): { buffer: Buffer; count: number; bytes: number } | null {
  const root = join(dir, 'resources');
  if (!existsSync(root)) return null;
  const names: string[] = [];
  const blocks: Buffer[] = [];
  const walk = (rel: string): void => {
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(child);
      else {
        names.push(child);
        blocks.push(readFileSync(join(root, child)));
      }
    }
  };
  walk('');
  if (!names.length) return null;
  const order = names.map((_, i) => i).sort((a, b) => byCodeUnit(names[a], names[b]));
  const buffer = buildContainer({
    feature: BO_NAMED | BO_SORTED,
    blocks: order.map((i) => blocks[i]),
    names: order.map((i) => names[i]),
    // the original yinshun.adb has plain boUnicode (0x3) here, not boSorted
    nameFeature: BO_UNICODE,
  });
  return { buffer, count: names.length, bytes: blocks.reduce((a, b) => a + b.length, 0) };
}
