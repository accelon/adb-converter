#!/usr/bin/env bun
/** 暫用：fuyan 目錄節點點擊除錯。 */
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
const profile = resolve(ROOT, 'build/.chrome-profile-ft-' + process.pid);
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
await Bun.sleep(3500);
const out = await cdp.eval<string>(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const api = window.__accelon26;
  await api.closeAbout?.();
  const rows = [...document.querySelectorAll('#dirTree .tRow')];
  if (!rows.length) return JSON.stringify({ error: 'no tree rows' });
  const snap = () => {
    const body = document.querySelector('#docText .docBody');
    const hit = document.querySelector('#docText .hitLine');
    return {
      docLen: (document.getElementById('docText')?.textContent ?? '').length,
      tab: document.querySelector('#docTabs .docTab.active .docTabName')?.textContent ?? '',
      scrollTop: body ? Math.round(body.scrollTop) : -1,
      hitId: hit?.id ?? '',
      pageInfo: document.getElementById('pageInfo')?.textContent ?? '',
      treeN: document.querySelectorAll('#dirTree .tRow').length,
      chip: document.querySelector('#dbTabs .dbChip')?.textContent?.trim() ?? '',
      trail: [...document.querySelectorAll('#docTrail .trail')].map((x) => x.textContent).join(' › '),
      tabs: [...document.querySelectorAll('#docTabs .docTabName')].map((x) => x.textContent).join(' | '),
    };
  };
  const q = ${JSON.stringify(opt('q', ''))};
  if (q) {
    const input = document.getElementById('query');
    input.value = q;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    for (let i = 0; i < 100; i++) { await sleep(50); if (document.querySelector('#searchList .snippet')) break; }
    await sleep(500);
  }
  const results = [];
  const clickRow = async (label) => {
    const rows2 = [...document.querySelectorAll('#dirTree .tRow')];
    const r = rows2.find((x) => (x.querySelector('.tName')?.textContent ?? '').includes(label));
    if (!r) { results.push({ label, err: 'not found', n: rows2.length, names: rows2.map((x) => x.querySelector('.tName')?.textContent).slice(0, 12) }); return; }
    (r.querySelector('.tName') ?? r).click();
    await sleep(2200);
    results.push({ label, ...snap() });
  };
  results.push({ label: '(initial)', ...snap() });
  const root = [...document.querySelectorAll('#dirTree .tRow')].find((r) => (r.querySelector('.tName')?.textContent ?? '').includes('空之探究講義'));
  (root?.querySelector('.tName') ?? root)?.dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true }));
  await sleep(1800);
  results.push({ label: '(alt 展開全書)', ...snap() });
  await clickRow('第一節');
  await clickRow('二、初期聖典');
  const beforeTw = snap();
  const tw = [...document.querySelectorAll('#dirTree .tRow .tTwisty')][0];
  tw?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await sleep(900);
  results.push({ label: '(點箭頭收合)', before: beforeTw.docLen, ...snap() });
  return JSON.stringify({ results, rows: document.querySelectorAll('#dirTree .tRow').length }, null, 1);
})()`);
console.log(out);
if (cdp.logs.length) console.log('--- console ---\n' + cdp.logs.slice(-12).join('\n'));
proc.kill();
await Bun.sleep(200);
try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
