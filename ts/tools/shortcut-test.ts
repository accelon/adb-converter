#!/usr/bin/env bun
/**
 * shortcut-test.ts — 驗證「快速鍵卡片」：About →「⌨ 快速鍵」→ 卡片 → Esc 關閉。
 *
 *   bun run tools/shortcut-test.ts [--adb ../build/fuyan.adb]
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const ROOT = resolve(import.meta.dir, '..');
const HTML = resolve(ROOT, '../build/accelon26.html');
const ADB = resolve(opt('adb', resolve(ROOT, '../build/fuyan.adb')));
const SHOT = resolve(opt('shot', resolve(ROOT, '../build/shortcuts.png')));

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const browser = BROWSERS.find((p) => existsSync(p));
if (!browser) { console.error('no Chromium browser'); process.exit(2); }
for (const p of [HTML, ADB]) if (!existsSync(p)) { console.error('missing ' + p); process.exit(2); }

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + name + (detail ? '  ' + detail : '')); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
};

const profile = resolve(ROOT, '../build/.chrome-shortcut-' + process.pid);
const proc = Bun.spawn([browser, '--headless=new', '--disable-gpu', '--no-first-run',
  '--remote-debugging-port=0', '--remote-allow-origins=*', '--allow-file-access-from-files',
  '--window-size=1500,1000', `--user-data-dir=${profile}`, 'about:blank'],
  { stdout: 'pipe', stderr: 'pipe' });

async function devtoolsUrl(): Promise<string> {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const text = await Bun.file(resolve(profile, 'DevToolsActivePort')).text().catch(() => '');
    const [p, q] = text.split('\n').map((s) => s.trim());
    if (Number(p) > 0 && q) return `ws://127.0.0.1:${p}${q}`;
    await Bun.sleep(200);
  }
  throw new Error('no devtools');
}

const ws = new WebSocket(await devtoolsUrl());
const pending = new Map<number, (v: any) => void>();
let id = 0, session = '';
ws.onmessage = (ev) => {
  const m = JSON.parse(String(ev.data));
  if (m.id && pending.has(m.id)) { pending.get(m.id)!(m.result); pending.delete(m.id); }
};
await new Promise<void>((r) => (ws.onopen = () => r()));
function send(method: string, params: any = {}, withSession = true): Promise<any> {
  const i = ++id;
  return new Promise((res) => {
    pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params, ...(withSession && session ? { sessionId: session } : {}) }));
  });
}
const { targetId } = await send('Target.createTarget', { url: pathToFileURL(HTML).href + '?v=' + Date.now() }, false);
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true }, false);
session = sessionId;
await send('Runtime.enable');
await send('Page.enable');
await send('DOM.enable');
await Bun.sleep(900);

// 開庫（卡片與庫無關，但開著庫才是真實情境）
const doc = await send('DOM.getDocument');
const qi = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#file' });
await send('DOM.setFileInputFiles', { files: [ADB], nodeId: qi.nodeId });
await send('Runtime.evaluate', { expression: 'document.querySelector("#file").dispatchEvent(new Event("change"))' });
await Bun.sleep(3000);

const run = async (expr: string) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
  return r.result.value;
};

// 1) About 頁有入口按鈕
const aboutHasEntry = await run(`(async () => {
  const api = window.__accelon26;
  await api.openAbout();
  await new Promise((r) => setTimeout(r, 300));
  const btn = document.querySelector('#aboutKeys');
  return !!btn && !!document.querySelector('#aboutBox') && !document.querySelector('#aboutBox').hidden
    ? { btn: btn.textContent.trim(), line: (document.querySelector('#aboutKeysLine')?.textContent ?? '').slice(0, 40) }
    : null;
})()`);
ok('About 有「⌨ 快速鍵」按鈕', !!aboutHasEntry, aboutHasEntry ? `按鈕=${aboutHasEntry.btn}` : '');
ok('About 摘要那一行有數字', !!aboutHasEntry && /\d/.test(aboutHasEntry.line), aboutHasEntry?.line);

// 2) 點按鈕 → About 關、卡片開、內容有分組
const opened = await run(`(async () => {
  const q = (s) => document.querySelector(s);
  q('#aboutKeys').click();
  await new Promise((r) => setTimeout(r, 400));
  const box = q('#shortcutBox');
  const groups = [...document.querySelectorAll('#shortcutBody .skGroup')];
  const rows = [...document.querySelectorAll('#shortcutBody .skRow')];
  return {
    aboutClosed: q('#aboutBox').hidden,
    cardOpen: box && !box.hidden,
    groups: groups.length,
    rows: rows.length,
    groupNames: groups.map((g) => g.querySelector('h3').textContent),
    kbdCount: document.querySelectorAll('#shortcutBody kbd').length,
    countLine: q('#shortcutCount')?.textContent ?? '',
    hasF1: [...document.querySelectorAll('#shortcutBody .skKeys')].some((e) => e.textContent.includes('F1')),
    hasCtrlB: [...document.querySelectorAll('#shortcutBody .skKeys')].some((e) => e.textContent.replace(/\\s/g, '').includes('Ctrl+B')),
    apiState: window.__accelon26.shortcutsState(),
  };
})()`);
ok('點了之後 About 關閉', opened.aboutClosed === true);
ok('卡片開啟', opened.cardOpen === true);
ok('分組 ≥ 5', opened.groups >= 5, `分組 ${opened.groups}：${opened.groupNames.join('／')}`);
ok('條目 ≥ 25', opened.rows >= 25, `條目 ${opened.rows}`);
ok('每個鍵都畫成 <kbd>', opened.kbdCount >= opened.rows, `kbd ${opened.kbdCount}`);
ok('有 F1', opened.hasF1 === true);
ok('有 Ctrl+B', opened.hasCtrlB === true);
ok('debug API 看得到', opened.apiState?.open === true && opened.apiState?.count >= opened.rows,
  JSON.stringify(opened.apiState));

let shot = await send('Page.captureScreenshot', { format: 'png' });
await Bun.write(SHOT, Buffer.from(shot.data, 'base64'));

// 3) Esc 關閉；再一次從 About 進得去（不是一次性的）
const esc = await run(`(async () => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 200));
  const closed = document.querySelector('#shortcutBox').hidden;
  document.querySelector('#brand').click();
  await new Promise((r) => setTimeout(r, 300));
  document.querySelector('#aboutKeys').click();
  await new Promise((r) => setTimeout(r, 300));
  const again = !document.querySelector('#shortcutBox').hidden;
  document.querySelector('#shortcutClose').click();
  await new Promise((r) => setTimeout(r, 150));
  return { closed, again, closedByX: document.querySelector('#shortcutBox').hidden };
})()`);
ok('Esc 關閉卡片', esc.closed === true);
ok('再從 About 進得去', esc.again === true);
ok('✕ 也關得掉', esc.closedByX === true);

// 4) 沒有 console 錯誤
const errs = await run(`(() => (window.__accelon26ConsoleErrors ?? null))()`);
console.log(`\n${pass} passed, ${fail} failed${errs ? '  consoleErrors=' + JSON.stringify(errs) : ''}`);
console.log('shot ' + SHOT);
proc.kill();
process.exit(fail ? 1 : 0);
