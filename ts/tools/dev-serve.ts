#!/usr/bin/env bun
/**
 * 開發用伺服器：**每次重新整理都重新建置 HTML**，並自動開上次讀的 adb。
 *
 *   cd ts && bun run tools/dev-serve.ts
 *   cd ts && bun run tools/dev-serve.ts --port 8790 --roots "D:\accelon3;D:\2026\sz\accelon26;D:\2026\ndd"
 *
 * 為什麼要這支（作者 2026-11-03）：
 *   - 改 HTML／CSS／TS 之後不想每次 `build-viewer` 再手動重新整理、再手動選 adb。
 *   - 也不想為了看一頁而 build exe。
 *
 * 它做的事：
 *   1. 每個 GET / 都呼叫 `buildSingleFileHtml()`（約 0.6 秒），所以重新整理就是最新版；
 *      另外在 `</body>` 前注入一段 dev script（見 DEV_SCRIPT）。
 *   2. `GET /adb/<name>.adb`：從 --roots 找檔案，整檔回傳（本機夠快；不實作 Range）。
 *   3. `GET /__adbs`：列出 --roots 裡的 *.adb（給 dev script 的字串陣列）。
 *   4. 不自動重整：改完自己按 **Ctrl+F5**（作者 2026-11-03：SSE 的 bug 比省下的那一秒多）。
 *   5. dev script：把 adb 變成 File 塞進 `#file` input 並觸發 change（與使用者自己選檔同一條路），
 *      所以**閱讀器程式一行都不用改**；讀到一半的位置每 1 秒記在 localStorage，重整後還原。
 */
import { existsSync, readdirSync, statSync, watch } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { buildSingleFileHtml } from './page-build';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const PORT = Number(opt('port', '8790'));
const HOST = opt('host', '127.0.0.1');
const ROOTS = opt('roots', 'D:\\accelon3;D:\\2026\\sz\\accelon26;D:\\2026\\ndd')
  .split(';').map((s) => s.trim()).filter(Boolean).map((s) => resolve(s));

const SRC = resolve(import.meta.dir, '../src');
const TEMPLATE = resolve(SRC, 'accelon26/accelon26.template.html');

const DEV_SCRIPT = `
<script>
(() => {
  const DB_KEY = 'accelon26.dev.db';
  const FILE_KEY = 'accelon26.dev.file';
  const VA_KEY = 'accelon26.dev.va';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const showStatus = (m) => {
    const el = document.getElementById('status');
    if (el) el.textContent = m;
    console.warn('[dev] ' + m);
  };
  const saveNow = () => {
    try {
      const st = window.__accelon26?.state?.() ?? {};
      if (st.db) localStorage.setItem(DB_KEY, st.db);
      const va = st.cursorNode?.va;
      if (typeof va === 'number' && va > 0) localStorage.setItem(VA_KEY, st.db + ':' + va);
    } catch { /* ignore */ }
  };
  const openFromServer = async (name) => {
    const r = await fetch('/adb/' + encodeURIComponent(name) + '.adb');
    if (!r.ok) return false;
    const buf = await r.arrayBuffer();
    const f = new File([buf], name + '.adb', { type: 'application/octet-stream' });
    const input = document.querySelector('#file');
    const dt = new DataTransfer();
    dt.items.add(f);
    input.files = dt.files;
    input.dispatchEvent(new Event('change'));
    return true;
  };
  (async () => {
    for (let i = 0; i < 120; i++) {
      if (window.__accelon26 && document.querySelector('#file')) break;
      await sleep(100);
    }
    if (!window.__accelon26) return;
    // 使用者自己選檔時，把「檔名」也記下來：dbname 和檔名不一定相同（例如 13j.adb 的
    // dbname 是 13j，但有的庫不是），重新整理時兩個都試（2026-11-05）。
    const input = document.querySelector('#file');
    input?.addEventListener('change', () => {
      const f = input.files?.[0];
      if (f) { try { localStorage.setItem(FILE_KEY, f.name.replace(/\\.adb$/i, '')); } catch { /* ignore */ } }
    });
    const q = new URLSearchParams(location.search);
    const tries = [...new Set([q.get('db'), localStorage.getItem(DB_KEY), localStorage.getItem(FILE_KEY)]
      .filter((x) => !!x))];
    let opened = false;
    if (!window.__accelon26.state().db) {
      for (const name of tries) {
        if (await openFromServer(name)) { opened = true; break; }
      }
      for (let i = 0; i < 200 && opened; i++) {
        if (window.__accelon26.state().db) break;
        await sleep(100);
      }
      const saved = localStorage.getItem(VA_KEY) || '';
      const [db, va] = saved.split(':');
      if (db === window.__accelon26.state().db && va) {
        try { window.__accelon26.revealHit(Number(va), ''); } catch { /* ignore */ }
      }
    }
    // 記得的庫不在 dev server 的 --roots 裡：直接說清楚，不要讓畫面空白像壞掉
    if (tries.length && !window.__accelon26.state().db && !opened) {
      const list = await fetch('/__adbs').then((r) => r.json()).catch(() => []);
      showStatus('dev server 找不到「' + tries[0] + '.adb」；請把它的資料夾加進 --roots'
        + '（目前可用的：' + list.map((x) => x.name).slice(0, 20).join('、') + (list.length > 20 ? '…' : '') + '）');
    }
    setInterval(saveNow, 1000);
    window.addEventListener('beforeunload', saveNow);
  })();
})();
</script>
`;

/** --roots 裡的 *.adb（含一層子目錄） */
function listAdbs(): { name: string; label: string; path: string }[] {
  const out: { name: string; label: string; path: string }[] = [];
  for (const root of ROOTS) {
    if (!existsSync(root)) continue;
    const walk = (dir: string, depth: number): void => {
      let ents: string[] = [];
      try { ents = readdirSync(dir); } catch { return; }
      for (const e of ents) {
        const p = join(dir, e);
        let isDir = false;
        try { isDir = statSync(p).isDirectory(); } catch { continue; }
        if (isDir) { if (depth < 1) walk(p, depth + 1); continue; }
        if (extname(e).toLowerCase() !== '.adb') continue;
        const name = e.slice(0, -4);
        out.push({ name, label: root.includes('sz') ? `${name}（sz）` : name, path: p });
      }
    };
    walk(root, 0);
  }
  return out;
}

function findAdb(name: string): string | null {
  const hit = listAdbs().find((a) => a.name === name);
  return hit ? hit.path : null;
}

let revision = 0;
const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
let timer: ReturnType<typeof setTimeout> | null = null;
const bump = (): void => {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    revision++;
    const msg = new TextEncoder().encode('data: reload\n\n');
    for (const c of clients) { try { c.enqueue(msg); } catch { clients.delete(c); } }
    console.log(`[dev] 變更 → 通知 ${clients.size} 個頁面重新整理（rev ${revision}）`);
  }, 250);
};
for (const p of [SRC, TEMPLATE]) {
  try { watch(p, { recursive: true }, bump); } catch { /* 有些平台不支援 recursive */ }
}

let cache: { html: string; at: number } | null = null;
async function htmlNow(): Promise<string> {
  // 2 秒內的重複請求共用同一份（瀏覽器會同時要 favicon 等）
  if (cache && Date.now() - cache.at < 2000) return cache.html;
  const { html } = await buildSingleFileHtml();
  const out = html + DEV_SCRIPT;   // 直接接在 </html> 之後（不要把 </body> 換掉：bundle 內可能也有這個字串）
  cache = { html: out, at: Date.now() };
  return out;
}

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === '/__reload') {
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          clients.add(c);
          c.enqueue(new TextEncoder().encode(': connected\n\n'));
        },
        cancel() { /* 由 enqueue 失敗時清掉 */ },
      });
      return new Response(stream, {
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' },
      });
    }

    if (path === '/__adbs') {
      return Response.json(listAdbs().map(({ name, label, path }) => ({ name, label, path })));
    }

    const adb = /^\/adb\/(.+\.adb)$/.exec(path);
    if (adb) {
      const name = decodeURIComponent(adb[1]).replace(/\.adb$/i, '');
      const file = findAdb(name);
      if (!file) return new Response('adb not found: ' + name, { status: 404 });
      return new Response(Bun.file(file), {
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(statSync(file).size) },
      });
    }

    if (path === '/' || path === '/index.html') {
      const t0 = performance.now();
      const html = await htmlNow();
      const ms = (performance.now() - t0).toFixed(0);
      return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Build-Ms': ms } });
    }

    return new Response('not found: ' + path, { status: 404 });
  },
});

console.log(`dev server  http://${HOST}:${PORT}/  （每次重新整理都重新建置 HTML）`);
console.log('  roots: ' + ROOTS.join('  |  '));
console.log(`  adb:   ${listAdbs().length} 個（GET /__adbs 看清單；?db=<name> 指定要開哪一個）`);
console.log('  改 ts/src 或 template 會自動通知瀏覽器重新整理；位置每 1 秒記住，重整後還原');

export { server };
