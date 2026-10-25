#!/usr/bin/env bun
/**
 * Desktop (Wails3) check for 「加入 Obsidian」: the adb must be written NEXT TO THE
 * EXE and the adb list must pick it up.
 *
 *   bun run tools/probe-desktop-import.ts [--exe build/accelon26-test.exe]
 *        [--vault "《論語句讀新詮》.zip"] [--port 9333]
 *
 * The exe is copied into a temp folder (so the test never touches the real one),
 * started with WebView2's remote debugger, and the page is driven exactly like the
 * browser probe: pick the vault .zip → wait for the build → check
 *
 *   1. `<temp>/book.adb` exists and starts with the adb signature
 *   2. the page opened it (state().db)
 *   3. the adb list grew (state().catalog contains the new database)
 *
 * Exit code 1 when any of them fails.
 */
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const ROOT = resolve(import.meta.dir, '../..');
const EXE = resolve(opt('exe', resolve(ROOT, 'build/accelon26-test.exe')));
const VAULT = resolve(opt('vault', resolve(ROOT, '《論語句讀新詮》.zip')));
const PORT = Number(opt('port', '9333'));
if (!existsSync(EXE)) { console.error('missing ' + EXE + ' (build: cd wails && go build -o ../build/accelon26-test.exe .)'); process.exit(2); }
if (!existsSync(VAULT)) { console.error('missing ' + VAULT); process.exit(2); }

const mark = (() => { const t0 = Date.now(); return (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`); })();

const dir = mkdtempSync(join(tmpdir(), 'accelon26-import-desktop-'));
const exe = join(dir, 'accelon26.exe');
copyFileSync(EXE, exe);
const stateDir = join(dir, 'state');
mark('start ' + exe);

const proc = Bun.spawn([exe], {
  cwd: dir,
  env: {
    ...process.env,
    ACCELON26_DEBUG_PORT: String(PORT),
    ACCELON26_STATE_DIR: stateDir,
    ACCELON26_WEBVIEW_DIR: join(stateDir, 'webview'),
  } as Record<string, string>,
  stdout: 'pipe', stderr: 'pipe',
});

async function wsUrl(): Promise<string> {
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      const j = await r.json() as { webSocketDebuggerUrl?: string };
      if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await Bun.sleep(300);
  }
  throw new Error('no WebView2 devtools endpoint on ' + PORT);
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
      setTimeout(() => { if (this.pending.delete(id)) rej(new Error('timeout ' + method)); }, 180000);
    });
  }
  async attachPage(): Promise<void> {
    const list = await this.send('Target.getTargets', {}, false);
    const page = (list.targetInfos as { type: string; targetId: string }[]).find((t) => t.type === 'page');
    if (!page) throw new Error('no page target');
    const { sessionId } = await this.send('Target.attachToTarget', { targetId: page.targetId, flatten: true }, false);
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

const cdp = await Cdp.attach(await wsUrl());
await cdp.attachPage();
mark('attached');
await Bun.sleep(1500);
await cdp.eval('document.querySelector("#aboutClose")?.click()');

const host = await cdp.eval<string>('JSON.stringify({ host: !!window.__accelon26, state: window.__accelon26.state().host })');
console.log('host', host);

// pick the vault zip
const dom = await cdp.send('DOM.getDocument');
const q = await cdp.send('DOM.querySelector', { nodeId: dom.root.nodeId, selector: '#vaultZip' });
if (!q?.nodeId) { console.error('FAIL: #vaultZip missing'); proc.kill(); process.exit(1); }
await cdp.send('DOM.setFileInputFiles', { files: [VAULT], nodeId: q.nodeId });
await cdp.eval('document.querySelector("#vaultZip").dispatchEvent(new Event("change"))');
mark('zip attached');
// 檔名對話框：輸入 lunyu（不含 .adb）
let dialogOpen = false;
for (let i = 0; i < 300; i++) {
  const s = await cdp.eval<string>('JSON.stringify(window.__accelon26.vaultImport())');
  if (JSON.parse(s).dialogOpen) { dialogOpen = true; break; }
  await Bun.sleep(100);
}
if (!dialogOpen) { console.error('FAIL: the name dialog never opened'); proc.kill(); process.exit(1); }
await cdp.eval(`(() => {
  const input = document.querySelector('#vaultNameInput');
  input.value = 'lunyu';
  input.dispatchEvent(new Event('input'));
  document.querySelector('#vaultNameOk').click();
  return true;
})()`);

const report = await cdp.eval<string>(`
  (async () => {
    const wait = async (fn, n = 900) => { for (let i = 0; i < n; i++) { if (fn()) return true; await new Promise((r) => setTimeout(r, 200)); } return false; };
    const done = await wait(() => window.__accelon26?.vaultImport?.().last, 900);
    // 寫檔＋重列清單是 build 之後的非同步尾巴：等目錄真的多出檔案
    const st = () => window.__accelon26.state();
    return JSON.stringify({
      done,
      last: window.__accelon26?.vaultImport?.().last ?? null,
      status: window.__accelon26.status(),
      db: st().db, tokens: st().tokens, dirRows: st().dirRows,
      catalog: (st().catalog ?? []).map((c) => c.name + '@' + (c.file ?? '').toString().slice(0, 0)),
      list: [...document.querySelectorAll('#dbPickMenu .dbPickItem')].map((r) => r.textContent.trim()),
    }, null, 1);
  })()
`);
console.log('report', report);
// 等檔案真的出現（寫檔是 build 之後的非同步尾巴）
let waited = 0;
while (waited < 30000 && !readdirSync(dir).some((f) => f.endsWith('.adb'))) {
  await Bun.sleep(500);
  waited += 500;
  if (waited % 5000 === 0) {
    const s = await cdp.eval<string>('JSON.stringify({ status: window.__accelon26.status(), last: window.__accelon26.vaultImport().last })').catch((e) => 'ERR ' + e.message);
    console.log('  waiting', waited + 'ms', s);
  }
}
console.log('waited', waited, 'ms');
// 寫檔之後才 refreshHostDbs + openFile：再等它真的開起來
let openWait = 0;
let opened: any = null;
while (openWait < 25000) {
  opened = await cdp.eval<string>('JSON.stringify({ db: window.__accelon26.state().db, tokens: window.__accelon26.state().tokens, dirRows: window.__accelon26.state().dirRows, status: window.__accelon26.status(), catalog: (window.__accelon26.state().catalog ?? []).map((c) => c.name) })').then((s) => JSON.parse(s)).catch((e) => ({ error: e.message }));
  if (opened.db) break;
  await Bun.sleep(500);
  openWait += 500;
}
console.log('after save', JSON.stringify(opened));

proc.kill();
await Bun.sleep(500);

const r = JSON.parse(report);
const files = readdirSync(dir).filter((f) => f.endsWith('.adb'));
console.log('exe folder adbs', JSON.stringify(files));
const fails: string[] = [];
if (!r.done) fails.push('the build never finished');
const adbPath = files.map((f) => join(dir, f))[0];
if (!adbPath) {
  fails.push('no .adb was written next to the exe');
} else {
  const head = readFileSync(adbPath).subarray(0, 80);
  if (!head.subarray(32, 80).toString('latin1').startsWith('\r\nAccelon Search Engine')) {
    fails.push('the written file is not an adb (signature mismatch)');
  }
  console.log('written', adbPath, statSync(adbPath).size, 'bytes');
}
if (!opened?.db) fails.push('the imported database did not open');
if (!opened?.catalog?.includes('論語句讀新詮')) fails.push('the adb list did not pick up the new database');
try { rmSync(dir, { recursive: true, force: true }); } catch { /* the exe may still hold it */ }
if (fails.length) { console.error('FAIL ' + fails.join('; ')); process.exit(1); }
console.log('ok — written next to the exe, opened, list refreshed');
