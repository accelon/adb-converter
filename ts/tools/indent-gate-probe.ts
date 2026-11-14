#!/usr/bin/env bun
/**
 * 段首縮排的畫面層探針（厚觀法師 2026-11-14）。
 *
 *   bun run tools/indent-gate-probe.ts --adb ../accelon3/fuyan.adb     # 期望 0
 *   bun run tools/indent-gate-probe.ts --adb ../accelon3/ys.adb        # 期望 > 0
 *
 * 為什麼要這一支：`indent` 這個開關在 doc-pane 是**依庫名**給的
 * （`reader.header.dbname === 'fuyan'` 才關），單元測試只能證明渲染器聽話，
 * 證明不了「fuyan 這個庫真的走到那一支」。這裡直接開真的 adb、數畫面上的
 * `.paraIndent`，資料／設定／渲染三層一起驗。
 *
 * 另外回報 `.pageBreak` 的數量當對照：兩個數字一起看，才不會把「整頁沒渲染」
 * 誤讀成「縮排拿掉了」。
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => {
  const i = args.indexOf('--' + n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const ROOT = resolve(import.meta.dir, '../..');
const HTML = resolve(opt('html', 'D:/accelon3/accelon26.html'));
const ADB = resolve(opt('adb', resolve(ROOT, 'accelon3/fuyan.adb')));
const EXPECT = opt('expect', '');           // 給了就當斷言：0 / pos
const PAGE = opt('page', '');               // 指定頁 id（不給就用閱讀器自己開的那一頁）
const LINE = Number(opt('line', '0'));      // 指定行號（＝out/fuyan.txt 行號）；openPage 只載 200 行視窗
const DB = opt('db', ADB.replace(/^.*[\\/]/, '').replace(/\.adb$/i, ''));
const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const browser = BROWSERS.find((p) => existsSync(p));
if (!browser) { console.error('no Chromium browser found'); process.exit(2); }
for (const p of [HTML, ADB]) if (!existsSync(p)) { console.error('missing ' + p); process.exit(2); }

const profile = resolve(ROOT, 'build/.chrome-profile-indent' + process.pid);
const proc = Bun.spawn([browser, '--headless=new', '--disable-gpu', '--no-first-run',
  '--remote-debugging-port=0', '--remote-allow-origins=*', '--allow-file-access-from-files',
  '--window-size=1400,1000', `--user-data-dir=${profile}`, 'about:blank'],
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
  ws!: WebSocket;
  id = 0;
  pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  sessionId = '';
  errors: string[] = [];
  static async attach(url: string): Promise<Cdp> {
    const c = new Cdp();
    await new Promise<void>((res, rej) => {
      c.ws = new WebSocket(url);
      c.ws.onopen = () => res();
      c.ws.onerror = () => rej(new Error('ws error'));
      c.ws.onmessage = (ev) => {
        const m = JSON.parse(String(ev.data));
        if (m.method === 'Runtime.exceptionThrown') {
          c.errors.push(m.params?.exceptionDetails?.exception?.description ?? 'exception');
        } else if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') {
          c.errors.push((m.params.args ?? []).map((a: any) => a.value ?? a.description ?? '').join(' '));
        }
        if (m.id && c.pending.has(m.id)) {
          const p = c.pending.get(m.id)!;
          c.pending.delete(m.id);
          m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
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
      const timer = setTimeout(() => { if (this.pending.delete(id)) rej(new Error('timeout ' + method)); }, 60000);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); res(v); },
        reject: (e) => { clearTimeout(timer); rej(e); },
      });
      this.ws.send(JSON.stringify(payload));
    });
  }
  async openPage(url: string) {
    const { targetId } = await this.send('Target.createTarget', { url }, false);
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true }, false);
    this.sessionId = sessionId;
    await this.send('Runtime.enable');
    await this.send('Page.enable');
    await this.send('DOM.enable');
  }
  async eval<T>(expression: string): Promise<T> {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
    return r.result.value as T;
  }
}

const cdp = await Cdp.attach(await devtoolsUrl());
await cdp.openPage(pathToFileURL(HTML).href + '?v=' + Date.now());
await Bun.sleep(800);
const doc = await cdp.send('DOM.getDocument');
const q = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#file' });
await cdp.send('DOM.setFileInputFiles', { files: [ADB], nodeId: q.nodeId });
await cdp.eval('document.querySelector("#file").dispatchEvent(new Event("change"))');
await Bun.sleep(2500);
await cdp.eval(`document.querySelector('#aboutClose')?.click()`);

if (PAGE) {
  await cdp.eval(`(async () => {
    await window.__accelon26.openPage(${JSON.stringify(DB)}, ${JSON.stringify(PAGE)}, '');
  })()`);
  await Bun.sleep(1500);
}
if (LINE > 0) {
  await cdp.eval(`(async () => { await window.__accelon26.showLine(${LINE}); })()`);
  await Bun.sleep(1200);
}

const res = await cdp.eval<{ db: string; indent: number; page: number; chars: number; figures: number }>(`
(() => {
  const pane = document.querySelector('#docText');
  const text = (pane ? pane.innerText : '').replace(/\\s/g, '');
  return {
    db: document.querySelector('#docHead')?.innerText?.trim() ?? '',
    indent: pane ? pane.querySelectorAll('.paraIndent').length : -1,
    page: pane ? pane.querySelectorAll('.pageBreak').length : -1,
    chars: text.length,
    figures: pane ? pane.querySelectorAll('svg, img').length : -1,
  };
})()`);

console.log(JSON.stringify({
  adb: ADB,
  head: res.db,
  paraIndent: res.indent,
  pageMarks: res.page,
  figures: res.figures,
  chars: res.chars,
  jsErrors: cdp.errors,
}, null, 2));

let bad = 0;
if (EXPECT === '0' && res.indent !== 0) { console.error('FAIL 期望 0 個 paraIndent，實際 ' + res.indent); bad++; }
if (EXPECT === 'pos' && res.indent <= 0) { console.error('FAIL 期望有 paraIndent，實際 ' + res.indent); bad++; }
if (res.chars < 100) { console.error('FAIL 畫面幾乎沒字（' + res.chars + '），先確認這頁有沒有載入'); bad++; }
if (cdp.errors.length) { console.error('FAIL 有 JS 例外：' + cdp.errors.join(' ｜ ')); bad++; }

try { proc.kill(); } catch { /* ignore */ }
process.exit(bad ? 1 : 0);
