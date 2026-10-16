/**
 * Long lists are mounted in CHUNKS.
 *
 * 目錄樹／名詞／頻次／原書分頁／西文 all end up as one row per database node, and
 * fgdict alone has 6,966 rows in its tree (≈35k DOM nodes). Building them in one
 * go blocks the main thread — measured: switching to fgdict spent 390 ms
 * synchronously inside the switch, and its tree alone was 34,837 nodes.
 *
 * The reader can only see a screenful, so the first CHUNK rows go in immediately and
 * the rest arrive as the reader scrolls (or clicks the sentinel row). The list is
 * still COMPLETE: nothing is hidden, it is only mounted on demand.
 */
export const CHUNK = 200;

export interface ChunkOpts<T> {
  /** one row's markup (rows become direct children of the box, as the CSS expects) */
  html: (t: T, i: number) => string;
  /** attach the click handlers of the rows just mounted */
  bind?: (el: HTMLElement, t: T, i: number) => void;
  /**
   * async work for the rows about to be mounted — 詞條名（caches/詞）、頻次的段名
   * （每個都是一次內文走訪）。Called with the slice, so a long list only pays for
   * what is actually shown.
   */
  prepare?: (slice: T[], from: number, to: number) => Promise<void> | void;
  /** mount at least this many rows at once (an already open tree stays open) */
  min?: number;
}

interface Host<T> {
  items: T[];
  opts: ChunkOpts<T>;
  at: number;
  busy: boolean;
  sentinel: HTMLElement | null;
}

const hosts = new WeakMap<HTMLElement, Host<never>>();
const wired = new WeakSet<HTMLElement>();

/** rows currently mounted in this box */
export function mounted(box: HTMLElement): number {
  return hosts.get(box)?.at ?? 0;
}

async function grow(box: HTMLElement, host: Host<never>): Promise<void> {
  if (host.busy || host.at >= host.items.length) return;
  host.busy = true;
  try {
    host.sentinel?.remove();
    host.sentinel = null;
    const from = host.at;
    const to = Math.min(from + CHUNK, host.items.length);
    const slice = host.items.slice(from, to) as never[];
    await host.opts.prepare?.(slice, from, to);
    const holder = document.createElement('div');
    holder.innerHTML = slice.map((t, k) => host.opts.html(t, from + k)).join('');
    const els = [...holder.children] as HTMLElement[];
    for (const el of els) box.appendChild(el);
    els.forEach((el, k) => host.opts.bind?.(el, host.items[from + k] as never, from + k));
    host.at = to;
    if (to < host.items.length) {
      const p = document.createElement('p');
      p.className = 'dim moreRows';
      p.textContent = '還有 ' + (host.items.length - to).toLocaleString() + ' 列（捲到底自動載入，或點這裡）';
      p.onclick = () => { void grow(box, host); };
      box.appendChild(p);
      host.sentinel = p;
    }
  } finally {
    host.busy = false;
  }
}

function maybeGrow(box: HTMLElement): void {
  const host = hosts.get(box);
  if (!host || host.busy || host.at >= host.items.length) return;
  // 240 px of slack, so the next chunk is already there when the reader arrives
  if (box.scrollTop + box.clientHeight >= box.scrollHeight - 240) void grow(box, host);
}

/** replace the content of the box with the first chunk of items */
export async function renderChunked<T>(box: HTMLElement, items: T[], opts: ChunkOpts<T>): Promise<void> {
  const host: Host<T> = { items, opts, at: 0, busy: false, sentinel: null };
  hosts.set(box, host as unknown as Host<never>);
  if (!wired.has(box)) {
    wired.add(box);
    box.addEventListener('scroll', () => maybeGrow(box));
  }
  box.innerHTML = '';
  const want = Math.min(Math.max(CHUNK, opts.min ?? 0), items.length);
  while (host.at < want) await grow(box, host as unknown as Host<never>);
}

/** mount further chunks until pred holds (for a row that has to be scrolled to) */
export async function growUntil(box: HTMLElement, pred: () => boolean): Promise<boolean> {
  const host = hosts.get(box);
  if (!host) return pred();
  while (!pred() && host.at < host.items.length) await grow(box, host);
  return pred();
}
