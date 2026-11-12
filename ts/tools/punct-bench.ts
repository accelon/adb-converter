#!/usr/bin/env bun
/**
 * 跨標點比對的成本實測（作者 2026-11-12）。
 *
 *   bun run tools/punct-bench.ts [adb ...]
 *
 * 量四件事：
 *   1. 建標點表（`ensurePunct`）一次的耗時與記憶體
 *   2. 建表之後，同一個多字查詢的端到端耗時（表已在，只有比對）
 *   3. 同一批 posting 清單，`skip` 有／無 的 `phraseMatch` 耗時差
 *   4. skip 分支實際被走到的比例（複製一份 seek 帶計數器，不改生產程式）
 */
import { AdbReader, SyncIO } from '../src/accelon26/adb';
import { SearchSession } from '../src/accelon26/search';

const path = process.argv[2] ?? 'D:/accelon3/fuyan.adb';
const mb = (n: number) => (n / 1048576).toFixed(1) + ' MB';
const ms = (n: number) => n.toFixed(1) + ' ms';
const nu = (n: number) => n.toLocaleString('en-US');

const rss0 = process.memoryUsage().rss;
const t0 = performance.now();
const reader = await AdbReader.open(new SyncIO(path));
const session = new SearchSession(reader);
await session.init();
console.log(`\n=== ${path} ===`);
console.log(`open+init            ${ms(performance.now() - t0)}   maxVA=${nu(reader.header.maxBlockOffset ?? 0)}  rss=${mb(rss0)}`);

// ---- 1. 建表 ----------------------------------------------------------------
const heapA = process.memoryUsage();
const t1 = performance.now();
const skip = await (session as any).ensurePunct();
const buildMs = performance.now() - t1;
const heapB = process.memoryUsage();
const vas: number[] | null = (session as any).punctVas ?? null;
console.log(`ensurePunct（建表）  ${ms(buildMs)}   標點 VA=${nu(vas?.length ?? 0)}  heap+${mb(heapB.heapUsed - heapA.heapUsed)}  rss+${mb(heapB.rss - heapA.rss)}`);
if (skip && vas?.length) {
  // 抽樣驗 skip 判準合理
  const probe = vas[Math.floor(vas.length / 2)];
  console.log(`  skip 抽驗：VA ${nu(probe)} → ${skip(probe)}（應 true）；${nu(probe - 1)} → ${skip(probe - 1)}`);
}

// ---- 2. 端到端 ---------------------------------------------------------------
const CASES = ['涅槃寂靜', '諸行無常諸法無我', '不生亦不滅', '緣起性空'];
const timeIt = async (fn: () => Promise<unknown>, n = 5) => {
  const t: number[] = [];
  for (let i = 0; i < n; i++) {
    const s = performance.now();
    await fn();
    t.push(performance.now() - s);
  }
  t.sort((a, b) => a - b);
  return t[Math.floor(t.length / 2)];
};
console.log('\n端到端 searchPhrase（中位數，表已建）');
for (const q of CASES) {
  const r = await session.searchPhrase(q, 5000);
  const t = await timeIt(() => session.searchPhrase(q, 5000));
  console.log(`  ${q.padEnd(10)} ${ms(t).padStart(10)}   命中 ${nu(r.total ?? (r as any).hits?.length ?? 0)}`);
}
const tSingle = await timeIt(() => session.search('佛', 5000));
console.log(`  (單字對照) 佛   ${ms(tSingle).padStart(10)}`);

// ---- 3/4. 逐清單比對：skip 有無 + 走 skip 的比例 -----------------------------
function seekCounted(list: number[], target: number, maxGap: number, skipFn?: (va: number) => boolean) {
  let lo = 0, hi = list.length - 1, ans = list.length;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (list[m] >= target) { ans = m; hi = m - 1; } else lo = m + 1; }
  const p = ans < list.length ? list[ans] : -1;
  if (p < 0) return { p: -1, viaSkip: false, probes: 0 };
  if (p - target <= maxGap) return { p, viaSkip: false, probes: 0 };
  if (!skipFn) return { p: -1, viaSkip: false, probes: 0 };
  if (p - target > 4) return { p: -1, viaSkip: true, probes: 0 };
  let probes = 0;
  for (let v = target; v < p; v++) { probes++; if (!skipFn(v)) return { p: -1, viaSkip: true, probes }; }
  return { p, viaSkip: true, probes };
}

function matchCounted(lists: number[][], skipFn?: (va: number) => boolean) {
  let seeks = 0, viaSkip = 0, probes = 0, hits = 0, units = 0;
  if (!lists.length) return { hits, units, seeks, viaSkip, probes };
  for (const va of lists[0]) {
    let prev = va, ok = true;
    for (let i = 1; i < lists.length; i++) {
      seeks++;
      const r = seekCounted(lists[i], prev + 1, 0, skipFn);
      if (r.viaSkip) viaSkip++;
      probes += r.probes;
      if (r.p < 0) { ok = false; break; }
      prev = r.p;
    }
    if (ok) { hits++; units = prev - va + 1; }
  }
  return { hits, units, seeks, viaSkip, probes };
}

console.log('\n逐清單比對（同一批 posting，只差 skip）');
for (const q of CASES) {
  const lists: number[][] = [];
  for (const ch of q) {
    const st = await session.lookup(ch);
    if (!st.postings.length) { lists.length = 0; break; }
    lists.push(st.postings);
  }
  if (lists.length < 2) { console.log(`  ${q} 跳過（缺字）`); continue; }
  // 時間：純比對，不建表
  const run = (fn?: (va: number) => boolean, n = 5) => {
    const t: number[] = [];
    let r: ReturnType<typeof matchCounted> | null = null;
    for (let i = 0; i < n; i++) { const s = performance.now(); r = matchCounted(lists, fn); t.push(performance.now() - s); }
    t.sort((a, b) => a - b);
    return { t: t[Math.floor(t.length / 2)], r: r! };
  };
  const a = run(undefined);
  const b = run(skip);
  const pct = (x: number) => (100 * x).toFixed(2) + '%';
  console.log(`  ${q}`);
  console.log(`    無 skip ${ms(a.t).padStart(9)}  命中 ${nu(a.r.hits)}`);
  console.log(`    有 skip ${ms(b.t).padStart(9)}  命中 ${nu(b.r.hits)}   +${pct((b.t - a.t) / Math.max(a.t, 0.01))}`);
  console.log(`    seek 次數 ${nu(b.r.seeks)}，走到 skip 判定 ${nu(b.r.viaSkip)}（${pct(b.r.viaSkip / Math.max(b.r.seeks, 1))}），標點逐點查 ${nu(b.r.probes)}`);
}

console.log(`\n總 rss ${mb(process.memoryUsage().rss)}（開始 ${mb(rss0)}）`);
