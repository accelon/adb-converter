/**
 * vendor/Unihan_Variants.txt → 繁簡通檢表（`ts/src/accelon26/variant-data.ts`）。
 *
 *   cd ts && bun run tools/gen-variants.ts [--fields kTraditionalVariant,kSimplifiedVariant]
 *                                         [--out src/accelon26/variant-data.ts] [--check]
 *
 * 做法：把 Unihan 的「變體」關係當成無向圖，用 union-find 併成「同一組字」。
 * 只收漢字（基本區／擴充 A／相容表意文字），並丟掉只有一個字的組。
 *
 * 預設只用 **kTraditionalVariant ＋ kSimplifiedVariant**（真正的繁簡對應）。
 * 想要更寬的通檢（異體字）可以加 `--fields kZVariant`（裡／裏、說／説…）。
 *
 * 產物是一行字串：組與組之間用 `|`，組內就是那幾個字（例：`发發髮|干乾幹`）。
 * 逐字掃描時只建一次索引，不必把 JSON 塞進 bundle。
 *
 * SOURCE (不進 git，這支工具也**不**下載):
 *   https://github.com/CNMan/Unicode/blob/master/Unihan/Unihan_Variants.txt
 *   → 手動放到 vendor/Unihan_Variants.txt（.gitignore 已排除 vendor/）。
 *   產物 variant-data.ts 已 commit，所以建置／測試不需要 vendor/；
 *   只有要重新產生對照表（Unihan 更新、或改 --fields）時才需要那個檔。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const opt = (n: string, d?: string) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const ROOT = resolve(import.meta.dir, '../..');
const SRC = resolve(ROOT, 'vendor/Unihan_Variants.txt');
const OUT = resolve(ROOT, 'ts', opt('out', 'src/accelon26/variant-data.ts')!);
const FIELDS = new Set((opt('fields', 'kTraditionalVariant,kSimplifiedVariant') ?? '').split(',').map((s) => s.trim()).filter(Boolean));
const CHECK = args.includes('--check');

if (!existsSync(SRC)) {
  console.error(`找不到 ${SRC}`);
  console.error('vendor/Unihan_Variants.txt 不進 git（.gitignore 排除 vendor/）。需要時自己下載：');
  console.error('  https://github.com/CNMan/Unicode/blob/master/Unihan/Unihan_Variants.txt');
  console.error('放到 vendor/Unihan_Variants.txt 再跑一次。');
  console.error('建置與測試不需要它：產物 src/accelon26/variant-data.ts 已經在 repo 裡。');
  process.exit(2);
}

const isHan = (cp: number): boolean =>
  (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0xf900 && cp <= 0xfaff)
  || (cp >= 0x20000 && cp <= 0x2fa1f);

// ---- union-find ------------------------------------------------------------
const parent = new Map<number, number>();
const find = (x: number): number => {
  let p = parent.get(x);
  if (p === undefined) { parent.set(x, x); return x; }
  while (p !== x) {
    const up = parent.get(p) ?? p;
    if (up === p) break;
    parent.set(x, up);            // path compression
    x = p; p = up;
  }
  return p;
};
const union = (a: number, b: number): void => {
  const ra = find(a), rb = find(b);
  if (ra !== rb) parent.set(ra, rb);
};

// ---- parse -----------------------------------------------------------------
const lines = readFileSync(SRC, 'utf8').split(/\r?\n/);
let relations = 0;
const perField = new Map<string, number>();
for (const line of lines) {
  if (!line || line.startsWith('#')) continue;
  const cols = line.split('\t');
  if (cols.length < 3) continue;
  const field = cols[1].trim();
  if (!FIELDS.has(field)) continue;
  const a = Number.parseInt(cols[0].replace(/^U\+/, ''), 16);
  if (!Number.isFinite(a) || !isHan(a)) continue;
  for (const raw of cols[2].split(/\s+/)) {
    const b = Number.parseInt(raw.split('<')[0].replace(/^U\+/, ''), 16);
    if (!Number.isFinite(b) || !isHan(b) || b === a) continue;
    union(a, b);
    relations++;
    perField.set(field, (perField.get(field) ?? 0) + 1);
  }
}

// ---- groups ----------------------------------------------------------------
const groups = new Map<number, number[]>();
for (const cp of parent.keys()) {
  const root = find(cp);
  const list = groups.get(root);
  if (list) list.push(cp); else groups.set(root, [cp]);
}
const out: string[] = [];
let chars = 0;
for (const list of groups.values()) {
  if (list.length < 2) continue;
  const s = list.sort((x, y) => x - y).map((cp) => String.fromCodePoint(cp)).join('');
  out.push(s);
  chars += list.length;
}
out.sort();
const data = out.join('|');

const header = `/**
 * GENERATED FILE — do not edit.
 *
 * \`cd ts && bun run tools/gen-variants.ts\` 從 \`vendor/Unihan_Variants.txt\` 重新產生。
 * 資料來源（**不進 git**，工具也不會下載）：
 *   https://github.com/CNMan/Unicode/blob/master/Unihan/Unihan_Variants.txt
 *
 * 欄位：${[...FIELDS].join('、')}；每組是「同一個字的不同寫法」（繁簡／異體），
 * 組與組之間用 \`|\`。查詢端用 \`variants.ts\` 建立索引。
 *
 * 統計：${out.length} 組、${chars} 個字、${relations} 條關係（來源 ${lines.length} 行）。
 */
`;

const body = `${header}export const VARIANT_GROUPS = ${JSON.stringify(data)};\n`;
const existing = (() => { try { return readFileSync(OUT, 'utf8'); } catch { return ''; } })();

if (CHECK) {
  if (existing === body) { console.log(`OK：${OUT} 已是最新（${out.length} 組／${chars} 字）`); process.exit(0); }
  console.error(`NG：${OUT} 與 vendor/Unihan_Variants.txt 不一致（跑一次 gen-variants.ts）`);
  process.exit(1);
}

writeFileSync(OUT, body, 'utf8');
console.log(`wrote ${OUT}`);
console.log(`  ${out.length} 組、${chars} 個字、${relations} 條關係（${[...perField].map(([k, v]) => `${k} ${v}`).join('、')}）`);
for (const probe of ['萨薩', '发發髮', '干乾幹', '里裡裏']) {
  const hit = out.find((g) => probe[0] && g.includes(probe[0]) && [...probe].every((c) => g.includes(c)));
  console.log(`  例：${hit ?? `（${probe} 不在同一組）`}`);
}
