#!/usr/bin/env bun
/**
 * Certification test for the TypeScript indexer: rebuild the inverted index of
 * yinshun.adb and require every token's hit list to be identical to the index
 * stored inside the database.
 *
 * The fixture path can be overridden with ABX_YINSHUN; when the database is not
 * available the test reports a skip (exit 0) so it does not break on a machine
 * without the corpus.
 *
 *   bun run test/index-match.ts
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const tsDir = join(import.meta.dir, '..');
const adb = process.env.ABX_YINSHUN ?? 'D:\\accelon3\\yinshun\\yinshun.adb';

if (!existsSync(adb)) {
  console.log(`skip: ${adb} not available (set ABX_YINSHUN to point at yinshun.adb)`);
  process.exit(0);
}

const proc = Bun.spawnSync(['bun', 'run', 'tools/compare-index.ts', adb, '--json', join(tsDir, '..', 'build', 'index-yinshun.json')], {
  cwd: tsDir,
  stdout: 'pipe',
  stderr: 'pipe',
});
const out = proc.stdout.toString();
const err = proc.stderr.toString();
const lines = out.split('\n');

const tokenChecks = lines.filter((l) => /^(ok|FAIL)\s+(token hits total|distinct tokens|token key sets|every token's)/.test(l));
for (const l of tokenChecks) console.log(l);
const certified = out.includes('TOKEN INDEX MATCHES EXACTLY');
const failures = lines.filter((l) => l.startsWith('FAIL '));

console.log(`${adb}`);
console.log(certified ? 'certified: the rebuilt token index is identical to the stored one' : 'NOT certified');
if (failures.length) console.log(failures.join('\n'));
if (!certified && err) console.log(err.split('\n').slice(-5).join('\n'));

// the exit code of the tool is the pass criterion (the token index)
process.exit(proc.exitCode === 0 && certified ? 0 : 1);
