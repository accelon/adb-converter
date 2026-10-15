#!/usr/bin/env bun
/**
 * Stress test the extractor: pick the databases with the most XML findings from
 * build/xml-lint.json, extract them, and let python's expat check every file.
 *
 *   bun run tools/stress-extract.ts [--count 4] [--max-mb 300]
 */
import { readFileSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

const args = process.argv.slice(2);
const count = args.includes('--count') ? Number(args[args.indexOf('--count') + 1]) : 4;
const maxMb = args.includes('--max-mb') ? Number(args[args.indexOf('--max-mb') + 1]) : 300;
const tsDir = join(import.meta.dir, '..');
const root = join(tsDir, '..');
const outRoot = join(root, 'build', 'xstress');

interface Lint {
  file: string;
  issueTotal: number;
  issueCounts: Record<string, number>;
}
const lint: Lint[] = JSON.parse(readFileSync(join(root, 'build', 'xml-lint.json'), 'utf8'));
const picked = lint
  .filter((r) => r.issueTotal > 10)
  .sort((a, b) => b.issueTotal - a.issueTotal)
  .filter((r) => {
    try {
      return statSync(r.file).size < maxMb * 1024 * 1024;
    } catch {
      return false;
    }
  })
  .slice(0, count);

console.log(`stress extracting ${picked.length} databases (each < ${maxMb} MB)`);
for (const p of picked) {
  const name = basename(p.file, '.adb');
  const out = join(outRoot, name);
  rmSync(out, { recursive: true, force: true });
  const t0 = Date.now();
  const proc = Bun.spawnSync(['bun', 'run', 'tools/extract.ts', p.file, '-o', out, '--quiet'], { cwd: tsDir });
  const lines = proc.stdout.toString().trim().split('\n');
  const summary = lines[lines.length - 2] ?? lines[lines.length - 1] ?? '';
  const repairs = lines[lines.length - 1] ?? '';
  console.log(
    `${name.padEnd(16)} size=${(statSync(p.file).size / 1048576).toFixed(0).padStart(5)}MB issues=${String(p.issueTotal).padStart(6)} ` +
      `${((Date.now() - t0) / 1000).toFixed(1)}s  ${Object.entries(p.issueCounts).map(([k, n]) => `${k}=${n}`).join(' ')}`,
  );
  console.log(`  ${summary}`);
  if (proc.exitCode !== 0) console.log(`  exit=${proc.exitCode} ${proc.stderr.toString().slice(-300)}`);
  console.log(`  ${repairs}`);
}
console.log(`\ncheck with: python build/xml-check.py ${outRoot}`);
