/**
 * 診斷：taisho 這種 241 MB 的庫，目錄點書會不會炸、查一個字會不會把記憶體吃光。
 *
 *   bun run tools/probe-taisho.ts --adb D:/accelon3/taisho.adb [--click 史傳部三] [--query 佛]
 *                                [--html build/accelon26.html] [--sample 200]
 *
 * 只在真正的 UI 路徑上操作（點 .tRow、在 #query 打字），每一步之後量 V8 堆與
 * renderer 進程的 RSS，並記下 CDP 的崩潰／例外事件。輸出最後一行是 JSON。
 */
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const HTML = resolve(opt('html', resolve(import.meta.dir, '../../build/accelon26.html')));
const ADB = resolve(opt('adb', 'D:/accelon3/taisho.adb'));
const CLICKS = opt('click', '').split('|').filter(Boolean);
const QUERY = opt('query', '');
const SAMPLE_MS = Number(opt('sample', '250'));
const PORT = Number(opt('port', String(9000 + Math.floor(Math.random() * 90))));

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const browser = BROWSERS.find((p) => existsSync(p));
if (!browser) { console.error('no Chromium browser found'); process.exit(2); }
if (!existsSync(HTML)) { console.error('missing ' + HTML); process.exit(2); }
if (!existsSync(ADB)) { console.error('missing ' + ADB); process.exit(2); }

const server = Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/' || url.pathname === '/accelon26.html') {
      return new Response(Bun.file(HTML), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    if (url.pathname === '/test.adb') {
      return new Response(Bun.file(ADB), { headers: { 'Content-Type': 'application/octet-stream' } });
    }
    return new Response('not found', { status: 404 });
  },
});

const profile = resolve(import.meta.dir, '../../build/.chrome-profile-probe');
try { await import('node:fs/promises').then((fs) => fs.rm(profile, { recursive: true, force: true })); } catch { /* ignore */ }
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

const events: { t: number; kind: string; detail: string }[] = [];
const t0 = Date.now();

class Cdp {
  private ws!: WebSocket;
  private id = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  sessionId = '';
  dead = false;
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
        if (m.method === 'Inspector.targetCrashed') { c.dead = true; events.push({ t: Date.now() - t0, kind: 'targetCrashed', detail: '' }); }
        if (m.method === 'Target.targetCrashed') { c.dead = true; events.push({ t: Date.now() - t0, kind: 'targetCrashed', detail: JSON.stringify(m.params) }); }
        if (m.method === 'Runtime.exceptionThrown') {
          const d = m.params.exceptionDetails;
          events.push({ t: Date.now() - t0, kind: 'exception', detail: (d?.exception?.description ?? d?.text ?? '?').slice(0, 600) });
        }
        if (m.method === 'Log.entryAdded') {
          const e = m.params.entry;
          events.push({ t: Date.now() - t0, kind: 'log:' + e.level, detail: String(e.text).slice(0, 300) });
        }
        if (m.method === 'Inspector.detached') { c.dead = true; events.push({ t: Date.now() - t0, kind: 'detached', detail: String(m.params.reason) }); }
      };
    });
    return c;
  }
  async send(method: string, params: Record<string, unknown> = {}, session = true): Promise<any> {
    if (this.dead) throw new Error('renderer dead');
    const id = ++this.id;
    const payload: Record<string, unknown> = { id, method, params };
    if (session && this.sessionId) payload.sessionId = this.sessionId;
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => { if (this.pending.delete(id)) rej(new Error('timeout ' + method)); }, 120000);
    });
  }
  async openPage(url: string) {
    const { targetId } = await this.send('Target.createTarget', { url }, false);
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true }, false);
    this.sessionId = sessionId;
    await this.send('Runtime.enable');
    await this.send('Page.enable');
    await this.send('Log.enable');
    await this.send('Inspector.enable');
  }
  async eval<T>(expression: string): Promise<T> {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'eval failed');
    return r.result.value as T;
  }
  async heap(): Promise<{ used: number; total: number }> {
    const h = await this.send('Runtime.getHeapUsage');
    return { used: h.usedSize, total: h.totalSize };
  }
}

/** sample the renderer heap until `fn` settles; returns peak */
async function sampleWhile<T>(cdp: Cdp, fn: () => Promise<T>): Promise<{ peakUsed: number; peakTotal: number; maxSampleMs: number; result?: T; error?: string }> {
  let peakUsed = 0, peakTotal = 0, maxSampleMs = 0;
  let done = false;
  const sampler = (async () => {
    while (!done) {
      const s = performance.now();
      try {
        const h = await cdp.heap();
        peakUsed = Math.max(peakUsed, h.used);
        peakTotal = Math.max(peakTotal, h.total);
      } catch { break; }
      maxSampleMs = Math.max(maxSampleMs, performance.now() - s);
      await Bun.sleep(SAMPLE_MS);
    }
  })();
  try {
    const result = await fn();
    done = true; await sampler;
    return { peakUsed, peakTotal, maxSampleMs, result };
  } catch (e) {
    done = true; await sampler;
    return { peakUsed, peakTotal, maxSampleMs, error: e instanceof Error ? e.message : String(e) };
  }
}

const mb = (n: number) => Math.round(n / 1048576);

try {
  const cdp = await Cdp.attach(await devtoolsUrl());
  await cdp.openPage(`http://127.0.0.1:${PORT}/accelon26.html`);
  await Bun.sleep(700);

  const open = await sampleWhile(cdp, () => cdp.eval<any>(`
    (async () => {
      const res = await fetch('/test.adb');
      const blob = await res.blob();
      const file = new File([blob], 'taisho.adb', { type: 'application/octet-stream' });
      await window.__accelon26.openFile(file);
      const st = () => window.__accelon26.state();
      for (let i = 0; i < 900; i++) {
        const p = st().treePhases ?? {};
        if (p.instances !== undefined || p.skipped !== undefined) break;
        await new Promise(r => setTimeout(r, 200));
      }
      await new Promise(r => setTimeout(r, 500));
      const s = st();
      return { db: s.db, tiers: s.dirInfo?.tiers, nodes: s.dirInfo?.nodes, rows: s.dirRows,
               phases: s.treePhases, textCache: s.textCache, mapper: s.mapper };
    })()
  `));
  const step: Record<string, unknown> = { open: { ...open, peakUsedMB: mb(open.peakUsed), peakTotalMB: mb(open.peakTotal) } };

  // 目錄：把樹展開到看得見要點的書（逐層點開）
  if (args.includes('--dump')) {
    const dump = await sampleWhile(cdp, () => cdp.eval<any>(`
      (async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const rows = () => [...document.querySelectorAll('#dirTree .tRow')];
        for (let pass = 0; pass < 3; pass++) {
          const closed = rows().filter((r) => (r.querySelector('.tTwisty')?.textContent ?? '') === '▸');
          if (!closed.length) break;
          for (const r of closed.slice(0, 400)) {
            const t = r.querySelector('.tTwisty');
            if (t) t.click();
            await sleep(30);
          }
          await sleep(600);
          await window.__accelon26.growTree();
          await sleep(300);
        }
        return rows().slice(0, 900).map((r) => ({
          tag: (r.querySelector('.tTag')?.textContent ?? '').trim(),
          name: (r.querySelector('.tName')?.textContent ?? '').trim(),
        }));
      })()
    `));
    step.dump = dump.result;
  }
  if (CLICKS.length) {
    const click = await sampleWhile(cdp, () => cdp.eval<any>(`
      (async () => {
        const out = [];
        const rows = () => [...document.querySelectorAll('#dirTree .tRow')];
        const find = (name) => rows().find((r) => (r.querySelector('.tName')?.textContent ?? '').trim() === name);
        const st = () => window.__accelon26.state();
        for (const name of ${JSON.stringify(CLICKS)}) {
          await window.__accelon26.growTree();
          const row = find(name);
          if (!row) {
            out.push({ name, found: false, sample: rows().slice(0, 400).map(r => (r.querySelector('.tName')?.textContent ?? '').trim()).filter((x) => x.includes(name.slice(0, 2))).slice(0, 8) });
            continue;
          }
          const before = st();
          (row.querySelector('.tName') ?? row).click();
          await new Promise(r => setTimeout(r, 1500));
          const s = st();
          out.push({
            name, found: true,
            docRealm: s.docRealm, docTabs: s.docTabs?.length, docPageLines: s.docPageLines,
            docRows: s.docRows, marks: s.marks, status: document.getElementById('status')?.textContent?.slice(0, 120),
            textCache: s.textCache, linkMs: s.lastLink?.totalMs, rows: s.dirRows,
            beforeRows: before.docRows,
            trail: (document.getElementById('docTrail')?.innerHTML ?? '').slice(0, 900),
          });
        }
        return out;
      })()
    `));
    step.click = { ...click, peakUsedMB: mb(click.peakUsed), peakTotalMB: mb(click.peakTotal) };
  }

  // 直接呼叫 revealHit(va) 並計時：看它是「很慢」還是「很吃記憶體」還是「丟例外」
  if (opt('va', '')) {
    const va = Number(opt('va', '0'));
    const watch = await sampleWhile(cdp, () => cdp.eval<any>(`
      (async () => {
        const st = () => window.__accelon26.state();
        const t0 = performance.now();
        let err = null;
        const p = window.__accelon26.revealHit(${va}, 'node-${va}', 1, { mode: 'node' })
          .catch((e) => { err = String(e && e.stack || e).slice(0, 800); });
        const marks = [];
        for (let i = 0; i < 40; i++) {
          await Promise.race([p, new Promise(r => setTimeout(r, 500))]);
          const s = st();
          marks.push({ ms: Math.round(performance.now() - t0), heapMB: Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1048576),
            docRows: s.docRows, docRealm: s.docRealm, cache: s.textCache,
            mapperLines: s.mapper?.lines, mapperVa: s.mapper?.va, complete: s.mapper?.complete,
            docTabs: s.docTabs?.length,
            first: (document.querySelector('#docText .docLine')?.textContent ?? '').slice(0, 60),
            status: (document.getElementById('status')?.textContent ?? '').slice(0, 80) });
          if (s.docRows > 0 || err) break;
        }
        return { va: ${va}, err, marks };
      })()
    `));
    step.va = { ...watch, peakUsedMB: mb(watch.peakUsed), peakTotalMB: mb(watch.peakTotal) };
  }

  // 頻次 pane 自己的輸入（分段計數也要是精確值）
  if (opt('freq', '')) {
    const freq = await sampleWhile(cdp, () => cdp.eval<any>(`
      (async () => {
        window.__accelon26.showTab('freq', 'left');
        await new Promise(r => setTimeout(r, 300));
        const q = document.getElementById('freqQuery');
        const t0 = performance.now();
        q.value = ${JSON.stringify(opt('freq', ''))};
        q.dispatchEvent(new Event('input'));
        for (let i = 0; i < 300; i++) {
          await new Promise(r => setTimeout(r, 200));
          const m = document.getElementById('freqMeta')?.textContent ?? '';
          if (m.includes('筆命中')) break;
        }
        const ms = Math.round(performance.now() - t0);
        await window.__accelon26.growTree();
        const out = {
          ms,
          meta: (document.getElementById('freqMeta')?.textContent ?? '').slice(0, 200),
          rows: document.querySelectorAll('#freqList .snippet').length,
          top: [...document.querySelectorAll('#freqList .snippet')].slice(0, 5)
            .map((r) => r.textContent.replace(/\\s+/g, ' ').trim().slice(0, 40)),
        };
        if (${args.includes('--freqclick') ? 'true' : 'false'}) {
          // rows are mounted a chunk at a time: wait for the first one before clicking
          for (let i = 0; i < 40 && !document.querySelector('#freqList .snippet'); i++) {
            await new Promise(r => setTimeout(r, 150));
          }
          const row = document.querySelector('#freqList .snippet');
          row?.click();
          await new Promise(r => setTimeout(r, 2000));
          return { ...out,
            sumMeta: (document.getElementById('searchMeta')?.textContent ?? '').slice(0, 160),
            sumItems: document.querySelectorAll('#searchList .snippet').length,
            sumFirst: (document.querySelector('#searchList .snippet')?.textContent ?? '').trim().slice(0, 60),
            scope: window.__accelon26.state().snippetScope,
          };
        }
        return out;
      })()
    `));
    step.freq = { ...freq, peakUsedMB: mb(freq.peakUsed), peakTotalMB: mb(freq.peakTotal) };
  }

  // 查詢：走真正的輸入框（含 120ms debounce）
  if (QUERY) {
    if (args.includes('--variants')) {
      await cdp.eval(`(() => { window.__accelon26.setVariants(true); return 1; })()`);
      await Bun.sleep(200);
    }
    const search = await sampleWhile(cdp, () => cdp.eval<any>(`
      (async () => {
        const st = () => window.__accelon26.state();
        const q = document.getElementById('query');
        q.value = ${JSON.stringify(QUERY)};
        q.dispatchEvent(new Event('input'));
        const before = st();
        for (let i = 0; i < 300; i++) {
          await new Promise(r => setTimeout(r, 200));
          const s = st();
          if (s.searchQuery === ${JSON.stringify(QUERY)}) break;
        }
        const s = st();
        await window.__accelon26.growTree();
        await new Promise(r => setTimeout(r, 300));
        const badgeOf = (name) => {
          const row = [...document.querySelectorAll('#dirTree .tRow')]
            .find((r) => (r.querySelector('.tName')?.textContent ?? '').trim() === name);
          return row ? (row.querySelector('.tCount')?.textContent ?? '').trim() : null;
        };
        const badgeSum = [...document.querySelectorAll('#dirTree .tRow')]
          .reduce((a, r) => a + (Number((r.querySelector('.tCount')?.textContent ?? '0').replace(/,/g, '')) || 0), 0);
        // 點某個冊的命中數：摘要要切成那一冊的命中（清單被截斷時必須另外去索引取）
        const pick = ${JSON.stringify(opt('badge', ''))};
        let afterClick = null;
        if (pick) {
          const row = [...document.querySelectorAll('#dirTree .tRow')]
            .find((r) => (r.querySelector('.tName')?.textContent ?? '').trim() === pick);
          if (row) {
            row.querySelector('.tCount')?.click();
            await new Promise(r => setTimeout(r, 1500));
            afterClick = {
              meta: document.getElementById('searchMeta')?.textContent?.slice(0, 200),
              snippets: document.querySelectorAll('#searchList .snippet').length,
              first: (document.querySelector('#searchList .snippet')?.textContent ?? '').trim().slice(0, 60),
            };
          }
        }
        // 點節點本身（名字／色塊）：本文聯動之外，摘要會不會被約束到這一節？
        const nodeName = ${JSON.stringify(opt('node', ''))};
        let afterNodeClick = null;
        if (nodeName) {
          const row = [...document.querySelectorAll('#dirTree .tRow')]
            .find((r) => (r.querySelector('.tName')?.textContent ?? '').trim() === nodeName);
          if (row) {
            const before = window.__accelon26.state();
            (row.querySelector('.tName') ?? row).click();
            await new Promise(r => setTimeout(r, 1800));
            const s2 = window.__accelon26.state();
            afterNodeClick = {
              meta: document.getElementById('searchMeta')?.textContent?.slice(0, 160),
              snippets: document.querySelectorAll('#searchList .snippet').length,
              scope: s2.snippetScope,
              docTab: s2.docTab, docTabs: s2.docTabs?.length,
              docRealm: s2.docRealm, beforeRealm: before.docRealm,
            };
          } else afterNodeClick = { notFound: true };
        }
        return {
          hits: s.multi?.hits ?? null, truncated: s.multi?.truncated ?? null,
          q: s.searchQuery, searchMs: s.multi?.ms ?? null,
          hitTotal: s.hitTotal,
          listRows: document.querySelectorAll('#searchList .snippet').length,
          meta: document.getElementById('searchMeta')?.textContent?.slice(0, 200),
          badges: [...document.querySelectorAll('#dirTree .tRow')].slice(0, 8)
            .map((r) => [(r.querySelector('.tName')?.textContent ?? '').trim(), (r.querySelector('.tCount')?.textContent ?? '').trim()]),
          badgeSum, zeros: [...document.querySelectorAll('#dirTree .tRow')].filter((r) => !r.querySelector('.tCount')).length,
          afterClick, afterNodeClick,
          treeRows: document.querySelectorAll('#dirTree .tRow').length,
          heapMB: Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1048576),
        };
      })()
    `));
    step.search = { ...search, peakUsedMB: mb(search.peakUsed), peakTotalMB: mb(search.peakTotal) };
  }

  step.dead = cdp.dead;
  step.events = events.slice(-25);
  console.log(JSON.stringify(step, null, 2));
} finally {
  proc.kill();
  server.stop(true);
}
