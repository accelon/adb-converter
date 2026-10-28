#!/usr/bin/env bun
/**
 * 列出 adb 裡「沒有 j」的 `<聯 i="taisho?…">`，寫成 broken-quote.md。
 *
 *   bun run ts/tools/broken-quotes.ts --adb accelon3/ys.adb --out broken-quote.md
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readAdbText } from '../src/adbtext';
import { AdbReader, SyncIO } from '../src/accelon26/adb';

const ROOT = resolve(import.meta.dir, '../..');
const args = process.argv.slice(2);
const opt = (n: string, d?: string) => { const k = args.indexOf('--' + n); return k >= 0 ? args[k + 1] : d; };
const ADB = resolve(ROOT, opt('adb', 'accelon3/ys.adb')!);
const OUT = resolve(ROOT, opt('out', 'docs/adb/broken-quote.md')!);
const TSV = resolve(ROOT, opt('tsv', 'build/ys-broken-quotes.tsv')!);

const taisho = await AdbReader.open(new SyncIO(resolve(ROOT, 'accelon3/taisho.adb')));
const pageIds = new Set((await taisho.attributeValues('頁.id'))!.values);
const db = readAdbText(ADB);

type Row = { srcPage: string; line: number; target: string; reason: string; q: string };
const rows: Row[] = [];
let curPage = '';
for (let li = 0; li < db.lines.length; li++) {
  const line = db.lines[li];
  const pm = /<頁 id="([^"]*)"/.exec(line);
  if (pm) curPage = pm[1];
  if (!line.includes('<聯')) continue;
  for (const m of line.matchAll(/<聯([^>]*)>/g)) {
    const attrs = m[1];
    const i = /\bi="([^"]*)"/.exec(attrs)?.[1] ?? '';
    const q = /\bq="([^"]*)"/.exec(attrs)?.[1] ?? '';
    if (!i.startsWith('taisho?') || /\bj="/.test(attrs)) continue;
    const target = i.slice(7);
    const reason = !q ? 'no-q（內部連結）' : !pageIds.has(target) ? 'no-page（頁 id 不存在）' : 'no-match（頁內找不到）';
    rows.push({ srcPage: curPage, line: li + 1, target, reason, q });
  }
}
const count = (p: string) => rows.filter((r) => r.reason.startsWith(p)).length;
const noQ = count('no-q'), noPage = count('no-page'), noMatch = count('no-match');
const md = (s: string) => s.replace(/\|/g, '\\|');
const short = (s: string, n = 80) => (s.length > n ? s.slice(0, n) + '…' : s);

let out = `# 找不到精確位置的引文（broken quotes）\n\n`;
out += `> 產生：${new Date().toISOString().slice(0, 19).replace('T', ' ')}（UTC）\n`;
out += `> 來源：\`${ADB.replace(ROOT + '\\', '').replace(ROOT + '/', '')}\`\n`;
out += `> 工具：\`bun run ts/tools/broken-quotes.ts\`\n\n`;
out += `這些 \`<聯>\` 沒有 \`j\`（字元範圍），閱讀器只能用 \`q\` 做頁內文字比對；\n`;
out += `在找到人工校正前，先留在這裡。\n\n`;
out += `全文檢索（到 \`taisho.adb\` 找是否在別頁）的結果見\n[\`broken-quote-elsewhere.md\`](broken-quote-elsewhere.md)。\n\n`;
out += `## 統計\n\n`;
out += `| 原因 | 條數 | 說明 |\n|---|---:|---|\n`;
out += `| no-match | ${noMatch} | 頁 id 存在，但頁面（含前後頁）找不到足夠相似的文字 |\n`;
out += `| no-q | ${noQ} | 舊式 \`<聯 l=…>\` 內部連結，沒有 \`q\` |\n`;
out += `| no-page | ${noPage} | \`i\` 指的頁 id 不在 \`taisho.adb\` |\n`;
out += `| **合計** | **${rows.length}** | |\n\n`;
out += `## 清單\n\n`;
out += `| # | 來源頁 | 行 | 目標頁 | 原因 | q |\n|---:|---|---:|---|---|---|\n`;
rows.forEach((r, k) => {
  out += `| ${k + 1} | ${md(r.srcPage || '—')} | ${r.line} | ${md(r.target)} | ${md(r.reason)} | ${md(short(r.q)) || '—'} |\n`;
});
writeFileSync(OUT, out);
writeFileSync(TSV, rows.map((r) => [r.srcPage, r.line, r.target, r.reason, r.q].join('\t')).join('\n') + '\n');
console.log(`wrote ${OUT}（${rows.length} 條：no-match ${noMatch}、no-q ${noQ}、no-page ${noPage}）`);
console.log(`wrote ${TSV}`);
process.exit(0);
