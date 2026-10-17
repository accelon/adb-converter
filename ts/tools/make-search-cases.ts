/**
 * 產生 **Go／TS 共用**的搜尋測試集：`test/shared/search-cases.json`。
 *
 *   bun run tools/make-search-cases.ts            # 重寫（以 TS 後端為答案）
 *
 * 只記錄「詞組層」的東西（token、缺失、命中數、前幾個 VA、units）——那正是
 * Go 後端（`wails/query.go`）與 TS 後端（`SearchSession.clauseHits()`）都負責的部分；
 * 檔案分段與 BM25 只在 TS，不進這個檔案。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { AdbReader, SyncIO } from '../src/accelon26/adb';
import { SearchSession } from '../src/accelon26/search';
import { setVariantSearch } from '../src/accelon26/variants';
import { variantGroupsFor } from '../src/accelon26/backend';

const DBS: Record<string, string> = {
  '13j': 'D:\\2026\\adb-converter\\13j.adb',
  yinshun: 'D:\\accelon3\\yinshun\\yinshun.adb',
  fgdict: 'D:\\accelon3\\fgdict.adb',
};

// 每個庫都跑同一組查詢：單詞、多詞、運算子、萬用字元、缺字、只有排除詞。
const QUERIES = [
  '乾',
  '象曰',
  '象曰 潛龍',
  '潛龍+勿用',
  '潛龍-勿用',
  '潛龍*勿用',
  '乾.元',
  '見.龍',
  '.乾',
  '乾. 元',
  '緣起 性空',
  '緣起*性空',
  '緣起+性空-無明',
  '菩薩',
  '菩.心',
  '涅槃 解脫',
  'zzz 不存在',
  '-無明',
  '光明 無明',
  '佛.法',
];

const OUT = resolve(import.meta.dir, '..\\test\\shared\\search-cases.json');

// 繁簡通檢（變體組）也要有共用案例：TS 算出答案，Go 用同一組 `groups` 重跑
// （Go 會把同組字的 posting 聯集；這一段是計算量最大的部分）。
const VARIANT_QUERIES = ['菩薩', '眾生', '說服', '涅槃 解脫', '菩.心', '佛.法'];

interface ClauseCase {
  text: string;
  role: string;
  near: number;
  wild: boolean;
  tokens: string[];
  missing: string[];
  occurrences: number;
  units: number;
  first: number[];
  last: number;
}

const cases: { db: string; query: string; clauses: ClauseCase[] }[] = [];
const variantCases: { db: string; query: string; groups: string[]; clauses: ClauseCase[] }[] = [];
const pack = (clauses: Awaited<ReturnType<SearchSession['clauseHits']>>): ClauseCase[] => clauses.map((c) => ({
  text: c.text,
  role: c.role,
  near: c.nearOf,
  wild: c.wildcard,
  tokens: c.tokens,
  missing: c.missing,
  occurrences: c.occurrences,
  units: c.hits[0]?.units ?? 0,
  first: c.hits.slice(0, 3).map((h) => h.va),
  last: c.hits.length ? c.hits[c.hits.length - 1].va : -1,
}));

for (const [db, path] of Object.entries(DBS)) {
  let reader;
  try {
    reader = await AdbReader.open(new SyncIO(path));
  } catch {
    console.log(`skip ${db}: ${path} 不存在`);
    continue;
  }
  const session = new SearchSession(reader);
  for (const query of QUERIES) {
    const clauses = await session.clauseHits(query, 1_000_000);
    cases.push({ db, query, clauses: pack(clauses) });
    console.log(`${db} ${JSON.stringify(query)} → ${clauses.map((c) => c.occurrences).join('/')}`);
  }
  // 繁簡通檢：答案用「開著通檢」的 TS 後端算
  setVariantSearch(true);
  for (const query of VARIANT_QUERIES) {
    const clauses = await session.clauseHits(query, 1_000_000);
    variantCases.push({ db, query, groups: variantGroupsFor(query), clauses: pack(clauses) });
    console.log(`  ${db} 通檢 ${JSON.stringify(query)} → ${clauses.map((c) => c.occurrences).join('/')}` +
      `（groups ${variantGroupsFor(query).length}）`);
  }
  setVariantSearch(false);
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({
  version: 2,
  source: 'tools/make-search-cases.ts（TS 後端）',
  cases,
  variantCases,
}, null, 1) + '\n', 'utf8');
console.log(`wrote ${OUT}（${cases.length} 個查詢 ＋ ${variantCases.length} 個通檢案例）`);
