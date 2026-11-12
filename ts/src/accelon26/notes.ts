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
import { docSession, markLineRange, revealDocLine } from './doc-pane';
import { ancestorTrail, currentNodeAt } from './scopes';
import { noteLabel } from './note-label';
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
  /** `<註>`／`<釋>` 的 VA → 資料自己帶的頁 id（`pg="…"`；作者 2026-11-01） */
  refPg: Map<number, string>;
  bodyPg: Map<number, string>;
  /** `<頁>` 的 VA（升冪）與頁 id：給「同頁優先」的配對用 */
  pageVas: number[];
  pageIds: string[];
}
const noteIdxCache = new WeakMap<AdbReader, NoteIndex | null>();

async function noteIndexOf(r: AdbReader): Promise<NoteIndex | null> {
  if (noteIdxCache.has(r)) return noteIdxCache.get(r)!;
  const tagsC = r.containers.get('tags');
  if (!tagsC) { noteIdxCache.set(r, null); return null; }
  const idx: NoteIndex = {
    refs: new Map(), bodies: new Map(), refPg: new Map(), bodyPg: new Map(), pageVas: [], pageIds: [],
  };
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
  /** 頁 id 屬性（`註.pg`／`釋.pg`）→ VA → pg。沒有這個屬性就空表（ys／taisho／fuyan） */
  const buildPg = async (tag: string, attr: string, into: Map<number, string>): Promise<void> => {
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
      const pg = av.values[k];
      if (pg) into.set(va, pg);
    }
  };
  await build('註', '註.n', idx.refs);
  await build('釋', '釋.n', idx.bodies);
  await buildPg('註', '註.pg', idx.refPg);
  await buildPg('釋', '釋.pg', idx.bodyPg);
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

/** 這個 VA 落在第幾個 `<頁>`（-1＝在任何頁標記之前） */
function pageIndexAt(idx: NoteIndex, va: number): number {
  const v = idx.pageVas;
  if (!v.length) return -1;
  let lo = 0, hi = v.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (v[mid] <= va) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/** 這個 VA 落在哪一個 `<頁>`（沒有就空字串） */
function pageOfVa(idx: NoteIndex, va: number): string {
  const at = pageIndexAt(idx, va);
  return at >= 0 ? idx.pageIds[at] : '';
}

/**
 * 讀「這一端」的 pg：`dir='body'` 時我們手上是一個 `<註>`，要拿它自己的 `pg="…"`。
 *
 * `fromVa` 是行首的 VA（`vaOfLine`），不一定等於標籤的 VA，所以用**行號**去找同一行的
 * 那個標籤（差一行以內都算），再查它的 pg。沒有 pg 的庫（ys／taisho／fuyan）回空字串。
 */
function pgAtLine(
  own: number[] | undefined, ownPg: Map<number, string>, line: number,
): string {
  if (!own?.length || !ownPg.size || line < 0) return '';
  let best = '', bestD = Number.POSITIVE_INFINITY;
  for (const va of own) {
    const p = ownPg.get(va);
    if (!p) continue;
    const d = Math.abs(lineOfVa(va) - line);
    if (d < bestD) { bestD = d; best = p; }
    if (d === 0) break;
  }
  return bestD <= 1 ? best : '';
}

/** 快取 key 用的「這一頁」：優先用資料自己的 pg，沒有才用 `<頁>` 推出來的頁 id */
function pageKeyOf(
  idx: NoteIndex, dir: 'body' | 'ref', n: string, fromVa: number, fromLine: number,
): string {
  const own = dir === 'body' ? idx.refs.get(n) : idx.bodies.get(n);
  const ownPg = dir === 'body' ? idx.refPg : idx.bodyPg;
  return pgAtLine(own, ownPg, fromLine) || pageOfVa(idx, fromVa);
}

/**
 * 同一個 n 有多條時，怎麼配對（作者 2026-11-01 定案）。
 *
 * yl38 這種「每節重新編號」的庫，`n=45` 有 9 條 `<註>` 與 9 條 `<釋>`，**只有 `pg` 相同
 * 的那一條是同一節**。所以：
 *
 *   1. **有 `pg` 且相同 → 直接取**（資料自己帶的頁 id，最可靠）
 *   2. 否則**同頁**（由 `<頁>` 的 VA 推）最近一條
 *   3. 否則 n 相同、**離目前頁最近**的那條（平手取後面）
 *
 * 為什麼不能只靠 (2)：頁標記常落在段落之前，引用那條推出來的頁可能比釋文多一頁
 * （yl38p25 的 `<註>` 對的是 yl38p24 的 `<釋>`），同頁候選就空了；而一味取 VA 最近，
 * 會一律抓到釋群的第一條（＝第一章），正是作者看到「hover 顯示第四章第六節」的原因。
 *
 * **hover 與點擊都走這一個函式**（`findBody`／`findRef`），所以兩邊不可能不一致。
 * 沒有 pg 的庫自動退化到 (2)(3)，行為與以前相同。
 */
function pickNote(
  idx: NoteIndex, dir: 'body' | 'ref', n: string, fromVa: number, fromLine: number,
): { va: number; how: 'pg' | 'page' | 'pageNear' | 'nearest' } | null {
  const target = dir === 'body' ? idx.bodies.get(n) : idx.refs.get(n);
  const own = dir === 'body' ? idx.refs.get(n) : idx.bodies.get(n);
  const ownPg = dir === 'body' ? idx.refPg : idx.bodyPg;
  const targetPg = dir === 'body' ? idx.bodyPg : idx.refPg;
  if (!target || !target.length) return null;
  const nearestIn = (list: number[], va: number, after: boolean): number => {
    let lo = 0, hi = list.length - 1, at = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid] <= va) { at = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (after) return at + 1 < list.length ? list[at + 1] : list[list.length - 1];
    return at >= 0 ? list[at] : list[0];
  };
  // (1) 資料自己的 pg（yl38：`<註 n="45" pg="yl38p24"/>` ↔ `<釋 n="45" pg="yl38p24">`）
  const fromPg = pgAtLine(own, ownPg, fromLine);
  if (fromPg) {
    const samePg = target.filter((v) => targetPg.get(v) === fromPg);
    if (samePg.length) return { va: nearestIn(samePg, fromVa, dir === 'body'), how: 'pg' };
  }
  // (2) 同頁（由 <頁> 的 VA 推）
  const pg = pageOfVa(idx, fromVa);
  const samePage = pg ? target.filter((v) => pageOfVa(idx, v) === pg) : [];
  if (samePage.length) return { va: nearestIn(samePage, fromVa, dir === 'body'), how: 'page' };
  // (3) n 相同、離目前頁最近（平手取後面那條）
  const pi = pageIndexAt(idx, fromVa);
  if (pi >= 0) {
    let best = -1, bestD = Number.POSITIVE_INFINITY;
    for (const v of target) {
      const q = pageIndexAt(idx, v);
      if (q < 0) continue;
      const d = Math.abs(q - pi);
      if (d < bestD || (d === bestD && q >= pi)) { best = v; bestD = d; }
    }
    if (best >= 0) return { va: best, how: 'pageNear' };
  }
  return { va: nearestIn(target, fromVa, dir === 'body'), how: 'nearest' };
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
  const idx = await noteIndexOf(r);
  // 快取 key 要含頁 id：同一個 n 在不同節是不同的釋，只靠行號會跨節誤用（作者 2026-11-01）
  const key = 'b:' + n + ':' + (idx ? pageKeyOf(idx, 'body', n, vaOfLine(fromLine), fromLine) : '') + ':' + fromLine;
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
  if (idx) {
    let hit: NoteHit | null = null;
    const pick = pickNote(idx, 'body', n, vaOfLine(fromLine), fromLine);
    if (pick) {
      const line = lineOfVa(pick.va);
      // tags 的 VA 與 linesVirtual 的行首 VA 可能差一兩行：在附近幾行找一次
      for (const d of [0, 1, -1, 2, -2]) {
        const l = line + d;
        if (l < 0 || l > last) continue;
        hit = await check(l);
        if (hit) break;
      }
      // `<釋 n="1"/>` 標籤自成一行、注文在後面幾行：再往後找幾行
      for (let l = line + 3; !hit && l <= Math.min(last, line + 8); l++) hit = await check(l);
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
  const idx = await noteIndexOf(r);
  const key = 'r:' + n + ':' + (idx ? pageKeyOf(idx, 'ref', n, vaOfLine(fromLine), fromLine) : '') + ':' + fromLine;
  const cached = memo.get(key);
  if (cached) return cached.line;
  const last = r.header.lineCount - 1;

  const check = async (i: number): Promise<boolean> => {
    const line = await m.lineText(i);
    if (!line || line.indexOf('<' + '註') < 0) return false;
    return !!noteTagAt(line, '註', n);
  };

  // 有 tags/attributes 就查表（2026-10-31）：不必掃原文
  // 與 findBody 共用同一套配對（第 k 條釋 ↔ 第 k 條註；同頁優先）
  if (idx) {
    let found = -1;
    const pick = pickNote(idx, 'ref', n, vaOfLine(fromLine), fromLine);
    if (pick) {
      const line = lineOfVa(pick.va);
      // 窗口 ±8：圖表裡好幾個注號會排成一列（05B 的 p35–36 表有五個），
      // 標籤的 VA 會全部落在緊接的 `<圖>` 那一行，±2 就找不回上面那幾行
      // （厚觀法師 2026-11-12：點釋文編號要回得到圖上的注號）。
      for (const d of [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6, 7, -7, 8, -8]) {
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
async function noteContext(n: string, fromLine: number): Promise<{ crumb: string; html: string }> {
  const r = reader;
  const m = mapper;
  if (!r || !m || fromLine < 0) return { crumb: '', html: '' };
  const line = await findRef(n, fromLine).catch(() => -1);
  if (line < 0) return { crumb: '', html: '' };
  const TERM = /[。？！?!]/;
  const first = Math.max(0, line - 1);
  const seg: string[] = [];
  for (let k = 0; k < 4; k++) {
    const t = await r.physicalText(m.lineStartOf(first + k), m.lineStartOf(first + k + 1)).catch(() => '');
    if (!t) break;
    seg.push(t);
    const rawSoFar = seg.join('');
    const idx = rawSoFar.indexOf('<註 ');
    if (idx >= 0) {
      const after = rawSoFar.slice(idx).replace(/<[^>]*>/g, '');
      if (TERM.test(after)) break;
    }
  }
  const raw = seg.join('');
  // 逐字走一遍：建立「純文字索引 → 原始索引」對照，順便記下每個 <註> 的位置
  const plainAt: number[] = [];
  const noteMarks: { plain: number; n: string }[] = [];
  let plain = '';
  for (let i = 0; i < raw.length; ) {
    if (raw[i] === '<') {
      const gt = raw.indexOf('>', i);
      if (gt < 0) break;
      const tag = raw.slice(i, gt + 1);
      const nm = /<註[\s/>][^>]*?\bn\s*=\s*"([^"]*)"/.exec(tag);
      if (nm) noteMarks.push({ plain: plain.length, n: nm[1] });
      i = gt + 1;
      continue;
    }
    const cp = raw.codePointAt(i) ?? 0;
    const ch = String.fromCodePoint(cp);
    if (!/\s/.test(ch)) {
      plainAt.push(i);
      plain += ch;
    }
    i += cp > 0xffff ? 2 : 1;
  }
  const target = noteMarks.find((x) => x.n === n);
  if (!target) return { crumb: '', html: '' };
  const pos = Math.min(target.plain, plain.length);
  let start = 0;
  let k2 = pos - 1;
  if (k2 >= 0 && TERM.test(plain[k2])) k2--;
  for (; k2 >= 0; k2--) if (TERM.test(plain[k2])) { start = k2 + 1; break; }
  let end = plain.length;
  for (let i = pos; i < plain.length; i++) if (TERM.test(plain[i])) { end = i + 1; break; }
  const rawStart = plainAt[start] ?? 0;
  const rawEnd = end < plainAt.length ? plainAt[end] : raw.length;
  // 這一段原始文字：<註 n> 換成標記（目標那個高亮），其他標籤丟掉
  const piece = raw.slice(rawStart, rawEnd);
  let html = '';
  let i2 = 0;
  while (i2 < piece.length) {
    if (piece[i2] === '<') {
      const gt = piece.indexOf('>', i2);
      if (gt < 0) break;
      const tag = piece.slice(i2, gt + 1);
      const nm = /<註[\s/>][^>]*?\bn\s*=\s*"([^"]*)"/.exec(tag);
      if (nm) {
        const mark = nm[1] === n ? ' noteCtxMark' : '';
        html += `<span class="noteCtxRef${mark}">[${escHtml(nm[1])}]</span>`;
      }
      i2 = gt + 1;
      continue;
    }
    const cp2 = piece.codePointAt(i2) ?? 0;
    html += escHtml(String.fromCodePoint(cp2));
    i2 += cp2 > 0xffff ? 2 : 1;
  }
  // 句首常殘留前一句的收尾引號／括號（」，）」，去掉
  const body = html.trim().replace(/^[」』）】》〉〕］”’]+/, '').trim();
  // 作者 2026-11-02：順便回傳這個註所在那一段的 breadcrumb（不必下拉），
  // 讓讀者知道這條注釋屬於哪一節；由 `showNoteContext` 放在原文上方。
  return { crumb: noteCrumb(line), html: body };
}

/**
 * 某一行所在的目錄路徑（書 › 章 › 節…）：hover `<釋>` 的原文提示用（作者 2026-11-02）。
 * 只取左欄那一庫的樹（跨庫分頁時樹不是它的，回空字串＝不顯示）。
 */
function noteCrumb(line: number): string {
  const v = mapper?.linesVirtual ?? [];
  if (!v.length || line < 0) return '';
  const va = v[Math.min(line, v.length - 1)] ?? 0;
  const anc = ancestorTrail(va);
  const self = currentNodeAt(va);
  const labels = anc.map((a) => a.label);
  if (self && (!anc.length || anc[anc.length - 1].va !== self.va)) labels.push(self.label);
  return labels.filter(Boolean).join(' › ');
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
  const { crumb, html } = await noteContext(n, from);
  if (tipFor !== ref || tip.hidden) return;
  tip.innerHTML = html
    ? (crumb ? `<div class="noteCrumb">${escHtml(crumb)}</div>` : '') + `<div class="noteCtx">${html}</div>`
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
  tip.textContent = hit?.text || `找不到 <釋 n="${noteLabel(n)}">`;
  placeTip(ref, tip);
}

/**
 * 跳躍目標「看得到的」那一列。圖前那行 `[13][14]…` 在圖自己帶注號之後會收起來
 * （`display:none`，見 doc-pane 的 noteRowsToHide），那一列沒有版面、捲不動，
 * 所以往下找第一個有版面的兄弟（就是那張圖）——讀者眼裡「跳回圖上」。
 */
function rowForScroll(line: number): HTMLElement | null {
  const row = document.getElementById('L' + line);
  if (!row) return null;
  if (row.getClientRects().length) return row;
  let el: Element | null = row;
  while ((el = el.nextElementSibling)) {
    if ((el as HTMLElement).getClientRects?.().length) return el as HTMLElement;
  }
  return row;
}

/**
 * 找「跟這一列同一張圖」的注號。落點若是圖前那行 `[13][14]…`（法師 2026-11-12
 * 15:07 要求顯示出來），圖通常在一兩塊之內的下方；真的找不到就退到同一頁容器裡的第一個。
 */
function svgNumsNear(row: HTMLElement, sel: string): HTMLElement[] {
  const own = [...row.querySelectorAll<HTMLElement>(sel)];
  if (own.length) return own;
  let el: Element | null = row;
  for (let i = 0; i < 6 && (el = el.nextElementSibling); i++) {
    const hit = [...(el as HTMLElement).querySelectorAll<HTMLElement>(sel)];
    if (hit.length) return hit;
  }
  const box = row.closest('.docBody') ?? row.parentElement;
  return box ? [...box.querySelectorAll<HTMLElement>(sel)] : [];
}

/**
 * 跳到目標行後閃一下（作者 2026-10-31：註↔釋往返不要讓讀者用眼睛找）。
 * 行加 `.noteTarget`，編號加 `.noteTargetMark`，2.6 秒後自動移除。
 */
function flashTarget(line: number, mark?: HTMLElement | null, note?: string): void {
  requestAnimationFrame(() => {
    const row = rowForScroll(line);
    if (row) {
      row.classList.remove('noteTarget');
      void (row as HTMLElement).offsetWidth;   // 重新觸發動畫
      row.classList.add('noteTarget');
      window.setTimeout(() => row.classList.remove('noteTarget'), 12000);
      const num = mark ?? row.querySelector<HTMLElement>('a.noteRef, a.noteBack');
      if (num) {
        num.classList.remove('noteTargetMark');
        void num.offsetWidth;
        num.classList.add('noteTargetMark');
        window.setTimeout(() => num.classList.remove('noteTargetMark'), 12000);
      }
      // 圖上的注號也要閃（厚觀法師 2026-11-12：點釋文的編號要回得到圖上那個號）
      const svgSel = note ? `svg a.noteRef[data-note="${note}"]` : 'svg [data-note]';
      const svgNums = svgNumsNear(row, svgSel);
      for (const svgNum of svgNums) {
        svgNum.classList.remove('noteTargetMark');
        void (svgNum as unknown as HTMLElement).offsetWidth;
        svgNum.classList.add('noteTargetMark');
        window.setTimeout(() => svgNum.classList.remove('noteTargetMark'), 12000);
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
  if (!hit) { setStatus(`找不到 <釋 n="${noteLabel(n)}">`, 'warn'); return; }
  await revealDocLine(hit.line);
  flashTarget(hit.line, null, n);
}

async function jumpToRef(body: HTMLElement): Promise<void> {
  const n = body.dataset.note ?? '';
  const from = lineOf(body);
  hideTip();
  if (!n || from < 0 || !mapper) return;
  const line = await findRef(n, from);
  if (line < 0) { setStatus(`找不到 <註 n="${n}">`, 'warn'); return; }
  await revealDocLine(line);
  // 註號行若被收起（圖上自帶注號），捲到它下面那張圖
  requestAnimationFrame(() => rowForScroll(line)?.scrollIntoView({ block: 'center' }));
  flashTarget(line, null, n);
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
/**
 * 診斷（測試／開發用）：列出某個 n 的所有 `<註>`／`<釋>`、各自在哪一行哪一頁、帶什麼 pg。
 * 作者 2026-11-01 的驗收要「每個 n 在兩個不同節各測一次」，測試就靠這支挑頁。
 */
export async function notePagesOf(n: string): Promise<{
  refs: { va: number; line: number; page: string; pg: string }[];
  bodies: { va: number; line: number; page: string; pg: string }[];
} | null> {
  const r = reader;
  if (!r) return null;
  const idx = await noteIndexOf(r);
  if (!idx) return null;
  const list = (arr: number[] | undefined, pgs: Map<number, string>) =>
    (arr ?? []).map((va) => ({ va, line: lineOfVa(va), page: pageOfVa(idx, va), pg: pgs.get(va) ?? '' }));
  return { refs: list(idx.refs.get(n), idx.refPg), bodies: list(idx.bodies.get(n), idx.bodyPg) };
}

export { noteLabel };

/**
 * 「跳到註／釋」用：給註號（`11.001` 或完整的 `11.001@38`）→ 候選的**完整 key**。
 *
 * 有 `@` 就是完整 key（跨冊唯一）；只有章.註時，在目前這本書裡找標籤相同的 key。
 * 用 `[^…]` 前綴（Markdown 腳注寫法）就是為了**不與「跳到節點」（`1.2.3`）衝突**：
 * `11.001` 本身看起來就是目錄路徑，只有加上前綴才當成註號。
 */
export async function noteKeysOf(label: string): Promise<{ refs: string[]; bodies: string[] } | null> {
  const r = reader;
  if (!r) return null;
  const idx = await noteIndexOf(r);
  if (!idx) return null;
  const want = (label ?? '').trim();
  if (!want) return { refs: [], bodies: [] };
  const collect = (map: Map<string, number[]>): string[] => {
    const out: string[] = [];
    for (const key of map.keys()) {
      if (key === want) return [key];          // 完整 key：直接命中
      if (noteLabel(key) === want) out.push(key);
    }
    return out;
  };
  return { refs: collect(idx.refs), bodies: collect(idx.bodies) };
}

/**
 * 直接跳到某個註／釋（作者 2026-11-02 的 `[^11.001]` 語法）。
 *
 * `to='ref'` 跳正文的 `<註>`、`'body'` 跳 `<釋>`；同一個註號有多條時取**離目前行最近**
 * 的那一條（舊 adb 同號的情形），與「由近而遠」的配對規則一致。
 */
export async function jumpToNote(query: { key: string; to: 'ref' | 'body' }): Promise<boolean> {
  const r = reader;
  const m = mapper;
  if (!r || !m) return false;
  const idx = await noteIndexOf(r);
  if (!idx) { setStatus(`${r.header.dbname} 沒有 <註>／<釋>，不能跳到註`, 'warn'); return false; }
  const keys = await noteKeysOf(query.key);
  if (!keys) return false;
  const list = query.to === 'body' ? keys.bodies : keys.refs;
  if (!list.length) {
    setStatus(`找不到${query.to === 'body' ? '釋' : '註'} ${noteLabel(query.key)}`, 'warn');
    return false;
  }
  const cur = docSession();
  const fromLine = cur ? (cur.cache?.dt?.lineNumbers[0] ?? 0) : 0;
  const v = m.linesVirtual;
  const fromVa = v[Math.min(Math.max(0, fromLine), v.length - 1)] ?? 0;
  const vasOf = (key: string): number[] => (query.to === 'body' ? idx.bodies.get(key) : idx.refs.get(key)) ?? [];
  const nearest = (arr: number[]): number => arr.reduce((a, b) => (Math.abs(b - fromVa) < Math.abs(a - fromVa) ? b : a), arr[0]);
  let bestKey = list[0];
  let bestD = Number.POSITIVE_INFINITY;
  for (const key of list) {
    const arr = vasOf(key);
    if (!arr.length) continue;
    const d = Math.abs(nearest(arr) - fromVa);
    if (d < bestD) { bestD = d; bestKey = key; }
  }
  const va = nearest(vasOf(bestKey));
  if (va === undefined) { setStatus(`找不到註 ${noteLabel(query.key)}`, 'warn'); return false; }
  const line = lineOfVa(va);
  await revealDocLine(line);
  markLineRange(line, line);
  setStatus(`${query.to === 'body' ? '釋' : '註'} ${noteLabel(bestKey)}`, 'info');
  return true;
}

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
