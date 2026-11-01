/**
 * 一次性診斷：看某個 adb 的「頁 id」長什麼樣（ys／fuyan 要能像大正一樣跳行，得先知道
 * 它們的 `<頁 id="…">` 寫法）。純 CLI，不開 GUI。
 *
 *   bun run tools/pages-probe.ts --adb D:\accelon3\ys.adb
 */
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { AdbReader, SyncIO } from '../src/accelon26/adb';
import { VaPaMapper } from '../src/accelon26/vapa';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const ADB = resolve(opt('adb', resolve(import.meta.dir, '../../accelon3/ys.adb')));
const SHOW = Number(opt('show', '30'));
if (!existsSync(ADB)) { console.error('missing ' + ADB); process.exit(2); }

const reader = await AdbReader.open(new SyncIO(ADB));
const mapper = new VaPaMapper(reader);
await mapper.init();
const h = reader.header;
console.log(`${h.dbname}（${h.dbcname}） lines=${h.lineCount.toLocaleString('en-US')} blocks=${reader.containers.get('source')?.count}`);
for (const name of ['頁', '欄', '卷', '書', '册', '冊', '集', '編', '章', '節', '文']) {
  const at = reader.containers.get('tags')?.names.indexOf(name) ?? -1;
  if (at < 0) continue;
  const vas = await reader.decodeBlockList('tags', at);
  console.log(`  <${name}> ${vas.length.toLocaleString('en-US')} 個`);
}
const av = await reader.attributeValues('頁.id').catch(() => null);
const ids = av?.values ?? [];
console.log(`頁.id 屬性 ${ids.length.toLocaleString('en-US')} 筆`);
console.log('前 ' + SHOW + '：' + JSON.stringify(ids.slice(0, SHOW)));
const tail = ids.slice(-5);
console.log('最後 5：' + JSON.stringify(tail));
// 觀察：有幾種形狀
const shapes = new Map<string, number>();
for (const id of ids) {
  const shape = id.replace(/\d+/g, '#').replace(/[a-z]/g, 'c').replace(/[A-Z]/g, 'C');
  shapes.set(shape, (shapes.get(shape) ?? 0) + 1);
}
console.log('形狀統計：' + JSON.stringify([...shapes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)));
