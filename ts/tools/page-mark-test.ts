#!/usr/bin/env bun
/**
 * 原書頁 <頁> 的標記（2026-10-31）：
 *   1. 必須 inline（span），後面不折行。
 *   2. 雙擊它只出現「複製文字」，沒有搜尋／書籤／查字典。
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
const profile = resolve(ROOT, 'build/.chrome-profile-pm-' + process.pid);
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
  await window.__accelon26?.closeAbout?.();
  await window.__accelon26?.xrefJump?.('ys?37p0037a').catch(() => {});
  for (let i = 0; i < 80; i++) { if (document.querySelector('#docText .docLine')) break; await sleep(100); }
  await sleep(400);
  let mark = document.querySelector('#docText .pageBreak');
  if (!mark) {
    // 這一頁沒有 <頁> 就翻下一頁找
    for (let i = 0; i < 10 && !mark; i++) { document.getElementById('pageNext')?.click(); await sleep(500); mark = document.querySelector('#docText .pageBreak'); }
  }
  if (!mark) return JSON.stringify({ error: 'no .pageBreak on this page' });
  const disp = getComputedStyle(mark).display;
  const tag = mark.tagName;
  const pid = mark.querySelector('.pageId') ?? mark;
  // 模擬雙擊：選取頁碼文字 → mouseup
  const r = document.createRange();
  r.selectNodeContents(pid);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
  pid.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
  await sleep(600);
  const menu = document.getElementById('selMenu');
  const vis = (sel2) => {
    const b = menu?.querySelector('[data-sel="' + sel2 + '"]');
    if (!b) return null;
    const grp = b.closest('.selGroup');
    return !b.hidden && (!grp || !grp.hidden);
  };
  return JSON.stringify({
    tag, display: disp,
    afterSameLine: (() => { const p = mark.parentElement; return p ? p.textContent.trim().length > pid.textContent.trim().length : false; })(),
    pageOnlyLines: [...document.querySelectorAll('#docText .docLine')].filter((l) => { const pb = l.querySelector('.pageBreak'); return !!pb && l.textContent.trim() === pb.textContent.trim(); }).length,
    contLines: document.querySelectorAll('#docText .contLine').length,
    contMerged: (() => { const c = document.querySelector('#docText .contLine'); return c ? !!c.closest('.docLine')?.querySelector('.pageBreak') : null; })(),
    pageOnlySample: (() => { const l = [...document.querySelectorAll('#docText .docLine')].find((x) => { const pb = x.querySelector('.pageBreak'); return !!pb && x.textContent.trim() === pb.textContent.trim(); }); return (l?.outerHTML ?? '').slice(0, 320); })(),
    neighbors: (() => { const all = [...document.querySelectorAll('#docText .docLine')]; const i = all.findIndex((x) => { const pb = x.querySelector('.pageBreak'); return !!pb && x.textContent.trim() === pb.textContent.trim(); }); if (i < 0) return []; return all.slice(Math.max(0, i - 3), i + 4).map((x) => ({ id: x.id, src: (x.getAttribute('data-src') ?? '').slice(0, 40) })); })(),
    menuHidden: menu?.hidden ?? null,
    copy: vis('copy'), cite: vis('cite'), pos: vis('pos'), dict: vis('dict'),
    minorHidden: menu?.querySelector('.selMinor')?.hidden ?? null,
    copySubOpen: (() => { const s = menu?.querySelector('.selSub[data-sub="copy"]'); return s ? !s.hidden : null; })(),
  }, null, 1);
})()`));
console.log(out);
// 第二段：取消「原書分行」→ 頁碼前後應在同一個段落（不因頁碼前的空行被切斷）
const reflow = JSON.parse(await cdp.eval(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const cb = document.getElementById('showHardBreaks');
  if (!cb) return JSON.stringify({ error: 'no hardbreaks checkbox' });
  cb.checked = false;
  cb.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(1500);
  const para = [...document.querySelectorAll('#docText .docPara')].find((p) => p.querySelector('.pageMark'));
  if (!para) return JSON.stringify({ para: false });
  const pm = para.querySelector('.pageMark');
  const text = para.textContent ?? '';
  const mark = pm.textContent ?? '';
  const at = mark ? text.indexOf(mark) : -1;
  const after = at >= 0 ? text.slice(at + mark.length).trim() : '';
  return JSON.stringify({ para: true, mark, afterLen: after.length, afterText: after.slice(0, 30) });
})()`));
console.log(JSON.stringify({ reflow }, null, 1));
await cdp.eval("(() => { const m = document.getElementById('selMenu'); if (m) m.hidden = true; const pb = document.querySelector('#docText .pageBreak'); pb?.scrollIntoView({ block: 'center' }); return true; })()").catch(() => {});
await Bun.sleep(400);
const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }).catch(() => null);
if (shot?.data) { const { writeFileSync } = await import('node:fs'); writeFileSync(resolve(ROOT, 'build/page-break.png'), Buffer.from(shot.data, 'base64')); }
if (cdp.logs.length) console.log('--- console ---\n' + cdp.logs.slice(-6).join('\n'));
proc.kill();
await Bun.sleep(200);
try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
const fails: string[] = [];
if (out.error) fails.push(out.error);
if (out.tag !== 'SPAN') fails.push('pageBreak 不是 inline span：' + out.tag);
if (out.display !== 'inline') fails.push('pageBreak display 不是 inline：' + out.display);
if (out.menuHidden !== false) fails.push('雙擊頁碼沒有開選單');
if (out.copy !== true) fails.push('沒有「複製文字」');
if (out.cite === true) fails.push('不該有「引用複製」');
if (out.pos === true) fails.push('不該有「複製字元級位置」');
if (out.dict === true) fails.push('不該有「查字典」');
if (out.pageOnlyLines !== 0) fails.push('頁碼仍然自成一行：' + out.pageOnlyLines);
if (out.minorHidden !== true) fails.push('不該有「加入書籤」');
if (reflow.error) fails.push('連排測試：' + reflow.error);
else if (!reflow.para) fails.push('連排模式找不到含頁碼的段落');
else if (!(reflow.afterLen > 0)) fails.push('頁碼後面的文字被切到別的段落：' + JSON.stringify(reflow));
if (cdp.logs.some((l) => l.startsWith('[exception]'))) fails.push('console 有 exception');
if (fails.length) { console.error('FAIL:\n- ' + fails.join('\n- ')); process.exit(1); }
console.log('ok: <頁> inline；雙擊只留「複製文字」；連排版面頁碼不切段');
