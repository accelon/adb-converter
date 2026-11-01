#!/usr/bin/env bun
/**
 * 引紋（熱圖）頁籤的版面對不對（2026-10-31）：
 * 縮圖（.heatMiniWrap）不能高到把下面的 heatDetail 擠出畫面。
 *
 *   cd ts && bun run tools/heat-layout-test.ts [--html ../build/accelon26.html]
 *        [--w 1500] [--h 1100]
 */
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const ROOT = resolve(import.meta.dir, '../..');
const HTML = resolve(opt('html', resolve(ROOT, 'build/accelon26.html')));
const YS = resolve(opt('ys', 'D:/accelon3/ys.adb'));
const TAISHO = resolve(opt('taisho', 'D:/accelon3/taisho.adb'));
const W = Number(opt('w', '1500'));
const H = Number(opt('h', '1100'));
const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const browser = BROWSERS.find((p) => existsSync(p));
if (!browser) { console.error('no Chromium browser'); process.exit(2); }
const profile = resolve(ROOT, 'build/.chrome-profile-hl-' + process.pid);
const proc = Bun.spawn([browser, '--headless=new', '--disable-gpu', '--no-first-run',
  '--remote-debugging-port=0', '--remote-allow-origins=*', '--allow-file-access-from-files',
  `--window-size=${W},${H}`, `--user-data-dir=${profile}`, 'about:blank'],
  { stdout: 'pipe', stderr: 'pipe' });
async function devtoolsUrl(): Promise<string> {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const text = await Bun.file(resolve(profile, 'DevToolsActivePort')).text().catch(() => '');
    const [port, path] = text.split('\n').map((s) => s.trim());
    if (Number(port) > 0 && path) return `ws://127.0.0.1:${port}${path}`;
    await Bun.sleep(200);
  }
  throw new Error('no devtools');
}
class Cdp {
  ws!: WebSocket; id = 0; sessionId = '';
  pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  logs: string[] = [];
  static async attach(url: string): Promise<Cdp> {
    const c = new Cdp();
    await new Promise<void>((res, rej) => {
      c.ws = new WebSocket(url);
      c.ws.onopen = () => res();
      c.ws.onerror = () => rej(new Error('ws error'));
      c.ws.onmessage = (ev) => {
        const m = JSON.parse(String(ev.data));
        if (m.method === 'Runtime.consoleAPICalled') c.logs.push('[console] ' + (m.params?.args ?? []).map((a: any) => a.value ?? a.description ?? a.type).join(' '));
        if (m.method === 'Runtime.exceptionThrown') c.logs.push('[exception] ' + (m.params?.exceptionDetails?.exception?.description ?? m.params?.exceptionDetails?.text));
        if (m.id && c.pending.has(m.id)) {
          const p = c.pending.get(m.id)!; c.pending.delete(m.id);
          m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
        }
      };
    });
    return c;
  }
  send(method: string, params: Record<string, unknown> = {}, session = true): Promise<any> {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, sessionId: session ? this.sessionId : undefined }));
    });
  }
  async openPage(url: string): Promise<void> {
    const { targetId } = await this.send('Target.createTarget', { url }, false);
    const r = await this.send('Target.attachToTarget', { targetId, flatten: true }, false);
    this.sessionId = r.sessionId;
    await this.send('Page.enable'); await this.send('Runtime.enable'); await this.send('DOM.enable');
  }
  async eval<T>(expression: string): Promise<T> {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
    return r.result.value as T;
  }
}
async function pick(file: string): Promise<void> {
  const doc = await cdp.send('DOM.getDocument');
  const q = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#file' });
  await cdp.send('DOM.setFileInputFiles', { files: [file], nodeId: q.nodeId });
  await cdp.eval('document.querySelector("#file").dispatchEvent(new Event("change"))');
}

const cdp = await Cdp.attach(await devtoolsUrl());
await cdp.openPage(pathToFileURL(HTML).href + '?v=' + Date.now());
await Bun.sleep(900);
// 模擬 100% 縮放（DSF 1）
await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
await pick(TAISHO); await Bun.sleep(4000);
await pick(YS); await Bun.sleep(4500);

const out = JSON.parse(await cdp.eval<string>(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const api = window.__accelon26;
  await api.closeAbout?.();
  document.body.classList.add('advanced');   // 引紋是進階分頁
  const input = document.getElementById('query');
  input.focus();
  input.value = '何等為信根';
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
  // 這頁有反鏈 → 「引紋」頁籤會出現
  const btn = document.querySelector('#colRight .tabBtn[data-tab="heat"]');
  let shown = false;
  for (let i = 0; i < 120; i++) {
    await sleep(100);
    if (btn && !btn.hidden) { shown = true; break; }
  }
  if (!shown) return JSON.stringify({ error: 'heat tab not shown', err: globalThis.__revErr ?? null });
  btn.click();
  let wrap = null;
  for (let i = 0; i < 200; i++) {
    await sleep(100);
    wrap = document.querySelector('#heatBody .heatMiniWrap');
    if (wrap) break;
  }
  if (!wrap) return JSON.stringify({ error: 'no heatMiniWrap' });
  await sleep(400);
  const r = (el) => { const x = el.getBoundingClientRect(); return { top: Math.round(x.top), bottom: Math.round(x.bottom), h: Math.round(x.height) }; };
  const body = document.getElementById('heatBody');
  const detail = document.getElementById('heatDetail');
  const miniScroll = document.querySelector('#heatBody .heatMiniScroll');
  return JSON.stringify({
    viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
    pane: r(document.querySelector('#colRight .tabPane[data-tab="heat"]') ?? body),
    heatBody: r(body),
    miniWrap: r(wrap),
    miniScroll: miniScroll ? r(miniScroll) : null,
    detail: detail ? r(detail) : null,
    heatBodyStyle: { h: getComputedStyle(body).height, overflow: getComputedStyle(body).overflow },
    activeTab: document.querySelector('#colRight .tabBtn.active')?.dataset.tab ?? '',
    paneActive: !!document.querySelector('#colRight .tabPane.active[data-tab=heat]'),
    detailDisplay: detail ? getComputedStyle(detail).display : '',
    miniOverflow: getComputedStyle(wrap).overflow,
  }, null, 1);
})()`));
console.log(JSON.stringify(out, null, 1));
const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }).catch(() => null);
if (shot?.data) writeFileSync(resolve(ROOT, 'build/heat-layout.png'), Buffer.from(shot.data, 'base64'));
if (cdp.logs.length) console.log('--- console ---\n' + cdp.logs.join('\n'));
proc.kill();
await Bun.sleep(200);
try { rmSync(profile, { recursive: true, force: true }); } catch { /* browser may hold it */ }

const fails: string[] = [];
if (out.error) fails.push(out.error);
if (out.detail && out.heatBody && out.detail.bottom > out.heatBody.bottom + 2) fails.push(`heatDetail 被擠出 heatBody：detail.bottom=${out.detail.bottom} > body.bottom=${out.heatBody.bottom}`);
if (out.detail && out.detail.h < 60) fails.push('heatDetail 太矮：' + out.detail.h);
if (out.detail && out.detail.bottom > out.viewport.h) fails.push('heatDetail 在視窗外：' + JSON.stringify(out.detail));
if (out.miniWrap && out.heatBody && out.miniWrap.h > out.heatBody.h * 0.6) fails.push('縮圖太高：' + out.miniWrap.h + ' / ' + out.heatBody.h);
if (cdp.logs.some((l) => l.startsWith('[exception]'))) fails.push('console 有 exception');
if (fails.length) { console.error('FAIL:\n- ' + fails.join('\n- ')); process.exit(1); }
console.log('ok: 引紋頁籤的縮圖沒有擠掉 heatDetail');
