/**
 * 腳注連動（作者 2026-10-26）
 *
 * Accelon3 的 `<註 n="1"/>` 與 `<釋 n="1">…</釋>` 用 `n` 對應，像 Markdown 的腳注：
 *   * hover `<註>` → 顯示 `<釋>` 包住的文字（浮動提示，可捲動）。
 *   * 點 `<註>` → 捲到對應的 `<釋>`；點 `<釋>`（或它開頭的編號）→ 捲回 `<註>`。
 *
 * 註文有兩種寫法（見 render_accelon3.ts）：
 *   * `<釋 n="1">…</釋>`（manual.adb，可跨行）
 *   * `<釋 n="1"/>　注文`（thonzu.adb，注文在同一行標籤後面）
 *
 * 找對應的 `釋`／`註` 時**由近而遠**掃描來源行（先往後找注文、先往前找引用），
 * 所以同一本書裡每個章節重新編號（n=1 出現很多次）也不會抓錯。掃描結果依
 * 「檔＋n＋起始行」快取；換庫時 WeakMap 自然失效。
 */
import { decodeXmlEntities } from '../xml-entities';
import { mapper, reader, setStatus } from './viewer';
import { revealDocLine } from './doc-pane';
import type { AdbReader } from './adb';

interface NoteHit {
  /** 0-based 來源行 */
  line: number;
  /** 去掉標籤、解過實體的注文 */
  text: string;
}

/** 最多往前／往後掃這麼多行就放棄（正常注文都在引用附近幾十行內） */
const SCAN_MAX = 200000;

const cache = new WeakMap<AdbReader, Map<string, NoteHit | null>>();

/** 文字裡的標籤／實體 → 純文字（提示框用） */
function plain(s: string): string {
  return decodeXmlEntities(s.replace(/<[^>]*>/g, ''))
    .replace(/\u3000/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 這一行裡找 `<tag … n="n" …>`；回傳標籤結束位置與是否自閉合 */
function noteTagAt(line: string, tag: string, n: string): { end: number; selfClose: boolean } | null {
  const re = new RegExp('<' + tag + '(\\s[^>]*)?>', 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    const attrs = m[1] ?? '';
    const nm = /\bn\s*=\s*"([^"]*)"/.exec(attrs) ?? /\bn\s*=\s*'([^']*)'/.exec(attrs);
    if (!nm || decodeXmlEntities(nm[1]) !== n) continue;
    return { end: m.index + m[0].length, selfClose: /\/\s*$/.test(attrs) };
  }
  return null;
}

function cacheOf(r: AdbReader): Map<string, NoteHit | null> {
  let m = cache.get(r);
  if (!m) { m = new Map(); cache.set(r, m); }
  return m;
}

const tick = (): Promise<void> => new Promise((res) => setTimeout(res, 0));

/** 找 `n` 對應的 `<釋>`：先往後（注文通常在引用之後），再往前 */
async function findBody(n: string, fromLine: number): Promise<NoteHit | null> {
  const r = reader;
  const m = mapper;
  if (!r || !m || fromLine < 0) return null;
  const memo = cacheOf(r);
  const key = 'b:' + n + ':' + fromLine;
  if (memo.has(key)) return memo.get(key)!;
  const last = r.header.lineCount - 1;

  const check = async (i: number): Promise<NoteHit | null> => {
    const line = await m.lineText(i);
    if (!line || line.indexOf('<釋') < 0) return null;
    const t = noteTagAt(line, '釋', n);
    if (!t) return null;
    let text = line.slice(t.end);
    if (!t.selfClose) {
      let j = i;
      while (text.indexOf('</釋>') < 0 && j < last && j - i < 80) {
        j++;
        text += (await m.lineText(j)) ?? '';
      }
      const cut = text.indexOf('</釋>');
      if (cut >= 0) text = text.slice(0, cut);
    }
    return { line: i, text: plain(text) };
  };

  let hit: NoteHit | null = null;
  for (let i = fromLine; i <= Math.min(last, fromLine + SCAN_MAX) && !hit; i++) {
    hit = await check(i);
    if ((i - fromLine) % 1000 === 999) await tick();
  }
  for (let i = fromLine - 1; i >= Math.max(0, fromLine - SCAN_MAX) && !hit; i--) {
    hit = await check(i);
    if ((fromLine - 1 - i) % 1000 === 999) await tick();
  }
  memo.set(key, hit);
  return hit;
}

/** 找 `n` 對應的 `<註>`：先往前（引用在注文之前），再往後；找不到回 -1 */
async function findRef(n: string, fromLine: number): Promise<number> {
  const r = reader;
  const m = mapper;
  if (!r || !m || fromLine < 0) return -1;
  const memo = cacheOf(r);
  const key = 'r:' + n + ':' + fromLine;
  const cached = memo.get(key);
  if (cached) return cached.line;
  const last = r.header.lineCount - 1;

  const check = async (i: number): Promise<boolean> => {
    const line = await m.lineText(i);
    if (!line || line.indexOf('<' + '註') < 0) return false;
    return !!noteTagAt(line, '註', n);
  };

  let found = -1;
  for (let i = fromLine; i >= Math.max(0, fromLine - SCAN_MAX) && found < 0; i--) {
    if (await check(i)) found = i;
    if ((fromLine - i) % 1000 === 999) await tick();
  }
  for (let i = fromLine + 1; i <= Math.min(last, fromLine + SCAN_MAX) && found < 0; i++) {
    if (await check(i)) found = i;
    if ((i - fromLine) % 1000 === 999) await tick();
  }
  if (found >= 0) memo.set(key, { line: found, text: '' });
  return found;
}

/** 元素在本文的哪一行（`L123`）；不在本文（例如摘要卡）回 -1 */
function lineOf(el: Element): number {
  const row = el.closest('.docLine') as HTMLElement | null;
  if (!row) return -1;
  const n = Number(row.id.replace(/^L/, ''));
  return Number.isFinite(n) ? n : -1;
}

let bound = false;
let tipFor: HTMLElement | null = null;
let hideTimer = 0;

function tipEl(): HTMLElement | null {
  return document.getElementById('noteTip');
}

function placeTip(ref: HTMLElement, tip: HTMLElement): void {
  const r = ref.getBoundingClientRect();
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2));
  let top = r.top - h - 8;
  if (top < 8) top = r.bottom + 8;
  tip.style.left = left + 'px';
  tip.style.top = top + 'px';
}

function hideTip(): void {
  const tip = tipEl();
  tipFor = null;
  if (!tip || tip.hidden) return;
  tip.hidden = true;
  tip.textContent = '';
}

function scheduleHide(): void {
  window.clearTimeout(hideTimer);
  hideTimer = window.setTimeout(hideTip, 240);
}

async function showTip(ref: HTMLElement): Promise<void> {
  const n = ref.dataset.note;
  const tip = tipEl();
  const from = lineOf(ref);
  if (!n || !tip || from < 0) return;
  if (tipFor === ref && !tip.hidden) return;   // 在同一个註裡移動：不要重設
  tipFor = ref;
  window.clearTimeout(hideTimer);
  tip.hidden = false;
  tip.textContent = '讀取中…';
  placeTip(ref, tip);
  const hit = await findBody(n, from);
  if (tipFor !== ref || tip.hidden) return;
  tip.textContent = hit?.text || `找不到 <釋 n="${n}">`;
  placeTip(ref, tip);
}

async function jumpToBody(ref: HTMLElement): Promise<void> {
  const n = ref.dataset.note ?? '';
  const from = lineOf(ref);
  hideTip();
  if (!n || from < 0 || !mapper) return;
  const hit = await findBody(n, from);
  if (!hit) { setStatus(`找不到 <釋 n="${n}">`, 'warn'); return; }
  await revealDocLine(hit.line);
}

async function jumpToRef(body: HTMLElement): Promise<void> {
  const n = body.dataset.note ?? '';
  const from = lineOf(body);
  hideTip();
  if (!n || from < 0 || !mapper) return;
  const line = await findRef(n, from);
  if (line < 0) { setStatus(`找不到 <註 n="${n}">`, 'warn'); return; }
  await revealDocLine(line);
}

function onClick(ev: MouseEvent): void {
  const t = ev.target as Element | null;
  if (!t) return;
  const ref = t.closest('a.noteRef') as HTMLElement | null;
  if (ref) {
    ev.preventDefault();
    ev.stopPropagation();
    void jumpToBody(ref);
    return;
  }
  const body = t.closest('.noteBody') as HTMLElement | null;
  if (!body) return;
  // 注文裡的詞條連結、插圖照常運作；有選取（正在複製）也不要跳
  if (t.closest('a[data-entry], img.inlineImg')) return;
  if (t.closest('a[href]') && !t.closest('a.noteBack')) return;
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed) return;
  ev.preventDefault();
  ev.stopPropagation();
  void jumpToRef(body);
}

/** 文件區的委派監聽（只綁一次）：hover 出提示、點擊互相跳轉 */
export function initNoteLinks(): void {
  if (bound) return;
  bound = true;
  const tip = tipEl();
  tip?.addEventListener('mouseenter', () => window.clearTimeout(hideTimer));
  tip?.addEventListener('mouseleave', scheduleHide);
  document.addEventListener('mouseover', (ev) => {
    const a = (ev.target as Element | null)?.closest?.('a.noteRef') as HTMLElement | null;
    if (a) void showTip(a);
  });
  document.addEventListener('mouseout', (ev) => {
    const a = (ev.target as Element | null)?.closest?.('a.noteRef') as HTMLElement | null;
    if (a && a === tipFor) scheduleHide();
  });
  // 頁面捲動／換頁後提示的位置就不對了，直接收起來（提示框自己捲動不算）
  document.addEventListener('scroll', (ev) => {
    if ((ev.target as Element | null)?.closest?.('#noteTip')) return;
    hideTip();
  }, true);
  document.addEventListener('click', onClick, true);
}
