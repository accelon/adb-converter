/**
 * 鏡像站切換的桌面版驗證（作者 2026-10-29）。
 *
 *   # 先建一顆「比線上舊」的 exe（這樣才會真的檢查更新；建置時間要超過 2 小時前）
 *   cd wails && go build -ldflags "-X main.buildTime=2026-10-28T00:00:00Z -H windowsgui" \
 *     -o ../build/mirrortest/accelon26.exe .
 *   cd ts && bun run tools/mirror-test.ts
 *
 * 驗：自動探測 → 切鏡像 → exe 更新網址與 adb manifest 都指到 nissaya.cn →
 * 切回主站 → 兩者都回到 shutonggui.cn。
 */
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../..');
const EXE = resolve(ROOT, 'build/mirrortest/accelon26.exe');
const DIR = resolve(ROOT, 'build/mirrortest');
const STATE = resolve(ROOT, 'build/tmp-mirror-test');
const PORT = 9559;
const PRIMARY = 'https://shutonggui.cn/accelon26/';
const OVERSEAS = 'https://nissaya.cn/accelon26/';

mkdirSync(DIR, { recursive: true });
rmSync(STATE, { recursive: true, force: true });
// 上一次測試可能把 updateMirror 寫進 exe 旁的 settings.json：測試一律從「自動」開始。
rmSync(resolve(DIR, 'settings.json'), { force: true });

const proc = Bun.spawn([EXE], {
  cwd: DIR,
  env: {
    ...process.env,
    ACCELON26_DEBUG_PORT: String(PORT),
    ACCELON26_STATE_DIR: STATE,
    ACCELON26_WEBVIEW_DIR: resolve(STATE, 'webview'),
  } as Record<string, string>,
  stdout: 'pipe', stderr: 'pipe',
});

let wsurl = '';
for (const until = Date.now() + 30000; Date.now() < until && !wsurl;) {
  try { wsurl = ((await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()) as { webSocketDebuggerUrl?: string }).webSocketDebuggerUrl ?? ''; } catch { /* not yet */ }
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
const evalIn = async <T>(expr: string): Promise<T> => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
  return r.result.value as T;
};
for (let i = 0; i < 100; i++) {
  if (await evalIn<boolean>('!!(window.__accelon26 && window.__accelon26.state)').catch(() => false)) break;
  await Bun.sleep(300);
}
await Bun.sleep(1500);

const call = async <T = any>(method: string, ...args: unknown[]): Promise<T> => {
  const raw = await evalIn<string>(`(async () => {
    const m = await new Function('u', 'return import(u)')('/wails/runtime.js');
    return JSON.stringify(await m.Call.ByName(${JSON.stringify(method)}, ...${JSON.stringify(args)}) ?? null);
  })()`);
  return JSON.parse(raw) as T;
};

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + name + (detail ? '  ' + detail : '')); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
};

try {
  let mir: any = null;
  for (let i = 0; i < 40; i++) {
    mir = JSON.parse(await evalIn<string>('JSON.stringify(window.__accelon26.mirror())'));
    if (!mir.probing) break;
    await Bun.sleep(300);
  }
  ok('自動模式有兩站探測結果（至少一站回應）', mir.mode === 'auto' && !!(mir.probe?.primary || mir.probe?.overseas),
    JSON.stringify(mir));

  await evalIn(`window.__accelon26.setMirrorMode('overseas')`);
  await Bun.sleep(1200);
  const ov = await call<any>('main.AdbHost.CheckUpdate');
  ok('切到鏡像：exe 更新用 nissaya.cn', ov.checkOK && String(ov.updateURL).startsWith(OVERSEAS),
    `updateURL=${ov.updateURL}`);
  ok('切到鏡像：實際回應的站也是 nissaya.cn', ov.mirrorUsed === OVERSEAS && ov.mirrorFallback === false,
    `used=${ov.mirrorUsed} fallback=${ov.mirrorFallback}`);
  ok('切到鏡像：線上版本時間讀得到',
    ov.checkOK && /^2026-/.test(String(ov.remoteBuildTime)), String(ov.remoteBuildTime));

  await evalIn('window.__accelon26.checkAdbUpdates()');
  await Bun.sleep(1200);
  const adbOv = JSON.parse(await evalIn<string>('JSON.stringify(window.__accelon26.adbUpdate())'));
  ok('切到鏡像：adb manifest 也在 nissaya.cn',
    String(adbOv.manifestUrl) === OVERSEAS + 'adb/manifest.json' && !adbOv.error,
    String(adbOv.manifestUrl));

  await evalIn(`window.__accelon26.setMirrorMode('primary')`);
  await Bun.sleep(1200);
  const pr = await call<any>('main.AdbHost.CheckUpdate');
  ok('切回主站：exe 更新用 shutonggui.cn', pr.checkOK && String(pr.updateURL).startsWith(PRIMARY),
    `updateURL=${pr.updateURL}`);
  ok('切回主站：實際回應的站也是 shutonggui.cn', pr.mirrorUsed === PRIMARY, `used=${pr.mirrorUsed}`);

  await evalIn('window.__accelon26.checkAdbUpdates()');
  await Bun.sleep(1200);
  const adbPr = JSON.parse(await evalIn<string>('JSON.stringify(window.__accelon26.adbUpdate())'));
  ok('切回主站：adb manifest 也在 shutonggui.cn',
    String(adbPr.manifestUrl) === PRIMARY + 'adb/manifest.json' && !adbPr.error,
    String(adbPr.manifestUrl));

  const ui = JSON.parse(await evalIn<string>(`JSON.stringify((() => {
    window.__accelon26.openSettings();
    const sel = document.getElementById('setMirror');
    return {
      options: sel ? [...sel.options].map((o) => o.textContent) : [],
      value: sel ? sel.value : '',
      status: document.getElementById('setMirrorStatus')?.textContent ?? '',
    };
  })())`));
  ok('設定頁有「更新 → 鏡像站」三個選項與目前狀態',
    ui.options?.length === 3 && ui.options.some((x: string) => x.includes('nissaya.cn')) && !!ui.status,
    JSON.stringify(ui));
} finally {
  try {
    await evalIn(`(async () => { const m = await new Function('u', 'return import(u)')('/wails/runtime.js'); await m.Window.Close(); return 1; })()`);
  } catch { /* already closed */ }
  for (let i = 0; i < 40 && proc.exitCode === null; i++) await Bun.sleep(250);
  try { proc.kill(); } catch { /* gone */ }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
