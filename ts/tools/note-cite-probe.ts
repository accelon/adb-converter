#!/usr/bin/env bun
/** 診斷：fuyan <釋> 內選取文字 → 引用複製（2026-11-01）。 */
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dir, '../..');
const HTML = resolve(process.argv[2] || 'D:/accelon3/accelon26.html');
const ADB = process.argv[3] || 'D:/accelon3/fuyan.adb';
const PAGE = process.argv[4] || 'fuyan?05B-p001';
const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const browser = BROWSERS.find((p) => existsSync(p))!;
const profile = resolve(ROOT, 'build/.chrome-profile-note-' + process.pid);
const proc = Bun.spawn([browser, '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
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
await Bun.sleep(4500);
const out = JSON.parse(await cdp.eval<string>(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await window.__accelon26?.closeAbout?.();
  await window.__accelon26?.xrefJump?.(${JSON.stringify(PAGE)}).catch(() => {});
  for (let i = 0; i < 100; i++) { await sleep(100); if (document.querySelector('#docText .noteBody')) break; }
  await sleep(400);
  const body = document.querySelector('#docText .noteBody');
  if (!body) return JSON.stringify({ error: 'no noteBody' });
  const t = [...body.childNodes].find((n) => n.nodeType === 3 && (n.textContent ?? '').trim().length > 0);
  if (!t) return JSON.stringify({ error: 'no text node in noteBody' });
  const r = document.createRange();
  const len = Math.min(6, (t.textContent ?? '').length);
  r.setStart(t, 0); r.setEnd(t, len);
  const sel = window.getSelection();
  sel.removeAllRanges(); sel.addRange(r);
  const direct0 = await window.__accelon26?.citationForSelection?.();
  const sel0 = window.getSelection()?.toString() ?? '';
  body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
  await sleep(500);
  const menu = document.getElementById('selMenu');
  const vis = (s) => { const b = menu?.querySelector('[data-sel="' + s + '"]'); if (!b) return null; const g = b.closest('.selGroup'); return !b.hidden && (!g || !g.hidden); };
  const cite = menu?.querySelector('[data-sel="cite"]');
  const selText = window.getSelection()?.toString() ?? '';
  const direct = await window.__accelon26?.citationForSelection?.().then((x) => x).catch((e) => 'ERR ' + e);
  const citeNow = await window.__accelon26?.citationForSelection?.().catch?.((e) => 'ERR ' + e) ?? null;
  const state = { menuHidden: menu?.hidden, cite: vis('cite'), copy: vis('copy'), text: len, selText, direct0, sel0, direct, citeNow };
  let copied = null;
  if (cite && !cite.hidden) { cite.click(); await sleep(400); copied = (window).__lastCopy ?? null; }
  return JSON.stringify({ state, copied }, null, 1);
})()`));
console.log(out);
if (cdp.logs.length) console.log('--- console ---\n' + cdp.logs.slice(-10).join('\n'));
proc.kill();
await Bun.sleep(200);
try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
