#!/usr/bin/env bun
/**
 * fuyan-font-probe.ts — 厚觀法師 2026-11-14 16:32（UID 213）
 *
 *   01 腳注 27（2）的句號為什麼落到下一行（原書是不是這樣）
 *   02 梵文、英文、數字用的是什麼字體（法師看到 Cambria）
 *
 *   bun run ts/tools/fuyan-font-probe.ts --adb D:/2026/fuyan/out/fuyan.adb
 *
 * 看三件事：
 *   (1) 梵文行在畫面上實際用哪個字族（CDP CSS.getPlatformFontsForNode：字形數）
 *   (2) 那幾行在資料裡是怎麼斷的（data-src）、畫面斷在哪
 *   (3) 「引用複製」對這一段的輸出（是否仍有 bhav｜et、空格消失）
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
const PAGE = opt('page', '5p514');

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const browser = BROWSERS.find((p) => existsSync(p));
if (!browser) { console.error('no Chromium browser'); process.exit(2); }
for (const p of [HTML, ADB]) if (!existsSync(p)) { console.error('missing ' + p); process.exit(2); }

const profile = resolve(ROOT, 'build/.chrome-profile-fp' + process.pid);
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
await send('CSS.enable');
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
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result.value as T;
}

await ev(`(async () => { await window.__accelon26.openPage('fuyan','${PAGE}',''); await new Promise(r=>setTimeout(r,900)); await window.__accelon26.showLine(${opt('line', '37237')}); await new Promise(r=>setTimeout(r,700)); })()`);

// 找梵文那幾行（含 saṃgho／abhāvāc 的在 5p514；5p298 用 bhavet）
const found = await ev<any>(`
(() => {
  const lines = [...document.querySelectorAll('#docText .docLine')];
  const pick = (needle) => {
    const l = lines.find(x => (x.textContent||'').includes(needle));
    return l ? { id: l.id, t: (l.textContent||'').slice(0, 70), src: (l.getAttribute('data-src')||'').slice(0, 120),
                 ff: getComputedStyle(l).fontFamily } : null;
  };
  return {
    n: lines.length,
    body: getComputedStyle(document.querySelector('#docText .docBody') || document.body).fontFamily,
    sanskrit: pick('saṃgho') || pick('upādānād'),
    second: pick('ṣapudgalāḥ') || pick('vidy'),
    dotLine: pick('。'),
  };
})()`);
console.log('行數', found.n);
console.log('body font-family:', found.body);
for (const k of ['sanskrit', 'second', 'dotLine']) {
  const v = (found as any)[k];
  if (!v) { console.log(k, 'null'); continue; }
  console.log(k, '|', v.id, '|', v.t, '|', v.src, '|', v.ff);
}

const dump = await ev<any>(`
(() => {
  const el = document.querySelector('#L37246');
  if (!el) return { err: 'no el' };
  const spans = [...el.querySelectorAll('*')].slice(0, 8).map(x => ({
    tag: x.tagName, cls: x.className, txt: (x.textContent||'').slice(0, 20),
    ff: getComputedStyle(x).fontFamily.slice(0, 60),
    w: Math.round(x.getBoundingClientRect().width),
  }));
  const lt = el.querySelector('.lineText');
  return { html: el.innerHTML.slice(0, 400), spans,
           ltStyle: lt ? { ta: getComputedStyle(lt).textAlign, ws: getComputedStyle(lt).whiteSpace, ff: getComputedStyle(lt).fontFamily.slice(0,50) } : null,
           elStyle: { ta: getComputedStyle(el).textAlign, js: getComputedStyle(el).justifyContent, w: Math.round(el.getBoundingClientRect().width), sw: el.scrollWidth } };
})()`);
console.log('DUMP', JSON.stringify(dump, null, 1));

// 真實渲染字族（字形數）
for (const k of ['sanskrit', 'second'] as const) {
  const v = (found as any)[k];
  if (!v) continue;
  const nid = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: `#${v.id}` });
  const pf = await send('CSS.getPlatformFontsForNode', { nodeId: nid.nodeId });
  console.log('實際字形', k, JSON.stringify((pf.fonts || []).map((f: any) => [f.familyName, f.glyphCount])));
}

// 引用複製：選梵文那一段
const selInfo = await ev<any>(`
(() => {
  const lines = [...document.querySelectorAll('#docText .docLine')];
  const i0 = lines.findIndex(l => (l.getAttribute('data-src')||'').includes('saṃgho'));
  if (i0 < 0) return { err: 'no saṃgho' };
  let i1 = i0;
  while (i1 + 1 < lines.length && !(lines[i1+1].getAttribute('data-src')||'').startsWith('<段界/>')) i1++;
  const a = document.createTreeWalker(lines[i0], NodeFilter.SHOW_TEXT).nextNode();
  const w = document.createTreeWalker(lines[i1], NodeFilter.SHOW_TEXT);
  let last = null, n; while ((n = w.nextNode())) last = n;
  if (!a || !last) return { err: 'no text node' };
  const r = document.createRange();
  r.setStart(a, 0); r.setEnd(last, (last.nodeValue||'').length);
  const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
  return { i0, i1, lines: i1 - i0 + 1 };
})()`);
console.log('選取', JSON.stringify(selInfo));
const dbg = await ev<any>(`(async () => { try { return await window.__accelon26.citationDebug(); } catch (e) { return { error: String(e) }; } })()`);
if (dbg && dbg.text) {
  console.log('--- 引用複製輸出 ---');
  console.log(JSON.stringify(dbg.text));
  const t = String(dbg.text);
  console.log('--- 檢查 ---');
  console.log((/puruṣapudgalāḥ/.test(t) ? 'ok   ' : 'FAIL ') + 'puruṣapudgalāḥ 接回');
  console.log((/vidyate/.test(t) ? 'ok   ' : 'FAIL ') + 'vidyate 接回');
  console.log((/na vidyate/.test(t) ? 'ok   ' : 'FAIL ') + 'na 與 vidyate 之間的空白保留');
  console.log((/\n/.test(t) ? 'info ' : 'info ') + '換行數 ' + (t.match(/\n/g) || []).length);
} else {
  console.log('citationDebug', JSON.stringify(dbg).slice(0, 400));
}

await ev(`(() => { const el = document.querySelector('#L${opt('line','37237')}'); if (el) el.scrollIntoView({ block: 'center' }); })()`);
await Bun.sleep(500);
const shot = await send('Page.captureScreenshot', { format: 'png' });
await Bun.write(`D:/2026/fuyan/build/font-${PAGE}.png`, Buffer.from(shot.data, 'base64'));
console.log('截圖 build/font-' + PAGE + '.png');
if (errors.length) console.log('JS 例外', errors.length, errors[0]?.split('\n')[0]);
proc.kill();
process.exit(0);
