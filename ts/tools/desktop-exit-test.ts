/**
 * 桌面版「離開時記住閱讀狀態」的實測（作者 2026-11-01）。
 *
 *   bun run tools/desktop-exit-test.ts [--exe <accelon26.exe>] [--cwd D:\accelon3] [--port 9333]
 *
 * 驗的是**真的 exe、真的 WebView2**（不是瀏覽器模擬）：
 *   1. 開兩個 adb、打開一頁本文、捲到某處、選一段字 → 關掉視窗（Window.Close，
 *      走 Go 的 WindowClosing → ExecJS("__accelon26.saveOnExit()")）
 *   2. 再開一次 exe（同一個 WebView2 資料目錄）→ 兩個庫都回來、active 一樣、
 *      **捲動位置回來、選取區還選著**
 *
 * 用獨立的 state／WebView2 目錄（ACCELON26_STATE_DIR／ACCELON26_WEBVIEW_DIR），
 * 不會動到使用者真正的資料。跑完會把目錄留著（第二次啟動要用同一個）。
 */
import { resolve } from 'node:path';
import { existsSync, rmSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const ROOT = resolve(import.meta.dir, '../..');
const EXE = resolve(opt('exe', resolve(ROOT, 'accelon3', 'accelon26.exe')));
const CWD = resolve(opt('cwd', resolve(ROOT, 'accelon3')));
const PORT = Number(opt('port', '9333'));
const STATE_DIR = resolve(ROOT, 'build/tmp-exit-state');

if (!existsSync(EXE)) { console.error('missing ' + EXE); process.exit(2); }

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + name + (detail ? '  ' + detail : '')); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
};

function guiEnv(port: number): Record<string, string> {
  return {
    ...process.env,
    ACCELON26_DEBUG_PORT: String(port),
    ACCELON26_STATE_DIR: STATE_DIR,
    ACCELON26_WEBVIEW_DIR: resolve(STATE_DIR, 'webview-' + port),
  } as Record<string, string>;
}

async function waitPortFree(port: number, timeoutMs = 20000): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try { await fetch(`http://127.0.0.1:${port}/json/version`); } catch { return; }
    if (Date.now() > until) return;
    await Bun.sleep(300);
  }
}

interface Gui {
  proc: ReturnType<typeof Bun.spawn>;
  evalIn: <T>(expr: string) => Promise<T>;
  close: () => Promise<void>;
}

async function startGui(): Promise<Gui> {
  await waitPortFree(PORT);
  const proc = Bun.spawn([EXE, '-debug-port', String(PORT)], {
    cwd: CWD, env: guiEnv(PORT), stdout: 'pipe', stderr: 'pipe',
  });
  let wsurl = '';
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline && !wsurl) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      const j = await r.json() as { webSocketDebuggerUrl?: string };
      wsurl = j.webSocketDebuggerUrl ?? '';
    } catch { /* not up yet */ }
    if (!wsurl) await Bun.sleep(300);
  }
  if (!wsurl) { try { proc.kill(); } catch { /* gone */ } throw new Error('no WebView2 devtools endpoint on port ' + PORT); }
  let sock!: WebSocket;
  await new Promise<void>((res, rej) => { sock = new WebSocket(wsurl); sock.onopen = () => res(); sock.onerror = () => rej(new Error('ws')); });
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  let id = 0, session = '';
  const send = (method: string, params: any = {}, withSession = true): Promise<any> => new Promise((res, rej) => {
    const myId = ++id;
    const payload: any = { id: myId, method, params };
    if (withSession && session) payload.sessionId = session;
    pending.set(myId, { resolve: res, reject: rej });
    sock.send(JSON.stringify(payload));
    setTimeout(() => { if (pending.delete(myId)) rej(new Error('timeout ' + method)); }, 60000);
  });
  sock.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data));
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id)!; pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
    else if (m.method === 'Target.attachedToTarget') session = m.params.sessionId;
  };
  const targets = await send('Target.getTargets', {}, false);
  const page = (targets.targetInfos as any[]).find((t) => t.type === 'page');
  if (!page) throw new Error('no page target');
  const attached = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true }, false);
  session = attached.sessionId;
  await send('Runtime.enable');
  const evalIn = async <T>(expr: string): Promise<T> => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
    return r.result.value as T;
  };
  for (let i = 0; i < 120; i++) {
    const ready = await evalIn<boolean>('!!(window.__accelon26 && window.__accelon26.state)').catch(() => false);
    if (ready) break;
    await Bun.sleep(300);
  }
  await Bun.sleep(1500);
  const close = async (): Promise<void> => {
    await evalIn(`(async () => {
      const m = await new Function('u', 'return import(u)')('/wails/runtime.js');
      try { await m.Window.Close(); } catch (e) { /* 已經關了 */ }
      return 1;
    })()`).catch(() => undefined);
    for (let i = 0; i < 60 && proc.exitCode === null; i++) await Bun.sleep(250);
    try { proc.kill(); } catch { /* already gone */ }
  };
  return { proc, evalIn, close };
}

/** 頁面裡的公用片段：等樹、開庫、點目錄、捲動＋選字 */
const HELPERS = `
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const st = () => window.__accelon26.state();
  const waitTree = async () => {
    for (let i = 0; i < 400; i++) {
      const p = st().treePhases ?? {};
      if (p.instances !== undefined || p.skipped !== undefined) return true;
      await sleep(150);
    }
    return false;
  };
  const waitDoc = async (n = 0) => {
    for (let i = 0; i < 200; i++) {
      if (document.querySelectorAll('#docText .docLine').length > (n ?? 0)) return true;
      await sleep(150);
    }
    return false;
  };
  const selectRange = (a = 2, b = 8) => {
    for (const line of document.querySelectorAll('#docText .docLine')) {
      const host = line.querySelector('.lineText');
      if (!host) continue;
      const t = document.createTreeWalker(host, NodeFilter.SHOW_TEXT).nextNode();
      if (!t || (t.nodeValue ?? '').length < b + 1) continue;
      const r = document.createRange();
      r.setStart(t, a);
      r.setEnd(t, b);
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(r);
      return { line: Number(line.id.slice(1)), text: r.toString() };
    }
    return null;
  };
`;

try {
  // 乾淨的第一次啟動（＝使用者第一次開這個 exe）
  rmSync(STATE_DIR, { recursive: true, force: true });

  // ---------- 第一次：開兩個庫、看一頁、捲動＋選字，然後關掉視窗 ----------
  const g1 = await startGui();
  const run1 = await g1.evalIn<any>(`
    (async () => {
      ${HELPERS}
      await waitTree();
      const cur = st().db;
      const srcs = window.__accelon26.catalogSources()
        .slice()
        .sort((a, b) => a.size - b.size);
      const other = srcs.find((s) => s.name !== cur && s.size > 0);
      if (other) { await window.__accelon26.openFile(other); await waitTree(); await sleep(600); }
      // 找一個「夠長、捲得動」的節點：前 8 列各點一次，取行數最多的那一列
      const rows = [...document.querySelectorAll('#dirTree .tRow')];
      let best = { n: 0, i: -1 };
      for (let i = 0; i < Math.min(rows.length, 8); i++) {
        (rows[i].querySelector('.tName') ?? rows[i]).click();
        await waitDoc(best.n > 0 ? 0 : 0);
        await sleep(600);
        const n = document.querySelectorAll('#docText .docLine').length;
        if (n > best.n) best = { n, i };
      }
      if (best.i >= 0) {
        (rows[best.i].querySelector('.tName') ?? rows[best.i]).click();
        await waitDoc(0);
        await sleep(700);
      }
      const body = document.querySelector('#docText .docBody');
      body.scrollTop = 600;
      await sleep(250);
      const scroll = body.scrollTop;
      const sel = selectRange(2, 8);
      return {
        dbs: st().dbs.map((d) => d.name),
        db: st().db, dbcname: st().docTabDb, page: st().docPage,
        scroll, selText: sel?.text ?? '', selLine: sel?.line ?? 0,
        rows: document.querySelectorAll('#docText .docLine').length,
        opensetBeforeExit: localStorage.getItem('accelon26.openset.v1'),
      };
    })()
  `);
  ok('第一次啟動：開著兩個 adb、有本文可以捲',
    (run1.dbs ?? []).length === 2 && run1.rows > 0 && run1.scroll > 0,
    `dbs=${JSON.stringify(run1.dbs)}、${run1.rows} 行、捲到 ${run1.scroll}`);
  ok('離開之前還沒寫「開著哪幾個 adb」（平時不寫）',
    run1.opensetBeforeExit === null, `openset=${run1.opensetBeforeExit}`);
  ok('第一次啟動：本文有選取一段字',
    !!run1.selText && run1.selLine > 0, `選「${run1.selText}」（L${run1.selLine}）`);

  await g1.close();     // Window.Close → Go 的 WindowClosing → ExecJS(saveOnExit)

  // ---------- 第二次：同一個 WebView2 目錄，看有沒有回到同一個地方 ----------
  const g2 = await startGui();
  const run2 = await g2.evalIn<any>(`
    (async () => {
      ${HELPERS}
      // 等啟動恢復把兩個庫都開好
      for (let i = 0; i < 400; i++) {
        if (st().dbs.length >= 2) break;
        await sleep(200);
      }
      await waitTree();
      await waitDoc(0);
      await sleep(900);
      const body = document.querySelector('#docText .docBody');
      return {
        dbs: st().dbs.map((d) => d.name),
        db: st().db, docTabDb: st().docTabDb, page: st().docPage,
        scroll: body?.scrollTop ?? -1,
        selText: window.getSelection()?.toString() ?? '',
        rows: document.querySelectorAll('#docText .docLine').length,
        openset: localStorage.getItem('accelon26.openset.v1'),
        lastRead: localStorage.getItem('accelon26.lastRead.v1'),
      };
    })()
  `);
  await g2.close();

  ok('第二次啟動：兩個庫都自動開回來',
    (run2.dbs ?? []).length === 2 && JSON.stringify(run2.dbs) === JSON.stringify(run1.dbs),
    `${JSON.stringify(run1.dbs)} → ${JSON.stringify(run2.dbs)}`);
  ok('第二次啟動：active 還是同一個庫',
    run2.db === run1.db, `${run1.db} → ${run2.db}`);
  ok('第二次啟動：回到同一頁（同一段本文）',
    run2.page === run1.page && run2.rows > 0, `頁 ${run1.page} → ${run2.page}、${run2.rows} 行`);
  ok('★ 第二次啟動：捲動位置回來',
    Math.abs((run2.scroll ?? -1) - (run1.scroll ?? -2)) <= 4,
    `離開時 ${run1.scroll} → 重開後 ${run2.scroll}`);
  ok('★ 第二次啟動：選取區回來',
    !!run1.selText && run2.selText === run1.selText,
    `離開時「${run1.selText}」→ 重開後「${run2.selText}」`);
  ok('離開那一刻寫下了 openset（localStorage）',
    !!run2.openset && /"dbs"/.test(run2.openset), (run2.openset ?? '').slice(0, 120));
  ok('★ openset 裡沒有 adb 路徑（adb 跟著 exe 走，只認名字）',
    !!run2.openset && !/"path"\s*:/.test(run2.openset) && !/(^|["\s(])[A-Za-z]:[\\/]/.test(run2.openset),
    (run2.openset ?? '').slice(0, 160));
  ok('離開那一刻寫下了 lastRead 的 scrollTop／sel',
    !!run2.lastRead && /"scrollTop"/.test(run2.lastRead) && /"sel"/.test(run2.lastRead),
    (run2.lastRead ?? '').slice(0, 160));

  // settings.json **不可以**有 adb 路徑（別人的環境不一樣）：舊版的 `reading` 要被清掉
  const settingsFile = resolve(CWD, 'settings.json');
  const settingsText = existsSync(settingsFile) ? (await Bun.file(settingsFile).text()) : '';
  ok('settings.json 沒有 `reading`、也沒有 adb 路徑',
    !/"reading"\s*:/.test(settingsText) && !/[A-Za-z]:\\\\/.test(settingsText) && !/[A-Za-z]:\\/.test(settingsText),
    settingsFile + '：' + JSON.stringify(settingsText.slice(0, 160)));
} finally {
  // 保險：把可能還留著的行程收掉
  try { Bun.spawnSync({ cmd: ['taskkill', '/IM', 'accelon26.exe', '/F'], stdout: 'ignore', stderr: 'ignore' }); } catch { /* 沒有就算了 */ }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
