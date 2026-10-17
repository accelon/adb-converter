/**
 * How fast is bzip2, really? Same bytes, two decoders.
 *
 *   bun run tools/bzip2-bench.ts [--adb ../13j.adb] [--blocks 32]
 *
 * It extracts real source blocks (each adb source block is ONE bzip2 stream) to
 * build/bzip2-blocks/*.bin, times the TypeScript vendored decoder on those bytes, and
 * leaves the files for wails/bzip2_bench_test.go (the Go side of the comparison) to decode with Go's compress/bzip2 —
 * same input, no I/O in the timed loop.
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { AdbReader, SyncIO, blockRange } from '../src/accelon26/adb';
import { bzip2 } from '../src/vendor/bzip2.js';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const ADB = resolve(opt('adb', resolve(import.meta.dir, '../../13j.adb')));
const WANT = Number(opt('blocks', '32'));
const OUT = resolve(import.meta.dir, '../../build/bzip2-blocks');

const reader = await AdbReader.open(new SyncIO(ADB));
const src = reader.containers.get('source');
if (!src) throw new Error('no source container');
const count = src.count;
const step = Math.max(1, Math.floor(count / WANT));
const idxs: number[] = [];
for (let i = 0; i < count && idxs.length < WANT; i += step) idxs.push(i);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const decode = (bytes: Uint8Array): Uint8Array => {
  const out = new Uint8Array(bytes.length * 4 + 65536);
  let pos = 0;
  bzip2.simple(bytes, (b: number) => { if (pos < out.length) out[pos++] = b; });
  return out.subarray(0, pos);
};

const inputs: { i: number; bytes: Uint8Array }[] = [];
for (const i of idxs) {
  const r = blockRange(src, i);
  const bytes = await reader.readBlock('source', i);
  writeFileSync(resolve(OUT, `block-${String(i).padStart(4, '0')}.bin`), bytes);
  inputs.push({ i, bytes });
}

// warm-up + timing, decode only (no I/O inside the loop)
let decodedBytes = 0;
for (const x of inputs) decodedBytes += decode(x.bytes).length;
const REPS = Number(opt('reps', '5'));
const t0 = performance.now();
for (let rep = 0; rep < REPS; rep++) for (const x of inputs) decode(x.bytes);
const ms = performance.now() - t0;
const compressedBytes = inputs.reduce((a, x) => a + x.bytes.length, 0);

const per = inputs.map((x) => {
  const t = performance.now();
  for (let k = 0; k < 10; k++) decode(x.bytes);
  return { i: x.i, in: x.bytes.length, out: decode(x.bytes).length, ms: (performance.now() - t) / 10 };
});
per.sort((a, b) => a.ms - b.ms);
const med = per[Math.floor(per.length / 2)];

console.log(`${ADB}：${inputs.length} 個 source block（共 ${count} 個）`);
console.log(`  壓縮 ${(compressedBytes / 1048576).toFixed(2)} MiB → 解壓 ${(decodedBytes / 1048576).toFixed(2)} MiB`);
console.log(`  TypeScript vendored bzip2：${(ms / REPS).toFixed(1)} ms / 輪，${(decodedBytes / 1048576 / (ms / REPS / 1000)).toFixed(0)} MiB/s（解壓後）`);
console.log(`  每個 block 中位數 ${med.ms.toFixed(2)} ms（${med.in}→${med.out} bytes，${(med.out / 1048576 / (med.ms / 1000)).toFixed(0)} MiB/s）`);
console.log(`  寫出 ${inputs.length} 個 .bin 到 ${OUT} 給 Go 對照`);
