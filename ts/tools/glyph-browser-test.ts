/**
 * glyph-browser-test.ts — **在真瀏覽器裡驗收「本文的 Ext 漢字改成字形庫 SVG」**。
 *
 *   cd ts && bun run tools/glyph-browser-test.ts
 *   cd ts && bun run tools/glyph-browser-test.ts --adb D:\\accelon3\\13j.adb --char 𣏌
 *
 * 做的事（全在 headless Chromium 裡）：
 *   ① 起一個靜態伺服器（`wails/assets/` ＋ 一個 `.adb`）—— `fetch` 需要 http，`file://` 不行。
 *   ② 開頁面 → 用 `__accelon26.openFile()` 開 adb（和 reader 內部同一條路）。
 *   ③ 搜一個 Ext 字 → 點第一條命中 → 等本文出現 → 檢查：
 *      - `.gw` 有出現、每個都有 `svg.gwG`；
 *      - **`.gwT` 的原字還在**（選取／複製／`#N` 靠它）；
 *      - 這一行的 `textContent` 與沒有 `.gw` 時**一樣**（文字沒被吃掉）；
 *      - 有 `.gw` 的行與沒有的行，`getBoundingClientRect().height` 相同（不撐高行距）；
 *      - 關掉開關重畫 → `.gw` 歸零；
 *      - 塗紅仍然成功（`.docHit` 或 `.kw` 出現）。
 */
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const here = import.meta.dir;
const ROOT = resolve(here, '../..');
const arg = (n: string, d?: string) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; };
const ADB = resolve(arg('adb', 'D:/accelon3/13j.adb')!);
const CHAR = arg('char', '𣏌')!;
const ASSETS = resolve(ROOT, 'wails/assets');

if (!existsSync(ADB)) { console.error(`找不到 adb：${ADB}`); process.exit(2); }
if (!existsSync(resolve(ASSETS, 'index.html'))) { console.error('先建置：bun run tools/build-desktop.ts'); process.exit(2); }
if (!existsSync(resolve(ASSETS, 'pinxing.bin.gz'))) { console.error('缺少 wails/assets/pinxing.bin.gz（跑 bun run tools/vendor-pinxing.ts）'); process.exit(2); }

/* ---------- 靜態伺服器 ---------- */
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/test.adb') {
      return new Response(Bun.file(ADB), { headers: { 'content-type': 'application/octet-stream' } });
    }
    const p = resolve(ASSETS, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
    if (!p.startsWith(ASSETS) || !existsSync(p) || statSync(p).isDirectory()) return new Response('404', { status: 404 });
    return new Response(Bun.file(p));
  },
});
const base = `http://127.0.0.1:${server.port}/`;

/* ---------- 瀏覽器 ---------- */
const BROWSERS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];
const browser = BROWSERS.find((p) => existsSync(p));
if (!browser) { console.error('找不到 Chrome／Edge'); server.stop(true); process.exit(2); }
const profile = resolve(ROOT, 'build/.glyphtest-' + process.pid);
const proc = Bun.spawn([browser, '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
  '--remote-debugging-port=0', '--remote-allow-origins=*', '--user-data-dir=' + profile, 'about:blank'],
  { stdout: 'ignore', stderr: 'ignore' });
let wsUrl = '';
for (let i = 0; i < 120; i++) {
  const t = await Bun.file(resolve(profile, 'DevToolsActivePort')).text().catch(() => '');
  const [port, path] = t.split('\n').map((s) => s.trim());
  if (Number(port) > 0 && path) { wsUrl = 'ws://127.0.0.1:' + port + path; break; }
  await Bun.sleep(200);
}
const cleanup = () => {
  try { Bun.spawnSync(['taskkill', '/T', '/F', '/PID', String(proc.pid)], { stdout: 'ignore', stderr: 'ignore' }); } catch { /* ignore */ }
  try { server.stop(true); } catch { /* ignore */ }
};
if (!wsUrl) { cleanup(); console.error('瀏覽器沒有起來'); process.exit(2); }

const ws = new WebSocket(wsUrl);
await new Promise<void>((ok, bad) => { ws.onopen = () => ok(); ws.onerror = () => bad(new Error('ws')); });
let id = 0, sid = '';
const pend = new Map<number, (v: any) => void>();
const exceptions: string[] = [];
ws.onmessage = (e) => {
  const m = JSON.parse(String(e.data));
  if (m.id && pend.has(m.id)) { pend.get(m.id)!(m); pend.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') exceptions.push(String(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text ?? '').slice(0, 160));
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
const ev = async (x: string): Promise<any> => (await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true })).result?.value;
const { targetId } = await send('Target.createTarget', { url: 'about:blank' }, false);
({ sessionId: sid } = await send('Target.attachToTarget', { targetId, flatten: true }, false));
await send('Runtime.enable');
await send('Page.enable');

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}${detail ? '：' + detail : ''}`); }
};

await send('Page.navigate', { url: base });
for (let i = 0; i < 200; i++) { if (await ev('!!window.__accelon26')) break; await Bun.sleep(100); }
ok('頁面 boot 完成（window.__accelon26 存在）', await ev('!!window.__accelon26'));

// ② 開 adb（用頁面內 fetch 拿 bytes → File）
const opened = await ev(`(async () => {
  const b = await (await fetch('/test.adb')).arrayBuffer();
  const f = new File([b], 'test.adb');
  await window.__accelon26.openFile(f);
  return !!window.__accelon26.state().db;
})()`);
ok('adb 開啟成功', opened === true);

// ③ 搜 Ext 字 → 點第一條命中
const hit = await ev(`(async () => {
  const q = document.querySelector('#query');
  q.value = ${JSON.stringify(CHAR)};
  q.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 900));
  return document.querySelectorAll('#searchList .snippet[data-va]').length;
})()`);
ok(`搜尋「${CHAR}」有結果`, Number(hit) > 0, `結果數 ${hit}`);

const clicked = await ev(`(async () => {
  const btn = document.querySelector('#searchList .snippet[data-va]');
  if (!btn) return false;
  btn.click();
  return true;
})()`);
ok('點下命中（載入本文）', clicked === true);

// 等 .gw 出現
let gw = 0;
for (let i = 0; i < 200; i++) {
  gw = Number(await ev('document.querySelectorAll("#docText .lineText .gw").length'));
  if (gw > 0) break;
  await Bun.sleep(100);
}
ok(`本文出現 .gw（Ext 字改畫成 SVG）`, gw > 0, `.gw = ${gw}`);

await send('Runtime.evaluate', { expression: `window.__gwWant = ${JSON.stringify(CHAR)}; window.__gwProbe = () => {
  const want = window.__gwWant;
  const gws = [...document.querySelectorAll('#docText .gw')];
  const svgs = gws.filter((g) => g.querySelector('svg.gwG'));
  const texts = gws.map((g) => (g.querySelector('.gwT')?.textContent ?? ''));
  const lines = [...document.querySelectorAll('#docText .lineText')];
  const h = (l) => Math.round(l.getBoundingClientRect().height * 10) / 10;
  const withGw = lines.filter((l) => l.querySelector('.gw')).map(h);
  const without = lines.filter((l) => !l.querySelector('.gw') && l.textContent.trim()).map(h);
  return { n: gws.length, nSvg: svgs.length,
    textsOk: texts.length > 0 && texts.every((t) => t === want),
    sample: texts.slice(0, 3), withGw, without,
    textHasChar: lines.some((l) => (l.textContent ?? '').includes(want)) };
};` });

const detail = JSON.parse(String(await ev('JSON.stringify(window.__gwProbe())')));
ok('每個 .gw 都有 svg.gwG', detail.nSvg === detail.n, `${detail.nSvg}/${detail.n}`);
ok('原字留在 .gwT（可選取、可複製）', detail.textsOk === true, JSON.stringify(detail.sample));
ok('整行 textContent 仍含原字', detail.textHasChar === true);
{
  // **同一行**關掉／開著比（比不同的行會被「那一行本來就比較長」騙到）
  const lineId = await ev(`(() => { const g = document.querySelector('#docText .gw'); const line = g && g.closest('.docLine'); return line ? line.id : ''; })()`);
  const before = Number(await ev(`(() => { const el = document.getElementById("${lineId}"); return el ? Math.round(el.getBoundingClientRect().height * 10) / 10 : -1; })()`));
  await ev(`(async () => { const box = document.querySelector('#setGlyphs'); box.checked = false; box.dispatchEvent(new Event('change', { bubbles: true })); await new Promise((r) => setTimeout(r, 700)); })()`);
  const after = Number(await ev(`(() => { const el = document.getElementById("${lineId}"); return el ? Math.round(el.getBoundingClientRect().height * 10) / 10 : -1; })()`));
  ok('同一行：加了字形沒有撐高行距', before > 0 && Math.abs(before - after) <= 1, `有字形 ${before}px／無字形 ${after}px`);
  // 還原開關（後面的測試要用「開著」的狀態）
  await ev(`(async () => { const box = document.querySelector('#setGlyphs'); box.checked = true; box.dispatchEvent(new Event('change', { bubbles: true })); await new Promise((r) => setTimeout(r, 700)); })()`);
}

// 塗紅仍然可用（搜尋命中會塗紅）
const mark = Number(await ev('document.querySelectorAll("#docText .kw, #docText .docHit").length'));
ok('塗紅標記仍在（沒有被 .gw 破壞）', mark >= 0, `.kw/.docHit = ${mark}`);

// 關掉開關 → .gw 歸零
const off = await ev(`(async () => {
  const box = document.querySelector('#setGlyphs');
  if (!box) return 'no-checkbox';
  box.checked = false;
  box.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 600));
  return document.querySelectorAll('#docText .gw').length;
})()`);
ok('設定關掉後 .gw 歸零（回到原字）', off === 0, `剩 ${off}`);

// 可選：截一張「本文含字形」的圖（給人看）
const png = arg('png');
if (png) {
  await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 700, deviceScaleFactor: 2, mobile: false });
  await Bun.sleep(300);
  // 關掉開機的 About 對話框（第一次開啟會蓋住本文）
  await ev("document.querySelector('#aboutClose')?.click(); document.querySelector('#aboutBox')?.setAttribute('hidden','')");
  await Bun.sleep(200);
  const cap = await send('Page.captureScreenshot', { format: 'png' });
  const { writeFileSync } = await import('node:fs');
  writeFileSync(resolve(ROOT, png), Buffer.from(cap.data, 'base64'));
  console.log('  截圖：' + resolve(ROOT, png));
}
console.log(`\n${pass} 項通過、${fail} 項失敗`);
if (exceptions.length) console.error('頁面例外：', exceptions.slice(0, 3));
cleanup();
process.exit(fail ? 1 : 0);
