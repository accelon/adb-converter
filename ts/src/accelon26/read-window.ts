/**
 * 讀窗（read window）與分窗（window split）——作者 2026-11-02 定案。
 *
 * 「讀窗」＝畫面上那一個閱讀頁面整體；「分窗」＝它在哪裡切開（對應「分頁」）。
 * 以前是純算術：一個 realm 每 200 行切一頁，所以常切在句子中間、或切在 `<頁>` 之後
 * 讓讀者以為沒下文。現在改成**邏輯切分**：
 *
 *   1. `<文>`（標籤本身或 `u="文"` 屬性）是邊界：起點在 `<文>` 裡就讀到 `</文>`
 *      （以下一個 `<文>` 的前一行近似）。
 *   2. `u="文"` 的節點（部／章／節…）連讀：到**下一個 `u="文"` 節點的前一行**。
 *   3. 不然就到**下一個目錄節點的前一行**。
 *   4. 太短（< `minLines`＝20）而且界線不是**大標題**（深度 ≤ 1）→ 往下挖一層，
 *      把第一個子節點的正文收進來。
 *   5. 太長（> `maxLines`＝400）→ 退到**第一個 `<段>`** 之前（不停在句子中間）。
 *   6. **標題群不可切開**：連續標題行（中間最多夾 2 行空白／只有 `<頁>`、`<段>` 的行）
 *      算同一群；群歸給它後面的正文，讀窗**從群裡最大的標題開始**、
 *      **不得以標題群結尾**。
 *
 * 全部現算（索引放記憶體，關庫就回收），**不寫進 adb**、也不存 settings
 * ——作者 2026-11-02：「不需要記錄 adb 的閱讀切分點，省一點記憶體」。
 */
import type { AdbReader } from './adb';

/** 一個讀窗的界線（行號，0 起） */
export interface ReadWindow {
  first: number;
  last: number;
  /** 為什麼切在這裡（診斷／測試用，不顯示給使用者）：wen／node／min／seg／cap／realm */
  why: string;
}

/** 分窗需要的索引（行號升冪） */
export interface WindowSource {
  /** 這個庫有幾行 */
  lineCount: number;
  /** 目錄節點的起始行 */
  nodeStarts: number[];
  /** 對應的節點深度（0＝最上層；≤1 視為「大標題」） */
  nodeDepths: number[];
  /** `<文>` 標籤或 `u="文"` 節點的起始行 */
  wenStarts: number[];
  /** `<段>` 的起始行 */
  segStarts: number[];
  /** `<頁>` 的起始行（保底用） */
  pageStarts: number[];
}

export interface WindowOptions {
  /** 一窗最多幾行（作者 2026-11-02：放寬到 400） */
  maxLines?: number;
  /** 一窗至少幾行（除非碰到大標題；作者 2026-11-02：20） */
  minLines?: number;
  /** 標題群之間最多允許幾行間隔（作者 2026-11-02：一兩行） */
  gapLines?: number;
  /** 這一窗最早只能從哪一行開始（翻頁時傳「上一窗的最後一行＋1」，保證不重疊） */
  minFirst?: number;
}

export const WINDOW_MAX_LINES = 400;
export const WINDOW_MIN_LINES = 20;
export const WINDOW_GAP_LINES = 2;

/** 在升冪陣列裡找第一個 > v 的值（沒有回 -1） */
function nextGreater(arr: number[], v: number): number {
  let lo = 0, hi = arr.length - 1, at = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] > v) { at = mid; hi = mid - 1; } else lo = mid + 1;
  }
  return at < 0 ? -1 : arr[at];
}

/** 找最後一個 ≤ v 的索引（沒有回 -1） */
function lastLE(arr: number[], v: number): number {
  let lo = 0, hi = arr.length - 1, at = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= v) { at = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return at;
}

/** 這一行是不是節點起始行？是就回深度，不是回 -1 */
function depthAt(src: WindowSource, line: number): number {
  const i = lastLE(src.nodeStarts, line);
  return i >= 0 && src.nodeStarts[i] === line ? src.nodeDepths[i] : -1;
}

/** 一行是不是「空的」：只有空白、或只有 `<頁>`／`<段>` 這種標記（判標題群間隔用） */
const isBlankish = (plain: string): boolean => !plain.trim();

/** 往上找最近的一個「非空白」行（中間最多 `gap` 行空白／標記行）；沒有回 -1 */
/** 從 `line+1` 起找「隔著最多 gap 行空白」的第一個標題行；沒有回 -1 */
async function nextHeadingWithin(
  src: WindowSource, line: number, gap: number, plainOf: (i: number) => Promise<string>,
): Promise<number> {
  let at = line + 1;
  let skipped = 0;
  while (at < src.lineCount && skipped <= gap && isBlankish(await plainOf(at))) { at++; skipped++; }
  return at < src.lineCount ? at : -1;
}

async function upSkippingBlank(
  first: number, gap: number, plainOf: (i: number) => Promise<string>,
): Promise<number> {
  let up = first - 1;
  let skipped = 0;
  while (up >= 0 && skipped <= gap && isBlankish(await plainOf(up))) { up--; skipped++; }
  return up < 0 ? -1 : up;
}

/**
 * 起點往前吸收標題群：如果上面（隔一兩行空白）是**更上層的標題**，起點就移到它。
 * 這樣「節」不會單獨當一窗的開頭（作者 2026-11-02：不能上一窗最後一行是章、
 * 下一窗第一行是小節）。
 */
export async function alignWindowStart(
  src: WindowSource, line: number, plainOf: (i: number) => Promise<string>, gap = WINDOW_GAP_LINES, floor = 0,
): Promise<number> {
  let first = Math.max(floor, line);
  const d0 = depthAt(src, first);
  if (d0 < 0) return first;                    // 起點不是標題：不動
  let depth = d0;
  for (let step = 0; step < 8; step++) {
    const up = await upSkippingBlank(first, gap, plainOf);
    if (up < floor) break;
    const du = depthAt(src, up);
    if (du < 0 || du >= depth) break;          // 上面不是標題、或不是更上層 → 不吸收
    first = up;
    depth = du;
  }
  return first;
}

/**
 * 從 `fromLine` 算一個讀窗。`realmLast` 是 realm 的最後一行（`boundsOfRealm` 的 last）。
 */
export async function computeReadWindow(
  src: WindowSource,
  fromLine: number,
  realmLast: number,
  plainOf: (i: number) => Promise<string>,
  opts: WindowOptions = {},
): Promise<ReadWindow> {
  const maxLines = opts.maxLines ?? WINDOW_MAX_LINES;
  const minLines = opts.minLines ?? WINDOW_MIN_LINES;
  const gap = opts.gapLines ?? WINDOW_GAP_LINES;
  const capLast = Math.max(0, Math.min(realmLast, src.lineCount - 1));
  const floor = Math.max(0, opts.minFirst ?? 0);
  let first = await alignWindowStart(src, Math.max(floor, Math.min(fromLine, capLast)), plainOf, gap, floor);
  if (first > capLast) first = capLast;
  const maxLast = Math.min(capLast, first + maxLines - 1);

  /** 窗尾若是標題，整個標題群歸下一個讀窗：往前退到群的前一行 */
  const cutBeforeHeadingGroup = async (boundary: number): Promise<number> => {
    let end = boundary;
    for (let guard = 0; guard < 12 && end > first; guard++) {
      if (depthAt(src, end) < 0) break;
      let top = end;
      let depth = depthAt(src, end);
      for (let k = 0; k < 8; k++) {
        const up = await upSkippingBlank(top, gap, plainOf);
        if (up < first) break;
        const du = depthAt(src, up);
        if (du < 0 || du >= depth) break;
        top = up;
        depth = du;
      }
      end = top - 1;
    }
    return end;
  };
  /** 把窗尾退到最近的 `<段>` 之前（避免停在句子中間） */
  const cutAtSegment = (end: number): number => {
    const i = lastLE(src.segStarts, end);
    if (i < 0) return end;
    const seg = src.segStarts[i];
    return seg > first + 2 ? seg - 1 : end;    // 段界太靠近窗首就維持原樣
  };

  // 1) `<文>`／`u="文"`：到下一個「文」邊界的前一行
  let boundary = nextGreater(src.wenStarts, first);
  let why = 'wen';
  if (boundary < 0 || boundary > maxLast) {
    // 2) 下一個目錄節點
    boundary = nextGreater(src.nodeStarts, first);
    why = 'node';
    if (boundary < 0) { boundary = capLast + 1; why = 'realm'; }
    else if (boundary > maxLast) { boundary = maxLast + 1; why = 'cap'; }
  }
  let end = Math.min(capLast, boundary - 1);

  // 3) 太短（而且不是碰到大標題）→ 往下挖一層，把下一個節點的正文收進來
  const nextDepth = boundary <= capLast ? depthAt(src, boundary) : -1;
  const bigHeading = nextDepth >= 0 && nextDepth <= 1;
  if (end - first + 1 < minLines && !bigHeading) {
    const after = nextGreater(src.nodeStarts, end);
    if (after >= 0 && after <= capLast) {
      const nn2 = nextGreater(src.nodeStarts, after);
      const room = nn2 < 0 ? capLast + 1 : Math.min(nn2, capLast + 1);
      if (room - 1 > end) { end = Math.min(room - 1, capLast); why = 'min'; }
    }
  }

  // 4) 太長（超過 maxLines）→ 退到 `<段>` 之前
  if (end - first + 1 > maxLines) {
    end = cutAtSegment(Math.min(maxLast, end));
    why = 'seg';
  }

  // 5) 標題群不可切開：
  //    (a) 窗尾本身是標題 → 整個群歸下一個讀窗
  //    (b) 下一個讀窗會從某個標題群開始（`end+1` 或隔幾行空白就是標題）→ 這一窗必須
  //        收在那個群的前一行，否則下一個讀窗把起點往前吸到群頂時就會和前後重疊
  end = await cutBeforeHeadingGroup(end);
  for (let guard = 0; guard < 6; guard++) {
    const nxt = await nextHeadingWithin(src, end, gap, plainOf);
    if (nxt < 0) break;
    let top = nxt;
    let depth = depthAt(src, nxt);
    for (let k = 0; k < 8; k++) {
      const up = await upSkippingBlank(top, gap, plainOf);
      if (up < first) break;
      const du = depthAt(src, up);
      if (du < 0 || du >= depth) break;
      top = up;
      depth = du;
    }
    if (top > end) break;          // 群在下一個讀窗的開頭，不必退
    end = top - 1;
    end = await cutBeforeHeadingGroup(end);
  }

  // 6) 保底：至少一行
  if (end < first) end = Math.min(capLast, first);
  return { first, last: end, why };
}

/** 從 `line` 往回找一個讀窗（上一窗）：先退到 minLines 之前再算一窗，確保不會原地打轉 */
export async function previousReadWindow(
  src: WindowSource, line: number, realmFirst: number,
  plainOf: (i: number) => Promise<string>, opts: WindowOptions = {},
): Promise<ReadWindow> {
  const minLines = opts.minLines ?? WINDOW_MIN_LINES;
  const from = Math.max(realmFirst, line - Math.max(minLines, 1));
  return computeReadWindow(src, from, Math.max(realmFirst, line - 1), plainOf, opts);
}

/** 診斷／測試用：把讀窗寫成一行字 */
export const windowLabel = (w: ReadWindow): string =>
  `${w.first}–${w.last}（${w.last - w.first + 1} 行，${w.why}）`;

/**
 * 從一個已開啟的 adb 建 `WindowSource`。
 *
 * * `nodes`：目錄節點（閱讀器給真正的樹節點；測試可以給「標籤→深度」的簡表）。
 * * `mapper`：VA → 行號。
 *
 * 只讀 adb 現成的容器／屬性，**不寫任何東西**。
 */
export async function windowSourceFromReader(
  r: AdbReader,
  mapper: { lineOfVa(va: number): number },
  nodes: { va: number; depth: number }[] = [],
): Promise<WindowSource> {
  const tagsC = r.containers.get('tags');
  const linesOf = async (tag: string): Promise<number[]> => {
    const ti = tagsC?.names.indexOf(tag) ?? -1;
    if (ti < 0) return [];
    const vas = await r.decodeBlockList('tags', ti);
    return vas.map((va) => mapper.lineOfVa(va)).filter((n) => n >= 0).sort((a, b) => a - b);
  };
  /** 屬性值 → 起始行（`u="文"`、`段.n`、`頁.id` 都是這個模式） */
  const linesOfAttr = async (tag: string, attr: string, keep?: (v: string) => boolean): Promise<number[]> => {
    const ti = tagsC?.names.indexOf(tag) ?? -1;
    if (ti < 0) return [];
    const av = await r.attributeValues(attr).catch(() => null);
    if (!av?.pointers) return [];
    const vas = await r.decodeBlockList('tags', ti);
    const out: number[] = [];
    for (let k = 0; k < av.values.length; k++) {
      if (keep && !keep(av.values[k])) continue;
      const p = av.pointers[k];
      if (((p >>> 24) & 0xff) !== ti) continue;
      const va = vas[(p & 0xffffff) - 1];
      if (va == null) continue;
      const line = mapper.lineOfVa(va);
      if (line >= 0) out.push(line);
    }
    return [...new Set(out)].sort((a, b) => a - b);
  };
  const nodeStarts = [...new Set(nodes.map((n) => mapper.lineOfVa(n.va)).filter((n) => n >= 0))]
    .sort((a, b) => a - b);
  const depthOf = new Map<number, number>();
  for (const n of nodes) {
    const line = mapper.lineOfVa(n.va);
    if (line < 0) continue;
    const cur = depthOf.get(line);
    if (cur === undefined || n.depth < cur) depthOf.set(line, n.depth);
  }
  const nodeDepths = nodeStarts.map((line) => depthOf.get(line) ?? 0);
  // `<文>` 標籤本身，以及 u="文" 的結構標籤（部／章／節／…）
  const wenTag = await linesOf('文');
  const wenAttrs: number[] = [];
  for (const key of r.containers.get('attributes')?.names ?? []) {
    const dot = key.lastIndexOf('.');
    if (dot <= 0 || key.slice(dot + 1) !== 'u') continue;
    wenAttrs.push(...await linesOfAttr(key.slice(0, dot), key, (v) => v.trim() === '文'));
  }
  const wenStarts = [...new Set([...wenTag, ...wenAttrs])].sort((a, b) => a - b);
  return {
    lineCount: r.header.lineCount,
    nodeStarts,
    nodeDepths,
    wenStarts,
    segStarts: await linesOf('段'),
    pageStarts: await linesOf('頁'),
  };
}
