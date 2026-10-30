#!/usr/bin/env bun
/**
 * 「對照」分頁與圖版選單的煙霧測試（2026-10-30）。
 *
 *   cd ts && bun run tools/map-test.ts [--map ../build/goryeo_taisho.adb]
 *                                     [--taisho D:/accelon3/taisho.adb]
 *
 * 驗：
 *   1. 開 goryeo_taisho.adb → 左欄出現「對照」，6,357 卷
 *   2. 輸入 T05p0002c0405 → 換出 K…，兩顆圖版按鈕的網址格式正確
 *   3. 清單選一卷、省略藏別輸入（5p2c）都有結果
 *   4. 換開 taisho.adb → 選取本文，選單出現「看大正藏圖版」與「看高麗藏圖版」
 *      且網址是 DIA／KABC 的形式；位址的冊頁欄與頁 id 相符
 */
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const ROOT = resolve(import.meta.dir, '../..');
const HTML = resolve(opt('html', resolve(ROOT, 'build/accelon26.html')));
const MAP = resolve(opt('map', resolve(ROOT, 'build/goryeo_taisho.adb')));
const TAISHO = resolve(opt('taisho', 'D:/accelon3/taisho.adb'));
const GORYEO = resolve(opt('goryeo', resolve(ROOT, 'build/goryeo.adb')));
const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const browser = BROWSERS.find((p) => existsSync(p));
if (!browser) { console.error('no Chromium browser'); process.exit(2); }
if (!existsSync(MAP)) { console.error('no ' + MAP); process.exit(2); }
const profile = resolve(ROOT, 'build/.chrome-profile-map-' + process.pid);
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
        if (m.method === 'Runtime.consoleAPICalled') {
          const text = (m.params?.args ?? []).map((a: any) => a.value ?? a.description ?? a.type).join(' ');
          c.logs.push(`[${m.params?.type}] ${text}`);
        } else if (m.method === 'Runtime.exceptionThrown') {
          c.logs.push('[exception] ' + (m.params?.exceptionDetails?.exception?.description ?? m.params?.exceptionDetails?.text));
        }
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

async function pickFile(file: string): Promise<void> {
  const doc = await cdp.send('DOM.getDocument');
  const q = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#file' });
  await cdp.send('DOM.setFileInputFiles', { files: [file], nodeId: q.nodeId });
  await cdp.eval('document.querySelector("#file").dispatchEvent(new Event("change"))');
}

// ---------------------------------------------------------------- phase 1
// 先開一次 taisho（放進 catalog／slot），下面才能測「從對照結果在大正藏開啟」
await pickFile(TAISHO);
await Bun.sleep(5000);
// goryeo 也先開（測「按經名去圈字那一藏」時要用）
await pickFile(GORYEO);
await Bun.sleep(5000);
await pickFile(MAP);
await Bun.sleep(4000);

// Alt+1…5：依晶片順序切 adb（taisho / goryeo / 對照）
const r0 = JSON.parse(await cdp.eval<string>(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  window.__accelon26.closeAbout?.();
  await sleep(300);
  const chips = () => [...document.querySelectorAll('#dbTabs .dbChip')];
  const active = () => chips().findIndex((el) => el.classList.contains('active'));
  const alt = (n) => window.dispatchEvent(new KeyboardEvent('keydown', { key: String(n), code: 'Digit' + n, altKey: true, bubbles: true }));
  const out = { count: chips().length, start: active() };
  alt(1); await sleep(500); out.alt1 = active();
  alt(3); await sleep(500); out.alt3 = active();
  alt(9); await sleep(400); out.alt9 = active();
  // Alt+O／S／A（開清單／全庫搜尋／關於）
  const key = (code) => window.dispatchEvent(new KeyboardEvent('keydown', { code, key: code.replace(/^Key/, '').toLowerCase(), altKey: true, bubbles: true }));
  // Esc 要從有焦點的元素送出，document／window 的監聽器才收得到
  const esc = () => (document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
  key('KeyO'); await sleep(400);
  out.pickOpen = !document.getElementById('dbPickMenu').hidden;
  out.pickFocus = (document.activeElement || {}).className || '';
  esc(); await sleep(300);
  out.pickClosed = document.getElementById('dbPickMenu').hidden;
  key('KeyS'); await sleep(400);
  out.allOpen = !document.getElementById('allSearchBox').hidden;
  esc(); await sleep(300);
  key('KeyA'); await sleep(400);
  out.aboutOpen = !document.getElementById('aboutBox').hidden;
  esc(); await sleep(300);
  alt(1); await sleep(500); out.final = active();
  out.db = window.__accelon26.state().db;
  return JSON.stringify(out, null, 1);
})()`));

const r1 = JSON.parse(await cdp.eval<string>(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const api = window.__accelon26;
  const out = {};
  out.state = await api.mapState();
  out.db = api.state().db;
  out.trees = await api.treesInfo();
  const tab = document.querySelector('#colLeft .tabBtn[data-tab="map"]');
  out.tabVisible = !!tab && !tab.hidden;
  out.tabLabel = tab?.textContent ?? '';
  out.tabActive = !!tab && tab.classList.contains('active');
  out.noMeta = !document.getElementById('mapMeta') && !document.getElementById('mapResult');
  out.chips = [...document.querySelectorAll('#dbTabs .dbChip')].map((el) => (el.textContent || '').replace('✕', '').trim());
  const list = document.getElementById('mapList');
  const input = document.getElementById('mapQuery');
  const rows = () => [...document.querySelectorAll('#mapList .mapHit')];
  const texts = () => rows().map((el) => (el.textContent || '').replace(/\\s+/g, ' ').trim());
  const buttons = () => rows().map((el) => el.querySelector('.mapHitOpen')?.textContent ?? '');
  const enter = () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  // renderMap 是非同步的，送出後要等它跑完（否則會讀到上一筆的列）
  const set = async (v) => { input.value = v; input.dispatchEvent(new Event('input', { bubbles: true })); enter(); await sleep(350); };
  const wait = async (n) => { for (let i = 0; i < 80; i++) { if (rows().length >= n) return; await sleep(100); } };

  // 一開始：只有說明，沒有清單
  out.helpText = (list.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60);
  out.helpRows = rows().length;

  // 位置：位置那一筆＋對照那一筆
  await set('T05p0002c0405'); await wait(2);
  out.posRows = texts();
  out.posButtons = buttons();
  out.posTips = rows().map((el) => el.title);
  out.posRowHeight = rows()[0]?.offsetHeight ?? 0;
  const kAddr1 = (out.posTips?.[0] ?? '').split(' ⇄ ')[1] ?? '';
  out.lineT = await api.posmapLineOf('T05p0002c0405');
  out.lineK = kAddr1 ? await api.posmapLineOf(kAddr1) : null;

  // 範圍：-0507 = 同頁同欄第 5 行第 7 字
  await set('T05p0002c0405-0507');
  for (let i = 0; i < 40; i++) { if ((rows()[0]?.title || '').includes('→')) break; await sleep(100); }
  out.rangeTips = rows().map((el) => el.title);

  // 終點只給頁＋欄：到那一欄尾
  await set('T05p0002c0405-0003a');
  for (let i = 0; i < 40; i++) { if ((rows()[0]?.title || '').includes('0003a')) break; await sleep(100); }
  out.pageEndTip = rows()[0]?.title ?? '';

  // 數字：1 → 大正、高麗各一筆
  await set('1'); await wait(2);
  out.num1 = texts();
  out.num1Buttons = buttons();
  out.num1Marks = rows().map((el) => el.querySelector('.mapMark')?.className ?? '');

  // 1.2 → 第二卷
  await set('1.2'); await wait(2);
  out.num12 = texts();

  // T 前綴 → 只找大正
  await set('T1'); await wait(1);
  out.t1 = texts();
  out.t1Buttons = buttons();
  out.t1Marks = rows().map((el) => el.querySelector('.mapMark')?.className ?? '');

  // 文字
  await set('大般若'); await wait(2);
  out.text = texts();
  out.textButtons = buttons();

  // 卷題不該夾帶 migrator 的標記（^half〔別名〕）：查長阿含不應出現「中本起經」
  await set('長阿含'); await wait(1);
  out.changahan = texts();
  await set('中本起'); await wait(1);
  out.zhongbenqi = texts();

  // 清空 → 回說明
  await set(''); await sleep(200);
  out.helpAgain = rows().length === 0 && (list.textContent || '').includes('輸入文字找經名');

  out.convertApi = await api.posmapConvert('K01p0001a0105');
  out.badInput = await api.posmapConvert('亂打');
  return JSON.stringify(out, null, 1);
})()`));

// ---------------------------------------------------------------- phase 2
await cdp.eval('window.__accelon26.closeAbout?.(); document.getElementById("about")?.setAttribute("hidden",""); true').catch(() => {});
await Bun.sleep(300);
const shotRes = await cdp.send('Page.captureScreenshot', { format: 'png' }).catch(() => null);
if (shotRes?.data) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(resolve(ROOT, 'build/map-pane.png'), Buffer.from(shotRes.data, 'base64'));
}

// 再拍一張有結果的（輸入 1）
await cdp.eval(`(async () => {
  const i = document.getElementById('mapQuery');
  i.value = '1';
  i.dispatchEvent(new Event('input', { bubbles: true }));
  i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  return true;
})()`).catch(() => {});
await Bun.sleep(700);
const shotRows = await cdp.send('Page.captureScreenshot', { format: 'png' }).catch(() => null);
if (shotRows?.data) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(resolve(ROOT, 'build/map-rows.png'), Buffer.from(shotRows.data, 'base64'));
}

// 按經名（圈字那一藏）→ 高麗；按右邊那顆（大正）→ 大正（都在中間開啟）
const r1b = JSON.parse(await cdp.eval<string>(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const api = window.__accelon26;
  const before = api.state().db;
  const input = document.getElementById('mapQuery');
  input.value = 'T05p0002c0405';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  for (let i = 0; i < 80; i++) { const r = document.querySelector('#mapList .mapHit'); if (r && (r.title || '').includes('T05p0002c0405')) break; await sleep(100); }
  const row = document.querySelector('#mapList .mapHit');
  const mark = row?.querySelector('.mapMark')?.textContent ?? '';
  const button = row?.querySelector('.mapHitOpen')?.textContent ?? '';
  row?.querySelector('.mapHitName')?.click();
  for (let i = 0; i < 60; i++) { if (api.state().db === 'goryeo') break; await sleep(100); }
  await sleep(1200);
  return JSON.stringify({ before, mark, button, after: api.state().db,
    line: !!document.querySelector('#docText .docLine'),
    band: window.__lastJumpBand ?? null,
    openHit: window.__lastOpenHit ?? null,
    hitLines: document.querySelectorAll('#docText .jumpHit').length }, null, 1);
})()`));

// 拍一張：按經名跳過去，本文那一行有色帶
{
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }).catch(() => null);
  if (shot?.data) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(resolve(ROOT, 'build/map-band.png'), Buffer.from(shot.data, 'base64'));
  }
}

// 回對照分頁，這次按右邊那顆（大正）
await pickFile(MAP);
await Bun.sleep(3000);
const r1c = JSON.parse(await cdp.eval<string>(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const api = window.__accelon26;
  const input = document.getElementById('mapQuery');
  input.value = 'T05p0002c0405';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  for (let i = 0; i < 80; i++) { if (document.querySelector('#mapList .mapHit')) break; await sleep(100); }
  const row = document.querySelector('#mapList .mapHit');
  row?.querySelector('.mapHitOpen')?.click();
  for (let i = 0; i < 60; i++) { if (api.state().db === 'taisho') break; await sleep(100); }
  await sleep(700);
  return JSON.stringify({ after: api.state().db, line: !!document.querySelector('#docText .docLine') }, null, 1);
})()`));

await pickFile(TAISHO);
await Bun.sleep(4000);

const r2 = JSON.parse(await cdp.eval<string>(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const api = window.__accelon26;
  const out = {};
  out.db = api.state().db;
  out.chips = [...document.querySelectorAll('#dbTabs .dbChip')].map((el) => (el.textContent || '').replace('✕', '').trim());
  await api.xrefJump('taisho?5p2c');
  for (let i = 0; i < 100; i++) { if (document.querySelector('#docText .docLine')) break; await sleep(100); }
  await sleep(600);
  const lines = [...document.querySelectorAll('#docText .docLine')];
  out.docLines = lines.length;
  const markers = [...document.querySelectorAll('#docText [data-page]')];
  const pageOf = (el) => {
    let best = '', bestIdx = -1;
    for (let i = 0; i < markers.length; i++) {
      const m = markers[i];
      const follows = !!(m.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
      if (follows || el.contains(m)) { best = m.dataset.page; bestIdx = i; }
    }
    return { id: best, marker: markers[bestIdx] };
  };
  // 選一行「落在 5p2c」的本文
  let node = null, lineEl = null, marker = null;
  for (const ln of lines) {
    const p = pageOf(ln);
    if (p.id !== '5p2c') continue;
    const w = document.createTreeWalker(ln, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const mm = /[\\u3400-\\u9fff]{4}/.exec(n.data || '');
      if (mm) { node = n; lineEl = ln; marker = p.marker; break; }
    }
    if (node) break;
  }
  if (!node) return JSON.stringify({ error: 'no 5p2c han text' });
  const m = /[\\u3400-\\u9fff]{4}/.exec(node.data);
  const range = document.createRange();
  range.setStart(node, m.index); range.setEnd(node, m.index + m[0].length);
  const s = window.getSelection(); s.removeAllRanges(); s.addRange(range);
  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
  await sleep(900);
  const menu = document.getElementById('selMenu');
  const t = menu?.querySelector('[data-sel="plateT"]');
  const k = menu?.querySelector('[data-sel="plateK"]');
  out.menuOpen = !!menu && !menu.hidden;
  out.plateT = { hidden: !!t?.hidden, text: t?.textContent ?? '', url: t?.title ?? '' };
  out.plateK = { hidden: !!k?.hidden, text: k?.textContent ?? '', url: k?.title ?? '' };
  out.selText = (window.getSelection()?.toString() || '').slice(0, 20);
  out.lineId = lineEl?.id ?? '';
  // 地址的「欄內行號」：頁標記那一行起算；標記後面還有字就算第 1 行
  const markerLine = marker?.closest('.docLine') ?? null;
  const markerIdx = lines.indexOf(markerLine);
  const selIdx = lines.indexOf(lineEl);
  let hanAfter = 0;
  if (marker && markerLine) {
    const r2 = document.createRange();
    r2.setStartAfter(marker);
    r2.setEnd(markerLine, markerLine.childNodes.length);
    hanAfter = [...r2.toString()].filter((c) => /[\\u3400-\\u9fff\\uf900-\\ufaff]/.test(c)).length;
  }
  out.expectedLine = selIdx - markerIdx + (hanAfter > 0 ? 1 : 0);
  out.markerPage = marker?.dataset.page ?? '';
  out.markerLineId = markerLine?.id ?? '';
  out.selLineId = lineEl?.id ?? '';
  out.atLine = await api.posmapAtLine(Number((lineEl?.id || '0').slice(1)), 0);
  return JSON.stringify(out, null, 1);
})()`));

// 兩層選單的外觀：拍「搜尋」與「查看」兩個第二層
for (const [grp, file] of [['copy', 'menu-copy.png'], ['search', 'menu-search.png'], ['view', 'menu-view.png']] as const) {
  await cdp.eval(`document.querySelector('#selMenu .selGroup[data-grp="${grp}"] .selGroupBtn')?.click(); true`).catch(() => {});
  await Bun.sleep(250);
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }).catch(() => null);
  if (shot?.data) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(resolve(ROOT, 'build/' + file), Buffer.from(shot.data, 'base64'));
  }
}

// ---------------------------------------------------------------- phase 3: goryeo.adb
await pickFile(GORYEO);
await Bun.sleep(5000);

const r3 = JSON.parse(await cdp.eval<string>(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const api = window.__accelon26;
  const out = { db: api.state().db };
  out.chips = [...document.querySelectorAll('#dbTabs .dbChip')].map((el) => (el.textContent || '').replace('✕', '').trim());
  await api.xrefJump('goryeo?17p815a');
  for (let i = 0; i < 120; i++) { if (document.querySelector('#docText .docLine')) break; await sleep(100); }
  await sleep(700);
  const lines = [...document.querySelectorAll('#docText .docLine')];
  const markers = [...document.querySelectorAll('#docText [data-page]')];
  const pageOf = (el) => {
    let best = '';
    for (const m of markers) if ((m.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) || el.contains(m)) best = m.dataset.page;
    return best;
  };
  let node = null, lineEl = null;
  for (const ln of lines) {
    if (pageOf(ln) !== '17p815a') continue;
    const w = document.createTreeWalker(ln, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const mm = /[\\u3400-\\u9fff]{4}/.exec(n.data || '');
      if (mm) { node = n; lineEl = ln; break; }
    }
    if (node) break;
  }
  if (!node) return JSON.stringify({ error: 'no 17p815a han text' });
  const mm = /[\\u3400-\\u9fff]{4}/.exec(node.data);
  const range = document.createRange();
  range.setStart(node, mm.index); range.setEnd(node, mm.index + mm[0].length);
  const s = window.getSelection(); s.removeAllRanges(); s.addRange(range);
  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
  await sleep(900);
  const menu = document.getElementById('selMenu');
  const t = menu?.querySelector('[data-sel="plateT"]');
  const k = menu?.querySelector('[data-sel="plateK"]');
  out.menuOpen = !!menu && !menu.hidden;
  out.plateT = { hidden: !!t?.hidden, url: t?.title ?? '' };
  out.plateK = { hidden: !!k?.hidden, url: k?.title ?? '' };
  out.pageOfSel = pageOf(lineEl);
  out.lineId = lineEl?.id ?? '';
  out.lineText = (lineEl?.textContent ?? '').slice(0, 60);
  out.markerSample = markers.slice(0, 8).map((m) => m.dataset.page);
  out.markerCount = markers.length;
  out.atLine = await api.posmapAtLine(Number((lineEl?.id || '0').slice(1)), 0);
  return JSON.stringify(out, null, 1);
})()`));

// ---------------------------------------------------------------- phase 4: goryeo.adb 單獨開
// 沒有對照表時，高麗藏圖版仍可由 <書 id> 與 <卷 n> 算出來；大正藏圖版不出現。
await cdp.openPage(pathToFileURL(HTML).href + '?v=' + Date.now() + '&fresh');
await Bun.sleep(900);
await pickFile(GORYEO);
await Bun.sleep(5000);

const r4 = JSON.parse(await cdp.eval<string>(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const api = window.__accelon26;
  const out = { db: api.state().db, map: await api.mapState() };
  await api.xrefJump('goryeo?17p815a');
  for (let i = 0; i < 120; i++) { if (document.querySelector('#docText .docLine')) break; await sleep(100); }
  await sleep(700);
  const lines = [...document.querySelectorAll('#docText .docLine')];
  const markers = [...document.querySelectorAll('#docText [data-page]')];
  const pageOf = (el) => { let best = ''; for (const m of markers) if ((m.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) || el.contains(m)) best = m.dataset.page; return best; };
  let node = null;
  for (const ln of lines) {
    if (pageOf(ln) !== '17p815a') continue;
    const w = document.createTreeWalker(ln, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const mm = /[\\u3400-\\u9fff]{4}/.exec(n.data || '');
      if (mm) { node = n; break; }
    }
    if (node) break;
  }
  if (!node) return JSON.stringify({ error: 'no 17p815a han text' });
  const mm = /[\\u3400-\\u9fff]{4}/.exec(node.data);
  const range = document.createRange();
  range.setStart(node, mm.index); range.setEnd(node, mm.index + mm[0].length);
  const s = window.getSelection(); s.removeAllRanges(); s.addRange(range);
  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
  await sleep(900);
  const menu = document.getElementById('selMenu');
  const t = menu?.querySelector('[data-sel="plateT"]');
  const k = menu?.querySelector('[data-sel="plateK"]');
  out.menuOpen = !!menu && !menu.hidden;
  out.plateT = { hidden: !!t?.hidden, url: t?.title ?? '' };
  out.plateK = { hidden: !!k?.hidden, url: k?.title ?? '' };
  return JSON.stringify(out, null, 1);
})()`));

// ---------------------------------------------------------------- phase 5: 只開 taisho（沒有對照表）
// 大正藏圖版只要頁 id，選單一開就要有；高麗藏那顆才需要對照表。
await cdp.openPage(pathToFileURL(HTML).href + '?v=' + Date.now() + '&fresh2');
await Bun.sleep(900);
await pickFile(TAISHO);
await Bun.sleep(5000);

const r5 = JSON.parse(await cdp.eval<string>(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const api = window.__accelon26;
  const out = { db: api.state().db, map: await api.mapState() };
  await api.xrefJump('taisho?5p2c');
  for (let i = 0; i < 120; i++) { if (document.querySelector('#docText .docLine')) break; await sleep(100); }
  await sleep(700);
  const lines = [...document.querySelectorAll('#docText .docLine')];
  const markers = [...document.querySelectorAll('#docText [data-page]')];
  const pageOf = (el) => { let best = ''; for (const m of markers) if ((m.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) || el.contains(m)) best = m.dataset.page; return best; };
  let node = null;
  for (const ln of lines) {
    if (pageOf(ln) !== '5p2c') continue;
    const w = document.createTreeWalker(ln, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const mm = /[\\u3400-\\u9fff]{4}/.exec(n.data || '');
      if (mm) { node = n; break; }
    }
    if (node) break;
  }
  if (!node) return JSON.stringify({ error: 'no 5p2c han text' });
  const mm = /[\\u3400-\\u9fff]{4}/.exec(node.data);
  const range = document.createRange();
  range.setStart(node, mm.index); range.setEnd(node, mm.index + mm[0].length);
  const s = window.getSelection(); s.removeAllRanges(); s.addRange(range);
  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
  await sleep(1200);
  const menu = document.getElementById('selMenu');
  const t = menu?.querySelector('[data-sel="plateT"]');
  const k = menu?.querySelector('[data-sel="plateK"]');
  out.menuOpen = !!menu && !menu.hidden;
  out.plateT = { hidden: !!t?.hidden, url: t?.title ?? '' };
  out.plateK = { hidden: !!k?.hidden, url: k?.title ?? '' };
  return JSON.stringify(out, null, 1);
})()`));

proc.kill();
await Bun.sleep(200);
try { rmSync(profile, { recursive: true, force: true }); } catch { /* browser may hold it */ }

console.log('--- phase 1: goryeo_taisho.adb ---');
console.log(JSON.stringify(r1, null, 1));
console.log('--- phase 2: taisho.adb ---');
console.log(JSON.stringify(r2, null, 1));
console.log('--- phase 3: goryeo.adb ---');
console.log(JSON.stringify(r3, null, 1));
console.log('--- phase 4: goryeo.adb 單獨開（沒有對照表）---');
console.log(JSON.stringify(r4, null, 1));
console.log('--- phase 5: taisho.adb 單獨開（沒有對照表）---');
console.log(JSON.stringify(r5, null, 1));
if (cdp.logs.length) console.log('--- console ---\n' + cdp.logs.join('\n'));

const fails: string[] = [];
if (r0.count !== 3) fails.push('應該開著 3 個 adb：' + JSON.stringify(r0));
if (r0.alt1 !== 0 || r0.alt3 !== 2 || r0.alt9 !== 2 || r0.final !== 0) fails.push('Alt+1／3／9 的切換不對：' + JSON.stringify(r0));
if (!r0.pickOpen || !String(r0.pickFocus).includes('dbPickItem') || !r0.pickClosed) fails.push('Alt+O 應開清單並聚焦第一項：' + JSON.stringify(r0));
if (!r0.allOpen) fails.push('Alt+S 應開全庫搜尋：' + JSON.stringify(r0));
if (!r0.aboutOpen) fails.push('Alt+A 應開關於：' + JSON.stringify(r0));
if (r0.db !== 'goryeo_taisho') fails.push('Alt+1 應回到對照庫：' + r0.db);
if (!r1.tabVisible) fails.push('對照 tab 不應隱藏');
if (!r1.chips?.includes('大正')) fails.push('dbChip 應顯示短名「大正」：' + JSON.stringify(r1.chips));
if (!r1.chips?.includes('高麗⇄大正')) fails.push('對照庫的晶片名不對：' + JSON.stringify(r1.chips));
if (!r3.chips?.includes('高麗')) fails.push('開 goryeo 後晶片應是「高麗」：' + JSON.stringify(r3.chips));
if (r1.tabLabel !== '高麗⇄大正') fails.push('tab 名稱應取 <樹> 的文字：' + r1.tabLabel);
if (r1.state?.rows !== 6357 || r1.state?.records !== 6357) fails.push('map rows / posmap records 應為 6357：' + JSON.stringify(r1.state));
if (!r1.noMeta) fails.push('#mapMeta／#mapResult 應已移除');
if (r1.helpRows !== 0) fails.push('一開始不應有清單：' + r1.helpRows);
if (!String(r1.helpText).includes('輸入文字找經名')) fails.push('一開始應顯示說明：' + r1.helpText);
if (!(r1.posRows?.length >= 2)) fails.push('位置應至少兩筆：' + JSON.stringify(r1.posRows));
if (!r1.posButtons?.includes('大正') || !r1.posButtons?.includes('高麗')) fails.push('位置兩筆的按钮應有 大正／高麗：' + JSON.stringify(r1.posButtons));
if (!/^T05p0002c0405 ⇄ K\d{2}p\d{4}[a-g]\d{4}$/.test(String(r1.posTips?.[0] ?? ''))) fails.push('hover 應顯示字元級位置：' + JSON.stringify(r1.posTips));
if (!String(r1.pageEndTip).includes('T05p0003a')) fails.push('頁＋欄的終點應有 T05p0003a：' + r1.pageEndTip);
if (!/^T05p0002c0405 → T05p0002c0507 ⇄ K\d{2}p\d{4}[a-g]\d{4} → K\d{2}p\d{4}[a-g]\d{4}$/.test(String(r1.rangeTips?.[0] ?? ''))) fails.push('範圍的 hover 應有終點：' + JSON.stringify(r1.rangeTips));
if (r1.posRowHeight > 32) fails.push('一筆列太高：' + r1.posRowHeight + 'px');
if (r1.num1?.length !== 2) fails.push('輸入 1 應有兩筆（大正、高麗各一）：' + JSON.stringify(r1.num1));
if (!r1.num1?.some((t: string) => t.includes('大般若')) || !r1.num1?.some((t: string) => t.includes('長阿含'))) fails.push('輸入 1 應有大般若與長阿含：' + JSON.stringify(r1.num1));
if (!r1.num1Buttons?.includes('大正') || !r1.num1Buttons?.includes('高麗')) fails.push('輸入 1 的按鈕應有 大正／高麗：' + JSON.stringify(r1.num1Buttons));
if (!(r1.num12?.length >= 1) || !r1.num12?.every((t: string) => t.includes('卷2'))) fails.push('輸入 1.2 應只有第二卷：' + JSON.stringify(r1.num12));
if (r1.t1?.length !== 1 || !String(r1.t1Marks?.[0] ?? '').includes('mapMarkT') || !String(r1.t1?.[0] ?? '').includes('長阿含')) fails.push('T1 應只列大正的長阿含：' + JSON.stringify({ rows: r1.t1, marks: r1.t1Marks }));
if (!r1.num1Marks?.some((m: string) => m.includes('mapMarkT')) || !r1.num1Marks?.some((m: string) => m.includes('mapMarkK'))) fails.push('輸入 1 應有大正、高麗兩種圈字：' + JSON.stringify(r1.num1Marks));
if (r1.t1Buttons?.[0] !== '高麗') fails.push('T1 那一筆應開高麗：' + JSON.stringify(r1.t1Buttons));
if (!(r1.text?.length >= 2) || !r1.text?.every((t: string) => t.includes('大般若'))) fails.push('文字搜尋應都是大般若：' + JSON.stringify(r1.text));
if (!r1.textButtons?.includes('大正') || !r1.textButtons?.includes('高麗')) fails.push('文字搜尋的按鈕應有 大正／高麗：' + JSON.stringify(r1.textButtons));
if (!r1.changahan?.length || !r1.changahan.every((t: string) => t.includes('長阿含'))) fails.push('查長阿含不應出現別的經：' + JSON.stringify(r1.changahan));
if (!r1.zhongbenqi?.some((t: string) => t.includes('中本起經'))) fails.push('查中本起應有中本起經：' + JSON.stringify(r1.zhongbenqi));
if (!r1.helpAgain) fails.push('清空後應回說明');
if (r1b.before !== 'goryeo_taisho' || r1b.after !== 'goryeo') fails.push('按經名（圈字高麗）應切到 goryeo：' + JSON.stringify(r1b));
if (r1b.mark !== '高') fails.push('位置那一筆的圈字應是高：' + JSON.stringify(r1b));
if (r1b.button !== '大正') fails.push('位置那一筆的按鈕應是大正：' + JSON.stringify(r1b));
if (!r1b.line) fails.push('按經名後中間應有經文：' + JSON.stringify(r1b));
if (!r1b.band || !(r1b.hitLines > 0)) fails.push('跳過去應把該行塗色帶：' + JSON.stringify({ band: r1b.band, hitLines: r1b.hitLines, openHit: r1b.openHit }));
if (r1c.after !== 'taisho' || !r1c.line) fails.push('按右邊「大正」應切到 taisho 並開啟經文：' + JSON.stringify(r1c));
if (!String(r1.convertApi?.from ?? '').startsWith('K01p0001a')) fails.push('posmapConvert(K01p0001a0105) 應從 K 起算：' + JSON.stringify(r1.convertApi?.from));
if (!r1.badInput?.error) fails.push('看不懂的位址應回 error');
if (r2.error) fails.push('phase 2: ' + r2.error);
if (!r2.menuOpen) fails.push('taisho 選取後選單應打開');
if (r2.plateT?.hidden) fails.push('讀 taisho 時應顯示「看大正藏圖版」');
if (!String(r2.plateT?.url ?? '').startsWith('https://dia.dila.edu.tw/uv3/index.html?id=Tv')) fails.push('DIA 網址不對：' + r2.plateT?.url);
if (!/#\?c=0&m=0&s=0&cv=10&xywh=0%2C1783%2C2236%2C837$/.test(String(r2.plateT?.url ?? ''))) fails.push('DIA 網址應指到 c 欄：' + r2.plateT?.url);
if (r2.plateK?.hidden) fails.push('有對照表時應顯示「看高麗藏圖版」');
if (!/^https:\/\/kabc\.dongguk\.edu\/viewer\/view\?dataId=ABC_IT_K\d{4}[a-d]?_T_\d{3}&imgId=\d{3}_\d{4}_[a-g]$/.test(String(r2.plateK?.url ?? ''))) fails.push('KABC 網址不對：' + r2.plateK?.url);
if (!String(r2.atLine?.from ?? '').startsWith('T05p0002c')) fails.push('posmapAtLine 應落在 T05p0002c：' + r2.atLine?.from);
if (r2.atLine?.t?.line !== r2.expectedLine) fails.push(`欄內行號應為 ${r2.expectedLine}，實得 ${r2.atLine?.t?.line}`);
if (r2.markerPage !== '5p2c') fails.push('測試自己沒選到 5p2c：' + r2.markerPage);
if (r3.error) fails.push('phase 3: ' + r3.error);
if (!r3.menuOpen) fails.push('goryeo 選取後選單應打開');
if (r3.plateK?.hidden) fails.push('讀 goryeo 時應顯示「看高麗藏圖版」');
if (!/dataId=ABC_IT_K0647_T_001&imgId=017_0815_[a-g]/.test(String(r3.plateK?.url ?? ''))) fails.push('KABC 網址應是 K0647 卷1 冊17 頁815：' + r3.plateK?.url);
if (r3.plateT?.hidden) fails.push('有對照表時，讀 goryeo 也應能看大正藏圖版');
if (!String(r3.plateT?.url ?? '').startsWith('https://dia.dila.edu.tw/uv3/index.html?id=Tv01p')) fails.push('goryeo→大正 DIA 網址不對：' + r3.plateT?.url);
if (!/#\?c=0&m=0&s=0&cv=10&xywh=0%2C(214|1001|1783)%2C2236%2C837$/.test(String(r3.plateT?.url ?? ''))) fails.push('goryeo→大正 DIA 網址應指到某一欄：' + r3.plateT?.url);
if (!String(r3.atLine?.from ?? '').startsWith('K17p0815a') && !String(r3.atLine?.from ?? '').startsWith('K17p815a')) fails.push('goryeo 位址應在 17p815a：' + r3.atLine?.from);
if (r4.error) fails.push('phase 4: ' + r4.error);
if (r4.map?.records !== 0) fails.push('phase 4 不應載入對照表：' + JSON.stringify(r4.map));
if (r4.plateK?.hidden) fails.push('沒有對照表時，讀 goryeo 仍應看高麗藏圖版');
if (!/dataId=ABC_IT_K0647_T_001&imgId=017_0815_[a-g]/.test(String(r4.plateK?.url ?? ''))) fails.push('phase 4 KABC 網址不對：' + r4.plateK?.url);
if (!r4.plateT?.hidden) fails.push('沒有對照表時不應顯示大正藏圖版');
if (r5.error) fails.push('phase 5: ' + r5.error);
if (!r5.menuOpen) fails.push('phase 5 選取後選單應打開');
if (r5.plateT?.hidden) fails.push('phase 5：只開 taisho 也應有「看大正藏圖版」');
if (!String(r5.plateT?.url ?? '').startsWith('https://dia.dila.edu.tw/uv3/index.html?id=Tv05p')) fails.push('phase 5 DIA 網址不對：' + r5.plateT?.url);
if (!/#\?c=0&m=0&s=0&cv=10&xywh=0%2C1783%2C2236%2C837$/.test(String(r5.plateT?.url ?? ''))) fails.push('phase 5 DIA 網址應指到 c 欄：' + r5.plateT?.url);
if (!r5.plateK?.hidden) fails.push('phase 5 沒有對照表時不應顯示高麗藏圖版');
if (fails.length) { console.error('FAIL:\n- ' + fails.join('\n- ')); process.exit(1); }
console.log('ok: 對照分頁與圖版選單');
