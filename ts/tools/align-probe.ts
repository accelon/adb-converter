#!/usr/bin/env bun
/**
 * 對齊探針：找含指定字串的列，量每個字的 x 座標，看「線條字元排的表」有沒有對齊。
 *
 *   bun run tools/align-probe.ts --adb D:/accelon3/fuyan.adb --db fuyan --find 古說 --png build/align.png
 *
 * 用途：厚觀法師 2026-11-12「82 頁文字編排不整齊」。整段以全形空白與 ┌│└ 排成表格，
 * 讀者端只要字寬不是等寬（或空白被吃掉），欄位就會歪。
 *
 * 注意：閱讀器是**按需渲染**的（不是一次畫滿 200 行）。目標行不在畫面上時，
 * 它根本不在 DOM 裡，`--find` 一定找不到——請用 `--line` 指定行號（會用 showLine
 * 跳過去），或先 `--page` 跳到那一頁再找。
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
const ADB = resolve(opt('adb', resolve(ROOT, 'accelon3/fuyan.adb')));
const DB = opt('db', 'fuyan');
const FIND = opt('find', '古說');
const PNG = resolve(opt('png', resolve(ROOT, 'build/align-probe.png')));
const REFLOW = opt('reflow', '0') === '1';
const PAGE = opt('page', '');
/** 直接指定行號（推薦）：閱讀器按需渲染，不先跳過去，那行可能根本不在 DOM 裡 */
const LINE = Number(opt('line', '0'));

const { cdp, close } = await launch({ html: HTML, tag: 'align' });
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
      document.querySelector('#aboutClose')?.click();
      if (${REFLOW}) { window.__accelon26.setHardBreaks(false); }
      if (${JSON.stringify(PAGE)}) {
        await window.__accelon26.openPage(${JSON.stringify(DB)}, ${JSON.stringify(PAGE)});
        await until(() => document.querySelectorAll('#docText .docLine').length > 0, 8000);
      }
      if (${LINE} && !document.getElementById('L' + ${LINE})) {
        await window.__accelon26.showLine(${LINE});
        await until(() => !!document.getElementById('L' + ${LINE}), 8000);
      }
      const pick = () => [...document.querySelectorAll('#docText .docLine')]
        .filter((e) => (e.textContent || '').includes(${JSON.stringify(FIND)}));
      let rows = pick();
      if (!rows.length) {
        // 不在目前的視窗裡：用搜尋把它拉進來（拉完要重新取，元素會換）
        window.__accelon26.search?.(${JSON.stringify(FIND)});
        await sleep(1200);
        rows = pick();
      }
      const out = { find: ${JSON.stringify(FIND)}, count: rows.length, lines: [] };
      // 找不到時要能看出原因：總共幾列、前幾列長什麼樣
      const all = [...document.querySelectorAll('#docText .docLine')];
      out.total = all.length;
      out.sample = all.slice(0, 5).map((e) => e.id + ' ' + (e.textContent || '').slice(0, 20));
      for (const row of rows.slice(0, 8)) {
        row.scrollIntoView({ block: 'center' });
        await sleep(120);
        const txt = row.textContent || '';
        // 量每個字的 x：用 Range 讀位置（不影響版面）
        const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
        const chars = [];
        let node;
        while ((node = walker.nextNode())) {
          for (let i = 0; i < (node.nodeValue || '').length; i++) {
            const ch = node.nodeValue[i];
            const r = document.createRange();
            r.setStart(node, i); r.setEnd(node, i + 1);
            const b = r.getBoundingClientRect();
            chars.push({ ch: ch.trim() === '' ? '·' : ch, x: Math.round(b.left), w: Math.round(b.width) });
          }
        }
        out.lines.push({ id: row.id, text: txt, chars: chars.slice(0, 60) });
      }
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
