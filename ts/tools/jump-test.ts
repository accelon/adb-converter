#!/usr/bin/env bun
/**
 * 「跳至」接受字元級位置並高亮（2026-10-30）。
 *
 *   cd ts && bun run tools/jump-test.ts [--adb D:/accelon3/taisho.adb]
 *                                      [--page 5p2c] [--html ../build/accelon26.html]
 *                                      [--goryeo D:/accelon3/goryeo.adb]
 *
 * 驗：
 *   1. 選取一段 → 「複製」→「複製字元級位置」，得到 `taisho?5p2c j=a-b`
 *   2. 貼進「跳至」按 Enter：中間本文跳到那一頁，並把這幾個字塗上色帶
 *      （CSS Custom Highlight；`window.__lastCharBand.text` 等於選取文字）
 *   3. 手寫的位置（j=0-3）也能跳
 *   4. 換開別的庫再貼同一個位置：會切回原本的庫再跳
 */
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const ROOT = resolve(import.meta.dir, '../..');
const HTML = resolve(opt('html', resolve(ROOT, 'build/accelon26.html')));
const TAISHO = resolve(opt('adb', 'D:/accelon3/taisho.adb'));
const GORYEO = resolve(opt('goryeo', 'D:/accelon3/goryeo.adb'));
const PAGE = opt('page', '5p2c');
const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const browser = BROWSERS.find((p) => existsSync(p));
if (!browser) { console.error('no Chromium browser'); process.exit(2); }
if (!existsSync(TAISHO)) { console.error('no ' + TAISHO); process.exit(2); }
const profile = resolve(ROOT, 'build/.chrome-profile-jump-' + process.pid);
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
  logs: string[] = [];
  static async attach(url: string): Promise<Cdp> {
    const c = new Cdp();
    await new Promise<void>((res, rej) => {
      c.ws = new WebSocket(url);
      c.ws.onopen = () => res();
      c.ws.onerror = () => rej(new Error('ws error'));
      c.ws.onmessage = (ev) => {
        const m = JSON.parse(String(ev.data));
        if (m.method === 'Runtime.consoleAPICalled') {
          c.logs.push(`[${m.params?.type}] ` + (m.params?.args ?? []).map((a: any) => a.value ?? a.description ?? a.type).join(' '));
        } else if (m.method === 'Runtime.exceptionThrown') {
          c.logs.push('[exception] ' + (m.params?.exceptionDetails?.exception?.description ?? m.params?.exceptionDetails?.text));
        }
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

async function pickFile(file: string): Promise<void> {
  const doc = await cdp.send('DOM.getDocument');
  const q = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#file' });
  await cdp.send('DOM.setFileInputFiles', { files: [file], nodeId: q.nodeId });
  await cdp.eval('document.querySelector("#file").dispatchEvent(new Event("change"))');
}

await pickFile(TAISHO);
await Bun.sleep(5000);

// ---------------------------------------------------------------- phase A：複製位置 → 跳至
const a = JSON.parse(await cdp.eval<string>(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const api = window.__accelon26;
  const out = {};
  await api.xrefJump('taisho?${PAGE}');
  for (let i = 0; i < 120; i++) { if (document.querySelector('#docText .docLine')) break; await sleep(100); }
  await sleep(700);

  // 在 5p2c 那一頁選 6 個連續漢字
  const lines = [...document.querySelectorAll('#docText .docLine')];
  const markers = [...document.querySelectorAll('#docText [data-page]')];
  const pageOf = (el) => { let best = ''; for (const m of markers) if ((m.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) || el.contains(m)) best = m.dataset.page; return best; };
  let node = null, idx = -1, sel = '';
  for (const ln of lines) {
    if (pageOf(ln) !== '${PAGE}') continue;
    const w = document.createTreeWalker(ln, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const m = /[\\u3400-\\u9fff]{6}/.exec(n.data || '');
      if (m) { node = n; idx = m.index; sel = m[0]; break; }
    }
    if (node) break;
  }
  if (!node) return JSON.stringify({ error: 'no 6-char han run on page ${PAGE}' });
  const range = document.createRange();
  range.setStart(node, idx); range.setEnd(node, idx + 6);
  const s = window.getSelection(); s.removeAllRanges(); s.addRange(range);
  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
  await sleep(500);
  out.selText = sel;

  // 選單：複製 → 複製字元級位置
  const menu = document.getElementById('selMenu');
  menu?.querySelector('.selGroup[data-grp="copy"] .selGroupBtn')?.click();
  await sleep(120);
  menu?.querySelector('[data-sel="pos"]')?.click();
  await sleep(400);
  out.pos = window.__lastCopy || '';

  // 清選取，切到「跳至」，貼上位置並按 Enter
  window.getSelection()?.removeAllRanges();
  await sleep(200);
  document.querySelector('#colLeft .tabBtn[data-tab="jump"]')?.click();
  await sleep(200);
  const input = document.getElementById('jumpQuery');
  input.value = out.pos;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  for (let i = 0; i < 60; i++) { if (window.__lastCharBand) break; await sleep(100); }
  out.meta = document.getElementById('jumpMeta')?.textContent?.slice(0, 80) ?? '';
  out.band = window.__lastCharBand ?? null;
  out.hasHighlight = !!(window.CSS && CSS.highlights && CSS.highlights.has && CSS.highlights.has('accelonCharBand'));
  out.db = api.state().db;
  return JSON.stringify(out, null, 1);
})()`));

// 截一張圖（本文只高亮那幾個字；先把「關於」收起來）
await cdp.eval('window.__accelon26.closeAbout?.(); true').catch(() => {});
await Bun.sleep(300);
{
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }).catch(() => null);
  if (shot?.data) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(resolve(ROOT, 'build/jump-highlight.png'), Buffer.from(shot.data, 'base64'));
  }
}

// 手寫位置：這一頁的前 4 個字（先清掉上一條色帶，才等得到新的）
const a2 = JSON.parse(await cdp.eval<string>(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const input = document.getElementById('jumpQuery');
  window.__lastCharBand = null;
  input.value = 'taisho?${PAGE} j=0-4';
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  for (let i = 0; i < 40; i++) { if (window.__lastCharBand && window.__lastCharBand.text && window.__lastCharBand.text.length >= 3) break; await sleep(100); }
  return JSON.stringify({ manual: window.__lastCharBand ?? null }, null, 1);
})()`));

// ---------------------------------------------------------------- phase B：換庫後再貼同一個位置
await pickFile(GORYEO);
await Bun.sleep(5000);

const b = JSON.parse(await cdp.eval<string>(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const api = window.__accelon26;
  const out = { before: api.state().db };
  document.querySelector('#colLeft .tabBtn[data-tab="jump"]')?.click();
  await sleep(200);
  const input = document.getElementById('jumpQuery');
  input.value = ${JSON.stringify(a.pos)};
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  for (let i = 0; i < 80; i++) { if (window.__lastCharBand && window.__lastCharBand.text) break; await sleep(100); }
  out.after = api.state().db;
  out.band = window.__lastCharBand ?? null;
  return JSON.stringify(out, null, 1);
})()`));

proc.kill();
await Bun.sleep(200);
try { rmSync(profile, { recursive: true, force: true }); } catch { /* browser may hold it */ }

console.log('--- A: 複製位置 → 跳至並高亮 ---');
console.log(JSON.stringify(a, null, 1));
console.log('--- B: 換庫後貼同一個位置 ---');
console.log(JSON.stringify(b, null, 1));
if (cdp.logs.length) console.log('--- console ---\n' + cdp.logs.join('\n'));

const fails: string[] = [];
if (a.error) fails.push('A: ' + a.error);
if (!new RegExp('^taisho\\?' + PAGE + ' j=\\d+-\\d+$').test(String(a.pos))) fails.push('複製的位置格式不對：' + a.pos);
if (!a.band?.text) fails.push('跳至後沒有字元色帶');
if (a.band?.text !== a.selText) fails.push(`色帶文字應等於選取（${a.selText}），實得 ${a.band?.text}`);
if (!a.hasHighlight) fails.push('CSS Highlight 沒有註冊');
if (!a.meta?.includes('按 Enter')) fails.push('跳至的提示不對：' + a.meta);
if (!a2.manual?.text || a2.manual.text.length < 3) fails.push('手寫位置沒有高亮：' + JSON.stringify(a2.manual));
if (b.error) fails.push('B: ' + b.error);
if (b.before === 'taisho') fails.push('B 測試前應該已經換到別的庫：' + b.before);
if (b.after !== 'taisho') fails.push('換庫後貼位置應切回 taisho，實得 ' + b.after);
if (b.band?.text !== a.selText) fails.push(`換庫後色帶文字應相同，實得 ${b.band?.text}`);
if (fails.length) { console.error('FAIL:\n- ' + fails.join('\n- ')); process.exit(1); }
console.log('ok: 跳至接受字元級位置並高亮');
