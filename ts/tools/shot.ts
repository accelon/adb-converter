/**
 * Screenshot harness: open build/accelon26.html from file://, hand it an .adb,
 * drive the new document pane (node link + Ctrl tab + paging) and save a PNG.
 *
 *   bun run tools/shot.ts [--adb path] [--out build/shot.png] [--w 1600] [--h 1000]
 */
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const HTML = resolve(opt('html', resolve(import.meta.dir, '../../build/accelon26.html')));
const ADB = resolve(opt('adb', resolve(import.meta.dir, '../../13j.adb')));
const OUT = resolve(opt('out', resolve(import.meta.dir, '../../build/shot.png')));
const W = Number(opt('w', '1600'));
const H = Number(opt('h', '1000'));

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const browser = BROWSERS.find((p) => existsSync(p));
if (!browser) { console.error('no Chromium browser found'); process.exit(2); }

const profile = resolve(import.meta.dir, '../../build/.chrome-profile-shot');
const proc = Bun.spawn([browser, '--headless=new', '--disable-gpu', '--no-first-run',
  '--remote-debugging-port=0', '--remote-allow-origins=*', '--allow-file-access-from-files',
  `--window-size=${W},${H}`, `--user-data-dir=${profile}`, 'about:blank'],
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
        if (m.id && c.pending.has(m.id)) { const p = c.pending.get(m.id)!; c.pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
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

const cdp = await Cdp.attach(await devtoolsUrl());
await cdp.openPage(pathToFileURL(HTML).href + '?v=' + Date.now());
await Bun.sleep(700);
const doc = await cdp.send('DOM.getDocument');
const q = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#file' });
await cdp.send('DOM.setFileInputFiles', { files: [ADB], nodeId: q.nodeId });
await cdp.eval('document.querySelector("#file").dispatchEvent(new Event("change"))');
await Bun.sleep(2500);

// 1. search, then click a node's 命中數 (summary scope), 2. link a book, 3. Ctrl a second one
const state = await cdp.eval<string>(`
  (async () => {
    const wait = (fn, n = 60) => new Promise(async (res) => { for (let i = 0; i < n; i++) { if (fn()) return res(true); await new Promise((r) => setTimeout(r, 200)); } res(false); });
    const q = document.querySelector('#query');
    q.value = window.__accelon26.state().db === '13j' ? '象曰' : '大乘';
    q.dispatchEvent(new Event('input'));
    await wait(() => document.querySelector('#dirTree .tCount.hit'));
    const books = [...document.querySelectorAll('#dirTree .tRow')].filter((r) => r.querySelector('.tTag')?.textContent === '書');
    books[0].querySelector('.tDot').click();
    await wait(() => window.__accelon26.state().docTabs.length >= 1 && document.querySelector('#docText .docLine'));
    books[1].querySelector('.tDot').dispatchEvent(new MouseEvent('click', { ctrlKey: true, bubbles: true }));
    await wait(() => window.__accelon26.state().docTabs.length >= 2);
    const st = window.__accelon26.state();
    return JSON.stringify({ db: st.db, tabs: st.docTabs.map((t) => t.name), page: st.docPage, pages: st.docTabPages, pagerHidden: st.pagerHidden });
  })()
`);
console.log('state', state);
const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
await Bun.write(OUT, Buffer.from(shot.data, 'base64'));
console.log('wrote', OUT);
proc.kill();
process.exit(0);
