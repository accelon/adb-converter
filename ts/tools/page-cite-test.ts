/**
 * 「頁行」引用（作者 2026-11-01）：`y38p7a8` 讓 ys／fuyan 也能跳行。
 *
 *   bun run tools/page-cite-test.ts [--html build/accelon26.html] [--ys ..] [--fuyan ..]
 *
 * 驗的是：
 *   1. 語法：`y38p7a8`／`y38p7`／`y38` 解析正確；全形、大小寫、`p.` 都接受；
 *      `#123`、`1.2.3`、`49p15`、`大正2，206a15` 不會被誤吃
 *   2. 同一頁的 a/b/c 欄算**一頁**（ys 有 157 頁有第二欄）
 *   3. `y38p7a8` 真的跳到第 38 部書第 7 頁的第 8 行（色帶在那一行）
 *   4. `y38p7` 跳頁首、`y38` 跳書首（兩者不同行）
 *   5. fuyan 沒有分欄，`f1p7a3` 也能跳（一律 a 欄）
 *   6. cheat card 與快速鍵卡片都寫了這個語法
 */
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const ROOT = resolve(import.meta.dir, '../..');
const HTML = resolve(opt('html', resolve(ROOT, 'build/accelon26.html')));
const YS = resolve(opt('ys', resolve(ROOT, '../../accelon3/ys.adb')));
const FUYAN = resolve(opt('fuyan', resolve(ROOT, '../../accelon3/fuyan.adb')));
const YL38 = resolve(opt('yl38', resolve(ROOT, '../../accelon3/yl38.adb')));
const PORT = Number(opt('port', String(8300 + Math.floor(Math.random() * 90))));

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const browser = BROWSERS.find((p) => existsSync(p));
if (!browser) { console.error('no Chromium browser found'); process.exit(2); }
if (!existsSync(HTML)) { console.error('missing ' + HTML); process.exit(2); }
for (const f of [YS, FUYAN, YL38]) if (!existsSync(f)) { console.error('missing ' + f); process.exit(2); }

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + name + (detail ? '  ' + detail : '')); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
};

const server = Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/accelon26.html') {
      return new Response(Bun.file(HTML), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    if (url.pathname === '/ys.adb') return new Response(Bun.file(YS), { headers: { 'Content-Type': 'application/octet-stream' } });
    if (url.pathname === '/fuyan.adb') return new Response(Bun.file(FUYAN), { headers: { 'Content-Type': 'application/octet-stream' } });
    if (url.pathname === '/yl38.adb') return new Response(Bun.file(YL38), { headers: { 'Content-Type': 'application/octet-stream' } });
    return new Response('not found', { status: 404 });
  },
});

const profile = resolve(ROOT, `build/.chrome-profile-pc-${process.pid}-${Date.now() % 100000}`);
const proc = Bun.spawn([browser, '--headless=new', '--disable-gpu', '--no-first-run',
  '--remote-debugging-port=0', '--remote-allow-origins=*',
  `--user-data-dir=${profile}`, '--no-default-browser-check',
  'about:blank'], { stdout: 'pipe', stderr: 'pipe' });

async function devtoolsUrl(): Promise<string> {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const text = await Bun.file(resolve(profile, 'DevToolsActivePort')).text().catch(() => '');
    const [portLine, pathLine] = text.split('\n').map((s) => s.trim());
    if (Number(portLine) > 0 && pathLine) return `ws://127.0.0.1:${portLine}${pathLine}`;
    await Bun.sleep(200);
  }
  throw new Error('DevToolsActivePort never appeared');
}

class Cdp {
  private ws!: WebSocket;
  private id = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private sessionId = '';
  logs: string[] = [];
  static async attach(url: string): Promise<Cdp> {
    const c = new Cdp();
    await new Promise<void>((res, rej) => {
      c.ws = new WebSocket(url);
      c.ws.onopen = () => res();
      c.ws.onerror = (e) => rej(new Error('ws error ' + String(e)));
      c.ws.onmessage = (ev) => {
        const m = JSON.parse(String(ev.data));
        if (m.id && c.pending.has(m.id)) {
          const p = c.pending.get(m.id)!; c.pending.delete(m.id);
          m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
          return;
        }
        if (m.method === 'Runtime.exceptionThrown') c.logs.push('exception: ' + (m.params.exceptionDetails?.exception?.description ?? '?'));
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
      setTimeout(() => { if (this.pending.delete(id)) rej(new Error('timeout ' + method)); }, 300000);
    });
  }
  async openPage(url: string) {
    const { targetId } = await this.send('Target.createTarget', { url }, false);
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true }, false);
    this.sessionId = sessionId;
    await this.send('Runtime.enable');
    await this.send('Page.enable');
  }
  async eval<T>(expression: string): Promise<T> {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
    return r.result.value as T;
  }
}

try {
  const cdp = await Cdp.attach(await devtoolsUrl());
  await cdp.openPage(`http://127.0.0.1:${PORT}/accelon26.html`);
  await Bun.sleep(700);

  const setup = await cdp.eval<any>(`
    (async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const openDb = async (path, name) => {
        const res = await fetch(path);
        const blob = await res.blob();
        await window.__accelon26.openFile(new File([blob], name, { type: 'application/octet-stream' }));
        for (let i = 0; i < 600; i++) {
          const p = window.__accelon26.state().treePhases ?? {};
          if (p.instances !== undefined || p.skipped !== undefined) break;
          await sleep(150);
        }
        await sleep(500);
      };
      await openDb('/ys.adb', 'ys.adb');
      const ysDb = window.__accelon26.state().db;
      await openDb('/fuyan.adb', 'fuyan.adb');
      const fuyanDb = window.__accelon26.state().db;
      await openDb('/yl38.adb', 'yl38.adb');
      const yl38Db = window.__accelon26.state().db;
      return { ysDb, fuyanDb, yl38Db };
    })()
  `);
  ok('三個庫都開得起來（ys／fuyan／yl38）', setup.ysDb === 'ys' && setup.fuyanDb === 'fuyan' && setup.yl38Db === 'yl38', JSON.stringify(setup));

  // ---- 1) 語法（純函式） ----
  const syntax = await cdp.eval<any>(`
    (() => {
      const p = (s) => window.__accelon26.pageCite(s);
      return {
        full: p('y38p7a8'), page: p('y38p7'), book: p('y38'),
        upper: p('Y38P7A8'), wide: p('ｙ３８ｐ７ａ８'), dot: p('y38p.7a8'),
        name: p('fuyan1p7a3'), noCol: p('f1p7'),
        hash: p('#123'), toc: p('1.2.3'), pageId: p('49p15'), taisho: p('大正2，206a15'),
        zero: p('y0'), zeroRev: p('8p'),
      };
    })()
  `);
  ok('y38p7a8 → 書38、頁7、a欄、第8行',
    JSON.stringify(syntax.full) === JSON.stringify({ db: 'ys', book: 38, page: 7, col: 'a', line: 8 }),
    JSON.stringify(syntax.full));
  ok('y38p7 → 頁首（沒有行號）；y38 → 書首（沒有頁號）',
    syntax.page?.page === 7 && syntax.page?.line === null
    && syntax.book?.book === 38 && syntax.book?.page === null,
    `${JSON.stringify(syntax.page)}｜${JSON.stringify(syntax.book)}`);
  ok('全形／大寫／p. 都接受',
    syntax.upper?.line === 8 && syntax.wide?.line === 8 && syntax.dot?.line === 8,
    `${JSON.stringify(syntax.upper)}｜${JSON.stringify(syntax.wide)}｜${JSON.stringify(syntax.dot)}`);
  ok('庫名全寫也可以（fuyan1p7a3）', syntax.name?.db === 'fuyan' && syntax.name?.page === 7,
    JSON.stringify(syntax.name));
  ok('不會誤吃 #123／1.2.3／49p15／大正引用',
    [syntax.hash, syntax.toc, syntax.pageId, syntax.taisho].every((x: any) => x === null),
    JSON.stringify([syntax.hash, syntax.toc, syntax.pageId, syntax.taisho]));
  ok('不合法的（y0）不收', syntax.zero === null, JSON.stringify(syntax.zero));

  // ---- 2) 解析到頁（b 欄算同一頁） ----
  const resolved = await cdp.eval<any>(`
    (async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const out = {};
      for (const [k, text] of [['p7a8', 'y38p7a8'], ['p7', 'y38p7'], ['book', 'y38'], ['fuyan', 'f1p7a3']]) {
        out[k] = await window.__accelon26.pageCiteResolve(text);
        await sleep(120);
      }
      return out;
    })()
  `);
  ok('y38p7a8 解析到第 38 部書的第 7 頁',
    resolved.p7a8?.book === 38 && resolved.p7a8?.id && resolved.p7a8?.line === resolved.p7a8?.baseLine + 7,
    JSON.stringify(resolved.p7a8));
  ok('頁的 a/b/c 欄算同一頁（b 欄頁 id 與 a 欄同一個「頁」）',
    !!resolved.p7a8?.id && /[a-c]$/i.test(resolved.p7a8.id),
    `頁 id ${resolved.p7a8?.id}、欄 ${resolved.p7a8?.col}`);
  ok('y38p7 的 line ＝ 頁首；y38 的 line ＝ 書首（兩者不同）',
    resolved.p7?.line === resolved.p7?.baseLine && resolved.book?.line === resolved.book?.baseLine
    && resolved.book?.id !== resolved.p7?.id,
    `${JSON.stringify(resolved.p7)}｜${JSON.stringify(resolved.book)}`);
  ok('fuyan 沒有分欄，f1p7a3 也解析得到（欄 a）',
    resolved.fuyan?.db === 'fuyan' && resolved.fuyan?.col === 'a'
    && resolved.fuyan?.line === resolved.fuyan?.baseLine + 2,
    JSON.stringify(resolved.fuyan));

  // ---- 3) 真的跳過去（色帶在那一行） ----
  const jumped = await cdp.eval<any>(`
    (async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const go = async (text) => {
        const q = document.getElementById('query');
        q.value = text;
        q.dispatchEvent(new Event('input'));
        q.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await sleep(1500);
        const band = window.__lastJumpBand ?? null;
        return {
          band,
          db: window.__accelon26.state().db,
          mode: window.__accelon26.queryMode ? window.__accelon26.queryMode(text) : '',
          visible: !!document.getElementById('L' + (band?.from ?? -1)),
          status: document.getElementById('statusText')?.textContent ?? '',
        };
      };
      const row = await go('y38p7a8');
      await go('y38p7');
      const pageTop = window.__lastJumpBand ?? null;
      await go('y38');
      const bookTop = window.__lastJumpBand ?? null;
      await go('f1p7a3');
      const fuyan = { band: window.__lastJumpBand ?? null, db: window.__accelon26.state().db };
      return { row, pageTop, bookTop, fuyan };
    })()
  `);
  ok('y38p7a8 跳過去：色帶落在第 8 行，而且那一行在畫面上',
    jumped.row?.band?.from === resolved.p7a8?.line && jumped.row?.band?.to === resolved.p7a8?.line
    && jumped.row?.visible === true && jumped.row?.db === 'ys',
    JSON.stringify({ band: jumped.row?.band, want: resolved.p7a8?.line, status: jumped.row?.status }));
  ok('搜尋框的模式標籤顯示「頁行」', jumped.row?.mode === '頁行', String(jumped.row?.mode));
  ok('y38p7 跳頁首（和 y38p7a8 不同行）',
    jumped.pageTop?.from === resolved.p7?.line && jumped.pageTop?.from !== jumped.row?.band?.from,
    `${JSON.stringify(jumped.pageTop)} vs ${JSON.stringify(jumped.row?.band)}`);
  ok('y38 跳書首（在頁首之前或同一行）',
    (jumped.bookTop?.from ?? -1) > 0 && (jumped.bookTop?.from ?? 0) <= (jumped.pageTop?.from ?? 0),
    JSON.stringify(jumped.bookTop));
  ok('f1p7a3 跳到 fuyan 第 7 頁第 3 行（沒有分欄也能跳）',
    jumped.fuyan?.db === 'fuyan' && jumped.fuyan?.band?.from === resolved.fuyan?.line,
    JSON.stringify(jumped.fuyan));

  // ---- 4) cheat card／快速鍵卡片 ----
  const cards = await cdp.eval<any>(`
    (async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      // 切回 ys，讓 cheat card 填 ys 的例子
      const chips = [...document.querySelectorAll('#dbTabs .dbChip')];
      chips.find((c) => /印順/.test(c.textContent))?.click();
      await sleep(900);
      const q = document.getElementById('query');
      q.blur();
      q.focus();
      await sleep(2000);
      const card = document.getElementById('jumpCheatCard');
      return {
        shown: card && !card.hidden,
        pageLine: document.getElementById('ccPageLine')?.textContent ?? '',
        hint: document.getElementById('ccPageLineHint')?.textContent ?? '',
        text: (card?.textContent ?? '').replace(/\\s+/g, ' ').slice(0, 400),
      };
    })()
  `);
  ok('跳至提示卡有「頁行」一列，例子依庫換成 y38p7a8',
    cards.pageLine === 'y38p7a8' && /沒有分欄/.test(cards.hint),
    `shown=${cards.shown}｜${cards.pageLine}｜${cards.hint.slice(0, 40)}`);
  ok('提示卡文字裡同時有頁 id、大正引用、頁行、行號',
    /頁行/.test(cards.text) && /頁 id/.test(cards.text) && /大正引用/.test(cards.text) && /行號/.test(cards.text),
    cards.text.slice(0, 120));

  const sc = await cdp.eval<any>(`
    (async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      window.__accelon26.openShortcuts?.();
      await sleep(400);
      const box = document.getElementById('shortcutBox');
      const text = (box?.textContent ?? '').replace(/\\s+/g, ' ');
      window.__accelon26.closeShortcuts?.();
      return { open: !!box && !box.hidden, hasRow: /y38p7a8/.test(text), text: text.slice(0, 200) };
    })()
  `);
  ok('快速鍵卡片（搜尋與跳至）有 y38p7a8 這一列', sc.hasRow === true, `open=${sc.open}`);
  // ---- 5) 庫名本身帶數字（作者回報：yl38p24 被誤判成「yl 的第 38 部書」） ----
  const yl = await cdp.eval<any>(`
    (async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const chips = [...document.querySelectorAll('#dbTabs .dbChip')];
      chips.find((c) => /yl38/.test(c.textContent))?.click();
      await sleep(1200);
      const parsed = window.__accelon26.pageCite('yl38p24');
      const resolved = await window.__accelon26.pageCiteResolve('yl38p24');
      await sleep(200);
      // 真的輸入：yl38p24 本身就是 yl38 的頁 id，應該直接跳那一頁（不是被頁行引用吃掉）
      const q = document.getElementById('query');
      q.value = 'yl38p24';
      q.dispatchEvent(new Event('input'));
      q.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await sleep(1500);
      const pageMarks = [...document.querySelectorAll('#docText .pageMark[data-page], #docText .pageBreak[data-page]')].map((m) => m.dataset.page);
      const docText = (document.getElementById('docText')?.textContent ?? '').replace(/\s+/g, ' ').slice(0, 160);
      const snippets = document.querySelectorAll('#searchList .snippet').length;
      const tiles = window.__accelon26.state().docTabs?.length ?? 0;
      return {
        parsed, resolved,
        db: window.__accelon26.state().db,
        pageMarks,
        hasPage: pageMarks.includes('yl38p24'),
        docText, snippets, tiles, dirState: document.querySelectorAll('#docText .docLine').length,
        html: (document.getElementById('docText')?.innerHTML ?? '').replace(/\s+/g, ' ').slice(-420),
        marks: document.querySelectorAll('#docText .pageMark[data-page], #docText .pageBreak[data-page]').length,
        status: document.getElementById('statusText')?.textContent ?? '',
      };
    })()
  `);
  ok('yl38p24 → 解析成「yl38 這個庫的第 24 頁」（不是 yl 的第 38 部書）',
    yl.parsed?.db === 'yl38' && yl.parsed?.book === null && yl.parsed?.page === 24,
    JSON.stringify(yl.parsed));
  ok('yl38 第 24 頁解析得到（頁 id yl38p23，照文件順序）',
    yl.resolved?.db === 'yl38' && /p23$/.test(yl.resolved?.id ?? ''),
    JSON.stringify(yl.resolved));
  ok('輸入 yl38p24：跳到頁 id yl38p24（頁 id 優先，不被頁行引用搶走）',
    yl.db === 'yl38' && yl.hasPage === true,
    `db=${yl.db}｜畫面上的頁碼 ${JSON.stringify(yl.pageMarks)}｜狀態「${yl.status}」`);

  if (cdp.logs.length) console.error(cdp.logs.slice(-8).join('\n'));
} finally {
  proc.kill();
  server.stop(true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
