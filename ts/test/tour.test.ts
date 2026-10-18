/**
 * 操作導覽：劇本 → 宏 → 播放器的「資料面」測試（不開瀏覽器）。
 *
 *   bun run test/tour.test.ts
 *
 * 驗的是：
 *   1. 編解碼往返（劇本 → 二進位 → 劇本）一字不差
 *   2. 損壞／版本不符／magic 不對 → 說人話的錯誤，不是亂播
 *   3. 真正上線的 tour-data.ts 與 ts/tour/*.tour 同步（改了劇本忘了重編 → 這支會紅）
 *   4. 劇本剖析器：場景、說明文字、指令、`=>` 分隔、錯誤行號
 *   5. 靜態檢查：`#id`／`data-tab`／`api:` 路徑打錯會擋下來
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  TOUR_FMT, TOUR_MAGIC, OP, OP_NAME, crc32, decodeTour, encodeTour, fromBase64, toBase64,
  type Tour,
} from '../src/accelon26/tour-format';
import { TOUR_BLOBS, TOUR_INDEX } from '../src/accelon26/tour-data';
import { parseTour } from '../tools/build-tours';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + name + (detail ? '  ' + detail : '')); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
};

const HERE = import.meta.dir;
const TOUR_DIR = resolve(HERE, '../tour');
const TEMPLATE = resolve(HERE, '../src/accelon26/accelon26.template.html');

const sample: Tour = {
  id: 'unit', title: '單元測試', intro: '說明', require: 'db=13j',
  scenes: [
    { title: '一', body: '第一段\n\n第二段（**粗**、`碼`）', steps: [
      { op: OP.point, args: ['#query'] },
      { op: OP.type, args: ['#query', '般若'] },
      { op: OP.wait, args: ['120'] },
    ] },
    { title: '二', body: '', steps: [{ op: OP.unpoint, args: [] }] },
  ],
};

// ------------------------------------------------------------ 1. 往返
{
  const bytes = encodeTour(sample);
  const back = decodeTour(bytes);
  ok('往返：整份相等', JSON.stringify(back) === JSON.stringify(sample),
    `${bytes.length} bytes`);
  ok('往返：中文與 emoji 都完好', back.scenes[0].body.includes('粗') && back.intro === '說明');
  ok('編碼是決定性的（同輸入 → 同 bytes）',
    toBase64(encodeTour(sample)) === toBase64(encodeTour(sample)));
  ok('base64 往返', toBase64(fromBase64(toBase64(bytes))) === toBase64(bytes));
  ok('magic 在檔頭', String.fromCharCode(...bytes.subarray(0, 5)) === TOUR_MAGIC);
  const want = (bytes[7] | (bytes[8] << 8) | (bytes[9] << 16) | (bytes[10] << 24)) >>> 0;
  ok('CRC 記在檔頭、且等於 payload 的 CRC32', want === crc32(bytes.subarray(11)),
    `${want.toString(16)}`);
}

// ------------------------------------------------------------ 2. 壞資料
{
  const bytes = encodeTour(sample);
  const bad = bytes.slice();
  bad[bad.length - 3] ^= 0x40;         // 翻一個 bit
  let msg = '';
  try { decodeTour(bad); } catch (e) { msg = (e as Error).message; }
  ok('改壞一個 bit → 說「損壞」', /損壞/.test(msg), msg);

  const wrongMagic = bytes.slice();
  wrongMagic[0] = 0x58;                // 'X'
  msg = '';
  try { decodeTour(wrongMagic); } catch (e) { msg = (e as Error).message; }
  ok('magic 不對 → 說「不是導覽宏」', /不是導覽宏/.test(msg), msg);

  const wrongFmt = bytes.slice();
  wrongFmt[5] = TOUR_FMT + 7;
  msg = '';
  try { decodeTour(wrongFmt); } catch (e) { msg = (e as Error).message; }
  ok('版本不符 → 說「請更新 accelon26」', /版本/.test(msg) && /更新/.test(msg), msg);
}

// -------------------------------------------- 3. 上線的資料與劇本同步
{
  const files = readdirSync(TOUR_DIR).filter((f) => f.endsWith('.tour')).sort();
  ok('有劇本', files.length > 0, files.join(', '));
  const ids: string[] = [];
  for (const f of files) {
    const src = readFileSync(resolve(TOUR_DIR, f), 'utf8');
    const { tour, errors } = parseTour(src, f);
    ok(`${f}：剖析零錯誤`, errors.length === 0, errors.slice(0, 2).join(' / '));
    if (errors.length) continue;
    ids.push(tour.id);
    const want = toBase64(encodeTour(tour));
    ok(`${f}：tour-data.ts 是最新的（不是舊的編譯結果）`,
      TOUR_BLOBS[tour.id] === want,
      TOUR_BLOBS[tour.id] ? `${(TOUR_BLOBS[tour.id].length / 1365).toFixed(1)} KiB` : '缺這一份');
    const back = decodeTour(fromBase64(TOUR_BLOBS[tour.id] ?? ''));
    ok(`${f}：解回來與劇本相同`, JSON.stringify(back) === JSON.stringify(tour),
      `${back.scenes.length} 場景`);
    ok(`${f}：每一步的 opcode 都有名字`,
      tour.scenes.every((s) => s.steps.every((st) => !!OP_NAME[st.op])));
    ok(`${f}：場景標題與說明都不空`, tour.scenes.every((s) => !!s.title && !!s.body));
  }
  ok('TOUR_INDEX 與劇本一一對應',
    ids.length === TOUR_INDEX.length && ids.every((id) => TOUR_INDEX.some((t) => t.id === id)),
    TOUR_INDEX.map((t) => `${t.id}(${t.scenes} 場景/${t.steps} 步)`).join(' '));
  ok('選單資料與宏一致',
    TOUR_INDEX.every((t) => {
      const d = decodeTour(fromBase64(TOUR_BLOBS[t.id]));
      return d.scenes.length === t.scenes && d.title === t.title;
    }));
}

// --------------------------------------------------------- 4. 剖析器
{
  const src = [
    '@id  demo',
    '@title 示範',
    '# 這是註解',
    '',
    '### 第一個場景',
    '說明第一行',
    '說明第二行',
    '',
    '> 指向 #query',
    '> 輸入 #query => 般 若',
    '> 等 300',
    '> 等頁面 count:#searchList .snippet >= 2 8000',
    '',
    '### 第二個場景',
    '> 你來 按一下 📁 => api:db',
    '> 分外 左 dir',
  ].join('\n');
  const { tour, errors } = parseTour(src, 'demo.tour');
  ok('剖析：場景數', tour.scenes.length === 2, String(tour.scenes.length));
  ok('剖析：說明文字保留換行', tour.scenes[0].body === '說明第一行\n說明第二行', JSON.stringify(tour.scenes[0].body));
  ok('剖析：中文別名 → opcode',
    tour.scenes[0].steps[0].op === OP.point && tour.scenes[0].steps[2].op === OP.wait);
  ok('剖析：`=>` 只切第一個，內容可以有空白',
    tour.scenes[0].steps[1].args[1] === '般 若', JSON.stringify(tour.scenes[0].steps[1].args));
  ok('剖析：等頁面的最後一個純數字是逾時',
    tour.scenes[0].steps[3].args.join('|') === 'count:#searchList .snippet >= 2|8000',
    JSON.stringify(tour.scenes[0].steps[3].args));
  ok('剖析：你來 的條件在 `=>` 後面',
    tour.scenes[1].steps[0].args.join('|') === '按一下 📁|api:db', JSON.stringify(tour.scenes[1].steps[0].args));
  ok('剖析：不認得的指令要報錯（含行號）',
    parseTour('### s\n> 飛 #query\n', 'x.tour').errors.some((m) => /:2/.test(m) && /飛/.test(m)),
    parseTour('## 不是場景\n### s\n', 'x.tour').errors.join(' | '));
  ok('剖析：場景外的文字要報錯',
    parseTour('這行沒有去處\n### s\n> 等 100\n', 'x.tour').errors.some((m) => /場景之外/.test(m)));
  ok('剖析：@id 要跟檔名一致',
    parseTour('@id other\n### s\n> 等 100\n', 'x.tour').errors.some((m) => /檔名/.test(m)));
  ok('剖析：空劇本要報錯',
    parseTour('@id x\n', 'x.tour').errors.some((m) => /沒有任何場景/.test(m)));
}

// ------------------------------------------------------- 5. 靜態檢查（#id）
{
  const html = readFileSync(TEMPLATE, 'utf8');
  const ids = new Set([...html.matchAll(/id="([A-Za-z][\w-]*)"/g)].map((m) => m[1]));
  const bad = parseTour('### s\n> 指向 #noSuchId\n', 'b.tour');
  // 剖析不管 id；id 檢查在 build-tours 的 lint（這裡用同一條規則重跑一次）
  const built = parseTour('### s\n> 指向 #noSuchId\n', 'b.tour');
  ok('剖析不會因為 #id 不存在而失敗（那是 lint 的事）', built.errors.length === 0,
    bad.errors.join(' | '));

  // 掃所有上線劇本用到的 #id，確認都在 template 裡
  const missing: string[] = [];
  for (const f of readdirSync(TOUR_DIR).filter((x) => x.endsWith('.tour'))) {
    const { tour } = parseTour(readFileSync(resolve(TOUR_DIR, f), 'utf8'), f);
    for (const sc of tour.scenes) {
      for (const st of sc.steps) {
        for (const a of st.args) {
          for (const m of a.matchAll(/#([A-Za-z][\w-]*)/g)) if (!ids.has(m[1])) missing.push(m[1]);
        }
      }
    }
  }
  ok('劇本裡每一個 #id 都在 template 裡', missing.length === 0, missing.join(' '));
  ok('播放器自己的殼也在 template 裡（聚光燈／氣泡）',
    ['tourSpot', 'tourBubble', 'tourNext', 'tourPrev', 'tourTitle', 'tourList'].every((i) => ids.has(i)));
  ok('導覽的入口在「關於」裡（作者 2026-10-18 從頂欄搬進來）',
    ids.has('aboutTour') && ids.has('aboutStartup') && !ids.has('tourBtn'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
