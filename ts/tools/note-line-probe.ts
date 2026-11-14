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
const ADB = resolve(opt('adb', 'D:/2026/fuyan/out/fuyan.adb'));



const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const browser = BROWSERS.find((p) => existsSync(p));
if (!browser) { console.error('no Chromium browser'); process.exit(2); }
for (const p of [HTML, ADB]) if (!existsSync(p)) { console.error('missing ' + p); process.exit(2); }

const profile = resolve(ROOT, 'build/.chrome-profile-nlp' + process.pid);
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

await ev(`(async () => { await window.__accelon26.openPage('fuyan','5p298',''); await new Promise(r=>setTimeout(r,700)); await window.__accelon26.showLine(28869); await new Promise(r=>setTimeout(r,600)); })()`);

const res = await ev<any>(`
(() => {
  const lines = [...document.querySelectorAll('#docText .docLine')];
  const idx = lines.findIndex(l => (l.textContent||'').includes('若從取至取'));
  const out = { total: lines.length, idx };
  out.rows = lines.slice(Math.max(0, idx - 1), idx + 7).map(l => {
    const cs = getComputedStyle(l);
    const nb = l.querySelector('.noteBody');
    const r = l.getBoundingClientRect();
    return { cls: l.className, w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top),
             ws: cs.whiteSpace, hasNote: !!nb,
             txt: (l.textContent||'').replace(/\s+/g,' ').slice(0, 48) };
  });
  const nb = document.querySelector('#docText .noteBody');
  out.note = nb ? { w: Math.round(nb.getBoundingClientRect().width), h: Math.round(nb.getBoundingClientRect().height), ws: getComputedStyle(nb).whiteSpace, len: (nb.textContent||'').length } : null;
  return out;
})()`);
console.log(JSON.stringify(res, null, 1));
await ev(`(() => { const l = document.querySelector('#docText .hitLine'); if (l) l.scrollIntoView({block:'center'}); })()`);
await Bun.sleep(400);
const shot = await send('Page.captureScreenshot', { format: 'png' });
await Bun.write('D:/2026/adb-converter/build/note-5p298.png', Buffer.from(shot.data, 'base64'));
console.log('shot saved');
if (errors.length) console.log('JS 例外', errors.length, errors[0]?.split('\n')[0]);
proc.kill();
process.exit(0);
