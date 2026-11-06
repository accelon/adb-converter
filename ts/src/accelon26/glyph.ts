/**
 * 字形庫 → 本文的 SVG 字形（作者 2026-11-06 的需求）。
 *
 * 兩件事，都在**顯示層**：
 *   1. 載入 `glyphwiki.bin.gz`（exe 的 asset；網頁版抓不到就整個功能關閉）。
 *   2. 把本文 `.lineText` 裡的 **Unicode Extension 漢字**換成「原字留著（透明）＋ SVG 疊上去」，
 *      SVG 由 `ts/src/vendor/glyph/pinxing.ts` 現畫，**知道字級與 dpr**（最小筆寬＋對齊像素格）。
 *
 * ============================ 為什麼「留字」不「換字」（§5.2）============================
 *
 * accelon26 的所有座標都掛在漢字序號上（`#N`、書籤、塗紅、引用複製）。把漢字換成 `<svg>`
 * 會讓那一行後面的字全部往前挪一位。所以原字留在 `.gwT`（`color:transparent`），
 * SVG 絕對定位疊上去 —— 選取、複製、塗紅、`textContent` 全部不變。
 *
 * ============================ 為什麼讓 `.gw` 知道字級 ============================
 *
 * KAGE 的橫筆只有 2% em。16 px 的正文裡那是 0.32 px 的灰線；`pinxing` 的 `emPx`／`dpr`
 * 會把「最細筆 ≥1 裝置像素」與「對齊像素格」算進去（實測灰墨 48% → 12%，峰值 1.00）。
 * 這裡的 `emPx` 用 `getComputedStyle` 量**那一行實際的字級**，所以標題放大、字級設定、
 * 瀏覽器縮放都會自動跟上。
 */
import { decodeLibraryLazy, indexOfCodePoint, keyOfIdx, toKageData, type Library } from '../vendor/pinxing/lib-format';
import { LitePinxing, LitePolygons } from '../vendor/pinxing/pinxing';
import { inflateRaw } from '../inflate';

/** 字庫 asset 的位置（Wails 的 `BundledAssetFileServer` 直接送 assets/ 底下的檔案） */
const LIB_URL = 'pinxing.bin.gz';
/** exe 裡沒有這個檔時（網頁版、或建置時沒放）就整個功能關閉 */
let lib: Library | null = null;
let libLoading: Promise<Library | null> | null = null;
let lastError = '';

/* ============================ 範圍：哪些字要換 ============================ */

/**
 * **只換 Unicode Extension**（作者 2026-11-06 定案）：Ext A–I ＋ 相容區／相容補充。
 * URO（4E00–9FFF）一律不動 —— 一般字型都有，換了只會和旁邊的字不同調。
 */
export function inExtension(cp: number): boolean {
  return (cp >= 0x3400 && cp <= 0x4dbf)      // Ext A
    || (cp >= 0x20000 && cp <= 0x323af)      // Ext B–I（含 G/H）
    || (cp >= 0xf900 && cp <= 0xfaff)        // 相容表意文字
    || (cp >= 0x2f800 && cp <= 0x2fa1f);     // 相容表意文字補充
}

/* ============================ 載入 ============================ */

export function glyphLibReady(): boolean { return lib !== null; }
export function glyphLibError(): string { return lastError; }

/** 載入字庫（只載一次；失敗回 null，功能自動關閉）。 */
export function loadGlyphLib(): Promise<Library | null> {
  if (lib) return Promise.resolve(lib);
  if (libLoading) return libLoading;
  libLoading = (async () => {
    try {
      const res = await fetch(LIB_URL, { cache: 'no-store' });
      if (!res.ok) { lastError = `fetch ${LIB_URL} → ${res.status}`; return null; }
      const raw = new Uint8Array(await res.arrayBuffer());
      // `.bin.gz`：看魔數決定要不要解壓（伺服器不會幫我們解 Content-Encoding）
      const bytes = raw[0] === 0x1f && raw[1] === 0x8b ? inflateGzip(raw) : raw;
      lib = decodeLibraryLazy(bytes);
      return lib;
    } catch (e) {
      lastError = String((e as Error)?.message ?? e).slice(0, 120);
      return null;
    }
  })();
  return libLoading;
}

/** gzip → raw（跳過 10 byte 檔頭；用專案既有的 inflateRaw，不必假設 DecompressionStream 存在） */
function inflateGzip(gz: Uint8Array): Uint8Array {
  // FEXTRA/FNAME 很少見，但照規格略過，免得遇到就整個壞掉
  let p = 10;
  const flg = gz[3] ?? 0;
  if (flg & 4) { const xlen = (gz[10] ?? 0) | ((gz[11] ?? 0) << 8); p += 2 + xlen; }
  if (flg & 8) { while (p < gz.length && gz[p] !== 0) p++; p++; }
  if (flg & 16) { while (p < gz.length && gz[p] !== 0) p++; p++; }
  if (flg & 2) p += 2;
  return inflateRaw(gz.subarray(p));
}

/* ============================ 畫一個字（含快取） ============================ */

const STYLE = 'songti';
const CACHE_MAX = 4000;
const cache = new Map<string, string | null>();

export function glyphSvgOf(cp: number, emPx: number, dpr: number): string | null {
  if (!lib) return null;
  const d = Math.max(1, Math.round(dpr * 100) / 100);
  const em = Math.max(6, Math.round(emPx * 10) / 10);
  const key = `${STYLE}|${em}|${d}|${cp}`;
  if (cache.has(key)) return cache.get(key)!;
  let svg: string | null = null;
  try {
    const gi = indexOfCodePoint(lib, cp);
    if (gi !== undefined) {
      const k = new LitePinxing(STYLE);
      k.emPx = em;
      k.dpr = d;
      // 引用子樹（部件的字形）先塞進描繪器
      const st = [gi]; const seen = new Set<number>();
      while (st.length) {
        const i = st.pop()!;
        if (seen.has(i)) continue;
        seen.add(i);
        const g = lib.glyphs[i]!;
        k.parts.set(keyOfIdx(lib, i), toKageData(g, lib));
        for (const s of g.strokes) if (s.kind === 99 && s.ref !== null) st.push(s.ref);
      }
      const polys = new LitePolygons();
      k.makeGlyph(polys, keyOfIdx(lib, gi));
      const out = polys.generateSVG();
      svg = out.includes('<path d=""') ? null : out;
    }
  } catch (e) {
    lastError = String((e as Error)?.message ?? e).slice(0, 120);
    svg = null;
  }
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(key, svg);
  return svg;
}

/* ============================ 本文的後處理 ============================ */

/** 這一行實際的字級（px）；量不到就回 null */
function fontSizePx(el: Element): number | null {
  const fs = parseFloat(getComputedStyle(el).fontSize);
  return Number.isFinite(fs) && fs > 0 ? fs : null;
}

/**
 * 把 `root` 底下 `.lineText` 的 Ext 漢字包成 `.gw` 並疊上 SVG。
 *
 * 回傳包了幾個字。**文字不動**：原字仍在 `.gwT` 裡（透明），所以選取／複製／塗紅／`#N` 都不變。
 */
export function decorateGlyphs(root: ParentNode = document): number {
  if (!lib) return 0;
  const dpr = typeof devicePixelRatio === 'number' && devicePixelRatio > 0 ? devicePixelRatio : 1;
  const lines = root.querySelectorAll<HTMLElement>('.lineText');
  let n = 0;
  for (const line of lines) {
    if (line.querySelector('.gw')) continue;          // 已經做過
    const emPx = fontSizePx(line);
    if (!emPx) continue;
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    const targets: Text[] = [];
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      const s = (t as Text).nodeValue ?? '';
      if (/[\u{3400}-\u{4dbf}\u{20000}-\u{323af}\u{f900}-\u{faff}\u{2f800}-\u{2fa1f}]/u.test(s)) targets.push(t as Text);
    }
    for (const text of targets) n += wrapInText(text, emPx, dpr);
  }
  return n;
}

/**
 * 畫完本文之後叫這個：載字庫（只載一次）→ 把 `#docText` 裡的 Ext 漢字疊上 SVG。
 *
 * 非阻塞：第一次還沒載完就先回 0；載完之後呼叫端（或下一次重畫）會補上。
 * 回傳這次包了幾個字。
 */
export async function upgradeDocGlyphs(root?: ParentNode): Promise<number> {
  const L = await loadGlyphLib();
  if (!L) return 0;
  const target = root ?? document.getElementById('docText') ?? document;
  return decorateGlyphs(target);
}

/** 一個 text node 裡的所有 Ext 字：切開、包 `.gw`、疊 SVG。回傳包了幾個。 */function wrapInText(text: Text, emPx: number, dpr: number): number {
  const s = text.nodeValue ?? '';
  const re = /[\u{3400}-\u{4dbf}\u{20000}-\u{323af}\u{f900}-\u{faff}\u{2f800}-\u{2fa1f}]/gu;
  let m: RegExpExecArray | null;
  let at = 0;
  const parts: { text?: string; cp?: number }[] = [];
  while ((m = re.exec(s))) {
    if (m.index > at) parts.push({ text: s.slice(at, m.index) });
    parts.push({ cp: m[0].codePointAt(0)! });
    at = m.index + m[0].length;
  }
  if (!parts.length) return 0;
  if (at < s.length) parts.push({ text: s.slice(at) });
  // 組出取代的節點（DocumentFragment）
  const doc = text.ownerDocument;
  const frag = doc.createDocumentFragment();
  let count = 0;
  for (const p of parts) {
    if (p.text !== undefined) { frag.appendChild(doc.createTextNode(p.text)); continue; }
    const cp = p.cp!;
    const svg = glyphSvgOf(cp, emPx, dpr);
    if (!svg) { frag.appendChild(doc.createTextNode(String.fromCodePoint(cp))); continue; }
    const span = doc.createElement('span');
    span.className = 'gw';
    span.dataset.cp = 'U+' + cp.toString(16).toUpperCase();
    const t = doc.createElement('span');
    t.className = 'gwT';
    t.textContent = String.fromCodePoint(cp);
    span.appendChild(t);
    span.insertAdjacentHTML('beforeend', svg.replace('<svg ', '<svg class="gwG" aria-hidden="true" focusable="false" '));
    frag.appendChild(span);
    count++;
  }
  text.parentNode?.replaceChild(frag, text);
  return count;
}
