# Accelon26 系統架構

> 一份 adb 閱讀器：同一份 HTML 同時跑在 **file://**（雙擊開啟）與 **Wails3 桌面版**（Go 宿主）。
> 唯一差別在「資料從哪裡來、查詢在誰那裡算」；其餘 UI／渲染／搜尋語意完全共用。
> 最後更新：2026-10（改名 adbview → accelon26 時）。

---

## 1. 兩種模式的一句話對照

| | **file:// 模式** | **Wails3 模式** |
|---|---|---|
| 取得 | 使用者雙擊 `build/accelon26.html` | 啟動 `accelon26.exe`，Go 把同一份 HTML 內嵌後載入 WebView |
| 資料來源 | `File` 物件 → `Blob.slice()`（`BlobIO`） | 工作目錄的 `.adb` 路徑 → 宿主 mmap 讀取（`host.ts`） |
| 誰有 adb | **使用者自己加**：`#file` 選檔 / 拖放 | **啟動就列出**：`main.AdbHost.ListAdbs` → `catalog` |
| 解壓 bzip2 | 內嵌 JS bzip2（`adb.ts: bunzip`） | 宿主 `DecompressText`（Go `compress/bzip2`，一次呼叫回字串） |
| 查詢引擎 | TS（`SearchSession.clauseHits`） | Go（`main.AdbHost.SearchQuery`，`wails/query.go`） |
| 目錄頂欄 | `#file` ＋ 下拉第一項「加入 adb」 | 下垃沒有「加入 adb」（已列出工作目錄） |
| 其他 | — | About／更新檢查／F11 全螢幕都經宿主 |

`host.ts` 是**唯一**知道宿主存在的模組；它把宿主包成跟 `File` 同形的 `AdbSource`，
所以 pane／樹／分頁／詞典的程式碼一律不需要判斷「我是不是桌面版」。

---

## 2. 分層

```
            ┌──────────────────────────── UI（DOM） ────────────────────────────┐
            │ ui.ts 頂欄/欄寬/設置   panes.ts 分頁   doc-pane.ts 本文分頁        │
            │ scopes.ts 左欄五頁   summary.ts 摘要   text-pane.ts 右欄文字       │
            │ dict-pane.ts 詞典   allsearch.ts 搜尋所有 adb   about/update-ui    │
            └───────────────┬───────────────────────────────┬──────────────────┘
                            │ 只呼叫下面兩層                │
            ┌───────────────▼──────────────┐  ┌─────────────▼──────────────────┐
            │ 查詢：backend.ts（唯一入口）  │  │ 讀取/渲染：vapa.ts mapper      │
            │  searchAutoVia / queryBackend │  │  render_accelon3.ts 標籤渲染    │
            └───────┬──────────────┬───────┘  │  search.ts SearchSession        │
                    │              │          │  paint.ts 塗紅  link.ts 跳頁    │
             ┌──────▼─────┐  ┌─────▼──────┐   └─────────────┬──────────────────┘
             │ TS 引擎     │  │ Go 引擎     │                 │
             │ search.ts   │  │ wails/query │                 │
             └──────┬─────┘  └─────┬───────┘                 │
                    └──────┬───────┴──────────────────────────┘
                    ┌──────▼──────────────────────────────────┐
                    │ adb.ts：AdbReader（容器/區塊/bzip2）      │
                    │ AdbSource = BlobIO（file://）| host 路徑  │
                    └──────────────────────────────────────────┘
```

**不變式**
- `reader` / `mapper` / `session` 是**當前 active 庫**的全域（切庫靠 `dbs.ts` 的 snapshot/restore）。
- 每個 pane 只讀「自己那份 snapshot」，所以切庫不需要整頁重載。
- UI 不可直接呼叫宿主查詢；一律經 `backend.ts`（`test/backend-layout.test.ts` 守住）。

---

## 3. 資料來源抽象

| 型別 | 何時 | 讀取方式 |
|---|---|---|
| `BlobIO` | file:// 選檔／拖檔 | `blob.slice(start,end).arrayBuffer()`；`decompressText` 不存在 → JS bzip2 |
| host source（`host.ts: hostSource`） | Wails3 的 catalog | `ByName('…ReadBase64' / '…Postings' / '…SearchQuery')`；`decompressText` 存在 → 宿主解壓 |
| `SyncIO` | 桌面測試／工具 | node `fs` 同步讀（只給測試與 CLI） |

`AdbReader.open(source)` 只讀檔頭與六個容器目錄（幾 ms）；內容一律**按區塊惰性讀**。
`VaPaMapper.init()` 建行表；`SearchSession.init()` 讀 token 表與 posting 目錄。兩者都只做一次，隨庫快取在 slot 裡。

---

## 4. 啟動動線

### 4.1 file://
```
DOMContentLoaded → boot()
  applyCols() / splitter / 欄切換
  initVariants() initSettings() initSearchAll() initDictPane() initAbout()
  renderDbPick()               ← catalog 空 → 只顯示「加入 adb」；🔍 隱藏
  bootDesktop()                ← 探測宿主：沒有 → 直接 return
  setStatus('請選擇或拖入 .adb…')
使用者：📁 → 加入 adb（=`#file`）或拖放
```
### 4.2 Wails3

> 建置／WebView2／視窗／更新的共通坑見 [wails3-pitfalls.md](wails3-pitfalls.md)；Windows／漢字／UI 見 [yap-software-practice.md](yap-software-practice.md)。

```
DOMContentLoaded → boot()（同上）
  bootDesktop()
    initDesktopBrand()         ← 左上角建置時間／更新提示（AppInfo / CheckUpdate）
    initDesktopWindowKeys()    ← F11 / Esc（宿主）
    desktopSources()           ← main.AdbHost.ListAdbs  → catalog（只讀檔頭）
    renderDbPick()             ← 全庫列出、沒有「加入 adb」、🔍 顯示
    openPicked([srcs[0]])      ← 自動開第一個庫
```

---

## 5. UI 動作 → 非同步資料抓取（核心表）

> 「讀哪裡」一欄：**B** = Blob/host 讀區塊、**T** = token/字串表、**G** = Go 查詢、**L** = localStorage。

| UI 動作 | 進入點 | 非同步抓什麼（依序） | 模式差異 | 完成後更新 |
|---|---|---|---|---|
| 選檔／拖檔 | `ui.ts openPicked` → `viewer.openFile` | ① `AdbReader.open`（檔頭＋容器）② `mapper.init()`（行表）③ `SearchSession.init()`（token 表） | file:// 走 B(Blob)；Wails 走 B(host) | `refreshAll()` |
| 打開 catalog 裡的庫 | `dbs.ts openCatalogEntry` | ① `saveLoaded()`（存舊 slot）② 開檔 ③ `restore*()` 各模組快照 | 同左 | 每個 pane 自己的 `showTab()` 重畫 |
| 關庫（chip ✕） | `dbs.ts closeSlot` | 無新讀取（只丟 slot） | — | `refreshAll` / `clearDbUi`（含 `hideDocLogo()`） |
| 輸入查詢（debounce） | `summary.ts` → `backend.searchAutoVia` | 單詞：`queryBackend` → **G** `SearchQuery` 或 **T** `session.clauseHits`；複雜（`+ - * . 空白`）：`searchMultiVia` → `rankClauses`；繁簡通檢時多帶 `groups` | Go 有宿主時走 G；否則 TS | 摘要卡片（`#searchList`）、`searchMeta` |
| 點摘要卡片 | `link.ts revealHit` | `mapper.docText(va…)`（B）＋ 命中頁的 tokens | 同左 | 本文分頁（`#docText`）、`paint.ts` 塗紅 |
| 點目錄節點 | `scopes.ts` 樹列 → `revealHit` | 樹在第一層：`loadTrees`（T：`<樹 s/t>`）→ `loadTree`（每層 `decodeBlockList`）→ `buildTree`；列是**分批掛載** | 同左 | 本文分頁 |
| 名詞分頁輸入 | `scopes.ts renderTerms` | ① `tagSegments(tag)`（T：`tags` 容器）② `reader.cachedStrings(tag)`（T：`caches/詞`）③ 掃名稱表 | 同左 | `#termsList`（塗紅 `mark.kw`）、`#termsCount`／`#termsMeta` |
| 全文．頻次 | `renderFreq` | `freqSegments()`（T）＋ `searchAutoVia`（G/T）逐段計數 | 同左 | `#freqList` |
| 原書分頁 | `renderFolio` | `attributeValues('頁.n')`（T）＋ `decodeBlockList('tags', 頁)` | 同左 | `#folioList` |
| 西文 | `renderLatin` | `cachedStrings` + token 表（T） | 同左 | `#latinList` |
| 點本文任何字 | `dict-pane.ts`（document 捕獲階段） | ① `sentencesAtPoint()` 取候選句 ② 對每個 catalog 庫 `dictIndexOf()`：開暫時 reader（B）→ `cachedStrings(tag)`（T）→ `decodeBlockList('tags', i)`（T）→ 排序 ③ 二分搜尋 ④ 點列時 `mapper.docText(va, vaEnd)`（B）＋ `renderPageBlocks` | 同左（暫時 reader 不佔 5 個 slot） | 右欄 `#dictList`／`#dictBody`（正文＋開頭/結尾親戚） |
| 搜尋所有 adb（🔍） | `allsearch.ts runSearchAll` | 對每個 catalog 庫開暫時 reader → `SearchSession.init()` → `search()`（單詞走 **G**／**T**）→ 取命中數 | 同左 | popup 清單（每查完一個就重畫、最後依命中數排序） |
| 點搜尋結果列 | `allsearch.ts` | `openCatalogEntry()`（若未載入）；查詢詞帶進**左欄 active 分頁**的輸入框 | 同左 | 該分頁重畫 |
| 切換左/右分頁 | `panes.ts showTab` | 由該 pane 自己決定（見上表各列） | — | 該 pane |
| 右欄「文字內容」 | `text-pane.ts` | 重用本文已抓的 `docText` 結果，不重讀 | — | `#textBody` |
| 設置（🔧） | `ui.ts initSettings` | **L** 讀寫；繁簡通檢會載入 `variant-data`；文字顯示影響渲染 | — | 重畫當前本文／列出重畫 |
| 字級／欄寬 | `doc-pane.ts stepFontSize` | 只寫 **L** | — | CSS 變數 |
| About／更新 | `about.ts`、`update-ui.ts` | **G** `AppInfo` / `CheckUpdate` / `ReleaseNotes`；安裝再 `InstallUpdate` | 只有 Wails | 對話框 |

### 快取與失效
- **每庫一份**：行表、token 表、posting 目錄、`caches/*` 字串表、樹、原書分頁、目錄樹——都掛在 slot 或模組層，切庫不重建。
- **全域**：詞典索引（`dict-lookup.ts` 的 `indexes`，依 catalog key）、變體表、塗紅樣式。
- **失效**：`clearDbUi()` 清空 pane；`renderTerms/renderFreq/…` 都用 `seq` 守衛，舊查詢回來就丟掉。
- **設定鍵**：一律 `accelon26.*`（改名前的 `adbview.*` 不遷移，直接忽略）。

---

## 6. 兩模式的程式碼路徑（同一份 HTML）

```
build/accelon26.html          ← bun run tools/build-viewer.ts（內嵌 script + icon）
wails/assets/index.html       ← bun run tools/build-desktop.ts（同一份，Go 內嵌）
wails/*.go                    ← 宿主：ListAdbs / ReadBase64 / Postings / DecompressText
                                 SearchQuery（wails/query.go）/ AppInfo / CheckUpdate …
```

- Go 只做「IO ＋ 查詢 ＋ 視窗」，**不碰 DOM**；TS 只做「UI ＋ 渲染 ＋ 搜尋語意」。
- 兩邊的查詢結果形狀由 `ClauseHits` 契約綁住，並用 **共用測試集** `ts/test/shared/search-cases.json`
  同時餵 `ts/test/backend-cases.test.ts` 與 `wails/query_cases_test.go` —— 所以 Go 引擎改動不會悄悄跟 TS 分歧。
- 桌面版只在「發布」時跑完整 GUI 測試；日常 UI 改動只跑 file-protocol 三套（13j／yinshun／fgdict）。

---

## 7. 檔案地圖（速查）

| 檔案 | 責任 |
|---|---|
| `adb.ts` | adb 格式：容器、區塊、bzip2、`BlobIO`／`SyncIO`／host source |
| `vapa.ts` | VA↔PA 映射、行表、`docText`、`nodeLabel`、`textOfVaSpan` |
| `search.ts` | token 表、`SearchSession`（`clauseHits` / `singleResult` / `rankClauses`）、樹 |
| `backend.ts` | **唯一**查詢入口：TS／Go 分派、繁簡通檢分組 |
| `host.ts` | **唯一**宿主入口：探測、`ListAdbs`、IO、查詢、AppInfo、視窗 |
| `dbs.ts` | slot（最多 5 個）、catalog、📁 下拉、snapshot/restore |
| `db-kind.ts` | 詞典型 adb 判定（有 `$詞` 就算；`isdict` 只是補充）＋ `detectIsdict()`（設定頁過濾用） |
| `doc-pane.ts` | 本文分頁、分頁載入、字級、原書頁碼 |
| `scopes.ts` | 目錄／名詞／頻次／原書分頁／西文 |
| `summary.ts` / `paint.ts` / `link.ts` | 摘要卡片、塗紅、跳頁 |
| `dict-lookup.ts` / `dict-pane.ts` | 詞典索引與右欄詞典分頁 |
| `allsearch.ts` | 搜尋所有 adb |
| `tour-format.ts` / `tour.ts` / `tour-data.ts` | 操作導覽：宏的編解碼、播放器、內嵌的宏（由 `tools/build-tours.ts` 產生） |
| `render_accelon3.ts` | 標籤→HTML（標題／色彩／硬換行） |
| `panes.ts` / `lazy-list.ts` | 分頁切換；分批掛載 DOM |
| `viewer.ts` | 全域 `reader/mapper/session`、`openFile`、狀態列、設定遷移 |

---

## 8. 驗證

| 指令 | 範圍 |
|---|---|
| `bun run tools/file-protocol-test.ts --adb <db>` | file:// 全 UI（13j 158／yinshun 170／fgdict 171） |
| `bun run tools/tour-test.ts --adb <db>` | 操作導覽全播（29 項；13j／yinshun／fgdict 各跑一次） |
| `bun run test/tour.test.ts` | 劇本→宏→劇本的編解碼與剖析器（31） |
| `bun run test/backend-cases.test.ts` | TS 引擎 vs 共用測試集（180） |
| `bun run test/go`（`cd wails && go test ./...`） | Go 引擎 vs 同一份測試集 |
| `bun run tools/desktop-test.ts --gui --quick` | Wails3 GUI（37） |
| `bun run tools/check-map-ids.ts` | `accelon26-map.html` 與 build 的 id 集合一致（140／141） |

---

## 9. 操作導覽（劇本 → 宏 → 播放器）

目的：**取代人類手把手教新手**。劇本是資料，不是程式；播放器只認得 opcode。

```
ts/tour/*.tour           人寫的（Markdown 方言：### 場景、> 指令、其餘是說明）
      │  bun run tools/build-tours.ts     ← 編譯器：剖析 + 靜態檢查 + 打包
      ▼
tour-data.ts             base64 二進位宏（人不可讀，進版控）＋ TOUR_INDEX
      │  bun run tools/build-viewer.ts    ← 既有建置，自動 bundle
      ▼
build/accelon26.html     tour.ts 播放器 ＋ 宏
```

| 檔案 | 責任 |
|---|---|
| `ts/src/accelon26/tour-format.ts` | opcode 表、二進位編解碼、CRC32、base64（瀏覽器與 Bun 共用） |
| `ts/tools/build-tours.ts` | 劇本剖析、`#id`／`data-tab`／`api:` 靜態檢查、產生 `tour-data.ts`（`--check` 驗同步） |
| `ts/src/accelon26/tour.ts` | 播放器：聚光燈、氣泡、條件式等待（`sel`／`count`／`api`／`text`）、場景閘門、`停`（點畫面任何地方前進）、鍵盤 |
| `ts/src/accelon26/tour-data.ts` | 產物（不要手改） |
| `ts/tools/tour-test.ts` | 真瀏覽器全播：每一份劇本從頭播到尾並斷言 |

入口在**「關於」→「▶ 操作導覽」**；「關於」預設啟動時顯示（`accelon26.about.startup`），
所以第一次打開就看得到入口。

三條設計約束（改動前先讀）：

1. **宏必須內嵌**：file:// 讀不到旁邊的檔案（同 §4.1），所以不能在執行時載入 `.tour`。
2. **等待一律條件式**：開庫、目錄樹、清單掛載都是非同步的；固定 `sleep` 在慢機器上就是隨機失敗。
3. **不擋操作**：聚光燈是 `pointer-events:none` 的 box-shadow，氣泡只有按鈕可點 —— 使用者中途亂點不會被導覽卡住。

`api:` 條件讀的是 `__accelon26.state()`（與測試、診斷同一份快照），不是第二套狀態。

---

## 10. 官網（`www/`）

一頁的靜態網站，**不屬於 app 的執行路徑**：它只是「下載頁＋說明書」，所以刻意
沒有任何第三方依賴（無 CDN、無字型檔、無框架），一張 HTML ＋ 四張 JPEG。

| 產物 | 誰產生 | 進版控 |
|---|---|---|
| `www/index.html` | 手寫 | 是 |
| `www/img/*.jpg`（4 張 gallery） | `bun run tools/site-shots.ts`（真瀏覽器截圖） | 是 |
| `www/accelon26.7z` | `bun run tools/release.ts`（建好 exe 之後打包） | **否**（`www/*.7z` 在 .gitignore） |

- 官網假設 **`www/` 整個目錄**被部署到 `https://shutonggui.cn/accelon26/`（與 About 的官網連結同一個位置）。
- 下載檔是 7z 而不是 exe：Windows 的瀏覽器與郵件對 `.exe` 愈來愈不友善，壓縮檔也小一半（17 MB → 7.1 MB）。
- 頁面上的安裝說明：解開 7z → `accelon26.exe` 放到 **accelon3.exe 同一個資料夾** → 雙擊。
  7-Zip 打不開時給 https://sparanoid.com/lab/7z/（Windows x64）。
- 「更新於 …」是頁面上唯一的 JS：對 `accelon26.7z` 做 HEAD 讀 `Last-Modified`／`Content-Length`；
  拿不到就保持預設文字（file:// 開啟時就是這樣）。


