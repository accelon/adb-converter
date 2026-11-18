#!/usr/bin/env bun
/**
 * 一次性畫面層證據探針（DEPLOY §2.2「驗證不可省」用）。
 *
 * 目的：證明「繁體製作的 ADB ＋ 無損簡體顯示 ＋ 繁體搜尋 → 摘要真的塗紅」。
 *   修復前：摘要卡片正文已被 convert: simConverter() 渲染成簡體，
 *           paintCardMarks 拿繁體 marks 去 indexOf 簡體 DOM → 找不到 → 0 個 mark。
 *   修復後：比對前先把查詢字轉成顯示模式（needle）→ 包住簡體命中 → mark > 0。
 *
 * 用法： bun run tools/_sumsim-probe.ts [--adb D:/accelon3/fuyan.adb] [--q 無明]
 * 產出： build/sumsim.png ＋ stdout 一行 JSON 判定。
 */
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { launch, loadAdb } from './_cdp';

const ROOT = resolve(import.meta.dir, '../..');
const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(k);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const HTML = arg('--html', 'D:/accelon3/accelon26.html'); // 用 build-viewer 剛產出的新鮮檔（含修復）
const ADB = arg('--adb', 'D:/accelon3/fuyan.adb');
const Q = arg('--q', '無明'); // 無→无 為無損 SAFE 一對一，正好製造繁簡不一致

const { cdp, close } = await launch({ html: HTML, tag: 'sumsim', windowSize: '--window-size=1400,1000' });
const out: Record<string, unknown> = { adb: ADB, q: Q };
try {
  // 1) 預置無損簡體（accelon26.simmode=1），重載讓 doc-pane 模組 init 讀到
  await cdp.eval(`localStorage.setItem('accelon26.simmode','1'); 'ok'`);
  await cdp.eval(`location.reload()`);
  await cdp.waitFor('window.__accelon26', 20000);

  // 2) 開繁體庫
  await loadAdb(cdp, ADB);
  out.simModeAtRuntime = await cdp.eval(`(async()=>{ return localStorage.getItem('accelon26.simmode'); })()`);

  // 3) 繁體搜尋：填 #query、dispatch input（120ms debounce → runSearch）
  await cdp.eval(`(() => { const q=document.querySelector('#query'); q.value=${JSON.stringify(Q)}; q.focus(); q.dispatchEvent(new Event('input',{bubbles:true})); return 'typed'; })()`);
  const gotCards = await cdp.waitFor(`document.querySelectorAll('#searchList .snippet').length > 0`, 40000, 100);
  out.cardsAppeared = gotCards;

  // 4) 判定：卡片正文是否簡體、卡片內是否出現 <mark> 包住簡體命中
  out.metrics = await cdp.eval(`(() => {
    const cards=[...document.querySelectorAll('#searchList .snippet')];
    const bodyText=cards.map(c=>c.innerText).join('\\n');
    const marks=cards.flatMap(c=>[...c.querySelectorAll('mark')]);
    const markTexts=marks.map(m=>m.textContent||'');
    const first=cards[0];
    return {
      cardCount: cards.length,
      displayHasSimplified: bodyText.includes('无'),        // 顯示端是簡體
      displayHasTraditional: bodyText.includes('無'),        // 若仍殘留繁體代表轉換路徑
      markCount: marks.length,                               // 塗紅數（修復前=0）
      anyMarkMatchesNeedle: markTexts.some(t=>t.includes('无明')), // 包住的正是簡體命中
      sampleMarks: markTexts.slice(0,4),
      firstCardText: first ? first.innerText.slice(0,40) : ''
    };
  })()`);
  const m = out.metrics as any;
  out.PASS = m.markCount > 0 && m.displayHasSimplified && m.anyMarkMatchesNeedle;

  // 5) 截圖摘要欄
  const clip = await cdp.eval(`(() => { const el=document.querySelector('#searchList'); const r=el.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:Math.min(r.height,900)}; })()`) as any;
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 2, mobile: false });
  const shot = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: Math.max(0, clip.x), y: Math.max(0, clip.y), width: Math.max(1, clip.w), height: Math.max(1, clip.h), scale: 1 },
  });
  writeFileSync(resolve(ROOT, 'build/sumsim.png'), Buffer.from(shot.data, 'base64'));
  out.png = 'build/sumsim.png';
} finally {
  console.log(JSON.stringify(out, null, 2));
  await close();
}
process.exit((out as any).PASS ? 0 : 1);
