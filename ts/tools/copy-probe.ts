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

const profile = resolve(ROOT, 'build/.chrome-profile-cp' + process.pid);
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

await ev(`(async () => { await window.__accelon26.openPage('fuyan','5p298',''); await new Promise(r=>setTimeout(r,700)); await window.__accelon26.showLine(31640); await new Promise(r=>setTimeout(r,600)); })()`);

// 選一整條注（從「（1）《中論》卷3」到「長行例知。」）
const sel = await ev<any>(`
(() => {
  const lines = [...document.querySelectorAll('#docText .docLine')];
  const i0 = lines.findIndex(l => (l.textContent||'').includes('（1）《中論》卷3'));
  const i1 = lines.findIndex(l => (l.textContent||'').includes('長行例知'));
  if (i0 < 0 || i1 < 0) return { err: 'line not found', i0, i1 };
  const startLine = lines[i0];
  const a = document.createTreeWalker(startLine, NodeFilter.SHOW_TEXT).nextNode();
  const endWalker = document.createTreeWalker(lines[i1], NodeFilter.SHOW_TEXT);
  let last = null, n; while ((n = endWalker.nextNode())) last = n;
  const r = document.createRange();
  r.setStart(a, 0); r.setEnd(last, (last.nodeValue||'').length);
  const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
  return { i0, i1, n: i1 - i0 + 2, text: (s.toString()||'').replace(/\s+/g,' ').slice(0, 80) };
})()`);
console.log('選取', JSON.stringify(sel));

const dbg = await ev<any>(`(async () => { try { return await window.__accelon26.citationDebug(); } catch (e) { return { error: String(e) }; } })()`);
if (dbg && dbg.text) {
  const t = String(dbg.text);
  console.log('lines', JSON.stringify(dbg.lines));
  console.log('--- 引用全文 ---');
  console.log(t);
  const checks = {
    '其誰當往來？同一行': /其誰當往來？/.test(t),
    'bhavet 完整': /bhavet/.test(t),
    '沒有「往來\n？」': !/往來\s*\n\s*？/.test(t),
    '沒有 bhav\net': !/bhav\s*\n\s*et/.test(t),
    '（1）（2）之間仍分行': /。\s*\n\s*（2）/.test(t),
  };
  console.log('--- 檢查 ---');
  for (const [k, v] of Object.entries(checks)) console.log((v ? 'ok   ' : 'FAIL ') + k);
} else {
  console.log('citationDebug', JSON.stringify(dbg).slice(0, 300));
}
if (errors.length) console.log('JS 例外', errors.length, errors[0]?.split('\n')[0]);
proc.kill();
process.exit(0);
