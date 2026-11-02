/**
 * 腳注 hover 與點擊是否一致（作者 2026-11-01 回報的 bug：yl38p24 的 [45] hover 顯示
 * 第四章第六節的釋文，但點擊跳到正確的那一條）。
 *
 *   bun run tools/note-link-test.ts [--html build/accelon26.html] [--adb ..\..\accelon3\yl38.adb]
 *
 * 驗的是（yl38 每節重新編號，同一個 n 有 9 條釋）：
 *   1. yl38p24 的 [45]：hover 的文字＝點擊落點那一條的釋文
 *   2. 第四章第六節（yl38p288 附近）的 [45]：hover 與點擊都落在那一節的釋
 *   3. 抽 5 個重複的 n（45、46、13、14、23）在兩個不同頁各測一次，兩邊都一致
 *   4. 沒有重複 n 的庫（ys）行為不變
 */
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const ROOT = resolve(import.meta.dir, '../..');
const HTML = resolve(opt('html', resolve(ROOT, 'build/accelon26.html')));
const YL38 = resolve(opt('adb', resolve(ROOT, '../../accelon3/yl38.adb')));
const YS = resolve(opt('ys', resolve(ROOT, '../../accelon3/ys.adb')));
const PORT = Number(opt('port', String(8200 + Math.floor(Math.random() * 90))));
// yl38p24 的 [45] 其實落在 yl38p25（頁標記在段落之前）：兩頁都測
const PAGES = ['yl38p25', 'yl38p56', 'yl38p70', 'yl38p288'];
const NS = ['45', '46', '13', '14', '23'];

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const browser = BROWSERS.find((p) => existsSync(p));
if (!browser) { console.error('no Chromium browser found'); process.exit(2); }
for (const f of [HTML, YL38, YS]) if (!existsSync(f)) { console.error('missing ' + f); process.exit(2); }

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
    if (url.pathname === '/accelon26.html') return new Response(Bun.file(HTML), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    if (url.pathname === '/yl38.adb') return new Response(Bun.file(YL38), { headers: { 'Content-Type': 'application/octet-stream' } });
    if (url.pathname === '/ys.adb') return new Response(Bun.file(YS), { headers: { 'Content-Type': 'application/octet-stream' } });
    return new Response('not found', { status: 404 });
  },
});

const profile = resolve(ROOT, `build/.chrome-profile-note-${process.pid}-${Date.now() % 100000}`);
const proc = Bun.spawn([browser, '--headless=new', '--disable-gpu', '--no-first-run',
  '--remote-debugging-port=0', '--remote-allow-origins=*',
  `--user-data-dir=${profile}`, '--no-default-browser-check', 'about:blank'],
  { stdout: 'pipe', stderr: 'pipe' });

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
      const res = await fetch('/yl38.adb');
      const blob = await res.blob();
      await window.__accelon26.openFile(new File([blob], 'yl38.adb', { type: 'application/octet-stream' }));
      for (let i = 0; i < 400; i++) {
        const p = window.__accelon26.state().treePhases ?? {};
        if (p.instances !== undefined || p.skipped !== undefined) break;
        await sleep(150);
      }
      await sleep(600);
      return { db: window.__accelon26.state().db };
    })()
  `);
  ok('yl38 開得起來', setup.db === 'yl38', JSON.stringify(setup));

  // 量測：hover 的文字 vs 點擊落點那一條的文字（一次一個頁、分批做，避免單次 evaluate 太久）
  const fixtures = `
    (() => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const tip = () => document.getElementById('noteTip');
      window.__noteTest = {
        goPage: async (page) => {
          const q = document.getElementById('query');
          q.value = page;
          q.dispatchEvent(new Event('input'));
          q.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          await sleep(1400);
          return [...document.querySelectorAll('#docText .pageBreak[data-page], #docText .pageMark[data-page]')].map((m) => m.dataset.page);
        },
        refs: () => [...document.querySelectorAll('#docText a.noteRef')].map((a) => a.dataset.note ?? ''),
        measure: async (n) => {
          const ref = [...document.querySelectorAll('#docText a.noteRef')].find((a) => (a.dataset.note ?? '') === n);
          if (!ref) return { missing: true };
          window.__noteTest.hideTip = () => { const t = tip(); t.hidden = true; t.textContent = ''; };
          window.__noteTest.hideTip();
          ref.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }));
          for (let i = 0; i < 80; i++) {
            await sleep(60);
            const t = tip();
            if (!t.hidden && t.textContent && t.textContent !== '讀取中…') break;
          }
          const hover = (tip().textContent ?? '').replace(/\\s+/g, ' ').trim();
          window.__noteTest.hideTip();
          await sleep(250);   // 讓上一個 hover／render 收尾，免得點擊被吃掉
          ref.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          for (let i = 0; i < 140; i++) {
            await sleep(60);
            if (document.querySelector('.docLine.noteTarget')) break;
          }
          const row = document.querySelector('.docLine.noteTarget');
          const line = row ? Number(row.id.replace(/^L/, '')) : -1;
          const text = [row, row?.nextElementSibling, row?.nextElementSibling?.nextElementSibling]
            .map((el) => (el?.textContent ?? '')).join(' ').replace(/\\s+/g, ' ').trim();
          return { hover: hover.slice(0, 90), clickLine: line, clickText: text.slice(0, 90) };
        },
      };
      return 1;
    })()
  `;
  await cdp.eval(fixtures);

  const rows: any[] = [];
  const measureOn = async (page: string, n: string, marks: string[]) => {
    const goMarks = await cdp.eval<any>(`window.__noteTest.goPage(${JSON.stringify(page)})`).catch(() => []);
    const r = await cdp.eval<any>(`window.__noteTest.measure(${JSON.stringify(n)})`);
    const clickClean: string = String(r.clickText ?? '').replace(/^[\s[［]*[^\s\]］]*[\s\]］]*/, '');
    const same = !!r.hover && !!clickClean
      && (clickClean.startsWith(String(r.hover).slice(0, 20)) || String(r.hover).startsWith(clickClean.slice(0, 20)));
    rows.push({ page, n, marks: goMarks?.length ? goMarks : marks, hover: r.hover ?? '', clickLine: r.clickLine ?? -1, clickText: clickClean, same, missing: !!r.missing });
  };
  // 每頁上看得見的註記號（先灑一輪，留下 hover／點擊一致性的基本樣本）
  for (const page of PAGES) {
    const marks = await cdp.eval<any>(`window.__noteTest.goPage(${JSON.stringify(page)})`);
    const refs = await cdp.eval<string[]>(`window.__noteTest.refs()`);
    const pick = [...new Set([...refs.filter((n) => NS.includes(n)), ...refs])].slice(0, 3);
    for (const n of pick) await measureOn(page, n, marks);
  }
  // 作者要的驗收：45／46／13／14／23 各在**兩個不同節**各測一次
  // （用 notePagesOf 找出每個 n 的 pg，挑兩個不同的 pg 當「兩節」）
  const perN = await cdp.eval<any>(`
    (async () => {
      const out = {};
      for (const n of ${JSON.stringify(NS)}) {
        const p = await window.__accelon26.notePagesOf(n);
        const pgs = [...new Set((p?.refs ?? []).map((x) => x.pg).filter(Boolean))];
        out[n] = pgs.slice(0, 2);
      }
      return out;
    })()
  `);
  for (const n of NS) {
    const pgs: string[] = perN?.[n] ?? [];
    for (const pg of pgs) await measureOn(pg, n, [pg]);
  }
  const pairs = NS.map((n) => ({ n, sections: new Set(rows.filter((r: any) => r.n === n).map((r: any) => r.page)).size }));


  const got = rows.filter((r: any) => !r.missing);
  ok('畫面上找得到註記號（至少 4 個測試點）', got.length >= 4, `${got.length} / ${rows.length} 個測試點`);
  const bad = got.filter((r: any) => !r.same);
  ok('hover 與點擊落點一致（每個 n、兩個頁都要）', bad.length === 0,
    bad.length ? `${bad.length} 個不一致，例如 ${JSON.stringify(bad[0])}` : `${got.length} 個都一致`);
  const first = got.filter((r: any) => r.page === PAGES[0] && r.n === '45');
  ok(`${PAGES[0]} 的 [45]：hover 顯示第一章第二節那條（〈泛說解脫道〉，不是別節的「五、」）`,
    first.length > 0 && first.every((r: any) => /泛說解脫道|空之探究/.test(r.hover) && r.same === true),
    JSON.stringify(first[0] ?? null));
  const later = got.filter((r: any) => r.page === PAGES[1] && r.n === '45');
  ok(`${PAGES[1]} 那一節的 [45]：hover 與點擊都在該節`, later.length > 0 && later.every((r: any) => r.same === true),
    JSON.stringify(later[0] ?? null));
  ok('兩個頁的 [45] 是不同的兩條釋',
    first.length > 0 && later.length > 0 ? first[0].hover !== later[0].hover : true,
    `${(first[0]?.hover ?? '').slice(0, 36)} ｜ ${(later[0]?.hover ?? '').slice(0, 36)}`);
  ok('抽樣的 n 至少 2 個、每個都有結果', new Set(got.map((r: any) => r.n)).size >= 2,
    JSON.stringify([...new Set(got.map((r: any) => r.n))]));
  // 作者要的驗收：45／46／13／14／23 各在兩個不同節各測一次，hover 與點擊都要一致
  const pairOk = pairs.filter((p: any) => p.sections >= 2).map((p: any) => p.n);
  const pairBad = pairs.filter((p: any) => p.sections >= 2)
    .filter((p: any) => got.filter((r: any) => r.n === p.n && !r.same).length > 0).map((p: any) => p.n);
  ok('5 個重複的 n 各在兩個不同節測過，而且都一致',
    pairOk.length >= 5 && pairBad.length === 0,
    `在兩節以上測到的 n：${JSON.stringify(pairOk)}；不一致的：${JSON.stringify(pairBad)}`);

  // ys：也有 <註>/<釋>（16,355 條，n 不重複），但沒有 pg —— 抽查 hover 與點擊要一致。
  // 分成幾步（開庫／選出一個真的有釋的 n／量測），任何一步卡住都看得出在哪。
  const ysOpen = await cdp.eval<any>(`
    (async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const res = await fetch('/ys.adb');
      await window.__accelon26.openFile(new File([await res.blob()], 'ys.adb', { type: 'application/octet-stream' }));
      for (let i = 0; i < 300; i++) {
        const p = window.__accelon26.state().treePhases ?? {};
        if (p.instances !== undefined || p.skipped !== undefined) break;
        await sleep(150);
      }
      await sleep(600);
      const q = document.getElementById('query');
      q.value = '13p0303a';
      q.dispatchEvent(new Event('input'));
      q.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await sleep(1500);
      return {
        db: window.__accelon26.state().db,
        refs: [...document.querySelectorAll('#docText a.noteRef')].map((a) => a.dataset.note ?? '').slice(0, 20),
      };
    })()
  `);
  let ysPick = '';
  for (const n of (ysOpen.refs ?? [])) {
    const p = await cdp.eval<any>(`window.__accelon26.notePagesOf(${JSON.stringify(n)})`);
    if ((p?.bodies ?? []).length) { ysPick = n; break; }
  }
  let ysMeasured: any = { n: '', hover: '', clickText: '' };
  if (ysPick) {
    ysMeasured = await cdp.eval<any>(`
      (async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const tip = document.getElementById('noteTip');
        const hide = () => { tip.hidden = true; tip.textContent = ''; };
        const ref = [...document.querySelectorAll('#docText a.noteRef')].find((a) => (a.dataset.note ?? '') === ${JSON.stringify(ysPick)});
        if (!ref) return { missing: true };
        hide();
        ref.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }));
        for (let i = 0; i < 80; i++) {
          await sleep(60);
          if (!tip.hidden && tip.textContent && tip.textContent !== '讀取中…') break;
        }
        const hover = (tip.textContent ?? '').replace(/\\s+/g, ' ').trim();
        hide();
        await sleep(250);
        ref.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        for (let i = 0; i < 140; i++) {
          await sleep(60);
          if (document.querySelector('.docLine.noteTarget')) break;
        }
        const row = document.querySelector('.docLine.noteTarget');
        const clickText = [row, row?.nextElementSibling].map((el) => (el?.textContent ?? '')).join(' ')
          .replace(/\\s+/g, ' ').replace(/^[\\s[［]*[^\\s\\]］]*[\\s\\]］]*/, '').trim();
        return { n: ${JSON.stringify(ysPick)}, hover: hover.slice(0, 70), clickText: clickText.slice(0, 70) };
      })()
    `);
  }
  const ys = {
    db: ysOpen.db,
    picked: ysPick,
    hover: ysMeasured.hover,
    clickText: ysMeasured.clickText,
    same: !!ysMeasured.hover && !!ysMeasured.clickText
      && (String(ysMeasured.clickText).startsWith(String(ysMeasured.hover).slice(0, 18))
        || String(ysMeasured.hover).startsWith(String(ysMeasured.clickText).slice(0, 18))),
  };
  ok('ys（n 不重複）行為不變：hover 與點擊一致', ys.db === 'ys' && ys.same === true, JSON.stringify(ys));

  // hover `<釋>` 開頭的 [n]：原文提示上方要有 breadcrumb（作者 2026-11-02）
  const crumb = await cdp.eval<any>(`
    (async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const chips = [...document.querySelectorAll('#dbTabs .dbChip')];
      chips.find((c) => /空之探究|yl38/.test(c.textContent))?.click();
      await sleep(1200);
      const q = document.getElementById('query');
      q.value = 'yl38p25';
      q.dispatchEvent(new Event('input'));
      q.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await sleep(1400);
      const ref = [...document.querySelectorAll('#docText a.noteRef')].find((a) => a.dataset.note === '45');
      if (!ref) return { missing: true };
      ref.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      for (let i = 0; i < 120; i++) {
        await sleep(80);
        if (document.querySelector('#docText a.noteBack')) break;
      }
      const back = [...document.querySelectorAll('#docText a.noteBack')].find((a) => a.dataset.note === '45')
        ?? document.querySelector('#docText a.noteBack');
      if (!back) return { noBack: true };
      const diag = {
        inLine: !!back.closest('.docLine'),
        rowId: back.closest('.docLine')?.id ?? '',
        note: back.dataset.note ?? '',
        cls: back.className,
        parent: back.parentElement?.className ?? '',
      };
      const tip = document.getElementById('noteTip');
      tip.hidden = true; tip.textContent = '';
      back.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }));
      for (let i = 0; i < 120; i++) {
        await sleep(80);
        if (!tip.hidden && tip.textContent && tip.textContent !== '讀取中…') break;
      }
      const crumbEl = tip.querySelector('.noteCrumb');
      const out = {
        diag,
        hasCrumbClass: !!crumbEl,
        crumb: (crumbEl?.textContent ?? '').trim(),
        ctx: (tip.querySelector('.noteCtx')?.textContent ?? '').trim().slice(0, 40),
        tipText: (tip.textContent ?? '').trim().slice(0, 60),
      };
      tip.hidden = true; tip.textContent = '';
      return out;
    })()
  `);
  ok('hover 釋文的 [n]：原文提示上方有 breadcrumb（不可點）',
    crumb.hasCrumbClass === true && (crumb.crumb ?? '').length > 0 && /›/.test(crumb.crumb ?? ''),
    JSON.stringify(crumb));
  ok('原文提示同時還有「原文那句」', (crumb.ctx ?? '').length > 0, JSON.stringify({ ctx: crumb.ctx }));

  if (cdp.logs.length) console.error(cdp.logs.slice(-8).join('\n'));
} finally {
  proc.kill();
  server.stop(true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
