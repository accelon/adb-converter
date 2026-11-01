#!/usr/bin/env bun
/** 暫用：量 docTop 的留白（fuyan.adb 的標題／路徑）。 */
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const ROOT = resolve(import.meta.dir, '../..');
const HTML = resolve(opt('html', resolve(ROOT, 'build/accelon26.html')));
const ADB = resolve(opt('adb', 'D:/accelon3/fuyan.adb'));
const QUERY = opt('q', '空之探究');
const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const browser = BROWSERS.find((p) => existsSync(p))!;
const profile = resolve(ROOT, 'build/.chrome-profile-dh-' + process.pid);
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
  static async attach(url: string): Promise<Cdp> {
    const c = new Cdp();
    await new Promise<void>((res, rej) => {
      c.ws = new WebSocket(url);
      c.ws.onopen = () => res();
      c.ws.onerror = () => rej(new Error('ws error'));
      c.ws.onmessage = (ev) => {
        const m = JSON.parse(String(ev.data));
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
await Bun.sleep(3000);
const out = await cdp.eval<string>(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const api = window.__accelon26;
  await api.closeAbout?.();
  const input = document.getElementById('query');
  input.focus();
  input.value = ${JSON.stringify(QUERY)};
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
  for (let i = 0; i < 200; i++) { await sleep(50); if (document.querySelector('#searchList .snippet[data-va]')) break; }
  const hits = [...document.querySelectorAll('#searchList .snippet[data-va]')];
  for (const h of hits.slice(0, 8)) {
    h.click();
    for (let i = 0; i < 40; i++) { await sleep(50); if (document.querySelector('#docText .docHead')) break; }
    if (document.querySelector('#docText .docHead')) break;
  }
  await sleep(600);
  const bodyEl = document.querySelector('#docText .docBody');
  if (bodyEl) bodyEl.scrollTop = 0;
  await sleep(300);
  const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width), h: Math.round(r.height) }; };
  const top = document.querySelector('#docText .docTop');
  const head = document.querySelector('#docText .docHead');
  const trail = document.querySelector('#docTrail');
  const cs = (el) => { if (!el) return null; const s = getComputedStyle(el); return { display: s.display, flex: s.flex, justifyContent: s.justifyContent, marginLeft: s.marginLeft, maxWidth: s.maxWidth, fontSize: s.fontSize, whiteSpace: s.whiteSpace, overflow: s.overflow, textOverflow: s.textOverflow }; };
  const kids = top ? [...top.children].map((c) => ({ tag: c.tagName, cls: c.className, text: (c.textContent ?? '').slice(0, 40), rect: rect(c) })) : [];
  return JSON.stringify({ db: api.state?.().db, docLen: (document.getElementById('docText')?.textContent ?? '').length, docHeadHtml: (document.getElementById('docText')?.innerHTML ?? '').slice(0, 300), pane: rect(document.querySelector('#colMid') ?? document.querySelector('#docText')), top: rect(top), head: { rect: rect(head), style: cs(head), text: head?.textContent?.slice(0, 80) }, trail: { rect: rect(trail), style: cs(trail), text: trail?.textContent?.slice(0, 80) }, kids, topStyle: cs(top) }, null, 1);
})()`);
console.log(out);
const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }).catch(() => null);
if (shot?.data) { const { writeFileSync } = await import('node:fs'); writeFileSync(resolve(ROOT, 'build/doc-head.png'), Buffer.from(shot.data, 'base64')); }
proc.kill();
await Bun.sleep(200);
try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
