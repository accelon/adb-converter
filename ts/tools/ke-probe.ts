#!/usr/bin/env bun
/**
 * 暫用探針：看一頁 page head 的科判（`<目>`）在瀏覽器裡長什麼樣。
 *
 *   bun run tools/ke-probe.ts [--page 38p35] [--line 739] [--png build/ke.png]
 *
 * 印出該行的 outerHTML 與 computed style（font-family / background / border），
 * 並截一張「頁首」的圖，方便和紙本比。
 */
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => {
  const i = args.indexOf('--' + n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const ROOT = resolve(import.meta.dir, '../..');
const HTML = resolve(opt('html', 'D:/accelon3/accelon26.html'));
const ADB = resolve(opt('adb', resolve(ROOT, 'accelon3/fuyan.adb')));
const PNG = resolve(opt('png', resolve(ROOT, 'build/ke-probe.png')));
const PAGE = opt('page', '38p35');
const LINE = Number(opt('line', '739'));

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const browser = BROWSERS.find((p) => existsSync(p));
if (!browser) { console.error('no Chromium browser found'); process.exit(2); }
for (const p of [HTML, ADB]) if (!existsSync(p)) { console.error('missing ' + p); process.exit(2); }

const profile = resolve(ROOT, 'build/.chrome-profile-keprobe-' + process.pid);
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
  throw new Error('DevToolsActivePort never appeared');
}

class Cdp {
  ws!: WebSocket;
  id = 0;
  pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  sessionId = '';
  static async attach(url: string): Promise<Cdp> {
    const c = new Cdp();
    await new Promise<void>((res, rej) => {
      c.ws = new WebSocket(url);
      c.ws.onopen = () => res();
      c.ws.onerror = () => rej(new Error('ws error'));
      c.ws.onmessage = (ev) => {
        const m = JSON.parse(String(ev.data));
        if (m.id && c.pending.has(m.id)) {
          const p = c.pending.get(m.id)!;
          c.pending.delete(m.id);
          m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
        }
      };
    });
    return c;
  }
  async send(method: string, params: Record<string, unknown> = {}, session = true): Promise<any> {
    const id = ++this.id;
    const payload: Record<string, unknown> = { id, method, params };
    if (session && this.sessionId) payload.sessionId = this.sessionId;
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => { if (this.pending.delete(id)) rej(new Error('timeout ' + method)); }, 60000);
    });
  }
  async openPage(url: string) {
    const { targetId } = await this.send('Target.createTarget', { url }, false);
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true }, false);
    this.sessionId = sessionId;
    await this.send('Runtime.enable');
    await this.send('Page.enable');
    await this.send('DOM.enable');
  }
  async eval<T>(expression: string): Promise<T> {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
    return r.result.value as T;
  }
}

try {
  const cdp = await Cdp.attach(await devtoolsUrl());
  await cdp.openPage(pathToFileURL(HTML).href + '?v=' + Date.now());
  await Bun.sleep(800);
  const doc = await cdp.send('DOM.getDocument');
  const q = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#file' });
  await cdp.send('DOM.setFileInputFiles', { files: [ADB], nodeId: q.nodeId });
  await cdp.eval('document.querySelector("#file").dispatchEvent(new Event("change"))');
  await Bun.sleep(2500);

  const report = await cdp.eval<string>(`
    (async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      document.querySelector('#aboutClose')?.click();
      await window.__accelon26.openPage('fuyan', ${JSON.stringify(PAGE)});
      await sleep(900);
      const out = { page: ${JSON.stringify(PAGE)}, line: ${LINE} };
      const row = document.getElementById('L' + ${LINE});
      out.firstRows = [...document.querySelectorAll('#docText .docLine')].slice(0, 6)
        .map((e) => e.id + ' | ' + (e.textContent || '').replace(/\\s+/g, ' ').slice(0, 28));
      out.rowCount = document.querySelectorAll('#docText .docLine').length;
      if (!row) { await window.__accelon26.showLine(${LINE}); await sleep(900); }
      const row2 = document.getElementById('L' + ${LINE});
      row2?.scrollIntoView({ block: 'start' });
      await sleep(400);
      out.found = !!row2;
      out.html = row2 ? row2.outerHTML.slice(0, 1200) : '';
      out.text = row2 ? (row2.textContent || '').replace(/\\s+/g, ' ').slice(0, 80) : '';
      const h = row2?.querySelector('.h');
      if (h) {
        const cs = getComputedStyle(h);
        out.h = {
          tag: h.dataset.tag, up: h.dataset.up, depth: h.dataset.depth,
          fontFamily: cs.fontFamily, fontWeight: cs.fontWeight, fontSize: cs.fontSize,
          color: cs.color, background: cs.backgroundColor,
          border: cs.border, borderTop: cs.borderTopWidth + ' ' + cs.borderTopStyle + ' ' + cs.borderTopColor,
        };
      }
      const r = row2?.getBoundingClientRect();
      out.rect = r ? { top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) } : null;
      out.bodyBg = getComputedStyle(document.body).backgroundColor;
      out.theme = document.documentElement.dataset.theme || '(default)';
      return JSON.stringify(out, null, 1);
    })()
  `);
  console.log(report);

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  await Bun.write(PNG, Buffer.from(shot.data, 'base64'));
  console.log('screenshot ' + PNG);
} finally {
  try { proc.kill(); } catch { /* ignore */ }
  await Bun.sleep(300);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
}
