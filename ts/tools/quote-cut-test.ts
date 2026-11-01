#!/usr/bin/env bun
/**
 * 跨頁引文塗紅（2026-10-31）：
 * ys 的 <聯 i="taisho?2p183c" q="何等為信根謂聖弟子於如來所起信心根本堅固">（沒有 j）
 * ——引文在 2p183c 的頁末被切斷，剩下的在 184a。舊版整段 q 在這一頁找不到就不塗；
 * 現在應把「這一頁的尾巴」塗紅（何等為信根？謂聖），下一頁的部份不在這張圖上。
 *
 *   cd ts && bun run tools/quote-cut-test.ts [--html ../build/accelon26.html]
 */
import { existsSync, rmSync, writeFileSync } from 'node:fs';
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
const profile = resolve(ROOT, 'build/.chrome-profile-qc-' + process.pid);
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
async function pick(file: string): Promise<void> {
  const doc = await cdp.send('DOM.getDocument');
  const q = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#file' });
  await cdp.send('DOM.setFileInputFiles', { files: [file], nodeId: q.nodeId });
  await cdp.eval('document.querySelector("#file").dispatchEvent(new Event("change"))');
}

const cdp = await Cdp.attach(await devtoolsUrl());
await cdp.openPage(pathToFileURL(HTML).href + '?v=' + Date.now());
await Bun.sleep(900);
await pick(TAISHO); await Bun.sleep(4000);
await pick(YS); await Bun.sleep(4500);

const out = JSON.parse(await cdp.eval<string>(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const api = window.__accelon26;
  await api.closeAbout?.();
  const input = document.getElementById('query');
  input.focus();
  input.value = '何等為信根';
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
  let chip = null;
  for (let i = 0; i < 120; i++) {
    await sleep(100);
    chip = document.querySelector('a.entryLink.xrefLink[data-xref="taisho?2p183c"]');
    if (chip) break;
  }
  if (!chip) return JSON.stringify({ error: 'no chip taisho?2p183c' });
  const res = { j: chip.dataset.j ?? '', q: (chip.dataset.q ?? '').slice(0, 30) };
  chip.click();
  let tab = '';
  for (let i = 0; i < 60; i++) {
    await sleep(100);
    tab = document.querySelector('#textTabs .docTab.active .docTabName')?.textContent ?? '';
    if (tab) break;
  }
  for (let i = 0; i < 120; i++) {
    await sleep(100);
    if ((document.getElementById('textBody')?.textContent ?? '').length > 50) break;
  }
  await sleep(300);
  const marks = [...document.querySelectorAll('#textBody .xrefHit')];
  res.tab = tab;
  res.marks = marks.length;
  res.markText = marks.map((m) => m.textContent).join('|');
  res.via = (globalThis.__xrefLast && globalThis.__xrefLast.via) || '';
  res.hit = (globalThis.__xrefLast && globalThis.__xrefLast.hit) || 0;
  res.textLen = (document.getElementById('textBody')?.textContent ?? '').length;
  return JSON.stringify(res, null, 1);
})()`));
console.log(JSON.stringify(out, null, 1));
const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }).catch(() => null);
if (shot?.data) writeFileSync(resolve(ROOT, 'build/quote-cut.png'), Buffer.from(shot.data, 'base64'));
if (cdp.logs.length) console.log('--- console ---\n' + cdp.logs.join('\n'));
proc.kill();
await Bun.sleep(200);
try { rmSync(profile, { recursive: true, force: true }); } catch { /* browser may hold it */ }

const fails: string[] = [];
if (out.error) fails.push(out.error);
if (out.j) fails.push('這個案例應該沒有 j，卻有：' + out.j);
if (out.tab !== 'T 2p183c') fails.push('右欄沒有開 T 2p183c：' + out.tab);
if (!out.marks) fails.push('沒有塗紅（跨頁引文的頁末前綴沒被標）');
if (!/何等為信根/.test(out.markText ?? '')) fails.push('塗紅的文字不對：' + out.markText);
if (out.via !== 'quote') fails.push('塗紅不是走 quote 比對：' + out.via);
if (!out.hit) fails.push('__xrefLast.hit 是 0');
if (cdp.logs.some((l) => l.startsWith('[exception]'))) fails.push('console 有 exception');
if (fails.length) { console.error('FAIL:\n- ' + fails.join('\n- ')); process.exit(1); }
console.log('ok: 跨頁引文塗到頁末');
