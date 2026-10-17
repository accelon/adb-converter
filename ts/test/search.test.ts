/**
 * Phrase search tests (viewer side, no browser).
 *
 *   bun run test/search.test.ts [--adb <path>]... [--query 象曰] [--limit 5]
 *
 * The check that matters: for every hit, the text at that VA range must equal
 * the query tokens joined — i.e. the phrase really is in the text, and it may
 * sit on either side of a hard line break.
 */
import { AdbReader, SyncIO } from '../src/accelon26/adb';
import { VaPaMapper } from '../src/accelon26/vapa';
import { SearchSession, searchSummary, queryTokens, phraseMatch } from '../src/accelon26/search';

const args = process.argv.slice(2);
const opt = (n: string, d?: string) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const ADBS = args.reduce<string[]>((acc, a, i) => (a === '--adb' ? [...acc, args[i + 1]] : acc), []);
if (!ADBS.length) ADBS.push('D:\\2026\\adb-converter\\13j.adb', 'D:\\accelon3\\yinshun\\yinshun.adb');
const LIMIT = Number(opt('limit', '5'));
const QUERIES = args.reduce<string[]>((acc, a, i) => (a === '--query' ? [...acc, args[i + 1]] : acc), []);

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + name + (detail ? '  ' + detail : '')); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
};
const fmt = (n: number) => n.toLocaleString('en-US');

for (const path of ADBS) {
  console.log('\n=== ' + path + ' ===');
  const reader = await AdbReader.open(new SyncIO(path));
  const mapper = new VaPaMapper(reader);
  await mapper.init();
  const session = new SearchSession(reader);

  const queries = QUERIES.length ? QUERIES
    : reader.header.dbname === '13j' ? ['象曰', '之信', '潛龍勿用']
      : ['印順', 'Buddha', '大乘'];

  // 摘要分組（依 書）的名字：直接讀 adb 自己的 `caches` 字串表（13j 13／yinshun 44／
  // fgdict 7，每個都與該標籤的實例數相同），不必等目錄樹走完再借 treeLabels。
  {
    await session.init();          // groupTag／groupVa 由 init() 決定
    const tag = session.groupTag;
    const table = tag ? await reader.cachedStrings(tag) : [];
    const names = await session.groupNames();
    const inst = session.grouping.instances;
    ok('分組名字直接來自 caches 字串表（不是目錄樹）',
      !!tag && table.length > 0 && table.length === inst && JSON.stringify(names) === JSON.stringify(table),
      `${tag || '(none)'}：caches ${table.length} 筆＝實例 ${inst}，名字 ${JSON.stringify(names.slice(0, 3))}…`);
  }

  // ---- 1. tokenizer split ------------------------------------------------
  for (const q of queries.slice(0, 1)) {
    const toks = queryTokens(q);
    ok('query tokenizes like the index', toks.length > 0, `${JSON.stringify(q)} -> ${JSON.stringify(toks)}`);
  }

  for (const q of queries) {
    const res = await session.search(q);
    const toks = res.tokens.map((t) => t.token);
    if (res.missing.length) {
      console.log(`  -- ${JSON.stringify(q)}: 索引中沒有 ${JSON.stringify(res.missing)}（預期行為）`);
      ok(`query ${JSON.stringify(q)} handled`, true, 'token not in index');
      continue;
    }
    // ---- 2. every hit must read back as the phrase -----------------------
    let checked = 0, good = 0;
    const samples: string[] = [];
    for (const hit of res.hits.slice(0, 200)) {
      checked++;
      // read by VA span: a phrase's characters are VA-adjacent but a tag or a
      // hard break may sit between them
      const got = await mapper.textOfVaSpan(hit.va, hit.units);
      const want = toks.join('');
      if (got === want) good++;
      else if (samples.length < 3) samples.push(`VA ${fmt(hit.va)}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
    }
    ok(`all hits of ${JSON.stringify(q)} read back as the exact phrase`,
      checked === 0 || good === checked,
      `${fmt(good)}/${fmt(checked)} verified of ${fmt(res.hits.length)} hits (${res.ms.toFixed(0)} ms, tokens ${JSON.stringify(toks)})`);
    for (const s of samples) console.log('      ' + s);

    // ---- 3. summaries ----------------------------------------------------
    // No hit may produce an empty summary, and the summary must CONTAIN the hit
    // (measured on yinshun 太虛: 6 of 400 hits used to come back empty because
    // the read window was anchored on the line's first block, not the hit's).
    let emptySummaries = 0, lostHit = 0, checkedS = 0;
    for (const hit of res.hits.slice(0, 300)) {
      checkedS++;
      const s = await searchSummary(mapper, hit.va, hit.units);
      if (!s || !s.text.trim()) { emptySummaries++; continue; }
      const marked = s.text.slice(s.start, s.end);
      if (!marked || !toks.join('').startsWith(marked) && marked !== toks.join('')) lostHit++;
    }
    ok(`summaries of ${JSON.stringify(q)} are never empty and contain the hit`,
      emptySummaries === 0 && lostHit <= 1,
      `${fmt(checkedS)} checked: ${emptySummaries} empty, ${lostHit} without the full phrase`
      + '（允許 1 個：命中跨 skip 標籤，摘要只標得出可見部分）');

    for (const hit of res.hits.slice(0, LIMIT)) {
      const s = await searchSummary(mapper, hit.va, hit.units);
      if (!s) { console.log('      (no summary)'); continue; }
      const marked = s.text.slice(0, s.start) + '【' + s.text.slice(s.start, s.end) + '】' + s.text.slice(s.end);
      console.log(`      VA ${fmt(hit.va)} 行 ${s.line}: ${JSON.stringify(marked)}`);
    }
    // the marked range must be the phrase
    if (res.hits.length) {
      const s = await searchSummary(mapper, res.hits[0].va, res.hits[0].units);
      ok('summary marks exactly the phrase',
        !!s && s.text.slice(s.start, s.end) === toks.join(''),
        s ? JSON.stringify(s.text.slice(s.start, s.end)) : 'null');
      ok('summary is bounded (not the whole line)', !!s && s.text.length <= 200, s ? `${s.text.length} chars` : 'null');
    }
  }

  // ---- 4. incremental typing reuses the posting lists --------------------
  if (reader.header.dbname === '13j') {
    const t0 = performance.now();
    await session.search('潛龍');
    const two = performance.now() - t0;
    const t1 = performance.now();
    await session.search('潛龍勿用');
    const four = performance.now() - t1;
    const cached = await session.search('潛龍勿用');
    ok('search is fast enough to run per keystroke', two < 300 && four < 300,
      `2 chars ${two.toFixed(1)} ms, 4 chars ${four.toFixed(1)} ms (posting lists cached)`);
    ok('repeating the query is cheaper than the first run', cached.ms <= four + 1,
      `cached ${cached.ms.toFixed(1)} ms vs ${four.toFixed(1)} ms`);
  }

  // ---- 5. phraseMatch unit checks ---------------------------------------
  ok('phraseMatch: adjacency required', phraseMatch([[10, 20, 30], [11, 31]]).map((h) => h.va).join(',') === '10,30',
    'lists [[10,20,30],[11,31]] -> ' + JSON.stringify(phraseMatch([[10, 20, 30], [11, 31]])));
  ok('phraseMatch: single list passes through', phraseMatch([[5, 7]]).length === 2);
  ok('phraseMatch: empty list means no hit', phraseMatch([[5, 7], []]).length === 0);
  ok('phraseMatch: three tokens', phraseMatch([[1, 9], [2, 10], [3]]).map((h) => h.va).join(',') === '1',
    JSON.stringify(phraseMatch([[1, 9], [2, 10], [3]])));

  reader.close?.();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
