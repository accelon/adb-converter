// 為單篇文章產生「無損簡體」對照表（SAFE_PAIRS，只抽本篇用到的字）。
// 用法：bun tools/oneoff-simmap.ts <html>
import { readFileSync, writeFileSync } from 'node:fs';

const page = process.argv[2];
const DATA = 'D:\\2026\\agent-norms\\lossless-simplified\\simplified-data.ts';
const SAFE_LIT = readFileSync(DATA, 'utf8').match(/export const SAFE_PAIRS\s*=\s*((?:"[^"]*"\s*\+?\s*)+)/);
if (!SAFE_LIT) throw new Error('找不到 SAFE_PAIRS');
const SAFE = [...SAFE_LIT[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]).join('');
if (SAFE.length % 2) throw new Error('SAFE_PAIRS 不是兩字一組');

let html = readFileSync(page, 'utf8');
const body = html
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ');
const chars = new Set(body);

const ZHU_NOUN = /著(?:作|名|者|述|錄)|土著/;
const zhuOk = chars.has('著') && !ZHU_NOUN.test(body);
const FIX: Record<string, string> = { 線: '线' };

const pairs: string[] = [];
for (let i = 0; i < SAFE.length; i += 2) {
  const t = SAFE[i], s = FIX[t] ?? SAFE[i + 1];
  if (!chars.has(t)) continue;
  if (t === '著' && !zhuOk) continue;
  pairs.push(t + s);
}
const table = pairs.join('');
if (html.includes('__SIM_MAP__')) {
  html = html.replace('__SIM_MAP__', table);
  writeFileSync(page, html);
  console.log('pairs', pairs.length, 'table chars', table.length);
} else {
  console.log('no placeholder; pairs', pairs.length);
}
