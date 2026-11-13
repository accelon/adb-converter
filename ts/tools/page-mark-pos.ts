#!/usr/bin/env bun
/**
 * 頁碼位置探針：這一個 `<頁 id>` 的頁碼畫在「行尾（右）」還是「行首（左）」？
 *
 * 背景（厚觀法師 2026-11-08 錯誤 02「頁碼統一靠右」）：閱讀器把頁碼當成
 * 前一行尾端的標記；若 `<頁/>` 在資料裡黏在下一行**行首**（例如
 * `<頁 id="5p2"/><項>…</項>`），渲染時頁碼就落在那一行的左邊，
 * 和原書「頁碼在頁首右上」不一致。
 *
 *   bun run tools/page-mark-pos.ts --db D:/accelon3/fuyan.adb \
 *       --pages 5p1,5p2,5p3,9p50,38p50
 *
 * 判準：頁碼元素的中心 x 落在內文區右半 → right（好）；左半 → left（壞）。
 */
import { launch, loadAdb } from './_cdp';

const args = process.argv.slice(2);
const opt = (name: string, def = ''): string => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? (args[i + 1] ?? def) : def;
};

const DB = opt('db', 'D:/accelon3/fuyan.adb');
const PAGES = opt('pages').split(',').map((s) => s.trim()).filter(Boolean);
const HTML = opt('html', 'D:/accelon3/accelon26.html');

const { cdp, close } = await launch({ html: HTML, tag: 'pagemark' });
try {
  await loadAdb(cdp, DB);
  const out = await cdp.eval<
    Array<{ page: string; side: string; x: number; w: number; left: number; text: string; sameLineText: string }>
  >(`
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  document.querySelector('#aboutClose')?.click();
  const res = [];
  for (const page of ${JSON.stringify(PAGES)}) {
    await window.__accelon26.openPage('fuyan', page, '');
    await sleep(500);
    const body = document.querySelector('#docText .docBody');
    const marks = [...document.querySelectorAll('#docText .pageBreak[data-page]')];
    const el = marks.find((e) => e.dataset.page === page);
    if (!el) { res.push({ page, side: 'missing', x: 0, w: 0, left: 0, text: '', sameLineText: '' }); continue; }
    const r = el.getBoundingClientRect();
    const lineEl = el.closest('.docLine') || el.parentElement;
    const lr = lineEl.getBoundingClientRect();
    const br = body.getBoundingClientRect();
    const centre = r.left + r.width / 2;
    const rel = (centre - br.left) / Math.max(1, br.width);
    const lineText = (lineEl.textContent || '').replace(/\\s+/g, '');
    res.push({
      page,
      side: rel > 0.55 ? 'right' : (rel < 0.45 ? 'left' : 'middle'),
      x: Math.round(r.left),
      w: Math.round(r.width),
      left: Math.round(lr.left),
      text: (el.textContent || '').trim(),
      sameLineText: lineText.slice(0, 30),
    });
  }
  return res;
})()`);
  let bad = 0;
  for (const r of out) {
    if (r.side !== 'right') bad++;
    console.log(
      `${r.page.padEnd(7)} ${r.side.padEnd(7)} x=${String(r.x).padStart(5)} lineLeft=${String(r.left).padStart(5)}  ${r.sameLineText}`,
    );
  }
  console.log(`\n共 ${out.length} 頁，行首 ${bad} 頁`);
  process.exitCode = bad ? 1 : 0;
} finally {
  await close();
}
