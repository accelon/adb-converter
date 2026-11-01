/**
 * 「閱讀狀態」匯出／載入 與「啟動恢復開著的 adb」的實測（作者 2026-11-01）。
 *
 *   bun run tools/read-state-test.ts [--adb <A>] [--adb2 <B>] [--html build/accelon26.html]
 *
 * 驗的是：
 *   1. 匯出的 JSON 有 format／name／userId／app／ui／dbs／tabs／active
 *   2. **active 本文的選取區**（行號＋行內漢字＋文字）真的有記下來
 *   3. 檔名是「修訂者 ID ＋ 純數字本地時間」
 *   4. 載入後回到同一個庫／分頁／頁碼，並把選取區還原（getSelection 的內容一樣）
 *   5. settings.json 的 `reading` 記住開著的 adb 與 active（桌面版啟動恢復用）
 */
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const HTML = resolve(opt('html', resolve(import.meta.dir, '../../build/accelon26.html')));
const ADB_A = resolve(opt('adb', resolve(import.meta.dir, '../../13j.adb')));
const ADB_B = resolve(opt('adb2', resolve(import.meta.dir, '../../build/jingang-group.adb')));
const PORT = Number(opt('port', String(8700 + Math.floor(Math.random() * 90))));

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const browser = BROWSERS.find((p) => existsSync(p));
if (!browser) { console.error('no Chromium browser found'); process.exit(2); }
if (!existsSync(HTML)) { console.error('missing ' + HTML); process.exit(2); }
if (!existsSync(ADB_A)) { console.error('missing ' + ADB_A); process.exit(2); }
if (!existsSync(ADB_B)) { console.error('missing ' + ADB_B); process.exit(2); }

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + name + (detail ? '  ' + detail : '')); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
};

const server = Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/accelon26.html') {
      return new Response(Bun.file(HTML), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    if (url.pathname === '/a.adb') return new Response(Bun.file(ADB_A), { headers: { 'Content-Type': 'application/octet-stream' } });
    if (url.pathname === '/b.adb') return new Response(Bun.file(ADB_B), { headers: { 'Content-Type': 'application/octet-stream' } });
    return new Response('not found', { status: 404 });
  },
});

const profile = resolve(import.meta.dir, `../../build/.chrome-profile-rs-${process.pid}-${Date.now() % 100000}`);
const proc = Bun.spawn([browser, '--headless=new', '--disable-gpu', '--no-first-run',
  '--remote-debugging-port=0', '--remote-allow-origins=*',
  `--user-data-dir=${profile}`, '--no-default-browser-check',
  'about:blank'], { stdout: 'pipe', stderr: 'pipe' });

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
      c.ws.onerror = (e) => rej(new Error('ws error ' + String(e)));
      c.ws.onmessage = (ev) => {
        const m = JSON.parse(String(ev.data));
        if (m.id && c.pending.has(m.id)) {
          const p = c.pending.get(m.id)!; c.pending.delete(m.id);
          m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
          return;
        }
        if (m.method === 'Runtime.exceptionThrown') {
          c.logs.push('exception: ' + (m.params.exceptionDetails?.exception?.description ?? '?'));
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
      this.pending.set(id, { resolve: res, reject: rej });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => { if (this.pending.delete(id)) rej(new Error('timeout ' + method)); }, 180000);
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
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
    return r.result.value as T;
  }
}

const H = `
  const st = () => window.__accelon26.state();
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const waitTree = async () => {
    for (let i = 0; i < 300; i++) {
      const p = st().treePhases ?? {};
      if (p.instances !== undefined || p.skipped !== undefined) return true;
      await sleep(120);
    }
    return false;
  };
  const openDb = async (path, name) => {
    const res = await fetch(path);
    const blob = await res.blob();
    await window.__accelon26.openFile(new File([blob], name, { type: 'application/octet-stream' }));
    await waitTree();
    await sleep(400);
  };
  const clickTreeRow = async (n = 1) => {
    const rows = [...document.querySelectorAll('#dirTree .tRow')];
    const row = rows[Math.max(0, Math.min(n, rows.length - 1))];
    if (!row) return null;
    (row.querySelector('.tName') ?? row).click();
    for (let i = 0; i < 120; i++) {
      if (document.querySelectorAll('#docTabStrip .docTab').length > 0) break;
      await sleep(120);
    }
    await sleep(500);
    return { va: Number(row.dataset.va), rows: rows.length };
  };
  // 在本文第 n 個「有足夠字的行」選取第 a..b 個字（用真實 Range，等於使用者拖選）
  const selectInDoc = (a = 2, b = 7) => {
    const lines = [...document.querySelectorAll('#docText .docLine')];
    for (const line of lines) {
      const host = line.querySelector('.lineText');
      if (!host) continue;
      const w = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
      const t = w.nextNode();
      if (!t || (t.nodeValue ?? '').length < b + 1) continue;
      const r = document.createRange();
      r.setStart(t, a);
      r.setEnd(t, b);
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(r);
      return { line: Number(line.id.slice(1)), text: r.toString(), host: t.nodeValue };
    }
    return null;
  };
`;

try {
  const cdp = await Cdp.attach(await devtoolsUrl());
  await cdp.openPage(`http://127.0.0.1:${PORT}/accelon26.html`);
  await Bun.sleep(700);

  // 1) 打開 A，點目錄開一頁本文，選一段文字，匯出一份狀態
  const captured = await cdp.eval<any>(`
    (async () => {
      ${H}
      window.__accelon26.setUserId('tester');
      await openDb('/a.adb', 'a.adb');
      const row = await clickTreeRow(4);
      const sel = selectInDoc(2, 7);
      const state = window.__accelon26.readState('編輯前');
      const json = window.__accelon26.readStateJson('編輯前');
      const filename = window.__accelon26.readStateFilename();
      // 「開著哪幾個 adb」只在離開 exe 之前寫（作者 2026-11-01）
      const beforeExit = await window.__accelon26.openSet();
      window.__accelon26.saveOnExit();
      const openSet = await window.__accelon26.openSet();
      return {
        row, sel,
        state: {
          format: state.format, version: state.version, name: state.name,
          userId: state.userId, exportedAt: state.exportedAt,
          app: state.app, ui: state.ui,
          dbs: state.dbs.map((d) => ({ name: d.name, dbname: d.dbname, active: d.active, tabs: d.tabs })),
          tabs: state.tabs.map((t) => ({ name: t.name, db: t.db, realm: t.realm, page: t.page, active: t.active })),
          active: state.active && {
            tab: state.active.tab, db: state.active.db, name: state.active.name,
            realm: state.active.realm, page: state.active.page, pages: state.active.pages,
            selection: state.active.selection, head: state.active.pageHead,
            pinned: state.active.pinned && { va: state.active.pinned.va, token: state.active.pinned.token },
          },
          diagnostics: state.diagnostics,
        },
        jsonLen: json.length,
        json,
        filename,
        beforeExit,
        openSet: openSet && { dbs: openSet.dbs.map((d) => d.name), active: openSet.active },
      };
    })()
  `);

  const st = captured.state;
  ok('匯出：是 accelon26 的閱讀狀態檔（format／version）',
    st.format === 'accelon26-readstate' && st.version === 1, `${st.format} v${st.version}、名稱「${st.name}」`);
  ok('匯出：記了修訂者 ID 與本地時間',
    st.userId === 'tester' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(st.exportedAt),
    `userId=${st.userId}、exportedAt=${st.exportedAt}`);
  ok('匯出：檔名是「修訂者 ID ＋ 純數字本地時間」',
    /^tester\d{14}\.json$/.test(captured.filename), captured.filename);
  ok('匯出：記了開著的 adb 與 active',
    st.dbs.length === 1 && st.dbs[0].active === true && !!st.dbs[0].dbname,
    JSON.stringify(st.dbs));
  ok('匯出：記了本文分頁（realm／頁碼）',
    st.tabs.length >= 1 && st.active && st.active.realm && st.active.page >= 0,
    `tabs=${JSON.stringify(st.tabs)}、active page=${st.active?.page}/${st.active?.pages}`);
  ok('匯出：★ 本文的選取區（行號＋行內漢字＋文字）',
    !!st.active?.selection && st.active.selection.text === captured.sel?.text
    && Number.isFinite(st.active.selection.fromLine) && st.active.selection.fromLine === captured.sel?.line
    && st.active.selection.fromHan >= 0
    && st.active.selection.toHan >= st.active.selection.fromHan,
    `選「${captured.sel?.text}」→ ${JSON.stringify(st.active?.selection)}`);
  ok('匯出：選取區那一頁的開頭幾行（人看／核對用）',
    Array.isArray(st.active?.head) && st.active.head.length >= 1, JSON.stringify(st.active?.head));
  ok('匯出：介面狀態（閱讀開關、欄寬、主題、建置）',
    st.ui && typeof st.ui.hardBreaks === 'boolean' && typeof st.ui.docFont === 'number'
    && st.app && typeof st.app.userAgent === 'string' && typeof st.app.timeZone === 'string',
    `ui=${JSON.stringify({ hard: st.ui?.hardBreaks, font: st.ui?.docFont, marks: st.ui?.pageMarks })}、backend=${st.app?.backend}`);
  ok('匯出：診斷數字（分頁數／開庫數／搜尋）',
    st.diagnostics && Number.isFinite(st.diagnostics.tabCount) && Number.isFinite(st.diagnostics.openDbs),
    JSON.stringify({ tabs: st.diagnostics?.tabCount, dbs: st.diagnostics?.openDbs, query: st.diagnostics?.searchQuery }));
  ok('離開 exe 之前才寫「開著哪幾個 adb」（平時不寫）',
    captured.beforeExit === null && !!captured.openSet
    && captured.openSet.dbs.length === 1 && captured.openSet.dbs[0] === '十三經',
    `開庫後（還沒離開）=${JSON.stringify(captured.beforeExit)}、離開時寫入=${JSON.stringify(captured.openSet)}`);
  // 作者 2026-11-01：「adb 跟著 exe 走，匯出也不需要帶路徑」
  const jsonHasPath = /"path"\s*:/.test(String(captured.json ?? ''));
  const jsonHasDrive = /(^|["\s(])[A-Za-z]:[\\/]/.test(String(captured.json ?? ''));
  ok('★ 匯出的 JSON 沒有 adb 路徑（只認名字）',
    !jsonHasPath && !jsonHasDrive,
    `含 "path"=${jsonHasPath}、含磁碟機代號=${jsonHasDrive}`);

  // 2) 亂走一遍（換庫、換節點），再把狀態載回來
  const restored = await cdp.eval<any>(`
    (async () => {
      ${H}
      const json = window.__accelon26.readStateJson('編輯前');
      // 走開：開 B、點別的節點、選別的字
      await openDb('/b.adb', 'b.adb');
      await clickTreeRow(1);
      const wander = { db: st().db, realm: st().docRealm };
      const before = window.getSelection()?.toString() ?? '';
      const res = await window.__accelon26.readStateApply(json);
      await sleep(900);
      const sel = window.getSelection();
      const s2 = st();
      return {
        wander, before, res, db: s2.db, docTabDb: s2.docTabDb, realm: s2.docRealm, page: s2.docPage,
        selText: sel?.toString() ?? '', selRanges: sel?.rangeCount ?? 0,
        dbs: s2.dbs.map((d) => d.name),
        openSet: await window.__accelon26.openSet(),
      };
    })()
  `);
  ok('載入：回報套用了什麼',
    restored.res?.ok === true && (restored.res.applied ?? []).length >= 2, JSON.stringify(restored.res));
  ok('載入：回到存檔時的庫與分頁（不是剛走過去的 B）',
    restored.db === st.dbs[0].dbname && JSON.stringify(restored.realm) === JSON.stringify(st.active.realm)
    && restored.page === st.active.page + 1,
    `db=${restored.db}（檔案裡是 ${st.dbs[0].dbname}）、realm=${JSON.stringify(restored.realm)}、頁=${restored.page}/${st.active.page + 1}`);
  ok('載入：★ 選取區被還原（選到的文字一樣）',
    restored.selText === st.active.selection.text && restored.selText.length > 0 && restored.selRanges === 1,
    `選到「${restored.selText}」（存檔時「${st.active.selection.text}」）`);
  ok('載入：兩個庫都在（B 沒有被關掉）', (restored.dbs ?? []).length === 2, JSON.stringify(restored.dbs));

  // 3) 壞檔要有清楚的錯誤
  const bad = await cdp.eval<any>(`
    (async () => {
      const r1 = await window.__accelon26.readStateApply(JSON.stringify({ format: 'nope' }));
      let r2;
      try { r2 = await window.__accelon26.readStateApply('{ not json'); } catch (e) { r2 = { ok: false, error: 'parse: ' + e.message }; }
      return { r1, r2 };
    })()
  `);
  ok('載入：不是閱讀狀態檔會拒絕', bad.r1?.ok === false && /閱讀狀態/.test(bad.r1?.error ?? ''), JSON.stringify(bad.r1));
  ok('載入：壞掉的 JSON 不會炸掉整個程式', bad.r2?.ok === false, JSON.stringify(bad.r2));

  // 3) 桌面版啟動恢復：記錄「上次開著的庫」→ 全部關掉 → 用紀錄開回來
  const restoredBoot = await cdp.eval<any>(`
    (async () => {
      ${H}
      // 由 catalog 取得已載入過的 File 來源（模擬桌面版 startup 的來源清單）
      const srcs = window.__accelon26.catalogSources();
      // 「開著哪幾個 adb」只在離開那一刻寫，所以這裡先模擬一次離開
      window.__accelon26.saveOnExit();
      const saved = await window.__accelon26.openSet();
      return { srcs: srcs.length, saved: saved && { dbs: saved.dbs.map((d) => d.name), active: saved.active } };
    })()
  `);
  ok('啟動恢復：catalog 裡的來源可以當作「這台機器看得到的 adb」',
    restoredBoot.srcs >= 2 && !!restoredBoot.saved && (restoredBoot.saved.dbs ?? []).length === 2,
    `sources=${restoredBoot.srcs}、紀錄=${JSON.stringify(restoredBoot.saved)}`);

  const reboot = await cdp.eval<any>(`
    (async () => {
      ${H}
      const state0 = st();
      const saved = await window.__accelon26.openSet();
      const activeBefore = state0.db;
      const names0 = state0.dbs.map((d) => d.name);
      // 全部關掉（使用者關庫；紀錄要等「離開」那一次才會被清掉）
      const ids = [...document.querySelectorAll('#dbTabs .dbChip')].map((c) => Number(c.dataset.id));
      for (const id of ids) window.__accelon26.closeDbById(id);
      await sleep(400);
      const afterClose = { dbs: st().dbs.length, openSet: await window.__accelon26.openSet() };
      // 模擬「離開 exe」：這時才寫紀錄（全部關掉 → 紀錄應該被清掉）
      window.__accelon26.saveOnExit();
      const afterExitAllClosed = await window.__accelon26.openSet();
      // 把「重啟前」的紀錄寫回去，再跑一次啟動恢復
      window.__accelon26.openSetWrite(saved);
      const srcs = window.__accelon26.catalogSources();
      const okRestore = await window.__accelon26.openSetRestore(srcs);
      await sleep(600);
      return {
        names0, activeBefore, afterClose, afterExitAllClosed, okRestore,
        db: st().db, names: st().dbs.map((d) => d.name),
        openSet: await window.__accelon26.openSet(),
      };
    })()
  `);
  ok('關庫不會馬上改紀錄（只有離開 exe 才寫）',
    reboot.afterClose.dbs === 0 && !!reboot.afterClose.openSet,
    `關完 ${reboot.afterClose.dbs} 個、紀錄還在=${!!reboot.afterClose.openSet}`);
  ok('離開時全部關閉 → 紀錄清掉（下次不會亂開）',
    reboot.afterExitAllClosed === null, `離開後紀錄=${JSON.stringify(reboot.afterExitAllClosed)}`);
  ok('啟動恢復：依紀錄把兩個庫都開回來（順序＝dbTabs 由左到右）',
    reboot.okRestore === true && reboot.names.length === 2
    && JSON.stringify(reboot.names) === JSON.stringify(reboot.names0),
    `${JSON.stringify(reboot.names0)} → ${JSON.stringify(reboot.names)}`);
  ok('啟動恢復：回到上次 active 的那一個庫',
    reboot.db === reboot.activeBefore, `active ${reboot.activeBefore} → ${reboot.db}`);
  ok('啟動恢復：恢復後紀錄還在（下次啟動還能再恢復）',
    !!reboot.openSet && (reboot.openSet.dbs ?? []).length === 2, JSON.stringify(reboot.openSet?.dbs));

  // 5) ★ 離開 exe 時存「捲動位置＋選取區」，重新開同一個檔要回到那裡
  //    （上一輪就是這裡漏了：只存了頁碼，沒存 scrollTop 與選取區）
  const roundTrip = await cdp.eval<any>(`
    (async () => {
      ${H}
      // 先回到 A 庫的本文
      const json = window.__accelon26.readStateJson('before-exit');
      await window.__accelon26.readStateApply(json);
      await sleep(800);
      const body = () => document.querySelector('#docText .docBody');
      // 捲到 300、選一段字，然後「離開 exe」
      body().scrollTop = 300;
      await sleep(200);
      const scrollSet = body().scrollTop;
      const sel = selectInDoc(3, 9);
      window.__accelon26.saveOnExit();
      const stored = JSON.parse(localStorage.getItem('accelon26.lastRead.v1') || '{}');
      const rec = Object.values(stored).find((r) => r && r.scrollTop !== undefined) || null;
      // 關掉 A，再從同一個檔重開（openFile 會呼叫 restoreLastRead）
      const ids = [...document.querySelectorAll('#dbTabs .dbChip')].map((c) => Number(c.dataset.id));
      for (const id of ids) window.__accelon26.closeDbById(id);
      await sleep(500);
      await openDb('/a.adb', 'a.adb');
      await sleep(1200);
      const s2 = st();
      return {
        scrollSet, selText: sel?.text ?? '',
        rec: rec && { scrollTop: rec.scrollTop, sel: rec.sel && rec.sel.text, line: rec.line },
        db: s2.db, page: s2.docPage,
        scrollBack: body()?.scrollTop ?? -1,
        selBack: window.getSelection()?.toString() ?? '',
        rows: document.querySelectorAll('#docText .docLine').length,
      };
    })()
  `);
  ok('離開 exe 時把本文的捲動位置存下來（只存一次）',
    roundTrip.scrollSet > 0 && roundTrip.rec && Math.abs((roundTrip.rec.scrollTop ?? -1) - roundTrip.scrollSet) <= 2,
    `捲到 ${roundTrip.scrollSet}、存下 ${roundTrip.rec?.scrollTop}`);
  ok('離開 exe 時把本文的選取區存下來',
    !!roundTrip.rec?.sel && roundTrip.rec.sel === roundTrip.selText && roundTrip.selText.length > 0,
    `選「${roundTrip.selText}」、存下「${roundTrip.rec?.sel}」`);
  ok('重新開同一個檔：回到同一頁', roundTrip.db === st.dbs[0]?.dbname && roundTrip.rows > 0,
    `db=${roundTrip.db}、頁=${roundTrip.page}、${roundTrip.rows} 行`);
  ok('★ 重新開同一個檔：捲動位置回來', Math.abs((roundTrip.scrollBack ?? -1) - (roundTrip.scrollSet ?? -2)) <= 4,
    `離開時 ${roundTrip.scrollSet} → 重開後 ${roundTrip.scrollBack}`);
  ok('★ 重新開同一個檔：選取區回來',
    roundTrip.selBack === roundTrip.selText && roundTrip.selText.length > 0,
    `離開時「${roundTrip.selText}」→ 重開後「${roundTrip.selBack}」`);

  // 4) 設置頁的 UI 真的接上了（進階 → 閱讀狀態：名稱＋兩顆按鈕＋隱藏的檔案輸入）
  const ui = await cdp.eval<any>(`
    (async () => {
      ${H}
      window.__accelon26.openSettings();
      await sleep(250);
      document.querySelector('#setTabs .setTab[data-setpane="advanced"]').click();
      await sleep(250);
      const name = document.querySelector('#readStateName');
      const ex = document.querySelector('#readStateExport');
      const im = document.querySelector('#readStateImport');
      const file = document.querySelector('#readStateFile');
      const pane = document.querySelector('.setPane[data-setpane="advanced"]');
      name.value = '編輯前';
      ex.click();
      await sleep(700);
      return {
        hasName: !!name, hasExport: !!ex, hasImport: !!im, hasFile: !!file,
        paneVisible: !!pane && !pane.hidden,
        status: document.querySelector('#readStateStatus')?.textContent ?? '',
      };
    })()
  `);
  ok('設置頁：進階 →「閱讀狀態」有名稱輸入框與兩顆按鈕',
    ui.hasName && ui.hasExport && ui.hasImport && ui.hasFile && ui.paneVisible,
    `name=${ui.hasName} export=${ui.hasExport} import=${ui.hasImport} file=${ui.hasFile} pane=${ui.paneVisible}`);
  ok('設置頁：按「匯出閱讀狀態」會回報檔名與內容數量',
    /已匯出/.test(ui.status) && /\.json/.test(ui.status) && /本文分頁/.test(ui.status), ui.status);

  if (cdp.logs.length) console.error(cdp.logs.slice(-8).join('\n'));
} finally {
  proc.kill();
  server.stop(true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
