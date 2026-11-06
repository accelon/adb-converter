/**
 * glyph-desktop-test.ts — **在真的 exe（Wails／WebView2）裡驗字形庫**。
 *
 *   cd ts && bun run tools/glyph-desktop-test.ts
 *   cd ts && bun run tools/glyph-desktop-test.ts --exe D:\\accelon3\\accelon26.exe
 *
 * 為什麼要另立一支：http 版的 HTML 與 exe 裡的是**同一份**，但「asset 送不送得出去」
 * 只有 exe 答得出來（`wails/assets/pinxing.bin.gz` → `BundledAssetFileServer` → WebView2 的 fetch）。
 *
 * 檢查順序：
 *   ① `fetch('pinxing.bin.gz')` 拿得到（狀態 200、大小 > 1 MB）
 *   ② 從資料夾清單開一個 adb（`#dbPickBtn` → `.dbPickItem`），本文出現
 *   ③ 搜一個 Ext 字、點命中 → `.gw` 出現、`.gwT` 還是原字
 *   ④ 設定關掉 → `.gw` 歸零
 *
 * 跑完一律把 exe 收掉（AGENTS.md：不要留行程）。
 */
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const here = import.meta.dir;
const ROOT = resolve(here, '../..');
const arg = (n: string, d?: string) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; };
const EXE = resolve(arg('exe', 'D:/accelon3/accelon26.exe')!);
const CHAR = arg('char', '𣏌')!;
const PORT = Number(arg('port', String(9300 + (process.pid % 200))));

if (!existsSync(EXE)) { console.error(`找不到 exe：${EXE}`); process.exit(2); }

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}${detail ? '：' + detail : ''}`); }
};

const proc = Bun.spawn([EXE, '-debug-port', String(PORT)], { stdout: 'ignore', stderr: 'ignore', cwd: resolve(EXE, '..') });
const cleanup = () => { try { Bun.spawnSync(['taskkill', '/T', '/F', '/PID', String(proc.pid)], { stdout: 'ignore', stderr: 'ignore' }); } catch { /* ignore */ } };

// 等 WebView2 的 DevTools 端點
let target = '';
for (let i = 0; i < 240; i++) {
  try {
    const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json()) as { type: string; webSocketDebuggerUrl: string }[];
    const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (page) { target = page.webSocketDebuggerUrl; break; }
  } catch { /* 還沒起來 */ }
  await Bun.sleep(250);
}
if (!target) { cleanup(); console.error('exe 的 WebView2 沒有開起來（DevTools 端點等不到）'); process.exit(2); }

const ws = new WebSocket(target);
await new Promise<void>((ok2, bad) => { ws.onopen = () => ok2(); ws.onerror = () => bad(new Error('ws')); });
let id = 0;
const pend = new Map<number, (v: any) => void>();
ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.id && pend.has(m.id)) { pend.get(m.id)!(m); pend.delete(m.id); } };
async function send(method: string, params: Record<string, unknown> = {}): Promise<any> {
  const my = ++id;
  const p = new Promise<any>((ok2) => pend.set(my, ok2));
  ws.send(JSON.stringify({ id: my, method, params }));
  const r = await p;
  if (r.error) throw new Error(method + ': ' + JSON.stringify(r.error));
  return r.result;
}
const ev = async (x: string): Promise<any> => (await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true })).result?.value;
await send('Runtime.enable');

let ready = false;
for (let i = 0; i < 200; i++) { ready = await ev('!!window.__accelon26'); if (ready) break; await Bun.sleep(150); }
ok('exe 的頁面 boot 完成', ready);

// ① asset 真的送得出來
const asset = await ev(`(async () => {
  const r = await fetch('pinxing.bin.gz');
  const b = await r.arrayBuffer();
  return JSON.stringify({ status: r.status, bytes: b.byteLength, magic: [...new Uint8Array(b.slice(0, 2))] });
})()`);
const a = JSON.parse(String(asset ?? '{}')) as { status: number; bytes: number; magic: number[] };
ok('fetch("pinxing.bin.gz") 成功', a.status === 200 && a.bytes > 1_000_000, JSON.stringify(a));
ok('是 gzip（魔數 1f 8b）', a.magic?.[0] === 0x1f && a.magic?.[1] === 0x8b, String(a.magic));

// ② 開一個 adb
const opened = await ev(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  document.getElementById('dbPickBtn')?.click();
  await sleep(350);
  const items = [...document.querySelectorAll('#dbPickMenu .dbPickItem[data-key]')];
  if (!items.length) return JSON.stringify({ none: true });
  const want = items.map((i) => i.querySelector('.dbPickName')?.textContent ?? '');
  // 先找十三經（測試字 𣏌 在那裡），找不到就第一個
  const pick = items.find((i) => (i.querySelector('.dbPickName')?.textContent ?? '').includes('十三經')) ?? items[0];
  pick.click();
  for (let k = 0; k < 150; k++) { await sleep(100); if (document.querySelectorAll('#docText .docLine').length > 0) break; }
  await sleep(500);
  return JSON.stringify({ picked: pick.querySelector('.dbPickName')?.textContent ?? '', list: want.length, lines: document.querySelectorAll('#docText .docLine').length });
})()`);
const o = JSON.parse(String(opened ?? '{}')) as { picked?: string; lines?: number; none?: boolean };
ok('從資料夾清單開啟 adb 並出現本文', !!o.picked && (o.lines ?? 0) > 0, JSON.stringify(o));

// ③ 搜 Ext 字 → 點命中 → .gw
await ev(`(async () => {
  const q = document.querySelector('#query');
  q.value = ${JSON.stringify(CHAR)};
  q.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 1200));
})()`);
let gw = 0;
const clicked = await ev(`(async () => {
  const b = document.querySelector('#searchList .snippet[data-va]');
  if (!b) return false;
  b.click();
  await new Promise((r) => setTimeout(r, 1200));
  return true;
})()`);
// 這一項只是「搜不到就自己想辦法跳到有 Ext 字的那一頁」的輔助步驟；
// 開庫的第一頁本來就可能已經有 Ext 字（13j 就是），那就不必搜。
for (let i = 0; i < 80; i++) { gw = Number(await ev('document.querySelectorAll("#docText .gw").length')); if (gw > 0) break; await Bun.sleep(150); }
ok(`本文出現 .gw`, gw > 0, `.gw = ${gw}`);
const detail = JSON.parse(String(await ev(`JSON.stringify({
  n: document.querySelectorAll('#docText .gw').length,
  nSvg: document.querySelectorAll('#docText .gw svg.gwG').length,
  texts: [...new Set([...document.querySelectorAll('#docText .gw .gwT')].map((t) => t.textContent))].slice(0, 3),
  want: ${JSON.stringify(CHAR)}
})`)));
ok('每個 .gw 都有 svg.gwG', detail.nSvg === detail.n, `${detail.nSvg}/${detail.n}`);
{
  const cps = JSON.parse(String(await ev(`JSON.stringify([...document.querySelectorAll('#docText .gwT')].map((t) => t.textContent.codePointAt(0)))`))) as number[];
  const inRange = (cp: number) => (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x20000 && cp <= 0x323af) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0x2f800 && cp <= 0x2fa1f);
  ok('每個 .gwT 都還是原字（Ext 範圍的單一碼位）', cps.length > 0 && cps.every(inRange),
    cps.slice(0, 6).map((cp) => 'U+' + cp.toString(16).toUpperCase()).join(' '));
}

// ④ 設定關掉 → 歸零
const off = await ev(`(async () => {
  const box = document.querySelector('#setGlyphs');
  if (!box) return 'no-checkbox';
  box.checked = false;
  box.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 900));
  return document.querySelectorAll('#docText .gw').length;
})()`);
ok('設定關掉後 .gw 歸零', off === 0, `剩 ${off}`);

// 可選：截一張 exe 裡的本文（給人看）
const png = arg('png');
if (png) {
  // 先把 About／設定關掉，讓本文露出來
  await ev("document.querySelector('#aboutClose')?.click(); document.querySelector('#settingsClose')?.click(); document.querySelector('#aboutBox')?.setAttribute('hidden',''); document.querySelector('#settingsBox')?.setAttribute('hidden','');");
  await Bun.sleep(400);
  const cap = await send('Page.captureScreenshot', { format: 'png' });
  const { writeFileSync } = await import('node:fs');
  writeFileSync(resolve(ROOT, png), Buffer.from(cap.data, 'base64'));
  console.log('  截圖：' + resolve(ROOT, png));
}
cleanup();
try { rmSync(resolve(ROOT, 'build/.glyphtest-' + process.pid), { recursive: true, force: true }); } catch { /* ignore */ }
console.log(`\n${pass} 項通過、${fail} 項失敗`);
process.exit(fail ? 1 : 0);
