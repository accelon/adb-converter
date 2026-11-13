#!/usr/bin/env bun
/**
 * 罕用字「系統字」涵蓋度實測（作者 2026-11-13 13:23：罕用字使用系統字、不放子集字型）。
 *
 *   bun run tools/glyph-fallback-test.ts [--adb ../accelon3/fuyan.adb]
 *                                       [--html D:/accelon3/accelon26.html]
 *                                       [--png build/glyph-38p8.png]
 *
 * 做法：同一個 Chromium（WebView2 同引擎）裡，用 fuyan 實際的兩個字體棧
 * （--ming 新細明體系、--kai 標楷體系）把字畫到 canvas，
 * 與「保證沒有字形」的 U+10FFFE 逐像素比對：
 *   指紋相同 → 該字在這個字體棧下是豆腐（無字形）
 *   指紋不同 → 有真字形
 * 另外量 measureText 寬度（豆腐常與缺字同寬、真字形多數不同）並截圖。
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
const ADB = resolve(opt('adb', resolve(ROOT, 'accelon3/fuyan.adb')));
const PNG = resolve(opt('png', resolve(ROOT, 'build/glyph-fallback.png')));

const RARE = [
  { ch: '㝹', blk: 'ExtA', where: '38p8, 38p55（阿㝹夷經）' },
  { ch: '㲲', blk: 'ExtA', where: '5p18, 9p260（觀㲲為青）' },
  { ch: '㲉', blk: 'ExtA', where: '9p294（皮㲉）' },
  { ch: '𤛓', blk: 'ExtB', where: '38p34（𤛓牛乳頃）' },
  { ch: '𨅖', blk: 'ExtB', where: '38p56, 38p304, 5p289（尊者𨅖陀）' },
  { ch: '𩑶', blk: 'ExtB', where: '5p132（頸下垂𩑶）' },
  { ch: '𩜁', blk: 'ExtB', where: '38p275（羯𩜁伽）' },
];

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const browser = BROWSERS.find((p) => existsSync(p));
if (!browser) { console.error('no Chromium browser found'); process.exit(2); }
for (const p of [HTML, ADB]) if (!existsSync(p)) { console.error('missing ' + p); process.exit(2); }

const profile = resolve(ROOT, 'build/.chrome-profile-glyph-' + process.pid);
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
        if (m.id && c.pending.has(m.id)) {
          const p = c.pending.get(m.id)!;
          c.pending.delete(m.id);
          m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
        }
      };
    });
    return c;
  }
  async send(method: string, params: Record<string, unknown> = {}, session = true): Promise<any> {
    const id = ++this.id;
    const payload: Record<string, unknown> = { id, method, params };
    if (session && this.sessionId) payload.sessionId = this.sessionId;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => { if (this.pending.delete(id)) rej(new Error('timeout ' + method)); }, 60000);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); res(v); },
        reject: (e) => { clearTimeout(timer); rej(e); },
      });
      this.ws.send(JSON.stringify(payload));
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

type Row = { ch: string; blk: string; where: string; ming: string; kai: string; mingW: number; refW: number };
const rows = await cdp.eval<Row[]>(`
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  document.querySelector('#aboutClose')?.click();
  const cs = getComputedStyle(document.documentElement);
  const ming = cs.getPropertyValue('--ming').trim() || 'serif';
  const kai = "'DFKai-SB', 'KaiTi', '楷體', serif";
  const cv = document.createElement('canvas'); cv.width = cv.height = 96;
  const cx = cv.getContext('2d');
  const sig = (font, ch) => {
    cx.clearRect(0, 0, 96, 96);
    cx.font = font; cx.textBaseline = 'top'; cx.fillStyle = '#000';
    cx.fillText(ch, 8, 8);
    const d = cx.getImageData(0, 0, 96, 96).data;
    let h = 2166136261, ink = 0;
    for (let i = 0; i < d.length; i += 4) { if (d[i + 3]) { ink++; h = ((h ^ i) * 16777619) >>> 0; } }
    return h + ':' + ink;
  };
  const NOTDEF = '\\u{10FFFE}';
  const out = [];
  for (const r of ${JSON.stringify(RARE)}) {
    const mRef = sig('64px ' + ming, NOTDEF), kRef = sig('64px ' + kai, NOTDEF);
    const m = sig('64px ' + ming, r.ch), k = sig('64px ' + kai, r.ch);
    out.push({ ch: r.ch, blk: r.blk, where: r.where,
      ming: m === mRef ? '豆腐' : '有字形', kai: k === kRef ? '豆腐' : '有字形',
      mingW: Math.round((() => { cx.font = '64px ' + ming; return cx.measureText(r.ch).width; })()),
      refW: Math.round((() => { cx.font = '64px ' + ming; return cx.measureText(NOTDEF).width; })()) });
  }
  // 實地：38p8 那一段的 computed font 與文字
  await window.__accelon26.openPage('fuyan', '38p8');
  await sleep(900);
  const body = document.querySelector('#docText .docBody');
  const hit = [...(body?.querySelectorAll('.lineText') ?? [])].find((e) => (e.textContent || '').includes('夷'));
  window.__glyphProbe = { font: hit ? getComputedStyle(hit).fontFamily : '', text: (hit?.textContent ?? '').slice(0, 60) };
  return out;
})()`);

console.log('字體棧 ming =', (await cdp.eval<string>(`getComputedStyle(document.documentElement).getPropertyValue('--ming').trim()`)));
console.log('比較基準 = U+10FFFE（保證無字形的非字符）\n');
console.log('字  區塊   明體     楷體    量寬/豆腐寬   出現處');
let bad = 0;
for (const r of rows) {
  if (r.ming === '豆腐' || r.kai === '豆腐') bad++;
  console.log(`${r.ch}  ${r.blk.padEnd(5)}  ${r.ming.padEnd(6)}  ${r.kai.padEnd(6)}  ${r.mingW}/${r.refW}${r.mingW === r.refW ? ' (=豆腐寬)' : ''}  ${r.where}`);
}
const probe = await cdp.eval<any>('window.__glyphProbe');
console.log('\n38p8 實地 lineText font =', probe.font);
console.log('38p8 實地 lineText 前 60 字 =', probe.text);

// 畫面層證據：把 7 個字用閱讀器同一個字體棧放大畫在頁面上，截圖人工可核
await cdp.eval(`(() => {
  const cs = getComputedStyle(document.documentElement);
  const ming = cs.getPropertyValue('--ming').trim().replace(/"/g, "'");
  const kai = "'DFKai-SB', 'KaiTi', '楷體'";
  const d = document.createElement('div');
  d.id = '__glyphStrip';
  d.style.cssText = 'position:fixed;left:0;top:0;z-index:99999;background:#fff;color:#000;padding:12px 16px;font-size:13px;line-height:1.7;border:2px solid #c00';
  d.innerHTML =
    '<div style="font-family:' + ming + ';font-size:44px">明體：㝹 㲲 㲉 𤛓 𨅖 𩑶 𩜁</div>' +
    '<div style="font-family:' + kai + ';font-size:44px">楷體：㝹 㲲 㲉 𤛓 𨅖 𩑶 𩜁</div>' +
    '<div style="font-size:11px;color:#666">上：--ming（新細明體系）　下：DFKai-SB／標楷體系</div>';
  document.body.appendChild(d);
})()`);
await Bun.sleep(300);
const rect = await cdp.eval<{ x: number; y: number; width: number; height: number }>(
  `(() => { const r = document.querySelector('#__glyphStrip').getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`,
);
const stripShot = await cdp.send('Page.captureScreenshot', {
  format: 'png',
  clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 2 },
});
await Bun.write(PNG.replace(/\.png$/, '-strip.png'), Buffer.from(stripShot.data, 'base64'));
console.log('字形對照條 →', PNG.replace(/\.png$/, '-strip.png'), JSON.stringify(rect));

const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
await Bun.write(PNG, Buffer.from(shot.data, 'base64'));
console.log('截圖 →', PNG);

console.log(`\n結論：${bad === 0 ? '全部有字形（系統字可接受）' : `${bad} 個字在明體或楷體棧下是豆腐`}`);
proc.kill();
process.exit(bad === 0 ? 0 : 1);
