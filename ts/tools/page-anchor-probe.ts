#!/usr/bin/env bun
/**
 * page-anchor-probe.ts — 驗證兩件事（厚觀法師 2026-11-10 的錯誤01／02）：
 *   1. 科判誤判：長段落不該是 <span class="h" data-tag="節">
 *   2. 頁碼靠右：<span class="pageBreak"> 應該落在該行右端（leftPct 夠大）
 *
 *   bun run tools/page-anchor-probe.ts --adb D:/accelon3/fuyan.adb --page 5p41
 */
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const ROOT = resolve(import.meta.dir, '../..');
const HTML = resolve(opt('html', resolve(ROOT, 'build/accelon26.html')));
const ADB = resolve(opt('adb', 'D:/accelon3/fuyan.adb'));
const PAGE = opt('page', '5p41');

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const browser = BROWSERS.find((p) => existsSync(p))!;
const profile = resolve(ROOT, 'build/.chrome-profile-pa-' + process.pid);
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
  throw new Error('no devtools');
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
await Bun.sleep(900);

const doc = await cdp.send('DOM.getDocument');
const q = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#file' });
await cdp.send('DOM.setFileInputFiles', { files: [ADB], nodeId: q.nodeId });
await cdp.eval('document.querySelector("#file").dispatchEvent(new Event("change"))');
await Bun.sleep(3000);

const out = await cdp.eval<string>(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const api = window.__accelon26;
  await api.closeAbout?.();
  await api.xrefJump('fuyan?${PAGE}');
  await sleep(1200);
  const body = document.querySelector('#docText .docBody');
  if (body) body.scrollTop = 0;
  await sleep(300);

  // --- 頁碼位置 ---
  const bodyRect = body.getBoundingClientRect();
  const pages = [...document.querySelectorAll('#docText .pageBreak')].map((el) => {
    const r = el.getBoundingClientRect();
    const inner = el.querySelector('.pageId');
    const ir = inner ? inner.getBoundingClientRect() : r;
    const line = el.closest('.docLine') || el.closest('.lineText') || el.parentElement;
    const lr = line.getBoundingClientRect();
    // 同一視覺行後面還有沒有字
    const range = document.createRange();
    range.setStartAfter(el);
    const after = range.getBoundingClientRect();
    const sameLineTextAfter = after.top < ir.bottom - 2 && after.width > 0.5;
    return {
      page: el.getAttribute('data-page'),
      leftPct: +(((ir.left - lr.left) / lr.width) * 100).toFixed(1),
      rightGapPx: Math.round(lr.right - ir.right),
      midLine: sameLineTextAfter,
      lineChars: (line.textContent || '').replace(/\\s/g, '').length,
    };
  });

  // --- 科判誤判 ---
  const findSpan = (needle) => {
    const walker = document.createTreeWalker(document.querySelector('#docText'), NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      if (n.nodeValue && n.nodeValue.includes(needle)) {
        const el = n.parentElement;
        const h = el.closest('span.h');
        return { found: true, tag: h ? h.getAttribute('data-tag') : null, isHeading: !!h,
                 color: getComputedStyle(el).color, text: n.nodeValue.slice(0, 24) };
      }
    }
    return { found: false };
  };
  const probes = {
    '一期生滅(正文段)': findSpan('一期生滅，這是一般人所能明了的'),
    '剎那生滅(正文段)': findSpan('剎那生滅，如人從生到死'),
    '究竟生滅(正文段)': findSpan('究竟生滅，這是一般人更難理解'),
  };
  return JSON.stringify({ page: '${PAGE}', bodyW: Math.round(bodyRect.width), pages, probes }, null, 1);
})()`);
console.log(out);

const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }).catch(() => null);
if (shot?.data) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(resolve(ROOT, 'build/page-anchor-' + PAGE + '.png'), Buffer.from(shot.data, 'base64'));
}
proc.kill();
await Bun.sleep(200);
try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
