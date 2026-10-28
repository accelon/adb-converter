import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { authorAdb } from '../ts/src/adbauthor';
import { MAXLINELEN } from '../ts/src/index-builder';

const text = readFileSync('D:/2026/adb-converter/build/ys-linked.txt', 'utf8');
const lines = text.split('\n');
if (lines[lines.length - 1] === '') lines.pop();

// Accelon3 的行長上限（8192 bytes = 4096 chars）：lines.physical 會把每行截到這裡，
// 超過的行會讓行表與內文錯開（搜尋結果定位錯誤）。寧可擋下來，也不要默默產生壞檔。
const over = lines.map((l, i) => [i + 1, l.length]).filter(([, n]) => (n as number) * 2 > MAXLINELEN);
if (over.length) {
  throw new Error(
    `${over.length} 行的長度超過 ${MAXLINELEN / 2} 字（Accelon3 行長上限），例如第 ${over
      .slice(0, 5)
      .map(([i, n]) => `${i} 行 ${n} 字`)
      .join('、')}`,
  );
}

const logo = readFileSync('D:/2026/adb-converter/logo/ys_logo.png');
const found = readFileSync('D:/2026/adb-converter/logo/yinshunfoundation.png');
const out = await authorAdb({
  dbname: 'ys',
  dbcname: '印順法師佛學著作集',
  dbtype: 0,
  lines,
  resources: [
    { name: 'ys_logo.png', bytes: logo },
    { name: 'yinshunfoundation.png', bytes: found },
  ],
  log: (m) => console.error(m),
});
const buf = Buffer.from(out.file); buf.writeUInt32LE(0, 100);
writeFileSync('D:/2026/adb-converter/build/ys-linked.adb', buf);
// 直接覆寫 D:\accelon3\ys.adb 偶爾會拿到 EUNKNOWN（檔案被 Accelon26 開著、
// 或 Defender 正在掃 26 MB 的新檔）。先寫 .new 再改名，是同一顆磁碟上的原子替換。
const deployed = 'D:/accelon3/ys.adb';
writeFileSync(deployed + '.new', buf);
renameSync(deployed + '.new', deployed);
console.log('wrote ys.adb', (buf.length / 1048576).toFixed(1), 'MiB, lines', lines.length);
