#!/usr/bin/env bun
/** 產生文件用的族群統計表（Markdown）。 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const HERE = import.meta.dir;
const ROOT = resolve(HERE, '..');

interface JNode { no: string; title: string; author: string; cls: string; depth: number; children: JNode[] }
interface Group { family: string; label: string; roots: JNode[] }
const groups: Group[] = JSON.parse(readFileSync(join(ROOT, 'build/jingqun/jingqun.json'), 'utf8'));

const flat = (n: JNode): JNode[] => [n, ...n.children.flatMap(flat)];
const rows = groups.map((g) => {
  const ns = g.roots.flatMap(flat);
  const zhu = ns.filter((n) => n.cls === '注').length;
  const shu = ns.filter((n) => n.cls === '疏').length;
  const maxD = Math.max(...ns.map((n) => n.depth));
  const roots = g.roots.map((r) => `T${r.no.replace(/^0+/, '')} ${r.title}`).join('、');
  return { label: g.label, roots, total: ns.length, zhu, shu, maxD };
}).sort((a, b) => b.total - a.total);

const line = (r: typeof rows[0]) => `| ${r.label} | ${r.roots} | ${r.total} | ${r.zhu} | ${r.shu} | ${r.maxD} |`;
console.log('| 經群 | 根（經／論／律） | 節點 | 注 | 疏 | 最深 |');
console.log('|---|---|---:|---:|---:|---:|');
for (const r of rows) console.log(line(r));
console.log(`\n合計 ${rows.length} 群、${rows.reduce((a, r) => a + r.total, 0)} 節點`);

