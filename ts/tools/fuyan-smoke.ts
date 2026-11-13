#!/usr/bin/env bun
/**
 * fuyan 全庫冒煙（作者 2026-11-13 13:23：「先確定最新版不影響 fuyan」）。
 *
 *   bun run tools/fuyan-smoke.ts [--adb ../accelon3/fuyan.adb] [--html D:/accelon3/accelon26.html]
 *
 * 三關，缺一不可：
 *   1. 錨點解析：`anchorVa` 改成「頁 id → 塊.段 → 節點錨點」三段式後，
 *      fuyan 的頁 id（含重排過的 38p35/36/40/41/111/112）必須照舊解析得到。
 *   2. 頁面渲染：開頁＋跳到指定行，該行文字必須出現在 DOM（抓「資料有、畫面沒有」）。
 *   3. JS 例外：全過程不得有 Runtime.exceptionThrown／console.error。
 *
 * 注意：`openPage` 之後 DOM 只載入當前 200 行視窗，**不能**用「該頁含某字」判斷，
 * 必須 `showLine(行號)` 定位（行號＝`out/fuyan.txt` 的行號，實測相同）。
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

/** 錨點解析（頁 id 一律要解析得到；null ＝ anchorVa 壞了） */
const ANCHORS = ['38p0', '38p8', '38p35', '38p36', '38p40', '38p41', '38p107', '38p111', '38p112',
  '38p275', '38p348', '5p1', '5p17', '5p132', '9p1', '9p260', '9p294'];

/** 頁面渲染（line ＝ out/fuyan.txt 的行號，實測與閱讀器行號相同） */
const LINES: Array<{ page: string; line: number; must: string; note: string }> = [
  { page: '38p8', line: 185, must: '空屋', note: '小目＋縮排' },
  { page: '38p8', line: 210, must: '㝹', note: 'ExtA 罕用字（系統字）' },
  { page: '38p34', line: 770, must: '𤛓', note: 'ExtB 罕用字（系統字）' },
  { page: '38p35', line: 800, must: '慈', note: '圖表頁' },
  { page: '38p55', line: 8346, must: '㝹', note: 'ExtA（釋文）' },
  { page: '38p56', line: 9174, must: '𨅖', note: 'ExtB 罕用字' },
  { page: '38p275', line: 12582, must: '𩜁', note: 'ExtB 罕用字' },
  { page: '38p304', line: 31062, must: '𨅖', note: 'ExtB 罕用字' },
  { page: '5p132', line: 26729, must: '𩑶', note: 'ExtB 罕用字' },
  { page: '9p260', line: 53816, must: '㲲', note: 'ExtA 罕用字' },
  { page: '9p294', line: 54227, must: '㲉', note: 'ExtA 罕用字' },
  { page: '5p17', line: 30000, must: '', note: '科判（標題不以句號收尾）' },
  // 附錄科判表的頌號（2026-11-13）：紙本是 `[NN]` 的字面文字，不是腳註。
  // 曾被 docx2zhonglun 當成註號（`<註 n="23"/>`），讀者看到一個點不動的藍上標，頌號反而不見。
  { page: '5p189', line: 17072, must: '[23]', note: '附錄科判表頌號（7觀三相品）' },
  { page: '5p353', line: 19241, must: '[02]', note: '附錄科判表頌號（17觀業品）' },
  { page: '5p596', line: 22852, must: '[02]', note: '附錄科判表頌號（25觀涅槃品）' },
  { page: '38p112', line: 15000, must: '', note: '正文空頁（紙本只有腳注續文）' },
  { page: '38p348', line: 55000, must: '', note: '全書末頁' },
];

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const browser = BROWSERS.find((p) => existsSync(p));
if (!browser) { console.error('no Chromium browser found'); process.exit(2); }
for (const p of [HTML, ADB]) if (!existsSync(p)) { console.error('missing ' + p); process.exit(2); }

const profile = resolve(ROOT, 'build/.chrome-profile-smoke' + process.pid);
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

// ── 第 1 關：錨點解析 ───────────────────────────────────────────
const anchors = await cdp.eval<Array<{ id: string; va: number | null; err?: string }>>(`
(async () => {
  const out = [];
  for (const id of ${JSON.stringify(ANCHORS)}) {
    const p = await window.__accelon26.xrefProbe('fuyan', id);
    out.push({ id, va: p && p.va != null ? p.va : null, err: p && p.error });
  }
  return out;
})()`);
let badA = 0;
console.log('── 錨點解析（anchorVa 三段式之後 fuyan 頁 id 仍要命中）');
for (const a of anchors) {
  const ok = a.va != null;
  if (!ok) badA++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${a.id.padEnd(8)} va=${a.va == null ? 'null' : a.va}${a.err ? ' ' + a.err : ''}`);
}

// ── 第 2 關：頁面渲染（開頁 → showLine → 文字）──────────────────
type Row = { page: string; line: number; chars: number; has: boolean; svg: number; noteRef: number; head: string };
const rows: Row[] = [];
for (const c of LINES) {
  const r = await cdp.eval<Row>(`
  (async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await window.__accelon26.openPage('fuyan', ${JSON.stringify(c.page)}, '');
    await sleep(500);
    await window.__accelon26.showLine(${c.line});
    await sleep(400);
    const body = document.querySelector('#docText .docBody');
    const text = (body ? body.innerText : '').replace(/\\s+/g, ' ');
    return {
      page: ${JSON.stringify(c.page)}, line: ${c.line},
      chars: text.replace(/\\s/g, '').length,
      has: ${JSON.stringify(c.must)} === '' ? true : text.indexOf(${JSON.stringify(c.must)}) >= 0,
      svg: document.querySelectorAll('#docText svg.inlineSvg').length,
      noteRef: document.querySelectorAll('#docText a.noteRef').length,
      head: text.slice(0, 34),
    };
  })()`);
  rows.push(r);
}
let badB = 0;
console.log('\n── 頁面渲染（行號＝out/fuyan.txt）');
console.log('頁      行號   字數  圖 注 目標字 結果 說明');
for (let i = 0; i < rows.length; i++) {
  const r = rows[i]!, c = LINES[i]!;
  const ok = r.chars > 0 && r.has;
  if (!ok) badB++;
  console.log(`${r.page.padEnd(7)} ${String(r.line).padStart(5)} ${String(r.chars).padStart(5)} ${String(r.svg).padStart(2)} ${String(r.noteRef).padStart(3)} ` +
    `${(c.must || '－').padEnd(5)} ${ok ? 'ok  ' : 'FAIL'} ${c.note}`);
}

// ── 第 3 關：JS 例外 ─────────────────────────────────────────
if (cdp.errors.length) {
  console.log('\n── JS 例外 ' + cdp.errors.length + ' 筆：');
  for (const e of cdp.errors.slice(0, 5)) console.log('  ' + e.split('\n')[0]);
}
const total = badA + badB + (cdp.errors.length ? 1 : 0);
console.log(`\n錨點 ${anchors.length - badA}/${anchors.length}　頁面 ${rows.length - badB}/${rows.length}　JS 例外 ${cdp.errors.length}` +
  `${total === 0 ? '　→ 全部正常' : `　→ 異常 ${total} 項`}`);
proc.kill();
process.exit(total === 0 ? 0 : 1);
