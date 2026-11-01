/**
 * adb 選單（📁）的排序（作者 2026-11-01）。
 *
 *   bun run tools/dbpick-sort-test.ts [--html build/accelon26.html]
 *
 * 驗的是：
 *   1. 表頭有 ID／檔名／字數／大小／建置日期，而且**預設按 adb id 字母序**
 *   2. 點表頭按那一欄排序，再點一次反向（升▲／降▼）
 *   3. 日期／大小換過去時先給降冪（新／大的在前）
 *   4. 選擇會存下來（`accelon26.dbPickSort`）
 *   5. 點表頭不會把選單收起來；庫名那一欄不可排
 *
 * 用三個「大小、日期、id 都不同」的 adb 餵進去（File 的 lastModified 直接指定，
 * 不然三個檔的檔案時間都一樣，日期排序驗不出來）。
 */
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const ROOT = resolve(import.meta.dir, '../..');
const HTML = resolve(opt('html', resolve(ROOT, 'build/accelon26.html')));
const PORT = Number(opt('port', String(8600 + Math.floor(Math.random() * 90))));

const FILES = [
  { path: resolve(ROOT, '13j.adb'), name: '13j.adb', modified: Date.UTC(2026, 8, 10) },
  { path: resolve(ROOT, 'build/jingang-group.adb'), name: 'jingang-group.adb', modified: Date.UTC(2026, 9, 20) },
  { path: resolve(ROOT, 'sourcecode/shouwen.adb'), name: 'shouwen.adb', modified: Date.UTC(2026, 8, 28) },
];

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const browser = BROWSERS.find((p) => existsSync(p));
if (!browser) { console.error('no Chromium browser found'); process.exit(2); }
if (!existsSync(HTML)) { console.error('missing ' + HTML); process.exit(2); }
for (const f of FILES) if (!existsSync(f.path)) { console.error('missing ' + f.path); process.exit(2); }

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
    const i = Number(url.pathname.replace(/^\//, '').replace(/\.adb$/, ''));
    const f = FILES[i];
    if (f) return new Response(Bun.file(f.path), { headers: { 'Content-Type': 'application/octet-stream' } });
    return new Response('not found', { status: 404 });
  },
});

const profile = resolve(ROOT, `build/.chrome-profile-dbpsort-${process.pid}-${Date.now() % 100000}`);
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
        if (m.method === 'Runtime.exceptionThrown') {
          c.logs.push('exception: ' + (m.params.exceptionDetails?.exception?.description ?? '?'));
        }
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

  // 把三個 adb 餵進去（大小與檔案時間都不同），然後打開選單
  const setup = await cdp.eval<any>(`
    (async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const files = ${JSON.stringify(FILES.map((f, i) => ({ i, name: f.name, modified: f.modified })))};
      for (const f of files) {
        const res = await fetch('/' + f.i + '.adb');
        const blob = await res.blob();
        const file = new File([blob], f.name, { type: 'application/octet-stream', lastModified: f.modified });
        await window.__accelon26.openFile(file);
        await sleep(300);
      }
      document.getElementById('dbPickBtn').click();
      await sleep(400);
      return { catalog: window.__accelon26.state().catalog, open: window.__accelon26.state().dbPickOpen };
    })()
  `);
  ok('三個 adb 都在清單裡（大小與日期都不同）',
    (setup.catalog ?? []).length === 3 && setup.open === true,
    JSON.stringify(setup.catalog));

  // 讀表格：表頭、欄數、每一列的 id／檔名／大小／日期
  const probe = `
    (() => {
      const menu = document.getElementById('dbPickMenu');
      const ths = [...menu.querySelectorAll('.dbPickTable thead th')].map((th) => ({
        sort: th.dataset.sort || '', text: th.textContent.trim(), on: th.classList.contains('on'),
      }));
      const rows = [...menu.querySelectorAll('.dbPickItem[data-key]')].map((tr) => ({
        id: tr.dataset.id,
        idText: tr.querySelector('.dbPickId')?.textContent ?? '',
        file: tr.querySelector('.dbPickFile')?.textContent ?? '',
        name: tr.querySelector('.dbPickName')?.textContent ?? '',
        chars: tr.querySelector('.dbPickChars')?.textContent ?? '',
        size: tr.querySelector('.dbPickSize')?.textContent ?? '',
        date: tr.querySelector('.dbPickDate')?.textContent ?? '',
        cells: tr.children.length,
        loaded: tr.classList.contains('loaded'),
        active: tr.classList.contains('active'),
      }));
      return { ths, rows, open: !menu.hidden };
    })()
  `;

  const t0 = await cdp.eval<any>(probe);
  ok('表頭有 ID／檔名／字數／大小／建置日期，庫名不可排',
    JSON.stringify(t0.ths.map((t: any) => t.sort)) === JSON.stringify(['id', 'file', '', 'chars', 'size', 'date']),
    JSON.stringify(t0.ths));
  ok('每一列 6 欄（ID、檔名、庫名、字數、大小、建置日期）',
    (t0.rows ?? []).every((r: any) => r.cells === 6)
    && (t0.rows?.[0]?.idText ?? '') !== '' && (t0.rows?.[0]?.size ?? '') !== ''
    && (t0.rows?.[0]?.date ?? '') !== '',
    JSON.stringify((t0.rows ?? [])[0]));
  const ids0 = (t0.rows ?? []).map((r: any) => r.id);
  const sortedIds = [...ids0].sort((a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0));
  ok('預設按 adb id 字母序（A→Z），表頭 ID 有 ▲',
    JSON.stringify(ids0) === JSON.stringify(sortedIds) && t0.ths.find((x: any) => x.sort === 'id')?.on === true
    && (t0.ths.find((x: any) => x.sort === 'id')?.text ?? '').includes('▲'),
    JSON.stringify(ids0));

  // 點「檔名」→ 升冪；再點一次 → 降冪
  const byFile = await cdp.eval<any>(`
    (async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const q = (s) => document.querySelector(s);
      q('#dbPickMenu .dbPickSortCell[data-sort="file"] .dbPickSortBtn').click();
      await sleep(200);
      const asc = [...document.querySelectorAll('#dbPickMenu .dbPickItem[data-key] .dbPickFile')].map((x) => x.textContent);
      const arrow = q('#dbPickMenu .dbPickSortCell[data-sort="file"] .dbPickArrow')?.textContent ?? '';
      q('#dbPickMenu .dbPickSortCell[data-sort="file"] .dbPickSortBtn').click();
      await sleep(200);
      const desc = [...document.querySelectorAll('#dbPickMenu .dbPickItem[data-key] .dbPickFile')].map((x) => x.textContent);
      const arrow2 = q('#dbPickMenu .dbPickSortCell[data-sort="file"] .dbPickArrow')?.textContent ?? '';
      return { asc, desc, arrow, arrow2, open: !q('#dbPickMenu').hidden, stored: localStorage.getItem('accelon26.dbPickSort') };
    })()
  `);
  ok('點「檔名」→ 升冪，再點 → 降冪（▲／▼）',
    JSON.stringify(byFile.asc) === JSON.stringify([...byFile.asc].sort())
    && JSON.stringify(byFile.desc) === JSON.stringify([...byFile.asc].sort().reverse())
    && byFile.arrow === '▲' && byFile.arrow2 === '▼',
    `升 ${JSON.stringify(byFile.asc)}｜降 ${JSON.stringify(byFile.desc)}`);
  ok('點表頭不會把選單收起來', byFile.open === true, `open=${byFile.open}`);
  ok('排序選擇存進 localStorage', /"k":"file"/.test(String(byFile.stored)), String(byFile.stored));

  // 日期／大小：換過去時先給降冪（新／大的在前），再點一次升冪
  const byDate = await cdp.eval<any>(`
    (async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const q = (s) => document.querySelector(s);
      const nums = (sel) => [...document.querySelectorAll('#dbPickMenu .dbPickItem[data-key]')].map((tr) => Number(tr.querySelector(sel)?.textContent?.match(/[-\\d]+/)?.[0] ?? 0));
      const attr = (a) => [...document.querySelectorAll('#dbPickMenu .dbPickItem[data-key]')].map((tr) => Number(tr.dataset[a]));
      q('#dbPickMenu .dbPickSortCell[data-sort="date"] .dbPickSortBtn').click();
      await sleep(200);
      const d1 = attr('date');
      const a1 = q('#dbPickMenu .dbPickSortCell[data-sort="date"] .dbPickArrow')?.textContent ?? '';
      q('#dbPickMenu .dbPickSortCell[data-sort="date"] .dbPickSortBtn').click();
      await sleep(200);
      const d2 = attr('date');
      q('#dbPickMenu .dbPickSortCell[data-sort="size"] .dbPickSortBtn').click();
      await sleep(200);
      const s1 = attr('size');
      const a3 = q('#dbPickMenu .dbPickSortCell[data-sort="size"] .dbPickArrow')?.textContent ?? '';
      q('#dbPickMenu .dbPickSortCell[data-sort="size"] .dbPickSortBtn').click();
      await sleep(200);
      const s2 = attr('size');
      return {
        d1, a1, d2, s1, a3, s2,
        d1Text: [...document.querySelectorAll('#dbPickMenu .dbPickItem[data-key] .dbPickDate')].map((x) => x.textContent),
        stored: localStorage.getItem('accelon26.dbPickSort'),
      };
    })()
  `);
  const desc = (xs: number[]): boolean => xs.every((v, i) => i === 0 || xs[i - 1] >= v);
  const asc = (xs: number[]): boolean => xs.every((v, i) => i === 0 || xs[i - 1] <= v);
  ok('點「建置日期」先給降冪（新的在前），再點 → 升冪',
    desc(byDate.d1) && asc(byDate.d2) && byDate.a1 === '▼'
    && new Set(byDate.d1).size === 3,
    `降 ${JSON.stringify(byDate.d1Text)}｜dates ${JSON.stringify(byDate.d1)}`);
  ok('點「大小」先給降冪（大的在前），再點 → 升冪',
    desc(byDate.s1) && asc(byDate.s2) && byDate.a3 === '▼' && new Set(byDate.s1).size === 3,
    `bytes 降 ${JSON.stringify(byDate.s1)}｜升 ${JSON.stringify(byDate.s2)}`);
  ok('換到別的欄位也會存下來（大小）', /"k":"size"/.test(String(byDate.stored)), String(byDate.stored));

  // 回到 adb id：升冪
  const backToId = await cdp.eval<any>(`
    (async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      document.querySelector('#dbPickMenu .dbPickSortCell[data-sort="id"] .dbPickSortBtn').click();
      await sleep(200);
      const ids = [...document.querySelectorAll('#dbPickMenu .dbPickItem[data-key]')].map((tr) => tr.dataset.id);
      const a = document.querySelector('#dbPickMenu .dbPickSortCell[data-sort="id"] .dbPickArrow')?.textContent ?? '';
      return { ids, a };
    })()
  `);
  ok('點回 ID：回到字母序（升冪）',
    JSON.stringify(backToId.ids) === JSON.stringify([...backToId.ids].sort()) && backToId.a === '▲',
    JSON.stringify(backToId.ids));

  if (cdp.logs.length) console.error(cdp.logs.slice(-8).join('\n'));
} finally {
  proc.kill();
  server.stop(true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
