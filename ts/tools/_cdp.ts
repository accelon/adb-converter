#!/usr/bin/env bun
/**
 * probe 工具共用的 CDP 骨架。
 *
 *   import { launch, waitFor, POPUP } from './_cdp';
 *   const cdp = await launch({ html, adb });
 *   ...
 *   await cdp.close();
 *
 * 這裡放三件每個 probe 都會踩的事：
 *
 * ① **timer 要清**。`send()` 用 setTimeout 做超時，Bun 的 timer 是 ref'd；
 *    只設不清，最後一個請求之後進程會整整多活 60 秒才退出（2026-11-12 量到
 *    ke-probe 明明 6.4 秒就做完，實際跑 66.5 秒）。清掉之後 66.5s → 6.5s。
 *
 * ② **profile 要留**。原本每次 launch 都建一個 `build/.chrome-xxx-<pid>`、結束時
 *    `rmSync` 遞迴刪掉 —— 一個 profile 一萬多個檔案，光是刪就要 4.8 秒，
 *    還常常刪不乾淨（build/ 裡躺著幾個 12MB 的殘骸）。現在固定用一個 profile，
 *    下次啟動直接撿現成的（字型快取、IndexedDB 都在），不刪。
 *    並行時才退回臨時 profile，用 lock 檔判斷。
 *
 * ③ **等待要看條件，不要 sleep**。固定 sleep 是為了「等它好」，條件成立就該走。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const ROOT = resolve(import.meta.dir, '../..');

export const POPUP = '--window-size=1400,1000';

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];

/** 有沒有活著的進程（用來判斷 lock／SingletonLock 是不是上次崩掉留下的） */
function alive(pid: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 拿一個可用的 profile 目錄；回傳 `fresh` 表示是臨時建的（結束時要刪） */
function profileFor(tag: string): { dir: string; fresh: boolean; lock?: string } {
  const base = resolve(ROOT, 'build');
  mkdirSync(base, { recursive: true });
  const dir = resolve(base, `.chrome-${tag}`);
  const lock = dir + '.lock';

  // 已有別的 probe 在用同一個 profile：Chromium 會把新 target 丟給舊實例，
  // 兩邊互相干擾。這種情況退回自己的臨時 profile。
  let busy = false;
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, 'utf8').trim());
    if (alive(pid)) busy = true;
    else rmSync(lock, { force: true });          // 上次崩掉留下的
  }
  if (busy) {
    const tmp = dir + '-' + process.pid;
    return { dir: tmp, fresh: true };
  }
  writeFileSync(lock, String(process.pid));
  // 上次沒收乾淨的 Singleton* 會讓 Chromium 以為還有實例在跑；
  // DevToolsActivePort 也會留著舊端口，照它去連就是連到一個已經關掉的瀏覽器
  // （2026-11-12：複用 profile 後連兩次 ws error，就是這個）。
  for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'DevToolsActivePort']) {
    const p = resolve(dir, f);
    if (existsSync(p)) rmSync(p, { force: true });
  }
  return { dir, fresh: false, lock };
}

export class Cdp {
  ws!: WebSocket;
  id = 0;
  pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  sessionId = '';

  static async attach(url: string): Promise<Cdp> {
    const c = new Cdp();
    await new Promise<void>((res, rej) => {
      c.ws = new WebSocket(url);
      c.ws.onopen = () => res();
      c.ws.onerror = () => rej(new Error('ws error'));
      c.ws.onmessage = (ev) => {
        const m = JSON.parse(String(ev.data));
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
      // 一定要 clearTimeout，否則進程會被這個 ref'd timer 拖住整整 60 秒
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) rej(new Error('timeout ' + method));
      }, 60000);
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
    const r = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
    }
    return r.result.value as T;
  }

  /** 等到 `expr` 為真（或超時）。取代固定 sleep。 */
  async waitFor(expr: string, ms = 30000, step = 50): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await this.eval<boolean>(`!!(${expr})`)) return true;
      await Bun.sleep(step);
    }
    return false;
  }
}

export interface LaunchOpts {
  html?: string;
  /** profile 的分類名（不同工具各自一個，互不干擾） */
  tag?: string;
  windowSize?: string;
}

/** 起一個 headless Chromium，連上 CDP，開好頁面。 */
export async function launch(opts: LaunchOpts = {}) {
  const html = resolve(opts.html ?? 'D:/accelon3/accelon26.html');
  const browser = BROWSERS.find((p) => existsSync(p));
  if (!browser) throw new Error('no Chromium browser found');
  if (!existsSync(html)) throw new Error('missing ' + html);

  const { dir: profile, fresh, lock } = profileFor(opts.tag ?? 'probe');
  const proc = Bun.spawn([
    browser, '--headless=new', '--disable-gpu', '--no-first-run',
    '--remote-debugging-port=0', '--remote-allow-origins=*', '--allow-file-access-from-files',
    opts.windowSize ?? POPUP, `--user-data-dir=${profile}`, 'about:blank',
  ], { stdout: 'pipe', stderr: 'pipe' });

  const deadline = Date.now() + 20000;
  let url = '';
  while (Date.now() < deadline) {
    const text = await Bun.file(resolve(profile, 'DevToolsActivePort')).text().catch(() => '');
    const [portLine, pathLine] = text.split('\n').map((s) => s.trim());
    if (Number(portLine) > 0 && pathLine) { url = `ws://127.0.0.1:${portLine}${pathLine}`; break; }
    await Bun.sleep(50);
  }
  if (!url) throw new Error('DevToolsActivePort never appeared');

  // 上一個實例可能還在收尾（profile 目錄被鎖、端口剛關），連不上就重試一下
  let cdp: Cdp | null = null;
  for (let i = 0; i < 5 && !cdp; i++) {
    try { cdp = await Cdp.attach(url); } catch { await Bun.sleep(200 * (i + 1)); }
  }
  if (!cdp) throw new Error('cannot attach to CDP at ' + url);
  await cdp.openPage(pathToFileURL(html).href + '?v=' + Date.now());

  const close = async () => {
    // Browser.close 讓它自己收尾，比 kill 乾淨；等不到就 kill 補刀
    try { await cdp!.send('Browser.close', {}, false); } catch { /* ignore */ }
    const killer = setTimeout(() => { try { proc.kill(); } catch { /* ignore */ } }, 2000);
    await Promise.race([proc.exited.catch(() => {}), Bun.sleep(2500)]);
    clearTimeout(killer);
    try { proc.kill(); } catch { /* ignore */ }
    if (fresh) { try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ } }
    if (lock) { try { unlinkSync(lock); } catch { /* ignore */ } }
    try { cdp!.ws.close(); } catch { /* ignore */ }
  };

  return { cdp, close, profile, proc };
}

/**
 * 把 .adb 交給頁面的 `#file`（模擬使用者選檔），並等到資料庫真的開好。
 *
 * 判據用 `body.loaded`：viewer.openFile 在 `AdbReader.open` 成功後才加這個 class，
 * 之後才建 token index、mapper、docs。比「等 2.5 秒」可靠。
 */
/**
 * 把 .adb 交給頁面的 `#file`（模擬使用者選檔），並等到資料庫**真的**開好。
 *
 * 判據用狀態列：`openFile` 一開頭就 `setStatus('讀取 xxx…', 'busy')`（顯示、不 hidden），
 * 全部做完（token、mapper、anchors、docs、目錄樹都起來了）才 `setStatus(..., 'info')`
 * ——而 `info` 會把狀態列清空並 hidden。
 *
 * 不能用 `body.loaded`：那個 class 在 `AdbReader.open` 之後就加了，之後還有
 * mapper.init／loadAnchors／documents 一大串；而且 profile 是留著的，頁面一開
 * 就已經有 loaded，`waitFor` 會立刻通過，於是 openPage 在庫還沒就緒時就跑
 * （2026-11-12：page-probe 對 38p107 只拿到 3 塊，就是這樣來的）。
 */
export async function loadAdb(cdp: Cdp, adbPath: string): Promise<void> {
  const adb = resolve(adbPath);
  if (!existsSync(adb)) throw new Error('missing ' + adb);
  await cdp.waitFor('window.__accelon26', 20000);
  // 每次都送一次：openFile 會比對「這個檔是不是已經開著」，是就只切換（'existing'），
  // 不會真的重讀 13MB。反過來說，不能因為 body 已經 loaded 就跳過——profile 是
  // 留著的，上一次可能開的是另一本書。
  const doc = await cdp.send('DOM.getDocument');
  const q = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#file' });
  await cdp.send('DOM.setFileInputFiles', { files: [adb], nodeId: q.nodeId });
  await cdp.eval('document.querySelector("#file").dispatchEvent(new Event("change"))');
  // 一次 eval 內等完（逐次往返太慢，而且「done」在 busy 出現前就成立，會誤判）
  const ok = await cdp.eval<boolean>(`
    (async () => {
      const el = document.querySelector('#status');
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const t0 = Date.now();
      let sawBusy = false;
      while (Date.now() - t0 < 90000) {
        if (!el.hidden) sawBusy = true;
        else if (sawBusy) return true;            // 忙完又收起來了＝開好了
        else if (Date.now() - t0 > 2000) return true;  // 兩秒內沒忙過：已經開著（切換）
        await sleep(50);
      }
      return false;
    })()
  `);
  if (!ok) throw new Error('adb 沒有開起來（狀態列一直停在讀取中）');
}
