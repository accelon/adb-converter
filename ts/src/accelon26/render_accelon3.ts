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
import { defaultFontOf, fontFamilyOf, tagStyleOf } from './tag-style';
import { decodeXmlEntities } from '../xml-entities';
import { siddhamSequence } from './siddham-seq';
import { puaSequence } from './pua-seq';
import { noteLabel } from './note-label';
import { parseTableBlock } from './table-block';
import { parseWordSpec } from './word-spec';
import { isLinkTag, parseLinkSpec, type LinkKind } from './link-spec';
import { findPunctLoose } from './loose-match';

export interface RenderContext {
  /** 標籤 → 它在樹裡的深度（0＝最上層） */
  depthOf: Map<string, number>;
  /** 樹有幾層（最大深度 + 1）；0＝這個庫沒有樹 */
  levels: number;
  /**
   * 標籤 → 色號（0–7，依標籤第一次出現的順序，作者 2026-10-18）。
   * 顏色跟著**標籤**而不是深度：同一個庫裡「章」和「節」即使位在同一層，
   * 也會拿到不同的顏色。沒有這個表時退回深度。
   */
  tagChroma?: Map<string, number>;
}

/** 沒有樹（例如 fgdict 沒有 `s="*"`）時：所有標籤都當普通文字 */
const EMPTY_CTX: RenderContext = { depthOf: new Map(), levels: 0 };

/** 頁標記：`<頁/>` 是紙本頁，`_頁` 是 fgdict 的版本，`頁元` 是 13j 的「每本書的頁序」 */
export const PAGE_TAGS = new Set(['頁', '_頁', '頁元']);

/** 段落標記 */
export const PARA_TAGS = new Set(['段']);

/**
 * 行內格式標籤（2026-11-11）：Word 的粗體、引文楷體、上標。
 *
 * 這三個標籤原本**沒有渲染分支**，掉到下面 `depthOf.get(name)` 那一段時因為不在
 * 目錄樹的 `t=` 清單裡（`書,品,章,…細目`），被當成「不認識的標籤」整支丟掉，
 * 文字照留、樣式全無：fuyan 的資料裡有 39,770 個 `<粗>`、5,646 個 `<經>`，
 * 畫面上卻連一個粗體、一個楷體都沒有——厚觀法師 2026-11-09 起反覆回報的
 * 「腳注[9] 標楷體沒生效、該加粗處沒加粗」（錯誤03／08）就是這個原因，
 * 不是資料沒標。程式裡有、資料裡有，只有畫面上沒有。
 */
export const FMT_TAGS: Record<string, string> = {
  粗: 'fmt-bold', _粗: 'fmt-bold',
  經: 'fmt-kai', _經: 'fmt-kai',
  上標: 'fmt-sup',
};

/** `<例 t="…"/>`：詞書的體例分區標記（cyd 等）。 */
export const EXAMPLE_TAGS = new Set(['例', '_例']);

/** 找下一個 tag 的 `>`，但跳過屬性引號內的 `>`（`<彈 t="…<x>…">` 才不會被切斷）。 */
function findTagEnd(text: string, from: number): number {
  let quote = '';
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i;
    }
  }
  return -1;
}

interface LiScheme {
  /** `集.scheme`：`例.t` 的完整清單／順序（顏色依這個順序配 HSV） */
  labels: string[];
  h: number;
  s: number;
  v: number;
  step: number;
}

const LI_DEFAULT: LiScheme = { labels: [], h: 205, s: 0.55, v: 0.78, step: 37 };let liSchemeText = '';
const liHueByLabel = new Map<string, number>();
let liHueNext = 0;

/** viewer 開庫時把 `<集 scheme="…">` 的值設進來；多庫切換時跟著換。 */
export function setExampleScheme(raw: string): void {
  liSchemeText = raw ?? '';
  liHueByLabel.clear();
  liHueNext = 0;
}

/** 從檔頭找 `<集 … scheme="…">`（給 viewer 開庫時呼叫）。 */
export async function readExampleScheme(r: { sourceText(i: number): Promise<string> }): Promise<string> {
  try {
    const raw = await r.sourceText(0);
    const tail = raw.indexOf('</檔>');
    const head = tail >= 0 ? raw.slice(0, tail + 5) : raw;
    const m = /<集(?:\s[^>]*)?\bscheme\s*=\s*"([^"]*)"/i.exec(head);
    return m?.[1] ?? '';
  } catch { return ''; }
}

/** `<集 scheme="注音,漢語拼音,釋義,…">`：例.t 的清單，不是 HSV 數字。 */
function parseLiScheme(raw: string): LiScheme {
  const labels: string[] = [];
  for (const part of String(raw ?? '').split(/[|,、;\s]+/)) {
    const s = part.trim();
    if (s && !labels.includes(s)) labels.push(s);
  }
  return { ...LI_DEFAULT, labels };
}

function hsvRgb(h: number, s: number, v: number): [number, number, number] {
  const hh = ((h % 360) + 360) % 360 / 60;
  const c = v * s;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if (hh < 1) [r, g, b] = [c, x, 0];
  else if (hh < 2) [r, g, b] = [x, c, 0];
  else if (hh < 3) [r, g, b] = [0, c, x];
  else if (hh < 4) [r, g, b] = [0, x, c];
  else if (hh < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

function liVars(hue: number, scheme: LiScheme): { color: string; bg: string; vars: string } {
  const [r, g, b] = hsvRgb(hue, scheme.s, scheme.v);
  return {
    color: `rgb(${r} ${g} ${b})`,
    bg: `rgb(${r} ${g} ${b} / .075)`,
    vars: `--li-color:rgb(${r} ${g} ${b});--li-bg:rgb(${r} ${g} ${b} / .075)`,
  };
}

/** 正文插圖（Accelon3：`圖` 是單張圖，`嵌圖`／`圖片` 是其他寫法的別名） */
export const IMAGE_TAGS = new Set(['圖', '嵌圖', '圖片']);

/**
 * 腳注（作者 2026-10-26）：`<註 n="1"/>` 是正文裡的引用標記，`<釋 n="1">…</釋>`
 * 是注文；兩者用 `n` 對應，像 Markdown 的腳注。注文有兩種寫法：
 *   * `manual.adb`：`<釋 n="1">…多行…</釋>`
 *   * `thonzu.adb`：`<釋 n="1"/>　注文就在標籤後面》（一行一條）
 * 這裡只長出錨點與樣式；hover 顯示／點擊跳轉在 notes.ts。
 */
export const NOTE_REF_TAGS = new Set(['註']);
export const NOTE_BODY_TAGS = new Set(['釋']);

/** 內容要整段隱藏的標籤（建庫／目錄宣告用，不是內文） */
export const HIDDEN_TAGS = new Set(['樹', '隱']);

/**
 * `<圖 n="x.svg"/>` 的 SVG 原文 → inline `<svg>`。
 *
 * 作者 2026-10-28：不必為 accelon3 相容，所以直接 inline —— 字形跟著字色／主題走，
 * 也能用 CSS 縮放（`img` 載入的 SVG 不能繼承顏色，只能鋪白底硬上）。
 * viewBox 用檔案自己的（每個字的 bbox 不同），`preserveAspectRatio` 讓它置中。
 */
/**
 * inline SVG 的 id 要改成全文件唯一（作者 2026-10-31）。
 *
 * Visio 匯出的圖版，每張都有 `clip_1`／`clip_2`…；兩張圖 inline 在同一頁時，
 * `clip-path="url(#clip_1)"` 會抓到**第一張**的 clipPath，第二張就被切掉
 * （fuyan y37.0347 的實際狀況）。所以每張圖的 id 加上自己的前綴，連引用一起改。
 */
let svgSeq = 0;

function uniqueSvgIds(inner: string): string {
  const ids = [...inner.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  if (!ids.length) return inner;
  const prefix = 'svg' + (++svgSeq) + '-';
  let out = inner;
  for (const id of ids) {
    out = out.split(`id="${id}"`).join(`id="${prefix}${id}"`);
    out = out.split(`url(#${id})`).join(`url(#${prefix}${id})`);
    out = out.split(`href="#${id}"`).join(`href="#${prefix}${id}"`);
  }
  return out;
}

/**
 * Visio 匯出的 SVG 把樣式放在 `<style>` 的 `.stN{}` 規則裡。內嵌到 HTML 之後，那份
 * 樣式表**未必套得上**（CDATA 包裝、同頁兩張圖的 `.stN` 互相蓋掉），字級一跑掉就
 * 重疊、溢出、被裁掉（厚觀法師 2026-11-07 回報 hg03.162／hg03.164）。
 * 這裡把 `.stN` 的宣告直接寫進各元素的 style，並把 <style> 拿掉：
 * 圖就不必依賴外部樣式表，兩張圖也不會互相干擾。
 */
function inlineSvgStyles(src: string): { inner: string; rootDecl: string } {
  const rules: Record<string, string> = {};
  for (const sm of src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
    for (const rm of sm[1].matchAll(/\.([\w-]+)\s*\{([^}]*)\}/g)) {
      const key = rm[1];
      const decl = rm[2].trim().replace(/\s+/g, ' ');
      rules[key] = rules[key] ? `${rules[key]};${decl}` : decl;
    }
  }
  const declOf = (cls: string) => cls.trim().split(/\s+/)
    .map((c) => rules[c] ?? '')
    .filter(Boolean)
    .join(';');
  const inner = src
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/class="([^"]+)"/g, (all, cls: string) => {
      const d = declOf(cls);
      return d ? `${all} style="${d}"` : all;
    });
  return { inner, rootDecl: '' };
}

/** 取 `<style>` 裡的 `.stN` 規則（給根標籤用）。 */
function svgStyleRules(src: string): Record<string, string> {
  const rules: Record<string, string> = {};
  for (const sm of src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
    for (const rm of sm[1].matchAll(/\.([\w-]+)\s*\{([^}]*)\}/g)) {
      const key = rm[1];
      const decl = rm[2].trim().replace(/\s+/g, ' ');
      rules[key] = rules[key] ? `${rules[key]};${decl}` : decl;
    }
  }
  return rules;
}

export function inlineSvgHtml(src: string, label: string, figure = false): string {
  const m = /<svg\b([^>]*)>([\s\S]*?)<\/svg>/i.exec(src);
  if (!m) return `<span class="inlineImgMissing" title="${esc(label)}">▢</span>`;
  const vb = /\bviewBox\s*=\s*"([^"]*)"/i.exec(m[1])?.[1] ?? '0 0 1000 1000';
  const rootClass = /\bclass\s*=\s*"([^"]*)"/i.exec(m[1])?.[1]?.trim() ?? '';
  const clean = m[2].replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '')
    // Visio 的 <v:documentProperties>／<v:pageProps> 是看不見的檔案屬性；
    // 內嵌時根標籤的 xmlns:v 被丟掉，存成 .svg 再開就會報
    // 「Element v:documentproperties prefix is unbound」（hunxian 2026-11-09 回報）。
    .replace(/<v:[a-zA-Z][\s\S]*?<\/v:[a-zA-Z]+>/gi, '')
    .replace(/<v:[a-zA-Z][^>]*\/>/gi, '')
    // 元素屬性上的 `v:` 前綴（Visio 的 v:mid、v:ext…）也要拿掉，否則序列化成 .svg
    // 會是「Namespace prefix v for mid on g is not defined」，圖根本載不出來。
    .replace(/\sv:[a-zA-Z-]+\s*=\s*"[^"]*"/g, '')
    .replace(/\sv:[a-zA-Z-]+\s*=\s*'[^']*'/g, '');
  const rules = svgStyleRules(clean);
  const inlined = inlineSvgStyles(clean);
  const inner = uniqueSvgIds(inlined.inner
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son\w+\s*=\s*'[^']*'/gi, ''));
  // 圖版（整張插圖）照原圖的實寸顯示：Visio 匯出的 width="1.59in" 就是書上的大小。
  // CSS 再用 max-width:100% 收窄，所以窄視窗不會爆版。字形圖（小篆）仍用 1.5em。
  const size = figure ? svgFigureStyle(m[1]) : '';
  // 根標籤原本的 class 宣告（字級 12px 等）要搬到根上，子元素才繼承得到；
  // overflow 一律 hidden——Visio 有些文字畫在 viewBox 之外，Word 是裁掉的。
  const rootDecl = rootClass.split(/\s+/).map((c) => rules[c] ?? '').filter(Boolean).join(';');
  const style = [size, rootDecl, 'overflow:hidden'].filter(Boolean).join(';');
  const cls = ['inlineSvg', figure ? 'figureSvg' : ''].filter(Boolean).join(' ');
  return `<svg class="${esc(cls)}" viewBox="${esc(vb)}" role="img" aria-label="${esc(label)}"`
    + ` title="${esc(label)}"`
    + ` style="${style}"`
    + ` preserveAspectRatio="xMidYMid meet">${inner}</svg>`;
}

/** `<svg width="1.59in" height="1.4in">` → `width:152.6px`（96 dpi；pt/mm/cm 一起換算）。 */
const PER_UNIT: Record<string, number> = { in: 96, pt: 96 / 72, px: 1, mm: 96 / 25.4, cm: 96 / 2.54 };

function svgFigureStyle(head: string): string {
  const w = /\bwidth\s*=\s*"([\d.]+)\s*(in|pt|px|mm|cm)?"/i.exec(head);
  if (!w) return '';
  const n = Number(w[1]);
  if (!Number.isFinite(n) || n <= 0) return '';
  const px = n * (PER_UNIT[(w[2] ?? 'px').toLowerCase()] ?? 1);
  return `width:${px.toFixed(1)}px`;
}

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
  const tagChroma = new Map<string, number>();
  let levels = 0;
  let seen = 0;
  const walk = (nodes: TreeNode[], depth: number) => {
    for (const n of nodes) {
      if (seen++ >= limit) return;
      if (!depthOf.has(n.tag) || depthOf.get(n.tag)! > depth) depthOf.set(n.tag, depth);
      // 色號依「標籤第一次出現的順序」：章、節 即使同深度也會拿到不同顏色（作者 2026-10-18）
      if (!tagChroma.has(n.tag)) tagChroma.set(n.tag, tagChroma.size);
      levels = Math.max(levels, depth + 1);
      if (n.children.length) walk(n.children, depth + 1);
      if (seen >= limit) return;
    }
  };
  walk(roots, 0);
  return { depthOf, levels, tagChroma };
}

// 目前資料庫的層級（由 scopes.ts 在樹建好／換庫時設定；這支模組本身不 import 任何 UI）
let current: RenderContext = EMPTY_CTX;

export function setTierContext(ctx: RenderContext | null): void {
  current = ctx ?? EMPTY_CTX;
}

export function tierContext(): RenderContext {
  return current;
}

/** 天干／地支序：目錄的「甲一、乙一…」即使同一個標籤、同一層，也依序換色。 */
const STEMS = '甲乙丙丁戊己庚辛壬癸';
const BRANCHES = '子丑寅卯辰巳午未申酉戌亥';

export function labelDepthIndex(label?: string): number | null {
  const ch = [...(label ?? '').trim()][0];
  if (!ch) return null;
  const s = STEMS.indexOf(ch);
  if (s >= 0) return s % 8;
  const b = BRANCHES.indexOf(ch);
  if (b >= 0) return (b + 2) % 8;
  return null;
}

/**
 * 標籤的色號（0–7，作者 2026-10-18）：有 `tagChroma` 就依標籤，否則退回深度。
 * 內文標題、breadcrumb、目錄樹的 tDot 都用這一個，顏色才會一致。
 *
 * 2026-10-28：同一標籤若出現在不同深度（ys 的「甲一／乙一…」都是 <項>），
 * 不能再只用標籤色，否則整排同色；改用深度。標題本身以天干／地支開頭時，
 * 直接依那個序換色。
 */
export function tagChromaIndex(tag: string, depth: number, ctx: RenderContext = current, label?: string): number {
  // 天干／地支序的語意染色只適用於「章／節／項」——這是 repairSemanticTree /
  // resolveSemanticLabels 重掛的範圍（ys 的甲一、乙一…）。`書` 這一層的標題
  // （如「丁玲《…》」的「丁」）是普通書名，不該被當成語意層級而染成別的顏色。
  const semantic = (tag === '章' || tag === '節' || tag === '項') && label ? labelDepthIndex(label) : null;
  if (semantic != null) return semantic;
  const tagDepth = ctx.depthOf?.get(tag);
  const tc = ctx.tagChroma?.get(tag);
  const n = tc != null && tagDepth === depth ? tc : depth;
  return ((n % 8) + 8) % 8;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function attrValue(attrs: string, name: string): string {
  const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(attrs) ?? new RegExp(`\\b${name}\\s*=\\s*'([^']*)'`).exec(attrs);
  return m ? decodeXmlEntities(m[1]) : '';
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
   * `<术 sk|pi|tb="…">` 的外語顯示方式（作者 2026-10-31）：
   * hover（預設，title 提示）／inline（漢詞（外語））／off（只顯示漢詞）。
   */
  termMode?: 'orig' | 'hover' | 'inline' | 'off';
  /**
   * 詞典型 adb（`$詞`／`$字`）：連排模式下 `<詞>`／`<字>` 等詞條標籤要另起一段
   * （作者 2026-11-06）。只在詞典型開啟，避免 cs 的 `<詞>` 每個詞都斷行。
   */
  dictEntries?: boolean;
  /**
   * 「深度 → 本文上方幾級」（作者 2026-10-18）。`renderPageBlocks` 會依**這一頁**出現的
   * 標題深度算好：最深的那一層＝+1 級，往上一層再 +1 …… 所以同一個標題（例如「甲」）
   * 在不同頁面可以有不同大小，和本文之間是平緩的階梯，不會突然變成大字。
   * 沒有給就用舊行為（資料庫的絕對深度）。
   */
  depthSteps?: Map<number, number>;
  /**
   * `<圖 n="…"/>` → 可用的圖檔 URL（`resources` 容器裡的 blob URL）。
   * 回 null／沒有給這個回呼時畫一個小方塊佔位：圖片是正文的一部分（字形的
   * 古文字形往往就嵌在句子中間），但不該因為讀不到就讓整行消失。
   */
  imageUrl?: ((name: string) => string | null) | null;
  /**
   * `<圖 n="…"/>` 指向 SVG 時，直接拿原文 inline 成 `<svg>`（作者 2026-10-28）。
   * 這樣字形跟著字色／主題走（`currentColor`），也能用 CSS 縮放；
   * 回 null 就退回 `imageUrl` 的 blob URL。
   */
  svgText?: ((name: string) => string | null) | null;
  /**
   * 舊資料（tx／taixu）把整張圖版寫成 `<圖 f="images/…png"/>`，沒有 `t="圖版"`；
   * true 時這種沒有 `t`、不是 SVG 的 `f=` 點陣圖照圖版（原寸）顯示。
   * 其他庫的 `f=` 行內插圖（例如 yinshun 的 `images/y01-18.png`）不受影響。
   */
  untaggedFigures?: boolean;
  /**
   * `<集 scheme="…">`：詞書 `<例 t="…"/>` 體例分區的 HSV 配色。
   * 沒給時用模組預設（由 viewer 開庫時 `setExampleScheme()` 設定）。
   */
  exampleScheme?: string;
}

/** 一行的渲染結果（給分塊用） */
export interface RenderedLine {
  no: number;
  html: string;
  /** 原始文字（呼叫端要放進 data-src，塗紅靠它對回原文） */
  raw: string;
  /** 這一行有可見文字嗎（只有標籤的空行 → false） */
  visible: boolean;
  /**
   * 這一行開／關了標題（要獨立成段）
   */
  heading: boolean;
  /**
   * 這一行從 `<段 n="…">` 開始（段首）。連排模式要據此另起一段——
   * 不能只靠空行，因為日文（kmj）的段與段之間不一定有空行（作者 2026-11-03）。
   */
  segStart?: boolean;
  /**
   * 這一行**標題之後**才出現 `<段 n="…">`（例如 `<小節>[小戒]</小節><段 n="7"/>比丘們…`）。
   *
   * 這一行要當成「段落的第 1 行」（不是單行標題塊），否則段的第一句會被關在標題塊裡、
   * 跟同段的續行（下一行起）分成兩個段落（作者 2026-11-03）。
   * 標題字級在 `.h` span 上，和方塊種類無關，所以這樣不會讓正文變大。
   */
  segMid?: boolean;
  /**
   * 這一行要切成兩塊：`before` 是標題（heading 塊）、`after` 是段碼起的正文（para/line 塊）。
   * 來源是 `<小節>[小戒]</小節><段 n="7"/>比丘們…` 這種「標題與段同一行」的寫法——
   * `<段>` ≡ `<p>`，所以段碼之前屬於標題、之後才是本文（作者 2026-11-03）。
   */
  split?: { before: string; after: string };
  /**
   * DOM id 後綴（`doc-pane` 用 `L{no}{idSuffix}`）。切出來的標題用 `-h`，
   * 正文那一塊保留原本的 `L{no}`（塗紅、捲動都以有文字的那一塊為準）。
   */
  idSuffix?: string;
  /** 額外的列 class（`figLine`：圖文字被當成等寬區塊的那些行） */
  cls?: string;
  /** 額外的列 style（詞書 `<例>` 的 --li-color／--li-bg） */
  style?: string;
}

/** 表格的一列（`page` 有值時是原書頁碼，整列合併） */
export interface RenderTableRow {
  no: number;
  /** 原始行（`data-src`，塗紅靠它對回原文） */
  raw: string;
  /** 每格已渲染的 HTML（每格自己是一個 `.lineText`） */
  cells: string[];
  page?: string;
}

export interface RenderTable {
  cols: number;
  caption?: string;
  head: RenderTableRow | null;
  rows: RenderTableRow[];
  /**
   * 表格前面那張掃描原圖（作者 2026-11-06）：文字表優先顯示，原圖收進
   * 「看原圖」的 `<details>` 裡；找不到圖檔時不長這個（不要留一個 ▢）。
   */
  source?: { no: number; raw: string; html: string };
}

/** 一個版面塊：段落（多行連排）、標題（單行）、表格，或等寬的圖文字 */
export interface RenderBlock {
  kind: 'line' | 'heading' | 'para' | 'table' | 'pre';
  lines: RenderedLine[];
  /** kind === 'table' 才有 */
  table?: RenderTable;
}

/**
 * 一行 → HTML 片段。跨行的標籤（`<章>` 開在第 1 行、`</章>` 在第 9 行）用一個堆疊
 * 記住，每一行開頭重新開、行尾全部收掉，所以每一行都是獨立的合法片段。
 */
export class Accelon3Renderer {
  /** 目前還開著的標題（跨行） */
  private stack: { tag: string; depth: number; color?: string }[] = [];
  /** 被隱藏標籤（樹／隱）包住的次數 */
  private hidden = 0;
  /** 目前還開著的連結錨點（`_名`／`聯`）；收尾時依這個 stack 關 </a> */
  private linkStack: { tag: string; kind: LinkKind }[] = [];
  /** 目前還開著的 `<釋>`（跨行；`line:true` 表示自閉合、只包到本行尾） */
  private notes: { n: string; line: boolean }[] = [];
  /** 跨行的 `<引>`（引文）：邏輯深度；行尾收掉、下一行重開（2026-10-30） */
  private quoteDepth = 0;
  /** 這一行是否已經開著 `<span class="quote">` */
  private quoteOpen = false;
  /** 跨行仍然開著的格式標籤（`<粗>`／`<經>`／`<上標>`）：行尾全收、下一行重開 */
  private fmtStack: string[] = [];
  /** `<术 sk|pi|tb="…">` 的顯示方式（作者 2026-10-31）：hover／inline／off */
  private termMode: 'orig' | 'hover' | 'inline' | 'off' = 'orig';
  /** 目前開著的術語（跨行時要記得關掉、下一行再開） */
  private termStack: { html: string; shown: boolean; gloss: string }[] = [];
  private termCarry: { html: string; shown: boolean; gloss: string } | null = null;
  /** 目前開著的詞 span／詞頭；關閉時要補的注音也一起記 */
  private wordStack: { shown: boolean; pron: string }[] = [];
  /** 下一個文字 chunk 的第一個字後要插入的同形詞編號 */
  private homographPending = '';
  /** 還開著的 `<彈>`（提示標記，零 VA）；跨行時行尾收、下一行重開 */
  private tanTips: string[] = [];
  private tanCarry: string[] = [];
  /** 這一行第幾個 `<詞 w>`（1 起；`#N` 用。每行重置，見 lineInfo） */
  private wordNo = 0;
  /** 這個頁面上的頁碼計數（沒有 n= 時拿它當 id） */
  private pageSeq = 0;
  /** 這一行有沒有可見文字／標題（lineInfo 回報用） */
  private sawText = false;
  private sawHeading = false;
  /** 這一行要加的 class／style（`<例>` 的 liHeadLine） */
  private lineCls = '';
  private lineStyle = '';
  private readonly liPalette: LiScheme;
  /** 這一行是不是從 `<段 n>` 開始（段首）；連排模式據此另起一段 */
  private sawSegStart = false;
  /** 這一行是不是「標題之後」才出現 `<段 n>`（要當成段落的第一行） */
  private sawSegMid = false;
  /** `<段 n>` 之前都是標題：切在這裡（見 RenderedLine.split） */
  private splitAt: number | null = null;
  private readonly opts: Required<Pick<RenderOptions, 'hardBreaks' | 'headScale' | 'pageMarks'>> & {
    marks: { text: string; hue: number }[];
    convert: ((s: string) => string) | null;
    primary: string;
    depthSteps: Map<number, number> | null;
    imageUrl: ((name: string) => string | null) | null;
    svgText: ((name: string) => string | null) | null;
    untaggedFigures: boolean;
    exampleScheme: string;
    dictEntries: boolean;
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
      imageUrl: opts.imageUrl ?? null,
      svgText: opts.svgText ?? null,
      untaggedFigures: opts.untaggedFigures === true,
      exampleScheme: opts.exampleScheme ?? liSchemeText,
      dictEntries: opts.dictEntries === true,
    };
    this.liPalette = parseLiScheme(this.opts.exampleScheme);
    // 'hover' 也要收（2026-11-06）：漏了它會悄悄退回 'orig'，auto 的 <术>（a="1"）就
    // 完全不畫虛線、也沒有 title —— fuyan 全部術語都是自動標的，看起來就像壞掉。
    const tm = opts.termMode;
    this.termMode =
      tm === 'inline' || tm === 'off' || tm === 'orig' || tm === 'hover' ? tm : 'orig';
  }

  /** 顯示用轉換（無損簡體等）；沒有就原樣 */
  private conv(text: string): string {
    return this.opts.convert ? this.opts.convert(text) : text;
  }

  /**
   * 文字輸出：先解 XML 實體（`&lt;` 是作者寫的 `<`）→ 轉換（顯示模式）→ 跳脫
   * → 把關鍵字包成 `<mark class="kw">`（渲染前塗紅）。
   *
   * 解實體一定在跳脫之前、且只解一層：`&amp;lt;` 代表文字 `&lt;`，不能再變成 `<`。
   * `text` 已經被 lineInfo 切成「不是標籤」的片段，所以在這裡解 `<` 不會被當成標籤。
   */
  private emit(text: string): string {
    const decoded = decodeXmlEntities(text);
    if (!decoded) return '';
    // 梵字顯示（2026-11-01）：
    //   `&SDxxxxx;`（SAT 連字）→ siddham-seq 的序列
    //   PUA（CBETA SD-XXXX → U+FA000+XXXX）→ pua-seq 的序列
    // 兩者都只換畫面，不動 raw／VA；找不到序列就照舊。
    const hasEntity = decoded.includes('&SD');
    const hasPua = /[\u{F0000}-\u{10FFFD}]/u.test(decoded);
    if (!hasEntity && !hasPua) return this.emitChunk(decoded);
    let out = '';
    let i = 0;
    let j = 0;
    while (j < decoded.length) {
      const cp = decoded.codePointAt(j)!;
      const w = cp > 0xffff ? 2 : 1;
      let rep: string | null = null;
      let len = w;
      if (cp === 0x26 && decoded.startsWith('&SD', j)) {
        const m = /^&(SD-?[0-9A-Z]{4,6});/.exec(decoded.slice(j));
        if (m) {
          const seq = siddhamSequence(m[1]);
          rep = seq ? `<span class="sdSeq" data-code="${m[1]}">${seq}</span>` : esc('&' + m[1] + ';');
          len = m[0].length;
        }
      } else if (cp >= 0xfa000 && cp <= 0x10afff) {
        const seq = puaSequence(cp);
        if (seq) rep = `<span class="sdSeq">${seq}</span>`;
      }
      if (rep != null) {
        out += this.emitChunk(decoded.slice(i, j));
        out += rep;
        i = j + len;
        j = i;
      } else {
        j += w;
      }
    }
    return out + this.emitChunk(decoded.slice(i));
  }

  /** 一般文字（含關鍵字著色） */
  private emitChunk(decoded: string): string {
    if (!decoded) return '';
    // 同形詞編號：`<詞 a="2">阿房</詞>` 要在「阿」之後顯示上標，但正文／快取
    // 仍只存乾淨的「阿房」。只插入一次，插在第一個字之後。
    if (this.homographPending) {
      const cp = decoded.codePointAt(0)!;
      const len = cp > 0xffff ? 2 : 1;
      const first = decoded.slice(0, len);
      const rest = decoded.slice(len);
      const sup = `<sup class="homograph">${esc(this.homographPending)}</sup>`;
      this.homographPending = '';
      return esc(this.conv(first)) + sup + this.emitChunk(rest);
    }
    if (!this.opts.marks.length) return esc(this.conv(decoded));
    // 收集每個關鍵字的所有出現位置：先嚴格比對；某個關鍵字嚴格找不到時，再用
    // 「忽略標點」比對補上（搜「涅槃寂靜」、原文「涅槃、寂靜」）——作者 2026-11-12。
    type Sp = { start: number; end: number; m: { text: string; hue: number } };
    const spans: Sp[] = [];
    for (const m of this.opts.marks) {
      let at = 0;
      let found = false;
      while ((at = decoded.indexOf(m.text, at)) >= 0) {
        spans.push({ start: at, end: at + m.text.length, m });
        at += m.text.length;
        found = true;
      }
      if (!found) {
        for (const r of findPunctLoose(decoded, m.text, true)) spans.push({ start: r.start, end: r.end, m });
      }
    }
    if (!spans.length) return esc(this.conv(decoded));
    spans.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
    let out = '';
    let i = 0;
    for (const sp of spans) {
      if (sp.start < i) continue;                 // 已被前一個（更長的）區間蓋住
      out += esc(this.conv(decoded.slice(i, sp.start)));
      const cur = this.opts.primary && sp.m.text === this.opts.primary ? ' cur' : '';
      out += `<mark class="kw${cur}" style="--hue:${sp.m.hue}">${esc(this.conv(decoded.slice(sp.start, sp.end)))}</mark>`;
      i = sp.end;
    }
    return out + esc(this.conv(decoded.slice(i)));
  }

  private openSpan(tag: string, depth: number, colorOverride?: string): string {
    // 本文（不在標題堆疊裡）永遠 1em；「往上一層」＋2px，最多 180%（作者 2026-10-18）。
    // 有 depthSteps（renderPageBlocks 依本頁算的相對層級）就用它 —— 這才是使用者看到的
    // 「和本文平緩過渡」；沒有就退回舊的絕對深度算法（直接 new 這支類別的場合）。
    // headScale=false（摘要卡片）時不加 font-size：標題只上色、字級不變。
    const steps = this.opts.depthSteps?.get(depth);
    const up = Math.max(0, this.ctx.levels - 1 - depth);
    const n = steps ?? up;
    // 作者 2026-10-22：標籤樣式（設置 → 標籤樣式）優先；沒有自訂就維持原本的 auto。
    const custom = tagStyleOf(tag);
    let size = !this.opts.headScale ? '' : n > 0 ? `font-size:min(calc(1em + ${n * LEVEL_STEP_PX}px), ${LEVEL_MAX_SCALE}em);` : 'font-size:1em;';
    if (this.opts.headScale && custom?.size != null) size = `font-size:${custom.size}%;`;
    const color = custom?.color || colorOverride || `var(--tag-text-${tagChromaIndex(tag, depth, this.ctx)})`;
    // 作者 2026-10-22：<經> 沒有自訂字型時預設楷體；自訂字型（含空字串＝本文）優先。
    const fontName = custom ? (custom.font ?? defaultFontOf(tag)) : defaultFontOf(tag);
    const font = (fontName || custom?.font2)
      ? `font-family:${fontFamilyOf({ font: fontName, font2: custom?.font2 })};`
      : '';
    return `<span class="h" data-tag="${esc(tag)}" data-up="${up}" data-depth="${depth}" style="${size}${font}--tagtext:${color}">`;
  }

  /** `<釋 n="X">` 的注文外框（notes.ts 靠 `data-note` 找它） */
  private noteSpan(n: string): string {
    return `<span class="noteBody" data-note="${esc(n)}">`;
  }

  /** 注文開頭的編號（點它回到 `<註>`） */
  private noteBack(n: string): string {
    // `data-note` 存**完整 n**（含 `@冊`）當 key；畫面上只顯示紙本註號（作者 2026-11-02）
    const label = esc(noteLabel(n));
    return `<a class="noteBack" data-note="${esc(n)}" href="#" title="回到註 ${label}">[${label}]</a>`;
  }

  /** `<頁>`：原書分行時是右靠的分隔；不保留硬換行時是行內的小字頁碼 */
  private pageMark(attrs: string): string {
    this.pageSeq++;
    const id = attrValue(attrs, 'n') || attrValue(attrs, 'id') || String(this.pageSeq);
    if (!this.opts.hardBreaks) {
      return `<span class="pageMark" data-page="${esc(id)}" title="原書頁 ${esc(id)}">〔${esc(id)}〕</span>`;
    }
    // 作者 2026-10-31：`<頁>` 必須 inline，後面不要折行（以前是 block，會把後文擠到下一行）
    return `<span class="pageBreak" id="P${this.pageSeq}" data-page="${esc(id)}"><span class="pageId">${esc(id)}</span></span>`;
  }

  /** 一行 → HTML（不含外層的列／段落標籤）＋診斷資訊 */
  lineInfo(text: string, lineNo = 0): RenderedLine {
    this.sawText = false;
    this.sawHeading = false;
    this.lineCls = '';
    this.lineStyle = '';
    this.homographPending = '';
    this.sawSegStart = false;
    this.sawSegMid = false;
    this.splitAt = null;
    this.wordNo = 0;                 // `#N` 是句內序號，每行重新起算
    let html = '';
    if (this.tanCarry.length) {
      for (const tip of this.tanCarry) html += `<span class="tan" data-tip="${esc(tip)}">`;
      this.tanTips = [...this.tanCarry];
      this.tanCarry = [];
    }
    // 跨行的標題：這一行開頭先把還開著的補回來（行尾會全部收掉）；
    // 顏色沿用開啟那一行算好的（作者 2026-11-05：天干／地支標題依序換色，
    // 續行不能重新用層次色，否則同一個標題會前後不同色）。
    for (const s of this.stack) html += this.openSpan(s.tag, s.depth, s.color);
    // 跨行的 <釋>：同理，每行重新開（不自閉合、而且真的有 n= 的才開）
    for (const note of this.notes) if (!note.line && note.n) html += this.noteSpan(note.n);
    // 跨行的 <引>：這一行開頭先把楷體外框補回來（行尾會收掉）
    this.quoteOpen = false;
    if (this.quoteDepth > 0) {
      html += '<span class="quote">';
      this.quoteOpen = true;
    }
    // 跨行的 <粗>／<經>／<上標>：同理，每行開頭把外框補回來（行尾全收）
    for (const t of this.fmtStack) html += `<span class="${FMT_TAGS[t]}">`;
    // 跨行的 <术>：這一行開頭把外框補回來（行尾會收掉）
    if (this.termCarry) {
      const c = this.termCarry;
      this.termCarry = null;
      if (c.shown) html += c.html;
      this.termStack.push(c);
    }

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
      const gt = findTagEnd(text, lt + 1);
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
      // `<彈 t="…">文字</彈>`：零 VA 的提示標記；文字留在正文，t 只放 data-tip，
      // 不進正文／token。未來 t 內若有標籤，仍是整段字串，不在這裡拆。
      if (name === '彈' || name === '_彈') {
        if (closing) {
          if (this.tanTips.length) { this.tanTips.pop(); html += '</span>'; }
          continue;
        }
        const tip = attrValue(attrs, 't');
        html += `<span class="tan" data-tip="${esc(tip)}">`;
        this.sawText = true;
        if (selfClose) html += '?</span>';
        else this.tanTips.push(tip);
        continue;
      }
      // `<例 t="注音"/>`：詞書的體例分區（cyd）。正常 VA、t 不進全文索引；
      // 畫面是帶框線的一區，色相依 `<集 scheme="…">` 的 HSV 設定輪流變化。
      if (EXAMPLE_TAGS.has(name)) {
        if (closing) continue;
        const label = attrValue(attrs, 't') || '體例';
        const pal = this.liPalette;
        const at = pal.labels.indexOf(label);
        let hue = at >= 0 ? pal.h + at * pal.step : liHueByLabel.get(label);
        if (hue == null) {
          hue = pal.h + (pal.labels.length + liHueNext) * pal.step;
          liHueByLabel.set(label, hue);
          liHueNext++;
        }
        const v = liVars(hue, pal);
        this.lineCls = 'liHeadLine';
        this.lineStyle = v.vars;
        html += `<span class="liHead">${esc(label)}</span>`;
        this.sawText = true;
        this.sawHeading = true;
        continue;
      }
      // `<融 i="db?page" j="0-N">經文…</融>`：透明容器，內容就是正文；
      // 指針留在屬性裡，建置時可重新從母 adb 抽文。
      if (name === '融' || name === '_融') continue;
      // `<嵌始 i="db?page" j="12-34"/>`：段落起點零寬標記，展開時用它亮起正文。
      if (name === '嵌始' || name === '_嵌始') {
        const eid = attrValue(attrs, 'e');
        const i = attrValue(attrs, 'i');
        const j = attrValue(attrs, 'j');
        if (!closing) {
          if (eid) html += `<span class="embedSegStart" data-eid="${esc(eid)}"></span>`;
          else if (i && j) html += `<span class="embedSegStart" data-key="${esc(i + '|' + j)}" data-i="${esc(i)}" data-j="${esc(j)}"></span>`;
        }
        continue;
      }
      // `<嵌 i="db?page" j="12-34" t="…" n="…"/>`：文內嵌入（transclusion）。
      // 本文只長出晶片；點擊後由 embed.ts 取目標頁的引文插在後面，再點一次收合。
      if (name === '嵌' || name === '_嵌') {
        const xref = attrValue(attrs, 'i');
        const targets = attrValue(attrs, 't');
        const eid = attrValue(attrs, 'e');
        const q = attrValue(attrs, 'q');
        const j = attrValue(attrs, 'j');
        const label = attrValue(attrs, 'n') || '嵌';
        if (!closing && targets) {
          // 群組式：i/j = 經文段落，t = 多家註疏的目標清單
          const key = xref && j ? xref + '|' + j : '';
          html += `<button type="button" class="embedChip embedGroupChip" data-embed-targets="${esc(targets)}"`
            + (eid ? ` data-eid="${esc(eid)}"` : '')
            + (key ? ` data-key="${esc(key)}" data-i="${esc(xref)}" data-j="${esc(j)}"` : '')
            + (q ? ` data-q="${esc(q)}"` : '')
            + ` data-label="${esc(label)}" title="展開 ${esc(label)} 對這段經文的解釋">▸ ${esc(label)}</button>`;
          this.sawText = true;
        } else if (!closing && xref) {
          const sub = attrValue(attrs, 'sub');
          const mx = attrValue(attrs, 'max');
          html += `<button type="button" class="embedChip" data-embed="${esc(xref)}"`
            + (q ? ` data-q="${esc(q)}"` : '')
            + (j ? ` data-j="${esc(j)}"` : '')
            + (sub === '1' || sub === 'true' ? ' data-sub="1"' : '')
            + (mx && /^[0-9]+$/.test(mx) ? ` data-max="${esc(mx)}"` : '')
            + ` data-label="${esc(label)}" title="嵌入 ${esc(label)} 的引文">▸ ${esc(label)}</button>`;
          this.sawText = true;
        }
        continue;
      }
      // Link model：`_名` / `聯` 都在這裡長同一個 `<a data-link="…">`。
      // 目標怎麼解析留給 link.ts（entry）／xref.ts（xref），renderer 不查庫。
      if (isLinkTag(name)) {
        const spec = parseLinkSpec(name, (attr) => attrValue(attrs, attr));
        if (closing) {
          const top = this.linkStack[this.linkStack.length - 1];
          if (top?.tag === name) { html += '</a>'; this.linkStack.pop(); }
        } else if (!selfClose && spec) {
          const cls = spec.kind === 'xref' ? 'entryLink xrefLink' : spec.kind === 'node' ? 'entryLink nodeLink' : 'entryLink';
          let a = `<a class="${cls}" href="#" data-link="${spec.kind}"`;
          if (spec.kind === 'entry') {
            if (spec.target) a += ` data-entry="${esc(spec.target)}"`;
            if (spec.homograph) a += ` data-homograph="${esc(spec.homograph)}"`;
            if (spec.newTab) a += ' data-newtab="1"';
            a += ` title="${spec.target ? esc(spec.target) : '開新分頁'}"`;
          } else if (spec.kind === 'node') {
            // `<節聯>`：跳到通用節點錨點（捲動＋高亮＋目錄游標；link.ts linkToNode 解析）
            a += ` data-node="${esc(spec.target)}"`;
            if (spec.db) a += ` data-nodedb="${esc(spec.db)}"`;
            if (spec.newTab) a += ' data-newtab="1"';
            a += ` title="跳到 ${esc(spec.target)}"`;
          } else {
            a += ` data-xref="${esc(spec.target)}"`;
            if (spec.quote) a += ` data-q="${esc(spec.quote)}"`;
            if (spec.range) a += ` data-j="${esc(spec.range)}"`;
            a += ` title="${esc(spec.target)}"`;
          }
          html += a + '>';
          this.linkStack.push({ tag: name, kind: spec.kind });
          this.sawText = true;
        }
        continue;
      }
      // `<聯 n="詞條">`：Accelon 的條目連結（LINK，pair，SKIP）。本文只負責長出
      // 可點的錨點；目標怎麼解析成 VA 由 link.ts 的 linkToEntry 做。
      // `<聯 i="taisho?51p185b">`：跨庫／跨頁錨點（作者 2026-10），點擊由 xref.ts 處理。
      // `<段 n="12">`（作者 2026-11-02）：巴利藏幾個庫的**跨庫對齊鍵**。渲染成可點的
      // 小晶片，點它列出同結構的庫（parallel.ts），選一個就跳到同一個段。
      if (name === '段' || name === '_段') {
        if (closing) continue;
        const segN = attrValue(attrs, 'n');
        if (!segN) {
          // 沒有段號的 `<段/>`：舊式段落分隔（與下面的 PARA_TAGS 相同規則）——
          // 行首只加縮排 span（不插 <br>，免得先空一行），行中才插 `<br class="para">`。
          // 2026-11-03 之前這個分支被上面的 `continue` 吃掉，`<段/>` 完全沒有作用。
          if (this.sawText) html += '<br class="para">';
          html += '<span class="paraIndent">　　</span>';
          continue;
        }
        // 有段號：跨庫對齊鍵的小晶片
        //   * 行首（前面還沒有可見文字）→ `segStart`，連排模式另起一個 `para`
        //   * 行中、前面是**標題** → `splitAt`：段碼之前的都算標題，另成一個 heading 塊，
        //     段碼與其後正文變成新段落（作者 2026-11-03：小節與本文不該黏在一起）
        //   * 行中、前面不是標題（少數）→ 插 `<br class="para">`，同段內換行
        if (this.sawText) {
          if (this.sawHeading) this.splitAt = html.length;
          else html += '<br class="para">';
          this.sawSegMid = true;
        } else this.sawSegStart = true;
        html += `<button type="button" class="segChip" data-seg="${esc(segN)}"`
          + ` title="第 ${esc(segN)} 段：點一下對讀同結構的庫">¶${esc(segN)}</button>`;
        this.sawText = true;
        continue;
      }
      // `<圖 n="x.png"/>`：正文裡的插圖（字形、圖版）。圖檔在 `resources` 容器，
      // URL 由呼叫端先解好 —— 渲染本身是同步的。讀不到就畫一個小方塊：字形圖
      // 常常嵌在句子中間，整行消失會讓句子讀不通。
      if (IMAGE_TAGS.has(name)) {
        if (!closing) {
          // `f=` 是 Delphi 的 FILE 屬性（`basetype.pas`），taixu 的表格掃描就是用 f
          const src = attrValue(attrs, 'n') || attrValue(attrs, 'id') || attrValue(attrs, 'f');
          // SVG 優先 inline：跟著字色走、可用 CSS 縮放（作者 2026-10-28）
          const svg = src ? this.opts.svgText?.(src) ?? null : null;
          const url = src && !svg ? this.opts.imageUrl?.(src) ?? null : null;
          // 圖版判定：`t="圖版"` 是正規寫法；舊資料（tx／taixu）把整張掃描圖／表格
          // 原圖寫在 Delphi 的 `f=` 上、沒有 t，由 `untaggedFigures` 開啟相容判定。
          // SVG 仍只認 t=，免得把句中的小篆字形當圖版；`n=` 的點陣圖（Obsidian
          // 行內圖、yinshun 的 images/y…）也不受影響。
          const t = attrValue(attrs, 't');
          const figure = t === '圖版'
            || (this.opts.untaggedFigures && !svg && !t && !!attrValue(attrs, 'f'));
          if (svg) html += inlineSvgHtml(svg, src, figure);
          else if (url) html += `<img class="inlineImg${figure ? ' figureImg' : ''}" src="${esc(url)}" alt="${esc(src)}" title="${esc(src)}">`;
          else html += `<span class="inlineImgMissing" title="${esc(src || '圖')}">▢</span>`;
          this.sawText = true;
        }
        continue;
      }
      // `<註 n="1"/>`：腳注引用。沒有 n= 的註照舊當一般文字（沒有可對應的釋）。
      if (NOTE_REF_TAGS.has(name)) {
        const n = attrValue(attrs, 'n');
        if (!closing && n) {
          // `data-note` 存完整 n（含 `@冊`）當 key；顯示與 aria-label 只給紙本註號
          const label = esc(noteLabel(n));
          html += `<a class="noteRef" data-note="${esc(n)}" href="#" aria-label="註 ${label}">[${label}]</a>`;
          this.sawText = true;
        }
        continue;
      }
      // `<釋 n="1">…</釋>` 或 `<釋 n="1"/>注文`：注文。沒有 n= 的釋（hcy 的
      // 「意思是…」）不是腳注，標籤丟掉、文字照常顯示；但仍要在堆疊裡佔一格，
      // 收尾時才不會誤關上一個腳注（作者 2026-10-26 踩過：`</釋>` 沒有 n=）。
      if (NOTE_BODY_TAGS.has(name)) {
        if (closing) {
          const last = this.notes.pop();
          if (last?.n) html += '</span>';
          continue;
        }
        const n = attrValue(attrs, 'n');
        this.notes.push({ n, line: selfClose });
        if (!n) continue;
        html += this.noteSpan(n) + this.noteBack(n);
        this.sawText = true;
        continue;
      }
      if (PARA_TAGS.has(name)) {
        // <段/> 或 <段>：都當段落分隔（最簡做法：<br> ＋ 兩個全形空格）。
        // 縮排放在自己的 span 裡：塗紅在做「文字位移對應」時會跳過它，
        // 才不會讓後面每個字的 offset 都差 2。
        // 行首的 <段/>（例如 `<段/><釋 …>`）不要再插 <br>，否則整行會先空一行
        //（作者 2026-10-31：ys 的 <釋> 群多空一行）。
        if (!closing) {
          if (this.sawText) html += '<br class="para">';
          html += '<span class="paraIndent">　　</span>';
        }
        continue;
      }
      // `<引>`：CBETA 的 <quote> 引文；用楷體和作者自己的敘述分開（2026-10-30）
      if (name === '引' || name === '_引') {
        if (closing) {
          if (this.quoteDepth > 0) this.quoteDepth--;
          if (this.quoteDepth === 0 && this.quoteOpen) { html += '</span>'; this.quoteOpen = false; }
        } else if (!selfClose) {
          this.quoteDepth++;
          if (!this.quoteOpen) { html += '<span class="quote">'; this.quoteOpen = true; }
        }
        continue;
      }
      // `<粗>`／`<經>`／`<上標>`：Word 的粗體、引文楷體、上標（2026-11-11）。
      // 開著的跨行要記在 fmtStack，行尾全收、下一行重開（和 `<引>` 同一套做法）。
      const fmtCls = FMT_TAGS[name];
      if (fmtCls) {
        if (closing) {
          const k = this.fmtStack.lastIndexOf(name);
          if (k >= 0) {
            const n = this.fmtStack.length - k;
            this.fmtStack.length = k;
            html += '</span>'.repeat(n);
          }
        } else if (!selfClose) {
          this.fmtStack.push(name);
          html += `<span class="${fmtCls}">`;
        }
        continue;
      }
      // `<hr/>`：一條水平線（作者 2026-11-01：注釋群與正文分界）
      if (name === 'hr') {
        if (!closing) html += '<hr class="docHr">';
        continue;
      }
      // `<术 sk="…">` 等：術語（作者 2026-10-31）。漢詞照常顯示；外語依設定
      // hover（title 提示）／inline（漢詞（外語））／off（只顯示漢詞）。
      if (name === '术' || name === '_术') {
        if (closing) {
          const t = this.termStack.pop();
          if (t?.shown) {
            html += '</span>';
            if (t.gloss) html += t.gloss;
          }
          continue;
        }
        if (selfClose) continue;                 // <术 …/> 沒有漢詞可顯示
        const langs: [string, string][] = [['sk', '梵'], ['pi', '巴'], ['tb', '藏']];
        let lang = '';
        let val = '';
        for (const [k] of langs) { const v = attrValue(attrs, k); if (v) { lang = k; val = v; break; } }
        if (!val) {
          // 未知的屬性鍵（未來加別的語言）：第一個 key="value" 就當外語，用預設色
          const m2 = /\b([A-Za-z]{2,4})\s*=\s*"([^"]*)"/.exec(attrs);
          if (m2) { lang = m2[1].toLowerCase(); val = decodeXmlEntities(m2[2]); }
        }
        const cls = lang === 'sk' ? 'term-sk' : lang === 'pi' ? 'term-pi' : lang === 'tb' ? 'term-tb' : 'term-other';
        const label = lang === 'sk' ? '梵' : lang === 'pi' ? '巴' : lang === 'tb' ? '藏' : (lang || '外語');
        // 作者 2026-10-31：漢詞只加虛線，不上色；只有 hover 模式才給 title（外語提示），
        // inline 模式外語直接接在後面，off 模式只留漢詞——兩者都不再掛 tooltip。
        // `a="1"`＝自動加上的（原書沒有標注）；orig 模式只顯示原書就有的
        const auto = attrValue(attrs, 'a') === '1';
        const shown = !!val && this.termMode !== 'off' && !(auto && this.termMode === 'orig');
        const hover = this.termMode === 'hover';
        const tip = shown && hover ? ` title="${esc(label + '：' + val)}"` : '';
        const open = shown
          ? `<span class="term ${cls}${hover ? ' has-tip' : ''}" data-lang="${esc(lang)}" data-term="${esc(val)}"${tip}>`
          : '';
        const gloss = shown && this.termMode === 'inline' ? `<span class="termGloss">（${esc(val)}）</span>` : '';
        if (shown) html += open;
        this.termStack.push({ html: open, shown, gloss });
        this.sawText = true;
        continue;
      }
      // Word model：`詞`／`_詞`／`辭`／`_辭` 的差異只在 VA、詞頭與詞譜 span。
      const word = parseWordSpec(name, (attr) => attrValue(attrs, attr), this.opts.dictEntries);
      if (word) {
        if (closing) {
          const frame = this.wordStack.pop();
          if (frame?.shown) html += '</span>';
          if (frame?.pron) html += frame.pron;
          this.homographPending = '';
          continue;
        }
        if (selfClose) continue;
        let pron = '';
        if (word.pron) {
          const parts: string[] = [];
          if (word.pron.zy) parts.push(`<span class="pronZy">${esc(word.pron.zy)}</span>`);
          if (word.pron.py) parts.push(`<span class="pronPy">${esc(word.pron.py)}</span>`);
          pron = `<span class="dictPron">${parts.join('')}</span>`;
        }
        if (word.dictHead) {
          html += '<span class="dictHead">';
          if (word.homograph) this.homographPending = word.homograph;
        } else if (word.wordSpan) {
          // 詞譜 `b` 只有在「看起來是 IAST 詞件」時才放進 title。
          // 2026-11-03：cs-lex 的 `b` 是 provident-pali 編碼（BIkVKU|sNVGEn 這種大小寫混編、
          // 沒有變音符號），直接當提示只會讓讀者一頭霧水，所以濾掉；真正要顯示 IAST
          // 得由建置端給（`iast` 屬性）或提供 provident-pali → IAST 對照表。
          const bText = /^[a-zāīūṅñṭḍṇṃḷĀĪŪ'\-]+(\|[a-zāīūṅñṭḍṇṃḷĀĪŪ'\-]+)*$/.test(word.b)
            ? word.b.replace(/\|/g, ' + ')
            : '';
          const wordAttrs = word.w ? ` data-w="${esc(word.w)}" data-wi="${++this.wordNo}"` : '';
          html += `<span class="word" data-b="${esc(word.b)}" data-j="${esc(word.j)}"${wordAttrs}${bText ? ` title="${esc(bText)}"` : ''}>`;
        }
        this.wordStack.push({ shown: word.dictHead || word.wordSpan, pron });
        this.sawText = true;
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
        // 作者 2026-11-05：內文標題也要跟目錄色點、breadcrumb 同色。ys 的
        // 「甲一／乙一…」同標籤、同深度但依天干換色，所以用標題開頭的文字
        // （標籤後面那一段）當 label 丟給 tagChromaIndex；沒有天干／地支就照層次。
        const upcoming = text.slice(i).replace(/<[^>]*>/g, '');
        const color = tagStyleOf(name)?.color
          || `var(--tag-text-${tagChromaIndex(name, depth, this.ctx, upcoming)})`;
        this.stack.push({ tag: name, depth, color });
        html += this.openSpan(name, depth, color);
      }
    }

    // 行尾把行內開著的東西收掉（下一行會重新開；HTML 才是平衡的）：
    // 錨點 → 只到本行的釋 → 跨行的釋 → 標題（由內而外）。
    // `<彈>` 也是跨行時收掉、下一行重開。
    if (this.tanTips.length) {
      this.tanCarry = [...this.tanTips];
      html += '</span>'.repeat(this.tanTips.length);
      this.tanTips = [];
    }
    // `<聯>`／`_名` 錨點同樣在行尾收掉；跨行的聯不重新開（條目連結都是行內）
    if (this.linkStack.length) { html += '</a>'.repeat(this.linkStack.length); this.linkStack = []; }
    // 跨行的 <粗>／<經>／<上標>：它們開在引文裡面，是最內層，所以比 <引> 先收
    if (this.fmtStack.length) html += '</span>'.repeat(this.fmtStack.length);
    // 跨行的引文：這一行收掉外框，下一行開頭再開（HTML 每行都要平衡）
    if (this.quoteOpen) { html += '</span>'; this.quoteOpen = false; }
    while (this.notes.length && this.notes[this.notes.length - 1].line) {
      const top = this.notes.pop()!;
      if (top.n) html += '</span>';
    }
    // 跨行的 <术>：行尾先收掉，下一行再開
    if (this.termStack.length) {
      const carry = this.termStack[0];
      for (let k = this.termStack.length - 1; k >= 0; k--) if (this.termStack[k].shown) html += '</span>';
      this.termStack = [];
      this.termCarry = carry;
    }
    // 詞譜 span 不跨行；行尾若有沒收的（來源壞掉）先收掉。
    while (this.wordStack.length) if (this.wordStack.pop()?.shown) html += '</span>';
    html += '</span>'.repeat(this.notes.filter((x) => x.n).length);
    html += '</span>'.repeat(this.stack.length);
    // 段碼之前是標題：把那一段切出去當獨立的 heading 塊（`RenderedLine.split`）。
    // 切點之後沒有可見文字（例如行尾只有 `<段/>`）就退回插 `<br class="para">`。
    let split: { before: string; after: string } | undefined;
    if (this.splitAt != null && this.splitAt > 0) {
      const before = html.slice(0, this.splitAt);
      const after = html.slice(this.splitAt);
      const visibleAfter = after.replace(/<[^>]*>/g, '').replace(/[\s\u3000\u00a0]/g, '');
      if (visibleAfter) split = { before, after };
      else html = before + '<br class="para">' + after;
    }
    // 「線條字元排的圖表」（厚觀法師 2026-11-12 82 頁）：整段用 ┌│└├┤─ 與全形空白
    // 排出欄位，紙本靠等寬對齊。加上 figArt 讓 CSS 用明體、行距收緊、去掉段落縮排，
    // 否則每一列都被當成一個段落（縮排＋行距），欄位就散了。
    // 只認「框線」字元（┌└├┤┬┴┼│）；單純的 ─ 是中文破折號（「空──無相」這類句子很多），
    // 不能因為一個破折號就整行當圖表。雙線框（║╔╗╚╝╠╣╦╩╬，U+2550–256C）同理算框線：
    // 全書只有 231 頁注 51 那一行「║」（本種滅／現行滅的中間），行距收緊才不會浮在半空中。
    if (/[\u250C\u2510\u2514\u2518\u251C\u2524\u252C\u2534\u253C\u2502\u2550-\u256C]/.test(text)) {
      this.lineCls = (this.lineCls ? this.lineCls + ' ' : '') + 'figArt';
      // 線條字元（┌│└├┤─…）在部分字型裡是「半寬」，一列幾十個就會把後面的欄位推歪。
      // 包一層定寬 span（1em），不管字型怎麼畫都佔一個全形字的位置（只換標籤外的字）。
      html = html.split(/(<[^>]*>)/).map((seg) =>
        seg.startsWith('<') ? seg : seg.replace(/[\u2500-\u257F]/g, (c) => `<span class="boxd">${c}</span>`)
      ).join('');
    }
    return {
      no: lineNo, html, raw: text, visible: this.sawText, heading: this.sawHeading,
      segStart: this.sawSegStart, segMid: this.sawSegMid, split,
      cls: this.lineCls || undefined,
      style: this.lineStyle || undefined,
    };
  }

  /** 只要 HTML 時的簡便入口（測試／舊呼叫端用） */
  line(text: string, lineNo = 0): string {
    return this.lineInfo(text, lineNo).html;
  }
}

/* ------------------------------------------------------------------ *
 * 表格區塊（`<表>` 與 `<圖文字>`）
 * ------------------------------------------------------------------ */

/** 會被當成「區塊」的標籤：新語法的 `<表>`，以及舊資料放框線表的 `<圖文字>` */
const BLOCK_TAG_RE = /^<(_?)(表|圖文字)(?=[\s>])[^>]*>/;
const BLOCK_TAGS = new Set(['表', '圖文字']);

interface BlockRegion {
  i: number;
  j: number;
  tag: string;
  /** 開標籤之後、收標籤之前的行（`inner.length === j - i + 1`） */
  inner: string[];
}

/** 這一行是不是區塊的開始（開標籤必須在行首；前後不能夾正文） */
function blockRegionAt(lines: string[], i: number): BlockRegion | null {
  const raw = lines[i];
  const lead = raw.length - raw.trimStart().length;
  const head = raw.slice(lead);
  const m = BLOCK_TAG_RE.exec(head);
  if (!m || !BLOCK_TAGS.has(m[2])) return null;
  const tag = m[2];
  const openEnd = lead + m[0].length;
  let j = -1;
  let col = -1;
  for (let k = i; k < lines.length; k++) {
    const from = k === i ? openEnd : 0;
    const at = lines[k].indexOf('</' + tag + '>', from);
    if (at >= 0) { j = k; col = at; break; }
  }
  if (j < 0) return null;
  // 收標籤後面還有正文 → 不當區塊（避免吃掉後面的句子）
  if (lines[j].slice(col + tag.length + 3).trim()) return null;
  const inner: string[] = [];
  if (i === j) inner.push(lines[i].slice(openEnd, col));
  else {
    inner.push(lines[i].slice(openEnd));
    for (let k = i + 1; k < j; k++) inner.push(lines[k]);
    inner.push(lines[j].slice(0, col));
  }
  return { i, j, tag, inner };
}

/**
 * 表格 → HTML。每列仍是 `.docLine`（`id=L{n}`、`data-src`），每格是 `.lineText`
 * —— 塗紅、錨點、捲動都不必改；`<tr>` 只是讓欄寬由瀏覽器排。
 */
export function tableHtml(t: RenderTable, rowCls?: (no: number) => string): string {
  const cls = (base: string, no: number) => {
    const extra = rowCls ? rowCls(no).trim() : '';
    return base + (extra ? ' ' + extra : '');
  };
  const cap = t.caption ? `<caption class="tCap">${esc(t.caption)}</caption>` : '';
  const head = t.head
    ? `<thead><tr class="${cls('docLine tHead', t.head.no)}" id="L${t.head.no}" data-src="${esc(t.head.raw)}">`
      + t.head.cells.map((c) => `<th><span class="lineText">${c}</span></th>`).join('')
      + '</tr></thead>'
    : '';
  const body = t.rows.map((r) => (r.page
    ? `<tr class="${cls('docLine tPage', r.no)}" id="L${r.no}" data-src="${esc(r.raw)}">`
      + `<td colspan="${t.cols}"><span class="lineText">原書頁 ${esc(r.page)}</span></td></tr>`
    : `<tr class="${cls('docLine', r.no)}" id="L${r.no}" data-src="${esc(r.raw)}">`
      + r.cells.map((c) => `<td><span class="lineText">${c}</span></td>`).join('')
      + '</tr>')).join('');
  // 掃描原圖收在表格下面（作者 2026-11-06：文字表優先，校對時再展開）
  const src = t.source
    ? `<details class="tblSrc" id="L${t.source.no}" data-src="${esc(t.source.raw)}">`
      + '<summary>看原圖</summary><div class="tblSrcImg">' + t.source.html + '</div></details>'
    : '';
  return `<div class="docTable" style="--cols:${t.cols}"><table>${cap}${head}<tbody>${body}</tbody></table>${src}</div>`;
}

/** 一個區塊 → 版面塊；不是可解析的表格就回 null（呼叫端照舊逐行渲染） */
function blockAt(
  lines: string[], lineNumbers: number[], i: number,
  opts: RenderOptions, ctx: RenderContext, depthSteps: Map<number, number>,
): { last: number; block: RenderBlock } | null {
  const reg = blockRegionAt(lines, i);
  if (!reg) return null;
  const noAt = (at: number) => lineNumbers[i + at] ?? i + at;
  const data = parseTableBlock(reg.inner);
  if (data) {
    const r = new Accelon3Renderer(ctx, { ...opts, depthSteps });
    const cellsOf = (cells: string[]) => cells.map((c) => r.lineInfo(c, 0).html);
    const rowOf = (row: { cells: string[]; page?: string; at: number }): RenderTableRow => ({
      no: noAt(row.at), raw: lines[i + row.at] ?? '', cells: row.cells.length ? cellsOf(row.cells) : [], page: row.page,
    });
    const table: RenderTable = {
      cols: data.cols,
      caption: data.caption?.text,
      head: data.header ? rowOf({ cells: data.header.cells, at: data.header.at }) : null,
      rows: data.rows.map(rowOf),
    };
    // 摘要／純文字用途：列的文字（不含框線）
    const flat = (row: RenderTableRow) => row.page ? `〔頁 ${row.page}〕` : row.cells.map((c) => c.replace(/<[^>]*>/g, '')).join('　');
    const lines2: RenderedLine[] = [];
    if (table.head) lines2.push({ no: table.head.no, html: flat(table.head), raw: table.head.raw, visible: true, heading: false });
    for (const row of table.rows) lines2.push({ no: row.no, html: flat(row), raw: row.raw, visible: true, heading: false });
    return { last: reg.j, block: { kind: 'table', lines: lines2, table } };
  }
  // 解析不了：`<圖文字>` 用等寬顯示（框線圖才對得齊），`<表>` 只當普通文字
  if (reg.tag === '圖文字' && reg.j > reg.i) {
    const r = new Accelon3Renderer(ctx, { ...opts, depthSteps });
    const rows: RenderedLine[] = [];
    for (let at = 0; at < reg.inner.length; at++) {
      const text = reg.inner[at];
      // 開／收標籤自己那一行（前後的空段）不要長出空列
      if (!text.trim() && (at === 0 || at === reg.inner.length - 1)) continue;
      const info = r.lineInfo(text, noAt(at));
      // `data-src` 一定要放整行原文（塗紅的位移是算在整行上的）
      rows.push({ ...info, raw: lines[i + at] ?? text, cls: 'figLine' });
    }
    return { last: reg.j, block: { kind: 'pre', lines: rows } };
  }
  // `<表>說明</表>`（同一行）：當圖說，不要讓它變成普通段落
  if (reg.tag === '表' && reg.j === reg.i) {
    const text = reg.inner[0].trim();
    if (!text) return null;
    const r = new Accelon3Renderer(ctx, { ...opts, depthSteps });
    const info = r.lineInfo(text, noAt(0));
    if (!info.visible) return null;
    return {
      last: reg.j,
      block: { kind: 'line', lines: [{ ...info, raw: lines[i], cls: 'tableCaption' }] },
    };
  }
  return null;
}

const IMG_ONLY_RE = /^<(圖|嵌圖|圖片)(?=[\s/>])[^>]*\/>$/;

/**
 * 表格前面「只有一張圖」的列：那是同一個表格的圖檔版本（作者 2026-11-06）。
 * 文字表都解析出來了，再把圖放在上面只是重複；純圖列才丟，夾著文字的一律不動。
 */
function hoistImagesBeforeTables(blocks: RenderBlock[]): void {
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.kind !== 'table' || !block.table) continue;
    let j = i - 1;
    while (j >= 0) {
      const b = blocks[j];
      // `line`＝保留硬換行時的一列；`para`＝連排時的一段（圖可能和多行文字黏在一起）
      if (b.kind !== 'line' && b.kind !== 'para') break;
      let taken: RenderedLine | null = null;
      while (b.lines.length) {
        const last = b.lines[b.lines.length - 1];
        const raw = (last.raw ?? '').trim();
        const text = last.html.replace(/<[^>]*>/g, '').trim();
        if (!raw && !text) { b.lines.pop(); continue; }                          // 空行
        if (IMG_ONLY_RE.test(raw) && (!text || text === '▢')) { taken = b.lines.pop()!; continue; }
        break;
      }
      if (!b.lines.length) { blocks.splice(j, 1); i--; }                          // 整個塊只剩圖
      // 找得到圖檔才收成「看原圖」；只有 ▢ 佔位符就直接丟掉，不要長一個沒用的按鈕
      if (taken && /<(img|svg)\b/i.test(taken.html)) {
        block.table.source = { no: taken.no, raw: taken.raw, html: taken.html };
      }
      break;
    }
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
  // <頁> 的硬換行（作者 2026-10-31）：原 XML 把 `<頁/>` 放在自己一行（前後還常有空行），
  // 或放在一行的尾端、後面才換行。閱讀時都不該因此斷行：
  //   頁碼 → 接在「前一行」的尾端，被它切開的下一行也接在同一行（contLine）；
  //   頁碼前後的空行丟掉。
  const PAGE_MARK_RE = /<span class="pageBreak"[^>]*><span class="pageId">[^<]*<\/span><\/span>/g;
  const ENDS_PAGE_RE = /<span class="pageBreak"[^>]*><span class="pageId">[^<]*<\/span><\/span>\s*$/;
  let pageOnly = '';
  let blanks: RenderedLine[] = [];
  let softBreak = false;
  let sawBlank = false;          // 連排：前面的空行（頁碼旁的不算）
  let lastPage = false;          // 前一個內容是頁碼
  const flushBlanks = (): void => {
    for (const b of blanks) out.push({ kind: 'line', lines: [b] });
    blanks = [];
  };
  const mergeIntoPrev = (info: RenderedLine, prefix = ''): boolean => {
    const prev = out[out.length - 1];
    if (!prev || prev.kind !== 'line' || !prev.lines.length) return false;
    const last = prev.lines[prev.lines.length - 1];
    last.html += prefix
      + `<span class="lineText contLine" id="L${info.no}${info.idSuffix ?? ''}" data-src="${esc(info.raw)}">${info.html}</span>`;
    return true;
  };
  /** 前一個 block 是不是圖版：圖不能和後面的文字擠在同一行（作者 2026-11-01） */
  const prevHasFigure = (): boolean => {
    const prev = out[out.length - 1];
    if (!prev || prev.kind !== 'line' || !prev.lines.length) return false;
    return /<svg\b|figureImg|figureSvg/.test(prev.lines[prev.lines.length - 1].html);
  };
  /** 把頁碼接到前一個 block 的尾端（不接文字） */
  const appendToPrev = (html: string): boolean => {
    const prev = out[out.length - 1];
    if (!prev || prev.kind !== 'line' || !prev.lines.length) return false;
    prev.lines[prev.lines.length - 1].html += html;
    return true;
  };
  // 先把 `<表>`／`<圖文字>` 區塊找出來（一次掃描；找到就整段跳過）
  const special = new Map<number, { last: number; block: RenderBlock }>();
  for (let i = 0; i < lines.length; i++) {
    const b = blockAt(lines, lineNumbers, i, opts, ctx, depthSteps);
    if (b) { special.set(i, b); i = b.last; }
  }
  for (let i = 0; i < lines.length; i++) {
    // 表格／圖文字區塊：整段收成一個 block，逐行狀態（標題堆疊、頁碼接續）全部讓開
    const sp = special.get(i);
    if (sp) {
      flushBlanks();
      if (pageOnly) { if (!appendToPrev(pageOnly)) out.push({ kind: 'line', lines: [{ no: 0, html: pageOnly, raw: '', visible: true, heading: false }] }); pageOnly = ''; }
      out.push(sp.block);
      cur = null; sawBlank = false; lastPage = false; softBreak = false;
      i = sp.last;
      continue;
    }
    let info = r.lineInfo(lines[i], lineNumbers[i] ?? i);
    // 「標題＋段」同一行（`<段>` ≡ `<p>`，作者 2026-11-03）：段碼之前是標題，先推出去
    // 當自己的 heading 塊；剩下的（段碼＋本文）照一般流程走，續行才會接在同一段。
    if (info.split) {
      const head: RenderedLine = {
        ...info, html: info.split.before, heading: true,
        segStart: false, segMid: false, split: undefined, idSuffix: '-h',
      };
      flushBlanks();
      out.push({ kind: hard ? 'line' : 'heading', lines: [head] });
      cur = null;
      sawBlank = false;
      lastPage = false;
      info = {
        ...info, html: info.split.after, heading: false,
        segStart: true, segMid: false, split: undefined, idSuffix: '',
      };
    }
    if (hard) {
      // 頁碼行本身 visible=true（sawText 會被頁碼設起來），所以要看「拿掉頁碼後還剩什麼」
      const rest = info.html
        .replace(PAGE_MARK_RE, '')
        .replace(/<[^>]*>/g, '')
        .replace(/[\s\u3000\u00a0]/g, '')
        .trim();
      const hasPage = /class="pageBreak"/.test(info.html);
      // 只有圖、沒有文字的一行不是空行（作者 2026-11-01：圖版會被當成空行丟掉）
      const hasFigure = /<svg\b|class="[^"]*inlineImg|figureImg/.test(info.html);
      if (hasPage && !rest) { pageOnly += info.html; softBreak = true; continue; }   // 這一行只有頁碼
      if (!rest && !hasFigure) { blanks.push(info); continue; }                       // 空行先留著
      if (pageOnly) {
        // 作者 2026-11-01：`<頁>` 後面接的是標題時，標題要從頁首獨立一行，
        // 不能和上一個段落、頁碼擠在同一行（例：05B-p287 的〈二〉〈18觀法品〉）。
        // 2026-11-12（厚觀法師第八項）：後面接的是**圖表標題**時同理 —— `38p93`
        // 的頁碼就擺在〔圖表 HG02.093〕之前，接上前一行會讓 93 頁第一行變成
        // 上一頁那句「…總列如下：〔圖表 …〕」，而紙本是表格直接開頭。
        const headingNext = /^\s*<(章|節|項|目|小目|細目|釋)[\s>]/.test(lines[i])
          || /^\s*〔圖表/.test(lines[i])
          || /^\s*<圖[\s>]/.test(lines[i]);
        if (headingNext) {
          appendToPrev(pageOnly);                              // 頁碼留在前一行尾端
          pageOnly = '';
          blanks = [];
          softBreak = false;
          // 不 continue：這一行（標題）照下面的流程自成一個 block
        } else if (prevHasFigure()) {                          // 圖版：只接頁碼，文字自成一行
          appendToPrev(pageOnly);
          pageOnly = '';
          blanks = [];
          softBreak = false;
        } else if (mergeIntoPrev(info, pageOnly)) {            // 頁碼＋下一行都接在前一行
          pageOnly = '';
          blanks = [];
          softBreak = false;
          continue;
        } else {
          info.html = pageOnly + info.html;                    // 沒有前一行：接在自己前面
          info.visible = true;
          pageOnly = '';
          blanks = [];
        }
      } else if (softBreak) {
        if (!prevHasFigure() && mergeIntoPrev(info)) {         // 前一行以 <頁> 結尾：這一行接上去
          blanks = [];
          softBreak = false;
          continue;
        }
        flushBlanks();
      } else {
        flushBlanks();
      }
      out.push({ kind: 'line', lines: [info] });
      softBreak = ENDS_PAGE_RE.test(info.html);
      continue;
    }
    // 連排（原書分行取消）：頁碼（`.pageMark`）是里程碑，不是段落界線。
    // 原 XML 的 `<頁/>` 前後常有空行；那些空行不應該把段落切斷（作者 2026-10-31）。
    const rest2 = info.html
      .replace(/<span class="pageMark"[^>]*>[^<]*<\/span>/g, '')
      .replace(/<[^>]*>/g, '')
      .replace(/[\s\u3000\u00a0]/g, '');
    const pageOnlyReflow = /class="pageMark"/.test(info.html) && !rest2;
    if (pageOnlyReflow) {
      if (!cur) { cur = { kind: 'para', lines: [] }; out.push(cur); }
      cur.lines.push(info);
      sawBlank = false;
      lastPage = true;
      continue;
    }
    if (!info.visible) {
      if (!lastPage) sawBlank = true;          // 頁碼後面的空行不算段落界線
      continue;
    }
    // 作者 2026-11-01：標題無論如何都要行首——連排模式下不能和上一段或頁碼黏在一起。
    // `info.heading` 依賴 depthOf（真正的 adb 才有），這裡再用原始標籤補一道保險。
    // 2026-11-06：詞典型的 `<字>`／`<詞>` 也是條目標題，連排時要另起一段
    // （hanyudazidian 的「乙」原本會黏在「一」的姓釋文後面）。
    // 2026-11-12（陳裕文）：ys 的 `<部>`（第一章…、辛一…）漏在這裡，黏在上一段末尾。
    const rawHeading = /^\s*<(章|節|項|目|小目|細目|釋|部)[\s>]/.test(lines[i])
      || (opts.dictEntries === true && /^\s*<(詞|字|詞條|字頭)[\s>]/.test(lines[i]));
    // 作者 2026-11-03：`<段 n>` 是段首，**即使前後沒有空行**也要另起一段（日文的段與段
    // 之間常常沒有空行）。兩種位置：行首（`segStart`）與「標題之後」（`segMid`）。
    // `segMid` 的行要當**正文段落的第一行**：標題字級在 `.h` span 上，方塊種類不影響字級；
    // 但若當成 heading 塊，段的第一句會跟同段的續行（下一行起）分成兩個段落。
    if (info.segMid) { flushBlanks(); cur = null; sawBlank = false; lastPage = false; }
    if (!info.segMid && !info.segStart && (info.heading || rawHeading)) { out.push({ kind: 'heading', lines: [info] }); cur = null; sawBlank = false; lastPage = false; continue; }
    if (info.segStart) { cur = null; sawBlank = false; lastPage = false; }
    if (sawBlank) { cur = null; sawBlank = false; }
    // 行首的 `<段/>` 在連排模式也是**一段的開始**（作者 2026-11-06）：它字面就是
    // 「斷一段」；不這樣做的話，每行開頭的縮排會擠在同一段裡，例子全部黏在一起。
    // 帶 n= 的 `<段 n="…">` 由上面的 segStart 處理，不重複。
    if (cur && cur.lines.length && /^\s*<段(?![^>]*\bn\s*=)[^>]*>/.test(lines[i])) cur = null;
    // 這一行以頁碼結尾（…知見<頁/>）→ 後面的空行不算段落界線
    lastPage = /class="pageMark"/.test(info.html);
    if (!cur) { cur = { kind: 'para', lines: [] }; out.push(cur); }
    cur.lines.push(info);
  }
  // 收尾：頁碼／空行留在最後
  if (pageOnly) {
    const prev = out[out.length - 1];
    if (prev && prev.kind === 'line' && prev.lines.length) prev.lines[prev.lines.length - 1].html += pageOnly;
    else out.push({ kind: 'line', lines: [{ no: 0, html: pageOnly, raw: '', visible: true, heading: false }] });
    pageOnly = '';
    blanks = [];
  }
  if (hard) flushBlanks();
  // 表格已經把圖裡的文字轉出來了，緊接在前的「只有一張圖」那一列就是多餘的
  // （taixu：<表>圖說</表> → <圖/> → <圖文字>框線表）。只丟純圖列，不動別的。
  hoistImagesBeforeTables(out);
  return out;
}

/** 一次渲染一整頁（行號陣列只為了讓呼叫端好對齊） */
export function renderPageLines(lines: string[], firstLine: number, ctx: RenderContext = current): string[] {
  const r = new Accelon3Renderer(ctx);
  return lines.map((line, i) => r.line(line, firstLine + i));
}
