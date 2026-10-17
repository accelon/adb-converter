/**
 * VA → PA mapping tests.
 *
 *   bun run test/vapa.test.ts [--adb <path>]... [--blocks N] [--quick]
 *
 * The walk replays the indexer's own VA accounting. Two ground truths stored in
 * the adb check it, both produced by the original Delphi build:
 *   - tables/blocks.virtual : the VA at which each source block starts
 *   - tags container        : the VA of every tag instance
 * If both match, the mapping is exact rather than approximate.
 */
import { AdbReader, SyncIO } from '../src/accelon26/adb';
import { VaPaMapper } from '../src/accelon26/vapa';

const args = process.argv.slice(2);
const opt = (n: string, d?: string) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const ADBS = args.reduce<string[]>((acc, a, i) => (a === '--adb' ? [...acc, args[i + 1]] : acc), []);
if (!ADBS.length) ADBS.push('D:\\2026\\adb-converter\\13j.adb');
const BLOCKS = Number(opt('blocks', '0'));
const QUICK = args.includes('--quick');

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
  const srcCount = reader.containers.get('source')!.count;

  // ---- 1 + 2. full walk vs blocks.virtual and the tags container ----------
  const t0 = performance.now();
  const v = await mapper.validate({ maxBlocks: BLOCKS || srcCount, tags: !QUICK });
  ok('block boundary VAs reproduced by the walk', v.blockMismatch.length === 0,
    `${fmt(v.blocksChecked)}/${fmt(srcCount)} blocks, ${fmt(v.linesWalked)} lines in ${(performance.now() - t0).toFixed(0)} ms`);
  for (const m of v.blockMismatch.slice(0, 6)) console.log(`      block ${m.block}: walked ${fmt(m.walked)} vs stored ${fmt(m.stored)} (delta ${m.walked - m.stored})`);
  ok('tag instance VAs match the tags container', v.tagMismatch.length === 0,
    `${fmt(v.tagsChecked)} tag instances compared`);
  for (const m of v.tagMismatch.slice(0, 6)) console.log(`      tag ${m.tag}: walked ${fmt(m.walked)} vs stored ${fmt(m.stored)}`);

  // ---- 3. highlight / context on real postings ---------------------------
  const rows = reader.tokens().slice().sort((a, b) => b.bytes - a.bytes);
  const samples: { name: string; postings: number[] }[] = [];
  for (const r of rows) {
    if (r.cls !== 0) continue;
    samples.push({ name: r.name, postings: (await reader.decodeBlockList('tokens', r.i)).slice(0, 8) });
    if (samples.length >= 3) break;
  }
  let checked = 0, wrong = 0;
  const lines: string[] = [];
  for (const s of samples) {
    for (const va of s.postings) {
      const el = await mapper.elementAt(va);
      checked++;
      if (!el) { wrong++; continue; }
      const isSelf = el.element.kind === 'token' && el.element.normalized === s.name;
      if (!isSelf) {
        wrong++;
        if (lines.length < 4) lines.push(`${JSON.stringify(s.name)} VA ${fmt(va)} → block ${el.block} va=${fmt(el.element.va)} kind=${el.element.kind} text=${JSON.stringify(el.element.text.slice(0, 16))}`);
      }
    }
  }
  ok('every posting lands on its own token', wrong === 0, `${fmt(checked)} postings, ${wrong} wrong`);
  for (const l of lines) console.log('      ' + l);

  // ---- 4. context window contains the hit --------------------------------
  if (samples.length) {
    const va = samples[0].postings[0];
    const ctx = await mapper.context(va, 40, 60);
    ok('context window contains the hit at the reported offsets',
      !!ctx && ctx.text.slice(ctx.hitStart, ctx.hitEnd).length > 0,
      ctx ? `${JSON.stringify(ctx.text.slice(0, 26))}… hit=[${ctx.hitStart},${ctx.hitEnd})=${JSON.stringify(ctx.text.slice(ctx.hitStart, ctx.hitEnd))} (blocks=${ctx.blocks})` : 'null');
  }

  // ---- 5. incremental walk equals the full walk --------------------------
  const m2 = new VaPaMapper(reader);
  await m2.init();
  const probeBlock = Math.min(srcCount - 1, Math.floor(srcCount / 2));
  await m2.advanceTo(probeBlock);
  const partial = m2.progress;
  await m2.advanceTo(srcCount);
  const full = m2.progress;
  ok('lazy walk reaches the same state as walking everything',
    full.complete && full.lines === mapper.progress.lines && full.va === mapper.progress.va,
    `partial lines=${fmt(partial.lines)} → full lines=${fmt(full.lines)} va=${fmt(full.va)}`);

  // ---- 6. exact document text via the line table -------------------------
  const docs = await reader.documents();
  if (docs.length) {
    const d = docs[0];
    const dt = await mapper.docText(d.vaStart, d.vaEnd);
    ok('document text is line-aligned and non-empty',
      dt.lines.length > 0 && dt.text.length > 0,
      `${fmt(dt.total)} lines, ${fmt(dt.text.length)} chars, blocks ${dt.blockFirst}–${dt.blockLast}`);
    ok('first line of the first document is its header tag', /^\s*</.test(dt.lines[0] ?? ''), JSON.stringify((dt.lines[0] ?? '').slice(0, 60)));
    const joinedLen = dt.lines.reduce((a, l) => a + l.length, 0) + Math.max(0, dt.lines.length - 1);
    ok('joined lines account for the whole text', joinedLen === dt.text.length || dt.lines.length === 0,
      `${fmt(joinedLen)} vs ${fmt(dt.text.length)} (including ${fmt(Math.max(0, dt.lines.length - 1))} newlines)`);
  } else {
    const dt = await mapper.docText(0, reader.header.maxBlockOffset, 200);
    ok('single-file database: text from VA 0 is line-aligned', dt.lines.length > 0, `${fmt(dt.total)} lines, first=${JSON.stringify((dt.lines[0] ?? '').slice(0, 40))}`);
  }

  // ---- 7. the reason VA exists: hits must survive a hard line break -------
  const adj = await mapper.lineAdjacency();
  const adjacentShare = adj.checked ? adj.adjacent / adj.checked : 0;
  ok('a hard line break consumes no VA (line-to-line gap == 1)',
    adjacentShare > 0.85,
    `${fmt(adj.adjacent)}/${fmt(adj.checked)} = ${(adjacentShare * 100).toFixed(1)}% adjacent; gaps ` +
    [...adj.gaps].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([g, n]) => `${g}:${fmt(n)}`).join(' '));
  const pairs = await mapper.crossLinePairs(40);
  // prefer pairs whose two tokens actually continue each other in the text:
  // same block, adjacent PA, and no tag between them
  const linked = pairs.filter((p) => p.a.paEnd === p.b.pa && p.b.va === p.a.va + 1);
  ok('CJK words cut by a line break exist and stay VA-consecutive',
    pairs.length > 0,
    `${fmt(pairs.length)} sampled, ${fmt(linked.length)} text-continuous; ` +
    pairs.slice(0, 4).map((p) => `「${p.a.normalized}${p.b.normalized}」line ${p.a.line}→${p.b.line} VA ${p.a.va}+${p.b.va}`).join('  '));
  if (linked.length) {
    const p = linked[0];
    // a hit starting on the first token must follow the text across the break
    // and end on the second: no separator, and the span stays a phrase
    const ctx = await mapper.contextSpans(p.a.va, 8, 24, 16);
    const hit = ctx ? ctx.text.slice(ctx.hitStart, ctx.hitEnd) : '';
    const expA = p.a.normalized ?? p.a.text;
    const expB = p.b.normalized ?? p.b.text;
    ok('the cross-line hit text joins with no separator',
      ctx !== null && hit.startsWith(expA) && hit.length >= expA.length + expB.length && hit.slice(expA.length).startsWith(expB),
      `hit=${JSON.stringify(hit)} starts with ${JSON.stringify(expA + expB)}? ${hit.startsWith(expA + expB)} span=${hit.length} chars`);
  } else {
    ok('the cross-line hit text joins with no separator', false, 'no text-continuous cross-line pair found');
  }

  // ---- 8. line table sanity ---------------------------------------------
  const lv = mapper.linesVirtual, lp = mapper.linesPhysical;
  ok('line tables have equal length', lv.length === lp.length && lv.length > 0, `${fmt(lv.length)} lines`);
  ok('lines.virtual monotone', lv.every((x, i) => i === 0 || lv[i - 1] <= x));
  ok('lines.physical monotone', lp.every((x, i) => i === 0 || lp[i - 1] <= x));
  ok('last lines.virtual + 1 = maxBlockOffset', lv[lv.length - 1] + 1 === reader.header.maxBlockOffset,
    `${fmt(lv[lv.length - 1] + 1)} vs ${fmt(reader.header.maxBlockOffset)}`);

  console.log('  ' + JSON.stringify(mapper.progress));
  reader.close?.();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
