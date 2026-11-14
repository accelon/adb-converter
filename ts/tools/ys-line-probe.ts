#!/usr/bin/env bun
/**
 * kai-probe.ts — 驗「注文裡的引文是不是真的顯示成楷體」（厚觀法師 2026-11-14 第一項）
 *
 *   bun run ts/tools/kai-probe.ts --adb D:/2026/fuyan/out/fuyan.adb
 *
 * 只看畫面層：打開 5p298，跳到注 9 那一行，量「能取」所在 span 的 computed
 * font-family 有沒有楷體，同時數整頁的 .fmt-kai / .quote。
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
const ADB = resolve(opt('adb', 'D:/accelon3/ys.adb'));

const CASES: any[] = [];

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

const dbg = await ev<any>(`
(async () => { const s=(ms)=>new Promise(r=>setTimeout(r,ms));
  await window.__accelon26.openPage('ys','1pa1a',''); await s(900);
  const hs=[...document.querySelectorAll('#docText .h')].slice(0,6).map(h=>{
    const cs=getComputedStyle(h);
    return { tag:h.tagName, cls:h.className, depth:h.getAttribute('data-depth'), txt:(h.innerText||'').slice(0,14),
             fs:cs.fontSize, fw:cs.fontWeight, col:cs.color };
  });
  const ph=[...document.querySelectorAll('#docText .docParaHeading')].slice(0,3).map(e=>e.innerText.slice(0,20));
  return { hCount:document.querySelectorAll('#docText .h').length,
           paraHeading:document.querySelectorAll('#docText .docParaHeading').length,
           hs, ph };
})()`);
console.log(JSON.stringify(dbg,null,1));
if (errors.length) console.log('JS 例外', errors.length, errors[0]?.split('\n')[0]);
proc.kill();
process.exit(0);
