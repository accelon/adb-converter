#!/usr/bin/env bun
/**
 * 大正引用短晶片（2026-10-31）：<聯 i="taisho?…">大正</聯> 是小字圓角標籤，
 * 只作用在 .entryLink.xrefLink；條目連結（.entryLink）與 .embedChip 不受影響；
 * 點擊仍走 xref、有 j 就塗 j 的範圍。
 *
 *   cd ts && bun run tools/xref-chip-test.ts [--html ../build/accelon26.html]
 *        [--ys D:/accelon3/ys.adb] [--taisho D:/accelon3/taisho.adb]
 *
 * 用搜尋「原其大本」跳到那一頁（頁碼會隨 ys.adb 重建變動，不寫死）。
 */
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const ROOT = resolve(import.meta.dir, '../..');
const HTML = resolve(opt('html', resolve(ROOT, 'build/accelon26.html')));
const YS = resolve(opt('ys', 'D:/accelon3/ys.adb'));
const TAISHO = resolve(opt('taisho', 'D:/accelon3/taisho.adb'));
const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const browser = BROWSERS.find((p) => existsSync(p));
if (!browser) { console.error('no Chromium browser'); process.exit(2); }
const profile = resolve(ROOT, 'build/.chrome-profile-xc-' + process.pid);
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
async function pick(file: string): Promise<void> {
  const doc = await cdp.send('DOM.getDocument');
  const q = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#file' });
  await cdp.send('DOM.setFileInputFiles', { files: [file], nodeId: q.nodeId });
  await cdp.eval('document.querySelector("#file").dispatchEvent(new Event("change"))');
}

const cdp = await Cdp.attach(await devtoolsUrl());
await cdp.openPage(pathToFileURL(HTML).href + '?v=' + Date.now());
await Bun.sleep(900);
await pick(TAISHO); await Bun.sleep(4000);
await pick(YS); await Bun.sleep(4500);

const out = JSON.parse(await cdp.eval<string>(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const api = window.__accelon26;
  await api.closeAbout?.();
  // 用搜尋跳到「原其大本」那一頁（頁碼不寫死）
  const input = document.getElementById('query');
  input.focus();
  input.value = '原其大本';
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
  let chip = null;
  for (let i = 0; i < 120; i++) {
    await sleep(100);
    chip = document.querySelector('#docText a.entryLink.xrefLink[data-q^="原其大本"]');
    if (chip && (document.getElementById('docText')?.textContent ?? '').includes('原其大本')) break;
  }
  if (!chip) return JSON.stringify({ error: 'no chip near 原其大本' });
  const cs = getComputedStyle(chip);
  const host = chip.closest('.lineText');
  const plain = document.createElement('a');
  plain.className = 'entryLink';
  plain.textContent = '測試';
  const btn = document.createElement('button');
  btn.className = 'embedChip';
  btn.textContent = '嵌入';
  host.appendChild(plain);
  host.appendChild(btn);
  const pcs = getComputedStyle(plain);
  const bcs = getComputedStyle(btn);
  const res = {
    text: chip.textContent,
    cls: chip.className,
    xref: chip.dataset.xref ?? '',
    q: (chip.dataset.q ?? '').slice(0, 20),
    j: chip.dataset.j ?? '',
    lineHasOriginal: (chip.parentElement?.textContent ?? '').includes('原其大本'),
    chip: {
      fontSize: cs.fontSize, borderRadius: cs.borderRadius, border: cs.borderStyle,
      decoration: cs.textDecorationLine, padding: cs.padding, verticalAlign: cs.verticalAlign,
      opacity: cs.opacity, color: cs.color,
    },
    plain: { fontSize: pcs.fontSize, borderRadius: pcs.borderRadius, borderBottom: pcs.borderBottomStyle, decoration: pcs.textDecorationLine },
    embed: { fontSize: bcs.fontSize, borderRadius: bcs.borderRadius },
  };
  plain.remove(); btn.remove();
  chip.click();
  let tab = '';
  for (let i = 0; i < 60; i++) {
    await sleep(100);
    tab = document.querySelector('#textTabs .docTab.active .docTabName')?.textContent ?? '';
    if (tab) break;
  }
  res.tab = tab;
  for (let i = 0; i < 120; i++) {
    await sleep(100);
    if ((document.getElementById('textBody')?.textContent ?? '').length > 50) break;
  }
  await sleep(300);
  res.marks = document.querySelectorAll('#textBody .xrefHit').length;
  res.textLen = (document.getElementById('textBody')?.textContent ?? '').length;
  return JSON.stringify(res, null, 1);
})()`));
console.log(JSON.stringify(out, null, 1));
const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }).catch(() => null);
if (shot?.data) writeFileSync(resolve(ROOT, 'build/xref-chip.png'), Buffer.from(shot.data, 'base64'));
if (cdp.logs.length) console.log('--- console ---\n' + cdp.logs.join('\n'));
proc.kill();
await Bun.sleep(200);
try { rmSync(profile, { recursive: true, force: true }); } catch { /* browser may hold it */ }

const fails: string[] = [];
if (out.error) fails.push(out.error);
if (out.cls !== 'entryLink xrefLink') fails.push('class 不對：' + out.cls);
if (!out.xref.startsWith('taisho?')) fails.push('data-xref 不見了：' + out.xref);
if (!out.j) fails.push('data-j 不見了');
if (!out.lineHasOriginal) fails.push('這一行的文字不是「原其大本…」');
if (out.chip.fontSize !== '11px') fails.push('font-size 不是 11px：' + out.chip.fontSize);
if (out.chip.borderRadius !== '9px') fails.push('border-radius 不是 9px：' + out.chip.borderRadius);
if (out.chip.border !== 'solid') fails.push('border 不是 solid：' + out.chip.border);
if (out.chip.decoration !== 'none') fails.push('不該有底線：' + out.chip.decoration);
if (out.plain.fontSize === '11px' || out.plain.borderRadius === '9px') fails.push('普通 entryLink 被波及：' + JSON.stringify(out.plain));
if (out.embed.fontSize === '11px' && out.embed.borderRadius === '9px') fails.push('embedChip 被波及：' + JSON.stringify(out.embed));
if (!/^T /.test(out.tab)) fails.push('點晶片沒有開 taisho 分頁：' + out.tab);
if (!out.textLen) fails.push('右欄沒有內容');
if (!out.marks) fails.push('有 j 但右欄沒有塗色');
if (cdp.logs.some((l) => l.startsWith('[exception]'))) fails.push('console 有 exception');
if (fails.length) { console.error('FAIL:\n- ' + fails.join('\n- ')); process.exit(1); }
console.log('ok: 大正短晶片樣式與點擊');
