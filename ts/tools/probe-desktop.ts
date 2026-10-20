/**
 * 診斷（桌面版）：在真正的 exe + WebView2 上重現「點目錄的書會崩」與「查任何字都內存不足」。
 *
 *   bun run tools/probe-desktop.ts --cwd D:/accelon3 --db taisho --query 佛
 *   bun run tools/probe-desktop.ts --cwd D:/accelon3 --db taisho --click 史傳部|史傳部三|古清涼傳
 *
 * 除了 V8 堆（CDP），每一步之後也量 msedgewebview2 全部子行程的 WorkingSet 總和——
 * 「內存不足」是行程層級的事，只看 JS 堆會漏掉 ArrayBuffer／字串外部記憶體。
 */
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const EXE = resolve(opt('exe', 'D:/accelon3/accelon26.exe'));
const CWD = resolve(opt('cwd', 'D:/accelon3'));
const DB = opt('db', 'taisho');
const CLICKS = opt('click', '').split('|').filter(Boolean);
const QUERY = opt('query', '');
const PORT = Number(opt('port', String(9300 + Math.floor(Math.random() * 90))));
const STATE_DIR = resolve(import.meta.dir, '../../build/tmp-probe-desktop');

const events: { t: number; kind: string; detail: string }[] = [];
const t0 = Date.now();

function webviewWorkingsetMB(): number {
  const ps = Bun.spawnSync({
    cmd: ['powershell', '-NoProfile', '-Command',
      "$root = " + proc.pid + "; " +
      "$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize; " +
      "$set = New-Object System.Collections.Generic.HashSet[int]; [void]$set.Add($root); " +
      "do { $n = 0; foreach ($p in $all) { if ($set.Contains([int]$p.ParentProcessId) -and -not $set.Contains([int]$p.ProcessId)) { [void]$set.Add([int]$p.ProcessId); $n++ } } } while ($n -gt 0); " +
      "$sum = 0; foreach ($p in $all) { if ($set.Contains([int]$p.ProcessId)) { $sum += $p.WorkingSetSize } }; $sum"],
    stdout: 'pipe', stderr: 'ignore',
  });
  const v = Number(new TextDecoder().decode(ps.stdout).trim());
  return Number.isFinite(v) ? Math.round(v / 1048576) : 0;
}

await import('node:fs/promises').then((fs) => fs.rm(STATE_DIR, { recursive: true, force: true })).catch(() => undefined);
const proc = Bun.spawn([EXE], {
  cwd: CWD,
  env: {
    ...process.env,
    ACCELON26_DEBUG_PORT: String(PORT),
    ACCELON26_STATE_DIR: STATE_DIR,
    ACCELON26_WEBVIEW_DIR: resolve(STATE_DIR, 'webview'),
  } as Record<string, string>,
  stdout: 'pipe', stderr: 'pipe',
});

let wsurl = '';
{
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && !wsurl) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      wsurl = ((await r.json()) as { webSocketDebuggerUrl?: string }).webSocketDebuggerUrl ?? '';
    } catch { /* not up yet */ }
    if (!wsurl) await Bun.sleep(300);
  }
}
if (!wsurl) { proc.kill(); throw new Error('no WebView2 devtools endpoint on ' + PORT); }

let sock: WebSocket;
await new Promise<void>((res, rej) => { sock = new WebSocket(wsurl); sock.onopen = () => res(); sock.onerror = () => rej(new Error('ws')); });
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
let id = 0, session = '', dead = false;
const send = (method: string, params: any = {}, withSession = true): Promise<any> => new Promise((res, rej) => {
  if (dead) return rej(new Error('renderer dead'));
  const myId = ++id;
  const payload: any = { id: myId, method, params };
  if (withSession && session) payload.sessionId = session;
  pending.set(myId, { resolve: res, reject: rej });
  sock.send(JSON.stringify(payload));
  setTimeout(() => { if (pending.delete(myId)) rej(new Error('timeout ' + method)); }, 120000);
});
sock.onmessage = (ev) => {
  const m = JSON.parse(String(ev.data));
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id)!; pending.delete(m.id);
    m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    return;
  }
  if (m.method === 'Target.attachedToTarget') session = m.params.sessionId;
  if (m.method === 'Inspector.targetCrashed' || m.method === 'Target.targetCrashed') { dead = true; events.push({ t: Date.now() - t0, kind: 'targetCrashed', detail: JSON.stringify(m.params ?? {}) }); }
  if (m.method === 'Inspector.detached') { dead = true; events.push({ t: Date.now() - t0, kind: 'detached', detail: String(m.params?.reason) }); }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    events.push({ t: Date.now() - t0, kind: 'exception', detail: (d?.exception?.description ?? d?.text ?? '?').slice(0, 400) });
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    events.push({ t: Date.now() - t0, kind: 'console.error', detail: String(m.params.args?.[0]?.value ?? m.params.args?.[0]?.description ?? '').slice(0, 300) });
  }
};
const targets = await send('Target.getTargets', {}, false);
const page = (targets.targetInfos as any[]).find((t) => t.type === 'page');
const attached = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true }, false);
session = attached.sessionId;
await send('Runtime.enable');
await send('Inspector.enable');

const evalIn = async <T>(expr: string): Promise<T> => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
  return r.result.value as T;
};
for (let i = 0; i < 100; i++) {
  if (await evalIn<boolean>('!!(window.__accelon26 && window.__accelon26.state)').catch(() => false)) break;
  await Bun.sleep(300);
}

const mb = (n: number) => Math.round(n / 1048576);
async function heap(): Promise<number> {
  const h = await send('Runtime.getHeapUsage');
  return h.usedSize as number;
}
async function sampleWhile<T>(fn: () => Promise<T>): Promise<{ peakUsed: number; peakWs: number; result?: T; error?: string }> {
  let peakUsed = 0, peakWs = 0, done = false;
  const sampler = (async () => {
    while (!done) {
      try { peakUsed = Math.max(peakUsed, await heap()); } catch { break; }
      peakWs = Math.max(peakWs, webviewWorkingsetMB());
      await Bun.sleep(300);
    }
  })();
  try {
    const result = await fn();
    done = true; await sampler;
    return { peakUsed, peakWs, result };
  } catch (e) {
    done = true; await sampler;
    return { peakUsed, peakWs, error: e instanceof Error ? e.message : String(e) };
  }
}

const out: Record<string, unknown> = { exe: EXE, cwd: CWD, wsStartMB: webviewWorkingsetMB() };
try {
  const open = await sampleWhile(() => evalIn<string>(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    // 等資料夾清單建好，找 taisho 那一項點下去
    document.getElementById('dbPickBtn').click();
    await sleep(400);
    const items = [...document.querySelectorAll('#dbPickMenu .dbPickItem[data-key]')];
    const names = items.map((i) => i.querySelector('.dbPickName')?.textContent ?? '');
    const item = items.find((i) => (i.querySelector('.dbPickName')?.textContent ?? '').includes(${JSON.stringify(DB)}));
    if (!item) return JSON.stringify({ names, picked: null });
    const picked = item.querySelector('.dbPickName')?.textContent ?? '';
    item.click();
    for (let i = 0; i < 900; i++) {
      await sleep(200);
      const p = window.__accelon26.state().treePhases ?? {};
      if (p.instances !== undefined || p.skipped !== undefined) break;
    }
    await sleep(600);
    const s = window.__accelon26.state();
    return JSON.stringify({ names, picked, db: s.db, tiers: s.dirInfo?.tiers, nodes: s.dirInfo?.nodes,
      rows: s.dirRows, backend: s.backend, variants: s.variants, textCache: s.textCache });
  })()`));
  out.open = { ...open, peakUsedMB: mb(open.peakUsed), peakWsMB: open.peakWs, result: open.result ? JSON.parse(open.result as unknown as string) : null };

  if (CLICKS.length) {
    const click = await sampleWhile(() => evalIn<string>(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const rows = () => [...document.querySelectorAll('#dirTree .tRow')];
      const nameOf = (r) => (r.querySelector('.tName')?.textContent ?? '').trim();
      const out = [];
      for (const name of ${JSON.stringify(CLICKS)}) {
        await window.__accelon26.growTree();
        const row = rows().find((r) => nameOf(r) === name) || rows().find((r) => nameOf(r).startsWith(name));
        if (!row) { out.push({ name, found: false }); continue; }
        const before = window.__accelon26.state();
        (row.querySelector('.tName') ?? row).click();
        await sleep(1200);
        const s = window.__accelon26.state();
        out.push({ name, found: true, docRealm: s.docRealm, docPageLines: s.docPageLines,
          docRows: s.docRows, marks: s.marks, textCache: s.textCache,
          status: document.getElementById('status')?.textContent?.slice(0, 120),
          linkMs: s.lastLink?.totalMs, beforeRows: before.docRows });
      }
      return JSON.stringify(out);
    })()`));
    out.click = { ...click, peakUsedMB: mb(click.peakUsed), peakWsMB: click.peakWs, result: click.result ? JSON.parse(click.result as unknown as string) : null };
  }

  if (QUERY) {
    const search = await sampleWhile(() => evalIn<string>(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const q = document.getElementById('query');
      q.value = ${JSON.stringify(QUERY)};
      q.dispatchEvent(new Event('input'));
      for (let i = 0; i < 300; i++) {
        await sleep(200);
        if (window.__accelon26.state().searchQuery === ${JSON.stringify(QUERY)}) break;
      }
      const s = window.__accelon26.state();
      return JSON.stringify({ q: s.searchQuery, multi: s.multi, backend: s.backend, goQueries: s.goQueries,
        listRows: document.querySelectorAll('#searchList .snippet').length,
        meta: document.getElementById('searchMeta')?.textContent?.slice(0, 200) });
    })()`));
    out.search = { ...search, peakUsedMB: mb(search.peakUsed), peakWsMB: search.peakWs, result: search.result ? JSON.parse(search.result as unknown as string) : null };
  }

  out.dead = dead;
  out.wsEndMB = webviewWorkingsetMB();
  out.events = events.slice(-20);
  console.log(JSON.stringify(out, null, 2));
} finally {
  try { proc.kill(); } catch { /* gone */ }
  await Bun.sleep(800);
  process.exit(0);
}
