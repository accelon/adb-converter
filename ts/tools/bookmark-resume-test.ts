#!/usr/bin/env bun
/**
 * 重開同一個 adb 會回到最後加入的書籤，目錄也指到那個節點（2026-10-31）。
 *
 *   cd ts && bun run tools/bookmark-resume-test.ts [--adb D:/accelon3/fuyan.adb]
 */
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const ROOT = resolve(import.meta.dir, '../..');
const HTML = resolve(opt('html', resolve(ROOT, 'build/accelon26.html')));
const ADB = resolve(opt('adb', 'D:/accelon3/fuyan.adb'));
const NODE = opt('node', '第三章');
const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const browser = BROWSERS.find((p) => existsSync(p))!;
const profile = resolve(ROOT, 'build/.chrome-profile-bm-' + process.pid);
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

async function pick(): Promise<void> {
  const doc = await cdp.send('DOM.getDocument');
  const q = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#file' });
  await cdp.send('DOM.setFileInputFiles', { files: [ADB], nodeId: q.nodeId });
  await cdp.eval('document.querySelector("#file").dispatchEvent(new Event("change"))');
}

await pick();
await Bun.sleep(6000);
const seeded = JSON.parse(await cdp.eval<string>(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await window.__accelon26?.closeAbout?.();
  for (let i = 0; i < 100; i++) { if (document.querySelector('#dirTree .tRow')) break; await sleep(100); }
  const row = document.querySelector('#dirTree .tRow');
  const va = Number(row?.dataset?.va ?? 0);
  const book = row?.querySelector('.tName')?.textContent ?? '';
  const bm = { id: 't1', db: 'fuyan', va, pageId: '', book, page: '', text: '', createdAt: Date.now() };
  localStorage.setItem('accelon26.bookmarks.v1', JSON.stringify({ fuyan: [bm] }));  return JSON.stringify({ va, book: bm.book });
})()`));

// 重新載入頁面（模擬「下次開」），再開同一個 adb
await cdp.send('Page.reload', { ignoreCache: true });
await Bun.sleep(1500);
await cdp.eval('window.__accelon26?.closeAbout?.()').catch(() => {});
await pick();
await Bun.sleep(4000);
const out = JSON.parse(await cdp.eval<string>(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 120; i++) {
    if (document.querySelector('#dirTree .tRow.current')) break;
    await sleep(100);
  }
  await sleep(400);
  return JSON.stringify({
    status: document.getElementById('status')?.textContent ?? '',
    tab: document.querySelector('#docTabs .docTabName')?.textContent ?? '',
    currentRow: document.querySelector('#dirTree .tRow.current')?.dataset.va ?? '',
    pageInfo: document.getElementById('pageInfo')?.textContent ?? '',
    docLen: (document.getElementById('docText')?.textContent ?? '').length,
  });
})()`));
console.log(JSON.stringify({ seeded, after: out }, null, 1));
if (cdp.logs.length) console.log('--- console ---\n' + cdp.logs.slice(-10).join('\n'));
proc.kill();
await Bun.sleep(200);
try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }

const fails: string[] = [];
if (!seeded?.va) fails.push('沒有拿到節點' + (seeded?.error ? '：' + seeded.error : ''));
if (out.docLen < 100) fails.push('開庫後沒有內文');
if (Number(out.currentRow) !== Number(seeded.va)) fails.push(`目錄沒指到書籤節點（期望 ${seeded.va}，實際 ${out.currentRow || '無'}）`);
if (cdp.logs.some((l) => l.startsWith('[exception]'))) fails.push('console 有 exception');
if (fails.length) { console.error('FAIL:\n- ' + fails.join('\n- ')); process.exit(1); }
console.log('ok: 重開 adb 會回到最後的書籤，目錄也指到那個節點');
