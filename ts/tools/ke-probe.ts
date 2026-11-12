#!/usr/bin/env bun
/**
 * 暫用探針：看某一頁、某一行的實際渲染。
 *
 *   bun run tools/ke-probe.ts --page 38p35 --line 739 [--png build/ke.png] [--timing]
 *
 * 印出該行的 outerHTML、computed style（font / background / border）、
 * 附近幾列每個字的 x 座標（查線條字元排的表格對不對齊），並截一張圖。
 *
 * 2026-11-12：改用 `_cdp.ts`。先前每次要 66.5 秒，其中 60 秒是 send() 的
 * 超時 timer 沒清、拖住進程，4.8 秒是刪 profile。現在約 3～4 秒。
 */
import { resolve } from 'node:path';
import { launch, loadAdb } from './_cdp';

const T0 = performance.now();
const LAP_ON = process.argv.includes('--timing');
/** 分段計時（打 stderr，不弄髒 stdout 的 JSON） */
const lap = (m: string) => {
  if (LAP_ON) console.error(`[${((performance.now() - T0) / 1000).toFixed(1)}s] ${m}`);
};

const args = process.argv.slice(2);
const opt = (n: string, d: string) => {
  const i = args.indexOf('--' + n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const ROOT = resolve(import.meta.dir, '../..');
const HTML = resolve(opt('html', 'D:/accelon3/accelon26.html'));
const ADB = resolve(opt('adb', resolve(ROOT, 'accelon3/fuyan.adb')));
const PNG = resolve(opt('png', resolve(ROOT, 'build/ke-probe.png')));
const PAGE = opt('page', '38p35');
const LINE = Number(opt('line', '739'));

const { cdp, close } = await launch({ html: HTML, tag: 'keprobe' });
try {
  lap('browser up');
  await loadAdb(cdp, ADB);
  lap('adb loaded');

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
      await window.__accelon26.openPage('fuyan', ${JSON.stringify(PAGE)});
      // 不等「行數穩定」（按需渲染，行數會一直長，只會等到超時），也不等 openPage
      // 之後的懶加載（目標行常常不在它開的那個窗口裡）：沒有就直接 showLine 跳過去。
      if (!document.getElementById('L' + ${LINE})) {
        await window.__accelon26.showLine(${LINE});
      }
      await until(() => !!document.getElementById('L' + ${LINE}), 5000);
      const out = { page: ${JSON.stringify(PAGE)}, line: ${LINE} };
      const row = document.getElementById('L' + ${LINE});
      out.firstRows = [...document.querySelectorAll('#docText .docLine')].slice(0, 6)
        .map((e) => e.id + ' | ' + (e.textContent || '').replace(/\\s+/g, ' ').slice(0, 28));
      out.rowCount = document.querySelectorAll('#docText .docLine').length;
      if (!row) {
        await window.__accelon26.showLine(${LINE});
        await until(() => document.getElementById('L' + ${LINE}));
      }
      const row2 = document.getElementById('L' + ${LINE});
      row2?.scrollIntoView({ block: 'start' });
      await until(() => {
        const r = document.getElementById('L' + ${LINE})?.getBoundingClientRect();
        return r && r.top >= 0 && r.top < window.innerHeight;
      }, 3000);
      out.found = !!row2;
      out.html = row2 ? row2.outerHTML.slice(0, 1200) : '';
      out.text = row2 ? (row2.textContent || '').replace(/\\s+/g, ' ').slice(0, 80) : '';
      const h = row2?.querySelector('.h');
      if (h) {
        const cs = getComputedStyle(h);
        out.h = {
          tag: h.dataset.tag, up: h.dataset.up, depth: h.dataset.depth,
          fontFamily: cs.fontFamily, fontWeight: cs.fontWeight, fontSize: cs.fontSize,
          color: cs.color, background: cs.backgroundColor,
          border: cs.border, borderTop: cs.borderTopWidth + ' ' + cs.borderTopStyle + ' ' + cs.borderTopColor,
        };
      }
      const nb = row2?.querySelector('.noteBody');
      if (nb) {
        const cs2 = getComputedStyle(nb);
        out.note = {
          fontFamily: cs2.fontFamily, fontWeight: cs2.fontWeight, fontSize: cs2.fontSize,
          cls: nb.className,
          kids: [...nb.querySelectorAll('*')].slice(0, 6).map((e) => {
            const c3 = getComputedStyle(e);
            return (e.className || '(none)') + '[' + ((e.dataset && e.dataset.tag) || '') + '] ' + c3.fontFamily + ' / ' + c3.fontWeight;
          }),
        };
        const bodyCS = getComputedStyle(document.querySelector('#docText'));
        out.docTextFont = bodyCS.fontFamily;
      }
      // 附近幾列的每個字 x（查「線條字元排的表格」對不對齊）
      out.fig = [];
      for (const el of [...document.querySelectorAll('#docText .docLine')]) {
        const id = Number((el.id || '').replace('L', ''));
        if (!id || Math.abs(id - ${LINE}) > 4) continue;
        const chars = [];
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          const v = node.nodeValue || '';
          for (let k = 0; k < v.length; k++) {
            const rg = document.createRange();
            rg.setStart(node, k); rg.setEnd(node, k + 1);
            const b = rg.getBoundingClientRect();
            if (!b.width) continue;
            chars.push([v[k] === '\u3000' ? '_' : v[k], Math.round(b.left)]);
          }
        }
        out.fig.push({ id: id, chars: chars.slice(0, 40) });
      }
      const r = row2?.getBoundingClientRect();
      out.rect = r ? { top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) } : null;
      out.bodyBg = getComputedStyle(document.body).backgroundColor;
      out.theme = document.documentElement.dataset.theme || '(default)';
      return JSON.stringify(out, null, 1);
    })()
  `);
  console.log(report);
  lap('eval done');

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  await Bun.write(PNG, Buffer.from(shot.data, 'base64'));
  console.log('screenshot ' + PNG);
} finally {
  await close();
  lap('closed');
}
