/**
 * 閱讀態「假光標 + 鍵盤導航 + Shift 選取」（作者 2026-11-22/24）。
 *
 * 只要假光標、不編輯；#docText 取得 focus 自動開啟、失去 focus 不消失、點擊 docText 移動光標；
 * ←→↑↓ / PgUp/PgDn / Home/End 移動、Shift+鍵選取。刻意不用 contenteditable（會動搖整個
 * getSelection/caretRangeFromPoint 座標模型）。光標＝原生 Selection 折疊 Range + 自繪豎線；
 * Shift 用 selection.extend() 產生真實選區 → 現有引用/掃描/注號全部讀 getSelection() 自動兼容。
 *
 * 2026-11-24 迭代：
 *  (1)(2) ↑↓ 改為「幾何找上/下方最近 DOM 行 → caretRangeFromPoint 吸附最接近的可停靠字元」，
 *         不再用 line±1（修「善現 p.348 按 ↓ 沒作用」——腳注版面 line+1 未必存在）。
 *  (3) 閃爍改純 CSS 淡入淡出（無 JS timer）。
 *  (5) 連按方向鍵時光標恆亮（加 .solid 停動畫），閒置 600ms 才恢復淡入淡出。
 *  (4) 粗細/顏色由 CSS 變數 --caret-w / --caret-color 控制（設置→閱讀 可調，見 ui.ts）。
 *
 * 刻意不 import viewer（避免新增 import 循環）。
 */

let bound = false;
let bar: HTMLElement | null = null;
let caret: { line: number; col: number } | null = null;
let active = false;
let solidTimer = 0;

const pane = (): HTMLElement | null => document.getElementById('docText');
const scroller = (): HTMLElement | null => pane()?.querySelector<HTMLElement>('.docBody') ?? pane();

function textNodesOf(el: Node): Text[] {
  const out: Text[] = [];
  const walk = (n: Node) => {
    if (n.nodeType === Node.TEXT_NODE) { if ((n as Text).textContent) out.push(n as Text); return; }
    for (const c of Array.from(n.childNodes)) walk(c);
  };
  walk(el);
  return out;
}

const lineEl = (line: number): HTMLElement | null =>
  document.querySelector<HTMLElement>(`#docText .docLine[id="L${line}"]`);

function rangeAt(line: number, col: number): Range | null {
  const el = lineEl(line);
  if (!el) return null;
  const nodes = textNodesOf(el);
  let acc = 0;
  for (const node of nodes) {
    const len = node.textContent?.length ?? 0;
    if (col <= acc + len) { const r = document.createRange(); r.setStart(node, Math.min(col - acc, len)); r.collapse(true); return r; }
    acc += len;
  }
  const last = nodes[nodes.length - 1];
  const r = document.createRange();
  if (last) r.setStart(last, last.textContent?.length ?? 0); else r.selectNodeContents(el);
  r.collapse(false); return r;
}

function posFromRange(r: Range): { line: number; col: number } | null {
  const node = r.startContainer;
  const el = (node.nodeType === Node.TEXT_NODE ? node.parentElement : node as Element)?.closest?.('#docText .docLine') as HTMLElement | null;
  if (!el || !el.id.startsWith('L')) return null;
  const line = Number(el.id.slice(1));
  if (!Number.isFinite(line)) return null;
  const nodes = textNodesOf(el);
  let acc = 0;
  for (const n of nodes) {
    if (n === r.startContainer) return { line, col: acc + r.startOffset };
    acc += n.textContent?.length ?? 0;
  }
  return { line, col: acc };
}

const caretRangeAt = (x: number, y: number): Range | null =>
  (document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }).caretRangeFromPoint?.(x, y) ?? null;

function ensureBar(): HTMLElement | null {
  const sc = scroller();
  if (!sc) return null;
  if (!bar || !bar.isConnected) {
    bar = document.createElement('div');
    bar.id = 'caretBar';
    bar.setAttribute('aria-hidden', 'true');
    if (getComputedStyle(sc).position === 'static') sc.style.position = 'relative';
    sc.appendChild(bar);
  }
  return bar;
}

function drawBar(): void {
  const b = ensureBar();
  const sc = scroller();
  if (!b || !sc || !caret) { if (b) b.hidden = true; return; }
  const r = rangeAt(caret.line, caret.col);
  if (!r) { b.hidden = true; return; }              // 該行不在目前 DOM（捲動外）：留狀態、先不畫
  let rect = r.getBoundingClientRect();
  if (!rect.height && !rect.width) { const lr = lineEl(caret.line)?.getBoundingClientRect(); if (!lr) { b.hidden = true; return; } rect = lr; }
  const sr = sc.getBoundingClientRect();
  b.hidden = false;
  b.style.left = (rect.left - sr.left + sc.scrollLeft) + 'px';
  b.style.top = (rect.top - sr.top + sc.scrollTop) + 'px';
  b.style.height = Math.max(14, rect.height || 18) + 'px';
}

function setCaret(line: number, col: number, extend: boolean): void {
  const el = lineEl(line);
  if (!el) return;
  const max = textNodesOf(el).reduce((a, n) => a + (n.textContent?.length ?? 0), 0);
  col = Math.max(0, Math.min(col, max));
  caret = { line, col };
  active = true;
  const sel = window.getSelection();
  const r = rangeAt(line, col);
  if (sel && r) {
    if (extend) { if (sel.rangeCount === 0) { const a = rangeAt(line, 0); if (a) sel.addRange(a); } sel.extend(r.startContainer, r.startOffset); }
    else { sel.removeAllRanges(); sel.addRange(r); }
  }
  drawBar();
  if (!extend) { persistCaretSoon(); caretHover(); }   // 落點（不是拖曳選取）才記憶＋套用 hover
}

const lineLen = (line: number): number => { const el = lineEl(line); return el ? textNodesOf(el).reduce((a, n) => a + (n.textContent?.length ?? 0), 0) : 0; };

function visibleLines(): number[] {
  const sc = scroller(); if (!sc) return [];
  const sr = sc.getBoundingClientRect();
  return Array.from(sc.querySelectorAll<HTMLElement>('.docLine[id^="L"]'))
    .map((el) => ({ el, line: Number(el.id.slice(1)) }))
    .filter((x) => Number.isFinite(x.line))
    .sort((a, b) => a.el.getBoundingClientRect().top - b.el.getBoundingClientRect().top)
    .filter((x) => { const t = x.el.getBoundingClientRect().top; return t >= sr.top - 2 && t < sr.bottom; })
    .map((x) => x.line);
}

const allLines = (): number[] =>
  Array.from(document.querySelectorAll<HTMLElement>('#docText .docLine[id^="L"]'))
    .map((el) => Number(el.id.slice(1))).filter(Number.isFinite).sort((a, b) => a - b);

function scrollIntoViewIfNeeded(): void {
  const sc = scroller(); const b = bar;
  if (!sc || !b || b.hidden) return;
  const sr = sc.getBoundingClientRect(), rr = b.getBoundingClientRect();
  if (rr.top < sr.top) sc.scrollTop -= (sr.top - rr.top) + 8;
  else if (rr.bottom > sr.bottom) sc.scrollTop += (rr.bottom - sr.bottom) + 8;
}

function moveH(dx: number, extend: boolean): void {
  if (!caret) return;
  let { line, col } = caret;
  col += dx;
  if (col < 0) { const p = line - 1; if (lineEl(p)) { line = p; col = lineLen(p); } else col = 0; }
  else { const len = lineLen(line); if (col > len) { const nx = line + 1; if (lineEl(nx)) { line = nx; col = 0; } else col = len; } }
  setCaret(line, col, extend);
  scrollIntoViewIfNeeded();
}

/**
 * ↑↓（2026-11-25 改版）：直接找**幾何上最近的一個 DOM text node**（含軟折行的單一視覺行片段），
 * 在該片段與目前 X 交會處用 caretRangeFromPoint 吸附；這樣軟折行（一段 .docLine 佔好幾個視覺行）
 * 不會因为「整行 rect 太高、y 落到空白帶→回退到行首」而跳過頭。
 * 找不到可用位置時退回「上下最近的真實字」；該方向完全沒有字才不動。
 */
function moveV(dir: number, extend: boolean): void {
  if (!caret) return;
  const cur = rangeAt(caret.line, caret.col)?.getBoundingClientRect() ?? lineEl(caret.line)?.getBoundingClientRect();
  if (!cur || (!cur.height && !cur.width)) { moveH(dir > 0 ? 1 : -1, extend); return; }
  const x = cur.left + cur.width / 2;
  const sc = scroller(); if (!sc) return;

  // 收集本頁所有文字節點的視覺行片段（Range.getClientRects 會把軟折一行拆成多段）
  type Frag = { rect: DOMRect; node: Text };
  const all: Frag[] = [];
  const walker = document.createTreeWalker(sc, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text;
    if (!t.textContent || !t.parentElement?.closest?.('.docLine[id^="L"]')) continue;
    const rr = document.createRange(); rr.selectNodeContents(t);
    for (const rect of Array.from(rr.getClientRects())) { if (rect.height > 0 && rect.width > 0) all.push({ rect, node: t }); }
  }
  // caret 的折疊 rect 高有時失真（0 或超小字）：用全頁字高中位數兜底再算「本行中線」
  const hs = all.map((z) => z.rect.height).sort((a, b) => a - b);
  const rowH = Math.max(cur.height, hs.length ? hs[Math.floor(hs.length / 2)] : 18);
  // 「下一行」以本行中線為界：caret 折疊 rect 常比行盒矮，若用 cur.bottom，同視覺行的
  // sup／上標小字（只低幾 px）會被誤當成下一行（2026-11-25 軟折行修正）。
  const frags = all.filter((z) => (dir > 0 ? z.rect.top > cur.top + rowH * 0.6 : z.rect.bottom < cur.bottom - rowH * 0.6));
  if (!frags.length) return;                             // 該方向已無字（頁首／頁尾）
  const near = (r: DOMRect): number => (dir > 0 ? r.top - cur.bottom : cur.top - r.bottom);
  frags.sort((a, b) => near(a.rect) - near(b.rect)
    || Math.abs(a.rect.left + a.rect.width / 2 - x) - Math.abs(b.rect.left + b.rect.width / 2 - x));
  const r0 = frags[0].rect;
  const hit = caretRangeAt(x, r0.top + r0.height / 2);   // 最近視覺行片段的中央
  const p = hit && posFromRange(hit);
  if (p) { setCaret(p.line, p.col, extend); scrollIntoViewIfNeeded(); return; }
  // 吸附失敗：直接在候選文字節點裡找與 X 最接近的字元
  const q = snapToText(frags[0].node, x);
  if (q) setCaret(q.line, q.col, extend);
  else { const fr = frags[0]; const lp = fr.node.parentElement?.closest?.('.docLine[id^="L"]') as HTMLElement | null;
         const line = lp ? Number(lp.id.slice(1)) : NaN;
         if (!Number.isFinite(line)) return;
         setCaret(line, dir > 0 ? 0 : lineLen(line), extend); }
  scrollIntoViewIfNeeded();
}

/** 在文字節點內找與螢幕 X 最接近的字元停靠點（caretRangeFromPoint 失效時的後備）。 */
function snapToText(node: Text, x: number): { line: number; col: number } | null {
  const lp = node.parentElement?.closest?.('.docLine[id^="L"]') as HTMLElement | null;
  if (!lp) return null;
  const line = Number(lp.id.slice(1));
  if (!Number.isFinite(line)) return null;
  const text = node.textContent ?? '';
  let best = -1, bestD = Infinity;
  const probe = document.createRange();
  for (let i = 0; i <= text.length; i++) {
    try { probe.setStart(node, Math.min(i, text.length)); probe.collapse(true); } catch { continue; }
    const rects = probe.getClientRects();
    const r = rects.length ? rects[0] : null;
    const rx = r ? r.left : x;                            // 行尾折疊 Range：比對節點尾端
    const d = Math.abs(rx - x);
    if (d < bestD) { bestD = d; best = i; }
  }
  if (best < 0) return null;
  const acc = textNodesOf(lp);
  let col = 0;
  for (const n of acc) { if (n === node) break; col += n.textContent?.length ?? 0; }
  return { line, col: col + best };
}

function pageDir(dir: number, extend: boolean): void {
  const sc = scroller(); if (!sc) return;
  sc.scrollTop += dir * sc.clientHeight * 0.9;
  const vis = visibleLines();
  if (vis.length) { const line = dir > 0 ? vis[vis.length - 1] : vis[0]; setCaret(line, dir > 0 ? lineLen(line) : 0, extend); }
  drawBar();
}

function toEdge(where: 'start' | 'end' | 'lineStart' | 'lineEnd', extend: boolean): void {
  if (!caret) return;
  if (where === 'lineStart') return setCaret(caret.line, 0, extend);
  if (where === 'lineEnd') return setCaret(caret.line, lineLen(caret.line), extend);
  const lines = allLines(); if (!lines.length) return;
  const line = where === 'start' ? lines[0] : lines[lines.length - 1];
  setCaret(line, where === 'end' ? lineLen(line) : 0, extend);
  lineEl(line)?.scrollIntoView({ block: where === 'start' ? 'start' : 'end' });
}

/** 連按導航鍵時恆亮：加 .solid、重設閒置計時器，600ms 沒再按才恢復淡入淡出。 */
function markSolid(): void {
  const b = ensureBar(); if (!b) return;
  b.classList.add('solid');
  if (solidTimer) window.clearTimeout(solidTimer);
  solidTimer = window.setTimeout(() => { bar?.classList.remove('solid'); }, 600);
}

// ───────────────────────────────────────────────────────────────────────────────
// 2026-11-24 追加（作者）：光標位置「跳至」引用、跨重啟記憶、停在 術／註／聯 等同 hover。
// 仍然刻意不 import viewer／doc-pane（避免循環）：狀態列用 ui 在開機時注入的 hook。
// ───────────────────────────────────────────────────────────────────────────────

type StatusHook = (msg: string, kind?: 'info' | 'err') => void;
let statusHook: StatusHook | null = null;
/** ui.ts 開機時注入 setStatus，讓 F9／還原能回報（caret-mode 不直接 import viewer）。 */
export function setCaretStatus(fn: StatusHook): void { statusHook = fn; }
const say = (msg: string, kind: 'info' | 'err' = 'info'): void => { try { statusHook?.(msg, kind); } catch { /* 沒接上就靜默 */ } };

/** 目前開啟的庫名（用 ui 掛在 window 上的 state()，不 import viewer）。 */
function dbNameOf(): string {
  const st = (window as unknown as { __accelon26?: { state?: () => Record<string, unknown> } }).__accelon26?.state?.();
  return String(st?.db ?? '');
}

// —— 跨重啟記憶：每個庫各存 {line, col}（light，独立於 lastRead 的選取區）——
const CP_PREFIX = 'accelon26.caret.pos.v1|';
let persistTimer = 0;
let restoredFor = '';        // 這個庫這次開啓已嘗試過還原（成功或放棄），避免打擾後續導覽

function persistCaretSoon(): void {
  if (persistTimer) window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(persistCaretNow, 350);
}
function persistCaretNow(): void {
  if (!caret) return;
  const db = dbNameOf();
  if (!db) return;           // 開庫事件還沒送到：不要覆蓋上一個庫
  try { localStorage.setItem(CP_PREFIX + db, JSON.stringify({ line: caret.line, col: caret.col, at: Date.now() })); } catch { /* 無痕 */ }
}
function readStoredCaret(db: string): { line: number; col: number } | null {
  let raw = '';
  try { raw = localStorage.getItem(CP_PREFIX + db) || ''; } catch { return null; }
  if (!raw) return null;
  try {
    const o = JSON.parse(raw);
    return o && Number.isFinite(o.line) ? { line: o.line | 0, col: (o.col | 0) } : null;
  } catch { return null; }
}
/**
 * 還原上次的光標：等「那一行已经在目前 DOM」才落下。renderDoc（含 ensurePage → 那一頁）
 * 之後 DOM 才會有該行，所以用幾次重試兜住開庫／還原的分頁時序；放棄後本庫不再打擾。
 */
function scheduleRestore(attempts = 5): void {
  const db = dbNameOf();
  if (!db) { if (attempts > 0) window.setTimeout(() => scheduleRestore(attempts - 1), 200); return; }
  if (restoredFor === db) return;
  const pos = readStoredCaret(db);
  if (pos && lineEl(pos.line)) { setCaret(pos.line, pos.col, false); restoredFor = db; return; }
  if (attempts > 0) window.setTimeout(() => scheduleRestore(attempts - 1), 200);
  else restoredFor = db;
}

async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* file://／權限，退回 execCommand */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;left:-9999px;top:0';
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy'); ta.remove(); return ok;
  } catch { return false; }
}
/** 光標位置的可複製字串 `#L<行>:<欄>@<庫>`；沒有光標、或那一行不在目前 DOM → null。 */
export function caretRefString(): string | null {
  if (!caret) return null;
  if (!lineEl(caret.line)) return null;
  const db = dbNameOf();
  return '#L' + caret.line + ':' + caret.col + (db ? '@' + db : '');
}
/**
 * F9：#docText 有光標、且那一行目前就在 DOM 時，把光標位置複製成可貼回「跳至」的
 * `#L<行>:<欄>@<庫>`（`lineJumpTarget` 認得 `:欄`，貼上 Enter 會跳那一行、再落下光標）。
 * 回傳 true＝已接手（成敗都已在狀態列提示）；回傳 false＝沒有可用光標，交回元素檢查器。
 */
export async function caretCopyRef(): Promise<boolean> {
  const text = caretRefString();
  if (text == null) return false;
  const ok = await copyText(text);
  say(ok ? '已複製光標位置：' + text + '（貼到搜尋框可跳回）' : '複製失敗：' + text, ok ? 'info' : 'err');
  return true;
}

// —— 停在 術／註／聯＝等同 hover ——
let hoverHost: Element | null = null;
let caretTipEl: HTMLElement | null = null;

/** 光標落點所在的「會 hover 的元素」：註／聯 的連結、術語 span。找不到回 null。 */
function hoverHostForCaret(): Element | null {
  if (!caret) return null;
  const r = rangeAt(caret.line, caret.col);
  if (!r) return null;
  // 折疊 Range 的 startContainer 有時落在 element 邊界（一個 span 之前）；往「前一個字」靠，
  // 取緊貼光標左側那個字，才和肉眼看到的光標位置一致。
  let node: Node | null = r.startContainer;
  let off = r.startOffset;
  if (node && node.nodeType !== Node.TEXT_NODE) {
    const kids = node.childNodes;
    const prev = kids[off > 0 ? off - 1 : Math.min(off, kids.length - 1)] ?? null;
    if (prev) { node = prev.nodeType === Node.TEXT_NODE ? prev : (prev.textContent ? null : prev); if (!node) return null; off = 0; }
  }
  const el = node ? (node.nodeType === Node.TEXT_NODE ? node.parentElement : node as Element) : null;
  if (!el) return null;
  return el.closest('a.noteRef, a.noteBack, .term, a.entryLink, a[data-xref], a[data-link]');
}
function clearCaretTip(): void { caretTipEl?.remove(); caretTipEl = null; }
function showCaretTip(text: string): void {
  clearCaretTip();
  if (!text) return;
  const sc = scroller(); const host = hoverHost;
  const rect = host?.getBoundingClientRect?.();
  if (!sc || !rect || (!rect.width && !rect.height)) return;
  const tip = document.createElement('div');
  tip.id = 'caretTip';
  tip.setAttribute('aria-hidden', 'true');
  tip.textContent = text;
  sc.appendChild(tip);
  caretTipEl = tip;
  const sr = sc.getBoundingClientRect();
  const w = tip.offsetWidth || 120;
  const left = Math.max(2, Math.min(rect.left - sr.left + sc.scrollLeft, sr.width - w - 4));
  let top = rect.top - sr.top + sc.scrollTop - tip.offsetHeight - 6;
  if (top < sc.scrollTop + 2) top = rect.bottom - sr.top + sc.scrollTop + 6;   // 上方不夠就改下面
  tip.style.left = left + 'px';
  tip.style.top = top + 'px';
}
/** 光標移動後：換了元素才觸發，註走既有浮面板（合成 mouseover/mouseout），術／聯用自繪气泡。 */
function caretHover(): void {
  const host = hoverHostForCaret();
  if (host === hoverHost) return;                    // 同一個元素：不重複觸發
  if (hoverHost?.matches?.('a.noteRef, a.noteBack')) {
    try { hoverHost.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })); } catch { /* noop */ }
  }
  clearCaretTip();
  hoverHost = host;
  if (!host) return;
  if (host.matches('a.noteRef, a.noteBack')) {       // 註：滑過用的浮動面板，委派監聽會接住
    try { host.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); } catch { /* noop */ }
    return;
  }
  const title = host.getAttribute('title') || '';     // 術／聯：原生 title 提示 → 自繪重現
  if (title) showCaretTip(title);
}

export function initCaretMode(): void {
  if (bound) return;
  const box = pane(); if (!box) return;
  bound = true;
  box.tabIndex = 0;
  // 換庫：清掉這次已還原紀錄，稍後重試把上次的光標落回（那一行進 DOM 後才成）。
  window.addEventListener('accelon26:db', () => { restoredFor = ''; hoverHost = null; clearCaretTip(); window.setTimeout(() => scheduleRestore(), 0); });
  window.setTimeout(() => scheduleRestore(), 0);   // 首開（db 事件已過）也試一次

  box.addEventListener('focus', () => {
    active = true;
    if (!caret) {
      let vis = visibleLines();
      if (!vis.length) vis = allLines();
      if (vis.length) setCaret(vis[0], 0, false);
    }
    drawBar();
  });

  box.addEventListener('mousedown', (ev) => {
    const tgt = ev.target as Element | null;
    if (tgt?.closest?.('a,button,.noteRef,.noteBack,.pageBreak,.pageMark,[data-xref],[data-embed],.embedChip,.nodeLink,.docTable')) return;
    const r = caretRangeAt(ev.clientX, ev.clientY);
    const p = r && posFromRange(r);
    if (p) { setCaret(p.line, p.col, ev.shiftKey); markSolid(); }
  });

  box.addEventListener('keydown', (ev) => {
    if (!active || !caret || ev.altKey) return;
    const t = ev.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    const shift = ev.shiftKey;
    let handled = true;
    switch (ev.key) {
      case 'ArrowLeft': moveH(-1, shift); break;
      case 'ArrowRight': moveH(1, shift); break;
      case 'ArrowUp': moveV(-1, shift); break;
      case 'ArrowDown': moveV(1, shift); break;
      case 'Home': toEdge(ev.ctrlKey ? 'start' : 'lineStart', shift); break;
      case 'End': toEdge(ev.ctrlKey ? 'end' : 'lineEnd', shift); break;
      case 'PageUp': pageDir(-1, shift); break;
      case 'PageDown': pageDir(1, shift); break;
      default: handled = false;
    }
    if (handled) { ev.preventDefault(); ev.stopPropagation(); markSolid(); }
  });
}

export function caretReanchor(): void { if (caret) drawBar(); }

/** 貼「跳至」引用（#L<行>:<欄>@<庫）進來時：跳那一頁後把光標落到該行該欄並捲進視窗。 */
export function caretJumpTo(line: number, col: number): void {
  if (!lineEl(line)) return;                          // 那一行不在目前 DOM：跳頁已由呼叫端處理
  restoredFor = dbNameOf();                           // 使用者主動定位，不再被自動還原打擾
  setCaret(line, col, false);
  const sc = scroller();
  if (sc) {
    const r = rangeAt(line, col)?.getBoundingClientRect();
    const sr = sc.getBoundingClientRect();
    if (r) { if (r.top < sr.top) sc.scrollTop -= (sr.top - r.top) + 12; else if (r.bottom > sr.bottom) sc.scrollTop += (r.bottom - sr.bottom) + 12; }
  }
  markSolid();
}

export const caretDebug = (): { active: boolean; caret: typeof caret; solid: boolean } =>
  ({ active, caret, solid: !!bar?.classList.contains('solid') });
