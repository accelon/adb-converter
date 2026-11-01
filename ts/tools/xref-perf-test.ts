#!/usr/bin/env bun
/**
 * 跨庫點「大正」到看見經文的耗時分解（2026-10-31）。
 *
 *   cd ts && bun run tools/xref-perf-test.ts [--html ../build/accelon26.html]
 *
 * 量：載入 ys／taisho 的時間、第一次點聯（冷）與第二次（暖）的各段耗時。
 * renderForeign 會把分解寫在 globalThis.__xrefPerf：
 *   reader＝打開目標庫、index＝頁碼索引、reverse＝反鏈表、page＝取頁文字、paint＝組 HTML。
 */
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const ROOT = resolve(import.meta.dir, '../..');
const HTML = resolve(opt('html', resolve(ROOT, 'build/accelon26.html')));
const YS = resolve(opt('ys', 'D:/accelon3/ys.adb'));
const TAISHO = resolve(opt('taisho', 'D:/accelon3/taisho.adb'));
const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const browser = BROWSERS.find((p) => existsSync(p));
if (!browser) { console.error('no Chromium browser'); process.exit(2); }
const profile = resolve(ROOT, 'build/.chrome-profile-xp-' + process.pid);
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

async function pick(file: string): Promise<number> {
  const t0 = Date.now();
  const doc = await cdp.send('DOM.getDocument');
  const q = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#file' });
  await cdp.send('DOM.setFileInputFiles', { files: [file], nodeId: q.nodeId });
  await cdp.eval('document.querySelector("#file").dispatchEvent(new Event("change"))');
  // 等 db 真的開好：state().db 等於檔名
  const want = file.split(/[\\/]/).pop()!.replace(/\.adb$/i, '').toLowerCase();
  for (let i = 0; i < 600; i++) {
    const st = await cdp.eval<string>(`window.__accelon26?.state?.().db ?? ''`).catch(() => '');
    if (String(st).toLowerCase() === want) break;
    await Bun.sleep(50);
  }
  return Date.now() - t0;
}

const cdp = await Cdp.attach(await devtoolsUrl());
await cdp.openPage(pathToFileURL(HTML).href + '?v=' + Date.now());
await Bun.sleep(900);
await cdp.eval('window.__accelon26.closeAbout?.(); true').catch(() => {});
const tTaisho = await pick(TAISHO);
const tYs = await pick(YS);
await Bun.sleep(500);

const out = JSON.parse(await cdp.eval<string>(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const api = window.__accelon26;
  const t0 = performance.now();
  await api.xrefJump('ys?26p0066a');
  for (let i = 0; i < 200; i++) { if (document.querySelector('#docText .docLine')) break; await sleep(50); }
  const tJump = performance.now() - t0;
  await sleep(500);
  const chip = document.querySelector('a.entryLink.xrefLink[data-xref^="taisho?"]');
  if (!chip) return JSON.stringify({ error: 'no chip' });
  const clickOnce = async () => {
    const t = performance.now();
    chip.click();
    for (let i = 0; i < 400; i++) {
      await sleep(25);
      if (document.querySelector('#textBody .docHead')) break;
    }
    await sleep(150);
    return {
      wall: Math.round(performance.now() - t),
      perf: (globalThis.__xrefPerf ?? null),
      click: (globalThis.__xrefClick ?? null),
      tab: document.querySelector('#textTabs .docTab.active .docTabName')?.textContent ?? '',
      len: (document.getElementById('textBody')?.textContent ?? '').length,
      hasHead: !!document.querySelector('#textBody .docHead'),
      hasRev: !!document.querySelector('#textBody .xrefRevBar'),
    };
  };
  const cold = await clickOnce();
  const warm = await clickOnce();
  // 反鏈 bar 是背景補的：等它出現，記錄花多久
  const tRev = performance.now();
  let revMs = -1;
  for (let i = 0; i < 200; i++) {
    if (document.querySelector('#textBody .xrefRevBar')) { revMs = Math.round(performance.now() - tRev); break; }
    await sleep(50);
  }
  return JSON.stringify({
    jump: Math.round(tJump),
    cold, warm,
    reverseEntries: (globalThis.__revEntries ?? null),
    revBarMs: revMs,
    revPerf: globalThis.__revPerf ?? null,
  }, null, 1);
})()`));
console.log(JSON.stringify(out, null, 1));
if (cdp.logs.length) console.log('--- console ---\n' + cdp.logs.join('\n'));
proc.kill();
await Bun.sleep(200);
try { rmSync(profile, { recursive: true, force: true }); } catch { /* browser may hold it */ }

console.log(JSON.stringify({ loadTaishoMs: tTaisho, loadYsMs: tYs }, null, 1));
