/**
 * 匯出 swjzz.adb 用到的全部 IDS（`<構形>`）：
 *   * markdown 清單（依出現次數）→ docs/adb/swjzz-ids.md
 *   * 每行一條的 TSV → build/swjzz-ids.tsv
 *
 *   bun run ts/tools/swjzz-ids.ts [--adb accelon3/swjzz.adb]
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readAdbText } from '../src/adbtext';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const ROOT = resolve(import.meta.dir, '../..');
const ADB = args.includes('--adb') ? resolve(opt('adb', '')) : resolve(ROOT, 'accelon3/swjzz.adb');
const MD = resolve(ROOT, 'docs/adb/swjzz-ids.md');
const TSV = resolve(ROOT, 'build/swjzz-ids.tsv');

const t = readAdbText(ADB);
const counts = new Map<string, { n: number; heads: string[] }>();
let total = 0;
let curHead = '';
for (const line of t.lines) {
  const h = /^<字[^>]*>([\s\S]*?)<\/字>/.exec(line);
  if (h) curHead = h[1];
  for (const m of line.matchAll(/<構形>([\s\S]*?)<\/構形>/g)) {
    const ids = m[1];
    total++;
    const rec = counts.get(ids) ?? { n: 0, heads: [] };
    rec.n++;
    if (rec.heads.length < 8 && !rec.heads.includes(curHead)) rec.heads.push(curHead);
    counts.set(ids, rec);
  }
}

const isIds = (s: string) => /^[\u2ff0-\u2fff]/.test(s) || /^\u303e/.test(s);
const rows = [...counts.entries()].filter(([ids]) => isIds(ids)).sort((a, b) => b[1].n - a[1].n || (a[0] < b[0] ? -1 : 1));
const other = [...counts.entries()].filter(([ids]) => !isIds(ids)).sort((a, b) => b[1].n - a[1].n);
const cp = (s: string) => [...s].map((c) => 'U+' + c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')).join(' ');
const ops = new Map<string, number>();
for (const [ids, r] of rows) {
  const first = [...ids][0];
  if (/[\u2ff0-\u2fff]/.test(first)) ops.set(first, (ops.get(first) ?? 0) + r.n);
  else ops.set('（無描述符：〾 變體指示等）', (ops.get('（無描述符：〾 變體指示等）') ?? 0) + r.n);
}

const md: string[] = [];
md.push('# swjzz.adb 用到的 IDS（構形）一覽');
md.push('');
md.push(`> 由 \`ts/tools/swjzz-ids.ts\` 掃 \`${ADB}\` 產生。`);
md.push(`> IDS＝Ideographic Description Sequence（U+2FF0–U+2FFF 的構形描述符 ＋ 部件字），`);
md.push('> 來源是 `swjz.xml` 裡「UCS 沒有的字」所附的 XML 註解（`<!--⿰氵㫄-->`），轉換時變成 `<構形>`。');
md.push('');
md.push(`* <構形> 共 **${total}** 處、不重複 **${rows.length}** 種`);
md.push(`* 出現最多的部位：\`⿰\` ${ops.get('⿰') ?? 0} 次、\`⿱\` ${ops.get('⿱') ?? 0} 次、\`⿸\` ${ops.get('⿸') ?? 0} 次、\`⿺\` ${ops.get('⿺') ?? 0} 次、\`〾\`（變體指示）${ops.get('（無描述符：〾 變體指示等）') ?? 0} 次`);
md.push('');
md.push('## 全部（依出現次數）');
md.push('');
md.push('| # | IDS | 次數 | 出現的字頭（最多 8 個） | code points |');
md.push('|---|---|---|---|---|');
rows.forEach(([ids, r], i) => md.push(`| ${i + 1} | \`${ids}\` | ${r.n} | ${r.heads.join('')} | ${cp(ids)} |`));
md.push('');
md.push('## 非 IDS 的註記（原檔註解裡不是構形描述的文字）');
md.push('');
md.push(other.map(([ids, r]) => '`' + ids + '`（' + r.n + '）').join('　'));
md.push('');
md.push('## 全部（依字串排序）');
md.push('');
md.push(rows.map(([ids]) => `\`${ids}\``).sort().join('　'));
md.push('');
writeFileSync(MD, md.join('\n'), 'utf8');
writeFileSync(TSV, rows.map(([ids, r]) => `${ids}\t${r.n}\t${r.heads.join('')}`).join('\n') + '\n', 'utf8');

console.log(`${ADB}`);
console.log(`構形 ${total} 處、不重複 ${rows.length} 種`);
console.log(`wrote ${MD}`);
console.log(`wrote ${TSV}`);
