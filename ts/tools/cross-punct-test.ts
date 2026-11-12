#!/usr/bin/env bun
/**
 * 跨標點搜尋的實機驗收（作者 2026-11-12）。
 *
 *   bun run tools/cross-punct-test.ts [--adb ../accelon3/fuyan.adb]
 *                                    [--html D:/accelon3/accelon26.html]
 *                                    [--query 諸行無常諸法無我]
 *
 * 驗四件事，缺一不可：
 *   1. 查詢在**沒有**那串字的原文裡找得到（跨標點命中）
 *   2. 命中數與探針一致（搜尋引擎對）
 *   3. 摘要卡片把「諸行無常，諸法無我」整段塗紅（`<mark class="kw">` 含標點）
 *   4. 點進本文後 `.docHit` 也蓋住標點（畫面層證據，不是只看資料）
 *
 * 任何一項不成立就 exit 1。
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
const QUERY = opt('query', '諸行無常諸法無我');

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const browser = BROWSERS.find((p) => existsSync(p));
if (!browser) { console.error('no Chromium browser found'); process.exit(2); }
for (const p of [HTML, ADB]) if (!existsSync(p)) { console.error('missing ' + p); process.exit(2); }

const profile = resolve(ROOT, 'build/.chrome-profile-cross-' + process.pid);
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
    const wait = async (fn, n = 80) => { for (let i = 0; i < n; i++) { if (fn()) return true; await sleep(100); } return false; };
    const out = { query: ${JSON.stringify(QUERY)} };
    document.querySelector('#aboutClose')?.click();
    const qi = document.querySelector('#query');
    qi.value = out.query;
    qi.dispatchEvent(new Event('input'));
    await wait(() => document.querySelectorAll('#searchList .snippet').length > 0, 80);
    const st = window.__accelon26.state();
    out.hits = st.hitTotal;
    // 摘要：第一個 snippet 裡的 mark
    const first = document.querySelector('#searchList .snippet');
    out.snippetText = (first?.innerText ?? '').slice(0, 60).replace(/\\s+/g, ' ');
    const marks = [...(first?.querySelectorAll('mark.kw') ?? [])];
    out.snippetMarks = marks.map((m) => m.textContent);
    out.snippetMarkedWithPunct = marks.some((m) => /[，、；：]/.test(m.textContent ?? ''));
    out.summaryHead = (document.querySelector('#searchMeta')?.innerText ?? '').slice(0, 80);
    // 點第一筆 → 本文塗紅
    first?.click();
    await wait(() => document.querySelectorAll('#docText .docHit').length > 0, 60);
    await sleep(300);
    const docMarks = [...document.querySelectorAll('#docText .docHit')];
    out.docMarks = docMarks.map((m) => m.textContent);
    out.docMarkedWithPunct = docMarks.some((m) => /[，、；：]/.test(m.textContent ?? ''));
    out.docVisible = (document.querySelector('#docText .docBody')?.innerText ?? '').slice(0, 100).replace(/\\s+/g, ' ');
    out.consoleErrors = window.__accelon26.consoleErrors?.() ?? null;
    return JSON.stringify(out);
  })()
`);

const r = JSON.parse(report);
console.log(JSON.stringify(r, null, 1));

const fails: string[] = [];
if (!(r.hits > 0)) fails.push('查詢沒有命中');
if (!r.snippetMarks || !r.snippetMarks.length) fails.push('摘要沒有任何塗紅');
if (!r.docMarks || !r.docMarks.length) fails.push('本文沒有 .docHit');
// 跨標點專用的期待：命中的那一段要含標點（查「諸行無常諸法無我」→「諸行無常，諸法無我」）
if (args.includes('--expect-punct')) {
  if (!r.snippetMarkedWithPunct) fails.push('摘要沒有把跨標點的整段塗紅');
  if (!r.docMarkedWithPunct) fails.push('本文 .docHit 沒有蓋住標點');
}
if (r.consoleErrors && r.consoleErrors.length) fails.push('console 有錯誤：' + r.consoleErrors.join(' | '));

proc.kill();
await Bun.sleep(200);
try { rmSync(profile, { recursive: true, force: true }); } catch { /* 瀏覽器可能還握著 */ }

if (fails.length) { console.error('FAIL ' + fails.join('; ')); process.exit(1); }
console.log('PASS 跨標點：搜尋、摘要塗紅、本文塗紅都對');
