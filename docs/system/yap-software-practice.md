# Yap 的軟件開發實踐（Windows / Bun / 單檔 HTML / Wails3）

> **這是作者的預設做法，不是通用最佳實踐。** 新專案先照這裡做；要偏離時，先確認原因，並把偏離寫進該專案的 README 或決策紀錄。
>
> **適用**：Windows 10/11 x64 的本機工具、文件閱讀器、資料轉換器；Bun + TypeScript 前端；需要桌面版時用 Wails3 包成**單一 portable exe**。
>
> **分工**：
> * [wails3-pitfalls.md](./wails3-pitfalls.md) — Wails3 專屬的 syso、WebView2、SmartScreen、視窗／DPI、更新 helper 等坑。
> * **本文件** — 開發節奏、Windows 非 Wails3 的坑、漢字處理、無損簡體、介面風格、依賴預算。
> * 各專案的 `README`／`ACCELON26-HANDOVER.md`／`DEPLOY.md` — 只記該專案的檔名、指令、資料與驗收數字；共通原則連回本文件。
>
> **一句話**：**瀏覽器先能跑，exe 最後才做；依賴越少越好；漢字先當資料，不當畫面文字；介面預設暗色，可切亮色／護眼。**

> **Canonical**：[agent-norms](https://github.com/accelon/agent-norms) 的 `yap-software-practice.md`；消費端（如 adb-converter）的副本由 `ts/tools/sync-agent-norms.ts` 同步，不要直接改副本。

**目錄**：0 決策表 · 1 技術選擇 · 2 開發節奏 · 3 單檔 HTML · 4 Windows 環境坑 · 5 漢字處理 · 6 無損簡體 · 7 介面風格 · 8 測試 · 9 文件 · 10 檢查表 · 11 反模式

---

## 0. 預設決策表

| 層 | 預設 | 例外／備註 |
|---|---|---|
| 作業系統 | Windows 10/11 x64 | macOS 只在做跨平台版時處理；見 wails3-pitfalls §6 |
| 語言 | TypeScript（前端）＋ Go（原生宿主） | 少量 Bun 腳本用 TS；不要為了一個小工具引入第二種語言 |
| 執行環境 | Bun ≥ 1.1 | 不用 npm／yarn／pnpm；不要混用 lockfile |
| 前端形態 | **單檔 HTML**，`file://` 可雙擊 | 需要 module／fetch／worker 時才用 local HTTP 迭代 |
| 桌面形態 | **Wails3 單一 exe**，portable | 不做 installer、Electron、Tauri、CDN 殼 |
| 依賴 | 執行期 0 個 npm 依賴；工具鏈只有 Bun／Go | 7-Zip、curl 只在發佈腳本用；不進 runtime |
| 資料 | 本機檔案；使用者挑檔或工作目錄 | 不上傳、不連網、不 telemetry |
| 介面 | 暗色系（預設）／亮色系／護眼 | 只換 CSS 變數，版面不動 |
| 自解說 | 非平凡 app 預設要有 guided tour | 第一次使用、新功能、demo 共用同一份 script；見 `self-explaining-tour` |
| 簡體顯示 | 保持原樣（預設）／無損簡體／強制簡體 | **只影響顯示**，索引與搜尋仍在原文 |
| 字型 | 系統字型堆疊，無 web font | Windows 以 Microsoft JhengHei／YaHei 為主 |
| 測試 | 瀏覽器先行；exe 只在發佈前跑 | 改了 UI 不必重建 exe |

---

## 1. 技術選擇與底線

### 1.1 Windows 優先

- 以 Windows 10/11 x64 為第一目標；視窗、字型、檔案權限、輸入法都以 Windows 為準。
- 不要假設使用者有管理員權限；預設**按使用者**安裝／ portable，資料寫 `%LocalAppData%` 或 `%AppData%`。
- 不要假設路徑是 ASCII、沒有空格、少於 260 字元，或檔名大小寫有別。
- macOS／Linux 是加值，不是第一輪的驗收阻擋；跨平台細節另看 wails3-pitfalls §6。

### 1.2 Bun + TypeScript

- Bun 負責：建置、測試腳本、打包、檔案操作。**不要為了跑一個腳本引入 Node 生態的整套工具。**
- 前端用 TypeScript，但產物是**傳統 script**（不是 ES module），因為 `file://` 不允許 module。
- 優先用 Bun 內建：`Bun.file`、`Bun.write`、`Bun.spawnSync`、`Bun.Glob`、`bun build`。
- 版本寫進 `package.json` 的 `engines.bun`，例如 `>=1.1`；CI 與本機用同一個 major。
- 不要用 `bun test` 當唯一測試框架；本專案的做法是明確的 `test/*.ts` 腳本，輸出可讀的 ok／fail。

### 1.3 單檔 HTML 優先

- 產品預設是**一個 HTML**：CSS、JS、icon 全部 inline；沒有旁邊的 `.js`、`.css`、字型檔、圖片檔。
- 雙擊即可開；資料由使用者用 `<input type=file>` 或拖放提供，透過 `Blob.slice().arrayBuffer()` 隨機讀取。
- 單檔的好處：不用安裝、不用伺服器、不會有「少帶一個檔」的問題；缺點是 `file://` 的安全限制，見 §3。
- 單檔不是「把所有東西塞進去就好」：仍然要模組化**原始碼**，只是建置時 bundler inline 成一支 script。

### 1.4 Wails3 單一 exe

- 需要桌面版時，用 Wails3 把同一份 HTML 嵌進 Go 宿主，產出**一顆 portable exe**。
- 不做 installer、不做 Electron、不做「先裝 runtime 再裝 app」；WebView2 是 Windows 上常見的獨立元件，但不是每台都有，見 wails3-pitfalls §1.6。
- UI 不應該知道宿主存在：只有一個 `host.ts` 之類的薄層知道。瀏覽器版與桌面版共用同一份 UI。
- **平常不要建 exe**；只有要給使用者測試或發佈時才建。UI 文字、顏色、排版改了，只建 HTML。
- exe 的 SmartScreen／簽章／更新流程是另一門學問，全部看 [wails3-pitfalls.md](./wails3-pitfalls.md) §4–§5；本文件不重複。

### 1.5 依賴預算

**執行期依賴：0 個 npm 套件。** 這是預設，不是口號。

- 不要 React／Vue／Svelte／Tailwind／Bootstrap／jQuery。
- 不要 icon font、不要 web font、不要 CDN、不要 analytics、不要 telemetry。
- 不要「為了一個小功能」裝一個 200 KB 的套件；先找瀏覽器原生 API 或自己寫 20 行。
- 演算法真的需要現成實作時，**vendor 進 repo**（放 `vendor/`，保留 license），不要讓 runtime 依賴 registry。
- Go 端優先用標準庫（`compress/bzip2`、`archive/zip`、`crypto/sha256`、`net/http`）；不要為了一個 helper 引入大框架。
- 建置工具可以多一點：Bun、Go、7-Zip、curl、signtool；但這些不進使用者的 runtime。
- 每次加依賴前問三件事：**能不能自己做？能不能 vendor？拿掉它會少多少功能？** 三個答案都不划算才加。

### 1.6 資料與隱私

- 預設**不連網**；更新檢查是唯一例外，而且要能關、能離線。
- 不收集使用者資料、不送 telemetry、不把檔案內容上傳。
- 檔案在使用者本機處理；需要暫存時用 `%TEMP%` 或 app 的 cache，離開時清掉。
- 日誌不印檔案內容、不印憑證、不印完整家目錄；需要時遮罩。

---

## 2. 開發節奏：HTML 先行，exe 後行

### 2.1 平常（預設走這條）

```powershell
cd ts
bun run tools/build-viewer.ts      # -> build/app.html（單檔，雙擊可開）
```

- 用 `file://` 雙擊 `build/app.html`，挑一個真實資料檔，確認主要流程。
- 瀏覽器測試優先：`file-protocol-test.ts`、`browser-test.ts` 之類的腳本，直接開 `file://` 或 local HTTP。
- 每次改完先看**建置產物**，不要只看原始碼；`file://` 可能快取舊 HTML，測試用 `?v=Date.now()` 破快取。
- UI 改動只寫進 `release_notes.draft.txt` 之類的草稿；**不要順手重建 exe**。

### 2.2 什麼時候用 local HTTP

只有以下情況才需要：

- ES module／`import` 被 `file://` 的 CORS 擋住。
- 需要 `fetch()` 讀同目錄檔案。
- 需要 Web Worker、Service Worker、`crypto.subtle`、Clipboard API、File System Access API 等**secure context** 功能。
- 需要測 CORS、快取、HTTP header 行為。

做法：

```powershell
# 用專案自己的最小靜態伺服器，綁 127.0.0.1，不要綁 0.0.0.0
bun run tools/serve.ts   # 或任何 20 行的 Bun 靜態伺服器
```

- 不要用需要額外下載的 `bunx serve`；那違反「極少依賴」。專案自己的 `tools/serve.ts` 用 Bun 內建 API 即可。

- 用 `http://127.0.0.1:<port>`，不要用 `localhost`（可能先解析到 IPv6）。
- Port 被佔用就換一個；測試腳本要能處理「上一個伺服器還沒死」。
- local HTTP 只是**開發輔助**；正式產品仍然要能在 `file://` 開，或由 Wails3 內嵌。不要讓產品依賴一個常駐伺服器。

### 2.3 發佈（只有說「發佈」時才做）

固定順序：

```text
1. 建前端（單檔 HTML）
2. 確認 assets 存在且非 0
3. go build（把 HTML 嵌進 exe）
4. 跑桌面 smoke test
5. 簽章／雜湊／versions.json（見 wails3-pitfalls §4–§5）
6. 上傳：先產物、後 manifest
7. 從 HTTPS 抓回來驗 sha256 與簽章
```

- **先 HTML、後 Go**；反過來會把舊 UI 包進 exe。
- 建置腳本要「先刪生成目錄再建」，讓前端失敗變成明確錯誤，而不是默默嵌入舊檔。
- 版本時間用 `-ldflags` 注入，不要用檔案 mtime。
- 發佈前跑一次桌面回歸；平常不要跑，因為開視窗、下載、更新很慢。
- 詳細的 Wails3 建置與更新坑，看 [wails3-pitfalls.md](./wails3-pitfalls.md) §1、§5。

### 2.4 測試層級

| 層級 | 何時跑 | 內容 |
|---|---|---|
| 單元／純函式 | 每次改 | 解析、轉換、版本比較、主題對照、無損簡體規則 |
| `file://` 瀏覽器 | 每次改 UI／流程 | 開檔、搜尋、渲染、鍵盤、主題 |
| local HTTP | 需要 secure context 時 | module、fetch、worker、CORS |
| Go 測試 | 每次改 Go | 檔案讀取、解壓、查詢、更新 manifest |
| 桌面 smoke | 發佈前 | 開窗、bridge、WebView2、更新、回滾 |
| 乾淨 VM | 發佈前 | 標準使用者、無開發工具、MOTW、字型、IME |

---

## 3. 單檔 HTML 的設計約束

### 3.1 `file://` 的限制

- **ES module 被 CORS 擋**：`<script type="module">` 在 `file://` 下會失敗（`Origin 'null'`）。必須用傳統 `<script>`，並把程式 inline。
- **`fetch()` 不能讀同目錄檔案**：不要設計「HTML 旁邊放 JSON／圖片」的架構；所有資產要 inline，資料由使用者挑檔。
- **Web Worker 可能失敗**：`file://` 的 worker 載入限制因瀏覽器而異；不要假設可用。
- **`crypto.subtle`／Clipboard／File System Access**：多數需要 secure context，且 `file://` 的行為因瀏覽器而異；要這些功能就開 local HTTP 測，或設計 fallback。
- **`localStorage` 在 `file://` 的行為不穩定**：不同瀏覽器／不同檔案路徑可能不共享；不要拿它存重要資料。桌面版用 Go 的設定檔。
- **快取**：瀏覽器可能快取舊 HTML；測試用 `?v=Date.now()`，並確認 `build/app.html` 內容真的是新的。

### 3.2 單檔的建置方式

- 原始碼可以是多個 TS 模組；`bun build --target browser` 或自寫 bundler 合成一支**傳統 script**。
- CSS 用 `<style>` inline；圖示用 **data URI** 或 inline SVG；不要外部檔案。
- 不要 inline 巨大的 base64 圖片；能畫成 SVG 就畫，能省略就省略。
- 產物命名與 exe 一致（例如 `app.html` 與 `app.exe`），讓使用者知道是同一份東西。
- 建置後檢查：檔案大小、是否含 `</script>` 提早結束、是否含外部 URL、是否含 `sourceMappingURL`（正式版不要）。

### 3.3 檔案讀取

- 使用者用 `<input type=file>`、拖放、或桌面宿主的檔案清單提供資料。
- 用 `File.slice(start, end).arrayBuffer()` 做隨機讀取；不要一次 `arrayBuffer()` 讀完整個大檔。
- 加一層**區塊快取**（例如 128 KiB）：小讀取先取所在區塊，之後 `subarray`。這是 `file://` 開大檔的關鍵，比 SSD 或解壓速度影響更大。
- 桌面版可以把同樣的 `ByteSource` 介面換成 Go 的檔案讀取；UI 不應該分叉。
- 檔案路徑／名稱只在 UI 顯示；不要把完整路徑放進 HTML 屬性或日誌。

### 3.4 單檔的效能

- 單檔 HTML 的啟動成本主要是**解析 HTML／JS** 與**第一次讀檔**；不要 inline 幾 MB 的資料。
- 大資料用「使用者挑檔＋隨機讀」，不要 `fetch` 整包。
- 虛擬滾動／分批掛 DOM；不要一次建幾萬個節點。
- 重運算放 Go（桌面版）或 Web Worker（瀏覽器版），不要卡主執行緒。
- 量測：`performance.now()`、`state()` 診斷；不要憑感覺。

---

## 4. Windows 環境坑（非 Wails3）

> Wails3 專屬的 WebView2、SmartScreen、syso、`0x8007139F`、更新 helper 不在這裡；見 [wails3-pitfalls.md](./wails3-pitfalls.md)。

### 4.0 症狀速查

| 症狀 | 最可能原因 | 先做什麼 |
|---|---|---|
| 中文變亂碼 | 主控台 code page／PowerShell 編碼／用錯 API | 先確認檔案本身是 UTF-8；用 UTF-8 檔傳內容，不要用中文 CLI 參數 |
| 檔案被加上 BOM／CRLF | 編輯器或 PowerShell 寫入 | 用 Bun／Node 或指定編碼；原始碼 UTF-8 無 BOM、LF |
| Excel 開 CSV 中文亂碼 | CSV 沒有 BOM | UTF-8 BOM + CRLF（只給 Excel／記事本看的檔） |
| 程式找不到中文路徑 | URL 沒 encode／legacy API 用 ANSI | `encodeURIComponent`／`decodeURIComponent`；用 Unicode API |
| 檔名大小寫衝突 | Windows 檔案系統不分大小寫 | 不要用只差大小寫的檔名；比較時 normalize |
| 路徑太長失敗 | > 260 字元 | `\\?\` 前綴、manifest `longPathAware`、縮短路徑 |
| 檔案無法刪除／改名 | 被 mmap／Explorer／防毒鎖住 | 先關閉 mapping／handle；retry；不要硬刪 |
| `fetch`／module 失敗 | `file://` 限制 | 改 local HTTP 測；正式版用 inline script |
| `crypto.subtle`／Clipboard 失敗 | 非 secure context | local HTTP；或 fallback |
| Emoji 顯示空框 | 字型沒有該碼位（例如 Unicode 16） | 改用通用字元或 inline SVG，不要依賴 emoji |
| 罕用字顯示方框 | 系統字型缺字 | 字型堆疊＋fallback；測試乾淨 Windows |
| `\b` 抓不到中文邊界 | JS `\b` 只認 ASCII | 用空白／標點邊界或 `\p{Script=Han}` |
| 字數／游標位置差 1 | UTF-16 code unit vs code point | 用 `for...of`／`Array.from`／`Intl.Segmenter` |
| 輸入法選字時搜尋亂跳 | 沒有處理 composition | `compositionstart/end`、`isComposing` |
| 主題載入閃一下 | 先畫預設再套主題 | `<head>` 內先行 boot script |
| 亮色／護眼下有黑方塊 | 顏色寫死，沒用 `--chip-*` | 所有顏色都走主題變數 |
| 「無損簡體」誤轉字 | 把多對一合併字也轉了 | 只轉一對一；合併字保留原字 |

### 4.1 編碼與命令列

**先分清楚三種東西：**

1. **檔案內容的編碼**（UTF-8／UTF-16LE／BOM）。
2. **主控台的 code page**（cp950／cp936／65001）。
3. **程式之間傳參數的編碼**（Windows 命令列是 UTF-16，但中間工具可能轉 ANSI）。

常見錯誤是「檔案是 UTF-8，但 PowerShell 用 ANSI 讀進來再寫回去」，結果中文全毀。

規則：

- **原始碼、設定、JSON**：UTF-8 **無 BOM**、LF。
- **給 Windows 記事本／Excel 看的文字**：UTF-8 **帶 BOM**、CRLF（例如 README.txt、CSV）。
- **UTF-16LE**：只在 Windows API 或既有格式要求時用；解碼時注意 BOM。
- 不要用 PowerShell 的 `Get-Content`／`Set-Content`／`-replace` 改 UTF-8 中文原始碼；它可能把中文變亂碼，甚至把程式碼改壞。用編輯器、Bun／Node 腳本，或明確指定 encoding。
- 如果真的要用 PowerShell 寫檔：PowerShell 7 用 `-Encoding utf8NoBOM`；Windows PowerShell 5.1 的 `utf8` 會帶 BOM，要知道自己在做什麼。
- 命令列輸出含中文時，先 `chcp 65001`，並設定 `[Console]::OutputEncoding`／`$OutputEncoding`；不要假設使用者是 cp950 或 cp936。

  ```powershell
  chcp 65001 > $null
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
  $OutputEncoding = [System.Text.UTF8Encoding]::new()
  ```

- **不要把中文當 CLI 參數傳給子行程**（PowerShell → Bun／Go／7-Zip 都可能變亂碼）。用 UTF-8 檔案、stdin、JSON，或環境變數（但環境變數也不保證）。
- `cmd.exe` 的 `%VAR%`、`^`、`&`、`!` 很容易吃掉中文或特殊字元；能用 PowerShell／Bun 的參數陣列就不要拼 shell 字串。
- 用 `Bun.spawnSync({ cmd: ['tool', '--arg', value] })`，不要 `cmd: 'tool --arg ' + value`；Windows 的引號規則很痛。
- PowerShell 的 `curl` 是 `Invoke-WebRequest` 的 alias；要真的 curl 就寫 `curl.exe`。`Invoke-WebRequest` 在下載二進位／大檔時常出問題。
- Git 顯示中文檔名會轉八進位；`git config core.quotepath false` 只影響顯示，不影響內容。

### 4.2 檔案、路徑、行尾

- **路徑**：用 `node:path`／Go `filepath`，不要手拼 `\` 或 `/`。
- **中文檔名／空格**：可以支援，但 URL 要 `encodeURIComponent`；`file:///D:/...` 的磁碟機、`#`、`%`、`?` 都要編碼。
- **長路徑**：超過 260 字元時，Windows API 需要 `\\?\` 前綴或 manifest `longPathAware`；Node／Bun／Go 的支援不一，測試要涵蓋。
- **保留名**：`CON`、`PRN`、`AUX`、`NUL`、`COM1`…`LPT9`；結尾的句點與空格也會出問題。
- **大小寫**：Windows 檔案系統不分大小寫；`Foo` 與 `foo` 不能同時存在。比較檔名時先 normalize。
- **行尾**：原始碼統一 LF（`.gitattributes`：`* text=auto eol=lf`）；Windows 面向的文字用 CRLF。不要讓同一個檔一半 LF 一半 CRLF。
- **BOM**：UTF-8 BOM 會讓某些 parser 出錯（JSON、shell script、Go source）；只有給記事本／Excel 的檔才加。
- **檔案鎖**：Explorer 預覽、防毒、mmap、Office 都可能鎖檔；寫入用 `.tmp` + rename，失敗要 retry／回報，不要硬刪。
- **權限**：`Program Files` 不可寫；用 `%LocalAppData%`。Controlled Folder Access 可能擋「文件」「下載」；寫檔要有退路。
- **OneDrive／雲端同步**：檔案可能是 placeholder，讀取會觸發下載；不要假設即時可用。
- **UNC／網路磁碟**：不要假設 mmap、rename、檔案鎖行為與本機相同。

### 4.3 工具鏈

- **Bun**：`bun run` 腳本用 `Bun.spawnSync` 的 `cmd` 陣列；需要隱藏視窗時用 `windowsHide`（若你的版本支援）。不要用 `shell: true` 拼中文路徑。
- **Go**：`go build` 的輸出／工作目錄要明確；Windows GUI 用 `-H windowsgui`，console 版另建；Wails3 的 syso／WebView2 見另一份。
- **7-Zip**：路徑通常是 `C:\Program Files\7-Zip\7z.exe`；用參數陣列，壓縮前先清乾淨 `pkg` 目錄，避免把舊檔包進去。
- **curl**：Windows 10 內建 `curl.exe`；不要用 `Invoke-WebRequest` 抓二進位。
- **Git Bash／MSYS**：`/c/...` 與 `C:\...` 會自動轉換，但傳給原生 Windows 程式時常出錯；必要時 `MSYS_NO_PATHCONV=1`。
- **Node 與 Bun**：不要在同一個專案混用兩套 lockfile；Bun 專案就用 `bun.lock`。
- **防毒**：剛 build 出來的 exe 可能被掃描／鎖住；簽章與 FP 送樣看 wails3-pitfalls §4.9。

### 4.4 瀏覽器與 `file://`

- Chrome／Edge 的 `file://` 限制比 local HTTP 多；開發時先用 `file://`，遇到 module／fetch／secure context 才開 local HTTP。
- `file://` 的 HTML 會被快取；改完先確認 `build/app.html` 的內容，測試加 `?v=Date.now()`。
- `file://` 的 `localStorage` 不一定共享；不要用它存使用者設定。桌面版用 Go 的 `os.UserConfigDir()`。
- `window.open`／下載／Clipboard 需要使用者手勢；不要在 async 深處才呼叫。
- WebView2 與 Chrome 的行為不完全一樣；桌面版要另外測（但 WebView2 專屬坑看 wails3-pitfalls）。

### 4.5 測試環境

- 乾淨的 Windows VM：沒有 Go／Node／Bun／Wails CLI，沒有你的開發者憑證快取。
- 標準使用者（非管理員）；中文使用者名稱；中文／空格路徑。
- 125%／150%／200% 縮放；多螢幕；RDP。
- 微軟拼音、微軟注音、倉頡／速成至少各測一次輸入。
- 乾淨的 Windows 10 與 Windows 11 各一次；Windows 11 的 Smart App Control 看 wails3-pitfalls §4。

---

## 5. 漢字處理

> 這一節的目標：**不要因為編碼、代理對、異體字、全形標點、字型或輸入法，讓中文介面出現「看起來像 bug 的現象」。**

### 5.1 先分清楚四個層次

| 層次 | 單位 | 常見 API | 陷阱 |
|---|---|---|---|
| 位元組 | byte | `Uint8Array`、`Buffer`、檔案 | UTF-8 一個漢字多數 3 bytes，非 BMP 4 bytes；UTF-16LE 2 或 4 bytes |
| UTF-16 碼元 | code unit（16-bit） | JS `string.length`、`s[i]`、`slice` | 一個漢字可能 1 或 2 個碼元；`slice` 可能切開代理對 |
| 碼點 | code point | `for...of`、`Array.from`、`codePointAt` | 罕用字／非 BMP 漢字是 2 個碼元 |
| 字素叢集 | grapheme cluster | `Intl.Segmenter` | 組合字、variation selector、emoji 家族 |

規則：

- 算「字數」時，先問是**碼元數**、**碼點數**還是**使用者看到的字數**；三個答案可能不同。
- 不要用 `s[i]` 逐字處理漢字；用 `for (const ch of s)` 或 `Array.from(s)`（按碼點）。
- 不要用 `slice` 切單字；可能切開代理對。要按碼點切，先轉陣列或使用 segmenter。
- 需要精確的使用者字數／游標位置時，用 `Intl.Segmenter('zh', { granularity: 'grapheme' })`（WebView2／現代瀏覽器支援）。
- 舊資料可能有**未配對代理**（unpaired surrogate）；不要丟給 UTF-8 encoder（會變 U+FFFD）。若需要 round-trip，保留原始碼元，顯示時再處理。
- JSON／HTML 輸出前，確認沒有 U+FFFD 被悄悄寫進去。

### 5.2 UTF-16、BOM 與 NUL

- Windows 的寬字元 API、WebView2、舊格式常用 UTF-16LE；JavaScript 字串也是 UTF-16。
- `TextDecoder('utf-16le')` 預設會**吃掉 BOM**；要保留 BOM 時用 `{ ignoreBOM: true }`，並自己決定要不要顯示。
- **不要在 UTF-16LE 位元組緩衝上用 `indexOf(0)` 找結束符**：ASCII 字元的高位位元組就是 `0x00`，逐 byte 找會誤中。要在位元組層找對齊的 `00 00`，或先解碼成字串再按碼元處理。
- 寫 UTF-16LE 檔時，注意 BOM（`FF FE`）與位元組序；不要假設對方會自動處理。
- 從網路／檔案收到 UTF-8 時，先驗證是否有效；無效位元組不要直接 `decodeURIComponent`。

### 5.3 正規化與異體字

- 比較字串前，先決定要不要 `normalize('NFC')`；NFC 對大多數中文是穩定的，但**不要用 normalize 取代原字顯示**。
- 保留原始字串；比較／搜尋時才用正規化版本。
- 中文異體字（說／説、眾／衆、為／爲、裡／裏）不是同一個碼位；要通檢就得建**異體組**，不要只做 `replace`。
- CJK Compatibility Ideographs（U+F900–U+FAFF）與 variation selector（IVS）不要隨便剝掉；它們可能是有意義的。
- 檔名正規化：Windows 不做 Unicode normalization；同一個字的不同組合可能產生兩個檔名。必要時 NFC 後再比較。
- 不要把「簡體／繁體」當成單純的 `toLowerCase`；這是一對多／多對一的映射，見 §6。

### 5.4 全形／半形、標點與空白

- 全形空白是 U+3000，不是 ASCII 空格；`trim()` 會處理它，但自寫的 whitespace regex 不一定。
- 全形標點（，。；：！？、「」『』（））在分詞／搜尋時要當邊界，不要當一般文字。
- 顯示時保留使用者的全形標點；搜尋時可以 normalize 成半形或統一邊界，但**不要改寫原文**。
- `\b` 只認 ASCII word boundary；`<集\b` 永遠不會匹配「集」後面接中文。用 `(?:^|[\s，。；：！？、「」『』（）])` 或 `\p{Script=Han}`（加 `u` flag）。
- `\w` 也不含中文；不要用 `\w+` 抓中文詞。
- 中英混排時，英文與中文之間要不要加空格是**排版選擇**；不要用 regex 自動插入，會污染原文。
- 行首行尾標點：CSS `line-break: strict`／`word-break: normal` 可以減少標點落單；不要對整段用 `word-break: break-all`。

### 5.5 分詞、搜尋與標記

- 中文沒有空格；分詞可以逐字、詞典、或 `Intl.Segmenter`。先確定產品需要哪一種。
- 全文索引應該建在**原文**上；查詢時再做異體／繁簡展開，不要把索引轉成簡體。
- 片語搜尋要處理標點與空白：查詢與原文都先做同樣的 normalize（但保留 offset 映射）。
- 高亮 offset 要用**碼點／字素**為單位，不要用 UTF-16 code unit；否則代理對會被切開。
- 需要把正規化後的位置映射回原文時，建一個 offset map；不要假設 `normalize()` 後長度不變。
- 大小寫：中文沒有大小寫；英文用 `toLocaleLowerCase`，但不要對中文做 locale 轉換。
- `RegExp` 用 `u` flag；`\p{Script=Han}` 可以匹配漢字，但不要把標點算進去。
- 查詢字串也要 trim 全形空白；不要把使用者輸入的 `，` 當成 token 的一部分。

### 5.6 排序與 collation

- 預設排序要明確：**UTF-16 code unit 順序**（穩定、可預測）或** locale collation**（像字典）。
- 中文 locale 排序用 `Intl.Collator('zh-Hant')`／`'zh-Hans'`；不要自己寫拼音表。
- 拼音／筆畫排序不是 `Intl.Collator` 的預設；要就得自己建表，並寫清楚規則。
- 平手時用原始索引做 tie-break，保證穩定。
- 全形／半形、大小寫、異體字要不要視為同一個排序鍵，先決定再實作。
- 檔案清單的排序可能與 Explorer 不同；不要假設使用者看到的順序。

### 5.7 檔案名稱與 URL

- 中文檔名可以支援，但 URL 一定要 encode；`file:///D:/資料/測試.txt` 要變成合法的 URL。
- `#`、`%`、`?`、`&`、空格在檔名裡都要 encode；不要用字串拼接組 URL。
- `decodeURIComponent` 可能拋錯（malformed `%`）；要 try/catch。
- Windows 路徑用 `\`，URL 用 `/`；不要混。
- 長路徑、保留名、大小寫、結尾句點／空格，見 §4.2。
- 顯示檔名時用 `path.basename`；不要把完整路徑放進 UI（隱私）。

### 5.8 輸入法（IME）

- 中文輸入法在選字期間會觸發多次 `input`；不要每次 `input` 都搜尋。
- 用 `compositionstart`／`compositionupdate`／`compositionend` 判斷；`event.isComposing` 或 `keyCode === 229` 也可以輔助。
- 選字期間按 Enter 是「確認選字」，不是「送出搜尋」；要區分。
- `compositionend` 後再 debounce（例如 100–200 ms）再查詢。
- 全形標點輸入（，。、）也要能正常查；不要把它們吃掉。
- 測微軟拼音、微軟注音、倉頡／速成；至少一個繁中、一個簡中輸入法。

### 5.9 字型與顯示

- Windows 的 `Segoe UI` 不含 CJK；字型堆疊要包含中文：
  ```css
  font-family: "Segoe UI", "Microsoft JhengHei", "Microsoft YaHei",
               "PingFang TC", "Noto Sans CJK TC", system-ui, sans-serif;
  ```
- 繁體 Windows 優先用 Microsoft JhengHei；簡體 Windows 用 Microsoft YaHei；不要只寫一個。
- 等寬字：`ui-monospace, Consolas, "Cascadia Mono", monospace`。
- 不要用 web font／CDN；系統字型就夠，也避免單檔 HTML 變大。
- 罕用字、IDS（⿱）、非 BMP 漢字可能缺字；要有 fallback，必要時顯示「缺字」而不是空白。
- **不要用 emoji 當功能圖示**：Unicode 16 的新字（例如 U+1FABE）在多數字型是空框；用 inline SVG 或通用字元。
- `lang="zh-Hant"`／`zh-Hans` 要設對；影響字型選擇、 hyphenation、朗讀。
- 字級：base 15px、line-height 1.6；內文 16px／1.5；可調 12–32px。中文不要用過細的字重。
- 對比：亮色／護眼主題下，灰字（`--dim`）要能讀；不要只在暗色主題檢查。
- 行長：中文長行要限制最大寬度（例如 38–45em），否則閱讀很累。

### 5.10 漢字測試語料

每次改動文字處理，至少跑：

- 常見繁簡：`發／髮`、`乾／幹`、`裡／裏`、`臺／台`、`後／后`、`中醫`。
- 罕用／非 BMP：`𠮷`（U+20BB7）、`𪚥`（U+2A6A5）、IDS `⿱艹`。
- 全形標點：`，。；：！？、「」『』（）`。
- 中英混排、數字、全形空白 U+3000。
- 未配對代理（如果格式可能有）、BOM、CRLF。
- 中文檔名＋空格＋`#`＋`%`。
- 輸入法選字、Enter、Esc。
- 三個主題、125%／200% 縮放。

---

## 6. 無損簡體

### 6.1 為什麼需要

給習慣讀簡體的人方便，但**不要因為簡化而誤解個別字**。最典型的例子是：

- `發／髮` 都簡化成 `发`；「頭髮」變「头发」還看得懂，但「發心」變「发心」就可能誤讀。
- `乾／幹` 都變 `干`；「乾燥」變「干燥」還好，「幹事」變「干事」可能混淆。
- `臺／台`、`後／后`、`裡／裏` 也是多對一。

所以需要三種模式，而不是「一鍵簡體」。

### 6.2 三態

| 模式 | 行為 | 適用 |
|---|---|---|
| `保持原樣`（0） | 不動 | 預設；尊重原文 |
| `無損簡體`（1） | 只轉**一對一**的繁→簡；多對一合併字保留原字 | 想讀簡體、但不想誤解 |
| `強制簡體`（2） | 全部轉（Unihan `kSimplifiedVariant`） | 明確要簡體排版、可接受合併 |

UI 用三段式（`保持原樣／無損簡體／強制簡體`），預設 `保持原樣`；設定存在 `localStorage`，換文件不變。

### 6.3 無損的判定規則

1. 簡體字本身也是常用繁體字時，該繁→簡在無損模式**不轉**。例：`后`、`台`、`里`、`干`、`只`、`几`、`云`、`面`、`松`、`咸`、`借`、`谷`、`舍`、`系`、`复`、`于`、`郁`、`冲`、`准`、`胡`、`采`、`累`、`布`、`卷`、`秋`、`千`、`卜`、`出`、`板`、`表`、`别`、`蒙`、`划`、`夸`、`困`、`厘`、`了`、`霉`、`仆`、`曲`、`术`、`涂`、`向`、`须`、`折`、`征`、`志`、`制`、`朱`、`筑`、`姜`、`御`、`芸`、`沾`、`毡`。
   - 這張人工表叫 `LOSSY_TARGETS`；沒有它，「王后／王後」會分不出來。
2. 繁體字只能對到**這一個**簡體字。
3. 簡體字的其他繁體寫法必須都是**同一個字的異體**（用 Unihan `kZVariant`／`kSemanticVariant`／`kSpecializedSemanticVariant` 做 union-find）。
   - 可以轉：說／説→说、眾／衆→众。
   - 不能轉：發／髮→发、乾／幹→干。
4. 這個繁體字自己也在那一組裡；否則就是把兩個不同的字併在一起。
4. 這個繁體字自己也在那一組裡；否則就是把兩個不同的字併在一起。

資料從 Unihan 的 `kSimplifiedVariant`／`kTraditionalVariant` 雙向補齊，只收 BMP（產物是「兩字一組」的字串，非 BMP 會對不齊）。本專案的產物約 **2641 組無損、2810 組強制**；實際數字以 `gen-lossless.ts --check` 為準。

### 6.4 只影響顯示

- 索引、搜尋、塗紅比對、排序、複製到剪貼簿的「原文」都應該用原字。
- 顯示時才呼叫 `toSimplified(text, mode)`；渲染器拿到的每個文字節點都先轉。
- 塗紅／高亮要畫的字（片語、切片）也要先用同一個轉換再找字，否則簡體顯示下會對不上。
- 匯出／下載時預設給原文；如果使用者選了簡體顯示，再決定要不要匯出轉換後的文字（要寫清楚）。
- 不要把轉換後的文字寫回索引或快取；那是顯示層。

### 6.5 資料產生

```powershell
cd ts
bun run tools/gen-lossless.ts          # vendor/Unihan_Variants.txt -> simplified-data.ts
bun run tools/gen-lossless.ts --check  # CI：確認產物是最新的
```

- `vendor/Unihan_Variants.txt` 不進 git；產物 `simplified-data.ts` 進 git，建置不需要 vendor。
- 產生器要有 `--check`，CI 比對產物與 vendor 是否一致；不要手改產物。
- 只收 BMP；非 BMP 的漢字要另外處理，否則「兩字一組」會對不齊。
- 人工表 `LOSSY_TARGETS` 要寫註解與測試；新增字要有人審。

### 6.6 UI 與測試

- 設置頁要有三態與**範例句**，例如：「頭髮乾燥，臺灣的醫生後來又發心。」
  - 無損：保留 `髮`、`乾`、`臺`、`後`。
  - 強制：全部轉。
  - 不一樣的字用虛線底線標出；目前模式那一列突顯。
- 測試：
  - `見→见`、`潛→潜` 會轉。
  - `髮`、`乾`、`臺`、`後` 在無損模式**不轉**。
  - 強制模式會轉。
  - 搜尋用原文仍然找得到（顯示轉換不影響索引）。
  - 塗紅位置在簡體顯示下仍然正確。
  - `toSimplified` 不改變標點、數字、拉丁字母。
- 不要把「無損簡體」做成「把整份文件存成簡體」；它是**顯示偏好**，不是資料轉換。

### 6.7 常見錯誤

- 用 OpenCC 之類的轉換器直接轉，沒有處理多對一 → 語意丟失。
- 把「異體字」和「簡繁合併」混為一談 → 說／説可以轉，發／髮不能。
- 先轉簡體再建索引 → 原文查不到、offset 對不上。
- 轉換後才做 highlight → 位置錯、切開代理對。
- 只處理 BMP → 非 BMP 漢字被忽略或對齊錯。
- 把轉換結果寫回快取／存檔 → 下一次開啟已經不是原文。
- UI 只寫「簡體」沒有說明「無損」→ 使用者以為所有字都會轉。

---

## 7. 介面風格

### 7.1 三套主題

| 主題 | 定位 | 主色 |
|---|---|---|
| **暗色系（預設）** | 長時間閱讀、低光環境 | 底 `#1e1e1e`、面板 `#252526`、線 `#3c3c3c` |
| **亮色系** | 白天、簡報、對比 | 底 `#ffffff`、面板 `#f5f6f8`、線 `#d6d9de` |
| **護眼** | 偏綠紙色、降低亮底刺激 | 底 `#eaf1e2`、面板 `#e2ecd8`、線 `#c3d3b6` |

- 預設暗色，但**不要純黑**；用 `#1e1e1e` 之類的深灰。
- 護眼是「偏綠紙色」，不是醫療保證；不要宣稱護眼效果。
- 三套主題都要測；不要只調暗色。

### 7.2 只換 CSS 變數

- `:root` 放暗色；`html[data-theme="light"]`／`html[data-theme="eye"]` 覆寫變數。
- 所有顏色都要是變數：`--bg`、`--panel`、`--panel2`、`--line`、`--fg`、`--dim`、`--accent`、`--warn`、`--err`、`--gold`、`--hl-bg`、`--row-hover`、`--link`、`--mark-fg`、`--popup-bg`、`--popup-fg`、`--code-bg`、`--hit-1..4`、`--ok`、`--chip-bg`、`--chip-fg`、`--tag-0..7`、`--tag-text-0..7`。
- **不要在任何規則裡寫死顏色**；包含 hover、selected、disabled、陰影、邊框、scrollbar。
- `color-scheme: dark`／`light` 要跟著主題設，原生控制項與 scrollbar 才會對。
- 換主題只改 attribute，**不要重繪整份文件**；版面不動。
- 主題切換要即時、不要閃；`localStorage` 記住選擇。

### 7.3 避免主題閃爍

在 `<head>` 放一段**先行** script，在 CSS 之後、body 之前套上 `data-theme`：

```html
<script>
try {
  var t = localStorage.getItem('app.theme');
  if (t === 'light' || t === 'eye') document.documentElement.setAttribute('data-theme', t);
} catch (e) {}
</script>
```

- 預設暗色：沒有 attribute 就是暗色。
- 不要把主題套用放在 `DOMContentLoaded` 之後；會先閃一下暗底。
- `localStorage` 失敗（私密模式）要 fallback 到預設，不要拋錯。

### 7.4 色票與對比

- 暗色：底 `#1e1e1e`、面板 `#252526`、次要面板 `#2d2d30`、線 `#3c3c3c`、字 `#d8d8d8`、dim `#909090`、accent `#5aa9ff`。
- 亮色：底 `#ffffff`、面板 `#f5f6f8`、線 `#d6d9de`、字 `#1f2328`、dim `#6a7280`、accent `#1f6feb`。
- 護眼：底 `#eaf1e2`、面板 `#e2ecd8`、線 `#c3d3b6`、字 `#2c3a2a`、dim `#5d6c55`、accent `#3f7d4e`。
- 文字對比至少 4.5:1；大字／粗體可以 3:1，但不要濫用。
- 不要用純黑 `#000` 大面積；暗色用深灰，亮色用白或近白。
- 選取、hover、mark、hit 都要在三套主題下可讀；不要只用「亮一點」處理。
- 標籤色彩：`--tag-N` 是圓點／底色（深），`--tag-text-N` 是標題字色（比底色亮、彩度高）。**標題用字色，不要用底色**；深色底上底色會看不清楚。

### 7.5 字型與字級

- 字型堆疊見 §5.9；不要 web font。
- base 15px、line-height 1.6；內文 16px／1.5；程式碼 12.5–13px／1.7。
- 字級可調 12–32px；用按鈕 `A-`／`A+` 或 `TT`，不要 `<select>`。
- 中文不要用 `font-weight: 300` 之類的細字；Windows 的 CJK 合成字重可能很醜。
- 長文最大寬度 38–45em；不要讓一行橫跨整個 4K 螢幕。
- 英文與數字用同一套字型堆疊；等寬區用 monospace。

### 7.6 圖示

- **用 inline SVG，不要用 emoji／icon font／CDN**。
- Emoji 的問題：字型缺字（例如 Unicode 16 的 U+1FABE 在 Windows 顯示空框）、跨平台長相不同、無法跟著主題變色。
- SVG 用 `currentColor`，自動吃主題字色；`aria-hidden="true"`，按鈕要有 `aria-label`。
- 圖示按鈕至少 24×24 點擊區；不要只畫 12px 的圖。
- 不要用「🌲」這種有多種變體的字當功能圖示；寧可畫一棵樹的 SVG。

### 7.7 版面與互動

- 桌面工具用 CSS Grid 三欄（左目錄／中內容／右參考）或兩欄；不要做成行銷網站。
- 頁面本身不滾動；只有需要的 pane 滾動（`html, body { height: 100%; overflow: hidden; }`）。
- 可拖曳分隔線；記住寬度；太小自動收合。
- 表格／清單用虛擬滾動或分批掛 DOM；不要一次建幾萬列。
- 動畫少、短（150–200 ms）；尊重 `prefers-reduced-motion`。
- 所有操作要能用鍵盤：Tab、Enter、Esc、F11；焦點要可見。
- 設定頁用一個置中彈窗；不要把設定散在 header。
- 狀態訊息低調；不要用 alert／confirm 做一般提示（更新確認除外）。

### 7.8 無損簡體的 UI

- 三段式控制：`保持原樣`／`無損簡體`／`強制簡體`；預設原樣。
- 旁邊放一句範例與「哪些字被保留」的說明；不要只寫「簡體」。
- 切換只重繪文字，不重載文件；設定立即生效。
- 顯示簡體時，搜尋仍用原文；使用者輸入繁體也找得到。
- 複製／匯出要說明是原文還是顯示文字；預設原文。

### 7.9 無障礙

- 主題 segmented control 用 `aria-pressed`；圖示按鈕有 `aria-label`。
- 顏色不是唯一訊息：命中、錯誤、選取都要有文字或圖示輔助。
- 對比、焦點、鍵盤、縮放 200% 都要測。
- 不要只靠閃爍表示更新；閃爍要能停止，並有靜態徽章／文字。

### 7.10 自解說（guided tour）

**預設：非平凡 app 都要有 guided tour。** 不愛看說明書的人靠「看一次、跟著做」學會；同一份 script 也是 demo。

- 入口要明顯：About／Help／第一次啟動／空狀態；不要藏在設置深處。
- 第一次使用 tour 控制在 5–10 個場景；一個場景一個概念，每個場景都能單獨重播。
- 介紹介面用 `停`（等使用者看完），**不要用固定 `等` 跑過去**。
- 等資料用 `等頁面 count:…`／`api:…`，不要用固定 sleep。
- 檔案選擇器、系統對話框不能自動化，用 `你來`。
- 每個場景結尾停住，由使用者按「下一個場景」；不要自動連播。
- 設定被 tour 改過的要還原，或明確告訴使用者怎麼改回來。
- tour data 編譯後內嵌；`--check` 放進 CI，UI 改版時同一個 commit 更新選擇器。
- 發佈前跑一次完整播放（`tourState().failed` 必須空）；不要只測第一個場景。

模組與 skill：

- <https://github.com/accelon/agent-norms/tree/main/self-explaining-tour>
- <https://github.com/accelon/agent-norms/blob/main/skills/self-explaining-tour/SKILL.md>

---

## 8. 測試與驗收

### 8.1 瀏覽器先行

- 每次改 UI／流程：`bun run tools/build-viewer.ts`，雙擊 `file://` 測。
- 需要 module／fetch／secure context：local HTTP 測，但正式版仍要能 `file://` 或 Wails 內嵌。
- 測試用真實中文語料；不要只用 ASCII 假資料。
- 測試前清 cache 或加 `?v=Date.now()`；確認你測的是新建置的 HTML。

### 8.2 漢字專項

- 見 §5.10 的語料。
- 測「字數」與「游標位置」：`𠮷` 這類非 BMP 字是否算 1 個使用者字元。
- 測代理對不會被切開：highlight、複製、slice。
- 測 IME：拼音／注音選字時不查詢，選完才查。
- 測全形標點與 `\b`／`\w` 的邊界。
- 測無損簡體：合併字保留、一對一轉換、搜尋仍用原文。
- 測字型：乾淨 Windows 上罕用字不變方框；emoji 不當圖示。

### 8.3 主題專項

- 三套主題各截一張圖；檢查 chip、tag、hover、selected、disabled、scrollbar、彈窗。
- 檢查載入不閃：重新載入頁面，看第一幀。
- 檢查 `localStorage` 記住選擇；私密模式 fallback。
- 檢查對比：dim 字、placeholder、disabled 按鈕。
- 檢查護眼主題不是「只有底色變綠」；面板、線、字色都要協調。

### 8.4 Windows 真實環境

- 乾淨 VM、標準使用者、中文使用者名稱、中文路徑。
- 125%／150%／200%；多螢幕；RDP。
- 微軟拼音／注音／倉頡。
- 無 WebView2／有 WebView2（桌面版）。
- 防毒開啟；Controlled Folder Access 開啟。
- 從 HTTPS 下載的產物（MOTW）測 SmartScreen；細節看 wails3-pitfalls §4。

### 8.5 桌面版

- 只在發佈前跑完整桌面 smoke；平常不要為了改 UI 重建 exe。
- 測 bridge、檔案清單、開檔、搜尋、主題、視窗狀態。
- 更新流程用本機 HTTP 伺服器測，不要拿正式 exe 當白老鼠；細節看 wails3-pitfalls §5.8。

---

## 9. 文件與版本

- **單一真相**：Wails3 坑看 `wails3-pitfalls.md`；個人實踐看本文件；專案細節看該專案 README／HANDOVER／DEPLOY。不要在三個地方各寫一份。
- **決策紀錄**：偏離本文件時，寫下「為什麼」與「什麼情況下要改回來」。
- **Release notes 給使用者看**：一行一條「感覺到什麼」，不是 commit log。
- **不要留暫存腳本**：`build/*.mjs`、`tmp-*.ts` 用完就收進 `tools/` 或刪掉。
- **版本號／buildTime**：用 linker 注入，不要用檔案 mtime；詳見 wails3-pitfalls §5.4。

---

## 10. 發佈前檢查表

### 建置

- [ ] 前端先建，assets 存在且非 0；exe 裡的 UI 是最新的。
- [ ] 沒有把 debug 版、DevTools、測試資料帶進正式產物。
- [ ] `-trimpath`；沒有把本機路徑／秘密嵌進 binary。
- [ ] 版本時間來自 linker；`-version` 可讀。

### 功能

- [ ] `file://` 雙擊能開；資料挑檔／拖放正常。
- [ ] 大檔隨機讀取不卡；沒有一次讀完整檔。
- [ ] 搜尋、高亮、字數、游標位置在中文語料上正確。
- [ ] 無損簡體：合併字保留、一對一轉換、搜尋仍用原文。
- [ ] 三套主題都正常；載入不閃；沒有寫死顏色。
- [ ] 圖示是 SVG；沒有依賴缺字 emoji。
- [ ] IME 選字期間不誤觸搜尋。
- [ ] 中文檔名／路徑／空格／長路徑可開。

### Windows

- [ ] 乾淨 VM、標準使用者測過。
- [ ] 中文使用者名稱、中文路徑測過。
- [ ] 125%／200%、多螢幕測過。
- [ ] 防毒／Controlled Folder Access 下寫檔有退路。
- [ ] 從 HTTPS 下載的產物測過 SmartScreen（見 wails3-pitfalls §4）。
- [ ] installer／exe 簽章與 timestamp（若有簽章）。

### 文件

- [ ] README 寫清楚怎麼跑、怎麼建、怎麼測。
- [ ] 使用者看的說明不含開發術語。
- [ ] 更新／回滾步驟寫清楚。
- [ ] 沒有教使用者關閉安全功能。

---

## 11. 反模式（不要做）

- ❌ 為了改一個 UI 字串就重建 exe。
- ❌ 引入 React／Vue／Tailwind／CDN／web font／icon font。
- ❌ 用 `file://` 載 ES module 或 `fetch` 同目錄檔案，然後說「瀏覽器壞了」。
- ❌ 用 PowerShell `Get-Content`／`Set-Content`／`-replace` 改 UTF-8 中文原始碼。
- ❌ 把中文當 CLI 參數傳給子行程。
- ❌ 用 `s[i]` 逐字處理漢字，或 `slice` 切單字。
- ❌ 用 `\b`／`\w` 抓中文邊界。
- ❌ 把「簡體」直接套 OpenCC，沒有處理多對一。
- ❌ 把無損簡體轉換寫回索引／存檔。
- ❌ 用 emoji 當功能圖示。
- ❌ 只測暗色主題，亮色／護眼放生。
- ❌ 把顏色寫死在 CSS 規則裡。
- ❌ 把 `localStorage` 當 file:// 的可靠設定儲存。
- ❌ 假設使用者路徑是 ASCII、少於 260 字元、大小寫有別。
- ❌ 在使用者沒同意的情況下發佈、簽章、上傳或改安全設定。

---

## 附錄 A：常用指令

```powershell
# 建單檔 HTML
cd ts
bun run tools/build-viewer.ts

# 產生無損簡體表（需要 vendor/Unihan_Variants.txt）
bun run tools/gen-lossless.ts
bun run tools/gen-lossless.ts --check

# 本機 HTTP（需要 module／secure context 時）
bun run tools/serve.ts   # 或任何 20 行的 Bun 靜態伺服器

# 建桌面 exe（只在發佈時）
cd wails
go build -ldflags "-H windowsgui" -o ..\dist\app.exe .

# 看檔案編碼／BOM（PowerShell 7）
Format-Hex .\file.txt | Select-Object -First 2
```

## 附錄 B：相關文件

- [wails3-pitfalls.md](./wails3-pitfalls.md) — Wails3 專屬坑（syso、WebView2、SmartScreen、視窗、更新）。
- 各專案的 `README`／`MACOS.md`／`DEPLOY.md`／`ACCELON26-HANDOVER.md`／`architecture.md` — 專案專屬的建置、部署、實作與驗收 runbook；不在本 repo。

---

> **最後原則**：先讓它在瀏覽器裡正確、快、可測；再把同一份東西包成 exe。**漢字不是「文字」而是資料**：位元組、碼元、碼點、字素、異體、簡繁，每一層都可能出錯。介面先讓眼睛舒服，再談功能。
