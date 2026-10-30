#!/usr/bin/env bun
/**
 * 行內註〔註82〕→ 真正的腳註（2026-10-30）：
 * ys 的「方等泥洹經<note>竺法護釋法顯</note>」現在應是 [37.082]，
 * hover 顯示釋文「竺法護釋法顯」，點擊跳到 <釋>；不能再有「〔註82〕」純文字行。
 *
 *   cd ts && bun run tools/note82-test.ts [--html ../build/accelon26.html]
 *        [--ys D:/accelon3/ys.adb] [--taisho "D:/accelon3/=taisho.adb"]
 */
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const ROOT = resolve(import.meta.dir, '../..');
const HTML = resolve(opt('html', resolve(ROOT, 'build/accelon26.html')));
const YS = resolve(opt('ys', 'D:/accelon3/ys.adb'));
const TAISHO = resolve(opt('taisho', 'D:/accelon3/=taisho.adb'));
const PAGE = opt('page', '37p0037a');
const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const browser = BROWSERS.find((p) => existsSync(p));
if (!browser) { console.error('no Chromium browser'); process.exit(2); }
const profile = resolve(ROOT, 'build/.chrome-profile-n82-' + process.pid);
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
  await api.xrefJump('ys?${PAGE}');
  for (let i = 0; i < 100; i++) { if (document.querySelector('#docText .docLine')) break; await sleep(100); }
  await sleep(800);
  const body = document.querySelector('#docText .docBody');
  if (body) body.scrollTop = 0;
  await sleep(400);
  const text = document.getElementById('docText')?.textContent ?? '';
  const ref = document.querySelector('a.noteRef[data-note="37.082"]');
  const out = {
    hasRef: !!ref,
    oldText: text.includes('〔註82〕'),
    note083: !!document.querySelector('a.noteRef[data-note="37.083"]'),
    tip: '',
    bodyText: '',
    jumped: false,
  };
  if (ref) {
    ref.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    for (let i = 0; i < 50; i++) { await sleep(100); if ((document.getElementById('noteTip')?.textContent ?? '') !== '讀取中…') break; }
    out.tip = (document.getElementById('noteTip')?.textContent ?? '').trim();
    ref.click();
    await sleep(700);
    const bodyEl = document.querySelector('.noteBody[data-note="37.082"]');
    out.bodyText = (bodyEl?.textContent ?? '').trim();
    out.jumped = !!bodyEl;
  }
  return JSON.stringify(out, null, 1);
})()`));
// 截圖：這一段（句子裡的 [37.082]）
await cdp.eval(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const api = window.__accelon26;
  await api.xrefJump('ys?');
  for (let i = 0; i < 60; i++) { if (document.querySelector('#docText .docLine')) break; await sleep(100); }
  await sleep(500);
  const b = document.querySelector('#docText .docBody'); if (b) b.scrollTop = 0;
  await sleep(300);
  return true;
})()`).catch(() => {});
{
  const { writeFileSync } = await import('node:fs');
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }).catch(() => null);
  if (shot?.data) writeFileSync(resolve(ROOT, 'build/note82.png'), Buffer.from(shot.data, 'base64'));
}

console.log(JSON.stringify(out, null, 1));
if (cdp.logs.length) console.log('--- console ---\n' + cdp.logs.join('\n'));
proc.kill();
await Bun.sleep(200);
try { rmSync(profile, { recursive: true, force: true }); } catch { /* browser may hold it */ }

const fails: string[] = [];
if (!out.hasRef) fails.push('找不到 [37.082]（a.noteRef）');
if (out.oldText) fails.push('文件裡仍有「〔註82〕」純文字');
if (!out.note083) fails.push('[37.083] 不見了');
if (out.tip !== '竺法護釋法顯') fails.push('hover 釋文不對：' + JSON.stringify(out.tip));
if (!out.jumped || !out.bodyText.includes('竺法護釋法顯')) fails.push('點擊後沒有釋文：' + JSON.stringify(out.bodyText));
if (cdp.logs.some((l) => l.startsWith('[exception]'))) fails.push('console 有 exception');
if (fails.length) { console.error('FAIL:\n- ' + fails.join('\n- ')); process.exit(1); }
console.log('ok: 行內註〔註82〕已變成 [37.082] 腳註');
