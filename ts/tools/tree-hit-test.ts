#!/usr/bin/env bun
/**
 * 目錄節點／紅數字：直接跳到該節點的第一筆命中（2026-10-31）。
 *
 *   cd ts && bun run tools/tree-hit-test.ts [--html ../build/accelon26.html]
 *        [--ys D:/accelon3/ys.adb] [--taisho D:/accelon3/taisho.adb] [--q 如來常樂我淨]
 *
 * 驗：搜尋後點一個有 tCount 的節點（名稱）→ 摘要顯示該節點命中、第一張卡 active、
 * 本文跳到含查詢的那一筆；再點同一列的紅數字也一樣。
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
const Q = opt('q', '如來常樂我淨');
const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const browser = BROWSERS.find((p) => existsSync(p));
if (!browser) { console.error('no Chromium browser'); process.exit(2); }
const profile = resolve(ROOT, 'build/.chrome-profile-th-' + process.pid);
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
  const q = ${JSON.stringify(Q)};
  const input = document.getElementById('query');
  input.focus();
  input.value = q;
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
  for (let i = 0; i < 120; i++) { if (document.querySelector('#searchList .snippet.active')) break; await sleep(100); }
  await sleep(400);
  const beforeLine = document.querySelector('#docText .docLine')?.id ?? '';
  const beforeTab = document.querySelector('#docTabStrip .docTab.active')?.textContent ?? '';

  // 找一個有命中、而且收合著的節點（twisty ▸）
  const rows = [...document.querySelectorAll('#dirTree .tRow[data-va]')];
  const pickRow = (collapsedOnly) => rows.find((r) => {
    const n = Number((r.querySelector('.tCount')?.textContent ?? '').replace(/[^0-9]/g, ''));
    const tw = r.querySelector('.tTwisty')?.textContent ?? '';
    return n > 0 && (!collapsedOnly || tw.includes('▸'));
  }) ?? rows.find((r) => Number((r.querySelector('.tCount')?.textContent ?? '').replace(/[^0-9]/g, '')) > 0);

  const row = pickRow(true);
  if (!row) return JSON.stringify({ error: 'no node with tCount' });
  const rowVa = row.dataset.va;
  const count = row.querySelector('.tCount')?.textContent ?? '';
  const nameEl = row.querySelector('.tName'); if (nameEl) nameEl.click();

  let active = false, docHas = false;
  for (let i = 0; i < 120; i++) {
    await sleep(100);
    active = !!document.querySelector('#searchList .snippet.active[data-va]');
    docHas = (document.getElementById('docText')?.textContent ?? '').includes(q);
    if (active && docHas) break;
  }
  const res = {
    rowVa, count, active, docHas,
    beforeLine, afterLine: document.querySelector('#docText .docLine')?.id ?? '',
    beforeTab, afterTab: document.querySelector('#docTabStrip .docTab.active')?.textContent ?? '',
    meta: document.getElementById('searchMeta')?.textContent ?? '',
    snippetVa: document.querySelector('#searchList .snippet.active[data-va]')?.dataset.va ?? '',
  };

  // 再點同一列的紅數字：也要直接跳到第一筆
  const row2 = document.querySelector('#dirTree .tRow[data-va="' + rowVa + '"]');
  const cntEl = row2 && row2.querySelector('.tCount'); if (cntEl) cntEl.click();
  let active2 = false;
  for (let i = 0; i < 120; i++) {
    await sleep(100);
    active2 = !!document.querySelector('#searchList .snippet.active[data-va]');
    if (active2) break;
  }
  res.badgeActive = active2;
  res.badgeMeta = document.getElementById('searchMeta')?.textContent ?? '';
  return JSON.stringify(res, null, 1);
})()`));
console.log(JSON.stringify(out, null, 1));
if (cdp.logs.length) console.log('--- console ---\n' + cdp.logs.join('\n'));
proc.kill();
await Bun.sleep(200);
try { rmSync(profile, { recursive: true, force: true }); } catch { /* browser may hold it */ }

const fails: string[] = [];
if (out.error) fails.push(out.error);
if (!out.active) fails.push('點節點後摘要第一張卡沒有 active');
if (!out.docHas) fails.push('本文沒有跳到含查詢的那一筆');
if (out.afterLine === out.beforeLine && out.beforeLine) fails.push('本文行號沒變（應該跳到節點內的第一筆）');
if (!out.snippetVa) fails.push('找不到 active 的 snippet');
if (!out.badgeActive) fails.push('點紅數字後沒有跳到第一筆');
if (cdp.logs.some((l) => l.startsWith('[exception]'))) fails.push('console 有 exception');
if (fails.length) { console.error('FAIL:\n- ' + fails.join('\n- ')); process.exit(1); }
console.log('ok: 目錄節點／紅數字直接跳到第一筆');
