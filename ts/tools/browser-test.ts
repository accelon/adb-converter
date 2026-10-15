/**
 * Headless browser test for the single-file mockup.
 *
 *   bun run tools/browser-test.ts [--html ../build/adbview.html] [--adb ..\\13j.adb]
 *
 * Starts a tiny static server (so the page is an http origin and the test can
 * hand the page a real .adb), launches Edge/Chrome headless with the DevTools
 * protocol, then drives `window.__adbview` exactly like a user would:
 * open a database, list tokens, show a document, show a token's posting list.
 * Asserts the DOM actually changed.
 */
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const HTML = resolve(opt('html', resolve(import.meta.dir, '../../build/adbview.html')));
const ADB = resolve(opt('adb', resolve(import.meta.dir, '../../13j.adb')));
const PORT = Number(opt('port', '8931'));

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/chromium', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
const browser = BROWSERS.find((p) => existsSync(p));
if (!browser) { console.error('no Chromium browser found'); process.exit(2); }
if (!existsSync(HTML)) { console.error('missing ' + HTML + ' (run tools/build-viewer.ts first)'); process.exit(2); }
if (!existsSync(ADB)) { console.error('missing ' + ADB); process.exit(2); }

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + name + (detail ? '  ' + detail : '')); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
};

// ---- static server (http origin so the page may fetch the adb) -------------
const server = Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/' || url.pathname === '/adbview.html') {
      return new Response(Bun.file(HTML), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    if (url.pathname === '/test.adb') {
      return new Response(Bun.file(ADB), { headers: { 'Content-Type': 'application/octet-stream' } });
    }
    return new Response('not found', { status: 404 });
  },
});
const base = `http://127.0.0.1:${PORT}`;

// ---- headless browser ------------------------------------------------------
const profile = resolve(import.meta.dir, '../../build/.chrome-profile');
// Chrome >= 111 rejects a CDP websocket whose Origin it does not know, so the
// browser must be told to accept ours (see the "Rejected an incoming WebSocket
// connection from the http://localhost origin" message).
const proc = Bun.spawn([browser, '--headless=new', '--disable-gpu', '--no-first-run',
  '--remote-debugging-port=0', '--remote-allow-origins=*',
  `--user-data-dir=${profile}`, '--no-default-browser-check',
  'about:blank'], { stdout: 'pipe', stderr: 'pipe' });

async function devtoolsUrl(): Promise<string> {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    // DevToolsActivePort = "<port>\n<path of the browser websocket>"
    const text = await Bun.file(resolve(profile, 'DevToolsActivePort')).text().catch(() => '');
    const [portLine, pathLine] = text.split('\n').map((s) => s.trim());
    const port = Number(portLine);
    if (port > 0 && pathLine) return `ws://127.0.0.1:${port}${pathLine}`;
    await Bun.sleep(200);
  }
  throw new Error('DevToolsActivePort never appeared');
}

/** Minimal CDP client: one page target, evaluate JS, read the result. */
class Cdp {
  private ws!: WebSocket;
  private id = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private sessionId = '';
  logs: string[] = [];

  static async attach(browserWs: string): Promise<Cdp> {
    const c = new Cdp();
    await c.connect(browserWs);
    return c;
  }

  private connect(url: string): Promise<void> {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(url);
      this.ws.onopen = () => res();
      this.ws.onerror = (e) => rej(new Error('ws error ' + String(e)));
      this.ws.onmessage = (ev) => {
        const msg = JSON.parse(String(ev.data));
        if (msg.id && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message));
          else p.resolve(msg.result);
          return;
        }
        if (msg.method === 'Runtime.consoleAPICalled') {
          const text = (msg.params.args ?? []).map((a: any) => a.value ?? a.description ?? a.type).join(' ');
          this.logs.push(msg.params.type + ': ' + text);
        }
        if (msg.method === 'Runtime.exceptionThrown') {
          this.logs.push('exception: ' + (msg.params.exceptionDetails?.exception?.description ?? '?'));
        }
      };
    });
  }

  async send(method: string, params: Record<string, unknown> = {}, session = true): Promise<any> {
    const id = ++this.id;
    const payload: Record<string, unknown> = { id, method, params };
    if (session && this.sessionId) payload.sessionId = this.sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error('timeout: ' + method)); }, 30000);
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
    const r = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
    return r.result.value as T;
  }
}

try {
  const cdp = await Cdp.attach(await devtoolsUrl());
  await cdp.openPage(base + '/adbview.html');
  await Bun.sleep(600); // let DOMContentLoaded run

  ok('page loaded the viewer bundle', await cdp.eval<boolean>('!!window.__adbview'), 'window.__adbview present');
  ok('initial status asks for a file', (await cdp.eval<string>('window.__adbview.status()') ?? '').includes('選擇'),
    await cdp.eval<string>('window.__adbview.status()'));

  // hand the page a real database, exactly like the file picker / drop would
  const opened = await cdp.eval<{ db: string; tokens: number; docs: number; ms: number; status: string }>(`
    (async () => {
      const t0 = performance.now();
      const res = await fetch('/test.adb');
      const blob = await res.blob();
      const file = new File([blob], 'test.adb', { type: 'application/octet-stream' });
      await window.__adbview.openFile(file);
      const s = window.__adbview.state();
      return { db: s.db, tokens: s.tokens, docs: s.docs, ms: performance.now() - t0, status: window.__adbview.status() };
    })()
  `);
  ok('opened the adb from a Blob (file picker path)', !!opened.db, JSON.stringify(opened));
  ok('token index built', opened.tokens > 1000, opened.tokens + ' tokens');
  ok('open+index is fast', opened.ms < 8000, opened.ms.toFixed(0) + ' ms');

  const dom = await cdp.eval<Record<string, string>>(`(() => ({
    meta: document.querySelector('#meta').textContent.trim().slice(0, 240),
    containers: document.querySelector('#containers').textContent.trim().slice(0, 80),
    tokens: document.querySelectorAll('#tokenRows .tokenRow').length,
    listed: document.querySelector('#tokenTitle').textContent,
    classes: document.querySelector('#tokenClasses').textContent.replace(/\\s+/g, ' ').trim(),
  }))()`);
  ok('meta pane rendered with timing breakdown', /開啟/.test(dom.meta) && /token 索引/.test(dom.meta), dom.meta.slice(0, 120));
  ok('container list rendered', dom.containers.includes('source'), dom.containers);
  ok('token rows rendered (first page)', dom.tokens >= 200, String(dom.tokens));
  ok('class chips show counts', /漢字/.test(dom.classes), dom.classes);

  // The posting list pane was removed and token browsing is advanced-only, so
  // this switches that mode on first.
  const tokenResult = await cdp.eval<string>(`
    (async () => {
      window.__adbview.setAdvanced(true);
      window.__adbview.showTab('token', 'left');
      await new Promise(r => setTimeout(r, 400));
      const rows = document.querySelectorAll('#tokenRows .tokenRow');
      rows[0].click();
      await new Promise(r => setTimeout(r, 900));
      return document.querySelector('#status').textContent.replace(/\\s+/g, ' ').trim().slice(0, 120);
    })()
  `);
  ok('clicking a token reads its posting list and jumps there',
    tokenResult.includes('區塊'), tokenResult);

  // token click jumps the document pane and paints only that token
  const marked = await cdp.eval<{ mark: string; line: string | null; pinned: any; tok: string }>(`
    (async () => {
      const rows = document.querySelectorAll('#tokenRows .tokenRow');
      const tok = rows[0].querySelector('.tokName').textContent;
      rows[0].click();
      for (let i = 0; i < 40; i++) {
        if (document.querySelector('#docText mark.docHit')) break;
        await new Promise(r => setTimeout(r, 200));
      }
      const hl = document.querySelector('#docText .hitLine');
      return {
        tok,
        mark: document.querySelector('#docText mark.docHit')?.textContent ?? '(no mark)',
        line: hl ? hl.id : null,
        pinned: window.__adbview.state().pinned,
      };
    })()
  `);
  ok('clicking a token paints it in the document', marked.mark !== '(no mark)' && !!marked.line,
    `token=${JSON.stringify(marked.tok)} mark=${JSON.stringify(marked.mark)} line=${marked.line}`);
  ok('the painted text is the clicked token', !!marked.pinned && marked.pinned.text === marked.mark,
    JSON.stringify(marked.pinned));
  ok('exactly one mark is painted', await cdp.eval<number>(`document.querySelectorAll('#docText mark.docHit').length`) === 1);

  // side toggles and right-column tabs (columns are width-based now)
  const ui = await cdp.eval<{ tab: string; cols: string; grid: string; leftTokens: boolean; rightTabs: boolean }>(`
    (async () => {
      window.__adbview.setAdvanced(true);
      window.__adbview.showTab('docs', 'right');
      const tab = document.querySelector('#colRight .tabBtn.active')?.getAttribute('data-tab');
      window.__adbview.setCols(25, 25);                      // both open
      window.__adbview.toggleSide('left');                   // -> 0/25
      await new Promise(r => setTimeout(r, 60));
      const mid = window.__adbview.cols();
      window.__adbview.toggleSide('right');                  // -> 0/0
      await new Promise(r => setTimeout(r, 60));
      const c = window.__adbview.cols();
      const grid = getComputedStyle(document.querySelector('main')).gridTemplateColumns;
      window.__adbview.setCols(25, 0);
      return {
        tab, cols: c.left + '/' + c.right, mid: mid.left + '/' + mid.right, grid,
        leftTokens: !!document.querySelector('#colLeft #tokenRows'),
        rightTabs: !!document.querySelector('#colRight .tabs'),
      };
    })()
  `);
  ok('right column tabs switch', ui.tab === 'docs', 'active tab = ' + ui.tab);
  ok('both side columns can be hidden independently', ui.cols === '0/0' && ui.mid === '0/25',
    `開 25/25 → 藏左 ${ui.mid} → 再藏右 ${ui.cols}；grid=${ui.grid.slice(0, 48)}`);
  ok('token list on the left, tabs on the right', ui.leftTokens && ui.rightTabs, JSON.stringify(ui));

  // document list + document text (only for a database that has 檔)
  const docResult = await cdp.eval<string>(`
    (async () => {
      const items = document.querySelectorAll('#docs .docItem');
      if (!items.length) return 'no-documents';
      items[0].click();
      await new Promise(r => setTimeout(r, 1500));
      return document.querySelector('#docText').textContent.replace(/\\s+/g,' ').trim().slice(0, 100);
    })()
  `);
  ok('document text renders (or the db has no 檔)', docResult === 'no-documents' || docResult.length > 20, docResult);

  const res = await cdp.eval<string>(`document.querySelector('#resources').textContent.replace(/\\s+/g,' ').trim().slice(0,60)`);
  ok('resource pane reports state', res.length > 0, res);

  const errors = cdp.logs.filter((l) => l.startsWith('exception') || l.startsWith('error'));
  ok('no page exceptions', errors.length === 0, errors.slice(0, 3).join(' | ') || 'clean');
} catch (e) {
  fail++;
  console.log('  FAIL harness: ' + (e as Error).message);
} finally {
  proc.kill();
  server.stop(true);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
