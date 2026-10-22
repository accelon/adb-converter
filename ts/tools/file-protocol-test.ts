/**
 * Real file:// test: open build/accelon26.html as a local file, hand the page a
 * real .adb through the file input, and drive the UI.
 *
 *   bun run tools/file-protocol-test.ts [--adb <path>] [--html <path>]
 *
 * This is the mode the user actually wants: double click the HTML, pick the
 * database. It must work with NO server, so `fetch` is unavailable and the only
 * way in is the File API (Blob.slice) — which is what gets exercised here.
 */
import { resolve } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const HTML = resolve(opt('html', resolve(import.meta.dir, '../../build/accelon26.html')));
const ADB = resolve(opt('adb', resolve(import.meta.dir, '../../13j.adb')));
const PORT = Number(opt('port', '8951'));

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const browser = BROWSERS.find((p) => existsSync(p));
if (!browser) { console.error('no Chromium browser found'); process.exit(2); }
if (!existsSync(HTML)) { console.error('missing ' + HTML + ' (run tools/build-viewer.ts)'); process.exit(2); }
if (!existsSync(ADB)) { console.error('missing ' + ADB); process.exit(2); }

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + name + (detail ? '  ' + detail : '')); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
};

// Chrome refuses to read a local file from a page it considers untrusted unless
// told to; this flag is what a normal double-click does NOT need (a user gesture
// on the picker grants access), but an automated driver does.
const profile = resolve(import.meta.dir, '../../build/.chrome-profile-file');
const proc = Bun.spawn([browser, '--headless=new', '--disable-gpu', '--no-first-run',
  '--remote-debugging-port=0', '--remote-allow-origins=*',
  '--allow-file-access-from-files',
  `--user-data-dir=${profile}`, 'about:blank'], { stdout: 'pipe', stderr: 'pipe' });

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
      c.ws.onerror = () => rej(new Error('ws error'));
      c.ws.onmessage = (ev) => {
        const m = JSON.parse(String(ev.data));
        if (m.id && c.pending.has(m.id)) {
          const p = c.pending.get(m.id)!; c.pending.delete(m.id);
          m.error ? p.reject(new Error((p as any).method + ': ' + m.error.message)) : p.resolve(m.result);
          return;
        }
        if (m.method === 'Runtime.consoleAPICalled') c.logs.push(m.params.type + ': ' + (m.params.args ?? []).map((a: any) => a.value ?? a.description).join(' '));
        if (m.method === 'Runtime.exceptionThrown') c.logs.push('exception: ' + (m.params.exceptionDetails?.exception?.description ?? '?'));
      };
    });
    return c;
  }
  async send(method: string, params: Record<string, unknown> = {}, session = true): Promise<any> {
    const id = ++this.id;
    const payload: Record<string, unknown> = { id, method, params };
    if (session && this.sessionId) payload.sessionId = this.sessionId;
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej, method } as any);
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => { if (this.pending.delete(id)) rej(new Error('timeout ' + method)); }, 60000);
    });
  }
  async openPage(url: string) {
    const { targetId } = await this.send('Target.createTarget', { url }, false);
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true }, false);
    this.sessionId = sessionId;
    await this.send('Runtime.enable');
    await this.send('Page.enable');
    await this.send('DOM.enable');
    // 這個頁面要跑十幾分鐘、裡面有很多 setTimeout 等待；headless 的背景頁會被
    // Chrome 節流（5 分鐘後 timer 一分鐘才跑一次），CDP 的 evaluate 就會 60 秒 timeout。
    // 把頁面帶到前景＋模擬 focus，讓計時器正常跑（作者 2026-10-22）。
    await this.send('Page.bringToFront').catch(() => {});
    await this.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  }
  async eval<T>(expression: string): Promise<T> {
    let r: any;
    try {
      r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    } catch (e) {
      // "Promise was collected" 是 CDP 的偶發狀況（頁面在算大東西時 GC 掉 promise），
      // 不是測試真的失敗 → 重試（最多 3 次、每次多等一點；作者 2026-10）
      const msg = (e as Error).message;
      if (/Promise was collected/.test(msg)) {
        for (let attempt = 1; attempt <= 3; attempt++) {
          await Bun.sleep(400 * attempt);
          try {
            r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
            break;
          } catch (e2) {
            if (attempt === 3) {
              console.log(`    [eval failed after 3 retries: ${(e2 as Error).message}]`);
              throw e2;
            }
          }
        }
      } else {
        console.log(`    [eval failed: ${msg}｜typeof=${typeof expression}] ${(new Error().stack ?? '').split('\n').slice(1, 5).map((s) => s.trim()).join(' | ')}`);
        throw e;
      }
    }
    if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
    return r.result.value as T;
  }
}

try {
  const cdp = await Cdp.attach(await devtoolsUrl());
  const fileUrl = pathToFileURL(HTML).href + '?v=' + Date.now();   // never a cached bundle
  await cdp.openPage(fileUrl);
  await Bun.sleep(800);

  const origin = await cdp.eval<string>('location.protocol + "//" + (location.host || "(none)")');
  ok('page really runs on file://', origin.startsWith('file://'), origin);
  ok('viewer bundle loaded on file://', await cdp.eval<boolean>('!!window.__accelon26'));

  // 後端分界（作者 2026-10）：網頁版沒有宿主，查詢一律由 TS 後端算（goQueries 永遠 0）
  const backend = await cdp.eval<{ backend: string; goQueries: number }>(
    'JSON.stringify({ backend: window.__accelon26.state().backend, goQueries: window.__accelon26.state().goQueries ?? -1 })');
  const be = JSON.parse(backend) as { backend: string; goQueries: number };
  ok('網頁版走 TS 後端（state().backend=ts、goQueries=0）',
    be.backend === 'ts' && be.goQueries === 0, JSON.stringify(be));
  // 網頁版的圖示：appicon.png 以 data URI 內嵌（單檔 HTML 不能依賴旁邊的檔案）
  const icon = await cdp.eval<string>(`(() => {
    const link = document.querySelector('link[rel="icon"]');
    return JSON.stringify({ href: (link?.getAttribute('href') ?? '').slice(0, 30), len: link?.getAttribute('href')?.length ?? 0, title: document.title });
  })()`);
  const iconInfo = JSON.parse(icon) as { href: string; len: number; title: string };
  ok('網頁版有內嵌的 PNG 圖示（favicon data URI）',
    iconInfo.href.startsWith('data:image/png;base64,') && iconInfo.len > 1000, `${iconInfo.href}… ${iconInfo.len} 字元`);
  ok('頁面標題是 accelon26', iconInfo.title === 'accelon26', iconInfo.title);
  // the point of the exercise: fetch must NOT be needed
  const fetchWorks = await cdp.eval<string>(`fetch('x').then(() => 'ok').catch(e => 'blocked: ' + e.message)`);
  ok('fetch is unavailable on file:// (as expected, so the File API is the only path)',
    fetchWorks.startsWith('blocked'), fetchWorks);

  // ---- 「關於」是首頁（作者 2026-10-18）：啟動就顯示，操作導覽的入口在裡面 ----
  const startupAbout = JSON.parse(await cdp.eval<string>(`(() => {
    const box = document.getElementById('aboutBox');
    const chk = document.getElementById('aboutStartup');
    const tour = document.getElementById('aboutTour');
    return JSON.stringify({
      open: !box.hidden,
      startup: window.__accelon26.aboutState().startup,
      checked: chk ? chk.checked : null,
      tourBtn: !!tour && tour.getBoundingClientRect().width > 0,
      headerTour: !!document.getElementById('tourBtn'),
      bg: getComputedStyle(box).backgroundColor,
    });
  })()`)) as { open: boolean; startup: boolean; checked: boolean; tourBtn: boolean; headerTour: boolean; bg: string };
  ok('啟動時顯示「關於」，裡面有「▶ 操作導覽」', startupAbout.open && startupAbout.tourBtn,
    `open=${startupAbout.open}、導覽按鈕=${startupAbout.tourBtn}、底色 ${startupAbout.bg}`);
  ok('「啟動時顯示本頁面」預設勾選（可以取消）；頂欄已沒有 🎬',
    startupAbout.checked === true && startupAbout.startup === true && startupAbout.headerTour === false,
    `勾選=${startupAbout.checked}、存檔=${startupAbout.startup}、頂欄🎬=${startupAbout.headerTour}`);
  // 關掉它：後面幾組斷言都假設沒有彈窗（尤其是 elementFromPoint 那組）
  await cdp.eval('window.__accelon26.closeAbout()');
  await Bun.sleep(150);
  ok('關掉之後不擋後面的介面', await cdp.eval<boolean>("document.getElementById('aboutBox').hidden === true"));

  // 沒有資料庫時：＋ 右邊有一行閃爍的提示（作者 2026-10）
  // headless Chrome 預設回報 prefers-reduced-motion: reduce（我們的 CSS 會關掉動畫），
  // 所以先模擬「一般使用者」量閃爍，再切回 reduce 確認提示仍然看得見。
  const hintProbe = `(() => {
    const el = document.querySelector('#dbHint');
    const cs = el ? getComputedStyle(el) : null;
    const add = document.querySelector('#dbPickBtn').getBoundingClientRect();
    const box = el?.getBoundingClientRect();
    const allBtn = document.querySelector('#searchAllBtn');
    return JSON.stringify({
      text: (el?.textContent ?? '').trim(),
      display: cs?.display ?? 'none',
      anim: cs?.animationName ?? '',
      rightOfAdd: !!box && box.width > 0 && box.left >= add.right - 1,
      allHidden: !!allBtn && getComputedStyle(allBtn).display === 'none',
    });
  })()`;
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  const hintInfo = JSON.parse(await cdp.eval<string>(hintProbe)) as { text: string; display: string; anim: string; rightOfAdd: boolean; allHidden: boolean };
  ok('沒有資料庫時：📁 右邊閃爍「← 開啟資料庫」，且不顯示放大鏡',
    hintInfo.display !== 'none' && hintInfo.anim.includes('dbHintFlash') && hintInfo.rightOfAdd
    && hintInfo.text === '← 開啟資料庫'
    && hintInfo.allHidden === true,
    `${hintInfo.text}｜display=${hintInfo.display} anim=${hintInfo.anim} 在📁右邊=${hintInfo.rightOfAdd}、放大鏡隱藏=${hintInfo.allHidden}`);
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  const hintQuiet = JSON.parse(await cdp.eval<string>(hintProbe)) as { text: string; display: string; anim: string };
  ok('系統設定「減少動態」時提示不閃爍但仍在',
    hintQuiet.display !== 'none' && hintQuiet.anim === 'none' && hintQuiet.text.length > 0,
    `${hintQuiet.text}｜display=${hintQuiet.display} anim=${hintQuiet.anim}`);
  await cdp.send('Emulation.setEmulatedMedia', { features: [] });

  // put a real .adb into the file input, exactly like a user picking it
  await cdp.send('DOM.setFileInputFiles', { files: [ADB], nodeId: await (async () => {
    const doc = await cdp.send('DOM.getDocument');
    const q = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#file' });
    return q.nodeId;
  })() });
  await Bun.sleep(500);
  // the input's change event is what the viewer listens to
  await cdp.eval('document.querySelector("#file").dispatchEvent(new Event("change"))');

  const opened = await cdp.eval<{ db: string; tokens: number; docs: number; status: string; listed: number; openMs: number }>(`
    (async () => {
      // wait for the FULL first paint (metadata, token list, documents), not
      // just for the database to be recognised
      for (let i = 0; i < 240; i++) {
        const s = window.__accelon26.state();
        const rows = document.querySelectorAll('#tokenRows .tokenRow').length;
        if (s.db && rows > 0) {
          const meta = document.querySelector('#meta').textContent;
          const m = /開啟 ([\\d,]+) ms/.exec(meta);
          return { ...s, status: window.__accelon26.status(), openMs: m ? Number(m[1].replace(/,/g, '')) : -1 };
        }
        await new Promise(r => setTimeout(r, 250));
      }
      return { ...window.__accelon26.state(), status: window.__accelon26.status(), listed: 0, openMs: -1 };
    })()
  `);
  ok('the picked file opened over Blob.slice', !!opened.db, JSON.stringify(opened));
  ok('token index built from the local file', opened.tokens > 1000, `${opened.tokens} tokens, container open ${opened.openMs} ms`);
  ok('開啟資料庫後閃爍提示消失',
    await cdp.eval<boolean>(`getComputedStyle(document.querySelector('#dbHint')).display === 'none'`),
    await cdp.eval<string>(`getComputedStyle(document.querySelector('#dbHint')).display`));

  // 開檔成本細分：讀取次數／位元組／各階段毫秒（file:// 只能靠 Blob.slice）
  const breakdown = await cdp.eval<any>(`
    (async () => {
      for (let i = 0; i < 60; i++) {
        const b = window.__accelon26.openBreakdown();
        if (b) return b;
        await new Promise(r => setTimeout(r, 250));
      }
      return null;
    })()
  `);
  if (breakdown) {
    console.log('      開檔細分：' + JSON.stringify(breakdown));
    // the directory tree is built in the BACKGROUND, so it is reported apart
    // from the open total
    const sync = breakdown.parseMs + breakdown.tokenMs + breakdown.layoutMs + breakdown.docsMs;
    const pct = (v: number) => (sync > 0 ? Math.round((v / sync) * 100) + '%' : '-');
    console.log(`      讀取 ${breakdown.reads} 次 / ${(breakdown.bytes / 1048576).toFixed(2)} MiB`
      + ` / I/O ${breakdown.ioMs.toFixed(0)} ms（快取命中 ${breakdown.cached}、最大單次 ${(breakdown.maxRead / 1024).toFixed(0)} KiB）`);
    console.log(`      開檔合計 ${breakdown.totalMs.toFixed(0)} ms ＝ 解析 ${breakdown.parseMs.toFixed(0)} (${pct(breakdown.parseMs)})`
      + ` + token ${breakdown.tokenMs.toFixed(0)} (${pct(breakdown.tokenMs)})`
      + ` + VA 表 ${breakdown.layoutMs.toFixed(0)} (${pct(breakdown.layoutMs)})`
      + ` + 文件 ${breakdown.docsMs.toFixed(0)} (${pct(breakdown.docsMs)})`
      + `；背景目錄樹 ${breakdown.treeMs.toFixed(0)} ms`);
  }
  ok('開檔有細分計時', !!breakdown && breakdown.totalMs > 0, breakdown ? `total ${breakdown.totalMs.toFixed(0)} ms` : 'no breakdown');

  const dom = await cdp.eval<Record<string, number | string>>(`(() => ({
    tokens: window.__accelon26.state().tokens,
    db: window.__accelon26.state().db,
    meta: (document.querySelector('#meta')?.textContent ?? '').trim().slice(0, 80),
  }))()`);
  ok('UI rendered from the local file', Number(dom.tokens) > 0 && String(dom.db).length > 0 && String(dom.meta).length > 3, JSON.stringify(dom).slice(0, 160));

  // 本文區還空著時，顯示這個資料庫自己在 adb 裡的 logo（resources 的 <dbname>_logo.png）：
  // 有這個資源就必須真的畫出來，沒有就要保持隱藏（13j／fgdict 都沒有）。
  const logo = await cdp.eval<{ name: string; shown: boolean; w: number }>(`
    (async () => {
      for (let i = 0; i < 30; i++) {
        const img = document.getElementById('docLogoImg');
        if (img && img.naturalWidth > 0) break;
        await new Promise(r => setTimeout(r, 200));
      }
      const st = window.__accelon26.state();
      const img = document.getElementById('docLogoImg');
      return { name: st.logo.name, shown: !document.getElementById('docLogo').hidden, w: img ? img.naturalWidth : 0 };
    })()
  `);
  ok('本文區空白時顯示資料庫自己的 logo（resources 裡的 <dbname>_logo.png）',
    logo.name ? (logo.shown && logo.w > 0) : !logo.shown,
    logo.name ? logo.name + ' ' + logo.w + 'px 顯示中' : '此庫沒有 logo 資源，保持隱藏');

  // 開檔後：預設不是進階模式 —— 沒有 posting list 面板、沒有 token 分頁
  const initial = await cdp.eval<{ postingGone: boolean; adv: boolean; leftTab: string; rightTab: string; tokenHidden: boolean }>(`
    (() => {
      const st = window.__accelon26.state();
      const tokenBtn = document.querySelector('#colLeft .tabBtn[data-tab="token"]');
      return {
        postingGone: !document.querySelector('#postingPane') && !document.querySelector('#posting'),
        adv: st.advanced,
        leftTab: st.leftTab,
        rightTab: st.rightTab,
        tokenHidden: !tokenBtn || getComputedStyle(tokenBtn).display === 'none',
        // the reader's default tab is whatever this database declares, not 'dir':
        // a dictionary has no s="*" (fgdict opens on 名詞)
        firstTab: [...document.querySelectorAll('#colLeft .tabBtn')]
          .find((b) => getComputedStyle(b).display !== 'none' && !b.classList.contains('advOnly'))?.dataset.tab ?? '',
      };
    })()
  `);
  ok('預設模式沒有 posting list 面板', initial.postingGone, 'no #postingPane / #posting');
  ok('預設模式：左欄只有搜尋、右欄第一分頁是目錄',
    initial.adv === false && !!initial.firstTab && initial.leftTab === initial.firstTab && initial.tokenHidden,
    JSON.stringify(initial));

  // 目錄樹只存在於宣告了 s="*" 的庫（fgdict 沒有，它落在名詞）：在 fgdict 這棵樹是隱藏
  // 面板，所以「樹的形狀」斷言（幾本書、逐層展開）只在看得到它的庫上跑。
  const dirTabShown = await cdp.eval<boolean>("getComputedStyle(document.querySelector('#colLeft .tabBtn[data-tab=\"dir\"]')).display !== 'none'");

  const marked = await cdp.eval<{ mark: string; line: string | null; head: string; pinned: any; gone: boolean }>(`
    (async () => {
      const waitMark = async () => {
        for (let i = 0; i < 50; i++) {
          if (document.querySelector('#docText mark.docHit')) return;
          await new Promise(r => setTimeout(r, 200));
        }
      };
      // token browsing is an advanced-mode feature
      window.__accelon26.setAdvanced(true);
      window.__accelon26.showTab('token', 'left');
      await new Promise(r => setTimeout(r, 300));
      document.querySelectorAll('#tokenRows .tokenRow')[0].click();
      await waitMark();
      const st = window.__accelon26.state();
      const hl = document.querySelector('#docText .hitLine');
      return {
        mark: document.querySelector('#docText mark.docHit')?.textContent ?? '(none)',
        line: hl ? hl.id : null,
        head: document.querySelector('#docText .docHead')?.textContent.replace(/\\s+/g,' ').trim().slice(0, 56) ?? '',
        pinned: st.pinned,
        reveal: st.lastReveal,
        gone: !document.querySelector('#searchResults'),
      };
    })()
  `);
  ok('點 token 直接聯動文件並塗紅該 token', marked.mark !== '(none)' && !!marked.line,
    `mark=${JSON.stringify(marked.mark)} 行 ${marked.line} ｜ ${marked.head}`);
  ok('塗紅的就是被點的 token', !!marked.pinned && marked.pinned.text === marked.mark,
    JSON.stringify(marked.pinned) + ' ｜ linkLog=' + JSON.stringify((await cdp.eval('window.__accelon26.state().linkLog'))));
  ok('「搜尋結果」區已移除', marked.gone, 'no #searchResults in the DOM');

  // 只有一個 mark（只塗紅該 token）
  const marks = await cdp.eval<number>(`
    (async () => {
      // painting is async and can be repeated when another render lands, so wait
      // for the count to settle before asserting
      let prev = -1;
      for (let i = 0; i < 40; i++) {
        const n = document.querySelectorAll('#docText mark.docHit').length;
        if (n > 0 && n === prev) return n;
        prev = n;
        await new Promise(r => setTimeout(r, 200));
      }
      return document.querySelectorAll('#docText mark.docHit').length;
    })()
  `);
  ok('文件中只有一個塗紅標記', marks === 1, marks + ' mark(s)');

  // posting list 面板已移除：點 token 直接跳到第一筆命中
  const noPosting = await cdp.eval<{ gone: boolean; tabToken: boolean; mark: string }>(`
    (async () => {
      const rows = document.querySelectorAll('#tokenRows .tokenRow');
      rows[3]?.click();
      // a page read can take a moment on a compressed dictionary: poll for the mark
      for (let i = 0; i < 40; i++) {
        if (document.querySelector('#docText mark.docHit')) break;
        await new Promise(r => setTimeout(r, 250));
      }
      return {
        gone: !document.querySelector('#posting') && !document.querySelector('#postingPane'),
        tabToken: !!document.querySelector('#colLeft .tabBtn[data-tab="token"]'),
        mark: document.querySelector('#docText mark.docHit')?.textContent ?? '(none)',
      };
    })()
  `);
  ok('posting list 面板已移除（點 token 直接跳本文）',
    noPosting.gone && noPosting.tabToken && noPosting.mark !== '(none)',
    JSON.stringify(noPosting));

  // 左右欄分頁歸屬：左 = 搜尋／token，右 = 目錄／META／容量／文件／圖片
  const swapped = await cdp.eval<{ leftHasTokens: boolean; rightHasTabs: boolean; rightFirst: string }>(`
    ({
      leftHasTokens: !!document.querySelector('#colLeft #tokenRows'),
      dirOnLeft: !!document.querySelector('#colLeft #dirTree'),
      rightHasTabs: !!document.querySelector('#colRight .tabs') && !!document.querySelector('#colRight #meta'),
      rightFirst: document.querySelector('#colRight .tabBtn')?.textContent.trim() ?? '',
    })
  `);
  ok('目錄樹在左欄、檔案資訊在右欄',
    swapped.leftHasTokens && swapped.rightHasTabs && swapped.dirOnLeft && swapped.rightFirst === '摘要',
    JSON.stringify(swapped));

  // 進階模式：關閉後收起進階分頁並回到預設分頁
  const advMode = await cdp.eval<{ offTab: string; offRight: string; offHidden: boolean; onHidden: boolean; firstTab: string; headOff: string; headOn: string }>(`
    (async () => {
      window.__accelon26.setAdvanced(false);
      await new Promise(r => setTimeout(r, 300));
      const tokenBtn = document.querySelector('#colLeft .tabBtn[data-tab="token"]');
      const metaBtn = document.querySelector('#colRight .tabBtn[data-tab="meta"]');
      const offHidden = getComputedStyle(tokenBtn).display === 'none' && getComputedStyle(metaBtn).display === 'none';
      // docHead 的統計列（.dim）也只有進階模式才顯示
      const headDim = () => {
        const el = document.querySelector('#docText .docHead .dim') ?? document.querySelector('#textBody .docHead .dim');
        return el ? getComputedStyle(el).display : '(no docHead)';
      };
      const headOff = headDim();
      window.__accelon26.setAdvanced(true);
      await new Promise(r => setTimeout(r, 300));
      const onHidden = getComputedStyle(tokenBtn).display !== 'none' && getComputedStyle(metaBtn).display !== 'none';
      const headOn = headDim();
      window.__accelon26.setAdvanced(false);
      await new Promise(r => setTimeout(r, 200));
      // the state AFTER the mode change, and the tab this database actually offers
      const st = window.__accelon26.state();
      const firstTab = [...document.querySelectorAll('#colLeft .tabBtn')]
        .find((b) => getComputedStyle(b).display !== 'none' && !b.classList.contains('advOnly'))?.dataset.tab ?? '';
      return { offTab: st.leftTab, offRight: st.rightTab, offHidden, onHidden, firstTab, headOff, headOn };
    })()
  `);
  ok('進階模式可切換，關閉時收起進階分頁並回到預設分頁',
    advMode.offHidden && advMode.onHidden && !!advMode.firstTab && advMode.offTab === advMode.firstTab,
    JSON.stringify(advMode));
  // 詞典型 adb（fgdict）沒有 docHead；一般文本（13j／yinshun）才有，而且 .dim 只在進階模式顯示
  const isDictDb = await cdp.eval<boolean>('window.__accelon26.state().dict === true');
  ok('docHead 的統計列（.dim）只在進階模式顯示（詞典型 adb 根本沒有 docHead）',
    isDictDb ? advMode.headOff === '(no docHead)' && advMode.headOn === '(no docHead)'
      : advMode.headOff === 'none' && advMode.headOn !== 'none',
    isDictDb
      ? `詞典型 adb：docHead 不存在（一般 ${advMode.headOff}／進階 ${advMode.headOn}）`
      : `一般模式 display=${advMode.headOff}；進階模式 display=${advMode.headOn}`);

  // header 三顆開關都是圖示，沒有中文 label（中文只放在 tooltip）
  const icons = await cdp.eval<{ labels: string[]; tips: string[]; adv: string }>(`
    (() => {
      const ids = ['toggleLeft', 'toggleRight', 'settingsBtn'];
      const els = ids.map((id) => document.getElementById(id));
      return {
        labels: els.map((e) => e.textContent.trim()),
        tips: els.map((e) => e.title),
        adv: document.getElementById('settingsBtn').textContent.trim(),
      };
    })()
  `);
  ok('欄位／設置開關只用圖示（無中文 label）',
    icons.labels.every((t) => t.length > 0 && !/[\u4e00-\u9fff]/.test(t)) && icons.tips.every((t) => /[\u4e00-\u9fff]/.test(t)),
    `圖示 ${JSON.stringify(icons.labels)}；tooltip ${JSON.stringify(icons.tips.map((t) => t.slice(0, 12)))}`);
  // 載入後：檔案輸入隱藏，改由「＋」開別的庫；已開的庫各一個 chip，只有 active 帶 ✕
  const headerUi = await cdp.eval<{ fileHidden: boolean; addVisible: boolean; addIsButton: boolean; chips: number; activeChips: number; names: string[]; activeName: string; closes: number }>(`
    (() => {
      const f = document.querySelector('#file');
      const pick = document.querySelector('#dbPickBtn');
      const menu = document.querySelector('#dbPickMenu');
      const add = menu?.querySelector('.dbPickItem[data-add]');
      const chips = [...document.querySelectorAll('#dbTabs .dbChip')];
      const active = chips.filter((c) => c.classList.contains('active'));
      return {
        fileHidden: getComputedStyle(f).display === 'none',
        addVisible: !!add && getComputedStyle(add).display !== 'none',
        addIsButton: add?.tagName === 'TR',
        addFirst: menu?.querySelector('.dbPickTable tbody')?.firstElementChild === add,
        pickVisible: !!pick && getComputedStyle(pick).display !== 'none',
        chips: chips.length,
        activeChips: active.length,
        names: chips.map((c) => c.textContent.replace('✕', '').trim()),
        activeName: active[0]?.textContent.replace('✕', '').trim() ?? '',
        closes: document.querySelectorAll('#dbTabs .dbChipClose').length,
      };
    })()
  `);
  ok('載入後檔案輸入隱藏、📁 下拉第一項是「加入 adb」、庫名在 chip 上（active 才有 ✕）',
    headerUi.fileHidden && headerUi.pickVisible && headerUi.addVisible && headerUi.addIsButton && headerUi.addFirst
    && headerUi.chips === 1 && headerUi.activeChips === 1 && headerUi.closes === 1 && !!headerUi.activeName,
    JSON.stringify(headerUi));

  // 最右上一定有一個下拉：這次工作階段選過的 adb（只讀 header）。狀態列只顯示錯誤／忙碌。
  const pickUi = await cdp.eval<{
    pickLast: boolean; options: string[]; selected: string; catalog: { name: string; file: string; open: boolean }[];
    statusHidden: boolean; statusApi: string; statusDom: string;
    hidden: boolean; color: string; hasSelect: boolean; openedHidden: boolean; closedHidden: boolean; escHidden: boolean;
  }>(`
    (async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const h = document.getElementById('header');
      const wrap = h.querySelector('.dbPickWrap');
      const btn = document.getElementById('dbPickBtn');
      const menu = document.getElementById('dbPickMenu');
      const st = window.__accelon26.state();
      const hidden = menu.hidden;
      const color = getComputedStyle(btn).color;
      const hasSelect = !!document.getElementById('dbPick');
      // 版面順序（作者 2026-10）：📁 在原本 ＋ 的位置（左欄切換鈕之後、chips 之前），
      // 齒輪移到最右邊
      const order = [...h.children].map((el) => el.id || el.className);
      const pickIdx = order.indexOf('dbPickWrap');
      const tabsIdx = order.indexOf('dbTabs');
      btn.click();
      await sleep(250);
      const openedHidden = menu.hidden;
      const items = [...menu.querySelectorAll('.dbPickItem')];
      const addItem = items.filter((i) => i.hasAttribute('data-add'));
      const options = items.filter((i) => !i.hasAttribute('data-add'))
        .map((i) => i.querySelector('.dbPickName')?.textContent ?? '');
      const selected = menu.querySelector('.dbPickItem.active .dbPickName')?.textContent ?? '';
      // 要在同一輪裡比較：後面再按一下／Esc 會重畫選單，節點就換人了
      const addFirst = menu.querySelector('.dbPickTable tbody')?.firstElementChild === addItem[0];
      btn.click();
      await sleep(200);
      const closedHidden = menu.hidden;
      btn.click();
      await sleep(200);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(200);
      const escHidden = menu.hidden;
      // 齒輪要貼齊 header 右緣（作者 2026-10）：狀態列隱藏時也一樣
      const gear = document.getElementById('settingsBtn').getBoundingClientRect();
      const hb = h.getBoundingClientRect();
      const padRight = parseFloat(getComputedStyle(h).paddingRight) || 0;
      const gearRightGap = Math.round(hb.right - padRight - gear.right);
      const others = [...h.children].filter((el) => el.id !== 'settingsBtn' && getComputedStyle(el).display !== 'none');
      const rightmost = others.every((el) => el.getBoundingClientRect().right <= gear.left + 1);
      return {
        pickLast: h.lastElementChild === wrap,
        gearRightGap, rightmost,
        order, pickIdx, tabsIdx,
        addItems: addItem.length, addFirst,
        settingsLast: document.getElementById('settingsBtn') === h.lastElementChild,
        options, selected,
        catalog: st.catalog,
        statusHidden: document.getElementById('status').hidden,
        statusApi: window.__accelon26.status().slice(0, 40),
        statusDom: document.getElementById('status').textContent.slice(0, 40),
        hidden, color, hasSelect, openedHidden, closedHidden, escHidden,
      };
    })()
  `);
  ok('📁 在原本 ＋ 的位置（切欄鈕之後、chips 之前），齒輪貼齊最右邊',
    pickUi.pickIdx >= 0 && pickUi.pickIdx < pickUi.tabsIdx && pickUi.settingsLast === true
    && pickUi.rightmost === true && Math.abs(pickUi.gearRightGap) <= 1,
    `header 元素順序 ${JSON.stringify(pickUi.order)}｜齒輪距內容右緣 ${pickUi.gearRightGap}px、右邊沒有別的元素=${pickUi.rightmost}`);
  ok('黃色資料夾按鈕：按一下才展開 adb 清單',
    pickUi.hidden === true && pickUi.openedHidden === false
    && pickUi.hasSelect === false && pickUi.color === 'rgb(255, 212, 121)',
    `預設 hidden=${pickUi.hidden}、按下後 hidden=${pickUi.openedHidden}、顏色 ${pickUi.color}、還有 <select>=${pickUi.hasSelect}`);
  ok('adb 清單第一項是「加入 adb」，再列出目前的庫並標成 active；再按一下／Esc 收起',
    pickUi.catalog.length === 1 && pickUi.catalog[0].open
    && pickUi.addItems === 1 && pickUi.addFirst === true
    && pickUi.options.length === 1 && pickUi.selected === pickUi.catalog[0].name
    && pickUi.closedHidden === true && pickUi.escHidden === true,
    `清單 ${JSON.stringify(pickUi.options)}、加入項=${pickUi.addItems}（第一項=${pickUi.addFirst}）`
    + `、active「${pickUi.selected}」、catalog ${JSON.stringify(pickUi.catalog)}`);
  ok('狀態列只顯示錯誤／忙碌（載入後的「N 詞、M 文件」不再顯示）',
    pickUi.statusHidden && pickUi.statusDom === '' && pickUi.statusApi.length > 0,
    `#status hidden=${pickUi.statusHidden}、DOM「${pickUi.statusDom}」、API 仍記得「${pickUi.statusApi}」`);

  // 全文搜尋：輸入 → 摘要 → 點摘要才聯動本文（輸入本身不動本文）
  const search = await cdp.eval<{
    meta: string; metaOk: boolean; snippets: number; marked: string; clicked: boolean;
    line: string | null; inputStable: boolean; tabs: string;
  }>(`
    (async () => {
      const q = document.querySelector('#query');
      // pick a phrase that exists in this database
      const db = window.__accelon26.state().db;
      const word = db === '13j' ? '象曰' : '印順';
      q.value = word;
      q.dispatchEvent(new Event('input'));
      // The first search decodes the posting list of every token, so poll for the
      // result instead of assuming a fixed delay (yinshun's lists are large).
      // Wait for the summaries themselves — the meta line appears before them.
      for (let i = 0; i < 40; i++) {
        if (document.querySelectorAll('#searchList .snippet').length > 0) break;
        await new Promise(r => setTimeout(r, 200));
      }
      const metaOk = /命中/.test(document.querySelector('#searchMeta').textContent);
      const metaText = document.querySelector('#searchMeta').textContent.slice(0, 90);
      await new Promise(r => setTimeout(r, 250));
      const snippets = document.querySelectorAll('#searchList .snippet').length;
      const mark = document.querySelector('#searchList .snippet mark');
      const first = document.querySelector('#searchList .snippet');
      // Both the DOM mark and the pinned VA must be settled before the value is
      // trusted: a page render swaps the rows first and paints the mark after.
      const settled = async () => {
        let line = null, va = -1;
        for (let i = 0; i < 30; i++) {
          await new Promise(r => setTimeout(r, 200));
          const st = window.__accelon26.state();
          const now = document.querySelector('#docText .docLine.hitLine')?.id ?? null;
          const nowVa = st.pinned ? st.pinned.va : -1;
          if (now && nowVa > 0 && now === line && nowVa === va) break;
          line = now; va = nowVa;
        }
        return { line, va };
      };
      let line = null;
      let vaAfterClick = -1;
      if (first) {
        window.__accelon26.showTab('sum', 'right');   // 摘要在右欄
        first.click();                              // 點摘要才會聯動本文
        const s1 = await settled();
        line = s1.line; vaAfterClick = s1.va;
      }
      // 再改一次輸入：本文必須留在原地
      q.value = word;
      q.dispatchEvent(new Event('input'));
      await new Promise(r => setTimeout(r, 900));
      const vaAfterInput = (await settled()).va;
      const tabs = [...document.querySelectorAll('#colLeft .tabBtn')].map(b => b.getAttribute('data-tab')).join(',');
      return {
        meta: metaText, metaOk,
        snippets,
        marked: mark ? mark.textContent : '(none)',
        clicked: !!first,
        line,
        inputStable: vaAfterClick > 0 && vaAfterInput === vaAfterClick,

        tabs,
      };
    })()
  `);
  ok('左欄第一分頁是「目錄」（全文搜尋）', search.tabs.split(',')[0] === 'dir', 'tabs = ' + search.tabs);
  ok('輸入詞後出現搜尋摘要且標紅', search.snippets > 0 && search.snippets <= 30 && search.marked !== '(none)',
    `${search.snippets} 份摘要（輸入後只顯示最前 30 筆），mark=${JSON.stringify(search.marked)}｜${search.meta}`);
  ok('輸入即時重搜（無需按鈕）', search.metaOk, search.meta);
  ok('點摘要會聯動本文並標出該行', search.clicked && !!search.line, `行 ${search.line}`);
  ok('輸入只更新摘要、本文不隨輸入移動', search.inputStable, `點摘要後釘在 ${search.line}`);

  // ---- 摘要卡片也要渲染標籤（作者 2026-10）：不硬換行、標題只上色不放大 ----
  const snip = await cdp.eval<any>(`
    (async () => {
      const wait = async (fn, n = 90) => { for (let i = 0; i < n; i++) { if (fn()) return true; await new Promise(r => setTimeout(r, 200)); } return false; };
      const st = () => window.__accelon26.state();
      const q = document.querySelector('#query');
      const prev = q.value;
      q.value = '乾';
      q.dispatchEvent(new Event('input'));
      await wait(() => st().searchQuery === '乾');
      await new Promise(r => setTimeout(r, 1800));
      const cards = [...document.querySelectorAll('#searchList .snippet')];
      const first = cards[0];
      const heads = [...document.querySelectorAll('#searchList .snippet .h')];
      const out = {
        cards: cards.length,
        headingTags: [...new Set(heads.map((h) => h.dataset.tag))],
        headingStyle: heads[0] ? (heads[0].getAttribute('style') ?? '') : '',
        headingSize: heads[0] ? getComputedStyle(heads[0]).fontSize : '',
        cardSize: first ? getComputedStyle(first).fontSize : '',
        rawTags: first ? (first.textContent ?? '').includes('<') : true,
        brs: first ? first.querySelectorAll('br').length : -1,
        marks: first ? first.querySelectorAll('mark').length : -1,
        hasCur: !!first?.querySelector('mark.cur'),
      };
      q.value = prev;
      q.dispatchEvent(new Event('input'));
      await new Promise(r => setTimeout(r, 600));
      return out;
    })()
  `);
  ok('摘要卡片也渲染標籤：標題上色但字級不變、沒有原始標籤',
    snip.cards > 0 && snip.rawTags === false
    && (snip.headingTags.length === 0
      || (!/font-size/.test(snip.headingStyle) && snip.headingSize === snip.cardSize)),
    `${snip.cards} 張卡片；標題 ${JSON.stringify(snip.headingTags)}｜style「${snip.headingStyle}」`
    + `｜字級 ${snip.headingSize}（卡片 ${snip.cardSize}）｜原始標籤=${snip.rawTags}`);
  ok('摘要卡片不保留硬換行（沒有 <br>）、命中字有塗色',
    snip.brs === 0 && snip.marks > 0,
    `${snip.brs} 個 <br>、${snip.marks} 個 mark（主要命中 cur=${snip.hasCur}）`);

  // ---- 軟件說明（About）：點左上角 accelon26 → 置中彈窗，順便檢查更新 ----
  const about = await cdp.eval<any>(`
    (async () => {
      const wait = async (fn, n = 90) => { for (let i = 0; i < n; i++) { if (fn()) return true; await new Promise(r => setTimeout(r, 200)); } return false; };
      const box = document.querySelector('#aboutBox');
      const before = { hidden: box.hidden };
      document.querySelector('#brand').click();
      await wait(() => !box.hidden, 20);
      const r = box.getBoundingClientRect();
      const opened = {
        hidden: box.hidden,
        title: document.querySelector('#aboutTitle').textContent.trim(),
        sub: document.querySelector('.aboutSub').textContent.trim(),
        site: document.querySelector('#aboutSite').getAttribute('href'),
        logo: (document.querySelector('#aboutLogo').getAttribute('src') ?? '').startsWith('data:image/png'),
        logoW: document.querySelector('#aboutLogo').getBoundingClientRect().width,
        centred: Math.abs((r.left + r.width / 2) - window.innerWidth / 2) < 8,
        wechat: document.querySelector('#aboutWechat')?.textContent?.trim() ?? '',
        message: document.querySelector('#aboutMessage')?.getAttribute('href') ?? '',
        messageText: document.querySelector('#aboutMessage')?.textContent?.trim() ?? '',
      };
      await wait(() => window.__accelon26.aboutState().phase !== 'checking');
      const settled = {
        phase: window.__accelon26.aboutState().phase,
        message: document.querySelector('#aboutUpdateMsg').textContent.trim(),
        canInstall: !document.querySelector('#aboutInstall').hidden,
        build: document.querySelector('#aboutBuild').textContent.trim(),
        mode: document.querySelector('#aboutMode').textContent.trim(),
      };
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise(r => setTimeout(r, 200));
      const closed = box.hidden;
      return { before, opened, settled, closed };
    })()
  `);
  ok('點左上角 accelon26 → About 彈窗（置中）', about.before.hidden && !about.opened.hidden && about.opened.centred,
    `原本隱藏=${about.before.hidden}，開啟後隱藏=${about.opened.hidden}，置中=${about.opened.centred}`);
  ok('About：大 logo ＋ 標題「開放古籍平台」＋ 小字「Accelon3 跨平台平替」',
    about.opened.logo && about.opened.logoW >= 72 && about.opened.title === '開放古籍平台'
    && about.opened.sub.includes('Accelon3 跨平台平替'),
    `logo ${Math.round(about.opened.logoW)}px、標題「${about.opened.title}」、小字「${about.opened.sub}」`);
  ok('About：官網與版本（建置時間）',
    about.opened.site === 'https://shutonggui.cn/accelon26/' && about.settled.build.length > 4,
    `官網 ${about.opened.site}｜版本 ${about.settled.build}｜${about.settled.mode}`);
  ok('About：有開發者聯絡（微信 Sukhanika）',
    String(about.opened.wechat).includes('Sukhanika') && String(about.opened.wechat).includes('微信'),
    `「${about.opened.wechat}」`);
  ok('About：微信旁邊有「留言給作者」（開官網留言頁）',
    about.opened.message === 'https://shutonggui.cn/accelon26/message.html'
    && /留言給作者/.test(about.opened.messageText ?? ''),
    `href=${about.opened.message}`);
  ok('About 開啟時檢查更新：顯示「已是最新」或「無法檢查」',
    about.settled.phase !== 'checking' && about.settled.message.length > 0
    && (about.settled.phase === 'latest' || (about.settled.phase === 'unknown' && !about.settled.canInstall)),
    `phase=${about.settled.phase}｜「${about.settled.message}」｜更新按鈕=${about.settled.canInstall}`);
  ok('About：Esc 可關閉', about.closed === true, `關閉=${about.closed}`);

  // 網頁版沒有自動更新（作者 2026-10：等回到 Go／桌面版再做）—— About 要說清楚
  const aboutWeb = await cdp.eval<any>(`
    (async () => {
      document.querySelector('#brand').click();
      const box = document.querySelector('#aboutBox');
      for (let i = 0; i < 40 && box.hidden; i++) await new Promise(r => setTimeout(r, 100));
      for (let i = 0; i < 80; i++) { if (window.__accelon26.aboutState().phase !== 'checking') break; await new Promise(r => setTimeout(r, 100)); }
      const out = {
        phase: window.__accelon26.aboutState().phase,
        msg: document.querySelector('#aboutUpdateMsg').textContent.trim(),
        installShown: !document.querySelector('#aboutInstall').hidden,
      };
      window.__accelon26.closeAbout();
      return out;
    })()
  `);
  ok('About：網頁版說明「重新載入即可」，不假裝有自動更新',
    aboutWeb.phase === 'latest' && aboutWeb.msg.includes('重新載入') && aboutWeb.installShown === false,
    `phase=${aboutWeb.phase}｜「${aboutWeb.msg}」｜更新按鈕=${aboutWeb.installShown}`);

  // ---- 設置（齒輪）：進階模式搬進來、繁簡輸入通檢、文字顯示三態 ----
  const settings = await cdp.eval<any>(`
    (async () => {
      const wait = async (fn, n = 60) => { for (let i = 0; i < n; i++) { if (fn()) return true; await new Promise(r => setTimeout(r, 200)); } return false; };
      const st = () => window.__accelon26.state();
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const box = document.querySelector('#settingsBox');
      const before = { hidden: box.hidden, advanced: st().advanced, variants: st().variants, simMode: st().simMode };
      document.querySelector('#settingsBtn').click();
      await wait(() => !box.hidden, 20);
      const opened = {
        hidden: box.hidden,
        title: document.querySelector('#settingsTitle').textContent.trim(),
        hasAdvanced: !!document.querySelector('#setAdvanced'),
        hasVariants: !!document.querySelector('#setVariants'),
        segs: [...document.querySelectorAll('#simSeg button')].map((b) => b.textContent.trim()),
        activeSeg: (document.querySelector('#simSeg button.active') ?? {}).textContent ?? '',
      };
      // 進階模式：從設置頁勾選（原本的 🧑‍💻 按鈕已移除）
      const adv = document.querySelector('#setAdvanced');
      // 作者 2026-10-22：主題／介面／進階合併成「介面」分頁；進階模式是這個分頁的最後一列
      const uiPane = document.querySelector('#setBody .setPane[data-setpane="ui"]');
      const rows = [...uiPane.querySelectorAll('.setRow')];
      const advRow = adv.closest('.setRow');
      const advIsLast = rows.length > 0 && rows[rows.length - 1] === advRow;
      adv.checked = true; adv.dispatchEvent(new Event('change'));
      await sleep(400);
      const advOn = { advanced: st().advanced, body: document.body.classList.contains('advanced') };
      adv.checked = false; adv.dispatchEvent(new Event('change'));
      await sleep(300);
      const advOff = st().advanced;
      // 文字顯示三態
      const seg = [...document.querySelectorAll('#simSeg button')];
      const text = () => (document.querySelector('#docText .docBody')?.textContent ?? '');
      const t0 = text();
      seg[1].click(); await sleep(700);
      const t1 = text();
      const m1 = st().simMode;
      seg[2].click(); await sleep(700);
      const t2 = text();
      const m2 = st().simMode;
      seg[0].click(); await sleep(700);
      const t3 = text();
      const m0 = st().simMode;
      // 設置頁的「文字顯示」範例：三列、差異字有標記、active 跟著目前模式
      const demo = () => [...document.querySelectorAll('#simDemo .simRow')].map((r) => ({
        label: r.querySelector('.simLabel').textContent,
        text: r.querySelector('.simText').textContent,
        marks: r.querySelectorAll('.simText em').length,
        active: r.classList.contains('active'),
      }));
      const demoOrig = demo();
      seg[1].click(); await sleep(500);
      const demoSafe = demo();
      seg[0].click(); await sleep(400);          // 還原成原樣，免得後面的測試看到簡體字
      // 主題（作者 2026-10-22）：春綠／秋黃；秋黃是黃棕紙色
      const themeLabels = [...document.querySelectorAll('#themeSeg button')].map((b) => b.textContent.trim());
      const autumnBtn = [...document.querySelectorAll('#themeSeg button')].find((b) => b.dataset.theme === 'autumn');
      autumnBtn.click();
      await sleep(250);
      const autumnTheme = document.documentElement.getAttribute('data-theme');
      const autumnLs = localStorage.getItem('accelon26.theme');
      document.querySelector('#themeSeg button[data-theme="dark"]').click();
      await sleep(150);
      // 點擊查字典（作者 2026-10-22）：開關存 localStorage，預設開
      const dictAuto = document.getElementById('setDictAuto');
      const dictSection = !!document.getElementById('dictOrderList');
      const dictDefault = !!dictAuto?.checked;
      dictAuto.checked = false; dictAuto.dispatchEvent(new Event('change'));
      await sleep(250);
      const dictOff = localStorage.getItem('accelon26.dict.auto');
      dictAuto.checked = true; dictAuto.dispatchEvent(new Event('change'));
      await sleep(250);
      const dictOn = localStorage.getItem('accelon26.dict.auto');
      // 清單是非同步掃描的；給它一點時間（fgdict 執行時要看得到 fgdict.adb）
      for (let i = 0; i < 25 && !document.querySelector('#dictOrderList .dictOrderRow')
        && !document.querySelector('#dictOrderList .note'); i++) await sleep(150);
      const dictFiles = [...document.querySelectorAll('#dictOrderList .dictOrderRow')]
        .map((r) => r.querySelector('.df')?.textContent ?? '');
      const dictDbIsFg = st().db === 'fgdict';
      window.__accelon26.closeSettings();
      return {
        before, opened, advOn, advOff, advIsLast, demoOrig, demoSafe,
        dict: { section: dictSection, default: dictDefault, off: dictOff, on: dictOn, files: dictFiles, dbIsFg: dictDbIsFg },
        theme: { labels: themeLabels, autumn: autumnTheme, ls: autumnLs },
        sim: { t0, t1, t2, t3, m0, m1, m2, db: st().db, stored: localStorage.getItem('accelon26.simmode') },
      };
    })()
  `);
  ok('齒輪開啟「設置」彈窗（進階模式與繁簡都在裡面）',
    settings.before.hidden === true && settings.opened.hidden === false
    && settings.opened.title === '設置' && settings.opened.hasAdvanced && settings.opened.hasVariants,
    `標題「${settings.opened.title}」、進階=${settings.opened.hasAdvanced}、通檢=${settings.opened.hasVariants}`);
  ok('設置頁可以切換進階模式（取代原本的 🧑‍💻 按鈕）',
    settings.advOn.advanced === true && settings.advOn.body === true && settings.advOff === false,
    `勾選後 advanced=${settings.advOn.advanced}／body=${settings.advOn.body}；取消後=${settings.advOff}`);
  ok('設置頁的「進階模式」在「介面」分頁的最後一列',
    settings.advIsLast === true,
    `進階模式是介面分頁最後一列=${settings.advIsLast}`);
  ok('文字顯示是三態（保持原樣／無損簡體／強制簡體）',
    JSON.stringify(settings.opened.segs) === JSON.stringify(['保持原樣', '無損簡體', '強制簡體']),
    JSON.stringify(settings.opened.segs));
  ok('設置頁有「文字顯示」範例：三列並排、差異字有標記、active 跟著模式',
    settings.demoOrig.length === 3
    && settings.demoOrig[0].marks === 0
    && settings.demoOrig[1].marks > 0 && settings.demoOrig[2].marks > 0
    && settings.demoOrig[2].marks > settings.demoOrig[1].marks
    && settings.demoOrig[0].active === true
    && settings.demoSafe[1].active === true && settings.demoSafe[2].active === false
    && settings.demoSafe[1].text !== settings.demoSafe[2].text,
    `無損「${settings.demoSafe[1].text}」（${settings.demoSafe[1].marks} 個差異字）／`
    + `強制「${settings.demoOrig[2].text}」（${settings.demoOrig[2].marks} 個）`);
  ok('點擊查字典：介面有開關（預設開，關閉會存起來）',
    settings.dict.section === true && settings.dict.default === true
    && settings.dict.off === '0' && settings.dict.on === '1',
    JSON.stringify(settings.dict));
  ok('點擊查字典：有詞典型 adb 時，清單列出檔名（fgdict.adb）',
    !settings.dict.dbIsFg || settings.dict.files.includes('fgdict.adb'),
    JSON.stringify(settings.dict.files));
  ok('主題多了秋黃（黃棕）；春綠是原本的護眼',
    settings.theme.labels.join('|') === '暗色系|亮色系|春綠|秋黃'
    && settings.theme.autumn === 'autumn' && settings.theme.ls === 'autumn',
    JSON.stringify(settings.theme));
  ok('三態都生效，且可以回到原樣',
    settings.sim.m1 === 1 && settings.sim.m2 === 2 && settings.sim.m0 === 0
    && settings.sim.t1 !== settings.sim.t0 && settings.sim.t3 === settings.sim.t0,
    `模式 ${settings.sim.m0}→${settings.sim.m1}→${settings.sim.m2}；`
    + `無損「${settings.sim.t1.slice(0, 12)}」／強制「${settings.sim.t2.slice(0, 12)}」`);
  if (settings.sim.db === '13j') {
    ok('無損簡體：見→见、潛→潜，但乾／終不合併字保留原樣',
      settings.sim.t1.includes('见') && settings.sim.t1.includes('潜') && settings.sim.t1.includes('乾'),
      `無損開頭「${settings.sim.t1.slice(0, 24)}」`);
    ok('強制簡體：乾→干（合併字也轉）',
      settings.sim.t2.includes('干') && !settings.sim.t2.includes('乾'),
      `強制開頭「${settings.sim.t2.slice(0, 24)}」`);
  }

  // ---- 標籤樣式（作者 2026-10-22）：本文列、每列示範、內置標籤、天干地支只示範甲 ----
  const tagStyle = await cdp.eval<any>(`
    (async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      window.__accelon26.openSettings();
      await sleep(400);
      const tabs = [...document.querySelectorAll('#setTabs .setTab')].map((b) => b.textContent.trim());
      // 作者 2026-10-22：預設是「介面」分頁；標籤樣式的表格要切過去才畫
      document.querySelector('#setTabs .setTab[data-setpane="tags"]').click();
      await sleep(400);
      const rows = () => [...document.querySelectorAll('#tagTable .tagRow')];
      const row = (k) => rows().find((r) => r.dataset.key === k);
      const store = document.querySelector('#tagStorePath')?.textContent ?? '';
      const first = rows()[0];
      const body = row('__body__');
      const jing = row('經');
      const group = row('天干地支');
      const initial = {
        preview: !!document.querySelector('#tagPreview'),
        bodyKind: body?.dataset.kind,
        bodyText: body?.querySelector('.tchip')?.textContent,
        bodySize: body?.querySelector('.sizeVal')?.textContent,
        bodyMin: body?.querySelector('input[data-field="size"]')?.getAttribute('min'),
        bodyMax: body?.querySelector('input[data-field="size"]')?.getAttribute('max'),
        bodyFirst: first === body,
        builtins: ['文', '項', '部', '經'].map((k) => !!row(k)),
        jingFont: jing ? getComputedStyle(jing.querySelector('.tchip')).fontFamily : '',
        groupText: group?.querySelector('.tchip')?.textContent,
        ramp: document.querySelectorAll('#tagTable .rampCell').length,
        fontSource: document.querySelector('#tagFontSource')?.textContent ?? '',
      };
      // 全域自訂「章」：#ff0000 / 200%
      document.querySelector('#tagScopeSeg button[data-tag-scope="global"]').click();
      await sleep(200);
      row('章').querySelector('button[data-act="own"]').click();
      await sleep(100);
      let r = row('章');
      const color = r.querySelector('input[data-field="color"]');
      color.value = '#ff0000'; color.dispatchEvent(new Event('input', { bubbles: true }));
      const size = r.querySelector('input[data-field="size"]');
      size.value = '200'; size.dispatchEvent(new Event('input', { bubbles: true }));
      size.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(450);
      const chapterChip = () => row('章').querySelector('.tchip');
      const chapterColor = getComputedStyle(chapterChip()).color;
      const chapterSize = getComputedStyle(chapterChip()).fontSize;
      const chapterInline = chapterChip().style.fontSize;
      // 本文：字級 15pt（存在 body.size，不是改 doc 字級）；顏色紅、字型 DFKai-SB
      const bodyRow = () => row('__body__');
      const docFontBefore = window.__accelon26.state().docFont;
      const bs = bodyRow().querySelector('input[data-field="size"]');
      bs.value = '15'; bs.dispatchEvent(new Event('input', { bubbles: true }));
      bs.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(450);
      const bodySizeVar = getComputedStyle(document.documentElement).getPropertyValue('--doc-body-size').trim();
      const bodyDocFont = window.__accelon26.state().docFont;
      const bodyLabel = bodyRow().querySelector('.sizeVal')?.textContent;
      const chapterSize2 = getComputedStyle(chapterChip()).fontSize;
      const bodyDoc = document.querySelector('#docText .docBody');
      const bodyPx = bodyDoc ? getComputedStyle(bodyDoc).fontSize : '';
      bodyRow().querySelector('button[data-act="own"]').click();
      await sleep(100);
      const bc = bodyRow().querySelector('input[data-field="color"]');
      bc.value = '#ff0000'; bc.dispatchEvent(new Event('input', { bubbles: true }));
      bc.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(250);
      const bf = bodyRow().querySelector('select[data-field="font"]');
      bf.value = 'DFKai-SB'; bf.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(350);
      // 標籤樣式的 body 存在 root 變數（沒有開本文時也能檢查；實際中欄由 CSS 取用）
      const bodyColor = getComputedStyle(document.documentElement).getPropertyValue('--doc-body-color').trim();
      const bodyFont = getComputedStyle(document.documentElement).getPropertyValue('--doc-body-font').trim();
      const bodySampleColor = getComputedStyle(bodyRow().querySelector('.tchip')).color;
      const ls = localStorage.getItem('accelon26.settings') || '';
      // 天干地支：底色 #00ff00 → 只示範甲（沒有 22 格）
      row('天干地支').querySelector('button[data-act="own"]').click();
      await sleep(100);
      const gc = row('天干地支').querySelector('input[data-field="color"]');
      gc.value = '#00ff00'; gc.dispatchEvent(new Event('input', { bubbles: true }));
      gc.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(450);
      const jiaColor = getComputedStyle(row('天干地支').querySelector('.tchip')).color;
      const lsGroup = localStorage.getItem('accelon26.settings') || '';
      // 還原本文 12pt（16px），免得後面的字級測試看到 20px
      const bs2 = bodyRow().querySelector('input[data-field="size"]');
      bs2.value = '12'; bs2.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(250);
      // 關設置 → 展開到「章」，看目錄色點（沒有樹的庫會跳過）
      window.__accelon26.closeSettings();
      await sleep(300);
      const hasTree = !!document.querySelector('#dirTree .tRow');
      const trow = () => [...document.querySelectorAll('#dirTree .tRow')];
      trow()[0]?.querySelector('.tTwisty')?.click();
      await sleep(800);
      if (!trow().some((x) => x.querySelector('.tTag')?.textContent === '章')) {
        const ji = trow().find((x) => x.querySelector('.tTag')?.textContent === '記');
        ji?.querySelector('.tTwisty')?.click();
        await sleep(800);
      }
      const chapter = trow().find((x) => x.querySelector('.tTag')?.textContent === '章');
      const dotColor = chapter?.querySelector('.tDot') ? getComputedStyle(chapter.querySelector('.tDot')).backgroundColor : '';
      // 清掉：測試不留足跡（重設 + 移除 localStorage）
      window.__accelon26.openSettings();
      await sleep(250);
      window.__accelon26.resetTagStyles();
      await sleep(500);
      localStorage.removeItem('accelon26.settings');
      window.__accelon26.closeSettings();
      await sleep(500);
      const chapter2 = trow().find((x) => x.querySelector('.tTag')?.textContent === '章');
      const dotAfter = chapter2?.querySelector('.tDot') ? getComputedStyle(chapter2.querySelector('.tDot')).backgroundColor : '';
      return {
        tabs, rowCount: rows().length, store, initial,
        chapterColor, chapterSize, chapterInline, bodySizeVar, bodyDocFont, bodyLabel, chapterSize2, bodyPx,
        docFontBefore,
        bodyColor, bodyFont, bodySampleColor, jiaColor,
        lsHas: ls.includes('"章"') && ls.includes('#ff0000') && ls.includes('"body"'),
        groupSaved: lsGroup.includes('"天干地支"') && lsGroup.includes('#00ff00'),
        hasTree, dotColor, dotAfter,
      };
    })()
  `);
  ok('設置多了「標籤樣式」分頁：介面最左、沒有預覽、顯示儲存位置',
    tagStyle.tabs.length === 3 && tagStyle.tabs.join('|') === '介面|標籤樣式|繁簡'
    && tagStyle.rowCount >= 11 && tagStyle.initial.preview === false
    && tagStyle.store.includes('localStorage'),
    JSON.stringify({ tabs: tagStyle.tabs, rows: tagStyle.rowCount, preview: tagStyle.initial.preview, store: tagStyle.store }));
  ok('標籤樣式：本文列置頂（pt）、文／項／部／經內置、經預設楷體、天干地支只示範甲',
    tagStyle.initial.bodyFirst === true && tagStyle.initial.bodyKind === 'body'
    && tagStyle.initial.bodyText === '本文' && /^\d+pt$/.test(tagStyle.initial.bodySize)
    && tagStyle.initial.bodyMin === '8' && tagStyle.initial.bodyMax === '30'
    && tagStyle.initial.builtins.every(Boolean)
    && /Kai|楷/.test(tagStyle.initial.jingFont)
    && tagStyle.initial.groupText === '甲' && tagStyle.initial.ramp === 0
    && tagStyle.initial.fontSource.includes('字型清單'),
    JSON.stringify(tagStyle.initial));
  ok('章自訂 #ff0000 / 200% → 直接示範在 .tchip（32px）、目錄色點也紅',
    tagStyle.chapterColor === 'rgb(255, 0, 0)' && tagStyle.chapterSize === '32px'
    && tagStyle.chapterInline === '24pt' && tagStyle.lsHas
    && (!tagStyle.hasTree || tagStyle.dotColor === 'rgb(255, 0, 0)'),
    JSON.stringify({ color: tagStyle.chapterColor, size: tagStyle.chapterSize, inline: tagStyle.chapterInline, dot: tagStyle.dotColor }));
  ok('本文列 15pt → 中欄 --doc-body-size 15pt（20px）、章跟著 40px；本文顏色／字型套到中欄',
    tagStyle.bodySizeVar === '15pt' && tagStyle.bodyDocFont === tagStyle.docFontBefore
    && tagStyle.bodyLabel === '15pt'
    && tagStyle.chapterSize2 === '40px' && (!tagStyle.bodyPx || tagStyle.bodyPx === '20px')
    && tagStyle.bodyColor === '#ff0000'
    && /DFKai-SB/.test(tagStyle.bodyFont) && tagStyle.bodySampleColor === 'rgb(255, 0, 0)',
    JSON.stringify({ sizeVar: tagStyle.bodySizeVar, docFontBefore: tagStyle.docFontBefore, docFont: tagStyle.bodyDocFont, label: tagStyle.bodyLabel, chapter: tagStyle.chapterSize2, bodyPx: tagStyle.bodyPx, color: tagStyle.bodyColor, font: tagStyle.bodyFont }));
  ok('標籤樣式：重設後目錄色點回到 auto',
    !tagStyle.hasTree || (tagStyle.dotAfter && tagStyle.dotAfter !== 'rgb(255, 0, 0)'),
    `重設前 ${tagStyle.dotColor} → 重設後 ${tagStyle.dotAfter}`);
  ok('天干地支是同一個設定：底色 #00ff00 → 甲示範綠、存進 groups（只示範甲）',
    tagStyle.jiaColor === 'rgb(0, 255, 0)' && tagStyle.groupSaved,
    `甲 ${tagStyle.jiaColor}｜groups=${tagStyle.groupSaved}`);

  // 輸入區按 Escape 不再清掉輸入（作者 2026-10）：文字留著、結果也留著，清空要用 ✕。
  // 這一組同時覆蓋兩個 handler：全文搜尋的 #query，以及四個 pane 共用的 wireOwnSearch。
  const escKeep = await cdp.eval<{ q: { before: string; after: string; snippets: number }; own: string | null }>(`
    (async () => {
      const q = document.querySelector('#query');
      const before = q.value;
      q.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise((r) => setTimeout(r, 500));
      const qOut = { before, after: q.value, snippets: document.querySelectorAll('#searchList .snippet').length };
      // 任何一個 pane 的輸入框（頻次／名詞／西文／原書分頁）都用同一個 handler
      let own = null;
      const paneInput = ['#freqQuery', '#termsQuery', '#latinQuery', '#folioQuery']
        .map((sel) => document.querySelector(sel))
        .find((el) => el && !el.closest('.tabPane')?.hidden);
      if (paneInput) {
        paneInput.value = '\u4f5b';
        paneInput.dispatchEvent(new Event('input'));
        await new Promise((r) => setTimeout(r, 400));
        paneInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await new Promise((r) => setTimeout(r, 300));
        own = paneInput.value;
        paneInput.value = '';
        paneInput.dispatchEvent(new Event('input'));
        await new Promise((r) => setTimeout(r, 400));
      }
      return { q: qOut, own };
    })()
  `);
  ok('輸入區按 Escape 不會清掉輸入的文字（也不再清掉結果）',
    !!escKeep.q.before && escKeep.q.after === escKeep.q.before && escKeep.q.snippets > 0,
    `#query「${escKeep.q.before}」→「${escKeep.q.after}」、摘要 ${escKeep.q.snippets} 筆`
    + (escKeep.own === null ? '｜（此庫沒有其他可見的輸入框）' : `；pane 輸入框 Escape 後＝「${escKeep.own}」`));

  // 真正的瀏覽器行為：<input type="search"> 內建「Escape 清空」→ 一定要 preventDefault 才擋得住。
  // 合成事件不會觸發預設動作，所以這裡用 CDP 送真正的按鍵（trusted）；作者回報的正是
  // 「fgdict 全文檢索輸入區按 Escape 還是會刪除輸入文字」。
  const pressEscape = async (sel: string): Promise<string | null> => {
    const focused = await cdp.eval<boolean>("(() => { const el = document.querySelector('" + sel + "'); if (!el || !el.offsetParent) return false; el.focus(); return document.activeElement === el; })()");
    if (!focused) return null;
    for (const type of ['keyDown', 'keyUp']) {
      await cdp.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    }
    await Bun.sleep(300);
    return cdp.eval<string>("document.querySelector('" + sel + "').value");
  };
  // #query 住在「目錄」分頁裡（沒有 s="*" 的庫沒有這個分頁 → 略過）
  const dirShown = await cdp.eval<boolean>(`(() => {
    const btn = document.querySelector('#colLeft .tabBtn[data-tab="dir"]');
    if (!btn || btn.hidden || getComputedStyle(btn).display === 'none') return false;
    btn.click();
    return true;
  })()`);
  if (dirShown) {
    await Bun.sleep(500);
    const qBefore = await cdp.eval<string>("document.querySelector('#query').value");
    const qAfter = await pressEscape('#query');
    ok('真按 Escape（trusted）也清不掉全文搜尋的輸入', !!qBefore && qAfter === qBefore,
      `#query「${qBefore}」→「${qAfter}」`);
  } else {
    console.log('      （此庫沒有「目錄」分頁，#query 不可見，略過）');
  }
  // 左欄「全文／頻次」分頁的輸入框（fgdict 的全文檢索就是這一個）
  const freqShown = await cdp.eval<boolean>(`(() => {
    const btn = document.querySelector('#colLeft .tabBtn[data-tab="freq"]');
    if (!btn || btn.hidden || getComputedStyle(btn).display === 'none') return false;
    btn.click();
    return true;
  })()`);
  if (freqShown) {
    await Bun.sleep(800);
    const typed = await cdp.eval<string>("(() => { const el = document.querySelector('#freqQuery'); el.value = '佛'; el.dispatchEvent(new Event('input')); return el.value; })()");
    await Bun.sleep(600);
    const after = await pressEscape('#freqQuery');
    ok('真按 Escape（trusted）也清不掉「全文／頻次」的輸入框', after === typed,
      `#freqQuery「${typed}」→「${after}」`);
    await cdp.eval("(() => { const el = document.querySelector('#freqQuery'); el.value = ''; el.dispatchEvent(new Event('input')); })()");
    await Bun.sleep(600);
  } else {
    console.log('      （此庫沒有「全文／頻次」分頁，略過該輸入框的 trusted Escape 檢查）');
  }
  // 目錄樹（<樹> 解析 → 右欄「目錄」分頁）
  const tree = await cdp.eval<{
    tabs: string; rows: number; meta: string; labels: string[]; dots: string[];
    twisty: number; line: string | null; jumped: string | null; rootRows: number; dbg?: string;
  }>(`
    (async () => {
      window.__accelon26.showTab('dir', 'left');
      // the tree is built asynchronously (labels walk the source text)
      for (let i = 0; i < 60; i++) {
        if (!window.__accelon26.state().dirLoading) break;
        await new Promise(r => setTimeout(r, 250));
      }
      await new Promise(r => setTimeout(r, 300));
      const rows = [...document.querySelectorAll('#dirTree .tRow')];
      const labels = rows.slice(0, 5).map(r => r.querySelector('.tName').textContent);
      const dots = rows.slice(0, 3).map(r => r.querySelector('.tDot').style.background);
      // collapse the first row if it has children, then re-open
      const first = rows[0];
      if (!first) {
        return {
          tabs: [...document.querySelectorAll('#colRight .tabBtn')].map(b => b.getAttribute('data-tab')).join(','),
          rows: 0, meta: document.querySelector('#dirMeta').textContent.slice(0, 90),
          labels: [], dots: [], twisty: 0, line: null, jumped: null, rootRows: 0,
          dbg: JSON.stringify(window.__accelon26.state().dirInfo),
        };
      }
      let rootRows = rows.length;
      const tw = first?.querySelector('.tTwisty');
      if (tw && tw.textContent.trim() === '▾') {
        tw.click();
        await new Promise(r => setTimeout(r, 250));
        rootRows = document.querySelectorAll('#dirTree .tRow').length;
        document.querySelector('#dirTree .tTwisty').click();
        await new Promise(r => setTimeout(r, 250));
      }
      // click a row's node mark (.tDot) -> open it if it can open, and link the text
      const target = [...document.querySelectorAll('#dirTree .tRow')][1] ?? first;
      (target.querySelector('.tDot') ?? target).click();
      await new Promise(r => setTimeout(r, 1200));
      return {
        tabs: [...document.querySelectorAll('#colRight .tabBtn')].map(b => b.getAttribute('data-tab')).join(','),
        rows: rows.length,
        meta: document.querySelector('#dirMeta').textContent.slice(0, 90),
        labels, dots,
        twisty: document.querySelectorAll('#dirTree .tTwisty').length,
        line: document.querySelector('#docText .hitLine')?.id ?? null,
        jumped: window.__accelon26.state().lastReveal,
        rootRows,
      };
    })()
  `);
  ok('目錄樹分頁在左欄、右欄是 META 等', tree.tabs.includes('meta') && !tree.tabs.includes('tree'), 'tabs = ' + tree.tabs);
  const dirState = await cdp.eval<{ dirRows: number; html: number; pane: string; meta: string; err: string; loading: boolean }>(`
    (() => {
      const st = window.__accelon26.state();
      const pane = document.querySelector('#colRight .tabPane[data-tab="tree"]');
      return {
        dirRows: st.dirRows,
        html: document.getElementById('dirTree').innerHTML.length,
        pane: pane ? getComputedStyle(pane).display + '/' + pane.clientHeight : '(none)',
        meta: document.getElementById('dirMeta').textContent.slice(0, 60),
        err: st.dirError,
        loading: st.dirLoading,
      };
    })()
  `);
  ok('目錄樹狀態可用', !dirTabShown || (dirState.html > 100 && dirState.dirRows > 0),
    `${dirState.dirRows} 列在 DOM，pane ${dirState.pane}，loading=${dirState.loading}｜${dirState.meta}${dirState.err ? ' ERR ' + dirState.err.slice(0, 120) : ''}`);
  ok('目錄樹列出 <樹> 的節點', !dirTabShown || tree.rows >= 2,
    `${tree.rows} 列（twisty ${tree.twisty}），第一層標籤 ${JSON.stringify(tree.labels)}｜${tree.meta}`);
  const dirState2 = await cdp.eval<{ tiers: string[]; nodes: number; roots: number } | null>(`window.__accelon26.state().dirInfo`);
  // 沒有 s="*" 的庫不建樹（dirInfo 為 null）—— 這一項只在有目錄樹的庫上成立
  ok('預設目錄＝第一個有 t= 的 <樹>', !dirTabShown || (dirState2?.tiers?.length > 0 && dirState2.nodes > 0),
    dirTabShown
      ? `${dirState2?.roots} 根 / ${dirState2?.nodes} 節點，層級 ${JSON.stringify(dirState2?.tiers)}`
      : '此庫沒有 s="*" → 不建目錄樹');

  // 目錄樹的列是「捲到底才掛上 DOM」（lazy-list）：先確認機制，再把整棵樹掛完，
  // 因為後面幾組斷言要看全部（fgdict 6,966 列，全掛上是 3.5 萬個節點）。
  const lazyTree = await cdp.eval<{ first: number; more: string; all: number }>(`
    (async () => {
      const box = document.getElementById('dirTree');
      const more = box.querySelector('.moreRows');
      const first = box.querySelectorAll('.tRow').length;
      const all = more ? await window.__accelon26.growTree() : first;
      return { first, more: more ? more.textContent.slice(0, 40) : '', all };
    })()
  `);
  ok('目錄樹分批掛上 DOM（捲到底才載入更多）',
    !dirTabShown || (lazyTree.first <= 200 && (lazyTree.more ? lazyTree.all > lazyTree.first : lazyTree.all === lazyTree.first)),
    `首批 ${lazyTree.first} 列／全部 ${lazyTree.all} 列${lazyTree.more ? '（' + lazyTree.more + '）' : '（一屏裝得下）'}`);

  // 逐層展開：書 → 章（13j 的 `t="章,節,項."` 尾點讓章成為末層，所以只有兩層；
  // yinshun 的 t= 沒有尾點，章底下還有節，可以展開三層）
  const depthTest = await cdp.eval<{
    bookRows: number; afterBook: number; chapterLabels: string[]; afterChapter: number;
    dots: string[]; levels: string; deeper: boolean;
  }>(`
    (async () => {
      const rows = () => [...document.querySelectorAll('#dirTree .tRow')];
      const expand = async (i) => {
        const r = rows()[i];
        const tw = r?.querySelector('.tTwisty');
        if (tw && tw.textContent.trim() === '▸') {
          tw.click();
          await new Promise(x => setTimeout(x, 700));
        }
      };
      const bookRows = rows().length;
      await expand(0);
      const afterBook = rows().length;
      const chapterLabels = rows().slice(1, 5).map(r => r.querySelector('.tName').textContent);
      const expandable = rows().findIndex((r, i) => i > 0 && r.querySelector('.tTwisty')?.textContent.trim() === '▸');
      const deeper = expandable > 0;
      if (deeper) await expand(expandable);
      const afterChapter = rows().length;
      const dots = rows().slice(0, 4).map(r => r.querySelector('.tDot').style.background);
      const levels = rows().slice(0, 4).map(r => r.querySelector('.tTag').textContent).join(',');
      return { bookRows, afterBook, chapterLabels, afterChapter, dots, levels, deeper };
    })()
  `);
  // a database without s="*" has no 目錄 pane at all (fgdict): its tree is a
  // page-folio index, so the chapter-expansion check does not apply
  ok('目錄樹可逐層展開（書 → 章→ 節）',
    !dirTabShown || (depthTest.afterBook > depthTest.bookRows && (!depthTest.deeper || depthTest.afterChapter > depthTest.afterBook)),
    `收合 ${depthTest.bookRows} 列 → 展開書 ${depthTest.afterBook} 列`
    + `${depthTest.deeper ? ` → 展開章 ${depthTest.afterChapter} 列` : '（此庫此書的章為末層）'}`
    + `；章標籤 ${JSON.stringify(depthTest.chapterLabels)}；層級 ${depthTest.levels}`);
  ok('第一層子節點有名字', !dirTabShown || depthTest.chapterLabels.every((s) => !!s && s.trim().length > 0),
    JSON.stringify(depthTest.chapterLabels));

  // ---- 內文渲染成 HTML（render_accelon3.ts）＋進階模式的「顯示原始文件」 ----
  const render = await cdp.eval<any>(`
    (async () => {
      const wait = async (fn, n = 100) => { for (let i = 0; i < n; i++) { if (fn()) return true; await new Promise(r => setTimeout(r, 200)); } return false; };
      const st = () => window.__accelon26.state();
      // 本文可能已經由上面的目錄測試載進來了；還沒有就點名詞列／目錄列
      if (!document.querySelector('#docText .docLine')) {
        const node = document.querySelector('#dirTree .tRow');
        if (node) (node.querySelector('.tDot') ?? node).click();
        else document.querySelector('#termsList .snippet')?.click();
      }
      await wait(() => document.querySelectorAll('#docText .docLine').length > 0, 100);
      await new Promise(r => setTimeout(r, 700));
      const px = (el) => getComputedStyle(el);
      const h = [...document.querySelectorAll('#docText .lineText .h')];
      const base = parseFloat(px(document.querySelector('#docText .docBody')).fontSize);
      const rendered = {
        lines: document.querySelectorAll('#docText .docLine').length,
        headings: h.length,
        tags: [...new Set(h.map(x => x.dataset.tag))].slice(0, 5),
        up: [...new Set(h.map(x => x.dataset.up))].slice(0, 5),
        size: h[0] ? parseFloat(px(h[0]).fontSize) : 0,
        base,
        color: h[0] ? px(h[0]).color : '',
        bodyColor: px(document.querySelector('#docText .docBody')).color,
        lum: h[0] ? (() => { const m = /rgba?\\((\\d+), *(\\d+), *(\\d+)/.exec(px(h[0]).color); return m ? Math.round((Number(m[1]) * 299 + Number(m[2]) * 587 + Number(m[3]) * 114) / 1000) : 0; })() : 0,
        pages: document.querySelectorAll('#docText .pageBreak').length,
        rawTags: (document.querySelector('#docText .lineText')?.textContent ?? '').includes('<'),
        toggleHidden: getComputedStyle(document.querySelector('#rawToggle')).display,
        state: st().renderRaw,
      };
      // 進階模式才看得到「原始文件」
      window.__accelon26.setAdvanced(true);
      await new Promise(r => setTimeout(r, 300));
      const shownInAdvanced = getComputedStyle(document.querySelector('#rawToggle')).display !== 'none';
      // 勾選 → 原始文件
      const box = document.querySelector('#showRaw');
      box.checked = true;
      box.dispatchEvent(new Event('change'));
      await new Promise(r => setTimeout(r, 700));
      const raw = {
        headings: document.querySelectorAll('#docText .lineText .h').length,
        pages: document.querySelectorAll('#docText .pageBreak').length,
        hasTags: [...document.querySelectorAll('#docText .lineText')].some((el) => (el.textContent ?? '').includes('<')),
        state: st().renderRaw,
        stored: localStorage.getItem('accelon26.showraw'),
      };
      box.checked = false;
      box.dispatchEvent(new Event('change'));
      await new Promise(r => setTimeout(r, 700));
      const back = { headings: document.querySelectorAll('#docText .lineText .h').length, state: st().renderRaw };
      window.__accelon26.setAdvanced(false);
      return { rendered, shownInAdvanced, raw, back };
    })()
  `);
  ok('內文預設渲染成 HTML（原始標籤看不到）',
    render.rendered.lines > 0 && !render.rendered.rawTags && render.rendered.state === false,
    `${render.rendered.lines} 行、標籤殘留=${render.rendered.rawTags}`);
  ok('標題依層級 +2pt、不超過本文 200%，字色比 tDot 亮且有彩度',
    render.rendered.headings === 0
    || (render.rendered.size > render.rendered.base && render.rendered.size <= render.rendered.base * 2 + 0.5
      && render.rendered.color !== render.rendered.bodyColor && render.rendered.lum > 150),
    `標題 ${render.rendered.headings} 個（${JSON.stringify(render.rendered.tags)}，up=${JSON.stringify(render.rendered.up)}）`
    + `｜字級 ${render.rendered.size}px／本文 ${render.rendered.base}px｜字色 ${render.rendered.color}（亮度 ${render.rendered.lum}，本文 ${render.rendered.bodyColor}）`);
  ok('`<頁>` 渲染成右靠的分隔（.pageBreak）', render.rendered.pages > 0, `${render.rendered.pages} 個`);
  ok('「顯示原始文件」只在進階模式出現',
    !/^(inline|flex|block)/.test(render.rendered.toggleHidden) && render.shownInAdvanced === true,
    `一般模式 display=${render.rendered.toggleHidden}，進階模式可見=${render.shownInAdvanced}`);
  ok('勾「原始文件」→ 不渲染（標籤回來、沒有標題）',
    render.raw.headings === 0 && render.raw.hasTags === true && render.raw.state === true && render.raw.stored === '1',
    `標題 ${render.raw.headings} 個、看得到標籤=${render.raw.hasTags}、state=${render.raw.state}`);
  ok('取消「原始文件」→ 回到渲染', render.back.state === false && render.back.headings === render.rendered.headings,
    `state=${render.back.state}、標題 ${render.back.headings} 個`);

  // ---- 祖先標題列 ＋ 上一頁／下一頁跨節點（作者 2026-10） ----
  const trail = await cdp.eval<any>(`
    (async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const st = () => window.__accelon26.state();
      const rows = () => [...document.querySelectorAll('#dirTree .tRow')];
      if (!document.querySelector('#dirTree .tRow')) return { skipped: true };
      // 展開第一本書，點它底下的第一個「章」
      const first = rows()[0];
      if (first?.querySelector('.tTwisty')?.textContent.trim() !== '▾') first?.querySelector('.tTwisty')?.click();
      await sleep(600);
      const chapter = rows().find((r) => r.querySelector('.tTag')?.textContent === '章');
      if (!chapter) return { skipped: true };
      chapter.querySelector('.tDot').click();
      await sleep(1500);
      const bookLabel = rows()[0]?.querySelector('.tName')?.textContent ?? '';
      const clicked = chapter.querySelector('.tName').textContent;
      const trail0 = [...document.querySelectorAll('#docTrail .trail')].map((a) => a.textContent.replace(/[▾▸]/g, '').trim());
      const trail0Full = [...document.querySelectorAll('#docTrail .trail')].map((a) => (a.title.match(/「(.*)」/) ?? [])[1] ?? '');
      const crumbFont = (() => { const b = document.querySelector('#docTrail .trail'); return b ? getComputedStyle(b).fontSize : ''; })();
      const bodyFont = (() => { const b = document.querySelector('#docText .docBody'); return b ? getComputedStyle(b).fontSize : ''; })();
      const pager0 = { hidden: document.getElementById('docPager').hidden, info: document.getElementById('pageInfo').textContent };
      const vaBefore = st().pinned?.va;
      const tabBefore = st().docTabs[st().docTab]?.name ?? '';
      // 小節（只有一頁）也要能按「下一頁」→ 換到下一個 text node
      document.getElementById('pageNext').click();
      await sleep(1600);
      const vaAfter = st().pinned?.va;
      const tabAfter = st().docTabs[st().docTab]?.name ?? '';
      // 同層 siblings 直接排在 breadcrumb 後面（作者 2026-10）；超過 5 個改成下拉（2026-10-18）
      let sibChips = [...document.querySelectorAll('#docTrail .trailSib')];
      let dropdown = false;
      if (!sibChips.length && document.querySelector('#docTrail .trailMore')) {
        document.querySelector('#docTrail .trailMore').click();
        await sleep(400);
        const menu = document.getElementById('trailMenu');
        sibChips = menu ? [...menu.querySelectorAll('.trailItem')] : [];
        dropdown = true;
      }
      const sibLabels = sibChips.map((c) => c.textContent.trim());
      const sibCount = sibChips.length;
      const curSel = dropdown ? '#trailMenu .trailItem.active' : '#docTrail .trailSib.cur';
      const sibCur = document.querySelector(curSel)?.textContent.trim() ?? '';
      const sibFull = document.querySelector(curSel)?.title ?? '';
      // 短標籤：不能有空白（有分隔符就只取前面那段）、長度 ≤ 5；下拉裡是完整標籤，不檢查
      const shortOk = [...trail0, ...(dropdown ? [] : sibLabels)]
        .every((t) => !/\s/.test(t) && [...t].length <= 5);
      // 點沒有 cur／active 的 sibling → 直接換節
      const chip = sibChips.find((c) => !c.classList.contains('cur') && !c.classList.contains('active') && c.dataset.tag);
      const chipLabel = chip?.textContent.trim() ?? '';
      // dropdown items (#trailMenu .trailItem) carry the full label as their TEXT,
      // chips carry it in the title as 「…」 — accept either, or the assertion would
      // compare the tab name against an empty string.
      const chipFull = (((chip?.title ?? '').match(/「(.*)」/) ?? [])[1] ?? '') || chipLabel;
      const vaBeforeChip = st().pinned?.va;
      chip?.click();
      await sleep(1800);
      const vaPicked = st().pinned?.va;
      const tabPicked = st().docTabs[st().docTab]?.name ?? '';
      // 點第一格（書）→ 下拉所有書（完整標籤，不節略）
      document.querySelector('#docTrail .trail')?.click();
      await sleep(400);
      const bookMenu = document.getElementById('trailMenu');
      const bookItems = bookMenu ? [...bookMenu.querySelectorAll('.trailItem')] : [];
      const bookLabels = bookItems.map((i) => i.textContent);
      const bookActive = bookMenu?.querySelector('.trailItem.active')?.textContent ?? '';
      const itemStyle = bookItems[0] ? getComputedStyle(bookItems[0]) : null;
      const menuClipped = bookItems.filter((i) => i.scrollWidth > i.clientWidth + 1).length;
      return {
        skipped: false, bookLabel, clicked, trail0, trail0Full, crumbFont, bodyFont, pager0, tabBefore, tabAfter, vaBefore, vaAfter,
        sibCount, sibLabels: sibLabels.slice(0, 6), sibCur, sibFull, shortOk,
        chipLabel, chipFull, vaBeforeChip, vaPicked, tabPicked,
        bookLabels: bookLabels.slice(0, 4), bookCount: bookLabels.length, bookActive,
        menuTextOverflow: itemStyle?.textOverflow ?? '', menuWhiteSpace: itemStyle?.whiteSpace ?? '',
        menuClipped, menuLabels: bookLabels,
        trailAfter: [...document.querySelectorAll('#docTrail .trail')].map((a) => a.textContent.replace(/[▾▸]/g, '').trim()),
      };
    })()
  `);
  if (trail.skipped) {
    console.log('      （此庫沒有可展開的目錄樹，略過祖先標題列的檢查）');
  } else {
    ok('本文上方是 breadcrumb：所有祖先（短標籤），字級同內文',
      trail.trail0.includes(trail.bookLabel) && trail.bookLabel.length > 0
      && trail.crumbFont === trail.bodyFont,
      `點「${trail.clicked}」→ 路徑 ${JSON.stringify(trail.trail0)}（完整 ${JSON.stringify(trail.trail0Full)}）`
      + `｜字級 ${trail.crumbFont}／內文 ${trail.bodyFont}`);
    ok('小節（只有一頁）也看得到上一頁／下一頁',
      trail.pager0.hidden === false && /共 \d+ 行/.test(trail.pager0.info),
      `${trail.pager0.info}`);
    ok('下一頁跨到邊界時換到下一個 text node',
      trail.vaAfter !== trail.vaBefore && trail.tabAfter !== trail.tabBefore,
      `VA ${trail.vaBefore} → ${trail.vaAfter}；本文分頁「${trail.tabBefore}」→「${trail.tabAfter}」`);
    ok('breadcrumb 也顯示目前節點的 siblings（目前這一個突顯）',
      trail.sibCount > 1 && !!trail.sibCur && trail.sibLabels.includes(trail.sibCur),
      `${trail.sibCount} 個同層：${JSON.stringify(trail.sibLabels)}…｜目前＝${JSON.stringify(trail.sibCur)}（完整 ${JSON.stringify(trail.sibFull)}）`);
    ok('breadcrumb 短標籤：有分隔符取前面那段，沒有就最多 5 個字',
      trail.shortOk === true,
      `路徑 ${JSON.stringify(trail.trail0)}／同層 ${JSON.stringify(trail.sibLabels)}`);
    ok('點 sibling 晶片 → 本文換到那一節',
      !!trail.chipLabel && trail.vaPicked !== trail.vaBeforeChip && trail.tabPicked === trail.chipFull,
      `點「${trail.chipLabel}」（完整「${trail.chipFull}」）→ 本文分頁「${trail.tabPicked}」，VA ${trail.vaBeforeChip} → ${trail.vaPicked}`);
    ok('breadcrumb 點「書」→ 下拉所有書，active 是本文所屬那一本',
      trail.bookCount > 1 && trail.bookActive === trail.bookLabel,
      `${trail.bookCount} 本 ${JSON.stringify(trail.bookLabels)}…｜active=${JSON.stringify(trail.bookActive)}`);
    ok('breadcrumb 下拉不節略（完整標籤、沒有 ellipsis）',
      trail.menuTextOverflow !== 'ellipsis' && trail.menuClipped === 0
      && Math.max(...trail.menuLabels.map((s: string) => [...s].length)) >= 5,
      `${trail.bookCount} 項、text-overflow=${trail.menuTextOverflow}、被截斷 ${trail.menuClipped} 項、`
      + `最長 ${Math.max(...trail.menuLabels.map((s: string) => [...s].length))} 字`);
  }

  // ---- 檔頭的 VA 屬於這一個檔（作者 2026-10-22）----
  // 節點的 vaEnd 是「下一個同層標題」的 VA，而 <檔> 的開標籤佔 4 個 VA：每一冊最後
  // 一串節點都會跨進下一冊的檔頭。照範圍判定時，本文 realm 從檔頭開始（摘要點命中、
  // 文件清單都是整個 <檔> 的 realm）breadcrumb 就會說成「前一本書」—— yinshun 搜「彗」：
  // 目錄標在華雨集第二冊（正確），本文上方卻說華雨集第一。
  // 這裡直接開最後一本書的整個 <檔>（`showLine`，與文件清單同一條路）：breadcrumb
  // 至少要有**一個節點落在這一個檔裡面**（目前這一節）；前一本書的節點全部在 realm 之前。
  const headCrumb = await cdp.eval<any>(`
    (async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const st = () => window.__accelon26.state();
      window.__accelon26.showTab('dir', 'left');
      if (!document.querySelector('#dirTree .tRow')) return { skipped: true, why: '沒有目錄樹' };
      if ((st().docs ?? 0) < 2) return { skipped: true, why: '單一 <檔> 的庫，沒有檔界' };
      await window.__accelon26.growTree();
      const rows = [...document.querySelectorAll('#dirTree .tRow')].map((r) => ({
        va: Number(r.dataset.va),
        tag: r.querySelector('.tTag')?.textContent ?? '',
        name: r.querySelector('.tName')?.textContent ?? '',
      }));
      const rootTag = rows[0]?.tag ?? '';
      const books = rows.filter((r) => r.tag === rootTag && r.name);
      const last = books[books.length - 1] ?? null;
      if (!last) return { skipped: true, why: '沒有第一層節點' };
      // 整個 <檔> 的 realm：檔頭在第一個標題之前
      await window.__accelon26.showLine(0, last.va);
      await sleep(1400);
      const realm = st().docRealm;
      if (!realm) return { skipped: true, why: '本文沒有 realm' };
      const label = (el) => ((el.title ?? '').match(/「(.*)」/) ?? [])[1] ?? el.textContent.replace(/[▾▸]/g, '').trim();
      const nav = [...document.querySelectorAll('#docTrail .trail, #docTrail .trailSib')];
      if (!nav.length) return { skipped: true, why: 'breadcrumb 是空的（同層只有自己）' };
      const trail = nav.map(label);
      const navVas = nav.map((el) => Number(el.dataset.va));
      // 目前節點（breadcrumb 的 self）必須在這一個檔裡面；祖先可能跨檔（一本書橫跨兩冊）
      const inside = navVas.some((v) => v >= realm.from && v < realm.to);
      return { skipped: false, last: last.name, realm, trail, navVas, inside };
    })()
  `);
  if (headCrumb.skipped) {
    console.log(`      （${headCrumb.why}，略過檔頭 breadcrumb 的檢查）`);
  } else {
    ok('本文 realm 是整個 <檔> 時，breadcrumb 指著這一個檔的節點（不是前一本書）',
      headCrumb.inside === true,
      `開最後一本「${headCrumb.last}」的 <檔> realm ${headCrumb.realm.from}..${headCrumb.realm.to}｜`
      + `breadcrumb ${JSON.stringify(headCrumb.trail)}（VA ${JSON.stringify(headCrumb.navVas)}）`);
  }

  // ---- 原書分行（作者 2026-10）：關閉時不保留硬換行、<頁> 變行內頁碼、關鍵字在渲染前塗好 ----
  const reflow = await cdp.eval<any>(`
    (async () => {
      const wait = async (fn, n = 90) => { for (let i = 0; i < n; i++) { if (fn()) return true; await new Promise(r => setTimeout(r, 200)); } return false; };
      const st = () => window.__accelon26.state();
      const box = document.querySelector('#showHardBreaks');
      const boxShown = getComputedStyle(document.querySelector('#hbToggle')).display !== 'none';
      const before = {
        hard: window.__accelon26.hardBreaksOn(),
        pages: document.querySelectorAll('#docText .pageBreak').length,
        paras: document.querySelectorAll('#docText .docPara').length,
        lines: document.querySelectorAll('#docText .docLine').length,
      };
      box.checked = false;
      box.dispatchEvent(new Event('change'));
      await wait(() => window.__accelon26.hardBreaksOn() === false && document.querySelectorAll('#docText .docPara').length > 0);
      await new Promise(r => setTimeout(r, 500));
      const firstLine = document.querySelector('#docText .docLine');
      const after = {
        hard: window.__accelon26.hardBreaksOn(),
        pages: document.querySelectorAll('#docText .pageBreak').length,
        marks: document.querySelectorAll('#docText .pageMark').length,
        paras: document.querySelectorAll('#docText .docPara').length,
        lines: document.querySelectorAll('#docText .docLine').length,
        display: firstLine ? getComputedStyle(firstLine).display : '',
        whiteSpace: firstLine ? getComputedStyle(firstLine.querySelector('.lineText') ?? firstLine).whiteSpace : '',
        stored: localStorage.getItem('accelon26.hardbreaks'),
        stateFlag: st().hardBreaks,
      };
      // 多詞組查詢 → 關鍵字在渲染前就包成 <mark class="kw">（不靠事後在 DOM 找字）
      const q = document.querySelector('#query');
      const pair = st().db === '13j' ? '乾 元' : '佛 法';
      q.value = pair;
      q.dispatchEvent(new Event('input'));
      await wait(() => st().searchQuery === pair);
      await new Promise(r => setTimeout(r, 1600));
      document.querySelector('#searchList .snippet')?.click();
      await wait(() => document.querySelectorAll('#docText mark.kw').length > 0, 60);
      const kw = {
        count: document.querySelectorAll('#docText mark.kw').length,
        hues: [...new Set([...document.querySelectorAll('#docText mark.kw')].map((m) => m.style.getPropertyValue('--hue')))],
        texts: [...new Set([...document.querySelectorAll('#docText mark.kw')].map((m) => m.textContent))].slice(0, 4),
      };
      q.value = '';
      q.dispatchEvent(new Event('input'));
      await new Promise(r => setTimeout(r, 600));
      box.checked = true;
      box.dispatchEvent(new Event('change'));
      await wait(() => window.__accelon26.hardBreaksOn() === true);
      await new Promise(r => setTimeout(r, 400));
      const back = {
        hard: window.__accelon26.hardBreaksOn(),
        pages: document.querySelectorAll('#docText .pageBreak').length,
        paras: document.querySelectorAll('#docText .docPara').length,
      };
      return { boxShown, before, after, kw, back };
    })()
  `);
  ok('「原書分行」開關在工具列上（預設開）',
    reflow.boxShown === true && reflow.before.hard === true && reflow.before.pages > 0,
    `顯示=${reflow.boxShown}、預設=${reflow.before.hard}、頁分隔 ${reflow.before.pages} 個`);
  ok('原書分行關閉：不保留硬換行（<p> 連排、行內 span），<頁> 變行內頁碼',
    reflow.after.hard === false && reflow.after.pages === 0 && reflow.after.paras > 0
    && reflow.after.display === 'inline' && reflow.after.whiteSpace === 'normal'
    && reflow.after.marks > 0 && reflow.after.stored === '0' && reflow.after.stateFlag === false,
    `段落 ${reflow.after.paras}、行 ${reflow.after.lines}、頁碼 ${reflow.after.marks}、display=${reflow.after.display}、white-space=${reflow.after.whiteSpace}`);
  ok('原書分行關閉時：關鍵字在渲染前就塗好（mark.kw、每個詞組一色）',
    reflow.kw.count > 0 && reflow.kw.hues.length === 2,
    `${reflow.kw.count} 個 kw、hues=${JSON.stringify(reflow.kw.hues)}、texts=${JSON.stringify(reflow.kw.texts)}`);
  ok('再把原書分行打開：回到硬換行（頁分隔回來）',
    reflow.back.hard === true && reflow.back.pages > 0 && reflow.back.paras === 0,
    `頁分隔 ${reflow.back.pages} 個、段落 ${reflow.back.paras}`);

  // 詞典型 adb（作者 2026-10）：<集 c="isdict"> 或 $詞 樹 → 本文不顯示 docHead，
  // 免得「詞條名稱」在分頁標題、docHead、命中塗紅裡出現三次
  const dictHead = await cdp.eval<{ dict: boolean; docHead: number; tab: string; headword: string }>(`
    (async () => {
      const st = window.__accelon26.state();
      return {
        dict: st.dict === true,
        docHead: document.querySelectorAll('#docText .docHead').length,
        tab: st.docTabs[st.docTab]?.name ?? '',
        headword: (document.querySelector('#docText .docBody')?.textContent ?? '').trim().slice(0, 16),
      };
    })()
  `);
  ok('詞典型 adb 不顯示 docHead（一般文本照常顯示）',
    dictHead.docHead === (dictHead.dict ? 0 : 1),
    `dict=${dictHead.dict}、docHead ${dictHead.docHead} 個、分頁「${dictHead.tab}」、內文開頭「${dictHead.headword}」`);

  // ---- 右欄「詞典」分頁（作者 2026-10）：點本文 → 開頭模式查詞條（長的在前）→ 點詞條看正文
  const dictPane = await cdp.eval<any>(`
    (async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const tabBtn = document.querySelector('#colRight .tabBtn[data-tab="dict"]');
      const hasTab = !!tabBtn;
      const st0 = window.__accelon26.dictPaneState();
      const isDict = window.__accelon26.state().dict === true;
      let rows = [];
      let body = '';
      let clickTarget = '';
      if (isDict) {
        // 用本文裡真的字去查（比丘尼戒 → 比丘／比丘尼）
        await window.__accelon26.dictLookupAt('比丘尼戒');
        await sleep(2500);
        const st = window.__accelon26.dictPaneState();
        rows = st.rows.map((r, i) => ({ db: r.db, label: r.label, len: [...r.label].length }));
        body = (document.getElementById('dictBody')?.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 40);
        // 點第二個詞條（比丘）→ 下方換成它的正文
        const items = [...document.querySelectorAll('#dictList .dictItem')];
        clickTarget = items[1]?.textContent.replace(/\\s+/g, ' ').trim() ?? '';
        items[1]?.click();
        await sleep(2000);
        body = (document.getElementById('dictBody')?.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 40);
      } else {
        await window.__accelon26.dictLookupAt('象曰');
        await sleep(1200);
        body = document.getElementById('dictList')?.textContent?.trim().slice(0, 40) ?? '';
      }
      return {
        hasTab, isDict, rows, body, clickTarget,
        tabShown: getComputedStyle(tabBtn).display !== 'none',
        indexes: st0.indexes,
        active: window.__accelon26.dictPaneState().active,
      };
    })()
  `);
  ok('右欄有「詞典」分頁（上半詞條清單、下半詞條正文）',
    dictPane.hasTab === true && dictPane.tabShown === true
    && await cdp.eval<boolean>(`!!document.getElementById('dictList') && !!document.getElementById('dictBody')`),
    `tab=${dictPane.hasTab}、顯示=${dictPane.tabShown}`);
  // 版面不變式（作者 2026-10-18）：一欄同時只能有一個 tabPane 畫出來。
  // 這條會抓到「某個分頁的 CSS 不小心把 display 寫死」——詞典分頁就這樣在別的分頁
  // active 時也畫在下面（`.tabPane[data-tab="dict"] { display:flex }` 優先度蓋掉
  // `.tabPane { display:none }`），畫面上是一片多出來、沒有標題的內容。
  const paneInvariant = JSON.parse(await cdp.eval<string>(`(() => {
    const out = {};
    for (const col of ['#colLeft', '#colRight']) {
      out[col] = [...document.querySelectorAll(col + ' .tabPane')]
        .filter((p) => getComputedStyle(p).display !== 'none')
        .map((p) => p.dataset.tab);
    }
    return JSON.stringify(out);
  })()`)) as Record<string, string[]>;
  const multiShown = Object.entries(paneInvariant).filter(([, v]) => v.length > 1);
  ok('一欄同時只顯示一個分頁（其餘 display:none）', multiShown.length === 0,
    Object.entries(paneInvariant).map(([k, v]) => `${k}=[${v.join(',')}]`).join(' '));
  if (dictPane.isDict) {
    const lens = dictPane.rows.map((r: any) => r.len);
    const labels = dictPane.rows.map((r: any) => r.label);
    ok('詞典：點「比丘尼戒」→ 開頭模式的詞條（比丘／比丘尼），長的先列',
      labels.includes('比丘') && labels.includes('比丘尼')
      && lens.every((n: number, i: number) => i === 0 || lens[i - 1] >= n),
      `詞條 ${JSON.stringify(labels)}（長度 ${JSON.stringify(lens)}）`);
    ok('詞典：點一個詞條 → 下方顯示它的正文',
      dictPane.body.length > 10 && /比丘/.test(dictPane.body),
      `點「${dictPane.clickTarget}」→ 正文「${dictPane.body}」`);
    // 作者 2026-10 的三個邊界：順世（詞條只有 順世外道）、般若經（不該帶出 般若經十喻）、
    // 點詞條後的「開頭／結尾」兩份親戚清單
    const dictEdges = await cdp.eval<any>(`
      (async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const st = () => window.__accelon26.dictPaneState();
        const look = async (t) => { await window.__accelon26.dictLookupAt(t); await sleep(1200); return st(); };
        const shun = await look('順世者的斷見');
        const bor = await look('般若經');
        const labels = bor.rows.map((r) => r.label);
        let start = [];
        let end = [];
        if (labels.includes('般若')) {
          const i = labels.indexOf('般若');
          [...document.querySelectorAll('#dictList .dictItem')][i]?.click();
          await sleep(1500);
          start = st().relatives.map((r) => r.label);
          [...document.querySelectorAll('#dictBody .dictMoreTab')].find((e) => e.dataset.kind === 'end')?.click();
          await sleep(1200);
          end = st().relatives.map((r) => r.label);
        }
        return {
          shun: shun.rows.map((r) => r.label),
          labels, start: start.slice(0, 4), end: end.slice(0, 4),
          tabs: [...document.querySelectorAll('#dictBody .dictMoreTab')].map((e) => e.textContent.trim()),
        };
      })()
    `);
    ok('詞典：詞條只有「順世外道」時，點「順世」也找得到（退回開頭匹配）',
      dictEdges.shun.includes('順世外道'),
      `詞條 ${JSON.stringify(dictEdges.shun)}`);
    ok('詞典：點「般若經」只配到「般若」，不會帶出「般若經十喻」',
      dictEdges.labels.length === 0
        ? false
        : dictEdges.labels.includes('般若') && !dictEdges.labels.some((l: string) => l.startsWith('般若經')),
      `詞條 ${JSON.stringify(dictEdges.labels)}`);
    ok('詞典：點詞條後有「開頭／結尾」兩份親戚清單（般若經十喻 排在 般若學 前面）',
      dictEdges.tabs.join(',') === '開頭,結尾'
      && dictEdges.start.includes('般若經典') && dictEdges.start.includes('般若經十喻')
      && dictEdges.start.indexOf('般若經十喻') < dictEdges.start.indexOf('般若學')
      && dictEdges.end.every((l: string) => l.endsWith('般若')),
      `開頭 ${JSON.stringify(dictEdges.start)}…｜結尾 ${JSON.stringify(dictEdges.end)}…`);
  } else {
    ok('非詞典型 adb：詞典分頁說明「沒有詞典型 adb」',
      /沒有詞典型 adb/.test(dictPane.body), `「${dictPane.body}」`);
  }

  // 設置頁「顯示原書頁碼」（作者 2026-10）：決定 <頁>／<_頁> 要不要渲染
  const pageMarks = await cdp.eval<any>(`
    (async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const count = () => ({
        breaks: document.querySelectorAll('#docText .pageBreak').length,
        marks: document.querySelectorAll('#docText .pageMark').length,
        pane: document.querySelectorAll('#textBody .pageBreak, #textBody .pageMark').length,
      });
      window.__accelon26.openSettings();
      await sleep(300);
      const box = document.getElementById('setPageMarks');
      const inInterface = !!box?.closest('section.setSection')?.querySelector('h3')?.textContent.includes('介面');
      const defaultOn = window.__accelon26.pageMarksOn();
      const on = count();
      // 關 → 完全不渲染（硬換行模式：頁分隔不見）
      box.checked = false;
      box.dispatchEvent(new Event('change'));
      await sleep(500);
      const off = count();
      const storedOff = localStorage.getItem('accelon26.pagemarks');
      // 開回來 → 頁分隔回來
      box.checked = true;
      box.dispatchEvent(new Event('change'));
      await sleep(500);
      const back = count();
      // 連排模式：頁碼是行內 .pageMark，也要一起消失
      const hb = document.getElementById('showHardBreaks');
      hb.checked = false; hb.dispatchEvent(new Event('change'));
      await sleep(500);
      const reflowOn = count();
      box.checked = false; box.dispatchEvent(new Event('change'));
      await sleep(500);
      const reflowOff = count();
      box.checked = true; box.dispatchEvent(new Event('change'));
      hb.checked = true; hb.dispatchEvent(new Event('change'));
      await sleep(500);
      const storedOn = localStorage.getItem('accelon26.pagemarks');
      window.__accelon26.closeSettings();
      return { inInterface, defaultOn, on, off, back, reflowOn, reflowOff, storedOff, storedOn, hint: box.closest('label')?.textContent ?? '' };
    })()
  `);
  ok('設置頁「顯示原書頁碼」在「介面」區，預設開啟',
    pageMarks.inInterface === true && pageMarks.defaultOn === true,
    `在介面區=${pageMarks.inInterface}、預設=${pageMarks.defaultOn}`);
  ok('關閉「顯示原書頁碼」：<頁>／<_頁> 完全不渲染（原書分行模式）',
    pageMarks.on.breaks > 0 && pageMarks.off.breaks === 0 && pageMarks.off.pane === 0
    && pageMarks.back.breaks === pageMarks.on.breaks && pageMarks.storedOff === '0' && pageMarks.storedOn === '1',
    `頁分隔 ${pageMarks.on.breaks} → ${pageMarks.off.breaks} → ${pageMarks.back.breaks}（右欄頁碼 ${pageMarks.off.pane}）`);
  ok('關閉「顯示原書頁碼」：連排模式的行內頁碼也消失',
    pageMarks.reflowOn.marks > 0 && pageMarks.reflowOff.marks === 0 && pageMarks.reflowOff.breaks === 0,
    `行內頁碼 ${pageMarks.reflowOn.marks} → ${pageMarks.reflowOff.marks}`);

  // 目錄的 meta 列只有進階模式才顯示；再點一次 active 的「目錄」分頁＝收合所有子孫
  if (dirTabShown) {
    const metaAdv = await cdp.eval<any>(`
      (async () => {
        const st = () => window.__accelon26.state();
        const meta = () => document.getElementById('dirMeta');
        const wait = (ms) => new Promise(r => setTimeout(r, ms));
        window.__accelon26.setAdvanced(false);
        await wait(500);
        const off = { hidden: meta().hidden, len: meta().textContent.trim().length, display: getComputedStyle(meta()).display };
        window.__accelon26.setAdvanced(true);
        await wait(800);
        const on = { hidden: meta().hidden, text: meta().textContent.slice(0, 40), display: getComputedStyle(meta()).display };
        const tab = document.querySelector('#colLeft .tabBtn[data-tab="dir"]');
        tab?.click();                                  // 確定它是 active
        await wait(300);
        const roots = st().dirInfo?.roots ?? 0;
        const tw = document.querySelector('#dirTree .tTwisty');
        if (tw && tw.textContent.trim() === '▸') { tw.click(); await wait(700); }
        const expanded = document.querySelectorAll('#dirTree .tRow').length;
        tab?.click();                                  // 再點一次 → 全部收合
        await wait(700);
        const collapsed = document.querySelectorAll('#dirTree .tRow').length;
        const openTwisties = [...document.querySelectorAll('#dirTree .tTwisty')].filter((t) => t.textContent.trim() === '▾').length;
        window.__accelon26.setAdvanced(false);
        await wait(400);
        return { off, on, roots, expanded, collapsed, openTwisties };
      })()
    `);
    ok('目錄 meta 只在進階模式顯示',
      metaAdv.off.hidden === true && metaAdv.off.len === 0 && metaAdv.on.hidden === false && metaAdv.on.text.length > 0,
      `一般：hidden=${metaAdv.off.hidden} display=${metaAdv.off.display}｜進階：「${metaAdv.on.text}」`);
    ok('再點一次 active 的目錄分頁 → 整棵樹只剩第一層',
      metaAdv.collapsed === metaAdv.roots && metaAdv.expanded > metaAdv.roots && metaAdv.openTwisties === 0,
      `展開 ${metaAdv.expanded} 列 → 收合 ${metaAdv.collapsed} 列（第一層 ${metaAdv.roots} 個，還開著的分支 ${metaAdv.openTwisties}）`);
  }

  // 每一本書都能展開（只有第一本帶 t=，其餘用標籤層級預設），且點書（的節點記號）會跳到該 <書> 所在行
  const everyBook = await cdp.eval<{ expandable: number; total: number; clicked: string; line: string | null; status: string; bookLabels: string[] }>(`
    (async () => {
      await window.__accelon26.growTree();     // 列是 lazy 掛上的：這一組要看整棵樹
      const rows = () => [...document.querySelectorAll('#dirTree .tRow')];
      const bookRows = rows().filter((r) => r.querySelector('.tTag')?.textContent === '書');
      // a row is expandable when it shows a twisty at all (▸ collapsed / ▾ open)
      const expandable = bookRows.filter((r) => ['▸', '▾'].includes(r.querySelector('.tTwisty')?.textContent.trim())).length;
      const bookLabels = bookRows.map((r) => r.querySelector('.tName')?.textContent ?? '');
      // expand the second book and click one of its chapters
      const second = bookRows[1];
      second?.querySelector('.tTwisty')?.click();
      await new Promise(r => setTimeout(r, 800));
      const after = rows();
      const target = after[after.indexOf(second) + 1];
      const label = target?.querySelector('.tName')?.textContent ?? '';
      (target?.querySelector('.tDot') ?? target)?.click();
      for (let i = 0; i < 40; i++) {
        if (document.querySelector('#docText .hitLine')) break;
        await new Promise(r => setTimeout(r, 200));
      }
      return {
        expandable, total: bookRows.length, clicked: label, bookLabels,
        db: window.__accelon26.state().db,
        line: document.querySelector('#docText .hitLine')?.id ?? null,
        status: document.querySelector('#status').textContent.slice(0, 60),
      };
    })()
  `);
  // The book count differs per database (13j: 13, yinshun: 44). 13j's 書 elements
  // are headings whose title is the id; yinshun's are containers holding the title
  // first, and its LATER 書 elements are metadata (publisher, edition, dates), so
  // only the leading block is required to be free of the occurrence-number fallback.
  const fallbacks = everyBook.bookLabels.filter((s) => /^#\d+$/.test(s)).length;
  // the book count belongs to the database (13j 13, yinshun 44, fgdict 7)
  const wantBooks = ({ '13j': 13, yinshun: 44, fgdict: 7 } as Record<string, number>)[everyBook.db ?? ''] ?? 1;
  ok('每本書都有名字', !dirTabShown || (everyBook.bookLabels.length >= wantBooks && everyBook.bookLabels.every((s) => !!s && !!s.trim())),
    `${everyBook.bookLabels.length} 本（${everyBook.db}），其中 ${fallbacks} 個用編號 fallback`);
  ok('主要書名都解析出來（前 10 本無 #N fallback）',
    !dirTabShown || everyBook.bookLabels.slice(0, 10).every((s) => !!s && !/^#\d+$/.test(s)),
    `${JSON.stringify(everyBook.bookLabels.slice(0, 5))} … ${JSON.stringify(everyBook.bookLabels.slice(-2))}`);
  // A book whose range holds no child tier at all is legitimately a leaf, so the
  // requirement is that the great majority expand (13j 13/13 after the inherited
  // slot fix; yinshun 43/44).
  ok('絕大多數書都能展開（範圍內沒有子層的書是葉節點）',
    !dirTabShown || everyBook.expandable >= everyBook.total - 1,
    `${everyBook.expandable}/${everyBook.total} 本可展開`);
  ok('點目錄節點跳到該位置的本文', !dirTabShown || !!everyBook.line, `點「${everyBook.clicked}」→ 行 ${everyBook.line}；${everyBook.status}`);

  // 目錄節點顯示「該節點 realm 內的命中數」（用 posting 的 VA 與節點範圍算）
  const realm = await cdp.eval<{ total: number; badges: number[]; first: number; rows: number }>(`
    (async () => {
      const q = document.querySelector('#query');
      const word = window.__accelon26.state().db === '13j' ? '象曰' : '大乘';
      q.value = word;
      q.dispatchEvent(new Event('input'));
      // 上一次查詢的徽章還在畫面上：要等「這一次」的搜尋真的落地再點，
      // 否則那個點擊屬於舊結果，新結果一到約束就被取消（＝新的規則）。
      for (let i = 0; i < 60; i++) {
        if (window.__accelon26.state().searchQuery === word && document.querySelector('#dirTree .tCount.hit')) break;
        await new Promise(r => setTimeout(r, 250));
      }
      const badges = [...document.querySelectorAll('#dirTree .tCount.hit')]
        .map(e => Number(e.textContent.replace(/,/g, '')));
      const meta = document.querySelector('#searchMeta').textContent;
      const total = Number(((meta.match(/([0-9,]+) 筆/) ?? [])[1] ?? '0').replace(/,/g, ''));
      return {
        total, badges, first: badges[0] ?? 0,
        rows: document.querySelectorAll('#dirTree .tRow').length,
      };
    })()
  `);
  // Rows are NOT disjoint (a book's realm contains its chapters'), so the badges
  // must not be summed; each one is checked against the search total instead.
  ok('目錄節點顯示 realm 內命中數',
    !dirTabShown || (realm.first > 0 && realm.badges.every((b) => b > 0 && b <= realm.total)),
    `第一個節點 ${realm.first}、總命中 ${realm.total}（${realm.rows} 列，最大 ${Math.max(...realm.badges)}）`);

  // 點 tCount > 顯示該節點命中的摘要（摘要範圍限在該節點 realm 內，本文不動）
  const badgeClick = await cdp.eval<{
    badge: number; metaOk: boolean; maxVa: number; minVa: number; to: number; from: number; snippets: number; meta: string; scoped: boolean;
  }>(`
    (async () => {
      const hitBadgeEl = document.querySelector('#dirTree .tCount.hit');
      // 沒有 s="*" 的庫沒有目錄樹（作者 2026-10）→ 沒有徽章可點
      if (!hitBadgeEl) return { skipped: true, badge: 0, metaOk: true, minVa: 0, maxVa: 0, to: 0, from: 0, snippets: 1, meta: '', scoped: true };
      hitBadgeEl.scrollIntoView({ block: 'center' });
      const badge = Number(hitBadgeEl.textContent.replace(/,/g, ''));
      document.querySelector('#dirTree .tCount.hit').click();
      // the scoped summary may be rebuilt by a debounced re-search of the SAME
      // query, so let it settle before reading the pane
      let scoped = false;
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 100));
        if (window.__accelon26.state().snippetScope) scoped = true;
      }
      const st = window.__accelon26.state();
      const meta = document.querySelector('#searchMeta').textContent;
      const v = [...document.querySelectorAll('#searchList .snippet')].map((e) => Number(e.dataset.va));
      return {
        badge, metaOk: /範圍內/.test(meta),
        minVa: v.length ? Math.min.apply(null, v) : -1,
        maxVa: v.length ? Math.max.apply(null, v) : -1,
        from: st.snippetScope ? st.snippetScope.from : -1,
        to: st.snippetScope ? st.snippetScope.to : -1,
        snippets: v.length,
        meta: meta.slice(0, 60),
        scoped,
      };
    })()
  `);
  ok('點命中數：摘要切成該節點的命中',
    !dirTabShown || (badgeClick.scoped && badgeClick.metaOk && badgeClick.snippets > 0
    && badgeClick.minVa >= badgeClick.from && badgeClick.maxVa < badgeClick.to),
    dirTabShown
      ? `徽章 ${badgeClick.badge}、${badgeClick.snippets} 筆摘要落在 [${badgeClick.from}, ${badgeClick.to})｜${badgeClick.meta}`
      : '此庫沒有目錄樹（沒有 s="*"）→ 不適用');

  // 點命中數＝摘要只看該節點 realm；**重新輸入不同的詞 → 這個約束取消**（作者 2026-10）。
  // 這裡同時是「scope 屬於產生結果的那個查詢」的回歸：若用輸入框當下的文字當 scope 的
  // 查詢，一個在新查詢還在飛時按下的命中數會把新文字認成同一個查詢，約束就黏住了。
  const rescope = await cdp.eval<{
    skipped: boolean; scoped: boolean; from: number; to: number; scopeAfter: boolean;
    shown: number; word: string; meta: string; head: string;
  }>(`
    (async () => {
      const dirTab = document.querySelector('#colLeft .tabBtn[data-tab="dir"]');
      if (!dirTab || getComputedStyle(dirTab).display === 'none') {
        return { skipped: true, scoped: false, from: -1, to: -1, scopeAfter: false, shown: 0, word: '', meta: '', head: '' };
      }
      const q = document.querySelector('#query');
      const db = window.__accelon26.state().db;
      const restore = q.value;          // 這一組會換詞，離開前要放回去
      const first = db === '13j' ? '象曰' : '大乘';
      const second = db === '13j' ? '孟子' : '涅槃';
      // 1) 先讓摘要縮到某一棵樹節點的 realm
      q.value = first;
      q.dispatchEvent(new Event('input'));
      for (let i = 0; i < 40; i++) { if (document.querySelector('#dirTree .tCount.hit')) break; await new Promise(r => setTimeout(r, 250)); }
      document.querySelector('#dirTree .tCount.hit')?.click();
      let from = -1, to = -1;
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 200));
        const sc = window.__accelon26.state().snippetScope;
        if (sc) { from = sc.from; to = sc.to; break; }
      }
      const head = document.querySelector('#searchMeta').textContent.slice(0, 40);
      // 2) 換一個詞 → 約束必須消失，摘要回到整個結果
      q.value = second;
      q.dispatchEvent(new Event('input'));
      for (let i = 0; i < 60; i++) { await new Promise(r => setTimeout(r, 250)); if (!window.__accelon26.state().snippetScope) break; }
      await new Promise(r => setTimeout(r, 500));
      const st = window.__accelon26.state();
      const out = { skipped: false, scoped: from >= 0 && to > from, from, to,
        scopeAfter: !!st.snippetScope, shown: document.querySelectorAll('#searchList .snippet').length,
        word: second, meta: document.querySelector('#searchMeta').textContent.slice(0, 60), head };
      // put the box back: the next block compares badges between two words
      q.value = restore;
      q.dispatchEvent(new Event('input'));
      await new Promise(r => setTimeout(r, 800));
      return out;
    })()
  `);
  ok('重新輸入不同的詞 → 「只看該節點」的摘要約束取消',
    rescope.skipped || (rescope.scoped && !rescope.scopeAfter && rescope.shown > 0 && !/範圍內/.test(rescope.meta)),
    rescope.skipped ? '此庫沒有目錄樹（沒有 s="*"）→ 不適用'
      : `先縮到 [${rescope.from}, ${rescope.to})（${rescope.head}），輸入「${rescope.word}」後 scope=${rescope.scopeAfter}、摘要 ${rescope.shown} 筆｜${rescope.meta}`);

  // 聯動本文的動作：Ctrl+點樹節點 → 送到右欄「文字內容」（中間本文不動，2026-10 作者指定）；
  // Alt+點 → 展開全部子孫（舊版是 Ctrl）
  const clicks = await cdp.eval<{
    tabNew: number; tabSame: number; tabAfterPages: number; altExpands: boolean;
    nodeOpens: boolean; ctrlKept: boolean; ctrlToText: boolean; ctrlRows: number; ctrlBook: string; ctrlWasOpen: boolean;
    textNew: number; textLines: number; textTab: string | null;
    before: number; after: number; label: string; dotLine: string | null; dotStatus: string;
  }>(`
    (async () => {
      await window.__accelon26.growTree();     // 列是 lazy 掛上的：這一組要看整棵樹
      const rows = () => [...document.querySelectorAll('#dirTree .tRow')];
      const books = () => rows().filter((r) => r.querySelector('.tTag')?.textContent === '書');
      // 沒有 s="*" 的庫沒有目錄樹 → 這一組（點節點／Ctrl／Alt）整組跳過
      if (!books().length) {
        return { skipped: true, tabNew: 0, tabSame: 0, tabAfterPages: 0, altExpands: true, nodeOpens: true,
          ctrlKept: true, ctrlToText: true, ctrlRows: 0, ctrlBook: '', ctrlWasOpen: false,
          textNew: 0, textLines: 0, textTab: null, before: 0, after: 0, label: '', dotLine: null, dotStatus: '' };
      }
      const spec = () => window.__accelon26.state().docTabs.length;
      const settle = async () => {
        for (let i = 0; i < 30; i++) {
          await new Promise((r) => setTimeout(r, 200));
          if (document.querySelector('#docText .docLine.hitLine') && window.__accelon26.state().pinned) return;
        }
      };
      // fold every book first, so one click opens exactly one
      for (const b of books()) {
        if (b.querySelector('.tTwisty').textContent.trim() === '▾') {
          b.querySelector('.tTwisty').click();
          await new Promise((r) => setTimeout(r, 300));
        }
      }
      const before = rows().length;
      const beforeTabs = spec();
      books()[0].querySelector('.tDot').click();
      await settle();
      const after = rows().length;
      const tabSame = spec() - beforeTabs;
      const nodeOpens = after > before && !!document.querySelector('#docText .docLine.hitLine');
      // Ctrl+點：把該節點的文字放到右欄「文字內容」；中間本文完全不動
      const beforeCtrlTabs = spec();
      const beforeText = window.__accelon26.state().text.tabs.length;
      const target = books()[books().length - 1];
      target.querySelector('.tName').dispatchEvent(new MouseEvent('click', { ctrlKey: true, bubbles: true }));
      // the text pane reads its own page asynchronously: poll for the tab
      for (let i = 0; i < 40; i++) {
        if (window.__accelon26.state().text.tabs.length > beforeText) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      for (let i = 0; i < 30; i++) {
        if (document.querySelectorAll('#textBody .docLine').length > 0) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      const tabNew = spec() - beforeCtrlTabs;
      const textNew = window.__accelon26.state().text.tabs.length - beforeText;
      const textLines = document.querySelectorAll('#textBody .docLine').length;
      const textTab = window.__accelon26.state().rightTab;
      // Ctrl+點箭頭不該展開全部子孫：把一本書打開後 Ctrl+點它的箭頭，應該收合
      // the tree is REBUILT on every toggle, so the row must be re-queried by VA (a held
      // element is detached and a dispatched event on it never reaches the tree)
      const b2va = books()[2]?.dataset.va;
      const rowFor = () => rows().find((r) => r.dataset.va === b2va);
      if (rowFor()?.querySelector('.tTwisty').textContent.trim() === '▸') {
        rowFor().querySelector('.tTwisty').click();
        await new Promise((r) => setTimeout(r, 800));
      }
      const b2 = rowFor();
      const ctrlWasOpen = b2.querySelector('.tTwisty').textContent.trim() === '▾';
      const openRows = rows().length;
      const ctrlBook = b2.querySelector('.tName')?.textContent ?? '?';
      const beforeTwistyText = window.__accelon26.state().text.tabs.length;
      b2.querySelector('.tTwisty').dispatchEvent(new MouseEvent('click', { ctrlKey: true, bubbles: true }));
      await new Promise((r) => setTimeout(r, 900));
      const ctrlRows = rows().length;
      // Ctrl+點箭頭同樣是「送到右欄」：既不展開也不收合（2026-10 作者指定）
      const ctrlKept = ctrlRows === openRows;
      const ctrlToText = window.__accelon26.state().text.tabs.length > beforeTwistyText;
      // Alt+點：展開全部子孫
      const collapsed = books().find((r) => r.querySelector('.tTwisty')?.textContent.trim() === '▸');
      const beforeAlt = rows().length;
      collapsed?.querySelector('.tName')?.dispatchEvent(new MouseEvent('click', { altKey: true, bubbles: true }));
      await new Promise((r) => setTimeout(r, 1500));
      const altExpands = rows().length > beforeAlt + 1;
      // 分頁標籤只是切換，不會再生分頁
      const beforeSwitch = spec();
      document.querySelectorAll('#docTabStrip .docTab').forEach((el) => el.click());
      await new Promise((r) => setTimeout(r, 600));
      const tabAfterPages = spec() - beforeSwitch;
      // 點節點色塊會聯動本文到該節點（狀態列會說出節點名，pinned VA 指向該節點）
      const db = window.__accelon26.state().db;
      const wanted = db === '13j' ? '尚書' : (books()[1]?.querySelector('.tName')?.textContent ?? '');
      const targetBook = books().find((r) => r.querySelector('.tName').textContent === wanted) ?? books()[1];
      const label = targetBook?.querySelector('.tName')?.textContent ?? '(none)';
      const nodeVa = Number(targetBook?.dataset.va ?? -1);
      const dot = targetBook?.querySelector('.tDot');
      dot?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 200));
        const st = window.__accelon26.state();
        if (st.pinned && st.pinned.va === nodeVa && document.querySelector('#docText .docLine.hitLine')) break;
      }
      const pinnedVa = window.__accelon26.state().pinned ? window.__accelon26.state().pinned.va : -1;
      return {
        tabNew, tabSame, tabAfterPages, altExpands, nodeOpens, ctrlKept, ctrlToText, ctrlRows, ctrlBook, ctrlWasOpen,
        textNew, textLines, textTab,
        before, after, label,
        nodeVa, pinnedVa,
        dotDbg: JSON.stringify({
          page: window.__accelon26.state().docPage, pages: window.__accelon26.state().docTabPages,
          realm: window.__accelon26.state().docRealm, tab: window.__accelon26.state().docTabs[window.__accelon26.state().docTab],
          first: document.querySelector('#docText .docLine')?.id,
          last: [...document.querySelectorAll('#docText .docLine')].pop()?.id,
          allTabs: window.__accelon26.state().docTabs,
        }),
        dotLine: document.querySelector('#docText .docLine.hitLine')?.id ?? null,
        dotStatus: document.querySelector('#status').textContent.slice(0, 70),
      };
    })()
  `);
  ok('點節點（開得起來就開）並聯動本文', !dirTabShown || clicks.nodeOpens,
    `${clicks.before} → ${clicks.after} 列，聯動到 ${clicks.dotLine}（新增 ${clicks.tabSame} 分頁）`);
  ok('Ctrl+點樹節點：文字送到右欄「文字內容」，中間本文不動',
    !dirTabShown || (clicks.tabNew === 0 && clicks.textNew === 1 && clicks.textLines > 0 && clicks.textTab === 'text'),
    `中間分頁 +${clicks.tabNew}、右欄文字分頁 +${clicks.textNew}（${clicks.textLines} 列，右欄在 ${clicks.textTab}）`);
  ok('Ctrl+點箭頭也是送到右欄（不展開、不收合）', !dirTabShown || (clicks.ctrlKept && clicks.ctrlToText),
    `Ctrl+點「${clicks.ctrlBook}」箭頭（原本 ${clicks.ctrlWasOpen ? '開' : '關'}）→ ${clicks.ctrlRows} 列（未變）、右欄 +${clicks.ctrlToText ? 1 : 0}`);
  ok('Alt+點節點名展開全部子孫', !dirTabShown || clicks.altExpands, `Alt+點後 ${clicks.altExpands}`);
  ok('切換本文分頁不會再生分頁', clicks.tabAfterPages === 0, `+${clicks.tabAfterPages}`);
  // The status names the DEEPEST node holding the VA, which in a dictionary is
  // often a page below the row that was clicked, so the strong check is the VA.
  ok('點色塊會聯動內文到該節點',
    !dirTabShown || (clicks.pinnedVa === clicks.nodeVa && !!clicks.dotLine),
    `點「${clicks.label}」的色塊 → 行 ${clicks.dotLine}（VA ${clicks.pinnedVa} / 節點 ${clicks.nodeVa}）；${clicks.dotStatus}｜${clicks.dotDbg}`);

  // 右欄「文字內容」分頁：Ctrl+點本文分頁＝複製、Shift+點＝搬移；右欄純參考，不連動左樹
  const textPane = await cdp.eval<{
    mid0: number; afterCopy: { mid: number; text: number }; afterMove: { mid: number; text: number };
    rightTab: string | null; lines: number; textTabLabels: string[];
    cursorBefore: unknown; cursorAfter: unknown; treeActiveBefore: number; treeActiveAfter: number;
  }>(`
    (async () => {
      const tabs = () => [...document.querySelectorAll('#docTabStrip .docTab')];
      const st = () => window.__accelon26.state();
      for (let i = 0; i < 10 && tabs().length < 2; i++) {
        document.getElementById('docTabAdd').click();
        await new Promise(r => setTimeout(r, 500));
      }
      const mid0 = tabs().length;
      tabs()[0].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
      for (let i = 0; i < 20; i++) { if (document.querySelectorAll('#textBody .docLine').length) break; await new Promise(r => setTimeout(r, 200)); }
      const afterCopy = { mid: tabs().length, text: st().text.tabs.length };
      tabs()[0].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true }));
      await new Promise(r => setTimeout(r, 700));
      const afterMove = { mid: tabs().length, text: st().text.tabs.length };
      // 右欄捲動不該連動左邊的樹（右欄純參考）
      const cursorBefore = st().cursorNode;
      const treeActiveBefore = document.querySelectorAll('#dirTree .tRow.active').length;
      const body = document.getElementById('textBody');
      body.scrollTop = 200;
      body.dispatchEvent(new Event('scroll'));
      await new Promise(r => setTimeout(r, 700));
      return { mid0, afterCopy, afterMove, rightTab: st().rightTab,
        lines: document.querySelectorAll('#textBody .docLine').length,
        textTabLabels: st().text.tabs.map((x) => x.label),
        cursorBefore, cursorAfter: st().cursorNode,
        treeActiveBefore, treeActiveAfter: document.querySelectorAll('#dirTree .tRow.active').length };
    })()
  `);
  ok('Ctrl+點本文分頁＝複製到右欄文字內容',
    textPane.afterCopy.mid === textPane.mid0 && textPane.afterCopy.text >= 1 && textPane.rightTab === 'text' && textPane.lines > 0,
    `中間 ${textPane.mid0} → ${textPane.afterCopy.mid} 分頁、右欄 ${textPane.afterCopy.text} 個文字分頁（${textPane.lines} 列）`);
  ok('Shift+點本文分頁＝搬到右欄（中間讓出那一個）',
    textPane.afterMove.mid === textPane.mid0 - 1 && textPane.afterMove.text >= textPane.afterCopy.text,
    `中間 ${textPane.afterCopy.mid} → ${textPane.afterMove.mid} 分頁、右欄 ${textPane.afterMove.text} 個（${JSON.stringify(textPane.textTabLabels)}）`);
  ok('右欄文字純參考：捲動它不連動左邊的樹',
    JSON.stringify(textPane.cursorAfter) === JSON.stringify(textPane.cursorBefore) && textPane.treeActiveAfter === textPane.treeActiveBefore,
    `cursorNode ${JSON.stringify(textPane.cursorBefore)} → ${JSON.stringify(textPane.cursorAfter)}、樹上 active ${textPane.treeActiveBefore} → ${textPane.treeActiveAfter}`);
  // 字級按鈕（作者 2026-10：點一下 +2px、超過 32 回 12、Alt+點 −2px）
  const rightFs = await cdp.eval<any>(`
    (async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const px = (sel) => { const el = document.querySelector(sel); return el ? parseFloat(getComputedStyle(el).fontSize) : -1; };
      const varPx = (name) => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
      const click = (id, alt = false) => document.getElementById(id).dispatchEvent(new MouseEvent('click', { altKey: alt, bubbles: true }));
      const icons = [...document.querySelectorAll('.fsPick.iconOnly .fsT')].map((s) => s.textContent.trim());
      const hasText = [...document.querySelectorAll('.fsPick.iconOnly')].some((l) => /[左右中欄正]/.test(l.firstChild?.textContent ?? ''));
      // 按鈕中心點的最上層元素必須「在按鈕裡面」——否則點了沒反應
      const hits = ['#fsLeftPick', '#fsBodyPick', '#fsRightPick'].map((sel) => {
        const btn = document.querySelector(sel);
        const box = btn.getBoundingClientRect();
        const el = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return { id: btn.id, inButton: !!el?.closest?.('button') && el.closest('button').id === btn.id };
      });
      const where = {
        left: !!document.querySelector('#colLeft #fsLeftPick'),
        body: !!document.querySelector('#docBar #fsBodyPick'),
        right: !!document.querySelector('#colRight #fsRightPick'),
      };
      // 已經沒有下拉選單了
      const noSelect = !document.querySelector('#fsBody, #fsLeft, #fsRight');
      // 作者 2026-10-18：每次調 1px
      const docStart = varPx('--fsdoc');
      click('fsBodyPick'); await sleep(150);
      const plus = varPx('--fsdoc') - docStart;
      // 一路點到超過 32 → 回 12
      let wrap = null;
      for (let i = 0; i < 48; i++) {
        const before = varPx('--fsdoc');
        click('fsBodyPick'); await sleep(60);
        const after = varPx('--fsdoc');
        if (before === 32 && after === 12) { wrap = [before, after]; break; }
      }
      // Alt+點：−1px，夾在 12（先把字級拉回 18 再往下點）
      while (varPx('--fsdoc') < 18) { click('fsBodyPick'); await sleep(60); }
      let minSeq = [];
      for (let i = 0; i < 12; i++) { click('fsBodyPick', true); await sleep(60); minSeq.push(varPx('--fsdoc')); }
      const atMin = varPx('--fsdoc');
      const title = document.getElementById('fsBodyPick').title;
      // 右欄按鈕：清單與正文跟著變，介面（分頁按鈕、欄位本身）不變
      const snap = () => ({
        list: px('#searchList'), dict: px('#dictList'), tab: px('#colLeft .tabBtn[data-tab="dir"]'),
        tabRight: px('#colRight .tabBtn[data-tab="sum"]'), col: px('#colRight'),
        text: px('#textBody .docBody'), mid: px('#docText .docBody'), right: varPx('--fs-right'),
      });
      const before = snap();
      click('fsRightPick'); await sleep(300);
      const after = snap();
      return { icons, hasText, hits, where, noSelect, plus, wrap, minSeq, atMin, title, before, after };
    })()
  `);
  ok('字級控制是「小 T／大 T」圖示、沒有文字標籤（也沒有下拉選單）',
    rightFs.icons.length === 3 && rightFs.icons.every((t: string) => t === 'TT')
    && rightFs.hasText === false && rightFs.noSelect === true,
    `圖示 ${JSON.stringify(rightFs.icons)}、有文字標籤=${rightFs.hasText}、還有 select=${rightFs.noSelect === false}`);
  ok('字級控制位置：左在左欄、中在本文工具列、右在右欄',
    rightFs.where.left === true && rightFs.where.body === true && rightFs.where.right === true,
    JSON.stringify(rightFs.where));
  ok('字級按鈕真的點得到（中心點最上層在按鈕裡面）',
    rightFs.hits.length === 3 && rightFs.hits.every((h: any) => h.inButton === true),
    JSON.stringify(rightFs.hits));
  ok('按一下字級 +1px（作者 2026-10-18：原本 +2）',
    rightFs.plus === 1, `+1 之後 --fsdoc = 前值 + ${rightFs.plus}px`);
  ok('加到超過 32px 就回到 12px',
    Array.isArray(rightFs.wrap) && rightFs.wrap[0] === 32 && rightFs.wrap[1] === 12,
    `32 → ${rightFs.wrap?.[1]}px（序列 ${JSON.stringify(rightFs.minSeq.slice(0, 3))}…）`);
  ok('按住 Alt 點：每次 −1px，最小停在 12px 不再變',
    rightFs.atMin === 12 && rightFs.minSeq.slice(-3).every((v: number) => v === 12)
    && rightFs.minSeq.some((v: number) => v === 13),
    `Alt 連點：${JSON.stringify(rightFs.minSeq)}｜提示「${rightFs.title}」`);
  // 字級的範圍（作者 2026-10-18）：只調「清單」與「內文」，
  // 分頁按鈕、欄位本身（介面）不動。
  const near = (a: number, b: number) => Math.abs(a - b) < 0.3;
  ok('字級只調清單與內文：右欄清單／文字內容 +1px、欄位與分頁按鈕不變',
    near(rightFs.after.right, rightFs.before.right + 1)
    && near(rightFs.after.list, rightFs.before.list + 1)
    && near(rightFs.after.text, rightFs.before.text + 1)
    && near(rightFs.after.col, rightFs.before.col)
    && near(rightFs.after.tab, rightFs.before.tab)
    && near(rightFs.after.tabRight, rightFs.before.tabRight)
    && near(rightFs.after.mid, rightFs.before.mid),
    `--fs-right ${rightFs.before.right} → ${rightFs.after.right}px；清單 ${rightFs.before.list} → ${rightFs.after.list}、`
    + `文字內容 ${rightFs.before.text} → ${rightFs.after.text}；欄 ${rightFs.before.col}、`
    + `分頁 ${rightFs.before.tab}／${rightFs.before.tabRight}；中欄 ${rightFs.before.mid} → ${rightFs.after.mid}px`);
  // 依命中數排序、0 命中不顯示。
  const freq = await cdp.eval<{
    hasTab: boolean; tabName: string; openTab: boolean; noQueryItems: number; sample: string;
    withQueryItems: number; countsSorted: boolean; zerosHidden: boolean; meta: string; jumped: string | null;
    latinHasInput: boolean; latinNoQuery: number; latinFiltered: number; latinMeta: string;
  }>(`
    (async () => {
      const tab = document.querySelector('#colLeft .tabBtn[data-tab="freq"]');
      const hasTab = !!tab && !tab.hidden;
      const tabName = tab?.textContent.trim() ?? '';
      const q = document.querySelector('#freqQuery');
      q.value = '';
      tab.click();
      await new Promise(r => setTimeout(r, 800));
      const openTab = document.querySelector('#colLeft .tabPane[data-tab="freq"]')?.classList.contains('active') ?? false;
      const noQueryItems = document.querySelectorAll('#freqList .snippet').length;
      const sample = document.querySelector('#freqList .snippet b')?.textContent ?? '';
      // now search: counts must appear, sorted desc, and no zero rows.
      // The <文> segments are a narrow part of yinshun (the closing articles), so a
      // whole-corpus term may legitimately yield 0 of them; the check below is about
      // ordering and zero-hiding, not a fixed count.
      q.value = window.__accelon26.state().db === '13j' ? '象曰' : '大乘';
      q.dispatchEvent(new Event('input'));
      // the no-query list is already populated and its snippets do NOT carry a
      // count, so wait for the QUERY render via the meta line (a poll on an
      // element that already exists would read the previous result).
      const waitFreq = async (fn) => { for (let i = 0; i < 60; i++) { if (fn()) return true; await new Promise(r => setTimeout(r, 250)); } return false; };
      const waitText = async (sel, re) => { for (let i = 0; i < 60; i++) { if (re.test(document.querySelector(sel).textContent)) return true; await new Promise(r => setTimeout(r, 250)); } return false; };
      await waitText('#freqMeta', /命中/);
      await waitFreq(() => !!document.querySelector('#freqList .tCount.hit'));
      // 西文 pane has its own input as well — but only databases that declare a
      // s="~…" tree have that tab at all (fgdict does not)
      const latinTab = document.querySelector('#colLeft .tabBtn[data-tab="latin"]');
      const latinHasTab = !!latinTab && !latinTab.hidden;
      const lq = document.querySelector('#latinQuery');
      const latinHasInput = !!lq;
      let latinNoQuery = 0, latinFiltered = 0, latinMeta = '';
      let latinStart = 0, latinEnd = 0, latinMid = 0, latinModeMeta = '';
      if (latinHasTab) {
        lq.value = '';
        lq.dispatchEvent(new Event('input'));
        latinTab.click();
        for (let i = 0; i < 50; i++) {
          if (document.querySelectorAll('#latinList .snippet').length > 0) break;
          await new Promise(r => setTimeout(r, 200));
        }
        latinNoQuery = document.querySelectorAll('#latinList .snippet').length;
        lq.value = 'a';
        lq.dispatchEvent(new Event('input'));
        await new Promise(r => setTimeout(r, 700));
        latinFiltered = document.querySelectorAll('#latinList .snippet').length;
        latinMeta = document.querySelector('#latinMeta').textContent.slice(0, 70);
        // 西文 shares the 名詞 position filter (任意／開頭／中間／結尾)
        const latinModeSel = document.querySelector('#latinMode');
        const countFor = async (mode) => {
          latinModeSel.value = mode;
          latinModeSel.dispatchEvent(new Event('change'));
          await new Promise((r) => setTimeout(r, 700));
          return document.querySelectorAll('#latinList .snippet').length;
        };
        latinStart = await countFor('start');
        latinEnd = await countFor('end');
        latinMid = await countFor('mid');
        latinModeMeta = document.querySelector('#latinMeta').textContent.slice(0, 60);
        latinModeSel.value = 'any';
        latinModeSel.dispatchEvent(new Event('change'));
        await new Promise((r) => setTimeout(r, 400));
      }
      await new Promise(r => setTimeout(r, 400));
      const rows = [...document.querySelectorAll('#freqList .snippet')];
      const nums = rows.map(r => Number((r.querySelector('.tCount.hit')?.textContent ?? '0').replace(/[^0-9]/g, '')));
      const countsSorted = nums.every((n, i) => i === 0 || nums[i - 1] >= n);
      const zerosHidden = nums.every(n => n > 0);
      const first = rows[0];
      first?.click();
      for (let i = 0; i < 40; i++) {
        if (document.querySelector('#docText mark.docHit')) break;
        await new Promise(r => setTimeout(r, 200));
      }
      return {
        hasTab, tabName, openTab, noQueryItems, sample, withQueryItems: rows.length,
        countsSorted, zerosHidden,
        meta: document.querySelector('#freqMeta').textContent.slice(0, 80),
        jumped: window.__accelon26.state().lastReveal,
        latinHasInput, latinHasTab, latinNoQuery, latinFiltered, latinMeta,
        latinStart, latinEnd, latinMid, latinModeMeta,
      };
    })()
  `);
  // 13j declares no s="*u=…" tree, so the 頻次 tab is hidden there by design
  if (freq.hasTab) {
    // *u=… declares a per-attribute segment (頻次); a bare *tag declares per-tag
    // segments and is labelled 全文. Both are the same pane.
    ok('左欄有分段分頁（由 <樹> 控制）', freq.tabName === '頻次' || freq.tabName === '全文',
      `tab=${JSON.stringify(freq.tabName)}`);
    ok('頻次：未輸入條件時列出段名', freq.openTab && freq.noQueryItems > 0 && !!freq.sample,
      `${freq.noQueryItems} 段，例：${JSON.stringify(freq.sample)}`);
    ok('頻次：有條件時按段分群、依命中數排序、0 不顯示',
      freq.countsSorted && freq.zerosHidden && /命中/.test(freq.meta),
      `${freq.withQueryItems} 段有命中；排序正確=${freq.countsSorted}；無 0=${freq.zerosHidden}｜${freq.meta}`);
    ok('頻次：點段會聯動內文', !!freq.jumped, String(freq.jumped));
    if (freq.latinHasTab) {
      ok('西文：有自己的輸入區與內容', freq.latinHasInput && freq.latinNoQuery > 0,
        `未輸入 ${freq.latinNoQuery} 個；輸入『a』後 ${freq.latinFiltered} 個｜${freq.latinMeta}`);
      ok('西文：開頭／中間／結尾三種位置都可篩選',
        freq.latinStart > 0 && freq.latinEnd > 0 && freq.latinMid > 0
        && freq.latinStart <= freq.latinFiltered && freq.latinEnd <= freq.latinFiltered
        && freq.latinMid <= freq.latinFiltered,
        `「a」任意 ${freq.latinFiltered}｜開頭 ${freq.latinStart}｜中間 ${freq.latinMid}｜結尾 ${freq.latinEnd}｜${freq.latinModeMeta}`);
    } else {
      ok('此庫沒有 s="~…" 樹，西文分頁隱藏', !freq.latinHasTab, 'hidden=true');
    }
  } else {
    // No s="*u=…" tree: the 頻次 button must be hidden and its pane inactive.
    // (`freq.hasTab` is computed from the button's own hidden state.)
    ok('此庫沒有 s="*u=…" 樹，頻次分頁隱藏', !freq.hasTab && !freq.openTab,
      `hidden=${!freq.hasTab}, active=${freq.openTab}`);
  }
  // ---- 檢索命中數徽章要跟著輸入即時重繪（不是上一次的數字） -----------------
  const badgeMoves = await cdp.eval<any>(`
    (async () => {
      const wait = async (fn, n = 40) => { for (let i = 0; i < n; i++) { if (fn()) return true; await new Promise(r => setTimeout(r, 200)); } return false; };
      const dirTab = document.querySelector('#colLeft .tabBtn[data-tab="dir"]');
      if (!dirTab || getComputedStyle(dirTab).display === 'none') return { skipped: true };
      dirTab.click();
      await wait(() => document.querySelector('#dirTree .tRow'));
      const db = window.__accelon26.state().db;
      const words = db === '13j' ? ['象曰', '乾'] : ['大乘', '涅槃'];
      const q = document.querySelector('#query');
      const rowBadges = () => [...document.querySelectorAll('#dirTree .tRow')]
        .map(r => (r.querySelector('.tCount.hit')?.textContent ?? '').trim());
      q.value = words[0];
      q.dispatchEvent(new Event('input'));
      await wait(() => rowBadges().some(v => v));
      const a = rowBadges();
      q.value = words[1];
      q.dispatchEvent(new Event('input'));
      // the same rows must show the NEW query's numbers (or none, if that word misses)
      await wait(() => JSON.stringify(rowBadges()) !== JSON.stringify(a));
      const b = rowBadges();
      const childOnly = [...document.querySelectorAll('#dirTree .tCount')].filter(e => !e.classList.contains('hit')).length;
      q.value = '';
      q.dispatchEvent(new Event('input'));
      await new Promise(r => setTimeout(r, 600));
      const cleared = [...document.querySelectorAll('#dirTree .tCount.hit')].length;
      return { skipped: false, words, a: a.filter(Boolean).slice(0, 5), b: b.filter(Boolean).slice(0, 5), childOnly, cleared };
    })()
  `);
  if (!badgeMoves.skipped) {
    ok('目錄命中數徽章隨輸入即時重繪（不是上一次的數字）',
      JSON.stringify(badgeMoves.a) !== JSON.stringify(badgeMoves.b),
      `${JSON.stringify(badgeMoves.words)}：${JSON.stringify(badgeMoves.a)} → ${JSON.stringify(badgeMoves.b)}`);
    ok('清空輸入後命中徽章收起', badgeMoves.cleared === 0,
      `清空後 hit 徽章 ${badgeMoves.cleared} 個、子節點數徽章 ${badgeMoves.childOnly} 個`);
  }

  // ---- 多詞組 + BM25（作者 2026-10 指定的四種查法）-----------------------
  // yinshun 宣告了 s="*u=文"，所以文件＝6,978 個 <… u="文"> 實例，
  // 文件長度用 tag 位置的 VA 差值（不讀本文）。
  if (opened.db === 'yinshun') {
    const multi = await cdp.eval<any>(`
      (async () => {
        const wait = async (fn, n = 140) => { for (let i = 0; i < n; i++) { if (fn()) return true; await new Promise(r => setTimeout(r, 200)); } return false; };
        const st = () => window.__accelon26.state();
        const q = document.querySelector('#query');
        const run = async (text) => {
          q.value = text;
          q.dispatchEvent(new Event('input'));
          await wait(() => st().searchQuery === text && !!st().multi);
          await new Promise(r => setTimeout(r, 1600));
          const m = st().multi;
          const marks = [...document.querySelectorAll('#searchList mark')];
          return {
            text,
            clauses: m.clauses.map(c => ({ text: c.text, role: c.role, near: c.nearOf, idf: Math.round(c.idf * 100) / 100, df: c.df })),
            segments: m.segments, docs: m.docs,
            hues: [...new Set(marks.map(x => x.style.getPropertyValue('--hue')))],
            texts: [...new Set(marks.map(x => x.textContent))],
            cards: document.querySelectorAll('#searchList .snippet').length,
          };
        };
        const near = await run('緣起*性空');
        const or = await run('緣起 性空');
        const and = await run('緣起+性空');
        // 點一張卡：本文要用「每個關鍵字一種顏色」塗出來
        document.querySelector('#searchList .snippet')?.click();
        await new Promise(r => setTimeout(r, 1600));
        const dm = [...document.querySelectorAll('#docText mark')];
        const doc = {
          count: dm.length,
          hues: [...new Set(dm.map(x => x.style.getPropertyValue('--hue')))],
          texts: [...new Set(dm.map(x => x.textContent))],
        };
        const neg = await run('緣起-性空');
        // 本文標題＝上一輪引擎耗時；hover 有 token／posting 細節
        const dt = document.querySelector('#docTitle');
        const title = { text: dt.textContent, tip: dt.title, cleared: '' };
        q.value = '';
        q.dispatchEvent(new Event('input'));
        await new Promise(r => setTimeout(r, 700));
        title.cleared = dt.textContent;
        return { near, or, and, neg, doc, title };
      })()
    `);
    const clauseText = (c: any[]) => c.map((x: any) => (x.near >= 0 ? '*' : '') + (x.role === 'required' ? '+' : x.role === 'excluded' ? '-' : '') + x.text).join(' ');
    ok('多詞組：四種運算子的詞組解析',
      clauseText(multi.near.clauses) === '緣起 *性空'
      && clauseText(multi.or.clauses) === '緣起 性空'
      && clauseText(multi.and.clauses) === '緣起 +性空'
      && clauseText(multi.neg.clauses) === '緣起 -性空',
      [multi.near, multi.or, multi.and, multi.neg].map((r) => clauseText(r.clauses)).join(' ／ '));
    ok('多詞組：文件＝s="*u=文" 的分段（不是 44 本書）',
      multi.near.segments > 1000, `${multi.near.segments} 段，平均 idf ${multi.near.clauses.map((c: any) => c.idf).join('/')}`);
    ok('多詞組：鄰近 ⊂ 必要 ⊂ 可選（BM25 排序下的文件數）',
      multi.near.docs < multi.and.docs && multi.and.docs < multi.or.docs,
      `*性空 ${multi.near.docs}／+性空 ${multi.and.docs}／空白 ${multi.or.docs} 份`);
    ok('多詞組：摘要上每個關鍵字有自己的顏色（HSV）',
      multi.or.hues.length === 2 && multi.or.texts.includes('緣起') && multi.or.texts.includes('性空'),
      `hues=${JSON.stringify(multi.or.hues)} texts=${JSON.stringify(multi.or.texts)}`);
    ok('多詞組：排除詞不上色（緣起-性空 只塗 緣起）',
      multi.neg.hues.length === 1 && multi.neg.texts.length === 1 && multi.neg.texts[0] === '緣起',
      `hues=${JSON.stringify(multi.neg.hues)} texts=${JSON.stringify(multi.neg.texts)}`);
    ok('多詞組：本文也是每個關鍵字一種顏色',
      multi.doc.hues.length === 2 && multi.doc.texts.includes('緣起') && multi.doc.texts.includes('性空'),
      `${multi.doc.count} 個 mark、hues=${JSON.stringify(multi.doc.hues)}、texts=${JSON.stringify(multi.doc.texts)}`);
    ok('docTitle 顯示上一輪引擎耗時（搜尋＋取文）',
      /搜尋 [\d.]+ ms/.test(multi.title.text) && /取文 [\d.]+ ms/.test(multi.title.text),
      multi.title.text);
    ok('docTitle hover 顯示搜尋細節（token／posting 長度、文件分割）',
      /token／posting/.test(multi.title.tip) && /\d{1,3}(,\d{3})+|\d+\)/.test(multi.title.tip)
      && /文件分割/.test(multi.title.tip),
      multi.title.tip.split('\n').slice(1, 4).join(' ｜ '));
    ok('清空查詢後 docTitle 回到預設文字',
      multi.title.cleared.includes('未渲染 XML'), multi.title.cleared);

    // 單字萬用字元：菩.心 → 菩提心／菩薩心…；菩.心-菩提心 → 只剩菩薩心那一些
    const wc = await cdp.eval<any>(`
      (async () => {
        const wait = async (fn, n = 140) => { for (let i = 0; i < n; i++) { if (fn()) return true; await new Promise(r => setTimeout(r, 200)); } return false; };
        const st = () => window.__accelon26.state();
        const q = document.querySelector('#query');
        const run = async (text) => {
          q.value = text;
          q.dispatchEvent(new Event('input'));
          await wait(() => st().searchQuery === text && !!st().multi);
          await new Promise(r => setTimeout(r, 1400));
          return {
            docs: st().multi?.docs ?? -1,
            cards: document.querySelectorAll('#searchList .snippet').length,
            texts: [...new Set([...document.querySelectorAll('#searchList mark')].map((m) => m.textContent))],
          };
        };
        const hit = await run('菩.心');
        const neg = await run('菩.心-菩提心');
        q.value = '';
        q.dispatchEvent(new Event('input'));
        return { hit, neg };
      })()
    `);
    ok('wildcard「菩.心」在 UI 找到並塗紅「菩提心／菩薩心」',
      wc.hit.docs > 0 && wc.hit.cards > 0
      && wc.hit.texts.some((t: string) => t.endsWith('心')) && wc.hit.texts.includes('菩提心'),
      `${wc.hit.docs} 份文件／${wc.hit.cards} 張卡片、marks=${JSON.stringify(wc.hit.texts.slice(0, 4))}`);
    ok('wildcard「菩.心-菩提心」排除後還有菩薩心那一些',
      wc.neg.docs > 0 && wc.neg.docs < wc.hit.docs
      && !wc.neg.texts.includes('菩提心') && wc.neg.texts.some((t: string) => t.endsWith('心')),
      `${wc.hit.docs} → ${wc.neg.docs} 份文件；marks=${JSON.stringify(wc.neg.texts.slice(0, 4))}`);

    // 繁簡通檢：系統級開關（對所有庫生效），開著時「菩萨」＝「菩薩」
    const vr = await cdp.eval<any>(`
      (async () => {
        const wait = async (fn, n = 120) => { for (let i = 0; i < n; i++) { if (fn()) return true; await new Promise(r => setTimeout(r, 200)); } return false; };
        const st = () => window.__accelon26.state();
        const q = document.querySelector('#query');
        const run = async (text) => {
          q.value = text;
          q.dispatchEvent(new Event('input'));
          await wait(() => st().searchQuery === text);
          await new Promise(r => setTimeout(r, 1400));
          const meta = document.querySelector('#searchMeta').textContent ?? '';
          const m = /([\\d,]+)\\s*筆命中/.exec(meta);
          return {
            hits: m ? Number(m[1].replace(/,/g, '')) : 0,
            missing: /索引中沒有/.test(meta),
            cards: document.querySelectorAll('#searchList .snippet').length,
            meta: meta.slice(0, 60),
          };
        };
        window.__accelon26.openSettings();
        await new Promise(r => setTimeout(r, 300));
        const setBox = document.querySelector('#setVariants');
        const settingsShown = !document.getElementById('settingsBox').hidden;
        setBox.checked = true;
        setBox.dispatchEvent(new Event('change'));
        await new Promise(r => setTimeout(r, 300));
        const btnOn = setBox.checked;
        const lsOn = localStorage.getItem('accelon26.variants');
        const simp = await run('菩萨');
        const trad = await run('菩薩');
        const flagOn = st().variants;
        setBox.checked = false;
        setBox.dispatchEvent(new Event('change'));
        await new Promise(r => setTimeout(r, 300));
        const simpOff = await run('菩萨');
        const btnOff = setBox.checked;
        // 勾選框本身也要能切換（不是只有 debug API）
        setBox.click();
        await new Promise(r => setTimeout(r, 500));
        const afterClick = st().variants;
        window.__accelon26.setVariants(false);
        window.__accelon26.closeSettings();
        q.value = '';
        q.dispatchEvent(new Event('input'));
        return { settingsShown, btnOn, lsOn, btnOff, flagOn, afterClick, simp, trad, simpOff };
      })()
    `);
    ok('繁簡通檢：設置頁的勾選框（localStorage 記住）',
      vr.btnOn === true && vr.lsOn === '1' && vr.flagOn === true && vr.btnOff === false,
      `on=${vr.btnOn} ls=${vr.lsOn} state=${vr.flagOn}｜關掉後按鈕=${vr.btnOff}`);
    ok('繁簡通檢：關著時「菩萨」查不到（此庫是繁體）',
      vr.simpOff.hits === 0 && vr.simpOff.cards === 0,
      `${vr.simpOff.hits} 筆命中／${vr.simpOff.cards} 張卡片（missing=${vr.simpOff.missing}）`);
    ok('繁簡通檢：開著時「菩萨」＝「菩薩」',
      vr.simp.hits > 0 && vr.simp.hits === vr.trad.hits,
      `菩萨 ${vr.simp.hits} 筆 vs 菩薩 ${vr.trad.hits} 筆｜${vr.simp.meta}`);
    ok('繁簡通檢：按勾選框本身可切換', vr.afterClick === true && vr.settingsShown === true,
      `click 後 state().variants=${vr.afterClick}、設置頁開著=${vr.settingsShown}`);
  }

  // ---- 使用者測試報告（fgdict）的回歸 --------------------------------------
  // 全文／頻次面板：筆數與段名同一行、頁籤名＝段名、把查詢詞塗紅、摘要聯動該段
  // 原書分頁：頁籤名＝頁碼、不塗紅、把 <_頁> 捲進畫面、連點不重複開分頁
  const report = await cdp.eval<any>(`
    (async () => {
      const wait = async (fn, n = 60) => { for (let i = 0; i < n; i++) { if (fn()) return true; await new Promise(r => setTimeout(r, 200)); } return false; };
      const st = () => window.__accelon26.state();
      const out = { db: st().db, treeMs: window.__accelon26.openBreakdown()?.treeMs ?? -1, phases: st().treePhases, earlyTab: st().leftTab };
      // 名詞 pane render time (the caches/<tag> string table path)
      const termsTab = document.querySelector('#colLeft .tabBtn[data-tab="terms"]');
      if (termsTab && !termsTab.hidden) {
        termsTab.click();
        const t0 = performance.now();
        await wait(() => document.querySelector('#termsList .snippet'), 60);
        out.termsMs = Math.round(performance.now() - t0);
        out.termsRows = document.querySelectorAll('#termsList .snippet').length;
        // 名詞＝閱讀單位：點詞條後內文只顯示「這一個 <詞> 實例」的 realm
        // （從它的 VA 到下一筆 <詞>，也就是整個詞條），不是整個 <檔>。
        const trows = [...document.querySelectorAll('#termsList .snippet')];
        if (trows.length >= 2) {
          const vas = [Number(trows[0].dataset.va), Number(trows[1].dataset.va)];
          const nTabs = st().docTabs.length;
          trows[0].click();
          await wait(() => st().docRealm && st().docRealm.from === vas[0], 60);
          await new Promise(r => setTimeout(r, 400));
          out.term = {
            vas,
            realm: st().docRealm,
            rows: st().docRows,
            lines: st().docPageLines,
            tabName: st().docTabs[st().docTab]?.name ?? '',
            rowName: trows[0].querySelector('b')?.textContent ?? '',
            newTabs: st().docTabs.length - nTabs,
            // 詞條的內文不該等於整個 <檔>：這兩個 VA 之間才是它
            docCount: st().docs.length,
          };
        }
        // 名詞搜尋：輸入查詢後清單只能是「符合的詞條」—— 舊寫法用 slice 位移去
        // 取 caches/<tag>，結果查「法王」列出字典最前面的 一、一一、一一心識…
        if (out.db === 'fgdict') {
          const tq = document.querySelector('#termsQuery');
          tq.value = '法王';
          tq.dispatchEvent(new Event('input'));
          await wait(() => (document.querySelector('#termsMeta').textContent ?? '').includes('法王'), 60);
          await new Promise(r => setTimeout(r, 900));
          const qrows = [...document.querySelectorAll('#termsList .snippet')];
          const qnames = qrows.map((r) => r.querySelector('b')?.textContent ?? '');
          const qrow = qrows[0];
          qrow?.click();
          await new Promise(r => setTimeout(r, 900));
          out.termQuery = {
            meta: document.querySelector('#termsMeta').textContent.slice(0, 90),
            rows: qrows.length,
            names: qnames.slice(0, 5),
            allMatch: qnames.length > 0 && qnames.every((n) => n.includes('法王')),
            clicked: qnames[0] ?? '',
            tab: st().docTabs[st().docTab]?.name ?? '',
            marked: document.querySelector('#docText mark.docHit')?.textContent ?? '',
            lines: st().docRows,
          };
          // 塗紅（作者 2026-10）：清單裡的詞條名要把輸入詞標成 mark.kw
          // 萬用字元 . ：般.經 ＝ 般＋任一字＋經（開頭模式 → 般若經十喻／般若經典…）
          {
            const btn = document.querySelector('#termsMode');
            while (btn.dataset.mode !== 'start') { btn.click(); await new Promise(r => setTimeout(r, 200)); }
            tq.value = '般.經';
            tq.dispatchEvent(new Event('input'));
            await new Promise(r => setTimeout(r, 1200));
            const wrows = [...document.querySelectorAll('#termsList .snippet')].map((r) => r.querySelector('b'));
            out.termsMark = {
              wildRows: wrows.length,
              wildNames: wrows.slice(0, 4).map((b) => b?.textContent ?? ''),
              wildMarks: wrows.slice(0, 4).map((b) => [...(b?.querySelectorAll('mark.kw') ?? [])].map((m) => m.textContent)),
              allHaveMark: wrows.length > 0 && wrows.every((b) => (b?.querySelectorAll('mark.kw')?.length ?? 0) > 0),
              plain: (() => {
                tq.value = '法王';
                tq.dispatchEvent(new Event('input'));
                return null;
              })(),
            };
            await new Promise(r => setTimeout(r, 1200));
            const prows = [...document.querySelectorAll('#termsList .snippet')].map((r) => r.querySelector('b'));
            out.termsMark.plainRows = prows.length;
            out.termsMark.plainMarks = prows.slice(0, 3).map((b) => [...(b?.querySelectorAll('mark.kw') ?? [])].map((m) => m.textContent));
            out.termsMark.plainAllMarked = prows.length > 0 && prows.every((b) => (b?.querySelectorAll('mark.kw')?.length ?? 0) > 0);
            tq.value = '';
            tq.dispatchEvent(new Event('input'));
          }
          // 三態 toggle（作者 2026-10）：開頭 → 中間 → 結尾；一般模式 #termsMeta 收起，
          // 符合詞條數直接放在 #termsMode 右邊
          {
            const modeBtn = document.querySelector('#termsMode');
            const seqMode = [];
            for (let i = 0; i < 4; i++) {
              seqMode.push(modeBtn.dataset.mode + ':' + modeBtn.textContent.trim());
              modeBtn.click();
              await new Promise(r => setTimeout(r, 350));
            }
            out.termsMode = {
              tag: modeBtn.tagName,
              seq: seqMode,
              metaDisplay: getComputedStyle(document.querySelector('#termsMeta')).display,
              count: document.querySelector('#termsCount').textContent,
            };
          }
          // 名詞分頁的多詞組：「-」排除（用詞條名比對）
          tq.value = '法王 -大慈';
          tq.dispatchEvent(new Event('input'));
          await wait(() => (document.querySelector('#termsMeta').textContent ?? '').includes('-大慈'), 60);
          await new Promise(r => setTimeout(r, 800));
          const negRows = [...document.querySelectorAll('#termsList .snippet')];
          const negNames = negRows.map((r) => r.querySelector('b')?.textContent ?? '');
          out.termQuery.neg = {
            meta: document.querySelector('#termsMeta').textContent.slice(0, 90),
            rows: negNames.length,
            names: negNames.slice(0, 5),
            noExcluded: negNames.length > 0 && negNames.every((n) => !n.includes('大慈')),
          };
          // 繁簡通檢：詞條名也要通（菩萨 → 菩薩）
          window.__accelon26.setVariants(true);
          await new Promise(r => setTimeout(r, 300));
          tq.value = '菩萨';
          tq.dispatchEvent(new Event('input'));
          await new Promise(r => setTimeout(r, 900));
          const vNames = [...document.querySelectorAll('#termsList .snippet b')].map((b) => b.textContent ?? '');
          out.termQuery.variants = {
            rows: vNames.length,
            names: vNames.slice(0, 5),
            allTrad: vNames.length > 0 && vNames.every((n) => n.includes('菩薩')),
          };
          window.__accelon26.setVariants(false);
          await new Promise(r => setTimeout(r, 300));
          tq.value = '';
          tq.dispatchEvent(new Event('input'));
        }
      }
      const freqTab = document.querySelector('#colLeft .tabBtn[data-tab="freq"]');
      if (freqTab && !freqTab.hidden) {
        freqTab.click();
        // a 120 ms debounce from the previous block's #query cleanup may still be in
        // flight; an empty search resets the 摘要 pane, so let it land BEFORE clicking a
        // row here (otherwise the row's summary is wiped again after it is rendered)
        await new Promise(r => setTimeout(r, 400));
        const fq = document.querySelector('#freqQuery');
        const word = out.db === 'fgdict' ? '法王' : '大乘';
        fq.value = word;
        fq.dispatchEvent(new Event('input'));
        // wait for THIS query to be rendered: the pane already shows hit badges from
        // the earlier block's query (大乘), so a badge-based wait returns the STALE row
        // and its handler would paint the previous word.
        await wait(() => (document.querySelector('#freqMeta').textContent ?? '').includes(word), 80);
        await wait(() => document.querySelector('#freqList .tCount.hit'), 20);
        const r0 = document.querySelector('#freqList .snippet');
        const b0 = r0?.querySelector('b');
        const c0 = r0?.querySelector('.tCount.hit');
        const sameLine = !!b0 && !!c0 && b0.parentElement === c0.parentElement;
        // prefer the 法王家 row when the database is the dictionary under test
        const rows = [...document.querySelectorAll('#freqList .snippet')];
        const row = (out.db === 'fgdict' && rows.find(r => r.querySelector('b')?.textContent === '法王家')) || r0;
        const rowName = row?.querySelector('b')?.textContent ?? '';
        const rowCount = Number((row?.querySelector('.tCount.hit')?.textContent ?? '0').replace(/[^0-9]/g, ''));
        const before = st().docTabs.length;
        const pinBefore = st().pinned?.va ?? -1;
        const tabBefore = st().docTabs[st().docTab]?.name ?? '';
        row?.click();
        // poll for the QUERY to be painted (not merely for any mark): the page has to
        // move to the hit first, which can take a moment on a 22k-segment dictionary
        await wait(() => (document.querySelector('#docText mark.docHit')?.textContent ?? '').includes(word), 40);
        // the 摘要 follows the click asynchronously (the realm's hits are fetched from
        // the index when the global result was truncated), so poll for it instead of
        // sleeping a fixed 400 ms
        await wait(() => (document.querySelector('#searchMeta')?.textContent ?? '').includes('範圍內')
          || document.querySelectorAll('#searchList .snippet').length > 0, 40);
        out.freq = {
          word, rowName, rowCount, sameLine, found: !!row,
          rowVa: Number(row?.dataset.va),
          pinBefore, tabBefore, pinAfter: st().pinned?.va ?? -1,
          statusAfter: window.__accelon26.status(),
          tabName: st().docTabs[st().docTab]?.name ?? '',
          marks: document.querySelectorAll('#docText mark.docHit').length,
          markText: document.querySelector('#docText mark.docHit')?.textContent ?? '',
          pin: JSON.stringify(st().pinned),
          lineText: (document.getElementById('L' + (st().pinned?.line ?? -1))?.textContent ?? '').slice(0, 60),
          sumItems: document.querySelectorAll('#searchList .snippet').length,
          sumMeta: document.querySelector('#searchMeta').textContent.slice(0, 50),
          scope: st().snippetScope,
          newTabs: st().docTabs.length - before,
        };
      }
      // 使用者回報：全文輸入「法喜」點「二食」→ 摘要的兩個 mark 必須是「法喜」。
      // （walk 漂移時 summary 的 span 會塗到隔壁字：實測塗成「帖見」「止觀」。）
      if (out.db === 'fgdict') {
        const fq2 = document.querySelector('#freqQuery');
        fq2.value = '法喜';
        fq2.dispatchEvent(new Event('input'));
        await wait(() => (document.querySelector('#freqMeta').textContent ?? '').includes('法喜'), 80);
        const row2 = [...document.querySelectorAll('#freqList .snippet')]
          .find((r) => r.querySelector('b')?.textContent === '二食');
        row2?.click();
        await wait(() => document.querySelectorAll('#searchList .snippet mark').length > 0, 40);
        await new Promise((r) => setTimeout(r, 400));
        out.faxi = {
          found: !!row2,
          marks: [...document.querySelectorAll('#searchList .snippet mark')].map((m) => m.textContent),
          snippets: document.querySelectorAll('#searchList .snippet').length,
        };
      }
      const folioTab = document.querySelector('#colLeft .tabBtn[data-tab="folio"]');
      if (folioTab && !folioTab.hidden) {
        folioTab.click();
        await wait(() => document.querySelectorAll('#folioList .snippet').length > 0, 40);
        const first = document.querySelector('#folioList .snippet');
        const label = first?.textContent.trim() ?? '';
        const before = st().docTabs.length;
        first?.click();
        await wait(() => st().pinned && document.getElementById('L' + st().pinned.line), 40);
        await new Promise(r => setTimeout(r, 700));
        const line = st().pinned?.line ?? -1;
        const rowEl = document.getElementById('L' + line);
        const box = document.querySelector('#docText');
        const rb = rowEl?.getBoundingClientRect();
        const bb = box?.getBoundingClientRect();
        const inView = !!rb && !!bb && rb.top >= bb.top - 2 && rb.bottom <= bb.bottom + 2;
        const afterFirst = st().docTabs.length;
        first?.click();
        await new Promise(r => setTimeout(r, 700));
        out.folio = {
          label, line, inView,
          marks: document.querySelectorAll('#docText mark.docHit').length,
          tabName: st().docTabs[st().docTab]?.name ?? '',
          tabsFirst: afterFirst - before,
          tabsSecond: st().docTabs.length - afterFirst,
        };
      }
      return out;
    })()
  `);
  ok('目錄樹在背景建好（不阻塞名詞分頁）', (report.phases?.trees ?? 1e9) < 800,
    `背景目錄樹 ${(report.phases?.trees ?? -1).toFixed(0)} ms（實例 ${report.phases?.instances ?? '?'}、load ${(report.phases?.load ?? -1).toFixed(0)}、build ${(report.phases?.build ?? -1).toFixed(0)}、render ${(report.phases?.render ?? -1).toFixed(0)}，rendered=${report.phases?.rendered ?? '?'}）`);
  if (report.termsMs !== undefined) {
    ok('名詞分頁：字串表路徑渲染很快（caches/<tag> 一次讀取）', report.termsMs < 400,
      `${report.termsRows} 列 / ${report.termsMs} ms；背景目錄樹 ${report.treeMs.toFixed(1)} ms ${JSON.stringify(report.phases)} 左欄=${report.earlyTab}`);
  }
  if (report.term) {
    const t = report.term;
    ok('名詞：點詞條只顯示該詞條的 realm（<詞> 為閱讀分界）',
      !!t.realm && t.realm.from === t.vas[0] && t.realm.to === t.vas[1] && t.rows > 0,
      `<詞>@${t.vas[0]}–${t.vas[1]} → realm ${JSON.stringify(t.realm)}、本頁 ${t.rows} 行（共 ${t.lines}）`);
    ok('名詞：本文分頁名＝詞條名，且不另開分頁', t.tabName === t.rowName && t.newTabs === 0,
      `tab=${JSON.stringify(t.tabName)} row=${JSON.stringify(t.rowName)} +${t.newTabs} 分頁`);
  }
  if (report.termQuery) {
    const q = report.termQuery;
    ok('名詞搜尋：清單只列出符合的詞條（不是字典最前面那幾個）',
      q.rows > 0 && q.allMatch, `「法王」→ ${q.rows} 列｜${JSON.stringify(q.names)}`);
    ok('名詞搜尋：點列後本文只顯示該詞條、塗紅的就是它',
      q.tab === q.clicked && q.lines > 0 && (q.marked.includes('法王') || q.clicked.includes(q.marked)),
      `tab=${JSON.stringify(q.tab)} 點=${JSON.stringify(q.clicked)} 塗紅=${JSON.stringify(q.marked)}（${q.lines} 行）`);
    if (q.neg) {
      ok('名詞多詞組：`-詞` 會排除（詞條名比對）',
        q.neg.rows > 0 && q.neg.rows < q.rows && q.neg.noExcluded,
        `${q.rows} → ${q.neg.rows} 列｜${JSON.stringify(q.neg.names)}`);
    }
    if (q.variants) {
      ok('名詞分頁：繁簡通檢開著時「菩萨」找得到「菩薩」詞條',
        q.variants.rows > 0 && q.variants.allTrad,
        `${q.variants.rows} 列｜${JSON.stringify(q.variants.names)}`);
    }
    if (report.termsMark) {
      const mk = report.termsMark;
      ok('名詞分頁：搜尋結果依輸入詞塗紅（<mark class="kw">）',
        mk.plainRows > 0 && mk.plainAllMarked && mk.plainMarks.every((ms: string[]) => ms.includes('法王')),
        `${mk.plainRows} 列、每列都有 mark｜前 3 列的 mark=${JSON.stringify(mk.plainMarks)}`);
      ok('名詞分頁：輸入支援萬用字元 `.`（般.經 → 般若經十喻／般若經典）',
        mk.wildRows > 0 && mk.allHaveMark
        && mk.wildNames.some((n: string) => n.startsWith('般若經'))
        && mk.wildMarks.every((ms: string[]) => ms.some((m: string) => m.length === 3)),
        `${mk.wildRows} 列｜${JSON.stringify(mk.wildNames)}｜mark=${JSON.stringify(mk.wildMarks)}`);
    }
    if (report.termsMode) {
      const m = report.termsMode;
      ok('名詞分頁：比對位置是三態 toggle 按鈕（開頭 → 中間 → 結尾 → 開頭）',
        m.tag === 'BUTTON' && m.seq.length === 4
        && m.seq[0].startsWith('start:開頭') && m.seq[1].startsWith('mid:中間')
        && m.seq[2].startsWith('end:結尾') && m.seq[3].startsWith('start:開頭'),
        JSON.stringify(m.seq));
      ok('一般模式：#termsMeta 收起，符合詞條數（只有數字）在按鈕裡',
        m.metaDisplay === 'none' && /^[0-9,]+$/.test(String(m.count).trim())
        && m.seq.every((s: string) => !/個詞條/.test(s)),
        `#termsMeta display=${m.metaDisplay}、#termsCount「${m.count}」、按鈕「${m.seq[0]}」`);
    }
  }
  if (report.freq) {
    const f = report.freq;    ok('全文：命中數與段名同一行（不再分行）', f.sameLine, `row=${JSON.stringify(f.rowName)} count=${f.rowCount}`);
    ok('全文：點段名→本文頁籤名為段名', f.found && f.tabName === f.rowName,
      `tab=${JSON.stringify(f.tabName)} row=${JSON.stringify(f.rowName)}`
      + `｜va=${f.rowVa} tabBefore=${JSON.stringify(f.tabBefore)} pin ${f.pinBefore}→${f.pinAfter}`
      + `｜${f.statusAfter}`);
    ok('全文：內文把查詢詞塗紅', f.marks > 0 && f.markText.includes(f.word),
      `「${f.word}」→ ${f.marks} 個 mark ${JSON.stringify(f.markText)}｜pinned=${f.pin}`);
    ok('全文：摘要聯動該段的命中', f.sumItems > 0 && /範圍內/.test(f.sumMeta), `${f.sumItems} 筆｜${f.sumMeta}`);
  }
  if (report.faxi) {
    const fx = report.faxi;
    ok('全文：摘要的塗紅就是查詢詞（法喜／二食，walk 漂移也不例外）',
      fx.found && fx.marks.length === 2 && fx.marks.every((m) => m === '法喜'),
      `二食=${fx.found}｜${JSON.stringify(fx.marks)}｜${fx.snippets} 筆摘要`);
  }
  if (report.folio) {
    const p = report.folio;
    ok('原書分頁：不塗紅', p.marks === 0, `${p.marks} 個 mark`);
    ok('原書分頁：把 <_頁> 捲進畫面', p.inView, `行 ${p.line}｜${p.inView}`);
    ok('原書分頁：本文頁籤名為頁碼', p.tabName === p.label, `tab=${JSON.stringify(p.tabName)} label=${JSON.stringify(p.label)}`);
    ok('原書分頁：連點同一頁不重複開分頁', p.tabsSecond === 0, `第一次 +${p.tabsFirst}、第二次 +${p.tabsSecond}`);
  }

  // 本文塗紅必須和摘要一致（舊版只塗到一個字）
  const paint = await cdp.eval<{ snippet: string; doc: string; marks: number; title: string; resetGone: boolean; noHead: boolean }>(`
    (async () => {
      const q = document.querySelector('#query');
      const word = window.__accelon26.state().db === '13j' ? '象曰' : '印順';
      q.value = word;
      q.dispatchEvent(new Event('input'));
      await new Promise(r => setTimeout(r, 1600));
      const first = document.querySelector('#searchList .snippet');
      if (first) first.click();
      for (let i = 0; i < 50; i++) {
        if (document.querySelector('#docText mark.docHit')) break;
        await new Promise(r => setTimeout(r, 200));
      }
      const st = window.__accelon26.state();
      const spans = await window.__accelon26.pinnedSpans();
      const label = first?.querySelector('mark')?.textContent ?? '(none)';
      // wait for the mark count to settle (painting is async and can repeat)
      let marks = [];
      let prevN = -1;
      for (let i = 0; i < 40; i++) {
        marks = [...document.querySelectorAll('#docText mark.docHit')];
        if (marks.length > 0 && marks.length === prevN) break;
        prevN = marks.length;
        await new Promise(r => setTimeout(r, 200));
      }
      // Where the mapper's span lands vs the line the reader was sent to: when they
      // disagree the mapper's VA walk has drifted from the stored VA table (fgdict
      // by >1000 VA), and the painter falls back to marking the searched phrase in
      // the pinned line — so compare against the query in that case.
      const spanLine = spans && spans[0] ? spans[0].line : -1;
      const drifted = spanLine >= 0 && !!st.pinned && spanLine !== st.pinned.line;
      return {
        snippet: label,
        word,
        drifted,
        doc: marks.map(x => x.textContent).join(''),
        marks: marks.length,
        pinned: st.pinned,
        reveal: st.lastReveal,
        spans,
        docRows: st.docRows,
        dbg: window.__accelon26.debugDoc(),
        title: document.querySelector('header h1').textContent.trim(),
        resetGone: !document.querySelector('#resetCols'),
        noHead: !document.querySelector('#searchList .snippetHead'),
      };
    })()
  `);
  ok('本文塗紅與摘要一致（VA walk 漂移的庫改比對搜尋詞）',
    (paint.doc === paint.snippet || (paint.drifted && paint.doc === paint.word)) && paint.doc.length > 0,
    `摘要 ${JSON.stringify(paint.snippet)} vs 本文 ${JSON.stringify(paint.doc)}（搜尋詞 ${JSON.stringify(paint.word)}，漂移=${paint.drifted}，${paint.marks} 個 mark；pinned=${JSON.stringify(paint.pinned)} spans=${JSON.stringify(paint.spans)}）`);
  ok('摘要不顯示 VA／行', paint.noHead, 'no .snippetHead');
  ok('標題為 Accelon26', paint.title.replace(/\\s+/g, '') === 'Accelon26', JSON.stringify(paint.title));
  ok('重設欄寬按鈕已移除', paint.resetGone, 'no #resetCols');

  // 分頁（網頁分頁＝page，不是原書的葉）：一次只載一頁，底部有上一頁／下一頁
  const paging = await cdp.eval<{
    pages: number; pageLines: number; nav: boolean; lineFirst: string; lineSecond: string;
    textChanged: boolean; back: boolean; clickMoved: boolean; realmOk: boolean; info: string;
  }>(`
    (async () => {
      window.__accelon26.showTab('dir', 'left');
      const rows = () => [...document.querySelectorAll('#dirTree .tRow')];
      const wait = async (fn) => { for (let i = 0; i < 60; i++) { if (fn()) return true; await new Promise(r => setTimeout(r, 200)); } return false; };
      const books = () => rows().filter((r) => r.querySelector('.tTag')?.textContent === '書');
      // a node that is CLOSED has children and a range, so clicking it opens and links
      const closed = books().find((r) => r.querySelector('.tTwisty')?.textContent.trim() === '▸');
      const start = closed ?? books()[0];
      if (start) {
        start.querySelector('.tDot').click();
        await wait(() => !!document.querySelector('#docText .hitLine'));
      } else {
        // 沒有目錄樹的庫（沒有 s="*"）改用摘要的第一筆聯動
        document.querySelector('#searchList .snippet')?.click();
        await wait(() => !!document.querySelector('#docText .docLine'));
      }
      await new Promise(r => setTimeout(r, 400));
      const st = window.__accelon26.state();
      const dr = st.docRealm;
      // page count of THIS node's realm (13j has no <檔>, so its realm is the
      // whole database; yinshun's second book is a real node realm)
      const pages = st.docTabPages;
      const pageLines = st.docPageLines;
      const nav = st.pagerHidden === false;
      const firstText = [...document.querySelectorAll('#docText .docLine .lineText')].map((e) => e.textContent).join('');
      const lineFirst = document.querySelector('#docText .docLine')?.id ?? null;
      document.querySelector('#pageNext').click();
      await new Promise(r => setTimeout(r, 800));
      const st2 = window.__accelon26.state();
      const secondText = [...document.querySelectorAll('#docText .docLine .lineText')].map((e) => e.textContent).join('');
      const lineSecond = document.querySelector('#docText .docLine')?.id ?? null;
      const info = document.querySelector('#pageInfo').textContent;
      document.querySelector('#pagePrev').click();
      await new Promise(r => setTimeout(r, 800));
      const thirdText = [...document.querySelectorAll('#docText .docLine .lineText')].map((e) => e.textContent).join('');
      const lineBack = document.querySelector('#docText .docLine')?.id ?? null;
      return {
        pages, pageLines, nav, lineFirst, lineSecond,
        textChanged: firstText.length > 0 && secondText.length > 0 && firstText !== secondText,
        back: thirdText === firstText && lineBack === lineFirst,
        clickMoved: st2.docPage === st.docPage + 1,
        realmOk: !!dr && st.docTabs.length >= 1,
        realm: dr,
        tab: st.docTabs[st.docTab],
        pageBefore: st.docPage,
        pageAfter: st2.docPage,
        pagerLog: JSON.stringify(st2.pagerLog),
        info: info.slice(0, 70),
      };
    })()
  `);
  ok('聯動後一次只載入一頁（每頁 200 行）',
    paging.realmOk && paging.pageLines > 0 && paging.pageLines <= 200
    && paging.pages >= 1 && paging.nav === (paging.pages > 1),
    `${paging.pages} 頁、本頁 ${paging.pageLines} 行｜${paging.info}`);
  // A node whose realm fits one page legitimately shows no pager; only a
  // multi-page realm must actually turn (and turn back).
  ok('「下一頁」「上一頁」真的換頁（且翻得回去）',
    paging.pages <= 1
      ? (paging.nav === false)
      : (paging.clickMoved && paging.textChanged && paging.back),
    `${paging.pages} 頁 ${paging.pageBefore}→${paging.pageAfter}：${paging.lineFirst} → ${paging.lineSecond} → ${paging.lineFirst}（pager ${paging.nav ? '顯示' : '隱藏'}）｜realm=${JSON.stringify(paging.realm)} lines=${paging.pageLines}｜${paging.pagerLog}`);
  // 預設：右欄關閉、欄寬狀態存 localStorage、本文不顯示行號
  const layout = await cdp.eval<{ right: number; left: number; stored: string; lineNo: boolean; fs: number; fsApplied: string }>(`
    (() => {
      const c = window.__accelon26.cols();
      return {
        left: c.left, right: c.right,
        stored: localStorage.getItem('accelon26.cols.v2') ?? '(none)',
        lineNo: !!document.querySelector('#docText .lineNo'),
        fs: window.__accelon26.docFont(),
        fsApplied: getComputedStyle(document.querySelector('#docText .docBody') ?? document.body).fontSize,
      };
    })()
  `);
  // The right column now hosts the 摘要 pane, so it starts OPEN (25 / 25); it used
  // to start closed when its first tab was the advanced-only META.
  ok('右欄預設開啟（放摘要）', layout.right === 25, JSON.stringify(layout));
  ok('本文不顯示行號', !layout.lineNo, 'no .lineNo in #docText');
  ok('欄寬狀態存在 localStorage', layout.stored !== '(none)', layout.stored);
  ok('字級已設定並套用', layout.fs >= 10 && layout.fsApplied === layout.fs + 'px',
    `設定 ${layout.fs}px，實際 ${layout.fsApplied}`);

  // 字級按鈕生效、存檔；`autoFitFont()` 仍是保留的 API（作者 2026-10）
  const font = await cdp.eval<{ up: string; down: string; stored: string; auto: number; before: any; after: any }>(`
    (async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      window.__accelon26.setDocFont(30);                 // deliberately too large
      await sleep(150);
      const before = window.__accelon26.debugDoc();
      const auto = window.__accelon26.autoFitFont();
      await sleep(150);
      const after = window.__accelon26.debugDoc();
      window.__accelon26.setDocFont(16);
      const click = (alt = false) => document.getElementById('fsBodyPick')
        .dispatchEvent(new MouseEvent('click', { altKey: alt, bubbles: true }));
      click();  await sleep(120);
      const up = String(window.__accelon26.docFont());    // 16 → 17
      click(true); await sleep(120);
      click(true); await sleep(120);
      const down = String(window.__accelon26.docFont());  // 17 → 16 → 15
      const stored = localStorage.getItem('accelon26.docfs');
      window.__accelon26.setDocFont(16);
      return { up, down, stored, auto, before, after };
    })()
  `);
  ok('字級按鈕（中）生效並存檔', font.up === '17' && font.down === '15' && font.stored === '15',
    `＋1 → ${font.up}，Alt−1×2 → ${font.down}，stored=${font.stored}`);

  // docTools 的三顆字級按鈕：左／中／右（作者 2026-10）
  // 字級的範圍（作者 2026-10-18）：只調「清單」與「內文」，介面（欄本身、分頁按鈕）不動。
  const fsPick = await cdp.eval<any>(`
    (async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const click = (id, alt = false) => document.getElementById(id)
        .dispatchEvent(new MouseEvent('click', { altKey: alt, bubbles: true }));
      const px = (sel) => { const el = document.querySelector(sel); return el ? getComputedStyle(el).fontSize : '(none)'; };
      const varPx = (n) => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(n));
      const before = {
        left: px('#colLeft'), right: px('#colRight'), body: px('#docText .docBody'),
        dirTree: px('#dirTree'), leftTab: px('#colLeft .tabBtn'),
      };
      // 左欄 13 → 17（每次 1px）
      for (let i = 0; i < 4; i++) click('fsLeftPick');
      await wait(250);
      // 右欄降到最小 12（13 → 12，多按的會夾住）
      for (let i = 0; i < 4; i++) click('fsRightPick', true);
      await wait(250);
      // 正文 16 → 19
      for (let i = 0; i < 3; i++) click('fsBodyPick');
      await wait(250);
      const after = {
        left: px('#colLeft'), right: px('#colRight'), body: px('#docText .docBody'),
        dirTree: px('#dirTree'), leftTab: px('#colLeft .tabBtn'),
        leftVar: varPx('--fs-left'), rightVar: varPx('--fs-right'), bodyVar: varPx('--fsdoc'),
        leftStore: localStorage.getItem('accelon26.fs.left'),
        rightStore: localStorage.getItem('accelon26.fs.right'),
      };
      // 還原（左 17 → 13、右 12 → 13、正文 16）
      for (let i = 0; i < 4; i++) click('fsLeftPick', true);
      click('fsRightPick');
      window.__accelon26.setDocFont(16);
      await wait(200);
      return { before, after };
    })()
  `);
  const pxNum = (s: string) => Number.parseFloat(String(s));
  ok('字級：三顆按鈕都在（各自在自己的欄、沒有下拉）',
    await cdp.eval<boolean>(`['#fsLeftPick','#fsBodyPick','#fsRightPick'].every((s) => document.querySelector(s)?.tagName === 'BUTTON')
      && !document.querySelector('#fsLeft, #fsBody, #fsRight')`));
  ok('字級按鈕：左／右各自生效並存檔',
    Math.abs(pxNum(fsPick.after.leftVar) - 17) < 0.3 && Math.abs(pxNum(fsPick.after.rightVar) - 12) < 0.3
    && fsPick.after.leftStore === '17' && fsPick.after.rightStore === '12',
    `左欄字級 ${fsPick.after.leftVar}px（stored ${fsPick.after.leftStore}）｜`
    + `右欄字級 ${fsPick.after.rightVar}px（stored ${fsPick.after.rightStore}）`);
  ok('字級按鈕：中（正文）跟著變（19px）',
    Math.abs(pxNum(fsPick.after.body) - 19) < 0.6, `${fsPick.before.body} → ${fsPick.after.body}`);
  ok('字級按鈕：左欄的清單跟著放大，但分頁按鈕與欄本身不動',
    Math.abs(pxNum(fsPick.after.dirTree) - 17) < 0.6
    && Math.abs(pxNum(fsPick.after.leftTab) - pxNum(fsPick.before.leftTab)) < 0.2
    && Math.abs(pxNum(fsPick.after.left) - pxNum(fsPick.before.left)) < 0.2,
    `#dirTree ${fsPick.before.dirTree} → ${fsPick.after.dirTree}；`
    + `.tabBtn ${fsPick.before.leftTab} → ${fsPick.after.leftTab}；#colLeft ${fsPick.before.left} → ${fsPick.after.left}`);
  const over = (d: any) => Math.max(0, (d.scrollWidth ?? 0) - (d.clientWidth ?? 0));
  // Short-line pages (a dictionary entry) may legitimately be pushed to the 40px
  // ceiling instead of shrinking, so accept that case too.
  ok('（API）自動字級讓行不再溢出（軟換行）',
    font.auto >= 10 && font.auto <= 40
    && (over(font.after) < over(font.before) || over(font.after) === 0 || font.auto >= 40),
    `30px 溢出 ${over(font.before)}px（最長 ${font.before.longestLine} 字 / ${font.before.sample} 行樣本）→ 自動 ${font.auto}px 溢出 ${over(font.after)}px`);

  // 「不換行」必須扣除左右欄：同一份文件，把左欄收起後中間變寬，自動字級必須變大
  const fitWidth = await cdp.eval<{ narrow: number; wide: number; widths: string }>(`
    (async () => {
      window.__accelon26.setCols(25, 0);                 // default: left column open
      await new Promise(r => setTimeout(r, 250));
      const narrow = window.__accelon26.autoFitFont();
      const w1 = Math.round(document.querySelector('#docText .docBody').clientWidth);
      window.__accelon26.setCols(0, 0);                  // left column collapsed
      await new Promise(r => setTimeout(r, 300));
      const wide = window.__accelon26.autoFitFont();
      const w2 = Math.round(document.querySelector('#docText .docBody').clientWidth);
      window.__accelon26.setCols(25, 0);
      await new Promise(r => setTimeout(r, 250));
      return { narrow, wide, widths: w1 + 'px -> ' + w2 + 'px' };
    })()
  `);
  // A wider pane may already be at the 40px ceiling (short-line dictionaries), so
  // require "never smaller, and strictly larger while there is headroom".
  ok('（API）自動字級會扣除左右欄寬度（左欄收起 → 字級變大或不小於）',
    fitWidth.wide >= fitWidth.narrow && (fitWidth.wide >= 40 || fitWidth.wide > fitWidth.narrow),
    `中間欄 ${fitWidth.widths}：左欄開 ${fitWidth.narrow}px → 左欄收 ${fitWidth.wide}px｜fit=${JSON.stringify(await cdp.eval('window.__accelon26.state().lastFit'))}`);
  const fitDbg = await cdp.eval<unknown>(`JSON.stringify(window.__accelon26.fitDebug())`);
  console.log('      fitDebug = ' + fitDbg);

  // 欄寬：預設左 25 / 右 0（關閉）、可拖曳、低於 15% 自動隱藏、可一鍵開回
  const cols = await cdp.eval<{ def: any; dragged: any; snapped: any; back: any; widths: string }>(`
    (async () => {
      window.__accelon26.setCols(25, 0);                     // the shipped default
      const def = window.__accelon26.cols();
      window.__accelon26.setCols(40, 20);
      const dragged = window.__accelon26.cols();
      window.__accelon26.setCols(8, 20);                     // below the 15% minimum
      const snapped = window.__accelon26.cols();
      window.__accelon26.setCols(25, 25);
      const back = window.__accelon26.cols();
      await new Promise(r => setTimeout(r, 100));
      const g = getComputedStyle(document.querySelector('main')).gridTemplateColumns;
      window.__accelon26.setCols(25, 0);
      return { def, dragged, snapped, back, widths: g };
    })()
  `);
  const pct = (s: string) => Number.parseFloat(String(s).replace('fr', ''));
  ok('預設欄寬 左 25 / 中 75 / 右 0', cols.def.left === 25 && cols.def.right === 0 && pct(cols.def.css.center) === 75,
    JSON.stringify(cols.def.css));
  ok('可調整欄寬', cols.dragged.left === 40 && cols.dragged.right === 20,
    `left=${cols.dragged.left}% right=${cols.dragged.right}% center=${cols.dragged.css.center}`);
  ok('低於 15% 自動隱藏', cols.snapped.left === 0 && pct(cols.snapped.css.left) === 0,
    `設定 8% → left=${cols.snapped.left}% css=${cols.snapped.css.left}`);
  ok('可開回 25 / 50 / 25', cols.back.left === 25 && cols.back.right === 25, JSON.stringify(cols.back.css));
  ok('grid 實際寬度反映設定', /px/.test(cols.widths), cols.widths.slice(0, 60));

  // 拖曳：真的用 pointer 事件拖 splitter（不用 API），確認寬度改變
  const drag = await cdp.eval<string>(`
    (async () => {
      window.__accelon26.setCols(25, 25);
      const sp = document.querySelector('#splitLeft');
      const r = sp.getBoundingClientRect();
      const y = r.top + r.height / 2;
      const before = window.__accelon26.cols().left;
      sp.dispatchEvent(new PointerEvent('pointerdown', { clientX: r.left + 2, clientY: y, bubbles: true, pointerId: 1 }));
      sp.dispatchEvent(new PointerEvent('pointermove', { clientX: r.left + 2 + window.innerWidth * 0.1, clientY: y, bubbles: true, pointerId: 1 }));
      sp.dispatchEvent(new PointerEvent('pointerup', { clientX: r.left + 2 + window.innerWidth * 0.1, clientY: y, bubbles: true, pointerId: 1 }));
      await new Promise(rr => setTimeout(rr, 100));
      const after = window.__accelon26.cols().left;
      window.__accelon26.setCols(25, 0);
      return before + '% -> ' + after + '% (center ' + window.__accelon26.cols().css.center + ')';
    })()
  `);
  ok('拖曳 splitter 會改變欄寬', /25% -> 3[0-9]%/.test(drag), drag);

  // 側欄 header 按鈕可各自切換（兩側獨立）
  const ui2 = await cdp.eval<{ hidden: string; back: string; reopen: string; dbl: string }>(`
    (async () => {
      window.__accelon26.setCols(25, 0);                       // shipped default
      window.__accelon26.toggleSide('left');                   // 25/0 -> 0/0
      await new Promise(r => setTimeout(r, 60));
      const hidden = window.__accelon26.cols().left + '/' + window.__accelon26.cols().right;
      window.__accelon26.toggleSide('left');                   // 0/0 -> 25/0
      window.__accelon26.toggleSide('right');                  // 25/0 -> 25/25
      await new Promise(r => setTimeout(r, 60));
      const back = window.__accelon26.cols().left + '/' + window.__accelon26.cols().right;
      // 收起再打開要回到「上回調整的寬度」，不是回到預設 25%
      window.__accelon26.setCols(40, 20);
      window.__accelon26.toggleSide('left');                   // 40/20 -> 0/20（記住 40）
      window.__accelon26.toggleSide('right');                  // 0/20 -> 0/0（記住 20）
      window.__accelon26.toggleSide('left');                   // -> 40/0
      window.__accelon26.toggleSide('right');                  // -> 40/20
      const reopen = window.__accelon26.cols().left + '/' + window.__accelon26.cols().right;
      // 雙擊分隔線仍是「回到預設」（不是回到上回寬度）
      document.querySelector('#splitLeft').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      const dbl = window.__accelon26.cols().left + '/' + window.__accelon26.cols().right;
      window.__accelon26.setCols(25, 0);
      return { hidden, back, reopen, dbl };
    })()
  `);
  ok('左右欄可各自切換隱藏／顯示', ui2.hidden === '0/0' && ui2.back === '25/25', `${ui2.hidden} → ${ui2.back}`);
  ok('再打開回到上回調整的寬度（不是 25%）', ui2.reopen === '40/20', ui2.reopen);
  ok('雙擊分隔線回到預設寬度', ui2.dbl === '25/20', ui2.dbl);

  const res = await cdp.eval<string>(`document.querySelector('#resources').textContent.replace(/\\s+/g,' ').trim().slice(0, 70)`);
  ok('resources pane reports state on file://', res.length > 0, res);

  // ---- 多庫：從 adb 下拉選一個 → 它跳到 dbTabs 最左；點 chip 切換則完全不動 -------
  // 造一個「庫名不同」的複本當第二個庫（只改 header 的 dbname／dbcname；viewer 不看 crc32）
  const COPY = resolve(import.meta.dir, '../../build/tmp-copy.adb');
  {
    const copy = Buffer.from(readFileSync(ADB));
    copy.fill(0, 0, 32);
    copy.write('copy_test', 0, 'ascii');
    copy.fill(0, 128, 192);
    Buffer.from('複本測試\0', 'utf16le').copy(copy, 128);
    writeFileSync(COPY, copy);
  }
  await cdp.send('DOM.setFileInputFiles', { files: [ADB, COPY], nodeId: await (async () => {
    const doc = await cdp.send('DOM.getDocument');
    const q = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#file' });
    return q.nodeId;
  })() });
  await cdp.eval('document.querySelector("#file").dispatchEvent(new Event("change"))');
  for (let i = 0; i < 80; i++) {
    const n = await cdp.eval<number>('document.querySelectorAll("#dbTabs .dbChip").length');
    if (n === 2) break;
    await Bun.sleep(300);
  }
  const multi = await cdp.eval<{ names: string[]; active: string; chips: number }>(`
    (() => {
      const chips = [...document.querySelectorAll('#dbTabs .dbChip')];
      return {
        chips: chips.length,
        names: chips.map((c) => c.textContent.replace('✕', '') + (c.classList.contains('active') ? '*' : '')),
        active: chips.find((c) => c.classList.contains('active'))?.textContent.replace('✕', '') ?? '',
      };
    })()
  `);
  ok('一次餵兩個 adb：兩個 chip，最後開啟的（複本）在最左',
    multi.chips === 2 && multi.names[0].startsWith('複本測試') && multi.active.startsWith('複本測試'),
    JSON.stringify(multi));
  // 點另一個 chip 切換：順序必須完全不動（作者：切換 active 時不要亂跳）
  const afterChip = await cdp.eval<string>(`(() => {
    const chips = [...document.querySelectorAll('#dbTabs .dbChip')];
    chips.find((c) => !c.classList.contains('active')).click();
    return [...document.querySelectorAll('#dbTabs .dbChip')].map((c) => c.textContent.replace('✕', '')).join(' | ');
  })()`);
  ok('點 chip 切換 active：順序完全不動',
    afterChip === multi.names.map((n) => n.replace('*', '')).join(' | '), afterChip);
  // 從資料夾清單選「原本的庫」——它現在在最右，選了就必須跳到最左（一使用就跳到最左）
  const otherName = await cdp.eval<string>(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    document.getElementById('dbPickBtn').click();
    await sleep(250);
    const item = [...document.querySelectorAll('#dbPickMenu .dbPickItem[data-key]')]
      .find((i) => !(i.querySelector('.dbPickName')?.textContent ?? '').includes('複本測試'));
    item.click();
    await sleep(200);
    return item.querySelector('.dbPickName')?.textContent ?? '';
  })()`);
  await Bun.sleep(1500);
  const promoted = await cdp.eval<string>(`[...document.querySelectorAll('#dbTabs .dbChip')].map((c) => c.textContent.replace('✕', '') + (c.classList.contains('active') ? '*' : '')).join(' | ')`);
  ok('從 adb 資料夾清單選一個庫：它跳到 dbTabs 最左',
    promoted.startsWith(otherName + '*') && promoted.includes('複本測試'),
    `選「${otherName}」→ ${promoted}`);
  // 收起複本（它的分頁一起走），回到原本的庫；複本仍留在下拉裡
  await cdp.eval(`(() => {
    const chip = [...document.querySelectorAll('#dbTabs .dbChip')].find((c) => c.textContent.includes('複本測試'));
    chip.querySelector('.dbChipClose').click();
  })()`);
  await Bun.sleep(1500);
  const afterClose = await cdp.eval<{ chips: number; db: string; catalog: string[] }>(`
    ({ chips: document.querySelectorAll('#dbTabs .dbChip').length,
       db: window.__accelon26.state().db,
       catalog: window.__accelon26.state().catalog.map((e) => e.name + (e.open ? '' : '(未載入)')) })
  `);
  ok('關掉複本：只剩原本的庫，複本仍留在下拉（未載入）',
    afterClose.chips === 1 && afterClose.db !== 'copy_test' && afterClose.catalog.some((n) => n.includes('複本測試(未載入)')),
    JSON.stringify(afterClose));

  // ---- 搜尋所有 adb（作者 2026-10）：放大鏡按鈕 → popup → 逐庫查 → 依命中數排序 ----
  const allSearch = await cdp.eval<any>(`
    (async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      // 先把左欄切到「目錄」：這樣「把查詢帶進 active 分頁」的斷言才穩定
      document.querySelector('#colLeft .tabBtn[data-tab="dir"]')?.click();
      await sleep(300);
      const btn = document.getElementById('searchAllBtn');
      const box = document.getElementById('allSearchBox');
      const st = () => window.__accelon26.searchAllState();
      const openedBefore = box.hidden;
      btn.click();
      await sleep(300);
      const opened = box.hidden === false;
      const q = document.getElementById('allSearchQuery');
      const word = window.__accelon26.state().db === '13j' ? '象曰' : '佛';
      q.value = word;
      const beforeCount = st().renderCount;
      document.getElementById('allSearchGo').click();
      for (let i = 0; i < 300; i++) {
        await sleep(100);
        const s = st();
        if (!s.busy && s.rows.length && s.rows.every((r) => r.state === 'done' || r.state === 'error')) break;
      }
      const s = st();
      const rows = [...document.querySelectorAll('#allSearchList .allSearchRow')].map((r) => ({
        tag: r.tagName, text: r.textContent.replace(/\\s+/g, ' ').trim(), key: r.dataset.key,
      }));
      const hitsInOrder = s.rows.map((r) => r.hits);
      // 點第一列：打開那個庫，並把查詢帶進主搜尋框
      // 點「目前這個庫」那一列（不另外開新庫，免得影響後面的測試；
      // 點別列會真的載入該庫，桌面的 GUI 測試有涵蓋）
      const curKey = window.__accelon26.state().dbPick;
      const rowForCur = [...document.querySelectorAll('#allSearchList .allSearchRow')]
        .find((r) => r.dataset.key === curKey) ?? document.querySelector('#allSearchList .allSearchRow');
      rowForCur?.click();
      for (let i = 0; i < 60; i++) {
        await sleep(150);
        if (document.querySelectorAll('#searchList .snippet').length) break;
      }
      const after = {
        db: window.__accelon26.state().db,
        query: document.getElementById('query').value,
        input: (() => {
          const tab = document.querySelector('#colLeft .tabBtn.active')?.dataset.tab ?? 'dir';
          const map = { dir: 'query', terms: 'termsQuery', freq: 'freqQuery', folio: 'folioQuery', latin: 'latinQuery' };
          const el = document.getElementById(map[tab] ?? 'query');
          return { tab: tab, value: el ? el.value : '' };
        })(),
        snippets: document.querySelectorAll('#searchList .snippet').length,
        closed: box.hidden,
        sortedDesc: rows.every((r, i) => i === 0 || Number(s.rows[i]?.hits ?? 0) >= 0),
      };
      return { openedBefore, opened, rows, hitsInOrder, renderedTimes: s.renderCount - beforeCount, after, catalog: s.rows.length,
        word,
        title: document.getElementById('allSearchTitle').textContent.trim(),
        leftTab: window.__accelon26.state().leftTab,
        leftInput: (() => {
          const tab = document.querySelector('#colLeft .tabBtn.active')?.dataset.tab ?? 'dir';
          const map = { dir: 'query', terms: 'termsQuery', freq: 'freqQuery', folio: 'folioQuery', latin: 'latinQuery' };
          const id = map[tab] ?? 'query';
          const el = document.getElementById(id);
          return el ? el.value : '';
        })() };
    })()
  `);
  ok('放大鏡按鈕在 📁 旁邊，按一下開「搜尋所有 adb」popup',
    allSearch.openedBefore === true && allSearch.opened === true
    && allSearch.rows.length === allSearch.catalog
    && /^搜尋 \d+ 個數據庫$/.test(allSearch.title),
    `預設 hidden=${allSearch.openedBefore}、按下後展開=${allSearch.opened}、${allSearch.rows.length} 列、標題「${allSearch.title}」`);
  ok('搜尋全部：每個庫都查、每查完一個就更新一次（重畫次數 > 庫數）',
    allSearch.renderedTimes > allSearch.catalog,
    `重畫 ${allSearch.renderedTimes} 次、${allSearch.catalog} 個庫`);
  ok('搜尋結果依命中數由多到少排序',
    allSearch.rows.every((r: any, i: number) => i === 0 || Number(allSearch.rows[i - 1].text.match(/([\\d,]+)/)?.[1]?.replace(/,/g, '') ?? 0)
      >= Number(r.text.match(/([\\d,]+)/)?.[1]?.replace(/,/g, '') ?? 0)),
    allSearch.rows.map((r: any) => r.text).join(' ｜ '));
  ok('點一列 → 打開那個庫並把查詢帶進左欄「目前 active 的分頁」',
    allSearch.after.closed === true
    && allSearch.after.input.value === allSearch.word
    && (allSearch.after.input.tab !== 'dir' || allSearch.after.snippets > 0),
    `db=${allSearch.after.db}、查詢詞=${JSON.stringify(allSearch.word)}`
    + `、左欄分頁=${allSearch.after.input.tab}、輸入框=${JSON.stringify(allSearch.after.input.value)}`
    + `、摘要 ${allSearch.after.snippets} 筆`);

  // 餵一個不是 .adb 的檔：錯誤是狀態列唯一還顯示的東西，而且不能把例外丟出來
  await cdp.send('DOM.setFileInputFiles', { files: [HTML], nodeId: await (async () => {
    const doc = await cdp.send('DOM.getDocument');
    const q = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#file' });
    return q.nodeId;
  })() });
  await cdp.eval('document.querySelector("#file").dispatchEvent(new Event("change"))');
  let badShown = false;
  for (let i = 0; i < 25; i++) {
    badShown = await cdp.eval<boolean>("!document.getElementById('status').hidden");
    if (badShown) break;
    await Bun.sleep(200);
  }
  const badOpen = await cdp.eval<{ text: string; chips: number; db: string; catalog: number }>(`
    ({ text: document.getElementById('status').textContent.slice(0, 40),
      chips: document.querySelectorAll('#dbTabs .dbChip').length,
      db: window.__accelon26.state().db, catalog: window.__accelon26.state().catalog.length })
  `);
  ok('餵非 .adb：狀態列顯示錯誤，原本的庫不受影響',
    badShown && /開啟失敗/.test(badOpen.text) && badOpen.chips === 1 && !!badOpen.db,
    `狀態「${badOpen.text}」、chip ${badOpen.chips}、db ${badOpen.db}、catalog ${badOpen.catalog}`);

  // 走訪目錄不按 Ctrl 不該多開分頁（需求三）。放在最後：它會改變本文狀態，而前面的
  // 斷言都是針對特定頁／字級，插在中間會把它們全部打亂。
  const walk = await cdp.eval<{ added: number; tabs: number }>(`
    (async () => {
      const spec = () => window.__accelon26.state().docTabs.length;
      const books = () => [...document.querySelectorAll('#dirTree .tRow')]
        .filter((r) => r.querySelector('.tTag')?.textContent === '書');
      const dirTab = document.querySelector('#colLeft .tabBtn[data-tab="dir"]');
      if (!dirTab || getComputedStyle(dirTab).display === 'none' || books().length < 4) return { added: 0, tabs: spec(), skipped: true };
      dirTab.click();
      await new Promise((r) => setTimeout(r, 500));
      const before = spec();
      for (const i of [1, 2, 3]) {
        const rows = books();
        rows[i % rows.length].querySelector('.tDot').click();
        await new Promise((r) => setTimeout(r, 700));
      }
      return { added: spec() - before, tabs: spec(), skipped: false };
    })()
  `);
  ok('不按 Ctrl 走訪目錄只更新當前分頁（不會多開）', walk.added === 0, `走過 3 個節點，分頁 +${walk.added}（共 ${walk.tabs}）`);

  // 關掉最後一個庫：＋ 右邊的閃爍提示要回來（clearDbUi 拿掉 body.loaded）
  const closed = JSON.parse(await cdp.eval<string>(`(async () => {
    const before = {
      chips: [...document.querySelectorAll('#dbTabs .dbChip')].map((c) => c.textContent.trim()),
      loaded: document.body.classList.contains('loaded'),
      found: !!document.querySelector('#dbTabs .dbChip.active .dbChipClose'),
    };
    const x = document.querySelector('#dbTabs .dbChip.active .dbChipClose')
      ?? document.querySelector('#dbTabs .dbChip .dbChipClose');
    if (x) x.click();
    await new Promise(r => setTimeout(r, 400));
    const cs = getComputedStyle(document.querySelector('#dbHint'));
    return JSON.stringify({
      before,
      chips: document.querySelectorAll('#dbTabs .dbChip').length,
      loaded: document.body.classList.contains('loaded'),
      display: cs.display, anim: cs.animationName,
      logoHidden: document.getElementById('docLogo').hidden,
      logoImg: !!document.querySelector('#docLogo img'),
      log: window.__accelon26.state().dbLog.slice(-4),
    });
  })()`)) as { before: { chips: string[]; loaded: boolean; found: boolean }; chips: number; loaded: boolean; display: string; anim: string; logoHidden: boolean; logoImg: boolean; log: string[] };
  // 閃爍本身由上面的第一條斷言保證（同一個 CSS 規則），這裡只驗「狀態回到沒有庫」。
  ok('關掉最後一個庫後閃爍提示回來',
    closed.chips === 0 && !closed.loaded && closed.display !== 'none',
    `之前 ${JSON.stringify(closed.before)} → chips ${closed.chips}、loaded ${closed.loaded}、display ${closed.display}、log ${JSON.stringify(closed.log)}`
    + `｜page ${cdp.logs.slice(-2).join(' | ').slice(0, 300)}`);
  // 作者 2026-10：關掉資料庫（例如 yinshun）之後，中間的 logo 不可以還留著
  ok('關掉資料庫後中間的 logo 一併收起',
    closed.logoHidden === true,
    `#docLogo hidden=${closed.logoHidden}`);
  // 例外要在**全部**動作跑完之後才算：關掉最後一個庫那一段以前漏掉過一個
  // `resetTextPane is not defined`（拆模組時少 import），當下沒有斷言看得到它。
  const errors = cdp.logs.filter((l) => l.startsWith('exception'));
  ok('no page exceptions', errors.length === 0, errors.slice(0, 2).join(' | ') || 'clean');
} catch (e) {
  fail++;
  console.log('  FAIL harness: ' + (e as Error).message);
  console.log('  --- page console (' + cdp.logs.length + ') ---');
  for (const l of cdp.logs.slice(-40)) console.log('    ' + l.slice(0, 200));
} finally {
  proc.kill();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
