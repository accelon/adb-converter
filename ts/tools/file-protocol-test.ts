/**
 * Real file:// test: open build/adbview.html as a local file, hand the page a
 * real .adb through the file input, and drive the UI.
 *
 *   bun run tools/file-protocol-test.ts [--adb <path>] [--html <path>]
 *
 * This is the mode the user actually wants: double click the HTML, pick the
 * database. It must work with NO server, so `fetch` is unavailable and the only
 * way in is the File API (Blob.slice) — which is what gets exercised here.
 */
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const HTML = resolve(opt('html', resolve(import.meta.dir, '../../build/adbview.html')));
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
          m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
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
      this.pending.set(id, { resolve: res, reject: rej });
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
  }
  async eval<T>(expression: string): Promise<T> {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
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
  ok('viewer bundle loaded on file://', await cdp.eval<boolean>('!!window.__adbview'));
  // the point of the exercise: fetch must NOT be needed
  const fetchWorks = await cdp.eval<string>(`fetch('x').then(() => 'ok').catch(e => 'blocked: ' + e.message)`);
  ok('fetch is unavailable on file:// (as expected, so the File API is the only path)',
    fetchWorks.startsWith('blocked'), fetchWorks);

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
        const s = window.__adbview.state();
        const rows = document.querySelectorAll('#tokenRows .tokenRow').length;
        if (s.db && rows > 0) {
          const meta = document.querySelector('#meta').textContent;
          const m = /開啟 ([\\d,]+) ms/.exec(meta);
          return { ...s, status: window.__adbview.status(), openMs: m ? Number(m[1].replace(/,/g, '')) : -1 };
        }
        await new Promise(r => setTimeout(r, 250));
      }
      return { ...window.__adbview.state(), status: window.__adbview.status(), listed: 0, openMs: -1 };
    })()
  `);
  ok('the picked file opened over Blob.slice', !!opened.db, JSON.stringify(opened));
  ok('token index built from the local file', opened.tokens > 1000, `${opened.tokens} tokens, container open ${opened.openMs} ms`);

  // 開檔成本細分：讀取次數／位元組／各階段毫秒（file:// 只能靠 Blob.slice）
  const breakdown = await cdp.eval<any>(`
    (async () => {
      for (let i = 0; i < 60; i++) {
        const b = window.__adbview.openBreakdown();
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
    rows: document.querySelectorAll('#tokenRows .tokenRow').length,
    meta: document.querySelector('#meta').textContent.trim().slice(0, 80),
    containers: document.querySelector('#containers').textContent.trim().slice(0, 60),
  }))()`);
  ok('UI rendered from the local file', Number(dom.rows) >= 200 && String(dom.meta).length > 10, JSON.stringify(dom).slice(0, 160));

  // 開檔後：預設不是進階模式 —— 沒有 posting list 面板、沒有 token 分頁
  const initial = await cdp.eval<{ postingGone: boolean; adv: boolean; leftTab: string; rightTab: string; tokenHidden: boolean }>(`
    (() => {
      const st = window.__adbview.state();
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

  // isolate: bisect where the token-click path hangs (printed, not asserted)
  const iso1 = await cdp.eval<string>("(() => { window.__adbview.setAdvanced(true); window.__adbview.showTab('token','left'); return 'iso1 ok'; })()");
  console.log('      ' + iso1);
  await cdp.eval("new Promise((r) => setTimeout(r, 300)).then(() => 1)");
  const iso2 = await cdp.eval<string>("document.querySelectorAll('#tokenRows .tokenRow').length + ' rows'")
  ;
  console.log('      ' + iso2);
  const iso3b = await cdp.eval<string>("(() => { const r = document.querySelectorAll('#tokenRows .tokenRow')[0]; return 'onclick=' + (typeof r.onclick) + ' title=' + r.textContent.slice(0, 10); })()");
  console.log('      ' + iso3b);
  const bcPoll = await cdp.eval<string>(`
    (async () => {
      document.querySelectorAll('#tokenRows .tokenRow')[0].click();
      const out = [];
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 300));
        out.push(JSON.stringify(window.__adbview.state().bc));
        if (document.querySelector('#docText mark.docHit')) { out.push('MARK'); break; }
      }
      return out.join(' | ');
    })()
  `).catch((e) => 'EVAL FAILED: ' + e.message);
  console.log('      bc => ' + bcPoll);
  const marked = await cdp.eval<{ mark: string; line: string | null; head: string; pinned: any; gone: boolean }>(`
    (async () => {
      const waitMark = async () => {
        for (let i = 0; i < 50; i++) {
          if (document.querySelector('#docText mark.docHit')) return;
          await new Promise(r => setTimeout(r, 200));
        }
      };
      // token browsing is an advanced-mode feature
      window.__adbview.setAdvanced(true);
      window.__adbview.showTab('token', 'left');
      await new Promise(r => setTimeout(r, 300));
      document.querySelectorAll('#tokenRows .tokenRow')[0].click();
      await waitMark();
      const st = window.__adbview.state();
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
    JSON.stringify(marked.pinned) + ' ｜ linkLog=' + JSON.stringify((await cdp.eval('window.__adbview.state().linkLog'))));
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
  const advMode = await cdp.eval<{ offTab: string; offRight: string; offHidden: boolean; onHidden: boolean; firstTab: string }>(`
    (async () => {
      window.__adbview.setAdvanced(false);
      await new Promise(r => setTimeout(r, 300));
      const tokenBtn = document.querySelector('#colLeft .tabBtn[data-tab="token"]');
      const metaBtn = document.querySelector('#colRight .tabBtn[data-tab="meta"]');
      const offHidden = getComputedStyle(tokenBtn).display === 'none' && getComputedStyle(metaBtn).display === 'none';
      window.__adbview.setAdvanced(true);
      await new Promise(r => setTimeout(r, 300));
      const onHidden = getComputedStyle(tokenBtn).display !== 'none' && getComputedStyle(metaBtn).display !== 'none';
      window.__adbview.setAdvanced(false);
      await new Promise(r => setTimeout(r, 200));
      // the state AFTER the mode change, and the tab this database actually offers
      const st = window.__adbview.state();
      const firstTab = [...document.querySelectorAll('#colLeft .tabBtn')]
        .find((b) => getComputedStyle(b).display !== 'none' && !b.classList.contains('advOnly'))?.dataset.tab ?? '';
      return { offTab: st.leftTab, offRight: st.rightTab, offHidden, onHidden, firstTab };
    })()
  `);
  ok('進階模式可切換，關閉時收起進階分頁並回到預設分頁',
    advMode.offHidden && advMode.onHidden && !!advMode.firstTab && advMode.offTab === advMode.firstTab,
    JSON.stringify(advMode));

  // header 三顆開關都是圖示，沒有中文 label（中文只放在 tooltip）
  const icons = await cdp.eval<{ labels: string[]; tips: string[]; adv: string }>(`
    (() => {
      const ids = ['toggleLeft', 'toggleRight', 'advToggle'];
      const els = ids.map((id) => document.getElementById(id));
      return {
        labels: els.map((e) => e.textContent.trim()),
        tips: els.map((e) => e.title),
        adv: document.getElementById('advToggle').textContent.trim(),
      };
    })()
  `);
  ok('欄位／進階開關只用圖示（無中文 label）',
    icons.labels.every((t) => t.length > 0 && !/[\u4e00-\u9fff]/.test(t)) && icons.tips.every((t) => /[\u4e00-\u9fff]/.test(t)),
    `圖示 ${JSON.stringify(icons.labels)}；tooltip ${JSON.stringify(icons.tips.map((t) => t.slice(0, 12)))}`);
  // 載入後：檔案輸入隱藏，改由「＋」開別的庫；已開的庫各一個 chip，只有 active 帶 ✕
  const headerUi = await cdp.eval<{ fileHidden: boolean; addVisible: boolean; addIsButton: boolean; chips: number; activeChips: number; names: string[]; activeName: string; closes: number }>(`
    (() => {
      const f = document.querySelector('#file');
      const add = document.querySelector('#dbAdd');
      const chips = [...document.querySelectorAll('#dbTabs .dbChip')];
      const active = chips.filter((c) => c.classList.contains('active'));
      return {
        fileHidden: getComputedStyle(f).display === 'none',
        addVisible: !!add && getComputedStyle(add).display !== 'none',
        addIsButton: add?.tagName === 'BUTTON',
        chips: chips.length,
        activeChips: active.length,
        names: chips.map((c) => c.textContent.replace('✕', '').trim()),
        activeName: active[0]?.textContent.replace('✕', '').trim() ?? '',
        closes: document.querySelectorAll('#dbTabs .dbChipClose').length,
      };
    })()
  `);
  ok('載入後檔案輸入隱藏、＋可開檔、庫名在 chip 上（active 才有 ✕）',
    headerUi.fileHidden && headerUi.addVisible && headerUi.addIsButton
    && headerUi.chips === 1 && headerUi.activeChips === 1 && headerUi.closes === 1 && !!headerUi.activeName,
    JSON.stringify(headerUi));

  // 全文搜尋：輸入 → 摘要 → 點摘要才聯動本文（輸入本身不動本文）
  const search = await cdp.eval<{
    meta: string; metaOk: boolean; snippets: number; marked: string; clicked: boolean;
    line: string | null; inputStable: boolean; tabs: string;
  }>(`
    (async () => {
      const q = document.querySelector('#query');
      // pick a phrase that exists in this database
      const db = window.__adbview.state().db;
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
          const st = window.__adbview.state();
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
        window.__adbview.showTab('sum', 'right');   // 摘要在右欄
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
  // 目錄樹（<樹> 解析 → 右欄「目錄」分頁）
  const tree = await cdp.eval<{
    tabs: string; rows: number; meta: string; labels: string[]; dots: string[];
    twisty: number; line: string | null; jumped: string | null; rootRows: number; dbg?: string;
  }>(`
    (async () => {
      window.__adbview.showTab('dir', 'left');
      // the tree is built asynchronously (labels walk the source text)
      for (let i = 0; i < 60; i++) {
        if (!window.__adbview.state().dirLoading) break;
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
          dbg: JSON.stringify(window.__adbview.state().dirInfo),
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
        jumped: window.__adbview.state().lastReveal,
        rootRows,
      };
    })()
  `);
  ok('目錄樹分頁在左欄、右欄是 META 等', tree.tabs.includes('meta') && !tree.tabs.includes('tree'), 'tabs = ' + tree.tabs);
  const dirState = await cdp.eval<{ dirRows: number; html: number; pane: string; meta: string; err: string; loading: boolean }>(`
    (() => {
      const st = window.__adbview.state();
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
  ok('目錄樹狀態可用', dirState.html > 100 && dirState.dirRows > 0,
    `${dirState.dirRows} 列在 DOM，pane ${dirState.pane}，loading=${dirState.loading}｜${dirState.meta}${dirState.err ? ' ERR ' + dirState.err.slice(0, 120) : ''}`);
  ok('目錄樹列出 <樹> 的節點', tree.rows >= 2,
    `${tree.rows} 列（twisty ${tree.twisty}），第一層標籤 ${JSON.stringify(tree.labels)}｜${tree.meta}`);
  const dirState2 = await cdp.eval<{ tiers: string[]; nodes: number; roots: number }>(`window.__adbview.state().dirInfo`);
  ok('預設目錄＝第一個有 t= 的 <樹>', dirState2?.tiers?.length > 0 && dirState2.nodes > 0,
    `${dirState2?.roots} 根 / ${dirState2?.nodes} 節點，層級 ${JSON.stringify(dirState2?.tiers)}`);

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
  const dirTabShown = await cdp.eval<boolean>("getComputedStyle(document.querySelector('#colLeft .tabBtn[data-tab=\"dir\"]')).display !== 'none'");
  ok('目錄樹可逐層展開（書 → 章→ 節）',
    !dirTabShown || (depthTest.afterBook > depthTest.bookRows && (!depthTest.deeper || depthTest.afterChapter > depthTest.afterBook)),
    `收合 ${depthTest.bookRows} 列 → 展開書 ${depthTest.afterBook} 列`
    + `${depthTest.deeper ? ` → 展開章 ${depthTest.afterChapter} 列` : '（此庫此書的章為末層）'}`
    + `；章標籤 ${JSON.stringify(depthTest.chapterLabels)}；層級 ${depthTest.levels}`);
  ok('第一層子節點有名字', depthTest.chapterLabels.every((s) => !!s && s.trim().length > 0),
    JSON.stringify(depthTest.chapterLabels));

  // 每一本書都能展開（只有第一本帶 t=，其餘用標籤層級預設），且點書（的節點記號）會跳到該 <書> 所在行
  const everyBook = await cdp.eval<{ expandable: number; total: number; clicked: string; line: string | null; status: string; bookLabels: string[] }>(`
    (async () => {
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
        db: window.__adbview.state().db,
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
  ok('每本書都有名字', everyBook.bookLabels.length >= wantBooks && everyBook.bookLabels.every((s) => !!s && !!s.trim()),
    `${everyBook.bookLabels.length} 本（${everyBook.db}），其中 ${fallbacks} 個用編號 fallback`);
  ok('主要書名都解析出來（前 10 本無 #N fallback）',
    everyBook.bookLabels.slice(0, 10).every((s) => !!s && !/^#\d+$/.test(s)),
    `${JSON.stringify(everyBook.bookLabels.slice(0, 5))} … ${JSON.stringify(everyBook.bookLabels.slice(-2))}`);
  // A book whose range holds no child tier at all is legitimately a leaf, so the
  // requirement is that the great majority expand (13j 13/13 after the inherited
  // slot fix; yinshun 43/44).
  ok('絕大多數書都能展開（範圍內沒有子層的書是葉節點）',
    everyBook.expandable >= everyBook.total - 1,
    `${everyBook.expandable}/${everyBook.total} 本可展開`);
  ok('點目錄節點跳到該位置的本文', !!everyBook.line, `點「${everyBook.clicked}」→ 行 ${everyBook.line}；${everyBook.status}`);

  // 目錄節點顯示「該節點 realm 內的命中數」（用 posting 的 VA 與節點範圍算）
  const realm = await cdp.eval<{ total: number; badges: number[]; first: number; rows: number }>(`
    (async () => {
      const q = document.querySelector('#query');
      q.value = window.__adbview.state().db === '13j' ? '象曰' : '大乘';
      q.dispatchEvent(new Event('input'));
      for (let i = 0; i < 60; i++) {
        if (document.querySelector('#dirTree .tCount.hit')) break;
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
    realm.first > 0 && realm.badges.every((b) => b > 0 && b <= realm.total),
    `第一個節點 ${realm.first}、總命中 ${realm.total}（${realm.rows} 列，最大 ${Math.max(...realm.badges)}）`);

  // 點 tCount > 顯示該節點命中的摘要（摘要範圍限在該節點 realm 內，本文不動）
  const badgeClick = await cdp.eval<{
    badge: number; metaOk: boolean; maxVa: number; minVa: number; to: number; from: number; snippets: number; meta: string; scoped: boolean;
  }>(`
    (async () => {
      document.querySelector('#dirTree .tCount.hit').scrollIntoView({ block: 'center' });
      const badge = Number(document.querySelector('#dirTree .tCount.hit').textContent.replace(/,/g, ''));
      document.querySelector('#dirTree .tCount.hit').click();
      // the scoped summary may be rebuilt by a debounced re-search of the SAME
      // query, so let it settle before reading the pane
      let scoped = false;
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 100));
        if (window.__adbview.state().snippetScope) scoped = true;
      }
      const st = window.__adbview.state();
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
    badgeClick.scoped && badgeClick.metaOk && badgeClick.snippets > 0
    && badgeClick.minVa >= badgeClick.from && badgeClick.maxVa < badgeClick.to,
    `徽章 ${badgeClick.badge}、${badgeClick.snippets} 筆摘要落在 [${badgeClick.from}, ${badgeClick.to})｜${badgeClick.meta}`);

  // 聯動本文的動作：Ctrl+點 → 開新的本文分頁；Alt+點 → 展開全部子孫（舊版是 Ctrl）
  const clicks = await cdp.eval<{
    tabNew: number; tabSame: number; tabAfterPages: number; altExpands: boolean;
    nodeOpens: boolean; ctrlOld: boolean; ctrlRows: number; ctrlBook: string; ctrlWasOpen: boolean;
    before: number; after: number; label: string; dotLine: string | null; dotStatus: string;
  }>(`
    (async () => {
      const rows = () => [...document.querySelectorAll('#dirTree .tRow')];
      const books = () => rows().filter((r) => r.querySelector('.tTag')?.textContent === '書');
      const spec = () => window.__adbview.state().docTabs.length;
      const settle = async () => {
        for (let i = 0; i < 30; i++) {
          await new Promise((r) => setTimeout(r, 200));
          if (document.querySelector('#docText .docLine.hitLine') && window.__adbview.state().pinned) return;
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
      // Ctrl+點：聯動本文時開一個新的本文分頁
      const beforeCtrlTabs = spec();
      const target = books()[books().length - 1];
      const ctrlCount = beforeCtrlTabs;
      void ctrlCount;
      target.querySelector('.tName').dispatchEvent(new MouseEvent('click', { ctrlKey: true, bubbles: true }));
      // The link is ASYNC and can be slow: this is the last book, so its first page
      // decodes blocks at the very end of the 24 MB database. A fixed 1400 ms sleep
      // read the tab count before the tab existed (measured: the same click landed
      // 1.2 s later, during the next step). Poll for it instead.
      for (let i = 0; i < 40 && spec() === beforeCtrlTabs; i++) await new Promise((r) => setTimeout(r, 250));
      const tabNew = spec() - beforeCtrlTabs;
      // Ctrl+點箭頭不該展開全部子孫：把一本書打開後 Ctrl+點它的箭頭，應該收合
      const b2 = books()[2];
      if (b2.querySelector('.tTwisty').textContent.trim() === '▸') {
        b2.querySelector('.tTwisty').click();
        await new Promise((r) => setTimeout(r, 700));
      }
      const ctrlWasOpen = b2.querySelector('.tTwisty').textContent.trim() === '▾';
      const openRows = rows().length;
      const ctrlBook = b2.querySelector('.tName')?.textContent ?? '?';
      b2.querySelector('.tTwisty').dispatchEvent(new MouseEvent('click', { ctrlKey: true, bubbles: true }));
      await new Promise((r) => setTimeout(r, 900));
      const ctrlRows = rows().length;
      // Ctrl is a plain fold/open now: an open book folds, it never explodes
      const ctrlOld = ctrlWasOpen && ctrlRows >= openRows;
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
      const db = window.__adbview.state().db;
      const wanted = db === '13j' ? '尚書' : (books()[1]?.querySelector('.tName')?.textContent ?? '');
      const targetBook = books().find((r) => r.querySelector('.tName').textContent === wanted) ?? books()[1];
      const label = targetBook?.querySelector('.tName')?.textContent ?? '(none)';
      const nodeVa = Number(targetBook?.dataset.va ?? -1);
      const dot = targetBook?.querySelector('.tDot');
      dot?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 200));
        const st = window.__adbview.state();
        if (st.pinned && st.pinned.va === nodeVa && document.querySelector('#docText .docLine.hitLine')) break;
      }
      const pinnedVa = window.__adbview.state().pinned ? window.__adbview.state().pinned.va : -1;
      return {
        tabNew, tabSame, tabAfterPages, altExpands, nodeOpens, ctrlOld, ctrlRows, ctrlBook, ctrlWasOpen,
        before, after, label,
        nodeVa, pinnedVa,
        dotDbg: JSON.stringify({
          page: window.__adbview.state().docPage, pages: window.__adbview.state().docTabPages,
          realm: window.__adbview.state().docRealm, tab: window.__adbview.state().docTabs[window.__adbview.state().docTab],
          first: document.querySelector('#docText .docLine')?.id,
          last: [...document.querySelectorAll('#docText .docLine')].pop()?.id,
          allTabs: window.__adbview.state().docTabs,
        }),
        dotLine: document.querySelector('#docText .docLine.hitLine')?.id ?? null,
        dotStatus: document.querySelector('#status').textContent.slice(0, 70),
      };
    })()
  `);
  ok('點節點（開得起來就開）並聯動本文', clicks.nodeOpens,
    `${clicks.before} → ${clicks.after} 列，聯動到 ${clicks.dotLine}（新增 ${clicks.tabSame} 分頁）`);
  ok('Ctrl+點節點：聯動本文時開新的本文分頁', clicks.tabNew === 1, `Ctrl+點後分頁 +${clicks.tabNew}`);
  ok('Ctrl+點不再展開全部子孫（已改為 Alt）', !clicks.ctrlOld,
    `Ctrl+點「${clicks.ctrlBook}」箭頭（原本 ${clicks.ctrlWasOpen ? '開' : '關'}）→ ${clicks.ctrlRows} 列`);
  ok('Alt+點節點名展開全部子孫', clicks.altExpands, `Alt+點後 ${clicks.altExpands}`);
  ok('切換本文分頁不會再生分頁', clicks.tabAfterPages === 0, `+${clicks.tabAfterPages}`);
  // The status names the DEEPEST node holding the VA, which in a dictionary is
  // often a page below the row that was clicked, so the strong check is the VA.
  ok('點色塊會聯動內文到該節點',
    clicks.pinnedVa === clicks.nodeVa && !!clicks.dotLine,
    `點「${clicks.label}」的色塊 → 行 ${clicks.dotLine}（VA ${clicks.pinnedVa} / 節點 ${clicks.nodeVa}）；${clicks.dotStatus}｜${clicks.dotDbg}`);
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
      q.value = window.__adbview.state().db === '13j' ? '象曰' : '大乘';
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
        jumped: window.__adbview.state().lastReveal,
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
      const db = window.__adbview.state().db;
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

  // ---- 使用者測試報告（fgdict）的回歸 --------------------------------------
  // 全文／頻次面板：筆數與段名同一行、頁籤名＝段名、把查詢詞塗紅、摘要聯動該段
  // 原書分頁：頁籤名＝頁碼、不塗紅、把 <_頁> 捲進畫面、連點不重複開分頁
  const report = await cdp.eval<any>(`
    (async () => {
      const wait = async (fn, n = 60) => { for (let i = 0; i < n; i++) { if (fn()) return true; await new Promise(r => setTimeout(r, 200)); } return false; };
      const st = () => window.__adbview.state();
      const out = { db: st().db, treeMs: window.__adbview.openBreakdown()?.treeMs ?? -1, phases: st().treePhases, earlyTab: st().leftTab };
      // 名詞 pane render time (the caches/<tag> string table path)
      const termsTab = document.querySelector('#colLeft .tabBtn[data-tab="terms"]');
      if (termsTab && !termsTab.hidden) {
        termsTab.click();
        const t0 = performance.now();
        await wait(() => document.querySelector('#termsList .snippet'), 60);
        out.termsMs = Math.round(performance.now() - t0);
        out.termsRows = document.querySelectorAll('#termsList .snippet').length;
      }
      const freqTab = document.querySelector('#colLeft .tabBtn[data-tab="freq"]');
      if (freqTab && !freqTab.hidden) {
        freqTab.click();
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
        row?.click();
        // poll for the QUERY to be painted (not merely for any mark): the page has to
        // move to the hit first, which can take a moment on a 22k-segment dictionary
        await wait(() => (document.querySelector('#docText mark.docHit')?.textContent ?? '').includes(word), 40);
        await new Promise(r => setTimeout(r, 400));
        out.freq = {
          word, rowName, rowCount, sameLine, found: !!row,
          tabName: st().docTabs[st().docTab]?.name ?? '',
          marks: document.querySelectorAll('#docText mark.docHit').length,
          markText: document.querySelector('#docText mark.docHit')?.textContent ?? '',
          pin: JSON.stringify(st().pinned),
          lineText: (document.getElementById('L' + (st().pinned?.line ?? -1))?.textContent ?? '').slice(0, 60),
          sumItems: document.querySelectorAll('#searchList .snippet').length,
          sumMeta: document.querySelector('#searchMeta').textContent.slice(0, 50),
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
  if (report.freq) {
    const f = report.freq;
    ok('全文：命中數與段名同一行（不再分行）', f.sameLine, `row=${JSON.stringify(f.rowName)} count=${f.rowCount}`);
    ok('全文：點段名→本文頁籤名為段名', f.found && f.tabName === f.rowName, `tab=${JSON.stringify(f.tabName)} row=${JSON.stringify(f.rowName)}`);
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
      const word = window.__adbview.state().db === '13j' ? '象曰' : '印順';
      q.value = word;
      q.dispatchEvent(new Event('input'));
      await new Promise(r => setTimeout(r, 1600));
      const first = document.querySelector('#searchList .snippet');
      if (first) first.click();
      for (let i = 0; i < 50; i++) {
        if (document.querySelector('#docText mark.docHit')) break;
        await new Promise(r => setTimeout(r, 200));
      }
      const st = window.__adbview.state();
      const spans = await window.__adbview.pinnedSpans();
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
        dbg: window.__adbview.debugDoc(),
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
  ok('標題為 accelon26', paint.title.replace(/\\s+/g, '') === 'accelon26', JSON.stringify(paint.title));
  ok('重設欄寬按鈕已移除', paint.resetGone, 'no #resetCols');

  // 分頁（網頁分頁＝page，不是原書的葉）：一次只載一頁，底部有上一頁／下一頁
  const paging = await cdp.eval<{
    pages: number; pageLines: number; nav: boolean; lineFirst: string; lineSecond: string;
    textChanged: boolean; back: boolean; clickMoved: boolean; realmOk: boolean; info: string;
  }>(`
    (async () => {
      window.__adbview.showTab('dir', 'left');
      const rows = () => [...document.querySelectorAll('#dirTree .tRow')];
      const wait = async (fn) => { for (let i = 0; i < 60; i++) { if (fn()) return true; await new Promise(r => setTimeout(r, 200)); } return false; };
      const books = () => rows().filter((r) => r.querySelector('.tTag')?.textContent === '書');
      // a node that is CLOSED has children and a range, so clicking it opens and links
      const closed = books().find((r) => r.querySelector('.tTwisty')?.textContent.trim() === '▸');
      (closed ?? books()[0]).querySelector('.tDot').click();
      await wait(() => !!document.querySelector('#docText .hitLine'));
      await new Promise(r => setTimeout(r, 400));
      const st = window.__adbview.state();
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
      const st2 = window.__adbview.state();
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
      const c = window.__adbview.cols();
      return {
        left: c.left, right: c.right,
        stored: localStorage.getItem('adbview.cols.v2') ?? '(none)',
        lineNo: !!document.querySelector('#docText .lineNo'),
        fs: window.__adbview.docFont(),
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

  // 字級：＋／− 生效、存檔、自動「不換行」確實讓行不再溢出（更小的溢出＝更少軟換行）
  const font = await cdp.eval<{ up: string; down: string; stored: string; auto: number; before: any; after: any }>(`
    (async () => {
      window.__adbview.setDocFont(30);                 // deliberately too large
      await new Promise(r => setTimeout(r, 150));
      const before = window.__adbview.debugDoc();
      const auto = window.__adbview.autoFitFont();
      await new Promise(r => setTimeout(r, 150));
      const after = window.__adbview.debugDoc();
      window.__adbview.setDocFont(16);
      document.querySelector('#fsUp').click(); document.querySelector('#fsUp').click();
      const up = document.querySelector('#fsValue').textContent;
      document.querySelector('#fsDown').click();
      const down = document.querySelector('#fsValue').textContent;
      const stored = localStorage.getItem('adbview.docfs');
      window.__adbview.setDocFont(16);
      return { up, down, stored, auto, before, after };
    })()
  `);
  ok('字級 ＋／− 生效並存檔', font.up === '20' && font.down === '18' && font.stored === '18',
    `+2×2 → ${font.up}，−2 → ${font.down}，stored=${font.stored}`);
  const over = (d: any) => Math.max(0, (d.scrollWidth ?? 0) - (d.clientWidth ?? 0));
  // Short-line pages (a dictionary entry) may legitimately be pushed to the 40px
  // ceiling instead of shrinking, so accept that case too.
  ok('「不換行」自動字級讓行不再溢出（軟換行）',
    font.auto >= 10 && font.auto <= 40
    && (over(font.after) < over(font.before) || over(font.after) === 0 || font.auto >= 40),
    `30px 溢出 ${over(font.before)}px（最長 ${font.before.longestLine} 字 / ${font.before.sample} 行樣本）→ 自動 ${font.auto}px 溢出 ${over(font.after)}px`);

  // 「不換行」必須扣除左右欄：同一份文件，把左欄收起後中間變寬，自動字級必須變大
  const fitWidth = await cdp.eval<{ narrow: number; wide: number; widths: string }>(`
    (async () => {
      window.__adbview.setCols(25, 0);                 // default: left column open
      await new Promise(r => setTimeout(r, 250));
      const narrow = window.__adbview.autoFitFont();
      const w1 = Math.round(document.querySelector('#docText .docBody').clientWidth);
      window.__adbview.setCols(0, 0);                  // left column collapsed
      await new Promise(r => setTimeout(r, 300));
      const wide = window.__adbview.autoFitFont();
      const w2 = Math.round(document.querySelector('#docText .docBody').clientWidth);
      window.__adbview.setCols(25, 0);
      await new Promise(r => setTimeout(r, 250));
      return { narrow, wide, widths: w1 + 'px -> ' + w2 + 'px' };
    })()
  `);
  // A wider pane may already be at the 40px ceiling (short-line dictionaries), so
  // require "never smaller, and strictly larger while there is headroom".
  ok('自動字級會扣除左右欄寬度（左欄收起 → 字級變大或不小於）',
    fitWidth.wide >= fitWidth.narrow && (fitWidth.wide >= 40 || fitWidth.wide > fitWidth.narrow),
    `中間欄 ${fitWidth.widths}：左欄開 ${fitWidth.narrow}px → 左欄收 ${fitWidth.wide}px｜fit=${JSON.stringify(await cdp.eval('window.__adbview.state().lastFit'))}`);
  const fitDbg = await cdp.eval<unknown>(`JSON.stringify(window.__adbview.fitDebug())`);
  console.log('      fitDebug = ' + fitDbg);

  // 欄寬：預設左 25 / 右 0（關閉）、可拖曳、低於 15% 自動隱藏、可一鍵開回
  const cols = await cdp.eval<{ def: any; dragged: any; snapped: any; back: any; widths: string }>(`
    (async () => {
      window.__adbview.setCols(25, 0);                     // the shipped default
      const def = window.__adbview.cols();
      window.__adbview.setCols(40, 20);
      const dragged = window.__adbview.cols();
      window.__adbview.setCols(8, 20);                     // below the 15% minimum
      const snapped = window.__adbview.cols();
      window.__adbview.setCols(25, 25);
      const back = window.__adbview.cols();
      await new Promise(r => setTimeout(r, 100));
      const g = getComputedStyle(document.querySelector('main')).gridTemplateColumns;
      window.__adbview.setCols(25, 0);
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
      window.__adbview.setCols(25, 25);
      const sp = document.querySelector('#splitLeft');
      const r = sp.getBoundingClientRect();
      const y = r.top + r.height / 2;
      const before = window.__adbview.cols().left;
      sp.dispatchEvent(new PointerEvent('pointerdown', { clientX: r.left + 2, clientY: y, bubbles: true, pointerId: 1 }));
      sp.dispatchEvent(new PointerEvent('pointermove', { clientX: r.left + 2 + window.innerWidth * 0.1, clientY: y, bubbles: true, pointerId: 1 }));
      sp.dispatchEvent(new PointerEvent('pointerup', { clientX: r.left + 2 + window.innerWidth * 0.1, clientY: y, bubbles: true, pointerId: 1 }));
      await new Promise(rr => setTimeout(rr, 100));
      const after = window.__adbview.cols().left;
      window.__adbview.setCols(25, 0);
      return before + '% -> ' + after + '% (center ' + window.__adbview.cols().css.center + ')';
    })()
  `);
  ok('拖曳 splitter 會改變欄寬', /25% -> 3[0-9]%/.test(drag), drag);

  // 側欄 header 按鈕可各自切換（兩側獨立）
  const ui2 = await cdp.eval<{ hidden: string; back: string }>(`
    (async () => {
      window.__adbview.setCols(25, 0);                       // shipped default
      window.__adbview.toggleSide('left');                   // 25/0 -> 0/0
      await new Promise(r => setTimeout(r, 60));
      const hidden = window.__adbview.cols().left + '/' + window.__adbview.cols().right;
      window.__adbview.toggleSide('left');                   // 0/0 -> 25/0
      window.__adbview.toggleSide('right');                  // 25/0 -> 25/25
      await new Promise(r => setTimeout(r, 60));
      const back = window.__adbview.cols().left + '/' + window.__adbview.cols().right;
      window.__adbview.setCols(25, 0);
      return { hidden, back };
    })()
  `);
  ok('左右欄可各自切換隱藏／顯示', ui2.hidden === '0/0' && ui2.back === '25/25', `${ui2.hidden} → ${ui2.back}`);

  const res = await cdp.eval<string>(`document.querySelector('#resources').textContent.replace(/\\s+/g,' ').trim().slice(0, 70)`);
  ok('resources pane reports state on file://', res.length > 0, res);

  const errors = cdp.logs.filter((l) => l.startsWith('exception'));
  // 走訪目錄不按 Ctrl 不該多開分頁（需求三）。放在最後：它會改變本文狀態，而前面的
  // 斷言都是針對特定頁／字級，插在中間會把它們全部打亂。
  const walk = await cdp.eval<{ added: number; tabs: number }>(`
    (async () => {
      const spec = () => window.__adbview.state().docTabs.length;
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
