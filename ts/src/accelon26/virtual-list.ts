/**
 * Fixed-row-height virtual list（作者 2026-11-02，給 74,219 個節點的目錄用）。
 *
 * `renderChunked` 只把列分批**掛進 DOM**，但掛過的列不會拆掉；目錄全部展開時
 * 74,219 列會變成幾十萬個 DOM 節點，捲到後面會卡。這裡只保留視窗附近
 * （可視範圍 ± overscan）的列，上下用 spacer 撐出總高度，所以：
 *
 *   - 第一次只掛 200 列左右；
 *   - 捲動時換掉視窗，不增加 DOM；
 *   - 總高度不變，捲軸位置穩定。
 *
 * 限制：每一列高度必須固定（目錄 `.tRow` 是單行、固定 line-height）。列高的
 * 量法是用 `html()` 先做一列、量 offsetHeight，後續都沿用；字級改變時要重新
 * `renderVirtual()`。
 */

export interface VirtualOpts<T> {
  /** 一列的 HTML；必須是 box 的直接子節點（和 `.tRow` 一樣） */
  html: (t: T, i: number) => string;
  /** 綁定剛掛上的列 */
  bind?: (el: HTMLElement, t: T, i: number) => void;
  /** 只對視窗內的列做非同步準備（例如讀標籤） */
  prepare?: (slice: T[], from: number, to: number) => Promise<void> | void;
  /** 視窗上下各多留幾列（預設 12） */
  overscan?: number;
}

interface Host<T> {
  items: T[];
  opts: VirtualOpts<T>;
  rowH: number;
  start: number;
  end: number;
  all: boolean;
  painting: boolean;
  pending: boolean;
  gen: number;
}

const hosts = new WeakMap<HTMLElement, Host<never>>();
const wired = new WeakSet<HTMLElement>();

function hostOf(box: HTMLElement): Host<never> | null {
  return (hosts.get(box) as Host<never> | undefined) ?? null;
}

function measureRowH<T>(box: HTMLElement, items: T[], opts: VirtualOpts<T>): number {
  if (!items.length) return 22;
  const probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;left:-9999px;top:0;visibility:hidden';
  probe.innerHTML = opts.html(items[0], 0);
  box.appendChild(probe);
  const row = probe.firstElementChild as HTMLElement | null;
  const h = row?.getBoundingClientRect().height ?? 0;
  probe.remove();
  // 目錄列約 22px；量不到（面板隱藏／字型還沒好）時用保守值。
  return h > 4 ? h : 22;
}

function renderWindow<T>(box: HTMLElement, host: Host<T>, topOverride?: number): void {
  const { items, opts, rowH } = host;
  if (!items.length) {
    box.innerHTML = '';
    host.start = host.end = 0;
    return;
  }
  const total = items.length * rowH;
  const viewH = Math.max(1, box.clientHeight);
  const over = Math.max(2, opts.overscan ?? 12);
  const scrollTop = Math.max(0, Math.min(Math.max(0, total - viewH), topOverride ?? box.scrollTop));
  const first = Math.min(items.length, Math.max(0, Math.floor(scrollTop / rowH) - over));
  const last = Math.min(items.length, Math.ceil((scrollTop + viewH) / rowH) + over);
  if (!host.all && first === host.start && last === host.end && box.querySelector('.tRow')) return;

  const gen = ++host.gen;
  const slice = items.slice(first, last);
  host.painting = true;
  void (async () => {
    await opts.prepare?.(slice, first, last);
    // 展開／收合會連續叫 renderVirtual：舊的非同步工作完成時可能蓋掉新視窗的
    // scrollTop（實測：使用者捲到 40,000 後又被拉回頂端）。host 已被換掉就放棄。
    if (gen !== host.gen || (hosts.get(box) as unknown) !== host) return;
    const top = first * rowH;
    const bottom = Math.max(0, total - last * rowH);
    const holder = document.createElement('div');
    holder.innerHTML = slice.map((t, k) => opts.html(t, first + k)).join('');
    const els = [...holder.children] as HTMLElement[];
    els.forEach((el, k) => opts.bind?.(el, items[first + k] as never, first + k));
    const frag = document.createDocumentFragment();
    if (top > 0) {
      const sp = document.createElement('div');
      sp.className = 'vSpacer';
      sp.style.height = top + 'px';
      frag.appendChild(sp);
    }
    els.forEach((el) => frag.appendChild(el));
    if (bottom > 0) {
      const sp = document.createElement('div');
      sp.className = 'vSpacer';
      sp.style.height = bottom + 'px';
      frag.appendChild(sp);
    }
    box.replaceChildren(frag);
    box.scrollTop = scrollTop;
    host.start = first;
    host.end = last;
    host.painting = false;
    if (host.pending) {
      host.pending = false;
      renderWindow(box, host);
    }
  })();
}

function schedule(box: HTMLElement): void {
  const host = hostOf(box);
  if (!host || host.all) return;
  if (host.painting) { host.pending = true; return; }
  requestAnimationFrame(() => renderWindow(box, host as Host<unknown> as never));
}

/** 用虛擬捲動畫一個固定列高的清單（覆蓋 box 內容） */
export async function renderVirtual<T>(box: HTMLElement, items: T[], opts: VirtualOpts<T>): Promise<void> {
  // 量列高時不要讓上一次的固定列高／字級影響量測。
  box.classList.remove('virtualList');
  box.style.removeProperty('--vrow-h');
  const rowH = measureRowH(box, items, opts);
  const host: Host<T> = {
    items, opts, rowH,
    start: -1, end: -1, all: false, painting: false, pending: false, gen: 0,
  };
  hosts.set(box, host as unknown as Host<never>);
  box.classList.add('virtualList');
  box.style.setProperty('--vrow-h', rowH + 'px');
  if (!wired.has(box)) {
    wired.add(box);
    box.addEventListener('scroll', () => schedule(box));
  }
  const keepTop = box.scrollTop;
  box.innerHTML = '';
  renderWindow(box, host, keepTop);
  // 等第一幀的非同步 prepare 完成，讓呼叫端可以接著量 DOM
  while (host.painting || host.start < 0) await new Promise((r) => setTimeout(r, 0));
}

/** 把某個索引捲到視窗頂端（給「在目錄中顯示目前位置」用） */
export function scrollVirtualToIndex(box: HTMLElement, index: number): void {
  const host = hostOf(box);
  if (!host || host.all) return;
  const i = Math.max(0, Math.min(host.items.length - 1, index));
  const top = i * host.rowH;
  box.scrollTop = top;
  host.start = host.end = -1;   // 強制重畫
  renderWindow(box, host as Host<unknown> as never, top);
}

/** 目前視窗最上面那一列的索引（除錯／測試用） */
export function virtualTopIndex(box: HTMLElement): number {
  const host = hostOf(box);
  if (!host) return -1;
  return Math.max(0, Math.floor(box.scrollTop / host.rowH));
}

/** 目前視窗掛了幾個 `.tRow`（除錯／測試用） */
export function virtualRowsMounted(box: HTMLElement): number {
  return box.querySelectorAll('.tRow').length;
}

/**
 * 暫時把全部列掛回 DOM（給既有測試與 `growTreeFully()` 用；一般閱讀不要呼叫）。
 * 回傳掛上的列數；下一次 `renderVirtual()` 會恢復虛擬模式。
 */
export async function renderAllVirtualRows(box: HTMLElement): Promise<number> {
  const host = hostOf(box);
  if (!host) return box.querySelectorAll('.tRow').length;
  host.all = true;
  host.gen++;
  const { items, opts } = host;
  await opts.prepare?.(items, 0, items.length);
  const holder = document.createElement('div');
  holder.innerHTML = items.map((t, i) => opts.html(t as never, i)).join('');
  box.replaceChildren(...holder.children);
  [...box.children].forEach((el, i) => opts.bind?.(el as HTMLElement, items[i] as never, i));
  host.start = 0;
  host.end = items.length;
  return items.length;
}
