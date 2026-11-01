#!/usr/bin/env bun
/**
 * 釋文本身不點擊；只有開頭編號（a.noteBack）可以回本文的 <註>（2026-10-31）。
 */
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const ROOT = resolve(import.meta.dir, '../..');
const HTML = resolve(opt('html', resolve(ROOT, 'build/accelon26.html')));
const ADB = resolve(opt('adb', 'D:/accelon3/ys.adb'));
const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const browser = BROWSERS.find((p) => existsSync(p))!;
const profile = resolve(ROOT, 'build/.chrome-profile-nc-' + process.pid);
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
const doc = await cdp.send('DOM.getDocument');
const q = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#file' });
await cdp.send('DOM.setFileInputFiles', { files: [ADB], nodeId: q.nodeId });
await cdp.eval('document.querySelector("#file").dispatchEvent(new Event("change"))');
await Bun.sleep(4000);
const out = JSON.parse(await cdp.eval<string>(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const api = window.__accelon26;
  await api.closeAbout?.();
  await api.xrefJump('ys?37p0037a');
  for (let i = 0; i < 100; i++) { if (document.querySelector('#docText .docLine')) break; await sleep(100); }
  await sleep(500);
  const ref = document.querySelector('a.noteRef[data-note="37.085"]');
  if (!ref) return JSON.stringify({ error: 'no noteRef' });
  ref.click();
  let body = null;
  for (let i = 0; i < 40; i++) { await sleep(100); body = document.querySelector('.noteBody[data-note="37.085"]'); if (body) break; }
  if (!body) return JSON.stringify({ error: 'no noteBody' });
  const flash1 = !!document.querySelector('#docText .docLine.noteTarget');
  const mark1 = !!body.querySelector('a.noteBack.noteTargetMark');
  const page = () => document.getElementById('pageInfo')?.textContent ?? '';
  const before = page();
  body.click();                       // 點釋文本身：不應該跳
  await sleep(700);
  const afterBody = page();
  const back = body.querySelector('a.noteBack');
  back?.click();                      // 點編號：回本文的註
  await sleep(1200);
  const afterBack = page();
  const backHref = back?.getAttribute('href') ?? '';
  const flash2 = !!document.querySelector('#docText .docLine.noteTarget');
  return JSON.stringify({ before, afterBody, afterBack, backHref, flash1, mark1, flash2, bodyText: body.textContent?.slice(0, 30) ?? '' });
})()`));
console.log(JSON.stringify(out, null, 1));
if (cdp.logs.length) console.log('--- console ---\n' + cdp.logs.slice(-8).join('\n'));
proc.kill();
await Bun.sleep(200);
try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
const lineNo = (s: string): number => {
  const m = /行 ([\d,]+)–/.exec(s);
  return m ? Number(m[1].replace(/,/g, '')) : -1;
};
const fails: string[] = [];
if (out.error) fails.push(out.error);
if (!(lineNo(out.before) > 0)) fails.push('沒有頁碼資訊：' + out.before);
if (out.afterBody !== out.before) fails.push('點釋文本身不應該跳：' + out.before + ' → ' + out.afterBody);
if (out.afterBack === out.before) fails.push('點編號沒有回到註：' + out.afterBack);
if (!(lineNo(out.afterBack) > 0) || lineNo(out.afterBack) >= lineNo(out.before)) fails.push('回註的頁碼不對：' + out.afterBack);
if (!out.flash1) fails.push('跳回釋文後目標行沒有閃');
if (!out.mark1) fails.push('釋文開頭的編號沒有 highlight');
if (!out.flash2) fails.push('回註後目標行沒有閃');
if (cdp.logs.some((l) => l.startsWith('[exception]'))) fails.push('console 有 exception');
if (fails.length) { console.error('FAIL:\n- ' + fails.join('\n- ')); process.exit(1); }
console.log('ok: 釋文不點擊；編號可回本文');
