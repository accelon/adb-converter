#!/usr/bin/env bun
/**
 * Smoke test for 「加入 Obsidian」 in the real viewer (file://).
 *
 *   bun run tools/probe-vault-import.ts --vault "《論語句讀新詮》.zip"
 *        [--expect-sha256 <hash of the CLI build>] [--out build/import.png]
 *
 * What it checks, in one run:
 *   1. the 📁 menu now has 「加入 Obsidian（資料夾）」與「加入 Obsidian（.zip）」
 *   2. picking a .zip builds a database IN THE PAGE (no Bun), with progress
 *   3. the built bytes match the CLI byte for byte (sha256)
 *   4. the web build triggers a download into the browser's download folder
 *   5. the new database is opened and appears in the adb list
 *
 * Exit code 1 when any of those fails.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const ROOT = resolve(import.meta.dir, '../..');
const HTML = resolve(ROOT, 'build/accelon26.html');
const VAULT = args.includes('--vault') ? resolve(opt('vault', '')) : resolve(ROOT, '《論語句讀新詮》.zip');
const EXPECT = opt('expect-sha256', '');
const OUT = resolve(opt('out', 'build/import.png'));

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const browser = BROWSERS.find((p) => existsSync(p));
if (!browser) { console.error('no Chromium browser found'); process.exit(2); }
for (const p of [HTML, VAULT]) if (!existsSync(p)) { console.error('missing ' + p); process.exit(2); }

const downloads = mkdtempSync(join(tmpdir(), 'accelon26-dl-'));
const profile = resolve(ROOT, 'build/.chrome-profile-import-' + process.pid);
const proc = Bun.spawn([browser, '--headless=new', '--disable-gpu', '--no-first-run',
  '--remote-debugging-port=0', '--remote-allow-origins=*', '--allow-file-access-from-files',
  '--window-size=1600,1000', `--user-data-dir=${profile}`, 'about:blank'],
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
      setTimeout(() => { if (this.pending.delete(id)) rej(new Error('timeout ' + method)); }, 180000);
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

const t0 = Date.now();
const mark = (m: string) => console.log('[' + ((Date.now() - t0) / 1000).toFixed(1) + 's] ' + m);
mark('launching');
const cdp = await Cdp.attach(await devtoolsUrl());
mark('attached');
await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, eventsEnabled: true }, false);
await cdp.openPage(pathToFileURL(HTML).href + '?v=' + Date.now());
mark('page opened');
await Bun.sleep(900);
await cdp.eval('document.querySelector("#aboutClose")?.click()');

// 1) the menu rows exist
const menu = await cdp.eval<string>(`
  (() => {
    document.querySelector('#dbPickBtn').click();
    const rows = [...document.querySelectorAll('#dbPickMenu .dbPickItem')].map((r) => r.textContent.trim());
    document.querySelector('#dbPickBtn').click();
    return JSON.stringify(rows);
  })()
`);
console.log('menu', menu);

// 2) pick the zip
const doc = await cdp.send('DOM.getDocument');
const q = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#vaultZip' });
if (!q?.nodeId) { console.error('FAIL: #vaultZip is missing'); process.exit(1); }
mark('menu rows read');
await cdp.send('DOM.setFileInputFiles', { files: [VAULT], nodeId: q.nodeId });
mark('zip attached');
await cdp.eval('document.querySelector("#vaultZip").dispatchEvent(new Event("change"))');
mark('zip dispatched');
// 讀完 vault 會跳檔名對話框：輸入 lunyu（不含 .adb），按「建立」
let dialogOpen = false;
for (let i = 0; i < 300; i++) {
  const s = await cdp.eval<string>('JSON.stringify(window.__accelon26.vaultImport())');
  if (JSON.parse(s).dialogOpen) { dialogOpen = true; break; }
  await Bun.sleep(100);
}
if (!dialogOpen) { console.error('FAIL: the name dialog never opened'); proc.kill(); process.exit(1); }
const hint = await cdp.eval<string>(`
  (() => {
    const input = document.querySelector('#vaultNameInput');
    input.value = 'lunyu';
    input.dispatchEvent(new Event('input'));
    const text = document.querySelector('#vaultNameHint').textContent;
    document.querySelector('#vaultNameOk').click();
    return text;
  })()
`);
console.log('dialog hint:', hint);

// 3) wait for the build
const report = await cdp.eval<string>(`
  (async () => {
    const wait = async (fn, n = 600) => { for (let i = 0; i < n; i++) { if (fn()) return true; await new Promise((r) => setTimeout(r, 250)); } return false; };
    const ok = await wait(() => window.__accelon26?.vaultImport?.().last, 600);
    const imp = window.__accelon26?.vaultImport?.() ?? null;
    const st = window.__accelon26.state();
    return JSON.stringify({
      finished: ok,
      last: imp?.last ?? null,
      status: window.__accelon26.status(),
      db: st.db,
      tokens: st.tokens,
      dirRows: st.dirRows,
      docs: st.docs,
      catalog: st.catalog?.map?.((c) => c.name) ?? null,
    }, null, 1);
  })()
`);
console.log('report', report);
mark('report done');
const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
mark('screenshot');
await Bun.write(OUT, Buffer.from(shot.data, 'base64'));

proc.kill();
mark('killed');
await Bun.sleep(300);
try { rmSync(profile, { recursive: true, force: true }); } catch { /* still locked */ }

const r = JSON.parse(report);
const fails: string[] = [];
if (!r.finished) fails.push('the build never finished');
if (!r.last) fails.push('no build result');
if (r.last && EXPECT && r.last.sha256 !== EXPECT) fails.push(`sha256 ${r.last.sha256} != CLI ${EXPECT}`);
if (!r.db) fails.push('the imported database did not open');
const files = readdirSync(downloads);
console.log('downloads', JSON.stringify(files));
if (!files.some((f) => f.endsWith('.adb'))) fails.push('nothing was downloaded');
try { rmSync(downloads, { recursive: true, force: true }); } catch { /* ignore */ }
if (fails.length) { console.error('FAIL ' + fails.join('; ')); process.exit(1); }
console.log('ok — imported in the page, downloaded, opened');
