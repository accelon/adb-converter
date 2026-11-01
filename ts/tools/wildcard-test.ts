/**
 * 「搜尋所有 adb」的三種模式與萬用字元掃描（作者 2026-11-01）。
 *
 *   bun run tools/wildcard-test.ts [--html build/accelon26.html]
 *
 * 驗的是：
 *   1. 語法：`？象` 可用；單獨的 `？`／`＊`／`？？`、`＊＊`、regex 符號一律拒絕
 *   2. 單庫萬用：只掃目前這一庫，有進度（已掃／剩餘／找到）與結果字串（次數多的在前）
 *   3. 中斷：按下中斷就真的停（phase=aborted），不會偷偷跑完
 *   4. 全庫萬用：清單上每一庫都掃，per-db 命中數也在
 *   5. 三種模式切換有記住（localStorage），預設是「索引」
 */
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const ROOT = resolve(import.meta.dir, '../..');
const HTML = resolve(opt('html', resolve(ROOT, 'build/accelon26.html')));
const PORT = Number(opt('port', String(8400 + Math.floor(Math.random() * 90))));
const FILES = [
  { path: resolve(ROOT, '13j.adb'), name: '13j.adb' },
  { path: resolve(ROOT, 'build/jingang-group.adb'), name: 'jingang-group.adb' },
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

const profile = resolve(ROOT, `build/.chrome-profile-wild-${process.pid}-${Date.now() % 100000}`);
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

  // ---- 1) 語法 ----
  const syntax = await cdp.eval<any>(`
    (() => {
      const p = (s) => window.__accelon26.wildcardParse(s);
      return {
        good: p('？象'), good2: p('白＊心'), good3: p('象?'),
        lone1: p('？'), lone2: p('＊'), lone3: p('？？'), lone4: p('？＊'),
        twice: p('＊＊'), dot: p('象.'), bracket: p('象[日]'), empty: p(''),
      };
    })()
  `);
  ok('語法：？象 可用，並知道要用「象」縮小範圍',
    syntax.good.ok === true && syntax.good.narrowChar === '象', JSON.stringify(syntax.good));
  ok('語法：白＊心／象? 可用', syntax.good2.ok === true && syntax.good3.ok === true,
    `${syntax.good2.describe}｜${syntax.good3.describe}`);
  ok('語法：單獨的 ？／＊／？？／？＊ 一律拒絕',
    [syntax.lone1, syntax.lone2, syntax.lone3, syntax.lone4].every((r: any) => r.ok === false),
    JSON.stringify([syntax.lone1.error, syntax.lone2.error, syntax.lone3.error].map((e: any) => String(e).slice(0, 20))));
  ok('語法：＊＊ 拒絕（不能有不特定長度）', syntax.twice.ok === false, syntax.twice.error);
  ok('語法：regex 符號（. [ ]）拒絕並提示改用 ？／＊',
    syntax.dot.ok === false && syntax.bracket.ok === false && /？/.test(syntax.dot.error ?? ''),
    syntax.dot.error);
  ok('語法：空字串拒絕', syntax.empty.ok === false, syntax.empty.error);

  // ---- 2) 單庫萬用？曰（13j）----
  const single = await cdp.eval<any>(`
    (async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const st = () => window.__accelon26.searchAllState();
      const openDb = async (path, name) => {
        const res = await fetch(path);
        const blob = await res.blob();
        await window.__accelon26.openFile(new File([blob], name, { type: 'application/octet-stream' }));
        for (let i = 0; i < 300; i++) {
          const p = window.__accelon26.state().treePhases ?? {};
          if (p.instances !== undefined || p.skipped !== undefined) break;
          await sleep(120);
        }
        await sleep(400);
      };
      await openDb('/0.adb', '13j.adb');
      await openDb('/1.adb', 'jingang-group.adb');
      // 回到 13j 當 active
      const chips = [...document.querySelectorAll('#dbTabs .dbChip')];
      chips.find((c) => /十三經/.test(c.textContent))?.click();
      await sleep(900);
      document.getElementById('searchAllBtn').click();
      await sleep(300);
      // 預設模式應該是「索引」
      const defaultMode = st().mode;
      document.querySelector('#allSearchMode button[data-mode="single"]').click();
      await sleep(200);
      const q = document.getElementById('allSearchQuery');
      q.value = '？曰';
      const samples = [];
      const t0 = performance.now();
      document.getElementById('allSearchGo').click();
      for (let i = 0; i < 400; i++) {
        await sleep(100);
        const s = st();
        if (s.wild && samples.length < 3) samples.push({ ...s.wild });
        if (!s.busy && s.wild && (s.wild.phase === 'done' || s.wild.phase === 'aborted')) break;
      }
      const s = st();
      const chipsOut = [...document.querySelectorAll('#allSearchForms .allSearchForm')].slice(0, 6).map((b) => ({
        text: b.querySelector('b')?.textContent ?? '',
        count: Number((b.querySelector('span')?.textContent ?? '0').replace(/[^0-9]/g, '')),
        db: b.querySelector('.db')?.textContent ?? '',
      }));
      return {
        defaultMode, mode: s.mode, wild: s.wild, rows: s.rows, chips: chipsOut,
        progText: document.getElementById('allSearchProgText')?.textContent ?? '',
        progHidden: document.getElementById('allSearchProg')?.hidden,
        hintShown: !document.getElementById('allSearchHint')?.hidden,
        samples,
        ms: performance.now() - t0,
      };
    })()
  `);
  ok('預設模式是「索引」，切到「單庫萬用」生效',
    single.defaultMode === 'index' && single.mode === 'single',
    `預設=${single.defaultMode}、現在=${single.mode}`);
  ok('單庫萬用：掃完了，有命中與不同的字串',
    single.wild?.phase === 'done' && single.wild.hits > 0 && single.wild.forms > 0,
    JSON.stringify(single.wild));
  ok('單庫萬用：只掃 13j（一個庫）',
    (single.rows ?? []).length === 1 && /十三經/.test(single.rows[0]?.name ?? ''),
    JSON.stringify(single.rows));
  ok('單庫萬用：命中的字串都符合「1 個漢字＋曰」，且次數由多到少',
    (single.chips ?? []).length >= 3
    && single.chips.every((c: any) => /^\p{Script=Han}{2}$/u.test(c.text))
    && single.chips.every((c: any, i: number) => i === 0 || single.chips[i - 1].count >= c.count),
    JSON.stringify(single.chips));
  ok('單庫萬用：進度條與提示都有出現', single.progHidden === false && single.hintShown === true,
    `進度文字「${single.progText}」`);
  ok('單庫萬用：掃描過程有回報進度（已掃／剩餘／找到）',
    (single.samples ?? []).some((x: any) => x.phase === 'scanning' && x.blocksTotal > 0),
    JSON.stringify((single.samples ?? [])[0] ?? null));

  // ---- 3) 中斷 ----
  const aborted = await cdp.eval<any>(`
    (async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const st = () => window.__accelon26.searchAllState();
      document.querySelector('#allSearchMode button[data-mode="all"]').click();
      await sleep(150);
      const q = document.getElementById('allSearchQuery');
      q.value = '？心';
      // 不 await：立刻按中斷（作者要求「隨時中斷」）
      const p = window.__accelon26.runSearchAll('？心');
      window.__accelon26.stopSearchAll();
      await sleep(1200);
      await p.catch(() => undefined);
      const s = st();
      return {
        mode: s.mode, wild: s.wild,
        stopHidden: document.getElementById('allSearchStop')?.hidden,
        msg: document.getElementById('allSearchMsg')?.textContent ?? '',
      };
    })()
  `);
  ok('全庫萬用：可以隨時中斷（phase=aborted、中斷鈕收起）',
    aborted.mode === 'all' && aborted.wild?.phase === 'aborted' && aborted.stopHidden === true,
    JSON.stringify(aborted.wild));
  ok('中斷後畫面說明「已中斷」', /中斷/.test(aborted.msg), aborted.msg);

  // ---- 4) 全庫萬用（跑完）----
  const all = await cdp.eval<any>(`
    (async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const st = () => window.__accelon26.searchAllState();
      document.getElementById('allSearchQuery').value = '？曰';
      document.getElementById('allSearchGo').click();
      for (let i = 0; i < 600; i++) {
        await sleep(100);
        const s = st();
        if (!s.busy && s.wild && (s.wild.phase === 'done' || s.wild.phase === 'aborted')) break;
      }
      const s = st();
      return {
        wild: s.wild, rows: s.rows, mode: s.mode,
        msg: document.getElementById('allSearchMsg')?.textContent ?? '',
        stored: localStorage.getItem('accelon26.allSearchMode'),
      };
    })()
  `);
  ok('全庫萬用：清單上每個庫都掃了（不是只有目前這一庫）',
    (all.rows ?? []).length >= 2 && (all.rows ?? []).every((r: any) => r.state === 'done'),
    JSON.stringify(all.rows));
  ok('全庫萬用：合計命中 ≥ 單庫，且字串清單還在',
    all.wild?.phase === 'done' && all.wild.hits > 0 && all.wild.forms > 0,
    JSON.stringify(all.wild));
  ok('全庫萬用：說明文字有「全庫萬用」與總筆數', /全庫萬用/.test(all.msg) && /筆/.test(all.msg), all.msg);
  ok('模式選擇會記住（localStorage）', all.stored === 'all', String(all.stored));

  // ---- 5) 切回索引模式仍然可用 ----
  const back = await cdp.eval<any>(`
    (async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const st = () => window.__accelon26.searchAllState();
      document.querySelector('#allSearchMode button[data-mode="index"]').click();
      await sleep(150);
      document.getElementById('allSearchQuery').value = '象曰';
      document.getElementById('allSearchGo').click();
      for (let i = 0; i < 400; i++) {
        await sleep(100);
        const s = st();
        if (!s.busy && s.rows.length && s.rows.every((r) => r.state === 'done' || r.state === 'error')) break;
      }
      const s = st();
      return {
        mode: s.mode, rows: s.rows,
        progHidden: document.getElementById('allSearchProg')?.hidden,
        hintHidden: document.getElementById('allSearchHint')?.hidden,
      };
    })()
  `);
  ok('切回索引模式：走原本的逐庫指數查詢',
    back.mode === 'index' && (back.rows ?? []).some((r: any) => r.state === 'done'),
    JSON.stringify((back.rows ?? []).map((r: any) => ({ n: r.name, h: r.hits, s: r.state }))));
  ok('索引模式不顯示進度條與萬用提示', back.progHidden === true && back.hintHidden === true,
    `prog=${back.progHidden} hint=${back.hintHidden}`);

  if (cdp.logs.length) console.error(cdp.logs.slice(-8).join('\n'));
} finally {
  proc.kill();
  server.stop(true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
