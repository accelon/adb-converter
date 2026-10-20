/**
 * One-off check: which left-column tabs does a database get, and do the pane pickers
 * show every `<樹>` that shares a kind?
 *
 *   bun run tools/check-tabs.ts [--adb <path>] [--html build/accelon26.html]
 *
 * Prints one JSON line. Serve the page over http and hand it the file as a Blob, the
 * same path the picker takes (see browser-test.ts).
 */
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const HTML = resolve(opt('html', resolve(import.meta.dir, '../../build/accelon26.html')));
const ADB = resolve(opt('adb', resolve(import.meta.dir, '../../13j.adb')));
const PORT = Number(opt('port', String(8900 + Math.floor(Math.random() * 90))));

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
  async fetch(req) {
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

const profile = resolve(import.meta.dir, '../../build/.chrome-profile-tabs');
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
      setTimeout(() => { if (this.pending.delete(id)) rej(new Error('timeout ' + method)); }, 120000);
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
  await Bun.sleep(600);

  const out = await cdp.eval<any>(`
    (async () => {
      const res = await fetch('/test.adb');
      const blob = await res.blob();
      const file = new File([blob], 'test.adb', { type: 'application/octet-stream' });
      await window.__accelon26.openFile(file);
      const st = () => window.__accelon26.state();
      // wait for the background directory tree: that is when syncTreeTabs runs again
      for (let i = 0; i < 300; i++) {
        const p = st().treePhases ?? {};
        if (p.instances !== undefined || p.skipped !== undefined) break;
        await new Promise(r => setTimeout(r, 200));
      }
      await new Promise(r => setTimeout(r, 400));
      const shown = (sel) => { const b = document.querySelector(sel); return !!b && !b.hidden && getComputedStyle(b).display !== 'none'; };
      const tabs = [...document.querySelectorAll('#colLeft .tabBtn')]
        .filter((b) => !b.hidden && getComputedStyle(b).display !== 'none')
        .map((b) => ({ tab: b.dataset.tab, label: b.textContent.trim() }));
      const pick = (id) => {
        const wrap = document.querySelector('#' + id + 'Wrap');
        const sel = document.querySelector('#' + id);
        return {
          shown: !!wrap && !wrap.hidden,
          options: sel ? [...sel.options].map((o) => o.textContent.trim()) : [],
          value: sel ? sel.value : null,
        };
      };
      // 切到第二棵樹，確認真的換了內容（不是只有下拉好看）
      const rowsOf = (listId) => [...document.querySelectorAll('#' + listId + ' .snippet b, #' + listId + ' .tRow .tName')]
        .slice(0, 3).map((b) => b.textContent.trim());
      const exercise = async (id, listId) => {
        const sel = document.querySelector('#' + id);
        if (!sel || sel.options.length < 2) return null;
        const before = rowsOf(listId);
        sel.value = sel.options[1].value;
        sel.dispatchEvent(new Event('change'));
        await new Promise(r => setTimeout(r, 1500));
        const after = rowsOf(listId);
        return { before, after, changed: JSON.stringify(before) !== JSON.stringify(after) };
      };
      const dirSwitch = await (async () => {
        const sel = document.querySelector('#dirPick');
        if (!sel || sel.options.length < 2) return null;
        const info = () => window.__accelon26.state().dirInfo;
        const before = info();
        const beforeRows = rowsOf('dirTree');
        const hasHandler = typeof sel.onchange;
        sel.value = sel.options[1].value;
        sel.dispatchEvent(new Event('change'));
        await new Promise(r => setTimeout(r, 1500));
        const after = info();
        return {
          hasHandler,
          beforeTiers: before?.tiers, afterTiers: after?.tiers,
          beforeNodes: before?.nodes, afterNodes: after?.nodes,
          beforeKids: before?.kidsTotal, afterKids: after?.kidsTotal,
          beforeRows, afterRows: rowsOf('dirTree'),
        };
      })();
      const freqSwitch = await exercise('freqPick', 'freqList');
      return {
        db: st().db,
        scopes: st().scopes,
        treeNames: st().treeNames,
        builtScopes: st().builtScopes,
        phases: st().treePhases,
        tabs,
        dirPick: pick('dirPick'),
        freqPick: pick('freqPick'),
        dirSwitch,
        freqSwitch,
      };
    })()
  `);
  console.log(JSON.stringify(out, null, 2));
  // optional: switch to a second database in the same page (resetScopes + restoreScopes)
  if (opt('adb2', '')) {
    const b2 = await Bun.file(resolve(opt('adb2', ''))).arrayBuffer();
    const second = await cdp.eval<any>(`
      (async () => {
        const bytes = new Uint8Array(${JSON.stringify([...new Uint8Array(b2)])});
        await window.__accelon26.openFile(new File([bytes], 'second.adb'));
        const st = () => window.__accelon26.state();
        for (let i = 0; i < 300; i++) {
          const p = st().treePhases ?? {};
          if (p.instances !== undefined || p.skipped !== undefined) break;
          await new Promise(r => setTimeout(r, 200));
        }
        await new Promise(r => setTimeout(r, 400));
        return {
          db: st().db,
          tabs: [...document.querySelectorAll('#colLeft .tabBtn')]
            .filter((b) => !b.hidden && getComputedStyle(b).display !== 'none')
            .map((b) => ({ tab: b.dataset.tab, label: b.textContent.trim() })),
          dirPickShown: !(document.querySelector('#dirPickWrap')?.hidden ?? true),
          freqPickShown: !(document.querySelector('#freqPickWrap')?.hidden ?? true),
          dirActive: st().dirActive,
          treeNames: st().treeNames,
        };
      })()
    `);
    console.log(JSON.stringify({ second }, null, 2));
  }
  if (cdp.logs.length) console.error(cdp.logs.slice(-5).join('\n'));
} finally {
  proc.kill();
  server.stop(true);
}
