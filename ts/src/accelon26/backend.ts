/**
 * 搜尋後端的分界（作者 2026-10）：**索引運算**與 **UI** 分開。
 *
 * 兩個實作，同一個契約（`ClauseHits[]`）：
 *   * `go` —— 桌面宿主（`wails/query.go`）：一次呼叫就回每個詞組的命中，
 *             支援多詞組、`+`／`-`／`*` 與 `.` 萬用字元。
 *   * `ts` —— 純 TypeScript（`SearchSession.clauseHits()`）。
 *
 * 兩邊都只回答「詞組出現在哪些 VA」；**檔案分段與 BM25 只有一份**
 * （`SearchSession.rankClauses()`），所以 Go 與 TS 的結果必然一致 —— 由共用的
 * 測試集 `ts/test/shared/search-cases.json` 盯著（TS：`test/backend-cases.test.ts`，
 * Go：`wails/query_cases_test.go`）。
 *
 * 這一支**不 import 任何 UI 模組**（viewer／summary／paint…），所以改 UI 不必跑
 * Go 端測試，改後端（這裡＋search.ts＋query.ts＋wails/*.go）才需要。
 */
import type { AdbIO } from './adb';
import { parseQuery } from './query';
import type { ClauseHits, MultiResult, PhraseHit, SearchResult, SearchSession } from './search';
import { variantGroupOf, variantSearchOn } from './variants';

export type BackendKind = 'go' | 'ts';

/** Go 後端回答了幾個查詢（診斷／測試用：file:// 永遠是 0） */
let goQueries = 0;
export function goQueryCount(): number { return goQueries; }

/** 這個來源有沒有 Go 後端（桌面宿主才有） */
export function backendKind(io: AdbIO | null | undefined): BackendKind {
  return io?.searchQuery ? 'go' : 'ts';
}

/** Go 回來的詞組形狀（wails/query.go 的 clauseHits） */
interface GoClause {
  text: string;
  tokens: string[];
  role: 'required' | 'optional' | 'excluded';
  nearOf: number;
  wildcard: boolean;
  missing: string[];
  occurrences: number;
  hits: { va: number; units: number }[];
  colorIndex: number;
}

function mapGoClause(c: GoClause): ClauseHits {
  const hits: PhraseHit[] = (c.hits ?? []).map((h) => ({ va: h.va, units: h.units }));
  return {
    text: c.text,
    tokens: c.tokens ?? [],
    role: c.role,
    nearOf: typeof c.nearOf === 'number' ? c.nearOf : -1,
    wildcard: !!c.wildcard,
    missing: c.missing ?? [],
    occurrences: typeof c.occurrences === 'number' ? c.occurrences : hits.length,
    hits,
    colorIndex: c.colorIndex,
  };
}

/**
 * 查詢裡用得到的**變體組**（繁簡通檢，作者 2026-10）。
 *
 * 只把「這一串查詢裡真的出現的字」所屬的組傳給 Go（表很小，通常 0–3 組）；
 * 同組字的 posting 由 Go 聯集（`unionPostings`）—— 那是整個查詢最花時間的部分，
 * 放在 Go 做比在 JS 做快得多，也不必把整張表（40 KB）送過去。
 */
export function variantGroupsFor(query: string): string[] {
  const out = new Set<string>();
  for (const ch of query) {
    const g = variantGroupOf(ch);
    if (g.length > 1) out.add(g);
  }
  return [...out];
}

/** 一次後端查詢的結果：詞組命中 ＋ 診斷（誰回答的、花多久） */
export interface BackendAnswer {
  clauses: ClauseHits[];
  /** 由 Go 後端回答的（false＝TS 後端） */
  go: boolean;
  /** 後端花的毫秒（Go 是整個呼叫的來回時間，TS 是引擎時間） */
  ms: number;
}

/**
 * 查詢的唯一入口（作者 2026-10 重構）：桌面版走 Go 的 `SearchQuery`，否則用 TS 後端；
 * 兩邊都只回「每個詞組的命中」。單詞組／多詞組／運算子／萬用字元／繁簡通檢全部走這裡，
 * 不再有「單詞組走舊引擎、多詞組走另一條」的分岔。
 */
export async function queryBackend(
  session: SearchSession,
  io: AdbIO | null | undefined,
  query: string,
  maxHits = 1_000_000,
): Promise<BackendAnswer> {
  if (io?.searchQuery) {
    const groups = variantSearchOn() ? variantGroupsFor(query) : [];
    const t0 = Date.now();
    const out = await io.searchQuery(query, maxHits, groups) as { clauses?: GoClause[]; ms?: number } | null;
    if (out) {
      goQueries++;
      lastGoAnswer = { query, clauses: out.clauses?.length ?? 0, ms: out.ms ?? Date.now() - t0 };
      return {
        clauses: (out.clauses ?? []).map(mapGoClause),
        go: true,
        ms: out.ms ?? Date.now() - t0,
      };
    }
  }
  const t0 = Date.now();
  const clauses = await session.clauseHits(query, maxHits);
  return { clauses, go: false, ms: Date.now() - t0 };
}

/** 最近一次**由 Go 回答**的查詢（`state().hostSearch` 的來源；網頁版永遠 null） */
export let lastGoAnswer: { query: string; clauses: number; ms: number } | null = null;

/** 相容舊名稱：只回詞組命中（測試與少數呼叫端用） */
export async function clauseHitsFor(
  session: SearchSession,
  io: AdbIO | null | undefined,
  query: string,
  maxHits = 1_000_000,
): Promise<ClauseHits[]> {
  return (await queryBackend(session, io, query, maxHits)).clauses;
}

/** 多詞組／運算子／萬用字元查詢（分段＋BM25 在 TS 這一側） */
export async function searchMultiVia(
  session: SearchSession,
  io: AdbIO | null | undefined,
  query: string,
  maxHits = 5000,
  docLimit = 300,
): Promise<MultiResult> {
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const parsed = parseQuery(query);
  const segs = await session.segments();
  const { clauses } = await queryBackend(session, io, query, maxHits);
  return session.rankClauses(parsed, clauses, segs, maxHits, docLimit, t0);
}

/**
 * 查詢的唯一入口（作者 2026-10 重構）：
 *   單一詞組、沒有運算子 → `singleResult()`（不排名，全部命中照 VA 排＋分群統計）
 *   有空白／`+`／`-`／`*`／`.` → `rankClauses()`（分段＋BM25）
 *
 * 兩條都從**同一份 `ClauseHits`** 出發，而且都可能是 Go 或 TS 回答的，所以
 * 「桌面版／網頁版」「單詞／多詞」的結果只取決於引擎本身，不再取決於走哪條路。
 */
export async function searchAutoVia(
  session: SearchSession,
  io: AdbIO | null | undefined,
  query: string,
): Promise<SearchResult> {
  const parsed = parseQuery(query);
  const complex = parsed.hasOperators || parsed.wildcard || parsed.clauses.length > 1;
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  if (!complex) {
    const { clauses } = await queryBackend(session, io, query, 5000);
    return session.singleResult(parsed, clauses, 5000, t0);
  }
  const m = await searchMultiVia(session, io, query);
  return {
    query,
    tokens: m.clauses.flatMap((c) => c.tokens.map((t) => ({ token: t, block: -1, postings: [] as number[] }))),
    hits: m.hits,
    missing: m.missing,
    truncated: m.truncated,
    groups: m.groups,
    groupTag: session.groupTagName,
    ms: m.ms,
    multi: m,
  };
}
