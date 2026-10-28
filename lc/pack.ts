import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { authorAdb } from '../ts/src/adbauthor';
import { MAXLINELEN } from '../ts/src/index-builder';

/** 交付規則（2026-10-28 作者指示）：最終 adb 一定要放到 accelon3，兩邊 SHA-256 相同。 */
const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

const ROOT = 'D:/2026/adb-converter';
const outPath = process.argv[2] ?? `${ROOT}/build/lc.adb`;
const forceBase = process.argv.includes('--base');
const textPath = forceBase || !existsSync(`${ROOT}/build/lc-linked.txt`)
  ? `${ROOT}/build/lc-text.txt`
  : `${ROOT}/build/lc-linked.txt`;
const text = readFileSync(textPath, 'utf8');
const lines = text.split('\n');
if (lines[lines.length - 1] === '') lines.pop();

const over = lines.map((l, i) => [i + 1, l.length]).filter(([, n]) => (n as number) * 2 > MAXLINELEN);
if (over.length) {
  throw new Error(
    `${over.length} 行的長度超過 ${MAXLINELEN / 2} 字（Accelon3 行長上限），例如第 ${over
      .slice(0, 5)
      .map(([i, n]) => `${i} 行 ${n} 字`)
      .join('、')}`,
  );
}

const logo = readFileSync(`${ROOT}/logo/lc_logo.png`);
const out = await authorAdb({
  dbname: 'lc',
  dbcname: '呂澂佛學著作集',
  dbtype: 0,
  lines,
  resources: [{ name: 'lc_logo.png', bytes: logo }],
  log: (m) => console.error(m),
});
const buf = Buffer.from(out.file);
buf.writeUInt32LE(0, 100); // andtagid：與 ys 一致
writeFileSync(outPath, buf);
if (outPath === `${ROOT}/build/lc.adb`) {
  const deployed = 'D:/accelon3/lc.adb';
  writeFileSync(deployed + '.new', buf);
  renameSync(deployed + '.new', deployed);
  const a = sha256(readFileSync(outPath));
  const b = sha256(readFileSync(deployed));
  if (a !== b) throw new Error(`交付失敗：${outPath} 與 ${deployed} 的 SHA-256 不同`);
  console.log(`deployed ${deployed} (${(buf.length / 1048576).toFixed(2)} MiB, sha256 ${a})`);
}
console.log(`wrote ${outPath}: ${(buf.length / 1048576).toFixed(2)} MiB, lines ${lines.length}, resources ${out.resources}`);
