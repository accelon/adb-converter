#!/usr/bin/env bun
/** 從 build/tei-all.txt 抽出指定書名的 section，給 group.ts 做對齊。 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const full = readFileSync(join(ROOT, 'build/tei-all.txt'), 'utf8');
const header = full.slice(0, full.indexOf('<段/>'));
const parts = full.split(/(?=<段\/><書 id="n\d+">)/);
const sets: Record<string, string[]> = {
  fahua: ['妙法蓮華經', '妙法蓮華經玄義', '法華玄義釋籤', '妙法蓮華經文句', '法華文句記'],
  dari: ['大毘盧遮那成佛神變加持經', '大毘盧遮那成佛經疏', '大日經疏妙印鈔', '大日經疏妙印鈔口傳'],
};
for (const [db, titles] of Object.entries(sets)) {
  const want = new Set(titles);
  const picked = parts.filter((p) => {
    const m = /^<段\/><書 id="n\d+">([^<]+)<\/書>/.exec(p);
    return !!m && want.has(m[1]);
  });
  const out = header + picked.join('');
  writeFileSync(join(ROOT, 'build/jingqun', `${db}.txt`), out);
  console.log(db, picked.length, 'works', picked.map((p) => /^<段\/><書[^>]*>([^<]+)/.exec(p)?.[1]).join(' / '));
}
