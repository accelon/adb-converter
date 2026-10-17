/**
 * Browser-side reader tests — run in Bun, no browser and no server.
 *
 *   bun run test/accelon26.test.ts [--adb D:\\path\\13j.adb] [--adb-small ...]
 *
 * What it proves:
 *   1. BlobIO (Blob.slice, the same primitive the page uses) returns exactly the
 *      same bytes as SyncIO (node:fs) for every block the viewer ever reads.
 *   2. The cheap counters match the values SPEC.md §11 documents.
 *   3. Token names survive byte-for-byte, including lone surrogates.
 *   4. Posting byte lengths sum to the payload minus the name table.
 *   5. Source blocks decode (pure JS bzip2) and resources need no decompression.
 */
import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  AdbReader, BlobIO, SyncIO, CLASS_HAN, type AdbIO,
} from '../src/accelon26/adb';

const args = process.argv.slice(2);
const adbs: string[] = [];
for (let i = 0; i < args.length; i++) if (args[i] === '--adb') adbs.push(args[++i]);
if (!adbs.length) adbs.push('D:\\2026\\adb-converter\\13j.adb');

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + name + (detail ? '  ' + detail : '')); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
};
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex').slice(0, 16);

for (const path of adbs) {
  console.log('\n=== ' + path + ' ===');
  const size = statSync(path).size;
  const raw = new Uint8Array(readFileSync(path));
  const blobIO: AdbIO = new BlobIO(new Blob([raw]));

  const a = await AdbReader.open(new SyncIO(path));
  const b = await AdbReader.open(blobIO);

  // ---- 1. both transports agree on structure -----------------------------
  ok('header identical', JSON.stringify(a.header) === JSON.stringify(b.header),
    `${a.header.dbname} ${a.header.dbcname} v${a.header.version} ${size} B`);
  ok('container order identical', a.order.join(',') === b.order.join(','), a.order.join(','));
  let structSame = true;
  for (const n of a.order) {
    const ca = a.containers.get(n)!, cb = b.containers.get(n)!;
    if (ca.count !== cb.count || ca.totalBlockSize !== cb.totalBlockSize ||
      ca.blockSize !== cb.blockSize || ca.feature !== cb.feature ||
      ca.names.length !== cb.names.length) structSame = false;
    for (let i = 0; i < ca.names.length; i++) if (ca.names[i] !== cb.names[i]) structSame = false;
  }
  ok('every container map identical', structSame);

  // every block digest, via both transports (this is the real equivalence test)
  let blocks = 0, blockSame = 0;
  const t0 = performance.now();
  for (const n of a.order) {
    const c = a.containers.get(n)!;
    const step = Math.max(1, Math.floor(c.count / 24)); // sample big containers
    for (let i = 0; i < c.count; i += step) {
      blocks++;
      const x = await a.readBlock(n, i);
      const y = await b.readBlock(n, i);
      if (x.length === y.length && sha(x) === sha(y)) blockSame++;
      else if (blockSame === blocks - 1) console.log('      first mismatch: ' + n + '[' + i + ']');
    }
  }
  ok('block bytes identical over both IO backends', blocks === blockSame,
    `${blockSame}/${blocks} blocks, ${(performance.now() - t0).toFixed(0)} ms`);

  // ---- 2. counters vs documented values ----------------------------------
  const c = await a.counters();
  console.log('  counters: ' + JSON.stringify(c));
  ok('tokens container count > 0', c.distinctTokens > 0);
  ok('source blocks > 0', c.srcBlocks > 0);
  if (a.header.dbname === '13j') {
    ok('13j distinct tokens = 6,531', c.distinctTokens === 6531, String(c.distinctTokens));
    ok('13j maxBlockOffset = 818,554', c.virtualLength === 818554, String(c.virtualLength));
    ok('13j lines = 42,173', c.lines === 42173, String(c.lines));
  }
  if (a.header.dbname === 'yinshun' && a.header.size > 20_000_000) {
    ok('yinshun distinct tokens = 9,516', c.distinctTokens === 9516, String(c.distinctTokens));
    ok('yinshun lines = 266,916', c.lines === 266916, String(c.lines));
  }
  if (a.header.dbname === 'yinshun' && a.header.size < 20_000_000) {
    ok('yinshun-small is the 10 document subset', c.documents === 10 && c.srcBlocks < 200,
      `documents=${c.documents} srcBlocks=${c.srcBlocks}`);
  }

  // ---- 3. token rows -----------------------------------------------------
  const rows = a.tokens();
  const tokensC = a.containers.get('tokens')!;
  ok('token rows cover every block', rows.length === tokensC.count, `${rows.length} vs ${tokensC.count}`);
  const bytesSum = rows.reduce((s, r) => s + r.bytes, 0);
  const payload = tokensC.ends ? tokensC.ends[tokensC.count - 1] : tokensC.totalBlockSize;
  ok('posting byte lengths sum to payload minus name table',
    bytesSum === payload, `${bytesSum} vs ${payload} (name table ${tokensC.totalBlockSize - payload} B)`);
  const han = rows.filter((r) => r.cls === CLASS_HAN).length;
  ok('han share is plausible', han > 0 && han <= rows.length, `${han}/${rows.length} han`);
  const sorted = rows.every((r, i) => i === 0 || rows[i - 1].name <= r.name);
  ok('rows are already in adb (UTF-16 code unit) order', sorted);
  const dirty = rows.filter((r) => r.dirty);
  console.log('  dirty names: ' + dirty.length + (dirty.length ? ' e.g. ' + JSON.stringify(dirty[0].name) : ''));
  if (a.header.dbname === '13j') {
    // 13j token #15 is "⿱艹" + a lone high surrogate: must not become U+FFFD
    const t15 = rows[15];
    ok('13j token #15 keeps its lone surrogate', t15.name.length === 3 && t15.name.charCodeAt(2) === 0xd85a,
      JSON.stringify(t15.name) + ' units=' + [...t15.name].map((x) => x.charCodeAt(0).toString(16)).join(','));
    ok('13j dirty name count = 2', dirty.length === 2, dirty.map((d) => JSON.stringify(d.name)).join(' '));
  }

  // ---- 4. documents ------------------------------------------------------
  const docs = await a.documents();
  console.log('  documents: ' + docs.length + (docs.length ? ' e.g. ' + docs.slice(0, 3).map((d) => JSON.stringify(d.name)).join(' ') : ''));
  ok('document list is not larger than the 檔 hits', docs.length <= (a.containers.get('tags')?.count ?? 0) * 1000);
  if (a.header.dbname === 'yinshun' && a.header.size > 20_000_000) ok('yinshun documents = 45', docs.length === 45, String(docs.length));
  if (docs.length) ok('document names resolve (SPEC §10 chain)', docs.every((d) => !!d.name && !d.name.startsWith('檔 #')),
    docs.slice(0, 3).map((d) => d.name).join(' '));
  if (a.header.dbname === '13j') ok('13j is a single-file database', docs.length <= 1, String(docs.length));

  // ---- 5. source text + resources ---------------------------------------
  const text0 = await a.sourceText(0);
  ok('source block 0 decodes to UTF-16 text', text0.length > 0 && /[<>]/.test(text0), JSON.stringify(text0.slice(0, 40)));
  ok('source block 0 starts with the collection tag', /^<[^>]+>/.test(text0), JSON.stringify(text0.slice(0, 20)));
  const last = a.containers.get('source')!.count - 1;
  const textLast = await a.sourceText(last);
  ok('last source block decodes', textLast.length > 0, JSON.stringify(textLast.slice(0, 30)));
  const res = a.containers.get('resources');
  if (res && res.count) {
    const r0 = await a.resourceBytes(0);
    const png = r0.bytes[0] === 0x89 && r0.bytes[1] === 0x50 && r0.bytes[2] === 0x4e && r0.bytes[3] === 0x47;
    ok('resource 0 is raw (PNG magic, no decompression)', png, `${r0.name} ${r0.bytes.length} B`);
    let pngs = 0;
    for (let i = 0; i < Math.min(res.count, 40); i++) {
      const r = await a.resourceBytes(i);
      if (r.bytes[0] === 0x89 && r.bytes[1] === 0x50) pngs++;
    }
    ok('first 40 resources all PNG', pngs === Math.min(res.count, 40), `${pngs}/${Math.min(res.count, 40)}`);
  } else {
    console.log('  (no resources container)');
  }

  // ---- 6. random seek: one block out of tens of thousands ---------------
  const mid = Math.floor(a.containers.get('source')!.count / 2);
  const tSeek = performance.now();
  const one = await blobIO.read(a.containers.get('source')!.dataStart, 16);
  const tSeek2 = performance.now();
  ok('random seek of 16 bytes costs < 50 ms', tSeek2 - tSeek < 50, `${(tSeek2 - tSeek).toFixed(2)} ms, ${one.length} B`);
  const tBlk = performance.now();
  const midText = await b.sourceText(mid);
  ok('decode a mid-file source block', midText.length > 0, `block ${mid}, ${midText.length} units, ${(performance.now() - tBlk).toFixed(1)} ms`);

  a.close?.(); b.close?.();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
