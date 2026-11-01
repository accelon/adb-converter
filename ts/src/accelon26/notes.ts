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

/**
 * 註／釋的位置索引（2026-10-31）。
 * adb 的 `tags` 已經有每一個 `<註>`／`<釋>` 的 VA，`attributes` 也有 `註.n`／`釋.n`；
 * 不必掃原文，直接查表（ys 有 28,000 行外的釋，掃原文要 >20 秒）。
 */
interface NoteIndex {
  /** n → `<註>` 的 VA（升冪） */
  refs: Map<string, number[]>;
  /** n → `<釋>` 的 VA（升冪） */
  bodies: Map<string, number[]>;
  /** `<頁>` 的 VA（升冪）與頁 id：給「同頁優先」的配對用 */
  pageVas: number[];
  pageIds: string[];
}
const noteIdxCache = new WeakMap<AdbReader, NoteIndex | null>();

async function noteIndexOf(r: AdbReader): Promise<NoteIndex | null> {
  if (noteIdxCache.has(r)) return noteIdxCache.get(r)!;
  const tagsC = r.containers.get('tags');
  if (!tagsC) { noteIdxCache.set(r, null); return null; }
  const idx: NoteIndex = { refs: new Map(), bodies: new Map(), pageVas: [], pageIds: [] };
  const build = async (tag: string, attr: string, into: Map<string, number[]>): Promise<void> => {
    const ti = tagsC.names.indexOf(tag);
    if (ti < 0) return;
    const av = await r.attributeValues(attr).catch(() => null);
    if (!av || !av.pointers) return;
    const vas = await r.decodeBlockList('tags', ti);
    for (let k = 0; k < av.values.length; k++) {
      const p = av.pointers[k];
      if (((p >>> 24) & 0xff) !== ti) continue;
      const va = vas[(p & 0xffffff) - 1];
      if (va == null) continue;
      const n = av.values[k];
      const arr = into.get(n);
      if (arr) arr.push(va); else into.set(n, [va]);
    }
  };
  await build('註', '註.n', idx.refs);
  await build('釋', '釋.n', idx.bodies);
  if (!idx.refs.size && !idx.bodies.size) { noteIdxCache.set(r, null); return null; }
  for (const arr of idx.refs.values()) arr.sort((a, b) => a - b);
  for (const arr of idx.bodies.values()) arr.sort((a, b) => a - b);
  // 頁標記（作者 2026-11-01）：註釋獨立成 <書> 之後，每個「節」的 n 都重來，
  // 只靠「最近的 n」會配到別節；用頁 id 把候選收斂到同一頁。
  const pi = tagsC.names.indexOf('頁');
  if (pi >= 0) {
    const av = await r.attributeValues('頁.id').catch(() => null);
    const vas = await r.decodeBlockList('tags', pi);
    const pairs: [number, string][] = [];
    if (av?.pointers) {
      for (let k = 0; k < av.values.length; k++) {
        const p = av.pointers[k];
        if (((p >>> 24) & 0xff) !== pi) continue;
        const va = vas[(p & 0xffffff) - 1];
        if (va == null) continue;
        pairs.push([va, av.values[k]]);
      }
    }
    pairs.sort((a, b) => a[0] - b[0]);
    idx.pageVas = pairs.map((x) => x[0]);
    idx.pageIds = pairs.map((x) => x[1]);
  }
  noteIdxCache.set(r, idx);
  return idx;
}

/** 這個 VA 落在哪一個 `<頁>`（沒有就空字串） */
function pageOfVa(idx: NoteIndex, va: number): string {
  const v = idx.pageVas;
  if (!v.length) return '';
  let lo = 0, hi = v.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (v[mid] <= va) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans >= 0 ? idx.pageIds[ans] : '';
}

/**
 * 從候選 VA 挑一個：同一頁優先；同頁之中 preferAfter 決定往後或往前取最近。
 * （作者 2026-11-01：註釋獨立成 `<書>` 之後，n 只在同一節唯一）
 */
function pickVa(idx: NoteIndex, vas: number[], fromVa: number, preferAfter: boolean): number {
  if (!vas.length) return -1;
  const pg = pageOfVa(idx, fromVa);
  const same = pg ? vas.filter((v) => pageOfVa(idx, v) === pg) : [];
  const pool = same.length ? same : vas;
  let lo = 0, hi = pool.length - 1, at = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (pool[mid] <= fromVa) { at = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (preferAfter) return at + 1 < pool.length ? pool[at + 1] : pool[pool.length - 1];
  return at >= 0 ? pool[at] : pool[0];
}

/** 行號 → 該行起點的 VA（`linesVirtual` 是升冪表） */
function vaOfLine(line: number): number {
  const v = mapper?.linesVirtual ?? [];
  if (!v.length) return 0;
  return v[Math.min(Math.max(0, line), v.length - 1)] ?? 0;
}

/** VA → 行號（最後一個 `linesVirtual <= va` 的行） */
function lineOfVa(va: number): number {
  const v = mapper?.linesVirtual ?? [];
  if (!v.length) return -1;
  let lo = 0, hi = v.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (v[mid] <= va) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

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

  // 有 tags/attributes 就查表（O(log n)），不必掃原文
  const idx = await noteIndexOf(r);
  if (idx) {
    const vas = idx.bodies.get(n);
    let hit: NoteHit | null = null;
    if (vas?.length) {
      const fromVa = vaOfLine(fromLine);
      const va = pickVa(idx, vas, fromVa, true);
      const line = lineOfVa(va);
      // tags 的 VA 與 linesVirtual 的行首 VA 可能差一兩行：在附近幾行找一次
      for (const d of [0, 1, -1, 2, -2]) {
        const l = line + d;
        if (l < 0 || l > last) continue;
        hit = await check(l);
        if (hit) break;
      }
    }
    memo.set(key, hit);
    return hit;
  }

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

  // 有 tags/attributes 就查表（2026-10-31）：找「最近的註」，不必掃原文
  const idx = await noteIndexOf(r);
  if (idx) {
    const vas = idx.refs.get(n);
    let found = -1;
    if (vas?.length) {
      const fromVa = vaOfLine(fromLine);
      const va = pickVa(idx, vas, fromVa, false);
      const line = lineOfVa(va);
      for (const d of [0, 1, -1, 2, -2]) {
        const l = line + d;
        if (l < 0 || l > last) continue;
        if (await check(l)) { found = l; break; }
      }
    }
    if (found >= 0) memo.set(key, { line: found, text: '' });
    return found;
  }

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

/** HTML 轉義（提示框用 innerHTML） */
function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * 用到這個 `<註>` 的那一句（作者 2026-11-01）：
 * 從註記號往前往後找到句末標點（。？！），讓讀者不必點回正文就知道上下文。
 */
function contextSentence(ref: HTMLElement): string {
  const line = ref.closest('.docLine') as HTMLElement | null;
  if (!line) return '';
  const w = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
  let text = '';
  let at = -1;
  for (let nd = w.nextNode(); nd; nd = w.nextNode()) {
    if (at < 0 && (nd === ref || ref.contains(nd))) at = text.length;
    if (ref.contains(nd)) continue;            // 不要把手註編號 [17] 帶進原文
    text += nd.nodeValue ?? '';
  }
  if (!text.trim()) return '';
  const TERM = /[。？！?!]/;
  const pos = at < 0 ? text.length : Math.min(at, text.length);
  // 往前找句首：記號若緊接在句末之後，再往前多吃一句
  let k = pos - 1;
  if (k >= 0 && TERM.test(text[k])) k--;
  let start = 0;
  for (; k >= 0; k--) if (TERM.test(text[k])) { start = k + 1; break; }
  // 這一行以內：句首到記號，加上記號之後到句末（沒有句末就整段）
  const rest = text.slice(pos);
  const m = TERM.exec(rest);
  let ctx = text.slice(start, pos) + (m ? rest.slice(0, m.index + 1) : rest);
  ctx = ctx.replace(/\s+/g, ' ').trim();
  // 句子跨行：往下一直接到句末（最多 3 行、160 字）
  let el = line.nextElementSibling as HTMLElement | null;
  for (let i = 0; i < 3 && el && ctx.length < 160 && !(ctx && TERM.test(ctx.slice(-1))); i++) {
    const t = (el.textContent ?? '').replace(/\s+/g, ' ');
    const mm = TERM.exec(t);
    ctx += mm ? t.slice(0, mm.index + 1) : t;
    el = el.nextElementSibling as HTMLElement | null;
  }
  return ctx.trim();
}

/**
 * `<釋>` hover 時顯示的「原文那句」（作者 2026-11-01）。
 * 由釋找到對應的 `<註>`（findRef 先比同一頁），再把那一段原文抓出來，
 * 以句末標點（。？！）為界取整句；跨行會往下接。`<註>` 那邊的行為不變。
 */
async function noteContext(n: string, fromLine: number): Promise<string> {
  const r = reader;
  const m = mapper;
  if (!r || !m || fromLine < 0) return '';
  const line = await findRef(n, fromLine).catch(() => -1);
  if (line < 0) return '';
  const TERM = /[。？！?!]/;
  const first = Math.max(0, line - 1);
  const seg: string[] = [];
  let plain = '';
  for (let k = 0; k < 4; k++) {
    const t = await r.physicalText(m.lineStartOf(first + k), m.lineStartOf(first + k + 1)).catch(() => '');
    if (!t) break;
    seg.push(t);
    plain = seg.join('').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ');
    const idx = seg.join('').indexOf('<註 ');
    if (idx >= 0) {
      const after = seg.join('').slice(idx).replace(/<[^>]*>/g, '');
      if (TERM.test(after)) break;      // 註之後已經遇到句末，夠了
    }
  }
  const raw = seg.join('');
  const idx = raw.indexOf('<註 ');
  if (idx < 0) return '';
  const before = raw.slice(0, idx).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ');
  const pos = Math.min(before.length, plain.length);
  let start = 0;
  let k2 = pos - 1;
  if (k2 >= 0 && TERM.test(plain[k2])) k2--;
  for (; k2 >= 0; k2--) if (TERM.test(plain[k2])) { start = k2 + 1; break; }
  let end = plain.length;
  for (let i = pos; i < plain.length; i++) if (TERM.test(plain[i])) { end = i + 1; break; }
  return plain.slice(start, end).trim();
}

/** hover `<釋>` 開頭的 [n]：浮出「原文那句」 */
async function showNoteContext(ref: HTMLElement): Promise<void> {
  const n = ref.dataset.note;
  const tip = tipEl();
  const from = lineOf(ref);
  if (!n || !tip || from < 0) return;
  if (tipFor === ref && !tip.hidden) return;
  tipFor = ref;
  window.clearTimeout(hideTimer);
  tip.hidden = false;
  tip.textContent = '讀取中…';
  placeTip(ref, tip);
  const ctx = await noteContext(n, from);
  if (tipFor !== ref || tip.hidden) return;
  tip.innerHTML = ctx
    ? `<div class="noteCtx">${escHtml(ctx)}</div>`
    : '<div class="noteBody">（找不到對應的註）</div>';
  placeTip(ref, tip);
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

/**
 * 跳到目標行後閃一下（作者 2026-10-31：註↔釋往返不要讓讀者用眼睛找）。
 * 行加 `.noteTarget`，編號加 `.noteTargetMark`，2.6 秒後自動移除。
 */
function flashTarget(line: number, mark?: HTMLElement | null): void {
  requestAnimationFrame(() => {
    const row = document.getElementById('L' + line);
    if (row) {
      row.classList.remove('noteTarget');
      void (row as HTMLElement).offsetWidth;   // 重新觸發動畫
      row.classList.add('noteTarget');
      window.setTimeout(() => row.classList.remove('noteTarget'), 2600);
      const num = mark ?? row.querySelector<HTMLElement>('a.noteRef, a.noteBack');
      if (num) {
        num.classList.remove('noteTargetMark');
        void num.offsetWidth;
        num.classList.add('noteTargetMark');
        window.setTimeout(() => num.classList.remove('noteTargetMark'), 2600);
      }
    }
  });
}

async function jumpToBody(ref: HTMLElement): Promise<void> {
  const n = ref.dataset.note ?? '';
  const from = lineOf(ref);
  hideTip();
  if (!n || from < 0 || !mapper) return;
  const hit = await findBody(n, from);
  if (!hit) { setStatus(`找不到 <釋 n="${n}">`, 'warn'); return; }
  await revealDocLine(hit.line);
  flashTarget(hit.line);
}

async function jumpToRef(body: HTMLElement): Promise<void> {
  const n = body.dataset.note ?? '';
  const from = lineOf(body);
  hideTip();
  if (!n || from < 0 || !mapper) return;
  const line = await findRef(n, from);
  if (line < 0) { setStatus(`找不到 <註 n="${n}">`, 'warn'); return; }
  await revealDocLine(line);
  flashTarget(line);
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
  // 作者 2026-10-31：釋文本身**不要**接受點擊（讀者要選字、複製），
  // 只有開頭的編號 `[37.085]`（a.noteBack）點下去才回本文的 `<註>`。
  const back = t.closest('a.noteBack') as HTMLElement | null;
  if (!back) return;
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
    const t = ev.target as Element | null;
    const ref = t?.closest?.('a.noteRef') as HTMLElement | null;
    if (ref) { void showTip(ref); return; }
    const back = t?.closest?.('a.noteBack') as HTMLElement | null;
    if (back) void showNoteContext(back);
  });
  document.addEventListener('mouseout', (ev) => {
    const t = ev.target as Element | null;
    const a = (t?.closest?.('a.noteRef') ?? t?.closest?.('a.noteBack')) as HTMLElement | null;
    if (a && a === tipFor) scheduleHide();
  });
  // 頁面捲動／換頁後提示的位置就不對了，直接收起來（提示框自己捲動不算）
  document.addEventListener('scroll', (ev) => {
    if ((ev.target as Element | null)?.closest?.('#noteTip')) return;
    hideTip();
  }, true);
  document.addEventListener('click', onClick, true);
}
