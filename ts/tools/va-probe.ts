import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf('--' + n); return i >= 0 && args[i+1] ? args[i+1] : d; };
const ROOT = resolve(import.meta.dir, '../..');
const HTML = resolve(opt('html', 'D:/accelon3/accelon26.html'));
const ADB = resolve(opt('adb', 'D:/2026/fuyan/out/fuyan.adb'));
const BROWSERS = ['C://Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe','C://Program Files\\Microsoft\\Edge\\Application\\msedge.exe','C://Program Files\\Google\\Chrome\\Application\\chrome.exe'];
const browser = BROWSERS.find((p) => existsSync(p))!;
const profile = resolve(ROOT, 'build/.chrome-profile-va' + process.pid);
const proc = Bun.spawn([browser, '--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', '--remote-allow-origins=*', '--allow-file-access-from-files', `--user-data-dir=${profile}`, 'about:blank'], { stdout: 'pipe', stderr: 'pipe' });
let ws: WebSocket; let id = 0; const pending = new Map<number,(v:any)=>void>(); let sessionId = '';
for (let t = 0; t < 100; t++) { const txt = await Bun.file(resolve(profile,'DevToolsActivePort')).text().catch(()=> ''); const [p, q] = txt.split('\n').map(s=>s.trim()); if (Number(p) > 0 && q) { ws = new WebSocket(`ws://127.0.0.1:${p}${q}`); break; } await Bun.sleep(200); }
await new Promise<void>((r)=>{ ws.onopen = () => r(); });
ws!.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); if (m.id && pending.has(m.id)) { const f = pending.get(m.id)!; pending.delete(m.id); f(m.result ?? m); } };
function send(method: string, params: any = {}, session = true): Promise<any> { const n = ++id; return new Promise((res)=>{ pending.set(n,res); const pl: any = { id:n, method, params }; if (session && sessionId) pl.sessionId = sessionId; ws.send(JSON.stringify(pl)); }); }
const { targetId } = await send('Target.createTarget', { url: 'about:blank' }, false);
const att = await send('Target.attachToTarget', { targetId, flatten: true }, false); sessionId = att.sessionId;
await send('Runtime.enable'); await send('DOM.enable');
await send('Page.navigate', { url: pathToFileURL(HTML).href + '?v=' + Date.now() });
await Bun.sleep(1200);
const doc = await send('DOM.getDocument');
const q = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#file' });
await send('DOM.setFileInputFiles', { files: [ADB], nodeId: q.nodeId });
await send('Runtime.evaluate', { expression: 'document.querySelector("#file").dispatchEvent(new Event("change"))' });
await Bun.sleep(2500);
await send('Runtime.evaluate', { expression: `document.querySelector('#aboutClose')?.click()` });
async function ev<T>(e: string): Promise<T> { const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0,200)); return r.result.value as T; }
const pages = ['38p8','5p132','9p260','6p705','5p298'];
const out = await ev<any>(`(async () => { const o = {}; for (const p of ${JSON.stringify(pages)}) { const r = await window.__accelon26.xrefProbe('fuyan', p); o[p] = r && r.va; } return o; })()`);
console.log(ADB.split(/[\\/]/).pop(), JSON.stringify(out));
proc.kill(); process.exit(0);
