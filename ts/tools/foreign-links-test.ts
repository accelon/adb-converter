#!/usr/bin/env bun
/**
 * 右欄大正分頁的「→SAT」「→圖版」（2026-10-31）。
 *
 *   cd ts && bun run tools/foreign-links-test.ts [--html ../build/accelon26.html]
 *
 * 從 ys 點「大正」晶片開 T2p183c：
 *   →SAT：https://21dzk.l.u-tokyo.ac.jp/SAT2018/satdb2018pre.php?...&useid=0099_.02.0183c01
 *   →圖版：https://dia.dila.edu.tw/uv3/index.html?id=Tv02p0183#?...（c 欄 y=1783）
 */
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const ROOT = resolve(import.meta.dir, '../..');
const HTML = resolve(opt('html', resolve(ROOT, 'build/accelon26.html')));
const YS = resolve(opt('ys', 'D:/accelon3/ys.adb'));
const TAISHO = resolve(opt('taisho', 'D:/accelon3/taisho.adb'));
const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const browser = BROWSERS.find((p) => existsSync(p));
if (!browser) { console.error('no Chromium browser'); process.exit(2); }
const profile = resolve(ROOT, 'build/.chrome-profile-fl-' + process.pid);
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
  logs: string[] = [];
  static async attach(url: string): Promise<Cdp> {
    const c = new Cdp();
    await new Promise<void>((res, rej) => {
      c.ws = new WebSocket(url);
      c.ws.onopen = () => res();
      c.ws.onerror = () => rej(new Error('ws error'));
      c.ws.onmessage = (ev) => {
        const m = JSON.parse(String(ev.data));
        if (m.method === 'Runtime.consoleAPICalled') c.logs.push('[console] ' + (m.params?.args ?? []).map((a: any) => a.value ?? a.description ?? a.type).join(' '));
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
async function pick(file: string): Promise<void> {
  const doc = await cdp.send('DOM.getDocument');
  const q = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#file' });
  await cdp.send('DOM.setFileInputFiles', { files: [file], nodeId: q.nodeId });
  await cdp.eval('document.querySelector("#file").dispatchEvent(new Event("change"))');
}

const cdp = await Cdp.attach(await devtoolsUrl());
await cdp.openPage(pathToFileURL(HTML).href + '?v=' + Date.now());
await Bun.sleep(900);
await pick(TAISHO); await Bun.sleep(4000);
await pick(YS); await Bun.sleep(4500);

const out = JSON.parse(await cdp.eval<string>(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const api = window.__accelon26;
  await api.closeAbout?.();
  const input = document.getElementById('query');
  input.focus();
  input.value = '何等為信根';
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
  let chip = null;
  for (let i = 0; i < 120; i++) {
    await sleep(100);
    chip = document.querySelector('a.entryLink.xrefLink[data-xref="taisho?2p183c"]');
    if (chip) break;
  }
  if (!chip) return JSON.stringify({ error: 'no chip' });
  chip.click();
  // 等工具列出現
  let tools = null;
  for (let i = 0; i < 120; i++) {
    await sleep(100);
    tools = document.querySelectorAll('#textBody .xrefTools button[data-url]');
    if (tools && tools.length) break;
  }
  const urls = [...document.querySelectorAll('#textBody .xrefTools button[data-url]')].map((b) => ({ label: b.textContent, url: b.dataset.url }));
  // 攔 window.open，點兩顆按鈕看實際開的網址
  const opened = [];
  const orig = window.open;
  window.open = (u) => { opened.push(String(u)); return null; };
  const btns = [...document.querySelectorAll('#textBody .xrefTools button[data-url]')];
  for (const b of btns) b.click();
  await sleep(300);
  window.open = orig;
  return JSON.stringify({
    count: btns.length,
    urls,
    opened,
    head: document.querySelector('#textBody .docHead')?.textContent ?? '',
  }, null, 1);
})()`));
console.log(JSON.stringify(out, null, 1));
const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }).catch(() => null);
if (shot?.data) writeFileSync(resolve(ROOT, 'build/foreign-links.png'), Buffer.from(shot.data, 'base64'));
if (cdp.logs.length) console.log('--- console ---\n' + cdp.logs.join('\n'));
proc.kill();
await Bun.sleep(200);
try { rmSync(profile, { recursive: true, force: true }); } catch { /* browser may hold it */ }

const sat = (out.urls ?? []).find((u: any) => u.label.includes('SAT'))?.url ?? '';
const plate = (out.urls ?? []).find((u: any) => u.label.includes('圖版'))?.url ?? '';
const fails: string[] = [];
if (out.error) fails.push(out.error);
if (out.count !== 2) fails.push('工具列不是兩顆按鈕：' + out.count);
if (!sat.includes('21dzk.l.u-tokyo.ac.jp') || !sat.includes('useid=0099_.02.0183c01')) fails.push('SAT 網址不對：' + sat);
if (!plate.startsWith('https://dia.dila.edu.tw/uv3/index.html?id=Tv02p0183')) fails.push('圖版網址不對：' + plate);
if (!plate.includes('1783')) fails.push('圖版沒有帶 c 欄的 y：' + plate);
if (!(out.opened ?? []).some((u: string) => u.includes('21dzk'))) fails.push('點 →SAT 沒有開 SAT');
if (!(out.opened ?? []).some((u: string) => u.includes('dia.dila.edu.tw'))) fails.push('點 →圖版 沒有開 DIA');
if (cdp.logs.some((l) => l.startsWith('[exception]'))) fails.push('console 有 exception');
if (fails.length) { console.error('FAIL:\n- ' + fails.join('\n- ')); process.exit(1); }
console.log('ok: 右欄大正分頁的 →SAT／→圖版');
