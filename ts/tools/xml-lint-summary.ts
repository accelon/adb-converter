#!/usr/bin/env bun
/**
 * Summarise build/xml-lint.json (produced by tools/xml-lint.ts --json).
 *
 *   bun run tools/xml-lint-summary.ts [build/xml-lint.json] [--top N]
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface Finding {
  file: string;
  lines: number;
  tagsSeen: number;
  issueTotal: number;
  issueCounts: Record<string, number>;
  separators: number;
  undeclared: string[];
}

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--')) ?? join(import.meta.dir, '..', '..', 'build', 'xml-lint.json');
const top = args.includes('--top') ? Number(args[args.indexOf('--top') + 1]) : 12;
const results: Finding[] = JSON.parse(readFileSync(file, 'utf8'));

const kinds = new Map<string, number>();
let totalIssues = 0;
let clean = 0;
let withUndeclared = 0;
let withNonSeparator = 0;
for (const r of results) {
  if (r.issueTotal === 0 && r.undeclared.length === 0) clean++;
  else if (r.issueTotal === 0) clean++;
  totalIssues += r.issueTotal;
  for (const [k, n] of Object.entries(r.issueCounts ?? {})) kinds.set(k, (kinds.get(k) ?? 0) + n);
  if (r.undeclared.length) withUndeclared++;
  const nonSep = Object.entries(r.issueCounts ?? {}).filter(([k]) => k !== 'separator');
  if (nonSep.length) withNonSeparator++;
}

console.log(`${results.length} databases, ${clean} clean, ${results.length - clean} with findings`);
console.log(`issue kinds: ${[...kinds.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}=${n}`).join(' ')}`);
console.log(`databases whose only finding is the 檔 separator: ${results.filter((r) => r.issueTotal > 0 && Object.keys(r.issueCounts).every((k) => k === 'separator')).length}`);
console.log(`databases with undeclared tags: ${withUndeclared}, with non separator issues: ${withNonSeparator}`);

const rank = [...results]
  .filter((r) => r.issueTotal)
  .sort((a, b) => b.issueTotal - a.issueTotal)
  .slice(0, top);
console.log(`\ntop ${rank.length} by issue count:`);
for (const r of rank) {
  const counts = Object.entries(r.issueCounts).map(([k, n]) => `${k}=${n}`).join(' ');
  console.log(`  ${r.issueTotal.toString().padStart(8)}  ${r.file.replace(/^.*[\\/]/, '').padEnd(28)} ${counts}${r.undeclared.length ? ` undeclared=${r.undeclared.length}` : ''}`);
}

const undeclared = new Map<string, number>();
for (const r of results) for (const u of r.undeclared) undeclared.set(u, (undeclared.get(u) ?? 0) + 1);
if (undeclared.size) {
  console.log(`\nundeclared tag names (in ${undeclared.size} distinct):`);
  console.log('  ' + [...undeclared.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, n]) => `${k}(${n})`).join(' '));
}
