#!/usr/bin/env bun
/**
 * tools/_capture-slides.ts — 抓官網首页 gallery 三張新截圖（1a/2a/3a）
 *   bun run tools/_capture-slides.ts [shot1|shot2|shot3|all]
 *
 * 三張（對應使用者選的 1a/2a/3a）：
 *   www/img/kemontiers.jpg  — 3a：ybh 目錄樹 tagChromaIndex 22 層色階
 *   www/img/fusionview.jpg  — 2a：ybh?T1579-1#kpD02-001 融視圖 ON、注文嵌回原論本
 *   www/img/revlink.jpg     — 1a：taisho?30p279a 反鏈一排（ybh 挂 81 條）
 *
 * headless Chromium（_cdp.ts）開 accelon26.html、#file 塞 adb、CDP Page.captureScreenshot。
 * 尺寸 1280×720 JPEG，與現有 5 張一致。
 */
import { resolve } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { launch, loadAdb } from './_cdp';

const ROOT = resolve(import.meta.dir, '../..');
const IMG_DIR = resolve(ROOT, 'www/img');
mkdirSync(IMG_DIR, { recursive: true });
const which = process.argv[2] ?? 'all';

async function shot(cdp: import('./_cdp').Cdp, name: string): Promise<void> {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await Bun.sleep(300);
  const r = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 82 });
  const buf = Buffer.from(r.data as string, 'base64');
  writeFileSync(resolve(IMG_DIR, name), buf);
  console.log('  wrote www/img/' + name, buf.length, 'bytes');
}

// 切到名字含 sub 的 db chip（profile 復用會殘留 manual 等其他庫，active 未必是目標）
async function useDb(cdp: import('./_cdp').Cdp, sub: string): Promise<boolean> {
  return cdp.eval<boolean>(`(async () => {
    const chips = [...document.querySelectorAll('#dbTabs .dbChip')];
    const t = chips.find(c => (c.textContent || '').includes(${JSON.stringify(sub)}));
    if (!t) return false;
    t.click();
    await new Promise(r => setTimeout(r, 600));
    return true;
  })()`);
}

const { cdp, close } = await launch({ html: 'D:/accelon3/accelon26.html', tag: 'capture-slides', windowSize: '--window-size=1300,760' });
try {
  const ybh = 'D:/accelon3/ybh.adb';
  const taisho = 'D:/accelon3/taisho.adb';
  await loadAdb(cdp, ybh);
  // 關掉「啟動時顯示本頁面」關於框（會蓋住主欄，內存記过）
  await cdp.eval(`(() => { const b = document.getElementById('aboutClose'); if (b) b.click(); return 1; })()`);
  await Bun.sleep(300);
  // profile 復用可能殘留 manual 等庫且 active 不是 ybh → 明確切到 ybh 分頁
  await useDb(cdp, '瑜伽師地論漢文集成');

  if (which === 'all' || which === '1') {
    console.log('[3a] 目錄樹層級色…');
    await useDb(cdp, '瑜伽師地論漢文集成');
    // 展開到 章→科 層：點第一個 篇 的 twisty，再 Alt 點展開全部子孫
    await cdp.eval(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const tw = document.querySelector('#dirTree .tTwisty');
      if (tw) { tw.click(); await sleep(400); }
      const tw2 = document.querySelectorAll('#dirTree .tTwisty')[1];
      if (tw2) { tw2.dispatchEvent(new MouseEvent('click', { altKey: true, bubbles: true })); await sleep(700); }
    })()`);
    await cdp.waitFor('document.querySelectorAll("#dirTree .tRow").length > 12', 6000);
    await shot(cdp, 'kemontiers.jpg');
  }

  if (which === 'all' || which === '2') {
    console.log('[2a] 融視圖 ON・T1579-1#kpD02-001…');
    await useDb(cdp, '瑜伽師地論漢文集成');
    await cdp.eval(`(() => { const cb = document.getElementById('fusionOn'); if (cb && !cb.checked) cb.click(); return 1; })()`);
    await cdp.eval(`(() => { window.__accelon26.openPage('ybh', 'T1579-1#kpD02-001', ''); return 1; })()`);
    await cdp.waitFor(`document.querySelectorAll('#docText .fusionBlock[data-done="1"]').length > 0`, 25000);
    await Bun.sleep(1500);   // 讓其餘殼也填完
    await shot(cdp, 'fusionview.jpg');
  }

  if (which === 'all' || which === '3') {
    console.log('[1a] 反鏈・taisho?30p279a（ybh 挂 81 條）…');
    await loadAdb(cdp, taisho);   // 載第二庫→active 換 taisho（ybh 仍在 sources 裡貢獻反鏈）
    await cdp.eval(`(() => { window.__accelon26.openPage('taisho', '30p279a', ''); return 1; })()`);
    await cdp.waitFor('document.querySelector(".xrefRevBar") !== null', 45000);
    await Bun.sleep(2000);   // 等一排 chips 都畫完
    await shot(cdp, 'revlink.jpg');
  }
} finally {
  await close();
}
