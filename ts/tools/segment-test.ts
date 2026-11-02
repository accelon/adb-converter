/**
 * 平行段對讀（作者 2026-11-02）：`<段 n>` 晶片 → 下拉 → 打開同一段。
 *
 *   bun run tools/segment-test.ts [--html build/accelon26.html] [--dir D:\2026\sz\accelon26]
 *
 * 驗的是：
 *   1. 有 `段.n` 的庫會長出 `.segChip`（`¶12`），沒有的庫不會
 *   2. 點晶片 → 下拉列出 10 個同結構的庫（cs／cllk 標「還沒做」且不可點）
 *   3. 選一個庫 → 打開它，而且落在**同一個段**（`state().db` 換了，畫面上有 `data-seg` 相同的晶片）
 *   4. 段號不存在時有明確訊息，不會亂跳
 */
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const ROOT = resolve(import.meta.dir, '../..');
const HTML = resolve(opt('html', resolve(ROOT, 'build/accelon26.html')));
const DIR = resolve(opt('dir', 'D:/2026/sz/accelon26'));
const PORT = Number(opt('port', String(8000 + Math.floor(Math.random() * 90))));
const DBS = ['ccc', 'sc'];

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const browser = BROWSERS.find((p) => existsSync(p));
if (!browser) { console.error('no Chromium browser found'); process.exit(2); }
if (!existsSync(HTML)) { console.error('missing ' + HTML); process.exit(2); }
for (const d of ['ccc', 'sc']) if (!existsSync(resolve(DIR, d + '.adb'))) { console.error('missing ' + d + '.adb in ' + DIR); process.exit(2); }
const PLAIN = resolve(ROOT, '13j.adb');   // 沒有 <段> 的庫

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + name + (detail ? '  ' + detail : '')); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
};

const server = Bun.serve({
  port: PORT, hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/accelon26.html') return new Response(Bun.file(HTML), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    const name = url.pathname.replace(/^\//, '').replace(/\.adb$/i, '');
    if (name === '13j') return new Response(Bun.file(PLAIN), { headers: { 'Content-Type': 'application/octet-stream' } });
    if (DBS.includes(name)) return new Response(Bun.file(resolve(DIR, name + '.adb')), { headers: { 'Content-Type': 'application/octet-stream' } });
    return new Response('nf', { status: 404 });
  },
});
const profile = resolve(ROOT, `build/.chrome-profile-seg-${process.pid}-${Date.now() % 100000}`);
const proc = Bun.spawn([browser, '--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0',
  '--remote-allow-origins=*', `--user-data-dir=${profile}`, '--no-default-browser-check', 'about:blank'],
  { stdout: 'pipe', stderr: 'pipe' });

async function devtoolsUrl(): Promise<string> {
  const until = Date.now() + 20000;
  while (Date.now() < until) {
    const text = await Bun.file(resolve(profile, 'DevToolsActivePort')).text().catch(() => '');
    const [p, path] = text.split('\n').map((s) => s.trim());
    if (Number(p) > 0 && path) return `ws://127.0.0.1:${p}${path}`;
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
  // 等頁面真的載入（CDP 建立 target 之後可能還沒導航完成）
  for (let k = 0; k < 80; k++) {
    const ready = await cdp.eval<boolean>("location.protocol === 'http:' && !!(window.__accelon26 && window.__accelon26.state)").catch(() => false);
    if (ready) break;
    await Bun.sleep(250);
  }
  await Bun.sleep(500);

  const open = await cdp.eval<any>(`
    (async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const openDb = async (name) => {
        const res = await fetch('/' + name + '.adb');
        await window.__accelon26.openFile(new File([await res.blob()], name + '.adb', { type: 'application/octet-stream' }));
        for (let i = 0; i < 400; i++) {
          const p = window.__accelon26.state().treePhases ?? {};
          if (p.instances !== undefined || p.skipped !== undefined) break;
          await sleep(150);
        }
        await sleep(600);
      };
      await openDb('ccc');
      await openDb('sc');
      // 回到 ccc 當 active
      [...document.querySelectorAll('#dbTabs .dbChip')].find((c) => /ccc|莊春江/.test(c.textContent))?.click();
      await sleep(1200);
      return { db: window.__accelon26.state().db, dbs: window.__accelon26.parallelDbs() };
    })()
  `);
  ok('ccc 開得起來、平行清單有 10 個庫（8 個 ready＋cs／cllk）',
    open.db === 'ccc' && (open.dbs ?? []).length === 10 && open.dbs.filter((d: any) => d.ready).length === 8,
    JSON.stringify({ db: open.db, n: (open.dbs ?? []).length }));

  // 跳到某一段，看晶片
  const chips = await cdp.eval<any>(`
    (async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const va = await window.__accelon26.segmentVa('120');
      const q = document.getElementById('query');
      q.value = '#L0';
      // 直接用 openSegment 跳到 ccc 第 120 段
      await window.__accelon26.openSegment('ccc', '120');
      await sleep(1200);
      const all = [...document.querySelectorAll('#docText .segChip')].map((c) => c.dataset.seg);
      const near = all.filter((s) => Math.abs(Number(s) - 120) <= 6);
      const bands = window.__lastJumpBand ?? null;
      return { va, all: all.slice(0, 6), n: all.length, near, bands, db: window.__accelon26.state().db };
    })()
  `);
  ok('跳到第 120 段：畫面上出現 ¶ 晶片（而且 120 就在附近）', chips.db === 'ccc' && chips.n > 0 && (chips.near ?? []).includes('120'),
    JSON.stringify({ n: chips.n, first: chips.all, near: chips.near }));

  // 點晶片 → 下拉
  const menu = await cdp.eval<any>(`
    (async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const chip = [...document.querySelectorAll('#docText .segChip')].find((c) => c.dataset.seg === '120');
      if (!chip) return { missing: true };
      chip.click();
      await sleep(300);
      const m = document.getElementById('segMenu');
      const rows = [...(m?.querySelectorAll('.segRow') ?? [])].map((r) => ({
        file: r.dataset.file, ready: r.dataset.ready, text: (r.textContent ?? '').replace(/\\s+/g, ' ').trim(),
        disabled: r.getAttribute('aria-disabled') === 'true', cur: r.classList.contains('cur'),
      }));
      return { rows, visible: !!m && !m.hidden };
    })()
  `);
  ok('下拉列出 10 列、cs／cllk 標「還沒做」且不可點、目前庫標「目前」',
    (menu.rows ?? []).length === 10
    && menu.rows.filter((r: any) => r.ready === '0').every((r: any) => r.disabled && /還沒做/.test(r.text))
    && menu.rows.some((r: any) => r.cur && /目前/.test(r.text)),
    JSON.stringify((menu.rows ?? []).map((r: any) => r.file + (r.ready === '0' ? '(todo)' : '')).slice(0, 12)));

  // 選 sc → 打開同一段
  const jump = await cdp.eval<any>(`
    (async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const row = [...document.querySelectorAll('#segMenu .segRow')].find((r) => r.dataset.file === 'sc');
      row?.click();
      for (let i = 0; i < 200; i++) {
        await sleep(150);
        if (window.__accelon26.state().db === 'sc' && document.querySelector('#docText .segChip')) break;
      }
      await sleep(800);
      const chip = [...document.querySelectorAll('#docText .segChip')].find((c) => c.dataset.seg === '120');
      return {
        db: window.__accelon26.state().db,
        hasChip: !!chip,
        segs: [...document.querySelectorAll('#docText .segChip')].map((c) => c.dataset.seg).slice(0, 6),
        status: document.getElementById('status')?.textContent ?? '',
        menuGone: !document.getElementById('segMenu'),
        band: window.__lastJumpBand ?? null,
        page: window.__accelon26.state().docPage,
        pages: window.__accelon26.state().docPages,
        lines: document.querySelectorAll('#docText .docLine').length,
        want120: await window.__accelon26.segmentVa('120'),
        docTabDb: window.__accelon26.state().docTabDb,
        realm: window.__accelon26.state().docRealm,
        range: window.__accelon26.state().docRange,
        chips: [...document.querySelectorAll('#docText .segChip')].map((c) => c.dataset.seg),
      };
    })()
  `);
  ok('選 sc：打開 sc 並落在第 120 段（同一段）',
    jump.db === 'sc' && jump.docTabDb === 'sc' && jump.hasChip === true && (jump.chips ?? []).includes('120'),
    JSON.stringify(jump));

  // 不存在的段號：明確訊息、不亂跳
  const missing = await cdp.eval<any>(`
    (async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const ok = await window.__accelon26.openSegment('sc', '999999');
      await sleep(500);
      return { ok, status: document.getElementById('status')?.textContent ?? '', hidden: document.getElementById('status')?.hidden };
    })()
  `);
  ok('段號不存在時回 false 並顯示訊息', missing.ok === false && /段/.test(missing.status), JSON.stringify(missing));

  // 沒有 <段> 的庫不會長晶片（13j）
  const noSeg = await cdp.eval<any>(`
    (async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const res = await fetch('/13j.adb');
      await window.__accelon26.openFile(new File([await res.blob()], '13j.adb', { type: 'application/octet-stream' }));
      for (let i = 0; i < 300; i++) {
        const p = window.__accelon26.state().treePhases ?? {};
        if (p.instances !== undefined || p.skipped !== undefined) break;
        await sleep(150);
      }
      await sleep(900);
      const va = await window.__accelon26.segmentVa('1');
      return { db: window.__accelon26.state().db, va, chips: document.querySelectorAll('#docText .segChip').length };
    })()
  `);

  ok('沒有 <段> 的庫（13j）：segmentVa 回 null（不長晶片）',
    noSeg.db === '13j' && noSeg.va === null, JSON.stringify(noSeg));

  if (cdp.logs.length) console.error(cdp.logs.slice(-6).join('\n'));
} finally {
  proc.kill();
  server.stop(true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
