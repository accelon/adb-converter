#!/usr/bin/env bun
/**
 * 驗證 jingqun.tsv：
 *   - parent / root 都存在，且 root 是 depth 0
 *   - depth 與 parent 一致、class 與 depth 一致
 *   - 沒有循環
 *   - cf 證據的 root 與 cf 相符（cf 可指 parent，會沿 ancestor 鏈檢查）
 *   - 目標部類全數在表內
 *   - idx 與 catalog 的書序一致
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const HERE = import.meta.dir;
const ROOT = resolve(HERE, '..');

interface Row { family: string; class: string; depth: number; idx: number; no: string; vol: number; title: string; parent: string; root: string; conf: string; evidence: string; }
const rows: Row[] = readFileSync(join(HERE, 'jingqun.tsv'), 'utf8')
  .split(/\r?\n/).slice(1).filter(Boolean).map((l) => {
    const p = l.split('\t');
    return { family: p[0], class: p[2], depth: +p[3], idx: +p[4], no: p[5], vol: +p[6], title: p[7], parent: p[10], root: p[12], conf: p[14], evidence: p[15] };
  });

const cat = readFileSync(join(ROOT, 'build/jingqun/catalog.tsv'), 'utf8')
  .split(/\r?\n/).slice(1).filter(Boolean).map((l) => l.split('\t'));
const catByIdx = new Map(cat.map((r) => [+r[0], r]));
const cf = new Map<string, string>();
for (const l of readFileSync(join(ROOT, 'build/jingqun/cf.tsv'), 'utf8').split(/\r?\n/).slice(1)) {
  if (l) { const p = l.split('\t'); cf.set(p[0], p[2] ?? ''); }
}
const norm = (s: string) => s.toLowerCase().replace(/^0+/, '');
const byNo = new Map(rows.map((r) => [norm(r.no), r]));
const fails: string[] = [];

const ancestors = (r: Row): string[] => {
  const out = [norm(r.no)];
  let cur = r;
  while (cur.parent && out.length < 20) {
    const p = byNo.get(norm(cur.parent));
    if (!p) break;
    out.push(norm(p.no));
    cur = p;
  }
  return out;
};

for (const r of rows) {
  if (!catByIdx.has(r.idx)) fails.push(`${r.no}: idx ${r.idx} 不在 catalog`);
  if (r.depth === 0) {
    if (r.parent) fails.push(`${r.no}: root 卻有 parent ${r.parent}`);
    if (norm(r.root) !== norm(r.no)) fails.push(`${r.no}: root ${r.root} 不等於自己`);
  } else {
    const p = byNo.get(norm(r.parent));
    if (!p) fails.push(`${r.no}: parent ${r.parent} 不存在`);
    else if (p.depth + 1 !== r.depth) fails.push(`${r.no}: depth ${r.depth} 但 parent ${p.no} 是 ${p.depth}`);
    const root = byNo.get(norm(r.root));
    if (!root) fails.push(`${r.no}: root ${r.root} 不存在`);
    else if (root.depth !== 0) fails.push(`${r.no}: root ${root.no} 不是 depth 0`);
    const want = r.depth === 1 ? '注' : '疏';
    if (r.class !== want) fails.push(`${r.no}: depth ${r.depth} 但 class ${r.class}`);
  }
  if (r.evidence.startsWith('cf:')) {
    const c = norm(r.evidence.replace(/^cf:No\./, ''));
    const chain = ancestors(r);
    if (!chain.some((x) => x === c || x.startsWith(c) || c.startsWith(x))) {
      fails.push(`${r.no}: cf ${c} 不在 ancestor 鏈（${chain.join(' → ')}）`);
    }
  }
}

// 循環
for (const r of rows) {
  let cur = r, hops = 0;
  while (cur.parent && hops++ < 20) {
    const p = byNo.get(norm(cur.parent));
    if (!p) break;
    if (norm(p.no) === norm(r.no)) { fails.push(`${r.no}: 循環`); break; }
    cur = p;
  }
}

// 目標覆蓋（與 build.ts 的 isTarget 同步）
const GUYI = new Set([
  '2732', '2733', '2734', '2735', '2736', '2737', '2738', '2739', '2740', '2741',
  '2744', '2745', '2746', '2747', '2748', '2749', '2750', '2751', '2752',
  '2753', '2754', '2755', '2756', '2757', '2758', '2759', '2760', '2761', '2762', '2763',
  '2764a', '2764b', '2765', '2766', '2767', '2768', '2769', '2770', '2771', '2772',
  '2773', '2774', '2775', '2776', '2777', '2778', '2780', '2781', '2782', '2783',
  '2784', '2785', '2786', '2797', '2798', '2799', '2800', '2801', '2802', '2803',
  '2804', '2805', '2806', '2807', '2808', '2809', '2810', '2811', '2812', '2813',
  '2814', '2815', '2816', '2823', '2902',
  '2787', '2788', '2789',
]);
const ZONG = new Set(['1859', '1860', '1887b', '1912', '1921', '1928']);
const LVSHU = new Set(['2246', '2247', '2248']);
const have = new Set(rows.map((r) => r.no));
const target = cat.filter((r) =>
  r[5] === '釋經論部' || r[5] === '經疏部' || r[5] === '論疏部' || r[5] === '律疏部' ||
  (+r[1] >= 56 && +r[1] <= 61) ||
  (+r[1] >= 62 && +r[1] <= 69 && !['2246', '2247', '2248'].includes(r[2])) ||
  GUYI.has(r[2]) || ZONG.has(r[2]) || LVSHU.has(r[2]) ||
  ['1816', '1817', '1818', '1819', '1820', '1003', '1668'].includes(r[2]));
for (const r of target) if (!have.has(r[2])) fails.push(`目標 ${r[2]} ${r[6]} 未進表`);

console.log(`rows=${rows.length} families=${new Set(rows.map((r) => r.family)).size} target=${target.length} fails=${fails.length}`);
for (const f of fails.slice(0, 40)) console.log('FAIL ' + f);
if (fails.length) process.exit(1);
