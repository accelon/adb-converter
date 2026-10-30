#!/usr/bin/env bun
/**
 * 選取選單測試（2026-10-30 兩層）：第一層 搜尋／複製／查看；
 * 搜尋的第二層列出能接受輸入的左欄分頁，點一下要送過去並切頁；
 * 複製有一般文字、引用、（T/K）字元級位置與位址範圍；查看有查字典與圖版。
 *
 *   cd ts && bun run tools/selection-test.ts --adb ../build/jingang-group.adb
 */
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const ROOT = resolve(import.meta.dir, '../..');
const HTML = resolve(opt('html', resolve(ROOT, 'build/accelon26.html')));
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

  const refind = () => {
    const ln = [...document.querySelectorAll('#docText .docLine')].find((l) => (l.innerText || '').includes('佛告須菩提'));
    if (!ln) return null;
    const w = document.createTreeWalker(ln, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const at = (n.data || '').indexOf('佛告須菩提');
      if (at >= 0) return { ln, n, at };
    }
    return null;
  };
  const apply = (nd, st, en) => {
    const r = document.createRange();
    r.setStart(nd, st); r.setEnd(nd, en);
    const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
  };
  const pick = (n) => {
    const f = refind();
    if (!f) return false;
    apply(f.n, f.at, Math.min(f.at + n, f.n.data.length));
    return true;
  };
  const menu = () => document.getElementById('selMenu');
  const group = (k) => menu()?.querySelector('.selGroup[data-grp="' + k + '"]') ?? null;
  const item = (s) => menu()?.querySelector('[data-sel="' + s + '"]') ?? null;
  const openGroup = async (k) => {
    const g = group(k);
    if (!g || g.hidden) return false;
    g.querySelector('.selGroupBtn')?.click();
    await sleep(80);
    return g.classList.contains('open');
  };
  const waitMenu = async () => {
    for (let i = 0; i < 40; i++) { if (menu() && !menu().hidden) return true; await sleep(50); }
    return false;
  };
  const visibleItems = (k) => [...(menu()?.querySelectorAll('[data-sub="' + k + '"] [data-sel]') ?? [])]
    .filter((b) => !b.hidden).map((b) => b.dataset.sel);

  const out = {};
  out.db = window.__accelon26.state().db;
  pick(5); await sleep(300); await waitMenu();
  out.menuOpen = !!menu() && !menu().hidden;
  out.groupOrder = [...menu().querySelectorAll('.selGroup')].map((g) => g.dataset.grp);
  out.groupsVisible = out.groupOrder.every((k) => { const g = group(k); return !!g && !g.hidden; });

  // 搜尋：第二層列出能接受輸入的分頁；點一個就送過去並切頁
  out.searchOpen = await openGroup('search');
  out.searchItems = [...(menu()?.querySelectorAll('[data-sub="search"] [data-sel]') ?? [])].map((b) => b.textContent);
  menu()?.querySelector('[data-sub="search"] [data-sel]')?.click();
  await sleep(500);
  out.searchTab = document.querySelector('#colLeft .tabBtn.active')?.dataset.tab ?? '';
  out.searchValue = document.getElementById('query')?.value ?? '';
  out.menuHiddenAfterSearch = !!menu()?.hidden;

  // 複製：一般文字、引用、兩種模板、字元級位置、（高麗⇄大正位址只在 T/K 出現）
  pick(3); await sleep(300); await waitMenu();
  await openGroup('copy');
  out.copyOrder = [...menu().querySelectorAll('[data-sub="copy"] [data-sel]')].map((b) => b.dataset.sel);
  out.copyItems = visibleItems('copy');
  out.citeHidden = !!item('cite')?.hidden;
  item('pos')?.click();
  await sleep(300);
  out.pos = window.__lastCopy ?? '';

  pick(3); await sleep(300); await waitMenu();
  await openGroup('copy');
  item('rong')?.click();
  await sleep(300);
  out.rong = window.__lastSnippet ?? '';

  pick(3); await sleep(300); await waitMenu();
  await openGroup('copy');
  item('qian')?.click();
  await sleep(300);
  out.qian = window.__lastSnippet ?? '';

  // 查看：查字典、（有開大正藏時的）開《…》、圖版
  pick(3); await sleep(300); await waitMenu();
  out.viewOpen = await openGroup('view');
  out.viewItems = visibleItems('view');
  out.plateTHidden = !!item('plateT')?.hidden;
  out.plateKHidden = !!item('plateK')?.hidden;
  const bookmark = document.querySelector('#selMenu .selMinor');
  out.bookmarkVisible = !!bookmark && !bookmark.hidden;
  return JSON.stringify(out, null, 1);
})()`);
console.log(result);
proc.kill();
await Bun.sleep(200);
try { rmSync(profile, { recursive: true, force: true }); } catch { /* browser may hold it */ }
const r = JSON.parse(result);
const fails: string[] = [];
if (r.error) fails.push(r.error);
if (!r.menuOpen) fails.push('選取後選單應打開');
if (!r.groupsVisible) fails.push('第一層三組應都在：' + JSON.stringify(r.groupOrder));
if (r.groupOrder?.[0] !== 'copy') fails.push('第一層「複製」應排最上：' + JSON.stringify(r.groupOrder));
if (!r.searchOpen) fails.push('「搜尋」第二層應打開');
if (!r.searchItems?.length) fails.push('「搜尋」第二層應列出可以輸入的分頁');
if (r.searchTab !== 'dir') fails.push('點「目錄」應切到目錄分頁：' + r.searchTab);
if (r.searchValue !== '佛告須菩提') fails.push('選取文字應送進目錄搜尋框：' + JSON.stringify(r.searchValue));
if (!r.menuHiddenAfterSearch) fails.push('送完搜尋選單應收起');
if (!(r.copyOrder?.indexOf('cite') >= 0) || r.copyOrder.indexOf('cite') > r.copyOrder.indexOf('copy')) fails.push('「複製」第二層應是 引用複製 → 複製文字：' + JSON.stringify(r.copyOrder));
const wantCopy = ['copy', 'rong', 'qian', 'pos'];
for (const k of wantCopy) if (!r.copyItems?.includes(k)) fails.push('「複製」缺少 ' + k + '：' + JSON.stringify(r.copyItems));
if (r.db === 'jingang' && r.citeHidden !== true) fails.push('jingang 應隱藏引用複製');
if (r.db === 'taisho' && (r.citeHidden !== false || !r.copyItems?.includes('cite'))) fails.push('taisho 應顯示引用複製');
if (!/^jingang\?8p749a j=\d+-\d+$/.test(String(r.pos))) fails.push('字元級位置格式不對（應含頁與範圍）：' + r.pos);
if (!String(r.rong).startsWith('<融') || !String(r.rong).includes('j="')) fails.push('融入引用 snippet missing');
if (!String(r.qian).startsWith('<嵌') || !String(r.qian).includes('t="') || !String(r.qian).includes('@')) fails.push('嵌入引用 snippet missing');
if (!r.viewOpen) fails.push('「查看」第二層應打開');
if (!r.viewItems?.includes('dict')) fails.push('「查看」應有查字典：' + JSON.stringify(r.viewItems));
if (r.db === 'jingang' && (!r.plateTHidden || !r.plateKHidden)) fails.push('jingang 不應有圖版');
if (r.db === 'taisho' && r.plateTHidden) fails.push('taisho 應有看大正藏圖版');
if (!r.bookmarkVisible) fails.push('「☆ 加入書籤」應保留');
if (fails.length) { console.error(fails.join('; ')); process.exit(1); }
console.log('ok: selection two-level menu');
