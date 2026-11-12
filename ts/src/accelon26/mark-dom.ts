/**
 * 在「已渲染的 DOM」上把一段字包成 mark（跨節點也包得起來）。
 *
 * 為什麼需要這一支：摘要卡片與本文的塗紅都一樣，命中的關鍵字可能跨過
 * `<mark>`、`<span>` 或（跨標點時）好幾個文字節點。`indexOf` 只能在一條
 * 文字節點裡找，跨節點就整段不上色。這裡先收所有文字節點、合起來算位移，
 * 再用 `Range` 逐段包——視覺上是連續的一整段。
 *
 * 與 `paint.ts` 的 `markRange` 同一套做法；抽出來是因為摘要卡片也要用，
 * 而 paint.ts 依賴 doc-pane（在摘要裡 import 會繞成循環）。
 */

/**
 * 一行／一張卡裡的所有文字節點。跳過渲染器自己加的、不是原文的元素
 * （頁碼 `.pageBreak`、段落縮排 `.paraIndent`）。
 */
export function textNodesOf(root: Node, skip?: (el: HTMLElement) => boolean): Text[] {
  const out: Text[] = [];
  const walk = (n: Node) => {
    if (n.nodeType === Node.TEXT_NODE) { out.push(n as Text); return; }
    const el = n as HTMLElement;
    if (el.classList?.contains('pageBreak') || el.classList?.contains('paraIndent')) return;
    if (skip && skip(el)) return;
    for (const c of [...n.childNodes]) walk(c);
  };
  walk(root);
  return out;
}

/** 節點串起來的文字（與畫面一致：節點之間不加東西）。 */
export function joinedText(nodes: Text[]): string {
  return nodes.map((n) => n.textContent ?? '').join('');
}

export interface MarkSpan {
  start: number;
  end: number;
  /** `mark` 的 class（例如 `kw`、`kw cur`、`docHit`） */
  className: string;
  /** 直接設在 mark 上的樣式（例如 `--hue:120`） */
  style?: Record<string, string>;
  /** 寫進 `dataset`（例如 `va`） */
  data?: Record<string, string>;
}

/**
 * 把 `nodes` 合起來的第 `start..end` 字包成 mark（可能跨好幾個節點）。
 * 由後往前包，前面節點的位移才不會被影響。回傳第一個（最左）mark。
 */
export function markSpan(nodes: Text[], span: MarkSpan): HTMLElement | null {
  const pieces: { node: Text; from: number; to: number }[] = [];
  let acc = 0;
  for (const node of nodes) {
    const len = node.textContent?.length ?? 0;
    const a = Math.max(span.start, acc);
    const b = Math.min(span.end, acc + len);
    if (b > a) pieces.push({ node, from: a - acc, to: b - acc });
    acc += len;
  }
  let first: HTMLElement | null = null;
  for (let i = pieces.length - 1; i >= 0; i--) {
    const p = pieces[i];
    const host = p.node.parentElement;
    // 這一段已經被其他 mark 包住：直接沿用，補 class／顏色即可
    if (host && host.tagName === 'MARK') {
      for (const c of span.className.split(' ')) if (c) host.classList.add(c);
      for (const [k, v] of Object.entries(span.style ?? {})) host.style.setProperty(k, v);
      for (const [k, v] of Object.entries(span.data ?? {})) host.dataset[k] = v;
      first = host;
      continue;
    }
    const range = document.createRange();
    range.setStart(p.node, p.from);
    range.setEnd(p.node, p.to);
    const mark = document.createElement('mark');
    mark.className = span.className;
    for (const [k, v] of Object.entries(span.style ?? {})) mark.style.setProperty(k, v);
    for (const [k, v] of Object.entries(span.data ?? {})) mark.dataset[k] = v;
    try {
      range.surroundContents(mark);
      first = mark;
    } catch { /* 跨 element 邊界包不起來：跳過這一段 */ }
  }
  return first;
}
