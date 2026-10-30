#!/usr/bin/env bun
/**
 * 註文裡的多筆大正引用（2026-10-30）：直接是連結（沒有下拉）、三筆都能跳、
 * 沒有 q 只跳頁不塗色、單筆維持連結、console 沒有 exception。
 *
 *   cd ts && bun run tools/note-xref-test.ts [--html ../build/accelon26.html]
 *        [--ys D:/accelon3/ys.adb] [--yinshun D:/accelon3/yinshun.adb] [--taisho D:/accelon3/taisho.adb]
 */
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const ROOT = resolve(import.meta.dir, '../..');
const HTML = resolve(opt('html', resolve(ROOT, 'build/accelon26.html')));
const YS = resolve(opt('ys', 'D:/accelon3/ys.adb'));
const YINSHUN = resolve(opt('yinshun', 'D:/accelon3/yinshun.adb'));
const TAISHO = resolve(opt('taisho', 'D:/accelon3/taisho.adb'));
const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const browser = BROWSERS.find((p) => existsSync(p));
if (!browser) { console.error('no Chromium browser'); process.exit(2); }
for (const p of [YS, TAISHO]) if (!existsSync(p)) { console.error('no ' + p); process.exit(2); }
const profile = resolve(ROOT, 'build/.chrome-profile-nx-' + process.pid);
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
  throw new Error('DevToolsActivePort not found');
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
await pick(TAISHO);
await Bun.sleep(4500);
await pick(YS);
await Bun.sleep(4500);
await cdp.eval('window.__accelon26.closeAbout?.(); true').catch(() => {});

/** 開 ys 的某一頁、點某個註，回傳注文裡的連結與逐筆點擊結果 */
async function noteLinks(page: string, note: string) {
  return JSON.parse(await cdp.eval<string>(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const api = window.__accelon26;
    const out = { page: '${page}', note: '${note}' };
    await api.xrefJump('ys?${page}');
    for (let i = 0; i < 100; i++) { if (document.querySelector('#docText .docLine')) break; await sleep(100); }
    await sleep(700);
    const ref = document.querySelector('a.noteRef[data-note="${note}"]');
    if (!ref) { out.error = 'no noteRef'; return JSON.stringify(out); }
    ref.click();
    await sleep(800);
    const body = document.querySelector('.noteBody[data-note="${note}"]');
    if (!body) { out.error = 'no noteBody'; return JSON.stringify(out); }
    out.dropdown = !!body.querySelector('.noteXrefs');
    const links = [...body.querySelectorAll('a.xrefLink')];
    out.links = links.map((a) => ({ text: a.textContent, xref: a.dataset.xref ?? '' }));
    out.jumps = [];
    for (const a of links) {
      const short = ((a.dataset.xref ?? '').split('?')[1] ?? '').replace(/^\\d+p/, '');
      a.click();
      let head = '';
      for (let i = 0; i < 40; i++) { head = document.querySelector('#textBody .docHead')?.textContent ?? ''; if (short && head.includes(short)) break; await sleep(100); }
      out.jumps.push({
        xref: a.dataset.xref, tab: document.querySelector('#textTabs .docTab.active .docTabName')?.textContent ?? '',
        head, marks: document.querySelectorAll('#textBody .xrefHit').length,
        textLen: (document.getElementById('textBody')?.textContent ?? '').length,
      });
    }
    return JSON.stringify(out);
  })()`));
}

const ys085 = await noteLinks('37p0037a', '37.085');
const ys084 = await noteLinks('37p0037a', '37.084');

let yinshun: any = { skipped: true };
if (existsSync(YINSHUN)) {
  await pick(YINSHUN);
  await Bun.sleep(4000);
  yinshun = JSON.parse(await cdp.eval<string>(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const api = window.__accelon26;
    const out = { db: api.state().db };
    // 舊 yinshun.adb：<註 n="5.056"/> 在頁 37p37（<釋> 在 210293）
    await api.xrefJump(out.db + '?37p37');
    for (let i = 0; i < 80; i++) { if (document.querySelector('#docText .docLine')) break; await sleep(100); }
    await sleep(900);
    const ref = document.querySelector('a.noteRef[data-note="5.056"]');
    if (!ref) { out.error = 'no noteRef 5.056'; return JSON.stringify(out); }
    ref.click();
    await sleep(900);
    const body = document.querySelector('.noteBody[data-note="5.056"]');
    out.dropdown = !!body?.querySelector('.noteXrefs');
    out.links = [...(body?.querySelectorAll('a.xrefLink') ?? [])].map((a) => a.dataset.xref ?? '');
    out.jumps = [];
    for (const a of [...(body?.querySelectorAll('a.xrefLink') ?? [])]) {
      const short = ((a.dataset.xref ?? '').split('?')[1] ?? '').replace(/^\\d+p/, '');
      a.click();
      let head = '';
      for (let i = 0; i < 40; i++) { head = document.querySelector('#textBody .docHead')?.textContent ?? ''; if (short && head.includes(short)) break; await sleep(100); }
      out.jumps.push({ xref: a.dataset.xref, tab: document.querySelector('#textTabs .docTab.active .docTabName')?.textContent ?? '', head });
    }
    return JSON.stringify(out);
  })()`));
}

// 截一張：ys 37.085 的注文（三筆連結都在）
await pick(YS);
await Bun.sleep(3500);
await cdp.eval(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const api = window.__accelon26;
  await api.xrefJump('ys?37p0037a');
  for (let i = 0; i < 80; i++) { if (document.querySelector('#docText .docLine')) break; await sleep(100); }
  await sleep(600);
  document.querySelector('a.noteRef[data-note="37.085"]')?.click();
  await sleep(600);
  return true;
})()`).catch(() => {});
await Bun.sleep(300);
{
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }).catch(() => null);
  if (shot?.data) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(resolve(ROOT, 'build/note-xref.png'), Buffer.from(shot.data, 'base64'));
  }
}

console.log(JSON.stringify({ ys085, ys084, yinshun }, null, 1));
if (cdp.logs.length) console.log('--- console ---\n' + cdp.logs.join('\n'));
proc.kill();
await Bun.sleep(200);
try { rmSync(profile, { recursive: true, force: true }); } catch { /* browser may hold it */ }

const fails: string[] = [];
const want = ['taisho?12p1081a', 'taisho?12p1082c', 'taisho?12p1099c'];
for (const [label, r] of [['ys 37.085', ys085], ['yinshun 5.056', yinshun]] as const) {
  if (r.skipped) continue;
  if (r.error) { fails.push(label + ': ' + r.error); continue; }
  if (r.dropdown) fails.push(label + ' 不應有下拉（應是直接連結）');
  const targets = (r.links ?? []).map((l: any) => (typeof l === 'string' ? l : l.xref));
  if (JSON.stringify(targets) !== JSON.stringify(want)) fails.push(label + ' 的三筆連結不對：' + JSON.stringify(targets));
  for (const j of r.jumps ?? []) {
    const short = (j.xref ?? '').split('?')[1]?.replace(/^\d+p/, '') ?? '';
    if (!String(j.tab).includes(short)) fails.push(label + ' 跳轉後分頁不對：' + j.tab);
    if (!String(j.head).includes(short)) fails.push(label + ' 的本文標題不對：' + j.head);
    if (j.marks > 0) fails.push(label + ' 沒有 q 不應該塗紅：' + j.xref);
  }
}
if (ys084.error) fails.push('ys 37.084: ' + ys084.error);
if (ys084.dropdown) fails.push('ys 37.084 不應有下拉');
if ((ys084.links ?? []).length !== 1) fails.push('ys 37.084 應該只有 1 筆連結：' + JSON.stringify(ys084.links));
if (!(ys084.jumps?.[0]?.head ?? '').includes('49p57a')) fails.push('ys 37.084 的單筆連結跳轉不對：' + JSON.stringify(ys084.jumps));
if (cdp.logs.some((l) => l.startsWith('[exception]'))) fails.push('console 有 exception：\n' + cdp.logs.join('\n'));
if (fails.length) { console.error('FAIL:\n- ' + fails.join('\n- ')); process.exit(1); }
console.log('ok: 註文多筆引用是直接連結');
