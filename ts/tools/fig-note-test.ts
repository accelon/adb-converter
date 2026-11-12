#!/usr/bin/env bun
/**
 * 圖上注號的實機驗收（厚觀法師 2026-11-12 12:49）。
 *
 *   bun run tools/fig-note-test.ts [--adb ../accelon3/fuyan.adb]
 *                                 [--html D:/accelon3/accelon26.html]
 *                                 [--png build/fig-note.png]
 *
 * 驗四件事，缺一不可：
 *   1. 圖（SVG）裡真的有注號 `a.noteRef[data-note]`，而且在圖的框內
 *   2. 圖前那一列 `[13][14]…` 已經收起來（`.noteRefsMerged`，看不到但還在 DOM）
 *   3. 點圖上的注號 → 跳到釋文（`.noteTarget` 那一列的文字就是那條釋）
 *   4. 點釋文的編號 → 跳回圖，圖上那個號有 `.noteTargetMark`
 *
 * 任何一項不成立就 exit 1。
 */
import { existsSync, rmSync } from 'node:fs';
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
const PNG = resolve(opt('png', resolve(ROOT, 'build/fig-note.png')));
const PAGE = opt('page', '38p35');
const LINE = Number(opt('line', '0'));
const NOTE = opt('note', '13');

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const browser = BROWSERS.find((p) => existsSync(p));
if (!browser) { console.error('no Chromium browser found'); process.exit(2); }
for (const p of [HTML, ADB]) if (!existsSync(p)) { console.error('missing ' + p); process.exit(2); }

const profile = resolve(ROOT, 'build/.chrome-profile-fignote-' + process.pid);
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

const report = await cdp.eval<string>(`
  (async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const wait = async (fn, n = 80) => { for (let i = 0; i < n; i++) { if (fn()) return true; await sleep(100); } return false; };
    const out = { page: ${JSON.stringify(PAGE)}, note: ${JSON.stringify(NOTE)} };
    document.querySelector('#aboutClose')?.click();
    if (${LINE} > 0) { await window.__accelon26.showLine(${LINE}); out.page = 'L' + ${LINE}; }
    else await window.__accelon26.openPage('fuyan', out.page);
    await sleep(900);
    const body = document.querySelector('#docText .docBody');
    // 一頁可能有兩張圖（表格＋別的插圖）：挑「有這個注號」的那張
    const svgs = [...body.querySelectorAll('svg.inlineSvg')];
    const svg = svgs.find((s) => s.querySelector('a.noteRef[data-note="' + ${JSON.stringify(NOTE)} + '"]'))
      || svgs.find((s) => s.querySelector('a.noteRef')) || svgs[0] || null;
    out.svgCount = svgs.length;
    out.hasSvg = !!svg;
    out.pageHead = (body?.innerText ?? '').replace(/\\s+/g, ' ').slice(0, 120);
    out.markers = [...(svg?.querySelectorAll('a.noteRef') ?? [])].map((a) => ({
      n: a.dataset.note,
      text: a.textContent,
      box: (() => { const r = a.getBoundingClientRect(); const s = svg.getBoundingClientRect(); return { x: +(r.x - s.x).toFixed(1), y: +(r.y - s.y).toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) }; })(),
      inSvg: (() => { const r = a.getBoundingClientRect(); const s = svg.getBoundingClientRect(); return r.left >= s.left - 1 && r.right <= s.right + 1 && r.top >= s.top - 1 && r.bottom <= s.bottom + 1; })(),
    }));
    // 圖前那一列注號：應該收起來但還在 DOM
    const hidden = [...document.querySelectorAll('#docText .docLine.noteRefsMerged')];
    out.hiddenRows = hidden.map((el) => ({ id: el.id, text: el.textContent.trim().slice(0, 30), shown: el.getClientRects().length > 0 }));
    out.visibleNoteRows = [...document.querySelectorAll('#docText .docLine')]
      .filter((el) => /^\\s*(\\[\\d+\\]\\s*)+$/.test(el.textContent || ''))
      .map((el) => ({ id: el.id, text: el.textContent.trim().slice(0, 24) }));
    // 1) 點圖上的注號 → 釋文
    const mark = [...(svg?.querySelectorAll('a.noteRef') ?? [])].find((a) => a.dataset.note === out.note);
    out.markFound = !!mark;
    if (mark) {
      mark.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await sleep(300);
      // 點圖上的注號不可以順便打開「看圖」視窗（document 上還有另一個點圖監聽）
      out.zoomOpened = !(document.querySelector('#imgView')?.hidden ?? true);
      document.querySelector('#imgViewClose')?.click();
      await wait(() => document.querySelector('#docText .noteTarget'), 60);
      await sleep(400);
      const target = document.querySelector('#docText .noteTarget');
      out.targetText = (target?.innerText ?? '').replace(/\\s+/g, ' ').slice(0, 60);
      out.targetIsNoteBody = !!target?.querySelector('.noteBody');
      out.fwdRow = target?.id ?? '';
    }
    // 2) 點釋文的編號 → 回圖
    const back = document.querySelector('#docText .noteTarget a.noteBack');
    out.backFound = !!back;
    if (back) {
      back.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await sleep(900);
      const marked = [...document.querySelectorAll('svg a.noteRef.noteTargetMark')].map((a) => a.dataset.note);
      out.backMarked = marked;
      out.backIds = [...document.querySelectorAll('#docText .noteTarget')].map((e) => e.id);
      out.backHash = location.hash;
      out.backPageText = (document.querySelector('#docText .docBody')?.innerText ?? '').slice(0, 40).replace(/\\s+/g, ' ');
      out.status = (document.querySelector('#status')?.textContent ?? '').slice(0, 80);
      out.pages = await window.__accelon26.notePagesOf(out.note).catch(() => null);
      // 要驗的是「註號所在的那張圖」有沒有回到視線裡（頁面上可能還有別的小圖）
      const markedEl = document.querySelector('svg a.noteRef.noteTargetMark');
      const svg2 = markedEl?.closest('svg') ?? document.querySelector('#docText .docBody svg.inlineSvg');
      const pos = svg2 ? svg2.getBoundingClientRect() : null;
      out.svgRect = pos ? { top: Math.round(pos.top), bottom: Math.round(pos.bottom), h: Math.round(pos.height), vh: window.innerHeight, sy: Math.round(window.scrollY) } : null;
      out.backScrolledToFigure = !!pos && pos.top < window.innerHeight && pos.bottom > 0;
      out.flashRow = document.querySelector('#docText .noteTarget')?.id ?? '';
    }
    // 對照組：正文裡一個普通的注號，走同一條路（確認「釋→本文」本身沒有壞）
    await window.__accelon26.openPage('fuyan', out.page);
    await sleep(900);
    const plain = [...document.querySelectorAll('#docText .docLine:not(.noteRefsMerged) a.noteRef')]
      .find((a) => (a.closest('.lineText')?.textContent ?? '').length > 12);
    out.control = { found: !!plain, n: plain?.dataset.note ?? '' };
    if (plain) {
      plain.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await wait(() => document.querySelector('#docText .noteTarget .noteBody'), 60);
      await sleep(300);
      const b2 = document.querySelector('#docText .noteTarget a.noteBack');
      out.control.jumped = !!b2;
      if (b2) {
        b2.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        await sleep(1200);
        out.control.backRow = document.querySelector('#docText .noteTarget')?.id ?? '';
        out.control.backMark = document.querySelector('#docText .noteTargetMark')?.textContent ?? '';
        out.control.nowAt = (document.querySelector('#docText .docBody')?.innerText ?? '').slice(0, 40).replace(/\\s+/g, ' ');
      }
    }
    // 收尾：回到這一頁、把圖捲到中間，截圖用
    await window.__accelon26.openPage('fuyan', out.page);
    await sleep(900);
    document.querySelector('#docText svg.inlineSvg')?.scrollIntoView({ block: 'center' });
    await sleep(300);
    out.consoleErrors = window.__accelon26.consoleErrors?.() ?? null;
    return JSON.stringify(out);
  })()
`);

const r = JSON.parse(report);
console.log(JSON.stringify(r, null, 1));

const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
await Bun.write(PNG, Buffer.from(shot.data, 'base64'));

const fails: string[] = [];
if (!r.hasSvg) fails.push('這一頁沒有 inline SVG');
if (!r.markFound) fails.push(`圖上找不到註 ${NOTE} 的注號`);
if (r.zoomOpened) fails.push('點圖上注號順便打開了看圖視窗');
if (r.markers && r.markers.some((m: any) => !m.inSvg)) fails.push('有注號跑到圖的框外');
// 厚觀法師 2026-11-12 15:07 第 3 項：本文那列 [13][14]… 要顯示出來（與圖上的號並存）
if (!r.visibleNoteRows || !r.visibleNoteRows.length) fails.push('圖前的注號列沒有顯示出來');
if (r.hiddenRows && r.hiddenRows.length) fails.push('還有注號列被收起來（法師要求顯示）');
if (!r.targetIsNoteBody) fails.push('點圖上注號沒有跳到釋文');
if (!r.backFound) fails.push('釋文沒有回本文的編號');
if (!r.backMarked || !r.backMarked.length) fails.push('點釋文編號後，圖上的注號沒被標記');
if (!r.backScrolledToFigure) fails.push('點釋文編號後沒有捲回圖');
if (r.consoleErrors && r.consoleErrors.length) fails.push('console 有錯誤：' + r.consoleErrors.join(' | '));

proc.kill();
await Bun.sleep(200);
try { rmSync(profile, { recursive: true, force: true }); } catch { /* 瀏覽器可能還握著 */ }

if (fails.length) { console.error('FAIL ' + fails.join('; ')); console.error('screenshot ' + PNG); process.exit(1); }
console.log('PASS 圖上注號：位置、本文注號列顯示、註→釋、釋→圖 都對');
console.log('screenshot ' + PNG);
