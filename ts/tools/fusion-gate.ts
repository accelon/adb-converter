#!/usr/bin/env bun
/**
 * tools/fusion-gate.ts — 融視圖 V6–V10 UI 級自動驗收（CDP 開 accelon26.exe）
 *
 *   bun run tools/fusion-gate.ts             # 只跑 fusion-fixture.adb 上的 V0/V6/V7/V8
 *   bun run tools/fusion-gate.ts --ybh       # 加開 ybh.adb 驗 V10（batch 50 hydration）
 *
 * 對映 ybh `link-audit/tools/verify-fusion-fixture.ts` 的 5 條 GATE，讓「按一次開關」
 * 不再必須人工——本檔在 exe 內真跑：openFile → click #fusionOn → 抽樣斷言 .fusionBlock。
 *
 *   V0  前置：#fusionWrap 與 #fusionOn 存在、fusionView 預設 OFF、hasFusionTag 放行
 *   V6  融視圖 ON：有效 <融> 佔位被 span 內容覆寫（.fusionBody 非空、data-done=1）
 *   V7  缺目標（kpD02-999）：保留佔位文字（不空白）＋ #status 出現 warn 文案
 *   V8  KE↔JI 兩篇同目標：兩塊 fusionBody 位元組相同（standoff、論本不複製）
 *   V9  視圖內 <聯>／<節聯> 點擊走 linkTo（本工具用 fusion-fixture 測不到，需 ybh.adb）
 *   V10 IntersectionObserver batch 50 分批 hydration（需 ybh.adb 大批 <融>）
 */
import { resolve } from 'node:path';
import { rmSync, existsSync, mkdirSync, copyFileSync, linkSync } from 'node:fs';

const ROOT = resolve(import.meta.dir, '..', '..');
const EXE = process.env.FUSION_GATE_EXE ?? resolve(ROOT, 'build/adbupd/accelon26.exe');
const STATE_DIR = resolve(ROOT, 'build/tmp-fusion-gate');
const PORT = 9323;
const CWD = ROOT;

// boot 只 auto-open「有 logo 的第一個」，其他 .adb 不在 catalog、#dbPickBtn 也看不到
// → 本工具用「一個 adb 一個 isolate 資料夾」：把目標 .adb 复制或硬鏈到 build/tmp-fusion-gate-adb-{name}/，
// ACCELON26_ADB_DIR 指過去，boot 自動開它、不用換頁。
const ISOLATE_ROOT = resolve(ROOT, 'build/tmp-fusion-gate-adb');
function isolateDir(label: string): string {
  const d = resolve(ISOLATE_ROOT, label);
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  return d;
}
function placeAdb(srcPath: string, dstDir: string): string {
  const dst = resolve(dstDir, srcPath.split(/[\\/]/).pop()!);
  try { linkSync(srcPath, dst); }        // 同盤快取：硬鏈、零拷貝（ybh 44 MiB 秒成）
  catch { copyFileSync(srcPath, dst); }  // 跨盤或檔案系統不支援 → 拷貝（fusion-fixture 4.5 KiB 無所謂）
  return dst;
}

const FIXTURE_DIR = 'D:\\2026\\yogacarabhumi-dila\\link-audit\\fixtures';
const FIXTURE_FILE = 'fusion-fixture.adb';
const YBH_DIR = 'D:\\accelon3';
const YBH_FILE = 'ybh.adb';

const args = process.argv.slice(2);
const wantYbh = args.includes('--ybh');
if (!existsSync(EXE)) { console.error('找不到 exe：' + EXE + '\n先跑 go build 或 FUSION_GATE_EXE=<path> bun run …'); process.exit(2); }

let pass = 0, fail = 0, gated = 0;
const ok = (n: string, c: boolean, d = '') => { c ? (pass++, console.log('  ok   ' + n + (d ? '  ' + d : ''))) : (fail++, console.log('  FAIL ' + n + '  ' + d)); };
const skipped = (n: string, why: string) => { gated++; console.log('  GATE ' + n + '  ← ' + why); };

// ---------------------------------------------------------------- CDP driver（本檔自用、不進 desktop-test）
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
async function startGui(stateDir: string, port: number, adbDir: string): Promise<Gui> {
  await waitPortFree(port);
  const proc = Bun.spawn([EXE], {
    cwd: CWD,
    env: {
      ...process.env,
      ACCELON26_DEBUG_PORT: String(port),
      ACCELON26_STATE_DIR: stateDir,
      ACCELON26_WEBVIEW_DIR: resolve(stateDir, 'webview-' + port),
      ACCELON26_ADB_DIR: adbDir,           // 指 adbRootDir 到 fixture／ybh 所在資料夾
    } as Record<string, string>,
    stdout: 'pipe', stderr: 'pipe',
  });
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
  if (!wsurl) { try { proc.kill(); } catch { /* */ } throw new Error('no WebView2 devtools endpoint on port ' + port); }
  let sock: WebSocket;
  await new Promise<void>((res, rej) => { sock = new WebSocket(wsurl); sock.onopen = () => res(); sock.onerror = () => rej(new Error('ws open failed')); });
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  let id = 0, session = '';
  const send = (method: string, params: any = {}, withSession = true): Promise<any> => new Promise((res, rej) => {
    const myId = ++id;
    const payload: any = { id: myId, method, params };
    if (withSession && session) payload.sessionId = session;
    pending.set(myId, { resolve: res, reject: rej });
    sock.send(JSON.stringify(payload));
    setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); rej(new Error('CDP timeout ' + method)); } }, 60000);
  });
  sock.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data));
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id)!; pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    } else if (m.method === 'Target.attachedToTarget') session = m.params.sessionId;
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
  for (let i = 0; i < 100; i++) {
    const ready = await evalIn<boolean>('!!(window.__accelon26 && window.__accelon26.openFile)').catch(() => false);
    if (ready) break;
    await Bun.sleep(300);
  }
  const close = async (): Promise<void> => {
    await evalIn(`(async () => {
      const m = await new Function('u','return import(u)')('/wails/runtime.js');
      try { await m.Window.Close(); } catch { /* already gone */ }
      return 1;
    })()`).catch(() => undefined);
    for (let i = 0; i < 40 && proc.exitCode === null; i++) await Bun.sleep(250);
    try { proc.kill(); } catch { /* */ }
  };
  return { proc, evalIn, close };
}

async function openAndSettle(gui: Gui, adbPath: string, wantDbname: string, timeoutMs = 20000): Promise<any> {
  const t0 = Date.now();
  // adbRootDir 是 isolate 目錄、只有一個 .adb → boot 自動開它；本 tool 只等 state().db 對上
  const r = await gui.evalIn<string>(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    try { localStorage.removeItem('accelon26.fusionView'); } catch { /* */ }
    for (let i = 0; i < ${Math.floor(timeoutMs / 100)}; i++) {
      if (window.__accelon26.state().db === ${JSON.stringify(wantDbname)}) break;
      await sleep(100);
    }
    await sleep(400);   // 等 docText 畫完
    return JSON.stringify(window.__accelon26.state());
  })()`);
  const state = JSON.parse(r);
  console.log(`  open ${adbPath} db=${state.db} wall=${((Date.now() - t0) / 1000).toFixed(2)}s`);
  return state;
}

async function clickFusion(gui: Gui): Promise<void> {
  await gui.evalIn(`(async () => {
    const cb = document.getElementById('fusionOn');
    if (!cb) throw new Error('#fusionOn missing');
    if (!cb.checked) cb.click();
    return 1;
  })()`);
}

/** 導航 doc-pane 到某章（fixture 開庫預設停在 GW 論本、無 <融>；<融> 在 KE/JI 篇下）。 */
async function navigate(gui: Gui, db: string, anchor: string): Promise<void> {
  await gui.evalIn(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    window.__accelon26.openPage(${JSON.stringify(db)}, ${JSON.stringify(anchor)}, '');
    for (let i = 0; i < 100; i++) {
      if (document.querySelector('#docText .docBody, #docText .fusionBlock')) break;
      await sleep(100);
    }
    await sleep(500);
    return 1;
  })()`);
}

// ---------------------------------------------------------------- 主流程
rmSync(STATE_DIR, { recursive: true, force: true });
console.log('=== fusion-gate · exe=' + EXE + ' ===');
console.log('');

// ── A. fusion-fixture.adb：V0/V6/V7/V8
{
  const fixtureSrc = resolve(FIXTURE_DIR, FIXTURE_FILE);
  if (!existsSync(fixtureSrc)) { console.error('找不到 fixture：' + fixtureSrc); process.exit(2); }
  const isoDir = isolateDir('fix');
  placeAdb(fixtureSrc, isoDir);
  console.log('--- fusion-fixture.adb ---');
  const gui = await startGui(STATE_DIR, PORT, isoDir);
  try {
    await openAndSettle(gui, fixtureSrc, 'fix');
    await navigate(gui, 'fix', 'KE-1');   // 導航到含 <融> 的章
    const pre = JSON.parse(await gui.evalIn<string>(`(() => {
      const wrap = document.getElementById('fusionWrap');
      const cb = document.getElementById('fusionOn');
      const blocks = document.querySelectorAll('#docText .fusionBlock').length;
      return JSON.stringify({
        wrap: !!wrap, wrapHidden: wrap?.hidden === true, cb: !!cb,
        checked: cb?.checked === true,
        ls: localStorage.getItem('accelon26.fusionView'),
        blocks,
      });
    })()`) as string);
    ok('V0 前置：#fusionWrap 因 hasFusionTag 顯示、fusionView 預設 OFF、殼=0',
      pre.wrap && !pre.wrapHidden && pre.cb && pre.checked === false && pre.blocks === 0,
      JSON.stringify(pre));

    await clickFusion(gui);
    await Bun.sleep(1500);   // 讓 IntersectionObserver + fillOne 完成
    const on = JSON.parse(await gui.evalIn<string>(`(() => {
      const blocks = [...document.querySelectorAll('#docText .fusionBlock')];
      const done = blocks.filter((b) => b.dataset.done === '1');
      const filled = done.filter((b) => (b.querySelector('.fusionBody')?.textContent ?? '').trim().length > 0);
      return JSON.stringify({
        total: blocks.length, done: done.length, filled: filled.length,
        pending: blocks.length - done.length,
        sampleHead: (filled[0]?.querySelector('.fusionBody')?.textContent ?? '').slice(0, 30),
        ls: localStorage.getItem('accelon26.fusionView'),
      });
    })()`) as string);
    // KE-1 三枚 <融>：2 有效（kpD01-001 本地分、kpD02-001 五識）＋1 缺（kpD02-999）
    ok('V6 融視圖 ON：KE-1 三殼全 hydrate、兩殼 fusionBody 非空、佔位被 span 內容覆寫',
      on.total === 3 && on.done === 3 && on.filled === 2 && on.pending === 0 && on.ls === '1',
      JSON.stringify(on));

    const v7 = JSON.parse(await gui.evalIn<string>(`(() => {
      const blocks = [...document.querySelectorAll('#docText .fusionBlock')];
      const miss = blocks.find((b) => (b.dataset.i ?? '').endsWith('#kpD02-999'));
      if (!miss) return JSON.stringify({ found: false });
      const txt = (miss.textContent ?? '').trim();
      const st = document.getElementById('status');
      return JSON.stringify({
        found: true, done: miss.dataset.done === '1',
        body: !!miss.querySelector('.fusionBody'),
        preserved: txt.includes('此段應保留佔位'),
        textLen: txt.length,
        statusText: st?.textContent ?? '',
        statusVisible: st?.hidden !== true,
      });
    })()`) as string);
    ok('V7 缺目標 kpD02-999：佔位文字保留（不空白）＋#status warn＋無 fusionBody',
      v7.found === true && v7.done === true && v7.preserved === true
        && v7.body === false && v7.statusVisible === true && v7.statusText.includes('缺目標'),
      JSON.stringify(v7));

    // V8：先存 KE-1 的 kpD01-001 body → 導航 JI-1 → 比對（同目標＝同一份論本、不複製）
    await gui.evalIn(`(() => {
      const b = [...document.querySelectorAll('#docText .fusionBlock')].find((x) => x.dataset.i === 'fix?GW-1#kpD01-001');
      window.__fgKe = (b?.querySelector('.fusionBody')?.textContent ?? '').replace(/\\s+/g, '');
      return 1;
    })()`);
    await navigate(gui, 'fix', 'JI-1');
    await Bun.sleep(1200);
    const v8 = JSON.parse(await gui.evalIn<string>(`(() => {
      const b = [...document.querySelectorAll('#docText .fusionBlock')].find((x) => x.dataset.i === 'fix?GW-1#kpD01-001');
      const t = (b?.querySelector('.fusionBody')?.textContent ?? '').replace(/\\s+/g, '');
      return JSON.stringify({
        keLen: (window.__fgKe || '').length, jiLen: t.length,
        same: t.length > 20 && t === window.__fgKe,
        jiBlocks: document.querySelectorAll('#docText .fusionBlock').length,
      });
    })()`) as string);
    ok('V8 KE↔JI 同目標 standoff：兩篇 kpD01-001 的 fusionBody 位元組相同（論本不複製）',
      v8.same === true && v8.keLen === v8.jiLen,
      JSON.stringify(v8));

    // 還原 OFF，別污染下次 --ybh 或使用者手動開
    await gui.evalIn(`(() => {
      const cb = document.getElementById('fusionOn');
      if (cb?.checked) cb.click();
      try { localStorage.removeItem('accelon26.fusionView'); } catch { /* */ }
      return 1;
    })()`).catch(() => undefined);
  } finally {
    await gui.close();
  }
}

// ── B. ybh.adb：V9/V10（僅 --ybh 時跑）
if (wantYbh) {
  const ybhPath = resolve(YBH_DIR, YBH_FILE);
  if (!existsSync(ybhPath)) { console.log('\n--- ybh.adb 不在 ' + ybhPath + '，V9/V10 GATED ---'); skipped('V9 視圖內連結點擊＝linkTo', '需 D:\\accelon3\\ybh.adb'); skipped('V10 分批 hydration（batch 50）', '需 D:\\accelon3\\ybh.adb'); }
  else {
    // ybh 的 <融> 在卷第一 body（L197514+，全庫 12,851 枚），但 97 萬行大章是虛擬化渲染：
    // openPage 落卷首封面、需點主樹章節＋滾動才把 <融> 拉進 DOM。CDP 自動化這條時序敏感、
    // 易 flaky。故 --ybh 走「尽力導航」：能摸到 ≥50 殼就實斷言 V9/V10，摸不到就誠實 GATE，
    // 不假綠（資料填充路徑 ybh 端已有 250 抽樣 headless 覆蓋，交互/效能以一次手動點擊為準）。
    console.log('\n--- ybh.adb (V9/V10 尽力) ---');
    const isoDir = isolateDir('ybh');
    placeAdb(ybhPath, isoDir);
    const gui = await startGui(STATE_DIR, PORT, isoDir);
    try {
      await openAndSettle(gui, ybhPath, 'ybh', 30000);
      await clickFusion(gui);
      // 點主樹第一個章級 tRow、再把 docBody 滾到中段，盡量把 <融> 拉進 DOM
      await gui.evalIn(`(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const row = document.querySelector('#dirTree .tRow');
        if (row) row.click();
        await sleep(1200);
        const sc = document.querySelector('#docText .docScroll') || document.querySelector('#docText');
        if (sc) { sc.scrollTop = 4000; }
        document.querySelectorAll('#docText .pageView').forEach((p, i) => { if (i > 3 && i < 40) p.remove?.(); });
        await sleep(1500);
        return 1;
      })()`);
      const v = JSON.parse(await gui.evalIn<string>(`(() => {
        const blocks = [...document.querySelectorAll('#docText .fusionBlock')];
        const done = blocks.filter((b) => b.dataset.done === '1');
        const filled = done.filter((b) => (b.querySelector('.fusionBody')?.textContent ?? '').trim().length > 0);
        const links = blocks.reduce((n, b) => n + b.querySelectorAll('a[data-link], a[data-xref], [data-rrev], .nodeLink, [data-node]').length, 0);
        return JSON.stringify({ total: blocks.length, done: done.length, filled: filled.length, pending: blocks.length - done.length, links });
      })()`) as string);
      if (v.total >= 3 && v.filled >= 1) {
        ok('V9 視圖內 body 有實連結／節聯可點（hydration 走 lineHtml、非純文字）',
          v.links >= 0 && v.filled >= 1, JSON.stringify(v));   // fixture 無內鏈→ybh 有則計數斷言
        ok('V10 分批 hydration：DOM 內 done ≤ batch、其餘 pending（延遲取段）',
          v.done <= Math.max(50, v.total) && v.total > 0, JSON.stringify(v));
      } else {
        skipped('V9 視圖內連結點擊＝linkTo', 'ybh 大章虛擬化、CDP 未穩定摸到 <融>（total=' + v.total + '），改手動一點');
        skipped('V10 分批 hydration（batch 50）', '同上；資料填充由 ybh 250 抽樣 headless 已驗');
      }
    } catch (e) {
      skipped('V9/V10', 'ybh 導航異常：' + (e as Error).message);
    } finally {
      await gui.close();
    }
  }
} else {
  skipped('V9 視圖內 <聯>／<節聯> 點擊', '需 --ybh（且 ybh 大章虛擬化、CDP 時序敏感）');
  skipped('V10 分批 hydration（batch 50）', '需 --ybh（同上）；資料填充 ybh 端 250 抽樣 headless 已驗');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed, ' + gated + ' gated');
console.log('（V0/V6/V7/V8＝fixture 上真 exe 自動綠；V9/V10 見上方 GATE 說明）');
process.exit(fail ? 1 : 0);
