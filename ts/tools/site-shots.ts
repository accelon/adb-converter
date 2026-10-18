/**
 * 官網截圖（作者 2026-10-18）：把 accelon26 的幾個畫面拍成 gallery 用的 JPEG。
 *
 *   bun run tools/site-shots.ts            # 產出 www/img/*.jpg
 *   bun run tools/site-shots.ts --html …   # 拍別份 build
 *
 * 為什麼是一支腳本而不是手動截圖：官網的圖會隨 UI 改版過時，而**過時的官網圖**
 * 比沒有圖更糟（使用者會懷疑自己下載錯東西）。UI 改了就重跑這支，一次四張。
 *
 * 四張圖各對應官網列的一個特色：
 *   search.jpg     全文搜尋（邊打邊查、命中塗紅）
 *   tour.jpg       操作導覽（聚光燈＋說明氣泡）
 *   dict.jpg       詞典分頁（點本文的詞就查詞條）
 *   allsearch.jpg  一次搜尋所有資料庫
 *
 * 每換一個資料庫就 reload 一次：換庫時若剛好有「上一庫的分頁載入中」，它會在換庫後
 * 才落地，畫面上就會留著前一個庫的本文（截圖不能拍到這種東西）。
 */
import { resolve } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const ROOT = resolve(import.meta.dir, '../..');
const HTML = resolve(opt('html', resolve(ROOT, 'build/accelon26.html')));
const OUT = resolve(opt('out', resolve(ROOT, 'www/img')));
const W = 1280;
const H = 720;
// 720p（作者 2026-10-18）：視窗小、字就相對大；1x 輸出，官網上縮到 60% 寬時字還看得清。
const SCALE = 1;
const QUALITY = 90;

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const browser = BROWSERS.find((p) => existsSync(p));
if (!browser) { console.error('no Chromium browser found'); process.exit(2); }
if (!existsSync(HTML)) { console.error('missing ' + HTML + ' (run tools/build-viewer.ts)'); process.exit(2); }
for (const f of ['13j.adb', 'fgdict.adb']) {
  if (!existsSync(resolve(ROOT, f))) { console.error('missing ' + f); process.exit(2); }
}

const profile = resolve(ROOT, 'build/.chrome-profile-shots');
const proc = Bun.spawn([browser, '--headless=new', '--disable-gpu', '--no-first-run',
  '--remote-debugging-port=0', '--remote-allow-origins=*', '--allow-file-access-from-files',
  `--window-size=${W},${H}`, `--force-device-scale-factor=${SCALE}`,
  `--user-data-dir=${profile}`, 'about:blank'], { stdout: 'pipe', stderr: 'pipe' });

const sleep = (ms: number) => Bun.sleep(ms);

class Cdp {
  ws!: WebSocket; id = 0; pending = new Map<number, any>(); sessionId = '';
  static async attach(url: string) {
    const c = new Cdp();
    await new Promise<void>((res, rej) => {
      c.ws = new WebSocket(url);
      c.ws.onopen = () => res();
      c.ws.onerror = () => rej(new Error('ws'));
      c.ws.onmessage = (ev) => {
        const m = JSON.parse(String(ev.data));
        if (m.id && c.pending.has(m.id)) {
          const p = c.pending.get(m.id); c.pending.delete(m.id);
          m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
        }
      };
    });
    return c;
  }
  async send(method: string, params: any = {}, session = true): Promise<any> {
    const id = ++this.id;
    const payload: any = { id, method, params };
    if (session && this.sessionId) payload.sessionId = this.sessionId;
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => { if (this.pending.delete(id)) rej(new Error('timeout ' + method)); }, 60000);
    });
  }
  async openPage(url: string) {
    const { targetId } = await this.send('Target.createTarget', { url }, false);
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true }, false);
    this.sessionId = sessionId;
    await this.send('Runtime.enable');
    await this.send('Page.enable');
    await this.send('DOM.enable');
  }
  async eval<T>(e: string): Promise<T> {
    let r: any;
    for (let i = 0; i < 3; i++) {
      try {
        r = await this.send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
        break;
      } catch (err) {
        if (i === 2) throw err;
        await sleep(500);
      }
    }
    if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'eval');
    return r.result.value as T;
  }
}

async function devtoolsUrl(): Promise<string> {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    const text = await Bun.file(resolve(profile, 'DevToolsActivePort')).text().catch(() => '');
    const [portLine, pathLine] = text.split('\n').map((s) => s.trim());
    if (Number(portLine) > 0 && pathLine) return `ws://127.0.0.1:${portLine}${pathLine}`;
    await sleep(250);
  }
  throw new Error('DevToolsActivePort never appeared');
}

/** 瀏覽器剛啟動時 CDP 端點偶爾還沒接得上，重試幾次 */
async function attach(): Promise<Cdp> {
  const url = await devtoolsUrl();
  for (let i = 0; i < 8; i++) {
    try { return await Cdp.attach(url); } catch { await sleep(600); }
  }
  throw new Error('CDP attach failed');
}

const cdp = await attach();
await cdp.openPage(pathToFileURL(HTML).href + '?v=' + Date.now());

async function metrics(): Promise<void> {
  await cdp.send('Emulation.setDeviceMetricsOverride',
    { width: W, height: H, deviceScaleFactor: SCALE, mobile: false });
}

/** 等頁面載好（含 __accelon26）並把啟動時自動打開的「關於」關掉 */
async function ready(): Promise<void> {
  await metrics();
  for (let i = 0; i < 150; i++) {
    const ok = await cdp.eval<boolean>('typeof window.__accelon26 === "object" && !!window.__accelon26.state').catch(() => false);
    if (ok) break;
    await sleep(200);
  }
  await sleep(500);
  await cdp.eval('window.__accelon26.closeAbout()');
  await sleep(200);
}

async function reload(): Promise<void> {
  await cdp.send('Page.reload', { ignoreCache: true });
  await sleep(900);
  await ready();
}

/** 把一個 .adb 塞進 #file（跟使用者挑檔一樣的路徑） */
async function openAdb(file: string): Promise<void> {
  const doc = await cdp.send('DOM.getDocument');
  const node = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#file' });
  await cdp.send('DOM.setFileInputFiles', { files: [resolve(ROOT, file)], nodeId: node.nodeId });
  await sleep(350);
  await cdp.eval('document.querySelector("#file").dispatchEvent(new Event("change"))');
  for (let i = 0; i < 400; i++) {
    const ok = await cdp.eval<boolean>(`(() => {
      const st = window.__accelon26.state();
      if (!st.db) return false;
      const dir = document.querySelector('#colLeft .tabBtn[data-tab="dir"]');
      const dirShown = dir && dir.getBoundingClientRect().width > 0;
      return dirShown
        ? document.querySelectorAll('#dirTree .tRow').length > 2
        : !!document.querySelector('#termsList .snippet');
    })()`);
    if (ok) break;
    await sleep(200);
  }
  await sleep(700);
}

/** 等某個條件成立（回傳 false＝逾時） */
async function until(js: string, tries = 200): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if (await cdp.eval<boolean>(js)) return true;
    await sleep(200);
  }
  return false;
}

let n = 0;
async function shot(name: string): Promise<void> {
  await sleep(600);
  const r = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: QUALITY });
  const buf = Buffer.from(r.data, 'base64');
  writeFileSync(resolve(OUT, name), buf);
  console.log(`  ${++n}. ${name}  ${(buf.length / 1024).toFixed(0)} KiB`);
}

mkdirSync(OUT, { recursive: true });
console.log(`拍 ${W}×${H} ×${SCALE} q${QUALITY} → ${OUT}`);

// ================================================================ 1) 全文搜尋
await ready();
await openAdb('13j.adb');
await cdp.eval(`(() => {
  const q = document.querySelector('#query');
  q.value = '君子';
  q.dispatchEvent(new Event('input'));
})()`);
await until(`document.querySelectorAll('#searchList .snippet').length > 3`);
await cdp.eval('document.querySelector("#searchList .snippet")?.click()');
await until(`document.querySelectorAll('#docText mark.docHit').length > 0`);
await shot('search.jpg');

// ================================================================ 2) 操作導覽
// 停在「本文跳到那一句、命中塗紅」那一步：聚光燈照著本文，氣泡正在解說
await cdp.eval('void window.__accelon26.playTour("first-run", 2)');
await until(`(() => {
  const st = window.__accelon26.tourState();
  return st.point === '#docText' && st.spot && st.spot.visible;
})()`);
await sleep(900);
await shot('tour.jpg');
await cdp.eval('window.__accelon26.stopTour()');
await sleep(400);

// ================================================================ 3) 詞典（重新載入，畫面乾淨）
await reload();
await openAdb('fgdict.adb');
// 名詞：查「般若」→ 點第一列（中間就顯示那個詞條的正文）
await cdp.eval(`(() => {
  const q = document.querySelector('#termsQuery');
  q.value = '般若';
  q.dispatchEvent(new Event('input'));
})()`);
// 等的是「列表真的換成般若那幾條」——剛開庫時未篩選的列表已經有 .snippet，
// 只等 .snippet 會點到舊的「一」（作者 2026-10-18 的截圖踩過）
await until(`(document.querySelector('#termsList .snippet b')?.textContent ?? '').includes('般若')`);
await cdp.eval('document.querySelector("#termsList .snippet")?.click()');
await until(`document.querySelectorAll('#docText .docLine').length > 0`);
await until(`(document.querySelector('#docTabStrip .docTab .docTabName')?.textContent ?? '').startsWith('般若')`);
await sleep(700);
// 右欄「詞典」：同樣查般若，上面列詞條、下面是釋文
await cdp.eval(`(() => {
  const btn = document.querySelector('#colRight .tabBtn[data-tab="dict"]');
  if (btn) btn.click();
})()`);
await sleep(400);
await cdp.eval('window.__accelon26.dictLookupAt("般若")');
await until(`document.querySelectorAll('#dictList .dictItem').length > 0`);
await sleep(1500);
await shot('dict.jpg');

// ================================================================ 4) 搜尋所有資料庫
// 重新載入：換庫時若前一個庫有本文分頁，它會留在中間（截圖不要拍到）。
// 這裡兩個庫都不開任何本文分頁，所以畫面乾淨。
await reload();
await openAdb('13j.adb');
await openAdb('fgdict.adb');   // 第二個庫（兩個都在 catalog 裡）
await cdp.eval('window.__accelon26.openSearchAll()');
await sleep(400);
await cdp.eval(`(() => {
  const q = document.querySelector('#allSearchQuery');
  q.value = '般若';
  document.querySelector('#allSearchGo').click();
})()`);
await until(`document.querySelectorAll('#allSearchList .allSearchRow.done').length >= 2`, 400);
await sleep(1000);
await shot('allsearch.jpg');

await cdp.eval('window.__accelon26.closeSearchAll()');
proc.kill();
console.log(`\n${n} 張圖寫到 ${OUT}`);
