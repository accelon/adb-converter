#!/usr/bin/env bun
/**
 * dom-probe.ts — 開一頁、跑一段 JS、截圖（通用）
 *
 *   bun run tools/dom-probe.ts --db fuyan --page 38p41 --png build/x.png \
 *     --eval "document.querySelector('#docText').innerText.slice(0,200)"
 *
 * 參數：
 *   --html  閱讀器 html，預設 D:/accelon3/accelon26.html
 *   --adb   adb 檔，預設 D:/accelon3/fuyan.adb
 *   --db    db 名，預設 fuyan
 *   --page  頁 id（可空）
 *   --line  跳到某行號（可空）
 *   --eval  在頁面裡執行的 JS 運算式（可用 await；回傳值印出）
 *   --png   截圖路徑（可空＝不截）
 *   --w/--h 視窗尺寸，預設 1400x1000
 */
import { resolve } from 'node:path';
import { launch, loadAdb } from './_cdp';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => {
  const i = args.indexOf('--' + n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const HTML = resolve(opt('html', 'D:/accelon3/accelon26.html'));
const ADB = resolve(opt('adb', 'D:/accelon3/fuyan.adb'));
const DB = opt('db', 'fuyan');
const PAGE = opt('page', '');
const LINE = opt('line', '');
const EXPR = opt('eval', '');
const EXPR_FILE = opt('eval-file', '');
const PNG = opt('png', '');
const W = Number(opt('w', '1400'));
const H = Number(opt('h', '1000'));

const { cdp, close } = await launch({ html: HTML, tag: 'domprobe', windowSize: `--window-size=${W},${H}` });
try {
  await loadAdb(cdp, ADB);
  const boot = await cdp.eval<string>(`
    (async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      document.querySelector('#aboutClose')?.click();
      await sleep(200);
      const msg = [];
      if (${JSON.stringify(PAGE)} !== '') {
        try { await window.__accelon26.openPage(${JSON.stringify(DB)}, ${JSON.stringify(PAGE)}, ''); }
        catch (e) { msg.push('openPage error: ' + e); }
        await sleep(900);
      }
      if (${JSON.stringify(LINE)} !== '') {
        try { await window.__accelon26.showLine(${Number(LINE) || 0}); } catch (e) { msg.push('showLine error: ' + e); }
        await sleep(500);
      }
      const cur = document.querySelector('#docText .docBody');
      return JSON.stringify({ msg, lines: document.querySelectorAll('#docText .docLine').length, head: (cur ? cur.innerText : '').slice(0, 80) });
    })()
  `);
  console.log('BOOT ' + boot);

  if (EXPR || EXPR_FILE) {
    const code = EXPR_FILE ? await Bun.file(resolve(EXPR_FILE)).text() : EXPR;
    const r = await cdp.eval<string>(`
      (async () => {
        try { return JSON.stringify(await (async () => (${code}))(), null, 1); }
        catch (e) { return 'EVAL ERROR: ' + (e && e.stack ? e.stack : e); }
      })()
    `);
    console.log(r);
  }

  if (PNG) {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    await Bun.write(resolve(PNG), Buffer.from(shot.data, 'base64'));
    console.log('screenshot ' + resolve(PNG));
  }
} finally {
  await close();
}
