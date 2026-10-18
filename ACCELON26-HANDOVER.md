# accelon26 交接文件（2026-02，給下一個對話）

> **先讀 [`architecture.md`](architecture.md)**：那裡有一頁式的分層圖，以及
> 「哪個 UI 動作觸發哪些非同步資料抓取」的對照表（file:// 與 Wails3 兩種模式）。
> 本文件是逐輪的規格與踩坑紀錄，architecture.md 是現況地圖。
>
> **改名（2026-10）**：模組已從 `adbview` 全面改名為 `accelon26` ——
> 目錄 `ts/src/accelon26/`、模板 `accelon26.template.html`、示意圖 `accelon26-map.html`、
> 除錯 API `window.__accelon26`、設定鍵 `accelon26.*`（改名前的 `adbview.*` 沒有做遷移：
> 作者說除了他之外沒人跑過，舊鍵直接忽略即可）。

純瀏覽器 `.adb` 檢視器原型。**單檔 HTML，可從 `file://` 雙擊開啟**，無伺服器、無 sidecar、無 npm 依賴。
所有資料來自 `Blob.slice().arrayBuffer()` 隨機讀取。

> 本輪（2026-02 後半）依作者指示改了目錄區與本文區的行為，並修好三個資料庫的
> 瀏覽器測試。三項需求的規格寫在 §2，實作重點與踩到的坑在 §8。
>
> **狀態：暫停等作者測試回報。** 目前 13j 64/64、yinshun 68/68、fgdict 68/68
> （最後一輪只驗 fgdict，依作者指示）。可用版本＝ `build/accelon26.html`（單檔，
> 雙擊開啟即可）。fgdict 已確認：名詞頁（快取字串表＋開頭／中間／結尾）、
> 全文頁、原書分頁（6,959 頁碼）、詞條聯動跳行與塗紅、本文分頁標籤顯示詞名。
> **尚未回歸驗證**：13j／yinshun 在最後幾項修改後沒有重跑（作者要求先集中 fgdict）。
>
> **fgdict 報告（本輪）**：目錄樹改由容器取名（`caches/<tag>`、`<tag>.n`，不再逐節點走內文）
> ＋隱藏的目錄面板不渲染 → 背景樹 **6,400 ms → 390 ms**，名詞分頁開啟即出現（字串表 0 ms）；
> 左欄分頁改由 `<樹>` 宣告即時決定，不等樹。全文面板：筆數與段名**同一行**（分級紅字徽章）、
> 頁籤名＝段名、摘要聯動該段。原書分頁：頁籤名＝頁碼、**不塗紅**、把 `<_頁>` 捲進畫面、
> 連點不重複開分頁。**尚未修好 1 項**：全文面板點段名後，內文塗紅的是段首 token 而非查詢詞
> （已修好）。
>
> **yinshun 報告（同輪）**：目錄樹**只先做第一層標籤**，其餘等畫到那一列才解（`entryLabelsOnly`
> ＋`renderDirTree` 逐列解），名字改由行表取 → 背景樹 **4,030 ms → 51 ms**（13j 7 ms）。
> 命中徽章改在 `lastResult` 更新**之後**重繪（`refreshTreeHits`），輸入一改就重畫、清空即收起。
> Ctrl/Cmd 點節點**一律**開新分頁（原本只在當前分頁不涵蓋時才開）。
> **最後兩項「bug」其實是測試的問題，不是程式的**：
> (a) `Ctrl+點節點開新分頁` 讀的是一次連結後的固定 1400 ms，但那是最後一本書、第一頁要解 24 MB 檔尾的區塊，
> 連結晚到（實測 >1.4 s，且在下一個步驟才落地）→ 改成輪詢分頁數。
> (b) `全文：內文把查詢詞塗紅` 的前一個測試區塊已輸入過「大乘」，我的新區塊輸入「法王」後只等 `.tCount.hit`
> （舊的徽章已存在）→ 拿到**上一次 render** 的列與其 handler（`pinned.token` 是「大乘」）→ 改成等
> `#freqMeta` 出現新詞再點。
>
> **最終**：13j **67/67**、yinshun **75/75**、fgdict **78/78**。

> **本輪（2026-10 後半，多庫之後）依作者五點回報改了：** §3.4／§3.5 有完整說明。
> 一）**切換資料庫變快**：yinshun→fgdict 的同步成本 **381–445 ms → 4 ms**（fgdict→yinshun 34–44 → 3 ms），
> 原因是右欄切分頁時重建了（左欄的）6,966 列目錄樹 —— 修好觸發點＋列改成**分批掛上 DOM**（`lazy-list.ts`），
> 目錄樹／名詞／頻次／原書分頁／西文都只在需要時掛一屏。
> 二）**切換 adb 時樹的狀態不丟**：展開集合與標籤住在 `DirTree`（隨 slot 保存），DOM 只是它的投影；
> probe 實測 yinshun 展開一本書（44→47 列）→ 切到 fgdict → 切回來仍是 47 列且同一個節點開著。
> 三）**本文區空白時顯示資料庫自己的 logo**：從 adb 的 `resources` 取 `<dbname>_logo.*`（yinshun 有，
> 320×480；13j／fgdict 沒有就不顯示）。
> 四）**右欄「文字內容」分頁**（新模組 `text-pane.ts`）：Ctrl+點樹節點＝把該段文字送到右欄（中間不動）、
> Ctrl+點本文分頁＝複製到右欄、Shift+點＝搬到右欄；**右欄純參考，不連動左樹**。
> 五）文字內容頁刻意獨立成模組 —— 下一步要改的是「把行內 XML 標籤變成 HTML」，只會動 `renderTextPane()`。
>
> **測試**：13j **153/153**、yinshun **166/166**、fgdict **167/167**；`check-map-ids.ts` **119/119**；
> 多詞組引擎 `test/multi-search.test.ts` **39/39**（yinshun）；繁簡通檢 `test/variants.test.ts` **13/13**；
> 後端共用測試集 `test/backend-cases.test.ts` **180/180**（含 18 個通檢案例）、架構守門 `test/backend-layout.test.ts` **11/11**；
> Go 端 `wails/query_cases_test.go`（同一份 cases，含 `TestSearchQueryVariants`）與 `go test ./...` 全綠。
>
> **測試策略（作者 2026-10）**：**主要先在 HTML 測好**（`tools/file-protocol-test.ts`
> ＋ `check-map-ids.ts`，快）；**桌面版（Wails3）只在「發布」時才跑**完整
> `tools/desktop-test.ts --gui`（慢：開視窗、下載 16 MB、跑好幾次）。平常真的要看視窗，
> 用 `--gui --quick`（跳過更新／改版說明那幾段）。改完程式碼**不要**習慣性跑 desktop test。
>
> **同月再加一輪：桌面版（Wails3）**，見 §10。`wails/` 是獨立的 Go 模組（極薄：只有 mmap 讀取與
> 列工作目錄的 `*.adb`），UI 仍是同一份 TypeScript 單檔 HTML，**只有 `host.ts` 知道宿主存在**。
> 實測：exe 在倉庫根目錄啟動 → 自動列出 13j／fgdict／yinshun（只讀檔頭），下拉可切換、mmap 讀內文；
> `tools/desktop-test.ts --gui` 11/11。**除非作者說要造 exe 或「準備發佈」，預設只產生 HTML。**
>
> **再後一輪（同月，作者四點＋兩個 bug 回報）**：
> 一）**純文字檔統一 LF**（`.gitattributes`：`* text=auto eol=lf`；當時只有 4 個檔還帶 CRLF）。
> 二）**沒有 `s="*"` 就完全不建目錄樹**：`loadDirectoryTrees()` 只建正好 `s="*"` 的那棵（fgdict 0 實例／0 ms，
> yinshun 只建 `*` 那棵＝8,513 實例）；`groupNames()` 改讀 adb 自己的 `caches/<標籤>`（三庫都對得上），
> 搜尋分組不再依賴 `treeLabels`。
> 三）**狀態列只顯示錯誤與「讀取中」**：`setStatus(info)` 不寫 DOM（訊息仍留在 `__accelon26.status()`）。
> 四）**右上 adb 清單**（現為黃色資料夾按鈕 `#dbPickBtn` ＋ `#dbPickMenu`）：列出這次工作階段選過／拖過的每個 adb
> （只讀 header，未載入的也在），選一個就加入 `dbTabs` 並跳到最左；`dbTabs` 只保留最後使用的 5 個
> （滿了踢最久沒用的）；**點 chip 切換永不重排**。
> 五）**Escape 不再清輸入**：五個輸入框都是 `<input type="search">`，Chromium 內建 Escape 清空 ——
> keydown 必須 `preventDefault()`；測試改用 CDP `Input.dispatchKeyEvent` 送真按鍵（合成事件測不到預設動作）。
> 六）**摘要的「只看該節點」約束屬於產生結果的那個查詢**（`lastQuery`）——重打一個詞就取消，
> 不會因為新查詢還在飛時按了命中數而黏住。

---

## 0. 設計原則：先查 adb 內已有的資料，不要硬幹（遇到新需求先讀這節）

`.adb` 是**光盤（CD-ROM）時代**的格式：那時 random seek 很貴（一次尋道數十至數百毫秒、且無法遮蔽），
順序讀便宜。所以格式的每一個決定都在服務同一件事——**seek 越少越好：一次 seek 就拿到要的東西，之後盡量順序讀**。
這解釋了為什麼：

* 整個資料庫是**一個檔**（header → 容器頭 → 資料區 → 長度表），開檔只要一次 seek；
* `source` 的每一塊是**獨立 bzip2 流且連續存放**：要一塊只讀一段連續位元組；要全文就是一次順序讀
  （整個 source 資料區本身就是合法的 multi-stream bzip2，[FORMAT.md](FORMAT.md) §4 已驗證）；
* 行表 `tables/lines.physical`／`lines.virtual` 是**累積**表：行 i 的位址二搜尋就有，不必掃描；
* **索引與文字分開存**，而且索引把答案**先算好**（見下）。

**所以：作者要新功能時，先問「adb 內是不是已經有這份資料」，不要用內文硬算。**
回讀內文解壓是最後手段——Pascal 原始碼自己就把它註解成 `retrieve from source, Slow!`（`adb.pas: getnNodeValue`）。

### 0.1 先查清單

| 需求 | 先查這個 | 不要這樣做 |
|---|---|---|
| 節點／條目名稱 | `caches/<標籤>`（`AdbReader.cachedStrings`）：字串表，順序＝實例序 | 逐塊 bunzip 切 innerText（慢且容易取錯） |
| 實例屬性（`n` `l` `t` `s` `id`…） | `attributes/<標籤>.<屬性>` 的 values ＋ pointers（低位 24 bits ＝ 1-based 實例序） | 掃內文找屬性字串 |
| 某標籤有哪些實例、各在第幾 | `tags` 容器的命中表 | 掃內文比對標籤文字 |
| 命中數／命中範圍 | `tokens`／`tags` 命中表 ＋ 二分搜尋 | 逐行掃描內文 |
| 行號／頁碼 | `tables/lines.virtual`、`lines.physical`、`blocks.virtual`、`doclengths` | 解壓全文再數行 |
| 某一行／某頁的文字 | 只解該行跨越的 source 塊（`Blob.slice()` ＋ 128 KiB 快取） | 解壓整個 `source` |
| 文件清單／檔名 | `caches/檔`（`documents()`）或 `檔.n` | 走內文找 `<檔>` |
| 全庫有哪些標籤 | `tags` 容器的名稱表（＝建庫時宣告集） | — |

### 0.2 案例（都是「硬幹」被糾正後才對的）

* **fgdict 名詞清單**：第一版對每個碰到的區塊 bunzip 算 `<詞>` innerText → 慢、又容易取錯。
  作者指出 adb 內就有存 `<詞>` innerText 的 string array，改用 `caches/詞`
  （一次容器解析、22,648 筆、與 `tags` 實例同序）才對。
* **fgdict 書名（P0）**：`檔.n` 屬性值是空字串，`loadTree` 的 20,000 標籤預算又切掉後兩本；
  正解是 `caches/書`（7 個書名）補第一層，不是想辦法從內文撈。
* **節點名稱**：能用屬性／快取就別走內文；目前還有兩處會走內文（見 §7 P1 第 6 項）。

---
## 1. 建置與測試指令

```powershell
cd D:\2026\adb-converter\ts

# 建置（產出 ../build/accelon26.html，約 275 KiB 單檔）
bun run tools/build-viewer.ts

# 瀏覽器端（file:// 真實測試；--port 每次換一個避免殘留）
bun run tools/file-protocol-test.ts --adb ..\13j.adb --port 9601
bun run tools/file-protocol-test.ts --adb D:\accelon3\yinshun\yinshun.adb --port 9602
bun run tools/file-protocol-test.ts --adb D:\accelon3\fgdict.adb --port 9603
bun run tools/browser-test.ts --adb D:\accelon3\yinshun\yinshun.adb --port 9604   # http 來源

# 截圖（開檔→搜尋→點節點→Ctrl 開第二個本文分頁→存 PNG）
bun run tools/shot.ts --adb ..\13j.adb --out ..\build\shot-13j.png

# 單元測試（Bun，不需瀏覽器）
bun run test/vapa.test.ts --adb ..\13j.adb
bun run test/accelon26.test.ts --adb ..\13j.adb
bun run test/search.test.ts --adb ..\13j.adb
bun run test/search.test.ts --adb D:\accelon3\yinshun\yinshun.adb
bun run test/tree.test.ts                     # 13j + yinshun 兩庫
bun run test/multi-search.test.ts             # 多詞組 + BM25（預設 yinshun）
bun run test/variants.test.ts                 # 繁簡通檢（表 ＋ 引擎；預設 yinshun）
bun run test/render.test.ts                   # 內文渲染（標題／頁／段／未知標籤）
bun run tools/tag-stats.ts --adb ..\13j.adb   # 內文標籤盤點（哪些有 t=、哪些沒處理）
bun run tools/gen-variants.ts                 # 從 vendor/Unihan_Variants.txt 重產對照表
                                              #   vendor/ 不進 git：先手動下載
                                              #   https://github.com/CNMan/Unicode/blob/master/Unihan/Unihan_Variants.txt
bun run tools/gen-variants.ts --check         # 只檢查產物是否最新（CI 用，不需要 vendor 以外的東西）
bun run tools/gen-lossless.ts                 # 從 vendor/Unihan_Variants.txt 重產「無損簡體」表
bun run tools/gen-lossless.ts --check         # 只檢查簡體表是否最新
bun run test/multi-search.test.ts --adb ..\13j.adb --query "象曰 潛龍"   # s="*"（分群書）
bun run tools/verify-vapa.ts --adb ..\13j.adb --max-hits 2   # VA 對帳（13j 需 100%）

# 後端（作者 2026-10）：Go／TS 共用測試集；只改 UI 時不必跑這些
bun run cases                                 # 重產 test/shared/search-cases.json（以 TS 後端為答案）
bun run test:backend                          # TS 側跑共用測試集 ＋ 後端分界映射
bun run test:go                               # Go 側跑同一份測試集（= cd ../wails && go test ./...）
bun run test/backend-layout.test.ts           # 架構守門：後端不可 import UI

# 操作導覽（作者 2026-10）：劇本 ts/tour/*.tour → 宏 tour-data.ts → 內建的播放器
bun run build:tours                           # 編譯劇本（錯誤帶檔名與行號）；--check 只驗證有沒有過期
bun run test:tour                             # 劇本⇄宏 的編解碼與剖析器（30）
bun run test:tour-ui                          # 真瀏覽器從頭播到尾（24）；--adb 換庫，13j／yinshun／fgdict 各跑一次
```

**每次跑瀏覽器測試前必須清場**，否則 CDP websocket 會 `ws error`：

```powershell
Get-Process msedge -ErrorAction SilentlyContinue | Stop-Process -Force
Remove-Item -Recurse -Force D:\2026\adb-converter\build\.chrome-profile* -ErrorAction SilentlyContinue
```

## 2. 目錄區／本文區行為規格（本輪實作）

一）**聯動行為**：點 `tTwisty`／`tDot`／`tName` 任何一處 →
  可以打開就打開，**並且聯動本文**；已經開著就只收合（也聯動本文到該節點）；
  葉節點直接聯動。點 `tCount`（命中數）→ 右欄「摘要」切成**該節點範圍內的命中**，
  本文只移動到該節點開頭（不改變摘要以外的狀態）。
  **輸入區更新時不聯動本文**，只更新摘要（一次顯示最前 30 筆）；要看命中就點節點的 tCount。
  **輸入區按 Escape 不清空**（作者 2026-10）：文字與結果都留著，只是離開欄位；
  要清空用輸入框的 ✕（`#queryClear`／`#termsClear`／`#freqClear`／`#latinClear`／`#folioClear`），Enter 則立即重搜。
  `#query` 與四個 pane 的輸入框（`wireOwnSearch`）共用這個規則。
  ⚠️ **五個輸入框都是 `<input type="search">`，Chromium 內建「Escape 清空」** —— keydown 一定要
  `ev.preventDefault()`；只是把自己寫的清空程式碼刪掉，欄位還是會被瀏覽器清掉（作者 2026-10 回報
  「fgdict 全文檢索輸入區按 Escape 還是會刪除輸入文字」就是這個）。合成事件的測試**不會**觸發這個
  預設動作，所以回歸測試用 CDP `Input.dispatchKeyEvent` 送真正的（trusted）按鍵來驗。

  **狀態列只顯示錯誤與「讀取中」**（作者 2026-10「取消 span.status（用戶不需要此信息）」）：
  `setStatus(msg, 'info')` 不再寫進 DOM（`#status` 設 `hidden`），但訊息仍記在 `lastStatus`，
  `__accelon26.status()`／`state().status` 讀得到，所以測試與診斷不受影響。載入後的
  「庫名：N 詞、M 文件」、「已關閉資料庫」、「一次選了 N 個」都不再出現在畫面上。

  點某節點的**命中數**（tCount）→ 右欄摘要切成**該節點 realm 內**的命中（標題會說「…範圍內 N 筆」）；
  **重新輸入一個不同的詞 → 這個約束就取消**，摘要回到整個結果（作者 2026-10）。
  實作要點：scope 記的是「產生這份結果的那個查詢」（`lastQuery`），**不是輸入框當下的文字** ——
  用當下文字的話，一個在新查詢還在飛時按下的命中數會把新文字當成「同一個查詢」，約束就黏住了。
  `state().searchQuery` 就是那個查詢，測試用它等搜尋真的落地再點徽章（`file-protocol-test.ts` 的
  「重新輸入不同的詞 → 「只看該節點」的摘要約束取消」）。

二）**本文分頁**：每次聯動只載入當前節點（realm）的**一頁**，底部有「上一頁」「下一頁」。
  頁＝網頁分頁 page（每頁 `PAGE_LINES = 200` 行），**不是**原書的葉／folio。
  只有一頁的節點不顯示分頁列。

三）**Ctrl 開新分頁**：任何會聯動本文的動作（節點、摘要、頻次、西文、token、文件）
  按著 Ctrl（Mac 是 Cmd）就**開一個新的本文分頁**，否則更新目前分頁。
  本文分頁列（`#docTabs`）在有一頁以上時顯示，✕ 關閉、＋ 新開。
  **原本 Ctrl＋點節點名展開全部子孫，已改為 Alt＋點**（Ctrl 讓給「開新分頁」）。

四）**左欄＝每個 `<樹 s="…">` 一頁**，頁名由 scope 決定（`syncTreeTabs`）：

  | scope | 分頁 | 內容 |
  |---|---|---|
  | `*` | 目錄 | `t=` 層級樹＋全文搜尋 |
  | `$詞` | 名詞 | `<詞>` 的每個實例＝一個詞條；輸入時**只比對 `<詞>` 包住的字**，可選 開頭(`^`)／中間／結尾(`$`)／全部 |
  | `*u=文` | 頻次 | 依屬性分段，命中數排序、0 不顯示 |
  | `*詞` | 全文 | 依標籤分段（同一個 pane，只是頁名不同） |
  | `頁.n` | 原書分頁 | `<頁>` 的 `n` 值清單（fgdict 6,959 個），可用選的或**輸入頁碼**跳過去 |
  | `~…` | 西文 | 碼點範圍（作者確認）；有 任意／開頭／中間／結尾 位置篩選 |

  fgdict 因此是「名詞／全文／原書分頁」三頁（沒有 `s="*"` 就沒有目錄頁），
  13j 只有目錄，yinshun 是目錄／頻次／西文。每個 pane 都是**按到才建**（`showTab` 分派）。

五）**tCount（命中數）**：有搜尋時**永遠**顯示該節點 realm `[va, vaEnd)` 內的命中數，
  **與節點開合無關**（沒有搜尋時才顯示子節點數）。顏色分四級：
  由「占全體命中的比例」與「絕對數量」取較高者（`t1`…`t4`），
  最多命中的最亮（亮紅 `#ff1744` ＋ 微光暈），≥1000 再加一級字級。
  點 tCount 把右欄「摘要」切到該 realm。

六）**本文捲動 → 目錄樹同步**：以畫面**中間那一行**（不是第一行）為準，
  對應節點標為 `current`、其所有祖先標為 `ancestor`（只是亮起，**不捲過去、不自動展開**）。
  要展開並捲到該節點，按「文件內容」標題左邊的 🌲「展開樹」小按鈕（`#treeReveal`）。

七）**摘要聯動**會**強制打開右欄**（`setSide('right', true)` ＋ 切到「摘要」頁），
  因為右欄藏起來時摘要就沒有意義。

八）**欄寬的記憶**（作者 2026-10）：`#toggleLeft`／`#toggleRight` 把側欄收起來再打開時，
  要回到**上回調整的寬度**，不是回到 25% 預設。作法是同一個 key（`accelon26.cols.v2`）裡多存
  一份 `last`（`{left,right}`，永遠是「上一次真的顯示時」的寬度）：`saveCols` 遇到 0 不改 `last`，
  `setSide(side, true)` 讀 `last`。**雙擊分隔線仍回到預設 25%**（那是「重設」，不是「還原」）。
  另外中間欄有 20% 下限：兩側相加超過 80% 時按比例縮（`layoutCols`），免得 grid 出現負的 `fr`
  ——拖曳中的即時預覽與放開後存檔走同一個 `layoutCols`，畫面與存檔值不會走鐘。

九）**沒有資料庫時，📁 右邊閃爍「← 開啟資料庫」**（`#dbHint`，作者 2026-10；文案 2026-10 再修短）。
  純 CSS 驅動：`body:not(.loaded) #dbHint { display:inline-block; animation: dbHintFlash … }`，
  `.loaded` 由 `openFile` 成功時加上、`clearDbUi()`（關掉最後一個庫）移除 —— 所以「有庫就消失、
  關光又回來」不需要任何額外的 JS 同步。`prefers-reduced-motion: reduce` 時只留一行亮字、不閃
  （headless Chrome 預設就是 reduce，回歸測試要用 `Emulation.setEmulatedMedia` 才量得到閃爍）。
  這一條的測試順帶抓出一個潛伏 bug：`clearDbUi()` 呼叫 `resetTextPane()` 但 `ui.ts` 沒 import
  （拆模組時的遺漏，`ReferenceError` 讓關庫收尾中斷、chip 留在畫面上）。現在 `no page exceptions`
  也改到**全部動作跑完之後**才檢查，這一類「後面才炸」的錯誤不會再漏。

十）**詞條＝閱讀單位**（`s="$詞"`／`s="*詞"`，作者 2026-10）：這兩種 scope 宣告了「`<詞>` 就是
  內文的分界」，所以**點名詞（或全文）的詞條時，內文只顯示那一個 `<詞>` 實例的 realm**
  —— `linkTo` 的 `opts.realm` 直接吃 `{from: 詞的 VA, to: 下一筆詞的 VA}`，也就是整個詞條
  （詞頭＋釋文），不是整個 `<檔>`。分頁名仍是詞條名，plain click 更新當前分頁、Ctrl 另開
  （與其他聯動一致）。**`s="*"` 的目錄維持現狀**：仍然用樹節點的 realm；`*u=文` 這種屬性分段
  也不套用（`<文>` 不是詞條）。實測 fgdict 第一個詞條：`<詞>@1293–1409 → realm {1293,1409}，
  本頁 8 行`（整條釋文），不是四萬多行的 `<檔>`。

十一）**名詞／全文 搜尋的三個修正**（作者 2026-10 回報「名詞搜尋、全文搜尋無法工作」）：

  1. **名詞清單顯示錯的詞**（真 bug）：`prepare` 用「這一批列在 slice 裡的位移」去取
     `caches/<tag>`，所以一輸入查詢，12 筆符合的列全部顯示字典最前面的 `一、一一、一一心識…`。
     修法：每一列帶著自己在 `segs` 的 `idx`，只補「還沒有名字」的列（`names[row.idx]`）。
     實測「法王」→ `一切如來寶冠三界法王灌頂／大乘法王／大慈法王…`。
  2. **點列像沒反應（慢）**：`linkTo` 一定會 `mapper.elementAt(va)` 走一次 VA→PA 掃描；fgdict 的
     游標可能落後 20 萬行（實測在 #748 條目時點「法王家」＝第 223,814 行），那幾秒就是「點不動」。
     名詞／全文的列自己帶 realm 又用 `exact`（按文字塗紅），**不需要 element** → 直接跳過掃描。
  3. **element 找不到就整支放棄**：fgdict 的大文件裡有空 block，`elementAt` 回 null，
     舊碼 `if (!el && !node) return` 讓那種列永久點不動。現在只要呼叫端給了 realm 就照樣聯動
     （行號本來就來自 line table，不靠 walk）。

  另外兩個 pane 都加了**過期結果丟棄**（`termsSeq`／`freqSeq`）：非同步的字串表／搜尋回來時
  若已經有新查詢，舊的那一輪不再改清單 —— 否則快速輸入時舊結果會蓋掉新結果。

十二）**多關鍵字搜尋＋BM25**（2026-10，TypeScript 版已實作；作用於 `s="*"`／`s="*tag"`／
  `s="$tag"`／`s="*u=值"`）。

  **語法**（`query.ts`）：空白或運算子都是分隔，`+`／`-`／`*` 是**前綴**，作用在後面那一個詞組：

  | 寫法 | 意思 |
  |---|---|
  | `緣起 性空` | 兩個詞組都算分（optional，OR）：至少命中一個，命中越多分數越高 |
  | `緣起 +性空` | `性空` 是必要（required，AND）；其餘照舊算分 |
  | `緣起 -性空` | `性空` 不能出現（excluded；不上色） |
  | `緣起*性空` | 兩個詞組的距離 ≤ `PROXIMITY_TOKENS`（20）且落在同一份文件 |

  詞組內部仍要求 **token 相鄰**（「緣起」＝緣＋起），與索引既有的片語規則一致。

  **文件（BM25 的單位）**（`search.ts: segments()`）：優先 `s="*u=值"`（屬性分段，yinshun：40 個
  標籤、6,978 個節）→ `s="*tag"`／`s="$tag"`（fgdict：`<詞>` 22,648 個）→ 結構標籤
  **書／章／節**（13j：1,329 段）→ **頁／_頁** → 分群標籤 → 整個庫（完整規則見十四）。
  **文件長度＝tag 位置的 VA 差值**（`to - from`），
  不讀本文 —— VA 就是 token 位置，差值就是 token 數（作者指定要省下來的開銷）。

  **BM25**：`idf = ln(1 + (N - df + 0.5)/(df + 0.5))`、`k1 = 1.2`、`b = 0.75`，
  `score = Σ idf · tf·(k1+1) / (tf + k1·(1 - b + b·dl/avgdl))`。文件依分數排序，命中再依
  「文件排名 → VA」排序，所以摘要清單自然是「最相關的先」。

  **選引擎**（`SearchSession.searchAuto`）：單一詞組、沒有運算子 → 走舊的片語引擎（行為完全
  不變，還有分群與桌面版 Go 查詢）；有空白／運算子 → 多詞組 + BM25。摘要、全文（`*u=值`／
  `*tag`）、名詞（`$tag`；詞條名比對 `+`／`-`）都換成 `searchAuto`。

  **顏色**：每個正面詞組一個 HSV 色相（`query.ts: clauseHue`，0 號紅、往後轉 300°），
  摘要卡片與本文都用同一組色相：`mark.kw`／`mark.docHit` 吃 `--hue`。排除詞不上色。
  本文由 `paint.ts: paintKeywordMarks()` 逐行（純文字節點）塗色，長詞優先、不重疊。

  **實測（yinshun）**：`緣起*性空` 190 份文件／3,101 命中、`緣起+性空` 552／4,688、
  `緣起 性空` 1,078／6,683、`緣起-性空` 526／1,995（引擎全量；UI 只取前 300 份文件）。
  測試：`test/multi-search.test.ts`（引擎，含「鄰近 ⊂ 必要 ⊂ 可選」的集合關係）＋
  `file-protocol-test.ts` 的多詞組斷言（詞組解析、分段、集合關係、三種顏色）。

  **還沒做**：桌面版的 BM25 仍在 JS（Go 只服務單詞組查詢）；`$tag` 目前只比對詞條名，
  詞條內文的 BM25 尚未接上。

十三）**單字萬用字元 `.`**（作者 2026-10）：`菩.心` ＝ 菩 ＋ **任意一個 token** ＋ 心
  （菩提心、菩薩心…），`菩.心-菩提心` 則是「菩與心之間不是提」的那一種
  （排除詞照常以片語比對）。

  * 解析：`query.ts: normalizeClause()` —— `.` **只有在「前後都是漢字」時才算萬用字元**
    （`菩.心` ✓、`菩.提.心` ✓、`菩..心` ＝ 兩個）；**其他位置的 `.` 是 skipword，直接丟掉**
    （歷史上 `.` 會被索引起來，其實它該被丟棄，所以查詢裡不把它當 token：
    `a.b` → `ab`、`菩.a` → `菩a`、`.菩.心.` → `菩.心`）。
    中間的 `.` **最多保留 `MAX_WILDCARDS`＝10 個**，多的忽略。
  * 引擎選擇：整理後還有 `.` 的查詢**一定走多詞組引擎**（舊的片語引擎不認得它，會當成沒命中的 token）。
  * 比對：`search.ts: phraseMatchPattern()` —— 以第一個「有實際 token」的清單當錨點，
    回推詞組起點，其餘位置用 binary search 在各自的 posting list 裡驗證；沒有 `.` 時
    直接退回原本的 `phraseMatch()`（同一套規則，只是快一點）。
  * 名詞分頁：`query.ts: namePattern()` 把 `.` 當「任一個字」（詞條名是字串，不是 token），
    同樣先 normalize。
  * 塗色：萬用字元的實際文字只能由 VA span 取得（`searchSummary` 無 phrase 的路徑），
    所以摘要卡片標的是 `s.start..s.end` 那個真實片段，而不是查詢字串。
  * 實測（yinshun，引擎全量）：`菩.心` 1,506 筆、`菩提心` 1,408 筆、
    **`菩.心-菩提心` 32 筆（剩下的就是菩薩心那一些）** —— 這個例子才看得出「萬用字元
    ＋排除」是同一個詞族裡的篩選，而不是把結果全部清空。
    `菩..心` 150 筆（菩薩發心、菩提的心…）、`大.乘` 125 筆（大小乘…）、
    `大..乘` 44 筆（大小二乘…）——命中的長度正好等於詞組的 token 數。
    UI 只取前 300 份文件，所以摘要那兩條是 435 → 27 份文件。
  * 注意：`.` 是「任意一個 **token**」，所以標點（例如 `大）乘` 的全形括號）也算一個
    token —— 想要只比對文字得另外排除標點，目前沒做。

十四）**文件分界的退回階梯**（作者 2026-10）：

  ```
  s="*u=值" / s="*tag" / s="$tag"           ← scope 自己宣告的文件單位
      ↓ 沒有宣告
  書 → 書＋章 → 書＋章＋節（100 token 門檻）  ← 由粗到細，取第一個「平均 ≤ 8KB」的層級
      ↓ 連最細的結構層級都還是 > 8KB
  頁／_頁                                    ← 最後的細分界
      ↓ 都沒有
  分群標籤（13j 的 13 本 書） → 整個庫
  ```

  **100 token 門檻**（`MIN_SEG_GAP`）：相鄰兩個分界相距不到 100 token 就**不算新文件**
  —— `<書>` 和它的第一章、某章和它的第一節之間不是兩份文件。做法是把該層級所有標籤的
  實例 VA 併起來排序，再逐個「離上一個留下的分界 ≥ 100 才留」。

  **1KB–8KB 的目標帶**（`MIN_AVG_DOC`＝1024、`MAX_AVG_DOC`＝8192 token，作者 2026-10
  「1~8KB 之間都可以接受，比用 `<頁>` 好」）：書／章／節 由粗到細試，**取第一個平均長度
  ≤ 8KB 的層級**。所以 13j 選的是 **書／章（254 段、平均 3,223 token ≈ 3.1KB）**，
  而不是更細的 書／章／節（1,329 段、平均 616 token —— 掉出 1KB 下限，一份文件太小）。
  只有在「連最細的層級都 > 8KB」時才退到 頁／_頁。

  診斷：`test/multi-search.test.ts` 會印 `attr:`／`tag:`／`hier:書/章`／`page:`／`group:`／
  `whole`、段數與平均長度，並斷言 hier 的平均落在 1–8KB。

十五）**目錄的兩個 UI 規則**（作者 2026-10）：

  1. **`#dirMeta` 只在進階模式顯示**（層級／節點數／展開列數／`s="…"`）—— 一般讀者不必看到。
     在 `renderDirTree()` 收尾時設定 `head.hidden = !advanced`；切換進階模式時
     `setAdvanced()` 若正在看目錄會重畫一次（只更新那一行，不是重建整棵樹的資料）。
  2. **再點一次已經 active 的「目錄」分頁 → 把所有子孫收起來，整棵樹只留第一層**
     （`scopes.ts: collapseDirTree()`：清空 `d.open`、重畫、捲回頂端）。
     ui.ts 的 tab 點擊改成「先記住 active 再 showTab」，只有目錄分頁有這個第二段行為；
     其他分頁再點一次沒有特別效果（fgdict 沒有目錄分頁，不受影響）。

十六）**`#docTitle` ＝上一輪引擎耗時**（作者 2026-10）。新模組 `engine-stats.ts` 只存兩個
  最近量測，兩個地方呼叫它：搜尋完成（`summary.ts` → `noteSearch`）、本文聯動完成
  （`link.ts` → `noteLink`）。

  * 標題文字：`文件內容（搜尋 4.1 ms・取文 3 ms）`；清空查詢或換庫就回到預設的
    `文件內容（硬分行；未渲染 XML）`（`resetEngineStats()`）。
  * hover（`title` 屬性，多行）：
    ```
    上一輪引擎耗時
    搜尋：4.1 ms（4 個 token、1,646 筆命中、526 份文件）
      token／posting：緣(15,325)　起(19,667)　性(22,582)　空(17,769)
      文件分割：attr:*u=文　6,978 段
      查詢：緣起-性空
    取文字：3 ms（確保頁面 3 ms、25 列、VA 1,977,299）
    ```
  * posting 長度由 `SearchSession.lookups()` 提供（每次 `search`／`searchMulti` 開頭清空，
    `lookup()` 順手記一筆）。桌面版單詞組查詢由 Go 一次算完、沒有回傳 posting 長度，
    所以顯示「宿主回答」。
  * 「取文」那段量的是 `linkTo` 裡 `ensurePage`＋捲動＋亮樹的時間（`lastLink` 的
    totalMs／ensureMs 同源，只是現在也寫進標題）。

十七）**繁簡通檢**（作者 2026-10）：系統級開關，對所有 adb 生效。
  * **對照表**：`cd ts && bun run tools/gen-variants.ts` 讀 `vendor/Unihan_Variants.txt`
    （Unicode 18），把 kTraditionalVariant／kSimplifiedVariant 的關係用 union-find 併成
    「同一組字」，輸出 `ts/src/accelon26/variant-data.ts`（一行字串，組與組之間 `|`）。
    **5194 組、10510 個字、10632 條關係**；`萨薩`、`发發髮`、`乾干幹`、`裏裡里` 都在同一組
    （傳遞併組會把「里」與「裏」放一起 —— 通檢是取超集，寧可多找到）。
    `--fields` 可以加 `kZVariant` 之類的欄位做更寬的異體通檢。
  * **資料來源不進 git**：`vendor/Unihan_Variants.txt` 來自
    <https://github.com/CNMan/Unicode/blob/master/Unihan/Unihan_Variants.txt>，
    `.gitignore` 已排除 `vendor/`，工具也**不會**自己去下載（檔案不存在時直接告訴你
    來源網址並結束）。**產物 `variant-data.ts` 有 commit**，所以建置與測試都不需要 vendor/；
    只有要重新產生對照表時才要手動放進 `vendor/Unihan_Variants.txt`。
    大小約 40 KB（bundle +59 KiB，作者 2026-10 表示可接受）。
  * **開關**：header 的 `#varToggle`（「繁簡」），存 localStorage `accelon26.variants`，
    點一下對**所有已開的庫**都生效；有查詢時立刻重跑一次。
  * **引擎**：`SearchSession.lookup()` 在通檢模式下把單一漢字換成整組字，逐一取 posting
    後**聯集去重**（`variants.ts: expandToken`）；合併結果按「整組」快取（key 前綴 `\u0001`），
    所以關掉之後不會用到合併過的快取。桌面版的 Go 單詞組查詢在通檢模式下**改走 JS**，
    確保與網頁版結果一致。
  * **名詞分頁**：詞條名比對改用 `variants.ts: variantNamePattern()`（每個字換成 `[萨薩]`
    這樣的字元類），所以「菩萨」也找得到「菩薩」詞條。
  * **實測（yinshun）**：關著時「菩萨」0 筆（索引沒有「萨」）；開著時「菩萨」與「菩薩」
    都是 12,388 筆且 VA 完全相同。fgdict 名詞分頁「菩萨」→ 200 個「菩薩…」詞條。

十八）**內文渲染成 HTML**（作者 2026-10）：獨立模組 `render_accelon3.ts`（未來可再加
  `render_md.ts`），**不放在 viewer.ts**。doc-pane 與 text-pane 都呼叫它。

  * 標題＝`t=` 定義的層級標籤（`TreeNode.tag` → `depth`）。字級：**每往上一層 +2px**，
    以 `min(calc(1em + Npx), 2em)` 表達 —— **最多不超過本文的 200%**，換字級時會跟著算。
    字色＝該層的**亮色**主題變數 `--tag-text-N`（比 tDot 的 `--tag-N` 亮、彩度高）；
    標題不用底色（作者 2026-10：底色在深色主題上不明顯）。
  * **字級控制移到各自的欄**（作者 2026-10）：左欄的 `#fsLeftPick` 在左欄分頁列、
    中欄的 `#fsBodyPick` 在本文工具列、右欄的 `#fsRightPick` 在右欄分頁列。
    三者都**沒有文字標籤**，顯示成黑底白字的「小 T／大 T」（`.fsT`，純 CSS，不用圖）。
  * **字級是「按鈕」不是下拉**（作者 2026-10 第二版）：`doc-pane.ts: stepFontSize()`
    * 點一下 **+2px**；加完**超過 32px 就回到 12px**
    * 按住 **Alt** 點：**−2px**；到最小 12px 後再點也不會變（不會繞回 32）
    * 三顆按鈕共用同一支，範圍 12–32px；提示文字（title）會顯示目前 px 與操作方式
      （`syncFontButtons()`，`setDocFont`／`setSideFont` 都會更新）。
  * 右欄字級也會套到右欄的「文字內容」
    （`.docBody` 在中欄用 `--fsdoc`，在右欄被 `#colRight .docBody` 蓋成 `--fs-right`）。
  * **「不換行」自動字級已移除**（作者 2026-10：讓讀者自己用按鈕調整）。開啟資料庫也不再
    自動改字級（預設 `DOCFS_DEFAULT`＝16px）；`autoFitFont()` 只留在 `window.__accelon26`
    供診斷／測試。
  * 內文標題用**字色**（`--tag-text-N`：比 tDot 亮、彩度高，深色底上看得清楚），
    不用底色（作者 2026-10：底色在深色主題上不明顯）。釘住的那一行只有淡淡一層
    `rgba(255,212,121,.10)`，免得標題看起來像有底色。

二十一）**原書分行**（作者 2026-10）：本文工具列的 `#hbToggle` → `#showHardBreaks`，
  預設**開**（保留原書的硬換行）。存 localStorage `accelon26.hardbreaks`。

  * **開**：每一行都是 `div.docLine`（硬換行），`<頁>` 是右靠的 `.pageBreak` 分隔。
  * **關**：不保留硬換行 —— `renderPageBlocks()` 把連續的內文行合成 `<p class="docPara">`
    連排（行本身是 `span.docLine id="Ln"`，所以捲動／塗紅照樣對得上）；
    **標題**與**空行**（連續兩個以上的換行）才換段；`<頁>` 變成行內的小字頁碼
    `.pageMark`（`〔12〕`），不是分隔線。英文行相接時補一個空白，中文不補。
  * **塗紅在渲染 HTML 之前完成**：`RenderOptions.marks` 讓 renderer 邊產生 HTML 邊把
    關鍵字包成 `<mark class="kw" style="--hue:…">`（作者：事後在 DOM 找字容易抓錯，尤其
    關鍵字跨行時）。所以 `.docBody.reflow` 下 `paintKeywordMarks()` 直接跳過，不重做。
  * 中欄與右欄「文字內容」都吃同一個設定（`hardBreaksOn()`）。

二十二）**設置頁（扳手 🔧）**（作者 2026-10）：header 的 `#settingsBtn`（🔧）開啟置中彈窗
  `#settingsBox`。原本的 🧑‍💻（進階模式）與「繁簡」按鈕都收進來，header 只剩三個圖示
  （◧／◨／🔧）。左上角標題是 `Accelon26`（亮灰 `#d9d9d9`，`26` 仍是金色）。

  * **介面**：`#setPageMarks` 顯示原書頁碼（進階模式已移到最下面，見下）。
  * **進階**（作者 2026-10：搬到設置頁**最下面**一區）：`#setAdvanced` 進階模式
    （token 瀏覽、META／容量／文件／圖片、顯示原始文件）。
  * **介面．顯示原書頁碼**（`#setPageMarks`，作者 2026-10）：決定 `<頁>`／`<_頁>`／`頁元`
    要不要渲染。開（預設）＝照常（原書分行是右靠頁分隔＋頁碼，連排是行內 `〔n〕`）；
    關＝**整個標籤不渲染**（沒有頁碼、也沒有分隔線），中欄與右欄「文字內容」都一樣。
    狀態存在 `localStorage['accelon26.pagemarks']`，切換時 `rerenderDoc()` 立即重畫。
  * **繁簡．輸入通檢**：`#setVariants` —— 查詢時把一個字的所有寫法合併（`variants.ts`）。
    說明用一般人的例子（打「菩萨」也找得到「菩薩」、打「台」也找得到「臺」「檯」）。
  * **繁簡．文字顯示**（`#simSeg` 三態，作者 2026-10）：
    * `保持原樣`（0）—— 不動
    * `無損簡體`（1）—— 只轉「一對一」的繁→簡；發／髮→发、乾／幹→干、裡／裏→里、
      臺→台 這種合併字**保留原字**，避免簡化造成誤解（作者舉例：中醫）
    * `強制簡體`（2）—— 全轉（Unihan kSimplifiedVariant）
  * **設置頁有範例**（`#simDemo`）：同一句「頭髮乾燥，臺灣的醫生後來又發心。」三列並排，
    **不一樣的字**用黃色虛線底線標出（無損 5 個、強制 9 個），目前模式那一列會突顯，
    切換時立刻重畫 —— 一眼看出「無損」保留了 髮／乾／臺。
  * **字級按鈕**（`button.fsStep` ＋ `.fsT`）：`<button class="fsPick iconOnly fsStep"
    id="fsBodyPick" data-fs="body"><span class="fsT">TT</span></button>`，點一下 +2px、
    Alt+點 −2px（12–32px，超過 32 回 12）。沒有 `<select>` 了（第二版改的）。
  * **資料**：`ts/src/accelon26/simplified-data.ts`（`tools/gen-lossless.ts` 從
    `vendor/Unihan_Variants.txt` 產生；每兩個字一組「繁,簡」）。無損 **2641** 組、
    強制 **2810** 組。只收 BMP 的字（產物是「兩字一組」的字串，非 BMP 會對不齊）。
    讀過 `D:\2023\ptk\lossless-simplified-chinese` 的做法後自己算的。
  * **無損的判定**（作者 2026-10）：
    1. 簡體字本身不能是常用繁體字 —— 人工表 `LOSSY_TARGETS`（后、台、里、干、只、几、
       云、面、松、咸、借、谷、舍、系、复、于、郁、冲、准、胡、采、累、布、卷、秋、千、
       卜、出、板、表、别…）。**所以「後」在無損模式保留原字**（否則「王后／王後」分不出）。
    2. 繁體字只能對到這一個簡體字。
    3. 簡體字的其他繁體寫法必須都是**同一個字的異體** —— 用 union-find 併
       `kZVariant`／`kSemanticVariant`／`kSpecializedSemanticVariant` 的關係，
       同一組才算（說／説→说、眾／衆→众 可以轉；發／髮、乾／幹 不行）。
    4. 這個繁體字自己也在那一組裡（否則就是把兩個不同的字併在一起）。
  * **只影響顯示**：索引、搜尋、塗紅比對仍在原文；塗紅要畫的字（片語／data-src 切片）
    也先用同一個轉換再找字（`paint.ts`），所以簡體顯示下仍畫得對。
  * 設定都是系統級（存 localStorage：`accelon26.advanced`、`accelon26.variants`、
    `accelon26.simmode`），換庫不變。
  * **顏色全部走主題變數**：`:root` 的 `--tag-0..--tag-7`；`depthColor()` 回傳
    `var(--tag-N)`，內文標題的 `--tagc` 也用同一組。換 theme 只改 CSS，不必改程式。
  * 標題後面那串統計（`.docHead .dim`：頁數／行號／source 區塊／字數）**只在進階模式顯示**
    （CSS：`body:not(.advanced) .docHead .dim { display: none }`；中欄與右欄「文字內容」都適用）。
  * **詞典型 adb 不顯示 `docHead`**（作者 2026-10）：詞條名稱已經在分頁標題上，而第一個
    詞條字串通常就是命中、會被塗紅 —— 再放一次標題就變成同一個詞顯示三次。判定在
    `db-kind.ts: detectDictDb()`，只看來源前幾行（**作者指定：有 `$詞` 就算詞典型**）：
    1. `<樹 s="$詞">`／`<樹 s="$字">`／`$詞條`／`$字頭` —— **主要依據**
       （佛光大辭典沒有 `isdict`，靠這條認出來）
    2. `<集 … c="… isdict …">` —— **補充**（康熙字典、漢語大詞典有；會漏掉沒標的庫）
    3. 保險：`詞`／`字` 標籤有現成且對得上的名稱表（就是詞條表）
    都沒有 → 一般文本（13j、印順）照常顯示。`state().dict` 會回報這個判定。
    注意 JS 的 `\b` 只認 ASCII，`<集\b` 永遠不匹配非 ASCII 的字 —— 要用「空白或 `>`」當邊界。
    詞典查詢（`dict-lookup.ts: declaredEntryTags()`）也用同一條規則：先讀 `<樹 s="$X">`
    的宣告決定詞條標籤，沒有宣告才退回 `詞`／`字`／`詞條`／`字頭` 的候選。
  * **摘要卡片也渲染標籤**（作者 2026-10）：`summary.ts: snippetHtml()` 用同一個 renderer，
    但 `hardBreaks: false`（文字連著排、不硬換行）＋ `headScale: false`（標題**只上色、不放大**）。
    關鍵字在渲染前用文字比對上色；這張卡片的命中字多一個 `cur`。
  * `<頁>`／`_頁`／13j 的 `頁元` → 右靠的分隔（`.pageBreak`：虛線＋頁碼 `data-page`）。  * `<段/>` → `<br class="para">` ＋ 兩個全形空格（縮排放在 `.paraIndent`，塗紅會跳過它）。
  * 沒有 `t=` 定義的標籤：標籤丟掉、文字照留；`樹`／`隱` 是建庫資訊，連內容一起隱藏。
  * 跨行的標題（`<章>` 開在第 1 行、`</章>` 在第 9 行）：renderer 用一個堆疊，每行開頭
    重新開、行尾收掉，所以每一行的 HTML 都平衡。
  * 塗紅現在走「所有文字節點」（不再假設 `.lineText` 只有一個 text node），並跳過
    renderer 合成的文字（頁碼、段落縮排）；每一行也帶 `data-src`（原始行），
    索引算出的字元位移先用 `data-src` 取回那幾個字再找字塗色，所以渲染後不會偏。
  * **進階模式的「顯示原始文件」**（`#rawToggle` → `#showRaw`）：勾了就不渲染；
    預設關閉＝讀者看到渲染後的樣子。狀態存 localStorage `accelon26.showraw`。
  * 標籤盤點工具：`bun run tools/tag-stats.ts --adb <path>`（見 §7 的統計）。

十九）**軟件說明（About）**（作者 2026-10）：點左上角 `#brand` → 置中彈窗（`about.ts`）。

  * 內容：左上角 88px 的大 logo（直接借用 favicon 的 data URI，不重複內嵌）、
    大標題「開放古籍平台」、小字「Accelon3 跨平台平替」、官網
    <https://shutonggui.cn/accelon26/>、版本（建置時間）、執行環境、程式檔位置。
    建置時間由 `tools/page-build.ts` 注入 `window.__ACCELON_BUILD__`；桌面版改用
    宿主 `AppInfo` 回報的 exe 時間（比較準）。
  * **開啟時才檢查更新**（沒有背景輪詢），判定依據只有「比目前建置時間晚」：
    * 桌面版：`main.AdbHost.CheckUpdate`（Go 拿線上 exe 的 Last-Modified 比
      `AppInfo.buildTime`）→ 有新版顯示「下載更新」，走 `InstallUpdate`
      （下載到暫存、帶 `-updated-from` 啟動新 exe、自己結束 → **執行中的程式不會
      被直接改寫**）。
    * 網頁版：沒有 exe 可換，best-effort 抓 `version.json`（`{ "buildTime": … }`，
      需 CORS）；抓不到就顯示「無法檢查更新」，不擋任何操作。
  * 沒有新版 → 「已是最新版本」；失敗 → 「無法檢查更新（原因）」。
  * **網頁版沒有自動更新**（作者 2026-10：等回到 Go／桌面版再做）：About 只顯示
    「重新載入頁面即可取得最新版」，不連網。`version.json` 的位置留在
    `about.ts: VERSION_MANIFEST`，未來要接再開。
  * Esc／點背景／✕ 關閉。左上角仍有「有新版本」的閃動提示（`update-ui.ts`），
    但點擊一律開 About，更新按鈕在 About 裡。

二十）**本文上方的 breadcrumb 與跨節點翻頁**（作者 2026-10）。

  * 本文上方（`#docTrail`）是 **breadcrumb**：把目前本文的**所有祖先節點**由外到內排成一條路，
    後面再接上**目前這一節的 siblings**（作者 2026-10：不用先開選單就能左右換節）。
    它放在 `.docBody` 裡面、`font-size: 1em`，所以字級**正好等於正文**；顏色用
    標題那組主題變數 `--tag-text-N`。
  * **短標籤**（`doc-pane.ts: trailLabel()`）：標籤裡有分隔符（空白／全形空白／
    `、，。：；·｜／/ - — _`）→ 只取**分隔符之前**那段（「甲二　正宗分」→「甲二」）；
    沒有分隔符 → 最多 **5 個字**。完整標籤留在 `title` 與下拉選單裡。
  * **siblings 晶片**（`.trailSib`）：目前這一節用 `.cur` 突顯（藍底＋左側色條，不可點）；
    點別的晶片**直接換到那一節**（`revealHit(mode:'node')`，分頁／塗紅／游標都一致）。
  * **點祖先格 → 下拉同層的所有節點**（`scopes.ts: siblingsOf(va)` → `#trailMenu`），
    目前這一個用 `.active` 突顯；下拉**不節略**（`text-overflow: clip`、不設 `max-width`，
    完整標籤；實測 yinshun 最長 16 字沒有被截斷）。點空白處或再點一次收起。
  * **上一頁／下一頁**：小節（少於一頁）以前整個 pager 被藏起來，現在只要「有上／下一個
    節點」就顯示；走到頁面邊界時改成換到**上／下一個 text node**
    （`link.ts: stepRealm()` 用 `treeOrder()` 的 DFS 順序，走 `revealHit(mode:'node')`
    同一條路，所以分頁／塗紅／游標都一致）。

二十四）**搜尋所有 adb（放大鏡）與「詞典」分頁**（作者 2026-10）。

  * **`#searchAllBtn`（🔍，就在 📁 右邊；沒有打開任何 adb 時隱藏）** → `#allSearchBox`：
    輸入查詢 → `#allSearchGo`（或 Enter）→ `allsearch.ts: runSearchAll()` **依序查每一個 catalog
    裡的 adb**，**每查完一個就重畫一次清單**（`renderCount` 可從 `searchAllState()` 看到），
    最後**依命中數由多到少排序**（同數按庫名）。清單一列 = 庫名（同名不同檔補檔名）＋命中數＋ms。
    標題是 **「搜尋 n 個數據庫」**（`#allSearchTitle`，開啟時依 `catalog.length` 更新）。
    點一列 → 打開那個庫（`openCatalogEntry`，等庫真的開好），再把查詢詞帶進
    **左欄目前 active 的分頁**的輸入框（`dir→#query`、`terms→#termsQuery`、
    `freq→#freqQuery`、`folio→#folioQuery`、`latin→#latinQuery`；作者 2026-10）。
    查詢用的是**暫時的 reader**（`AdbReader.open(new BlobIO(file))`
    ＋ `SearchSession.search()`），所以不會佔用 `openDbs` 的 5 個名額，也不會動到讀者的本文。
  * **名詞分頁的比對位置是三態 toggle**（`#termsMode`，作者 2026-10）：按一下換
    **開頭 → 中間 → 結尾 → 開頭**（沒有「任意」）。一般模式 `#termsMeta` 收起，
    符合的詞條數直接顯示在按鈕右邊的 `#termsCount`；進階模式才顯示 `#termsMeta` 的完整統計。
    多詞組（`+`／`-`／空白）也吃這個模式（否則 `法王 -大慈` 會用 includes 比對，
    列出的詞條反而比單詞查詢多）。
  * **名詞分頁的結果依輸入詞塗紅**（作者 2026-10）：`markName()` 把詞條名裡對到的
    片段包成 `<mark class="kw">`，純文字比對是「所有出現位置」（`法王` 在「大乘法王」只塗
    中間那兩個字）；多詞組時塗第一個必要詞（`法王 -大慈` → 塗「法王」）。
  * **名詞分頁的輸入支援萬用字元 `.`**（作者 2026-10）：`.` ＝ 任一個字元
    （`般.經` → `般若經十喻`、`般若經典`），比對用 `query.ts: namePattern(text, mode)`，
    會**依三態模式加上錨點**（開頭 `^body`、結尾 `body$`、中間不錨定），塗紅也用同一個樣式。
    前後的 `.` 沒有意義（`normalizeClause` 會丟掉），所以 `法.` 等於 `法`。
  * **右欄「詞典」分頁**（`#dictList` 上、`#dictBody` 下）：
    1. 在中間本文**點任何一個字**（`initDictPane()` 在 document 的捕捉階段掛 click）→
       `sentenceFrom()` 從那個字往後取到標點（`。，、；：！？…「」『』（）〔〕【】〈〉《》`）或 24 字。
       點在塗紅的詞上時直接用那個 `mark` 的文字定位（caret 常常落在字與字之間）。
       **一次試幾個起點**（`sentencesAtElement()`：caret、caret-1、caret-2、caret+1），
       取第一個查得到詞條的 —— 作者回報「順世者的斷見」點在「順世」上時 caret 可能落在
       「者」，只試一個起點就會查不到。
    2. 對**每一個詞典型 adb**（`catalog` 裡有 `<樹 s="$詞">` 這類宣告、且該詞條標籤有
       現成名稱表 `caches/<tag>` 的庫；`dict-lookup.ts: entryTagOf()`＋`declaredEntryTags()`）
       做**開頭模式查詢**：句子由長到短的前綴各二分搜尋一次（詞條名稱表已排序）。
       **只有完全查不到「剛好是前綴」的詞條時**，才退回「以這段話開頭」的詞條
       （作者 2026-10：`順世` → 詞典只有 `順世外道`，要能找到；而 `般若經` → 詞典有
       `般若`，就**不該**再帶出 `般若經十喻`／`般若經典`）。
    3. 結果**依詞條長度由大到小**列出；點一列 → `renderEntry()` 把那個詞條的正文渲染到下半部
       （詞典型 adb 本來就不顯示 docHead）。
    4. **正文下面還有「開頭」／「結尾」兩個分頁**（`relativesOf()`）：列出以這個詞條
       開頭／結尾的其他詞條，讓讀者沿著詞條往下挖。開頭排序是**和點到的那句話共同前綴較長者
       優先**（`般若` → `般若經典`、`般若經十喻` 排在 `般若學`／`般若二種相` 前面）；
       結尾短的先（`三般若`、`二般若`、`深般若`…）。點任何一個「親戚」就把它變成清單的一列。
  * 詞條名稱表與 `tags` 的實例 VA 一一對應（`cachedStrings(tag)` 與 `decodeBlockList('tags', i)`
    長度相同才用），所以不必掃本文；索引建一次就快取（`dictIndexState()` 可看）。
    實測：佛光大辭典 22,648 條（`詞`）、康熙字典 46,024 條（`字`）、漢語大詞典 353,116 條。
  * 驗證（fgdict）：點「比丘尼戒」→ 詞條 `比丘尼`、`比丘`（長的先列）；點「比丘」→
    下半部顯示「比丘梵語bhikṣu…」；點「般若經」→ 只有 `般若`；`般若` 的開頭清單是
    `般若經典`、`般若經十喻`、`般若學`…，結尾是 `三般若`、`二般若`…。
    非詞典型 adb（13j／印順）則顯示「沒有詞典型 adb」。

二十三）**後端分界（Go／TS）與共用測試集**（作者 2026-10，目標：UI 改動不必跑 Go 測試）。

  * **一句話**：後端只回答「詞組出現在哪些 VA」（`ClauseHits`）；分段、BM25、
    塗色、畫面都在前端。Go 與 TS 各有一個後端實作，回傳同一個形狀，前端只透過
    `backend.ts` 呼叫。
  * **誰是後端**（不可以 import 前端模組，`test/backend-layout.test.ts` 會擋）：
    `adb.ts`、`vapa.ts`、`search.ts`、`query.ts`、`backend.ts`、`lossless.ts`、
    `variants.ts`、`simplified-data.ts`、`variant-data.ts`。
  * **契約**（`search.ts: ClauseHits`）：
    `{ text, tokens, role, nearOf, wildcard, missing, occurrences, hits[{va,units}],
       colorIndex }`。**只有一條查詢路徑**（作者 2026-10 重構）：
    `backend.ts: queryBackend()` → `ClauseHits[]`，然後
      - 單詞組、沒有運算子 → `SearchSession.singleResult()`（不排名、照 VA 排、附分群統計）
      - 有空白／`+`／`-`／`*`／`.` → `SearchSession.rankClauses()`（分段＋候選文件＋
        `*` 鄰近＋排除＋BM25，也順便算分群統計）
    舊的「單詞走舊片語引擎、多詞走另一條」分岔、以及 Go 的 `SearchTokens` 都刪掉了
    （Go 現在只有一個查詢入口，分群統計改由 TS 的 `groupStats()` 算）。
  * **Go 後端**（`wails/query.go`）：`AdbHost.SearchQuery(path, query, maxHits, groups)`。
    自己解析查詢（空白／`+`／`-`／`*`／`.` 萬用字元、最多 10 個 `.`）、自己切 token
    （CJK 一字一 token、拉丁字連成一串），再解 posting ＋ `phraseMatchPattern()`。
    Wails 用 `ByName` 動態呼叫，不需要 codegen。
  * **繁簡通檢也走 Go**（作者 2026-10）：`groups` 是**變體表**（每個字串一組互為異體的
    單字，例如 `"萨薩"`）。TS 只挑「這一串查詢用得到的組」（`backend.ts:
    variantGroupsFor()`，通常 0–3 組，不必把 40 KB 整張表送過去），Go 用
    `unionPostings()` 把同組字的 posting 合併（遞增、去重）—— 那是整個查詢最花時間的
    部分，放在 Go 做。網頁版沒有宿主時，TS 用同一張表自己聯集（`SearchSession.lookup()`）。
  * **前端**（`ts/src/accelon26/backend.ts`）：`backendKind(io)`（`go`／`ts`）、
    `variantGroupsFor(query)`、`clauseHitsFor()`、`searchMultiVia()`、`searchAutoVia()`
    （規則與 `SearchSession.searchAuto()` 相同，只是後端可換）、`goQueryCount()`（診斷）。
  * **共用測試集**：`ts/test/shared/search-cases.json`（3 個庫 × 20 個查詢：單詞／
    多詞／`+`／`-`／`*`／`.x`／`x.`／`x.y`／缺字／只有排除詞，**外加 18 個通檢案例**：
    同樣的查詢但帶 `groups`，驗 Go 的 posting 聯集）。產生：
    `bun run tools/make-search-cases.ts`（以 TS 後端為答案）。
    * TS 側：`bun run test/backend-cases.test.ts` — 重算一次，並用「假宿主 io」
      驗證 `backend.ts` 的映射與 `searchAutoVia ≡ searchAuto`。
    * Go 側：`cd wails && go test ./...` — `query_cases_test.go` 讀同一份檔案；
      資料庫路徑用環境變數（`ACCELON_DB_13J`／`ACCELON_DB_YINSHUN`／`ACCELON_DB_FGDICT`），
      沒設就找預設位置，再沒有就跳過（CI 沒 .adb 不會紅）。
  * **桌面版驗證**：`state().backend`（`go`／`ts`）與 `state().goQueries`；
    `tools/desktop-test.ts --gui --quick` 會斷言多詞組／萬用字元查詢在桌面版
    `backend=go`、`goQueries` 增加、而且有結果（實測「大乘 般若」5,000/5,000、
    「菩薩.心」118、「緣起*性空」4632/2051、「涅槃 解脫」5,000/5,000）。
  * **繁簡通檢（Go 版）**：`clauseHitsFor()` 在 `variantSearchOn()` 時仍然呼叫 Go，
    只是多傳 `groups`（`variantGroupsFor(query)`）；Go 的 `unionPostings()` 把同組字
    posting 聯集起來。實測桌面版（yinshun，繁體庫）「菩萨 般若」：通檢關 → `菩萨`
    詞組 0 命中；通檢開 → 5,000 命中、`backend=go`、`goQueries` 增加。
  * **什麼時候該跑什麼**：只改 UI（`summary`／`paint`／`doc-pane`／`scopes`／template）
    → 跑瀏覽器測試就好；改了 `search.ts`／`query.ts`／`backend.ts`／`wails/*.go`
    → 加跑 `bun run test:backend`、`bun run test:go`，並在有新案例時
    `bun run cases` 重產共用測試集。

## 3. 檔案地圖

| 檔案 | 角色 |
|---|---|
| `ts/src/accelon26/adb.ts` | 格式核心。`AdbIO.read(offset,length)` 是唯一原語；`BlobIO`（瀏覽器，含 **128 KiB 區塊快取**）／`SyncIO`（Bun）。容器／長度表／名稱表解析、`tokens()`、`documents()`、`attributeValues()`、`decodeUtf16()` |
| `ts/src/accelon26/vapa.ts` | **VA↔PA 映射器**。`init()`、`elementAt`、`lineSpans`、`phraseSpans`、`textOfVaSpan`、`nodeLabel`、`lineLengthPercentile`、**`lineLengthMaxUnder`**、**`edgeLine`**、`loadAnchors`、`validate` |
| `ts/src/accelon26/search.ts` | 搜尋：`loadTrees`（`<樹>`）、`parseScope`／`parseTiers`、`loadInstanceAttrs`、`loadTree`、`buildTree`／`flattenTree`、`phraseMatch`、`searchSummary`、`SearchSession`（`clauseHits`／`singleResult`／`rankClauses`／`groupStats`／BM25／`segments()`） |
| `ts/src/accelon26/backend.ts` | **後端分界**（作者 2026-10）：`ClauseHits` 契約、`backendKind()`、`queryBackend()`（唯一查詢入口，Go 或 TS）、`variantGroupsFor()`、`clauseHitsFor()`、`searchMultiVia()`／`searchAutoVia()`、`lastGoAnswer`／`goQueryCount()`。不 import 任何 UI 模組 |
| `ts/src/accelon26/db-kind.ts` | **詞典型 adb 判定**（`detectDictDb()`／`isDictDb()`）：`<集 c="… isdict …">` 或 `$詞`／`$字` 樹 → 本文不顯示 docHead |
| `ts/test/shared/search-cases.json` | **Go／TS 共用**的查詢測試集（3 庫 × 20 查詢 ＋ 18 個通檢案例）；`tools/make-search-cases.ts` 產生 |
| `wails/query.go` | Go 後端（**唯一的宿主查詢入口**）：`parseQuery`／`queryTokens`／`phraseMatchPattern`／`unionPostings`（變體組 posting 聯集）、`AdbHost.SearchQuery(path, query, maxHits, groups)` |
| `wails/query_cases_test.go` | Go 側跑共用測試集＋`TestSearchQueryVariants`（環境變數給 .adb，沒給就跳過） |
| `ts/src/accelon26/query.ts` | 查詢語法：`parseQuery`（空白／`+`／`-`／`*` 前綴）、`PROXIMITY_TOKENS`、`clauseHue`（每個詞組一個 HSV 色相） |
| `ts/src/accelon26/kw-marks.ts` | 摘要與本文共用的「哪個關鍵字是哪個顏色」（避免 paint ↔ summary 的循環 import） |
| `ts/src/accelon26/engine-stats.ts` | `#docTitle` 的「上一輪引擎耗時」：搜尋／取文的毫秒數＋hover 的 token／posting 細節 |
| `ts/src/accelon26/variants.ts` | 繁簡通檢：開關、`expandToken`／`variantNamePattern`（資料在 `variant-data.ts`） |
| `ts/src/accelon26/render_accelon3.ts` | 內文 → HTML（Accelon3 方言）：標題層級字級／底色、`<頁>`→分隔、`<段/>`→段落、未知標籤；`computeTierContext` |
| `ts/src/accelon26/about.ts` | 軟件說明（About）：點左上角開啟、版本／建置時間、開啟時檢查更新（桌面走宿主、網頁抓 version.json） |
| `ts/src/accelon26/lossless.ts` | 顯示用的「無損簡體／強制簡體」（`toSimplified`；資料在 `simplified-data.ts`） |
| `ts/src/accelon26/simplified-data.ts` | **產生檔**：`tools/gen-lossless.ts` 從 Unihan 產生的繁→簡對照（無損 2641 組／強制 2810 組） |
| `ts/src/accelon26/variant-data.ts` | **產生檔**：`tools/gen-variants.ts` 從 `vendor/Unihan_Variants.txt` 產生的分組字串（5194 組／10510 字，約 40 KB）。**有 commit**；`vendor/` 本身不進 git（來源見檔頭註解） |
| `ts/src/accelon26/viewer.ts` | UI（原生 DOM）：左欄目錄樹／頻次／西文／token，**中間本文分頁＋分頁（page）**，右欄摘要。本文區核心是 `DocSession`／`linkTo`／`ensurePage`／`renderDoc`。**已 2701 行，正在拆**（見下） |
| `ts/src/accelon26/paint.ts` | **塗紅**：`markPhraseInLine`／`markPhraseOnPage`／`paintHit`（自 viewer.ts 拆出，依賴 `docSession`／`mapper`／`scrollToVa`／`scheduleCursorSync`） |
| `ts/src/accelon26/accelon26.template.html` | 版面與 CSS（由 build 內嵌）。`#docTabs`／`#docPager` 是本文分頁與上下頁 |
| `ts/tools/build-viewer.ts` | 把 UI 打包成**傳統 script 並 inline** 進單一 HTML |
| `ts/tools/file-protocol-test.ts` | file:// 端對端測試（驅動真實 UI） |
| `ts/tools/shot.ts` | 開啟頁面、餵檔、驅動本文分頁，存一張 PNG 供目視檢查 |
| `ts/src/tokenize.ts`、`ts/src/unicode.ts` | 分詞器與 Unicode 判定（照 Delphi 移植） |

### 3.2 viewer.ts 拆檔計畫（依主題，模組間用 live binding 共用狀態）

| 模組 | 內容 | 狀態 |
|---|---|---|
| `paint.ts` | 塗紅：`markPhraseInLine`／`markPhraseOnPage`／`paintHit` | ✅ 已拆（13j 67/67） |
| `doc-pane.ts` | 本文分頁捲動：`DocSession`／`ensurePage`／`renderDoc`／`renderPager`／`goPage`／`renderDocTabs`／`boundsOfRealm`／字級 | ⏳ |
| `summary.ts` | 摘要：`runSearch`／`renderSnippets`／`showNodeHits`＋snippet 狀態 | ⏳（狀態要改 setter，ESM 不能寫入 imported binding） |
| `link.ts` | 聯動：`linkTo`／`revealHit`／`showLine`／`nodeContaining`／游標高亮 | ⏳ |
| `scopes.ts` | 搜尋 scheme／左欄分頁：目錄樹、`renderTerms`／`renderFreq`／`renderFolio`／`renderLatin`、`labelTableFor`／`wrappedText` | ⏳ |
| `panes.ts` | 右欄與進階面板：`renderMeta`／`renderContainers`／`renderResources`／`renderDocs`／token 瀏覽 | ⏳ |
| `viewer.ts` | 狀態宣告、`openFile`、wiring／boot、`window.__accelon26` | ✅ 入口 |

拆法：子模組 `import { … } from './viewer'`，viewer 端把用到的狀態／函式 `export`；**不要**在子模組寫入 imported binding。

**工具**：`ts/tools/split-viewer.ts <doc-pane|link|summary|scopes|panes|ui>`（依名字自動算 span、import、export；每個模組跑一次，可重複）。

**結果（2026-10）**：已全拆完成，行為不變 —— 13j 67/67、yinshun 74/75、fgdict 76/78（後兩者只差
本來就未修的兩個 bug）。`viewer.ts` 2,701 → 197 行；模組大小：scopes 815／doc-pane 545／ui 376／link 221／
summary 211／panes 185／paint 117。bundle 198.7 KiB。

**第 7 個坑（這次卡住的真兇）**：payload 用到 viewer.ts 從**其他套件** import 的符號（`CLASS_LABELS`／
`VaPaMapper`／`loadTree`／`TreeNode`…）時，工具只掃「宣告」不會帶過去 → `ReferenceError: CLASS_LABELS is not defined`
（在 `openFile` 裡被 try/catch 吞掉，症狀是測試 `Runtime.evaluate` timeout）。修法：把 viewer.ts 的
`./adb`／`./vapa`／`./search` import 中、payload 有用到的名字一併加進子模組的 import。

**下一輪若還要拆**（例如再從 scopes.ts 分出 `dir-tree.ts`），照 §3.2 的工具與清單做；先前的實驗紀錄如下。

**一輪全拆的實驗結果（2026-10，已回退）**：機械上成功——15 個模組、bundle 189 KiB、`bun build` 無錯、
viewer.ts 剩 197 行——但啟動後 **`Runtime.evaluate` timeout（頁面卡住）**，來不及在該輪定位，故整批回退，
只留已驗證的 `paint.ts`（13j 67/67）。下一輪照下列順序做，這些坑都已踩過：

1. **span 不可吃下一個宣告的 doc comment**：end 要用「下一個 span 的 start − 1」，否則重複刪除會切掉下一個函式的頭（症狀：`Unexpected }`）。
2. **import 掃描要看整個 registry**，不是只看 viewer.ts：已經搬到別的模組的符號仍要從那個模組 import（症狀：`setDocFont is not defined`）。
3. **ESM 不能寫 imported binding** → 每個模組要提供 setter／reset（`setDocActive`／`resetScopes`／`resetSummary`／`resetLink`／`resetDocPane`…），openFile 改呼叫 reset。
4. **測試用的 `window.__accelon26` 必須延後建立**（包成 `installDebugApi()`，在 `boot()` 最後呼叫）：它是 top-level 讀取所有模組的 binding，循環 import 下會踩 TDZ（症狀：`ReferenceError`、`__accelon26` undefined）。
5. **`document.addEventListener('DOMContentLoaded', boot)` 只能留一處**（留在入口模組或 ui），且 `boot` 只能在所有模組初始化後跑。
6. 每拆一塊就跑 13j（67）確認；全拆完再跑 yinshun／fgdict。卡住時先用 `build/probe.ts` 抓 `Runtime.exceptionThrown`。
7. **子模組要繼承 viewer 的套件 import**（`CLASS_LABELS`／`VaPaMapper`／`loadTree`…），否則 `ReferenceError` 會被 `openFile` 的 try/catch 吞掉，症狀是「頁面卡住」。
8. **手改子模組而用到新符號時，記得自己補 import**：Bun 對「未 import 的識別字」不會報錯，會當成全域變數 → 執行時才 `ReferenceError`（例：`sessionForRealm`）。

**分頁行為（需求三，2026-10 作者回報後修正）**：不按 Ctrl 的聯動**更新當前分頁**（不是每個節點開一個）；
只有 Ctrl/Cmd 開新分頁；若目標 realm 已經有分頁，則聚焦那一個。回歸測試：`不按 Ctrl 走訪目錄只更新當前分頁（不會多開）`。

### 3.3 同時開啟多個 adb（2026-10，完成；剩 §待辦 的測試回歸）

最多 `MAX_DBS = 5` 個。每個資料庫是一個 **slot**（`dbs.ts`），內含各模組的 snapshot：
`snapshotCore/restoreCore`（reader/mapper/session/tokens/docs/blocksVirtual/currentDoc）、
`snapshotDocPane/restoreDocPane`（**本文分頁在 slot 裡** → 關掉資料庫就等於關掉它所有分頁）、
`snapshotScopes/restoreScopes`（樹、folio）、`snapshotSummary/restoreSummary`、`snapshotLink/restoreLink`、`snapshotPanes/restorePanes`。

UI（作者 2026-10 的頂欄順序）：`#brand` → `#toggleLeft`／`#toggleRight` → **`#dbPickBtn`（📁，原本 ＋ 的位置）**
→ `#searchAllBtn`（🔍，沒開庫時隱藏）→ `#dbHint` → `#dbTabs` → `#status` → **`#settingsBtn`（🔧，最右邊）**。
`#file` 是隱藏的 `<input type=file>`，只由下拉第一項「＋ 加入 adb」觸發（`dbs.ts: needsAddItem()`：
`hostState().available` 為真＝桌面版，不需要這一項；桌面版啟動時已列出工作目錄的 adb）。
`#dbTabs`＝每個已開庫一個 chip，**最後開啟的放最左邊**（作者 2026-10），其餘維持相對順序（切換只改顏色，不重排）、
**只有 active 的 chip 顯示 ✕**（關閉該庫＝連同它所有本文分頁）。chip 字級 13px 固定，不隨 active 變。
切換／關閉後由 `ui.ts` 的 `refreshAll()` 重畫（每個 pane 交給自己的 `showTab()` 重跑）；全部關完呼叫 `clearDbUi()`。
`clearDbUi()` 會 `hideDocLogo()`：**關掉資料庫時中間的 logo 一定要收起**（`updateDocLogo()` 會因為 reader
還指著剛關掉的庫、而 #docText 已經沒有 `.docLine`，又把 logo 打開，所以那裡不能再呼叫它）。

**最右上的 adb 清單**（作者 2026-10 第二版：**黃色資料夾按鈕**，不再是 `<select>`）：
`#dbPickBtn`（📁，`color: #ffd479`）按一下才展開 `#dbPickMenu`（預設 `hidden`；再按一下、
點空白處或 Esc 收起）。清單列出**這次工作階段選過／拖過的每一個 adb**，
只讀 header（`catalogAddFile()` → `AdbReader.open(new BlobIO(file))`，幾 KiB）所以**未載入的庫也在清單裡**，字尾標「（未載入）」；
同名不同檔（13j.adb 與 1839.adb 都是十三經）會補上檔名 `十三經｜1839.adb`；目前這一個標 `.active`。
選一個就加入 `dbTabs`：已載入的直接切換，未載入的當場載入。**沒有「拒絕」了**：`MAX_DBS = 5`
滿了就讓**最久沒用**的那個 slot 讓位（它的本文分頁跟著消失，跟按 ✕ 同義）。
瀏覽器版不能列資料夾，所以來源只有使用者自己選的檔；桌面版會自動列出與執行檔同資料夾的 adb（同一份清單模型）。
`state().dbPick` 是目前 active 的 catalog key，`state().dbPickOpen` 是清單開著沒有。

**純網頁版的下拉清單唯一來源就是 file input dialog**（作者 2026-10 確認）：`catalog` 只是模組裡的陣列，
**不寫 localStorage**，重新整理頁面就重來。localStorage 只放閱讀偏好（`accelon26.cols.v2` 欄寬、
`accelon26.docfs` 字級、`accelon26.advanced` 進階模式）。probe 實測（`build/probe-reload.ts`）：開兩個庫後
`Page.reload` → 下拉回到「（用 ＋ 開啟 .adb）」、chips 0、catalog 0，而 localStorage 的三個 key 一字不變。

**一次選多個**：`#file` 有 `multiple`。`openPicked()` 先把每一檔加進 catalog（只讀 header），再把**還有空位**的載入；
選**單一個**檔时一律載入（就算已經 5 個，最久沒用的讓位）——「選了就是要看它」。其餘留在下拉裡等讀者挑。
**同一次挑選的 change 會來兩次**（瀏覽器行為，測試又常自己 dispatch 一次）→ `picking`＋檔名／大小／mtime 簽章把重複的那一次丟掉。

**庫名相同時**：`alreadyOpen()` 比對「檔名＋大小＋mtime」→ 同一個檔案只是**切換**過去；
**不同檔案但庫名相同則取代那個 chip**（`registerOpenDb` 回 `replaced`），狀態列明說「十三經：13j.adb 取代了同名的庫（它的舊分頁已關閉）」。

**已用 probe 驗證**（`build/probe-multi.ts`、`build/probe-pick.ts`）：開 yinshun → 開 fgdict（chip 出現、active 變佛光大辭典）→ 在 fgdict 開一個本文分頁 →
點 chip 切回 yinshun（名稱／docs／左欄分頁都跟著換）→ 按 ✕ 關掉 fgdict（chip 0、`docTabs` 0＝它的分頁一併關掉、狀態列回到 yinshun）；
一次挑 6 個檔（已開 2 個）→ chips 5 個、順序不變、`略過 2 個`（其中 1839.adb 與 13j.adb 同名 → 取代，所以只新增 3 個 chip）。

**待辦**：`file-protocol-test.ts` 的多庫回歸、關閉 active 時挑選下一個的策略（目前取陣列最後一個）。

### 3.4 切換資料庫的「慢」＝一次把幾千列塞進 DOM（2026-10，已修）

作者回報「從 yinshun 切到 fgdict 明顯慢，fgdict→yinshun 很快」。量測（`build/probe-switch.ts`，
在頁面裡用兩次 `performance.now()` 夾住 chip 的 click，量的是**同步**成本）：

| 方向 | 修前 | 修後 |
|---|---|---|
| fgdict → yinshun | 34–44 ms | 2–4 ms |
| yinshun → fgdict | **381–445 ms** | 2–4 ms |

原因不是「名詞／全文節點太多」（那兩頁本來就只列 200／300 列），而是 **目錄樹**：
`showTab(name,'right')` 裡有一行 `if (col === 'right' && dirTrees.length) void renderDirTree();`
——**任何右欄分頁被切換都會重建（左欄的）目錄樹**，而 fgdict 的樹是 6,966 列／34,837 個 DOM 節點，
全部同步建在 click 的處理函式裡（一次 `innerHTML`）。切換資料庫時 `refreshAll()` 一定會呼叫
`showTab(rt,'right')`，所以每次切到 fgdict 都要付這 390 ms。

修法兩層：

1. **觸發點修對**：目錄樹改成在 `refreshAll()` 裡依「左欄 `dir` 分頁是否顯示」重建，右欄切換不再碰它。
2. **列分批掛上**（新模組 `lazy-list.ts`）：`renderChunked(box, items, { html, bind, prepare, min })`
   先掛 `CHUNK = 200` 列，捲到接近底部（或點「還有 N 列…」）再掛下一批。
   `prepare(slice, from, to)` 只為**即將顯示的列**做非同步工作（`labelFor`、`nameSegs`、
   `caches/詞` 的字串表）；`growUntil(box, pred)` 給「必須捲到某一列」用（🌲 展開樹）。
   目錄樹用 `min: mounted(box)`：展開／收合後仍保留讀者已經捲出來的那麼多列。

同一套分批掛列也用在 名詞（fgdict 22,648 詞條）、頻次（yinshun 6,978 段）、原書分頁（6,959 頁）、
西文（碼位範圍內的 token）：清單仍然是**完整**的，只是 DOM 一次只放一屏。
診斷：`state().dirRows`（現在掛了幾列）＋ `#dirTree .moreRows` 的提示；測試端有
`window.__accelon26.growTree()` 先把整棵樹掛完再斷言（見 `file-protocol-test.ts` 的「目錄樹分批掛上 DOM」）。

**沒有 `s="*"` 就沒有目錄樹**（作者 2026-10）：「不指定 s="*" 就不必顯示目錄樹」，接著「可以拿掉背景建樹」。
唯一的判斷是 `dirPaneShown()`（`#colLeft .tabBtn[data-tab=dir]` 可不可見）：`renderDirTree()`
開頭就檢查，不顯示時直接清空 `#dirTree` 與 `#dirMeta`（免得換庫後留著上一個庫的列）。
**而且連資料都不建了**：`loadDirectoryTrees()` 只建「宣告了 `s="*"` 的那棵樹」（`dirTrees` 現在只放這種），
沒有就 `dirTrees=[]`、`dirActive=-1`、`treePhases.skipped=1` 直接返回 —— fgdict 的 88k 實例／~160 ms 背景建樹整批省掉。fgdict（`$詞`／`*詞`／`頁.n`，沒有 `s="*"`）
因此 **0 列**在 DOM，左欄也真的沒有「目錄」這個分頁。
**樹的資料仍然建**（`dirTrees`，作者 2026-10 確認「照建不畫 ok」）：現在它只服務目錄樹面板
（`paintTreeActive`／展開集合／`dirInfo` 診斷），**搜尋分組不再需要它**——`groupNames()`
改成先讀 adb 自己的 `caches/<標籤>` 字串表（13j 13、yinshun 44、fgdict 7，每個都與該標籤的
實例數相同、內容也與樹標籤一致），其次才用 `treeLabels`，最後才是屬性表 `<tag>.n`／`<tag>.id`。
所以那 ~160 ms 的背景建樹**可以**拿掉（只影響隱藏面板），但目前刻意留著。

**代價與界線**：`#dirTree` 的列不再保證全部都在 DOM。要數整棵樹的斷言要先 `growTree()`；
`paintTreeActive()` 只會亮**已掛上**的列。fgdict 沒有 `s="*"`，它的目錄樹面板是隱藏的，
所以「樹的形狀」斷言（幾本書／逐層展開）在 fgdict 用 `dirTabShown` 跳過（13j／yinshun 完整覆蓋）。

**樹的狀態在切換時不會丟**：展開集合 `d.open`、已解出的標籤 `d.labels`、`parentOf` 都在
`DirTree` 物件裡，而 `DirTree` 由 `snapshotScopes/restoreScopes` 隨資料庫的 slot 一起保存
（DOM 只是從 `d.open` 重畫出來的結果）。所以切走再切回來，樹還是原本展開的樣子。

### 3.5 右欄「文字內容」＋ 本文區的 logo（2026-10）

**右欄「文字內容」＝第二個閱讀窗格（純參考）**，新模組 `text-pane.ts`。作者指定的操作：

| 動作 | 結果 |
|---|---|
| Ctrl+點 **樹節點**（含箭頭） | 該節點的文字放到右欄「文字內容」；**中間本文完全不動** |
| Ctrl+點 **本文分頁**（`#docTabStrip`） | 複製到右欄並顯示（中間那個分頁留著） |
| Shift+點 **本文分頁** | 搬到右欄（中間讓出那一個分頁） |
| 在右欄捲動／點 | **不連動左邊的樹**（只有中間的本文驅動樹與游標） |

* 這些點擊用**捕捉階段**的 listener（`initTextPane()`，掛在 `#dirTree` 與 `#docTabStrip` 上）：
  Ctrl/Shift 的點擊被它 `stopPropagation` 吃掉，所以樹列自己的 handler（`scopes.ts` 的 `bind`）
  與本文分頁的 handler 都不會看到那個點擊。
* 右欄多一個分頁鍵 `[data-tab=text]`，**有文字分頁時才出現**（`syncTextTab()`）；
  分頁籤在 `#textTabs`、內容在 `#textBody`、翻頁在 `#textPager`（`#textPrev`／`#textPageInfo`／`#textNext`）。
* **文字內容頁刻意獨立成模組**：`renderTextPane()` 是**唯一**決定「一行長什麼樣」的地方，
  目前是純文字（`mapper.docText` ＋ 行表），下一步要把行內的 XML 標籤變成 HTML —— 那時只改這裡。
* 右欄分頁也住在資料庫的 slot 裡（`snapshotTextPane/restoreTextPane`），關掉資料庫就一起收掉。

**本文區空白時的 logo**：新模組 `logo.ts`。`#docText` 裡沒有任何 `.docLine` 時，顯示這個資料庫
**自己在 adb 內的**圖：`resources` 容器裡名稱符合 `<dbname>_logo.*` 或 `<檔名>_logo.*` 的那一筆
（yinshun 是 `yinshun_logo.png`，320×480）。圖用 `resourceBytes(i)` 直接取（resources 不壓縮）
並以 blob URL 顯示；沒有這個資源的庫（13j、fgdict）就什麼都不顯示。`state().logo` 有
`{ name, at, shown }` 可診斷。開檔時 `setLogoBase(file.name)` 讓檔名也成為候選。

### 3.1 分區名稱與 id（溝通時直接用；示意圖 [accelon26-map.html](accelon26-map.html)）

| 統一稱呼 | 選擇器 | 備註 |
|---|---|---|
| 頂欄 | `#header` | `#brand`／`#toggleLeft`／`#toggleRight`／`#dbPickBtn`（📁 下拉，第一項「加入 adb」）／`#file`（隱藏）／`#searchAllBtn`（🔍）／`#dbTabs`（庫名 chips）／`#status`／`#settingsBtn`（🔧 最右） |
| 三欄容器 | `#main` | `--left` 25fr・`--center` 50fr・`--right` 25fr，6px 分隔線 |
| 左欄／中欄／右欄 | `#colLeft`／`#colMid`／`#colRight` | `#splitLeft`／`#splitRight` 拖到 15% 以下即收合 |
| 左欄分頁列／窗格區 | `#tabsLeft`／`#paneLeft` | 分頁鍵＝`[data-tab=dir\|terms\|freq\|folio\|latin\|token]` |
| 右欄分頁列／窗格區 | `#tabsRight`／`#paneRight` | `[data-tab=sum\|text\|meta\|capacity\|docs\|images]`（`text`＝文字內容，有文字分頁才出現） |
| 目錄樹本體 | `#dirTree` | 面板＝`#paneLeft [data-tab=dir]` |
| 名詞／頻次／原書分頁／西文清單 | `#termsList`／`#freqList`／`#folioList`／`#latinList` | 各自的 meta＝`#termsMeta` 等 |
| 位置篩選（名詞／西文共用一套） | `#termsMode`／`#latinMode` | 任意／開頭／中間／結尾；`modeMatch()` 一份實作（`scopes.ts`） |
| 摘要清單 | `#searchList` | 面板＝`#paneRight [data-tab=sum]` |
| 文件工具列 | `#docBar` | `#treeReveal`(🌲)・`#docTitle`・字級 `#fsDown`/`#fsValue`/`#fsUp`/`#fsAuto`/`#fsReset` |
| 本文分頁籤條 | `#docTabStrip`（父層 `#docTabs`，另有 `#docTabAdd`） | 分頁 ≥ 1 才顯示 |
| 本文 | `#docText` | 行元素 `L<行號>`、命中行 `.hitLine`；空白時旁邊顯示 `#docLogo`→`#docLogoImg` |
| 分頁列 | `#docPager` | `#pagePrev`／`#pageInfo`／`#pageNext`；分頁 ≥ 2 才顯示 |
| 右欄文字內容 | `#textTabs`／`#textBody`／`#textPager` | 分頁籤／文字／翻頁（`#textPrev`／`#textPageInfo`／`#textNext`） |

沒有 id 的 `[data-tab]` 面板，一律用 `#paneLeft`／`#paneRight` 當前綴指稱（`showTab(name, 'left' | 'right')` 用的鍵就是它）。

**維護規則**：改版面（新增／刪除／改名任何 id）時，同一輪必須更新 `accelon26-map.html`，並跑
`bun run tools/check-map-ids.ts`（雙向比對示意圖與 `build/accelon26.html` 的 id 集合，不一致就 exit 1）。
示意圖是與作者溝通分區的**共同詞彙**，不能讓它腐化。
## 4. 已驗證的格式知識（可直接信任）

* **VA（虛擬位址）= token 序號**：token +1、連續空白 +1、標籤開／閉**各 +4**、skip 標籤 +0。
* **PA（實體位址）= blockIndex × srcBlocksize + 區塊內位移**（UTF-16LE，srcBlocksize 16384）。
* **硬換行不佔 VA** → 被硬換行切開的中文詞是**連續的 VA 範圍**（13j 行界 90.5% 的 VA 差恰為 1）。
* **版面模型＝自訂標題（h1~h6 的推廣）**：標籤＝一行標題、**不包住內容**；範圍＝**到下一個同樣的標籤**（沒有就到 `</檔>`）。
  因此「同標籤不互相巢狀」是可驗證的不變量（13j 0 個、yinshun 0 個）。
* **`t=` 是逐實例宣告**，沒宣告的實例在該處停止下探；`t="章,節,項."` 的**第一項是直接子層**，
  其餘是**同層兄弟槽位**（會**繼承**到子層之下，所以 `章` 即使沒有 `t=` 也能收 `節`／`項`）。
  宣告只寫一次（13j 的 13 本書只有第一本帶 `t=`），其餘同標籤實例沿用。
* **`s=` 的種類**（Pascal `formatter.pas:1472 createSearchSchemes` + `tokenize.pas:717 parseTAV`）：

  | `s=` | 意義 | 現況 |
  |---|---|---|
  | `*` | 全文 | ✅ 分頁「目錄」（搜尋摘要移到右欄「摘要」） |
  | `*u=文` | **屬性過濾**（attr `u`, value `文`） | ✅ 分頁「頻次」（yinshun 6,978 段／40 個標籤） |
  | `*文` | **標籤名** → `<文>` 的實例 | ✅ 分頁「全文」（fgdict `*詞`：5,000 筆命中分布於 1,356／22,648 段） |
  | `~X` | **token 清單**：`settoken(adb, X)` | ⚠️ 分頁「西文」**已接線並有內容**（原本 `renderLatin()` 根本沒被呼叫）；**作者確認 X 就是碼位範圍**（2026-10） |
  | `$詞` | 標籤包裹（`parsetav` → tag `詞`） | ✅ 分頁「名詞」（fgdict：一個 `<詞>` 一個詞條，輸入時先列詞條名符合者） |
  | `@X` / `^X` / `%` | 字表／主題表／反向連結 | 未接 |
  | `頁.n` | `tag.attr`：樹從 `<頁>` 起，名字取 `n` 屬性 | ✅ 分頁「原書分頁」（fgdict 6,959 個頁碼，可選可輸入；用 `attributeValues('頁.n')` 的 pointers 對到 `<頁>` 實例 VA） |

  另有 `t`（subtree）、`p`（paging）、`o`（columns）三個屬性**尚未讀取**；
  **分頁名應取 `<樹>…</樹>` 的元素內容**（`ss.caption := removetag(getnNodeValue(dn))`），
  目前是用 `s=` 推導（fgdict 的三個 `<樹>` 內容都是空的，需要 fallback）。
* **屬性容器是「不掃內文」的關鍵**：`attributeValues(key)` 回傳的 `pointers` 低位 24 bits 是
  **1-based 實例序號**、高位 byte 是 tag id，所以每個屬性值都能直接對應到 `tags` 容器的實例。
* **本文分頁只能靠行表**：節點的 realm 是 VA 範圍，但一個節點**可以橫跨多個 `<檔>`**
  （yinshun 的 `書` 就是），所以頁碼→行號必須用**全域行表**（`linesVirtual`）算，
  `docText()` 的 VA 範圍要由「該頁第一行的 VA … 最後一行的 VA+1」推導，**不可**用單一 `<檔>` 的範圍。
  （踩過的坑：用 `<檔>` 範圍會讓每頁被夾成 1 行。）
* **映射器行號 vs 行表漂移**：`elementAt` 走的行號（walk）與 `linesVirtual` 的行號在檔界可能差 1 行
  （fgdict 每個檔界都差）。所以釘住的命中行要**夾回當前頁實際渲染的行**，否則標不到紅。
* **`caches` 容器是現成的字串表**（本輪最重要的發現）：`caches` 內是若干「本身也是容器」的區塊，
  以名稱為鍵，fgdict 有 `書`（7 個書名）與 `詞`（22,648 個詞條 innerText），
  yinshun 之類有 `檔`（`docNames()` 已在用）。**順序＝實例序號**，與 `tags` 容器的實例一一對應。
  讀它只要一次容器解析；改從內文切同樣的字要對每個碰到的區塊 bunzip，慢且容易取錯。
  `AdbReader.cachedStrings(key)` 就是這個入口。fgdict 的書名（P0）與詞條名都靠它解決。
* **fgdict 的 VA walk 漂移很大**：`elementAt(219386)` 會回傳別的區塊的第一個元素（walk VA 與
  儲存 VA 差 >1000），所以 fgdict 上 **VA→PA 的走訪不可信**；行表（`linesVirtual`/`linesPhysical`）
  與 `caches`／`tags` 才是 ground truth。**摘要的 snippet 也一樣**：`searchSummary(…, { phrase })` 會用
  `lineOfVa` ＋ 文字搜尋定位並塗紅，否則會顯示並塗到隔壁字（實測：搜「法喜」的兩筆顯示「帖見」「止觀」）。跳行用 `lineOfVa(va)`（`edgeLine` ＋「VA 等於某行結尾時
  屬於下一行」的修正），塗紅則對「節點標籤連結」改用「在該行原文中找詞條字串」(`markPhraseInLine`)。
* **本文分頁標籤**顯示「詞名／來源節點名」（`shortLabel` 截 8 字，完整名在 tooltip），
  不再顯示 `Fgdict1.xml` 這種對讀者無意義的檔名。

## 5. 效能

**開檔**：yinshun 24 MiB 原本 **3,525 ms → 60 ms**。原因不是 SSD、不是解壓，而是
`Blob.slice()` 被呼叫 **10,489 次**（每次約 0.33 ms 固定成本，與長度無關）。
`BlobIO` 加 128 KiB 區塊快取後降到 **19 次**。
細分可用 `window.__accelon26.openBreakdown()` 或 `state()` 取得（狀態列只顯示人看得懂的資訊）。

**本文**：舊版一次渲染 `min(3000 行, 整份文件)`，yinshun 的檔可達 45k 行，
一次要讀數百個 bzip2 區塊並塞進 DOM。現在**一次只載一頁 200 行**，聯動成本變成
「讀 1–2 個區塊」的量級（實測 `state().lastLink.ensureMs`：fgdict 29–85 ms、yinshun 數十 ms）；
DOM 列數也固定。

**聯動卡頓（本輪處理）**：
* **畫家不再自己換頁**：`paintHit` 原本發現命中不在當前頁就呼叫 `ensurePage`，
  於是「上一頁／下一頁」一翻頁就被拉回命中的那一頁（fgdict 這種映射器行號會漂移的庫特別明顯）。
  現在**只有「聯動」才跟隨命中**（`linkTo` 明確傳 targetLine），翻頁純粹由 `goPage` 決定。
* **目錄樹查找 O(depth × log width)**：`deepestNode()` 逐層二分搜尋，取代走訪全樹
  （fgdict 29,614 節點、每次聯動與每次捲動都跑）。
* **捲動高亮只改 class**：`paintTreeActive()` 不再重建整棵樹的 DOM。
* **命中數 O(log n)**：`realmHits` 用兩個二分搜尋取代線性掃描（大節點有數千命中）。
* **解碼快取上限 256 塊**：`AdbReader.sourceText` 的 `srcTextCache` 原本無上限，
  長時間跳讀會把整個 24 MB 庫的解碼結果留在記憶體、GC 抖動就變成卡頓。
* 診斷入口：`state().lastLink`（`ensureMs`／`totalMs`／`rows`）、`state().textCache`。

**自動字級（「不換行」）**：可用寬度必須取**中間欄**（`docTextWidth()`，扣除左右欄與列內 gap）；
量測必須在**無寬度約束**的容器。**因為有分頁，量測不可以只看當前頁**：
現在用行表取整份文件的 p90 當「代表行長」，並取 `線表最大行長（≤1.15×p90）` 當上限，
再從當前頁挑一條**真實**、長度不超過上限的行當量尺（CJK 量尺會偏寬）；
罕見超長行容許橫向捲動。`state().lastFit` 有全部中間數字。

## 6. 目前測試狀態

| 測試 | 結果 |
|---|---|
| `file-protocol-test.ts`（13j） | **157/157** |
| `file-protocol-test.ts`（yinshun） | **170/170** |
| `file-protocol-test.ts`（fgdict） | **171/171** |
| `test/tree.test.ts` | 40/40 |
| `test/search.test.ts`（13j／yinshun） | 19/19、18/18 |
| `test/multi-search.test.ts`（yinshun／fgdict／13j） | 39/39、18/18、18/18 |
| `test/variants.test.ts`（繁簡通檢） | **13/13** |
| `test/backend-cases.test.ts`（共用測試集，TS 側；含 18 個通檢案例） | **180/180** |
| `test/backend-layout.test.ts`（後端／前端分界） | **11/11** |
| `wails/query_cases_test.go`（共用測試集，Go 側；含 `TestSearchQueryVariants`） | `go test ./...` 全綠 |
| `tools/desktop-test.ts --gui --quick`（桌面） | **37/37** |
| `test/render.test.ts`（內文渲染） | **19/19** |
| `test/accelon26.test.ts` / `test/vapa.test.ts` | 22/22、13/13 |
| `test/tour.test.ts`（劇本⇄宏、剖析器、同步檢查） | **31/31** |
| `tools/tour-test.ts`（操作導覽全播；13j／yinshun／fgdict） | **29/29** 各一次 |

新增／改寫的斷言（都在 `file-protocol-test.ts`）：
* 輸入只更新摘要、本文不隨輸入移動（比對釘住的 VA）
* 點 tCount：摘要範圍切在該節點 realm 內、每筆命中 VA 都落在範圍內
* 點節點（開得起來就開）並聯動本文；Ctrl+點另開本文分頁；Ctrl+點箭頭不再爆開；
  Alt+點節點名展開全部子孫；切換分頁不會再生分頁
* 本文分頁：每頁 ≤200 行、只有一頁時分頁列隱藏、多頁時上一頁／下一頁真的換頁且翻得回去
* **本輪新增**：本文區空白時顯示資料庫自己的 logo（沒有這個資源就保持隱藏）
* **本輪新增**：目錄樹分批掛上 DOM（首批 ≤200 列、有「還有 N 列」提示、`growTree()` 掛完＝全部）
* **本輪改寫**：Ctrl+點樹節點＝送右欄文字內容且**中間本文不動**（含箭頭；原本是開新分頁）；
  Alt+點仍是展開全部子孫
* **本輪新增**：Ctrl+點本文分頁＝複製到右欄、Shift+點＝搬到右欄（中間讓出）、右欄捲動不連動左樹
* fgdict 沒有 `s="*"`（目錄樹面板隱藏）：樹的形狀斷言（幾本書／逐層展開）用 `dirTabShown` 跳過，
  由 13j／yinshun 覆蓋
* **本輪新增**：右上 `#dbPick`（header 最後一個元素）列出這次工作階段的所有 adb、選中目前的庫
* **本輪新增**：狀態列只顯示錯誤／忙碌（載入後 `#status` 是空的，`__accelon26.status()` 仍記得最後訊息）
* **本輪新增**：餵非 .adb → 狀態列顯示「開啟失敗」，原本的庫不受影響，而且不丟例外
* **本輪新增**：沒有 `s="*"` 的庫完全不建樹（`treePhases.instances = 0`）
* **本輪新增**（多庫：測試自己造一個「庫名不同」的複本 adb —— 只改 header 的 dbname／dbcname）：
  餵兩個檔＝兩個 chip 且最後開啟的在最左、**點 chip 切換順序完全不動**、
  **從下拉選的那一個跳到最左**、關掉它之後仍留在下拉標「（未載入）」
* **本輪新增**：沒有資料庫時 `#dbHint` 在 ＋ 右邊閃爍（`animationName=dbHintFlash`），
  開庫後消失；`prefers-reduced-motion` 下不閃爍但仍在；關掉最後一個庫後又回來
  （這條順帶抓到 `clearDbUi` 少了 `resetTextPane` import 的舊 bug）
* **本輪新增**：`no page exceptions` 移到全部動作之後才檢查（之前只涵蓋到中段）
* **本輪新增**（fgdict）：點名詞詞條 → `state().docRealm` 恰為 `[該 <詞> VA, 下一筆 <詞> VA)`、
  分頁名＝詞條名、不另開分頁；名詞搜尋「法王」→ 每一列都含「法王」；`法王 -大慈` 會排除
* **本輪新增**（yinshun）：`緣起*性空`／`緣起 性空`／`緣起+性空`／`緣起-性空` 四種詞組解析、
  文件數 `鄰近 < 必要 < 可選`、摘要與本文的每個關鍵字各自一種 HSV 顏色（排除詞不上色）
* **本輪新增**（yinshun）：`菩.心`（單字萬用字元）在摘要與本文都塗到「菩提心／菩薩心」；
  `菩.心-菩提心` 排除後還剩 27 份文件（菩薩心那一些）
* **本輪新增**：`.` 只在前後都是漢字時才是萬用字元，其餘位置的 `.` 當 skipword 丟掉
  （`a.b`→`ab`、`菩.a`→`菩a`）
* **本輪新增**（yinshun）：`#docTitle` 顯示「搜尋 X ms・取文 Y ms」，hover 有
  token／posting 長度與文件分割；清空查詢後回到預設文字
* **本輪新增**：`#dirMeta` 只在進階模式顯示（一般模式 `hidden`、`display:none`、無文字）；
  再點一次 active 的目錄分頁 → `dirRows` 回到第一層（13j 82→13、yinshun 47→44）、
  已展開的分支 0

## 7. 待辦事項

### P0 — 已解決

1. ~~fgdict 的 6/7 本書名取不到~~ → 已用 `caches/書`（7 個書名，實例序）解決；
   `loadTree` 的 20,000 標籤預算會切掉後面的節點，所以第一層標籤另外從快取補一次。

### P1 — 未實作的規格

2. **`$詞` 分頁**（fgdict）：✅ 已實作（名詞清單、`+`／`-`、單字萬用字元、點詞條只讀該詞條）。
   剩下的問題是 **`*詞` 與 `$詞` 的語意差異** —— 目前兩者共用同一份 `<詞>` 實例，
   需向作者確認 `*詞` 是否要求「命中從詞首開始」。
3. **`頁.n`（tag.attr）scope** 與 `@`／`^`／`%` 三種。
4. **讀 `<樹>` 元素內容當分頁名**，並讀 `t`/`p`/`o` 屬性（`o` 是 columns）。
5. **`~X`（西文）語意**：現在 **已接線、有內容**（`renderLatin()` 原本沒被呼叫是 bug），
   X 就是**碼位範圍**（2026-10 作者確認），不需再猜。
6. **目錄樹與頻次改為純屬性查表**：目前節點名稱仍會走內文（fgdict 6,978 段的取名已限制在顯示的前 200 列）。

### P2 — 測試覆蓋缺口

7. 測試改成**資料庫感知**：書數（13/44/7）、有無「頻次／西文／`$詞`」分頁都依 `s=` 宣告決定。
   （本輪已把本文分頁與自動字級的斷言改成資料庫感知，但書數與分頁存在性仍寫死。）
8. 「Ctrl 展開後收合，再展開不該還開著子孫」的斷言（已修，無斷言）。
9. 開第二個資料庫（換檔）後，本文分頁與快取必須重置——已實作（`openFile` 清
   `docTabs`／`boundsCache`／`paintAsked`），但**沒有測試**。

## 8. 工作注意事項（踩過的坑）

* **不要用 PowerShell 的 `Get-Content`/`Set-Content` 或 `-replace` 改 `.ts`**：
  本專案檔案是 UTF-8 無 BOM，PS 會把中文變亂碼、也曾把程式碼改壞成語法錯誤。請用編輯工具逐字改。
* **測試的 page-eval 字串內不要放 TypeScript 型別註解**（`const x: number[]`），
  也不要用未轉義的 `${}`／反引號 —— 兩者都會造成 `SyntaxError`。
* **瀏覽器可能快取 `file://` 的 HTML**。改完 viewer 後若測試結果與程式碼不符，
  先確認 `build/accelon26.html` 的內容（例如 `Select-String` 找一個新字串），
  並讓測試用 `?v=Date.now()` 開啟頁面（file-protocol-test.ts 已加了）。
* **重複宣告會靜默蓋掉新函式**：`viewer.ts` 曾經同時有兩個 `revealHit`，
  舊版把新版的 `linkTo` 整個蓋掉，浪費了一輪除錯。改完先用
  `bun build src/accelon26/viewer.ts --target browser --outfile build/_check.js` 轉譯一次。
* **繪圖是非同步的**，測試請輪詢「結果特徵」而不是固定 `setTimeout`；
  也不要輪詢「本來就非空」的元素（舊版的頻次斷言就是這樣讀到舊值的）。
  本輪新增：**比對 `state().pinned` 的 VA** 比比對 DOM 的 `.hitLine` 穩定
  （換頁時 DOM 會先換行、後塗紅）。
* **`#freqQuery`／`#latinQuery` 曾經完全沒有 handler**（輸入了不會重畫）。
  現在 `boot()` 用 `wireOwnSearch` 接上 input／Enter／Escape／清除鈕。
* CDP 啟動參數必須含 `--remote-allow-origins=*`，否則 websocket 握手失敗。
* 測試用的診斷入口都在 `window.__accelon26`（`state()`、`openBreakdown()`、`fitDebug()`、
  `pinnedSpans()`、`treeDebug()`、`debugDoc()`、`setCols()`、`setAdvanced()`、`showTab()`）。
  `state()` 新增 `docTab`／`docTabs`／`docPage`／`docPages`／`docTabPages`／`docPageLines`／
  `docRealm`／`pagerHidden`／`docStrip`／`snippetScope`／`lastFit`／`lastLink`／`pagerLog`／
  `cursorNode`／`textCache`。
* **左欄頁名與 scope 綁定**：`syncTreeTabs()` 由 `<樹 s="…">` 決定顯示哪幾頁與頁名
  （`*`→目錄、`$X`→名詞、`*u=`→頻次、`*X`→全文、`X.y`→原書分頁、`~X`→西文），
  換庫時「目錄」可能不存在，所以預設頁會自動落到第一個存在的頁。
* **🌲 展開樹**：使用者要求的是 `🪾`（U+1FABE，Unicode 16），但多數字型沒有這個字
  （headless Chrome 直接顯示空框），所以按鈕用 `🌲`（U+1F332，通用）。
* `.gitignore` 已排除 `*.adb`、`build/`、`sourcecode/`，所以資料庫與建置產物不會進版控。
* **`.ts` 是 CRLF**（`search.ts` 787 個 `\r\n`、0 個 LF）。用 Node 做字串替換時要按檔案的實際行尾組 pattern，
  否則 `old_string` 會找不到（踩過）；反過來我拆檔時寫出的是 LF，所以現在模組間行尾不一致（功能無害）。

## 9. 主要資料庫

| 檔案 | 大小 | 特色 |
|---|---|---|
| `D:\2026\adb-converter\13j.adb` | 2.25 MB | 十三經。單檔、13 書、四層（書→章→節→項 2,020 節點） |
| `D:\accelon3\yinshun\yinshun.adb` | 24.9 MB | 印順法師全集。45 文件、456 資源、三棵 `<樹>`（`*`／`*u=文`／`~00602000`） |
| `D:\accelon3\fgdict.adb` | 18.2 MB | 佛光大辭典。三棵 `<樹>`（`$詞`／`*詞`／`頁.n`）、`<詞>` 22,648 個 |

## 10. 桌面版（Wails3 宿主，2026-10）

**目的**：exe 啟動時就自動列出**工作目錄裡所有 `.adb`**（只讀每個檔的 256 位元組檔頭），
讀內文用 **mmap**。使用者從右上 `#dbPick` 下拉選一個就加入 `dbTabs`，其餘行為與網頁版完全一樣。

**作者指示**：除非明確說要造 exe 或「準備發佈」，否則**只產生 HTML 版**；大部分程式碼留在 TypeScript，
Go 層越薄越好，UI 最好不要知道 Go 層存在；Wails 不必走 socket／event 回呼。

### 10.1 一份 UI、兩種宿主

| 宿主 | 檔案從哪來 | 讀取方式 |
|---|---|---|
| 純網頁 `file://` | `#file` 檔案選擇器／拖曳（`File`） | `Blob.slice().arrayBuffer()`（`BlobIO`，128 KiB 分塊快取） |
| 桌面 `accelon26.exe` | 工作目錄的 `*.adb`（宿主回報，只讀檔頭） | Go mmap → base64 → `Uint8Array` |

UI 怎麼可能不知道 Go 層：`ts/src/accelon26/adb.ts` 定義 `ByteSource`／`AdbSource`（只要 `name`／`size`／
`lastModified` 與 `slice(start,end).arrayBuffer()`），挑檔案的 `File` 與宿主檔案都符合。
**只有 `ts/src/accelon26/host.ts` 知道宿主存在**：它用 `new Function('u','return import(u)')` 動態載入
`/wails/runtime.js`（`file://` 下必然失敗 → 沒有宿主），把 `Call.ByName('main.AdbHost.ListAdbs')` 與
`('main.AdbHost.ReadBase64', path, offset, length)` 包成普通的 `AdbSource`。`ui.ts` 只多一行
`void bootDesktop()`（有宿主才把工作目錄的 adb 加進 catalog，並開第一個）。
診斷：`state().host = { available, listed, error }`（**不要讓它靜默退化** —— 這一輪就是靠它抓到 bug）。

### 10.2 Go 層（`wails/`，獨立模組 `github.com/accelon/adb-converter/wails`）

只註冊一個 service `AdbHost`：

* `ListAdbs()`：`os.ReadDir(".")` 找 `*.adb`（大小寫不敏感）→ mmap → 只解析檔頭的 `dbname`（0..32 ASCII）
  與 `dbcname`（128..192 UTF-16LE）→ 回 `path/name/dbname/dbcname/size/modified`。
  `Name` 優先序＝`dbcname` → `dbname` → 檔名。讀不了就跳過，不讓整個清單失敗。
* `Open(path)`／`Close(path)`／`CloseAll()`：白名單（必須 `.adb` 且位於**當前工作目錄之內**）、
  映射快取＋引用計數（webview 會從多個 goroutine 呼叫，內部 `sync.Mutex`）。
* `ReadBase64(path, offset, length)`：**UI 唯一的讀取入口**，回傳映射切片的 base64；越界／負數回 error 不 panic。
* `Postings(path, token)`：回某個詞的 posting（VA 清單，遞增）—— 「TypeScript 直接取得詞 posting」的入口。
  packed varint 清單在 Go 解（直接從 mmap 讀），只有結果跨邊界。
* `SearchTokens(path, tokens, groupTag, maxHits)`：一次做完 查詞 → 解 posting（**多詞平行**）→
  `phraseMatch`（plAnd）→ `groupHits`（分群統計），回 `{hits, missing, truncated, groups}` 與各階段耗時。
  切詞仍在 TypeScript（`tokenize.ts` 是語言層），Go 只做索引運算（作者 2026-10 的指示）。
* `DecompressText(path, offset, length)`：**bzip2 有 Go 版就用 Go**（作者 2026-10）。adb 的 source 每個
  block 都是獨立 bzip2 stream，所以標準庫 `compress/bzip2` 剛好夠用；一次呼叫做完**解壓＋UTF-16LE 解碼
  ＋截到第一個 NUL**，回字串（比回 base64 的展開位元組小）。前端 `sourceText` 有宿主就走這條，
  沒有宿主（`file://`）才退回 TypeScript 的 vendored bzip2 —— `host.ts` 就是那個開關。
* mmap 直呼 `kernel32.dll`（`CreateFileMappingW`／`MapViewOfFile`／`UnmapViewOfFile`），不引入 `golang.org/x/sys`。
* **不做任何 adb 解析**（除了 256 位元組檔頭）：沒有事件、沒有 socket、沒有自訂協議。

**為什麼傳 base64 而不是 `[]byte`**：Wails 會把 `[]byte` 序列化成 JSON 數字陣列（約 6 倍大）；base64 只膨脹
1.33 倍，前端用 `Uint8Array.fromBase64`（沒有就 `atob`）解回 bytes。

### 10.3 建置與驗證

```powershell
cd ts; bun run tools/build-viewer.ts                  # 預設產物：../build/accelon26.html（單檔，file:// 可開）
cd ts; bun run tools/build-desktop.ts                 # 只在要桌面版時：同一份 HTML → ../wails/assets/index.html
cd wails; go test ./...                               # Go 單元測試（不需要 GUI）
cd ts; bun run tools/release.ts --no-build           # 打包 exe → D:\accelon26\accelon26.exe（HTML 內嵌）
#   或直接：cd wails; go build -ldflags "-H windowsgui" -o D:\accelon26\accelon26.exe .
cd ..;   .\build\desktop\accelon26.exe -selftest         # 不開 GUI：列工作目錄的 adb + mmap 讀取計時
cd ts; bun run tools/desktop-test.ts [--gui]          # 桌面版回歸：headless 5 項；--gui 再加視窗版 6 項
```

**實測（2026-10，exe 在倉庫根目錄執行，那裡有 13j.adb／fgdict.adb／yinshun.adb）**：

```
`-selftest`（節錄）：
  found 3 .adb file(s):
    佛光大辭典        size=19121862  dbname="fgdict"  dbcname="佛光大辭典"
    十三經            size=2252537   dbname="13j"     dbcname="十三經"
    印順法師佛學著作集  size=24910598  dbname="yinshun" dbcname="印順法師佛學著作集"
  mmap+base64 read: 200 x 131072 bytes = 25.0 MiB input, total 17.7 ms
    88540 ns/op, 1412 MiB/s input, 1882 MiB/s base64 out

tools/desktop-test.ts --gui（11/11 passed，節錄）：
  ok  視窗頁面啟動（desktop host 有回應）  ["佛光大辭典","印順法師佛學著作集（未載入）","十三經（未載入）"]
  ok  下拉已含工作目錄的兩個 adb          ["佛光大辭典","十三經","印順法師佛學著作集"]
  ok  啟動時沒有把每個 adb 都載入（只讀檔頭）1 個已載入
  ok  開第一個 adb 是用 mmap 讀的        reads=17 ioMs=75.8 parseMs=52.3 totalMs=109.8
  ok  從下拉選另一個 adb 會載入它        fgdict → yinshun：wall 206 ms、開檔 110 ms（19 次讀取，io 89.6 ms）
  ok  Go 的 bzip2 與 TypeScript 的 bzip2 對同一批 source block 逐字相同  blocks [0,1,51,101]（第 0 塊 8192 字）
  ok  視窗頁面啟動／下拉已含工作目錄的 adb／啟動只載入 1 個／開檔有 reads+ioMs
  （共 13 項全過；`tools/desktop-test.ts --gui`）
```

**bzip2 兩條路必須等價**：`tools/desktop-test.ts` 拿同一批 source block（13j 的第 0／1／51／101 塊）
分別用 Go 的 `compress/bzip2`（經宿主 binding）與 TypeScript 的 vendored bzip2 解壓＋解碼，**逐字相同**。

### 10.4 效能：mmap 很快，**跨語言邊界才是瓶頸**（實測，別被直覺騙了）

Go 端 mmap+base64：**~1.4 GiB/s**（25 MiB 讀 200 次共 17.7 ms）。但 webview 呼叫一次要過 Wails 的
runtime（JSON + base64 + 訊息傳遞），在執行中的 exe 裡用 `build/probe-bridge.ts` 量到：

| 一次要的位元組 | 每次呼叫耗時 | 有效頻寬 |
|---|---|---|
| 4 KiB | 0.99 ms | 4 MB/s |
| 16 KiB | 1.18 ms | 13 MB/s |
| 128 KiB | 3.16 ms | 40 MB/s |
| 512 KiB | 8.51 ms | 59 MB/s |
| 1 MiB | 16.9 ms | 59 MB/s |
| 4 MiB | 63.4 ms | 63 MB/s |

也就是：**每次呼叫固定成本 ~0.9 ms，之後約 60 MB/s**（base64 字串的搬運與解碼）。開 fgdict 要讀
~2.4 MB 的表 → 桌面 **109.8 ms**（17 次讀取、io 75.8 ms），同一顆庫在瀏覽器走 `Blob.slice` 是 **~49 ms**
（`ioMs` 只有 15 ms，因為 `Blob.slice` 每次呼叫幾乎不用錢）。**桌面版的價值是「啟動就列出工作目錄的庫」
與不用挑檔，不是原始讀取速度**。（要再快就得動這個邊界：加大分塊是「開檔變快、翻頁變慢」的取捨；`BlobIO.CHUNK` 目前 128 KiB 是兩者的折衷。）

**bzip2：Go 的解碼器略快，但「跨語言邊界」讓單塊呼叫變慢**（同一批真實 source block，純解壓、迴圈內無 I/O）：

| 資料集 | TypeScript vendored bzip2 | Go compress/bzip2（單核） | Go 平行 14 核 |
|---|---|---|---|
| 13j 32 塊（0.27→0.50 MiB） | 36.0 ms／14 MiB/s | 30.2 ms／17 MiB/s（中位數 1.01 ms/塊） | 7.6 ms／66 MiB/s（4.0×） |
| yinshun 128 塊（0.97→2.00 MiB） | 136.3 ms／15 MiB/s | 110.7 ms／18 MiB/s（1.00 ms/塊） | 23.1 ms／86 MiB/s（4.8×） |

所以：(1) Go 的解碼器本身只快 **~1.2×**；(2) 但**單塊走 binding 反而慢 2.4×** —— 在 exe 內量到
Go 4.6 ms/塊 vs TypeScript（含 fs 讀取）1.9 ms/塊，差的 ~3.6 ms 幾乎全是運輸（每次固定 ~0.9 ms ＋
把**解壓後**的文字搬過邊界；解壓後的位元組本來就比壓縮後大 2–3 倍）。mmap 本身沒問題：
`BenchmarkReadBase64_128KiB` = 87 µs/128 KiB（1.5 GB/s，in-process）。

**結論／選項**：

| 情境 | 目前最快的路 |
|---|---|
| 單塊（`sourceText` 現在的用法） | **TypeScript 解壓**（傳壓縮位元組、解碼 1.2 ms） |
| 一次很多塊（整份文件預取、搜尋暖機） | **Go 批次＋平行**（128 塊：平行 23 ms ＋ 一次運 2 MiB ≈ 58 ms vs TS 136 ms，約 **2.3×**） |

量測工具（可重跑）：`cd ts && bun run tools/bzip2-bench.ts [--adb … --blocks N]` 把真實 block 寫到
`build/bzip2-blocks/*.bin` 並量 TypeScript 解碼；`cd wails && go test -count=1 -run TestBzip2Throughput -v`
對同一批位元組量 Go 單核／平行（`wails/bzip2_bench_test.go`，另有 benchmark）。
目前程式**照作者指示「有 Go 版就用 Go」**（`hostSource()` 的 `decompressText`）：要讓單塊走回 TypeScript，
把那兩行拿掉即可；要讓 Go 真的贏，需要一個批次 API（Go 平行解壓 ＋ 一次回傳多塊）。

### 10.5 踩到的坑（下一輪別再踩）

1. **`application.BundledAssetFileServer` 不是 `AssetFileServerFS`**：只有前者會在 `/wails/runtime.js`
   提供內建 runtime（後者只服務 assets）。用錯的話頁面照樣跑，但 `host.ts` 的 import 失敗 → 下拉永遠空的。
2. **Wails 會覆寫 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`**（`preventEnvAndRegistryOverrides` 會 `os.Setenv`），
   所以自動化測試要開 devtools 只能從 `application.WindowsOptions.AdditionalBrowserArgs` 傳；
   本專案用環境變數 `ACCELON26_DEBUG_PORT` 開啟，**預設不開任何除錯埠**。
3. **Bun 不會對「未 import 的識別字」報錯**（會當成全域）→ `bootDesktop()` 裡的 `catalogAdd` 忘了 import，
   建置成功、執行時 `ReferenceError`，而且是在 async 裡 → 安靜地什麼都沒發生（下拉空的）。
   修法：補 import ＋ `state().host.error` 讓它能被看見。
4. 更新 HTML 後**必須重跑 `tools/build-desktop.ts` 再 `go build`**：HTML 是內嵌的，只 rebuild 其中一邊不會生效。
5. `wails/assets/index.html` 是**建置產物**（來自 `tools/build-desktop.ts`）；`//go:embed all:assets` 需要它存在。
6. `physicalBytes()`（adb.ts）目前**沒有任何呼叫者**（原本就不存在），所以 Go 端只做 `DecompressText`、
   沒有做回原生位元組的版本 —— 保持 Go 層最薄；哪天真要用再加。
7. **建置順序：先 HTML、再 exe**。exe 內嵌 `wails/assets/index.html`，先 `go build` 才
   `tools/build-desktop.ts` 就會把**舊的 UI**包進去（我踩過：改了左上角提示，exe 裡還是舊版）。
   `tools/release.ts` 已把順序固定住。
8. **Wails 的 DPI/座標系前後不一**：見 §10.8 的「踩到的坑」——螢幕與游標座標在
   `application.New()` 前後會是不同空間，定位一定要用 Wails 自己的 `application.Screen`。
9. **在持有 mutex 時 panic ＝ 永久卡死**：`searchFile()` 把解析結果寫進一個 nil map（`h.search[key] = f`）
   → panic；panic 回溯時 deferred `release()` 又想拿同一把鎖 → 整個 goroutine 卡住，前端
   `Runtime.evaluate` 逾時 60 s。症狀是「頁面看起來沒反應、Go 沒崩」。修法：寫入前先 `make` map；
   教訓是**鎖的臨界區裡不要有可能 panic 的動作**。
10. **Windows 命令列的中文會變亂碼**：`bun run tools/release.ts --items "改名為…"` 經 PowerShell 傳進去
    後，release_notes.json 變成亂碼（而且已經 commit）。**中文一律用 `--items-file notes.txt`**（UTF-8），
    release.ts 也會對亂碼字元發警告並中止。凡是「把中文當參數傳給子行程」都要小心。
11. **`wails3 generate syso` 一定要給 `-arch`**：不給的話它會產生**0 位元組**的 .syso（而且 exit code 0），
    `go build` 連結時看到壞掉的物件就改走 external linker → `loadinternal: cannot find runtime/cgo` ＋
    `gcc not found`（本機沒有 gcc）→ 建置失敗。給了 `-arch amd64` 就正常（67 KiB），`CGO_ENABLED=0` 也能連結。
    release.ts 會檢查檔案大小，太小的直接刪掉（免得下一次建置踩到）。
12. **共用 promise 的探測**：`hostCall()` 原本用 `probed` 旗標，兩個呼叫同時進來時，第二個會在探測
    還沒完成前看到 `probed=true / call=null` → 誤判「沒有宿主」（下拉整個空的）。修法：把探測做成
    一個共用的 promise，所有人 await 同一個。

### 10.8 視窗與螢幕（作者 2026-10）

規則（原文）：「第一次進入 exe 先進入全屏，離開時記下視窗設定，下次恢復；永遠將 exe 投在用戶
執行 exe 的那個屏，如果偵測不到，就在主屏開啟（經常有軟件開已不存在的外接屏）。」

實作（`wails/window.go` ＋ `main.go`）：

* **狀態檔**：`%AppData%\accelon26\window.json`（`RelX/RelY` 相對所在螢幕**工作區原點**、`W/H`、
  `State`＝normal／maximised／fullscreen、`Screen` 上次那張螢幕的名字）；可用環境變數
  `ACCELON26_STATE_DIR` 改寫（自動化測試與可攜版用）。原子寫入（.tmp ＋ rename），壞掉的檔視同第一次。
* **啟動流程**：視窗先建立但 `Hidden: true` → 等 `events.Common.ApplicationStarted`（訊息迴圈與
  螢幕資訊都就緒）→ 選螢幕 → 夾進工作區 → `SetSize`／`SetPosition` → 套用狀態（全螢幕／最大化）
  → `Show()`。所以不會「先出現在錯的螢幕再跳過去」。
* **選螢幕**：啟動瞬間的**滑鼠游標**所在螢幕（雙擊／點執行就是在那一張）→
  `application.ScreenNearestPhysicalRect` 找出對應的 Wails 螢幕 → 拿它的 `WorkArea`；
  游標問不到（外接螢幕被拔掉的座標、拿不到游標）→ 主螢幕 → 第一張。
* **第一次啟動**：全螢幕（`win.Fullscreen()`）；記下的「還原框」是夾進工作區後置中的預設大小。
* **視窗要有標準 Windows 標題列**（作者 2026-10 指出全螢幕時「沒有窗口標題、不能關也不能縮放」）：
  Wails 的全螢幕在 Windows 上是把樣式換成 `WS_POPUP`（**沒有標題列**），所以
  **F11 切換全螢幕、Esc 離開全螢幕**（`ts/src/accelon26/window-keys.ts` → `AdbHost.ToggleFullscreen`），
  離開後樣式回復成 `WS_OVERLAPPEDWINDOW`（標題列／可縮放／可關／可最大化，測試有斷言）。
  第一次以全螢幕啟動時，畫面頂端會出現 7 秒提示：「全螢幕中：按 Esc 或 F11 回到視窗（Alt+F4 關閉）」；
  `#brand` 的 hover hint 也一直寫著「F11 全螢幕／Esc 回視窗」。`WindowInfo().style` 可以看樣式位元
  （caption／resizable／sysMenu／maximizeBox／popupOnly），排錯時先看它。
* **相對位置用「啟動時選的那張螢幕」**算（不是「視窗框最近的那張」）：平台有時會把視窗再挪幾十像素，
  剛好跨過螢幕邊界時「最近的那張」會在兩張之間跳，存下來的相對位置就會在兩個座標系之間擺盪
  （實測：{DISPLAY2,99,0} ⇄ {DISPLAY1,70,38} 交替）。改用啟動螢幕後立刻收斂 ✓。
* **之後啟動**：恢復上次的狀態與框，位置＝工作區原點 ＋ 相對位置，**並夾進工作區**
  （大小不超過工作區、位置不越界）—— 這是「上次在外接螢幕、這回那張不在了」的解藥
  （`clampWindowState`，有單元測試）。
* **離開**：`WindowClosing` 先寫一次（那一刻視窗還在），`OnShutdown` 當保險，`windowTracker`
  只寫一次。追蹤器是**事件驅動**的（移動／縮放／最大化／全螢幕都會更新「最後一次 normal 的框」），
  所以就算 save 時視窗已經銷毀也寫得出來。

**排錯工具**（多螢幕問題先看這兩個）：

* `accelon26.exe -screens`：Win32 列出來的每張螢幕（monitor／work／primary／current／scale）、游標位置、
  Wails 選的啟動螢幕、上次的設定、狀態檔路徑。
* 服務方法 `main.AdbHost.WindowInfo()`（頁面可直接呼叫，**UI 完全不需要知道**）：位置、大小、狀態、
  所在螢幕與工作區、最後一次 normal 的框、狀態檔路徑。

**踩到的坑（座標系，§10.5 第 8 條）**：`w32.GetAllScreens()` 在 `application.New()` **之前與之後**
會回不同的數字（DPI 虛擬化：本機測試環境前後是 1040x693 三張 vs 3120x2080 一張，游標座標也跟著變），
而 Wails 的視窗座標系是後者那一套。所以**定位一律走 Wails 自己的 `application.Screen`**
（`ScreenNearestPhysicalRect` 負責 physical↔DIP 換算），`w32` 只用來列舉與拿游標原始座標（-screens）。

**驗證**（`tools/desktop-test.ts --gui`，共 28 項全過）：

```
ok 第一次啟動是全螢幕                    state=fullscreen 1040x694@0,0
ok 知道自己落在哪張螢幕（含工作區）        screen=\.\DISPLAY1 primary=true work=1040x694@0,0
ok 狀態檔寫在 ACCELON26_STATE_DIR
ok 離開時記下視窗設定                    { "relX":0, "relY":0, "w":1040, "h":694, "state":"fullscreen", "screen":"\\.\DISPLAY1" }
ok 第二次啟動恢復上次的狀態（fullscreen）
ok 恢復記下的大小（夾進啟動螢幕的工作區）  state=normal got 900x694 want 900x694（要求 900x700 → 夾到 694）
ok 恢復的位置在啟動螢幕的工作區內
ok 恢復的位置接近要求                    got (70,0) want (40,0)（平台差 30 px，見下）
ok 連續兩次啟動的視窗設定不會漂移         兩次都是 {relX:70, relY:0, w:900, h:694, state:normal}
```

測試環境的顯示器幾何很怪（三張虛擬螢幕、scale 3.0），平台回報的位置與要求差 ~30 px；**但同一份
設定連續兩次啟動完全相同**（不漂移），所以程式不補正這個常數差，只在啟動時等 60 ms 穩定後讀回來
補一次（不一致才補）。測試因此驗「在工作區內 + 接近要求 + 兩次不漂移」，而不是要求逐像素相同。

關視窗要用真的關閉（頁面呼叫 `Window.Close()`）：硬殺行程不會觸發 `WindowClosing`／`OnShutdown`，
設定就不會被寫下來（測試就是這樣抓到的）。

### 10.7 索引查詢（postings／plAnd／分群）搬到 Go

作者 2026-10：「把 plAnd、posting group 也做 go 版，這樣 TypeScript 直接取得詞 posting 和分群統計；
計算量大的函式，可以做 Go 平行版。」

**為什麼是「整條查詢」而不是單獨搬 plAnd／groupHits**：Go 端在 mmap 上解 posting 幾乎免費
（實測 yinshun「大乘」：lookup 0.5 ms（平行）／plAnd 0.5 ms／group 0.0 ms），真正花時間的是
**跨語言運輸**。所以做成一個呼叫（`SearchTokens`）只把命中與分群統計送回 TS；若只搬 plAnd，
反而得先把整份 posting 清單送過去，一定更慢。

**等價性**（`ts/tools/desktop-test.ts --gui`，同一顆庫、同一個查詢；hits 逐筆、groups 逐欄比對）：

| 案例 | hits | groups | TypeScript 引擎（本地 fs） | Go 一次呼叫（含運輸） |
|---|---|---|---|---|
| 13j「象曰」 | 446 | 13/13 | 1.5–1.8 ms | 3 ms |
| 13j「孟子」 | 316 | 13/13 | 0.4–0.6 ms | 2 ms |
| yinshun「大乘」 | 5,000 | 44/44 | 3.5–12 ms（JIT／快取暖不暖差很多） | 6–7 ms |
| yinshun「般若波羅蜜」 | 1,848 | 44/44 | 1.5–4.2 ms | 5 ms |

**讀數（誠實版）**：
* Go 的解壓是**平行**的（`parallel=true`，yinshun「大乘」內部 lookup 1.1 ms／plAnd 1.1 ms／group 0.0 ms），
  所以清單大時有優勢；但**每次呼叫固定約 2 ms 的運輸**讓清單小的查詢（13j）反而慢一點。
* 表上的 TS 數字是**本地 fs**（SyncIO，暖快取）量的，那是 TS 最有利的條件；桌面版若走 TS 路徑，
  還得用 `ReadBase64` 把每個 packed posting block 搬過橋（「大乘」兩個 block 約 100 KB，約 +4 ms），
  所以桌面上兩條路大致打平、清單大時 Go 明顯佔優。
* 真正的結構性好處：**posting 清單不必跨邊界**（只有命中與分群統計過去）、少很多次往返、
  而且解壓在 Go 的 goroutine 上，不佔 JS 主執行緒。

**在視窗裡實測**（`--gui` 斷言）：輸入「大乘」→ `state().hostSearch` 有值（hits 5,000、8.3 ms，
Go 內部 lookup 1.1／plAnd 1.1／group 0.0）、摘要 30 筆、「分 28 群（依 書）」——UI 真的走這條路，
不是只有直接呼叫 binding。
Go 端的自我檢查（不開 GUI）：`cd wails && go test -count=1 -run TestSearchTokensOnCorpus -v`
（對 13j 的「象曰」446 筆／13 群、「孟子」316 筆／13 群，並印出 `Postings` 的筆數）。

### 10.9 左上角建置時間與線上更新（作者 2026-10）

作者原文：「accelon26.exe 改名…左上角 hover hint 顯示 built time。如果
https://shutonggui.cn/accelon26/accelon26.exe 的 built time 比用戶運行中的更新，左上角閃動
表示有更新版提醒用戶更新，用戶點下時，問是否確定更新（先檢查 exe 所在目錄是否可寫，不可寫就
永遠不檢查是否有更新；如果目前運行的 exe built time 和電腦時鐘差別不到 2 小時，表示是開發者
本地 exe，就不必檢查更新了），更新後，顯示改版新增或改進的功能。」

**改名**：exe 與應用識別都改成 `accelon26`（`D:\accelon26\accelon26.exe`、視窗標題、
`%AppData%\accelon26\window.json`）；環境變數改成 `ACCELON26_*`。單檔 HTML 產物也跟著改成
`build/accelon26.html`（作者 2026-10：不要讓讀者在 `accelon26.html` 與 `accelon26.exe` 之間猜），
工具的預設路徑與測試一起改。**viewer 模組本身仍叫 accelon26**（`ts/src/accelon26/`）—— 那是同一份
UI，兩個宿主共用；桌面版內嵌的那一份仍叫 `wails/assets/index.html`（`go:embed` 的要求）。

**建置時間**（`wails/update.go`）：發佈時用 `-ldflags "-X main.buildTime=<RFC3339>"` 注入；
沒注入就退回執行檔的修改時間（`buildSource=file`，hover hint 會註明「檔案時間，非發佈建置」）。
線上的版本資訊**優先看 `versions.json`**（2026-10-18 加上，主機已放好）：

1. `GET https://shutonggui.cn/accelon26/versions.json` → `{ buildTime, url, size, sha256 }`；
   用 `buildTime` 比新舊（遠端要新至少 1 分鐘），`sha256`／`size` 拿來驗下載的內容。
2. 沒有 versions.json（舊主機）才退回 `HEAD accelon26.exe` 的 `Last-Modified`。
   這是 **fallback**：`Last-Modified` 是**上傳時間**，跟 exe 裡的建置時間不一定一致
   （2026-10-18 實測差 11 秒；上傳慢一點就會「更新完又說有新版」），所以不要靠它。

**不檢查更新的兩種情況**（都不打擾使用者）：
1. **exe 所在目錄不可寫**（真的寫一個暫存檔測試）→ 永遠不檢查；
2. **本地建置時間與現在差不到 2 小時** → 開發者自己的 exe（自動化測試用
   `ACCELON26_UPDATE_URL` 覆寫網址時會強制檢查，否則測不到）。

**UI**（`ts/src/accelon26/update-ui.ts`，透過 `host.ts` 對話；UI 完全不知道 Go 層）：
* 左上角 `#brand`（accelon26）的 hover hint ＝`accelon26 · built 2026-10-16 22:10 · …`
  （有新版時再加上「有新版本：線上 … — 點這裡更新」）；
* 有新版 → `#brand.update` **閃動**（CSS `brandFlash`）＋ 可點擊 → `window.confirm` 問一次；
* 更新後第一次啟動（帶 `-updated-from`）→ 顯示**改版說明**（`#notesBox`），內容來自
  `wails/release_notes.json`，只顯示比舊版新的那幾筆。

**更新流程**（`InstallUpdate`）：下載到 `<dir>/accelon26.exe.new`（先 `.part` 再改名）→
**五道關卡**，任何一道不過都丟掉下載檔、不動使用者手上那一顆：
`size` ＝ versions.json → `sha256` ＝ versions.json → 檔頭 `MZ` 且 ≥ 1 MiB →
跑一次 `new.exe -version` 解得建置時間 → 那個時間比目前新 → 把**執行中的** exe 改名成
`.old`（Windows 允許改執行中映像的名字，但不能覆蓋）→ `.new` 改名成正式名字 → 啟動新 exe
（帶 `-updated-from` 與 **＋1 的除錯埠** `-debug-port`，避免兩個行程搶同一個埠）→
**觀察 2 秒**：新版若馬上結束就把 `.old` 換回去（回報「新版啟動後馬上結束，已還原舊版」）；
還活著就 0.7 秒後自己結束。`.old` 在新版啟動時自動清掉。
觀察窗刻意短：新舊兩個行程同時活著時共用 WebView2 的資料目錄，重疊越短越安全
（代價是「起來後三秒才崩」抓不到，目前接受）。
`InstallUpdate` 有鎖（`installMu.TryLock`），連點兩次只會有一次真的動手。

**exe 放哪裡／怎麼建**（作者 2026-10）：exe **一律放到 `D:\accelon26\`**，用 **GUI 子系統**
（`-ldflags "-H windowsgui"`）建置 —— 這樣 **Explorer 雙擊不會跳出命令列視窗**。
console 版（看得到 log，開發用）加 `--console`。

**發佈（作者說「發布」時）**：

```powershell
cd ts; bun run tools/desktop-test.ts --gui                    # 發布前跑一次桌面回歸（慢，平常不跑）
cd ts; bun run tools/release.ts --items-file notes.txt        # 一行一項（UTF-8，中文請用這個）
# 或 bun run tools/release.ts --items "ascii-only;…" [--title "…"]
#  1) append 到 wails/release_notes.json  2) 先建 HTML 再 go build（-ldflags 注入建置時間）
#  3) 用 -version 驗 exe 裡真的是 ldflags 的時間  4) 印上傳指示並 HEAD 一次線上的 Last-Modified
# 然後把 build/desktop/accelon26.exe 上傳到 https://shutonggui.cn/accelon26/accelon26.exe
```

**圖示**（作者 2026-10：「用 logo128.png 做成 exe 和網頁版的 icon」）：

* **來源只有一份**：`ts/src/accelon26/appicon.png`（原本是倉庫根目錄的 logo128.png，已搬進 viewer 模組）。
* **exe 圖示**：`release.ts` 用 `wails3 generate icons` 產生 `build/windows/icon.ico`，再用
  `wails3 generate syso -arch amd64 -icon … -manifest wails/windows.manifest` 產生
  `wails/accelon26.syso`（go build 會自動連結這個資源物件）。`.syso` 是建置產物（gitignore）。
  manifest 宣告 per-monitor v2 DPI 感知、longPathAware、Common-Controls、Win10/11 支援。
* **網頁版圖示**：`page-build.ts` 把同一張 PNG 以 **data URI** 內嵌成 `<link rel="icon">`
  —— 單檔 HTML 不能依賴旁邊的檔案，data URI 才真的「一個檔案帶著走」（+19 KiB）。
* 驗證：`ExtractAssociatedIcon` 從 exe 取出 32×32 圖示（與來源相同）；網頁版在瀏覽器測試裡斷言
  `link[rel=icon]` 是 PNG data URI 且頁面標題是 accelon26。

**診斷**（`D:\accelon26\accelon26.exe -version`）（建置時間／說明筆數／更新網址）、`main.AdbHost.AppInfo()`、
`CheckUpdate()`（立刻檢查一次）、`InstallUpdate()`、`ReleaseNotes(since)`。

**驗證**（發布時才跑）：`tools/desktop-test.ts --gui` 42 項全過，其中更新相關：

```
ok 檢查到線上版本比較新（Last-Modified）      本地 2026-10-16 22:00 vs 線上 2026-10-17T14:00
ok 目錄可寫 → 允許更新；線上網址就是設定的那個   dirWritable=true canUpdate=true
ok 左上角 hover hint 顯示建置時間             accelon26 · built 2026-10-16 22:00 · …
ok 左上角閃動並提示有新版本                    update｜… 有新版本：線上 2026-10-17 14:00 — 點這裡更新
ok 更新後舊行程結束（交給新版）                exit 1（2 s）
ok 執行檔已被新版取代（mtime 變新）
ok 留下 .old（下次啟動自動清掉）＋ 新版啟動時把它清掉
ok 更新後顯示改版說明（notesBox）
```

Go 單元測試（`wails/update_test.go`）：目錄可寫／不可寫、遠端較新／較舊／沒有 Last-Modified／
連不上、開發者本地 exe 跳過檢查、下載＋PE 檔頭檢查、改版說明過濾與 fallback。
測試用**本地 HTTP 伺服器**當「已發佈的新版」（`ACCELON26_UPDATE_URL`），被更新的 exe 是
`build/tmp-upd` 的副本，所以不連外網、也不會動到正式的 exe。

### 10.6 檔案


| 檔案 | 角色 |
|---|---|
| `wails/main.go` | Wails 應用（極薄）：內嵌 assets、`-selftest`、註冊 `AdbHost`、`ACCELON26_DEBUG_PORT` |
| `wails/adbhost.go` | mmap + `ListAdbs`／`Open`／`ReadBase64`／`Close`／`CloseAll` |
| `wails/decompress.go` | bzip2（`DecompressText`）：解壓＋UTF-16 解碼一次做完 |
| `wails/search.go` | 索引查詢：容器表解析、packed posting 解壓、`phraseMatch`（plAnd）、`groupHits`（分群，可平行） |
| `wails/window.go` | 視窗與螢幕：狀態檔、啟動螢幕選擇、夾進工作區、事件驅動的追蹤器、`-screens` 診斷 |
| `wails/update.go` | 建置時間、目錄可寫偵測、線上檢查（Last-Modified）、自我更新、改版說明 |
| `wails/release_notes.json` | 各版改版說明（發佈時用 `tools/release.ts` 追加） |
| `ts/src/accelon26/update-ui.ts` | 左上角提示／閃動／確認／改版說明（UI 端唯一碰更新的一支） |
| `ts/src/accelon26/appicon.png` | 應用圖示（唯一來源）：exe 圖示與網頁 favicon 都用它 |
| `ts/src/accelon26/window-keys.ts` | F11／Esc 全螢幕切換與全螢幕提示 |
| `ts/tools/page-build.ts` | 單檔 HTML 的組裝（bundle ＋ favicon data URI），兩個建置腳本共用 |
| `wails/windows.manifest` | Windows manifest（DPI／longPath／Common-Controls），給 generate syso 用 |
| `ts/tools/release.ts` | 發佈：追加說明 → 先 HTML 再 exe（注入建置時間）→ 驗證 → 上傳指示 |
| `wails/adbhost_test.go`／`decompress_test.go`／`search_test.go`／`window_test.go`／`bzip2_bench_test.go` | Go 測試與量測 |
| `wails/adbhost_test.go` | Go 測試：檔頭解析、與 `os.ReadFile` 逐位元組相同、越界報錯、讀取計時 |
| `wails/assets/index.html` | 內嵌的 accelon26（由 `ts/tools/build-desktop.ts` 產生） |
| `ts/src/accelon26/host.ts` | 唯一知道宿主存在的地方（動態 import runtime → `AdbSource`） |
| `ts/tools/desktop-test.ts` | 桌面版回歸（headless `-selftest` ＋ `--gui` 的 WebView2/CDP 檢查） |
| `ts/tools/build-desktop.ts` | 把同一份單檔 HTML 寫進 `wails/assets/` |

---

## 11. 操作導覽（作者 2026-10）

目的：**取代人類手把手教新手**。劇本是資料（人可讀可編），宏是產物（人不可讀），
播放器內建在 HTML 裡，一場景一停，由使用者決定要不要往下。

```
ts/tour/*.tour  ──build-tours.ts──▶  src/accelon26/tour-data.ts  ──build-viewer──▶  accelon26.html
   (Markdown 方言)                     (base64 二進位宏，進版控)                     (宏 ＋ 播放器)
```

### 11.1 為什麼這樣分三層

| 層 | 理由 |
|---|---|
| 劇本用 Markdown 方言，不用 JSON | 要「可編」：能寫段落、加註解、diff 看得懂。JSON 的標點門檻會讓人寫第二份時就放棄 |
| 宏用二進位 ＋ base64 | 單檔 HTML 在 file:// 讀不到旁邊的檔案（§4.1），所以**只能內嵌**；同時讓「改 DSL」不必動播放器，也讓手滑編輯不會弄壞產品（這是妨碍順手改，不是加密） |
| 播放器只認 opcode | 它不 import 任何面板模組（`initTour(app)` 注入動作），所以不會有 ui → tour → ui 的循環 |

### 11.2 三個不能忘的約束

1. **等待一律條件式**（`等頁面 count:#searchList .snippet >= 1`）。開庫、目錄樹、清單分批掛載
   全是非同步的；固定 `等 1500` 在慢機器上就是隨機失敗。播放器輪詢 100 ms，逾時就**停在原地**
   並顯示「等不到 X」，不會靜默往下走。
2. **聚光燈不擋操作**：`#tourSpot` 是 `pointer-events:none` 的 `box-shadow: 0 0 0 9999px`，
   所以整場導覽期間頁面都還能用（「你來」那幾步更是必須如此）。
3. **檔案對話框不能自動化**：開檔那一步永遠是 `你來`（等 `api:db` 成立就自動過關，
   所以桌面版已經開好庫時這一步是零秒）。

### 11.3 格式（`tour-format.ts`，改編碼就要 `TOUR_FMT+1`）

```
"AC26T" u8 fmt u8 flags u32 crc32(payload)
str id | str title | str intro | str require | u16 場景數
  場景：str title | str 說明(Markdown) | u16 步驟數
    步驟：u8 opcode | u8 參數個數 | 參數 × str(u16 長度 + UTF-8)
```

`str` 一律 u16 長度；數字當字串存（`"400"`），少一種型別就少一處錯。
CRC 壞掉、magic 不對、版本不合都給人話訊息（不是播到一半亂掉）。

### 11.4 播放器的狀態機

```
play(id) → running ──step ok──▶ running
              │                  │ 場景最後一步
              │                  ▼
              │              waiting（說明文字 ＋「下一個場景 →」）
              │                  │
              └─ 失敗／需要 ──▶ paused（「略過這步」「重播」「結束」）
```

* 換場景／重播／上一場景都是「重新開一場」（`seq++` 讓舊的迴圈自然結束），不維護半途堆疊。
* 進度存在 `accelon26.tour.<id>`，選單的按鈕會變成「繼續（3 / 10）」。
* 鍵盤：`→`／空白 下一場景、`←` 上一場景、`Esc` 結束 —— 掛在 **window capture**（比 document 的
  capture 先收到），但**有彈窗時讓彈窗先處理 Esc**。
* 入口：**「關於」（左上角 `accelon26`）→「▶ 操作導覽」**（作者 2026-10-18：原本是頂欄的 🎬）。
  「關於」預設**啟動時顯示**（`accelon26.about.startup`，勾掉就不再自動彈），所以第一次開就會看到入口。
  `__accelon26.playTour/stopTour/tourState/openTourMenu` 供測試。

### 11.5 寫一份新劇本

看 `ts/tour/README.md`（語法、指令表、條件語法、六個常見錯誤）。摘要：

```markdown
### 查一個詞
左上「目錄」分頁的輸入框就是搜尋框：**邊打邊查**。

> 指向 #query
> 輸入 #query => 之
> 等頁面 count:#searchList .snippet >= 1 20000
> 說 每一筆是一句上下文，命中的字有顏色。
```

然後 `bun run build:tours`（編譯＋靜態檢查）→ `bun run tools/build-viewer.ts` → `bun run test:tour-ui`。

編譯器會擋：不認得的指令、參數個數不對、`#id` 不在 template、`data-tab` 打錯、
`api:` 路徑不在白名單、`@id` 與檔名不一致。**打錯的選擇器是導覽最常見的死法**——
它不會讓程式壞掉，只會讓導覽默默指著空氣。

### 11.6 這一輪抓到的兩個真問題（測試的價值）

1. `指向 #setVariants` 之後直接 `點 #settingsClose`：彈窗一關，聚光燈就照在空氣上，
   氣泡還顯示「⚠ 找不到」。修法：**關彈窗前先 `不指向`**（`#allSearchList` 同理）。
2. 「查一個詞」場景原本沒有 `若非` 守衛，在 fgdict（沒有「目錄」分頁）上整場指著
   0×0 的 `#query` 跑完，卻一步都沒報錯 —— 現在每個依賴 `s="*"` 的場景都第一行守衛。

### 11.7 檔案

| 檔案 | 角色 |
|---|---|
| `ts/tour/*.tour` | 劇本（人寫的） |
| `ts/tour/README.md` | 劇本語法與指令表 |
| `ts/tools/build-tours.ts` | 編譯器：剖析、靜態檢查、產生 `tour-data.ts`（`--check`） |
| `ts/src/accelon26/tour-format.ts` | opcode 表、編解碼、CRC32、base64 |
| `ts/src/accelon26/tour.ts` | 播放器：聚光燈、氣泡、條件、狀態機、鍵盤 |
| `ts/src/accelon26/tour-data.ts` | 產物（不要手改） |
| `ts/test/tour.test.ts` | 編解碼／剖析器／同步（31） |
| `ts/tools/tour-test.ts` | 真瀏覽器全播（29／庫） |

### 11.8 2026-10-18 作者回饋的調整（都已實作、都有測試）

| 回饋 | 做法 |
|---|---|
| 場景 1 跳太快 | 新增 opcode `停`（`tap`，16）：停在原地，等使用者在**畫面任何地方點一下**（或空白／→／Enter）才繼續。場景 1 每一步後面都加了 `停` |
| 「＋ 加入 adb」太暗 | 聚光燈的壓暗 `rgba(0,0,0,.55)` → `.40` |
| 氣泡要亮、字要大 | 底色 `#31353f`（比面板亮一階）、說明 16.5px、場景主題另立 `#tourTitle` 18px 粗體 、按鈕 14px |
| 要能回上一個場景 | `← 上一場景` 永遠顯示（第一個場景只是 disabled） |
| 🎬 移到 About | 頂欄移除 `#tourBtn`；About 加「▶ 操作導覽」 |
| About 啟動時顯示 | 新增勾選框 `#aboutStartup`（`accelon26.about.startup`，預設開）；`showAboutOnStartup()` 在 boot 最後呼叫 |
| 頂欄更緊湊 | `.sideToggle` 左右 padding 9px → 5px |
| 字級每次 1px | `FONT_STEP` 2 → 1 |
| 字級只調清單與內文 | `#colLeft/#colRight` 固定 13px；`--fs-left/right` 只套在 `.scrollArea`／`#tokenRows`／`.dictList`（`.dictItem`/`.dictHead` 改成 em）。分頁按鈕、搜尋列、迷你按鈕、`#docTabs` 都不再跟著縮放 |
| `#freqClear` 不需要 | 移除（`wireOwnSearch` 傳 null 元素本來就安全） |
| `#termsCount` 移進 `termsMode` | 按鈕改成 `開頭 <span id="termsCount">5</span>`；只放**數字**（不再寫「個詞條」），一般與進階模式都顯示 |

---

## 12. 官網（www/，作者 2026-10-18）

一頁、無第三方依賴：沒有 CDN、沒有字型檔、沒有框架。`index.html` 內嵌 CSS 與十幾行 JS，
圖片是四張 gallery 用的 JPEG。

```
www/
  index.html        一頁官網：特色 → 畫面 → 下載與安裝 → 聯絡
  img/search.jpg    全文搜尋（13j，君子 1,137 筆）
  img/dict.jpg      詞典（fgdict，般若）
  img/allsearch.jpg 一次搜尋所有資料庫
  img/tour.jpg      操作導覽（聚光燈＋氣泡）
  img/appicon.png   favicon（與 exe 圖示同一份來源）
  accelon26.7z      下載檔（**不進 git**，由 release.ts 產生）
```

| 事項 | 指令／做法 |
|---|---|
| 重拍截圖 | `bun run tools/site-shots.ts`（1600×1000 ×1.5 → 2400×1500 JPEG q88）。UI 改了就跑一次，官網的圖才不會過時 |
| 產生下載檔 | `bun run tools/release.ts`：建好 exe 之後順便打包 `www/accelon26.7z`（7-Zip ultra，17 MB → 7.1 MB）。找不到 7-Zip 就跳過並提示 |
| 部署 | 把 `www/` 整個目錄上傳（含 7z）。伺服器要送 `Last-Modified`：頁面上的「更新於 …」與程式自己的更新檢查都靠它 |
| 頁面上的安裝說明 | 解開 7z → 把 `accelon26.exe` 放到 **accelon3.exe 同一個資料夾** → 雙擊。打不開 7z 就到 https://sparanoid.com/lab/7z/ 下載 Windows x64 版 |
| 開發者聯絡 | 微信 **Sukhanika**（官網頁尾與「關於」都有；`#aboutWechat` 有測試顧） |

設計上的取捨：整頁只有一個大按鈕（下載），其餘都是「為什麼要用它」。圖片用
`loading="lazy"` ＋ 固定寬高，所以就算圖還沒載入版面也不會跳。

### 12.1 截圖時發現的一件事（待查，非官網問題）

換資料庫時，**前一個庫的本文分頁與內文可能還留在中間**（`#docTabs` 沒有被清掉）。
在 `openFile` 換庫後一兩秒內還看得到；`openFile` 的 `finally` 只清 DOM 的 strip、
不動 `docTabs` 狀態。懷疑是「點擊後的非同步載入在換庫之後才落地」的競態
（`ensurePage` 完成時沒有再檢查自己還屬於哪個庫）。
官網截圖工具因此每個資料庫都 `Page.reload` 一次，拍到的畫面才乾淨。
