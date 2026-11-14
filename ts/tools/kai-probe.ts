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

const CASES = [
  { page: '5p298', line: 31300, must: '能取', note: '注9（3）高麗藏引文' },
  { page: '5p298', line: 31300, must: '四本頌云', note: '注9（5）藏要引文' },
  { page: '5p298', line: 31300, must: '般若', note: '注9（2）書名（不該是楷體）' },
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

await ev(`(async () => { await window.__accelon26.openPage('fuyan','5p298',''); await new Promise(r=>setTimeout(r,600)); await window.__accelon26.showLine(31300); await new Promise(r=>setTimeout(r,500)); })()`);

const res = await ev<Array<{ must: string; cls: string; font: string; kai: boolean }>>(`
(() => {
  const out = [];
  const cases = ${JSON.stringify(CASES.map((c) => c.must))};
  const walker = document.createTreeWalker(document.querySelector('#docText'), NodeFilter.SHOW_TEXT);
  for (const want of cases) {
    let node;
    while ((node = walker.nextNode())) {
      if (node.nodeValue && node.nodeValue.indexOf(want) >= 0) break;
    }
    if (!node) { out.push({ must: want, cls: '(找不到)', font: '', kai: false }); continue; }
    const el = node.parentElement;
    const cs = getComputedStyle(el);
    out.push({ must: want, cls: el.className || el.tagName, font: cs.fontFamily, kai: /楷/.test(cs.fontFamily) });
  }
  return out;
})()`);

console.log('5p298 注9');
for (const r of res) console.log(`  ${r.kai ? 'KAI ' : '    '}${r.must.padEnd(6)} class=${r.cls.padEnd(28)} font=${r.font.split(',')[0]}`);
const page = await ev<{ kai: number; quote: number }>(`({ kai: document.querySelectorAll('#docText .fmt-kai').length, quote: document.querySelectorAll('#docText .quote').length })`);
console.log(`  本頁 .fmt-kai=${page.kai}　.quote=${page.quote}`);
if (errors.length) console.log('JS 例外', errors.length, errors[0]?.split('\n')[0]);
proc.kill();
process.exit(0);
