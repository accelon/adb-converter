#!/usr/bin/env bun
/**
 * 第一次使用（沒有任何 adb）的引導卡：`ts/tools/welcome-test.ts`
 *
 *   cd ts && bun run tools/welcome-test.ts [--html ../build/accelon26.html]
 *
 * 驗：沒有開庫時，本文區出現 #docWelcome；桌面專用的「下載公開資料庫」在網頁版隱藏；
 * 按「開啟本機 .adb」會觸發檔案選擇（#file 的 click）。順便截一張 build/welcome.png。
 */
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const ROOT = resolve(import.meta.dir, '../..');
const HTML = resolve(opt('html', resolve(ROOT, 'build/accelon26.html')));
const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const browser = BROWSERS.find((p) => existsSync(p));
if (!browser) { console.error('no Chromium browser'); process.exit(2); }
const profile = resolve(ROOT, 'build/.chrome-profile-welcome-' + process.pid);
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
await Bun.sleep(1200);
await cdp.eval('window.__accelon26.closeAbout?.(); true').catch(() => {});
await Bun.sleep(300);

const out = JSON.parse(await cdp.eval<string>(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const card = document.getElementById('docWelcome');
  const store = card?.querySelector('[data-welcome="store"]');
  const openBtn = card?.querySelector('[data-welcome="open"]');
  let fileClicked = 0;
  const file = document.getElementById('file');
  file?.addEventListener('click', () => { fileClicked++; });
  openBtn?.click();
  await sleep(200);
  return JSON.stringify({
    card: !!card,
    title: card?.querySelector('h2')?.textContent ?? '',
    storeHidden: !!store?.hidden,
    openLabel: openBtn?.textContent?.trim() ?? '',
    fileClicked,
    db: window.__accelon26.state().db,
  }, null, 1);
})()`));

const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }).catch(() => null);
if (shot?.data) writeFileSync(resolve(ROOT, 'build/welcome.png'), Buffer.from(shot.data, 'base64'));

proc.kill();
await Bun.sleep(200);
try { rmSync(profile, { recursive: true, force: true }); } catch { /* browser may hold it */ }

console.log(JSON.stringify(out, null, 1));
const fails: string[] = [];
if (!out.card) fails.push('沒有開庫時應顯示 #docWelcome');
if (out.title !== '開始閱讀') fails.push('引導卡標題不對：' + out.title);
if (!out.storeHidden) fails.push('網頁版應隱藏「下載公開資料庫」');
if (!out.fileClicked) fails.push('按「開啟本機 .adb」應觸發 #file');
if (out.db) fails.push('不應該已有資料庫：' + out.db);
if (fails.length) { console.error('FAIL:\n- ' + fails.join('\n- ')); process.exit(1); }
console.log('ok: 第一次使用的引導卡');
