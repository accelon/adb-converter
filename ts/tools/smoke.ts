#!/usr/bin/env bun
/**
 * UI 煙霧測試（作者 2026-11-03）：**每次改完前端就跑一次**，十秒內知道有沒有炸。
 *
 *   cd ts && bun run tools/smoke.ts                      # 測 dev server（127.0.0.1:8790）
 *   cd ts && bun run tools/smoke.ts --url http://127.0.0.1:8790/?db=cs
 *   cd ts && bun run tools/smoke.ts --html build/accelon26.html
 *
 * 檢查四件事（通過就 exit 0）：
 *   1. 頁面載入完成（readyState=complete）
 *   2. `window.__accelon26` 有建立（boot 跑完的證據）
 *   3. `#file` 存在（選檔入口在）
 *   4. 載入期間沒有 uncaught exception／unhandledrejection
 *
 * 為什麼要這支：2026-11-03 的循環 import 讓 boot 中途爆掉，按鈕全部沒反應，
 * 但沒有例外事件、build 也成功；人眼看不出來，只有真的開瀏覽器才知道。
 */
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const opt = (n: string, d: string): string => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const HTML = opt('html', '');
const URL0 = opt('url', 'http://127.0.0.1:8790/');
const target = HTML ? 'file:///' + resolve(HTML).replace(/\\/g, '/') : URL0;

const BROWSERS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];
const browser = BROWSERS.find((p) => existsSync(p));
if (!browser) { console.error('找不到 Chrome／Edge'); process.exit(2); }

const profile = resolve(import.meta.dir, '../../build/.smoke-' + process.pid);
const proc = Bun.spawn([browser, '--headless=new', '--disable-gpu', '--no-first-run',
  '--remote-debugging-port=0', '--remote-allow-origins=*', '--user-data-dir=' + profile,
  'about:blank'], { stdout: 'ignore', stderr: 'ignore' });

let wsUrl = '';
for (let i = 0; i < 100; i++) {
  const t = await Bun.file(resolve(profile, 'DevToolsActivePort')).text().catch(() => '');
  const [port, path] = t.split('\n').map((s) => s.trim());
  if (Number(port) > 0 && path) { wsUrl = 'ws://127.0.0.1:' + port + path; break; }
  await Bun.sleep(200);
}
if (!wsUrl) { proc.kill(); console.error('瀏覽器沒有起來'); process.exit(2); }

const ws = new WebSocket(wsUrl);
await new Promise<void>((ok, bad) => { ws.onopen = () => ok(); ws.onerror = () => bad(new Error('ws')); });
let id = 0; let sid = '';
const pend = new Map<number, (v: any) => void>();
const exceptions: string[] = [];
ws.onmessage = (e) => {
  const m = JSON.parse(String(e.data));
  if (m.id && pend.has(m.id)) { pend.get(m.id)!(m); pend.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') {
    exceptions.push(String(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text ?? '').slice(0, 200));
  }
};
async function send(method: string, params: Record<string, unknown> = {}, session = true): Promise<any> {
  const my = ++id;
  const payload: Record<string, unknown> = { id: my, method, params };
  if (session && sid) payload.sessionId = sid;
  const p = new Promise<any>((ok) => pend.set(my, ok));
  ws.send(JSON.stringify(payload));
  const r = await p;
  if (r.error) throw new Error(method + ': ' + JSON.stringify(r.error));
  return r.result;
}
const { targetId } = await send('Target.createTarget', { url: 'about:blank' }, false);
({ sessionId: sid } = await send('Target.attachToTarget', { targetId, flatten: true }, false));
await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: target });
const ev = async (x: string): Promise<any> => (await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true })).result?.value;

let api = false;
for (let i = 0; i < 160; i++) { api = await ev('!!window.__accelon26'); if (api) break; await Bun.sleep(250); }
// 網址有指定 db 時，等它真的開起來（大檔 cs.adb 125 MB 要幾十秒）
if (target.includes('db=')) {
  for (let i = 0; i < 240; i++) { if (await ev('!!(window.__accelon26 && window.__accelon26.state().db)')) break; await Bun.sleep(250); }
}
await Bun.sleep(800);

const info = await ev('JSON.stringify({ rs: document.readyState, api: !!window.__accelon26, file: !!document.querySelector("#file"), db: (window.__accelon26 && window.__accelon26.state().db) || "" })');
const parsed = JSON.parse(String(info ?? '{}'));
proc.kill();
await Bun.sleep(200);
try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }

const problems: string[] = [];
if (parsed.rs !== 'complete') problems.push('readyState=' + parsed.rs);
if (!parsed.api) problems.push('window.__accelon26 沒有建立（boot 中斷）');
if (!parsed.file) problems.push('#file 不存在');
if (exceptions.length) problems.push('例外：' + exceptions.slice(0, 2).join(' ｜ '));

if (problems.length) {
  console.error('✗ 煙霧測試失敗（' + target + '）');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
console.log('✓ 煙霧測試通過：' + target + (parsed.db ? `（已開 ${parsed.db}）` : '（未開庫）'));
