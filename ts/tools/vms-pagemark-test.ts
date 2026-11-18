#!/usr/bin/env bun
/**
 * 驗證《成唯識論》頁標點擊 → 右欄開大正藏。
 *
 *   cd ts && bun run tools/vms-pagemark-test.ts
 *
 * 開 vms.adb + taisho.adb，點第一個 .pageBreak[data-page]，
 * 檢查右欄（#textBody）出現大正藏的頁／經文，且左欄（本文）還在 vms。
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync as ex, rmSync } from 'node:fs';

const ROOT = resolve(import.meta.dir, '../..');
const HTML = 'D:/accelon3/accelon26.html';   // 用已部署的 viewer
const VMS = 'D:/accelon3/vms.adb';
const TAISHO = 'D:/accelon3/taisho.adb';
for (const [n, p] of [['html', HTML], ['vms', VMS], ['taisho', TAISHO]] as const) {
  if (!ex(p)) { console.error('missing ' + n + ': ' + p); process.exit(2); }
}
const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const browser = BROWSERS.find((p) => ex(p));
if (!browser) { console.error('no Chromium browser'); process.exit(2); }
const profile = resolve(ROOT, 'build/.chrome-profile-vmspm-' + process.pid);
const proc = Bun.spawn([browser, '--headless=new', '--disable-gpu', '--no-first-run',
  '--remote-debugging-port=0', '--remote-allow-origins=*', '--allow-file-access-from-files',
  '--window-size=1500,1100', `--user-data-dir=${profile}`, 'about:blank'],
  { stdout: 'ignore', stderr: 'ignore' });
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
  static async attach(url: string): Promise<Cdp> {
    const c = new Cdp();
    c.ws = new WebSocket(url);
    await new Promise<void>((ok, bad) => { c.ws.onopen = () => ok(); c.ws.onerror = () => bad(new Error('ws')); });
    c.ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (m.id && c.pending.has(m.id)) { const p = c.pending.get(m.id)!; c.pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
    };
    return c;
  }
  async send(method: string, params: Record<string, unknown> = {}, session = true): Promise<any> {
    const my = id2(this);
    const payload: Record<string, unknown> = { id: my, method, params };
    if (session && this.sessionId) payload.sessionId = this.sessionId;
    const p = new Promise<any>((resolve, reject) => this.pending.set(my, { resolve, reject }));
    this.ws.send(JSON.stringify(payload));
    return p;
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
let seq = 0;
function id2(_c: Cdp): number { return ++seq; }
const cdp = await Cdp.attach(await devtoolsUrl());
async function pick(file: string): Promise<void> {
  const doc = await cdp.send('DOM.getDocument');
  const q = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#file' });
  await cdp.send('DOM.setFileInputFiles', { files: [file], nodeId: q.nodeId });
  await cdp.eval('document.querySelector("#file").dispatchEvent(new Event("change"))');
}
let pass = 0, fail = 0;
const ok = (n: string, c: boolean, d = '') => { if (c) { pass++; console.log('  ok   ' + n + (d ? '  ' + d : '')); } else { fail++; console.log('  FAIL ' + n + (d ? '  ' + d : '')); } };

try {
  await cdp.openPage(pathToFileURL(HTML).href + '?v=' + Date.now());
  await Bun.sleep(1000);
  await pick(TAISHO); await Bun.sleep(3500);
  await pick(VMS); await Bun.sleep(4500);

  const out = JSON.parse(await cdp.eval<string>(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const api = window.__accelon26;
    await api.closeAbout?.();
    await api.showLine?.(1);
    await sleep(600);
    const marks = [...document.querySelectorAll('#docText .pageBreak[data-page],#docText .pageMark[data-page]')];
    const ids = marks.slice(0, 3).map((m) => m.dataset.page);
    if (!marks.length) return JSON.stringify({
      error: 'no page marks', ids,
      dbg: {
        title: document.title,
        dbname: api.dbInfo?.() ?? '',
        docTextLen: document.querySelector('#docText')?.innerHTML.length ?? -1,
        docTextHead: (document.querySelector('#docText')?.textContent ?? '').slice(0, 300),
        marksAnywhere: document.querySelectorAll('.pageBreak[data-page],.pageMark[data-page]').length,
        bodyClasses: document.querySelector('#docText')?.className ?? '',
        tabs: (document.querySelector('#dbTabs')?.textContent ?? '').slice(0, 200),
      },
    });
    const clicked = marks[0].dataset.page;
    marks[0].click();
    let head = '', text = '', title = '';
    for (let i = 0; i < 100; i++) {
      await sleep(100);
      head = document.querySelector('#textBody .docHead')?.textContent ?? '';
      text = document.querySelector('#textBody .docBody')?.textContent ?? '';
      if (head || text) break;
    }
    return JSON.stringify({
      ids, clicked,
      rightHead: head.slice(0, 200),
      rightText: text.slice(0, 160),
      mainTitle: document.querySelector('#dbTitle')?.textContent ?? document.querySelector('#dbPick')?.value ?? '',
      hasRight: !document.querySelector('#colRight')?.hidden,
    }, null, 1);
  })()`));
  console.log(JSON.stringify(out, null, 1));
  if (out.error) { ok('頁標存在', false, out.error); }
  else {
    ok('頁標是大正座標', /^T\d+n\d+_\d+[a-c]$/.test(out.clicked), out.clicked);
    ok('右欄已開', out.hasRight);
    ok('右欄有大正藏內容', /大正|No\.|經|\.docHead/.test(out.rightHead + out.rightText) || out.rightText.length > 20,
      (out.rightHead + ' / ' + out.rightText).slice(0, 100));
  }
} catch (e) {
  console.error(String(e));
  fail++;
} finally {
  try { cdp.ws.close(); } catch { /* ignore */ }
  try { proc.kill(); } catch { /* ignore */ }
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
