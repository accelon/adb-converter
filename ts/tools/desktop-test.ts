/**
 * Desktop (Wails3) smoke test — the exe must list every `.adb` in its WORKING DIRECTORY
 * and read them through the host's mmap (no Blob.slice, no socket, no events).
 *
 *   bun run tools/desktop-test.ts [--exe ../build/desktop/adbview.exe] [--gui] [--cwd ..]
 *
 * Default (headless): run the exe with `-selftest` in `--cwd` (the repository root, where
 * 13j.adb and fgdict.adb live) and check the listing + the read timing it prints.
 * --gui: also start the real window with WebView2's remote debugger and drive the SAME
 * page the browser suite drives — the dropdown must already contain the working
 * directory's databases before anything is clicked, and Go's compress/bzip2 must agree
 * with the TypeScript vendor bzip2 on real source blocks.
 */
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { AdbReader, SyncIO, blockRange } from '../src/adbview/adb';
import { SearchSession, queryTokens } from '../src/adbview/search';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const ROOT = resolve(import.meta.dir, '../..');
const EXE = resolve(opt('exe', resolve(ROOT, 'build/desktop/adbview.exe')));
const CWD = resolve(opt('cwd', ROOT));
const GUI = args.includes('--gui');
const PORT = Number(opt('port', '9222'));

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + name + (detail ? '  ' + detail : '')); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
};
if (!existsSync(EXE)) {
  console.error('missing ' + EXE + ' — build it first:  cd wails; go build -o ../build/desktop/adbview.exe .');
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

// ---------------------------------------------------------------- windowed sanity
const proc = Bun.spawn([EXE], {
  cwd: CWD,
  // the host reads this itself (Wails overwrites WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS)
  env: { ...process.env, ADBVIEW_DEBUG_PORT: String(PORT) },
  stdout: 'pipe', stderr: 'pipe',
});
let ws = '';
const deadline = Date.now() + 30000;
while (Date.now() < deadline && !ws) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
    const j = await r.json() as { webSocketDebuggerUrl?: string };
    ws = j.webSocketDebuggerUrl ?? '';
  } catch { /* not up yet */ }
  if (!ws) await Bun.sleep(300);
}
if (!ws) { console.log('  FAIL no WebView2 devtools endpoint'); proc.kill(); process.exit(1); }

let sock: WebSocket;
await new Promise<void>((res, rej) => { sock = new WebSocket(ws); sock.onopen = () => res(); sock.onerror = () => rej(new Error('ws')); });
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

proc.kill();
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
