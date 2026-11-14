#!/usr/bin/env bun
/**
 * ys-longline-probe.ts — 查「頁碼標記落在行尾時，硬換行是不是被吃掉了」
 *
 *   bun run tools/ys-longline-probe.ts --page 1pa7a
 *
 * 裕文居士 2026-11-14 14:37 的截圖（1pa7a／1pa8a／1pa9a）圈起來的「特別長的一行」，
 * 每一條的右端都是頁碼晶片 —— 懷疑是 `<頁 id=…/>` 收在行尾時把硬換行吃掉了。
 * 這支探針只做兩件事：
 *   ① 印出聲頁面前 12 個 block 的 class、字數、有沒有頁碼晶片、前 50 字
 *   ② 量「這一行有幾個字」對比「資料裡那一行有幾個字」
 */
import { resolve } from 'node:path';
import { launch, loadAdb } from './_cdp';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => {
  const i = args.indexOf('--' + n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const HTML = resolve(opt('html', 'D:/accelon3/accelon26.html'));
const ADB = resolve(opt('adb', 'D:/accelon3/ys.adb'));
const PAGE = opt('page', '1pa7a');
const DB = opt('db', 'ys');
const NEEDLE = opt('needle', '');
const PNG = resolve(opt('png', 'D:/2026/adb-converter/build/ys-long.png'));

const { cdp, close } = await launch({ html: HTML, tag: 'yslong' });
try {
  await loadAdb(cdp, ADB);

  const report = await cdp.eval<string>(`
    (async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
      await window.__accelon26.openPage(${JSON.stringify(DB)}, ${JSON.stringify(PAGE)});
      await settle(() => document.querySelectorAll('#docText .docBody > *').length || 0, 6000);
      const body = document.querySelector('#docText .docBody');
      const out = { db: ${JSON.stringify(DB)}, page: ${JSON.stringify(PAGE)}, hardBreaks: window.__accelon26.hardBreaksOn?.(), blocks: [] };
      const all = [...body.children];
      let kids = all.slice(0, 16);
      if (${JSON.stringify('')} !== '') {}
      const n = ${JSON.stringify(NEEDLE)};
      if (n) {
        const k = all.findIndex((e) => (e.textContent || '').includes(n));
        out.needleAt = k;
        kids = k >= 0 ? all.slice(Math.max(0, k - 3), k + 6) : all.slice(0, 3);
      }
      out.maxChars = Math.max(...all.map((e) => (e.textContent || '').replace(/\s/g, '').length));
      for (const el of kids) {
        const txt = (el.textContent || '');
        out.blocks.push({
          cls: String(el.className || el.tagName),
          chars: txt.replace(/\\s/g, '').length,
          hasPage: !!el.querySelector('.pageMark, [class*=page], .pm'),
          inner: el.innerHTML.slice(0, 150),
          text: txt.slice(0, 60),
        });
      }
      // 抓頁碼晶片的位置：它的 rect 相對文字行
      out.chips = [...document.querySelectorAll('#docText .docBody [class*=page], #docText .docBody .pm')]
        .slice(0, 8).map((e) => ({ cls: String(e.className), txt: e.textContent.trim(), top: Math.round(e.getBoundingClientRect().top) }));
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
