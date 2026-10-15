/**
 * Contract test for serve-adb.ts: proves the HTTP behaviour the viewer relies on.
 *
 *   bun run tools/serve-contract.ts [--port 8899] [--id 13j] [--adb <path>]
 *
 * Checks (all against a real server on 127.0.0.1):
 *   Range: 200 without Range, 206 with Content-Range, exact bytes, suffix range,
 *          open-ended range, 416 past EOF, malformed -> 200, If-Range stale -> 200,
 *          ETag revalidation -> 304, HEAD has headers and no body.
 *   CORS: OPTIONS preflight lists Range; GET carries Allow-Origin + Expose-Headers.
 *   API : /counts, /items, /tokens (names + hit counts), /layout (u32 VA map),
 *         /block/source/<i> (decompressed, 16 KiB class).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const PORT = Number(opt('port', '8899'));
const ADB = opt('adb', process.env.ABX_ADB ?? 'D:\\2026\\adb-converter\\13j.adb');
const ROOT = opt('root', join(tmpdir(), 'abx-contract'));
const ID = opt('id', 'testdb');

mkdirSync(ROOT, { recursive: true });
// the server resolves /api/adb/<id> to <root>/<id>.adb — hard link is not portable,
// so copy via a tiny symlink-free approach: write a marker file it can serve, and
// point the db route at an absolute path root.
const absRoot = ADB.replace(/[\\/][^\\/]+$/, '');
const absId = ADB.replace(/^.*[\\/]/, '').replace(/\.adb$/i, '');

const server = Bun.spawn(['bun', 'run', join(import.meta.dir, 'serve-adb.ts'),
  '--port', String(PORT), '--root', absRoot, '--host', '127.0.0.1'], {
  stdout: 'pipe', stderr: 'pipe', cwd: import.meta.dir,
});
const base = `http://127.0.0.1:${PORT}`;

let passed = 0, failed = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { passed++; console.log('  ok   ' + name + (detail ? '  ' + detail : '')); }
  else { failed++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
};

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(base + '/api/nope', { signal: AbortSignal.timeout(500) });
      if (r.status) return true;
    } catch { /* not up yet */ }
    await Bun.sleep(100);
  }
  return false;
}

const byte = async (r: Response) => new Uint8Array(await r.arrayBuffer());

try {
  if (!(await waitUp())) throw new Error('server did not start');
  console.log(`server up on ${base}, db=${absId} root=${absRoot}\n`);

  // ---------------------------------------------------------------- Range ---
  const full = await fetch(`${base}/api/db/${absId}.adb`);
  const fullBody = await byte(full);
  ok('no Range -> 200', full.status === 200, `status=${full.status} len=${fullBody.length}`);
  ok('no Range -> Accept-Ranges: bytes', full.headers.get('accept-ranges') === 'bytes');
  ok('no Range -> Content-Length matches body', Number(full.headers.get('content-length')) === fullBody.length);

  const r1 = await fetch(`${base}/api/db/${absId}.adb`, { headers: { Range: 'bytes=0-255' } });
  const b1 = await byte(r1);
  ok('Range 0-255 -> 206', r1.status === 206, `status=${r1.status}`);
  ok('Range 0-255 -> Content-Range', r1.headers.get('content-range') === `bytes 0-255/${fullBody.length}`, r1.headers.get('content-range') ?? '');
  ok('Range 0-255 -> 256 bytes', b1.length === 256, `len=${b1.length}`);
  ok('Range bytes equal file slice', b1.every((v, i) => v === fullBody[i]), 'first 256 bytes identical');
  ok('signature readable from range', new TextDecoder('latin1').decode(b1.subarray(32, 80)).startsWith('\r\nAccelon Search Engine'));

  const r2 = await fetch(`${base}/api/db/${absId}.adb`, { headers: { Range: 'bytes=100-99' } });
  ok('invalid last<first -> 200 (header ignored)', r2.status === 200, `status=${r2.status}`);
  await r2.arrayBuffer();

  const r3 = await fetch(`${base}/api/db/${absId}.adb`, { headers: { Range: `bytes=${fullBody.length + 10}-` } });
  ok('start past EOF -> 416', r3.status === 416, `status=${r3.status} cr=${r3.headers.get('content-range')}`);
  await r3.arrayBuffer();

  const r4 = await fetch(`${base}/api/db/${absId}.adb`, { headers: { Range: 'bytes=-16' } });
  const b4 = await byte(r4);
  ok('suffix range -16 -> 206, 16 bytes', r4.status === 206 && b4.length === 16, `status=${r4.status} len=${b4.length}`);
  ok('suffix range returns file tail', b4.every((v, i) => v === fullBody[fullBody.length - 16 + i]));

  const r5 = await fetch(`${base}/api/db/${absId}.adb`, { headers: { Range: 'bytes=256-' } });
  const b5 = await byte(r5);
  ok('open ended 256- -> 206, rest of file', r5.status === 206 && b5.length === fullBody.length - 256, `len=${b5.length}`);

  const r6 = await fetch(`${base}/api/db/${absId}.adb`, { headers: { Range: 'bytes=0-15,32-47' } });
  const b6 = await byte(r6);
  ok('two ranges -> multipart/byteranges', r6.status === 206 && (r6.headers.get('content-type') ?? '').startsWith('multipart/byteranges'), r6.headers.get('content-type') ?? '');
  ok('multipart body carries both parts', b6.length > 32 && new TextDecoder('latin1').decode(b6).includes('Content-Range: bytes 32-47'));

  const etag = full.headers.get('etag')!;
  ok('ETag header present', !!etag, etag);
  const r304 = await fetch(`${base}/api/db/${absId}.adb`, { headers: { 'If-None-Match': etag } });
  ok('If-None-Match same ETag -> 304', r304.status === 304, `status=${r304.status}`);
  await r304.arrayBuffer();
  const rStale = await fetch(`${base}/api/db/${absId}.adb`, { headers: { Range: 'bytes=0-3', 'If-Range': '"stale"' } });
  const bStale = await byte(rStale);
  ok('If-Range stale -> full 200 body', rStale.status === 200 && bStale.length === fullBody.length, `status=${rStale.status} len=${bStale.length}`);
  const rFresh = await fetch(`${base}/api/db/${absId}.adb`, { headers: { Range: 'bytes=0-3', 'If-Range': etag } });
  ok('If-Range current -> 206', rFresh.status === 206, `status=${rFresh.status}`);
  await rFresh.arrayBuffer();

  const head = await fetch(`${base}/api/db/${absId}.adb`, { method: 'HEAD' });
  const headBody = await byte(head);
  ok('HEAD -> 200, no body', head.status === 200 && headBody.length === 0, `status=${head.status} len=${headBody.length}`);
  ok('HEAD -> Content-Length set', Number(head.headers.get('content-length')) === fullBody.length);

  // ------------------------------------------------------------------ CORS ---
  const pre = await fetch(`${base}/api/db/${absId}.adb`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:5173' } });
  const allow = pre.headers.get('access-control-allow-headers') ?? '';
  ok('preflight lists Range', pre.status === 204 && /\bRange\b/i.test(allow), `status=${pre.status} allow-headers="${allow}"`);
  ok('preflight allows GET', /\bGET\b/.test(pre.headers.get('access-control-allow-methods') ?? ''));
  const exp = full.headers.get('access-control-expose-headers') ?? '';
  ok('GET exposes Content-Range/Accept-Ranges', /\bContent-Range\b/i.test(exp) && /\bAccept-Ranges\b/i.test(exp), exp);
  ok('GET has Allow-Origin', !!full.headers.get('access-control-allow-origin'));

  // ------------------------------------------------------------------- API ---
  const c = await fetch(`${base}/api/adb/${absId}/counts`);
  const counts = await c.json() as Record<string, number | string>;
  ok('/counts -> 200 json', c.status === 200 && counts.distinctTokens > 0, JSON.stringify(counts).slice(0, 200));

  const items = await (await fetch(`${base}/api/adb/${absId}/items`)).json() as any;
  const tokInfo = items.containers.tokens;
  ok('/items token count == /counts', tokInfo.count === counts.distinctTokens, `${tokInfo.count} vs ${counts.distinctTokens}`);
  ok('/items lists containers', items.containerOrder.includes('source') && items.containerOrder.includes('tokens'), items.containerOrder.join(','));

  const t0 = performance.now();
  // the name table is the last data block, so its byte length pins down what
  // /tokens should sum to (posting blocks only)
  const probe = await (await fetch(`${base}/api/adb/${absId}/debug/lengths/tokens`)).json() as any;
  const nameTableBytes = probe.lengths[probe.count] - probe.lengths[probe.count - 1];

  const tok = await fetch(`${base}/api/adb/${absId}/tokens`);
  const tokBytes = new Uint8Array(await tok.arrayBuffer());
  const tokMs = performance.now() - t0;
  ok('/tokens -> 200', tok.status === 200, `status=${tok.status} encoding=${tok.headers.get('content-encoding')} len=${tokBytes.length} ${tokMs.toFixed(0)} ms`);
  ok('/tokens posting bytes == payload minus name table',
    Number(tok.headers.get('x-adb-postingbytes')) === items.containers.tokens.totalBlockSize - nameTableBytes,
    `${tok.headers.get('x-adb-postingbytes')} vs ${items.containers.tokens.totalBlockSize} - ${nameTableBytes}`);

  // decode the token index exactly like the viewer will
  const dec = new TextDecoder('utf-16le');
  const dv2 = new DataView(tokBytes.buffer, tokBytes.byteOffset, tokBytes.byteLength);
  const nTok = dv2.getUint32(0, true);
  let p = 4, sizeSum = 0, cls = [0, 0, 0, 0], hanBytes = 0;
  const firstNames: string[] = [];
  let biggest = { name: '', bytes: 0 };
  for (let i = 0; i < nTok; i++) {
    const units = dv2.getUint16(p, true); p += 2;
    const name = dec.decode(tokBytes.subarray(p, p + units * 2)); p += units * 2;
    let size = 0, shift = 0, c: number;
    do { c = tokBytes[p++]; size += (c & 0x7f) * Math.pow(2, shift); shift += 7; } while (c & 0x80);
    const cl = tokBytes[p++];
    sizeSum += size; cls[cl]++;
    if (cl === 0) hanBytes += size;
    if (size > biggest.bytes) biggest = { name, bytes: size };
    if (firstNames.length < 5) firstNames.push(JSON.stringify(name) + ':' + size + 'B:c' + cl);
  }
  ok('/tokens fully parseable, count matches', nTok === counts.distinctTokens && p === tokBytes.length, `${nTok} tokens, ${p} of ${tokBytes.length} bytes consumed`);
  ok('/tokens posting byte sum == payload minus name table', sizeSum === items.containers.tokens.totalBlockSize - nameTableBytes, `${sizeSum} vs ${items.containers.tokens.totalBlockSize - nameTableBytes}`);
  ok('/tokens class counts match headers', cls.join(',') === [tok.headers.get('x-adb-han'), tok.headers.get('x-adb-latin'), tok.headers.get('x-adb-digit'), tok.headers.get('x-adb-other')].join(',') && cls.reduce((a, b) => a + b, 0) === nTok, `${cls.join(',')} first=${firstNames.join(' ')}`);
  ok('/tokens biggest posting is plausible', biggest.bytes > 0 && biggest.bytes <= items.containers.tokens.totalBlockSize, `${JSON.stringify(biggest.name)} = ${(biggest.bytes / 1024).toFixed(1)} KiB`);

  const cl = await (await fetch(`${base}/api/adb/${absId}/classes`)).json() as any;
  ok('/classes matches /tokens classes', cl.han === cls[0] && cl.latin === cls[1] && cl.digit === cls[2] && cl.other === cls[3] && cl.hanBytes === hanBytes,
    `han=${cl.han}/${cls[0]} hanBytes=${cl.hanBytes}/${hanBytes} latin=${cl.latin} digit=${cl.digit} other=${cl.other}`);
  ok('/classes han share is plausible', cl.han > 0 && cl.han <= cl.count, JSON.stringify(cl));
  ok('/classes postingBytes matches /tokens sum', cl.postingBytes === sizeSum, `${cl.postingBytes} vs ${sizeSum}`);

  const lay = await fetch(`${base}/api/adb/${absId}/layout`);
  const layBytes = new Uint8Array(await lay.arrayBuffer());
  const lv = new DataView(layBytes.buffer, layBytes.byteOffset, layBytes.byteLength);
  const nBlocks = lv.getUint32(0, true);
  ok('/layout -> block count == source blocks', nBlocks === items.containers.source.count, `${nBlocks} vs ${items.containers.source.count}`);
  ok('/layout VA monotonic', (() => { let p = -1; for (let i = 0; i < Math.min(nBlocks, 200); i++) { const v = lv.getUint32(8 + i * 4, true); if (v < p) return false; p = v; } return true; })());

  const blk = await fetch(`${base}/api/adb/${absId}/block/source/0`);
  const blkBytes = new Uint8Array(await blk.arrayBuffer());
  const stride = Number(items.header.srcBlockSize);
  const head16 = new TextDecoder('utf-16le').decode(blkBytes.subarray(0, 64));
  ok('/block/source/0 decompressed', blk.status === 200 && blkBytes.length > 0 && blkBytes.length <= stride + 4, `len=${blkBytes.length} stride=${stride}`);
  ok('source block 0 does not start with bzip2 magic', !(blkBytes[0] === 0x42 && blkBytes[1] === 0x5a && blkBytes[2] === 0x68), new TextDecoder('latin1').decode(blkBytes.subarray(0, 3)));
  ok('source block 0 is UTF-16 text', /[<>]/.test(head16), JSON.stringify(head16.slice(0, 40)));

  const raw = await fetch(`${base}/api/db/${absId}.adb`, {
    headers: {
      Range: `bytes=${items.containers.source.dataStart + (items.containers.source.blockSize || 0)}-${items.containers.source.dataStart + 16}`,
    },
  });
  const rawBytes = await byte(raw);
  ok('raw block bytes are still compressed (Range works on the file)', rawBytes[0] === 0x42 && rawBytes[1] === 0x5a, `first=${rawBytes[0].toString(16)} ${rawBytes[1].toString(16)}`);

  const blocked = await fetch(`${base}/api/adb/${absId}/block/source/999999999`);
  ok('out of range block -> 500 with message', blocked.status === 500, `status=${blocked.status}`);

  const traversal = await fetch(`${base}/api/db/../../../../etc/passwd`);
  ok('path traversal refused', traversal.status === 404, `status=${traversal.status}`);
  await traversal.arrayBuffer();
} catch (e) {
  failed++;
  console.log('  FAIL exception: ' + (e as Error).message + '\n' + (e as Error).stack);
} finally {
  server.kill();
  console.log(`\n${passed} passed, ${failed} failed`);
  writeFileSync(join(ROOT, 'contract-result.txt'), `${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}
