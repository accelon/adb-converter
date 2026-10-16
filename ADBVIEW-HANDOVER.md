# adbview 交接文件（2026-02，給下一個對話）

純瀏覽器 `.adb` 檢視器原型。**單檔 HTML，可從 `file://` 雙擊開啟**，無伺服器、無 sidecar、無 npm 依賴。
所有資料來自 `Blob.slice().arrayBuffer()` 隨機讀取。

> 本輪（2026-02 後半）依作者指示改了目錄區與本文區的行為，並修好三個資料庫的
> 瀏覽器測試。三項需求的規格寫在 §2，實作重點與踩到的坑在 §8。
>
> **狀態：暫停等作者測試回報。** 目前 13j 64/64、yinshun 68/68、fgdict 68/68
> （最後一輪只驗 fgdict，依作者指示）。可用版本＝ `build/adbview.html`（單檔，
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
> **測試**：13j **73/73**、yinshun **82/82**、fgdict **85/85**；`check-map-ids.ts` 79/79。

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

# 建置（產出 ../build/adbview.html，約 170 KiB 單檔）
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
bun run test/adbview.test.ts --adb ..\13j.adb
bun run test/search.test.ts --adb ..\13j.adb
bun run test/search.test.ts --adb D:\accelon3\yinshun\yinshun.adb
bun run test/tree.test.ts                     # 13j + yinshun 兩庫
bun run tools/verify-vapa.ts --adb ..\13j.adb --max-hits 2   # VA 對帳（13j 需 100%）
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

  **狀態列只顯示錯誤與「讀取中」**（作者 2026-10「取消 span.status（用戶不需要此信息）」）：
  `setStatus(msg, 'info')` 不再寫進 DOM（`#status` 設 `hidden`），但訊息仍記在 `lastStatus`，
  `__adbview.status()`／`state().status` 讀得到，所以測試與診斷不受影響。載入後的
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

## 3. 檔案地圖

| 檔案 | 角色 |
|---|---|
| `ts/src/adbview/adb.ts` | 格式核心。`AdbIO.read(offset,length)` 是唯一原語；`BlobIO`（瀏覽器，含 **128 KiB 區塊快取**）／`SyncIO`（Bun）。容器／長度表／名稱表解析、`tokens()`、`documents()`、`attributeValues()`、`decodeUtf16()` |
| `ts/src/adbview/vapa.ts` | **VA↔PA 映射器**。`init()`、`elementAt`、`lineSpans`、`phraseSpans`、`textOfVaSpan`、`nodeLabel`、`lineLengthPercentile`、**`lineLengthMaxUnder`**、**`edgeLine`**、`loadAnchors`、`validate` |
| `ts/src/adbview/search.ts` | 搜尋：`loadTrees`（`<樹>`）、`parseScope`／`parseTiers`、`loadInstanceAttrs`、`loadTree`、`buildTree`／`flattenTree`、`phraseMatch`、`searchSummary`、`SearchSession` |
| `ts/src/adbview/viewer.ts` | UI（原生 DOM）：左欄目錄樹／頻次／西文／token，**中間本文分頁＋分頁（page）**，右欄摘要。本文區核心是 `DocSession`／`linkTo`／`ensurePage`／`renderDoc`。**已 2701 行，正在拆**（見下） |
| `ts/src/adbview/paint.ts` | **塗紅**：`markPhraseInLine`／`markPhraseOnPage`／`paintHit`（自 viewer.ts 拆出，依賴 `docSession`／`mapper`／`scrollToVa`／`scheduleCursorSync`） |
| `ts/src/adbview/adbview.template.html` | 版面與 CSS（由 build 內嵌）。`#docTabs`／`#docPager` 是本文分頁與上下頁 |
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
| `viewer.ts` | 狀態宣告、`openFile`、wiring／boot、`window.__adbview` | ✅ 入口 |

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
4. **測試用的 `window.__adbview` 必須延後建立**（包成 `installDebugApi()`，在 `boot()` 最後呼叫）：它是 top-level 讀取所有模組的 binding，循環 import 下會踩 TDZ（症狀：`ReferenceError`、`__adbview` undefined）。
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

UI：`#dbAdd`＝固定在 chip 列左邊的「＋」（`#file` 選完就隱藏，`display:none`）、
`#dbTabs`＝每個已開庫一個 chip，**最後開啟的放最左邊**（作者 2026-10），其餘維持相對順序（切換只改顏色，不重排）、
**只有 active 的 chip 顯示 ✕**（關閉該庫＝連同它所有本文分頁）。chip 字級 13px 固定，不隨 active 變。
切換／關閉後由 `ui.ts` 的 `refreshAll()` 重畫（每個 pane 交給自己的 `showTab()` 重跑）；全部關完呼叫 `clearDbUi()`。

**最右上的下拉 `#dbPick`**（作者 2026-10「最右上邊一定要有一個 dropdown」）：列出**這次工作階段選過／拖過的每一個 adb**，
只讀 header（`catalogAddFile()` → `AdbReader.open(new BlobIO(file))`，幾 KiB）所以**未載入的庫也在清單裡**，字尾標「（未載入）」；
同名不同檔（13j.adb 與 1839.adb 都是十三經）會補上檔名 `十三經｜1839.adb`。選一個就加入 `dbTabs`：已載入的直接切換，
未載入的當場載入。**沒有「拒絕」了**：`MAX_DBS = 5` 滿了就讓**最久沒用**的那個 slot 讓位（它的本文分頁跟著消失，跟按 ✕ 同義）。
瀏覽器版不能列資料夾，所以來源只有使用者自己選的檔；未來的 wails3 版會自動列出與執行檔同資料夾的 adb（同一份清單模型即可）。

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
`window.__adbview.growTree()` 先把整棵樹掛完再斷言（見 `file-protocol-test.ts` 的「目錄樹分批掛上 DOM」）。

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

### 3.1 分區名稱與 id（溝通時直接用；示意圖 [adbview-map.html](adbview-map.html)）

| 統一稱呼 | 選擇器 | 備註 |
|---|---|---|
| 頂欄 | `#header` | `#toggleLeft`／`#toggleRight`／`#advToggle`／`#file`（隱藏）／`#dbAdd`（＋）／`#dbTabs`（庫名 chips）／`#status` |
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

**維護規則**：改版面（新增／刪除／改名任何 id）時，同一輪必須更新 `adbview-map.html`，並跑
`bun run tools/check-map-ids.ts`（雙向比對示意圖與 `build/adbview.html` 的 id 集合，不一致就 exit 1）。
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
細分可用 `window.__adbview.openBreakdown()` 或 `state()` 取得（狀態列只顯示人看得懂的資訊）。

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
| `file-protocol-test.ts`（13j） | **78/78** |
| `file-protocol-test.ts`（yinshun） | **78/78** |
| `file-protocol-test.ts`（fgdict） | **90/90** |
| `test/tree.test.ts` | 40/40 |
| `test/search.test.ts`（13j） | 19/19 |
| `test/adbview.test.ts` / `test/vapa.test.ts` | 22/22、13/13 |

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
* **本輪新增**：狀態列只顯示錯誤／忙碌（載入後 `#status` 是空的，`__adbview.status()` 仍記得最後訊息）
* **本輪新增**：餵非 .adb → 狀態列顯示「開啟失敗」，原本的庫不受影響，而且不丟例外
* **本輪新增**：沒有 `s="*"` 的庫完全不建樹（`treePhases.instances = 0`）

## 7. 待辦事項

### P0 — 已解決

1. ~~fgdict 的 6/7 本書名取不到~~ → 已用 `caches/書`（7 個書名，實例序）解決；
   `loadTree` 的 20,000 標籤預算會切掉後面的節點，所以第一層標籤另外從快取補一次。

### P1 — 未實作的規格

2. **`$詞` 分頁**（fgdict）：分段＝`<詞>` 的 22,648 個實例，命中＝落在段內者，段名＝包裹的 innerText。
   **`*詞` 與 `$詞` 在現有實作會相同** —— 需向作者確認 `*詞` 是否要求「命中從詞首開始」。
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
  先確認 `build/adbview.html` 的內容（例如 `Select-String` 找一個新字串），
  並讓測試用 `?v=Date.now()` 開啟頁面（file-protocol-test.ts 已加了）。
* **重複宣告會靜默蓋掉新函式**：`viewer.ts` 曾經同時有兩個 `revealHit`，
  舊版把新版的 `linkTo` 整個蓋掉，浪費了一輪除錯。改完先用
  `bun build src/adbview/viewer.ts --target browser --outfile build/_check.js` 轉譯一次。
* **繪圖是非同步的**，測試請輪詢「結果特徵」而不是固定 `setTimeout`；
  也不要輪詢「本來就非空」的元素（舊版的頻次斷言就是這樣讀到舊值的）。
  本輪新增：**比對 `state().pinned` 的 VA** 比比對 DOM 的 `.hitLine` 穩定
  （換頁時 DOM 會先換行、後塗紅）。
* **`#freqQuery`／`#latinQuery` 曾經完全沒有 handler**（輸入了不會重畫）。
  現在 `boot()` 用 `wireOwnSearch` 接上 input／Enter／Escape／清除鈕。
* CDP 啟動參數必須含 `--remote-allow-origins=*`，否則 websocket 握手失敗。
* 測試用的診斷入口都在 `window.__adbview`（`state()`、`openBreakdown()`、`fitDebug()`、
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
