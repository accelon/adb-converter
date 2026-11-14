#!/usr/bin/env bun
/**
 * fig-probe.ts — 驗《中觀論頌講記》的圖版位置（2026-11-14 圖表核對）
 *
 *   bun run ts/tools/fig-probe.ts --adb D:/2026/fuyan/out/fuyan.adb
 *
 * 畫面層：逐頁開 → 數 #docText svg.inlineSvg，並比對 href 裡的檔案名。
 *   5p34  應有 HG05.034（先前整條漏掉）
 *   5p58  不該有 HG05.070（腳注圖誤插正文）
 *   5p660 應只有 1 張 HG05.660（先前插了兩次）
 *   5p627 應有 HG05.627-1 與 HG05.627-2
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => {
  const i = args.indexOf('--' + n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const ROOT = resolve(import.meta.dir, '../..');
const HTML = resolve(opt('html', 'D:/accelon3/accelon26.html'));
const ADB = resolve(opt('adb', 'D:/2026/fuyan/out/fuyan.adb'));

const CASES = [
  { page: '5p34', want: { 'HG05.034': 1 }, note: 'p34 圖（先前漏掉）' },
  { page: '5p58', want: { 'HG05.070': 0 }, note: 'p58 不該有 070（腳注圖）' },
  { page: '5p660', want: { 'HG05.660': 1 }, note: 'p660 只一張 660' },
  { page: '5p627', want: { 'HG05.627-1': 1, 'HG05.627-2': 1 }, note: 'p627 兩張' },
];

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const browser = BROWSERS.find((p) => existsSync(p));
if (!browser) { console.error('no Chromium browser'); process.exit(2); }
for (const p of [HTML, ADB]) if (!existsSync(p)) { console.error('missing ' + p); process.exit(2); }

const profile = resolve(ROOT, 'build/.chrome-profile-kai' + process.pid);
const proc = Bun.spawn([browser, '--headless=new', '--disable-gpu', '--no-first-run',
  '--remote-debugging-port=0', '--remote-allow-origins=*', '--allow-file-access-from-files',
  '--window-size=1400,1000', `--user-data-dir=${profile}`, 'about:blank'],
  { stdout: 'pipe', stderr: 'pipe' });

async function devtoolsUrl(): Promise<string> {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const text = await Bun.file(resolve(profile, 'DevToolsActivePort')).text().catch(() => '');
    const [portLine, pathLine] = text.split('\n').map((s) => s.trim());
    if (Number(portLine) > 0 && pathLine) return `ws://127.0.0.1:${portLine}${pathLine}`;
    await Bun.sleep(200);
  }
  throw new Error('no devtools');
}

let ws!: WebSocket;
let id = 0;
const pending = new Map<number, (v: any) => void>();
let sessionId = '';
const errors: string[] = [];

ws = new WebSocket(await devtoolsUrl());
await new Promise<void>((res) => { ws.onopen = () => res(); });
ws.onmessage = (ev) => {
  const m = JSON.parse(String(ev.data));
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params?.exceptionDetails?.exception?.description ?? 'exception');
  if (m.id && pending.has(m.id)) { const f = pending.get(m.id)!; pending.delete(m.id); f(m.result ?? m); }
};
function send(method: string, params: Record<string, unknown> = {}, session = true): Promise<any> {
  const n = ++id;
  return new Promise((res) => {
    pending.set(n, res);
    const payload: Record<string, unknown> = { id: n, method, params };
    if (session && sessionId) payload.sessionId = sessionId;
    ws.send(JSON.stringify(payload));
  });
}
const { targetId } = await send('Target.createTarget', { url: 'about:blank' }, false);
const att = await send('Target.attachToTarget', { targetId, flatten: true }, false);
sessionId = att.sessionId;
await send('Runtime.enable');
await send('DOM.enable');
await send('Page.navigate', { url: pathToFileURL(HTML).href + '?v=' + Date.now() });
await Bun.sleep(1200);

const doc = await send('DOM.getDocument');
const q = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#file' });
await send('DOM.setFileInputFiles', { files: [ADB], nodeId: q.nodeId });
await send('Runtime.evaluate', { expression: 'document.querySelector("#file").dispatchEvent(new Event("change"))' });
await Bun.sleep(2500);
await send('Runtime.evaluate', { expression: `document.querySelector('#aboutClose')?.click()` });

async function ev<T>(expression: string): Promise<T> {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 200));
  return r.result.value as T;
}

{
  const d = await ev<any>(`
  (async () => { const s=(ms)=>new Promise(r=>setTimeout(r,ms));
    await window.__accelon26.openPage('fuyan','5p34',''); await s(700);
    await window.__accelon26.showLine(14622); await s(600);
    const b=document.querySelector('#docText .docBody');
    return { head:(b?b.innerText:'').slice(0,90), lines:document.querySelectorAll('#docText .docLine').length,
             svg:document.querySelectorAll('#docText svg').length,
             miss:document.querySelectorAll('#docText .inlineImgMissing').length,
             imgs:document.querySelectorAll('#docText img').length };
  })()`);
  console.log('DEBUG 5p34:', JSON.stringify(d));
}
for (const c of CASES) {
  const got = await ev<Record<string, number>>(`
  (async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await window.__accelon26.openPage('fuyan', ${JSON.stringify(c.page)}, '');
    await sleep(600);
    const out = {};
    for (const el of document.querySelectorAll('#docText svg.inlineSvg')) {
      const k = (el.getAttribute('aria-label') || el.getAttribute('title') || '(no-label)').toUpperCase();
      out[k] = (out[k] || 0) + 1;
    }
    for (const el of document.querySelectorAll('#docText img.inlineImg')) {
      const k = (el.getAttribute('alt') || el.getAttribute('src') || '(img)').toUpperCase();
      out['img:' + k] = (out['img:' + k] || 0) + 1;
    }
    for (const el of document.querySelectorAll('#docText .inlineImgMissing')) {
      const k = (el.getAttribute('title') || '(missing)').toUpperCase();
      out['MISSING:' + k] = (out['MISSING:' + k] || 0) + 1;
    }
    return out;
  })()`);
  const norm: Record<string, number> = {};
  for (const [k, v] of Object.entries(got)) norm[k.replace(/\.SVG$/i, '').toUpperCase()] = (norm[k.replace(/\.SVG$/i, '').toUpperCase()] || 0) + v;
  const ok = Object.entries(c.want).every(([k, v]) => (norm[k] || 0) >= v);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${c.page.padEnd(7)} ${JSON.stringify(got)}  ${c.note}`);
}
if (errors.length) console.log('JS 例外', errors.length, errors[0]?.split('\n')[0]);
proc.kill();
process.exit(0);
