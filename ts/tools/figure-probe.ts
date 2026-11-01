#!/usr/bin/env bun
/**
 * 診斷：圖版 inline SVG 在正文裡的尺寸與裁切（fuyan y37.0347）。
 * 用法：bun run tools/figure-probe.ts [html] [adb] [page] [fig]
 */
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dir, '../..');
const HTML = resolve(process.argv[2] || resolve(ROOT, 'build/accelon26.html'));
const ADB = process.argv[3] || 'D:/accelon3/fuyan.adb';
const PAGE = process.argv[4] || 'fuyan?05B-p105';
const FIG = process.argv[5] || 'y37.0347';

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const browser = BROWSERS.find((p) => existsSync(p))!;
const profile = resolve(ROOT, 'build/.chrome-profile-fig-' + process.pid);
const proc = Bun.spawn([browser, '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
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
  logs: string[] = [];
  static async attach(url: string): Promise<Cdp> {
    const c = new Cdp();
    await new Promise<void>((res, rej) => {
      c.ws = new WebSocket(url);
      c.ws.onopen = () => res();
      c.ws.onerror = () => rej(new Error('ws error'));
      c.ws.onmessage = (ev) => {
        const m = JSON.parse(String(ev.data));
        if (m.method === 'Runtime.exceptionThrown') c.logs.push('[exception] ' + (m.params?.exceptionDetails?.exception?.description ?? m.params?.exceptionDetails?.text));
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
await Bun.sleep(4500);
const out = JSON.parse(await cdp.eval<string>(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await window.__accelon26?.closeAbout?.();
  await window.__accelon26?.xrefJump?.(${JSON.stringify(PAGE)}).catch(() => {});
  for (let i = 0; i < 100; i++) { await sleep(100); if (document.querySelector('#docText .figureSvg')) break; }
  await sleep(400);
  const svgs = [...document.querySelectorAll('#docText .figureSvg')];
  const svg = svgs.find((s) => (s.getAttribute('aria-label') || '').includes(${JSON.stringify(FIG)})) || svgs[0];
  if (!svg) return JSON.stringify({ error: 'no figureSvg' });
  svg.scrollIntoView({ block: 'center' });
  await sleep(300);
  const r = svg.getBoundingClientRect();
  const cs = getComputedStyle(svg);
  const texts = [...svg.querySelectorAll('text')].map((t) => t.getBoundingClientRect());
  const firstTop = Math.min(...texts.map((x) => x.top));
  const lastBottom = Math.max(...texts.map((x) => x.bottom));
  return JSON.stringify({
    label: svg.getAttribute('aria-label'),
    vb: svg.getAttribute('viewBox'),
    rect: { left: r.left, top: r.top, w: r.width, h: r.height },
    cls: svg.getAttribute('class'), style: svg.getAttribute('style') ?? '',
    cw: cs.width, ch: cs.height, maxH: cs.maxHeight, overflow: cs.overflow,
    textCount: texts.length,
    firstTop: Math.round(firstTop), lastBottom: Math.round(lastBottom),
    clippedTop: firstTop < r.top - 1, clippedBottom: lastBottom > r.bottom + 1,
    ids: [...svg.querySelectorAll('[id]')].map((e) => e.id).slice(0, 4),
    clips: [...svg.querySelectorAll('[clip-path]')].map((e) => e.getAttribute('clip-path')).slice(0, 3),
  }, null, 1);
})()`));
console.log(out);
const rect = out.rect as { left: number; top: number; w: number; h: number };
const shot = await cdp.send('Page.captureScreenshot', {
  format: 'png',
  clip: { x: Math.max(0, rect.left - 20), y: Math.max(0, rect.top - 20), width: rect.w + 40, height: rect.h + 40, scale: 2 },
});
writeFileSync(resolve(ROOT, 'build/figure-clip.png'), Buffer.from(shot.data, 'base64'));
if (cdp.logs.length) console.log(cdp.logs.slice(-6).join('\n'));
proc.kill();
await Bun.sleep(200);
try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
