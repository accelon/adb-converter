#!/usr/bin/env bun
/**
 * 通用頁面探針：載入任一 adb，跳一頁，印出這一頁的版面塊結構並截圖。
 *
 *   bun run tools/page-probe.ts [--adb D:/accelon3/ys.adb] [--db ys] [--page 8p5a] [--png build/p.png]
 *
 * 用途：查「資料有、畫面沒有」那一類——例如標題該獨立成行卻黏在上一段末尾。
 * 印出的每一塊附 class（docParaHeading 就是被當成標題塊）、標籤與前 40 字。
 *
 * 注意：印出的 `blocks` 是**目前視窗裡的行**（一次 200 行），不是書頁邊界；
 * 判斷分頁要用頁標記，不要用它。
 */
import { resolve } from 'node:path';
import { launch, loadAdb } from './_cdp';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => {
  const i = args.indexOf('--' + n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const ROOT = resolve(import.meta.dir, '../..');
const HTML = resolve(opt('html', 'D:/accelon3/accelon26.html'));
const ADB = resolve(opt('adb', resolve(ROOT, 'accelon3/ys.adb')));
const DB = opt('db', 'ys');
const PAGE = opt('page', '8p5a');
const PNG = resolve(opt('png', resolve(ROOT, 'build/page-probe.png')));
/** 連排模式（不保留硬換行）＝讀者常見的版面；`--reflow 1` 開 */
const REFLOW = opt('reflow', '0') === '1';

const { cdp, close } = await launch({ html: HTML, tag: 'pageprobe' });
try {
  await loadAdb(cdp, ADB);

  const report = await cdp.eval<string>(`
    (async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const until = async (fn, ms = 15000) => {
        const d = Date.now() + ms;
        while (Date.now() < d) { if (fn()) return true; await sleep(50); }
        return false;
      };
      // 內容是漸進渲染的：條件一成立就截圖會拿到半頁（38p107 曾只看到 3 塊）。
      // 等「同一個數字連續三次不變」才算定下來。
      const settle = async (fn, ms = 15000) => {
        const d = Date.now() + ms;
        let prev = null, same = 0;
        while (Date.now() < d) {
          const v = fn();
          if (v === prev) { if (++same >= 3) return true; } else { same = 0; prev = v; }
          await sleep(60);
        }
        return false;
      };
      document.querySelector('#aboutClose')?.click();
      const out = { db: ${JSON.stringify(DB)}, page: ${JSON.stringify(PAGE)}, reflow: ${REFLOW} };
      if (${REFLOW}) { window.__accelon26.setHardBreaks(false); }
      await window.__accelon26.openPage(${JSON.stringify(DB)}, out.page);
      // 這一頁的塊（沒有目標行可等，只能等它畫完；上限給 5 秒，別讓它拖到 15 秒）
      await settle(() => document.querySelector('#docText .docBody')?.children.length || 0, 5000);
      const body = document.querySelector('#docText .docBody');
      out.head = (body?.innerText ?? '').replace(/\\s+/g, ' ').slice(0, 160);
      const blocks = [...document.querySelectorAll('#docText .docBody > *')].slice(0, 40);
      out.blocks = blocks.map((el) => ({
        tag: el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).replace(/\\s+/g, '.') : ''),
        text: (el.textContent || '').replace(/\\s+/g, ' ').slice(0, 46),
        hasSvg: !!el.querySelector('svg'),
        hasHeading: !!el.querySelector('.h'),
      }));
      out.blockCount = document.querySelectorAll('#docText .docBody > *').length;
      out.figures = [...document.querySelectorAll('#docText .docBody svg.inlineSvg, #docText .docBody img')]
        .map((e) => ({ tag: e.tagName.toLowerCase(), cls: String(e.className || ''), rectW: Math.round(e.getBoundingClientRect().width) }));
      return JSON.stringify(out, null, 1);
    })()
  `);
  console.log(report);

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  await Bun.write(PNG, Buffer.from(shot.data, 'base64'));
  console.log('screenshot ' + PNG);
} finally {
  await close();
}
