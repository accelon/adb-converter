#!/usr/bin/env bun
/**
 * Markdown vault (Obsidian) → Accelon .adb — one command, no UI.
 *
 *   bun run tools/md2adb.ts <vault.zip | vault-dir> -o <out.adb>
 *        [--title 書名] [--name lunyu] [--xml <dir>] [--referenced-only] [--quiet]
 *
 * The mapping itself lives in `src/vault-plan.ts` (shared with the viewer's
 * 「加入 Obsidian」, so the browser and the CLI produce the same database), and the
 * container layout in `src/author-core.ts`. This file is only the I/O: read the
 * zip or the folder, hand the planner the files, write the .adb.
 *
 * Default: EVERY picture in the vault is packed (small unused glyph images
 * included — see VaultOptions.allImages); `--referenced-only` packs just the ones
 * the notes point at.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { authorAdb } from '../src/adbauthor';
import { planVault, type VaultFile } from '../src/vault-plan';
import { readZip } from '../src/zipread';

const args = process.argv.slice(2);
/** `--name value` or `-name value` (both spellings are accepted) */
const opt = (name: string, dflt?: string): string | undefined => {
  for (const f of ['--' + name, '-' + name]) {
    const i = args.indexOf(f);
    if (i >= 0 && args[i + 1]) return args[i + 1];
  }
  return dflt;
};
const flag = (name: string): boolean => args.includes('--' + name);
const valueArgs = new Set<string>();
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('-')) valueArgs.add(args[i + 1] ?? '');
}
const input = args.find((a) => !a.startsWith('-') && !valueArgs.has(a));
const out = opt('o');
if (!input || !out) {
  console.error('usage: bun run tools/md2adb.ts <vault.zip|dir> -o out.adb [--name id] [--title 書名] [--xml dir] [--referenced-only]');
  process.exit(2);
}
const quiet = flag('quiet');
const say = (m: string) => { if (!quiet) console.error(m); };

/** Bun on Windows throws EEXIST from mkdirSync(recursive) when the folder exists */
function ensureDir(p: string): void {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

/* ------------------------------------------------------------------ read the vault */

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);

function skipPath(rel: string): boolean {
  return rel.split('/').some((p) => p === '.obsidian' || p === '.git' || p === '.trash');
}

function loadVault(path: string): { files: VaultFile[]; label: string } {
  const st = statSync(path);
  if (st.isDirectory()) {
    const files: VaultFile[] = [];
    const walk = (dir: string, rel: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (skipPath(childRel)) continue;
          walk(join(dir, e.name), childRel);
        } else if (extname(e.name).toLowerCase() === '.md') {
          files.push({ path: childRel, text: readFileSync(join(dir, e.name), 'utf8') });
        } else if (IMAGE_EXT.has(extname(e.name).toLowerCase())) {
          files.push({ path: childRel, bytes: new Uint8Array(readFileSync(join(dir, e.name))) });
        }
      }
    };
    walk(path, '');
    return { files, label: basename(resolve(path)) };
  }

  const entries = readZip(readFileSync(path));
  const files: VaultFile[] = [];
  for (const e of entries) {
    if (e.isDir) continue;
    const parts = e.name.split('/');
    // the whole vault is usually wrapped in one top-level folder
    const rel = parts.length > 1 ? parts.slice(1).join('/') : parts[0];
    if (!rel || skipPath(rel)) continue;
    const ext = extname(rel).toLowerCase();
    if (ext === '.md') files.push({ path: rel, text: e.bytes.toString('utf8') });
    else if (IMAGE_EXT.has(ext)) files.push({ path: rel, bytes: new Uint8Array(e.bytes) });
  }
  const tops = new Set(entries.map((e) => e.name.split('/')[0]));
  return { files, label: tops.size === 1 ? [...tops][0] : basename(resolve(path)) };
}

/* ------------------------------------------------------------------ build */

const { files, label } = loadVault(input);
// 與「加入 Obsidian」一致：書名不含書名號，兩邊產生的檔頭才會相同
const title = (opt('title') ?? label).replace(/《|》/g, '');
const dbname = (opt('name') ?? (label.replace(/[^\x20-\x7e]/g, '') || 'book')).slice(0, 31);

const plan = planVault(files, { title, allImages: !flag('referenced-only') });
for (const w of plan.warnings) say('  note: ' + w);
say(
  `vault: ${plan.stats.chapters} 章 in ${plan.stats.pian} 篇, ${plan.stats.entries} 字, ` +
    `${plan.stats.vaultImages} image(s) in the vault, ${plan.stats.images} packed, ` +
    `${plan.stats.skipped} ignored file(s)`,
);

const xmlDir = opt('xml');
if (xmlDir) {
  ensureDir(xmlDir);
  ensureDir(join(xmlDir, 'resources'));
  writeFileSync(join(xmlDir, `${dbname}.xml`), plan.lines.join('\n'), 'utf8');
  for (const r of plan.resources) writeFileSync(join(xmlDir, 'resources', r.name), r.bytes);
}

const t0 = performance.now();
const result = await authorAdb({
  dbname,
  dbcname: title,
  lines: plan.lines,
  resources: plan.resources.map((r) => ({ name: r.name, bytes: Buffer.from(r.bytes) })),
  log: (m) => say('  ' + m),
});
ensureDir(dirname(resolve(out)));
writeFileSync(out, result.file);

const ms = Math.round(performance.now() - t0);
say(
  `built ${out}: ${(result.file.length / 1048576).toFixed(2)} MiB in ${ms} ms — ` +
    `${result.lines} lines, ${result.tokens} tokens / ${result.tokenHits} hits, ` +
    `${result.tagNames.length} tags (${result.tagNames.join(' ')}), ` +
    `${result.resources} resources (${(result.resourceBytes / 1048576).toFixed(2)} MiB)`,
);
