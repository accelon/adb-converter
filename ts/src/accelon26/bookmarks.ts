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
import {
  addressAtLine, mapPosMap, mapSideOf, plateLinksAtLine, taishoPlateForPageId, type PlateLinks,
} from './map-pane';
import { formatAddress } from './posmap';
import { openExternalUrl } from './plates';

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
  /** 選取起點前面有幾個漢字（換算位置用；標點與標記不計）。 */
  hanPrefix: number;
  /** 選取終點在它的那一行前面有幾個漢字（複製位址範圍用）。 */
  hanPrefixEnd: number;
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
/** 這次選取算出來的圖版網址（「看大正藏／高麗藏圖版」）。 */
let plateUrls: PlateLinks = {};

const $id = <T extends HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const HAN_RE = /[\u3400-\u9fff\uf900-\ufaff]/;

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
  // 選取起點在這一行的第幾個漢字（標點、標記不計）：換址要的欄內偏置。
  let hanPrefix = 0;
  try {
    const pre = document.createRange();
    pre.selectNodeContents(line);
    pre.setEnd(range.startContainer, range.startOffset);
    for (const ch of pre.toString()) if (HAN_RE.test(ch)) hanPrefix++;
  } catch { hanPrefix = 0; }
  // 選取終點在它的那一行的第幾個漢字（複製位址範圍用）
  let hanPrefixEnd = 0;
  try {
    const endLineEl2 = (endLineEl ?? line) as HTMLElement;
    const pre = document.createRange();
    pre.selectNodeContents(endLineEl2);
    pre.setEnd(range.endContainer, range.endOffset);
    for (const ch of pre.toString()) if (HAN_RE.test(ch)) hanPrefixEnd++;
  } catch { hanPrefixEnd = hanPrefix; }
  return { text, raw, va, pageId, book, page: pageId, rect: { left: rect.left, top: rect.top, bottom: rect.bottom, width: rect.width }, searchable, startLine: n, endLine, hanPrefix, hanPrefixEnd };
}

async function hanRange(info: SelInfo): Promise<[number, number]> {
  const db = reader?.header.dbname ?? '';
  const page = await pageHanText(db, info.pageId);
  const needle = Array.from(info.raw).filter((c) => /[\u3400-\u9fff\uf900-\ufaff]/.test(c)).join('');
  if (!needle) return [0, 0];
  let at = page.indexOf(needle);
  if (at < 0) {
    // 區段跨頁時整段不在這一頁：用開頭的一段去對（越長越準），
    // 才不會退成 j=0-N 指到頁首。
    for (let n = Math.min(needle.length, 24); n >= 4; n--) {
      at = page.indexOf(needle.slice(0, n));
      if (at >= 0) break;
    }
  }
  if (at < 0) return [0, Math.min(page.length, needle.length)];
  return [at, Math.min(page.length, at + needle.length)];
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
  if (m) { m.hidden = true; closeSubs(m); }
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

/**
 * 選取位置的圖版（2026-10-30）：
 *   大正藏 → DIA 的 uViewer（只需冊與頁，讀大正藏時一定有）
 *   高麗藏 → KABC（要有對照表才知道經號、卷與冊頁欄；也就是 goryeo_taisho.adb）
 */
async function fillPlates(info: SelInfo): Promise<void> {
  const tBtn = document.querySelector<HTMLButtonElement>('#selMenu [data-sel="plateT"]');
  const kBtn = document.querySelector<HTMLButtonElement>('#selMenu [data-sel="plateK"]');
  if (kBtn) kBtn.hidden = true;
  let links: PlateLinks = plateUrls.taisho ? { taisho: plateUrls.taisho } : {};
  try {
    links = await plateLinksAtLine(info.startLine, info.hanPrefix);
  } catch (e) {
    // 換址失敗（例如對照表不在）不應該讓整個選單都沒有圖版：大正藏那顆已經先顯示了
    console.debug('plates: address failed', e);
  }
  if (pending !== info) return;
  plateUrls = { ...links, taisho: links.taisho || plateUrls.taisho };
  if (tBtn && plateUrls.taisho) { tBtn.hidden = false; tBtn.title = plateUrls.taisho; }
  if (kBtn && links.goryeo) { kBtn.hidden = false; kBtn.title = links.goryeo; }
  const m = $id('selMenu');
  if (m && !m.hidden) placeMenu(m, info);
}

function showMenu(info: SelInfo): void {
  const m = $id('selMenu');
  if (!m) return;
  pending = info;
  pendingRef = reader?.header.dbname === 'study' ? taishoRef(info.text) : '';
  plateUrls = {};
  addrRange = '';
  closeSubs(m);
  m.hidden = false;

  // 先全部顯示，再依情況收起來（不要留下上一個選取的狀態）
  for (const kind of ['search', 'copy', 'view']) {
    const g = grpOf(m, kind);
    if (g) g.hidden = false;
  }
  m.querySelectorAll<HTMLButtonElement>('[data-sel]').forEach((b) => { b.hidden = false; });
  const minor = m.querySelector<HTMLButtonElement>('.selMinor');
  if (minor) minor.hidden = false;
  for (const sel of ['plateT', 'plateK', 'sutra', 'addr']) {
    const b = actOf(m, sel);
    if (b) b.hidden = true;
  }

  fillSearch(m);

  if (pendingRef) {
    // study 的頁碼／大正引用：只留「複製文字」與「查看→打開經文」
    sutraHit = null;
    const gs = grpOf(m, 'search');
    if (gs) gs.hidden = true;
    for (const sel of ['cite', 'rong', 'qian', 'pos', 'addr', 'dict', 'plateT', 'plateK']) {
      const b = actOf(m, sel);
      if (b) b.hidden = true;
    }
    const open = actOf(m, 'sutra');
    if (open) {
      open.textContent = '打開經文';
      open.title = '在大正藏打開 ' + pendingRef;
      open.hidden = false;
    }
    if (minor) minor.hidden = true;
    placeMenu(m, info);
    return;
  }

  pendingRef = null;
  const citeBtn = actOf(m, 'cite');
  if (citeBtn) citeBtn.hidden = isTerminalDb();
  // 大正藏圖版只要頁 id：選單一開就先給，不必等換址完成
  if (reader?.header.dbname === 'taisho' && info.pageId) {
    const url = taishoPlateForPageId(info.pageId);
    const b = actOf(m, 'plateT');
    if (url && b) { plateUrls.taisho = url; b.hidden = false; b.title = url; }
  }
  placeMenu(m, info);
  void fillSutra(info);
  void fillPlates(info);
  void fillAddress(info);
}

/** 先顯示再量大小，才不會超出視窗。 */
function placeMenu(m: HTMLElement, info: SelInfo): void {
  const w = m.offsetWidth || 120, h = m.offsetHeight || 36;
  m.style.left = Math.max(6, Math.min(window.innerWidth - w - 6, info.rect.left)) + 'px';
  m.style.top = Math.max(6, Math.min(window.innerHeight - h - 6, info.rect.bottom + 6)) + 'px';
}

async function copyText(text: string, message: string): Promise<void> {
  // 測試／診斷：最近一次複製的字串（不管剪貼簿有沒有成功）
  (window as unknown as { __lastCopy?: string }).__lastCopy = text;
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

// ---------------------------------------------------------------- 兩層選單（2026-10-30）

/** 左欄可以接受輸入的分頁：第一層「搜尋」的目的地。 */
const INPUT_TABS: [kind: string, inputId: string][] = [
  ['dir', 'query'],
  ['terms', 'termsQuery'],
  ['freq', 'freqQuery'],
  ['folio', 'folioQuery'],
  ['jump', 'jumpQuery'],
  ['latin', 'latinQuery'],
  ['map', 'mapQuery'],
];

function visibleInputTabs(): { kind: string; inputId: string; label: string }[] {
  const out: { kind: string; inputId: string; label: string }[] = [];
  for (const [kind, inputId] of INPUT_TABS) {
    const btn = document.querySelector<HTMLElement>(`#colLeft .tabBtn[data-tab="${kind}"]`);
    if (!btn || btn.hidden) continue;
    out.push({ kind, inputId, label: (btn.textContent || kind).trim() });
  }
  return out;
}

/** 把選取文字送到指定的左欄分頁，並切過去。 */
function sendToTab(kind: string, text: string): void {
  const left = document.getElementById('colLeft');
  if (left && left.getBoundingClientRect().width < 10) document.getElementById('toggleLeft')?.click();
  const btn = document.querySelector<HTMLElement>(`#colLeft .tabBtn[data-tab="${kind}"]`);
  if (!btn || btn.hidden) return;
  // 已經在這一頁就不要重點（再點一次目錄會把樹收起來）
  if (!btn.classList.contains('active')) btn.click();
  const inputId = INPUT_TABS.find(([k]) => k === kind)?.[1] ?? '';
  const input = document.getElementById(inputId) as HTMLInputElement | null;
  if (!input) return;
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.focus();
}

const subOf = (m: HTMLElement, kind: string) => m.querySelector<HTMLElement>(`.selSub[data-sub="${kind}"]`);
const actOf = (m: HTMLElement, sel: string) => m.querySelector<HTMLButtonElement>(`[data-sel="${sel}"]`);
const grpOf = (m: HTMLElement, kind: string) => m.querySelector<HTMLElement>(`.selGroup[data-grp="${kind}"]`);

function closeSubs(m: HTMLElement): void {
  m.querySelectorAll<HTMLElement>('.selSub').forEach((s) => { s.hidden = true; });
  m.querySelectorAll<HTMLElement>('.selGroup').forEach((g) => g.classList.remove('open'));
}

/** 開第二層；靠近視窗右邊／下面時翻到左邊、往上收。 */
function openSub(m: HTMLElement, kind: string): void {
  m.querySelectorAll<HTMLElement>('.selSub').forEach((s) => { s.hidden = s.dataset.sub !== kind; });
  m.querySelectorAll<HTMLElement>('.selGroup').forEach((g) => g.classList.toggle('open', g.dataset.grp === kind));
  const sub = subOf(m, kind);
  if (!sub) return;
  m.classList.remove('flip');
  let r = sub.getBoundingClientRect();
  if (r.right > window.innerWidth - 6) {
    m.classList.add('flip');
    r = sub.getBoundingClientRect();
  }
  const dy = Math.min(0, window.innerHeight - 6 - r.bottom);
  sub.style.top = (dy < 0 ? -5 + dy : -5) + 'px';
}

/** 第一層「搜尋」的第二層：這個庫現在有、而且能接受輸入的分頁。 */
function fillSearch(m: HTMLElement): void {
  const sub = subOf(m, 'search');
  const grp = grpOf(m, 'search');
  if (!sub) return;
  const tabs = visibleInputTabs();
  sub.innerHTML = tabs.map((t) =>
    `<button type="button" data-sel="search:${t.kind}">${esc(t.label)}</button>`).join('');
  if (grp) grp.hidden = tabs.length === 0;
}

/**
 * 字元級位置：`db?頁 j=起-止`（頁＋這一頁第幾個漢字；沒有頁 id 就用行號）。
 * 沒有頁的庫，`j` 是「這一行的第幾個漢字」。
 */
async function charPosition(info: SelInfo): Promise<string> {
  const db = reader?.header.dbname || 'db';
  if (!info.pageId) {
    const a = info.hanPrefix;
    const total = Array.from(info.raw).filter((c) => HAN_RE.test(c)).length;
    const b = info.endLine === info.startLine ? info.hanPrefixEnd : a + total;
    return `${db}?L${info.startLine} j=${a}-${b}`;
  }
  const [a, b] = await hanRange(info);
  return `${db}?${info.pageId} j=${a}-${b}`;
}

let addrRange = '';

/** 「複製高麗⇄大正位址」：起點-終點（只對 taisho／goryeo 有意義，需要對照表）。 */
async function fillAddress(info: SelInfo): Promise<void> {
  const m = $id('selMenu');
  if (!m) return;
  const btn = actOf(m, 'addr');
  if (btn) btn.hidden = true;
  addrRange = '';
  if (!mapSideOf(reader)) return;
  try {
    if (!(await mapPosMap())) return;
    const a = await addressAtLine(info.startLine, info.hanPrefix);
    const b = await addressAtLine(info.endLine, info.hanPrefixEnd);
    if (!a || !b || pending !== info) return;
    addrRange = `${formatAddress(a)}-${formatAddress(b)}`;
    if (btn) { btn.hidden = false; btn.title = addrRange; }
  } catch (e) {
    console.debug('addr range failed', e);
  }
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

/** 選單動作（第一層三組＋書籤）。動態產生的第二層項目也用同一個入口。 */
async function runAction(action: string): Promise<void> {
  const info = pending ?? await selectionInfo();
  if (!info) return;
  if (action.startsWith('search:')) {
    sendToTab(action.slice('search:'.length), info.text);
  } else if (action === 'bookmark') addBookmark(info);
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
  } else if (action === 'pos') {
    await copyText(await charPosition(info), '已複製字元級位置（頁＋漢字範圍）');
  } else if (action === 'addr' && addrRange) {
    await copyText(addrRange, '已複製高麗⇄大正位址範圍');
  } else if (action === 'dict') await openDictLookup(info.text);
  else if (action === 'plateT' && plateUrls.taisho) await openExternalUrl(plateUrls.taisho);
  else if (action === 'plateK' && plateUrls.goryeo) await openExternalUrl(plateUrls.goryeo);
  else if (action === 'sutra') {
    if (pendingRef) {
      await openTaishoAt('taisho', pendingRef, '大正 ' + pendingRef);
    } else if (sutraHit) {
      openForeignTab(sutraHit.db, sutraHit.pageVa ?? sutraHit.va, sutraHit.title, false, sutraHit.pageId);
      setStatus('右欄開啟《' + sutraHit.title + '》', 'info');
    }
  }
  hideMenu();
}

export function initBookmarks(): void {
  if (inited) return;
  inited = true;
  const menu = $id('selMenu');
  menu?.addEventListener('mousedown', (ev) => ev.preventDefault());

  // 動作都用事件委派：第二層的「搜尋」項目是每次開選單才長出來的
  menu?.addEventListener('click', (ev) => {
    const b = (ev.target as Element | null)?.closest<HTMLElement>('[data-sel]');
    if (!b) return;
    ev.stopPropagation();
    void runAction(b.dataset.sel ?? '');
  });

  // 第一層：滑過就開第二層；點一下也可以（觸控）。
  // 離開時延遲一點再收，讓游標有時間跨過兩層之間的空隙。
  let closeTimer: number | undefined;
  const scheduleClose = (): void => {
    window.clearTimeout(closeTimer);
    closeTimer = window.setTimeout(() => { if (menu) closeSubs(menu); }, 180);
  };
  menu?.querySelectorAll<HTMLElement>('.selGroup').forEach((g) => {
    const kind = g.dataset.grp ?? '';
    if (!kind) return;
    const btn = g.querySelector<HTMLButtonElement>('.selGroupBtn');
    g.addEventListener('mouseenter', () => {
      window.clearTimeout(closeTimer);
      if (menu) openSub(menu, kind);
    });
    g.addEventListener('mouseleave', scheduleClose);
    btn?.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (!menu) return;
      if (g.classList.contains('open')) closeSubs(menu);
      else openSub(menu, kind);
    });
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

