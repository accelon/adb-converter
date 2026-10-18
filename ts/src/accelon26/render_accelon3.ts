/**
 * 內文 → HTML（Accelon3 方言）。**只做渲染**，不碰 UI 狀態、不 import viewer。
 *
 * 作者 2026-10 的需求：
 *   1. 內文的 XML 標籤要變成 HTML；這支獨立成模組（未來可以有 `render_md.ts`）。
 *   2. 標題（`t=` 定義的層級標籤）依「離本文幾層」放大：每往上一層 +10%。
 *      底色用該層的 `tDot` 顏色（主題變數 `--tag-N`），半透明，不遮字。
 *   3. `<頁>`（含 `_頁`／13j 的 `頁元`）→ 右靠的 `<hr>` 樣式分隔（`.pageBreak`，帶頁碼）；
 *      `<段/>` → 段落（`<br>` ＋ 兩個全形空格，最簡做法）。
 *   4. 不屬於 `t=` 的其他標籤：包住的文字照顯示，只是不當標題、不上色。
 *      `樹`／`隱` 是建庫用的隱藏資訊（目錄宣告等），連內容一起跳過。
 *
 * 產出的每一行仍然是 `<div class="lineText">…</div>` 的內容片段，行本身由 doc-pane
 * 包上 `<div class="docLine" id="Ln">`，所以捲動、塗紅、游標同步都不受影響。
 */
import type { TreeNode } from './search';

export interface RenderContext {
  /** 標籤 → 它在樹裡的深度（0＝最上層） */
  depthOf: Map<string, number>;
  /** 樹有幾層（最大深度 + 1）；0＝這個庫沒有樹 */
  levels: number;
}

/** 沒有樹（例如 fgdict 沒有 `s="*"`）時：所有標籤都當普通文字 */
const EMPTY_CTX: RenderContext = { depthOf: new Map(), levels: 0 };

/** 頁標記：`<頁/>` 是紙本頁，`_頁` 是 fgdict 的版本，`頁元` 是 13j 的「每本書的頁序」 */
export const PAGE_TAGS = new Set(['頁', '_頁', '頁元']);

/** 段落標記 */
export const PARA_TAGS = new Set(['段']);

/** 內容要整段隱藏的標籤（建庫／目錄宣告用，不是內文） */
export const HIDDEN_TAGS = new Set(['樹', '隱']);

/**
 * 每一層加多少（px）。
 *
 * 作者 2026-10：標題不要放大太多，「每往上一層 +2pt 就好」。
 */
export const LEVEL_STEP_PX = 2;

/**
 * 標題最大不超過本文的 **180%**（作者 2026-10-18：原本 200%，看起來還是太大）。
 *
 * 而且「往上一層」指的是**這一頁**裡的相對層級（見 renderPageBlocks 的 depthSteps），
 * 不是資料庫的絕對深度 —— 所以很深的庫也不會突然跳成大字。
 */
export const LEVEL_MAX_SCALE = 1.8;

/**
 * 從建好的目錄樹算「標籤 → 深度」與「樹有幾層」。
 *
 * 有界走訪（預設 20,000 個節點）：fgdict 的樹可以到 88k 個實例，但前兩萬個就足以
 * 決定每個層級用哪個標籤、最深到哪裡 —— 這個結果只用來排版，不需要百分之百完整。
 */
export function computeTierContext(roots: TreeNode[], limit = 20000): RenderContext {
  const depthOf = new Map<string, number>();
  let levels = 0;
  let seen = 0;
  const walk = (nodes: TreeNode[], depth: number) => {
    for (const n of nodes) {
      if (seen++ >= limit) return;
      if (!depthOf.has(n.tag) || depthOf.get(n.tag)! > depth) depthOf.set(n.tag, depth);
      levels = Math.max(levels, depth + 1);
      if (n.children.length) walk(n.children, depth + 1);
      if (seen >= limit) return;
    }
  };
  walk(roots, 0);
  return { depthOf, levels };
}

// 目前資料庫的層級（由 scopes.ts 在樹建好／換庫時設定；這支模組本身不 import 任何 UI）
let current: RenderContext = EMPTY_CTX;

export function setTierContext(ctx: RenderContext | null): void {
  current = ctx ?? EMPTY_CTX;
}

export function tierContext(): RenderContext {
  return current;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function attrValue(attrs: string, name: string): string {
  const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(attrs) ?? new RegExp(`\\b${name}\\s*=\\s*'([^']*)'`).exec(attrs);
  return m ? m[1] : '';
}

/** 渲染選項 */
export interface RenderOptions {
  /**
   * 原書分行（作者 2026-10）。預設 true＝每個硬換行都成列、`<頁>` 畫成右靠分隔。
   * false＝**不保留硬換行**（文字連著排），只在標題與空行（連續兩個以上的換行）換行，
   * `<頁>` 變成行內的小字頁碼。
   */
  hardBreaks?: boolean;
  /**
   * 要塗紅的關鍵字（在**產生 HTML 之前**就包好 `<mark class="kw">`）。
   * 作者 2026-10：不保留硬換行時，關鍵字可能跨行，事後在 DOM 上找字很容易抓錯，
   * 所以在渲染前先標好。
   */
  marks?: { text: string; hue: number }[];
  /**
   * 顯示用轉換（例如「無損簡體」）：只影響畫面上的字，索引／搜尋／塗紅比對仍在原文。
   * 轉換在**跳脫之前**套用，關鍵字也一起轉（讀者看到的字與顏色才會一致）。
   */
  convert?: ((s: string) => string) | null;
  /**
   * 標題要不要放大（預設 true）。摘要卡片用 false：標題只上色、字級不變
   * （作者 2026-10）。
   */
  headScale?: boolean;
  /** 這一張卡片的「主要命中」文字：同名的那個 mark 會多一個 `cur` class */
  primary?: string;
  /**
   * 要不要渲染 `<頁>`／`<_頁>`／`頁元`（作者 2026-10，設置頁的「顯示原書頁碼」）。
   * 預設 true；false 時**整個標籤都不見** —— 硬換行模式沒有頁分隔、連排模式沒有 `〔n〕`。
   */
  pageMarks?: boolean;
  /**
   * 「深度 → 本文上方幾級」（作者 2026-10-18）。`renderPageBlocks` 會依**這一頁**出現的
   * 標題深度算好：最深的那一層＝+1 級，往上一層再 +1 …… 所以同一個標題（例如「甲」）
   * 在不同頁面可以有不同大小，和本文之間是平緩的階梯，不會突然變成大字。
   * 沒有給就用舊行為（資料庫的絕對深度）。
   */
  depthSteps?: Map<number, number>;
}

/** 一行的渲染結果（給分塊用） */
export interface RenderedLine {
  no: number;
  html: string;
  /** 原始文字（呼叫端要放進 data-src，塗紅靠它對回原文） */
  raw: string;
  /** 這一行有可見文字嗎（只有標籤的空行 → false） */
  visible: boolean;
  /** 這一行開／關了標題（要獨立成段） */
  heading: boolean;
}

/** 一個版面塊：段落（多行連排）或標題（單行） */
export interface RenderBlock {
  kind: 'line' | 'heading' | 'para';
  lines: RenderedLine[];
}

/**
 * 一行 → HTML 片段。跨行的標籤（`<章>` 開在第 1 行、`</章>` 在第 9 行）用一個堆疊
 * 記住，每一行開頭重新開、行尾全部收掉，所以每一行都是獨立的合法片段。
 */
export class Accelon3Renderer {
  /** 目前還開著的標題（跨行） */
  private stack: { tag: string; depth: number }[] = [];
  /** 被隱藏標籤（樹／隱）包住的次數 */
  private hidden = 0;
  /** 這個頁面上的頁碼計數（沒有 n= 時拿它當 id） */
  private pageSeq = 0;
  /** 這一行有沒有可見文字／標題（lineInfo 回報用） */
  private sawText = false;
  private sawHeading = false;
  private readonly opts: Required<Pick<RenderOptions, 'hardBreaks' | 'headScale' | 'pageMarks'>> & {
    marks: { text: string; hue: number }[];
    convert: ((s: string) => string) | null;
    primary: string;
    depthSteps: Map<number, number> | null;
  };

  constructor(private ctx: RenderContext = current, opts: RenderOptions = {}) {
    this.opts = {
      hardBreaks: opts.hardBreaks !== false,
      headScale: opts.headScale !== false,
      pageMarks: opts.pageMarks !== false,
      depthSteps: opts.depthSteps ?? null,
      // 長的關鍵字先比對，才不會被短的切碎
      marks: [...(opts.marks ?? [])].filter((m) => m.text).sort((a, b) => b.text.length - a.text.length),
      convert: opts.convert ?? null,
      primary: opts.primary ?? '',
    };
  }

  /** 顯示用轉換（無損簡體等）；沒有就原樣 */
  private conv(text: string): string {
    return this.opts.convert ? this.opts.convert(text) : text;
  }

  /** 文字輸出：先轉換（顯示模式）→ 跳脫 → 把關鍵字包成 <mark class="kw">（渲染前塗紅） */
  private emit(text: string): string {
    if (!text) return '';
    if (!this.opts.marks.length) return esc(this.conv(text));
    let out = '';
    let i = 0;
    while (i < text.length) {
      let bestAt = -1;
      let best: { text: string; hue: number } | null = null;
      for (const m of this.opts.marks) {
        const at = text.indexOf(m.text, i);
        if (at < 0) continue;
        if (bestAt < 0 || at < bestAt) { bestAt = at; best = m; }
      }
      if (bestAt < 0 || !best) { out += esc(this.conv(text.slice(i))); break; }
      out += esc(this.conv(text.slice(i, bestAt)));
      const cur = this.opts.primary && best.text === this.opts.primary ? ' cur' : '';
      out += `<mark class="kw${cur}" style="--hue:${best.hue}">${esc(this.conv(best.text))}</mark>`;
      i = bestAt + best.text.length;
    }
    return out;
  }

  private openSpan(tag: string, depth: number): string {
    // 本文（不在標題堆疊裡）永遠 1em；「往上一層」＋2px，最多 180%（作者 2026-10-18）。
    // 有 depthSteps（renderPageBlocks 依本頁算的相對層級）就用它 —— 這才是使用者看到的
    // 「和本文平緩過渡」；沒有就退回舊的絕對深度算法（直接 new 這支類別的場合）。
    // headScale=false（摘要卡片）時不加 font-size：標題只上色、字級不變。
    const steps = this.opts.depthSteps?.get(depth);
    const up = Math.max(0, this.ctx.levels - 1 - depth);
    const n = steps ?? up;
    const size = !this.opts.headScale ? '' : n > 0 ? `font-size:min(calc(1em + ${n * LEVEL_STEP_PX}px), ${LEVEL_MAX_SCALE}em);` : 'font-size:1em;';
    return `<span class="h" data-tag="${esc(tag)}" data-up="${up}" data-depth="${depth}" style="${size}--tagtext:var(--tag-text-${depth % 8})">`;
  }

  /** `<頁>`：原書分行時是右靠的分隔；不保留硬換行時是行內的小字頁碼 */
  private pageMark(attrs: string): string {
    this.pageSeq++;
    const id = attrValue(attrs, 'n') || attrValue(attrs, 'id') || String(this.pageSeq);
    if (!this.opts.hardBreaks) {
      return `<span class="pageMark" data-page="${esc(id)}" title="原書頁 ${esc(id)}">〔${esc(id)}〕</span>`;
    }
    return `<div class="pageBreak" id="P${this.pageSeq}" data-page="${esc(id)}"><span class="pageId">${esc(id)}</span></div>`;
  }

  /** 一行 → HTML（不含外層的列／段落標籤）＋診斷資訊 */
  lineInfo(text: string, lineNo = 0): RenderedLine {
    this.sawText = false;
    this.sawHeading = false;
    let html = '';
    // 跨行的標題：這一行開頭先把還開著的補回來（行尾會全部收掉）
    for (const s of this.stack) html += this.openSpan(s.tag, s.depth);

    let i = 0;
    while (i < text.length) {
      const lt = text.indexOf('<', i);
      if (lt < 0) {
        if (!this.hidden) { html += this.emit(text.slice(i)); if (text.slice(i).trim()) this.sawText = true; }
        i = text.length;
        break;
      }
      if (lt > i && !this.hidden) {
        const run = text.slice(i, lt);
        html += this.emit(run);
        if (run.trim()) this.sawText = true;
      }
      const gt = text.indexOf('>', lt + 1);
      if (gt < 0) { if (!this.hidden) html += this.emit(text.slice(lt)); break; }
      const rawTag = text.slice(lt, gt + 1);
      i = gt + 1;
      const m = /^<(\/?)([^\s<>/]+)([\s\S]*?)(\/?)>$/.exec(rawTag);
      if (!m) { if (!this.hidden) html += this.emit(rawTag); continue; }
      const closing = m[1] === '/';
      const name = m[2];
      const attrs = m[3] ?? '';
      const selfClose = m[4] === '/';

      if (HIDDEN_TAGS.has(name)) {
        if (closing) this.hidden = Math.max(0, this.hidden - 1);
        else if (!selfClose) this.hidden++;
        continue;
      }
      if (this.hidden) continue;

      if (PAGE_TAGS.has(name)) {
        // 作者 2026-10：「顯示原書頁碼」關閉時，頁標籤整個不渲染（不留空行、不留頁碼）
        if (!closing && this.opts.pageMarks) { html += this.pageMark(attrs); this.sawText = true; }
        continue;
      }
      if (PARA_TAGS.has(name)) {
        // <段/> 或 <段>：都當段落分隔（最簡做法：<br> ＋ 兩個全形空格）。
        // 縮排放在自己的 span 裡：塗紅在做「文字位移對應」時會跳過它，
        // 才不會讓後面每個字的 offset 都差 2。
        if (!closing) html += '<br class="para"><span class="paraIndent">　　</span>';
        continue;
      }
      const depth = this.ctx.depthOf.get(name);
      if (depth === undefined) {
        // 沒有 t= 定義：標籤本身丟掉，文字照留
        continue;
      }
      this.sawHeading = true;
      if (closing) {
        // 收掉最近一個同名標題（找不到就不動）
        for (let k = this.stack.length - 1; k >= 0; k--) {
          if (this.stack[k].tag === name) {
            for (let j = this.stack.length - 1; j >= k; j--) { this.stack.pop(); html += '</span>'; }
            break;
          }
        }
      } else if (!selfClose) {
        this.stack.push({ tag: name, depth });
        html += this.openSpan(name, depth);
      }
    }

    // 行尾把這一行還開著的標題收掉（下一行會重新開；HTML 才是平衡的）
    html += '</span>'.repeat(this.stack.length);
    return { no: lineNo, html, raw: text, visible: this.sawText, heading: this.sawHeading };
  }

  /** 只要 HTML 時的簡便入口（測試／舊呼叫端用） */
  line(text: string, lineNo = 0): string {
    return this.lineInfo(text, lineNo).html;
  }
}

/**
 * 一頁 → 版面塊。
 *
 * * `hardBreaks`（預設）：每一行都自成一個 `line` 塊 —— 保留原書的硬換行。
 * * `hardBreaks: false`：連續的內文行合成一個 `para` 塊（不換行）；**標題**與
 *   **空行**（連續兩個以上的換行）才換段。
 */
export function renderPageBlocks(lines: string[], lineNumbers: number[], opts: RenderOptions = {}, ctx: RenderContext = current): RenderBlock[] {
  // 第一遍：先看**這一頁**的標題深度，決定字級的階梯（作者 2026-10-18）。
  // 錨點＝「正文開始的那一層」——第一個後面直接接內文的標題。
  // 這樣「丁一」只比內文大 2px、「丙一」再大 2px …… 越深的層越接近內文；
  // 比正文更深的子標題（戊、己、庚…）也一樣是 +2px，不會反而把上面的祖先撐大。
  const depths = new Set<number>();
  const infos: RenderedLine[] = [];
  if (opts.headScale !== false) {
    const probe = new Accelon3Renderer(ctx, opts);
    for (let i = 0; i < lines.length; i++) {
      const info = probe.lineInfo(lines[i], lineNumbers[i] ?? i);
      infos.push(info);
      for (const m of info.html.matchAll(/data-depth="(\d+)"/g)) depths.add(Number(m[1]));
    }
  }
  const maxDepth = depths.size ? Math.max(...depths) : -1;
  // 錨點：第一個「後面接著內文」的標題的（最深）深度
  let anchor = -1;
  for (let i = 0; i < infos.length && anchor < 0; i++) {
    if (!/class="h"/.test(infos[i].html)) continue;
    let headingDepth = -1;
    for (const m of infos[i].html.matchAll(/data-depth="(\d+)"/g)) headingDepth = Math.max(headingDepth, Number(m[1]));
    for (let j = i + 1; j < infos.length; j++) {
      if (!infos[j].visible) continue;            // 空行不算
      if (!/class="h"/.test(infos[j].html)) anchor = headingDepth;   // 下一段是內文 → 這一層就是正文的上一層
      break;
    }
  }
  const depthSteps = new Map<number, number>();
  for (const d of depths) {
    const steps = anchor >= 0 ? Math.max(1, anchor - d + 1) : maxDepth - d + 1;
    depthSteps.set(d, steps);
  }

  const r = new Accelon3Renderer(ctx, { ...opts, depthSteps });
  const hard = opts.hardBreaks !== false;
  const out: RenderBlock[] = [];
  let cur: RenderBlock | null = null;
  for (let i = 0; i < lines.length; i++) {
    const info = r.lineInfo(lines[i], lineNumbers[i] ?? i);
    if (hard) { out.push({ kind: 'line', lines: [info] }); continue; }
    if (!info.visible) { cur = null; continue; }              // 空行＝段落界線（連續兩個以上的換行）
    if (info.heading) { out.push({ kind: 'heading', lines: [info] }); cur = null; continue; }
    if (!cur) { cur = { kind: 'para', lines: [] }; out.push(cur); }
    cur.lines.push(info);
  }
  return out;
}

/** 一次渲染一整頁（行號陣列只為了讓呼叫端好對齊） */
export function renderPageLines(lines: string[], firstLine: number, ctx: RenderContext = current): string[] {
  const r = new Accelon3Renderer(ctx);
  return lines.map((line, i) => r.line(line, firstLine + i));
}
