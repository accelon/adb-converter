#!/usr/bin/env bun
/**
 * 循環 import 檢查（作者 2026-11-03）。
 *
 * 為什麼要有這支：2026-11-03 加了一行 `ui.ts → reading-pane.ts` 的 import，
 * 造成 `ui → reading-pane → doc-pane → viewer → ui` 的環，build 與型別檢查都不會擋，
 * 只有執行時在「開 adb」的地方炸掉（Index out of bounds），查了半個下午。
 *
 *   cd ts && bun run tools/check-cycles.ts            # 只印環
 *   cd ts && bun run tools/check-cycles.ts --strict   # 有環就 exit 1（給 CI／習慣用）
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const STRICT = process.argv.includes('--strict');
// 這個 repo 本來就有既存的環（2026-11-03 量到 64 個，歷史共業、目前可運作）。
// 所以預設只當「有沒有變多」的哨兵：超過 baseline 才 exit 1，避免每次都紅。
const maxArg = process.argv.indexOf('--max');
const BASELINE = maxArg >= 0 && process.argv[maxArg + 1] ? Number(process.argv[maxArg + 1]) : 64;
const FAIL_OVER = STRICT ? 0 : BASELINE;
const root = resolve(import.meta.dir, '../src');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) { if (e !== 'vendor' && e !== 'fonts') walk(p, out); continue; }
    if (e.endsWith('.ts') && !e.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

const files = walk(root);
const edges = new Map<string, string[]>();
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  const deps: string[] = [];
  for (const m of src.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+'(\.[^']+)'/gm)) {
    let dep = resolve(dirname(f), m[1]);
    if (!dep.endsWith('.ts')) dep += '.ts';
    try { if (statSync(dep).isFile()) deps.push(dep); } catch { /* 忽略不存在的（.js 等） */ }
  }
  edges.set(f, deps);
}

const cycles: string[][] = [];
const state = new Map<string, 0 | 1 | 2>();
const stack: string[] = [];
function dfs(n: string): void {
  state.set(n, 1);
  stack.push(n);
  for (const d of edges.get(n) ?? []) {
    const s = state.get(d) ?? 0;
    if (s === 0) dfs(d);
    else if (s === 1) {
      const at = stack.indexOf(d);
      if (at >= 0) cycles.push(stack.slice(at).concat(d));
    }
  }
  stack.pop();
  state.set(n, 2);
}
for (const f of files) if ((state.get(f) ?? 0) === 0) dfs(f);

const rel = (p: string): string => relative(root, p).replace(/\\/g, '/');
// 同一個環可能從不同起點被找到：去掉首尾相同與重複的
const uniq = new Map<string, string[]>();
for (const c of cycles) {
  const key = [...new Set(c.map(rel))].sort().join('>');
  if (!uniq.has(key)) uniq.set(key, c);
}

if (uniq.size === 0) {
  console.log(`沒有循環 import（掃了 ${files.length} 個 .ts）`);
} else {
  console.log(`找到 ${uniq.size} 個循環 import：`);
  for (const c of uniq.values()) console.log('  ' + c.map(rel).join(' → '));
  if (uniq.size > FAIL_OVER) {
    console.error('✗ 循環 import 比基準多（' + uniq.size + ' > ' + FAIL_OVER + '）——先確認是不是你新加的 import');
    process.exit(1);
  }
  console.log('（基準 ' + FAIL_OVER + '，沒有變多）');
}
