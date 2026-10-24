/**
 * F9 元素檢查器：把游標所在的 div/span 框起來，其餘壓暗；點目標把 id 複製到剪貼簿。
 *
 * 和 tour 的 spotlight 一樣用「9999px box-shadow」做洞，另外加一層透明 backdrop
 * 接住「點目標以外」的點擊（tour 不擋操作；這裡需要一個明確的取消區）。
 */
export type InspectStatus = (msg: string, kind?: 'info' | 'err') => void;

let layer: HTMLElement | null = null;
let closeHandlers: (() => void) | null = null;

function caretPoint(): { x: number; y: number } | null {
  const view = (window as any).__accelon26EditView;
  if (view?.state && document.querySelector('.cm-editor')) {
    try {
      const c = view.coordsAtPos(view.state.selection.main.head);
      if (c) return { x: c.left + 1, y: (c.top + c.bottom) / 2 };
    } catch { /* editor 已卸載 */ }
  }
  const sel = window.getSelection();
  if (sel?.rangeCount) {
    const range = sel.getRangeAt(0);
    let r = range.getBoundingClientRect();
    if (!r.width && !r.height && sel.focusNode) {
      const node = sel.focusNode;
      const el = node.nodeType === 1 ? node as Element : node.parentElement;
      if (el) r = el.getBoundingClientRect();
    }
    if (r.width || r.height) return { x: r.left + Math.min(2, Math.max(0, r.width / 2)), y: r.top + r.height / 2 };
  }
  return null;
}

function idAncestor(start: Element | null): HTMLElement | null {
  let el = start;
  while (el && el !== document.documentElement) {
    if ((el.tagName === 'DIV' || el.tagName === 'SPAN') && el.id) return el as HTMLElement;
    el = el.parentElement;
  }
  return null;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch { /* file:// 或權限不足，走 execCommand */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;left:-9999px;top:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

function placeLabel(rect: DOMRect, label: HTMLElement): void {
  const m = 8;
  const vw = window.innerWidth, vh = window.innerHeight;
  const w = label.offsetWidth, h = label.offsetHeight;
  let top: number, left: number;
  if (rect.top - h - m >= m) {                 // 上
    top = rect.top - h - m; left = rect.left;
  } else if (rect.bottom + h + m <= vh - m) {  // 下
    top = rect.bottom + m; left = rect.left;
  } else if (rect.left - w - m >= m) {         // 左
    left = rect.left - w - m; top = rect.top;
  } else if (rect.right + w + m <= vw - m) {   // 右
    left = rect.right + m; top = rect.top;
  } else {                                     // 真的沒空間：壓在目標左上
    left = Math.max(m, Math.min(vw - w - m, rect.left));
    top = Math.max(m, Math.min(vh - h - m, rect.bottom + m));
  }
  label.style.left = Math.round(left) + 'px';
  label.style.top = Math.round(top) + 'px';
}

export function stopInspect(): void {
  closeHandlers?.();
  closeHandlers = null;
  layer?.remove();
  layer = null;
}

/** F9: open on the caret, or close if already open. */
export function toggleInspect(status: InspectStatus): void {
  if (layer) { stopInspect(); return; }
  const pt = caretPoint();
  if (!pt) { status('F9：請先把游標放在文字上', 'err'); return; }
  const raw = document.elementFromPoint(pt.x, pt.y);
  const target = idAncestor(raw);
  if (!target) { status('F9：這個位置沒有 div/span id', 'err'); return; }
  const id = target.id;
  const r = target.getBoundingClientRect();
  const left = Math.max(0, r.left), top = Math.max(0, r.top);
  const right = Math.min(window.innerWidth, r.right), bottom = Math.min(window.innerHeight, r.bottom);
  if (right <= left || bottom <= top) { status('F9：目標不在畫面內', 'err'); return; }

  layer = document.createElement('div');
  layer.id = 'inspectLayer';
  layer.innerHTML = '<div id="inspectBackdrop"></div>'
    + '<div id="inspectSpot"></div>'
    + '<div id="inspectHit" role="button" tabindex="0"></div>'
    + '<div id="inspectLabel"><b></b><span>點一下複製 id · Esc／F9 取消</span></div>';
  document.body.appendChild(layer);
  layer.querySelector<HTMLElement>('#inspectHit')!.title = '點一下複製 #' + id;
  layer.querySelector<HTMLElement>('#inspectLabel b')!.textContent = '#' + id;

  const spot = layer.querySelector<HTMLElement>('#inspectSpot')!;
  const hit = layer.querySelector<HTMLElement>('#inspectHit')!;
  const label = layer.querySelector<HTMLElement>('#inspectLabel')!;
  const box = { left, top, width: right - left, height: bottom - top };
  for (const el of [spot, hit]) {
    el.style.left = box.left + 'px';
    el.style.top = box.top + 'px';
    el.style.width = box.width + 'px';
    el.style.height = box.height + 'px';
  }
  requestAnimationFrame(() => placeLabel(new DOMRect(box.left, box.top, box.width, box.height), label));

  const finish = (): void => {
    const text = '#' + id;
    void copyText(text).then((ok) => status(ok ? '已複製 ' + text : '複製失敗：' + text, ok ? 'info' : 'err'));
    stopInspect();
  };
  hit.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); finish(); });
  hit.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); finish(); } });
  layer.querySelector<HTMLElement>('#inspectBackdrop')!.addEventListener('click', () => stopInspect());

  const onKey = (ev: KeyboardEvent): void => { if (ev.key === 'Escape') { ev.preventDefault(); stopInspect(); } };
  const onViewport = (): void => stopInspect();
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', onViewport);
  window.addEventListener('scroll', onViewport, true);
  closeHandlers = () => {
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onViewport);
    window.removeEventListener('scroll', onViewport, true);
  };
  hit.focus({ preventScroll: true });
}
