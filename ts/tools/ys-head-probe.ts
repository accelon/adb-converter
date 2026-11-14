#!/usr/bin/env bun
/**
 * kai-probe.ts — 驗「注文裡的引文是不是真的顯示成楷體」（厚觀法師 2026-11-14 第一項）
 *
 *   bun run ts/tools/kai-probe.ts --adb D:/2026/fuyan/out/fuyan.adb
 *
 * 只看畫面層：打開 5p298，跳到注 9 那一行，量「能取」所在 span 的 computed
 * font-family 有沒有楷體，同時數整頁的 .fmt-kai / .quote。
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => {
  const i = args.indexOf('--' + n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const ROOT = resolve(import.meta.dir, '../..');
const HTML = resolve(opt('html', 'D:/accelon3/accelon26.html'));
const ADB = resolve(opt('adb', 'D:/2026/fuyan/out/fuyan.adb'));



const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const browser = BROWSERS.find((p) => existsSync(p));
if (!browser) { console.error('no Chromium browser'); process.exit(2); }
for (const p of [HTML, ADB]) if (!existsSync(p)) { console.error('missing ' + p); process.exit(2); }

const profile = resolve(ROOT, 'build/.chrome-profile-cp' + process.pid);
const proc = Bun.spawn([browser, '--headless=new', '--disable-gpu', '--no-first-run',
  '--remote-debugging-port=0', '--remote-allow-origins=*', '--allow-file-access-from-files',
  '--window-size=1400,1000', `--user-data-dir=${profile}`, 'about:blank'],
  { stdout: 'pipe', stderr: 'pipe' });

async function devtoolsUrl(): Promise<string> {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const text = await Bun.file(resolve(profile, 'DevToolsActivePort')).text().catch(() => '');
    const [portLine, pathLine] = text.split('\n').map((s) => s.trim());
    if (Number(portLine) > 0 && pathLine) return `ws://127.0.0.1:${portLine}${pathLine}`;
    await Bun.sleep(200);
  }
  throw new Error('no devtools');
}

let ws!: WebSocket;
let id = 0;
const pending = new Map<number, (v: any) => void>();
let sessionId = '';
const errors: string[] = [];

ws = new WebSocket(await devtoolsUrl());
await new Promise<void>((res) => { ws.onopen = () => res(); });
ws.onmessage = (ev) => {
  const m = JSON.parse(String(ev.data));
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params?.exceptionDetails?.exception?.description ?? 'exception');
  if (m.id && pending.has(m.id)) { const f = pending.get(m.id)!; pending.delete(m.id); f(m.result ?? m); }
};
function send(method: string, params: Record<string, unknown> = {}, session = true): Promise<any> {
  const n = ++id;
  return new Promise((res) => {
    pending.set(n, res);
    const payload: Record<string, unknown> = { id: n, method, params };
    if (session && sessionId) payload.sessionId = sessionId;
    ws.send(JSON.stringify(payload));
  });
}
const { targetId } = await send('Target.createTarget', { url: 'about:blank' }, false);
const att = await send('Target.attachToTarget', { targetId, flatten: true }, false);
sessionId = att.sessionId;
await send('Runtime.enable');
await send('DOM.enable');
await send('Page.navigate', { url: pathToFileURL(HTML).href + '?v=' + Date.now() });
await Bun.sleep(1200);

const doc = await send('DOM.getDocument');
const q = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#file' });
await send('DOM.setFileInputFiles', { files: [ADB], nodeId: q.nodeId });
await send('Runtime.evaluate', { expression: 'document.querySelector("#file").dispatchEvent(new Event("change"))' });
await Bun.sleep(2500);
await send('Runtime.evaluate', { expression: `document.querySelector('#aboutClose')?.click()` });

async function ev<T>(expression: string): Promise<T> {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 200));
  return r.result.value as T;
}


const dump = async (page: string, keys: string[]) => {
  await ev(`(async () => { await window.__accelon26.openPage('ys','${page}',''); await new Promise(r=>setTimeout(r,800)); })()`);
  const r = await ev<any>(`
  (() => {
    const keys = ${JSON.stringify(keys)};
    const lines = [...document.querySelectorAll('#docText .docLine')];
    const out = [];
    for (const k of keys) {
      const line = lines.find(l => (l.textContent||'').includes(k));
      if (!line) { out.push({ k, miss: true }); continue; }
      const h = line.querySelector('span.h');
      const st = h ? getComputedStyle(h) : null;
      out.push({
        k,
        text: (line.textContent||'').trim().slice(0, 40),
        nH: line.querySelectorAll('span.h').length,
        tag: h && h.getAttribute('data-tag'),
        depth: h && h.getAttribute('data-depth'),
        up: h && h.getAttribute('data-up'),
        cls: h && h.className,
        style: h && h.getAttribute('style'),
        color: st && st.color,
        size: st && st.fontSize,
        weight: st && st.fontWeight,
        docLineCls: line.className,
        html: line.innerHTML.slice(0, 220),
      });
    }
    // 圖：同一頁所有 svg
    const svgs = [...document.querySelectorAll('#docText svg')].map(s => {
      const b = s.getBoundingClientRect();
      const pl = s.closest('.docLine');
      return { cls: s.getAttribute('class'), label: s.getAttribute('aria-label'),
               w: Math.round(b.width), h: Math.round(b.height), x: Math.round(b.x), y: Math.round(b.y),
               inLine: !!pl, lineText: pl ? (pl.textContent||'').slice(-20) : null,
               parentCls: s.parentElement && s.parentElement.className };
    });
    return { lines: lines.length, out, svgs };
  })()`);
  console.log('\n=== ' + page + ' ===');
  for (const o of r.out) console.log(JSON.stringify(o));
  for (const s of r.svgs) console.log('svg', JSON.stringify(s));
  return r;
};


await ev(`(async () => { await window.__accelon26.openPage('ys','6p1a',''); await new Promise(r=>setTimeout(r,800)); })()`);
const trees = await ev<any>(`window.__accelon26.treesInfo()`);
console.log('trees', JSON.stringify(trees));
const snap = await ev<any>(`(() => { try { const t = window.__accelon26.treeSnapshot(); return { n: t.length, first: t.slice(0, 14) }; } catch (e) { return { error: String(e) }; } })()`);
console.log('treeSnapshot', JSON.stringify(snap));
const tagset = await ev<any>(`(() => { try { const t = window.__accelon26.treeSnapshot(); const m = {}; for (const x of t) { m[x.tag] = m[x.tag] || { n: 0, d: new Set() }; m[x.tag].n++; m[x.tag].d.add(x.depth); } const o = {}; for (const k in m) o[k] = { n: m[k].n, depths: [...m[k].d].sort((a,b)=>a-b) }; return o; } catch (e) { return { error: String(e) }; } })()`);
console.log('tree tags', JSON.stringify(tagset));

await dump('6p1a', ['攝大乘論講記', '懸論', '一 釋題', '二 本論與釋論及翻譯']);
await dump('3p20a', ['正釋', '甲一 序分', '乙一 證信序']);
await dump('1p18a', ['三 敘傳譯', '發心菩提', '般若道']);
const figInfo = await ev<any>(`(async () => {
  const svg = [...document.querySelectorAll('#docText svg.figureSvg')][0];
  const ln = svg && svg.closest('.docLine');
  if (svg) svg.scrollIntoView({ block: 'center' });
  await new Promise(r=>setTimeout(r,600));
  const s2 = svg ? svg.getBoundingClientRect() : null;
  const l2 = ln ? ln.getBoundingClientRect() : null;
  const st = svg ? getComputedStyle(svg) : null;
  const disp = st ? { display: st.display, float: st.float, position: st.position, verticalAlign: st.verticalAlign, height: st.height, width: st.width } : null;
  return { lineRect: l2 && { y: Math.round(l2.y), h: Math.round(l2.height), w: Math.round(l2.width) }, svgRect: s2 && { y: Math.round(s2.y), h: Math.round(s2.height), x: Math.round(s2.x), w: Math.round(s2.width) }, disp, lineCls: ln && ln.className, inner: ln && ln.innerHTML.slice(0,300) };
})()`);
console.log('FIG', JSON.stringify(figInfo));
const shot = await send('Page.captureScreenshot', { format: 'png' });
await Bun.write('D:/2026/ys/build/ys-probe-fig.png', Buffer.from(shot.data, 'base64'));
if (errors.length) console.log('JS 例外', errors.length, errors[0]?.split('\\n')[0]);
proc.kill();
process.exit(0);
