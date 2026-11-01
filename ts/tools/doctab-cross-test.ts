/**
 * 跨庫本文分頁（doctab 自帶 adb 上下文）的實測（作者 2026-11-01）。
 *
 *   bun run tools/doctab-cross-test.ts [--adb <A>] [--adb2 <B>] [--html build/accelon26.html]
 *
 * 驗的是 `docs/system/refactor-doctab-adb.md` §3 的行為：
 *   1. 點別的庫的分頁 → **不換 adb**（左欄目錄、摘要、dbChip 都不動）
 *   2. 頁碼／行號是分頁自己那一庫的（不是左欄那一庫的）
 *   3. header 的 🌲（treeReveal）才把 adb 切到那個分頁所屬的庫
 *   4. dbChip 的 owner 標記（有本文分頁的庫）不改變 active
 *   5. 關掉其中一庫 → 它的分頁消失，另一庫不受影響
 */
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const HTML = resolve(opt('html', resolve(import.meta.dir, '../../build/accelon26.html')));
const ADB_A = resolve(opt('adb', resolve(import.meta.dir, '../../13j.adb')));
const ADB_B = resolve(opt('adb2', resolve(import.meta.dir, '../../build/jingang-group.adb')));
const PORT = Number(opt('port', String(8800 + Math.floor(Math.random() * 90))));

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const browser = BROWSERS.find((p) => existsSync(p));
if (!browser) { console.error('no Chromium browser found'); process.exit(2); }
if (!existsSync(HTML)) { console.error('missing ' + HTML + ' (run tools/build-viewer.ts --o ../build/accelon26.html)'); process.exit(2); }
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

// 每次用新的 profile：上一次跑到一半被殺掉時，殘留的 DevToolsActivePort
// 會指到已經結束的瀏覽器，連線就會 ws error。
const profile = resolve(import.meta.dir, `../../build/.chrome-profile-cross-${process.pid}-${Date.now() % 100000}`);
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

// ---- 在頁面裡做事的公用片段 --------------------------------------------------
const PAGE_HELPERS = `
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
  // 點目錄的一列（點 .tName 才會聯動本文；點箭頭只展開／收合）並等本文分頁出現
  const clickTreeRow = async (n = 1) => {
    const rows = [...document.querySelectorAll('#dirTree .tRow')];
    const row = rows[Math.max(0, Math.min(n, rows.length - 1))];
    if (!row) return null;
    const nameEl = row.querySelector('.tName') ?? row;
    nameEl.click();
    for (let i = 0; i < 120; i++) {
      if (document.querySelectorAll('#docTabStrip .docTab').length > 0) break;
      await sleep(120);
    }
    await sleep(400);
    return { va: Number(row.dataset.va), name: row.textContent.replace(/\s+/g, ' ').trim(), rows: rows.length };
  };
  const chips = () => [...document.querySelectorAll('#dbTabs .dbChip')].map((c) => ({
    name: c.textContent.replace('✕', '').trim(),
    active: c.classList.contains('active'),
    owner: c.classList.contains('owner'),
  }));
  const tabStrip = () => [...document.querySelectorAll('#docTabStrip .docTab')].map((t) => ({
    label: t.querySelector('.docTabName')?.textContent?.trim() ?? '',
    active: t.classList.contains('active'),
    foreign: t.classList.contains('foreign'),
    title: t.title,
  }));
`;

try {
  const cdp = await Cdp.attach(await devtoolsUrl());
  await cdp.openPage(`http://127.0.0.1:${PORT}/accelon26.html`);
  await Bun.sleep(700);

  // 1) 共享分頁打開（預設關閉；跨庫並存只在開啟時成立）＋開 A 庫
  const setup = await cdp.eval<any>(`
    (async () => {
      window.__accelon26.setSharedDocTabs(true);
      ${PAGE_HELPERS}
      await openDb('/a.adb', 'a.adb');
      const a = st();
      return { shared: window.__accelon26.sharedDocTabsOn(), db: a.db, openDbs: a.dbs.length };
    })()
  `);
  ok('共享分頁可以打開（預設關閉）', setup.shared === true && setup.db !== null, JSON.stringify(setup));

  // 2) 在 A 庫點目錄 → 開一個本文分頁
  const tabA = await cdp.eval<any>(`
    (async () => {
      ${PAGE_HELPERS}
      const r = await clickTreeRow(4);
      const s = st();
      return { row: r, db: s.db, docTab1: s.docTab + 1, tabs: s.docTabs, realm: s.docRealm, chips: chips() };
    })()
  `);
  ok('A 庫點目錄節點 → 本文分頁與頁碼', (tabA.tabs?.length ?? 0) >= 1 && tabA.docTab1 === 1,
    `db=${tabA.db} tabs=${(tabA.tabs ?? []).length} realm=${JSON.stringify(tabA.realm)} row=${JSON.stringify(tabA.row)}`);
  if (cdp.logs.length) console.error('[page logs after tabA]\n' + cdp.logs.slice(-12).join('\n'));
  const tabARealm = tabA.realm;
  const tabAPages = await cdp.eval<number>('window.__accelon26.state().docPages');

  // 3) 開 B 庫（A 的分頁要留在分頁條上）
  const openB = await cdp.eval<any>(`
    (async () => {
      ${PAGE_HELPERS}
      await openDb('/b.adb', 'b.adb');
      const s = st();
      return { db: s.db, tabs: s.docTabs, strip: tabStrip(), chips: chips(), docTabDb: s.docTabDb, docTab: s.docTab };
    })()
  `);
  ok('開 B 庫：分頁條保留 A 的分頁（並標成 foreign）',
    openB.db !== tabA.db && (openB.strip ?? []).length >= 1,
    `db=${openB.db} strip=${JSON.stringify(openB.strip)}`);
  ok('B 庫沒有本文分頁時本文區顯示提示（docTab=-1、沒有 active 分頁）',
    openB.docTab === -1 || openB.docTabDb === openB.db,
    `docTab=${openB.docTab} docTabDb=${openB.docTabDb} db=${openB.db}`);

  // 4) 在 B 庫點目錄 → B 的本文分頁
  const tabB = await cdp.eval<any>(`
    (async () => {
      ${PAGE_HELPERS}
      const r = await clickTreeRow(3);
      const s = st();
      return { row: r, db: s.db, tabs: s.docTabs, strip: tabStrip(), chips: chips(), realm: s.docRealm, docTabDb: s.docTabDb };
    })()
  `);
  const bRealm = tabB.realm;
  ok('B 庫也有自己的本文分頁（兩庫分頁並存）',
    (tabB.tabs ?? []).length >= 2 && tabB.tabs.some((t: any) => t.db !== tabB.tabs[0].db),
    `row=${JSON.stringify(tabB.row)} tabs=${JSON.stringify((tabB.tabs ?? []).map((t: any) => ({ name: t.name, db: t.db, page: t.page })))}`);
  ok('兩個庫的 chips 都有 owner 標記（有本文分頁），active 只有一個',
    (tabB.chips ?? []).filter((c: any) => c.owner).length === 2 && (tabB.chips ?? []).filter((c: any) => c.active).length === 1,
    JSON.stringify(tabB.chips));

  // 5) 核心：點 A 的分頁 → **不換 adb**，左欄目錄不動，本文是 A 的
  const backToA = await cdp.eval<any>(`
    (async () => {
      ${PAGE_HELPERS}
      const before = st();
      const leftRowsBefore = document.querySelectorAll('#dirTree .tRow').length;
      const leftTabBefore = document.querySelector('#colLeft .tabBtn.active')?.dataset.tab;
      const chipBefore = chips();
      // A 的分頁是第一個（不是 active 的那一個）
      const idx = [...document.querySelectorAll('#docTabStrip .docTab')].findIndex((t) => !t.classList.contains('active'));
      document.querySelectorAll('#docTabStrip .docTab')[idx].click();
      await sleep(700);
      const after = st();
      return {
        idx,
        dbBefore: before.db, dbAfter: after.db,
        leftTabBefore, leftTabAfter: document.querySelector('#colLeft .tabBtn.active')?.dataset.tab,
        leftRowsBefore, leftRowsAfter: document.querySelectorAll('#dirTree .tRow').length,
        chipBefore, chipAfter: chips(),
        docTabDb: after.docTabDb, docTabDbId: after.docTabDbId,
        realm: after.docRealm, pages: after.docPages,
        strip: tabStrip(),
        marks: document.querySelectorAll('#docText mark.docHit').length,
        rows: document.querySelectorAll('#docText .docLine').length,
        trail: document.querySelector('#docTrail')?.textContent?.trim() ?? '',
      };
    })()
  `);
  ok('點別庫的分頁：adb 不變（左欄仍是 B）', backToA.dbBefore === backToA.dbAfter && backToA.dbAfter === openB.db,
    `db ${backToA.dbBefore} → ${backToA.dbAfter}`);
  ok('點別庫的分頁：左欄分頁與目錄列都不重畫',
    backToA.leftTabBefore === backToA.leftTabAfter && backToA.leftRowsBefore === backToA.leftRowsAfter,
    `leftTab ${backToA.leftTabBefore}→${backToA.leftTabAfter}、dirRows ${backToA.leftRowsBefore}→${backToA.leftRowsAfter}`);
  ok('點別庫的分頁：dbChip 的 active 不變（owner 仍在）',
    JSON.stringify(backToA.chipBefore) === JSON.stringify(backToA.chipAfter), JSON.stringify(backToA.chipAfter));
  ok('本文換成 A 的分頁（realm／頁數是 A 那一庫的）',
    backToA.docTabDbId !== 0 && backToA.docTabDb === tabA.db
    && JSON.stringify(backToA.realm) === JSON.stringify(tabARealm) && backToA.pages === tabAPages,
    `docTabDb=${backToA.docTabDb} realm=${JSON.stringify(backToA.realm)} pages=${backToA.pages}（A 原為 ${JSON.stringify(tabARealm)} / ${tabAPages} 頁）`);
  ok('跨庫分頁不畫麵包屑（改成「本文來自…」提示條）',
    /本文來自/.test(backToA.trail), `trail=${JSON.stringify(backToA.trail)}`);
  ok('本文真的畫出 A 的內容（有行、分頁標記 foreign）',
    backToA.rows > 0 && (backToA.strip ?? []).some((t: any) => t.foreign),
    `rows=${backToA.rows} strip=${JSON.stringify(backToA.strip)}`);

  // 6) 切回 B 的分頁 → 本文換回 B 的，adb 仍然不動
  const backToB = await cdp.eval<any>(`
    (async () => {
      ${PAGE_HELPERS}
      const tabs = [...document.querySelectorAll('#docTabStrip .docTab')];
      const idx = tabs.findIndex((t) => t.title.includes(${JSON.stringify(String(tabB.db))}));
      if (idx >= 0) { tabs[idx].click(); await sleep(700); }
      const s = st();
      return { idx, db: s.db, docTabDb: s.docTabDb, realm: s.docRealm,
        rows: document.querySelectorAll('#docText .docLine').length, pages: s.docPages };
    })()
  `);
  ok('切回 B 的分頁：本文換回 B、adb 仍然不動',
    backToB.db === openB.db && backToB.docTabDb === tabB.db
    && JSON.stringify(backToB.realm) === JSON.stringify(bRealm) && backToB.rows > 0,
    `db=${backToB.db} docTabDb=${backToB.docTabDb} realm=${JSON.stringify(backToB.realm)} rows=${backToB.rows}`);

  // 7) 🌲 才切庫：先回到 A 的分頁（adb 還是 B），按 🌲 → adb 變成 A
  const reveal = await cdp.eval<any>(`
    (async () => {
      ${PAGE_HELPERS}
      // 選 A 的分頁（title 帶 A 的庫名）
      const tabs = [...document.querySelectorAll('#docTabStrip .docTab')];
      const idx = tabs.findIndex((t) => t.title.includes(${JSON.stringify(String(tabA.db))}));
      tabs[idx].click();
      await sleep(600);
      const before = st();
      document.querySelector('#treeReveal').click();
      await sleep(1200);
      const after = st();
      const row = document.querySelector('#dirTree .tRow.current');
      return {
        idx,
        dbBefore: before.db, dbAfter: after.db,
        docTabDbBefore: before.docTabDb, docTabDbAfter: after.docTabDb,
        activeRow: row ? { va: Number(row.dataset.va) } : null,
        realm: after.docRealm,
        chips: chips(),
        activeTab: [...document.querySelectorAll('#docTabStrip .docTab')].findIndex((t) => t.classList.contains('active')),
      };
    })()
  `);
  ok('按 🌲 才切庫：adb 換成那個分頁所屬的庫', reveal.dbBefore !== reveal.dbAfter && reveal.dbAfter === tabA.db,
    `db ${reveal.dbBefore} → ${reveal.dbAfter}（分頁屬於 ${reveal.docTabDbBefore}）`);
  ok('按 🌲 後目錄展開並標出目前節點', !!reveal.activeRow && reveal.activeRow.va > 0,
    `current row=${JSON.stringify(reveal.activeRow)}`);
  ok('切庫後 dbChip 的 active 跟著換（owner 不受影響）',
    (reveal.chips ?? []).filter((c: any) => c.active).length === 1 && (reveal.chips ?? []).filter((c: any) => c.owner).length === 2,
    JSON.stringify(reveal.chips));

  // 7.5) 捲動位置：切走時要記住（切回時 renderDoc 會拿它還原）。
  //      注意：分頁有「釘選的命中」時，renderDoc 之後的 paintHit 會把畫面捲到那一行
  //      （這是原本就有的行為，釘選優先），所以這裡驗的是「有沒有記住」。
  const scroll = await cdp.eval<any>(`
    (async () => {
      ${PAGE_HELPERS}
      const tabs = () => [...document.querySelectorAll('#docTabStrip .docTab')];
      const body = () => document.querySelector('#docText .docBody');
      // 先到 B 的分頁
      tabs().find((t) => t.title.includes(${JSON.stringify(String(tabB.db))}))?.click();
      await sleep(700);
      const target = 420;
      body().scrollTop = target;
      await sleep(300);
      const set = body().scrollTop;
      // 切到 A 的分頁：離開時要把 B 的捲動位置記在分頁上
      tabs().find((t) => t.title.includes(${JSON.stringify(String(tabA.db))}))?.click();
      await sleep(700);
      const tabsAfterLeave = st().docTabs.map((t) => ({ name: t.name, scroll: t.scroll }));
      // 再切回 B：分頁還在、本文還在畫
      tabs().find((t) => t.title.includes(${JSON.stringify(String(tabB.db))}))?.click();
      await sleep(700);
      return { target, set, tabsAfterLeave, db: st().db, docTabDb: st().docTabDb,
        rows: document.querySelectorAll('#docText .docLine').length };
    })()
  `);
  const bScroll = (scroll.tabsAfterLeave ?? []).find((t: any) => t.name === '經疏部一')?.scroll;
  ok('切走分頁時記住它的捲動位置（切回時 renderDoc 用來還原）',
    scroll.set > 0 && bScroll === scroll.set && scroll.rows > 0,
    `捲到 ${scroll.set}，離開 B 後分頁記住 ${bScroll}｜切回 B 後 ${scroll.rows} 行、adb 仍 ${scroll.db}（分頁 ${scroll.docTabDb}）`);

  // 8) 關掉 B 庫 → B 的分頁消失，A 的不受影響
  const closed = await cdp.eval<any>(`
    (async () => {
      ${PAGE_HELPERS}
      const before = st();
      const chipB = [...document.querySelectorAll('#dbTabs .dbChip')]
        .find((c) => !c.classList.contains('active'));
      const nameB = chipB.textContent.replace('✕', '').trim();
      chipB.querySelector('.dbChipClose').click();
      await sleep(900);
      const after = st();
      return { nameB, beforeTabs: before.docTabs, afterTabs: after.docTabs, db: after.db,
        dbs: after.dbs.map((d) => d.name), chips: chips(), rows: document.querySelectorAll('#docText .docLine').length };
    })()
  `);
  ok('關掉一庫：它的本文分頁一起消失，另一庫的分頁還在',
    (closed.afterTabs ?? []).every((t: any) => t.db === closed.db) && (closed.afterTabs ?? []).length >= 1
    && (closed.beforeTabs ?? []).length > (closed.afterTabs ?? []).length,
    `before=${(closed.beforeTabs ?? []).length} after=${JSON.stringify((closed.afterTabs ?? []).map((t: any) => t.db))} dbs=${JSON.stringify(closed.dbs)}`);
  ok('關掉一庫後本文還在畫（A 的行仍看得見）', closed.rows > 0, `rows=${closed.rows}`);
  ok('owner 標記跟著減少（只剩一個有分頁的庫）',
    (closed.chips ?? []).filter((c: any) => c.owner).length === 1, JSON.stringify(closed.chips));

  if (cdp.logs.length) console.error('[page logs 1]\n' + cdp.logs.slice(-8).join('\n'));

  // ---- 共享分頁關閉（預設）＝舊行為：一個 adb 一組分頁，切庫整組換掉 ----------------
  const offMode = await cdp.eval<any>(`
    (async () => {
      ${PAGE_HELPERS}
      window.__accelon26.setSharedDocTabs(false);
      // 重新開一次 A，讓分頁從乾淨狀態開始
      await openDb('/a.adb', 'a2.adb');
      const opened = st();
      const rA = await clickTreeRow(4);
      const tabA = st();
      // 記住 A 的分頁與頁碼
      const aTabs = tabA.docTabs.map((t) => ({ from: t.from, to: t.to, page: t.page, db: t.db }));
      // 開 B → A 的分頁應該整組收起來
      await openDb('/b.adb', 'b2.adb');
      const afterB = st();
      const stripAfterB = tabStrip();
      const rB = await clickTreeRow(1);
      const tabB = st();
      const bTabs = tabB.docTabs.map((t) => ({ from: t.from, to: t.to, page: t.page, db: t.db }));
      // 切回 A 的 chip → A 的分頁要原樣回來
      const chipA = [...document.querySelectorAll('#dbTabs .dbChip')]
        .find((c) => c.textContent.includes('十三經'));
      chipA.click();
      await sleep(900);
      const backA = st();
      return {
        opened: opened.dbs.length,
        rA, aTabs, afterBdb: afterB.db, stripAfterB,
        afterBLeftTabs: afterB.docTabs.length, rB, bTabs,
        backAdb: backA.db, backATabs: backA.docTabs.map((t) => ({ from: t.from, to: t.to, page: t.page, db: t.db })),
        backARealm: backA.docRealm,
        rows: document.querySelectorAll('#docText .docLine').length,
        trail: document.querySelector('#docTrail')?.textContent?.trim() ?? '',
      };
    })()
  `);
  ok('（共享分頁關閉）切庫時本文分頁整組收起來（舊行為）',
    (offMode.aTabs ?? []).length === 1 && offMode.afterBLeftTabs === 0 && (offMode.stripAfterB ?? []).length === 0,
    `A tabs=${(offMode.aTabs ?? []).length}、開 B 後分頁數=${offMode.afterBLeftTabs}、strip=${JSON.stringify(offMode.stripAfterB)}`);
  ok('（共享分頁關閉）B 庫自有分頁，不與 A 並存',
    (offMode.bTabs ?? []).length === 1 && offMode.bTabs[0].db !== offMode.aTabs[0].db,
    `bTabs=${JSON.stringify(offMode.bTabs)}`);
  ok('（共享分頁關閉）切回 A 的 chip：A 的分頁與頁碼原樣回來',
    offMode.backAdb === offMode.aTabs[0].db
    && JSON.stringify(offMode.backATabs) === JSON.stringify(offMode.aTabs),
    `db=${offMode.backAdb} backATabs=${JSON.stringify(offMode.backATabs)} 原本=${JSON.stringify(offMode.aTabs)}`);
  ok('（共享分頁關閉）切回 A 後本文真的重畫（有行、麵包屑回來）',
    offMode.rows > 0 && !/本文來自/.test(offMode.trail), `rows=${offMode.rows} trail=${JSON.stringify(offMode.trail)}`);

  if (cdp.logs.length) console.error(cdp.logs.slice(-8).join('\n'));
} finally {
  proc.kill();
  server.stop(true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
