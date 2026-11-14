import { AdbReader } from '../src/accelon26/adb';
const open = async (p: string) => AdbReader.open({
  size: (await Bun.file(p).stat()).size,
  read: async (off: number, len: number) => new Uint8Array(await Bun.file(p).slice(off, off + len).arrayBuffer()),
} as any);
const a = await open('D:/accelon3/fuyan.adb');
const b = await open('D:/2026/fuyan/out/fuyan.adb');
const va1 = await a.linesVirtual(), va2 = await b.linesVirtual();
console.log('lines', va1.length, '→', va2.length, 'maxVA', va1[va1.length-1], '→', va2[va2.length-1]);
let maxd = 0, mind = 0, sum = 0, n = 0;
for (let k = 0; k < Math.min(va1.length, va2.length); k++) {
  const d = va2[k] - va1[k];
  if (d > maxd) maxd = d;
  if (d < mind) mind = d;
  sum += d; n++;
}
console.log('同位置偏差 max', maxd, 'min', mind, '平均', (sum/n).toFixed(3));
for (const k of [0, 23719, 23720, 30000, 50000, 70000, 81545]) if (k < va2.length) console.log(' L'+k, va1[k], '→', va2[k], '差', va2[k]-va1[k]);
