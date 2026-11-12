#!/usr/bin/env bun
/**
 * 通用頁面探針：載入任一 adb，跳一頁，印出這一頁的版面塊結構並截圖。
 *
 *   bun run tools/page-probe.ts [--adb D:/accelon3/ys.adb] [--db ys] [--page 8p5a] [--png build/p.png]
 *
 * 用途：查「資料有、畫面沒有」那一類——例如標題該獨立成行卻黏在上一段末尾。
 * 印出的每一塊附 class（docParaHeading 就是被當成標題塊）、標籤與前 40 字。
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
const ADB = resolve(opt('adb', resolve(ROOT, 'accelon3/ys.adb')));
const DB = opt('db', 'ys');
const PAGE = opt('page', '8p5a');
const PNG = resolve(opt('png', resolve(ROOT, 'build/page-probe.png')));
/** 連排模式（不保留硬換行）＝讀者常見的版面；`--reflow 1` 開 */
const REFLOW = opt('reflow', '0') === '1';

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const browser = BROWSERS.find((p) => existsSync(p));
if (!browser) { console.error('no Chromium browser found'); process.exit(2); }
for (const p of [HTML, ADB]) if (!existsSync(p)) { console.error('missing ' + p); process.exit(2); }

const profile = resolve(ROOT, 'build/.chrome-profile-pageprobe-' + process.pid);
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
  await Bun.sleep(3000);

  const report = await cdp.eval<string>(`
    (async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      document.querySelector('#aboutClose')?.click();
      const out = { db: ${JSON.stringify(DB)}, page: ${JSON.stringify(PAGE)}, reflow: ${REFLOW} };
      if (${REFLOW}) { window.__accelon26.setHardBreaks(false); await sleep(300); }
      await window.__accelon26.openPage(${JSON.stringify(DB)}, out.page);
      await sleep(1200);
      const body = document.querySelector('#docText .docBody');
      out.head = (body?.innerText ?? '').replace(/\\s+/g, ' ').slice(0, 160);
      const blocks = [...document.querySelectorAll('#docText .docBody > *')].slice(0, 40);
      out.blocks = blocks.map((el) => ({
        tag: el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).replace(/\\s+/g, '.') : ''),
        text: (el.textContent || '').replace(/\\s+/g, ' ').slice(0, 46),
        hasSvg: !!el.querySelector('svg'),
        hasHeading: !!el.querySelector('.h'),
      }));
      out.blockCount = document.querySelectorAll('#docText .docBody > *').length;
      out.figures = [...document.querySelectorAll('#docText .docBody svg.inlineSvg, #docText .docBody img')]
        .map((e) => ({ tag: e.tagName.toLowerCase(), cls: String(e.className || ''), rectW: Math.round(e.getBoundingClientRect().width) }));
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
