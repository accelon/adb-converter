/**
 * 取得更多 ADB（作者 2026-10-29）。
 *
 * 桌面版在 📁 下拉多一個「取得更多 ADB」：先由 mirror.ts 探測主站／鏡像
 * （Go 的 HEAD，和 exe／manifest 用同一套），再讀官網的 `adb/manifest.json`，
 * 列出公開資料庫。下載走 Go 的 StartNewAdbDownload，直接寫到執行檔旁邊，
 * 完成後 refreshHostDbs() 重刷 📁 清單，使用者不必開瀏覽器。
 *
 * 網頁版沒有宿主，這個入口不顯示。
 */
import { $, escapeHtml, fmtBytes } from './viewer';
import {
  catalog, refreshHostDbs, setAdbStoreHandler, setDbPickOpen,
} from './dbs';
import {
  desktopAdbDownloadStatus, desktopFetchText,
  desktopSetUpdateMirror, desktopStartNewAdbDownload,
} from './host';
import {
  currentMirrorBase, ensureMirrorReady, mirrorForBase, mirrorMode, MIRRORS,
} from './mirror';

interface StoreRow {
  file: string;
  name: string;
  size: number;
  sha256: string;
  date: string;
  notes: string[];
  installed: boolean;
  phase: 'idle' | 'downloading' | 'done' | 'error';
  received: number;
  total: number;
  error?: string;
  id?: string;
}

let open = false;
let loading = false;
let error = '';
let source = '';
let manifestBase = '';
let rows: StoreRow[] = [];

const baseName = (p: string): string => p.split(/[\\/]/).pop() ?? p;
const installedFiles = (): Set<string> =>
  new Set(catalog.filter((e) => !!e.file.path).map((e) => baseName(e.file.path!).toLowerCase()));

function fmtDate(iso?: string): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const d = new Date(t);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function render(): void {
  const list = $('#adbStoreList');
  const sub = $('#adbStoreSub');
  const status = $('#adbStoreStatus');
  if (!list) return;
  if (sub) {
    sub.textContent = loading ? '正在讀取清單…'
      : error ? error
        : `來源：${source || '官網'} · ${rows.length} 個資料庫`;
  }
  if (loading) {
    list.innerHTML = '<p class="dim">正在探測鏡像並讀取清單…</p>';
    if (status) status.textContent = '';
    return;
  }
  if (error) {
    list.innerHTML = `<p class="dim">${escapeHtml(error)}</p>`;
    if (status) status.textContent = '';
    return;
  }
  if (!rows.length) {
    list.innerHTML = '<p class="dim">清單裡沒有資料庫。</p>';
    if (status) status.textContent = '';
    return;
  }
  list.innerHTML = '<table class="dbPickTable adbStoreTable"><thead><tr>'
    + '<th>資料庫</th><th>檔案</th><th>大小</th><th>版本</th><th>狀態</th>'
    + '</tr></thead><tbody>'
    + rows.map((r) => {
      const pct = r.total > 0 ? Math.min(100, Math.round((r.received / r.total) * 100)) : 0;
      let action = '';
      if (r.installed) action = '<span class="adbStoreInstalled">已安裝</span>';
      else if (r.phase === 'downloading') action = `<span class="adbStorePct">${pct}%</span>`;
      else if (r.phase === 'done') action = '<span class="adbStoreInstalled">已下載</span>';
      else action = `<button type="button" class="mini primary" data-dl="${escapeHtml(r.file)}">下載</button>`;
      const note = r.phase === 'downloading'
        ? `<div class="adbStoreProg"><i style="width:${pct}%"></i></div>`
        : r.phase === 'error' ? `<div class="adbStoreErr">${escapeHtml(r.error ?? '下載失敗')}</div>`
          : r.notes.length ? `<div class="adbStoreNote">${escapeHtml(r.notes[0])}</div>` : '';
      return `<tr class="adbStoreRow" data-file="${escapeHtml(r.file)}">`
        + `<td><b>${escapeHtml(r.name)}</b>${note}</td>`
        + `<td class="adbStoreFile">${escapeHtml(r.file)}</td>`
        + `<td class="adbStoreSize">${fmtBytes(r.size)}</td>`
        + `<td class="adbStoreDate">${escapeHtml(fmtDate(r.date))}</td>`
        + `<td class="adbStoreAct">${action}</td></tr>`;
    }).join('')
    + '</tbody></table>';
  list.querySelectorAll<HTMLElement>('button[data-dl]').forEach((b) => {
    b.onclick = (ev) => {
      ev.stopPropagation();
      const row = rows.find((r) => r.file === b.dataset.dl);
      if (row) void download(row);
    };
  });
  if (status) {
    const done = rows.filter((r) => r.installed || r.phase === 'done').length;
    status.textContent = `已安裝或已下載 ${done}／${rows.length}`;
  }
}

async function load(): Promise<void> {
  loading = true;
  error = '';
  rows = [];
  render();
  try {
    await ensureMirrorReady();
    // 直接量「公開資料庫清單」而不是只量網站首頁：按下去才決定這次要從哪個鏡像抓。
    const bases = mirrorMode() === 'auto'
      ? [MIRRORS.primary.base, MIRRORS.overseas.base]
      : [currentMirrorBase()];
    const probes = await Promise.all(bases.map(async (base) => {
      const t0 = performance.now();
      try {
        const body = await desktopFetchText(base + 'adb/manifest.json?probe=' + Date.now());
        return { base, text: body, ms: body ? performance.now() - t0 : Infinity };
      } catch {
        return { base, text: '', ms: Infinity };
      }
    }));
    const best = probes.filter((p) => !!p.text).sort((a, b) => a.ms - b.ms)[0];
    if (!best) {
      error = '連不上官網的公開資料庫清單（主站與鏡像都失敗）。';
      return;
    }
    manifestBase = best.base;
    source = mirrorForBase(best.base).label;
    let text = best.text;
    if (mirrorMode() === 'auto') {
      try { await desktopSetUpdateMirror(best.base); } catch { /* 仍用剛抓到的清單 */ }
    }
    let m: { dbs?: Array<Record<string, unknown>> };
    try {
      m = JSON.parse(text) as typeof m;
    } catch {
      error = 'manifest.json 格式不對。';
      return;
    }
    const installed = installedFiles();
    rows = (m.dbs ?? []).filter((d) => typeof d?.file === 'string' && d.file).map((d) => {
      const file = String(d.file);
      const size = Number(d.size) || 0;
      const notes = Array.isArray(d.notes) ? d.notes.map(String) : [];
      return {
        file,
        name: String(d.name || file.replace(/\.adb$/i, '')),
        size,
        sha256: String(d.sha256 || ''),
        date: String(d.buildTime || d.date || ''),
        notes,
        installed: installed.has(file.toLowerCase()),
        phase: 'idle' as const,
        received: 0,
        total: size,
      };
    });
  } catch (e) {
    error = '讀取失敗：' + String((e as Error)?.message ?? e);
  } finally {
    loading = false;
    render();
  }
}

async function poll(row: StoreRow): Promise<void> {
  if (!row.id) return;
  const st = await desktopAdbDownloadStatus(row.id);
  if (!st) {
    row.phase = 'error';
    row.error = '讀不到下載狀態（桌面宿主沒有回應）';
    render();
    return;
  }
  row.received = st.received || 0;
  row.total = st.total || row.total;
  if (st.state === 'running') {
    render();
    setTimeout(() => { void poll(row); }, 150);
    return;
  }
  if (st.state === 'done') {
    row.phase = 'done';
    row.received = row.total;
    row.installed = true;
    render();
    await refreshHostDbs();
    return;
  }
  if (st.state === 'cancelled') {
    row.phase = 'idle';
    row.received = 0;
    render();
    return;
  }
  row.phase = 'error';
  row.error = st.error || '下載失敗';
  render();
}

async function download(row: StoreRow): Promise<void> {
  if (row.phase === 'downloading') return;
  row.phase = 'downloading';
  row.received = 0;
  row.error = '';
  render();
  try {
    const url = manifestBase + 'adb/' + encodeURIComponent(row.file);
    const id = await desktopStartNewAdbDownload(url, row.file, row.sha256, row.size);
    if (!id) throw new Error('桌面宿主沒有開始下載');
    row.id = id;
    void poll(row);
  } catch (e) {
    row.phase = 'error';
    row.error = String((e as Error)?.message ?? e);
    render();
  }
}

export function openAdbStore(): void {
  open = true;
  const back = $('#adbStoreBackdrop');
  const box = $('#adbStoreBox');
  if (back) back.hidden = false;
  if (box) box.hidden = false;
  setDbPickOpen(false);
  void load();
}

export function closeAdbStore(): void {
  open = false;
  const back = $('#adbStoreBackdrop');
  const box = $('#adbStoreBox');
  if (back) back.hidden = true;
  if (box) box.hidden = true;
}

export function initAdbStore(): void {
  setAdbStoreHandler(openAdbStore);
  $('#adbStoreClose')?.addEventListener('click', closeAdbStore);
  $('#adbStoreBackdrop')?.addEventListener('click', closeAdbStore);
  $('#adbStoreRefresh')?.addEventListener('click', () => { if (!loading) void load(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && open && !$('#adbStoreBox')?.hidden) {
      e.preventDefault();
      closeAdbStore();
    }
  });
}
