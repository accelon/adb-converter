/* ---------------------------------------------------------------------------
 * ⚠ 生成檔，不要手改（改來源）。
 *
 * 來源：D:\2026\pinxing\src\pinxing.ts（sha256 14cf4c5d8c4cc7da，43380 bytes）
 * 產生：ts/tools/vendor-pinxing.ts　→　重跑：cd ts && bun run tools/vendor-pinxing.ts
 * 檢查：bun run tools/vendor-pinxing.ts --check（來源變了會 exit 1）
 *
 * 改寫（三條，見生成器檔頭）：拿掉 shebang、「node: 開頭的 import」、CLI 段。
 * 授權：Apache-2.0（pinxing 自己的程式碼），不含 GPLv3 的 kage-engine。
 * --------------------------------------------------------------------------- */
/**
 * pinxing.ts — **拼形描繪器**（把 KAGE 筆段畫成 SVG；accelon26 用，Apache 乾淨）。
 *
 * ============================ 為什麼要有這一支 ============================
 *
 * `kage-engine/`（上游的 KAGE 引擎）是 **GPLv3**，而 accelon26 是 Apache-2.0；把引擎嵌進
 * exe／html 等於發佈 GPL 程式碼。所以作者 2026-11-06 定案：**自己重寫一個描繪器**
 * （原話：「就是 AI 重寫優化」）。上游引擎仍留在本專案給 pinxing.html／glyph-browser.html 用，
 * 並且**只在本機當這一支的驗收仲裁者**（`check-pinxing-render.ts`：IoU、墨跡框、並排 PNG）。
 *
 * ============================ 與上游引擎的關係（重要）============================
 *
 * **不是逐行移植，是照語意重寫。** 引擎把「筆形」藏在兩個數字裡 ——
 * KAGE 筆段的 `width` 欄（a2）與 `style` 欄（a3）其實是**起筆／收筆的形狀代碼**
 * （0＝平、1＝圓、5＝挑、12＝斜切起筆、13／23＝折角切、32＝平切…），
 * 而它的 `cdDrawLine`／`cdDrawCurveU` 用幾百行 if 把它們畫出來。
 *
 * 這裡把那一層**抽成獨立的「筆劃風格」層**（`StrokeStyle`）：
 *
 *   1. `parseKageStrokes()`／`expandRefs()`  → **幾何**：中線、引用框、伸縮（與風格無關）
 *   2. `shapeOf()`                           → **形狀代碼 → 筆形**（起筆／收筆／折角／粗細比）
 *   3. `STYLES`                              → **風格表**：`songti`（宋體，預設）／`heiti`（黑體）
 *                                              ／`yuanti`（圓體）／`xiti`（細體）
 *   4. `buildOutline()`                      → 中線 ＋ 寬度剖面 ＋ 端點形狀 → 多邊形
 *
 * ★ 作者 2026-11-06：「**kage 不有圓體，我們可以加各種變化**」。上游引擎只有兩種體
 *   （只有宋體與黑體，而黑體只是「不做那堆自動調整」）；這裡的風格是**參數化**的
 *   （粗細比、端點、接頭、圓角、收細位置），所以「圓體」「細體」「楷意」都只是多一張表
 *   —— 見 `STYLES` 與 `check-pinxing-render.ts` 的 `--style` 對照圖。
 *
 * ⚠ **命名**（作者 2026-11-06）：這一支叫 **pinxing**（拼形），不叫 kage-lite；
 *   風格的代號一律用**普通話拼音**（songti／heiti／yuanti／xiti），不用日文羅馬字
 *   （原本的 mincho／gothic／maru／shotai 一律換掉）。只有 `kBuhin` 這個名字留著 —— 那是**上游引擎的介面**，
 *   共用的模組（`compose-fit.ts` 等）呼叫它，我們不能單方面改。
 *
 * ============================ 保真度（誠實清單）============================
 *
 * v0（本檔）**刻意不做**上游引擎的那些「自動調整」：筆鋒、鱗、豎的加粗、曲的加粗、
 * 折角讓位、切角。它們靠「鄰筆關係」改寫筆段參數，是大字展示的資產；
 * 在本文 1em（16 px）幾乎不可見。要不要往上追，看並排圖再決定。
 *
 * 已知差異（量出來的，不是猜的）：見 `check-pinxing-render.ts` 報表的 `IoU`／`bbox`。
 *
 * ============================ 用法 ============================
 *
 *   bun run tools/pinxing.ts --cp u29028                     # 印 SVG 與統計
 *   bun run tools/pinxing.ts --cp u29028 --style yuanti --out out/a.svg
 *   （程式內：`installLitePinxing()` 之後，`svgOf()`／`evalSeq()` 等既有模組直接用它）
 */

/* ============================ 1. KAGE 資料 → 筆段 ============================ */

/** 一筆（KAGE 的 `kind:width:style:x1:y1:…`）。座標一律絕對值（引用已展開）。 */
export interface Stroke {
  /** 1＝直線 2／3／4＝曲線 6＝折れの橫 7＝折線 12＝曲＋線 9＝未使用 */
  kind: number;
  /** KAGE 的 `width` 欄：**起筆形狀碼**（低三位）＋ 粗細調整（千位以上） */
  width: number;
  /** KAGE 的 `style` 欄：**收筆形狀碼**（低二位）＋ 折角調整（百位以上） */
  style: number;
  /** 4 個點（x1,y1,x2,y2,x3,y3,x4,y4）；用不到的是 0 */
  x1: number; y1: number; x2: number; y2: number;
  x3: number; y3: number; x4: number; y4: number;
}

/** KAGE 字串 → 筆段（**不含** kind 99 的引用；引用由 `expandRefs()` 處理）。 */
export function parseKageStrokes(data: string): Stroke[] {
  const out: Stroke[] = [];
  for (const part of String(data).split("$")) {
    if (!part) continue;
    const c = part.split(":").map((v) => Math.floor(Number(v) || 0));
    if (c[0] === 99) continue;
    out.push({
      kind: c[0]!, width: c[1] ?? 0, style: c[2] ?? 0,
      x1: c[3] ?? 0, y1: c[4] ?? 0, x2: c[5] ?? 0, y2: c[6] ?? 0,
      x3: c[7] ?? 0, y3: c[8] ?? 0, x4: c[9] ?? 0, y4: c[10] ?? 0,
    });
  }
  return out;
}

/** 一個筆段的「本體點」（依 kind 決定用幾個）。`boxOfStrokes()` 與取樣共用同一份判定。 */
export function pointsOf(s: Stroke): number[][] {
  const pts = [[s.x1, s.y1], [s.x2, s.y2], [s.x3, s.y3], [s.x4, s.y4]];
  const k = s.kind % 100;
  // 引擎的 kind：1 直線(2)、2／3 二次(3)、4 折れ(3)、6 三次(4)、7 線＋二次(4)、12 二次＋線(4)
  const n = k === 1 || k === 0 ? 2 : k === 6 || k === 7 || k === 12 ? 4 : 3;
  return pts.slice(0, n);
}

/** 筆段的頂點外框（引擎 `getBox()` 的同一套規矩：kind 0／99 不算）。 */
export function boxOfStrokes(strokes: Stroke[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = 200, minY = 200, maxX = 0, maxY = 0;
  for (const s of strokes) {
    if (s.kind === 0 || s.kind === 99) continue;
    for (const [x, y] of pointsOf(s)) {
      if (x! < minX) minX = x!;
      if (x! > maxX) maxX = x!;
      if (y! < minY) minY = y!;
      if (y! > maxY) maxY = y!;
    }
  }
  return { minX, minY, maxX, maxY };
}

/**
 * 引用框裡的「伸縮」（引擎 `stretch()` 的同一條公式）。
 *
 * `sp` ＝來源那一側的伸縮起點（0–100 是「百分比定位」）、`dp` ＝目標那一側。
 * 它讓「把一個部件的左半拉長」這種寫法成立 —— 是 KAGE 資料的一部分，不是筆形，所以照抄語意。
 */
function stretchCoord(dp: number, sp: number, p: number, min: number, max: number): number {
  let p1: number, p2: number, p3: number, p4: number;
  if (p < sp + 100) {
    p1 = min; p3 = min; p2 = sp + 100; p4 = dp + 100;
  } else {
    p1 = sp + 100; p3 = dp + 100; p2 = max; p4 = max;
  }
  if (p2 === p1) return Math.floor(p3);
  return Math.floor(((p - p1) / (p2 - p1)) * (p4 - p3) + p3);
}

/**
 * 展開引用（kind 99）：把子字形的筆段映進引用框。
 *
 * KAGE 的框語意（實測，`ids-glyph.ts` 檔頭）：**子字形的 200×200 畫布仿射映射到框**，
 * x 與 y 各自縮放 —— 所以框窄時筆寬也會被壓（這是刻意的，不是 bug）。
 */
export function expandRefs(
  lookup: (name: string) => string | null,
  data: string,
  depth = 0,
): Stroke[] {
  if (depth > 8) return [];
  const out: Stroke[] = [];
  for (const part of String(data).split("$")) {
    if (!part) continue;
    // ⚠ 欄位要**先留字串**再轉數字：引用的名字在第 8 欄（`…:g15xz:…`），
    //   整條 `map(Number)` 會把名字變成 0（踩過：所有有引用的字都畫成空白）。
    const cols = part.split(":");
    const n = (i: number, d = 0) => Math.floor(Number(cols[i]) || d);
    if (n(0) !== 99) {
      out.push({
        kind: n(0), width: n(1), style: n(2),
        x1: n(3), y1: n(4), x2: n(5), y2: n(6),
        x3: n(7), y3: n(8), x4: n(9), y4: n(10),
      });
      continue;
    }
    const boxX1 = n(3), boxY1 = n(4), boxX2 = n(5, 200), boxY2 = n(6, 200);
    let sx = n(1);
    let sy = n(2);
    let sx2 = n(9);
    let sy2 = n(10);
    const child = lookup(String(cols[7] ?? ""));
    if (child == null) continue;
    const strokes = expandRefs(lookup, child, depth + 1);
    if (!strokes.length) continue;
    // 引擎的規矩（照語意，不是照抄）：sx 只在 >100 時才減 200（左側伸縮寫成負值）；
    // 否則 sx2／sy2 歸零（一般伸縮不做「兩段式」）。
    if (sx !== 0 || sy !== 0) {
      if (sx > 100) sx -= 200;
      else { sx2 = 0; sy2 = 0; }
    }
    const box = boxOfStrokes(strokes);
    const doStretch = sx !== 0 || sy !== 0;
    const mapped = strokes.map((s) => {
      const st = { ...s };
      if (doStretch) {
        const X = (v: number) => stretchCoord(sx, sx2, v, box.minX, box.maxX);
        const Y = (v: number) => stretchCoord(sy, sy2, v, box.minY, box.maxY);
        st.x1 = X(st.x1); st.x2 = X(st.x2); st.x3 = X(st.x3); st.x4 = X(st.x4);
        st.y1 = Y(st.y1); st.y2 = Y(st.y2); st.y3 = Y(st.y3); st.y4 = Y(st.y4);
      }
      const fx = (v: number) => boxX1 + (v * (boxX2 - boxX1)) / 200;
      const fy = (v: number) => boxY1 + (v * (boxY2 - boxY1)) / 200;
      return {
        ...st,
        x1: fx(st.x1), y1: fy(st.y1), x2: fx(st.x2), y2: fy(st.y2),
        x3: fx(st.x3), y3: fy(st.y3), x4: fx(st.x4), y4: fy(st.y4),
      };
    });
    out.push(...mapped);
  }
  return out;
}

/* ============================ 2. 筆劃風格（可插拔）============================ */

/**
 * **筆劃風格**：這是本檔刻意獨立出來的一層（作者 2026-11-06 的要求）。
 *
 * 上游引擎把筆形散在幾百行 if 裡（而且只有兩種體）；這裡換成資料：
 * 想加「圓體」「細明朝」「楷意」只要多一張表，不必碰幾何程式碼。
 */
export interface StrokeStyle {
  /** 風格代號（給設定頁／CLI 用；**普通話拼音**） */
  id: string;
  /** 給人看的中文名（宋體／黑體／圓體…） */
  label: string;
  /** 橫細的半寬（KAGE 200 方格單位） */
  minWidthY: number;
  /** 豎粗的半寬 */
  minWidthT: number;
  /** 曲線（撇捺）的半寬 */
  minWidthC: number;
  /** 整體粗細倍數（設置的「字形粗細 %」接這裡） */
  weight: number;
  /** 起筆形狀：平／圓／斜切／尖 */
  capStart: CapShape;
  /** 收筆形狀 */
  capEnd: CapShape;
  /** 折角／接頭 */
  join: "miter" | "round" | "bevel";
  /** 折角的讓位量（0＝尖角） */
  cornerSoft: number;
  /** 撇捺末端的收細（1＝不收） */
  taperEnd: number;
  /** 起筆的收細（1＝不收） */
  taperStart: number;
  /** 端點圓弧用幾段（0＝不用圓弧，直接切） */
  roundSteps: number;
  /** 每一筆額外脹開的量（分格）：吃掉相鄰筆畫之間的**次像素細縫**。
   *  實測 0.35 可以把 200 px 的針孔從 11 個降到 2 個，但墨量會超過上游 5%、IoU 反而掉 0.015
   *  —— 所以**預設 0**，需要時再開（`--bleed`）。 */
  bleed: number;
}

export type CapShape = "butt" | "round" | "cut" | "point";

/**
 * 風格表。**預設 `songti`（宋體）**：數值照上游引擎的常數（`new Kage()` 那一組：橫 2、豎 6），
 * 這樣 v0 的墨跡量級與引擎一致（差的是筆形細節，不是整體大小）。
 *
 * 想加風格就在這裡多一張表 —— 不必碰任何幾何程式碼。
 */
export const STYLES: Record<string, StrokeStyle> = {
  /** 宋體（明朝體）：橫細豎粗、方起方收、撇捺收細 —— 上游引擎的預設筆形 */
  songti: {
    id: "songti", label: "宋體", minWidthY: 2, minWidthT: 6, minWidthC: 6, weight: 1, bleed: 0,
    capStart: "cut", capEnd: "butt", join: "miter", cornerSoft: 0, taperEnd: 0.18, taperStart: 0.9, roundSteps: 0,
  },
  /** 黑體：橫豎等粗、方頭（上游引擎的第二種體只是不做自動調整，這裡真的把粗細比拉平） */
  heiti: {
    id: "heiti", label: "黑體", minWidthY: 4.2, minWidthT: 5, minWidthC: 5, weight: 1, bleed: 0,
    capStart: "butt", capEnd: "butt", join: "miter", cornerSoft: 0, taperEnd: 0.95, taperStart: 0.95, roundSteps: 0,
  },
  /** ★ 圓體：上游引擎**沒有**（作者原話）。等粗 ＋ 圓頭圓角 ＋ 不收細。 */
  yuanti: {
    id: "yuanti", label: "圓體", minWidthY: 4.6, minWidthT: 4.8, minWidthC: 4.8, weight: 1, bleed: 0,
    capStart: "round", capEnd: "round", join: "round", cornerSoft: 2, taperEnd: 1, taperStart: 1, roundSteps: 4,
  },
  /** 細體（測試用：證明風格只是參數） */
  xiti: {
    id: "xiti", label: "細體", minWidthY: 1.1, minWidthT: 3.2, minWidthC: 3.2, weight: 1, bleed: 0,
    capStart: "cut", capEnd: "point", join: "miter", cornerSoft: 0, taperEnd: 0.3, taperStart: 0.8, roundSteps: 0,
  },
};

/** 全部風格的代號（給設定頁列舉用） */
export function styleIds(): string[] {
  return Object.keys(STYLES);
}

export function styleOf(id?: string): StrokeStyle {
  return STYLES[id ?? "songti"] ?? STYLES.songti!;
}

/** 形狀代碼 → 這一筆的「筆形」（起筆、收筆、收細）。**風格層的入口。** */
export interface StrokeShape {
  /** 中段（等寬）的半寬 */
  body: number;
  /** 橫向路段的半寬（`blend` 時用） */
  bodyY: number;
  /** 豎向路段的半寬（`blend` 時用） */
  bodyT: number;
  /** 寬度是否跟著走勢走（一筆同時有豎與橫的 kind 3／4／7／12） */
  blend: boolean;
  halfStart: number;
  halfEnd: number;
  capStart: CapShape;
  capEnd: CapShape;
  /** 折角的斜切量（KAKATO：右下角多切一塊） */
  kakato: number;
  /** 起筆的斜切量（引擎 12 那條） */
  kirikuchi: number;
  /** 收細從哪個位置開始（0–1；曲線的撇捺要一路收到尾，直線只在最末端收） */
  taperFrom: number;
  /** 起筆／收筆**沿路徑**多伸出的量（引擎的角會伸出中線端點，這是它「接得起來」的原因） */
  extendStart: number;
  extendEnd: number;
}

/**
 * 形狀代碼 → 筆形。**這是引擎幾百行 if 的替代品**：只認「常見且看得出來」的幾個，
 * 其餘一律退回風格的預設值（引擎也有很多代碼是 `// no need`）。
 *
 * 代碼來源（引擎的 `cdDrawLine`／`cdDrawCurveU`）：
 *   0 平（起筆另有三段小切角）、1／6／22 平、2 圓、5 挑（收筆往上）、
 *   12 斜切起筆、13／23 折角切、32 平切、24 T 形接頭。
 */
function shapeOf(kind: number, width: number, styleCode: number, s: StrokeStyle, orient: "yoko" | "tate" | "curve"): StrokeShape {
  const startCode = width % 1000;
  const endCode = styleCode % 100;
  const bleed = s.bleed ?? 0;
  const thin = s.minWidthY * s.weight + bleed;
  const thick = (orient === "tate" ? s.minWidthT : orient === "curve" ? s.minWidthC : s.minWidthY) * s.weight + bleed;
  const w = thick;
  const sh: StrokeShape = {
    body: w, bodyY: thin, bodyT: thick, blend: false,
    halfStart: w, halfEnd: w, taperFrom: 0.90,
    capStart: s.capStart,
    capEnd: s.capEnd,
    kakato: 0,
    kirikuchi: 0,
    // 預設只多伸出 0.3 個半寬（≈1–2 格）：引擎的角會伸出更多，見下面 12／22／13／23
    extendStart: w * 0.3,
    extendEnd: w * 0.3,
  };
  // 曲線（撇捺）比直線容易收細；kind 2 的收筆代碼 7／4 是「掃出去」
  if (orient === "curve") {
    sh.capStart = s.capStart === "butt" ? "cut" : s.capStart;
    sh.capEnd = s.capEnd;
    sh.halfEnd *= s.taperEnd;          // 撇捺的末端收細（風格參數）
    sh.taperFrom = 0.35;              // 撇捺從三成處就開始收（引擎的 harai）
  }
  // ★ 一筆裡同時有豎與橫的（`3`／`4`／`7`／`12`，例如 `亡` 的 `乚`）：**寬度跟著走勢走**。
  //   橫向的路段用「橫」的半寬、豎向的路段用「豎」的半寬，轉角處自然內插 ——
  //   這是「筆壓跟著運筆方向」的模型，也是自由組字時窄槽位裡的部件不會糊成一團的原因。
  if (kind === 1 || kind === 3 || kind === 4 || kind === 7 || kind === 12) sh.blend = true;
  // 直線（橫／豎）**不收細**：引擎的橫豎是等寬的（收細只發生在撇捺與特定收筆代碼）
  switch (startCode) {
    case 0: sh.capStart = s.capStart === "round" ? "round" : "cut"; sh.kirikuchi = 0.35; break;
    case 12: sh.kirikuchi = 1; sh.extendStart = w * 1.2; break;
    case 22: case 27: sh.capStart = s.capStart === "round" ? "round" : "butt"; sh.extendStart = w * 0.9; break;
    case 2: sh.capStart = "round"; break;
    default: break;
  }
  switch (endCode) {
    case 0: if (kind === 6) sh.capEnd = "butt"; else sh.capEnd = s.capEnd; break;
    case 1: case 5: sh.capEnd = s.capEnd === "round" ? "round" : "point"; break;
    case 2: sh.capEnd = "round"; break;
    case 13: sh.kakato = 1; sh.capEnd = "cut"; sh.extendEnd = w * 0.9; break;
    case 23: sh.kakato = 0.6; sh.capEnd = "cut"; sh.extendEnd = w * 0.6; break;
    case 24: case 32: sh.capEnd = "cut"; break;
    default: break;
  }
  if (orient === "curve") {
    sh.extendStart = w * 0.35; sh.extendEnd = w * 0.35;
    sh.halfStart *= s.taperStart;
    // 撇捺的尾端不能細到看不見：有了尺寸下限時，尾端至少留一半
    // （16 px 正文裡「收成針」的撇捺會整條灰掉，那正是 kage 在本文不好看的原因之一）
    sh.halfEnd = Math.max(sh.halfEnd, s.minWidthY * 0.5 * s.weight);
  } else {
    // 直線（橫／豎）等寬、不收細 —— 引擎的橫豎也是等寬的
    sh.halfStart = w; sh.halfEnd = w;
  }
  if (sh.blend) { sh.halfStart = sh.bodyT; sh.halfEnd = sh.bodyT; }
  return sh;
}

/* ============================ 3. 中線 → 多邊形 ============================ */

export interface PolyPoint { x: number; y: number; off?: number }
export interface Poly { array: PolyPoint[] }

/** 折線簡化（Douglas–Peucker）：把共線／近平的取樣點去掉。
 *  ⚠ 這直接決定 SVG 大小：一條 172 格的橫線若不簡化會留下 57 個點（實測整字 5,240 B → 目標 <3 KB）。 */
function simplify(pts: { x: number; y: number }[], eps = 1.2): { x: number; y: number }[] {
  if (pts.length <= 2) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = 1; keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    if (b - a < 2) continue;
    const p = pts[a]!, q = pts[b]!;
    const dx = q.x - p.x, dy = q.y - p.y;
    const len = Math.hypot(dx, dy) || 1;
    let best = -1, bestD = 0;
    for (let i = a + 1; i < b; i++) {
      const r = pts[i]!;
      const d = Math.abs((r.x - p.x) * dy - (r.y - p.y) * dx) / len;
      if (d > bestD) { bestD = d; best = i; }
    }
    if (bestD > eps && best > 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  return pts.filter((_, i) => keep[i] === 1);
}


function sampleCenterline(s: Stroke, step = 3): { x: number; y: number }[] {
  const k = s.kind % 100;
  const p: { x: number; y: number }[] = [];
  const line = (x1: number, y1: number, x2: number, y2: number) => {
    p.push({ x: x1, y: y1 });
    if (x2 !== x1 || y2 !== y1) p.push({ x: x2, y: y2 });
  };
  const quad = (x1: number, y1: number, cx: number, cy: number, x2: number, y2: number) => {
    const len = Math.hypot(x2 - x1, y2 - y1) + Math.hypot(cx - x1, cy - y1);
    const n = Math.max(2, Math.min(30, Math.round(len / step)));
    for (let i = p.length ? 1 : 0; i <= n; i++) {
      const t = i / n, u = 1 - t;
      p.push({ x: u * u * x1 + 2 * u * t * cx + t * t * x2, y: u * u * y1 + 2 * u * t * cy + t * t * y2 });
    }
  };
  const cubic = (x1: number, y1: number, c1x: number, c1y: number, c2x: number, c2y: number, x2: number, y2: number) => {
    const len = Math.hypot(x2 - x1, y2 - y1);
    const n = Math.max(3, Math.min(30, Math.round(len / step)));
    for (let i = p.length ? 1 : 0; i <= n; i++) {
      const t = i / n, u = 1 - t;
      p.push({
        x: u * u * u * x1 + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * x2,
        y: u * u * u * y1 + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * y2,
      });
    }
  };
  /**
   * **折れ（kind 3／4）的「圓角轉彎」**：直線 → 小圓角 → 直線。
   *
   * ⚠ 這是作者 2026-11-06 抓到的「芒的最後一筆太彎了」的根因：
   *   `亡` 的 `乚`（`3:12:0:38:56:38:174:173:174`）中間那一點是**轉角**，不是控制點。
   *   把它當二次 Bezier 的控制點，整條筆畫就會沿著對角鼓出去（實測離弦 45 格）；
   *   上游引擎的做法是「離轉角 `kMage` 處切斷、中間那一小段才走二次曲線」——
   *   所以**直的還是直的，只有轉角是圓的**。
   */
  const corner = (x1: number, y1: number, cx: number, cy: number, x2: number, y2: number, r0: number) => {
    const d1 = Math.hypot(cx - x1, cy - y1), d2 = Math.hypot(x2 - cx, y2 - cy);
    if (d1 < 1 || d2 < 1) { line(x1, y1, cx, cy); line(cx, cy, x2, y2); return; }
    const r = Math.min(r0, d1 * 0.45, d2 * 0.45);
    const ax = cx - ((cx - x1) / d1) * r, ay = cy - ((cy - y1) / d1) * r;
    const bx = cx + ((x2 - cx) / d2) * r, by = cy + ((y2 - cy) / d2) * r;
    line(x1, y1, ax, ay);
    quad(ax, ay, cx, cy, bx, by);
    line(bx, by, x2, y2);
  };
  switch (k) {
    case 2:
      // 二次 Bezier：p1 →（控制）p2 → p3
      quad(s.x1, s.y1, s.x2, s.y2, s.x3, s.y3);
      break;
    case 3:
      // 折れ：直線 ＋ **圓角轉彎**（半徑＝kMage 10 格）
      corner(s.x1, s.y1, s.x2, s.y2, s.x3, s.y3, 10);
      break;
    case 4:
      // 折れ（軟一點）：轉角半徑小一些（上游用 6，且隨長度縮放）
      corner(s.x1, s.y1, s.x2, s.y2, s.x3, s.y3, 6);
      break;
    case 6:
      // 三次 Bezier：p1 → c1 → c2 → p4
      cubic(s.x1, s.y1, s.x2, s.y2, s.x3, s.y3, s.x4, s.y4);
      break;
    case 7:
      // 直線 ＋ 二次：p1→p2，再 p2→（控制 p3）→p4
      line(s.x1, s.y1, s.x2, s.y2);
      quad(s.x2, s.y2, s.x3, s.y3, s.x4, s.y4);
      break;
    case 12:
      // 二次 ＋ 直線：p1→（控制 p2）→p3，再 p3→p4
      quad(s.x1, s.y1, s.x2, s.y2, s.x3, s.y3);
      line(s.x3, s.y3, s.x4, s.y4);
      break;
    default:
      line(s.x1, s.y1, s.x2, s.y2);
      break;
  }
  /*
   * **鉤／跳**（收筆代碼 4、5）：上游引擎會讓筆畫在末端轉一小段 —— `也` 的豎鉤、
   * `九`／`乚` 的豎彎鉤都是這個。不做這件事，字尾就是平的（作者看 `龍` 時會覺得「少了什麼」）。
   *
   * 方向：豎筆的鉤往左、橫筆的跳往上（字裡「往左上收」是通則）。長度 ＝ 上游的 `kMage`（10 格），
   * 用二次曲線收成一小段，寬度交給 `halfWidthAt()` 的末端收細。
   */
  const endCode = s.style % 100;
  if (p.length >= 2 && (endCode === 4 || endCode === 5)) {
    const a = p[p.length - 2]!, b = p[p.length - 1]!;
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    const hx = Math.abs(dy) > Math.abs(dx) ? -1 : 0;   // 豎 → 往左
    const hy = Math.abs(dy) > Math.abs(dx) ? 0 : -1;   // 橫 → 往上
    const hookLen = 10 * (endCode === 4 ? 1 : 0.8);
    // 二次：從筆畫末端切向轉到鉤的方向（控制點放在末端，才不會整條歪掉）
    const steps = 3;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps, u = 1 - t;
      const cxp = b.x + ux * hookLen * 0.35, cyp = b.y + uy * hookLen * 0.35;
      p.push({
        x: u * u * b.x + 2 * u * t * cxp + t * t * (b.x + hx * hookLen),
        y: u * u * b.y + 2 * u * t * cyp + t * t * (b.y + hy * hookLen),
      });
    }
  }
  return simplify(p, 1.2);
}

/** 中線在 t（0–1）的寬度（半寬）：起筆、收筆各自收細（收細只發生在兩端，中間等寬）。
 *  `blend`（一筆同時有豎與橫）時，中間的寬度由呼叫端依**局部走勢**給（`localW`）。 */
function halfWidthAt(t: number, shape: StrokeShape, localW?: number): number {
  const { halfStart: hs, halfEnd: he, body: w, taperFrom } = shape;
  const mid = localW ?? w;
  if (t < 0.08) return hs + (mid - hs) * (t / 0.08);
  if (t > taperFrom) return mid + (he - mid) * ((t - taperFrom) / (1 - taperFrom));
  return mid;
}

/**
 * 中線 ＋ 寬度剖面 ＋ 端點形狀 → 一個封閉多邊形。
 *
 * 做法：沿中線逐點取左右法線偏移，先走左側、貼收筆端點、再走右側回來、貼起筆端點。
 * 折角（join）用**相鄰法線平均**；圓頭／圓角另外補圓弧點（風格層的 `roundSteps`）。
 */
export function buildOutline(center: { x: number; y: number }[], shape: StrokeShape, s: StrokeStyle): PolyPoint[] {
  const n = center.length;
  if (n < 2) return [];
  const left: { x: number; y: number }[] = [];
  const right: { x: number; y: number }[] = [];
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : i / (n - 1);
    const prev = center[Math.max(0, i - 1)]!, next = center[Math.min(n - 1, i + 1)]!;
    let tx = next.x - prev.x, ty = next.y - prev.y;
    const len = Math.hypot(tx, ty) || 1;
    tx /= len; ty /= len;
    // `blend`：橫向的路段用「橫」的半寬、豎向用「豎」的半寬（筆壓跟著運筆方向）
    let localW: number | undefined;
    if (shape.blend) {
      const vert = Math.min(1, Math.abs(ty));   // 0 ＝ 純橫、1 ＝ 純豎
      localW = shape.bodyY + (shape.bodyT - shape.bodyY) * vert;
    }
    const w = halfWidthAt(t, shape, localW);
    // 法線（往左）
    const nx = -ty, ny = tx;
    left.push({ x: center[i]!.x + nx * w, y: center[i]!.y + ny * w });
    right.push({ x: center[i]!.x - nx * w, y: center[i]!.y - ny * w });
  }
  const out: PolyPoint[] = [];
  const push = (p: { x: number; y: number }, off?: number) => out.push({ x: p.x, y: p.y, off: off ? 1 : 0 });
  for (const p of left) push(p);
  // 收筆端
  const endDir = dirOf(center[n - 2]!, center[n - 1]!);
  appendCap(out, center[n - 1]!, endDir, shape.halfEnd, shape.capEnd, s, +1, shape.kakato, shape.extendEnd);
  for (let i = n - 1; i >= 0; i--) push(right[i]!);
  // 起筆端
  const startDir = dirOf(center[1]!, center[0]!);
  appendCap(out, center[0]!, startDir, shape.halfStart, shape.capStart, s, -1, shape.kirikuchi, shape.extendStart);
  return out;
}

function dirOf(a: { x: number; y: number }, b: { x: number; y: number }): { x: number; y: number } {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: dx / len, y: dy / len };
}

/** 端點：平／圓／斜切／尖。`dir` 是**往外**的方向；`extend` 是沿路徑多伸出的量。 */
function appendCap(
  out: PolyPoint[], at0: { x: number; y: number }, dir: { x: number; y: number },
  w: number, shape: CapShape, s: StrokeStyle, side: 1 | -1, skew: number, extend = 0,
): void {
  const at = { x: at0.x + dir.x * extend, y: at0.y + dir.y * extend };
  const nx = -dir.y, ny = dir.x;
  const A = { x: at.x + nx * w, y: at.y + ny * w };
  const B = { x: at.x - nx * w, y: at.y - ny * w };
  if (shape === "round" && s.roundSteps > 0) {
    // 半圓：用二次控制點（Polygon 的 off=1）兩段就夠
    const c1 = { x: at.x + dir.x * w + nx * w, y: at.y + dir.y * w + ny * w };
    const c2 = { x: at.x + dir.x * w - nx * w, y: at.y + dir.y * w - ny * w };
    out.push({ x: A.x, y: A.y, off: 0 });
    out.push({ x: c1.x, y: c1.y, off: 1 });
    out.push({ x: at.x + dir.x * w, y: at.y + dir.y * w, off: 0 });
    out.push({ x: c2.x, y: c2.y, off: 1 });
    out.push({ x: B.x, y: B.y, off: 0 });
    return;
  }
  if (shape === "point") {
    out.push({ x: A.x, y: A.y, off: 0 });
    out.push({ x: at.x + dir.x * w * 0.5, y: at.y + dir.y * w * 0.5, off: 0 });
    out.push({ x: B.x, y: B.y, off: 0 });
    return;
  }
  if (shape === "cut" && skew > 0.6) {
    // 斜切（引擎的 12）：只把「起筆那一側」沿路徑推一點，不做整體延長
    out.push({ x: A.x + dir.x * w * 0.6, y: A.y + dir.y * w * 0.6, off: 0 });
    out.push({ x: B.x, y: B.y, off: 0 });
    return;
  }
  void side;
  out.push({ x: A.x, y: A.y, off: 0 });
  out.push({ x: B.x, y: B.y, off: 0 });
}

/* ============================ 4. 與既有模組的接縫 ============================ */

/**
 * `Polygons` 的替代品（契約與引擎相同：`array: [{ array: [{x,y,off}] }]`）。
 *
 * `inkBoxOfPolygons()`（`lib-measure.ts`）直接讀 `array`，所以量墨跡不必改。
 * `generateSVG()` 這裡**順便輸出精簡版**：所有筆併成**一條 path**、座標取整、
 * `fill="currentColor"`（引擎是每筆一個 `<path fill="black">`，實測 3,091 B → 1,603 B）。
 */
export class LitePolygons {
  array: { array: PolyPoint[] }[] = [];
  clear(): void { this.array = []; }
  push(poly: { array: PolyPoint[] }): void {
    const pts = poly.array.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
    if (pts.length < 3) return;
    this.array.push({ array: pts });
  }
  generateSVG(): string {
    const d = this.toPathData();
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" preserveAspectRatio="xMidYMid meet">`
      + `<path d="${d}" fill="currentColor" fill-rule="nonzero"/></svg>`;
  }
  /** 全部筆段併成一條 path（`M…L…Q…Z` 接著下一筆）。 */
  toPathData(round = true): string {
    const num = (v: number) => {
      const r = round ? Math.round(v) : Math.round(v * 10) / 10;
      return String(r);
    };
    let d = "";
    for (const poly of this.array) {
      const a = poly.array;
      if (a.length < 3) continue;
      d += `M${num(a[0]!.x)} ${num(a[0]!.y)}`;
      for (let i = 1; i < a.length; i++) {
        const p = a[i]!;
        d += p.off ? `Q${num(p.x)} ${num(p.y)}` : `L${num(p.x)} ${num(p.y)}`;
        if (p.off) {
          // 二次控制點：真正的端點是下一個點，這裡只補控制點
          const nxt = a[i + 1];
          if (nxt) { d += ` ${num(nxt.x)} ${num(nxt.y)}`; i++; }
        }
      }
      d += "Z";
    }
    return d;
  }
}

/** 這一格字要怎麼畫（`glyphPolygons()` 的選項）。 */
export interface RenderOptions {
  /** 要不要畫裝飾（鱗、楔）—— 字級小的時候這些只是雜點（作者 2026-11-06：以本文為先） */
  ornaments?: boolean;
  /** 鱗的尺寸（照上游的 `kAdjustUrokoX`／`Y`：24×12，tier 0） */
  uroko?: { x: number; y: number };
  /**
   * **裝置像素格**（以 KAGE 分格計；0 ＝ 不對齊）。
   *
   * 這是小字最重要的一步（作者 2026-11-06：「手機、小字」）：一條 1 裝置像素寬的橫筆
   * 若落在像素邊界上，會被拆成兩列各 75% 的灰；**把它的上下緣對到像素格**之後
   * 就變成實心的一列。這等於字型的 hinting —— 只是我們做在座標上（向量），
   * 所以放大、列印、換 DPR 都還是乾淨的（預先烤好的 PNG 做不到這件事）。
   */
  grid?: number;
}

/**
 * 把**軸對齊**的筆畫（橫／豎）沿著它的厚度方向對齊裝置像素格。
 *
 * 只動「垂直於筆畫」的那一軸，而且是用仿射把 [min,max] 映到最近的格線，
 * 所以筆形（端點、鉤、收細）原樣保留。
 */
function snapToGrid(outline: PolyPoint[], axis: "x" | "y", grid: number): void {
  if (grid <= 0) return;
  let lo = Infinity, hi = -Infinity;
  for (const p of outline) { const v = p[axis]; if (v < lo) lo = v; if (v > hi) hi = v; }
  if (!Number.isFinite(lo) || hi - lo <= 0) return;
  // ⚠ 只把「邊」對到格線，**不強迫至少一格**：筆畫本來就比一個裝置像素細時
  //   （密集字的密度下限、dpr 較高的細橫）逼成 1 格會讓整個字變胖一圈。
  const a = Math.round(lo / grid) * grid;
  const minW = Math.min(hi - lo, grid);
  const b = Math.max(a + minW, Math.round(hi / grid) * grid);
  const k = (b - a) / (hi - lo);
  for (const p of outline) p[axis] = a + (p[axis] - lo) * k;
}

/** 一格字形 → 多邊形（`pinxing` 的主函式）。 */
export function glyphPolygons(strokes: Stroke[], style: StrokeStyle, opts: RenderOptions = {}): LitePolygons {
  const polys = new LitePolygons();
  for (const st of strokes) {
    const k = st.kind % 100;
    if (k === 0 || k === 9) continue;
    const center = sampleCenterline(st);
    if (center.length < 2) continue;
    // 方向：第一段
    const dx = Math.abs(center[center.length - 1]!.x - center[0]!.x);
    const dy = Math.abs(center[center.length - 1]!.y - center[0]!.y);
    const orient: "yoko" | "tate" | "curve" =
      (k === 2 || k === 3 || k === 4 || k === 6 || k === 7 || k === 12) ? "curve" : (dy > dx ? "tate" : "yoko");
    const shape = shapeOf(k, st.width, st.style, style, orient);
    const outline = buildOutline(center, shape, style);
    if (outline.length >= 3) {
      // 小字對齊裝置像素格：只動「軸對齊、且沒有鉤」的筆畫（有鉤的 y 範圍含鉤，對齊會歪）
      const endCode = st.style % 100;
      const hasHook = endCode === 4 || endCode === 5;
      if (opts.grid && !hasHook && k === 1) {
        const horiz = Math.abs(center[center.length - 1]!.y - center[0]!.y) < 1;
        const vert = Math.abs(center[center.length - 1]!.x - center[0]!.x) < 1;
        if (horiz) snapToGrid(outline, "y", opts.grid);
        else if (vert) snapToGrid(outline, "x", opts.grid);
      }
      polys.push({ array: outline });
    }
    // 鱗（uroko）：橫筆收筆的「刷一下」——上游在淺角度的橫筆尾端加一個小三角，
    // 那是它看起來像毛筆的來源。只在「看得見」的尺寸畫（1em 的正文裡只是雜點）。
    if (opts.ornaments && opts.uroko && k === 1 && st.style % 100 === 0) {
      const a = center[center.length - 2]!, b = center[center.length - 1]!;
      const dirx = b.x - a.x;
      if (Math.abs(dirx) > Math.abs(b.y - a.y) && dirx > 0) {   // 往右的橫筆
        const y = shape.bodyY;
        const ux = opts.uroko.x, uy = opts.uroko.y;
        polys.push({ array: [
          { x: b.x, y: b.y - y },
          { x: b.x - ux, y: b.y },
          { x: b.x - ux / 2, y: b.y - uy },
        ] });
      }
    }
  }
  return polys;
}

/**
 * **`LitePinxing`** —— 拼形描繪器的本體（上游 `Kage` 的替代品）。
 *
 * 名字裡的「Lite」是相對上游那份完整引擎（GPL，含筆鋒／鱗／折角等自動調整）：
 * 這一支只做「讀 KAGE 筆段 → 畫出輪廓」，換來的是 Apache 乾淨、快一倍、SVG 小一半，
 * 而且**知道字會被畫成幾個像素**（`emPx`）。
 *
 * 共用的模組（`compose-fit.ts`／`free-compose.ts`／`ids-glyph.ts`）只用到
 * `kBuhin.push/search` 與 `makeGlyph()`，所以換掉引擎不必改它們一行。
 *
 * ⚠ `kBuhin`（部品）是**上游引擎的介面名**：共用模組呼叫它，所以留著。
 *   我們自己的程式請走別名 `parts`。
 */
export class LitePinxing {
  /** 上游名（共用模組會用）：部件名 → KAGE 資料 */
  kBuhin = new Map<string, string>();
  /** 我們的別名（同一份資料） */
  get parts(): Map<string, string> { return this.kBuhin; }
  /** 風格代號（見 `STYLES`）：songti／heiti／yuanti／xiti */
  styleId = "songti";
  /** 粗細倍數（1 ＝ 100%；設置的「字形粗細 %」接這裡） */
  weight = 1;
  /**
   * **這一格字實際會被畫成幾個像素**（em；0 ＝ 不知道，不套用）。
   *
   * ★ 這是「為本文優化」的關鍵（作者 2026-11-06：「kage 和 glyphwiki 是沒有針對自由組字
   *   優化的，但我們有」）：KAGE 的橫筆只有 **2% em**（200 分格裡的 4 格），
   *   在 16 px 的正文裡是 **0.32 px** 的灰線（實測峰值不透明度 0.25–0.38）；
   *   在 200 px 的字形面板裡卻剛好。所以**同一個字要隨目標尺寸調整筆寬**：
   *   知道 em 之後，`minStrokePx` 才有意義。
   */
  emPx = 0;
  /**
   * **裝置像素比**（手機 2–3、桌機 1）。`emPx` 是 CSS px，真正畫出來的是 `emPx × dpr`
   * 個裝置像素 —— 而「看不看得見」是**裝置像素**決定的。
   *
   * 實測（`check-pinxing-text.ts --dpr`）：dpr ＝ 2 時，KAGE 的橫筆 4 分格 ＝ **0.64 裝置 px**，
   * 灰墨比例從 dpr 1 的 88% 掉到 ~30%；dpr ＝ 3 時 ≈ 1 裝置 px，**根本不需要補**。
   * 所以「小字缺筆」是**桌機 dpr 1** 的問題；手機上 SVG 本來就夠。
   */
  dpr = 1;
  /**
   * 最細的筆至少要有幾個**裝置像素**（只在設了 `emPx` 時生效；0 ＝ 不設下限）。
   *
   * 預設 **1.0**（＝一個裝置像素）：這是「線要實心、不要灰掉」的物理門檻。
   * dpr 2 時它只等於 0.5 CSS px，所以手機上幾乎不會觸發（不會讓字變胖）。
   */
  minStrokePx = 1.0;
  constructor(styleId?: string) {
    if (styleId) this.styleId = styleId;
  }
  /** 這一格字會被畫成幾個**裝置**像素（0 ＝ 不知道） */
  get devicePx(): number {
    return this.emPx > 0 ? this.emPx * this.dpr : 0;
  }
  /** 這一支實際要用的風格（粗細倍數 ＋ 尺寸下限套上去） */
  style(strokeCount = 0): StrokeStyle {
    const s = { ...styleOf(this.styleId) };
    s.weight = (s.weight ?? 1) * this.weight;
    // 1 分格 ＝ devicePx/200 裝置像素；要把「至少 minStrokePx」換算成半寬（分格）
    const dev = this.devicePx;
    if (dev > 0 && this.minStrokePx > 0) {
      // **筆畫越多、下限越低**（真正字型的光柵化也是這樣做的）：16 px 的 `寶`／`邏`
      // 若也拉到 1 裝置 px，筆畫會糊成一團（實測墨量 +59%）；稀疏的字才需要那條下限。
      const dense = strokeCount > 24 ? 0.6 : strokeCount > 12 ? 0.8 : 1;
      const floor = (this.minStrokePx * dense / 2) / (dev / 200);
      s.minWidthY = Math.max(s.minWidthY, floor);
      s.minWidthT = Math.max(s.minWidthT, floor);
      s.minWidthC = Math.max(s.minWidthC, floor);
    }
    return s;
  }
  /**
   * 要不要畫筆劃裝飾（鱗／楔）。**預設跟著字級走**：不指定 `emPx`（＝大字面板）就畫；
   * 小於 20 px 就關掉（16 px 的一條三角鱗只會是一坨灰點，反而讓字看起來髒）。
   */
  ornaments = true;
  makeGlyph(polygons: LitePolygons, key: string): void {
    const data = this.kBuhin.get(key) ?? "";
    if (!data) return;
    const strokes = expandRefs((n) => this.kBuhin.get(n) ?? null, data);
    // 1 分格 ＝ emPx/200 px；20 px 以上才畫裝飾
    const showOrnaments = this.ornaments && (this.emPx === 0 || this.emPx >= 20);
    const dev = this.devicePx;
    const p = glyphPolygons(strokes, this.style(strokes.length), {
      ornaments: showOrnaments,
      uroko: { x: 24, y: 12 },
      // 1 裝置像素 ＝ 200/dev 分格
      grid: dev > 0 ? 200 / dev : 0,
    });
    for (const poly of p.array) polygons.push(poly);
  }
  /** 展開引用後的筆段（除錯／CLI 用；引擎也有同名方法） */
  getEachStrokes(data: string): Stroke[] {
    return expandRefs((n) => this.kBuhin.get(n) ?? null, data);
  }
}

/**
 * 造一個「引擎形狀」的物件（上游 `Kage` 的兩個名字 `Kage`／`Polygons` 是共用模組找引擎的方式）。
 *
 * ★ 這是**唯一的接縫**：`compose-fit.ts`／`free-compose.ts`／`ids-glyph.ts` 都只透過
 *   `new (globalThis as any).Kage()` 拿引擎，所以裝上去之後整條組字管線自動改用它。
 *   瀏覽器端本來就把 `ensureEngine()` 改成 no-op，這一行就是它改吃的東西。
 *
 * 對外只露三個名字：`parts`（部件表）、`styleId`（songti／heiti／yuanti／xiti）、
 * `weight`（粗細倍數）。`kBuhin`／`makeGlyph`／`getEachStrokes` 是**上游介面**，留給共用模組。
 */
export function createLitePinxing(styleId = "songti"): Record<string, unknown> {
  const mine = new LitePinxing(styleId);
  const api: Record<string, unknown> = {
    // ⚠ 上游介面名，共用模組會用；我們的程式請走 `parts`
    kBuhin: {
      push: (n: string, d: string) => mine.kBuhin.set(n, d),
      search: (n: string) => mine.kBuhin.get(n) ?? "",
    },
    parts: mine.parts,
    makeGlyph: (polys: LitePolygons, key: string) => mine.makeGlyph(polys, key),
    getEachStrokes: (d: string) => mine.getEachStrokes(d),
  };
  Object.defineProperty(api, "styleId", {
    get: () => mine.styleId, set: (v: string) => { mine.styleId = v; }, enumerable: true,
  });
  Object.defineProperty(api, "weight", {
    get: () => mine.weight, set: (v: number) => { mine.weight = v; }, enumerable: true,
  });
  return api;
}

export function installLitePinxing(styleId = "songti"): void {
  const g = globalThis as any;
  g.Kage = function () { return createLitePinxing(styleId); };
  g.Polygons = LitePolygons;
}

/* ============================ 5. CLI ============================ */
