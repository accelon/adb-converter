/** lc.adb ↔ taisho.adb 連結與回連結實機測試。 */
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const ROOT = resolve(import.meta.dir, '..');
const HTML = resolve(ROOT, 'build/accelon26.html');
const LC = resolve(ROOT, 'accelon3/lc.adb');
const TS = resolve('D:/accelon3/taisho.adb');
const browser = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find((p) => existsSync(p))!;
const profile = resolve(ROOT, 'build/.chrome-profile-lc');
rmSync(profile, { recursive: true, force: true });
const proc = Bun.spawn([browser, '--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', '--remote-allow-origins=*', '--allow-file-access-from-files', '--window-size=1500,950', `--user-data-dir=${profile}`, 'about:blank'], { stdout: 'pipe', stderr: 'pipe' });
async function devtoolsUrl(): Promise<string> {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const text = await Bun.file(resolve(profile, 'DevToolsActivePort')).text().catch(() => '');
    const [p, q] = text.split('\n').map((s) => s.trim());
    if (Number(p) > 0 && q) return `ws://127.0.0.1:${p}${q}`;
    await Bun.sleep(200);
  }
  throw new Error('no devtools');
}
class Cdp {
  ws!: WebSocket; id = 0; sessionId = '';
  pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  static async attach(url: string): Promise<Cdp> {
    const c = new Cdp();
    await new Promise<void>((res, rej) => {
      c.ws = new WebSocket(url); c.ws.onopen = () => res(); c.ws.onerror = () => rej(new Error('ws'));
      c.ws.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); if (m.id && c.pending.has(m.id)) { const p = c.pending.get(m.id)!; c.pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } };
    });
    return c;
  }
  async send(method: string, params: Record<string, unknown> = {}, session = true): Promise<any> {
    const id = ++this.id; const payload: Record<string, unknown> = { id, method, params };
    if (session && this.sessionId) payload.sessionId = this.sessionId;
    return new Promise((res, rej) => { this.pending.set(id, { resolve: res, reject: rej }); this.ws.send(JSON.stringify(payload)); setTimeout(() => { if (this.pending.delete(id)) rej(new Error('timeout ' + method)); }, 120000); });
  }
  async eval<T>(e: string): Promise<T> {
    const r = await this.send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval');
    return r.result.value as T;
  }
}
const cdp = await Cdp.attach(await devtoolsUrl());
const { targetId } = await cdp.send('Target.createTarget', { url: pathToFileURL(HTML).href + '?v=' + Date.now() }, false);
const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }, false);
cdp.sessionId = sessionId;
await cdp.send('Runtime.enable'); await cdp.send('Page.enable'); await cdp.send('DOM.enable');
await Bun.sleep(800);
const doc = await cdp.send('DOM.getDocument');
const q = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#file' });
await cdp.send('DOM.setFileInputFiles', { files: [LC, TS], nodeId: q.nodeId });
await cdp.eval('document.querySelector("#file").dispatchEvent(new Event("change"))');
for (let i = 0; i < 80; i++) { const n = await cdp.eval<number>('window.__accelon26?.state?.().dbs?.length ?? 0'); if (n >= 2) break; await Bun.sleep(400); }
await cdp.eval('document.querySelector("#aboutClose")?.click()');
await sleep(1200);
for (const key of ['呂澂', '大正']) {
  await cdp.eval(`(() => { const c = [...document.querySelectorAll('#dbTabs .dbChip')].find(x => x.textContent.includes(${JSON.stringify(key)})); c?.click(); })()`);
  await Bun.sleep(1200);
}
await cdp.eval(`(() => { const c = [...document.querySelectorAll('#dbTabs .dbChip')].find(x => x.textContent.includes('呂澂')); c?.click(); })()`);
await Bun.sleep(1000);
const hk = await cdp.eval<string>(`(() => {
  const fire = (alt) => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, altKey: alt, bubbles: true, cancelable: true }));
  const cols = () => window.__accelon26.state().cols;
  const before = cols();
  fire(false); const leftOff = cols();
  fire(false); const leftOn = cols();
  fire(true); const rightOff = cols();
  fire(true); const rightOn = cols();
  return JSON.stringify({ before, leftOff, leftOn, rightOff, rightOn, titles: [document.querySelector('#toggleLeft')?.title, document.querySelector('#toggleRight')?.title] });
})()`);
console.log('HOTKEY', hk);
const out = await cdp.eval<string>(`(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const res = {};
  const qi = document.querySelector('#query');
  qi.value = '觀察義禪'; qi.dispatchEvent(new Event('input'));
  await sleep(1500);
  res.hits = document.querySelectorAll('#searchList .snippet').length;
  document.querySelector('#searchList .snippet')?.click();
  await sleep(1500);
  const a = document.querySelector('#docText a.xrefLink');
  res.link = a?.dataset.xref; res.around = a?.parentElement?.textContent?.slice(0, 80);
  a?.scrollIntoView({ block: 'center' }); await sleep(200);
  a?.click(); await sleep(2000);
  res.right = document.querySelector('#textBody')?.textContent?.slice(0, 120);
  res.bar = document.querySelector('#textBody .xrefRevBar')?.textContent?.slice(0, 120);
  res.marks = document.querySelectorAll('#textBody mark.xrefHit').length;
  res.mid = document.querySelector('#docText .docBody')?.innerText?.slice(0, 50);
  const order = () => [...document.querySelectorAll('#textBody .xrefRev:not(.is-hidden) .revLabel')].map(x => x.textContent).join(' | ');
  document.querySelector('#textBody [data-revsort="src"]')?.click(); await sleep(300);
  res.orderSrc = order();
  document.querySelector('#textBody [data-revsort="host"]')?.click(); await sleep(300);
  res.orderHost = order();
  document.querySelector('#textBody [data-revsort="freq"]')?.click(); await sleep(300);
  res.orderFreq = order();
  document.querySelector('#textBody [data-revheat]')?.click(); await sleep(2500);
  res.heatTab = document.querySelector('#colRight .tabBtn.active')?.dataset.tab;
  res.heatTitle = document.querySelector('#heatBody .heatMini') ? '縮圖' : '';
  res.heatSub = document.querySelector('#heatStats')?.textContent;
  res.heatMiniCells = document.querySelectorAll('#heatBody .heatMini .hgCell').length;
  res.heatFullHidden = document.querySelector('#heatFull')?.hidden;
  const miniCell = [...document.querySelectorAll('#heatBody .heatMini .hgCell')].find(x => { const t = x.getAttribute('title') || ''; return t && !t.endsWith('0 條'); });
  miniCell?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await sleep(1500);
  res.heatDetail = document.querySelector('#heatDetail')?.textContent?.slice(0, 120);
  res.heatDetailRows = document.querySelectorAll('#heatDetail .revListRow').length;
  res.helpCount = document.querySelector('#heatHelp')?.textContent;
  document.querySelector('#heatNorm [data-norm="row"]')?.click(); await sleep(1000);
  res.helpRow = document.querySelector('#heatHelp')?.textContent;
  document.querySelector('#heatNorm [data-norm="count"]')?.click(); await sleep(800);
  document.querySelector('#heatFullBtn')?.click();
  await sleep(1200);
  res.heatFullRows = document.querySelectorAll('#heatFull .hgRow').length;
  res.heatFullSticky = getComputedStyle(document.querySelector('#heatFull .hgRow')).position;
  document.querySelector('#heatFullBtn')?.click();
  res.heatTop = document.querySelector('#heatBody')?.textContent?.slice(0, 160);
  return JSON.stringify(res);
})()`);
console.log(out);
const heatShot = await cdp.send('Page.captureScreenshot', { format: 'png' });
await Bun.write(resolve(ROOT, 'build/lc-heat.png'), Buffer.from(heatShot.data, 'base64'));
await cdp.eval('document.querySelector("#colRight .tabBtn[data-tab=\\"text\\"]")?.click()');
await sleep(400);
const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
await Bun.write(resolve(ROOT, 'build/lc-link.png'), Buffer.from(shot.data, 'base64'));
const bm = await cdp.eval<string>(`(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const selectText = () => {
    const line = document.querySelector('#docText .docLine .lineText') || document.querySelector('#docText .docLine');
    if (!line) return false;
    const node = [...line.childNodes].find(n => n.nodeType === 3) || line.firstChild;
    const sel = window.getSelection(); sel.removeAllRanges();
    const range = document.createRange(); range.setStart(node, 0); range.setEnd(node, Math.min(8, node.textContent.length));
    sel.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    return true;
  };
  if (!selectText()) return JSON.stringify({ error: 'no line' });
  await sleep(300);
  const menu = document.querySelector('#selMenu');
  const citation = await window.__accelon26.citationForSelection();
  const sutra = await window.__accelon26.sutraLookup('金剛經');
  const buttons = menu ? [...menu.querySelectorAll('button')].map(x => x.textContent) : [];
  menu?.querySelector('[data-sel="search"]')?.click();
  await sleep(500);
  const searchState = { active: document.querySelector('#colLeft .tabBtn.active')?.dataset.tab, value: document.querySelector('#colLeft .tabPane.active input[type=search]')?.value };
  selectText(); await sleep(300);
  document.querySelector('#selMenu [data-sel="dict"]')?.click();
  await sleep(1400);
  const dictState = { tab: document.querySelector('#colRight .tabBtn.active')?.dataset.tab, text: document.querySelector('#dictList')?.textContent?.slice(0, 80) };
  selectText(); await sleep(300);
  document.querySelector('#selMenu [data-sel="bookmark"]')?.click();
  await sleep(300);
  window.__accelon26.showTab('bookmark', 'left');
  await sleep(300);
  const state = window.__accelon26.bookmarkState();
  const rows = [...document.querySelectorAll('#bookmarkList .bmRow')].map(x => x.textContent?.slice(0, 80));
  window.__accelon26.showTab('jump', 'left');
  await sleep(200);
  const qi = document.querySelector('#jumpQuery'); qi.value = citation || ''; qi.dispatchEvent(new Event('input'));
  await sleep(900);
  const jumpMeta = document.querySelector('#jumpMeta')?.textContent;
  const jumpRows = document.querySelectorAll('#jumpList .snippet').length;
  qi.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await sleep(1800);
  const jumpedPage = document.querySelector('#docText .pageMark[data-page], #docText .pageBreak[data-page]')?.dataset.page;
  const jumpedTarget = !!document.querySelector('#docText [data-page="2p0538a"]');
  return JSON.stringify({ buttons, citation, sutra, searchState, dictState, state, rows, jumpMeta, jumpRows, jumpedPage, jumpedTarget });
})()`);
console.log('BM', bm);
const sut = await cdp.eval<string>(`(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const lines = [...document.querySelectorAll('#docText .docLine')];
  let line = null, node = null, at = -1;
  for (const l of lines) {
    const w = document.createTreeWalker(l, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) {
      const i = (n.textContent || '').indexOf('金剛經');
      if (i >= 0) { line = l; node = n; at = i; break; }
    }
    if (node) break;
  }
  if (!node) {
    const l = document.querySelector('#docText .docLine');
    if (!l) return JSON.stringify({ found: false });
    const span = document.createElement('span');
    span.textContent = '《金剛經》';
    l.appendChild(span);
    node = span.firstChild;
    at = 0;
  }
  const sel = window.getSelection(); sel.removeAllRanges();
  const range = document.createRange(); range.setStart(node, at); range.setEnd(node, at + (node.textContent || '').length); sel.addRange(range);
  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
  await sleep(1500);
  const btn = document.querySelector('#selMenu [data-sel="sutra"]');
  const out = { found: true, hidden: btn?.hidden, text: btn?.textContent, rightBefore: document.querySelector('#colRight .tabBtn.active')?.dataset.tab };
  btn?.click();
  await sleep(1200);
  return JSON.stringify({ ...out, rightAfter: document.querySelector('#colRight .tabBtn.active')?.dataset.tab, rightTitle: document.querySelector('#textBody')?.textContent?.slice(0, 100) });
})()`);
console.log('SUT', sut);
proc.kill();
process.exit(0);
function sleep(ms: number) { return Bun.sleep(ms); }


