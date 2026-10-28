/**
 * 右欄「引紋」頁籤：把反鏈的引用分布畫成熱圖（2026-10-28）。
 *
 * 這一頁不需要先開跨庫頁面：只要同時開著「來源庫」（有 `<聯>` 的 ys/tx/lc/yulinpo）
 * 和「目標庫」（大正藏），按右欄「引紋」就看到。
 *
 *  - 列：目標庫的「部（冊）／經（書）／卷」，按自然次序
 *  - 欄：來源庫的「書」，按自然次序
 *  - 格子：`<聯>` 條數；可切計數／列%／欄%
 *  - 左上角與第一列、第一欄 sticky（lock 部名、書名）
 *  - 上面另有一個 github commit 式的純色縮圖
 */
import { reader } from './viewer';
import { reverseHeat, reverseHeatRangeItems, reverseHeatSources, reverseHosts, type HeatGrain, type RevHeatData, type RevItem } from './xref';
import { openRevListItems, revRowHtml } from './rev-list';

type HeatNorm = 'count' | 'row' | 'col';
const HOST_KEY = 'accelon26.heat.host';
const SRC_KEY = 'accelon26.heat.src';
const GRAIN_KEY = 'accelon26.heat.grain';
const NORM_KEY = 'accelon26.heat.norm';

let hostDb = '';
let srcDb = '';
let grain: HeatGrain = 'volume';
let norm: HeatNorm = 'count';
let inited = false;
let rendering = false;
let lastData: RevHeatData | null = null;

const $id = <T extends HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function shortLabel(s: string, n: number): string {
  const t = s.replace(/[（(].*$/, '').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

function loadPrefs(): void {
  try {
    const g = localStorage.getItem(GRAIN_KEY) as HeatGrain | null;
    if (g === 'volume' || g === 'sutra' || g === 'juan') grain = g;
    const n = localStorage.getItem(NORM_KEY) as HeatNorm | null;
    if (n === 'count' || n === 'row' || n === 'col') norm = n;
    hostDb = localStorage.getItem(HOST_KEY) ?? '';
    srcDb = localStorage.getItem(SRC_KEY) ?? '';
  } catch { /* localStorage 可能被禁用 */ }
}
function savePrefs(): void {
  try {
    localStorage.setItem(HOST_KEY, hostDb);
    localStorage.setItem(SRC_KEY, srcDb);
    localStorage.setItem(GRAIN_KEY, grain);
    localStorage.setItem(NORM_KEY, norm);
  } catch { /* ignore */ }
}

async function activeHeatHint(): Promise<void> {
  const body = $id('heatBody');
  if (body) body.innerHTML = '<p class="dim">目前沒有可用的 <聯>。先開啟一個有連結的庫（ys、tx、lc、yulinpo）與目標庫（例如 taisho）。</p>';
}

/** 依比例回傳顏色；v=0 不畫 */
function colorOf(v: number, max: number): string {
  if (!v) return '';
  const a = 0.10 + 0.90 * Math.sqrt(Math.max(0, v) / Math.max(1, max));
  return 'background:rgba(198,84,54,' + a.toFixed(3) + ');color:' + (a > 0.55 ? '#fff' : 'var(--fg)');
}

function valueOf(data: RevHeatData, n: number, ri: number, ci: number): number {
  if (norm === 'row') return data.rows[ri].total ? (n / data.rows[ri].total) * 100 : 0;
  if (norm === 'col') return data.cols[ci].total ? (n / data.cols[ci].total) * 100 : 0;
  return n;
}

function textOf(v: number): string {
  if (!v) return '';
  if (norm === 'count') return String(Math.round(v));
  if (v < 1) return '<1%';
  return (v >= 10 ? Math.round(v) : Math.round(v * 10) / 10) + '%';
}

function gridHtml(data: RevHeatData, mini: boolean): string {
  if (mini) return miniGridHtml(data);
  const rowW = data.grain === 'juan' ? 220 : data.grain === 'volume' ? 170 : 180;
  const colW = 30;
  const vals: number[] = [];
  data.cells.forEach((row, ri) => row.forEach((n, ci) => vals.push(valueOf(data, n, ri, ci))));
  const max = Math.max(1, ...vals);
  const tmpl = rowW + 'px repeat(' + data.cols.length + ',' + colW + 'px) 56px';
  let html = '<div class="heatGrid" style="grid-template-columns:' + tmpl + '">';
  html += '<div class="hgCorner">' + esc(data.rowTag) + ' ＼ ' + esc(data.colTag) + '</div>';
  for (const c of data.cols) {
    html += '<div class="hgCol" title="' + esc(c.label) + '（' + c.total + ' 條）">' + esc(shortLabel(c.label, 4)) + '</div>';
  }
  html += '<div class="hgCorner hgCornerTot"></div>';
  data.rows.forEach((r, ri) => {
    html += '<div class="hgRow" title="' + esc(r.label) + '">' + esc(shortLabel(r.label, 14)) + '</div>';
    data.cells[ri].forEach((n, ci) => {
      const v = valueOf(data, n, ri, ci);
      const title = esc(r.label) + ' × ' + esc(data.cols[ci].label) + '：' + n + ' 條';
      html += '<div class="hgCell" style="' + colorOf(v, max) + '" title="' + title + '" data-hr="' + ri + '" data-hc="' + ci + '">' + textOf(v) + '</div>';
    });
    html += '<div class="hgTot">' + r.total + '</div>';
  });
  html += '</div>';
  return html;
}

/**
 * 縮圖：把列／欄各自合併到最多 60×64 格，只留顏色、不寫數字。
 * 像 github commit 地圖，一眼看整體形狀，不試圖承載精確數字。
 */
function miniGridHtml(data: RevHeatData): string {
  const maxRows = 60, maxCols = 64;
  const rs = Math.max(1, Math.ceil(data.rows.length / maxRows));
  const cs = Math.max(1, Math.ceil(data.cols.length / maxCols));
  const nr = Math.ceil(data.rows.length / rs), nc = Math.ceil(data.cols.length / cs);
  const cells: number[][] = Array.from({ length: nr }, () => new Array(nc).fill(0));
  for (let r = 0; r < data.rows.length; r++) {
    for (let c = 0; c < data.cols.length; c++) {
      const n = data.cells[r][c];
      if (n) cells[Math.floor(r / rs)][Math.floor(c / cs)] += n;
    }
  }
  const max = Math.max(1, ...cells.flat());
  let html = '<div class="heatGrid heatMini" style="grid-template-columns:repeat(' + nc + ',7px)">';
  cells.forEach((row, ri) => {
    row.forEach((n, ci) => {
      const r0 = ri * rs, r1 = Math.min(data.rows.length, r0 + rs);
      const c0 = ci * cs, c1 = Math.min(data.cols.length, c0 + cs);
      const label = (rs > 1 ? '列 ' + (r0 + 1) + '–' + r1 : (data.rows[r0]?.label ?? ''))
        + ' × ' + (cs > 1 ? '欄 ' + (c0 + 1) + '–' + c1 : (data.cols[c0]?.label ?? ''));
      html += '<div class="hgCell" data-mr0="' + r0 + '" data-mr1="' + r1 + '" data-mc0="' + c0 + '" data-mc1="' + c1 + '" style="' + colorOf(n, max) + '" title="' + esc(label) + '：' + n + ' 條"></div>';
    });
  });
  html += '</div>';
  return html;
}

function syncControls(data: RevHeatData, hosts: { db: string; name: string }[], sources: { db: string; name: string }[]): void {
  const hs = $id<HTMLSelectElement>('heatHost');
  const ss = $id<HTMLSelectElement>('heatSource');
  if (hs) {
    hs.innerHTML = hosts.map((h) => '<option value="' + esc(h.db) + '">' + esc(h.name) + '</option>').join('');
    hs.value = data.hostDb;
  }
  if (ss) {
    ss.innerHTML = sources.map((s) => '<option value="' + esc(s.db) + '">' + esc(s.name) + '</option>').join('');
    ss.value = data.srcDb;
  }
  document.querySelectorAll<HTMLElement>('#heatGrain [data-grain]').forEach((b) => b.classList.toggle('active', b.dataset.grain === grain));
  document.querySelectorAll<HTMLElement>('#heatNorm [data-norm]').forEach((b) => b.classList.toggle('active', b.dataset.norm === norm));
  const help = $id('heatHelp');
  if (help) {
    help.textContent = norm === 'row'
      ? '列佔比：每一列加總 100% ── 看這部大正部／經／卷的引用，來自哪些來源書。'
      : norm === 'col'
        ? '欄佔比：每一欄加總 100% ── 看這部來源書的引用，分佈在大正哪些部／經／卷。'
        : '格內數字＝<聯> 條數；列＝大正部／經／卷，欄＝來源書。按縮圖上的小點展開明細。';
  }
}

/** 縮圖點開後的明細：標題＋前 80 筆反鏈；「完整清單」再開抽屜。 */
function paintHeatDetail(title: string, items: RevItem[]): void {
  const box = $id('heatDetail');
  if (!box) return;
  if (!items.length) {
    box.innerHTML = '<p class="dim">這一格沒有反鏈。</p>';
    return;
  }
  const shown = items.slice(0, 80);
  box.innerHTML = '<div class="heatDetailHead"><b>' + esc(title) + '</b><span class="dim">' + items.length + ' 筆</span>'
    + '<button type="button" class="mini" id="heatDetailAll">完整清單</button></div>'
    + '<div class="heatDetailList">' + shown.map(revRowHtml).join('') + '</div>'
    + (items.length > shown.length ? '<p class="dim heatDetailMore">只顯示前 ' + shown.length + ' 筆，完整清單見上方按鈕。</p>' : '');
  $id('heatDetailAll')?.addEventListener('click', () => openRevListItems(title, items));
}

/** 畫「引紋」頁籤；由 showTab('heat','right') 或 DB 事件呼叫。 */
export async function renderHeatTab(): Promise<void> {
  const body = $id('heatBody');
  if (!body || rendering) return;
  rendering = true;
  try {
    const hosts = await reverseHosts();
    if (!hosts.length) { await activeHeatHint(); return; }
    const current = reader?.header.dbname ?? '';
    if (!hostDb || !hosts.some((h) => h.db === hostDb)) {
      hostDb = hosts.some((h) => h.db === 'taisho') ? 'taisho' : hosts.some((h) => h.db === current) ? current : hosts[0].db;
    }
    const sources = await reverseHeatSources(hostDb);
    if (!sources.length) { await activeHeatHint(); return; }
    if (!srcDb || !sources.some((s) => s.db === srcDb)) srcDb = sources[0].db;
    const data = await reverseHeat(hostDb, srcDb, grain);
    if (!data) { await activeHeatHint(); return; }
    lastData = data;
    syncControls(data, hosts, sources);
    const stats = $id('heatStats');
    if (stats) {
      stats.textContent = '共 ' + data.total.toLocaleString() + ' 條 · 來源頁 ' + data.srcPages.toLocaleString()
        + ' · 目標頁 ' + data.hostPages.toLocaleString() + ' · ' + data.rows.length + ' 列 × ' + data.cols.length + ' 欄';
    }
    body.innerHTML = '<div class="heatMiniWrap"><div class="heatMiniHead"><b>縮圖</b><span class="dim">點一個點展開；顏色越深＝引用越多</span></div>'
      + '<div class="heatMiniScroll">' + gridHtml(data, true) + '</div></div>'
      + '<div id="heatDetail" class="heatDetail"><p class="dim">點縮圖上的小點，下面會展開那一格的反鏈。</p></div>'
      + '<div id="heatFull" class="heatScroll" hidden></div>';
    const fullBtn = $id<HTMLElement>('heatFullBtn');
    if (fullBtn) {
      fullBtn.textContent = '完整熱圖';
      fullBtn.onclick = () => {
        const full = $id('heatFull');
        if (!full || !lastData) return;
        if (full.hidden) {
          full.innerHTML = gridHtml(lastData, false);
          full.hidden = false;
          fullBtn.textContent = '收起熱圖';
        } else {
          full.hidden = true;
          full.innerHTML = '';
          fullBtn.textContent = '完整熱圖';
        }
      };
    }
    savePrefs();
  } finally {
    rendering = false;
  }
}

/** 更新「引紋」按鈕是否可見；若正在看這一頁就重畫。 */
export async function syncHeatTab(): Promise<void> {
  const btn = document.querySelector<HTMLElement>('#colRight .tabBtn[data-tab="heat"]');
  if (!btn) return;
  const hosts = await reverseHosts();
  const shown = hosts.length > 0;
  btn.hidden = !shown;
  if (!shown) {
    if (btn.classList.contains('active')) {
      const sum = document.querySelector<HTMLElement>('#colRight .tabBtn[data-tab="sum"]');
      sum?.click();
    }
    return;
  }
  if (btn.classList.contains('active')) void renderHeatTab();
}

export function initHeatTab(): void {
  if (inited) return;
  inited = true;
  loadPrefs();
  $id<HTMLSelectElement>('heatHost')?.addEventListener('change', (ev) => {
    hostDb = (ev.target as HTMLSelectElement).value;
    srcDb = '';
    void renderHeatTab();
  });
  $id<HTMLSelectElement>('heatSource')?.addEventListener('change', (ev) => {
    srcDb = (ev.target as HTMLSelectElement).value;
    void renderHeatTab();
  });
  document.querySelectorAll<HTMLElement>('#heatGrain [data-grain]').forEach((b) => {
    b.addEventListener('click', () => {
      grain = (b.dataset.grain as HeatGrain) || 'volume';
      void renderHeatTab();
    });
  });
  document.querySelectorAll<HTMLElement>('#heatNorm [data-norm]').forEach((b) => {
    b.addEventListener('click', () => {
      norm = (b.dataset.norm as HeatNorm) || 'count';
      void renderHeatTab();
    });
  });
  $id('heatBody')?.addEventListener('click', (ev) => {
    const mini = (ev.target as Element | null)?.closest?.('.heatMini .hgCell[data-mr0]') as HTMLElement | null;
    if (mini && lastData) {
      const r0 = Number(mini.dataset.mr0), r1 = Number(mini.dataset.mr1);
      const c0 = Number(mini.dataset.mc0), c1 = Number(mini.dataset.mc1);
      const rows = lastData.rows, cols = lastData.cols;
      const rowLabel = r0 === r1 - 1 ? rows[r0]?.label : (rows[r0]?.label ?? '') + ' … ' + (rows[r1 - 1]?.label ?? '');
      const colLabel = c0 === c1 - 1 ? cols[c0]?.label : (cols[c0]?.label ?? '') + ' … ' + (cols[c1 - 1]?.label ?? '');
      const data = lastData;
      void (async () => {
        const items = await reverseHeatRangeItems(data, r0, r1, c0, c1);
        paintHeatDetail(rowLabel + ' × ' + colLabel, items);
      })();
      return;
    }
    const cell = (ev.target as Element | null)?.closest?.('.hgCell[data-hr]') as HTMLElement | null;
    if (!cell || !lastData) return;
    const ri = Number(cell.dataset.hr), ci = Number(cell.dataset.hc);
    const row = lastData.rows[ri], col = lastData.cols[ci];
    if (!row || !col) return;
    void (async () => {
      const items = await reverseHeatRangeItems(lastData!, ri, ri + 1, ci, ci + 1);
      if (items.length) openRevListItems(row.label + ' × ' + col.label, items);
    })();
  });
  document.addEventListener('accelon26:reverse', () => { void syncHeatTab(); });
  document.addEventListener('accelon26:db', () => { void syncHeatTab(); });
  // 反鏈那一排的「分布」按鈕：切到「引紋」頁籤
  document.addEventListener('accelon26:heat', (ev) => {
    const d = (ev as CustomEvent<{ host?: string; src?: string }>).detail ?? {};
    if (d.host) hostDb = d.host;
    if (d.src) srcDb = d.src;
    void (async () => {
      await syncHeatTab();
      const btn = document.querySelector<HTMLElement>('#colRight .tabBtn[data-tab="heat"]');
      if (btn && !btn.hidden) btn.click();
    })();
  });
  void syncHeatTab();
}
