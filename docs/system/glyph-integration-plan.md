# 字形庫整合（glyphwiki → accelon26）規劃

> 2026-11-06。作者需求原文：
> 「將 `d:\2023\glyphwiki\` 的組字功能，整合到 accelon26，可以將**本文區的 IDS**、
> **所有的 Unicode Extension（即使客戶沒字形）**轉換為**與本文大小一致**的 SVG 動態字形。
> 搬入 `pinxing.html` 的**找字能力**和**字形庫**嵌入 accelon26，但**組字程序和數據還是留在那裡**……
> `glyphwiki` 字形庫成為 **exe 的 asset**，html 不包入 asset，fallback 到 IDS 或構形序。
> `GlyphWiki` 的工作區不需要知道 ADB 的存在，它只是我們調用的底層庫。」
>
> 本文是**施工前的規劃與 UI 衝擊研究**（含實測數字）。尚未動任何程式碼。

---

## 0. 一句話

**字形庫（2.33 MB `.bin.gz`）進 exe 的 asset；組字與解碼留在 glyphwiki（成為有 API 的底層庫）；
描繪用**我們自己寫的 `pinxing`**（不引入 GPLv3 的引擎）；
accelon26 只做三件事：載入、把本文裡的 Ext 字與 IDS 裝飾成 1em 的內嵌 SVG、以及「字形」分頁／卡片。**

---

## 1. 兩邊的現況（先查，不要重造）

### 1.1 glyphwiki 已有的能力（`D:\2023\glyphwiki`）

| 能力 | 位置 | 能不能直接用 |
| --- | --- | --- |
| 字庫解碼／查詢（Unicode 進出） | `tools/lib-format.ts`（34 KB，**零 import**） | ✅ 純函式 |
| 字庫檔案 | `out/lib-cjk-all.bin.gz`（2,327,989 B；191,727 字形／98,701 家族／92,933 IDS） | ✅ |
| KAGE→SVG 描繪 | `kage-engine/*.js`（8 檔，約 100 KB）＋ `compose-fit.ts` 的 `svgOf()` | ⚠ **GPLv3，不進 accelon26** → 自己寫 `pinxing`（§3.5）。但它可以留在 glyphwiki 當**對照的仲裁者** |
| **內嵌 SVG 的 CSS 三條（已量測）** | `free-compose.ts` 的 `INLINE_CSS`／`baselineDelta()` | ✅ **基線 `-0.22em` 已對 6 個字形驗過** |
| 從 IDS 造字形 | `tools/ids-glyph.ts`：`parseIds()`／`planIds()`／`idsGlyph()` | ✅ 按 IDC 等比分配、巢狀自動正確 |
| 拼形序列（基字＋換部件） | `tools/free-compose.ts`：`evalSeq()`／`canReplaceCp()`／`solveIdsSlots()` | ✅ |
| 檢字（部件、位置、筆劃、`U+XXXX`） | `free-compose.ts` 的 `searchByComponent()`／`inkZoneOf()`；頁面端 `pinxing-page.js` 的 `parseSearch()`／`runSearch()` | ⚠ 前半是模組、後半**還埋在頁面程式碼裡** |
| 部件框／部件清單 | `free-compose.ts` 的 `refSlotsOf()`／`describeSlots()`／`listReplaceables()` | ✅ |

**結論：需要的東西 90% 已經存在，缺的是「一個對外 API」和「把頁面端檢字抽成模組」。**

### 1.2 accelon26 現有的接口

| 東西 | 位置 | 對本工作的意義 |
| --- | --- | --- |
| 內文渲染（純字串，不碰 DOM） | `ts/src/accelon26/render_accelon3.ts` 的 `emit()／emitChunk()` | 已在這裡做「梵字 PUA／悉曇序列」的顯示替換，是既有先例 |
| 內嵌 SVG 的先例 | `inlineSvgHtml()`＋CSS `.lineText svg.inlineSvg`（1.5em、`fill:currentColor`） | 圖版與小篆就是這樣畫的 |
| 宿主 asset | `wails/assets/`（`//go:embed all:assets` ＋ `BundledAssetFileServer`） | **加一個檔案就等於加一個 URL**，Go 不必改 |
| 宿主能力分界 | `ts/src/accelon26/host.ts`（`desktopHost()` 等） | 網頁版會回 null → 字形功能自動關閉 |
| 設置頁 | `accelon26.template.html` 的 `.setPane`（介面／閱讀／進階／辭典／標籤／繁簡／悉曇） | 新的「字形」開關放這裡 |
| 單檔 HTML 組裝 | `ts/tools/page-build.ts`（`Bun.build` → iife ＋ template 佔位符） | `pinxing` 與模組要進 bundle 就得過這裡 |
| 選取浮動選單 | `bookmarks.ts` 的 `#selMenu`（`[data-sel=…]`） | 「字形」入口掛這裡 |

---

## 2. 目標與非目標

**目標（v1）**
1. 本文區的 **Unicode Extension 漢字**（Ext A–I ＋ 相容區／相容補充）一律以字形庫的 SVG 顯示，
   大小、顏色、基線與旁邊的正文一致；**客戶端有沒有字型都不影響**。
2. 本文區的 **IDS**（`⿰氵㫄` 這種裸 IDS，以及說文系的 `<構形>`）以**當場組出來的 SVG** 顯示。
3. 交付：字形庫是 **exe 的 asset**；`accelon26.html`（file://）**不含字庫**，行為與今天相同（顯示 IDS／原字）。
4. 「找字」：**左欄「字形」分頁**（檢字語法 ＋ 候選格）＋ **字形卡**（大字、部件清單、異體、
   再檢字）；點本文的字形可直接開卡。

**非目標（v1 明確不做）**
- 不在 accelon26 做拼形編輯器（組字 UI 仍是 pinxing.html 的事）。
- 不動 adb 文字與 VA（**顯示層的事，資料不動**）。
- 不改 glyphwiki 工作區對 ADB 的認知（它只知道「有人要 lib.bin ＋ 我要輸出 SVG」）。
- 不改 pinxing.html／glyph-browser.html 的行為（只能「順便」共用抽出來的新模組）。

---

## 3. 架構：三塊，一個接縫

```
┌─ glyphwiki（底層庫，不知道 ADB 的存在）───────────────────────┐
│  tools/lib-format.ts   tools/free-compose.ts   tools/ids-glyph.ts …  │
│  tools/pinxing.ts        ← 新增：**自己的描繪器**（Apache 乾淨，§3.5）│
│  tools/check-pinxing-render.ts  ← 新增：對 GPL 引擎做差分（只在本機跑）      │
│  tools/glyph-api.ts        ← 新增：對外唯一入口（createGlyphCore）   │
│  tools/build-glyph-api.ts  ← 新增：產生 out/glyph-api/（原文＋manifest）│
│  out/lib-cjk-all.bin.gz    ← 既有產物                                 │
└──────────────────────────┬──────────────────────────────────────┘
                           │ 建置期複製（ts/tools/vendor-glyph.ts）
┌──────────────────────────▼──────────────────────────────────────┐
│ accelon26                                                          │
│  ts/src/vendor/glyph/*.ts      ← 生成物（進版控，檔頭寫來源與 sha256）│
│  ts/src/accelon26/glyph.ts     ← 我們寫的 API 層：載入／快取／裝飾     │
│  ts/src/accelon26/glyph-panel.ts ← 字形面板（找字、部件清單）          │
│  wails/assets/glyphwiki.bin.gz ← 建置時複製（gitignore）→ /glyphwiki.bin.gz │
└──────────────────────────────────────────────────────────────────┘
```

**為什麼是「建置期複製」而不是「共用一個資料夾」**：accelon26 的建置必須在沒有
`D:\2023\glyphwiki` 的機器上也能跑（CI／macOS）。沿用 `variant-data.ts` 的先例：
**生成物進版控、生成器留在來源那一邊**，並提供 `--check`（來源有變就失敗）＋
**golden 差分測試**（見 §8）鎖住「兩份其實是同一份」。

**glyphwiki 端要加的 API（草案）**

```ts
// tools/glyph-api.ts
export interface GlyphCore {
  decode(bytes: Uint8Array): void;                 // 4.7 MB → 字形表
  svgOfCp(cp: number): string | null;              // 一個碼位的內嵌 SVG（<svg …>）
  svgOfIds(ids: string): { svg: string | null; problems: string[] };
  svgOfSeq(expr: string): { svg: string | null; problems: string[] };   // 拼形序
  info(cp: number): GlyphInfo;                     // 碼位／異體／部件清單／IDS
  search(raw: string, limit?: number): number[];   // 檢字語法（木+ 木/ 4木日 U+XXXX…）
  componentIndex(): Array<{ cp: number; count: number }>;
  tightOfCp(cp: number): [number, number, number, number] | null;  // 基線／光學校正用
}
export function createGlyphCore(): GlyphCore;
```

**glyphwiki 端要抽出來的模組（唯一實作，兩個宿主共用）**

| 檔案 | 從哪裡抽 | 誰用 |
| --- | --- | --- |
| `tools/glyph-search.ts` | `pinxing-page.js` 的 `parseSearch`／`runSearch`／`searchCps`／`matchesPos`／`strokesOf`／`countInTree`／`buildDeepIndex` | pinxing.html（改呼叫它）、accelon26 的「字形」面板 |
| `tools/glyph-api.ts` | 新寫（薄層：把 `lib` 參數化，收攏 `svgOf`／`idsGlyph`／`evalSeq`／`search`） | accelon26 |

⚠ `pinxing-page.js` 目前把 `LIB` 當全域用；抽模組時改成**參數**或 `setLib()`，
並**重跑 `check-pinxing`**（約 70 條動線）證明 pinxing.html 沒被弄壞。

### 3.5 描繪器 `pinxing`（作者定案：**自己寫**，不引入 GPLv3 的 `kage-engine`）

**好消息**：整個模組層只透過兩個全域跟引擎打交道 —— `new Kage()` 與 `new Polygons()`。
所以只要做一個**同介面的替代品**，`compose-fit.ts`／`free-compose.ts`／`ids-glyph.ts`
一行都不用改（`ensureEngine()` 在瀏覽器端本來就是 no-op）。

**要實作的介面（契約）**

| 東西 | 契約 | 用途 |
| --- | --- | --- |
| `Kage.kBuhin.push(key, kageData)`／`.search(key)` | 字形索引 | 遞迴收集子字形 |
| `Kage.makeGlyph(polygons, key)` | 展開引用 → 攤平筆段 → 產生輪廓 | 唯一的描繪入口 |
| `Polygons.array` | `[{ array: [{x, y, off}] }]`（`off==1` 是二次控制點） | `inkBoxOfPolygons()` 量墨跡、`generateSVG()` |
| `Polygons.generateSVG()` | 回 `<svg viewBox="0 0 200 200">` | 我們**順便輸出精簡版**（合併成一條 path、座標取整、`fill:currentColor`；實測 **3,091 B → 1,603 B**） |

**保真度階梯**（先做 v0，量測不夠再往上）

| 級 | 內容 | 預估 | 判斷依據 |
| --- | --- | --- | --- |
| **v0** | 引用展開（框的仿射映射）＋ kind 1／2／3／4／6／7／9 的**等寬輪廓**（中線偏移、折角修剪、兩端平／圓） | 0.5–1 天 | 1em 內文幾乎看不出差 |
| v1 | 筆寬隨 `width`／`style` 變化、曲線分段更細、接頭處理 | +0.5 天 | 放大到 200 px 面板時的觀感 |
| v2 | 引擎那些「自動調整」（`adjustHane` 筆鋒／`adjustUroko` 鱗／`adjustTate`／`adjustMage`） | +1–2 天 | 只有拿 pinxing 並排比對才看得出來；**建議不做** |

**驗收（能失敗的驗收）**：`tools/check-pinxing-render.ts` 用 **GPL 引擎當仲裁者**（只在本機跑，
不進 accelon26）——
- 全庫抽樣：算我們的輪廓與引擎輪廓的 **IoU**（v0 目標 ≥ 0.75、v1 目標 ≥ 0.90）、
  **召回／精確**（分開看「少畫」與「畫錯」）、墨跡框差（目標 ≤ 4 格）；
- 出並排 PNG（引擎紅／pinxing 藍／重疊白）；
- 這支同時是「以後誰改了 pinxing 就會知道」的回歸鎖。

⚠ **法律上的誠實說明**：實作會**照 KAGE 格式的語意**（筆段型別、`width`／`style`、引用框的仿射映射）
重寫，程式碼自己寫、不抄 `kage-engine/` 的行；但仍會**讀過**那份程式碼來確認語意。
若作者要求更嚴格的 clean-room，這一步要另外安排。

### 3.6 第一輪做完的（2026-11-06）——實測結果

| 項目 | 結果 |
| --- | --- |
| `tools/pinxing.ts` | **自己的描繪器**：KAGE 解析、引用展開（框的仿射＋`stretch`）、中線取樣、寬度剖面、端點形狀、**風格表** |
| 筆劃風格層 | `STYLES`：`songti`（預設）／`heiti`（等粗方頭）／**`yuanti`（圓體，引擎沒有）**／`xiti`；想加新風格＝多一張表 |
| 接縫 | `installLitePinxing()` 只換掉全域 `Kage`／`Polygons` —— **`compose-fit`／`free-compose`／`ids-glyph` 一行都沒改** |
| 管線實測 | `svgOf(邏)` 8.9 KB／3 ms；`idsGlyph("⿰氵㫄")` ok；`evalSeq("寶缶支")` ok |
| 保真度（308 字抽樣） | IoU 中位 **0.755**、召回 0.819、精確 0.900、墨跡框差 ≤4 格 64.6% |
| 速度／體積 | **0.057 ms/字（17,616 字/秒）**、**999 B/字**（引擎：0.105 ms、2,928 B／字） |
| 對照圖 | `out/pinxing-songti.png`、`out/pinxing-yuanti.png`（三聯：引擎紅／pinxing 藍／重疊白） |

**差在哪（v1 要追的，都已定位）**：① 捺的「掃」（引擎的 harai 會在末梢拉出一段橫墨）
② 折角方塊（收筆代碼 13／23）③ 起筆的小楔（代碼 0／12）④ 鱗（`adjustUroko`）。
這四樣都是引擎的**自動裝飾**，在本文 1em 幾乎看不見，但 200 px 面板看得出來。

⚠ 環境（**2026-11-06 稍晚更正**）：我先前寫「本機 Edge headless 完全跑不起來（連 `--version`
都沒輸出）」——**那是錯的**。真因是**直接從 PowerShell `&` 呼叫時它不留下任何輸出**；
改用 `Bun.spawn`（或 `Start-Process`）帶 `--user-data-dir` 就正常。
現在有一支**在真的 Chromium 裡量**的工具（見 §3.10），並排圖仍由 `node:zlib` 直接寫 PNG
（那條路沒有錯，只是不再是唯一的一條）。

**命名**（作者 2026-11-06）：「庫名 kage-lite 改為 pinxing，shotai maru 等日文拼音……
都改為普通話吧。」
→ 模組與檔案叫 **`pinxing`**（拼形）；風格代號一律**普通話拼音**
`songti`（宋體，預設）／`heiti`（黑體）／`yuanti`（圓體）／`xiti`（細體），程式裡也帶中文 `label`。
唯一留下的上游名是 `kBuhin`（部品）—— 那是引擎的介面，共用的模組呼叫它，不能單方面改
（我們的別名是 `parts`）。

### 3.7 為**本文**與**自由組字**優化（作者 2026-11-06 的方向）

> 作者原話：「kage 和 glyphwiki 是**沒有針對自由組字優化**的，但我們有。keep this in mind，
> 你一定可以做的比 kage 好。」

**所以驗收標準換了**：不以「像不像 kage」為目標（`check-pinxing-render.ts` 的 IoU 只當**回歸鎖**），
改為量**我們真正的使用情境**——本文 1em 的可讀性與組字後的一致性。

**量到的第一件事（kage 在本文確實不行）**：KAGE 的橫筆只有 **2% em**（200 分格裡的 4 格），
在 **16 px 的正文**裡是 **0.32 px** 的灰線：

| 16 px 實測 | 引擎 | pinxing（不套尺寸） |
| --- | ---: | ---: |
| `一` 的墨有幾成是灰的（α<0.38） | 88% | 100% |
| `一` 的峰值不透明度 | 0.38 | 0.25 |
| `三` 的覆蓋率 | 4.5% | 3.5% |
| 全部樣本平均：覆蓋／灰墨 | 15.4%／48% | 14.7%／50% |

這就是「字在經文裡看起來缺筆」的量化版本——**在 200 px 的字形面板完全看不出來**，
所以 kage 從來沒有為這件事優化過。

**對策：讓描繪器知道「這一格字會被畫成幾個像素」。**

```ts
const k = new LitePinxing("songti");
k.emPx = 16;            // 本文實際字級（0 ＝ 不知道，不套用）
k.minStrokePx = 0.9;    // 最細的筆至少 0.9 px（預設）
```

`style()` 會把「至少 0.9 px」換算成 200 分格裡的半寬，再與風格原本的橫／豎粗取大值；
而且**筆畫越多、下限越低**（>24 筆 × 0.6、>12 筆 × 0.8、其餘 × 1.0）——
16 px 的 `邏`／`寶` 若也拉到 0.9 px 會糊成一團（實測墨量 +59%）。

**結果（同一批樣本、16 px）**：

| | 引擎 | pinxing＋尺寸感知 |
| --- | ---: | ---: |
| 平均覆蓋率 | 15.4% | **19.3%** |
| 平均灰墨比例 | 48% | **28%** |
| `十` 的灰墨 | 33% | **0%** |
| `口` 的灰墨 | 48% | **31%** |
| `寶缶支` 的灰墨 | 45% | **22%** |

**驗收工具**：`tools/check-pinxing-text.ts`（`--em`／`--min-px`／`--style`／`--png`）——
每個樣本畫出「引擎／pinxing 不套尺寸／pinxing 套本文尺寸」三欄，**16 px 的實際像素放大 8 倍**，
可以直接目視；樣本除了單字，還包含**自由組字的結果**（`寶缶支`、`峰夆電雨水`、`街圭舞`、`報土业`）。

**這件事對 v1 的影響**：原本列為「v1 要追」的四樣（捺的掃、折角方塊、起筆楔、鱗）
**降級為可選**——它們在 1em 幾乎不可見，而且有些（鱗、折角）在 16 px 反而是雜點。
真正該追的是：**組字後的一致性**（部件縮到 30% 還在不在、墨量有沒有跳、空隙有沒有糊掉）。

### 3.8 v1 保真度：第一輪（2026-11-06，作者回報「芒的最後一筆太彎了」之後）

作者原話：「我們的『芒』字有點怪。最後一筆太彎了。**保真度往 v1 追**。」

**根因（不是筆形，是幾何）**：`亡` 的 `乚` 是 `3:12:0:38:56:38:174:173:174`（kind 3）——
中間那一點是**轉角**，不是控制點。我把它當二次 Bezier 的控制點，整條筆畫就沿對角鼓出去
（實測離弦 45 格）。上游的做法是「離轉角 `kMage`（10 格）處切斷、中間那一小段才走二次曲線」。

**這一輪做了四件事**：

| # | 內容 | 效果 |
| --- | --- | --- |
| 1 | **折れ（kind 3／4）改成「直線＋圓角轉彎＋直線」** | 芒／亡／忙／龍的 `乚` 不再鼓出去；全庫 IoU 最小 0.499 → 0.631 |
| 2 | **筆壓跟著走勢**（kind 1／3／4／7／12）：橫向路段用橫的半寬、豎向用豎的半寬 | `亡` 的 `乚` 橫段變細，與 `豎粗橫細` 一致；召回 +1.2% |
| 3 | **鉤／跳（收筆代碼 4／5）**：豎鉤往左、橫跳往上，長度 ＝ `kMage` | `也`／`九`／`龍` 的字尾有鉤了 |
| 4 | **鱗（uroko）**：橫筆收筆的小三角（照上游 24×12）；**只在 ≥20 px 才畫** | IoU 中位 0.765 → **0.779**，`IoU≥0.90` 從 7 個變 15 個 |

**量測演進（308 字抽樣，對上游引擎）**

| 階段 | IoU 中位 | p10 | 最小 | 召回 | 墨量比 |
| --- | ---: | ---: | ---: | ---: | ---: |
| v0（第一版） | 0.755 | 0.650 | 0.499 | 0.819 | 0.908 |
| ＋折れ圓角 | 0.760 | 0.682 | 0.607 | 0.824 | 0.910 |
| ＋筆壓跟走勢 | 0.765 | 0.687 | 0.620 | 0.836 | 0.936 |
| ＋鉤＋鱗 | **0.779** | **0.700** | **0.631** | **0.862** | **0.964** |

**還沒做（按可見度排）**：① 捺的掃（`麥` 那類斜筆的尾端散開）② 折角方塊（`亡` 右下角）
③ 起筆楔（橫筆起頭的小塊）④ 逐段寬度（引擎對 `7`／`12` 的每一段用不同的寬度碼）。

**驗收**：`check-pinxing-render.ts`（IoU／召回／精確／並排圖）不退步；
`check-pinxing-text.ts` 的 16 px 數字不變（裝飾在 20 px 以下自動關掉，所以正文不受影響）。

### 3.9 小字優化：**裝置像素**與「對齊像素格」（作者 2026-11-06 第二輪）

> 作者原話：「我們主要不是印刷用，是**手機上看**。通常是小字，小字的優化是重要的，
> 你不一定要輸出 SVG 呀，如果 **PNG ClearType** 更好的話。」

**先量清楚：問題在 dpr 1，不在手機。** 把「看不看得見」改用**裝置像素**算
（`emPx × dpr`），同一批樣本、同一支工具（`--dpr`）：

| dpr（裝置像素／CSS px） | 引擎 灰墨／峰值 | pinxing（只有最小筆寬） |
| ---: | ---: | ---: |
| 1（桌機 16 px） | 48%／0.85 | 15%／**1.00** |
| 2（手機 16 CSS px＝32 裝置 px） | 27%／1.00 | 12%／**1.00** |
| 3 | 22%／1.00 | 10%／**1.00** |

也就是說：KAGE 的橫筆在 dpr 1 是 **0.32 裝置 px**（灰線），在 dpr 2 是 0.64、dpr 3 是 0.96——
**手機上本來就接近一個實心像素**。真正該做的是把「最細筆」的下限改成**裝置像素**（預設 1.0）。

**然後做對齊（＝hinting）**：一條 1 裝置 px 寬的橫筆若落在像素邊界上，會被拆成兩列各 75% 的灰。
把**軸對齊筆畫的上下緣對到裝置像素格**（`RenderOptions.grid`，只動垂直於筆畫的那一軸，筆形原樣保留），
三種 dpr 的灰墨都再降一個檔：48%→**15%**、27%→**12%**、22%→**10%**，
而且**峰值不透明度全部變成 1.00**（每一筆都是實心的）。

**要不要改用 PNG（ClearType）？—— 不建議，理由有三條**：

1. **ClearType 是次像素（RGB 條紋）反鋸齒**：預先烤進 PNG 之後，一縮放、一旋轉、
   一換到非 RGB 條紋的螢幕（手機多半是 PenTile／OLED 的各種排列）就會出現彩邊。
   這也是 Chrome／Safari 早就把次像素文字關掉的原因。
2. **PNG 是定色的**：它跟不上主題色／塗紅／選取反白；要跟就得用 `mask-image` 再包一層，
   等於把「一個 `<svg>` 疊一個透明字」換成「一張遮罩圖」，複雜度更高。
3. **真正讓小字變清楚的是 grid-fitting，不是 PNG**：上面那張表的每一欄都是**向量座標**
   對齊裝置格之後的結果 —— 放大、列印、換 DPR 都還是乾淨的，PNG 只有一個尺寸好看。

**所以：維持 SVG，把小字優化做在幾何上**（`emPx` ＋ `dpr` ＋ `minStrokePx` ＋ `grid`）。
若日後真的需要「極小字專用 bitmap」（例如 8–10 px 的密集排版），再考慮 PNG 遮罩，
但那會是**選項**，不是預設。


### 3.11 「招財進寶」最小幾 px 看得清？（2026-11-06 第三輪）

> 作者原話：「招財進寶最少幾 px 才看得清，和 kage 比比看我們有沒有比較好。」

工具 `tools/show-grail.ts`（dpr 2、8→32 px、每級放大 4 倍）。量三件事：**峰值不透明度**
（每一筆實不實心）、**洞數**（被封住的空白區，≥4 裝置 px；部件還分不分得出來的代理指標）、
**最小間隙**（p10）。

| px | kage 峰值／洞 | pinxing 峰值／洞 |
| ---: | --- | --- |
| 8 | **0.89（有灰筆）**／0 | **1.00**／1 |
| 10 | 0.96／1 | 1.00／1 |
| 12 | 1.00／3 | 1.00／2 |
| 16 | 1.00／5 | 1.00／**12** |
| 20 | 1.00／9 | 1.00／**12** |
| 24 | 1.00／18 | 1.00／14 |
| 28 | 1.00／**21** | 1.00／**25** |
| 32 | 1.00／21 | 1.00／23 |

**判準**：峰值 ≥ 0.95 且 洞數 ≥ 21（＝ kage 在 200 px 的洞數，當**共同的物理基準**；
各自跟自己的大圖比會失真，見下面「兩個教訓」）。

- **最小可辨識字級：兩者都是 28 px。** 這個字 40 幾筆塞進一格，本來就不是正文尺寸能讀的。
- **但 8–20 px 是我們贏**：8 px 時 kage 已經有灰筆（0.89），我們還是實心（1.00）；
  16 px 時我們保留 **12** 個結構洞、kage 只剩 **5** —— 縮小的時候我們糊得比較慢。
- 24 px 之後 kage 追上來（它的折角方塊／粗橫在大尺寸才顯得出結構）。

**兩個教訓（都寫進工具了）**：

1. **「洞數」不能各自跟自己的大圖比**。我們 200 px 的洞是 39、kage 是 21 —— 因為我們的筆畫
   邊緣位置差半格，有些「幾乎封住」的角落就變成洞。若拿自己的 39 當基準，門檻永遠達不到，
   會得到「pinxing 在本測試範圍內都不合格」這種荒謬結論。
2. **我上一輪說「我們的接頭有縫、是折角方塊造成的」——講得太早了。** 200 px 的疊圖顯示
   差異是**邊緣級的**（kage 有我們沒有的墨 5.5%、我們多的 5.8%，沿著每一條筆畫的邊緣成細條），
   **不是結構缺口**。折角方塊那件事仍然沒做，但它不是這個數字的原因。
3. 順手試了「每一筆脹開（bleed）0.35 分格」：200 px 的針孔 11 → 2 個，但墨量超過上游 5%、
   IoU 反而掉 0.015 —— **預設關掉**，留成參數。

**驗收**：`tools/check-pinxing-text.ts --dpr 1|2|3 --png`（三欄並排、實際像素放大），
`check-pinxing-render.ts` 的 IoU 不變（0.779）。

### 3.10 **在真的 Chromium 裡量**（2026-11-06 第二輪：`check-pinxing-browser.ts`）

上面所有數字都出自**我們自己的柵格器**（4× 超取樣）。它證明幾何對了，但不能證明
Chrome／WebView2 畫出來一樣。這一支把同一批 SVG 丟進 headless Chromium：
`<img src="data:image/svg+xml,…">` → `canvas.drawImage(img, 0, 0, PX, PX)` → `getImageData()`，
量的是**瀏覽器真的產生的像素**。

| 樣本平均（11 個，含 `寶缶支`／`峰夆電雨水`／`街圭舞`） | 引擎 灰墨／峰值 | pinxing 不套尺寸 | pinxing 套尺寸 |
| --- | ---: | ---: | ---: |
| **dpr 1**（16 裝置 px） | 62%／0.81 | 60%／0.82 | **30%／1.00** |
| **dpr 2**（32 裝置 px，手機） | 36%／1.00 | 32%／0.98 | **17%／1.00** |

結論與離線量測一致（方向、幅度都對得上），所以「對齊裝置像素格」這件事在**真瀏覽器**上成立：
每一筆的峰值不透明度都是 **1.00**（不再有灰線），灰墨比例 dpr 1 從 62% 降到 30%、dpr 2 從 36% 降到 17%。

⚠ 這支工具的兩個坑（已寫進檔頭）：
1. **`Bun.spawn` + 等 `DevToolsActivePort`** 才叫得動 Edge；直接 `&` 呼叫沒有任何輸出。
2. **一定要 `process.exit(0)` 收尾**，而且收瀏覽器要 `taskkill /T`（只 kill 主行程會留 30 個子行程，
   工具會「跑完卻不退出」——我第一次就留了 30 個 msedge 在背景）。




---


### 3.12 搬進 accelon26：`ts/src/vendor/glyph/`（2026-11-06 第四輪）

**做法**（沿用 `variant-data.ts` 的先例：生成物進版控、生成器留在本區）：

```
D:\2023\glyphwiki\tools\lib-format.ts   （字庫解碼／查詢，零 import）
D:\2023\glyphwiki\tools\pinxing.ts      （拼形描繪器）
        │  ts/tools/vendor-glyph.ts
        │  （三條機械改寫：拿掉 node: 開頭的 import、拿掉 import.meta.main 之後的 CLI 段、拿掉 shebang）
        ▼
ts/src/vendor/glyph/{lib-format.ts,pinxing.ts}   ← 進版控，檔頭寫來源 sha256／位元組數
```

**為什麼只搬兩支**：第一階段（本文的 Ext 字 → SVG）只需要「解碼 ＋ 畫」。
IDS→字形要 `ids-glyph`／`free-compose`／`compose-fit`（含 `node:fs` 與 CLI 段），第二階段再一起處理。

**三條護欄**：
1. `bun run tools/vendor-glyph.ts --check`：來源一改就 exit 1。
2. `bun run test/glyph-vendor.test.ts`：**160 筆 SVG 指紋**（40 字 × 4 情境：面板／16-dpr1／16-dpr2／24-dpr2）
   與 glyphwiki 產生的 golden 逐筆比對；另驗字庫 sha256 與 lazy≡全解（2,019 字）。
   golden 由 `glyphwiki/tools/make-glyph-golden.ts` 產生 → `ts/test/golden/glyph-golden.json`（進版控）。
3. 沒有字庫檔時測試**跳過**（exit 0）—— CI／macOS 沒有 `D:\2023\glyphwiki` 也要能綠。

**實測**：`bun build --target browser` 打包 **30.5 KB**（只含用到的部分）；
跑起來 芒 @16px dpr2 → SVG 534 B，指紋與 golden 相同。

⚠ `.gitignore` 原本把 `ts/src/vendor/*` 全排除，已補 `!ts/src/vendor/glyph/**`
（否則生成物進不了版控，CI 就建不出字形功能）。

**還沒做**：`wails/assets/glyphwiki.bin.gz` 的建置期複製、前端 `glyph.ts`（fetch＋解碼＋快取）、
本文的 `.gw` 疊層、設置開關。

---

### 3.13 接進閱讀器：本文的 Ext 字改成 SVG（2026-11-06 第五輪）

**完成的部分**（P1 的第一步）：

| 檔案 | 內容 |
| --- | --- |
| `ts/src/accelon26/glyph.ts`（新） | 載字庫（`fetch('glyphwiki.bin.gz')` → `inflateRaw` → `decodeLibraryLazy`）、`glyphSvgOf(cp, emPx, dpr)`（LRU 4000）、`decorateGlyphs(root)`、`upgradeDocGlyphs()` |
| `ts/src/accelon26/doc-pane.ts` | 本文畫完之後（`setupEndFooter` 後）呼叫 `upgradeDocGlyphs()`；新增 `glyphsEnabled()`／`setGlyphsEnabled()`（`localStorage['accelon26.glyphs']`） |
| `ts/src/accelon26/ui.ts` ＋ template | 設置 → 介面 → **「罕用字改用字形庫」** 開關（預設開）；關掉會重畫本文 |
| `accelon26.template.html` | `.gw`／`.gwT`／`.gwG` 三條 CSS（見 §5.2） |
| `ts/tools/vendor-pinxing.ts` | 把 `PINXING_DIR`（預設 `D:/2026/pinxing`）的 `src/*.ts` 與 `lib/lib-cjk-all.bin.gz` 複製成 `ts/src/vendor/pinxing/*.ts` 與 `wails/assets/pinxing.bin.gz`（2.22 MB）。**來源碼進版控；`.bin.gz` 不進版控**（作者 2026-11-06 指示） |
| `ts/tools/glyph-browser-test.ts`（新） | **真瀏覽器端對端驗收**（11 項，見下） |

**驗收（`bun run tools/glyph-browser-test.ts`，headless Chromium，13j.adb）**：

```
✓ 頁面 boot 完成        ✓ adb 開啟成功        ✓ 搜尋「𣏌」有結果
✓ 點下命中（載入本文）  ✓ 本文出現 .gw        ✓ 每個 .gw 都有 svg.gwG
✓ 原字留在 .gwT          ✓ 整行 textContent 仍含原字
✓ 同一行：加了字形沒有撐高行距（開／關互比）
✓ 塗紅標記仍在           ✓ 設定關掉後 .gw 歸零
11 項通過、0 項失敗
```

⚠ **量行距要「同一行開／關互比」**：第一版拿「有 `.gw` 的行」跟「沒有的行」比，得到
「51.2px vs 21.3px」——那是**不同的行**（有字形的剛好是長句、本來就折成兩行），不是撐高。
改成同一行關掉再量，差 ≤ 1px。

**還沒做**：`glyph.ts` 目前只換 Ext 漢字；IDS（`<構形>`／裸 IDS）要第二階段的
`ids-glyph`／`free-compose`／`compose-fit`。另外還沒在**桌面 exe** 上實測（本輪驗的是
http 版的同一份 HTML，`fetch('/glyphwiki.bin.gz')` 的路徑兩邊相同）。

---

### 3.14 桌面 exe 實測（2026-11-06 第六輪）

上一輪只在 http 版的同一份 HTML 上驗；這一輪**真的建了 exe**（`cd wails && go build`，
20.59 MB，比原來的 19.2 MB 多 1.4 MB）並在 WebView2 裡量：

```
✓ exe 的頁面 boot 完成
✓ fetch("glyphwiki.bin.gz") 成功         （200、2,327,989 bytes）
✓ 是 gzip（魔數 1f 8b）
✓ 從資料夾清單開啟 adb 並出現本文
✓ 本文出現 .gw                          （㕮 U+356E、䐜 U+441C … 都在轉）
✓ 每個 .gw 都有 svg.gwG
✓ 每個 .gwT 都還是原字（Ext 範圍的單一碼位）
✓ 設定關掉後 .gw 歸零
8 項通過、0 項失敗
```

⇒ **asset 由 `BundledAssetFileServer` 送得出去，WebView2 的 `fetch` 也拿得到**，
`decodeLibraryLazy` ＋ `pinxing` 在 WebView2 裡跑得起來。這是 P1 的核心風險，已經排除。

工具：`ts/tools/glyph-desktop-test.ts`（`--exe`／`--char`／`--png`；跑完一律 `taskkill /T` 收掉 exe）。

⚠ 兩個測試上的教訓（都寫進工具註解）：
1. **不要假設「開庫第一頁有 Ext 字」**：`13j` 有，但資料夾清單第一個常常是別的庫。
   所以 assertion 改成「本文出現 `.gw`」＋「每個 `.gwT` 都是 Ext 範圍的單一碼位」，
   不再指定某一個字。
2. 搜尋跳頁那一步只是**輔助**（第一頁就有 Ext 字時不必搜）；把它當成必要條件會讓測試
   因為「搜不到那個字」而假失敗。

---

### 3.15 搬家：描繪器獨立成 `D:\2026\pinxing`（2026-11-06 第七輪）

作者原話：「把所有這幾輪的成果，搬到 https://github.com/accelon/pinxing，字形庫還是先用
`d:\2023\glyphwiki`，但 accelon26 這邊只知 pinxing，不知 glyphwiki 了。」

**動的方向變了**：

```
以前： accelon26 ──複製──▶ D:\2023\glyphwiki\tools\{pinxing,lib-format}.ts
現在： accelon26 ──複製──▶ D:\2026\pinxing\src\{pinxing,lib-format}.ts  ＋ lib/lib-cjk-all.bin.gz
                                    ▲
                                    └── tools/fetch-lib.ts ──▶ D:\2023\glyphwiki\out\（暫時）
```

| 位置 | 角色 |
| --- | --- |
| `D:\2026\pinxing`（新 repo） | **描繪器 ＋ 解碼器 ＋ 字庫**的家；Apache-2.0；`bun run smoke` 自己就能驗（不需要 GPL、不需要網路） |
| `D:\2023\glyphwiki` | **字庫的產地**（KAGE 資料、GPL 引擎）；`tools/pinxing.ts` **已刪**，五支驗收工具改成 `PINXING_DIR`（預設 `D:/2026/pinxing`）動態 import —— **筆形只有一份** |
| `D:\2026\adb-converter` | 消費者：`ts/tools/vendor-pinxing.ts` 複製到 `ts/src/vendor/pinxing/` ＋ `wails/assets/pinxing.bin.gz` |

**改名對照**：

| 前 | 後 |
| --- | --- |
| `ts/tools/vendor-glyph.ts` | `ts/tools/vendor-pinxing.ts`（`PINXING_DIR`） |
| `ts/src/vendor/glyph/` | `ts/src/vendor/pinxing/` |
| `wails/assets/glyphwiki.bin.gz` | `wails/assets/pinxing.bin.gz` |
| `ts/test/glyph-vendor.test.ts` | `ts/test/pinxing-vendor.test.ts` |
| `ts/test/golden/glyph-golden.json` | `ts/test/golden/pinxing-golden.json`（由 pinxing 的 `tools/make-golden.ts` 產生） |

**pinxing repo 的內容**：`src/pinxing.ts`、`src/lib-format.ts`、`lib/lib-cjk-all.bin.gz`（2.2 MB，進版控）、
`tools/{fetch-lib,make-golden,smoke}.ts`、`test/golden.json`（160 筆指紋）、`README.md`、`AGENTS.md`、
`package.json`。第一個 commit：`c5c4487`。

**驗收（搬家後全部重跑）**：

```
pinxing 自己        bun run smoke                    9/9（解碼、字庫指紋、160 筆 SVG、四種風格）
accelon26 vendor   bun run tools/vendor-pinxing.ts --check   ✓ 同步
accelon26 golden   bun run test/pinxing-vendor.test.ts      5/5
http 版            bun run tools/glyph-browser-test.ts     11/11
exe（WebView2）    bun run tools/glyph-desktop-test.ts      8/8（重建 exe 後）
上游仲裁           check-pinxing-render / -text 仍可跑（走 PINXING_DIR）
```

⚠ 搬家時踩到一個小坑：用腳本把 `const { … } = await import("…")` 改成
`const { … } = // 註解` 再換行 —— 語法直接壞掉。**改 import 語句要用 `edit` 工具整段換**，
不要用字串取代在中間插東西。

---

## 4. 交付字形庫（exe asset）

| 項目 | 決定 |
| --- | --- |
| 檔案 | `wails/assets/glyphwiki.bin.gz`（建置時從 `D:\2023\glyphwiki\out\` 複製；**gitignore**） |
| 取得 | 前端 `fetch('/glyphwiki.bin.gz')`（`BundledAssetFileServer` 直接送，**Go 不必改一行**） |
| 解壓 | 看魔數 `1F 8B`：是 gzip 就跳過 10 byte 頭、用**既有的** `ts/src/inflate.ts` 的 `inflateRaw()`（`posmap.ts`／`vault-import.ts` 已在用，不必假設 `DecompressionStream` 存在）；不是就當原始位元組 |
| 何時載入 | **lazy**：第一次真的需要畫字形時才載（不是開機） |
| 網頁版 | `location.protocol === 'file:'` 或 fetch 失敗 → 功能關閉，行為與今天相同 |
| exe 增量 | 19.2 MB → **20.59 MB**（+1.4 MB，實測） |

> 為什麼不用 Wails binding：`[]byte` 走 JSON 會膨脹（pinxing-app 已實測並否決，見其 README §6）。
>
> 為什麼不內嵌進 HTML：作者定案。附帶好處是 html 版完全沒有這條路徑的風險。

---

## 5. 渲染策略：**保留文字，疊上 SVG**（本文的核心決定）

### 5.1 為什麼不能把字換掉

accelon26 的**所有座標**都掛在「文字」上：`#N`＝第 N 個漢字、選取區還原、
塗紅 `markRange()`、引用複製、`textContent` 前 120 字比對。

實測（`paint.ts`）：塗紅是對 **text node** 做 `Range.surroundContents()`；
一旦把漢字換成 `<svg>`，那顆字就從文字流消失 → 第 N 個漢字會**全部往前挪一位**，
`13j`／`taisho` 的引文、書籤、閱讀狀態全部指錯位置。

> 既有的悉曇 PUA 替換（`<span class="sdSeq">序列</span>`）之所以沒出事，是因為
> PUA／悉曇字**不是漢字**，不計入漢字序號；Ext 漢字**是**漢字，不能照抄那條路。

### 5.2 做法：佔位字（透明）＋ 絕對定位的 SVG

```html
<span class="gw" data-cp="29028">        <!-- inline-block，1em × 1em -->
  <span class="gwT">𩀨</span>             <!-- 原字：透明，但仍在文字流裡 -->
  <svg class="gc-inline gwG" …>…</svg>   <!-- 疊上去的字形（指針事件穿透） -->
</span>
```

````css
.lineText .gw  { display:inline-block; position:relative; width:1em; height:1em;
                vertical-align:-0.22em; }        /* -0.22em：free-compose.ts 實測值 */
.lineText .gwT { color:transparent; -webkit-text-fill-color:transparent; }
.lineText .gwG { position:absolute; inset:0; width:1em; height:1em;
                fill:currentColor; pointer-events:none; }
````

得到的好處：**複製、選取、塗紅、`#N` 定位、無障礙朗讀全部不變**（文字還在）。

### 5.3 IDS 怎麼辦

IDS 是**多字元**（`⿰氵㫄` 三個 code point，但在 adb 裡**只算 1 個 VA**，見
`adb-knowhow.md` §3）。做法與單字相同：那幾個字元一起放在 `.gwT` 裡（透明、可複製），
外面套一個 1em 的框，裡面放組出來的 SVG。文字內容仍是 IDS 原文 ——
**複製出去是 `⿰氵㫄`，不是憑空造的字**，這是對的。

### 5.4 在哪裡裝飾（**不改渲染器**）

在**渲染完成之後**做一次 DOM 後處理（`decorateGlyphs(root)`）：
掃 `#docText .lineText` 的 text node，把「Ext 漢字」與「IDS 字串」包成 `.gw`。

為什麼放後處理，而不是改 `render_accelon3.ts`：
- 渲染器是**同步純函式**，而字庫是非同步載入的；後處理天然解耦（字庫沒好就先不裝飾，好了再補）。
- 不影響摘要／詞典／導出的既有 HTML 輸出（也就沒有既有測試的期望值要改）。
- 只有本文區要（作者指定）；其他面板日後要，再呼叫同一支即可。

---

## 6. 對 UI 的衝擊（逐項，含實測）

### 6.1 不會壞的（因為保留了文字）

| 項目 | 為什麼沒事 |
| --- | --- |
| 選取／複製／引用複製 | 文字仍在 DOM；`range.toString()` 照舊 |
| 書籤、閱讀狀態、`#N` 字元位置 | 漢字序號不變 |
| 塗紅 `markRange()` | 它**按 text node 切段**再 `surroundContents`，每段都在同一顆 text node 內 → 即使那顆字被 `.gwT` 包住也不會拋例外 |
| 捲動同步／VA→元素 | 用 `.docLine` 列，不看字元 |
| 導出（`wails/export.go`） | 直接讀 adb 文字，與 DOM 無關 |

### 6.2 要注意的（要在實作時逐一驗）

| # | 項目 | 影響 | 處置 |
| --- | --- | --- | --- |
| 1 | **行高** | 1em 的 inline-block 可能把行撐高 → 有字形的行列距不一致 | `-0.22em` 的基線實測已含此情況；驗收要看「有／無字形的相鄰行 lineTop 差 ≤ 1px」 |
| 2 | **字重不一致** | 字形庫是明朝／均勻筆形，正文是 `JhengHei`（黑體）；罕用字會看起來偏細或偏粗 | v1 寫死 100%，把 `--gw-weight` 變數留好；設置滑桿排後面（作者：可以慢點）。機制＝`kMinWidthY/T/W` 一起乘（pinxing 的 `WSCALE`） |
| 3 | **字面大小** | KAGE 的墨跡常吃滿 200 方格，可能比系統字略大 | 同上，`--gw-size` 變數，預設 100% |
| 4 | **塗紅的著色** | `.gwT` 是 `color:transparent`，`<mark>` 的色相不會傳到 SVG（背景色會） | 背景照塗；必要時用 `.gw:has(mark)` 把 `--hue` 傳給 SVG（Chromium 105+ 有 `:has`） |
| 5 | **選取高亮** | 選取反白不會反映在 SVG 上（SVG 疊在上層） | 接受（與圖版 SVG 一致）；文件記錄 |
| 6 | **hover 放大** | 既有 `svg.inlineSvg:hover` 會把字放大到 1.5em，**會推版面** | 字形**不做** hover 放大；改為 hover 顯示 `title="U+29028"`，點擊開「字形」面板 |
| 7 | **楷體標題** | 標籤樣式指定楷體時，Ext 字仍是字形庫的明朝體 | 文件說明；不另做（要一致就把「字形庫字型」做成整段套用，屬 P2） |
| 8 | **無障礙** | 透明文字＋SVG 可能被朗讀兩次 | SVG 加 `aria-hidden="true" focusable="false"` |
| 9 | **列印** | SVG 向量，比點陣好 | 不需處理 |
| 10 | **深色主題** | `fill:currentColor`，跟著字色 | 不需處理（沿用 `INLINE_CSS` 的結論） |
| 11 | **`<構形>` 的排版** | 說文是「字頭｜構形」兩欄，構形換成 1em 方塊後**欄寬會變窄**（原本 3 個全形字） | 驗收要看 swjzz 的 `<字>` 列；必要時給 `.gw` 加 `margin:0 .05em` |
| 12 | **CSS 破版風險** | `.gw` 是 inline-block，遇到 `text-align:justify` / 表格格內 | 驗收跑 swjzz（表格多）與 13j |

### 6.3 效能預算（實測數字）

| 量測 | 數字 | 來源 |
| --- | --- | --- |
| 字庫解碼（全解） | **220–286 ms** | 本輪 bun 實測 |
| 解碼後記憶體 | heap **+117 MB**、**RSS +272 MB** | 同上（見 §6.4） |
| 只建位移表＋家族＋框字典 | **9.5 ms**（掃 4.70 MB）、RSS +36 MB | 同上（lazy 版原型） |
| 之後每解一個字形 | **0.14 µs**、約 **0.66 KB** | 同上 |
| 一個字形 → SVG | 平均 **0.28 ms**、3,091 B（最差 15 KB） | 同上（191,727 字形抽樣） |
| 併成一條 path ＋座標取整 | **1,603 B（52%）**、最差 7.5 KB | 同上（`<path d>` 合併、`fill="black"` 只寫一次） |
| 完整外框生成 | 14,094 字/秒 | glyphwiki 既有量測 |

**每頁要畫幾個字**（依 `<頁>`；沒有 `<頁>` 的庫用 400 行視窗）：

| 庫 | 單位 | p50 | p95 | max |
| --- | --- | ---: | ---: | ---: |
| `taisho` | 頁 | 0 | 2 | 418 |
| `goryeo` | 頁 | 0 | 1 | 47 |
| `13j` | 頁 | 0 | 3 | 7 |
| `jc` | 400 行 | 2 | 19 | 733 |
| `swjzz`（說文） | 400 行 | 126 | 226 | 298 |
| `kangxi` | 400 行 | 275 | 353 | 405 |
| `hydzd`（漢語大字典） | 400 行 | 31 | 297 | **3,270** |

**結論與對策**
- 經文類（taisho／goryeo／13j／ys…）：**幾乎無感**（p95 ≤ 3）。
- 字典類：組字速度不是問題（0.28 ms/字，700 個＝0.2 秒）；`hydzd` 那種 3,270 個是**極端例子**
  （作者 2026-11-06：「hydzd 是極端例子，組字速度夠快了」）。所以 v1 **不做** sprite／分批補畫，
  只留一條保險：單頁超過 1,000 個時分兩批（`requestIdleCallback`），超過 3,000 個才退回原字並記一筆警告。
  真的卡了再加 `<use>` sprite（重複字約 50 B）。

### 6.4 為什麼記憶體是 +117 MB（實測拆解）—— ✅ 已解掉（2026-11-06）

| 量測（本輪 bun 實測） | 數字 |
| --- | --- |
| 字庫檔案 | 4,703,188 B（`.bin`）／2,327,989 B（`.gz`） |
| 字形數 | 191,727（筆段 **391,155**、其中引用 **298,229**、單字形最多 33 段） |
| 完整解碼 | heap **+93 MB**、RSS **+276 MB**、**212 ms** |
| **lazy 解碼**（已實作） | heap **+24 MB**、RSS **+66 MB**、**42 ms** |
| 平均每個字形 | 約 0.66 KB（0.66 KB × 191,727 ≈ 126 MB） |
| 只建位移表（`Uint32Array`）＋家族＋框字典 | **9.5 ms** |
| 之後現解一個字形 | **0.14 µs** |

**來源**：4.7 MB 的 varint 位元流被攤成 **191,727 個字形物件 ＋ 391,155 個筆段物件 ＋
92,926 個 8 個數字的座標陣列 ＋ 298,229 個 `stretch` 陣列**，再加 98,701 筆家族表、
97,079 筆 IDS 部件表。每個 JS 物件／陣列都比二進位表示貴 10 倍以上 ——
**不是字庫變大，是「全部先攤成物件」變貴。**

**已完成的做法（`decodeLibraryLazy()`，格式零改動）**：
1. 掃一遍位元流，記下每個字形的位移（`Uint32Array`，0.77 MB，**9.5 ms**）。
2. `lib.glyphs[i]` 回一個**樁**（`strokes`／`tight` 是 prototype 上的 getter，第一次讀才解、解完快取）。
   `forkLibrary()` 的 `glyphs.slice()` 仍然成立（複製的是樁），**模組一層都不用改**。
3. `families`／`comp`／`syn`／`phil` 保持全解（查詢與檢字要用，量也小）。
4. 需要攤平時 `materialize(lib)`；`loadLibrary(path, { lazy: true })` 或 `GW_LIB_LAZY=1` 切換。
5. 護欄：`tools/check-lib-lazy.ts` **全庫 191,727 字**逐字比對 `toKageData` 與緊框（0 不一致）；
   `GW_LIB_LAZY=1` 重跑 `free-compose-test`／`check-lib-compat` 全綠。

---

## 7. 風險與需要決定的事

### 7.1 ✅ 已定案：**自己寫描繪器**（不引入 GPLv3 的 `kage-engine`）

`kage-engine/COPYING` 是 GPLv3，而 accelon26 是 Apache-2.0。作者 2026-11-06 決定走 B：
**我們自己實作「筆段→輪廓→SVG」（`pinxing`），accelon26 不含任何 GPL 程式碼。**

- 字形**資料**本來就自由（`dump/LICENSE.txt`：「自由使用、可商業、無擔保」），沒有問題。
- `kage-engine` 仍留在 glyphwiki，供 pinxing.html／glyph-browser.html 使用，
  並**只在本機當 pinxing 的驗收仲裁者**（`check-pinxing-render.ts`）。
- 代價：`pinxing` 的 v0 與引擎的筆形**必然有差異**（筆鋒／鱗／折角那些自動調整）。
  這一點要在第一版就讓作者並排看過再決定要不要往 v1／v2 追。

### 7.2 記憶體 ✅ 已解（lazy decode，2026-11-06）

4.7 MB 的位元流攤成 19 萬個物件就是 93 MB heap／276 MB RSS，而**真正會被看到的只有幾百個字形**。
`decodeLibraryLazy()` 把它壓到 **24 MB heap／66 MB RSS、42 ms**（詳見 §6.4）。
`decodeLibrary()` 保持原樣，既有工具與 `gocore` 的 Go 版差分測試都不受影響；
`gocore` 那一支（另一份實作）照舊是全庫比對的獨立證據。

### 7.3 建置機沒有 glyphwiki

`ts/tools/vendor-glyph.ts` 找不到來源時的行為：**沿用已進版控的生成物並警告**（不失敗）。
所以 CI／macOS 照樣建得出來（字形功能正常，因為生成物在 repo 裡）；
只有「重新產生」需要 `GLYPHWIKI_DIR`（預設 `D:\2023\glyphwiki`）。

### 7.4 HTML 版體積

`pinxing` ＋ 模組大約 **+180–220 KB**（html 2.41 MB → ~2.6 MB）。它們在 html 版是**惰性死碼**。
若嫌大，P2 可以只在 `build-desktop` 的 bundle 裡引入（需要兩個 entry 或建置旗標）。

### 7.5 已知不會做的事（寫清楚免得誤會）

- **PUA 缺字（CB／SD，第 15–16 平面）不會自動有字形**：字庫只收 12 個 CJK 區塊。
  它們要另一份資料（`docs/adb/taisho-pua-gaiji.tsv` 的組字式 → 構形序），屬 P3。
- 字庫只涵蓋 CJK 區塊；`⿰口謦咳` 這種**部件不在庫裡**的 IDS 會退回顯示原文（並在面板說明原因）。

---

## 8. 施工分階段與驗收

### P0 — glyphwiki：`pinxing`（**關鍵路徑**）—— ✅ 第一輪完成（2026-11-06）

0. ~~`tools/pinxing.ts` ＋ `check-pinxing-render.ts`~~ ✅（規格與實測見 §3.5、§3.6）。
   **下一步先請作者看並排圖**（`out/pinxing-songti.png`／`out/pinxing-yuanti.png`），
   再決定要不要往 v1 追（捺的掃、折角、起筆楔、鱗）。
1. `tools/glyph-search.ts`：把 `pinxing-page.js` 的檢字抽成模組；頁面改呼叫它。
2. `tools/glyph-api.ts`：`createGlyphCore()`（`svgOfCp`／`svgOfIds`／`svgOfSeq`／`info`／`search`／`tightOfCp`）。
3. ~~**`lib-format.ts` 加 lazy decode**~~ ✅（2026-11-06，§6.4）：`decodeLibraryLazy()` ＋
   字形樁 ＋ `materialize()`；全庫差分測試 191,727 字 0 不一致，模組測試在 lazy 上全綠。
   `decodeLibrary()` 行為不變（既有工具不受影響）。
4. `tools/build-glyph-api.ts` → `out/glyph-api/`（模組原文、`pinxing`、`manifest.json`：lib sha256／字形數／版號）。
5. **驗收**：`bun run verify --fast`（含 `free-compose-test`／`check-pinxing`）全綠；
   `gocore` 全庫差分測試全綠（lazy 與全解逐字形相同）；`build-glyph-api.ts --check` 可重現；
   `check-pinxing` 的指標不退步。

### P1 — accelon26：載入 ＋ 本文裝飾（經文類先行）

1. `ts/tools/vendor-glyph.ts`：複製 ＋ 檔頭 ＋ `--check`；把 `wails/assets/glyphwiki.bin.gz` 一起複製。
2. `ts/src/accelon26/glyph.ts`：fetch／解壓／`createGlyphCore()`／`svgOfCp` 快取／`decorateGlyphs(root)`。
3. `doc-pane.ts`：`#docText` 渲染完之後呼叫一次（只本文區）。
4. CSS：`.gw／gwT／gwG` ＋ 設置開關（介面 → 字形：**預設「只換 Unicode Extension」**／可關）。
5. **驗收**（headless Edge 實跑）：
   - `taisho` 一頁有 Ext 字 → `.gw svg` 出現、**同一句的其他字不動**（比對 `textContent`）；
   - 選取那顆字 → 複製 → 剪貼簿內容是**真字**；
   - 塗紅一個含 Ext 字的詞 → `mark.docHit` 仍產生；
   - 相鄰行 `getBoundingClientRect().top` 差 ≤ 1px；
   - 關掉開關 → DOM 回到原樣、`.gw` 為 0 個；
   - `bun run tools/smoke.ts` ＋ `check-cycles.ts`（基準 64）。

### P2 — IDS ＋ 說文

1. `.gw` 支援多字元 IDS（`⿰氵㫄`、`<構形>`）。
2. 單頁字形數的保險（>1,000 分兩批補畫、>3,000 退回原字）——`hydzd` 是極端例子，先不做 sprite。

### P3 — 找字 UI（作者定案：**含左欄「字形」分頁**）

1. **左欄新分頁「字形」**（與「詞彙」同一層）：一個輸入框 ＋ 候選格。
   - 語法沿用 pinxing／glyph-browser：`木+`（左）`+木`（右）`木/`（上）`/木`（下）
     `口口`（兩次）`4木日`（扣掉部件剩 4 畫）`U+XXXX`、直接輸入一個字；
   - 結果依區塊排序（BMP 先於 Ext A，一般漢字先於異體），點一格 → 右欄／下方的「字形」卡；
   - 每格顯示該字的 SVG（24–32 px）。
2. **字形卡**（右欄分頁或浮動卡）：大字（帶墨跡框／可切 1em 預覽）、`U+`碼、IDS、
   部件清單（可點 → 變成下一個查詢）、異體（同家族）、「加入本文？」不需要。
3. 點本文的字形 → 直接開同一張卡（不必先用選單）。
4. 選取文字 → `#selMenu` 加「字形」（選到 IDS 或 Ext 字時出現）。
5. （P3.5）PUA 缺字的構形序表。

---

## 9. 已定案與剩下的問題

**已定案（作者 2026-11-06）**

1. **描繪器自己寫**（`pinxing`），accelon26 不含 GPLv3 程式碼。
   作者原話：「pinxing 沒問題，就是 AI 重寫優化。」→ **v0 已完成**（§3.6）。
2. **只換 Unicode Extension**（Ext A–I ＋ 相容區／相容補充）；URO 常用字仍用系統字型。
3. **本文保留文字**（透明佔位 ＋ SVG 疊層），不把字換掉。
4. **找字 UI 做到左欄「字形」分頁**（不只本文自動換字）。
5. **筆劃風格要獨立成一層**，而且「kage 不有圓體，我們可以加各種變化」
   → `STYLES` 已有 `songti`／`heiti`／**`yuanti`（圓體）**／`xiti`（§3.5）。
6. **字形粗細／大小可調，但排後面**（作者：「可以在設置調，不過可以慢點，不重要」）——
   v1 先寫死 100%，接口留好（`LitePinxing.weight`；實測：`weight` 加倍＝墨量加倍）。
7. **效能**：`hydzd` 是極端例子，「組字速度夠快了」→ v1 不做 sprite／IntersectionObserver。
8. **順序**：作者 2026-11-06：「**等 pinxing porting 好再優化 in-memory 的字庫結構，要不了 120 MB 的**」
   → pinxing v0 完成後，**lazy decode 已完成**（93 MB → 24 MB heap、276 MB → 66 MB RSS、212 → 42 ms）。
9. **目標是「為本文與自由組字優化」，不是「復刻 kage」**（作者 2026-11-06）：
   → 已做 `emPx` ＋ `minStrokePx`（1em 的最細筆下限，密度自適應），16 px 的灰墨 48% → 28%
   （§3.7）；IoU 只當回歸鎖，不再當目標。

**仍待決定**

- **v1 保真度**（降級為可選）：作者 2026-11-06 定調「不以復刻 kage 為目標」，
  所以那四樣（捺的掃、折角方塊、起筆楔、鱗）除非在 200 px 面板上很明顯，否則不做。
- **`minStrokePx` 的預設值**：現在 0.9 px（密度自適應）。要不要做成設置裡的「輕／標準／重」
  （0.55／0.9／1.1），跟「字形粗細 %」放一起。
