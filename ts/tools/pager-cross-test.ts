#!/usr/bin/env bun
/**
 * 上下頁可以跨節點、跨書，從頭翻到尾（2026-10-31）。
 *
 *   cd ts && bun run tools/pager-cross-test.ts [--adb D:/accelon3/fuyan.adb]
 */
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const ROOT = resolve(import.meta.dir, '../..');
const HTML = resolve(opt('html', resolve(ROOT, 'build/accelon26.html')));
const ADB = resolve(opt('adb', 'D:/accelon3/fuyan.adb'));
const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const browser = BROWSERS.find((p) => existsSync(p))!;
const profile = resolve(ROOT, 'build/.chrome-profile-pg-' + process.pid);
const proc = Bun.spawn([browser, '--headless=new', '--disable-gpu', '--no-first-run',
  '--remote-debugging-port=0', '--remote-allow-origins=*', '--allow-file-access-from-files',
  '--window-size=1500,1100', `--user-data-dir=${profile}`, 'about:blank'],
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
const cdp = await Cdp.attach(await devtoolsUrl());
await cdp.openPage(pathToFileURL(HTML).href + '?v=' + Date.now());
await Bun.sleep(900);
const doc = await cdp.send('DOM.getDocument');
const q = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#file' });
await cdp.send('DOM.setFileInputFiles', { files: [ADB], nodeId: q.nodeId });
await cdp.eval('document.querySelector("#file").dispatchEvent(new Event("change"))');
await Bun.sleep(4000);
const out = JSON.parse(await cdp.eval<string>(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await window.__accelon26?.closeAbout?.();
  for (let i = 0; i < 100; i++) { if (document.querySelector('#dirTree .tRow')) break; await sleep(100); }
  document.querySelector('#dirTree .tRow .tName')?.click();
  await sleep(2000);
  const seen = [];
  let stuck = 0;
  const snap = () => (document.getElementById('pageInfo')?.textContent ?? '') + ' ｜ ' + (document.querySelector('#docTabs .docTabName')?.textContent ?? '');
  let last = '';
  for (let i = 0; i < 80; i++) {
    const next = document.getElementById('pageNext');
    if (!next || next.getAttribute('aria-disabled') === 'true') break;
    next.click();
    await sleep(500);
    const cur = snap();
    if (cur === last) { stuck++; if (stuck >= 3) break; } else { stuck = 0; seen.push(cur); last = cur; }
  }
  return JSON.stringify({ steps: seen.length, first: seen[0] ?? '', last: seen[seen.length - 1] ?? '', titles: [...new Set(seen.map((s) => s.split('｜')[1]?.trim()))].slice(0, 8), disabled: document.getElementById('pageNext')?.getAttribute('aria-disabled') });
})()`));
console.log(JSON.stringify(out, null, 1));
if (cdp.logs.length) console.log('--- console ---\n' + cdp.logs.slice(-8).join('\n'));
proc.kill();
await Bun.sleep(200);
try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
const fails: string[] = [];
if (!(out.steps > 3)) fails.push('翻不到幾頁：' + out.steps);
if (!(out.titles.length >= 2)) fails.push('沒有跨到別的節點／書：' + JSON.stringify(out.titles));
if (out.disabled === 'true' && out.steps < 5) fails.push('很早就 disabled');
if (cdp.logs.some((l) => l.startsWith('[exception]'))) fails.push('console 有 exception');
if (fails.length) { console.error('FAIL:\n- ' + fails.join('\n- ')); process.exit(1); }
console.log('ok: 上下頁可以跨節點／跨書');
