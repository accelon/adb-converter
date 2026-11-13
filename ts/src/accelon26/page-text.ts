/**
 * 頁文字與頁座標的共用層（2026-11-01）。
 *
 * 這一支**不碰 DOM**，只吃 `AdbReader`，所以閱讀器（xref）與各 adb 工作區的
 * 產生器（fuyan 的 `taisho-pages.ts`／`ys-pages.ts`、ys 的 `addj.ts` 等）都可以
 * import，不必各自重寫「頁 id → VA → 區塊 → 純漢字」。
 *
 * 座標規則：漢字逐 code point（`han.ts`），回傳的是「純漢字字串」；
 * `j`／`off` 就是這個字串的索引。
 */
import type { AdbReader } from './adb';
import { hanChars } from './han';
import { VaPaMapper } from './vapa';

export interface AnchorIndex {
  values: string[];
  pointers: Int32Array;
  vas: number[];
  tags: string[];
  bv: number[];
  bookVas: number[];
  juanVas: number[];
  volVas: number[];
  lianVas: number[];
}

const indexCache = new Map<AdbReader, AnchorIndex>();

/** 頁 id 表：`attributes/頁.id` → pointer → `tags/頁` 的 VA（每個 reader 快取一次）。 */
export async function anchorIndex(r: AdbReader): Promise<AnchorIndex | null> {
  const hit = indexCache.get(r);
  if (hit) return hit;
  const av = await r.attributeValues('頁.id');
  if (!av || !av.pointers) return null;
  const tagsC = r.containers.get('tags');
  const ti = tagsC?.names.indexOf('頁') ?? -1;
  if (!tagsC || ti < 0) return null;
  const list = async (name: string): Promise<number[]> => {
    const i = tagsC.names.indexOf(name);
    return i < 0 ? [] : r.decodeBlockList('tags', i);
  };
  const idx: AnchorIndex = {
    values: av.values,
    pointers: av.pointers as Int32Array,
    vas: await r.decodeBlockList('tags', ti),
    tags: tagsC.names,
    bv: await r.blocksVirtual(),
    bookVas: await list('書'),
    juanVas: await list('卷'),
    volVas: await list('冊'),
    lianVas: await list('聯'),
  };
  indexCache.set(r, idx);
  return idx;
}

/** 頁 id 可以省略 `p` 之後的前導 0：`9p94a` → `9p0094a`（作者 2026-11-06：讓 <聯> 短一點） */
export function padPageId(id: string): string {
  const m = /^(\d+)[pP](\d+)([a-z]?)$/.exec(id);
  if (!m) return id;
  const p = m[2].padStart(4, '0');
  return p === m[2] ? id : `${m[1]}p${p}${m[3]}`;
}

/** 去掉 `p` 之後多餘的前導 0：`9p0094a` → `9p94a`（ys.adb 2026-11-06 起也用短碼） */
export function shortPageId(id: string): string {
  const m = /^(\d+)[pP]0*(\d+)([a-z]?)$/.exec(id);
  if (!m) return id;
  const short = `${m[1]}p${parseInt(m[2], 10)}${m[3]}`;
  return short === id ? id : short;
}

/** 頁 id → VA（走 accelon3 的 attributes/頁.id → pointer → tags/頁 鏈）；
 *  沒有頁 id 或頁 id 不中時，依序退回 `塊.段` 與「通用節點錨點」（科判等，見 nodeAnchorInfo）。 */
export async function anchorVa(r: AdbReader, anchor: string): Promise<number | null> {
  // `#N`／`#詞` 只是句內詞序（vedic 的 `<詞 w="1">`），不影響 VA；先切掉再定位。
  // key 由閱讀端（word-hl.ts）另行反白，見 `splitWordKey()`。
  const hash = anchor.indexOf('#');
  const base = hash >= 0 ? anchor.slice(0, hash) : anchor;
  const idx = await anchorIndex(r);
  if (idx) {
    // 前導 0 可有可無：`9p94a`／`9p0094a` 都能命中（ys 新舊版頁 id 並存時也一樣）
    let i = idx.values.indexOf(base);
    const candidates = [padPageId(base), shortPageId(base)];
    // fuyan 的舊頁 id 是 `yl38p107`，新寫法（與 ys 同步）是 `38p107`；兩種都接受。
    if (r.header.dbname === 'fuyan' && /^[0-9]+p/i.test(base)) candidates.push('yl' + base);
    for (const cand of candidates) {
      if (i >= 0) break;
      if (cand !== base) i = idx.values.indexOf(cand);
    }
    if (i >= 0) {
      const ptr = idx.pointers[i];
      if (idx.tags[(ptr >>> 24) & 0xff] === '頁') {
        const va = idx.vas[(ptr & 0xffffff) - 1];
        if (va != null) return va;
      }
    }
  }
  // 沒有 `<頁>` 標籤的庫（sz 系列）：退回 `塊.段` 定位；都沒有就試通用節點錨點。
  const loc = await locatorVa(r, base);
  if (loc != null) return loc;
  const node = await nodeAnchorInfo(r, anchor);
  return node ? node.va : null;
}

/** `標籤.屬性` → 值 → VA 清單（走 attributes 的共用鏈，和 anchorIndex 同一套） */
async function attrVas(r: AdbReader, tag: string, attr: string): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  const tagsC = r.containers.get('tags');
  const ti = tagsC?.names.indexOf(tag) ?? -1;
  if (!tagsC || ti < 0) return out;
  const av = await r.attributeValues(`${tag}.${attr}`).catch(() => null);
  if (!av || !av.pointers) return out;
  const vas = await r.decodeBlockList('tags', ti);
  for (let k = 0; k < av.values.length; k++) {
    const ptr = av.pointers[k];
    const va = vas[(ptr & 0xffffff) - 1];
    if (va == null) continue;
    const key = av.values[k];
    const list = out.get(key) ?? [];
    list.push(va);
    out.set(key, list);
  }
  for (const list of out.values()) list.sort((a, b) => a - b);
  return out;
}

// ───────────────────── 通用節點錨點（科判等結構節點，2026-11-13） ─────────────────────

export interface NodeAnchorInfo {
  va: number;
  /** 下一個結構節點的 VA（節點範圍到那裡為止）；沒有就 null（到檔尾）。 */
  vaEnd: number | null;
  tag: string;
  ns: string;
  value: string;
}

interface NodeAnchorIndex {
  /** `ns#值` → VA（帶命名空間，精確） */
  nsMap: Map<string, number>;
  /** `值` → VA（文件序第一筆；同值跨著作時取最早那個） */
  bare: Map<string, number>;
  vaInfo: Map<number, { tag: string; value: string; ns: string }>;
  /** 所有錨點標籤實例的 VA（排序；用來算節點範圍） */
  endVas: number[];
  nsTag: string;
  /** 標籤 → 樹層序（篇=0、章=1、科NN=1+NN；跨多條 `t=` 取最小）。給子樹界用。 */
  rank: Map<string, number>;
}
const nodeAnchorCache = new WeakMap<AdbReader, Promise<NodeAnchorIndex | null>>();

async function tagVasList(r: AdbReader, tag: string): Promise<number[]> {
  const tagsC = r.containers.get('tags');
  const ti = tagsC?.names.indexOf(tag) ?? -1;
  return tagsC && ti >= 0 ? r.decodeBlockList('tags', ti) : [];
}

/** 樹 `t="篇,章,科01,…,科54."` → 標籤清單（去尾點、去空白）。 */
function levelsOf(t: string): string[] {
  return t.split(',').map((x) => x.trim().replace(/[.\s]+$/, '')).filter(Boolean);
}

/** 節點標題文字：去掉標籤後，取最後一個括號內的代碼（`瑜伽師地論（T1579）`→`T1579`）。 */
async function nodeLabelCode(r: AdbReader, tag: string, va: number): Promise<string> {
  const mp = await mapperOf(r);
  const line = mp.edgeLine(va);
  let t = await mp.lineText(line);
  t = t.replace(new RegExp('^\\s*<' + tag + '(?=[\\s/>])[^>]*>'), '');
  const close = t.indexOf('</' + tag + '>');
  if (close >= 0) t = t.slice(0, close);
  t = t.replace(/<[^>]*>/g, '').trim();
  const pm = /[（(]([^（）()]+)[）)]\s*$/.exec(t);
  return pm ? pm[1].trim() : t;
}

/**
 * 通用節點錨點索引：
 * - 錨點標籤＝所有 `<樹 t="…">` 宣告的層級標籤聯集（若有 `<錨>` 也納入）。
 * - 命名空間＝層級最多那條 `t=` 的第一個標籤（通常「篇／書」）；值優先取該標籤實例的
 *   `id`／`n` 屬性，沒有就讀標題最後一個括號內的代碼（ybh：`（T1579）`、`（PXJ-H）`）。
 * - 索引 `ns#值 → VA` 與 `值 → VA`（文件序第一筆）。第一次建立後快取。
 */
async function nodeAnchorIndex(r: AdbReader): Promise<NodeAnchorIndex | null> {
  let p = nodeAnchorCache.get(r);
  if (!p) { p = buildNodeAnchorIndex(r); nodeAnchorCache.set(r, p); }
  return p;
}

async function buildNodeAnchorIndex(r: AdbReader): Promise<NodeAnchorIndex | null> {
  const treeT = await attrVas(r, '樹', 't');
  const lists = [...treeT.keys()].map(levelsOf).filter((a) => a.length);
  const tagsC = r.containers.get('tags');
  const anchorTags = new Set<string>();
  for (const L of lists) for (const t of L) anchorTags.add(t);
  if (tagsC?.names.includes('錨')) anchorTags.add('錨');
  if (!anchorTags.size) return null;
  // 命名空間標籤：層級最多那條 t= 的第一個（ybh 的 t= 有 56 層 → 篇）
  const nsList = [...lists].sort((a, b) => b.length - a.length)[0];
  const nsTag = nsList?.[0] ?? '';
  // 標籤 → 樹層序（篇=0、章=1、科NN=1+NN；跨多條 t= 取最小）。`<嵌 sub="1">` 靠它定子樹界。
  // 科判家族（科漢01、科基02…，多樹庫 ybh v5）一律按層號定序（100+NN）：
  // 各家族自己的鏈索引都從 0 起，混鏈會把「章」（rank 1）誤排進 科X01（rank 0）之下，
  // 子樹界就跨不出卷。層號定序後：任何家族的 01 都在 章 之下、NN 隨深度單調。
  const rank = new Map<string, number>();
  for (const L of lists) L.forEach((t, i) => { const c = rank.get(t); if (c === undefined || i < c) rank.set(t, i); });
  for (const L of lists) for (const t of L) {
    const km = /^科[一-鿿]?(\d\d)$/.exec(t);
    if (km) rank.set(t, 100 + +km[1]!); // 覆寫：家族鏈自己的 01 是 index 0，不覆寫會排到 章 之上
  }

  // 命名空間值（VA → 名稱）
  const nsValByVa = new Map<number, string>();
  for (const attr of ['id', 'n']) {
    const m = await attrVas(r, nsTag, attr);
    for (const [val, vas] of m) for (const va of vas) if (!nsValByVa.has(va)) nsValByVa.set(va, val);
  }
  const nsVas = (await tagVasList(r, nsTag)).slice().sort((a, b) => a - b);
  for (const va of nsVas) {
    if (!nsValByVa.has(va) && nsTag) nsValByVa.set(va, await nodeLabelCode(r, nsTag, va));
  }
  const nsFor = (va: number): string => {
    let lo = 0, hi = nsVas.length - 1, ans = -1;
    while (lo <= hi) { const md = (lo + hi) >> 1; if (nsVas[md] <= va) { ans = md; lo = md + 1; } else hi = md - 1; }
    return ans < 0 ? '' : (nsValByVa.get(nsVas[ans]) ?? '');
  };

  // 卷級命名空間（2026-11-13，ybh 請求）：第二層標籤（章）的 id 形如 `W-V`，
  // 例如 `<章 id="T1579-1">`。kpD 編號每卷重排，篇級 `W#kp` 會在多卷間撞號；
  // 卷級 `W-V#kp` 才是全局唯一。只在章 id **全域唯一**時啟用，避免其他庫的
  // 「章1、章2」跨著作撞號（此時退回只有篇級別名，行為與舊版相同）。
  const volTag = nsList?.[1] ?? '';
  const volIdByVa = new Map<number, string>();
  let volVas: number[] = [];
  if (volTag) {
    const m = await attrVas(r, volTag, 'id');
    for (const [val, vas] of m) for (const va of vas) volIdByVa.set(va, val);
    const ids = [...volIdByVa.values()];
    if (ids.length && new Set(ids).size === ids.length) volVas = [...volIdByVa.keys()].sort((a, b) => a - b);
    else volIdByVa.clear();
  }
  const volFor = (va: number): string => {
    if (!volVas.length) return '';
    let lo = 0, hi = volVas.length - 1, ans = -1;
    while (lo <= hi) { const md = (lo + hi) >> 1; if (volVas[md] <= va) { ans = md; lo = md + 1; } else hi = md - 1; }
    return ans < 0 ? '' : (volIdByVa.get(volVas[ans]) ?? '');
  };

  const nsMap = new Map<string, number>();
  const bareCand = new Map<string, number>();
  const vaInfo = new Map<number, { tag: string; value: string; ns: string }>();
  const endSet = new Set<number>();
  for (const tag of anchorTags) {
    for (const attr of ['n', 'id']) {
      const m = await attrVas(r, tag, attr);
      for (const [rawVal, vas] of m) {
        const value = rawVal.trim();
        if (!value) continue;
        for (const va of vas) {
          endSet.add(va);
          const ns = tag === nsTag ? '' : nsFor(va);
          if (ns) nsMap.set(ns + '#' + value, va);
          // 卷級別名（章 id＝W-V）：只在本章範圍內生效，精確到卷
          const vol = tag === nsTag ? '' : volFor(va);
          if (vol) nsMap.set(vol + '#' + value, va);
          const prev = bareCand.get(value);
          if (prev == null || va < prev) bareCand.set(value, va);
          if (!vaInfo.has(va)) vaInfo.set(va, { tag, value, ns });
        }
      }
    }
  }
  return { nsMap, bare: bareCand, vaInfo, endVas: [...endSet].sort((a, b) => a - b), nsTag, rank };
}

/**
 * 解析通用節點錨點，回 VA 與節點範圍。
 * `NS#值` 或 `NS/值` 為帶命名空間；純值取文件序第一筆。
 * 命名空間給了卻找不到 → 回 null（不退回純值，避免跳到錯的著作）。
 */
export async function nodeAnchorInfo(r: AdbReader, anchor: string): Promise<NodeAnchorInfo | null> {
  const idx = await nodeAnchorIndex(r);
  if (!idx) return null;
  let va: number | undefined;
  let ns = '';
  let value = anchor;
  const nsSep = /^([^#/]+)[#/](.+)$/.exec(anchor);
  if (nsSep) {
    ns = nsSep[1];
    value = nsSep[2];
    va = idx.nsMap.get(ns + '#' + value);
    if (va == null) return null;
  } else {
    va = idx.bare.get(value);
    if (va == null) return null;
  }
  const info = idx.vaInfo.get(va);
  // 節點範圍＝下一個錨點 VA（二分）
  let vaEnd: number | null = null;
  let lo = 0, hi = idx.endVas.length - 1, ans = -1;
  while (lo <= hi) { const md = (lo + hi) >> 1; if (idx.endVas[md] > va) { ans = md; hi = md - 1; } else lo = md + 1; }
  if (ans >= 0) vaEnd = idx.endVas[ans];
  return { va, vaEnd, tag: info?.tag ?? '', ns: info?.ns ?? ns, value: info?.value ?? value };
}

/**
 * 節點的**子樹界**（`<嵌 sub="1">` 語義）：從 va 往後走 endVas，取第一個
 * 「同層或更淺」的錨點 VA 為排他界；一路更深（全是子孫）直到檔尾時回 null。
 * 層序來自樹 `t=` 的宣告次序（篇=0、章=1、科NN=1+NN）。
 */
export async function nodeSubtreeEnd(r: AdbReader, va: number): Promise<number | null> {
  const idx = await nodeAnchorIndex(r);
  if (!idx) return null;
  const rankOf = (v: number): number => idx.rank.get(idx.vaInfo.get(v)?.tag ?? '') ?? Number.POSITIVE_INFINITY;
  const me = rankOf(va);
  if (!Number.isFinite(me)) return null;
  let lo = 0, hi = idx.endVas.length; // 第一個 > va 的位置
  while (lo < hi) { const md = (lo + hi) >> 1; if (idx.endVas[md]! <= va) lo = md + 1; else hi = md; }
  for (let i = lo; i < idx.endVas.length; i++) {
    const ev = idx.endVas[i]!;
    const rk = idx.rank.get(idx.vaInfo.get(ev)?.tag ?? '');
    if (rk !== undefined && rk <= me) return ev;
  }
  return null;
}

/** 節點範圍的原始文字（含標籤；給 `<嵌>` 用）。從節點 VA 的行讀到 vaEnd 前一行。 */
export async function nodeSpanText(r: AdbReader, va: number, vaEnd: number | null, maxLines = 60): Promise<string> {
  const mp = await mapperOf(r);
  const total = r.header.lineCount;
  const start = mp.edgeLine(va);
  let end = vaEnd != null ? mp.edgeLine(Math.max(va, vaEnd - 1)) : Math.min(total - 1, start + maxLines - 1);
  end = Math.min(end, start + maxLines - 1, total - 1);
  const out: string[] = [];
  for (let L = start; L <= end; L++) out.push(await mp.lineText(L));
  return out.join('\n');
}

/**
 * 定位字串 `塊.段[:句]`（`a6.7`／`a6.7:3`）→ VA：不用 `<頁>` 標籤，直接查
 * `attributes/塊.id` 與 `attributes/段.n`，取「同一個塊裡的第一個該段」。
 * （作者 2026-11-02 定案：跨庫用 `ck.n` 跳；`:` 後面是「句」，1 起算。）
 *
 * 句＝`<段>` 所在的那一行算第 1 句，往後每行加 1（一個 adb 行就是一句）。
 * 行界用 `lines.virtual`（每一行的起始 VA），所以不需要額外的 `<句>` 標籤。
 */
/**
 * `塊.段[:句][#詞]`：`d1.7`、`d1.7:3`、`d1.7:3#2`。
 * `#詞` 是句內第 k 個詞（1 起算，用空白切），解析時只影響回傳的「位置說明」，
 * VA 仍停在該句——詞的醒目提示由閱讀端自己切文字（見 sz `docs/addressing.md` §8）。
 */
/**
 * 塊 id 可以**分多層**（2026-11-02，為 veda 的 `rv.10.90.3`／`bu.2.4.5`／`sb.2.1.1.1`）：
 * 位址以「最後一個 `.數字`」為段，前面整串（含點）就是塊 id。sz 的 `d1.7`／`dhp-1.1`
 * 只有一層，行為不變。
 */
// 段號可以是區間（cs 有 1,290 個 `<段 n="157-163">`）：連結一律取**首段**，
// 例如 `cs?a3.157-163` → 段 157。見 ped.adb 的 PTS 出處。
const LOCATOR_RE = /^([a-z][a-z0-9_-]*(?:\.[0-9]+)*)\.([0-9]+)(?:-([0-9]+))?(?::([0-9]+))?(?:#([0-9]+))?$/;
const lineVasCache = new WeakMap<AdbReader, number[]>();
const segVasCache = new WeakMap<AdbReader, number[]>();
const mapperCache = new WeakMap<AdbReader, Promise<VaPaMapper>>();

function mapperOf(r: AdbReader): Promise<VaPaMapper> {
  let p = mapperCache.get(r);
  if (!p) { p = (async () => { const m = new VaPaMapper(r); await m.init(); return m; })(); mapperCache.set(r, p); }
  return p;
}

/**
 * 這一行有沒有文字（去掉標籤與空白後非空）。
 *
 * `句` 的單位是「段內第 j 個**有文字的行**」，空白行不算（sz `docs/addressing.md`）。
 * 各譯本段內空行很多（ccc 23,727、kmj 31,942、yh 15,342），把空行算進去，句號會整段位移
 * （cs 有 1,082 段內空行、影響 432 段）——2026-11-03 定案，閱讀器要照同一個規格算。
 */
async function lineHasText(m: VaPaMapper, line: number): Promise<boolean> {
  const t = await m.lineText(line);
  return t.replace(/<[^>]*>/g, '').replace(/[\s\u3000\u00a0]/g, '') !== '';
}


/** 所有 `<段>` 的 VA（遞增），用來找「下一段」的界 */
async function allSegVas(r: AdbReader): Promise<number[]> {
  let v = segVasCache.get(r);
  if (!v) {
    const tagsC = r.containers.get('tags');
    const ti = tagsC?.names.indexOf('段') ?? -1;
    v = ti < 0 ? [] : await r.decodeBlockList('tags', ti);
    segVasCache.set(r, v);
  }
  return v;
}

async function lineVas(r: AdbReader): Promise<number[]> {
  let v = lineVasCache.get(r);
  if (!v) {
    v = await r.linesVirtual();
    lineVasCache.set(r, v);
  }
  return v;
}

/** 第一個「行末 VA ≥ va」的行（二分）：lines.virtual[i] 是第 i 行最後一個 token 的 VA */
function lineOf(vas: number[], va: number): number {
  let lo = 0;
  let hi = vas.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (vas[mid] >= va) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

async function locatorVa(r: AdbReader, anchor: string): Promise<number | null> {
  const m = LOCATOR_RE.exec(anchor);
  if (!m) return null;
  const chunks = (await attrVas(r, '塊', 'id')).get(m[1]) ?? [];
  const segMap = await attrVas(r, '段', 'n');
  // `<段 n="157-163">` 的 n 就是區間字串；先找完整區間，再退回首段。
  const segs = (m[3] ? segMap.get(`${m[2]}-${m[3]}`) : undefined) ?? segMap.get(m[2]) ?? [];
  if (!chunks.length || !segs.length) return null;
  for (let k = 0; k < chunks.length; k++) {
    const start = chunks[k];
    const end = k + 1 < chunks.length ? chunks[k + 1] : Number.POSITIVE_INFINITY;
    const at = segs.findIndex((v) => v > start && v < end);
    if (at < 0) continue;
    const hit = segs[at];
    const j = m[4] ? Number(m[4]) : 1;
    const vas = await lineVas(r);
    const li = lineOf(vas, hit); // 段標記所在的行
    const mp = await mapperOf(r);
    // 段標記那一行有文字 → 它就是第 1 句，`:1`（或不寫句）直接停在段首。
    // 沒有文字（段標記單獨一行）→ 第 1 句順延到第一個有文字的行（sz addressing.md）。
    if (j <= 1 && (await lineHasText(mp, li))) return hit;
    // 「下一段」要拿全部段標記的序列（同一個 n 會在每本書重複出現）
    const all = await allSegVas(r);
    const pos = lineOf(all, hit);
    const nextVa = all[pos + 1] ?? Number.POSITIVE_INFINITY;
    const lastLine = lineOf(vas, nextVa - 1); // 這一段的最後一行
    // 句＝段內第 j 個有文字的行（空白行不算）
    let seen = 0;
    let lineK = lastLine;
    for (let i = li; i <= lastLine; i++) {
      if (!(await lineHasText(mp, i))) continue;
      seen++;
      if (seen === j) { lineK = i; break; }
    }
    if (lineK <= 0) return hit;
    const startVa = vas[lineK - 1] + 1;
    return startVa > hit ? startVa : hit; // 單行段或超界：夾回段首
  }
  return null;
}

/** VA → `塊.段:句`（sz 的 cs／譯本；有 `塊.id`、`段.n` 的庫才有）。 */
export async function locatorAtVa(
  r: AdbReader,
  va: number,
): Promise<{ block: string; seg: string; sentence: number } | null> {
  const blockMap = await attrVas(r, '塊', 'id');
  const blocks: { va: number; id: string }[] = [];
  for (const [id, vas] of blockMap) for (const v of vas) blocks.push({ va: v, id });
  if (!blocks.length) return null;
  blocks.sort((a, b) => a.va - b.va);
  let bi = -1;
  for (let i = 0; i < blocks.length; i++) { if (blocks[i].va <= va) bi = i; else break; }
  if (bi < 0) return null;
  const block = blocks[bi];
  const next = blocks[bi + 1]?.va ?? Number.POSITIVE_INFINITY;
  const segMap = await attrVas(r, '段', 'n');
  const segs: { va: number; n: string }[] = [];
  for (const [n, vas] of segMap) for (const v of vas) segs.push({ va: v, n });
  segs.sort((a, b) => a.va - b.va);
  let si = -1;
  for (let i = 0; i < segs.length; i++) {
    if (segs[i].va >= block.va && segs[i].va <= va && segs[i].va < next) si = i;
    if (segs[i].va > va) break;
  }
  if (si < 0) return null;
  const seg = segs[si];
  const lines = await lineVas(r);
  const line = lineOf(lines, va);
  const segLine = lineOf(lines, seg.va);
  // 句＝段內第 j 個有文字的行（空白行不算；見 lineHasText 的說明）
  const m = await mapperOf(r);
  let sentence = 0;
  for (let i = segLine; i <= line; i++) {
    if (await lineHasText(m, i)) sentence++;
  }
  // 落在空行或只有段標記的那一行：算它下面（或上面）最近的那一句，最少 1
  if (sentence < 1) sentence = 1;
  return { block: block.id, seg: seg.n, sentence };
}

/** VA 落在哪一個 source 區塊 */
export function blockOf(idx: AnchorIndex, va: number): number {
  let blk = 0;
  for (let k = 0; k < idx.bv.length; k++) { if (idx.bv[k] <= va) blk = k; else break; }
  return blk;
}

/**
 * 目標頁的純漢字序列（`j`／`off` 的座標就是這個字串的索引）。
 *
 * - 從 `<頁 id="…">` 之後起算；
 * - 讀到下一個 `<頁 ` 為止；
 * - 跳過 `<…>` 標籤，只留漢字（`hanChars`，逐 code point）。
 */
export async function pageHanTextOf(r: AdbReader, anchor: string): Promise<string> {
  const idx = await anchorIndex(r);
  if (!idx) return '';
  const va = await anchorVa(r, anchor);
  if (va == null) return '';
  const blk0 = blockOf(idx, va);
  let blk = blk0;
  let blockText = await r.sourceText(blk);
  let startAt = Math.max(0, va - idx.bv[blk]);
  // 頁標記可能落在隔壁區塊（VA 指到頁內第一行），所以往前後幾個區塊找
  for (const off of [0, -1, 1, -2, 2, -3, 3]) {
    const b = blk0 + off;
    if (b < 0 || b >= idx.bv.length) continue;
    const t = off === 0 ? blockText : await r.sourceText(b);
    const k = t.indexOf('<頁 id="' + anchor + '"');
    if (k >= 0) { blk = b; blockText = t; startAt = k; break; }
  }
  let raw = blockText.slice(startAt);
  for (let b = blk + 1; raw.length < 20000 && b < idx.bv.length; b++) raw += await r.sourceText(b);
  const cut = raw.indexOf('<頁 ');
  if (cut > 0) raw = raw.slice(0, cut);
  return hanChars(raw).join('');
}
