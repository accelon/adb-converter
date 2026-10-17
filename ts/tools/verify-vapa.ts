/**
 * VA→PA verification using the short posting lists of an .adb.
 *
 *   bun run tools/verify-vapa.ts --adb <adb> [--max-hits 2] [--limit N] [--verbose]
 *
 * Every token that occurs only once or twice is an independent test case: read
 * its posting VA, convert VA→PA with the mapper, take the text at that exact
 * position, and require it to be that token. The adb's own index is the answer
 * key, so the check covers real positions spread over the whole text instead of
 * sampling a few frequent tokens.
 *
 * Measured (2026-02):
 *   13j.adb   3,006/3,006 = 100%    (VA 444..818,194, all 102 source blocks)
 *   yinshun   4,572/4,573 = 99.98%  (VA 83..7,676,890, 772 source blocks)
 * The single yinshun miss is a whitespace run sharing a VA with a token, i.e.
 * the build's blank policy differs (SPEC §15.3). 100% is not a goal: the
 * tokenizer went through several versions, so a handful of positions not lining
 * up is expected — and this mapper exists to highlight search hits in the
 * viewer, not to rebuild the index.
 */
import { AdbReader, SyncIO } from '../src/accelon26/adb';
import { VaPaMapper } from '../src/accelon26/vapa';
import { normalize } from '../src/tokenize';

const args = process.argv.slice(2);
const opt = (n: string, d?: string) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const PATHS = args.reduce<string[]>((acc, a, i) => (a === '--adb' ? [...acc, args[i + 1]] : acc), []);
if (!PATHS.length) PATHS.push('D:\\2026\\adb-converter\\13j.adb');
const MAX_HITS = Number(opt('max-hits', '2'));
const LIMIT = Number(opt('limit', '0'));
const VERBOSE = args.includes('--verbose');

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + name + (detail ? '  ' + detail : '')); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
};

for (const path of PATHS) {
  console.log('\n=== ' + path + ' ===');
  const t0 = performance.now();
  const reader = await AdbReader.open(new SyncIO(path));
  const mapper = new VaPaMapper(reader);
  await mapper.init();

  const rows = reader.tokens();
  // short posting lists first; bytes is a good filter (a 1-hit list is 5 bytes)
  const short = rows.filter((r) => r.bytes <= 8 + 4 * MAX_HITS).sort((a, b) => a.bytes - b.bytes);
  const total = short.length;
  const use = LIMIT > 0 ? short.slice(0, LIMIT) : short;
  console.log(`  tokens with a short posting list (<= ${MAX_HITS} hits): ${total.toLocaleString()}, testing ${use.length.toLocaleString()}`);

  let checked = 0, exact = 0, exactName = 0, missing = 0;
  const failures: string[] = [];
  let posMin = Infinity, posMax = -1, blocks = new Set<number>();

  for (const r of use) {
    const postings = await reader.decodeBlockList('tokens', r.i);
    if (postings.length > MAX_HITS) continue;
    for (const va of postings) {
      checked++;
      const h = await mapper.highlight(va);
      if (!h) { missing++; if (failures.length < 12) failures.push(`VA ${va} (${JSON.stringify(r.name)}): no position`); continue; }
      blocks.add(h.block);
      posMin = Math.min(posMin, va); posMax = Math.max(posMax, va);
      const got = h.text;
      const gotNorm = normalize(got);
      if (got === r.name) exact++;
      if (gotNorm === r.name) exactName++;
      else if (failures.length < 12) {
        const el = h.element;
        failures.push(`VA ${va.toLocaleString()} block ${h.block} expected ${JSON.stringify(r.name)} got ${JSON.stringify(got)}` +
          ` (norm ${JSON.stringify(gotNorm)}) element=${el ? el.kind + (el.tag ? ':' + el.tag : '') : '?'}` +
          (el ? ` el.va=${el.va} el.text=${JSON.stringify(el.text.slice(0, 24))}` : ''));
      }
    }
  }

  const ms = performance.now() - t0;
  ok('every short-posting VA resolves to its own token (normalized compare)',
    checked > 0 && exactName === checked,
    `${exactName.toLocaleString()}/${checked.toLocaleString()} correct, ${missing} unresolved, ` +
    `VA range ${posMin.toLocaleString()}–${posMax.toLocaleString()}, ${blocks.size} source blocks, ${(ms / 1000).toFixed(1)} s`);
  console.log(`  byte-exact matches (before normalization): ${exact.toLocaleString()}/${checked.toLocaleString()}`);
  if (failures.length) {
    console.log('  first failures:');
    for (const f of failures) console.log('    ' + f);
  }
  if (VERBOSE) {
    // show a few successes with their text for eyeballing
    for (const r of use.slice(0, 8)) {
      const postings = await reader.decodeBlockList('tokens', r.i);
      const h = await mapper.highlight(postings[0]);
      console.log(`    ${JSON.stringify(r.name)} VA ${postings[0]} -> PA ${h?.pa} block ${h?.block} text ${JSON.stringify(h?.text)}`);
    }
  }
  reader.close?.();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
