/**
 * 右欄與進階面板：META／容量／文件／圖片／token 瀏覽。
 *
 * Split out of viewer.ts (ADBVIEW-HANDOVER 3.2). Shared state is read from
 * ./viewer and the other split modules as ESM live bindings; a module OWNS the
 * state it declares, and other modules get/set it through that module's exports.
 */
import { $, displayName, docs, escapeHtml, fmtBytes, fmtInt, mapper, reader, setStatus, tokens } from './viewer';
import { revealHit, showLine } from './link';

let showAllClasses = false;

function containerSummary(c: Container) {
  return `${c.count} blocks · ${fmtBytes(c.totalBlockSize)}` + (c.blockSize ? ` · fixed ${c.blockSize}` : ' · var');
}

function renderMeta(r: AdbReader, openMs: number, tokenMs: number, layoutMs: number, docsMs: number) {
  const h: AdbHeader = r.header;
  const rows: [string, string][] = [
    ['檔名', h.dbname], ['顯示名', h.dbcname], ['檔案大小', fmtBytes(h.size)],
    ['壓縮', h.compression === 0 ? '無' : 'bzip2（每塊獨立）'],
    ['source 塊大小', fmtBytes(h.srcBlockSize)],
    ['source 塊數', fmtInt(r.containers.get('source')?.count ?? 0)],
    ['VA 總長', fmtInt(h.maxBlockOffset)], ['行數', fmtInt(h.lineCount)],
    ['tag 命中（header）', fmtInt(h.tagCount)],
    ['版本 / 類型', `v${h.version} / ${h.isDictionary ? '字典庫' : '一般'}${(h.dbType & 4) ? ' · hidden' : ''}`],
    ['CRC32', h.version >= 0x50902 ? h.crc32.toString(16) : `${h.crc32.toString(16)}（v < 0x50902，未校驗）`],
  ];
  $('#meta').innerHTML = `<table>${rows.map(([k, v]) => `<tr><th>${k}</th><td>${escapeHtml(String(v))}</td></tr>`).join('')}</table>
    <p class="note">開啟 ${openMs.toFixed(0)} ms ｜ token 索引 ${tokenMs.toFixed(0)} ms ｜ VA 表 ${layoutMs.toFixed(0)} ms ｜ 文件清單 ${docsMs.toFixed(0)} ms</p>`;

  // 容量 tab
  const c = r.containers;
  const cap: [string, string, string][] = [];
  for (const n of r.order) {
    const x = c.get(n)!;
    cap.push([n, fmtInt(x.count) + ' 塊', fmtBytes(x.totalBlockSize)]);
  }
  cap.push(['tokens 名稱表', '', fmtBytes((c.get('tokens')?.totalBlockSize ?? 0) - ((c.get('tokens')?.ends?.[(c.get('tokens')?.count ?? 1) - 1] ?? 0)))]);
  cap.push(['文字總量', fmtInt(h.lineCount) + ' 行', '']);
  cap.push(['VA 空間', fmtInt(h.maxBlockOffset), '']);
  $('#capacity').innerHTML = `<table class="cap"><tr><th>容器</th><th>區塊</th><th>大小</th></tr>
    ${cap.map(([a, b, d]) => `<tr><td>${escapeHtml(a)}</td><td>${escapeHtml(b)}</td><td>${escapeHtml(d)}</td></tr>`).join('')}</table>`;
}

function renderContainers(r: AdbReader) {
  $('#containers').innerHTML = r.order.map((n) => {
    const x = r.containers.get(n)!;
    return `<li><b>${n}</b> <span class="dim">${containerSummary(x)}</span></li>`;
  }).join('');
}

const THUMB_LIMIT = 48;

async function renderResources() {
  // the reader is a GLOBAL: capturing it keeps a database switch that lands mid-render
  // from reading resources out of the wrong container ("no resources container")
  const r = reader;
  const c = r?.containers.get('resources');
  const box = $('#resources');
  if (!r || !c || !c.count) { box.innerHTML = '<p class="dim">（此庫沒有 resources）</p>'; return; }
  const n = Math.min(c.count, THUMB_LIMIT);
  box.innerHTML = `<p class="note">${fmtInt(c.count)} 個資源，${fmtBytes(c.totalBlockSize)}（未壓縮，可直接讀單一資源）</p>
    <p class="note" id="thumbNote">載入前 ${n} 張縮圖…</p>`;
  const list = document.createElement('div');
  list.className = 'thumbGrid';
  box.appendChild(list);
  for (let i = 0; i < n; i++) {
    if (r !== reader) return;      // another database took over
    const { name, bytes } = await r.resourceBytes(i);
    const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
    const cell = document.createElement('div');
    cell.className = 'thumb';
    cell.title = name;
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].includes(ext)) {
      const url = URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer], { type: 'image/' + (ext === 'svg' ? 'svg+xml' : ext) }));
      cell.innerHTML = `<img src="${url}" alt="">`;
    } else {
      cell.innerHTML = `<div class="dim">${escapeHtml(ext || '?')}</div>`;
    }
    const label = document.createElement('span');
    label.textContent = name.split('/').pop() ?? name;
    cell.appendChild(label);
    list.appendChild(cell);
    if ((i & 15) === 15) await new Promise((r) => setTimeout(r, 0));
  }
  const note = $('#thumbNote');
  if (note) note.textContent = c.count > n ? `已載入前 ${n} 張（共 ${c.count}）` : `已載入 ${n} 張`;
}

// ------------------------------------------------------------------ documents
function renderDocs() {
  const box = $('#docs');
  if (!docs.length) { box.innerHTML = '<p class="dim">（無 檔 標籤：單檔庫；可直接用下方搜尋結果定位）</p>'; return; }
  box.innerHTML = docs.map((d) => `<button class="docItem" data-i="${d.i}">
      <span class="docName">${escapeHtml(displayName(d.name))}</span>
      <span class="dim">VA ${fmtInt(d.vaStart)}</span></button>`).join('');
  box.querySelectorAll<HTMLButtonElement>('.docItem').forEach((el) => {
    el.onclick = () => {
      const i = Number(el.dataset.i);
      const d = docs[i];
      if (!d) return;
      // find the first line of that document and show it (no hit to paint)
      const line = mapper!.linesVirtual.findIndex((v) => v >= d.vaStart);
      void showLine(line < 0 ? 0 : line, d.vaStart);
    };
  });
}

function renderTokens(stats: { count: number[]; bytes: number[] }, ms: number) {
  const total = stats.count.reduce((a, b) => a + b, 0);
  const list = showAllClasses ? tokens : tokens.filter((t) => t.cls === 0);
  const head = escapeHtml(reader!.header.dbname);
  $('#tokenSummary').innerHTML = `
    <div class="kv"><span>distinct tokens</span><b>${fmtInt(total)}</b></div>
    <div class="kv"><span>已列出</span><b>${fmtInt(list.length)}</b>${showAllClasses ? '' : ' <span class="dim">(僅漢字)</span>'}</div>
    <div class="kv"><span>索引建立</span><b>${ms.toFixed(0)} ms</b></div>`;
  $('#tokenClasses').innerHTML = CLASS_LABELS.map((label, ci) => `
    <button class="clsChip ${showAllClasses || ci === 0 ? '' : 'dim'}" data-cls="${ci}">
      ${label} <b>${fmtInt(stats.count[ci])}</b> <span class="dim">${fmtBytes(stats.bytes[ci])}</span>
    </button>`).join('') + `<button class="clsChip" id="toggleAll">${showAllClasses ? '只顯示漢字' : '全部載入'}</button>`;
  $('#tokenClasses').querySelectorAll<HTMLButtonElement>('.clsChip[data-cls]').forEach((el) => {
    el.onclick = () => {
      const cls = Number(el.dataset.cls);
      showAllClasses = true;
      hideAllExcept(cls);
      renderTokenList(tokens.filter((t) => t.cls === cls), `${CLASS_LABELS[cls]} 共 ${fmtInt(stats.count[cls])} 個`);
    };
  });
  const toggle = $('#toggleAll') as HTMLButtonElement;
  toggle.onclick = () => {
    showAllClasses = !showAllClasses;
    renderTokens(stats, ms);
    renderTokenList(showAllClasses ? tokens : tokens.filter((t) => t.cls === 0), head);
  };
  hideAllExcept(-1);
  renderTokenList(list, head);
}

/** chip visual state for a single-class view (-1 = all) */
function hideAllExcept(cls: number) {
  $('#tokenClasses').querySelectorAll<HTMLButtonElement>('.clsChip[data-cls]').forEach((el) => {
    el.classList.toggle('dim', cls >= 0 && Number(el.dataset.cls) !== cls);
  });
}

const PAGE = 300;

let tokenOffset = 0;

let tokenList: TokenRow[] = [];

function renderTokenList(list: TokenRow[], title: string) {
  tokenList = list;
  tokenOffset = 0;
  $('#tokenTitle').textContent = `${title} · 列出 ${fmtInt(list.length)} 個`;
  $('#tokenRows').innerHTML = '';
  appendTokenRows();
}

function appendTokenRows() {
  const body = $('#tokenRows');
  const end = Math.min(tokenOffset + PAGE, tokenList.length);
  const frag = document.createDocumentFragment();
  for (let i = tokenOffset; i < end; i++) {
    const t = tokenList[i];
    const row = document.createElement('div');
    row.className = 'tokenRow';
    row.innerHTML = `<span class="tokName">${escapeHtml(displayName(t.name))}</span>
      <span class="tokSize">${fmtBytes(t.bytes)}</span>
      ${t.dirty ? '<span class="dirty" title="名稱含未配對代理或內嵌 NUL">!</span>' : ''}`;
    row.onclick = () => void showToken(t);
    frag.appendChild(row);
  }
  body.appendChild(frag);
  tokenOffset = end;
  $('#tokenMore').textContent = tokenOffset < tokenList.length
    ? `還有 ${fmtInt(tokenList.length - tokenOffset)} 個（捲到底自動載入）` : '（已全部列出）';
}

/**
 * Clicking a token jumps straight to its first posting in the document. The
 * posting list pane was removed: it only duplicated what the search summaries
 * already show, so a token click now goes directly to the text.
 */
async function showToken(t: TokenRow, targetVa?: number) {
  setStatus(`讀取 ${JSON.stringify(displayName(t.name))} 的 posting list …`, 'busy');
  const t0 = performance.now();
  const va = await reader!.decodeBlockList('tokens', t.i);
  const ms = performance.now() - t0;
  setStatus(`${displayName(t.name)}：${fmtInt(va.length)} 筆 posting（${ms.toFixed(1)} ms）`, 'info');
  if (!va.length) return;
  const first = targetVa !== undefined && va.includes(targetVa) ? targetVa : va[0];
  await revealHit(first, t.name);
}

function binarySearch(xs: number[], v: number): number {
  let lo = 0, hi = xs.length - 1, best = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (xs[m] <= v) { best = m; lo = m + 1; } else hi = m - 1; }
  return best;
}

async function vapaProbe(va: number): Promise<unknown> {
  if (!mapper) return null;
  const ctx = await mapper.contextSpans(va, 60, 120);
  return ctx ? { block: ctx.block, pa: ctx.pa, hit: ctx.text.slice(ctx.hitStart, ctx.hitEnd), kind: ctx.element?.kind, tag: ctx.element?.tag ?? null } : null;
}

import { AdbHeader, AdbReader, CLASS_LABELS, Container, TokenRow } from './adb';

function snapshotPanes() {
  return { tokenList, tokenOffset, showAllClasses };
}
function restorePanes(s: any): void {
  tokenList = s.tokenList ?? [];
  tokenOffset = s.tokenOffset ?? 0;
  showAllClasses = s.showAllClasses ?? false;
}
export { PAGE, THUMB_LIMIT, appendTokenRows, binarySearch, containerSummary, hideAllExcept, renderContainers, renderDocs, renderMeta, renderResources, renderTokenList, renderTokens, restorePanes, showAllClasses, showToken, snapshotPanes, tokenList, tokenOffset, vapaProbe };
