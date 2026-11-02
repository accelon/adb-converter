/**
 * 一次性診斷：閱讀器現在一個「讀窗」多大、pager 顯示什麼、`<頁>` 有沒有渲染。
 *
 *   bun run tools/win-ui-probe.ts [--adb 13j] [--node 4]
 */
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const ROOT = resolve(import.meta.dir, '../..');
const ADB = resolve(opt('adb', resolve(ROOT, '13j.adb')));
const NODE = Number(opt('node', '4'));
const PORT = Number(opt('port', String(7900 + Math.floor(Math.random() * 90))));
const HTML = resolve(ROOT, 'build/accelon26.html');
const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const browser = BROWSERS.find((p) => existsSync(p));
if (!browser || !existsSync(HTML) || !existsSync(ADB)) { console.error('missing browser/html/adb'); process.exit(2); }

const server = Bun.serve({
  port: PORT, hostname: '127.0.0.1',
  async fetch(req) {
    const u = new URL(req.url);
    if (u.pathname === '/accelon26.html') return new Response(Bun.file(HTML), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    if (u.pathname === '/db.adb') return new Response(Bun.file(ADB), { headers: { 'Content-Type': 'application/octet-stream' } });
    return new Response('nf', { status: 404 });
  },
});
const profile = resolve(ROOT, `build/.chrome-profile-wui-${process.pid}-${Date.now() % 100000}`);
const proc = Bun.spawn([browser, '--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0',
  '--remote-allow-origins=*', `--user-data-dir=${profile}`, '--no-default-browser-check', 'about:blank'],
  { stdout: 'pipe', stderr: 'pipe' });
try {
  let ws = '';
  const until = Date.now() + 20000;
  while (Date.now() < until && !ws) {
    const t = await Bun.file(resolve(profile, 'DevToolsActivePort')).text().catch(() => '');
    const [p, path] = t.split('\n').map((s) => s.trim());
    if (Number(p) > 0 && path) ws = `ws://127.0.0.1:${p}${path}`;
    if (!ws) await Bun.sleep(200);
  }
  const sock = new WebSocket(ws);
  await new Promise<void>((res, rej) => { sock.onopen = () => res(); sock.onerror = () => rej(new Error('ws')); });
  let id = 0, session = '';
  const pending = new Map<number, (v: any) => void>();
  sock.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data));
    if (m.id && pending.has(m.id)) { const f = pending.get(m.id)!; pending.delete(m.id); f(m.result); }
    else if (m.method === 'Target.attachedToTarget') session = m.params.sessionId;
  };
  const send = (method: string, params: any = {}, s = true): Promise<any> => new Promise((res) => {
    const myId = ++id;
    const payload: any = { id: myId, method, params };
    if (s && session) payload.sessionId = session;
    pending.set(myId, res);
    sock.send(JSON.stringify(payload));
  });
  const created = await send('Target.createTarget', { url: 'http://127.0.0.1:' + PORT + '/accelon26.html' }, false);
  const attached = await send('Target.attachToTarget', { targetId: created.targetId, flatten: true }, false);
  session = attached.sessionId;
  await send('Runtime.enable');
  await Bun.sleep(1200);
  const ev = async (expr: string): Promise<any> => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval fail');
    return r.result.value;
  };
  const out = await ev(`
    (async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const res = await fetch('/db.adb');
      await window.__accelon26.openFile(new File([await res.blob()], 'db.adb', { type: 'application/octet-stream' }));
      for (let i = 0; i < 300; i++) { const p = window.__accelon26.state().treePhases ?? {}; if (p.instances !== undefined || p.skipped !== undefined) break; await sleep(150); }
      await sleep(800);
      const rows = [...document.querySelectorAll('#dirTree .tRow .tName')].slice(0, ${NODE});
      const out = [];
      for (const row of rows) {
        row.click();
        await sleep(1600);
        const s = window.__accelon26.state();
        out.push({
          name: (row.textContent ?? '').trim().slice(0, 10),
          range: s.docRange, page: s.docPage, pages: s.docPages, pageLines: s.docPageLines,
          breaks: document.querySelectorAll('#docText .pageBreak').length,
          marks: document.querySelectorAll('#docText .pageMark').length,
          lines: document.querySelectorAll('#docText .docLine').length,
          pager: (document.getElementById('docPager')?.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 40),
          head: (document.querySelector('#docText .docBody')?.textContent ?? '').replace(/\\s+/g, '').slice(0, 24),
        });
      }
      return out;
    })()
  `);
  console.log(JSON.stringify(out, null, 1));
} finally {
  proc.kill();
  server.stop(true);
}
