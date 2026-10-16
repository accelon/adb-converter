/**
 * Desktop (Wails3) smoke test — the exe must list every `.adb` in its WORKING DIRECTORY
 * and read them through the host's mmap (no Blob.slice, no socket, no events).
 *
 *   bun run tools/desktop-test.ts [--exe ../build/desktop/accelon26.exe] [--gui] [--cwd ..]
 *
 * Default (headless): run the exe with `-selftest` in `--cwd` (the repository root, where
 * 13j.adb and fgdict.adb live) and check the listing + the read timing it prints.
 * --gui: also start the real window with WebView2's remote debugger and drive the SAME
 * page the browser suite drives — the dropdown must already contain the working
 * directory's databases before anything is clicked, and Go's compress/bzip2 must agree
 * with the TypeScript vendor bzip2 on real source blocks.
 */
import { resolve } from 'node:path';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { AdbReader, SyncIO, blockRange } from '../src/adbview/adb';
import { SearchSession, queryTokens } from '../src/adbview/search';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const ROOT = resolve(import.meta.dir, '../..');
const EXE = resolve(opt('exe', resolve(ROOT, 'build/desktop/accelon26.exe')));
const CWD = resolve(opt('cwd', ROOT));
const GUI = args.includes('--gui');
const PORT = Number(opt('port', '9222'));

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + name + (detail ? '  ' + detail : '')); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
};
if (!existsSync(EXE)) {
  console.error('missing ' + EXE + ' — build it first:  cd wails; go build -o ../build/desktop/accelon26.exe .');
  process.exit(2);
}

// ---------------------------------------------------------------- headless selftest
const t0 = performance.now();
const run = Bun.spawnSync({ cmd: [EXE, '-selftest'], cwd: CWD, stdout: 'pipe', stderr: 'pipe' });
const out = new TextDecoder().decode(run.stdout) + new TextDecoder().decode(run.stderr);
const ms = Math.round(performance.now() - t0);
console.log('--- ' + EXE + ' -selftest  (cwd ' + CWD + ', ' + ms + ' ms) ---');
console.log(out.trimEnd());
console.log('---');
ok('-selftest exits 0', run.exitCode === 0, 'exit ' + run.exitCode);
// 13j.adb and fgdict.adb live in the repository root; the names come from the adb header
ok('列出工作目錄裡的 13j.adb（檔頭 dbcname 十三經）', /13j\.adb/.test(out) && /十三經/.test(out));
ok('列出工作目錄裡的 fgdict.adb（檔頭 dbcname 佛光大辭典）', /fgdict\.adb/.test(out) && /佛光大辭典/.test(out));
ok('只讀檔頭就能命名（沒有載入整個檔案）', !/read the whole|full file/i.test(out));
ok('印出 mmap 讀取計時', /(ns\/op|ms|µs|us)/.test(out));

if (!GUI) {
  console.log('\n' + pass + ' passed, ' + fail + ' failed' + (GUI ? '' : '（--gui 可再驗證視窗版的清單）'));
  process.exit(fail ? 1 : 0);
}


// ---------------------------------------------------------------- 啟動視窗的共用工具
// 測試一律把狀態檔放到 build/tmp-state-test（ACCELON26_STATE_DIR），不碰使用者真正的 %AppData%。
const STATE_DIR = resolve(ROOT, 'build/tmp-state-test');
const STATE_FILE = resolve(STATE_DIR, 'window.json');
const norm = (p: string) => p.toLowerCase().replaceAll(String.fromCharCode(92), '/');

/** 每一個行程的環境：自己的 WebView2 資料目錄與狀態目錄（同一個 WebView2 環境只有第一個
 *  行程拿得到 DevTools 埠，所以測試一定要一個行程一個目錄）。 */
function guiEnv(stateDir: string, port: number, extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...process.env,
    ACCELON26_DEBUG_PORT: String(port),
    ACCELON26_STATE_DIR: stateDir,
    ACCELON26_WEBVIEW_DIR: resolve(stateDir, 'webview-' + port),
    ...extra,
  } as Record<string, string>;
}

/** 等某個 DevTools 埠沒人回應（前一個行程的 WebView2 有時還留著）。 */
async function waitPortFree(port: number, timeoutMs = 20000): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      await fetch(`http://127.0.0.1:${port}/json/version`);
    } catch {
      return; // 沒人回應 → 可以用了
    }
    if (Date.now() > until) return;
    await Bun.sleep(300);
  }
}

interface Gui {
  proc: ReturnType<typeof Bun.spawn>;
  evalIn: <T>(expr: string) => Promise<T>;
  call: <T = any>(method: string, ...args: unknown[]) => Promise<T>;
  windowInfo: () => Promise<any>;
  close: () => Promise<void>;
}

async function startGui(stateDir: string, opts: { spawn?: boolean; env?: Record<string, string>; port?: number; exe?: string } = {}): Promise<Gui> {
  const spawn = opts.spawn !== false;
  const port = opts.port ?? PORT;
  const exe = opts.exe ?? EXE;
  if (spawn) await waitPortFree(port);
  const proc = spawn ? Bun.spawn([exe], {
    cwd: CWD,
    // ACCELON26_DEBUG_PORT: the host reads this itself (Wails overwrites WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS)
    // ACCELON26_STATE_DIR: where it remembers the window geometry
    env: guiEnv(stateDir, port, opts.env ?? {}),
    stdout: 'pipe', stderr: 'pipe',
  }) : ({ exitCode: null, kill: () => undefined } as any); // spawn:false → 接上「更新程式啟動的那個行程」
  let wsurl = '';
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && !wsurl) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      const j = await r.json() as { webSocketDebuggerUrl?: string };
      wsurl = j.webSocketDebuggerUrl ?? '';
    } catch { /* not up yet */ }
    if (!wsurl) await Bun.sleep(300);
  }
  if (!wsurl) {
    if (spawn) proc.kill();
    throw new Error('no WebView2 devtools endpoint on port ' + port);
  }
  let sock: WebSocket;
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
  const attached = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true }, false);
  session = attached.sessionId;
  await send('Runtime.enable');
  const evalIn = async <T>(expr: string): Promise<T> => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
    return r.result.value as T;
  };
  for (let i = 0; i < 100; i++) {
    const ready = await evalIn<boolean>('!!(window.__adbview && window.__adbview.state)').catch(() => false);
    if (ready) break;
    await Bun.sleep(300);
  }
  await Bun.sleep(2000);
  /** 直接呼叫服務方法（例如 main.AdbHost.AppInfo）。 */
  const call = async <T = any>(method: string, ...args: unknown[]): Promise<T> => {
    const raw = await evalIn<string>(`(async () => {
      const m = await new Function('u', 'return import(u)')('/wails/runtime.js');
      return JSON.stringify(await m.Call.ByName(${JSON.stringify(method)}, ...${JSON.stringify(args)}) ?? null);
    })()`);
    return JSON.parse(raw) as T;
  };
  const windowInfo = async (): Promise<any> => {
    const raw = await evalIn<string>(`(async () => {
      const m = await new Function('u', 'return import(u)')('/wails/runtime.js');
      return JSON.stringify(await m.Call.ByName('main.AdbHost.WindowInfo') ?? {});
    })()`);
    return JSON.parse(raw);
  };
  // 關視窗（不是硬殺）：Go 端的 WindowClosing / OnShutdown 才會把設定寫下來
  const close = async (): Promise<void> => {
    await evalIn(`(async () => {
      const m = await new Function('u', 'return import(u)')('/wails/runtime.js');
      try { await m.Window.Close(); } catch (e) { /* 已經關了 */ }
      return 1;
    })()`).catch(() => undefined);
    for (let i = 0; i < 40 && proc.exitCode === null; i++) await Bun.sleep(250);
    try { proc.kill(); } catch { /* already gone */ }
  };
  return { proc, evalIn, call, windowInfo, close };
}

// ---------------------------------------------------------------- 視窗啟動與基本斷言
// 先清掉狀態檔：這樣這一次啟動一定是「第一次啟動」＝全螢幕（也正是要驗的行為）。
rmSync(STATE_DIR, { recursive: true, force: true });
const gui = await startGui(STATE_DIR);
const evalIn = gui.evalIn;
const st = await evalIn<string>(`JSON.stringify({
  href: location.href.slice(0, 30),
  catalog: window.__adbview.state().catalog,
  options: [...document.getElementById('dbPick').options].map((o) => o.textContent),
  db: window.__adbview.state().db,
  open: window.__adbview.openBreakdown(),
})`);
console.log('--- window state ---');
console.log(st);
const parsed = JSON.parse(st) as { catalog: { name: string; open: boolean }[]; options: string[]; db: string; open: any };
ok('視窗頁面啟動（desktop host 有回應）', parsed.options.length > 1, JSON.stringify(parsed.options));
ok('下拉已含工作目錄的兩個 adb',
  parsed.catalog.some((c) => c.name.includes('十三經')) && parsed.catalog.some((c) => c.name.includes('佛光大辭典')),
  JSON.stringify(parsed.catalog.map((c) => c.name)));
ok('啟動時沒有把每個 adb 都載入（只讀檔頭）', parsed.catalog.filter((c) => c.open).length <= 1,
  parsed.catalog.filter((c) => c.open).length + ' 個已載入');
ok('開第一個 adb 是用 mmap 讀的（有 read 統計）', !!parsed.open && parsed.open.reads > 0,
  parsed.open ? `reads=${parsed.open.reads} ioMs=${parsed.open.ioMs?.toFixed?.(1)} parseMs=${parsed.open.parseMs?.toFixed?.(1)}` : 'no breakdown');

// pick the OTHER database from the dropdown and time it
const second = await evalIn<string>(`(async () => {
  const sel = document.getElementById('dbPick');
  const cur = document.getElementById('dbPick').selectedIndex;
  // the option label of a database that is not loaded yet carries the （未載入） suffix
  const name = (o) => o.textContent.replace('（未載入）', '');
  const opt = [...sel.options].find((o, i) => i !== cur);
  if (!opt) return JSON.stringify({ skipped: true });
  const want = name(opt);
  const before = window.__adbview.state().db;
  const t0 = performance.now();
  sel.value = opt.value;
  sel.dispatchEvent(new Event('change'));
  let wall = 0;
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (window.__adbview.openBreakdown()?.file === want) { wall = Math.round(performance.now() - t0); break; }
  }
  await new Promise((r) => setTimeout(r, 800));
  return JSON.stringify({ picked: want, before, now: window.__adbview.state().db, wallMs: wall, open: window.__adbview.openBreakdown() });
})()`);
console.log('--- 從下拉選另一個 ---');
console.log(second);
const picked = JSON.parse(second) as { skipped?: boolean; picked?: string; before?: string; now?: string; wallMs?: number; open?: any };
ok('從下拉選另一個 adb 會載入它（換掉原本的）',
  picked.skipped || (!!picked.open && picked.open.reads > 0 && picked.now !== picked.before && picked.wallMs! < 3000),
  picked.skipped ? '只有一個資料庫'
    : `${picked.before} → ${picked.now}：wall ${picked.wallMs} ms、開檔 ${picked.open.totalMs?.toFixed?.(0)} ms（${picked.open.reads} 次讀取，io ${picked.open.ioMs?.toFixed?.(1)} ms）`);
ok('桌面宿主的開檔成本有被量到（reads/ioMs 都有值）',
  picked.skipped || (picked.open.reads > 0 && picked.open.ioMs > 0 && picked.open.totalMs > 0),
  picked.skipped ? '只有一個資料庫' : `totalMs=${picked.open.totalMs?.toFixed?.(1)} ioMs=${picked.open.ioMs?.toFixed?.(1)}`);

// ---- Go 的索引查詢（postings + plAnd + 分群）必須與 TypeScript 引擎完全相同 -----
// 作者：「把 plAnd、posting group 也做 go 版，TypeScript 直接取得詞 posting 和分群統計」。
const searchCases: { adb: string; q: string }[] = [
  { adb: resolve(CWD, '13j.adb'), q: '象曰' },
  { adb: resolve(CWD, '13j.adb'), q: '孟子' },
  { adb: resolve(CWD, 'yinshun.adb'), q: '大乘' },
  { adb: resolve(CWD, 'yinshun.adb'), q: '般若波羅蜜' },
];
for (const c of searchCases) {
  if (!existsSync(c.adb)) continue;
  const reader = await AdbReader.open(new SyncIO(c.adb));
  const session = new SearchSession(reader);
  await session.init();
  const tag = session.grouping.tag;
  const t0 = performance.now();
  const ts = await session.search(c.q);
  const tsMs = performance.now() - t0;
  const tokens = queryTokens(c.q);
  const goOut = await evalIn<string>(`(async () => {
    const m = await new Function('u', 'return import(u)')('/wails/runtime.js');
    const t0 = performance.now();
    const out = await m.Call.ByName('main.AdbHost.SearchTokens', ${JSON.stringify(c.adb.replace(/\\/g, '/'))}, ${JSON.stringify(tokens)}, ${JSON.stringify(tag)}, 5000);
    return JSON.stringify({ ms: Math.round(performance.now() - t0), out });
})()`);
  const go = JSON.parse(goOut) as { ms: number; out: any };
  const goHits = (go.out?.hits ?? []) as { va: number; units: number }[];
  const tsHits = ts.hits as { va: number; units: number }[];
  const sameHits = tsHits.length === goHits.length
    && tsHits.every((h, i) => h.va === goHits[i].va && h.units === goHits[i].units);
  const tsGroups = ts.groups.map((g) => `${g.name}:${g.from}:${g.to}:${g.count}`).join('|');
  const goGroups = ((go.out?.groups ?? []) as any[]).map((g) => `${g.name}:${g.from}:${g.to}:${g.count}`).join('|');
  const sameGroups = tsGroups === goGroups && tsGroups.length > 0;
  ok(`Go 的索引查詢與 TypeScript 相同（${c.adb.split(/[\\\\/]/).pop()} 「${c.q}」）`,
    sameHits && sameGroups && tsGroups.split('|').length === ts.groups.length,
    `hits ${tsHits.length}${sameHits ? '' : '(不同)'}、groups ${ts.groups.length}/${(go.out?.groups ?? []).length}${sameGroups ? '' : '(不同)'}`
    + `｜TS ${tsMs.toFixed(1)} ms vs Go ${go.ms} ms（Go 內部 lookup ${go.out?.lookupMs?.toFixed?.(1)} / plAnd ${go.out?.andMs?.toFixed?.(1)} / group ${go.out?.groupMs?.toFixed?.(1)} ms，平行=${go.out?.parallel}）`
    + `，missing ${JSON.stringify(go.out?.missing ?? [])}`);
}

// ---- 視窗 UI 真的走 Go 的索引路徑（不是只有直接呼叫 binding） -------------------
const uiSearch = await evalIn<string>(`(async () => {
  const q = document.getElementById('query');
  q.value = '大乘';
  q.dispatchEvent(new Event('input'));
  for (let i = 0; i < 80; i++) { await new Promise(r => setTimeout(r, 200)); if (window.__adbview.state().hostSearch) break; }
  for (let i = 0; i < 40; i++) { await new Promise(r => setTimeout(r, 200)); if (document.querySelectorAll('#searchList .snippet').length) break; }
  const st = window.__adbview.state();
  return JSON.stringify({ db: st.db, hostSearch: st.hostSearch,
    snippets: document.querySelectorAll('#searchList .snippet').length,
    meta: document.getElementById('searchMeta').textContent.slice(0, 50) });
})()`);
const ui = JSON.parse(uiSearch) as { db: string; hostSearch: any; snippets: number; meta: string };
ok('視窗內輸入查詢走 Go 的索引路徑（state().hostSearch 有值、摘要有出來）',
  !!ui.hostSearch && ui.hostSearch.hits > 0 && ui.snippets > 0,
  `${ui.db}「大乘」：hits=${ui.hostSearch?.hits}、摘要 ${ui.snippets} 筆、${ui.hostSearch?.ms?.toFixed?.(1)} ms（Go 內部 lookup ${ui.hostSearch?.lookupMs?.toFixed?.(1)} / plAnd ${ui.hostSearch?.andMs?.toFixed?.(1)} / group ${ui.hostSearch?.groupMs?.toFixed?.(1)} ms）｜${ui.meta}`);

// ---- Go bzip2（桌面）與 TypeScript bzip2（file:// 的退路）必須逐字相同 ----------
// 作者：「bzip2 解壓，有 Go 版就用 Go，沒有才退回 typescript」—— 兩條路要驗到等價。
const blocksAdb = resolve(CWD, '13j.adb');
if (existsSync(blocksAdb)) {
  const reader = await AdbReader.open(new SyncIO(blocksAdb));
  const src = reader.containers.get('source');
  const count = src?.count ?? 0;
  const idxs = [0, 1, Math.floor(count / 2), count - 1].filter((i) => i >= 0 && i < count);
  const ranges: number[][] = [];
  const jsTexts: string[] = [];
  for (const i of idxs) {
    const r = blockRange(src!, i);
    ranges.push([r.start, r.end - r.start]);
    jsTexts.push(await reader.sourceText(i));      // TypeScript 的 vendor bzip2
  }
  const callGo = `(async () => {
    const m = await new Function('u', 'return import(u)')('/wails/runtime.js');
    const out = [];
    for (const [off, len] of ${JSON.stringify(ranges)}) {
      out.push(await m.Call.ByName('main.AdbHost.DecompressText', ${JSON.stringify(blocksAdb.replace(/\\/g, '/'))}, off, len));
    }
    return out;
  })()`;
  const goTexts = await evalIn<string[]>(callGo);
  ok('Go 的 bzip2 與 TypeScript 的 bzip2 對同一批 source block 逐字相同',
    jsTexts.length === goTexts.length && jsTexts.every((x, i) => x === goTexts[i]) && (jsTexts[0]?.length ?? 0) > 0,
    `blocks ${JSON.stringify(idxs)}（第 0 塊 ${jsTexts[0]?.length ?? 0} 字）`);
  // 兩條路的耗時（JS 含 node fs 讀取，Go 含跨語言運輸，只是同一個數量級的量級參考）
  reader.clearTextCache();
  const tJs = performance.now();
  for (const i of idxs) await reader.sourceText(i);
  const jsMs = performance.now() - tJs;
  const tGo = performance.now();
  await evalIn(callGo);
  const goMs = performance.now() - tGo;
  console.log(`      ${idxs.length} 個 block：JS bzip2 ${jsMs.toFixed(1)} ms vs Go bzip2 ${goMs.toFixed(1)} ms（含各自 I/O／運輸）`);
  ok('Go 的 bzip2 也有被量到', goMs >= 0 && jsMs >= 0, `JS ${jsMs.toFixed(1)} ms / Go ${goMs.toFixed(1)} ms`);
} else {
  console.log('      （' + blocksAdb + ' 不存在，略過 Go bzip2 對照）');
}


// ---- 視窗與螢幕：第一次全螢幕、離開記下設定、下次恢復、一律投在啟動螢幕上 -------------
// 作者：「第一次進入 exe 先進入全屏，離開時記下視窗設定，下次恢復；永遠將 exe 投在用戶執行
// exe 的那個屏，偵測不到就在主屏開啟（經常有軟件開已不存在的外接屏）。」
const info1 = await gui.windowInfo();
ok('第一次啟動是全螢幕', info1.fullscreen === true && info1.state === 'fullscreen',
  `state=${info1.state} ${info1.w}x${info1.h}@${info1.x},${info1.y}`);
ok('第一次啟動是全螢幕時有提示（按 Esc／F11 回視窗）',
  (await gui.evalIn<string>(`document.getElementById('fsHint')?.textContent ?? ''`)).includes('Esc'),
  await gui.evalIn<string>(`document.getElementById('fsHint')?.textContent ?? '(沒有提示)'`));
ok('知道自己落在哪張螢幕（含工作區）', !!info1.screen && !!info1.workArea,
  `screen=${info1.screen} primary=${info1.screenPrimary} work=${info1.workArea?.Width}x${info1.workArea?.Height}@${info1.workArea?.X},${info1.workArea?.Y}`);
ok('狀態檔寫在 ACCELON26_STATE_DIR（不碰使用者的 %AppData%）',
  norm(String(info1.statePath ?? '')) === norm(STATE_FILE), `${info1.statePath} vs ${STATE_FILE}`);

// 關掉視窗（優雅關閉）→ Go 應該把設定寫進狀態檔
await gui.close();
const savedRaw = existsSync(STATE_FILE) ? readFileSync(STATE_FILE, 'utf8') : '';
let saved: any = null;
try { saved = JSON.parse(savedRaw); } catch { /* keep null */ }
ok('離開時記下視窗設定', !!saved && saved.w > 0 && saved.h > 0, savedRaw.replace(/\s+/g, ' ').slice(0, 120));
ok('記下來的狀態是 fullscreen', saved?.state === 'fullscreen', String(saved?.state));

// 同一個狀態檔再啟動一次 → 恢復上次的狀態
const gui2 = await startGui(STATE_DIR);
const info2 = await gui2.windowInfo();
ok('第二次啟動恢復上次的狀態（fullscreen）', info2.fullscreen === true && info2.state === 'fullscreen',
  `state=${info2.state} ${info2.w}x${info2.h}@${info2.x},${info2.y}`);
await gui2.close();

// 手寫一個「上次是普通視窗、位置相對那張螢幕的工作區」的設定 → 應該恢復同樣大小，
// 而且位置是相對『這次啟動的螢幕』的工作區（上次那張外接螢幕不在了也不會跑到畫面外）
mkdirSync(STATE_DIR, { recursive: true });
writeFileSync(STATE_FILE, JSON.stringify({ relX: 40, relY: 30, w: 900, h: 700, state: 'normal' }));
const gui3 = await startGui(STATE_DIR);
const info3 = await gui3.windowInfo();
// 期望值要用「啟動時實際選的那張螢幕」的工作區（視窗框回推的不一定同一張）
const wa = info3.launchWorkArea ?? info3.workArea ?? { X: 0, Y: 0, Width: 0, Height: 0 };
const wantW = Math.min(900, wa.Width || 900);
const wantH = Math.min(700, wa.Height || 700);
const wantX = wa.X + Math.min(40, Math.max(0, (wa.Width || wantW) - wantW));
const wantY = wa.Y + Math.min(30, Math.max(0, (wa.Height || wantH) - wantH));
ok('恢復記下的大小（夾進啟動螢幕的工作區）', info3.state === 'normal' && Math.abs(info3.w - wantW) <= 2 && Math.abs(info3.h - wantH) <= 2,
  `state=${info3.state} got ${info3.w}x${info3.h} want ${wantW}x${wantH}`);
// 位置：要求的是「啟動螢幕工作區原點 + (relX,relY)」，而且**一定要在工作區裡面**
// （上次那張外接螢幕不在了也不能跑到畫面外）。平台/DPI 可能讓實際位置與要求差幾十像素
// （見交接文件 §10.8），所以這裡驗「在工作區內」＋「接近要求」，另外用下面的穩定性測試
// 確認「連續兩次啟動的設定不會漂移」。
const inWorkArea = info3.x >= wa.X - 2 && info3.y >= wa.Y - 2
  && info3.x + info3.w <= wa.X + wa.Width + 2 && info3.y + info3.h <= wa.Y + wa.Height + 2;
ok('恢復的位置在啟動螢幕的工作區內（不會跑到畫面外）', inWorkArea,
  `got (${info3.x},${info3.y}) ${info3.w}x${info3.h}｜工作區 ${wa.X},${wa.Y} ${wa.Width}x${wa.Height}`);
ok('恢復的位置接近要求（平台可能差幾十像素）', Math.abs(info3.x - wantX) <= 60 && Math.abs(info3.y - wantY) <= 60,
  `got (${info3.x},${info3.y}) want (${wantX},${wantY})`);

// 視窗要有標準 Windows 標題列：可以關、可以縮放、可以最大化（作者 2026-10 指出全螢幕沒有標題列）
const st3 = info3.style ?? {};
ok('視窗有標題列／可以縮放／可以關／可以最大化',
  st3.caption === true && st3.resizable === true && st3.sysMenu === true && st3.maximizeBox === true,
  `style=${st3.style} caption=${st3.caption} resizable=${st3.resizable} sysMenu=${st3.sysMenu} maximizeBox=${st3.maximizeBox}`);

// F11 進全螢幕、Esc 回視窗（全螢幕時 Wails 用 WS_POPUP，沒有標題列是正常的）
const pressKey = async (k: string, code: number) => {
  await gui3.evalIn(`(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, code: ${JSON.stringify(k)}, bubbles: true })); return 1; })()`);
  await Bun.sleep(800);
};
await pressKey('F11', 122);
const fsOn = await gui3.windowInfo();
ok('F11 進入全螢幕', fsOn.fullscreen === true, `fullscreen=${fsOn.fullscreen} style=${fsOn.style?.style}`);
await pressKey('Escape', 27);
const fsOff = await gui3.windowInfo();
ok('Esc 離開全螢幕並把標題列還回來（可以關／縮放／最大化）',
  fsOff.fullscreen === false && fsOff.style?.caption === true && fsOff.style?.resizable === true && fsOff.style?.maximizeBox === true,
  `fullscreen=${fsOff.fullscreen} style=${fsOff.style?.style} caption=${fsOff.style?.caption} resizable=${fsOff.style?.resizable}`);
await gui3.close();

// 穩定性：上面那次關掉時記下的設定，再啟動一次、再關掉，兩次的設定要一樣（不會每次漂移）
// 平台在建立視窗後可能自己再挪一次（DPI/虛擬螢幕），所以要求的是「收斂」：
// 再啟動幾次，必須在 3 次之內出現兩次完全相同的設定（往後就固定了）。
const readState = () => (existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : null);
const same = (a: any, b: any) => !!a && !!b
  && Math.abs(a.relX - b.relX) <= 2 && Math.abs(a.relY - b.relY) <= 2
  && a.w === b.w && a.h === b.h && a.state === b.state;
let prev = readState();
const seen = [JSON.stringify(prev)];
let converged = false;
let lastInfo: any = null;
for (let i = 0; i < 3 && !converged; i++) {
  const g = await startGui(STATE_DIR);
  lastInfo = await g.windowInfo();
  await g.close();
  const now = readState();
  seen.push(JSON.stringify(now));
  converged = same(prev, now);
  prev = now;
}
ok('連續啟動會收斂到同一組視窗設定（不會一直漂移）', converged,
  seen.join(' → ') + (lastInfo ? `｜最後一次啟動 ${lastInfo.w}x${lastInfo.h}@${lastInfo.x},${lastInfo.y}` : ''));

// ---- 線上更新：本地 HTTP 伺服器當作「已發佈的新版」 --------------------------------
// 作者：「如果線上 built time 比用戶運行中的新，左上角閃動…用戶點下時，問是否確定更新…
// 更新後，顯示改版新增或改進的功能。」測試用 ACCELON26_UPDATE_URL 指向本地伺服器，
// 餵一份「比現在新」的 exe（自己的一份拷貝），不連外網、也不碰正式站。
// 被更新的那顆 exe 是 build/tmp-upd 裡的**副本**，所以 build/desktop/accelon26.exe 不會被動到。
const updDir = resolve(ROOT, 'build/tmp-upd');
rmSync(updDir, { recursive: true, force: true });
mkdirSync(updDir, { recursive: true });
const oldExe = resolve(updDir, 'accelon26.exe');
copyFileSync(EXE, oldExe);

const serveDir = resolve(ROOT, 'build/tmp-update-serve');
rmSync(serveDir, { recursive: true, force: true });
mkdirSync(serveDir, { recursive: true });
const servedExe = resolve(serveDir, 'accelon26.exe');
copyFileSync(EXE, servedExe);
const futureLM = new Date(Date.now() + 24 * 3600 * 1000).toUTCString();
const server = Bun.serve({
  port: 0,
  fetch(req) {
    if (req.method === 'HEAD') return new Response(null, { status: 200, headers: { 'Last-Modified': futureLM } });
    return new Response(Bun.file(servedExe), { status: 200, headers: { 'Last-Modified': futureLM } });
  },
});
const fakeUpdateURL = `http://127.0.0.1:${server.port}/accelon26.exe`;
const before = statSync(oldExe).mtimeMs;

const gui5 = await startGui(updDir, { exe: oldExe, env: { ACCELON26_UPDATE_URL: fakeUpdateURL } });
let app5: any = null;
for (let i = 0; i < 40; i++) { app5 = await gui5.call('main.AdbHost.AppInfo'); if (app5?.updateAvailable) break; await Bun.sleep(300); }
ok('檢查到線上版本比較新（Last-Modified）', app5?.updateAvailable === true,
  `本地 ${app5?.buildTimeText} vs 線上 ${(app5?.remoteBuildTime ?? '').slice(0, 16)}｜${app5?.note}`);
ok('目錄可寫 → 允許更新；線上網址就是設定的那個', app5?.dirWritable === true && app5?.canUpdate === true && app5?.updateURL === fakeUpdateURL,
  `dirWritable=${app5?.dirWritable} canUpdate=${app5?.canUpdate}`);
const brandRaw = await gui5.evalIn<string>(`JSON.stringify({ cls: document.getElementById('brand').className, title: document.getElementById('brand').title })`);
const brand = JSON.parse(brandRaw) as { cls: string; title: string };
ok('左上角 hover hint 顯示建置時間', /built\s+\d{4}-\d{2}-\d{2}/.test(brand.title), brand.title);
ok('左上角閃動並提示有新版本', brand.cls.includes('update') && /有新版本/.test(brand.title), `${brand.cls}｜${brand.title}`);

// 點下左上角 → confirm（測試改成自動確定）→ Go 層下載、換檔、帶 -updated-from 重啟
const tClick = Date.now();
await gui5.evalIn(`(() => { window.confirm = () => true; document.getElementById('brand').click(); return 1; })()`).catch(() => undefined);
for (let i = 0; i < 120 && gui5.proc.exitCode === null; i++) await Bun.sleep(250);
ok('更新後舊行程結束（交給新版）', gui5.proc.exitCode !== null, `exit ${gui5.proc.exitCode}（${Math.round((Date.now() - tClick) / 1000)} s）`);
ok('執行檔已被新版取代（mtime 變新）', statSync(oldExe).mtimeMs > before,
  `${new Date(before).toISOString()} → ${new Date(statSync(oldExe).mtimeMs).toISOString()}`);
ok('留下 .old（下次啟動自動清掉）', existsSync(oldExe + '.old'), oldExe + '.old');

// 更新程式用 ＋1 的除錯埠啟動新版；埠有起來就順便驗一次「新版真的在跑」
let gui6: Gui | null = null;
try { gui6 = await startGui(updDir, { spawn: false, port: PORT + 1 }); } catch { gui6 = null; }
if (gui6) {
  const app6 = await gui6.call('main.AdbHost.AppInfo');
  ok('新版帶著 -updated-from 啟動', !!app6?.updatedFrom, `updatedFrom=${app6?.updatedFrom}`);
  await gui6.close();
} else {
  console.log('      （新行程的 DevTools 埠沒起來，改用在下面手動帶 -updated-from 驗改版說明）');
}

// 改版說明：直接照更新程式的方式啟動（-updated-from <舊建置時間>），驗左上角之外的那個說明框
const notesDir = resolve(ROOT, 'build/tmp-state-notes');
rmSync(notesDir, { recursive: true, force: true });
const oldBuild = app5?.buildTime ?? '';
await waitPortFree(PORT + 2);
const proc7 = Bun.spawn([oldExe, '-updated-from', oldBuild], {
  cwd: ROOT,
  env: guiEnv(notesDir, PORT + 2),
  stdout: 'pipe', stderr: 'pipe',
});
const gui8 = await startGui(notesDir, { spawn: false, port: PORT + 2 });
let notesVisible = false; let notesText = '';
for (let i = 0; i < 30; i++) {
  const r = await gui8.evalIn<string>(`JSON.stringify({ has: !!document.getElementById('notesBox'), text: document.getElementById('notesBox')?.textContent?.slice(0, 90) ?? '' })`);
  const p = JSON.parse(r) as { has: boolean; text: string };
  notesVisible = p.has; notesText = p.text;
  if (notesVisible) break;
  await Bun.sleep(300);
}
ok('更新後顯示改版說明（notesBox）', notesVisible, notesText);
ok('新版啟動時把上次留下的 .old 清掉', !existsSync(oldExe + '.old'), oldExe + '.old');

// 真正的改版說明（release_notes.json 內容）：假裝從很久以前那一版更新上來，應該列出這一版的每一項
await waitPortFree(PORT + 3);
const proc9 = Bun.spawn([oldExe, '-updated-from', '2000-01-01T00:00:00Z'], {
  cwd: ROOT,
  env: guiEnv(notesDir, PORT + 3),
  stdout: 'pipe', stderr: 'pipe',
});
const gui9 = await startGui(notesDir, { spawn: false, port: PORT + 3 });
let realNotes = '';
for (let i = 0; i < 30; i++) {
  realNotes = await gui9.evalIn<string>(`document.getElementById('notesBox')?.textContent ?? ''`);
  if (realNotes) break;
  await Bun.sleep(300);
}
const firstItem = 'exe 改名為 accelon26';
ok('改版說明列出 release_notes.json 的每一項', realNotes.includes(firstItem),
  realNotes.replace(/\s+/g, ' ').slice(0, 140));
await gui9.close();
try { proc9.kill(); } catch { /* already gone */ }
await gui8.close();
try { proc7.kill(); } catch { /* already gone */ }
server.stop(true);
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);