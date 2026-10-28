#!/usr/bin/env bun
/**
 * Smoke probe for an .adb, in the real viewer: open build/accelon26.html from
 * file://, hand it the database through the file input, then drive the panes
 * the way a reader would and print what came out.
 *
 *   bun run tools/probe-adb.ts [--adb build/lunyu.adb] [--query 仁]
 *                              [--out build/probe.png] [--shots 2]
 *
 * What it answers (in one JSON report):
 *   - did the header load (db, tokens, documents)
 *   - does the 目錄 tree show labelled rows, and how long did it take
 *   - opening a node: does the document pane render text? how many 聯 links?
 *   - clicking a 聯 link: does it land on the linked entry?
 *   - does any page render inline <圖> images?
 *   - searching: hit count, snippets, and whether any snippet leaks markup
 *
 * Exit code 1 when a check that must hold fails (tree empty, no document text).
 */
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
/** defaults live in the repo root, so the tool works from `ts/` or the root */
const ROOT = resolve(import.meta.dir, '../..');
const pick = (n: string, dflt: string) => (args.includes('--' + n) ? resolve(opt(n, dflt)) : resolve(ROOT, dflt));
const HTML = pick('html', 'build/accelon26.html');
const ADB = pick('adb', 'build/lunyu.adb');
const OUT = pick('out', 'build/probe.png');
const QUERY = opt('query', '仁');
const SHOTS = Number(opt('shots', '2'));

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const browser = BROWSERS.find((p) => existsSync(p));
if (!browser) { console.error('no Chromium browser found'); process.exit(2); }
for (const p of [HTML, ADB]) if (!existsSync(p)) { console.error('missing ' + p); process.exit(2); }

const profile = resolve(ROOT, 'build/.chrome-profile-probe-' + process.pid);
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
        if (m.id && c.pending.has(m.id)) { const p = c.pending.get(m.id)!; c.pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
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

// ---- tree, first node, 聯 jump
const step1 = await cdp.eval<string>(`
  (async () => {
    const wait = async (fn, n = 100) => { for (let i = 0; i < n; i++) { if (fn()) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    document.querySelector('#aboutClose')?.click();
    const out = {};
    const st = window.__accelon26.state();
    out.db = st.db; out.dbcname = st.dbcname ?? null; out.tokens = st.tokens; out.docs = st.docs;
    out.dirRows = st.dirRows; out.treePhases = st.treePhases; out.leftTabs = st.leftTab;
    const rows = () => [...document.querySelectorAll('#dirTree .tRow')];
    out.tree = rows().slice(0, 6).map((r) => (r.querySelector('.tTag')?.textContent ?? '') + ':' + (r.querySelector('.tName')?.textContent ?? ''));
    out.treeSnapshot = window.__accelon26?.treeSnapshot?.('勝鬘') ?? null;
    // open the first node that has a link action
    const first = rows().find((r) => r.querySelector('.tDot')) ?? rows()[0];
    (first?.querySelector('.tDot') ?? first)?.click();
    await wait(() => document.querySelectorAll('#docText .docLine').length > 0, 60);
    out.opened = first?.querySelector('.tName')?.textContent ?? '';
    out.trail = (document.querySelector('#docText .docTrail')?.innerText ?? '').replace(/\\n/g, ' ').slice(0, 80);
    out.docLines = document.querySelectorAll('#docText .docLine').length;
    out.docText = (document.querySelector('#docText .docBody')?.innerText ?? '').slice(0, 120).replace(/\\n/g, ' | ');
    const links = [...document.querySelectorAll('#docText a.entryLink')];
    out.entryLinks = links.length;
    out.firstLinks = links.slice(0, 6).map((a) => a.textContent);
    if (links.length) {
      out.linkTarget = links[0].dataset.entry;
      links[0].click();
      await sleep(700);
      await wait(() => !/^$/.test(document.querySelector('#docText .docBody')?.innerText ?? ''), 40);
      out.afterLinkTrail = (document.querySelector('#docText .docTrail')?.innerText ?? '').replace(/\\n/g, ' ').slice(0, 80);
      out.afterLinkText = (document.querySelector('#docText .docBody')?.innerText ?? '').slice(0, 80).replace(/\\n/g, ' | ');
      out.linkJumped = out.afterLinkTrail !== out.trail;
    }
    return JSON.stringify(out, null, 1);
  })()
`);
console.log('step1', step1);
let shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
await Bun.write(OUT, Buffer.from(shot.data, 'base64'));

// ---- find a page with inline images, then search
const step2 = await cdp.eval<string>(`
  (async () => {
    const wait = async (fn, n = 100) => { for (let i = 0; i < n; i++) { if (fn()) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const out = {};
    const rows = () => [...document.querySelectorAll('#dirTree .tRow')];
    const visibleImgs = () => [...document.querySelectorAll('#docText img.inlineImg')]
      .filter((im) => im.offsetParent !== null && im.getBoundingClientRect().height > 0);
    out.imgsOnOpenedPage = visibleImgs().length;
    // walk the tree until a page shows an inline image (up to 40 nodes)
    const roots = rows().filter((r) => r.querySelector('.tTwisty'));
    let clicks = 0;
    outer: for (const root of roots) {
      if (clicks > 40) break;
      root.querySelector('.tTwisty')?.click();
      await sleep(200);
      const kids = rows().filter((r) => r.querySelector('.tDot') && r !== root);
      for (const kid of kids.slice(-6)) {
        if (clicks++ > 40) break outer;
        kid.querySelector('.tDot')?.click();
        await sleep(350);
        if (visibleImgs().length) break outer;
      }
    }
    const imgs = visibleImgs();
    out.inlineImgs = imgs.length;
    out.imgLine = imgs[0]?.closest('.docLine')?.innerText?.slice(0, 60) ?? '';
    out.imgHeight = imgs[0]?.getBoundingClientRect().height.toFixed(1) ?? '';
    out.imgPageTrail = (document.querySelector('#docText .docTrail')?.innerText ?? '').replace(/\\n/g, ' ').slice(0, 60);
    const qi = document.querySelector('#query');
    if (qi) { qi.value = ${JSON.stringify(QUERY)}; qi.dispatchEvent(new Event('input')); }
    await wait(() => document.querySelectorAll('#searchList .snippet').length > 0, 60);
    const st = window.__accelon26.state();
    out.query = ${JSON.stringify(QUERY)};
    out.hits = st.hitTotal;
    out.summaryHead = (document.querySelector('#searchMeta')?.innerText ?? '').slice(0, 90);
    const snippets = [...document.querySelectorAll('#searchList .snippet')];
    out.snippetCount = snippets.length;
    out.snippetLeak = snippets.filter((s) => /(聯|圖|章|篇|字) [a-z]+="/.test(s.innerText) || /<\\/?\\w/.test(s.innerText)).length;
    out.snippets = snippets.slice(0, 3).map((s) => s.innerText.slice(0, 44));
    out.consoleErrors = window.__accelon26.consoleErrors?.() ?? null;
    return JSON.stringify(out, null, 1);
  })()
`);
console.log('step2', step2);
if (SHOTS > 1) {
  shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  await Bun.write(OUT.replace(/\.png$/, '-2.png'), Buffer.from(shot.data, 'base64'));
}
console.log('wrote', OUT + (SHOTS > 1 ? ' / ' + OUT.replace(/\.png$/, '-2.png') : ''));
proc.kill();
await Bun.sleep(200);
try { rmSync(profile, { recursive: true, force: true }); } catch { /* the browser may still hold it */ }

const fails: string[] = [];
const s1 = JSON.parse(step1);
const s2 = JSON.parse(step2);
if (!s1.db) fails.push('database did not open');
if (s1.dirRows === 0) fails.push('directory tree is empty');
if (!s1.docLines) fails.push('a node did not render any document text');
if (s2.snippetLeak > 0) fails.push(`${s2.snippetLeak} snippet(s) leak markup`);
if (fails.length) { console.error('FAIL ' + fails.join('; ')); process.exit(1); }
process.exit(0);


