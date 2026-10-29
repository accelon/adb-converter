/**
 * 書籤與選取文字選單（2026-10-28）
 *
 *   - 左欄「書籤」分頁：所有 adb 都有；存在 localStorage，依 dbname 分開。
 *   - 選取本文 → 浮動選單：加入書籤／複製／引用複製。
 *   - 引用格式由該 adb 檔頭的 `<引>…</引>` 決定（$書;、$_;、$*頁;…）。
 *   - 產生的引用含頁 id，貼到「跳至」即可跳到那一頁（見 scopes.ts 的 embedded 頁 id）。
 */
import { mapper, reader, setStatus } from './viewer';
import { lookupBook, openTaishoAt, pageHanText, pageIdAtVa, type BookHit } from './xref';
import { revealHit } from './link';
import { openDictLookup } from './dict-pane';
import { openForeignTab } from './text-pane';

interface Bookmark {
  id: string;
  db: string;
  va: number;
  pageId: string;
  book: string;
  page: string;
  text: string;
  createdAt: number;
}

interface SelInfo {
  text: string;
  raw: string;
  va: number;
  pageId: string;
  book: string;
  page: string;
  rect: { left: number; top: number; bottom: number; width: number };
  /** 只有「不超過 10 個字、且不含標點」的短詞才顯示「搜尋」。 */
  searchable: boolean;
  startLine: number;
  endLine: number;
}

const KEY = 'accelon26.bookmarks.v1';
/** 終點庫：只讀，不提供「引用複製」（例如金剛經研究讀本）。 */
const TERMINAL_DBS = new Set(['jingang', 'study']);
const isTerminalDb = (): boolean => !!reader && TERMINAL_DBS.has(reader.header.dbname);
let inited = false;
let pending: SelInfo | null = null;
let sutraHit: BookHit | null = null;
/** study 頁碼／大正引用：選單只留「打開經文」「複製」。 */
let pendingRef: string | null = null;

const $id = <T extends HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function loadAll(): Record<string, Bookmark[]> {
  try {
    const raw = localStorage.getItem(KEY);
    const all = raw ? JSON.parse(raw) : {};
    return all && typeof all === 'object' ? all : {};
  } catch { return {}; }
}
function saveAll(all: Record<string, Bookmark[]>): void {
  try { localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* localStorage 可能被禁用 */ }
}
function dbKey(): string {
  return reader?.header.dbname ?? '';
}
function bookmarksOf(db = dbKey()): Bookmark[] {
  const list = loadAll()[db] ?? [];
  return list.slice().sort((a, b) => b.createdAt - a.createdAt);
}

/** 目前 reader 的某個標籤在 VA 之前最近的名稱。 */
async function labelAt(va: number, tag: string): Promise<string> {
  const r = reader;
  if (!r) return '';
  const tc = r.containers.get('tags');
  const i = tc?.names.indexOf(tag) ?? -1;
  if (!tc || i < 0) return '';
  const vas = await r.decodeBlockList('tags', i);
  if (!vas.length) return '';
  const names = await r.cachedStrings(tag).catch(() => [] as string[]);
  let lo = 0, hi = vas.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (vas[m] <= va) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans >= 0 ? (names[ans] ?? '') : '';
}

async function bookAt(va: number): Promise<string> {
  for (const tag of ['書', '集', '編', '篇', '章']) {
    const t = await labelAt(va, tag);
    if (t) return t;
  }
  return reader?.header.dbcname || reader?.header.dbname || '';
}

function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** 取目前選取範圍（只接受中間本文的 .docLine，避免左右欄混在一起）。 */
async function selectionInfo(): Promise<SelInfo | null> {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return null;
  const raw = sel.toString();
  const text = normalize(raw);
  if (!text) return null;
  const range = sel.getRangeAt(0);
  const root = range.startContainer;
  const el = root.nodeType === 1 ? root as Element : root.parentElement;
  const line = el?.closest?.('#docText .docLine') as HTMLElement | null;
  if (!line) return null;
  const n = Number((line.id || '').slice(1));
  if (!Number.isFinite(n)) return null;
  const va = mapper?.linesVirtual?.[n];
  if (va == null) return null;
  const pageId = (await pageIdAtVa(va)) || '';
  const book = await bookAt(va);
  const rects = range.getClientRects();
  const rect = rects.length ? rects[0] : range.getBoundingClientRect();
  const compact = text.replace(/\s+/g, '');
  const searchable = Array.from(compact).length <= 10 && !/[\p{P}\p{S}]/u.test(text);
  const endRoot = range.endContainer;
  const endEl = endRoot.nodeType === 1 ? endRoot as Element : endRoot.parentElement;
  const endLineEl = endEl?.closest?.('#docText .docLine') as HTMLElement | null;
  const endN = Number((endLineEl?.id || '').slice(1));
  const endLine = Number.isFinite(endN) && endN >= n ? endN : n;
  return { text, raw, va, pageId, book, page: pageId, rect: { left: rect.left, top: rect.top, bottom: rect.bottom, width: rect.width }, searchable, startLine: n, endLine };
}

async function hanRange(info: SelInfo): Promise<[number, number]> {
  const db = reader?.header.dbname ?? '';
  const page = await pageHanText(db, info.pageId);
  const needle = Array.from(info.raw).filter((c) => /[\u3400-\u9fff\uf900-\ufaff]/.test(c)).join('');
  if (!needle) return [0, 0];
  const at = page.indexOf(needle);
  return at >= 0 ? [at, at + needle.length] : [0, Math.min(page.length, needle.length)];
}

const escAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 由選取產生可貼進 jingang.txt 的片段；指針用母庫的頁＋漢字範圍。 */
async function snippetFor(kind: 'rong' | 'qian', info: SelInfo): Promise<string> {
  const db = reader?.header.dbname ?? 'taisho';
  const [a, b] = await hanRange(info);
  const i = `${db}?${info.pageId}`;
  const q = Array.from(info.raw).filter((c) => /[\u3400-\u9fff\uf900-\ufaff]/.test(c)).join('');
  const label = info.text.slice(0, 10) || '選文';
  if (kind === 'rong') return `<融 i="${i}" j="${a}-${b}"></融>`;
  return `<嵌 i="${i}" j="${a}-${b}" q="${escAttr(q)}" t="${i}@${a}-${b}@${escAttr(label)}" n="1 家注疏"/>`;
}
function hideMenu(): void {
  const m = $id('selMenu');
  if (m) m.hidden = true;
  pending = null;
  sutraHit = null;
  pendingRef = null;
}

/** 認得的大正位置：18p14c、T18n0890_p0014c…；回傳可給 openTaishoAt 的頁碼。 */
function taishoRef(text: string): string {
  const t = text.replace(/\s+/g, '').replace(/[，。；：、！？「」『』（）()【】\[\]]/g, '');
  let m = /^(\d{1,3})p(\d{1,4})([a-c])?$/i.exec(t);
  if (m) return `${m[1]}p${m[2]}${(m[3] || 'a').toLowerCase()}`;
  // CBETA 常見：T18n0890_p0014c / T18n0890_0014c
  m = /^T(\d{1,3})n\d{3,4}[A-Za-z]?[_-]?p?(\d{1,4})([a-c])/i.exec(t);
  if (m) return `${m[1]}p${m[2]}${m[3].toLowerCase()}`;
  return '';
}

function sutraQuery(text: string): string {
  const inside = /《([^》]{1,40})》/.exec(text);
  if (inside) return inside[1];
  const t = text.replace(/^[「『《〈（(【\[]+|[」』》〉）)】\]]+$/g, '').replace(/[，。；：、！？…\s]+$/g, '').trim();
  return /[經論]$/.test(t) ? t : '';
}

/** 有開大正藏時，選取書名／結尾經論 → 在選單加一顆「開《…》」。 */
async function fillSutra(info: SelInfo): Promise<void> {
  sutraHit = null;
  const btn = document.querySelector<HTMLButtonElement>('#selMenu [data-sel="sutra"]');
  if (!btn) return;
  btn.hidden = true;
  btn.textContent = '';
  const q = sutraQuery(info.text);
  if (!q) return;
  const hit = await lookupBook('taisho', q);
  if (!hit || pending !== info) return;
  sutraHit = hit;
  btn.textContent = '開《' + hit.title + '》';
  btn.title = '在右欄打開大正藏《' + hit.title + '》';
  btn.hidden = false;
}

function showMenu(info: SelInfo): void {
  const m = $id('selMenu');
  if (!m) return;
  pending = info;
  pendingRef = reader?.header.dbname === 'study' ? taishoRef(info.text) : '';
  const all = [...m.querySelectorAll<HTMLButtonElement>('[data-sel]')];
  if (pendingRef) {
    // 雙擊頁碼／大正引用：只留「打開經文」「複製」，不要 bookmark／搜尋／字典／引用模板。
    sutraHit = null;
    for (const b of all) b.hidden = b.dataset.sel !== 'sutra' && b.dataset.sel !== 'copy';
    const open = m.querySelector<HTMLButtonElement>('[data-sel="sutra"]');
    if (open) {
      open.textContent = '打開經文';
      open.title = '在大正藏打開 ' + pendingRef;
      open.hidden = false;
    }
    m.hidden = false;
    const w = m.offsetWidth || 120, h = m.offsetHeight || 36;
    m.style.left = Math.max(6, Math.min(window.innerWidth - w - 6, info.rect.left)) + 'px';
    m.style.top = Math.max(6, Math.min(window.innerHeight - h - 6, info.rect.bottom + 6)) + 'px';
    return;
  }
  pendingRef = null;
  for (const b of all) b.hidden = false;
  const searchBtn = m.querySelector<HTMLButtonElement>('[data-sel="search"]');
  if (searchBtn) searchBtn.hidden = !info.searchable;
  const citeBtn = m.querySelector<HTMLButtonElement>('[data-sel="cite"]');
  if (citeBtn) citeBtn.hidden = isTerminalDb();
  const sutraBtn = m.querySelector<HTMLButtonElement>('[data-sel="sutra"]');
  if (sutraBtn) sutraBtn.hidden = true;
  m.hidden = false;
  // 先顯示再量大小，才不會超出視窗
  const w = m.offsetWidth || 120, h = m.offsetHeight || 36;
  const left = Math.max(6, Math.min(window.innerWidth - w - 6, info.rect.left));
  const top = Math.max(6, Math.min(window.innerHeight - h - 6, info.rect.bottom + 6));
  m.style.left = left + 'px';
  m.style.top = top + 'px';
  void fillSutra(info);
}

async function copyText(text: string, message: string): Promise<void> {
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-100000px';
    document.body.appendChild(ta);
    ta.select();
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
  }
  setStatus(ok ? message : '複製失敗（瀏覽器阻擋）', ok ? 'info' : 'err');
}

/** 依檔頭的 <引> 展開引用文字；找不到就退回一個含頁 id 的保守格式。 */
export async function citationFor(info: SelInfo): Promise<string> {
  const r = reader;
  if (!r) return info.text;
  const header = await r.sourceText(0).catch(() => '');
  const m = /<引(?:\s[^>]*)?>([\s\S]*?)<\/引>/.exec(header);
  const tpl = m?.[1] ?? '《$書;》：「$_;」( $*頁; )';
  const tags = [...tpl.matchAll(/\$(\*?)([^;]+);/g)].map((x) => x[2]);
  const values = new Map<string, string>();
  for (const tag of tags) {
    if (tag === '_') continue;
    if (tag === '頁') { values.set(tag, info.pageId); continue; }
    values.set(tag, await labelAt(info.va, tag));
  }
  let out = tpl.replace(/\$(\*?)([^;]+);/g, (_all, _star, tag: string) => {
    if (tag === '_') return info.text;
    if (tag === '頁') return info.pageId;
    return values.get(tag) ?? '';
  });
  out = normalize(out);
  // 模板若沒有頁 id，補一個括號；這樣「跳至」一定找得到。
  if (info.pageId && !out.includes(info.pageId)) out += ' (' + info.pageId + ')';
  return out;
}

/** 把選取文字送進目前 active 的左欄搜尋框；沒有搜尋框（書籤／token）就退回目錄搜尋。 */
function sendSearch(text: string): void {
  const left = document.getElementById('colLeft');
  if (left && left.getBoundingClientRect().width < 10) {
    document.getElementById('toggleLeft')?.click();
  }
  const active = document.querySelector<HTMLElement>('#colLeft .tabBtn.active');
  let tab = active?.dataset.tab ?? 'dir';
  const ids: Record<string, string> = {
    dir: 'query', terms: 'termsQuery', freq: 'freqQuery', jump: 'jumpQuery', latin: 'latinQuery',
  };
  let input = document.getElementById(ids[tab] ?? '') as HTMLInputElement | null;
  if (!input) {
    tab = 'dir';
    document.querySelector<HTMLElement>('#colLeft .tabBtn[data-tab="dir"]')?.click();
    input = document.getElementById('query') as HTMLInputElement | null;
  }
  if (!input) return;
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.focus();
}

function addBookmark(info: SelInfo): void {  const db = dbKey();
  if (!db) return;
  const all = loadAll();
  const list = (all[db] ?? []).slice();
  list.unshift({
    id: (globalThis.crypto as Crypto | undefined)?.randomUUID?.() ?? String(Date.now()) + Math.random().toString(16).slice(2),
    db, va: info.va, pageId: info.pageId, book: info.book, page: info.page,
    text: info.text.slice(0, 240), createdAt: Date.now(),
  });
  all[db] = list.slice(0, 500);
  saveAll(all);
  setStatus('已加入書籤：' + (info.book || db) + (info.pageId ? ' ' + info.pageId : ''), 'info');
  if (document.querySelector('#colLeft .tabBtn[data-tab="bookmark"]')?.classList.contains('active')) void renderBookmarks();
}

function jumpBookmark(b: Bookmark): void {
  void revealHit(b.va, b.book || b.pageId || '書籤', 1, { mode: 'node', noMark: true });
}

export async function renderBookmarks(): Promise<void> {
  const list = $id('bookmarkList');
  const meta = $id('bookmarkMeta');
  if (!list) return;
  if (!reader) {
    list.innerHTML = '<p class="dim">尚未開啟資料庫。</p>';
    if (meta) meta.textContent = '';
    return;
  }
  const items = bookmarksOf();
  if (meta) meta.textContent = items.length ? items.length + ' 個書籤（' + (reader.header.dbcname || reader.header.dbname) + '）' : '';
  if (!items.length) {
    list.innerHTML = '<p class="dim">選一段本文，按「加入書籤」。書籤只存在這個瀏覽器。</p>';
    return;
  }
  list.innerHTML = items.map((b) => {
    const title = (b.book || reader.header.dbcname || b.db) + (b.pageId ? ' ' + b.pageId : '');
    return '<div class="bmRow" data-id="' + esc(b.id) + '">'
      + '<button type="button" class="bmJump" title="跳到 ' + esc(title) + '">'
      + '<span class="bmTitle">' + esc(title) + '</span>'
      + '<span class="bmText">' + esc(b.text.slice(0, 100)) + '</span></button>'
      + '<button type="button" class="bmDel" data-del="' + esc(b.id) + '" title="刪除書籤">✕</button></div>';
  }).join('');
  list.querySelectorAll<HTMLElement>('.bmRow').forEach((row) => {
    const id = row.dataset.id;
    const b = items.find((x) => x.id === id);
    if (!b) return;
    row.querySelector<HTMLElement>('.bmJump')?.addEventListener('click', () => jumpBookmark(b));
    row.querySelector<HTMLElement>('.bmDel')?.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const all = loadAll();
      all[b.db] = (all[b.db] ?? []).filter((x) => x.id !== b.id);
      saveAll(all);
      void renderBookmarks();
      setStatus('已刪除書籤', 'info');
    });
  });
}

export function bookmarkState(): { count: number; db: string } {
  return { count: bookmarksOf().length, db: dbKey() };
}

/** 測試／診斷：目前選取範圍的引用文字（不複製）。 */
export async function citationForSelection(): Promise<string | null> {
  const info = await selectionInfo();
  return info ? citationFor(info) : null;
}

export function initBookmarks(): void {
  if (inited) return;
  inited = true;
  const menu = $id('selMenu');
  menu?.addEventListener('mousedown', (ev) => ev.preventDefault());

  const run = async (action: string) => {
    const info = pending ?? await selectionInfo();
    if (!info) return;
    if (action === 'bookmark') addBookmark(info);
    else if (action === 'copy') await copyText(info.raw, '已複製選取文字');
    else if (action === 'cite' && !isTerminalDb()) await copyText(await citationFor(info), '已複製引用');
    else if (action === 'rong') {
      const s = await snippetFor('rong', info);
      (window as unknown as { __lastSnippet?: string }).__lastSnippet = s;
      await copyText(s, '已複製 <融> 片段；貼到 jingang.txt 的頁面位置');
    } else if (action === 'qian') {
      const s = await snippetFor('qian', info);
      (window as unknown as { __lastSnippet?: string }).__lastSnippet = s;
      await copyText(s, '已複製 <嵌> 模板；把 q 改成要標記的經文，貼到段落後');
    }
    else if (action === 'search' && info.searchable) sendSearch(info.text);
    else if (action === 'dict') await openDictLookup(info.text);
    else if (action === 'sutra') {
      if (pendingRef) {
        await openTaishoAt('taisho', pendingRef, '大正 ' + pendingRef);
      } else if (sutraHit) {
        openForeignTab(sutraHit.db, sutraHit.pageVa ?? sutraHit.va, sutraHit.title, false, sutraHit.pageId);
        setStatus('右欄開啟《' + sutraHit.title + '》', 'info');
      }
    }
    hideMenu();
  };
  menu?.querySelectorAll<HTMLElement>('[data-sel]').forEach((b) => {
    b.addEventListener('click', () => void run(b.dataset.sel ?? ''));
  });

  document.addEventListener('mouseup', (ev) => {
    if (ev.button !== 0) return;
    if ((ev.target as Element | null)?.closest?.('#selMenu')) return;
    setTimeout(() => {
      void (async () => {
        const info = await selectionInfo();
        if (info) showMenu(info); else hideMenu();
      })();
    }, 0);
  }, true);
  document.addEventListener('keyup', (ev) => {
    if (ev.key === 'Shift' || (ev.key.startsWith('Arrow') && ev.shiftKey)) {
      setTimeout(() => { void (async () => { const info = await selectionInfo(); if (info) showMenu(info); })(); }, 0);
    }
  });
  document.addEventListener('selectionchange', () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) hideMenu();
  });
  document.addEventListener('mousedown', (ev) => {
    if (!(ev.target as Element | null)?.closest?.('#selMenu')) hideMenu();
  }, true);
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') hideMenu(); });
  window.addEventListener('scroll', hideMenu, true);
}

