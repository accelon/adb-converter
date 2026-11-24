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
 * ↑↓：找幾何上最近的一行（不靠 line±1），用 caretRangeFromPoint 落在該行、與目前 X 最接近的
 * 可停靠字元。找不到就退回該行行首/行尾。（修 p.348 腳注 ↓ 無作用。）
 */
function moveV(dir: number, extend: boolean): void {
  if (!caret) return;
  const cur = rangeAt(caret.line, caret.col)?.getBoundingClientRect() ?? lineEl(caret.line)?.getBoundingClientRect();
  if (!cur || (!cur.height && !cur.width)) { moveH(dir > 0 ? 1 : -1, extend); return; }
  const x = cur.left + cur.width / 2;
  const sc = scroller(); if (!sc) return;
  const cand = Array.from(sc.querySelectorAll<HTMLElement>('.docLine[id^="L"]'))
    .map((el) => ({ el, line: Number(el.id.slice(1)), r: el.getBoundingClientRect() }))
    .filter((z) => Number.isFinite(z.line) && z.r.height > 0);
  let best: typeof cand[number] | null = null;
  for (const z of cand) {
    if (dir > 0 ? z.r.top >= cur.bottom - 1 : z.r.bottom <= cur.top + 1) {
      if (!best || (dir > 0 ? z.r.top < best.r.top : z.r.bottom > best.r.bottom)) best = z;
    }
  }
  if (!best) return;                                   // 該方向已無行（頁首/頁尾）
  const h = Math.min(best.r.height, cur.height || best.r.height);
  const y = dir > 0 ? best.r.top + h / 2 : best.r.bottom - h / 2;
  const r = caretRangeAt(x, y);
  const p = r && posFromRange(r);
  if (p && p.line === best.line) setCaret(p.line, p.col, extend);
  else setCaret(best.line, dir > 0 ? 0 : lineLen(best.line), extend);   // 吸附失敗→該行首/尾
  scrollIntoViewIfNeeded();
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

export function initCaretMode(): void {
  if (bound) return;
  const box = pane(); if (!box) return;
  bound = true;
  box.tabIndex = 0;

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

export const caretDebug = (): { active: boolean; caret: typeof caret; solid: boolean } =>
  ({ active, caret, solid: !!bar?.classList.contains('solid') });
