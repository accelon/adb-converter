#!/usr/bin/env bun
/**
 * 段注引書統計：把 swjzz.adb 的 `<段注>` 掃一遍，數「X曰」與書名出現次數，輸出 markdown。
 *
 *   bun run ts/tools/swjzz-cites.ts [--adb accelon3/swjzz.adb] [--out swjzz-citations.md]
 *
 * 為什麼用「X曰」：段玉裁引書幾乎都寫成「《書》曰…」或「某曰…」，
 * 這是比對「注文引用哪一本書」最便宜的線索（作者 2026-10 提示）。
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readAdbText } from '../src/adbtext';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const ROOT = resolve(import.meta.dir, '../..');
const ADB = args.includes('--adb') ? resolve(opt('adb', '')) : resolve(ROOT, 'accelon3/swjzz.adb');
const OUT = args.includes('--out') ? resolve(opt('out', '')) : resolve(ROOT, 'docs/adb/swjzz-citations.md');

const t = readAdbText(ADB);
const duan: string[] = [];
const shiwen: string[] = [];
for (const line of t.lines) {
  const m = /^<段注>([\s\S]*)<\/段注>$/.exec(line);
  if (m) { duan.push(m[1].replace(/<[^>]*>/g, '')); continue; }
  const s = /^<(說文|說文異)>([\s\S]*)<\/\1>$/.exec(line);
  if (s) shiwen.push(s[2].replace(/<[^>]*>/g, ''));
}
const all = duan.join('');
console.log(`段注 ${duan.length} 條／${all.length} 字；說文 ${shiwen.length} 條`);

/** 「X曰」的 X 最長四字（含「某傳」「某注」這種兩段式，之後再人工歸類） */
const yue = new Map<string, number>();
for (const d of duan) for (const m of d.matchAll(/([\u3400-\u9fff]{1,4})曰/g)) {
  // 「木部曰」「艸部曰」是在指說文自己的部，不是引書；「毛傳皆曰」的「皆」也不是書名
  let k = m[1].replace(/[皆亦又並俱同]$/, '');
  if (k.endsWith('部')) continue;
  if (k.length) yue.set(k, (yue.get(k) ?? 0) + 1);
}
// 去噪：純虛詞的組合不算書名
const STOP = new Set(['故', '又', '或', '一', '亦', '是', '如', '皆', '下', '上', '此', '所', '其', '則', '而', '以', '曰', '云', '謂', '凡', '今', '古', '若', '按', '疑', '恐', '葢', '蓋', '部', '傳', '注', '說', '文']);
const yueRank = [...yue.entries()].filter(([k]) => !STOP.has(k)).sort((a, b) => b[1] - a[1]);

/** 書名（正文裡出現就算；段注很常寫「廣韵」「玉篇」而不帶「曰」） */
const BOOKS = [
  '說文', '玉篇', '廣韵', '廣韻', '釋詁', '釋言', '釋訓', '釋器', '釋獸', '釋鳥', '釋草', '釋木',
  '爾雅', '方言', '釋名', '廣雅', '集韵', '集韻', '類篇', '字林', '切韵', '唐韵', '五經文字',
  '九經字樣', '干祿字書', '經典釋文', '通俗文', '急就篇', '倉頡篇', '史籀篇',
  '詩', '毛傳', '毛詩', '韓詩', '尚書', '書', '周易', '易', '周禮', '儀禮', '禮記', '禮', '左傳',
  '左氏', '公羊', '穀梁', '論語', '孟子', '孝經', '史記', '漢書', '前漢', '後漢書', '文選',
  '楚辭', '淮南', '老子', '莊子', '荀子', '國語', '戰國策', '山海經', '水經', '白虎通',
  '史籀', '籀文', '古文', '秦刻石', '漢碑', '隸釋', '金石錄', '韻會', '洪武正韻', '華嚴',
  '大徐', '小徐', '徐鉉', '徐鍇', '繫傳', '玉裁',
];
const bookRank = BOOKS.map((b) => [b, all.split(b).length - 1] as [string, number])
  .filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);

/** 注家：段注引用漢唐注疏的「某曰」（鄭玄、顏師古、郭璞…） */
const COMMENTATORS: Record<string, string> = {
  鄭: '鄭玄', 毛: '毛亨（毛傳）', 師古: '顏師古', 杜: '杜預', 郭: '郭璞', 孟康: '孟康',
  應劭: '應劭', 如淳: '如淳', 韋昭: '韋昭', 韋: '韋昭', 張揖: '張揖', 高誘: '高誘',
  服虔: '服虔', 賈: '賈逵', 馬: '馬融', 何: '何休', 孔: '孔安國', 王: '王弼', 陸: '陸德明',
  戴先生: '戴震', 江: '江永', 錢: '錢大昕', 盧: '盧文弨', 顧: '顧炎武',
};
const commRank = Object.keys(COMMENTATORS)
  .map((k) => [k, yue.get(k) ?? 0] as [string, number])
  .filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);

const md: string[] = [];
md.push('# 《說文解字注》段注引書統計');
md.push('');
md.push(`> 由 \`ts/tools/swjzz-cites.ts\` 掃 \`${ADB}\` 產生（段注 ${duan.length.toLocaleString()} 條／${all.length.toLocaleString()} 字）。`);
md.push('> 「X曰」＝段注裡「某曰」的 X（去噪後的虛詞已排除）；書名＝全段注出現次數。');
md.push('');
md.push('## 1. 「X曰」最常見（前 40）');
md.push('');
md.push('| # | X曰 | 次數 |');
md.push('|---|---|---|');
yueRank.slice(0, 40).forEach(([k, v], i) => md.push(`| ${i + 1} | ${k}曰 | ${v} |`));
md.push('');
md.push('## 2. 書名出現次數（全段注）');
md.push('');
md.push('| 書 | 次數 | 備註 |');
md.push('|---|---|---|');
const NOTE: Record<string, string> = {
  書: '尚書（多稱「書」）', 易: '周易（多稱「易」）', 詩: '毛詩（多稱「詩」）',
  禮: '三禮泛稱', 說文: '段注自引說文', 古文: '古文經／古文奇字', 釋詁: '爾雅·釋詁',
  釋言: '爾雅·釋言', 釋訓: '爾雅·釋訓', 釋器: '爾雅·釋器', 釋獸: '爾雅·釋獸',
  廣韵: '段注寫「廣韵」（韻的俗寫）', 廣韻: '同「廣韵」', 集韵: '同「集韻」',
  小徐: '徐鍇《說文繫傳》', 大徐: '徐鉉校本', 玉裁: '段玉裁自稱',
};
bookRank.slice(0, 30).forEach(([k, v]) => md.push(`| ${k} | ${v} | ${NOTE[k] ?? ''} |`));
md.push('');
md.push('## 3. 注家（「某曰」裡的漢唐注疏家）');
md.push('');
md.push('| 簡稱 | 人 | 「某曰」次數 |');
md.push('|---|---|---|');
commRank.forEach(([k, v]) => md.push(`| ${k}曰 | ${COMMENTATORS[k]} | ${v} |`));
md.push('');
md.push('## 4. 說文與大徐本');
md.push('');
md.push(`* 段注本說文片段 ${shiwen.length.toLocaleString()} 條（每條都已用大徐本核對，見 \`swjzz-steps.md\`）。`);
md.push(`* 段注裡「說文」出現 ${all.split('說文').length - 1} 次、「許云」${all.split('許云').length - 1} 次、「許書」${all.split('許書').length - 1} 次。`);
md.push('');
writeFileSync(OUT, md.join('\n'), 'utf8');
console.log('wrote', OUT);
console.log(yueRank.slice(0, 15).map(([k, v]) => `${k}曰×${v}`).join(' '));
console.log(bookRank.slice(0, 15).map(([k, v]) => `${k}:${v}`).join(' '));
