/**
 * 後端測試（共用測試集的 TS 這一側）：
 *
 *   bun run test/backend-cases.test.ts
 *
 * 讀 `test/shared/search-cases.json`（`tools/make-search-cases.ts` 產生），
 * 1) 用 **TS 後端**（`SearchSession.clauseHits`）重算，確認答案沒漂
 * 2) 用 **`backend.ts` 的宿主路徑**（假的 io，回傳 Go 形狀的 JSON）再算一次，
 *    確認兩條路徑（Go／TS）在分界層看到同一個 `ClauseHits[]`
 *
 * Go 那一側跑同一份檔案：`wails/query_cases_test.go`（`go test`）。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AdbReader, SyncIO } from '../src/accelon26/adb';
import { SearchSession } from '../src/accelon26/search';
import { backendKind, clauseHitsFor, goQueryCount, searchAutoVia, variantGroupsFor } from '../src/accelon26/backend';

const DBS: Record<string, string> = {
  '13j': resolve(import.meta.dir, '..\\..\\13j.adb'),
  yinshun: 'D:\\accelon3\\yinshun\\yinshun.adb',
  fgdict: 'D:\\accelon3\\fgdict.adb',
};

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + name + (detail ? '  ' + detail : '')); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
};

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

const file = resolve(import.meta.dir, 'shared\\search-cases.json');
const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
  cases: { db: string; query: string; clauses: ClauseCase[] }[];
  variantCases?: { db: string; query: string; groups: string[]; clauses: ClauseCase[] }[];
};
const cases = parsed.cases;
const variantCases = parsed.variantCases ?? [];
console.log(`共用測試集：${cases.length} 個查詢、${variantCases.length} 個通檢案例（${file}）`);

const byDb = new Map<string, typeof cases>();
for (const c of cases) byDb.set(c.db, [...(byDb.get(c.db) ?? []), c]);

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

for (const [db, list] of byDb) {
  const path = DBS[db];
  if (!path || !(await Bun.file(path).exists())) {
    console.log(`  --  跳過 ${db}（找不到 ${path}）`);
    continue;
  }
  const reader = await AdbReader.open(new SyncIO(path));
  const session = new SearchSession(reader);
  ok(`${db}: 網頁版走 TS 後端`, backendKind(reader.io as never) === 'ts');

  // 假的宿主 io：把 TS 的答案包成 Go 的 JSON 形狀，驗證 backend.ts 的映射
  const fakeIo = {
    size: 0,
    read: async () => new Uint8Array(),
    searchQuery: async (q: string) => {
      const got = await session.clauseHits(q, 1_000_000);
      return {
        query: q,
        clauses: got.map((c) => ({
          text: c.text, tokens: c.tokens, role: c.role, nearOf: c.nearOf, wildcard: c.wildcard,
          missing: c.missing, occurrences: c.occurrences,
          hits: c.hits.map((h) => ({ va: h.va, units: h.units })),
          colorIndex: c.colorIndex,
        })),
        missing: [...new Set(got.flatMap((c) => c.missing))],
        ms: 0,
      };
    },
  };
  ok(`${db}: 有 searchQuery 就走 Go 後端`, backendKind(fakeIo as never) === 'go');

  for (const c of list) {
    const ts = await session.clauseHits(c.query, 1_000_000);    const mine = ts.map((x) => ({
      text: x.text, role: x.role, near: x.nearOf, wild: x.wildcard, tokens: x.tokens,
      missing: x.missing, occurrences: x.occurrences, units: x.hits[0]?.units ?? 0,
      first: x.hits.slice(0, 3).map((h) => h.va), last: x.hits.length ? x.hits[x.hits.length - 1].va : -1,
    }));
    ok(`${db} ${JSON.stringify(c.query)}：TS 後端與共用測試集一致`,
      same(mine, c.clauses),
      mine.map((m) => m.occurrences).join('/') + ' 詞組');

    const viaHost = await clauseHitsFor(session, fakeIo as never, c.query, 1_000_000);
    const hostView = viaHost.map((x) => ({
      text: x.text, role: x.role, near: x.nearOf, wild: x.wildcard, tokens: x.tokens,
      missing: x.missing, occurrences: x.occurrences, units: x.hits[0]?.units ?? 0,
      first: x.hits.slice(0, 3).map((h) => h.va), last: x.hits.length ? x.hits[x.hits.length - 1].va : -1,
    }));
    ok(`${db} ${JSON.stringify(c.query)}：宿主路徑與 TS 後端同一個結果`,
      same(hostView, mine));
  }

  // 分界層的 `searchAutoVia()` 必須與引擎自己的 `searchAuto()` 給出同一組命中
  // （Go 後端只換掉「詞組命中」那一段，分段／BM25 還是同一支程式）。
  for (const q of ['象曰 潛龍', '緣起*性空', '菩.心', '光明 無明', '乾']) {
    if (!list.some((c) => c.query === q)) continue;
    const a = await session.searchAuto(q);
    const b = await searchAutoVia(session, fakeIo as never, q);
    const key = (r: typeof a) => ({
      n: r.hits.length,
      first: r.hits.slice(0, 5).map((h) => h.va),
      multi: !!r.multi,
      docs: r.multi?.docCount ?? 0,
    });
    ok(`${db} ${JSON.stringify(q)}：searchAutoVia ≡ searchAuto`, same(key(a), key(b)),
      JSON.stringify(key(a)));
  }

  // 繁簡通檢（作者 2026-10）：**仍然走 Go**，差別只在多傳 `groups`；
  // Go 會把同組字的 posting 聯集起來（`unionPostings`）。TS 只負責挑出「這一串查詢
  // 用得到的那幾組」—— 表很小，不必整張送過去。
  {
    const { setVariantSearch, variantSearchOn: variantSearchOnValue } = await import('../src/accelon26/variants');
    const seen: string[][] = [];
    // 假宿主：記下收到的 groups，答案用「開著通檢的 TS 後端」模擬 Go 的聯集結果
    const fakeVariantIo = {
      size: 0,
      read: async () => new Uint8Array(),
      searchQuery: async (q: string, _maxHits: number, groups: string[] = []) => {
        seen.push(groups);
        const prev = variantSearchOnValue();
        setVariantSearch(groups.length > 0);
        const got = await session.clauseHits(q, 1_000_000);
        setVariantSearch(prev);
        return {
          query: q,
          clauses: got.map((c) => ({
            text: c.text, tokens: c.tokens, role: c.role, nearOf: c.nearOf, wildcard: c.wildcard,
            missing: c.missing, occurrences: c.occurrences,
            hits: c.hits.map((h) => ({ va: h.va, units: h.units })),
            colorIndex: c.colorIndex,
          })),
          missing: [...new Set(got.flatMap((c) => c.missing))],
          ms: 0,
        };
      },
    };
    setVariantSearch(true);
    for (const vc of variantCases.filter((x) => x.db === db)) {
      const want = vc.clauses.map((c) => c.occurrences);
      const groups = variantGroupsFor(vc.query);
      const goBefore = goQueryCount();
      const got = await clauseHitsFor(session, fakeVariantIo as never, vc.query, 1_000_000);
      const gotView = got.map((c) => ({
        text: c.text, role: c.role, near: c.nearOf, wild: c.wildcard, tokens: c.tokens,
        missing: c.missing, occurrences: c.occurrences, units: c.hits[0]?.units ?? 0,
        first: c.hits.slice(0, 3).map((h) => h.va), last: c.hits.length ? c.hits[c.hits.length - 1].va : -1,
      }));
      ok(`${db} 通檢 ${JSON.stringify(vc.query)}：走 Go 後端並傳入變體組`,
        goQueryCount() === goBefore + 1 && variantSearchOnValue()
        && same(seen[seen.length - 1], groups)
        && groups.every((g) => [...g].length >= 2),
        `groups ${JSON.stringify(groups)}（${groups.length} 組）→ 命中 ${want.join('/')}`);
      ok(`${db} 通檢 ${JSON.stringify(vc.query)}：結果與共用測試集一致`,
        same(gotView, vc.clauses), gotView.map((c) => c.occurrences).join('/'));
    }
    // 「菩薩」只有「薩」有變體組（菩 沒有）；「眾生」的「眾」有
    const g1 = variantGroupsFor('菩薩');
    const g2 = variantGroupsFor('眾生');
    ok(`${db}: variantGroupsFor 只挑查詢用到的字`,
      g1.some((s) => s.includes('薩')) && g2.some((s) => s.includes('眾'))
      && variantGroupsFor('zzz').length === 0,
      `菩薩 → ${JSON.stringify(g1)}｜眾生 → ${JSON.stringify(g2)}｜zzz → ${JSON.stringify(variantGroupsFor('zzz'))}`);
    setVariantSearch(false);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
