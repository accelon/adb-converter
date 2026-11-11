#!/usr/bin/env bun
/**
 * 清掉瀏覽器測試留下的中間檔（作者 2026-11-06）。
 *
 *   cd ts && bun run tools/clean-test-temp.ts            # 只列出，不刪
 *   cd ts && bun run tools/clean-test-temp.ts --apply    # 真的刪
 *   cd ts && bun run tools/clean-test-temp.ts --apply --min-age-min 0
 *
 * 範圍（只碰這幾種，不動 C:\temp 其他東西）：
 *   C:\temp\edge_BITS_*、chrome_BITS_*、HeadlessEdge*、edge-check-*、scoped_dir*
 *   build\.smoke-*、.refresh-*、.interlink-profile*、.chrome-*
 *
 * 預設只刪「超過 60 分鐘」的，避免刪到另一個 agent 正在跑的測試。
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const opt = (n: string, d: string): string => {
  const i = args.indexOf('--' + n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const APPLY = args.includes('--apply');
const MIN_AGE_MS = Math.max(0, Number(opt('min-age-min', '60'))) * 60_000;
const TEMP_DIR = opt('temp', 'C:\\temp');
const BUILD_DIR = resolve(import.meta.dir, '../../build');

const TEMP_PATTERNS = [/^edge_BITS_/, /^chrome_BITS_/, /^HeadlessEdge/, /^edge-check-/, /^scoped_dir/];
const BUILD_PATTERNS = [/^\.smoke-/, /^\.refresh-/, /^\.interlink-profile/, /^\.chrome-/];

interface Hit { path: string; mb: number; ageMin: number; kind: string }

function dirSizeMb(path: string): number {
  let sum = 0;
  const walk = (p: string): void => {
    let ents: string[] = [];
    try { ents = readdirSync(p); } catch { return; }
    for (const e of ents) {
      const q = join(p, e);
      try {
        const st = statSync(q);
        if (st.isDirectory()) walk(q);
        else sum += st.size;
      } catch { /* 被鎖住就跳過 */ }
    }
  };
  walk(path);
  return Math.round((sum / 1_048_576) * 10) / 10;
}

function collect(dir: string, patterns: RegExp[], kind: string): Hit[] {
  if (!existsSync(dir)) return [];
  const out: Hit[] = [];
  let ents: string[] = [];
  try { ents = readdirSync(dir); } catch { return []; }
  for (const name of ents) {
    if (!patterns.some((p) => p.test(name))) continue;
    const path = join(dir, name);
    let st;
    try { st = statSync(path); } catch { continue; }
    if (!st.isDirectory()) continue;
    const ageMin = Math.round((Date.now() - st.mtimeMs) / 60_000);
    if (ageMin < MIN_AGE_MS / 60_000) continue;
    out.push({ path, mb: dirSizeMb(path), ageMin, kind });
  }
  return out;
}

const hits = [
  ...collect(TEMP_DIR, TEMP_PATTERNS, 'C:\\temp'),
  ...collect(BUILD_DIR, BUILD_PATTERNS, 'build'),
].sort((a, b) => b.mb - a.mb);

if (!hits.length) {
  console.log('沒有符合的測試中間檔（min-age=' + MIN_AGE_MS / 60_000 + ' 分）');
  process.exit(0);
}

let total = 0;
for (const h of hits) {
  total += h.mb;
  console.log(`${APPLY ? '刪除' : '可刪'}  ${h.kind.padEnd(7)} ${String(h.mb).padStart(8)} MB  ${String(h.ageMin).padStart(5)} 分  ${h.path}`);
}
console.log(`\n共 ${hits.length} 個、${Math.round(total * 10) / 10} MB`);
if (!APPLY) {
  console.log('（只是列出；加 --apply 才會刪）');
  process.exit(0);
}

let removed = 0;
const failed: string[] = [];
for (const h of hits) {
  // 只刪自己列出來、且路徑在預期根目錄下的項目
  const okRoot = h.path.startsWith(TEMP_DIR + '\\') || h.path.startsWith(BUILD_DIR + '\\');
  if (!okRoot) { failed.push(h.path + '（不在預期根目錄）'); continue; }
  try { rmSync(h.path, { recursive: true, force: true }); removed++; }
  catch (e) { failed.push(h.path + '：' + (e as Error).message); }
}
console.log(`已刪 ${removed} 個` + (failed.length ? `，${failed.length} 個失敗` : ''));
for (const f of failed.slice(0, 10)) console.log('  ' + f);
