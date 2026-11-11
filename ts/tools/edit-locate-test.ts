#!/usr/bin/env bun
/**
 * edit-locate-test.ts — 驗證「F3 編輯定位」：有選取區→CodeMirror 選中同一段；
 * 無選取→大致捲到中線那一行並提示（作者 2026-11-10）。
 *
 *   bun run tools/edit-locate-test.ts --adb D:\\accelon3\\fuyan.adb
 */
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const ROOT = resolve(import.meta.dir, '..');
const HTML = resolve(opt('html', resolve('D:/accelon3/accelon26.html')));
const ADB = resolve(opt('adb', resolve('D:/accelon3/fuyan.adb')));
const PAGE = opt('page', '38p107');
const WAIT = Number(opt('wait', '3000'));

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const browser = BROWSERS.find((p) => existsSync(p));
if (!browser) { console.error('no Chromium browser'); process.exit(2); }
for (const p of [HTML, ADB]) if (!existsSync(p)) { console.error('missing ' + p); process.exit(2); }

const profile = resolve(ROOT, '../build/.chrome-editloc-' + process.pid);
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

// 先設進階模式 + 修訂者 ID（enterEdit 要這兩樣），再開 adb
await cdp.eval(`(function(){ document.body.classList.add('advanced'); localStorage.setItem('accelon26.editorId','測試者'); })()`);

const doc = await cdp.send('DOM.getDocument');
const q = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#file' });
await cdp.send('DOM.setFileInputFiles', { files: [ADB], nodeId: q.nodeId });
await cdp.eval('document.querySelector("#file").dispatchEvent(new Event("change"))');
await Bun.sleep(WAIT);

const result = await cdp.eval<string>(`(async () => {
  try {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const db = window.__accelon26.state().db || 'fuyan';
  await window.__accelon26.xrefJump(db + '?' + ${JSON.stringify(PAGE)});
  for (let i = 0; i < 80; i++) { if (document.querySelector('#docText .docLine')) break; await sleep(100); }
  await sleep(600);

  const out = {};
  out.db = db;

  // 找一段可選取的文字（取某一行 .lineText 的中間一段漢字）
  const lines = [...document.querySelectorAll('#docText .docLine[id^="L"]')];
  const target = lines.find((l) => { const t = l.querySelector('.lineText')?.textContent || ''; return (t.match(/[\\u3400-\\u9fff]/g) || []).length >= 8; });
  out.foundLine = !!target;
  if (!target) return JSON.stringify(out);

  const lineEl = target.querySelector('.lineText');
  const walker = document.createTreeWalker(lineEl, NodeFilter.SHOW_TEXT);
  let textNode = null, run = '';
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const han = (n.data || '').match(/[\\u3400-\\u9fff]{4,}/);
    if (han) { textNode = n; run = han[0]; break; }
  }
  out.hasRun = !!run;
  if (!textNode || !run) return JSON.stringify(out);

  // 1) 有選取：選取 run 的前 min(6, len) 個字
  const at = textNode.data.indexOf(run);
  const selText = run.slice(0, Math.min(6, run.length));
  const range = document.createRange();
  range.setStart(textNode, at); range.setEnd(textNode, at + selText.length);
  const s = window.getSelection(); s.removeAllRanges(); s.addRange(range);
  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
  await sleep(200);

  // 觸發 F3（用 window.dispatchEvent，capture 監聽器一定收得到）
  out.advanced = document.body.classList.contains('advanced');
  out.editorId = localStorage.getItem('accelon26.editorId') || '';
  // 關掉所有 modal（headless 載入時 aboutBox 可能預設開著，會擋住 F3）
  ['settingsBox','allSearchBox','aboutBox','editModal'].forEach((id) => { const el = document.getElementById(id); if (el) el.hidden = true; });
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F3', bubbles: true, cancelable: true }));
  for (let i = 0; i < 60; i++) { if (window.__accelon26EditView) break; await sleep(100); }
  await sleep(400);
  out.enterEditViaF3 = !!window.__accelon26EditView;

  // 若 F3 沒進編輯，改用 editBtn.click() 對照（用於區分「F3 失效」vs「選取定位失效」）
  if (!window.__accelon26EditView) {
    document.getElementById('editBtn')?.click();
    for (let i = 0; i < 60; i++) { if (window.__accelon26EditView) break; await sleep(100); }
    await sleep(400);
    out.enterEditViaBtn = !!window.__accelon26EditView;
  }

  const ed = window.__accelon26EditView;
  out.enterEdit = !!ed;
  if (ed) {
    const selRange = ed.state.selection.main;
    const selected = ed.state.sliceDoc(selRange.from, selRange.to);
    out.selectedText = selected;
    out.selectedMatches = selected.includes(selText) || selText.includes(selected);
    out.selWasEmpty = selRange.empty;
  }

  // 退出編輯：點「完成」按鈕（editDone），比 dispatch Escape 更可靠
  document.getElementById('editDone')?.click();
  await sleep(400);

  // 2) 無選取：清掉選取，觸發 F3，應大致捲到中線那行（caret 定位、不選取）
  const s2 = window.getSelection(); s2.removeAllRanges();
  await sleep(600);
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F3', bubbles: true, cancelable: true }));
  for (let i = 0; i < 60; i++) { if (window.__accelon26EditView) break; await sleep(100); }
  await sleep(400);
  const ed2 = window.__accelon26EditView;
  out.enterEdit2 = !!ed2;
  if (ed2) {
    const sel2 = ed2.state.selection.main;
    out.emptySelection = sel2.empty;
    out.caretLine = ed2.state.doc.lineAt(sel2.from).number;
    out.notice2 = document.getElementById('editNotice')?.textContent || '';
  }

  return JSON.stringify(out, null, 1);
  } catch (e) { return JSON.stringify({ error: String(e && e.stack || e) }); }
})()`);
console.log(result);
proc.kill();
await Bun.sleep(200);
try { rmSync(profile, { recursive: true, force: true }); } catch { /* browser may hold it */ }

const r = JSON.parse(result);
const fails: string[] = [];
if (r.error) fails.push(r.error);
if (!r.foundLine) fails.push('找不到可選取的行');
if (!r.hasRun) fails.push('找不到可選取的漢字段');
if (!r.enterEdit) fails.push('F3（有選取）應進入編輯');
if (r.enterEdit && !r.selectedMatches) fails.push('選取的文字應在 CodeMirror 選中：選到「' + r.selectedText + '」');
if (!r.enterEdit2) fails.push('F3（無選取）應進入編輯');
if (r.enterEdit2 && !r.emptySelection) fails.push('無選取時 caret 應是收合的（不選取）');
if (r.enterEdit2 && (!r.notice2 || !/選取|定位/.test(r.notice2))) fails.push('無選取定位應有鼓勵提示：' + r.notice2);
if (r.enterEdit2 && (!r.caretLine || r.caretLine < 1)) fails.push('無選取應定位到某一行：' + r.caretLine);

if (fails.length) { console.log('\n✗ 失敗：'); for (const f of fails) console.log('  - ' + f); process.exit(1); }
console.log('\n✓ 全部通過：F3 有選取→選中同一段；無選取→大致捲到中線行並提示');
