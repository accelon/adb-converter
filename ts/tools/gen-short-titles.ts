/**
 * 產出 `short-titles.ts`：印順著作的「短名」對照表。
 *
 * 來源是 `D:\2023\yinshun-corpus\xml\y*.xml` 每冊開頭的
 *   <articlegroup resp="yap" label="般若;般若經講記"/>
 * 意思是：全名「般若經講記」在引用、回連結時用「般若」。
 *
 *   bun run ts/tools/gen-short-titles.ts
 *
 * 產物進版控，執行時不必再讀 corpus。
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = 'D:/2023/yinshun-corpus/xml';
const OUT = 'D:/2026/adb-converter/ts/src/accelon26/short-titles.ts';

const map: Record<string, string> = {};
for (const f of readdirSync(SRC)) {
  if (!/^y\d+\.xml$/i.test(f)) continue;
  const text = readFileSync(join(SRC, f), 'utf8');
  for (const m of text.matchAll(/<articlegroup[^>]*label="([^"]*)"/g)) {
    const [short, full] = m[1].split(';');
    if (!short || !full) continue;
    if (!map[full]) map[full] = short;
  }
}

const keys = Object.keys(map).sort((a, b) => a.localeCompare(b, 'zh-Hant'));
const body = keys.map((k) => `  ${JSON.stringify(k)}: ${JSON.stringify(map[k])},`).join('\n');
const ts = `/**
 * 印順著作的短名（作者 2026-10-28）。
 *
 * 由 ts/tools/gen-short-titles.ts 從 corpus XML 的
 * \`<articlegroup resp="yap" label="短名;全名"/>\` 產生——回連結按鈕要短，
 * 所以「般若經講記」只寫「般若」，也不加《》。
 * 重新產生：bun run ts/tools/gen-short-titles.ts
 */
export const SHORT_TITLES: Record<string, string> = {
${body}
};
`;
writeFileSync(OUT, ts, 'utf8');
console.log(`wrote ${OUT}: ${keys.length} 條`);
