/**
 * 「切換 adb／本文頁籤時，麵包屑與本文不一致」的重現與回歸（作者 2026-11-01）。
 *
 *   bun run tools/trail-consistency-test.ts [--adb <path>] [--adb2 <path>] [--html build/accelon26.html]
 *
 * 做法：反覆「很快地」在目錄節點／本文分頁／adb 之間切換（故意在 0–40 ms 之内再點下一個），
 * 每一次都問 `__accelon26.trailInfo()`：
 *   * `rowsInsideRange`：畫面上的行號是不是都在這一頁的 realm 範圍内（不是＝畫到別的分頁）
 *   * `anchorNode` vs `textNode`：麵包屑用的節點 vs 畫面上那一行所屬的節點（應該一樣）
 *   * `trailLabels` 的同層「目前節點」文字是否等於 anchorNode 的標籤
 * 有幾次不一致就印幾次（含當時的分頁、realm、行號），最後給總數。
 *
 * 這個檔案同時是「舊版會錯、新版不會錯」的證據：`state().staleRenders` 是
 * `renderDoc` 被叫去畫「已經不是畫面上那一個」分頁的次數。
 */
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const ROOT = resolve(import.meta.dir, '../..');
const HTML = resolve(opt('html', resolve(ROOT, 'build/accelon26.html')));
const ADB_A = resolve(opt('adb', resolve(ROOT, '13j.adb')));
const ADB_B = resolve(opt('adb2', resolve(ROOT, 'yinshun.adb')));
const PORT = Number(opt('port', String(8500 + Math.floor(Math.random() * 90))));
const ROUNDS = Number(opt('rounds', '60'));

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const browser = BROWSERS.find((p) => existsSync(p));
if (!browser) { console.error('no Chromium browser found'); process.exit(2); }
if (!existsSync(HTML)) { console.error('missing ' + HTML); process.exit(2); }
for (const f of [ADB_A, ADB_B]) if (!existsSync(f)) { console.error('missing ' + f); process.exit(2); }

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
    if (url.pathname === '/a.adb') return new Response(Bun.file(ADB_A), { headers: { 'Content-Type': 'application/octet-stream' } });
    if (url.pathname === '/b.adb') return new Response(Bun.file(ADB_B), { headers: { 'Content-Type': 'application/octet-stream' } });
    return new Response('not found', { status: 404 });
  },
});

const profile = resolve(ROOT, `build/.chrome-profile-trail-${process.pid}-${Date.now() % 100000}`);
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
      setTimeout(() => { if (this.pending.delete(id)) rej(new Error('timeout ' + method)); }, 240000);
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

  // 準備：開 A、開 B（共享分頁 → 兩個庫的分頁可以並存、快速互切）
  const setup = await cdp.eval<any>(`
    (async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const waitTree = async () => {
        for (let i = 0; i < 400; i++) {
          const p = window.__accelon26.state().treePhases ?? {};
          if (p.instances !== undefined || p.skipped !== undefined) return true;
          await sleep(120);
        }
        return false;
      };
      const open = async (path, name) => {
        const res = await fetch(path);
        const blob = await res.blob();
        await window.__accelon26.openFile(new File([blob], name, { type: 'application/octet-stream' }));
        await waitTree();
        await sleep(400);
      };
      window.__accelon26.setSharedDocTabs(true);
      await open('/a.adb', 'a.adb');
      await open('/b.adb', 'b.adb');
      // 兩邊各點幾個目錄節點 → 幾個本文分頁
      const clickRows = async (n) => {
        const rows = [...document.querySelectorAll('#dirTree .tRow')];
        for (let i = 0; i < Math.min(rows.length, n); i++) {
          const r = rows[i];
          (r.querySelector('.tName') ?? r).click();
          for (let k = 0; k < 100; k++) {
            if (document.querySelectorAll('#docText .docLine').length) break;
            await sleep(80);
          }
          await sleep(120);
        }
        return document.querySelectorAll('#docTabStrip .docTab').length;
      };
      const chips = [...document.querySelectorAll('#dbTabs .dbChip')];
      // 先在 B（目前 active）點幾個節點，再切回 A 點幾個節點
      const bTabs = await clickRows(3);
      const chipA = chips.find((c) => !c.classList.contains('active'));
      chipA?.click();
      await sleep(800);
      await waitTree();
      const aTabs = await clickRows(3);
      return { tabs: document.querySelectorAll('#docTabStrip .docTab').length, aTabs, bTabs, db: window.__accelon26.state().db };
    })()
  `);
  ok('準備：兩個庫、多個本文分頁（共享分頁開）', (setup.tabs ?? 0) >= 2, JSON.stringify(setup));

  // 隨機亂切：頁籤 ↔ adb chip，中間只等 0–40ms（故意製造非同步競態）
  const run = await cdp.eval<any>(`
    (async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const st = () => window.__accelon26.state();
      const info = () => window.__accelon26.trailInfo();
      const issues = [];
      let checked = 0;
      const ROUNDS = ${ROUNDS};
      const rand = (n) => Math.floor(Math.random() * n);
      // 先把目錄展開一些，才有多一點節點可以點（點節點＝新 realm＝cache miss＝會 await）
      const expand = [...document.querySelectorAll('#dirTree .tTwisty')].slice(0, 6);
      for (const tw of expand) { tw.click(); await sleep(120); }
      const rowsOf = () => [...document.querySelectorAll('#dirTree .tRow')];
      for (let i = 0; i < ROUNDS; i++) {
        // 關鍵：點一個「沒載入過的節點」（ensurePage 會 await fetchPage），
        // 然後在它回來之前就切走（切頁籤／切 adb），重現非同步競態。
        const rows = rowsOf();
        if (rows.length) {
          const r = rows[rand(rows.length)];
          (r.querySelector('.tName') ?? r).click();
        }
        await sleep(rand(30));
        if (Math.random() < 0.5) {
          const tabs = [...document.querySelectorAll('#docTabStrip .docTab')];
          if (tabs.length > 1) tabs[rand(tabs.length)].click();
        } else {
          const chips = [...document.querySelectorAll('#dbTabs .dbChip')];
          if (chips.length > 1) chips[rand(chips.length)].click();
        }
        await sleep(rand(30));
        if (Math.random() < 0.4) {
          const rows2 = rowsOf();
          if (rows2.length) {
            const r2 = rows2[rand(rows2.length)];
            (r2.querySelector('.tName') ?? r2).click();
          }
        }
        // 等畫面穩定（paintHit 是 async 的）
        await sleep(900);
        const t = info();
        checked++;
        const bad = [];
        if (t.rows && t.range && !t.rowsInsideRange) bad.push('rows-outside-realm');
        if (t.anchorNode && t.textNode && t.anchorNode.va !== t.textNode.va) bad.push('anchor!=' + t.textNode.va);
        if (t.trailCurrent && t.anchorNode && t.trailCurrent !== t.anchorNode.label.slice(0, t.trailCurrent.length)) bad.push('trail-label');
        if (bad.length) {
          issues.push({
            why: bad, db: t.db, tab: t.tabName, realm: t.realm, range: t.range, rows: t.rows,
            anchor: t.anchorNode, text: t.textNode, trail: t.trailLabels, trailCurrent: t.trailCurrent,
            pinned: t.pinned, stale: t.staleRenders,
          });
        }
      }
      return { checked, issues, staleTotal: st().staleRenders ?? 0 };
    })()
  `);

  ok(`隨機切換 ${run.checked} 次後，麵包屑與本文每次都一致`,
    (run.issues ?? []).length === 0,
    (run.issues ?? []).length ? `${run.issues.length} 次不一致，例如 ${JSON.stringify(run.issues[0])}` : '0 次不一致');
  ok('沒有「畫到已經不是畫面上那一個分頁」的渲染',
    (run.staleTotal ?? 0) === 0,
    `staleRenders=${run.staleTotal}（>0 表示有非同步競態，新版會把它丟掉）`);

  // 決定性的案例（作者 2026-11-01 回報的那種不一致）：
  // 13j 沒有 <檔>，所以摘要／全文的連結把 realm 設成「整個庫」，pinned 釘在命中那一行。
  // 翻幾頁之後畫面上已經是別的章，但麵包屑仍然跟著 pinned（原本那一章）→ 不一致。
  const paged = await cdp.eval<any>(`
    (async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const st = () => window.__accelon26.state();
      const info = () => window.__accelon26.trailInfo();
      // 回到 13j 並用全文搜尋開一頁（realm＝整個庫，pinned＝命中的那一行）
      const chips = [...document.querySelectorAll('#dbTabs .dbChip')];
      const chip13 = chips.find((c) => /十三經/.test(c.textContent));
      chip13?.click();
      await sleep(900);
      const q = document.querySelector('#query');
      q.value = '象曰';
      q.dispatchEvent(new Event('input'));
      for (let i = 0; i < 120; i++) {
        if (document.querySelector('#searchList .snippet[data-va]')) break;
        await sleep(150);
      }
      document.querySelector('#searchList .snippet[data-va]')?.click();
      await sleep(1400);
      const before = info();
      // 往後翻三頁（pinned 那一行留在原地，畫面上已經換成後面的章節）
      for (let i = 0; i < 3; i++) {
        document.getElementById('pageNext')?.click();
        await sleep(900);
      }
      const after = info();
      // 再切到別的分頁、切回來（作者說「切換 adb 或頁籤時」看到）
      const tabs = [...document.querySelectorAll('#docTabStrip .docTab')];
      if (tabs.length > 1) {
        tabs[0].click(); await sleep(800);
        tabs[tabs.length - 1].click(); await sleep(900);
      }
      const back = info();
      return { before, after, back, pages: st().docPages, page: st().docPage };
    })()
  `);
  const mismatch = (t: any): boolean => !!(t?.anchorNode && t?.textNode && t.anchorNode.va !== t.textNode.va);
  ok('翻頁前：麵包屑與本文一致（釘選那一行在這一頁）',
    !!paged.before && paged.before.pinned?.onPage === true && !mismatch(paged.before),
    `pinned=${JSON.stringify(paged.before?.pinned)} anchor=${JSON.stringify(paged.before?.anchorNode)} text=${JSON.stringify(paged.before?.textNode)}`);
  ok('翻頁後：麵包屑仍然跟著本文（不是還停在原本那一章）',
    !mismatch(paged.after),
    `第 ${paged.page}/${paged.pages} 頁｜anchor=${JSON.stringify(paged.after?.anchorNode)} text=${JSON.stringify(paged.after?.textNode)}｜trail=${JSON.stringify(paged.after?.trailLabels)}`);
  ok('切走再切回：麵包屑與本文仍然一致',
    !mismatch(paged.back),
    `anchor=${JSON.stringify(paged.back?.anchorNode)} text=${JSON.stringify(paged.back?.textNode)}｜trailCurrent=${JSON.stringify(paged.back?.trailCurrent)}`);

  if (cdp.logs.length) console.error(cdp.logs.slice(-8).join('\n'));
} finally {
  proc.kill();
  server.stop(true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
