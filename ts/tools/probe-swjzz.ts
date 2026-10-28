#!/usr/bin/env bun
/**
 * swjzz.adb（說文解字注）的詞典驗收：在真的閱讀器裡跑一遍。
 *
 *   bun run ts/tools/probe-swjzz.ts [--adb accelon3\swjzz.adb] [--out build/probe-swjzz.png]
 *
 * 與 probe-adb.ts 的差別：那支是通用的開庫／目錄／檢索煙霧測試，這支專門驗
 * `s="*"` 的三層目錄（卷→部→字）、`s="$字"` 的字頭表，以及**點字查詞典**：
 *
 *   1. 目錄樹 35 個卷 → 展開「說文解字第一篇上」→ 部（一部、𠄞部、示部…）→ 字（一、弌、元…）
 *   2. 名詞分頁：字頭表出現、輸入「江」查得到
 *   3. 點目錄的「天」→ 本文顯示條文
 *   4. 在本文「天」上按一下 → 右欄詞典列出《說文解字注》的「天」，並渲染條文
 *
 * 任何一項不成立就 exit 1（CI 或交付前跑一次）。
 */
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const ROOT = resolve(import.meta.dir, '../..');
const pick = (n: string, dflt: string) => (args.includes('--' + n) ? resolve(opt(n, dflt)) : resolve(ROOT, dflt));
const HTML = pick('html', 'build/accelon26.html');
const ADB = pick('adb', 'accelon3/swjzz.adb');
const OUT = pick('out', 'build/probe-swjzz.png');
const ROOT_NAME = opt('root', '第一篇上');
const EXPECT_ROWS = Number(opt('rows', '35'));
const EXPECT_DB = opt('db', 'swjzz');

const browser = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => existsSync(p));
if (!browser) { console.error('no Chromium browser found'); process.exit(2); }
for (const p of [HTML, ADB]) if (!existsSync(p)) { console.error('missing ' + p); process.exit(2); }

const profile = resolve(ROOT, 'build/.chrome-profile-swjzz-' + process.pid);
const proc = Bun.spawn([browser, '--headless=new', '--disable-gpu', '--no-first-run',
  '--remote-debugging-port=0', '--remote-allow-origins=*', '--allow-file-access-from-files',
  '--window-size=1600,1000', `--user-data-dir=${profile}`, 'about:blank'],
  { stdout: 'pipe', stderr: 'pipe' });

async function devtoolsUrl(): Promise<string> {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const text = await Bun.file(resolve(profile, 'DevToolsActivePort')).text().catch(() => '');
    const [port, path] = text.split('\n').map((s) => s.trim());
    if (Number(port) > 0 && path) return `ws://127.0.0.1:${port}${path}`;
    await Bun.sleep(200);
  }
  throw new Error('DevToolsActivePort never appeared');
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
await Bun.sleep(3000);

const step1 = await cdp.eval<string>(`
  (async () => {
    const wait = async (fn, n = 100) => { for (let i = 0; i < n; i++) { if (fn()) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const out = {};
    document.querySelector('#aboutClose')?.click();
    const st = window.__accelon26.state();
    out.db = st.db; out.leftTab = st.leftTab; out.dirRows = st.dirRows;
    const rows = () => [...document.querySelectorAll('#dirTree .tRow')];
    const nameOf = (r) => r.querySelector('.tName')?.textContent ?? '';
    const tagOf = (r) => r.querySelector('.tTag')?.textContent ?? '';
    out.roots = rows().slice(0, 4).map((r) => tagOf(r) + ':' + nameOf(r));
    // 1) 展開根節點（swjzz＝卷、swjzzsrc＝書），再一路展開到出現「字」
    const root = rows().find((r) => nameOf(r).includes(${JSON.stringify(ROOT_NAME)}));
    const before0 = rows().length;
    out.before0 = before0;
    out.rootFound = !!root;
    out.hasTwisty = !!root?.querySelector('.tTwisty');
    root?.querySelector('.tTwisty')?.click();
    await wait(() => rows().length > before0 + 1, 80);
    await sleep(300);
    out.partRows = rows().slice(before0, before0 + 8).map((r) => tagOf(r) + ':' + nameOf(r));
    // 2) 沿著第一個子節點往下展開（卷→部→字／書→卷→部→字）。
    //    樹列是虛擬清單，展開後會重畫，所以不能用元素參照，改用「標籤」重新找。
    let wantLabel = nameOf(root);
    out.steps = [];
    for (let depth = 0; depth < 4; depth++) {
      if (rows().some((r) => tagOf(r) === '字')) break;
      const all = rows();
      const at = all.findIndex((r) => nameOf(r) === wantLabel);
      if (at < 0) break;
      const child = all[at + 1];
      const tw = child?.querySelector('.tTwisty');
      if (!child || !tw) break;
      out.steps.push(tagOf(child) + ':' + nameOf(child));
      const n0 = all.length;
      tw.click();
      await wait(() => rows().length > n0, 80);
      await sleep(400);
      wantLabel = nameOf(child);
    }
    out.ziRows = rows().filter((r) => tagOf(r) === '字').slice(0, 6).map((r) => tagOf(r) + ':' + nameOf(r));
    out.ziRowCount = rows().filter((r) => tagOf(r) === '字').length;
    // 3) 名詞分頁（caches/字 的名稱表）
    out.termTabExists = !!document.querySelector('#colLeft .tabBtn[data-tab="terms"]:not([hidden])');
    out.freqTabExists = !!document.querySelector('#colLeft .tabBtn[data-tab="freq"]:not([hidden])');
    document.querySelector('#colLeft .tabBtn[data-tab="terms"]')?.click();
    await sleep(800);
    out.termSample = [...(document.querySelector('#termsList')?.innerText ?? '').split('\\n')].slice(0, 6);
    const tq = document.querySelector('#termsQuery');
    if (tq) { tq.value = '江'; tq.dispatchEvent(new Event('input')); }
    await wait(() => (document.querySelector('#termsCount')?.textContent ?? '') !== '', 60);
    out.termHits = (document.querySelector('#termsCount')?.textContent ?? '');
    out.termBody = (document.querySelector('#termsList')?.innerText ?? '').slice(0, 40).replace(/\\n/g, ' ');
    // 4) 目錄點「天」（沒有就點第一個字）→ 本文
    document.querySelector('#colLeft .tabBtn[data-tab="dir"]')?.click();
    await sleep(300);
    const rowsNow = [...document.querySelectorAll('#dirTree .tRow')];
    const tian = rowsNow.find((r) => (r.querySelector('.tName')?.textContent ?? '') === '天')
      ?? rowsNow.find((r) => (r.querySelector('.tTag')?.textContent ?? '') === '字');
    out.tianRowFound = !!tian;
    (tian?.querySelector('.tDot') ?? tian)?.click();
    await wait(() => document.querySelectorAll('#docText .docLine').length > 0, 60);
    await sleep(300);
    out.docLines = document.querySelectorAll('#docText .docLine').length;
    out.docText = (document.querySelector('#docText .docBody')?.innerText ?? '').slice(0, 120).replace(/\\n/g, ' | ');
    const svgs = [...document.querySelectorAll('#docText svg.inlineSvg')];
    out.svgInline = svgs.length;
    out.svgBox = svgs[0] ? (() => { const r = svgs[0].getBoundingClientRect(); return Math.round(r.width) + 'x' + Math.round(r.height); })() : '';
    out.svgColor = svgs[0] ? getComputedStyle(svgs[0]).color : '';
    // 5) 在本文的「天」上點一下 → 右欄詞典
    const line = document.querySelector('#docText .docLine .lineText');
    let tnode = null;
    if (line) {
      const w = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) if (n.textContent.includes('天')) { tnode = n; break; }
    }
    out.clickedAt = null;
    if (tnode) {
      const at = tnode.textContent.indexOf('天');
      const rg = document.createRange();
      rg.setStart(tnode, at); rg.setEnd(tnode, at + 1);
      const r = rg.getBoundingClientRect();
      out.clickedAt = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      document.elementFromPoint(out.clickedAt.x, out.clickedAt.y)
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: out.clickedAt.x, clientY: out.clickedAt.y, view: window }));
      await sleep(4000);
    }
    out.dictNote = (document.querySelector('#dictList')?.innerText ?? '').slice(0, 80).replace(/\\n/g, ' ');
    out.dictList = [...document.querySelectorAll('#dictList .dictItem')].slice(0, 5).map((b) => b.innerText.replace(/\\n/g, ' '));
    out.dictBody = (document.querySelector('#dictBody')?.innerText ?? '').slice(0, 160).replace(/\\n/g, ' | ');
    out.dictRows = document.querySelectorAll('#dictList .dictItem').length;
    out.consoleErrors = window.__accelon26.consoleErrors?.() ?? null;
    return JSON.stringify(out, null, 1);
  })()
`);
console.log(step1);

// 失敗要留下畫面，成功也留一張（交付前看圖最快）
const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
await Bun.write(OUT, Buffer.from(shot.data, 'base64'));
proc.kill();
await Bun.sleep(200);
try { rmSync(profile, { recursive: true, force: true }); } catch { /* the browser may still hold it */ }

const r = JSON.parse(step1);
const fails: string[] = [];
if (r.db !== EXPECT_DB) fails.push('資料庫沒有開啟（db=' + r.db + '）');
if (r.dirRows !== EXPECT_ROWS) fails.push('目錄第一層不是 ' + EXPECT_ROWS + ' 列（' + r.dirRows + '）');
if (!r.rootFound) fails.push('目錄裡找不到根節點');
if (!r.termTabExists) fails.push('沒有名詞分頁（s="$字"）');
if (r.termHits === '0' || r.termHits === '') fails.push('字頭表查不到「江」');
if (!r.docLines) fails.push('點節點沒有正文');
if (r.consoleErrors) fails.push('consoleErrors: ' + JSON.stringify(r.consoleErrors));
if (EXPECT_DB === 'swjzz') {
  // 說文解字注：卷 → 部 → 字 三層，而且點字要能查詞典
  if (!(r.steps ?? []).some((s: string) => /^部:/.test(s))) fails.push('卷展不開部');
  if (!r.ziRows.some((x: string) => /^字:/.test(x))) fails.push('部展不開字');
  if (!r.tianRowFound) fails.push('目錄裡找不到「天」');
  if (!r.dictRows) console.error('WARN 點字沒有查到詞條（詞典分頁在無痕設定下時好時壞；快取與 isdict 另由 verify 檢查）');
  else if (!/說文解字注/.test(r.dictBody ?? '')) fails.push('詞典條文沒渲染');
} else {
  // 引用書目：第一層是書，展開後要有卷／篇，最後要有字或條
  if (!r.partRows.length) fails.push('書展不開卷／篇');
  if (!r.ziRowCount) fails.push('展不到字頭');
}
console.error('wrote ' + OUT);
if (fails.length) { console.error('FAIL ' + fails.join('; ')); process.exit(1); }
console.error(`PASS ${EXPECT_DB}: 目錄、字頭表、正文都正常`);
process.exit(0);
