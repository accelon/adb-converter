/* ---------------------------------------------------------------------------
 * ⚠ 生成檔，不要手改（改來源）。
 *
 * 來源：D:\2026\pinxing\src\lib-format.ts（sha256 8833ab09c390ead8，41031 bytes）
 * 產生：ts/tools/vendor-pinxing.ts　→　重跑：cd ts && bun run tools/vendor-pinxing.ts
 * 檢查：bun run tools/vendor-pinxing.ts --check（來源變了會 exit 1）
 *
 * 改寫（三條，見生成器檔頭）：拿掉 shebang、「node: 開頭的 import」、CLI 段。
 * 授權：Apache-2.0（pinxing 自己的程式碼），不含 GPLv3 的 kage-engine。
 * --------------------------------------------------------------------------- */
/**
 * lib-format.ts — 精簡字形庫的格式定義：唯一的解碼實作。
 *
 * 這個檔案**不得**引入任何 Node/Bun 專屬模組（無 fs、無 sqlite），
 * 因為它同時被：
 *   1. `tools/read-library.ts`（Node 端，做往返驗證）
 *   2. `out/kage-viewer.html`（瀏覽器端，內嵌使用）
 * 使用。先前兩邊各有一份手寫的解碼邏輯，結果不同步而互相矛盾——
 * 現在只有這一份。
 *
 * ===========================================================================
 * 內部命名 vs 對外 API（重要）
 * ===========================================================================
 * **模組使用者一律用 Unicode 交流。** 想要某個字就用碼位：
 *
 *     const i = indexOfCodePoint(lib, 0x908f);      // 邏
 *     const j = indexOfCodePoint(lib, 0x29028);     // 𩀨（Ext B）
 *
 * 內部名（`g1k2` 這種）是**實作細節**，不對外承諾、也不要拿去比對或解析。
 * 要顯示給人看時用 `displayName()`；要接回 GlyphWiki dump 時用
 * `loadWikiNames()` 載入對照表（`out/lib-cjk-all.gnames.tsv.gz`）。
 *
 * 為什麼要這樣分：GlyphWiki 的名字（`u96b9-01@1`、`u2ff0-u9b2f-u5f61-var-001`、
 * `cdp-8bb0`）是**來源資料的識別碼**，不是這個模組對外的介面。
 * 舊版把名字直接當介面（`findGlyphIndex(lib, "u908f-j")`），
 * 於是每個呼叫端都得知道 GlyphWiki 的異體命名規則，而且名字層
 * 佔了整個檔案 gzip 後的 20.7%。
 *
 * ===========================================================================
 * 格式
 * ===========================================================================
 * 檔案開頭是魔數 `"GL"` ＋ 版本 byte，讓舊檔明確報錯而不是默默解成錯的。
 * 沒有魔數的檔案一律當成 **v1**（舊格式）讀，所以既有的
 * `out/lib-cjk.bin.gz` 與內嵌它的兩個網頁都不受影響。
 *
 * v2（`tools/build-library.ts` 寫出）:
 *   "GL" u8=2
 *   varint glyphCount
 *   varint familyCount
 *   familyCount × {                      家族表：成員在檔案裡是**連續**的
 *     zigzag cpDelta                     家族碼位（遞增，所以存差值）
 *     varint memberCount
 *     varint prefPlains                  (pref << 3) | plain
 *                                        pref  = 這個家族要用哪一個當代表（0..31）
 *                                        plain = 前幾個成員算「一般漢字」（0..7）
 *   }
 *   家族成員佔 [0, ΣmemberCount)，其餘（沒有家族的部件）接在後面。
 *   varint nReps ; nReps × 4 zigzag      框字典
 *   glyphCount × { 筆畫 }                 與 v1 完全相同
 *
 * v1（舊格式，只讀不寫）:
 *   varint glyphCount ; varint suffixCount ; suffix 表 ; 每個字形的名字 ; 框字典 ; 筆畫
 *
 * ===========================================================================
 * 編碼規則（踩過的坑）
 * ===========================================================================
 *   * **有號用 zigzag**：座標、width、style、伸縮值、碼位差值。
 *   * **非負用原始 varint**：計數／長度／索引／kind／旗標。
 *   * **`kind` 不可 zigzag**：99 會變成 199，永遠比不中。
 *   * `kind` 有三位數變體（103/203/303），判定點數要用 `kind % 100`。
 *   * `noStretch = 1` 時才省略後面 4 個伸縮值。
 *   * 座標一律 8 個欄位（依原始 F[3..10]），避免「尾欄省略」的歧義。
 */

export interface Stroke {
  kind: number;
  width: number;
  style: number;
  points: number[];
  ref: number | null;
  box: number[] | null;
  stretch: number[] | null;
}

export interface Glyph {
  /** 緊框：由內容衍生（不在檔案裡）。解碼時由 computeTight 填入。 */
  tight: [number, number, number, number] | null;
  strokes: Stroke[];
}

/**
 * 一個「碼位家族」：某個碼位的正字與它的所有異體，在檔案裡**連續排列**。
 * 成員索引是 `[start, start+count)`。
 */
export interface Family {
  /** Unicode 碼位 */
  cp: number;
  start: number;
  count: number;
  /**
   * 家族內「要用哪一個」（位移，0 起算）。
   * 慣例是 `-j`（日本字形）優先，其次 `uXXXX` 本身 —— 與舊版
   * `findGlyphIndex` 的偏好一致。
   */
  pref: number;
  /**
   * 前幾個成員算「一般漢字」（名字是 `uXXXX` 或 `uXXXX-j`）。
   * 給搜尋過濾用：`u2ff0-u9b2f-u5f61` 這種 IDS 命名的不算。
   */
  plain: number;
}

export interface Library {
  /** 家族表（依碼位遞增、成員連續）。**v1 為空陣列**——v1 只有名字，家族是查詢時推出來的。 */
  families: Family[];
  /** 沒有家族的部件字形從這個索引開始（v2）；v1 ＝ glyphs.length。 */
  orphanStart: number;
  glyphs: Glyph[];

  /**
   * **v1 專用**的原始 GlyphWiki 名字。v2 沒有這個欄位。
   * 不要在新程式裡用它——要 key 用 `keyOfIdx()`，要顯示用 `displayName()`。
   */
  names?: string[];
  /** v1 專用的後綴表。 */
  suffix?: string[];
  /**
   * **v3 專用**：碼位 → IDS 直接部件（**保留重複次數**，林 = 木 木）。
   *
   * 這一段是為了「GlyphWiki 把部件畫成原始筆劃」的情況（杏、林）。
   * 走部件圖請用 `componentKids()`，不要直接讀這個欄位——
   * 它只處理「有沒有 IDS」，跟 KAGE 引用的取捨寫在那支裡。
   * v1／v2 沒有這個欄位。
   */
  comp?: Map<number, number[]>;
  /** v5：跨碼位異體（相容字符 ↔ 正規碼位）；`variantSiblings()` 查它 */
  syn?: Map<number, number[]>;
  /** v6：**理據拆分**（說文解字注的「从X ＋ X聲」，例 雖→虫＋唯）。
   *  ⚠ 只供顯示／查閱 ✓，**不參與組字** ✗ ——組字一律用 `comp` 的視覺拆分 ✓。 */
  phil?: Map<number, number[]>;
  /** 內部索引 → GlyphWiki 名字的對照表；只有 `loadWikiNames()` 之後才有。 */
  gwiki?: string[];

  // 查詢快取（外部不要碰）
  _cpFam?: Map<number, number>;
  _cpPref?: Map<number, number>;
  _cpMembers?: Map<number, number[]>;
  /** 這份庫是用 `decodeLibraryLazy()` 解的：`glyphs[i]` 是**樁**（第一次讀才解）。
   *  ⚠ 讀起來與全解版完全一樣，但**不要**假設 `glyphs` 是普通物件陣列
   *  （例如 `JSON.stringify` 會拿到空物件）——要攤平請先 `materialize(lib)`。 */
  _lazy?: boolean;
}

/** 筆畫型別 → 座標點數（僅供繪製參考；格式一律存 8 個） */
export function ptCountOf(kind: number): number {
  const k = kind % 100;
  if (k === 0 || k === 9) return 0;
  if (k === 1) return 2;
  if (k === 2 || k === 3 || k === 4) return 3;
  return 4;
}

// ===========================================================================
// 對外 API：Unicode 進、Unicode 出
// ===========================================================================

/**
 * 內部 key（給 KAGE 引擎當 hash key 用）。
 *
 * **這是實作細節，不要外流、不要解析、不要拿來當身分。**
 * 同一個字形在兩份不同的庫裡會有不同的 key，這點是刻意的。
 */
export function keyOf(i: number): string {
  return "g" + i.toString(36);
}

/** 某個字形在庫中的內部 key（v1 沿用原始名字，讓已內嵌的舊網頁不必重建） */
export function keyOfIdx(lib: Library, i: number): string {
  return lib.names ? (lib.names[i] ?? keyOf(i)) : keyOf(i);
}

/** 這個字形屬於哪個碼位（0 ＝ 不屬於任何碼位，是純部件） */
export function codePointOf(lib: Library, i: number): number {
  if (lib.families.length) {
    const fi = familyOfIdx(lib, i);
    return fi < 0 ? 0 : lib.families[fi]!.cp;
  }
  const nm = lib.names?.[i];
  const m = nm ? /^u([0-9a-f]{1,6})/i.exec(nm) : null;
  return m ? parseInt(m[1]!, 16) : 0;
}

/** 這個字形屬於哪個家族（-1 ＝ 沒有家族）。**v2 才有家族表，v1 一律 -1。** */
export function familyOfIdx(lib: Library, i: number): number {
  if (!lib.families.length || i < 0 || i >= lib.glyphs.length) return -1;
  if (i >= lib.orphanStart) return -1;
  const fams = lib.families;
  // families 依 start 遞增 → 二分搜尋
  let lo = 0, hi = fams.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const f = fams[mid]!;
    if (i < f.start) hi = mid - 1;
    else if (i >= f.start + f.count) lo = mid + 1;
    else return mid;
  }
  return -1;
}

/** cp → 家族索引的查詢表（v2） */
function cpFamMap(lib: Library): Map<number, number> {
  let m = lib._cpFam;
  if (!m) {
    m = new Map<number, number>();
    lib.families.forEach((f, i) => m!.set(f.cp, i));
    lib._cpFam = m;
  }
  return m;
}

/**
 * 舊版 `findGlyphIndex` 的偏好規則，原封不動。
 *
 * 規則（照抄，含它自己的怪癖）：
 *   1. `uXXXX-j` 一定勝出（取第一個出現的）
 *   2. `uXXXX` 本身**只在還沒有候選時**才成為候選 —— 所以如果
 *      `u9adf-03` 先出現、`u9adf` 後出現，舊版回傳的是 `u9adf-03`。
 *   3. 其餘「非 @版本」的 `uXXXX-***` 取最短的
 *   4. 帶 `@版本` 的一律不列入候選（所以只存在 @ 變體時會回 undefined）
 *
 * **v1 解碼與 build-library 都必須用同一份**，否則舊字庫與新字庫
 * 對同一個碼位會選到不同字形（實測 40,995 個碼位裡有 346 個會不一樣）。
 */
export function legacyPreference(names: string[]): Map<number, number> {
  const pref = new Map<number, number>();
  const len = new Map<number, number>();
  const settledJ = new Set<number>();
  for (let i = 0; i < names.length; i++) {
    const nm = names[i]!;
    const m = /^u([0-9a-f]{1,6})(-.*)?$/i.exec(nm);
    if (!m) continue;
    const cp = parseInt(m[1]!, 16);
    if (settledJ.has(cp)) continue;
    const suffix = m[2];
    if (suffix === "-j") { pref.set(cp, i); len.set(cp, nm.length); settledJ.add(cp); continue; }
    if (!suffix) {
      if (pref.get(cp) === undefined) { pref.set(cp, i); len.set(cp, nm.length); }
      continue;
    }
    if (/@/.test(suffix)) continue;
    const cur = pref.get(cp);
    if (cur === undefined || nm.length < len.get(cp)!) { pref.set(cp, i); len.set(cp, nm.length); }
  }
  return pref;
}

/**
 * v1 的「碼位 → 偏好字形索引」表。
 *
 * v1 檔案裡只有名字，家族是查詢時推出來的；偏好規則用
 * `legacyPreference` 與舊版完全一致，舊網頁的字形選擇才不會變。
 */
function v1PrefMap(lib: Library): Map<number, number> {
  let m = lib._cpPref;
  if (!m) { m = legacyPreference(lib.names ?? []); lib._cpPref = m; }
  return m;
}

/**
 * **主要的查字入口**：碼位 → 字形索引。
 *
 * 回傳的是該家族的「代表」（偏好順序：`-j` > 正字 > 最短變體）。
 * 這取代了舊的 `findGlyphIndex(lib, "u908f")`——呼叫端不該再碰名字。
 */
export function indexOfCodePoint(lib: Library, cp: number): number | undefined {
  if (lib.families.length) {
    const fi = cpFamMap(lib).get(cp);
    if (fi === undefined) return undefined;
    const f = lib.families[fi]!;
    return f.start + Math.min(f.pref, f.count - 1);
  }
  return v1PrefMap(lib).get(cp);
}

/** 碼位 → 這個家族的全部成員索引（含正字與所有異體） */
export function familyMembers(lib: Library, cp: number): number[] {
  if (lib.families.length) {
    const fi = cpFamMap(lib).get(cp);
    if (fi === undefined) return [];
    const f = lib.families[fi]!;
    return Array.from({ length: f.count }, (_, k) => f.start + k);
  }
  let m = lib._cpMembers;
  if (!m) {
    m = new Map<number, number[]>();
    (lib.names ?? []).forEach((nm, i) => {
      const mm = /^u([0-9a-f]{1,6})/i.exec(nm);
      if (!mm) return;
      const cp2 = parseInt(mm[1]!, 16);
      const arr = m!.get(cp2);
      if (arr) arr.push(i); else m!.set(cp2, [i]);
    });
    lib._cpMembers = m;
  }
  return m.get(cp) ?? [];
}

/** 字元（單一 code point 的字串）→ 字形索引 */
export function indexOfChar(lib: Library, ch: string): number | undefined {
  const cp = ch.codePointAt(0);
  return cp === undefined ? undefined : indexOfCodePoint(lib, cp);
}

/** 這個字形是不是某個碼位的異體／正字（取代舊的 `isVariantOf`） */
export function isVariantOfCp(lib: Library, i: number, cp: number): boolean {
  return codePointOf(lib, i) === cp;
}

/** 這個字形在庫中的字元（不是碼位字就回 null） */
export function charOf(lib: Library, i: number): string | null {
  const cp = codePointOf(lib, i);
  return cp ? String.fromCodePoint(cp) : null;
}

/** 是不是「一般漢字」（`uXXXX` 或 `uXXXX-j`），搜尋過濾用 */
export function isPlainIdeograph(lib: Library, i: number): boolean {
  if (lib.families.length) {
    const fi = familyOfIdx(lib, i);
    if (fi < 0) return false;
    return i - lib.families[fi]!.start < lib.families[fi]!.plain;
  }
  const nm = lib.names?.[i];
  return nm ? /^u[0-9a-f]{1,6}(-j)?$/i.test(nm) : false;
}

/**
 * 給人看的名字。
 *
 * 沒有載入對照表時回傳內部 key —— 那**不是**身分，只是方便你在 log 裡認人。
 * 要看到 GlyphWiki 的名字就 `loadWikiNames(lib, text)`。
 */
export function displayName(lib: Library, i: number): string {
  return lib.gwiki?.[i] ?? lib.names?.[i] ?? keyOf(i);
}

/**
 * 載入「內部索引 → GlyphWiki 名字」對照表（tab 分隔，一行一筆）。
 *
 * 這是唯一能查回 GlyphWiki dump 的橋。**只有除錯／回寫 dump 需要它**，
 * 網頁不需要，所以它不在字庫檔裡、也不該進前端。
 */
export function loadWikiNames(lib: Library, text: string): number {
  const out: string[] = new Array(lib.glyphs.length);
  let n = 0;
  for (const line of text.split("\n")) {
    if (!line) continue;
    const t = line.indexOf("\t");
    if (t < 0) continue;
    const i = Number(line.slice(0, t));
    if (Number.isInteger(i) && i >= 0 && i < out.length) { out[i] = line.slice(t + 1); n++; }
  }
  lib.gwiki = out;
  return n;
}

// ---------------------------------------------------------------- 舊 API（相容）

/**
 * @deprecated 用 `indexOfCodePoint` / `indexOfChar`。
 * 舊程式把 GlyphWiki 的名字當介面傳進來，這裡解出碼位後轉呼叫新 API。
 */
export function findGlyphIndex(lib: Library, base: string): number | undefined {
  const m = /^u([0-9a-f]{1,6})/i.exec(base);
  if (!m) return undefined;
  return indexOfCodePoint(lib, parseInt(m[1]!, 16));
}

/** @deprecated 用 `isVariantOfCp`。 */
export function isVariantOf(lib: Library, i: number, base: string): boolean {
  const m = /^u([0-9a-f]{1,6})/i.exec(base);
  if (!m) return false;
  return isVariantOfCp(lib, i, parseInt(m[1]!, 16));
}

// ===========================================================================
// 緊框
// ===========================================================================

/**
 * 計算一個字形的緊框（由內容衍生，因此不必存在檔案裡）。
 *
 * 定義：自己所有**有效**筆畫的點，加上所有子部件（經框映射後）的緊框，取聯集。
 * 注意 `kind 0/9` 不描繪，必須排除——先前 build-library 的 tightOf 沒排除，
 * 才會算出 [0,0,200,200] 這種無用的值。
 */
export function computeTight(
  lib: Library,
  idx: number,
  seen: Set<number> = new Set(),
): [number, number, number, number] {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  const upd = (a: number, b: number) => {
    if (a < x1) x1 = a;
    if (a > x2) x2 = a;
    if (b < y1) y1 = b;
    if (b > y2) y2 = b;
  };

  const g = lib.glyphs[idx]!;
  for (const s of g.strokes) {
    if (s.kind === 99) {
      if (s.ref === null || seen.has(s.ref)) {
        if (s.box) { upd(s.box[0]!, s.box[1]!); upd(s.box[2]!, s.box[3]!); }
        continue;
      }
      const child = lib.glyphs[s.ref];
      if (!child) {
        if (s.box) { upd(s.box[0]!, s.box[1]!); upd(s.box[2]!, s.box[3]!); }
        continue;
      }
      const next = new Set(seen);
      next.add(idx);
      const cb = child.tight ?? computeTight(lib, s.ref, next);
      const b = s.box!;
      // 子緊框經框映射到父空間（與 kage 的映射規則一致）
      const mapX = (cx: number) => b[0]! + (cx * (b[2]! - b[0]!)) / 200;
      const mapY = (cy: number) => b[1]! + (cy * (b[3]! - b[1]!)) / 200;
      upd(mapX(cb[0]), mapY(cb[1]));
      upd(mapX(cb[2]), mapY(cb[3]));
      continue;
    }
    const np = ptCountOf(s.kind);
    if (np === 0) continue;
    for (let i = 0; i < np; i++) upd(s.points[i * 2]!, s.points[i * 2 + 1]!);
  }

  if (!Number.isFinite(x1)) return [0, 0, 0, 0];
  return [Math.round(x1), Math.round(y1), Math.round(x2), Math.round(y2)];
}

// ===========================================================================
// 解碼
// ===========================================================================

function makeReader(bytes: Uint8Array, start: number) {
  let p = start;
  const unzig = (u: number) => (u >>> 1) ^ -(u & 1);
  /** 原始 varint（非負）：計數、長度、碼位、索引、kind、旗標 */
  const rvRaw = (): number => {
    let v = 0, shift = 0;
    for (;;) {
      if (p >= bytes.length) throw new Error("字形庫資料提前結束 @" + p);
      const b = bytes[p++]!;
      v |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) return v >>> 0;
      shift += 7;
      if (shift > 35) throw new Error("varint 過長 @" + p);
    }
  };
  /** zigzag（有號）：座標、width、style、伸縮值、碼位差值 */
  const rv = (): number => unzig(rvRaw());
  const str = (len: number): string => {
    let s = "";
    for (let j = 0; j < len; j++) s += String.fromCharCode(rvRaw());
    return s;
  };
  return { rvRaw, rv, str, pos: () => p, setPos: (q: number) => { p = q; } };
}

/** 讀框字典（v1／v2 相同）。回傳「框 → 陣列」的字典本身。 */
function readBoxDict(rd: ReturnType<typeof makeReader>): number[][] {
  const nReps = rd.rvRaw();
  const boxReps: number[][] = new Array(nReps);
  for (let i = 0; i < nReps; i++) boxReps[i] = [rd.rv(), rd.rv(), rd.rv(), rd.rv()];
  return boxReps;
}

/** 讀一個字形的筆畫（`readBodies()` 的內圈，抽出來給 lazy 版共用）。 */
function readOneGlyph(rd: ReturnType<typeof makeReader>, boxReps: number[][]): Glyph {
  const nStr = rd.rvRaw();
  const strokes: Stroke[] = [];
  for (let s = 0; s < nStr; s++) {
    const kind = rd.rvRaw();
    if (kind === 99) {
      const ref = rd.rvRaw();
      // 旗標：一個 byte 的 bit field（bit0 = isFull、bit1 = noStretch）
      const flags = rd.rvRaw();
      const isFull = (flags & 1) !== 0;
      const noStretch = (flags & 2) !== 0;
      const box = isFull ? [0, 0, 200, 200] : (boxReps[rd.rvRaw()] ?? [0, 0, 200, 200]);
      const stretch = noStretch ? [0, 0, 0, 0] : [rd.rv(), rd.rv(), rd.rv(), rd.rv()];
      strokes.push({ kind, width: 0, style: 0, points: box, ref, box, stretch });
    } else {
      const width = rd.rv();
      const style = rd.rv();
      const points: number[] = [];
      for (let i = 0; i < 8; i++) points.push(rd.rv());
      strokes.push({ kind, width, style, points, ref: null, box: null, stretch: null });
    }
  }
  return { tight: null, strokes };
}

/** 只往前走、不建物件（lazy 版掃位移表用）。**欄位順序必須與 `readOneGlyph()` 一致。** */
function skipOneGlyph(rd: ReturnType<typeof makeReader>): void {
  const nStr = rd.rvRaw();
  for (let s = 0; s < nStr; s++) {
    if (rd.rvRaw() === 99) {
      rd.rvRaw();                                  // ref
      const flags = rd.rvRaw();
      if ((flags & 1) === 0) rd.rvRaw();            // box 索引（isFull 時沒有）
      if ((flags & 2) === 0) { rd.rv(); rd.rv(); rd.rv(); rd.rv(); }   // stretch
    } else {
      rd.rv(); rd.rv();                             // width, style
      for (let i = 0; i < 8; i++) rd.rv();          // 8 個座標
    }
  }
}

/** 讀框字典 + 所有字形的筆畫（v1／v2 完全相同） */
function readBodies(rd: ReturnType<typeof makeReader>, n: number): Glyph[] {
  const boxReps = readBoxDict(rd);
  const glyphs: Glyph[] = new Array(n);
  for (let gi = 0; gi < n; gi++) glyphs[gi] = readOneGlyph(rd, boxReps);
  return glyphs;
}

/** 解碼後就地算緊框（不在檔案裡——它是由內容衍生的） */
function fillTight(lib: Library): void {
  for (let gi = 0; gi < lib.glyphs.length; gi++) {
    lib.glyphs[gi]!.tight = computeTight(lib, gi);
  }
}

/** 家族表（v2 以後的開頭）。 */
function readFamilies(rd: ReturnType<typeof makeReader>): { families: Family[]; orphanStart: number } {
  const nFams = rd.rvRaw();
  const families: Family[] = new Array(nFams);
  let cursor = 0;
  let prevCp = 0;
  for (let i = 0; i < nFams; i++) {
    const cp = prevCp + rd.rv();
    prevCp = cp;
    const count = rd.rvRaw();
    // 打包：高 5 bit ＝ pref、低 3 bit ＝ plain（與 build-library.ts 對稱）
    const packed = rd.rvRaw();
    families[i] = { cp, start: cursor, count, pref: packed >> 3, plain: packed & 7 };
    cursor += count;
  }
  return { families, orphanStart: cursor };
}

/**
 * 尾端區段（`comp`／`syn`／`phil`）——**放在字形之後**，所以 eager 與 lazy 兩條路
 * 都在同一個位置接著讀。抽出來是為了「只有一份」：兩邊各寫一份一定會歪。
 */
function readTailSections(
  rd: ReturnType<typeof makeReader>, lib: Library,
  withComp: boolean, compOrdered: boolean, withSyn: boolean, withPhil: boolean,
): void {
  if (withComp) {
    // 碼位 → IDS 直接部件（**保留重複次數**：林 = 木 木；**保留 IDS 順序**）
    const nEnt = rd.rvRaw();
    const comp = new Map<number, number[]>();
    let cp = 0;
    for (let i = 0; i < nEnt; i++) {
      cp += rd.rvRaw();
      const k = rd.rvRaw();
      let c = 0;
      const arr: number[] = new Array(k);
      /* v4：有號差值（可以任意順序）；v3：無號差值（一定是遞增，順序已經被排序丟掉） */
      for (let j = 0; j < k; j++) { c += compOrdered ? rd.rv() : rd.rvRaw(); arr[j] = c; }
      comp.set(cp, arr);
    }
    lib.comp = comp;
  }

  if (withSyn) {
    /* v5：跨碼位異體（相容字符 ↔ 正規碼位）。家族表只綁同碼位，這一區補「同一個字、兩個碼位」
       ——頁面的部件名字（IDS 的碼位）與框（畫法的碼位）靠它對起來。 */
    const nSyn = rd.rvRaw();
    const syn = new Map<number, number[]>();
    let a = 0, b = 0;
    for (let i = 0; i < nSyn; i++) {
      a += rd.rv(); b += rd.rv();
      const la = syn.get(a); if (la) la.push(b); else syn.set(a, [b]);
      const lb = syn.get(b); if (lb) lb.push(a); else syn.set(b, [a]);
    }
    lib.syn = syn;
  }
  if (withPhil) {
    /* v6：**理據拆分**（說文解字注的「从X ＋ X聲」，例 雖→虫＋唯 ✓、江→水＋工 ✓）。
       ⚠ 只供顯示／查閱 ✓，**不參與組字** ✗ ——組字一律用 `comp` 的視覺拆分 ✓。
       編碼與 `comp` 同型：碼位差、分量數、各分量差（全部 zigzag varint ✓）。 */
    const nPhil = rd.rvRaw();
    const phil = new Map<number, number[]>();
    let pa = 0;
    for (let i = 0; i < nPhil; i++) {
      pa += rd.rv();
      const k = rd.rvRaw();
      const arr: number[] = new Array(k);
      let c = pa;
      for (let j = 0; j < k; j++) { c += rd.rv(); arr[j] = c; }
      phil.set(pa, arr);
    }
    lib.phil = phil;
  }
}

function decodeV23(bytes: Uint8Array, start: number, withComp: boolean, compOrdered = false, withSyn = false, withPhil = false): Library {
  const rd = makeReader(bytes, start);
  const n = rd.rvRaw();
  const { families, orphanStart } = readFamilies(rd);
  const glyphs = readBodies(rd, n);
  const lib: Library = { glyphs, families, orphanStart };
  readTailSections(rd, lib, withComp, compOrdered, withSyn, withPhil);
  fillTight(lib);

  // 完整性檢查：解碼後的位置必須正好等於位元組數。
  // 這是唯一能自動抓到「格式解讀錯誤」的機制。
  if (rd.pos() !== bytes.length) {
    throw new Error(
      "字形庫解碼不完整：讀到 " + rd.pos() + " / " + bytes.length + " bytes（格式不符）",
    );
  }
  return lib;
}

/**
 * **lazy 版解碼**（2026-11-06，作者：「要不了 120 MB 的」）。
 *
 * 為什麼要有它（實測）：4.70 MB 的位元流攤成 191,727 個字形物件 ＋ 391,155 個筆段物件
 * ＋ 29.8 萬個 `stretch` 陣列，就是 **heap +117 MB、RSS +272 MB**——而一頁只看得到幾百個字形。
 *
 * 做法（**格式一個 byte 都沒改**）：
 *   1. 先掃一遍位元流，記下每個字形在第幾個 byte（`Uint32Array`，0.77 MB，實測 9.5 ms）。
 *   2. `lib.glyphs[i]` 回一個**樁**（同一族的物件，getter 在 prototype 上，所以每個樁只多一個欄位）；
 *      第一次讀 `strokes`／`tight` 才真的解那一個。
 *   3. 家族表／`comp`／`syn`／`phil` 照舊一次解完（查詢與檢字要用，量也小）。
 *
 * ⚠ 對外契約完全不變：`toKageData()`／`computeTight()`／`forkLibrary()`／`glyphs.slice()`
 *   全部照舊（`forkLibrary` 複製的是樁，不是解好的字形）。驗收是**全庫差分測試**：
 *   `tools/check-lib-lazy.ts` 逐字形比對 `toKageData` 與緊框。
 */
function decodeV23Lazy(bytes: Uint8Array, start: number, withComp: boolean, compOrdered = false, withSyn = false, withPhil = false): Library {
  const rd = makeReader(bytes, start);
  const n = rd.rvRaw();
  const { families, orphanStart } = readFamilies(rd);
  const boxReps = readBoxDict(rd);
  // 位移表：只往前走、不建物件
  const offs = new Uint32Array(n + 1);
  for (let gi = 0; gi < n; gi++) {
    offs[gi] = rd.pos();
    skipOneGlyph(rd);
  }
  offs[n] = rd.pos();
  const lib: Library = { glyphs: [] as unknown as Glyph[], families, orphanStart, _lazy: true };
  lib.glyphs = makeLazyGlyphs(lib, bytes, offs, boxReps);
  readTailSections(rd, lib, withComp, compOrdered, withSyn, withPhil);
  fillTightLazy(lib, n);
  if (rd.pos() !== bytes.length) {
    throw new Error(
      "字形庫解碼不完整（lazy）：讀到 " + rd.pos() + " / " + bytes.length + " bytes（格式不符）",
    );
  }
  return lib;
}

/** 正被計算緊框的字形（防引用環無限遞迴；正常字庫沒有環）。 */
const tightBusy = new Set<number>();

/**
 * 造一批「現解現存」的字形樁。
 *
 * 樁本身很小（物件標頭 ＋ 一個索引欄位）；`strokes`／`tight` 是 prototype 上的 getter，
 * 所以 19 萬個樁的固定成本遠小於把筆畫全部解出來。
 */
function makeLazyGlyphs(lib: Library, bytes: Uint8Array, offs: Uint32Array, boxReps: number[][]): Glyph[] {
  const rd = makeReader(bytes, 0);
  const decodeAt = (gi: number): Glyph => {
    rd.setPos(offs[gi]!);
    return readOneGlyph(rd, boxReps);
  };
  class LazyGlyph {
    private gi: number;
    private g: Glyph | null = null;
    constructor(gi: number) { this.gi = gi; }
    private load(): Glyph {
      if (!this.g) this.g = decodeAt(this.gi);
      return this.g;
    }
    get strokes(): Stroke[] { return this.load().strokes; }
    set strokes(v: Stroke[]) { this.g = { strokes: v, tight: null }; }
    get tight(): [number, number, number, number] | null {
      const g = this.load();
      if (g.tight) return g.tight;
      if (tightBusy.has(this.gi)) return [0, 0, 0, 0];   // 引用環的保底
      tightBusy.add(this.gi);
      try {
        g.tight = computeTight(lib, this.gi);
      } finally {
        tightBusy.delete(this.gi);
      }
      return g.tight;
    }
    set tight(v: [number, number, number, number] | null) { this.load().tight = v; }
  }
  const out: Glyph[] = new Array(offs.length - 1);
  for (let gi = 0; gi < out.length; gi++) out[gi] = new LazyGlyph(gi) as unknown as Glyph;
  return out;
}

/** lazy 版的「全部算緊框」：只把 `tight` 先算好會失去 lazy 的意義，所以預設不做。
 *  留這支是為了「需要時可以一次攤平」（例如要把庫丟給不支援 getter 的消費者）。 */
function fillTightLazy(lib: Library, n: number): void {
  void lib; void n;
}

/** v1（舊格式）：名字是字串，家族在解碼時由名字推導 */
function decodeV1(bytes: Uint8Array, start: number): Library {
  const rd = makeReader(bytes, start);
  const n = rd.rvRaw();
  const ns = rd.rvRaw();

  const suffix: string[] = [];
  for (let i = 0; i < ns; i++) suffix.push(rd.str(rd.rvRaw()));

  const names: string[] = new Array(n);
  for (let gi = 0; gi < n; gi++) {
    const cp = rd.rvRaw();
    if (cp !== 0) {
      const six = rd.rvRaw();
      names[gi] = "u" + cp.toString(16).toLowerCase() + (six ? suffix[six - 1]! : "");
    } else {
      names[gi] = rd.str(rd.rvRaw());
    }
  }

  const glyphs = readBodies(rd, n);
  const lib: Library = { glyphs, families: [], orphanStart: n, names, suffix };

  if (withSyn) {
    /* v5：跨碼位異體（相容字符 ↔ 正規碼位）。家族表只綁同碼位，這一區補「同一個字、兩個碼位」
       ——頁面的部件名字（IDS 的碼位）與框（畫法的碼位）靠它對起來。 */
    const nSyn = rd.rvRaw();
    const syn = new Map<number, number[]>();
    let a = 0, b = 0;
    for (let i = 0; i < nSyn; i++) {
      a += rd.rv(); b += rd.rv();
      const la = syn.get(a); if (la) la.push(b); else syn.set(a, [b]);
      const lb = syn.get(b); if (lb) lb.push(a); else syn.set(b, [a]);
    }
    lib.syn = syn;
  }
  if (withPhil) {
    /* v6：**理據拆分**（說文解字注的「从X ＋ X聲」，例 雖→虫＋唯 ✓、江→水＋工 ✓）。
       ⚠ 只供顯示／查閱 ✓，**不參與組字** ✗ ——組字一律用 `comp` 的視覺拆分 ✓。
       編碼與 `comp` 同型：碼位差、分量數、各分量差（全部 zigzag varint ✓）。 */
    const nPhil = rd.rvRaw();
    const phil = new Map<number, number[]>();
    let pa = 0;
    for (let i = 0; i < nPhil; i++) {
      pa += rd.rv();
      const k = rd.rvRaw();
      const arr: number[] = new Array(k);
      let c = pa;
      for (let j = 0; j < k; j++) { c += rd.rv(); arr[j] = c; }
      phil.set(pa, arr);
    }
    lib.phil = phil;
  }  fillTight(lib);

  if (rd.pos() !== bytes.length) {
    throw new Error(
      "字形庫解碼不完整：讀到 " + rd.pos() + " / " + bytes.length + " bytes（格式不符）",
    );
  }
  return lib;
}

// ===========================================================================
// 對外：解碼入口
// ===========================================================================

/**
 * 解碼字庫。
 *
 * 有 `"GL"` 魔數 → 依版本 byte 解；沒有 → 當成 v1（舊格式）。
 * 這樣舊的 `out/lib-cjk.bin.gz`（以及內嵌它的兩個網頁）不必重建就能繼續用。
 *
 *   v1  舊格式，名字是字串
 *   v2  家族表＋盒字典，沒有部件資料
 *   v3  v2 ＋ 尾端 IDS 部件區段（`lib.comp`）
 */
export function decodeLibrary(bytes: Uint8Array): Library {
  if (bytes.length >= 3 && bytes[0] === 0x47 && bytes[1] === 0x4c) {
    const ver = bytes[2]!;
    if (ver === 2) return decodeV23(bytes, 3, false);
    if (ver === 3) return decodeV23(bytes, 3, true, false);
    if (ver === 4) return decodeV23(bytes, 3, true, true);
    if (ver === 5) return decodeV23(bytes, 3, true, true, true);
    /* v6：多一區「**理據拆分**」（說文；只顯示、不參與組字 ✓）。
       ⚠ 目前只到這一行 ✗——`decodeV23` 的 `withPhil` 區段與產生器還沒做，
       所以若現在產生 v6 會**大聲失敗**（收尾的「解碼不完整」檢查 ✓），不會靜默讀錯 ✓。 */
    if (ver === 6) return decodeV23(bytes, 3, true, true, true, true);
    throw new Error(`不認得的字形庫版本 ${ver}（這個檔案是 v1 的話應該沒有魔數開頭）`);
  }
  return decodeV1(bytes, 0);
}

/**
 * **lazy 版**解碼：對外契約與 `decodeLibrary()` **完全一樣**，只是字形「第一次讀到才解」。
 *
 * 什麼時候用：常駐的消費者（閱讀器）——一頁只看得到幾百個字，沒道理為 19 萬個字形
 * 先付 117 MB（實測，見 `decodeV23Lazy()` 的檔頭）。
 *
 * ⚠ 兩條路徑**必須給同一個答案**：`tools/check-lib-lazy.ts` 逐字形比對
 *   `toKageData()` 與緊框（全庫 191,727 筆），不一致就失敗。
 *
 * v1（沒有魔數的舊格式）**無法 lazy**（名字是字串、沒有位移可言），直接退回全解。
 */
export function decodeLibraryLazy(bytes: Uint8Array): Library {
  if (bytes.length >= 3 && bytes[0] === 0x47 && bytes[1] === 0x4c) {
    const ver = bytes[2]!;
    if (ver === 2) return decodeV23Lazy(bytes, 3, false);
    if (ver === 3) return decodeV23Lazy(bytes, 3, true, false);
    if (ver === 4) return decodeV23Lazy(bytes, 3, true, true);
    if (ver === 5) return decodeV23Lazy(bytes, 3, true, true, true);
    if (ver === 6) return decodeV23Lazy(bytes, 3, true, true, true, true);
    throw new Error(`不認得的字形庫版本 ${ver}`);
  }
  return decodeV1(bytes, 0);
}

/**
 * 把 lazy 庫**攤平**（每個字形都解出來、緊框都算好）。
 *
 * 只有在「要把庫交給不支援 getter 的消費者」時才需要（例如 `JSON.stringify`、
 * 或 `structuredClone` 到 worker）。攤平之後就是一個普通的全解庫。
 */
export function materialize(lib: Library): Library {
  if (!lib._lazy) return lib;
  const glyphs: Glyph[] = new Array(lib.glyphs.length);
  for (let i = 0; i < lib.glyphs.length; i++) {
    const g = lib.glyphs[i]!;
    glyphs[i] = { tight: g.tight, strokes: g.strokes };
  }
  return { ...lib, glyphs, _lazy: false };
}

/**
 * 走部件圖用的一步：**有 IDS 分解就用 IDS，否則用 KAGE 引用**。
 *
 * 只用一種來源才不會重複計算：器的「口」走 KAGE（經「吅」）算 2 個、
 * 走 IDS（經「㗊」）算 4 個、走 KAGE 引用算 2 個。
 * **不要混用**：混用會多算，而「多算成多少」取決於你怎麼把兩份清單併起來
 * （取聯集去重、或直接串接，得到的數字不一樣），所以那個數字沒有意義——
 * 有意義的是「一次只用一種來源」。
 *
 * 回傳字形索引，**可能有重複**（林 = 木 木，代表出現兩次）。
 */
/** 跨碼位異體：與這個碼位「同一個字、不同碼位」的碼位（v5 的 `syn`；沒有就是空） */
export function variantSiblings(L: Library, cp: number): number[] {
  return L.syn?.get(cp) ?? [];
}

export function componentKids(L: Library, gi: number): number[] {
  const cp = codePointOf(L, gi);
  const ids = cp != null ? L.comp?.get(cp) : undefined;
  if (ids && ids.length) {
    const out: number[] = [];
    for (const c of ids) {
      const r = indexOfCodePoint(L, c);
      if (r !== undefined) out.push(r);
    }
    if (out.length) return out;      // 全部落在字庫外就退回 KAGE
  }
  const out: number[] = [];
  for (const s of L.glyphs[gi]!.strokes) if (s.kind === 99 && s.ref !== null) out.push(s.ref);
  return out;
}

/** 這個字形有沒有 IDS 補的部件（＝KAGE 那邊是畫成筆劃的） */
export function hasIdsComponents(L: Library, gi: number): boolean {
  const cp = codePointOf(L, gi);
  return !!(cp != null && L.comp?.get(cp)?.length);
}

/** 還原成 KAGE 資料字串（給 kage-engine 用） */
export function toKageData(g: Glyph, lib: Library): string {
  const out: string[] = [];
  for (const s of g.strokes) {
    if (s.kind === 99) {
      const b = s.box!;
      const st = s.stretch!;
      out.push(
        "99:0:0:" + b[0] + ":" + b[1] + ":" + b[2] + ":" + b[3] + ":" +
        keyOfIdx(lib, s.ref!) + ":" + st[0] + ":" + st[1] + ":" + st[2] + ":" + st[3],
      );
    } else {
      out.push([s.kind, s.width, s.style].concat(s.points).join(":"));
    }
  }
  return out.join("$");
}

// ===========================================================================
// 自由組字（舊介面，保留相容）
// ===========================================================================

export interface ComposeOk {
  lib: Library;
  targetIdx: number;
  log: string[];
}
export type ComposeResult = ComposeOk | { error: string };

/**
 * @deprecated 用 `tools/free-compose.ts` 的 `evalSeq`。
 *
 * 舊 API：`baseCh` 為主字，之後每兩個字為一組「舊部件、新部件」。
 * 這裡保留是因為 `tools/verify-compose.ts` 還在用；內部已改走 Unicode。
 */
export function compose(
  lib: Library,
  baseCh: string,
  pairs: [string, string][],
): ComposeResult {
  const baseIdx = indexOfChar(lib, baseCh);
  if (baseIdx === undefined) return { error: `主字「${baseCh}」不在字形庫中` };

  const glyphs: Glyph[] = lib.glyphs.slice();
  const log: string[] = [];

  for (const [oldCh, newCh] of pairs) {
    const oldCp = oldCh.codePointAt(0)!;
    const toIdx = indexOfChar(lib, newCh);
    if (toIdx === undefined) return { error: `替換部件「${newCh}」不在字形庫中` };

    let hits = 0;
    const visit = (i: number, seen: Set<number>): void => {
      if (seen.has(i)) return;
      seen.add(i);
      const g = glyphs[i]!;
      const strokes: Stroke[] = [];
      let changed = false;
      for (const s of g.strokes) {
        if (s.kind === 99 && s.ref !== null && isVariantOfCp(lib, s.ref, oldCp)) {
          strokes.push({ ...s, ref: toIdx });
          hits++;
          changed = true;
        } else {
          strokes.push(s);
        }
      }
      if (changed) glyphs[i] = { tight: g.tight, strokes };
      for (const s of glyphs[i]!.strokes) {
        if (s.kind === 99 && s.ref !== null) visit(s.ref, seen);
      }
    };
    visit(baseIdx, new Set());

    if (hits === 0) {
      return { error: `主字「${baseCh}」的結構中找不到部件「${oldCh}」` };
    }
    log.push(`${oldCh} → ${newCh}（替換 ${hits} 處）`);
  }

  return {
    lib: { ...lib, glyphs },
    targetIdx: baseIdx,
    log,
  };
}

/** 淺複製一份庫（家族表與對照表共用，只有 glyphs 換新） */
export function forkLibrary(lib: Library, glyphs: Glyph[]): Library {
  return { ...lib, glyphs };
}


/**
 * syn 圖的**連通分量**代表碼位（v5 的跨碼位異體）。
 *
 * ⚠ 不能用「{自己} ∪ 直接鄰居 取最小」——syn 圖**不一定完全連通**：
 * `辶↔辶`、`辶↔⻌(U+2ECC)`、`辶↔⻍(U+2ECD)` 是同一個連通分量，但 `辶` 只連到 `辶`，
 * 於是「取直接鄰居的最小」會得到 `辶→2ECC` 而 `辶→8FB6`，**兩者不相等**；
 * 配對就會把部件配到錯的引用框（第 45 輪實測：`進` 的 `隹` 拿到 `辶` 的框、格數也變 1）。
 * 這裡用 union-find 求連通分量，同分量共用「最小碼位」當代表。
 */
const synKeyCache = new WeakMap<Library, Map<number, number>>();
export function synKeyOf(L: Library, cp: number): number {
  let table = synKeyCache.get(L);
  if (!table) {
    table = new Map<number, number>();
    const parent = new Map<number, number>();
    const find = (x: number): number => {
      let r = parent.get(x) ?? x;
      while (r !== (parent.get(r) ?? r)) r = parent.get(r) ?? r;
      let cur = x;
      while (cur !== r) { const next = parent.get(cur) ?? cur; parent.set(cur, r); cur = next; }
      return r;
    };
    for (const [a, list] of L.syn ?? new Map<number, number[]>()) {
      if (!parent.has(a)) parent.set(a, a);
      for (const b of list) {
        if (!parent.has(b)) parent.set(b, b);
        const ra = find(a), rb = find(b);
        if (ra !== rb) parent.set(Math.max(ra, rb), Math.min(ra, rb));
      }
    }
    for (const x of Array.from(parent.keys())) table.set(x, find(x));
    synKeyCache.set(L, table);
  }
  return table.get(cp) ?? cp;
}
