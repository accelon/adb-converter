#!/usr/bin/env bun
/**
 * 選取選單測試：短詞顯示「搜尋」；超過 10 字或含標點則隱藏。
 *
 *   cd ts && bun run tools/selection-test.ts --adb ../build/jingang-group.adb
 */
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const ROOT = resolve(import.meta.dir, '../..');
const HTML = resolve(ROOT, 'build/accelon26.html');
const ADB = resolve(opt('adb', resolve(ROOT, 'build/jingang-group.adb')));
const PAGE = opt('page', '8p749a');
const WAIT = Number(opt('wait', '3000'));
const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const browser = BROWSERS.find((p) => existsSync(p));
if (!browser) { console.error('no Chromium browser'); process.exit(2); }
const profile = resolve(ROOT, 'build/.chrome-profile-sel-' + process.pid);
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
  throw new Error('DevToolsActivePort not found');
}
class Cdp {
  ws!: WebSocket; id = 0; sessionId = '';
  pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  static async attach(url: string): Promise<Cdp> {
    const c = new Cdp();
    await new Promise<void>((res, rej) => {
      c.ws = new WebSocket(url);
      c.ws.onopen = () => res();
      c.ws.onerror = () => rej(new Error('ws error'));
      c.ws.onmessage = (ev) => {
        const m = JSON.parse(String(ev.data));
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
await Bun.sleep(800);
const doc = await cdp.send('DOM.getDocument');
const q = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#file' });
await cdp.send('DOM.setFileInputFiles', { files: [ADB], nodeId: q.nodeId });
await cdp.eval('document.querySelector("#file").dispatchEvent(new Event("change"))');
await Bun.sleep(WAIT);

const result = await cdp.eval<string>(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await window.__accelon26.xrefJump((window.__accelon26.state().db || 'jingang') + '?' + ${JSON.stringify(PAGE)});
  for (let i = 0; i < 50; i++) { if (document.querySelector('#docText .docLine')) break; await sleep(100); }
  await sleep(800);

  const line = [...document.querySelectorAll('#docText .docLine')].find((l) => (l.innerText || '').includes('佛告須菩提'));
  if (!line) return JSON.stringify({ error: 'no target line' });
  let node = null;
  const w = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    if ((n.data || '').includes('佛告須菩提')) { node = n; break; }
  }
  if (!node) return JSON.stringify({ error: 'no text node' });
  const base = node.data.indexOf('佛告須菩提');
  const apply = (nd, st, en) => {
    const r = document.createRange();
    r.setStart(nd, st); r.setEnd(nd, en);
    const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
  };
  const pick = (n) => apply(node, base, Math.min(base + n, node.data.length));
  const pickLong = () => {
    for (const ln of document.querySelectorAll('#docText .docLine')) {
      const w2 = document.createTreeWalker(ln, NodeFilter.SHOW_TEXT);
      for (let n2 = w2.nextNode(); n2; n2 = w2.nextNode()) {
        const m = /[\u3400-\u9fff]{12,}/.exec(n2.data || '');
        if (m) { apply(n2, m.index, m.index + 12); return true; }
      }
    }
    return false;
  };
  const read = async () => {
    await sleep(250);
    const m = document.getElementById('selMenu');
    const b = m?.querySelector('[data-sel="search"]');
    return { open: !!m && !m.hidden, searchStillThere: !!b && !b.hidden, searchHidden: !!b && b.hidden, citeHidden: !!m?.querySelector('[data-sel="cite"]')?.hidden, text: (window.getSelection()?.toString() || '').slice(0, 30) };
  };
  const out = {};
  out.db = window.__accelon26.state().db;
  pick(3); out.short = await read();          // 佛告須
  if (!pickLong()) return JSON.stringify({ error: 'no long text node' });
  out.long = await read();                     // 12 字
  pick(6); out.punct = await read();          // 佛告須菩提：
  document.querySelector('[data-sel="rong"]')?.click();
  await sleep(250);
  out.rong = window.__lastSnippet ?? '';
  pick(6); await read();
  document.querySelector('[data-sel="qian"]')?.click();
  await sleep(250);
  out.qian = window.__lastSnippet ?? '';
  return JSON.stringify(out, null, 1);
})()`);
console.log(result);
proc.kill();
await Bun.sleep(200);
try { rmSync(profile, { recursive: true, force: true }); } catch { /* browser may hold it */ }
const r = JSON.parse(result);
const fails: string[] = [];
if (!r.short?.open || !r.short?.searchStillThere) fails.push('short selection should show 搜尋');
if (r.db === 'jingang' && r.short?.citeHidden !== true) fails.push('jingang should hide 引用複製');
if (r.db === 'taisho' && r.short?.citeHidden !== false) fails.push('taisho should show 引用複製');
if (r.long?.searchStillThere) fails.push('>10 chars should hide 搜尋');
if (r.punct?.searchStillThere) fails.push('punctuation should hide 搜尋');
if (!String(r.rong).startsWith('<融') || !String(r.rong).includes('j="')) fails.push('融入引用 snippet missing');
if (!String(r.qian).startsWith('<嵌') || !String(r.qian).includes('t="') || !String(r.qian).includes('@')) fails.push('嵌入引用 snippet missing');
if (fails.length) { console.error(fails.join('; ')); process.exit(1); }
console.log('ok: selection search visibility');
