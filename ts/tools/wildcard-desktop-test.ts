/**
 * 萬用字元掃描的**桌面版實測**（作者指定的驗收案例：taisho 打 `？象`，最多的是「白象」）。
 *
 *   bun run tools/wildcard-desktop-test.ts [--exe D:\accelon3\accelon26.exe] [--db taisho.adb] [--pattern ？象]
 *
 * 為什麼要跑真 exe：taisho.adb 331 MB，瀏覽器版要先把整個檔讀進記憶體；桌面版是 mmap，
 * 而且 posting 與 bzip2 解壓都走 Go，才是使用者真正的體驗。順便量一次掃描時間。
 *
 * 用獨立的 state／WebView2 目錄（ACCELON26_STATE_DIR／ACCELON26_WEBVIEW_DIR），
 * 不會動到使用者真正的資料。
 */
import { resolve } from 'node:path';
import { existsSync, rmSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const ROOT = resolve(import.meta.dir, '../..');
const EXE = resolve(opt('exe', resolve(ROOT, 'accelon3', 'accelon26.exe')));
const CWD = resolve(opt('cwd', resolve(ROOT, 'accelon3')));
// 預設用小型庫（taisho 開檔本身就要幾十秒；要掃 taisho 請用 tools/wildcard-scan-cli.ts）
const DB = opt('db', 'jingang-group.adb');
const PATTERN = opt('pattern', '？象');
const EXPECT_TOP = opt('expect-top', '');
const PORT = Number(opt('port', '9345'));
const STATE_DIR = resolve(ROOT, 'build/tmp-wild-desktop');

if (!existsSync(EXE)) { console.error('missing ' + EXE); process.exit(2); }

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + name + (detail ? '  ' + detail : '')); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
};

function guiEnv(): Record<string, string> {
  return {
    ...process.env,
    ACCELON26_DEBUG_PORT: String(PORT),
    ACCELON26_STATE_DIR: STATE_DIR,
    ACCELON26_WEBVIEW_DIR: resolve(STATE_DIR, 'webview-' + PORT),
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

const proc = { exitCode: null as number | null, kill: () => undefined as void };

try {
  rmSync(STATE_DIR, { recursive: true, force: true });
  await waitPortFree(PORT);
  const child = Bun.spawn([EXE, '-debug-port', String(PORT)], {
    cwd: CWD, env: guiEnv(), stdout: 'pipe', stderr: 'pipe',
  });
  proc.kill = () => { try { child.kill(); } catch { /* gone */ } };

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
  if (!wsurl) throw new Error('no devtools endpoint');

  const sock = new WebSocket(wsurl);
  await new Promise<void>((res, rej) => { sock.onopen = () => res(); sock.onerror = () => rej(new Error('ws')); });
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  let id = 0, session = '';
  const send = (method: string, params: any = {}, withSession = true): Promise<any> => new Promise((res, rej) => {
    const myId = ++id;
    const payload: any = { id: myId, method, params };
    if (withSession && session) payload.sessionId = session;
    pending.set(myId, { resolve: res, reject: rej });
    sock.send(JSON.stringify(payload));
    setTimeout(() => { if (pending.delete(myId)) rej(new Error('timeout ' + method)); }, 600000);
  });
  sock.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data));
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id)!; pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
    else if (m.method === 'Target.attachedToTarget') session = m.params.sessionId;
  };
  const targets = await send('Target.getTargets', {}, false);
  const page = (targets.targetInfos as any[]).find((t) => t.type === 'page');
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

  // 開目標庫（host 的 AdbSource，mmap）
  const opened = await evalIn<any>(`
    (async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const srcs = window.__accelon26.catalogSources();
      const want = ${JSON.stringify(DB)};
      const src = srcs.find((s) => (s.name || '').toLowerCase() === want.replace(/\\.adb$/i, '').toLowerCase())
        || srcs.find((s) => (s.path || '').toLowerCase().endsWith(want.toLowerCase()))
        || srcs.find((s) => /大正/.test(s.name || ''));
      if (!src) return { error: 'not found', names: srcs.map((s) => s.name).slice(0, 20) };
      const t0 = performance.now();
      await window.__accelon26.openFile(src);
      for (let i = 0; i < 600; i++) {
        const p = window.__accelon26.state().treePhases ?? {};
        if (p.instances !== undefined || p.skipped !== undefined) break;
        await sleep(150);
      }
      await sleep(600);
      return { db: window.__accelon26.state().db, name: src.name, openMs: Math.round(performance.now() - t0) };
    })()
  `);
  ok('開得起 ' + DB + '（桌面版 mmap）', !!opened?.db, JSON.stringify(opened));

  // 單庫萬用掃描
  const scan = await evalIn<any>(`
    (async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const st = () => window.__accelon26.searchAllState();
      document.getElementById('searchAllBtn').click();
      await sleep(300);
      document.querySelector('#allSearchMode button[data-mode="single"]').click();
      await sleep(150);
      document.getElementById('allSearchQuery').value = ${JSON.stringify(PATTERN)};
      const t0 = performance.now();
      document.getElementById('allSearchGo').click();
      const samples = [];
      for (let i = 0; i < 3000; i++) {
        await sleep(120);
        const s = st();
        if (s.wild && samples.length < 6 && s.wild.phase === 'scanning') samples.push({ ...s.wild });
        if (!s.busy && s.wild && (s.wild.phase === 'done' || s.wild.phase === 'aborted')) break;
      }
      const s = st();
      const chips = [...document.querySelectorAll('#allSearchForms .allSearchForm')].slice(0, 8).map((b) => ({
        text: b.querySelector('b')?.textContent ?? '',
        count: Number((b.querySelector('span')?.textContent ?? '0').replace(/[^0-9]/g, '')),
      }));
      return {
        wild: s.wild, chips, samples,
        msg: document.getElementById('allSearchMsg')?.textContent ?? '',
        prog: document.getElementById('allSearchProgText')?.textContent ?? '',
        ms: Math.round(performance.now() - t0),
      };
    })()
  `);
  ok('掃完了（不是中斷）', scan.wild?.phase === 'done', JSON.stringify(scan.wild));
  ok('有找到東西', (scan.wild?.hits ?? 0) > 0 && (scan.wild?.forms ?? 0) > 0, scan.msg);
  ok('進度有回報（已掃／剩餘）', (scan.samples ?? []).length > 0
    && (scan.samples ?? []).every((x: any) => x.blocksTotal > 0),
    JSON.stringify((scan.samples ?? []).slice(0, 2)));
  ok('結果字串依次數由多到少', (scan.chips ?? []).every((c: any, i: number) => i === 0 || (scan.chips[i - 1].count >= c.count)),
    JSON.stringify(scan.chips));
  ok(EXPECT_TOP ? `★ ${PATTERN} 在 ${DB} 最多的是「${EXPECT_TOP}」` : `${PATTERN} 在 ${DB} 有結果`,
    EXPECT_TOP ? (scan.chips ?? [])[0]?.text === EXPECT_TOP : (scan.chips ?? []).length > 0,
    `前 8：${JSON.stringify(scan.chips)}`);
  ok('掃描時間有記下來', (scan.wild?.ms ?? 0) > 0, `${((scan.wild?.ms ?? 0) / 1000).toFixed(1)} 秒（前端量到 ${(scan.ms / 1000).toFixed(1)} 秒）`);

  // 關視窗（走 Wails 的 WindowClosing，順便確認不會卡住）
  await evalIn(`(async () => {
    const m = await new Function('u', 'return import(u)')('/wails/runtime.js');
    try { await m.Window.Close(); } catch (e) { /* 已經關了 */ }
    return 1;
  })()`).catch(() => undefined);
  for (let i = 0; i < 40 && child.exitCode === null; i++) await Bun.sleep(250);
} finally {
  proc.kill();
  try { Bun.spawnSync({ cmd: ['taskkill', '/IM', 'accelon26.exe', '/F'], stdout: 'ignore', stderr: 'ignore' }); } catch { /* 沒有就算了 */ }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
