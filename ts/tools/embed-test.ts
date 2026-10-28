#!/usr/bin/env bun
/**
 * `<嵌>` 的端對端測試：開 adb → 找經文頁 → 點第一個晶片 → 確認引文插入、再按「收合」。
 *
 *   bun run tools/embed-test.ts --adb ../build/jingang.adb
 *   bun run tools/embed-test.ts --adb ../build/jingang.adb --book 金剛般若波羅蜜經
 *
 * 需要 build/accelon26.html（bun run tools/build-viewer.ts）。
 */
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const ROOT = resolve(import.meta.dir, '../..');
const HTML = resolve(ROOT, 'build/accelon26.html');
const ADB = resolve(opt('adb', resolve(ROOT, 'build/jingang.adb')));
const OUT = resolve(opt('out', resolve(ROOT, 'build/jingqun/embed-test.png')));
const BOOK = opt('book', '金剛般若波羅蜜經');
const WAIT = Number(opt('wait', '2500'));

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const browser = BROWSERS.find((p) => existsSync(p));
if (!browser) { console.error('no Chromium browser'); process.exit(2); }
if (!existsSync(ADB)) { console.error('missing ' + ADB); process.exit(2); }
const profile = resolve(ROOT, 'build/.chrome-profile-embed-' + process.pid);
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
  throw new Error('DevToolsActivePort not found');
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
    await this.send('Page.enable');
    await this.send('Runtime.enable');
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
await Bun.sleep(800);
const doc = await cdp.send('DOM.getDocument');
const q = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#file' });
await cdp.send('DOM.setFileInputFiles', { files: [ADB], nodeId: q.nodeId });
await cdp.eval('document.querySelector("#file").dispatchEvent(new Event("change"))');
await Bun.sleep(WAIT);

const result = await cdp.eval<string>(`
  (async () => {
    const wait = async (fn, n = 100) => { for (let i = 0; i < n; i++) { if (fn()) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    document.querySelector('#aboutClose')?.click();
    const out = {};
    const rows = () => [...document.querySelectorAll('#dirTree .tRow')];
    const bookName = ${JSON.stringify(BOOK)};
    let bookRow = rows().find((r) => r.querySelector('.tName')?.textContent?.trim() === bookName && r.querySelector('.tDot'));
    if (!bookRow) {
      const vol = rows().find((r) => r.textContent.includes('般若部四'));
      vol?.querySelector('.tTwisty')?.click();
      await sleep(500);
      bookRow = rows().find((r) => r.querySelector('.tName')?.textContent?.trim() === bookName && r.querySelector('.tDot'));
    }
    if (bookRow) bookRow.querySelector('.tDot')?.click();
    else (rows()[0]?.querySelector('.tDot') ?? rows()[0])?.click();
    await wait(() => document.querySelectorAll('#docText .docLine').length > 0, 100);
    await sleep(1200);

    const chips = () => [...document.querySelectorAll('#docText .embedChip')];
    out.chips = chips().length;
    out.labels = chips().slice(0, 8).map((b) => b.textContent);
    if (!chips().length) return JSON.stringify(out, null, 1);
    chips()[0].click();
    out.opened = await wait(() => !!document.querySelector('#docText .embedBlock .embedDoc'), 100);
    const block = document.querySelector('#docText .embedBlock');
    out.head = (block?.querySelector('.embedHead')?.innerText ?? '').replace(/\\n/g, ' ').trim();
    out.text = (block?.querySelector('.embedText')?.innerText ?? '').slice(0, 120).replace(/\\n/g, ' | ');
    out.textLen = block?.querySelector('.embedText')?.innerText?.length ?? 0;
    out.mark = !!block?.querySelector('mark');
    out.errors = window.__accelon26?.consoleErrors?.() ?? null;
    return JSON.stringify(out, null, 1);
  })()
`);
console.log(result);
const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
await Bun.write(OUT, Buffer.from(shot.data, 'base64'));
const closed = await cdp.eval<string>(`(async () => {
  const b = document.querySelector('#docText .embedBlock .embedClose');
  if (!b) return 'no close button';
  b.click();
  for (let i = 0; i < 30; i++) { if (!document.querySelector('#docText .embedBlock')) return 'ok'; await new Promise((r) => setTimeout(r, 100)); }
  return 'still open';
})()`);
console.log('close:', closed);
proc.kill();
await Bun.sleep(200);
try { rmSync(profile, { recursive: true, force: true }); } catch { /* browser may still hold it */ }

const r = JSON.parse(result);
const fails: string[] = [];
if (!r.chips) fails.push('no <嵌> chips on the page');
if (!r.opened) fails.push('clicking a chip did not insert .embedDoc');
if (!r.textLen) fails.push('embedded text is empty');
if (r.errors) fails.push('console errors: ' + JSON.stringify(r.errors));
if (fails.length) { console.error(fails.join('; ')); process.exit(1); }
console.log('ok:', r.chips, 'chips; first =', r.head);

