# Obsidian vault → accelon26 `.adb`：方案評估（含可執行原型）

> **結論（2026-10-25）**：**可行，而且原型已經跑通。** 一條指令、沒有人類介面：
>
> ```bash
> cd ts
> bun run md2adb "D:\2026\adb-converter\《論語句讀新詮》.zip" -o ..\build\lunyu.adb --name lunyu
> ```
>
> **0.7–1.1 秒**產出 **3.69 MiB** 的 adb（499 章、570 字條、772 張圖）。
> accelon26 開得起來：目錄樹 21 列 → 篇 → 章、本文渲染、`聯` 字條跳轉、
> **內嵌字形圖**、搜尋 1,141 筆、摘要不露標籤，全部實測正常（§6）。
>
> 代價：viewer 5 處小改（合計 +178 行）；另加 3 個新模組、3 支工具、1 個拖放包裝、1 份測試（約 1,150 行）。
> 沒有改動任何既有資料庫的讀取路徑（13j 回歸與改動前**同樣 73 pass / 2 fail**，
> 失敗的兩項與訊息都相同，§7）。
>
> **第二輪（同日）**：這個轉換已經搬進 accelon26 —— 📁 選單多了「加入 Obsidian（資料夾／.zip）」，
> 選完當場轉成 .adb：網頁版下載到「下載」資料夾、桌面版寫到執行檔旁邊，兩邊都自動更新
> adb 清單。瀏覽器產生的 adb 與 CLI **逐位元組相同**（sha256 相同）。詳見 §11。

---

## 0. 先講判斷：值不值得做

| 問題 | 答案 | 依據 |
|---|---|---|
| 資料夠乾淨、能全自動轉嗎？ | **可以** | 全文沒有 `<`、`&`、frontmatter、`#` 標題、清單、表格、程式碼區塊；只有 `[[連結]]`、`![[圖]]`、`【小節】`、空行（§1） |
| 需要人工對位／貼標籤嗎？ | **不用** | 資料夾＝篇、檔名＝章、根目錄單字檔＝字條，規則可完全推導（§2） |
| 772 張圖（760 PNG ＋ 12 data-URI，2.5 MB）怎麼辦？ | 進 `resources`，本文用 `<圖 n=…/>` **內嵌在句中** | viewer 原本只把圖列在右欄「圖片」分頁，**這次補上內嵌渲染**（§4.2） |
| 一鍵到 adb？ | **是**：zip 進、adb 出 | `bun run md2adb <vault> -o out.adb` |
| 會動到既有 13j／yinshun 的顯示嗎？ | **不會** | 改動都是「有這個標籤才生效」的加值路徑；13j 的 file-protocol 測試通過數與失敗訊息都和改動前相同（§7） |
| 距離「正式採用」還差什麼？ | 編輯回寫、部首排序、反連結樹、舊 exe 相容 | §8、§10 |

**建議**：採用「編寫在 Obsidian、出版在 accelon26」的分工——vault 仍是唯一編輯端，
adb 是**唯讀出版品**；每次改完 vault 重跑一次指令即可（增量重建 < 1 秒）。

---

## 1. 這批 vault 長什麼樣（實測，不是估計）

`《論語句讀新詮》.zip`：1,857 個項目、3.67 MB。

| 項目 | 數量 | 說明 |
|---|---:|---|
| `.md` | **1,069** | 499 章 ＋ 570 字條 |
| 篇（資料夾） | **20** | `01-〈學而篇〉` … `20-〈堯曰篇〉`，每篇 3–44 章 |
| `.png` | **760** | 2.52 MB；**744 張被引用**、16 張沒有引用、最大 158 KB（另有 12 張 data-URI 圖） |
| `.json` + `.obsidian/` | 6 + 1 目錄 | 忽略 |
| 正文字數 | 515,748 字 | 1.4 MB UTF-8 |
| 行數 | 17,675 行 | 沒有 CRLF、沒有 tab、沒有全形空白 |
| `[[連結]]` | 670 個（章→字）＋ 759 個（字→字／圖） | **0 個 unresolved** |
| 句中插圖 | 343 行 | 圖片就夾在句子中間（「㒸」於毛公鼎作「[圖]」），**不是**獨立圖版 |
| data-URI 圖 | 12 張（5 個檔） | 貼上時被 Obsidian 內嵌成 base64 |
| 小節 | 【原文】【譯文】【說明】各 499；【參考】255；【注釋】117 | 固定順序，偶有「参考」簡寫 |

一句話：**這是一個「經文 ＋ 字書」的雙層文本**，不是一般筆記庫。
沒有 markdown 語法包袱，卻有兩件麻煩事——**密集的行內連結**與**行內圖片**——
它們正好是 accelon26 原本最弱的地方（§4.2、§6.4）。

---

## 2. 對映：markdown → Accelon3 方言

| vault | Accelon3 | 產出 |
|---|---|---|
| 資料夾 `01-〈學而篇〉` | `<篇 t="章">學而第一</篇>` | 目錄第 1 層（21 個：20 篇＋字詞） |
| 檔名 `01-01第一章.md` | `<章>第一章</章>` | 目錄第 2 層（499 個） |
| 根目錄 `仁.md` | `<字>仁</字>` | 字條（570 個），掛在「字詞」之下 |
| `[[學]]` / `[[學|顯示]]` | `<聯 n="學">學</聯>` | 可點，跳到字條（viewer 既有的 `linkToEntry`） |
| `![[x.png]]` / `![](...)` | `<圖 n="x.png"/>` | 內嵌圖片（新，§4.2） |
| `![](data:image/png;base64,…)` | 解碼成 `resources/<檔名>-imgNN.png` ＋ `<圖 n="…"/>` | 12 張 |
| 空行 | 空行 | 段落 |
| `【原文】` 等 | **原樣保留為文字** | 不另立標籤（理由見 §5） |

實際產出的開頭（`build/lunyu-xml/lunyu.xml`）：

```xml
<集 t="集">《論語句讀新詮》</集>
<隱><樹 s="*" t="篇">目錄</樹></隱>
<篇 t="章">學而第一</篇>
<章>第一章</章>
【原文】
子曰：「<聯 n="學">學</聯>而<聯 n="時">時</聯><聯 n="習">習</聯>之，不亦<聯 n="說">說</聯>乎？…
```

### 2.1 為什麼是「篇／章／字」，不是「書／章」

`<樹 s="*" t="篇">` 宣告**目錄樹的第一層**是 `篇`，而 accelon26 的**搜尋分群**
也用同一個標籤（`groupTag = tree.tiers[0]`）。

* 若照 13j 的習慣再加一層 `<書>`，搜尋摘要就只能分「經文／字詞」兩群——沒有用。
* 把「字詞」也做成一個特別的 `篇`（第 21 個），分群就是 21 群，字條也能被單獨統計。
* 代價：`字詞` 在目錄裡跟「學而第一」並排。語意上小怪，閱讀上完全合理
  （它本來就是一本書後面的字書），而且換來的是可用的分群。

### 2.2 `t=` 的雙重作用（這是整套對映的關鍵）

Accelon3 的 `t=` 不只宣告**樹的層級**，它同時把列出的標籤**登記為「要存快取字串」**
（`index.pas:1006 → CreateChildTag(value,' cached')`）。所以：

```
<樹 s="*" t="篇">   → 篇 從此 cached（目錄 21 列的標題）
<篇 t="章">          → 章 從此 cached（499 列的標題）
<篇 t="字">          → 字 從此 cached（570 列的標題）
```

`caches/<標籤>` 就是目錄列的名字來源（不必回讀內文），`attributes/<標籤>.t`
則是目錄樹重建階層時讀的宣告。**少寫任何一個 `t=`，目錄就會變成空白或 `#n`。**

### 2.3 為什麼不用 `<檔>`

`<檔>` 會把文字切成「文件」，但本庫的層級是 `篇 > 章 > 字`，`檔` 的範圍會跨斷
目錄節點的範圍（`nodeOwningVa` 以檔界夾住節點），breadcrumb 會掉。13j 正是
**單一檔**（8.3 萬字、4.2 萬行），本庫 49.8 萬字也在同一量級 —— 跟它一樣做。

副作用：右欄「原書」分頁是空的（沒有檔可列）。這在 13j 上本來就是常態。

---

## 3. 管線（一鍵）

```
《論語句讀新詮》.zip
   │  src/zipread.ts            純 TS 讀 zip（無依賴，stored/deflate）
   ▼
markdown 樹（1,069 md + 760 png）
   │  tools/md2adb.ts           分類、改寫行內語法、組 Accelon XML
   ▼
XML 行（18,767 行）＋ resources（756 張）
   │  src/adbauthor.ts          buildIndex → 索引/行表/屬性/快取 → 容器 → 檔頭
   ▼
build/lunyu.adb（3.43 MiB）
```

**最省事：把 zip 拖到 `vault2adb.cmd` 上**（或用 `vault2adb.cmd "<zip>" lunyu`），它會跑完
並停在結果那一行。等價的 CLI：

```bash
cd ts
# 最簡：zip 進、adb 出
bun run md2adb "D:\...\《論語句讀新詮》.zip" -o ..\build\lunyu.adb --name lunyu

# 想看中間產物（XML ＋ 圖片，可人工檢查）
bun run md2adb "…zip" -o ..\build\lunyu.adb --name lunyu --xml ..\build\lunyu-xml

# 也可以直接吃解開的資料夾（vault 直接指過去）
bun run md2adb "D:\vault\《論語句讀新詮》" -o ..\build\lunyu.adb --name lunyu
```

參數：`--name`（adb 檔名／`dbname`，預設取 vault 名的 ASCII 部分，否則 `book`）、
`--title`（顯示名，預設＝vault 資料夾名）、`--xml`（輸出中間產物）、`--quiet`。

產物：`build/lunyu.adb`（不進版控，`build/` 已在 `.gitignore`）。

**「一鍵」的定義**：一個動作（把 zip 拖到 `vault2adb.cmd`，或一行 CLI），不需要視窗、
不需要選項、不需要人工對位。之後把 `lunyu.adb` 放進 accelon26 的目錄，exe 啟動就會
列出來（它掃自己目錄的 `*.adb`）；網頁版則是拖進去或從 📁 選。若要做到「連開檔都免」，
再加一個 `--deploy <exe 目錄>` 拷貝即可（10 行，尚未做）。

> ⚠️ **內嵌圖片只在重新建置的 UI 生效。** 這次改的是 `render_accelon3.ts`／`doc-pane.ts`，
> 我已經重建 `build/accelon26.html`（2026-10-25 08:12）。但現有的
> `accelon3/accelon26.exe` 是 **2026-10-24** 的舊 UI —— 用它開 `lunyu.adb` 時
> `<圖>` 會被直接忽略（圖片不顯示，其餘正常）。要看到字形圖，請用新的 HTML，
> 或按 `ACCELON26-HANDOVER.md` §13.6 的流程重新發佈 exe。

---

## 4. 改了什麼

### 4.1 新增（約 1,150 行，含測試）

| 檔案 | 行數 | 做什麼 |
|---|---:|---|
| `ts/src/zipread.ts` | 84 | 最小 ZIP 讀取器：central directory、stored/deflate、UTF-8 檔名（GBK 後備）。**不加依賴** |
| `ts/src/adbauthor.ts` | 209 | **從零建 adb**：`buildIndex` → source/tokens/tags/tables/attributes/caches/resources → 檔頭。原本只有 `rebuild-adb`（要捐贈者的檔頭與容器順序） |
| `ts/tools/md2adb.ts` | 294 | Obsidian vault → Accelon XML → adb；分類、行內改寫、資源收集、`--xml` |
| `ts/tools/check-index.ts` | 87 | 索引對拍：XML 重新索引，逐 token／逐位置比對 adb |
| `ts/tools/probe-adb.ts` | 217 | 實機煙霧測試：真的開 `accelon26.html`、真的點目錄／`聯`／搜尋，輸出 JSON（§6.2 的表就是它跑的） |
| `ts/test/adbauthor.test.ts` | 207 | 8 項：檔頭、標籤命中數、`t=` 快取、屬性表、資源、CR/LF 拒絕、zip 讀取 |
| `ts/src/adbwrite.ts` `makeHeader()` | +53 | 256 byte 檔頭**從零寫**（含 crc32），不再借別人的檔頭 |

### 4.2 viewer 的 5 處（+178 行，全部是加值路徑）

| 檔案 | 改動 | 為什麼非改不可 |
|---|---:|---|
| `render_accelon3.ts` | +24 | `<圖 n=…>` → `<img class="inlineImg">`（讀不到畫 `▢` 佔位）。原本 `圖` 沒有處理，**整張圖消失、句子斷掉** |
| `doc-pane.ts` | +51 | 一頁的圖先解成 blob URL 並快取（換庫整批 revoke）。渲染是同步的，只能先解 |
| `scopes.ts` | +45 | 深層節點的名字用 `caches/<tag>` 預填。否則 breadcrumb 會顯示 **`#136`** 而不是「學」（570 個字條不會全部先畫出來） |
| `search.ts` | +44 | 摘要視窗不要切在標籤中間（§6.4） |
| `accelon26.template.html` | +14 | `.inlineImg` 樣式：字高 1.5em、**白紙底**（字形圖是透明背景＋黑墨，深色主題會隱形） |

---

## 5. 幾個設計取捨（知道就好，不是 bug）

1. **章標題＝檔名**（`第一章`），不是原文首句。原文首句當標題會與正文重複一次。
2. **篇標題＝資料夾名＋序數**（`學而第一`）。資料夾叫「學而篇」，序數取自 `01-` 前綴。
3. **字條排序＝Unicode 碼位**。vault 沒有部首／筆畫／拼音資料，硬排會亂；
   要部首順序得另外做表（§8）。
4. **【原文】等小節保留為純文字**。做成標籤只會多一層沒有階層意義的顏色；
   保留 `【】` 反而一眼看得出結構。想上色可以日後掛「標籤樣式」。
5. **圖片預設全部打包**（760 PNG ＋ 12 張 data-URI ＝ 772 張，第二輪起；`--referenced-only`
   只放被引用的 744 張）。
6. **data-URI 圖抽成資源**（`廷-img00.png` 這種名字），不留在正文裡——否則一行 5,000 字。
7. **`集` 標籤寫成 `<集 t="集">`**：讓它自己也被快取，`cli analyze` 才看得到書名
   （原本顯示 `(unnamed)`）。

---

## 6. 驗證

### 6.1 建置統計

```
built build/lunyu.adb: 3.69 MiB in 0.3–0.6 s（含解 zip 與寫檔的全程 0.85 s）
  18,767 lines, 4,238 tokens / 445,195 hits, 15 tags
  (集 /集 隱 樹 /樹 /隱 篇 /篇 章 /章 聯 /聯 圖 字 /字)
  772 resources (2.42 MiB)
source 61 blocks / 0.95 MiB, maxblockoffset 457,976
```

**索引對拍**（`tools/check-index.ts`：把 XML 重新索引一次，逐 token、逐位置比對 adb 裡的
posting list）：

```
4238 tokens / 445195 hits, 15 tags — indexer vs adb: identical (adb postings 445195)
```

`bun run src/cli.ts analyze build/lunyu.adb` 摘要（它的 hit 統計方式與索引器略有不同，
以對拍為準）：

```
dbname lunyu   dbcname 《論語句讀新詮》   dbtype 0
linecount 18767   tagcount 4297   maxblockoffset 457976
tokens 4238 / 445,195 hits   unigram 3,869 (99.6% 覆蓋)
tags 圖=771 聯=670 /聯=670 字=570 /字=570 章=499 /章=499 篇=21 …
collection 集 = 1 -> 論語句讀新詮
resources 772 images (2.42 MiB, 98.1%)
```

### 6.2 實機（headless Chromium，`file://`，與使用者雙擊同一條路徑）

| 檢查 | 結果 |
|---|---|
| 開啟 | `db=lunyu`、4,238 詞、0 檔（單檔庫，同 13j） |
| 目錄樹 | **21 列**：`篇:學而第一` …`篇:堯曰第二十`、`篇:字詞`；建樹 **12–24 ms**、1,090 個節點 |
| 展開篇 | 16 個 `章` 列，標題正確（第一章…第十六章） |
| 本文 | `學而第一 ｜ 第一章`、標題上色、`【原文】`起 39 個可點字 |
| `聯` 跳轉 | 點「學」→ `字詞 › 學`，本文換成「學」的字條（`「學」音讀作〔xué ㄒㄩㄝˊ〕…`） |
| 內嵌圖 | 有圖的頁面 **5–43 張** `img.inlineImg` 可見（24 px 高），`0` 張缺圖 |
| 搜尋「仁」 | **1,141 筆**、2–7 ms、分 20 群（鄉黨第十沒有「仁」）、30 張摘要、**0 張摘要露出標籤** |
| 搜尋「㐱」 | 11 筆、**分 1 群（依篇）** → 字條有被正確歸群 |

![章頁](build/probe.png)
![字條頁（內嵌字形圖）](build/probe-2.png)

（截圖由 `ts/tools/probe-adb.ts` 產生，可重跑；輸出在 `build/`，不進版控。）

### 6.3 測試

逐檔執行（`bun test` 不指定檔名在 Bun 1.3.11/Windows 上只跑第一個檔）：

| 檔案 | pass |
|---|---:|
| `accelon26.test.ts` | 22 |
| **`adbauthor.test.ts`（新）** | **8** |
| `backend-cases.test.ts` | 180 |
| `backend-layout.test.ts` | 11 |
| `dict-settings.test.ts` | 13 |
| `edit-session.test.ts` | 23 |
| **`inflate.test.ts`（新）** | **4** |
| `multi-search.test.ts` | 39 |
| `rebuild-browser.test.ts` | 17 |
| `render.test.ts` | 22 |
| `search.test.ts` | 38 |
| `tag-style.test.ts` | 32 |
| `tour.test.ts` | 31 |
| `tree.test.ts` | 43 |
| `vapa.test.ts` | 13 |
| `variants.test.ts` | 13 |
| **合計** | **509 pass / 0 fail**（另加 Go `wails` 套件） |

瀏覽器端（file://，真的開檔、真的點）：

| 測試 | 結果 |
|---|---|
| `tools/file-protocol-test.ts --adb 13j.adb` | **73 pass / 2 fail** —— 與**改動前**（stash 後重建）的通過數、失敗訊息完全相同；這 2 個是既有的（`docHead` 統計列、harness `getComputedStyle(null)`） |
| `ts/tools/probe-adb.ts --adb build/lunyu.adb`（新庫） | 全部檢查通過，exit 0（§6.2 那張表就是它的輸出） |

### 6.4 這批資料暴露的一個既有 bug（已修）

摘要卡片原本是「以命中為中心、左右各取 30 字」。原文每一兩個字就被
`<聯 n="…">` 包住，30 字的視窗**經常切在標籤中間**，卡片就顯示成：

```
聯 n="令">令色，鮮矣仁」
```

修法（`search.ts`）：找字時跳過標籤內的位置；視窗的兩端若落在標籤內，
往外擴到標籤邊界。修完 `0` 張卡片露標籤。

**這是「密集行內標籤」才會遇到的問題**——13j／yinshun 的標籤稀疏，所以以前沒被發現。
同一類「範圍切在標籤中間」的假設還有兩處，這次順手補了：深層節點名字
（breadcrumb 顯示 `#136`，§4.2 scopes）與內嵌圖片的 `n=` 屬性。

---

## 7. 風險與限制

| 風險 | 影響 | 現況／對策 |
|---|---|---|
| **舊 accelon3.exe 可能不認這個 adb** | 只能用 accelon26 讀 | 標籤（篇/章/字/聯/圖）不在任何 docdef 裡，舊 exe 需要建庫定義檔才畫得出來。**未測試、不建議**；目標是 accelon26 |
| **編輯不會回寫 vault** | 在 accelon26 改的字，重跑一次就被蓋掉 | 明確定位：vault 是編輯端、adb 是出版品。要雙向得做「adb → md」（可做，未做） |
| 字條沒有部首／筆畫順序 | 570 條按 Unicode 排，找字要看目錄滾動 | 有全庫搜尋（2 ms）可替代；要正式排序需建對照表 |
| 目錄「字詞」與二十篇並列 | 語意上略怪 | 換來可用的搜尋分群（§2.1） |
| 摘要卡片裡的圖只顯示 `▢` 佔位；「導出文字」會帶著 `<圖 n=…>` 標記 | 不影響閱讀，但匯出要另外處理 | 摘要通常不需要字形圖；匯出可再加一步把 `<圖>` 轉成檔名 |
| 單檔庫沒有「原書」分頁 | 右欄少一個入口 | 與 13j 相同；要的話可改成「一章一個 `<檔>`」，但要處理節點跨檔（§2.3） |
| markdown 的其他語法未支援 | 標題 `#`、清單、表格、程式碼區塊會變成純文字 | 這批資料**完全沒有**這些語法；別處的 vault 要補 |

---

## 8. 工作量

| 項目 | 狀態 | 估時 |
|---|---|---|
| ZIP 讀取、`adbauthor`、`makeHeader` | ✅ 做完（含測試） | 0.5 天 |
| md → XML 對映（含連結／圖片／data-URI） | ✅ 做完 | 0.5 天 |
| viewer：內嵌圖、深層標籤、摘要切字、白底 | ✅ 做完 | 0.5 天 |
| 實機驗證與回歸 | ✅ 做完 | 0.5 天 |
| **合計（本次）** | | **約 2 天** |
| `--deploy`（複製到 exe 旁）＋ `.cmd` 一鍵 | 未做 | 0.5 小時 |
| adb → md 回寫（保住 accelon26 的修訂） | 未做 | 1–2 天 |
| 部首／筆畫排序表 | 未做 | 0.5–1 天 |
| 反連結樹（哪些章引用這個字） | 未做 | 1 天（`聯` 命中表已在 adb 裡） |
| 舊 accelon3.exe 相容（docdef） | 不建議 | — |

### 8.1 這次**沒有**驗證的

* **桌面 exe（Wails）**：只驗了網頁版 `file://`（同一份 HTML；exe 只是宿主）。
* **編輯模式**（revisions）：這種密集 `聯` 的文字上未測改字／重建。
* **「導出文字與圖片」**：未測（文字會帶 `<圖 n=…>` 標記）。
* **舊 accelon3.exe**：未測，預期需要 docdef。
* **列印／PDF**：未測。

---

## 9. 建議的下一步

1. **先當出版品用**：把 `build/lunyu.adb` 丟到 `accelon26.exe` 旁邊，實際讀幾章、
   點幾個字，確認閱讀體驗可以接受（字級、行距、「原書分行」開關）。
2. **要一鍵就加 3 行**：`--deploy <exe 目錄>`＋一個 `rebuild-lunyu.cmd`。
3. **要不要回寫**：如果作者想在 accelon26 裡改錯字，就得做 adb → md（或讓修訂
   以 patch 形式存在 adb，重跑時套用）。這件事要先決定，因為它決定 vault 與 adb
   誰是「真本」。
4. **排序**：570 個字條若真要像字典，需要部首／筆畫表；否則搜尋已夠快。

---

## 10. 檔案地圖（這次動到的）

```
ts/src/zipread.ts                  新  最小 ZIP 讀取器
ts/src/adbauthor.ts                新  從零建 adb
ts/src/adbwrite.ts                 改  makeHeader()
ts/tools/md2adb.ts                 新  vault → adb（CLI）
ts/tools/check-index.ts            新  索引對拍
ts/tools/probe-adb.ts              新  實機煙霧測試（file://）
ts/test/adbauthor.test.ts          新  8 項測試
vault2adb.cmd                      新  拖放 .zip 就建好 adb
ts/package.json                    改  "md2adb" script
ts/src/accelon26/render_accelon3.ts 改  <圖> 內嵌渲染
ts/src/accelon26/doc-pane.ts        改  圖片 blob URL 解析／快取
ts/src/accelon26/scopes.ts          改  深層標籤用 caches 預填
ts/src/accelon26/search.ts          改  摘要視窗不切標籤
ts/src/accelon26/accelon26.template.html 改  .inlineImg 樣式
```

重跑：

```bash
cd ts
bun run md2adb "D:\2026\adb-converter\《論語句讀新詮》.zip" -o ..\build\lunyu.adb --name lunyu --xml ..\build\lunyu-xml
bun run tools/check-index.ts ..\build\lunyu-xml\lunyu.xml ..\build\lunyu.adb
bun test test/adbauthor.test.ts
bun run tools/probe-adb.ts --adb ..\build\lunyu.adb   # 實機檢查＋截圖
```
---

## 11. 第二輪：accelon26 裡的「加入 Obsidian」（2026-10-25）

第一輪的轉換是 CLI（Bun）。這一輪把它搬進 accelon26 本身：**讀者在程式裡就能把一個
Obsidian vault 變成資料庫**，不必開終端機。

### 11.1 介面

📁（adb 選單）「加入 adb」的下面多了兩列：

```
＋ 加入 adb
＋ 加入 Obsidian（資料夾）
＋ 加入 Obsidian（.zip）
```

為什麼是兩列而不是一列：`<input type="file">` 一次只能選一種——`webkitdirectory`
選資料夾，普通 input 選 `.zip`。兩列最直白，也不必先問「你要哪一種」。

**選完 vault 會問檔名**（2026-10-25 第二版）。對話框會先列出這個 vault 的規模
（「論語句讀新詮：499 章、570 字、772 張圖」），再讓你打名字：

* `lunyu` 與 `lunyu.adb` 都可以（`.adb` 可省略；大小寫不拘）。
* 中文檔名可以（`論語.adb`）；因為 **adb 檔頭只能存 ASCII**，庫名會記成 `adb`，
  對話框會即時說明「會寫出 論語.adb；adb 檔頭（庫名）只存英數，這裡記為「adb」」。
* 檔名裡的 `\ / : * ? " < > |` 會被去掉，前後的點與空白也會修掉。
* Enter＝建立、Esc＝取消；不填名字按「建立」只會提示，不會寫檔。

狀態列會一路顯示進度（讀取 → 建索引 → 壓縮內文 n/m → 打包圖片 → 組裝檔案），
完成後：

| 環境 | 產物去哪裡 | adb 清單 |
|---|---|---|
| 網頁版（`file://`／http） | 觸發瀏覽器下載 → **預設落在「下載」資料夾** | 這一份同時加入本次工作階段的清單並開啟 |
| 桌面版（Wails3） | `main.AdbHost.SaveAdb` → **執行檔旁邊**（寫不進去才退到下載資料夾並回報） | `ListAdbs` 重掃，清單立刻出現並開啟 |

### 11.2 轉換在哪裡跑

不能叫 Bun，所以整條管線都在頁面裡：

```
vault（資料夾／.zip）
  │  vault-import.ts      讀檔；zip 用 zip-dir.ts 掃目錄 + inflate.ts 解壓；問檔名
  ▼
VaultFile[]（path / text / bytes）
  │  vault-plan.ts        ★與 CLI 共用：資料夾＝篇、檔名＝章、單字檔＝字、[[ ]]→<聯>、圖→<圖>
  ▼
XML 行 + 圖片
  │  author-core.ts       ★與 CLI 共用：buildIndex → 容器 → 檔頭（byte 級相同）
  │  bzip2-wasm.ts        既有的 libbz2 wasm（編輯模式重建 adb 用的那一支）
  ▼
Uint8Array → 下載／寫檔
```

兩個「★」是這一輪重構出來的核心：`vault-plan.ts`（markdown → Accelon 方言）與
`author-core.ts`（行 → adb 位元組，壓縮器由呼叫端注入）。CLI 與瀏覽器只是換了
「怎麼讀檔」與「用哪個 bzip2」。

**驗證方式**：同一份 vault，CLI 與瀏覽器各建一次，比對 sha256 ——

```
CLI      lunyu.adb  3,871,803 bytes  sha256 da48ae38a8cf98343322d638d505c12052c2fa89c4b4a32a464643f7e35dc210
瀏覽器   lunyu.adb  3,871,803 bytes  sha256 da48ae38a8cf98343322d638d505c12052c2fa89c4b4a32a464643f7e35dc210
```

### 11.3 兩件非做不可的配套

**（一）圖片全部打包。** 你說的「小圖也打包進去」：現在 `planVault` 預設把 vault 裡**每一張**
圖都放進 `resources`（不再只放被引用的）—— 這個 vault 是 760 張 PNG ＋ 12 張 data-URI ＝ **772 張**，
adb 從 3.43 MiB 長到 3.69 MiB。CLI 要舊行為可以加 `--referenced-only`。

**（二）zip 解壓要快。** 一個 vault 的 zip 有 ~1,300 個 deflate 條目。原本用
`DecompressionStream('deflate-raw')` 一條一個 stream：Chromium 每次要 ~50–100 ms 建 stream，
整包要**兩分鐘**。改成自寫的 inflate（`src/inflate.ts`，RFC 1951，~250 行）之後，
1,299 個條目在 **78 ms** 內解完，且與 `node:zlib` 逐位元組相同（`test/inflate.test.ts`
拿真的 vault zip 對拍）。

實測整段（桌面版，含寫檔與開庫）：**0.7–1.0 秒**；瀏覽器版 0.4 秒（不含下載）。

### 11.4 桌面宿主改了什麼（Go）

| 檔案 | 改動 | 為什麼 |
|---|---|---|
| `wails/import.go`（新） | `SaveAdb(name, base64)`：驗 adb 簽名 → 寫 exe 旁 → 失敗退下載 | 桌面版的出口；名字會清成 ASCII、補 `.adb` |
| `wails/adbhost.go` | `seedDirs()`（cwd ＋ exe 目錄）；`ListAdbs` 掃這兩處並去重；`resolve()` 白名單加上 exe 目錄 | 捷徑的「開始位置」不一定等於 exe 所在資料夾 |
| `wails/import_test.go`（新） | 5 項：寫入順序、檔名清理、簽名校驗、seedDirs | — |

過程中抓到一個真 bug：簽名校驗寫成 `data[32:80]`（48 bytes，含 NUL 補齊）比 44 bytes 的
簽名常數 → **永遠不相等**，於是每次「加入 Obsidian」都回「這不是 .adb 檔」。
改成 `data[32:32+len(signature)]` 並補測試。

### 11.5 驗證

| 檢查 | 結果 |
|---|---|
| `bun test test/inflate.test.ts` | 4 pass（含真 vault 的 1,299 個條目對拍） |
| `bun test test/adbauthor.test.ts` | 8 pass |
| `cd wails && go test ./...` | 全綠（含 5 項新測試） |
| `bun run tools/probe-vault-import.ts` | **~4 s**（含開瀏覽器）：選單有兩列 → 選 zip → 頁面內建庫（sha256 ＝ CLI）→ 下載到瀏覽器下載夾 → 開庫、清單更新 |
| `bun run tools/probe-desktop-import.ts` | exe 複製到暫存資料夾啟動 → 選 zip → 打檔名 lunyu → **lunyu.adb 寫在 exe 旁**（3,871,803 B、簽名正確）→ 開庫（4,238 詞、目錄 21 列）→ 清單出現 |
| `tools/file-protocol-test.ts --adb 13j.adb` | **73 pass / 2 fail**（與改動前同樣兩項） |

兩個 probe 都是真的驅動 UI（CDP）：`probe-vault-import.ts` 走網頁版、`probe-desktop-import.ts`
開真的 Wails 視窗。選單項目的測試也一併更新：資料庫列以 `.dbPickName` 認，動作列不算。

### 11.6 改了哪些檔案（第二輪）

```
ts/src/vault-plan.ts                新  vault → XML 行（CLI／瀏覽器共用）
ts/src/author-core.ts               新  行 → adb 位元組（壓縮器注入）
ts/src/adbauthor.ts                 改  只剩 Node 的 bzip2 包裝
ts/src/inflate.ts                   新  RFC 1951 inflate（瀏覽器解 zip）
ts/src/zip-dir.ts                   新  zip 中央目錄解析（共用）
ts/src/zipread.ts                   改  用 zip-dir + zlib
ts/src/accelon26/vault-import.ts    新  「加入 Obsidian」的 UI 與流程
ts/src/accelon26/adb-bytes.ts       改  makeHeaderBytes（從零寫檔頭）
ts/src/accelon26/dbs.ts             改  兩列選單、refreshHostDbs、handler 註冊
ts/src/accelon26/host.ts            改  desktopSaveAdb
ts/src/accelon26/ui.ts              改  接線＋診斷 API
ts/src/accelon26/accelon26.template.html 改  兩個隱藏 input
ts/tools/md2adb.ts                  改  用共用 planVault（預設打包全部圖片）
ts/tools/check-index.ts             新  （第一輪）索引對拍
ts/tools/probe-vault-import.ts      新  網頁版端到端
ts/tools/probe-desktop-import.ts    新  桌面版端到端
ts/test/inflate.test.ts             新
wails/import.go / import_test.go    新
wails/adbhost.go                    改  seedDirs / ListAdbs / resolve
vault2adb.cmd                       新  （第一輪）拖放就建 adb
www/adb/{lunyu.adb,index.txt,index.html}  改  公開清單加一列「論語句讀新詮」
```

### 11.7 這一輪的限制

* **資料夾選取沒有自動化測試**：CDP 的 `DOM.setFileInputFiles` 不能設定
  `webkitRelativePath`，所以 probe 走 `.zip`；資料夾路徑是同一套程式（只差讀檔），
  但沒有端到端測試覆蓋。
* **中文檔名**：檔名本身可以是中文（`論語.adb`），但 adb 檔頭的 `dbname` 只能 ASCII，
  會記成 `adb`；畫面上的庫名仍是書名。想要漂亮的 ASCII 檔名，就在對話框裡打（例如 `lunyu`）。
* **zip64／加密 zip 不支援**（vault 都很小）。
* **公開清單只改了本機**：`www/adb/index.txt`、`index.html` 與 `www/adb/lunyu.adb`
  都準備好了，`D:\accelon3\lunyu.adb` 也放了一份（產生器讀那裡），但**還沒上傳**
  （`bun run tools/deploy.ts --site-only` 會一起傳）。
* **桌面 exe 是本地重建**：`accelon3/accelon26.exe` 已用這次的程式碼重建，而且照
  `release.ts` 的旗標加了 GUI 子系統（雙擊不跳命令列）——用
  `bun run tools/pe-subsystem.ts` 確認 `subsystem=2`。要發佈仍照 HANDOVER §13.6
  的流程，我沒有動版本號或更新器。
