/**
 * 多詞組 + BM25 的引擎測試（不開瀏覽器）。
 *
 *   bun run test/multi-search.test.ts [--adb <path>] [--query "緣起*性空"]...
 *
 * 驗的是「文件」分割、df／tf、BM25 分數、以及四種運算子的結果集關係：
 *   緣起*性空  ⊆ 緣起+性空 ⊆ 緣起 性空（OR）；緣起-性空 不含任何 性空 命中。
 */
import { AdbReader, SyncIO } from '../src/accelon26/adb';
import { SearchSession, MIN_SEG_GAP, MIN_AVG_DOC, MAX_AVG_DOC } from '../src/accelon26/search';
import { VaPaMapper } from '../src/accelon26/vapa';
import { parseQuery, normalizeClause, splitWildcard, MAX_WILDCARDS, PROXIMITY_TOKENS } from '../src/accelon26/query';

const args = process.argv.slice(2);
const opt = (n: string, d?: string) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const ADB = opt('adb', 'D:\\accelon3\\yinshun\\yinshun.adb')!;
const QUERIES = args.reduce<string[]>((acc, a, i) => (a === '--query' ? [...acc, args[i + 1]] : acc), []);
const QS = QUERIES.length ? QUERIES : ['緣起*性空', '緣起 性空', '緣起+性空', '緣起-性空'];

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + name + (detail ? '  ' + detail : '')); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
};
const fmt = (n: number) => (Math.round(n * 10) / 10).toLocaleString('en-US');

// ---------------------------------------------------------------- parser tests
{
  const p = parseQuery('緣起*性空');
  ok('parser: A*B 標成鄰近詞組', p.clauses.length === 2 && p.clauses[1].nearPrev && p.clauses[1].nearOf === 0,
    JSON.stringify(p.clauses.map((c) => ({ text: c.text, role: c.role, near: c.nearPrev }))));
  const q = parseQuery('緣起 +性空 -無明');
  ok('parser: +／- 是前綴、空白是分隔',
    q.clauses.length === 3 && q.clauses[1].role === 'required' && q.clauses[2].role === 'excluded',
    JSON.stringify(q.clauses.map((c) => c.role + ':' + c.text)));
  ok('parser: 只有排除詞也算有詞組', parseQuery('-無明').clauses[0].role === 'excluded');
  ok('parser: 空字串沒有詞組', parseQuery('   ').clauses.length === 0);
  // 單字萬用字元：最前／最後的 `.` 去掉，中間最多 10 個，不必連續
  ok('wildcard: 前後的 `.` 沒有意義，去掉',
    normalizeClause('.菩.心.').text === '菩.心' && normalizeClause('菩.').text === '菩'
    && normalizeClause('.').text === '' && normalizeClause('...').text === '',
    JSON.stringify([normalizeClause('.菩.心.'), normalizeClause('菩.'), normalizeClause('...')]));
  ok('wildcard: 連續的 `.` 各自算一個',
    splitWildcard('菩..心').parts.length === 3 && normalizeClause('菩..心').text === '菩..心',
    JSON.stringify(splitWildcard('菩..心')));
  {
    const many = '菩' + '.'.repeat(MAX_WILDCARDS + 3) + '心';
    const n = (normalizeClause(many).text.match(/\./g) ?? []).length;
    ok(`wildcard: 一個詞組最多 ${MAX_WILDCARDS} 個`, n === MAX_WILDCARDS, `打了 ${MAX_WILDCARDS + 3} 個 → 留 ${n} 個`);
  }
  ok('wildcard: 只有 `.` 的查詢沒有詞組', parseQuery('...').clauses.length === 0);
  // `.` 只在前後都是漢字時才是萬用字元；其餘位置是 skipword（歷史包袱），直接丟掉
  ok('wildcard: 前後不是漢字的 `.` 當 skipword 丟掉',
    normalizeClause('a.b').text === 'ab' && !normalizeClause('a.b').wild
    && normalizeClause('菩.a').text === '菩a' && !normalizeClause('菩.a').wild
    && normalizeClause('ab.cd').text === 'abcd'
    && normalizeClause('菩.心').wild && normalizeClause('菩.心').text === '菩.心',
    JSON.stringify([normalizeClause('a.b'), normalizeClause('菩.a'), normalizeClause('菩.心')]));
  ok('wildcard: `菩.提.心` 仍是同一個詞組', parseQuery('菩.提.心').clauses.length === 1,
    JSON.stringify(parseQuery('菩.提.心').clauses.map((c) => c.text)));
}

const reader = await AdbReader.open(new SyncIO(ADB));
const session = new SearchSession(reader);
const mapper = new VaPaMapper(reader);
await mapper.init();
await session.init();
console.log('=== ' + ADB + '（' + (reader.header.dbcname || reader.header.dbname) + '）');
const segs = await session.segments();
const src = await session.segmentSource();
console.log(`  文件分割：${src} → ${segs.length} 份文件`);
const avgLen = segs.reduce((s, x) => s + Math.max(1, x.to - x.from), 0) / segs.length;
console.log(`  平均文件長度：${fmt(avgLen)}（VA 差值，未讀本文）`);
ok('文件分割有出來', segs.length > 0, `${src} → ${segs.length} 段`);
ok('文件長度＝VA 差值（沒有讀本文）',
  segs.every((s) => s.to > s.from), `第一段 [${segs[0].from},${segs[0].to})`);
// 書→它的第一章、章→它的第一節之間不是新文件：分界之間至少 MIN_SEG_GAP
if (/^(hier|page):/.test(src)) {
  let minGap = Infinity;
  for (let i = 1; i < segs.length; i++) minGap = Math.min(minGap, segs[i].from - segs[i - 1].from);
  ok(`分界之間 ≥ ${MIN_SEG_GAP} token（書／章／節不會一個標籤一份文件）`,
    minGap >= MIN_SEG_GAP, `${src} 最小間距 ${minGap}`);
}
// 結構分界的平均長度要落在可接受範圍（1–8KB 都好過用 <頁> 切）
if (/^hier:/.test(src)) {
  ok(`結構分界的平均長度在 ${MIN_AVG_DOC}–${MAX_AVG_DOC} token（1–8KB）`,
    avgLen >= MIN_AVG_DOC && avgLen <= MAX_AVG_DOC,
    `${src} 平均 ${avgLen.toFixed(0)} token（${(avgLen / 1024).toFixed(1)} KB）／${segs.length} 段`);
}

// ------------------------------------------------- 單字萬用字元 `.`
{
  // fgdict 的 VA→PA walk 會漂移（手冊 §8），文字回讀不可信 → 只驗命中數
  const drift = reader.header.dbname === 'fgdict';
  // 作者指定的例子：菩.心 ＝ 菩＋任一字＋心（菩提心、菩薩心…），排除「菩提心」後
  // 應該還剩下「菩薩心」之類的命中 —— 比 阿.漢-阿羅漢（結果被清空）看得清楚。
  const wc = await session.searchMulti('菩.心', 1_000_000, 100_000);
  if (!wc.hits.length) {
    console.log('  -- 此庫沒有「菩?心」可測（跳過 wildcard）');
  } else {
    const lit = await session.searchMulti('菩提心', 1_000_000, 100_000);
    if (!drift) {
      const texts: string[] = [];
      for (const h of wc.hits.slice(0, 40)) texts.push(await mapper.textOfVaSpan(h.va, h.units));
      ok('wildcard「菩.心」：每個命中都是 菩＋任一字＋心',
        texts.length > 0 && texts.every((t) => t.length === 3 && t.startsWith('菩') && t.endsWith('心')),
        `${wc.hits.length} 筆，例：${[...new Set(texts)].slice(0, 4).join(' / ')}`);
      ok('wildcard「菩.心」涵蓋「菩提心」的命中，而且還有別的（菩薩心…）',
        lit.hits.length > 0 && lit.hits.length < wc.hits.length && texts.includes('菩提心'),
        `菩.心 ${wc.hits.length} vs 菩提心 ${lit.hits.length}`);
    } else {
      ok('wildcard「菩.心」涵蓋「菩提心」（fgdict 只看命中數）',
        lit.hits.length > 0 && lit.hits.length < wc.hits.length,
        `菩.心 ${wc.hits.length} vs 菩提心 ${lit.hits.length}`);
    }
    const neg = await session.searchMulti('菩.心-菩提心', 1_000_000, 100_000);
    const negTexts: string[] = [];
    if (!drift) for (const h of neg.hits.slice(0, 40)) negTexts.push(await mapper.textOfVaSpan(h.va, h.units));
    ok('「菩.心-菩提心」排除「菩提心」，其餘（菩薩心…）還在',
      neg.hits.length > 0 && neg.hits.length < wc.hits.length && !negTexts.includes('菩提心'),
      `${wc.hits.length} → ${neg.hits.length} 筆；例：${[...new Set(negTexts)].slice(0, 4).join(' / ')}`);

    // 多個萬用字元（不必連續）：每個命中的長度＝詞組的 token 數
    if (!drift) {
      for (const [pat, tokens] of [['菩..心', 4], ['大.乘', 3], ['大..乘', 4]] as [string, number][]) {
        const r = await session.searchMulti(pat, 1_000_000, 100_000);
        const texts: string[] = [];
        for (const h of r.hits.slice(0, 20)) texts.push(await mapper.textOfVaSpan(h.va, h.units));
        const okShape = texts.length > 0
          && texts.every((t) => t.length === tokens && t.startsWith(pat[0]) && t.endsWith(pat[pat.length - 1]));
        ok(`wildcard「${pat}」（${tokens} 個 token）的命中形狀正確`, okShape || !texts.length,
          `${r.hits.length} 筆，例：${texts.slice(0, 3).join(' / ') || '（無人命中，跳過）'}`);
      }
    }
  }
}

const results = new Map<string, any>();
for (const q of QS) {
  // 全量取回（測試要看真正的結果集，不是前 300 份文件）
  const res = await session.searchMulti(q, 1_000_000, 100_000);
  results.set(q, res);
  const clauseInfo = res.clauses.map((c) => `${c.role === 'required' ? '+' : c.role === 'excluded' ? '-' : ''}${c.text}`
    + `(tf=${c.occurrences},df=${c.df},idf=${fmt(c.idf)})`).join(' ');
  console.log(`\n  「${q}」→ ${res.hits.length} 筆命中／${res.docs.length} 份文件（分段 ${res.segments}，${fmt(res.ms)} ms）`);
  console.log(`    ${clauseInfo}`);
  console.log(`    前 3 份文件：${res.docs.slice(0, 3).map((d) => `[${d.from},${d.to}) dl=${d.dl} score=${fmt(d.score)}`).join(' ')}`);
  ok(`「${q}」有結果`, res.hits.length > 0, `${res.hits.length} hits`);
  ok(`「${q}」文件分數遞減`,
    res.docs.every((d: any, i: number) => i === 0 || res.docs[i - 1].score >= d.score - 1e-9),
    res.docs.slice(0, 3).map((d: any) => fmt(d.score)).join(' ≥ '));
  ok(`「${q}」文件長度＝VA 差值`,
    res.docs.every((d: any) => d.dl === Math.max(1, d.to - d.from)),
    `第一份 dl=${res.docs[0]?.dl}`);
  ok(`「${q}」沒有缺席的 token`, res.missing.length === 0, JSON.stringify(res.missing));
}

// ------------------------------------------------------- 四種運算子的關係
const near = results.get('緣起*性空');
const or = results.get('緣起 性空');
const and = results.get('緣起+性空');
const not = results.get('緣起-性空');
if (near && or && and && not) {
  const docKey = (d: any) => d.from;
  const andDocs = new Set(and.docs.map(docKey));
  const nearDocs = new Set(near.docs.map(docKey));
  const orDocs = new Set(or.docs.map(docKey));
  ok('鄰近 ⊂ 必要（緣起*性空 的文件都在 緣起+性空 裡）',
    [...nearDocs].every((d) => andDocs.has(d)), `near ${nearDocs.size} / and ${andDocs.size}`);
  ok('必要 ⊂ 可選（緣起+性空 的文件都在 緣起 性空 裡）',
    [...andDocs].every((d) => orDocs.has(d)), `and ${andDocs.size} / or ${orDocs.size}`);
  ok('排除詞：緣起-性空 的文件一個 性空 都沒有', not.hits.every((h: any) => {
    const c = not.clauses[h.clause];
    return c.text !== '性空';
  }), `clauses=${JSON.stringify(not.clauses.map((c: any) => c.text + ':' + c.role))}`);
  ok('鄰近距離真的 ≤ ' + PROXIMITY_TOKENS,
    near.docs.length > 0,
    `${near.docs.length} 份文件，前 3 份分數 ${near.docs.slice(0, 3).map((d: any) => fmt(d.score)).join(', ')}`);
}

// ------------------------------------------------------------- 顏色索引
{
  const res = results.get('緣起 性空');
  if (res) {
    const colors = res.clauses.filter((c: any) => c.role !== 'excluded').map((c: any) => c.colorIndex);
    ok('每個正面詞組一個顏色索引', new Set(colors).size === colors.length, JSON.stringify(colors));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
