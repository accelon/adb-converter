/**
 * 內文標籤盤點：哪些標籤有 `t=` 定義、哪些是結構標籤（頁／段）、哪些沒處理。
 *
 *   cd ts && bun run tools/tag-stats.ts [--adb <path>]...
 *
 * 輸出每一庫的標籤統計（出現次數、是否結構標籤、例子），以及「未處理但數量不少」的清單
 * —— 這是渲染器（`src/accelon26/render_accelon3.ts`）決定要特別處置哪些標籤的依據。
 */
import { AdbReader, SyncIO } from '../src/accelon26/adb';
import { loadTrees } from '../src/accelon26/search';

const args = process.argv.slice(2);
const ADBS = args.reduce<string[]>((acc, a, i) => (a === '--adb' ? [...acc, args[i + 1]] : acc), []);
if (!ADBS.length) ADBS.push('13j.adb', 'D:\\accelon3\\yinshun\\yinshun.adb', 'D:\\accelon3\\fgdict.adb');

/** 已經是「結構標籤」的：不用 t= 也該特別處置 */
const SPECIAL = new Set(['頁', '_頁', '段']);

const TAG_RE = /<(\/?)([^\s<>/!?]+)((?:\s+[^<>]*)?)(\/?)>/g;

for (const path of ADBS) {
  const reader = await AdbReader.open(new SyncIO(path));
  const trees = await loadTrees(reader);
  const tierTags = new Set<string>();
  for (const t of trees) for (const tier of t.tiers) tierTags.add(tier);

  // `t=` 屬性表：`<tag>.t` → 這個 tag 的實例自己宣告下一層
  const attrs = reader.containers.get('attributes');
  const declared = new Set<string>();
  for (const key of attrs?.names ?? []) {
    const dot = key.lastIndexOf('.');
    if (dot <= 0 || key.slice(dot + 1) !== 't') continue;
    const tag = key.slice(0, dot);
    declared.add(tag);
    const av = await reader.attributeValues(key);
    for (const v of av?.values ?? []) {
      for (const raw of v.split(',')) {
        const name = raw.trim().replace(/\.$/, '');
        if (name) tierTags.add(name);
      }
    }
  }

  // 掃 source：標籤出現次數 + 一個例子
  const counts = new Map<string, number>();
  const example = new Map<string, string>();
  const blocks = reader.containers.get('source')?.count ?? 0;
  for (let b = 0; b < blocks; b++) {
    const text = await reader.sourceText(b);
    if (!text) continue;
    for (const line of text.split('\n')) {
      TAG_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = TAG_RE.exec(line))) {
        const name = m[2];
        if (m[1]) continue;                     // 只算開標籤（含自閉合）
        counts.set(name, (counts.get(name) ?? 0) + 1);
        if (!example.has(name)) example.set(name, line.trim().slice(0, 70));
      }
    }
  }

  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const structural = rows.filter(([name]) => tierTags.has(name) || declared.has(name) || SPECIAL.has(name));
  const unknown = rows.filter(([name]) => !tierTags.has(name) && !declared.has(name) && !SPECIAL.has(name));
  console.log(`\n=== ${path}（${reader.header.dbcname || reader.header.dbname}）`);
  console.log(`  標籤 ${rows.length} 種、出現 ${rows.reduce((s, r) => s + r[1], 0)} 次`);
  console.log(`  t= 定義的層級標籤：${[...tierTags].join('、') || '(無)'}`);
  console.log(`  自己宣告 t= 的標籤：${[...declared].join('、') || '(無)'}`);
  console.log('  結構標籤：');
  for (const [name, n] of structural.slice(0, 12)) {
    const kind = SPECIAL.has(name) ? '特殊' : (tierTags.has(name) ? 'tier' : 't=');
    console.log(`    ${kind.padEnd(3)} <${name}> ${n.toLocaleString('en-US')}　例：${example.get(name)}`);
  }
  console.log(`  沒有 t= 定義、也不是頁／段：${unknown.length} 種`);
  for (const [name, n] of unknown.slice(0, 15)) {
    console.log(`    <${name}> ${n.toLocaleString('en-US')}　例：${example.get(name)}`);
  }
}
