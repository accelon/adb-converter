/**
 * 公開資料庫更新（.adb）的桌面版端到端測試（作者 2026-10-29）。
 *
 *   cd ts && bun run tools/adb-update-test.ts
 *
 * 用本機 HTTP 伺服器假裝官網：
 *   /manifest.json  → 更新清單（13j.adb 有新 sha256 與兩條說明）
 *   /13j.adb        → 先慢速送（測進度條＋放棄），再全速送（測真的換檔）
 *
 * 驗的是使用者看到的流程：開機檢查 → #dbTabs 出現紅色 New → 點開對話盒看到說明
 * → 下載中有進度 → 放棄後原檔不變 → 再按更新會換檔並重新載入。
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../..');
const EXE_SRC = resolve(ROOT, 'build/adbupd/accelon26.exe');
const DIR = resolve(ROOT, 'build/tmp-adbupd');
const EXE = resolve(DIR, 'accelon26.exe');
const STATE = resolve(DIR, 'state');
const PORT = 9333;
const SRC = 'D:\\accelon3\\13j.adb';
const OLD = resolve(DIR, '13j.adb');

if (!existsSync(EXE_SRC)) {
  console.error('缺少 ' + EXE_SRC + '：先在 wails/ 建一顆測試 exe');
  process.exit(2);
}
if (!existsSync(SRC)) {
  console.error('缺少 ' + SRC);
  process.exit(2);
}

rmSync(DIR, { recursive: true, force: true });
mkdirSync(STATE, { recursive: true });
// 把 exe 複製到測試資料夾：exe 目錄＝工作目錄，ListAdbs 只會看到這一次準備的 adb
// （不會誤用 build/adbupd 裡以前留下的 13j.adb）。
copyFileSync(EXE_SRC, EXE);
copyFileSync(SRC, OLD);

// 同一份 13j 只改檔頭中文名 → 內容不同但大小相同：一定要比 sha256 才看得到版本。
const baseBytes = readFileSync(SRC);
const rename = (name: string): Buffer => {
  const b = Buffer.from(baseBytes);
  b.fill(0, 128, 192);
  b.write(name, 128, 60, 'utf16le');
  return b;
};
const localBytes = rename('十三經（本機版）');
const midBytes = rename('十三經（中間版）');
const newBytes = rename('十三經（更新版）');
writeFileSync(OLD, localBytes);
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const localSha = sha(localBytes);
const midSha = sha(midBytes);
const newSha = sha(newBytes);
const oldSha = sha(baseBytes);
console.log(`本機 13j.adb  ${(localBytes.length / 1024).toFixed(0)} KiB  sha256 ${localSha.slice(0, 12)}…（本機版）`);
console.log(`線上最新       ${(newBytes.length / 1024).toFixed(0)} KiB  sha256 ${newSha.slice(0, 12)}…（更新版；中間還有一版）`);

const NOTES = [
  '目錄層級修正：章／節／項依原書次序',
  '內文小篆字形改為 SVG，跟著字色走',
];
let slow = true;
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const p = new URL(req.url).pathname;
    if (p === '/manifest.json') {
      return Response.json({
        schema: 1,
        generated: new Date().toISOString(),
        dbs: [{
          file: '13j.adb', name: '十三經', size: newBytes.length, sha256: newSha,
          buildTime: '2026-10-29T01:00:00Z', date: '2026-10-29', notes: NOTES,
          history: [
            { buildTime: '2026-10-29T01:00:00Z', sha256: newSha, size: newBytes.length, notes: NOTES },
            { buildTime: '2026-10-29T00:30:00Z', sha256: midSha, size: midBytes.length, notes: ['中間版：目錄多了「傳」一層'] },
            { buildTime: '2026-10-28T15:15:00Z', sha256: localSha, size: localBytes.length, notes: ['本機版：這一版已安裝'] },
            { buildTime: '2006-01-18T17:34:52Z', sha256: oldSha, size: baseBytes.length, notes: ['原版：2006 年光碟'] },
          ],
        }],
      });
    }
    if (p === '/13j.adb') {
      if (!slow) return new Response(newBytes, { headers: { 'Content-Type': 'application/octet-stream' } });
      const chunk = 16 << 10;
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          let at = 0;
          const tick = () => {
            if (at >= newBytes.length) { try { c.close(); } catch { /* 已取消 */ } return; }
            try {
              c.enqueue(new Uint8Array(newBytes.subarray(at, Math.min(at + chunk, newBytes.length))));
            } catch { return; }   // 客戶端按了放棄：串流已關
            at += chunk;
            setTimeout(tick, 90);
          };
          tick();
        },
      });
      return new Response(stream, {
        headers: { 'Content-Length': String(newBytes.length), 'Content-Type': 'application/octet-stream' },
      });
    }
    return new Response('not found', { status: 404 });
  },
});
const base = `http://127.0.0.1:${server.port}`;
console.log('測試伺服器 ' + base);

// ---- CDP：和 tools/desktop-test.ts 同一套做法（縮小版） -------------------------
const proc = Bun.spawn([EXE], {
  cwd: DIR,
  env: {
    ...process.env,
    ACCELON26_ADB_MANIFEST: base + '/manifest.json',
    ACCELON26_DEBUG_PORT: String(PORT),
    ACCELON26_STATE_DIR: STATE,
    ACCELON26_WEBVIEW_DIR: resolve(STATE, 'webview'),
  } as Record<string, string>,
  stdout: 'pipe', stderr: 'pipe',
});

let wsurl = '';
for (const until = Date.now() + 30000; Date.now() < until && !wsurl;) {
  try {
    const j = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json() as { webSocketDebuggerUrl?: string };
    wsurl = j.webSocketDebuggerUrl ?? '';
  } catch { /* not yet */ }
  if (!wsurl) await Bun.sleep(300);
}
if (!wsurl) { proc.kill(); throw new Error('WebView2 devtools 沒有起來'); }

let sock: WebSocket;
await new Promise<void>((res, rej) => { sock = new WebSocket(wsurl); sock.onopen = () => res(); sock.onerror = () => rej(new Error('ws')); });
let seq = 0, session = '';
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
const send = (method: string, params: Record<string, unknown> = {}, withSession = true): Promise<any> => new Promise((res, rej) => {
  const id = ++seq;
  const payload: Record<string, unknown> = { id, method, params };
  if (withSession && session) payload.sessionId = session;
  pending.set(id, { resolve: res, reject: rej });
  sock.send(JSON.stringify(payload));
  setTimeout(() => { if (pending.delete(id)) rej(new Error('timeout ' + method)); }, 60000);
});
sock.onmessage = (ev) => {
  const m = JSON.parse(String(ev.data));
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id)!;
    pending.delete(m.id);
    m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
  } else if (m.method === 'Target.attachedToTarget') session = m.params.sessionId;
};
const targets = await send('Target.getTargets', {}, false);
const page = (targets.targetInfos as any[]).find((t) => t.type === 'page');
session = (await send('Target.attachToTarget', { targetId: page.targetId, flatten: true }, false)).sessionId;
await send('Runtime.enable');
await send('Page.enable');
const evalIn = async <T>(expr: string): Promise<T> => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
  return r.result.value as T;
};
for (let i = 0; i < 100; i++) {
  if (await evalIn<boolean>('!!(window.__accelon26 && window.__accelon26.state)').catch(() => false)) break;
  await Bun.sleep(300);
}
await Bun.sleep(2500);
await evalIn('window.__accelon26.closeAbout()').catch(() => undefined);

const shot = async (name: string) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  const out = resolve(ROOT, 'build', name);
  writeFileSync(out, Buffer.from(r.data, 'base64'));
  console.log('  screenshot → ' + out);
};

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + name + (detail ? '  ' + detail : '')); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
};
const waitFor = async (expr: string, ms = 30000): Promise<boolean> => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await evalIn<boolean>(expr).catch(() => false)) return true;
    await Bun.sleep(150);
  }
  return false;
};

try {
  // 1) 開機自動檢查 → #dbTabs 的紅色 New
  const found = await waitFor(`!!document.getElementById('adbUpBtn')`, 40000);
  const btn = JSON.parse(await evalIn<string>(`JSON.stringify((() => {
    const b = document.getElementById('adbUpBtn');
    return b ? { text: b.textContent, newText: b.querySelector('.adbUpNew')?.textContent,
      inTabs: !!b.closest('#dbTabs'), title: b.title } : null;
  })())`));
  ok('開機後 #dbTabs 出現更新按鈕', found && btn?.inTabs === true, JSON.stringify(btn));
  ok('按鈕上有紅色的 New', btn?.newText === 'New', 'new=' + btn?.newText);
  const st1 = JSON.parse(await evalIn<string>('JSON.stringify(window.__accelon26.adbUpdate())'));
  ok('清單比對到 1 個更新（13j 大小相同、sha256 不同）',
    st1.count === 1 && st1.items?.[0]?.file === '13j.adb',
    JSON.stringify({ count: st1.count, error: st1.error }));

  // 2) 點一下 → 對話盒，看得到更新的內容
  await evalIn(`(document.getElementById('adbUpBtn').click(), 1)`);
  await waitFor(`!document.getElementById('adbUpdateBox').hidden`);
  const dlg = JSON.parse(await evalIn<string>(`JSON.stringify({
    open: !document.getElementById('adbUpdateBox').hidden,
    sub: document.getElementById('adbUpdateSub')?.textContent,
    text: document.getElementById('adbUpdateList')?.textContent,
    versions: document.querySelectorAll('.adbUpVer').length,
    firstNotes: [...document.querySelectorAll('.adbUpVer:first-child .adbUpNotes li')].map((x) => x.textContent),
    changeNotes: [...document.querySelectorAll('.adbUpChanges .adbUpNotes li')].map((x) => x.textContent),
    histVersions: document.querySelectorAll('.adbUpHistList > li').length,
    bars: document.querySelectorAll('.adbUpTrack').length,
  })`));
  ok('點一下跳出更新對話盒', dlg.open === true, dlg.sub);
  ok('只列出「本機版之後」的每一版（2 版）', dlg.versions === 2,
    `${dlg.versions} 版：${JSON.stringify(dlg.changeNotes)}`);
  ok('最新一版的說明完整', dlg.firstNotes?.length === NOTES.length && dlg.firstNotes[0] === NOTES[0],
    JSON.stringify(dlg.firstNotes));
  ok('中間那一版的說明也在（跳版時每一次改變都看得到）',
    dlg.changeNotes.includes('中間版：目錄多了「傳」一層'), JSON.stringify(dlg.changeNotes));
  ok('版本記錄有 4 版（含更舊的原版）', dlg.histVersions === 4 && dlg.text.includes('原版：2006 年光碟'),
    `${dlg.histVersions} 版`);
  ok('狀態列顯示本機版 → 最新版',
    (await evalIn<string>(`document.querySelector('.adbUpRow .adbUpMeta')?.textContent ?? ''`)).includes('本機')
      && (await evalIn<string>(`document.querySelector('.adbUpRow .adbUpMeta')?.textContent ?? ''`)).includes('最新'),
    await evalIn<string>(`document.querySelector('.adbUpRow .adbUpMeta')?.textContent ?? ''`));
  await shot('adb-update-dialog.png');

  // 版本記錄頁籤：不必有新版也能看每一版
  await evalIn(`document.getElementById('adbUpTabHistory').click()`);
  const histTab = JSON.parse(await evalIn<string>(`JSON.stringify({
    tab: window.__accelon26.adbUpdate().tab,
    rows: document.querySelectorAll('.adbUpRow').length,
    versions: document.querySelectorAll('.adbUpHistList > li').length,
    text: document.getElementById('adbUpdateList')?.textContent,
  })`));
  ok('「版本記錄」頁籤列出全部版本', histTab.tab === 'history' && histTab.rows === 1
    && histTab.versions === 4 && histTab.text.includes('原版：2006 年光碟'), JSON.stringify({ tab: histTab.tab, rows: histTab.rows, versions: histTab.versions }));
  await evalIn(`document.getElementById('adbUpTabUpdates').click()`);

  // 3) 更新 → 有進度 → 放棄，原檔不變
  await evalIn(`(document.querySelector('[data-up="13j.adb"]').click(), 1)`);
  ok('開始下載後出現進度條', await waitFor(`(() => {
    const r = document.querySelector('.adbUpRow[data-file="13j.adb"]');
    const b = r && !r.querySelector('.adbUpProg')?.hidden;
    const pct = r?.querySelector('.pct')?.textContent ?? '';
    return !!b && pct !== '0%';
  })()`, 20000));
  await Bun.sleep(500);
  await shot('adb-update-progress.png');
  const mid = JSON.parse(await evalIn<string>('JSON.stringify(window.__accelon26.adbUpdate().items[0])'));
  ok('進度有收到位元組（received > 0）', mid.received > 0 && mid.total === newBytes.length,
    `${(mid.received / 1024).toFixed(0)} / ${(mid.total / 1024).toFixed(0)} KiB`);
  await evalIn(`(document.querySelector('[data-cancel="13j.adb"]').click(), 1)`);
  ok('按放棄後狀態變成 cancelled', await waitFor(`window.__accelon26.adbUpdate().items[0]?.phase === 'cancelled'`, 15000));
  const afterCancel = createHash('sha256').update(readFileSync(OLD)).digest('hex');
  ok('放棄後原檔一個位元組都沒變', afterCancel === localSha, afterCancel.slice(0, 12) + '…');
  ok('放棄後沒有留下暫存檔',
    readdirSync(DIR).every((n) => !n.startsWith('.accelon26-')),
    readdirSync(DIR).join('、'));
  ok('對話盒提示「原本的 adb 沒有更動」',
    (await evalIn<string>(`document.querySelector('.adbUpRow[data-file="13j.adb"]')?.textContent ?? ''`)).includes('沒有更動'));

  // 4) 再按一次（全速）→ 真的換檔並重新載入
  slow = false;
  await evalIn(`(document.querySelector('[data-up="13j.adb"]').click(), 1)`);
  const done = await waitFor(`window.__accelon26.adbUpdate().count === 0`, 60000);
  ok('更新完成（清單上的 New 消失）', done);
  ok('更新後仍保留版本記錄（不是只有 New 才看得到）',
    await evalIn<number>('window.__accelon26.adbUpdate().total') === 1
      && await evalIn<number>('window.__accelon26.adbUpdate().items[0].localIndex') === 0);
  const afterSha = createHash('sha256').update(readFileSync(OLD)).digest('hex');
  ok('檔案已換成新版（sha256 相同）', afterSha === newSha, afterSha.slice(0, 12) + '…');
  const st2 = JSON.parse(await evalIn<string>('JSON.stringify({ db: window.__accelon26.state().db, chip: document.querySelector("#dbTabs .dbChip.active")?.textContent ?? "", status: document.getElementById("adbUpdateStatus")?.textContent })'));
  ok('更新後重新開啟新版（庫名已變）', String(st2.chip).includes('更新版'), JSON.stringify(st2));
  ok('對話盒顯示「已更新」', String(st2.status).includes('已更新'), st2.status);
  ok('更新後只剩一個 dbChip（舊的同檔 slot 已收掉）',
    (await evalIn<number>('document.querySelectorAll("#dbTabs .dbChip").length')) === 1,
    String(await evalIn<number>('document.querySelectorAll("#dbTabs .dbChip").length')));
  const afterBtn = await evalIn<string>('document.getElementById("adbUpBtn")?.textContent ?? ""');
  ok('沒有新版時仍留「資料庫版本」按鈕（可看版本記錄）',
    afterBtn.includes('資料庫版本') && !afterBtn.includes('New'), afterBtn);
  await evalIn('(document.getElementById("adbUpBtn").click(), 1)');
  await Bun.sleep(900);
  await evalIn('document.getElementById("adbUpTabHistory").click()');
  const afterHist = JSON.parse(await evalIn<string>(`JSON.stringify({
    versions: document.querySelectorAll('.adbUpHistList > li').length,
    text: document.getElementById('adbUpdateList')?.textContent,
  })`));
  ok('更新後仍能打開版本記錄（4 版，含最新那版的說明）',
    afterHist.versions === 4 && afterHist.text.includes(NOTES[0]), JSON.stringify({ versions: afterHist.versions }));
  await shot('adb-update-done.png');

  // 5) 更新鏡像：自動探測；切到鏡像／主站時 Go 的更新站要跟著換
  const mir = JSON.parse(await evalIn<string>('JSON.stringify(window.__accelon26.mirror())'));
  ok('鏡像：自動模式有兩站的探測結果（至少一站回應）',
    mir.mode === 'auto' && !!(mir.probe?.primary || mir.probe?.overseas), JSON.stringify(mir));
  await evalIn(`window.__accelon26.setMirrorMode('overseas')`);
  await Bun.sleep(600);
  const usedOverseas = await evalIn<string>(`(async () => {
    const m = await new Function('u', 'return import(u)')('/wails/runtime.js');
    return await m.Call.ByName('main.AdbHost.UpdateMirror');
  })()`);
  ok('選境外鏡像 → Go 的更新站切到 nissaya.cn', usedOverseas === 'https://nissaya.cn/accelon26/', usedOverseas);
  await evalIn(`window.__accelon26.setMirrorMode('primary')`);
  await Bun.sleep(600);
  const usedPrimary = await evalIn<string>(`(async () => {
    const m = await new Function('u', 'return import(u)')('/wails/runtime.js');
    return await m.Call.ByName('main.AdbHost.UpdateMirror');
  })()`);
  ok('選大陸主站 → Go 的更新站切回 shutonggui.cn', usedPrimary === 'https://shutonggui.cn/accelon26/', usedPrimary);
} finally {
  try { await evalIn(`(async () => { const m = await new Function('u', 'return import(u)')('/wails/runtime.js'); await m.Window.Close(); return 1; })()`); } catch { /* ignore */ }
  for (let i = 0; i < 40 && proc.exitCode === null; i++) await Bun.sleep(250);
  try { proc.kill(); } catch { /* already gone */ }
  server.stop(true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
