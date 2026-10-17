/**
 * 繁簡通檢：表本身 ＋ 引擎行為（不開瀏覽器）。
 *
 *   bun run test/variants.test.ts [--adb D:\accelon3\yinshun\yinshun.adb]
 *
 * 驗的是：
 *   1. `vendor/Unihan_Variants.txt` 產生的分組表有 萨/薩、发/發/髮、干/乾/幹
 *   2. 通檢開著時，「菩萨」＝「菩薩」（posting 取聯集）；關掉時「萨」查不到
 */
import { AdbReader, SyncIO } from '../src/accelon26/adb';
import { SearchSession } from '../src/accelon26/search';
import { expandToken, setVariantSearch, variantGroupOf, variantNamePattern, variantTableStats } from '../src/accelon26/variants';
import { hasVariants } from '../src/accelon26/variants';

const args = process.argv.slice(2);
const opt = (n: string, d?: string) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const ADB = opt('adb', 'D:\\accelon3\\yinshun\\yinshun.adb')!;

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + name + (detail ? '  ' + detail : '')); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
};

// ---------------------------------------------------------------- 表本身
{
  const st = variantTableStats();
  console.log(`對照表：${st.groups} 組、${st.chars} 個字`);
  ok('表有產生（數千組、上萬字）', st.groups > 3000 && st.chars > 6000, `${st.groups} 組／${st.chars} 字`);
  ok('萨／薩 同一組', variantGroupOf('萨') === variantGroupOf('薩') && variantGroupOf('萨').includes('萨')
    && variantGroupOf('萨').includes('薩'), variantGroupOf('萨'));
  ok('发／發／髮 同一組',
    [...expandToken('发')].sort().join('') === [...new Set([...expandToken('发'), ...expandToken('發'), ...expandToken('髮')])].sort().join(''),
    expandToken('发').join(''));
  ok('干／乾／幹 同一組', expandToken('干').includes('乾') && expandToken('干').includes('幹'), expandToken('干').join(''));
  ok('沒有變體的字維持原樣', expandToken('一').join('') === '一' && !hasVariants('一'), expandToken('一').join(''));
  ok('拉丁字母不會被展開', expandToken('a').join('') === 'a');
  const re = variantNamePattern('菩萨');
  ok('詞條名樣式：菩萨 比對得到 菩薩', !!re && re.test('菩薩') && !re.test('菩提'), String(re));
}

// ---------------------------------------------------------------- 引擎
const reader = await AdbReader.open(new SyncIO(ADB));
const session = new SearchSession(reader);
await session.init();
console.log(`\n=== ${ADB}（${reader.header.dbcname || reader.header.dbname}）`);

const plain = async (q: string) => session.searchMulti(q, 1_000_000, 100_000);

setVariantSearch(false);
const off = await plain('菩萨');
const offTrad = await plain('菩薩');
setVariantSearch(true);
const on = await plain('菩萨');
const onTrad = await plain('菩薩');

ok('通檢關：簡體「菩萨」查不到（此庫是繁體）',
  off.hits.length === 0 || off.missing.length > 0,
  `${off.hits.length} 筆命中、missing=${JSON.stringify(off.missing)}`);
ok('通檢開：「菩萨」找得到（萨 → 薩 的 posting 被合併）', on.hits.length > 0, `${on.hits.length} 筆命中`);
ok('通檢開：「菩萨」與「菩薩」結果完全相同',
  on.hits.length === onTrad.hits.length
  && on.hits.every((h, i) => h.va === onTrad.hits[i].va && h.units === onTrad.hits[i].units),
  `菩萨 ${on.hits.length} vs 菩薩 ${onTrad.hits.length}`);
ok('通檢開：「菩薩」的結果沒有變（繁體本來就找得到）',
  offTrad.hits.length === onTrad.hits.length,
  `${offTrad.hits.length} vs ${onTrad.hits.length}`);
ok('通檢開：分詞仍然正確（菩＋萨 兩個 token）',
  on.clauses[0]?.tokens.length === 2, JSON.stringify(on.clauses[0]?.tokens));
if (on.hits.length) {
  console.log(`  第一個命中：VA ${on.hits[0].va}（通檢開）／${onTrad.hits[0].va}（菩薩）`);
}

// 關回去，確認快取不會污染
setVariantSearch(false);
const backOff = await plain('菩萨');
ok('把通檢關掉之後，「菩萨」又查不到了（沒有被合併快取污染）',
  backOff.hits.length === 0, `${backOff.hits.length} 筆命中`);
setVariantSearch(true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
