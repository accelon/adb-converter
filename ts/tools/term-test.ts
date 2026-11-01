#!/usr/bin/env bun
/**
 * `<术 sk|pi|tb>` 術語（2026-10-31）：
 *   顏色（三語言不同）、hover 的 title、行內模式、關閉模式、設定持久化。
 *
 *   cd ts && bun run tools/term-test.ts
 */
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const ROOT = resolve(import.meta.dir, '../..');
const HTML = resolve(opt('html', resolve(ROOT, 'build/accelon26.html')));
const ADB = resolve(opt('adb', 'D:/accelon3/ys.adb'));
const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const browser = BROWSERS.find((p) => existsSync(p))!;
const profile = resolve(ROOT, 'build/.chrome-profile-term-' + process.pid);
const proc = Bun.spawn([browser, '--headless=new', '--disable-gpu', '--no-first-run',
  '--remote-debugging-port=0', '--remote-allow-origins=*', '--allow-file-access-from-files',
  '--window-size=1500,1100', `--user-data-dir=${profile}`, 'about:blank'],
  { stdout: 'pipe', stderr: 'pipe' });
async function devtoolsUrl(): Promise<string> {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const text = await Bun.file(resolve(profile, 'DevToolsActivePort')).text().catch(() => '');
    const [port, path] = text.split('\n').map((s) => s.trim());
    if (Number(port) > 0 && path) return `ws://127.0.0.1:${port}${path}`;
    await Bun.sleep(200);
  }
  throw new Error('no devtools');
}
class Cdp {
  ws!: WebSocket; id = 0; sessionId = '';
  pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  logs: string[] = [];
  static async attach(url: string): Promise<Cdp> {
    const c = new Cdp();
    await new Promise<void>((res, rej) => {
      c.ws = new WebSocket(url);
      c.ws.onopen = () => res();
      c.ws.onerror = () => rej(new Error('ws error'));
      c.ws.onmessage = (ev) => {
        const m = JSON.parse(String(ev.data));
        if (m.method === 'Runtime.consoleAPICalled') c.logs.push('[console] ' + (m.params?.args ?? []).map((a: any) => a.value ?? a.description ?? a.type).join(' '));
        if (m.method === 'Runtime.exceptionThrown') c.logs.push('[exception] ' + (m.params?.exceptionDetails?.exception?.description ?? m.params?.exceptionDetails?.text));
        if (m.id && c.pending.has(m.id)) {
          const p = c.pending.get(m.id)!; c.pending.delete(m.id);
          m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
        }
      };
    });
    return c;
  }
  send(method: string, params: Record<string, unknown> = {}, session = true): Promise<any> {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, sessionId: session ? this.sessionId : undefined }));
    });
  }
  async openPage(url: string): Promise<void> {
    const { targetId } = await this.send('Target.createTarget', { url }, false);
    const r = await this.send('Target.attachToTarget', { targetId, flatten: true }, false);
    this.sessionId = r.sessionId;
    await this.send('Page.enable'); await this.send('Runtime.enable'); await this.send('DOM.enable');
  }
  async eval<T>(expression: string): Promise<T> {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
    return r.result.value as T;
  }
}
const cdp = await Cdp.attach(await devtoolsUrl());
await cdp.openPage(pathToFileURL(HTML).href + '?v=' + Date.now());
await Bun.sleep(900);
const doc = await cdp.send('DOM.getDocument');
const q = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#file' });
await cdp.send('DOM.setFileInputFiles', { files: [ADB], nodeId: q.nodeId });
await cdp.eval('document.querySelector("#file").dispatchEvent(new Event("change"))');
await Bun.sleep(4500);

const out = JSON.parse(await cdp.eval<string>(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const api = window.__accelon26;
  await api.closeAbout?.();
  const jumpLine = async (n) => {
    const input = document.getElementById('query');
    input.value = '#' + n;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    for (let i = 0; i < 100; i++) { await sleep(100); if (document.querySelector('#docText .docLine')) break; }
    await sleep(500);
  };
  const first = (sel) => document.querySelector(sel);
  const styleOf = (el) => el ? getComputedStyle(el).color : '';
  const termOf = (cls) => first('#docText .' + cls);

  await api.xrefJump('ys?37p0043a');
  for (let i = 0; i < 100; i++) { await sleep(100); if (document.querySelector('#docText .term')) break; }
  await sleep(300);
  const sk = termOf('term-sk');
  const r1 = {
    page: document.getElementById('pageInfo')?.textContent ?? '',
    terms: document.querySelectorAll('#docText .term').length,
    has872: !!document.getElementById('L241872'),
    sk: !!sk, skText: sk?.textContent ?? '', skTitle: sk?.getAttribute('title') ?? '',
    skColor: styleOf(sk), textColor: styleOf(first('#docText .docLine')), gloss: !!first('#docText .termGloss'),
  };

  await jumpLine(81084);
  const pi = termOf('term-pi');
  const sk2 = termOf('term-sk');
  const r2 = {
    pi: !!pi, piText: pi?.textContent ?? '', piColor: styleOf(pi),
    sk2: !!sk2, sk2Text: sk2?.textContent ?? '', sk2Color: styleOf(sk2),
  };

  await jumpLine(133936);
  const tb = termOf('term-tb');
  const r3 = { tb: !!tb, tbText: tb?.textContent ?? '', tbColor: styleOf(tb), tbTitle: tb?.getAttribute('title') ?? '' };

  const setMode = async (mode) => {
    const sel = document.getElementById('setTermMode');
    sel.value = mode;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(900);
  };
  await setMode('inline');
  const gloss = first('#docText .termGloss');
  const r4 = { gloss: !!gloss, glossText: gloss?.textContent ?? '', skTitleInline: termOf('term-sk')?.getAttribute('title') || '', skHasTip: !!termOf('term-sk')?.classList.contains('has-tip') };
  await setMode('off');
  const r5 = { terms: document.querySelectorAll('#docText .term').length, glosses: document.querySelectorAll('#docText .termGloss').length, tipts: [...document.querySelectorAll('#docText .term')].filter((x) => x.hasAttribute('title')).length, hasTipCls: [...document.querySelectorAll('#docText .term')].filter((x) => x.classList.contains('has-tip')).length, text: (document.getElementById('docText')?.textContent ?? '').includes('宗喀巴') };
  const persisted = localStorage.getItem('accelon26.termMode');
  return JSON.stringify({ r1, r2, r3, r4, r5, persisted }, null, 1);
})()`));
console.log(out);
if (cdp.logs.length) console.log('--- console ---\n' + cdp.logs.slice(-8).join('\n'));

// 重開後要記得「off」
await cdp.send('Page.reload', { ignoreCache: true });
await Bun.sleep(1800);
const after = JSON.parse(await cdp.eval<string>(`JSON.stringify({ stored: localStorage.getItem('accelon26.termMode'), select: document.getElementById('setTermMode')?.value ?? '' })`));
console.log(JSON.stringify({ afterReload: after }, null, 1));
proc.kill();
await Bun.sleep(200);
try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }

const fails: string[] = [];
if (!out.r1.sk) fails.push('37p0043a 沒有 term-sk');
if (!/梵：/.test(out.r1.skTitle)) fails.push('hover title 沒有「梵：」：' + out.r1.skTitle);
if (out.r1.gloss) fails.push('hover 模式不應出現 termGloss');
if (out.r1.skColor !== out.r1.textColor) fails.push('術語不該上色：' + out.r1.skColor + ' vs 正文 ' + out.r1.textColor);
if (!out.r2.pi) fails.push('81084 行沒有 term-pi');
if (!out.r2.sk2) fails.push('81084 行沒有 term-sk');
if (out.r2.piColor !== out.r2.sk2Color) fails.push('術語顏色不一致（應該都不上色）：' + out.r2.piColor + ' vs ' + out.r2.sk2Color);
if (!out.r3.tb) fails.push('133936 行沒有 term-tb');
if (/梵：/.test(out.r3.tbTitle)) fails.push('tb 的 title 標成梵語：' + out.r3.tbTitle);
if (out.r3.tbColor !== out.r2.sk2Color) fails.push('tb 不該另外上色：' + out.r3.tbColor + ' vs ' + out.r2.sk2Color);
if (!out.r4.gloss) fails.push('行內模式沒有 termGloss');
if (out.r4.skTitleInline) fails.push('行內模式不該有 title：' + out.r4.skTitleInline);
if (out.r4.skHasTip) fails.push('行內模式不該有 has-tip');
if (!/（.+）/.test(out.r4.glossText)) fails.push('行內模式沒有「（外語）」：' + out.r4.glossText);
if (out.r5.terms === 0) fails.push('關閉模式仍應保留漢詞外框（虛線）');
if (out.r5.tipts !== 0) fails.push('關閉模式不該有 title：' + out.r5.tipts);
if (out.r5.hasTipCls !== 0) fails.push('關閉模式不該有 has-tip');
if (out.r5.glosses !== 0) fails.push('關閉模式還有 termGloss');
if (!out.r5.text) fails.push('關閉模式看不到漢詞');
if (out.persisted !== 'off') fails.push('設定沒有寫入 localStorage：' + out.persisted);
if (after.stored !== 'off' || after.select !== 'off') fails.push('重開後沒有記得 off：' + JSON.stringify(after));
if (cdp.logs.some((l) => l.startsWith('[exception]'))) fails.push('console 有 exception');
if (fails.length) { console.error('FAIL:\n- ' + fails.join('\n- ')); process.exit(1); }
console.log('ok: <术> 只加虛線；只有 hover 給 title；inline／off 不掛 tooltip');
