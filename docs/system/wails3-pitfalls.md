# Wails3 避坑指南（給 AI agent）

> **對象**：要建立、修改、建置、發佈 Wails v3 桌面應用的 AI agent（人類也可讀）。
> **範圍**：只談 Wails3 與 Windows／macOS 桌面宿主；例子用通用的 `Backend`／`files`，**不含任何特定產品的資料格式、服務名或網域**。本指南由一個實際 Wails3 專案的踩坑紀錄提煉，已去除產品專屬部分。
> **基準**：Wails v3（2026-10，beta 系列；v3 API 仍在變動）。案例涵蓋 Windows 10/11 的 WebView2 與 macOS 的 WKWebView。
> **姊妹文件**：Windows／漢字／UI 的共通實踐見 [yap-software-practice.md](./yap-software-practice.md)；本文件只談 Wails3 專屬。
> **讀法**：先用 §0 依症狀分類；動工前讀 §1；寫前端／Go 橋讀 §2；視窗問題讀 §3；**Windows 發佈與 SmartScreen 讀 §4**；自動更新讀 §5；完成前跑 §9 檢查表。
> **原則**：每個坑都要「重現 → 修正 → 驗證」。**編譯成功不等於可用；本機可用不等於使用者可用。** 不要在使用者沒同意的情況下發佈、簽章、上傳或改動安全設定。

> **Canonical**：[agent-norms](https://github.com/accelon/agent-norms) 的 `wails3-pitfalls.md`；消費端（如 adb-converter）的副本由 `ts/tools/sync-agent-norms.ts` 同步，不要直接改副本。

**目錄**：0 症狀速查 · 1 建置鏈 · 2 前端／Go 橋 · 3 視窗／螢幕／DPI · 4 Windows 發佈與 SmartScreen · 5 自動更新 · 6 macOS · 7 Go 層 · 8 測試 · 9 發佈檢查表 · 10 AI agent 硬規則 · 附錄

---

## 0. 症狀速查

| 症狀 | 最可能原因 | 先做什麼 |
|---|---|---|
| 雙擊 exe 沒視窗，程式很快消失 | GUI 子系統下啟動期 fatal；WebView2 缺失；assets 損壞 | 建 console 版跑一次；寫啟動 log；加 `-version`／`-selftest` |
| 視窗開了但白屏 | assets 沒內嵌、路徑錯、`/wails/runtime.js` 404、JS 例外 | 開 DevTools；`fetch('/wails/runtime.js')`；看 console 第一個錯誤 |
| 頁面正常，但所有宿主功能是空的 | 用錯 asset handler；`Call.ByName` 名稱錯；宿主探測競態 | 確認 `BundledAssetFileServer`；看 network；把 host error 顯示出來 |
| 第二個實例開不起來，錯誤 `0x8007139F` | 兩個行程共用同一個 WebView2 user data folder | 等舊行程完全結束；做單一實例；測試時每個行程分開資料夾 |
| CDP／DevTools 連不上 | 環境變數被 Wails 覆寫；port 被佔；缺 `--remote-allow-origins=*` | 從 `WindowsOptions` 傳參數；每個行程獨立 dir＋port |
| 視窗開在錯的螢幕，或每次位置都漂一點 | 混用原生座標與 Wails 邏輯座標；DPI 虛擬化；沒夾進工作區 | 只用 `app.Screen`；`Hidden`＋`ApplicationStarted`；`clamp` |
| 全螢幕沒有標題列、不能縮放或關閉 | Windows 全螢幕是 `WS_POPUP` | 提供 Esc／F11；顯示提示；離開後恢復 `WS_OVERLAPPEDWINDOW` |
| 關掉再開，視窗設定沒保存 | 被硬殺；沒收到 `WindowClosing`／`OnShutdown` | 正常關閉；兩個事件都寫；原子寫入 |
| 下載後第一次執行被 SmartScreen 擋 | 未簽章＋Mark-of-the-Web＋沒有信譽 | 讀 §4；簽章；**不要叫使用者關閉 SmartScreen** |
| 更新完又提示有新版本 | 用 `Last-Modified`（上傳時間）當版本真相 | 用 `buildTime` manifest；至少 60 秒容差 |
| 更新後新版本起不來 | 新舊行程搶 WebView2；換檔失敗；沒回滾 | 重啟 helper 等舊 PID；保留上一版；失敗回滾 |
| `go build` 突然要 gcc／`runtime/cgo` | 0 byte 或錯架構的 `.syso` | 重跑 `wails3 generate syso -arch …`；太小就刪掉 |
| exe 裡是舊 UI | 先 `go build` 才建前端 | 固定「先前端、後 Go」；輸出先刪再建 |
| 中文變亂碼 | Windows 命令列參數編碼 | 見 [yap-software-practice.md](./yap-software-practice.md) §4.1 |
| 寫「下載」或「文件」資料夾被拒 | Controlled Folder Access／權限 | 準備退路目錄；回報實際寫入位置 |

### 0.1 如果只記十件事

1. **先前端、後 `go build`**；`go:embed` 不會幫你建前端。
2. **`generate syso` 一定要 `-arch`**；0 byte 的 `.syso` 會讓連結器找 gcc。
3. **用 `BundledAssetFileServer`**；否則 `/wails/runtime.js` 不存在，橋全斷。
4. **不要讓兩個行程共用 WebView2 user data folder**；會得到 `0x8007139F`。
5. **視窗定位只用 `app.Screen`**；不要混原生 Win32 實體座標。
6. **Windows 全螢幕是 `WS_POPUP`**；一定要給 Esc／F11 出口。
7. **SmartScreen 不是程式 bug**；未簽章＋MOTW＋沒信譽，只能靠簽章／Store／信譽。
8. **有簽章時，不要先執行下載檔再驗簽**；驗簽必須在 `-version` 之前。
9. **更新用 buildTime、helper 等舊 PID、保留上一版可回滾**；不要用 mtime。
10. **在乾淨 VM 用 HTTPS 下載、帶 MOTW 測**；開發機的綠燈不算。

> 這十條是速記；完整規則與理由見 §10 與各節。

---

## 1. 建置鏈

### 1.1 版本要對齊，v3 API 會變

- `go.mod` 的 `github.com/wailsapp/wails/v3` 版本、`wails3` CLI 版本、`build/` 下由 CLI 產生的 Taskfile，三者要一起看。CLI 與 library 差太多時，生成的 Taskfile／綁定可能編不過，或行為與文件不同。
- 先跑 `wails3 version`、`wails3 doctor`（若你的版本有）、`go version`；確認 Go 版本在 Wails 支援範圍。
- **不要在同一個任務裡順手升級 Wails**，除非使用者同意。升級會改變 API、Taskfile、事件名與預設行為。
- 文件（v3.wails.io）可能對應最新版，不是你 pin 的版本。API 不確定時，**讀 module cache 裡那個版本的原始碼**，不要憑最新文件猜。
- `wails3` 的 `build`／`package` 是 Taskfile 的包裝；若專案有自己的 Taskfile，先確認 `wails3 task build` 實際跑了哪些指令。

### 1.2 `.syso`：最容易浪費半天的建置坑

Windows 的圖示與 manifest 由 `wails3 generate icons` 與 `wails3 generate syso` 處理；`go build` 會自動連結套件目錄裡的 `*.syso`。

```powershell
wails3 generate icons -input appicon.png -windowsfilename build/windows/icon.ico
wails3 generate syso -arch amd64 -icon build/windows/icon.ico `
  -manifest windows.manifest -out app.syso
```

- **一定要給 `-arch`，且要跟 `GOARCH` 一致**。不給 `-arch` 時，某些版本會產生 **0 byte** 的 `.syso`，而且 **exit code 是 0**。
- 0 byte 的 `.syso` 會讓 `go build` 在連結階段改走 external linker，典型錯誤鏈是：

  ```text
  loadinternal: cannot find runtime/cgo
  gcc: not found
  ```

  這時不是你的 Go 程式需要 cgo，而是壞掉的資源物件把連結器帶偏了。**先刪掉 `.syso` 重生成**，不要先安裝 gcc。即使 `CGO_ENABLED=0`，在某些情況下壞掉的資源物件仍可能讓連結器走 external linker；不要用「我沒用 cgo」排除這個可能。
- 生成後檢查大小：正常通常幾十 KiB；`< 1 KiB` 直接視為失敗並刪除，免得下一次建置再踩。
- `.syso` 是建置產物，**不要進版控**；clean checkout 要能重新生成。錯架構的 `.syso` 會連結失敗或產出不能跑的 exe；同時建多個架構時，每個架構都要用對應的 `.syso`，不要把 amd64 的留給 arm64 build。
- 自訂 manifest 建議包含：per-monitor v2 DPI awareness、Common Controls、`longPathAware`、Windows 10/11 `supportedOS`。少了 DPI 宣告，WebView2 可能模糊，視窗座標也容易與 Wails 的邏輯座標對不上。
- 建置順序：**icon → syso → go build**。先 `go build` 再生成 syso，這顆 exe 不會有圖示。
- 在非 Windows 主機生成 `.syso` 可能踩工具限制；CI 盡量用 Windows runner，或先確認你的 CLI 版本支援 cross-generate。

### 1.3 先建前端，再 `go build`

前端產物通常用 `//go:embed all:assets` 嵌進 exe。`go:embed` 在編譯期展開，**它不會幫你跑前端建置**。

```go
//go:embed all:assets
var assets embed.FS
```

- 正確順序：建前端 → 確認 `assets/index.html` 存在且非 0 → `go build`。
- 錯誤順序（很常見）：先 `go build`，再建前端。結果是 exe 裡是**上一版 UI**，而且本機測試怎麼看都「有更新」，因為你跑的是舊檔。
- 發佈腳本要**先刪掉輸出檔再建**，讓「前端建置失敗」變成明確錯誤，而不是默默嵌入舊檔：

  ```powershell
  # 把 assets 換成你的 embed 生成目錄（不是原始碼目錄）
  Remove-Item -Recurse -Force assets -ErrorAction SilentlyContinue
  bun run build:desktop   # 換成你的前端建置指令（npm run build／pnpm build 等）
  if (!(Test-Path assets/index.html)) { throw "frontend build produced no assets" }
  go build -ldflags "-X main.buildTime=$buildTime -H windowsgui" -o app.exe .
  ```

- `//go:embed all:assets` 需要匹配到實際檔案；路徑錯或空目錄可能在編譯期就報 `no matching files found`。若目錄只有 `.gitkeep` 之類的佔位檔，可能編得過但沒有真正的 assets；建置後用 `-version` 或 `-selftest` 檢查 embedded 檔案清單。
- CI 快取可能藏住「前端沒建」；從 tag 做一次 clean build 再發佈。

### 1.4 GUI 子系統與 console 版

- 發佈版用 `-ldflags "-H windowsgui"`：雙擊不跳黑色命令列視窗。
- **GUI 子系統沒有 stdout/stderr**。`log.Fatal`、panic、WebView2 初始化失敗都可能「什麼都沒顯示就消失」。
- 因此要：
  - 寫檔 log（`%LocalAppData%\<App>\logs\` 或 exe 旁可寫目錄），啟動第一行記版本、buildTime、OS、WebView2 版本。
  - 在 `application.New` **之前**的致命錯誤用 `MessageBoxW`（Windows）或 `osascript`（macOS）告訴使用者；那時還沒有 Wails 視窗。
  - 提供 `--console` 或 `-console` 建置選項給開發／排錯；不要讓使用者只能猜。
- 從 GUI 程式啟動 console 子行程時，設定 `SysProcAttr{HideWindow: true}` 與 `CREATE_NO_WINDOW`，否則會閃黑窗。
- `-H windowsgui` 與 SmartScreen **完全無關**；不要把它當成警告的修正。

### 1.5 `production` tag 與 DevTools

- 許多 Wails v3 專案／template 用 `-tags production` 關閉 DevTools 與除錯日誌。若你的 Taskfile／template 使用它，發佈版就用；否則用你的 release 設定達到同等效果。
- 發佈版關了 DevTools，自動化測試就接不上。做法是另外建一個 debug 版，或提供**只在環境變數／明確 flag 下**開啟的除錯埠；正式版預設不開。
- 發佈前檢查 exe 的啟動參數裡沒有 `--remote-debugging-port`，也沒有 `--remote-allow-origins=*`。

### 1.6 WebView2 不是內建的

Windows 的 WebView2 Runtime 是 Microsoft 的獨立元件，不是你的 exe 的一部分。

- `wails3 package GOOS=windows` 預設做 NSIS installer，裡面含 WebView2 bootstrapper，會在有網路時下載 runtime。
- 如果你發的是 **portable zip／單 exe**，就沒有 bootstrapper：要自行偵測，並在缺失時顯示清楚訊息與下載連結；離線環境要另外附 Evergreen Standalone Installer。
- 較舊的 Windows 10、LTSC、Server 映像可能沒有 WebView2。啟動失敗在 `windowsgui` 下可能完全看不到，所以先寫 log／message box。
- WebView2 的 user data folder 必須可寫。**不要放在 `Program Files` 或 exe 旁邊的唯讀目錄**；明確指到 `%LocalAppData%\<App>\WebView2` 之類的位置。
- WebView2 會獨立更新。若你依賴某個版本行為，固定版本（fixed version）是選項，但體積與安全更新要自己承擔。

### 1.7 巢狀 module 與 CI

- `wails/` 若是獨立 Go module，根目錄的 `go test ./...` **不會**測到它。CI 要分別跑兩邊，或加 `go.work`（但不要用 `go.work` 掩蓋缺少 `go.mod` 的問題）。
- 指令要在正確的 module 目錄執行；`go build .` 的 `.` 是當前目錄，不是 repo 根。
- 輸出路徑若含空格或中文，腳本要用參數陣列／引號，不要拼 shell 字串。
- 建置產物（`bin/`、`build/`、`*.syso`、生成的 `assets/index.html`、installer、exe）放 `.gitignore`；`go.sum` 要進版控。

### 1.8 可重現與版本資訊

- 版本時間用 linker 注入，**不要用檔案 mtime**：

  ```powershell
  $buildTime = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  go build -trimpath -ldflags "-X main.buildTime=$buildTime -H windowsgui" -o app.exe .
  ```

- `-trimpath` 去掉本機路徑，利於重現與隱私。
- 建置後跑一次 `app.exe -version`，確認輸出標明 buildTime 來自 linker 注入（不是檔案時間）；若退回檔案時間，發佈版就無法可靠比新舊。
- 版本資訊（CompanyName、ProductName、FileVersion）要一致；這不解決 SmartScreen，但讓使用者與支援人員能確認拿到什麼。

---

## 2. 前端與 Go 的橋

### 2.1 一定要用會提供 runtime 的 asset handler

Wails v3 內嵌 assets 時，常見兩個 handler：

- `application.BundledAssetFileServer(assets)`：提供 assets **而且**在 `/wails/runtime.js` 提供內建 runtime。
- 只服務 assets 的 handler（例如 `AssetFileServerFS`）：頁面照樣開，但 `/wails/runtime.js` 不存在。

症狀：UI 看起來正常，但所有 `Call.ByName` 都失敗、清單永遠空的、`import('/wails/runtime.js')` 被拒。**頁面能開不代表橋能用。**

```go
Assets: application.AssetOptions{
    Handler: application.BundledAssetFileServer(assets),
},
```

驗證方式：在 DevTools console 跑

```js
await fetch('/wails/runtime.js').then(r => [r.status, r.headers.get('content-type')])
```

應該是 `200` 與 JavaScript content type。若是 404，先修 handler，不要先查 service。

### 2.2 `Call.ByName` 的名稱與參數

```js
const { Call } = await import('/wails/runtime.js');
const list = await Call.ByName('main.Backend.ListFiles');
const n = await Call.ByName('main.Backend.Read', path, offset, length);
```

- 名稱是「註冊時的套件路徑 + 型別 + 方法」。service 在 `package main` 時通常是 `main.Backend.Method`；換套件就要用完整路徑。
- service 方法必須 **exported**（大寫開頭），參數與回傳型別也要是綁定工具能處理的；改了 service 簽名若用生成綁定，記得重新 generate。
- 名稱錯的錯誤常常只是 promise reject；如果呼叫端沒有 catch，畫面就只是「沒反應」。
- 參數與回傳都要 JSON 可序列化。`[]byte` 雖然可序列化，但會變成數字陣列、體積大；熱路徑改用 base64 或批次。`map[any]any` 之類的型別要先轉成明確的 struct／string／number；時間用固定格式字串（例如 RFC3339）而不是依賴隱式轉換。
- 熱路徑用強型別回傳；`map[string]any` 方便但難測、也容易在版本間漂移。
- 若使用 Wails 的生成綁定，優先使用生成的 typed 方法；`ByName` 適合極薄宿主或動態探測。

### 2.3 宿主探測：共用同一個 promise

前端要同時支援「瀏覽器開啟」與「桌面宿主」時，通常會 lazy probe：

```ts
let probe: Promise<Host | null> | null = null;

function host(): Promise<Host | null> {
  return (probe ??= probeHost());
}
```

- **不要**用 `probed` 布林旗標做「已探測」：兩個呼叫同時進來時，第二個會在探測完成前看到 `probed=true, call=null`，誤判「沒有宿主」，於是清單整個空的。
- 把結果做成**共用的 promise**，所有人 await 同一個。
- 探測失敗不是「正常無宿主」與「壞掉」二選一；要區分並回報：

  ```ts
  export const hostState = () => ({ available: !!call, listed: lastCount, error: lastError });
  ```

- `void boot()` 裡的 async 錯誤會被吞掉。至少 `.catch(e => showDiagnostic(e))`；否則使用者只看到空白。
- 若 UI 有「重新整理」按鈕，讓它能重試探測，而不是把失敗快取到重新載入頁面。

### 2.4 二進位資料：base64，不要 `[]byte`

Wails 的 JSON 橋會把 Go 的 `[]byte` 序列化成**數字陣列**，體積約 3–4 倍（視數字位數）；base64 只膨脹約 1.33 倍。

```go
func (b *Backend) Read(path string, off, n int64) (string, error) {
    // ... 讀 bytes ...
    return base64.StdEncoding.EncodeToString(buf), nil
}
```

```ts
const u8 = Uint8Array.fromBase64
  ? Uint8Array.fromBase64(b64)
  : Uint8Array.from(atob(b64), c => c.charCodeAt(0));
```

- 前端要處理 `fromBase64` 不存在的情況（舊 WebView2）。
- 不要回傳巨大的 number array；也不要讓前端逐列呼叫。批次讀取、在 Go 端計算，只把結果送過去。
- 回傳錯誤用 error／結構化結果，不要用 `nil` 假裝成功；空結果與失敗要能區分。

### 2.5 跨語言邊界有固定成本

實測量級（依機器而異）：每次呼叫固定約 **0.9 ms**，之後約 **60 MB/s**；mmap 本身可以到 GB/s，瓶頸在 JSON＋base64＋訊息傳遞。

- 小量、單次：Go 不一定比前端自己的實作快；先量。
- 大量、批次：把整批工作放進一個 Go 呼叫，讓平行與解壓在 Go 的 goroutine 上做。
- 不要「每個 row 一次 `Call.ByName`」；那是把固定成本乘以 N。
- 設計 API 時就想「這一次呼叫要搬多少 bytes」；能只回摘要就不要回原始資料。

### 2.6 外部連結與 `target=_blank`

WebView2 對 `target=_blank` 的處理不是「開系統瀏覽器」；它可能開一個內嵌的新 WebView 視窗，或看起來什麼都沒發生。

- 攔截 `<a target="_blank">` 與 `window.open`，交給宿主用系統瀏覽器開。優先使用 Wails 的 Browser API（若你的版本有）或平台 API（Windows `ShellExecute`／macOS `open`）；`rundll32 url.dll,FileProtocolHandler` 只在沒有 API 時用，且要驗證 scheme。
- 只允許 `https:`／`http:`／`mailto:` 等預期 scheme；不要直接把任意字串丟給 shell。
- 外部連結失敗要回 false，讓 UI 有 fallback；不要靜默。

### 2.7 DevTools、CDP 與 WebView2 資料目錄

自動化測試要接上 WebView2 的 DevTools，有幾個連鎖坑：

1. **Wails 會覆寫 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`**。只設環境變數沒用；要從 `application.WindowsOptions.AdditionalBrowserArgs` 傳。
2. 新 Chromium 的 CDP websocket 需要 `--remote-allow-origins=*`，否則連線被拒。
3. **同一個 WebView2 user data folder 只有第一個行程拿得到 remote debugging port**。並行測試要每個行程自己的 `WebviewUserDataPath` 與自己的 port。
4. Port 被前一個行程佔住時，先等它消失；不要立刻重試同一個 port。
5. 等 DevTools endpoint 真的起來：輪詢 `http://127.0.0.1:<port>/json/version`，有回應再連。

```go
var winOpts application.WindowsOptions
if dir := os.Getenv("APP_WEBVIEW_DIR"); dir != "" {
    winOpts.WebviewUserDataPath = dir // 測試／並行實例；沒設定＝用預設
}
if port := os.Getenv("APP_DEBUG_PORT"); port != "" {
    winOpts.AdditionalBrowserArgs = []string{
        "--remote-debugging-port=" + port,
        "--remote-allow-origins=*",
    }
}
```

- 這段要**只在有明確 flag／env 時**開啟；正式版預設不開任何除錯埠。
- 測試結束用正常關閉（`win.Close()`／`app.Quit()`），不要硬殺；硬殺會讓 WebView2 子行程與資料目錄殘留，下一次測試莫名失敗。
- 清場要針對測試用的 PID／profile，不要全域殺掉使用者的瀏覽器。

### 2.8 兩個行程搶同一個 WebView2：`0x8007139F`

**實測**：新舊兩個行程同時使用同一個 WebView2 user data folder，第二個會拿到 `0x8007139F`（ERROR_INVALID_STATE）而開不起來；即使只重疊約 2 秒也會失敗。

對策：

- 正式版做**單一實例**：named mutex／lock file／Wails 的 single-instance 機制；第二個實例喚醒第一個後結束。
- 或者每個實例用**自己的** `WebviewUserDataPath`（但這會增加磁碟用量，且使用者會看到兩個獨立視窗）。
- 自動更新時，舊行程必須**完全結束**，新行程才能開；見 §5.3 的重啟 helper。
- 測試並行時，每個行程獨立 dir＋port。
- 若應用會 mmap 自己的資料檔，更新／刪除前先解除映射；Windows 上被映射的檔案可能無法改名或刪除。

---

## 3. 視窗、螢幕與 DPI

### 3.1 先建隱藏視窗，等 `ApplicationStarted` 再定位

Wails 的螢幕快取要等應用跑起來（訊息迴圈就緒）才有；在 `application.New` 之後、`Run` 之前常常是空的。

推薦流程：

```go
win := app.Window.NewWithOptions(application.WebviewWindowOptions{
    Title:  "MyApp",
    URL:    "/",
    Hidden: true, // 先不要顯示，避免先出現在錯的螢幕再跳過去
})

app.Event.OnApplicationEvent(events.Common.ApplicationStarted, func(*application.ApplicationEvent) {
    // 這時候 app.Screen.GetAll() 才有資料
    // 選螢幕 → 夾進工作區 → SetSize/SetPosition → 套用狀態 → Show()
})
```

- `Hidden: true` 也順便解決 Windows 的白色閃窗。
- 不要在 `application.New` 之前用 `app.Screen`；那時表是空的。
- `application.New`／`app.Run` 放在 `main` goroutine；不要從隨意 goroutine 建立應用或視窗（WebView2 有執行緒親和性）。
- `ApplicationStarted` 回呼不要做長時間同步工作；先定位、`Show()`，再把載入放到背景，否則使用者會看到「開了但沒反應」。
- `X`／`Y` 選項只有在 `InitialPosition: application.WindowXY` 時才生效；預設是 `WindowCentered`，`X/Y` 會被忽略。這是很常見的「我明明設了座標卻沒用」。
- `StartState` 可以在建立視窗時指定 normal／maximised／fullscreen；但若你要先定位再進全螢幕，建議在 `ApplicationStarted` 手動切換，順序較好控制。
- 第一次啟動若要全螢幕，先定位再 `Fullscreen()`；不要讓「全螢幕」與「定位」互相覆蓋。

### 3.2 只用 Wails 的座標系，不要混原生 Win32

- Wails 的 `win.SetPosition`／`win.SetSize` 使用**邏輯（DIP）座標**；`app.Screen` 同時有 `Bounds`／`WorkArea`（邏輯）與 `PhysicalBounds`／`PhysicalWorkArea`（實體）。
- 原生 `GetAllScreens`／`GetCursorPos` 回的是實體座標；在 DPI 虛擬化下，**同一個 API 在 `application.New` 前後拿到的數量或尺寸甚至可能不同**。把它們直接混進 Wails 的 `win.SetPosition`，視窗就會落在錯的位置。
- 正確做法：用游標的實體座標去問 `application.ScreenNearestPhysicalRect`，讓 Wails 做 physical↔DIP 換算，拿回來的 `Screen` 再取 `WorkArea`。
- 原生 API 只用來**列舉與診斷**（例如 `-screens` 印出 monitor/current/scale），不要用來定位。
- 測試要涵蓋：100%／125%／150%／200%、混合 DPI 的多螢幕、負座標、工具列在側邊。

### 3.3 選「使用者執行 exe 的那張螢幕」

- 啟動瞬間的**滑鼠游標**所在螢幕，通常就是使用者雙擊／點執行的那張。
- 用 `ScreenNearestPhysicalRect(Rect{cursorX, cursorY, 1, 1})`。
- 游標不在任何螢幕（外接螢幕已拔、座標殘留）→ 退回「視窗自己落在哪張」（macOS 可用）→ 主螢幕 → 第一張。
- 不要用「視窗框最近的那張」來決定相對位置：平台可能把視窗挪幾十像素，剛好跨過邊界時，最近螢幕會在兩張之間跳，存下來的相對位置就會在兩個座標系之間擺盪。
- 螢幕名字（`\\.\DISPLAY1`）只拿來診斷，不要當唯一鍵；換線／換埠可能改名。

### 3.4 記住視窗：相對工作區、夾進工作區

狀態檔建議：

```go
type windowState struct {
    RelX   int    `json:"relX"`   // 相對所在螢幕工作區原點
    RelY   int    `json:"relY"`
    W      int    `json:"w"`
    H      int    `json:"h"`
    State  string `json:"state"`  // normal | maximised | fullscreen
    Screen string `json:"screen,omitempty"` // 僅供診斷
}
```

- 存**相對工作區原點**的位置，不要存絕對座標；換螢幕、換解析度、拔掉外接螢幕才不會把視窗丟到畫面外。
- 還原時 `clamp`：大小不超過工作區、位置不越界；工作區比最小尺寸還小時以工作區為準。
- 狀態檔用 `os.UserConfigDir()/App/window.json`；原子寫入（`.tmp` → rename）；壞檔視同第一次啟動。
- 提供環境變數覆寫狀態目錄，測試與可攜版才好用。
- 離開時在 `WindowClosing` 先寫一次（那一刻視窗還在），`OnShutdown` 當保險；追蹤器只寫一次。
- 追蹤器要事件驅動：移動／縮放／最大化／全螢幕都更新「最後一次 normal 的框」，這樣從全螢幕還原才正確。
- **硬殺不會觸發 `WindowClosing`／`OnShutdown`**，設定不會寫下來。測試要用正常關閉；這也是使用者「怎麼每次開都回預設」的常見原因。
- 平台可能在 `SetPosition` 後再挪幾十像素（窗框、DPI 換算）。等 60 ms 讀回位置，不一致就補一次；不要無限追逐，也不要要求測試逐像素相同。測「在工作區內 + 接近要求 + 連續兩次不漂移」。

### 3.5 全螢幕：Windows 上沒有標題列是正常的

- Wails 在 Windows 的全螢幕是把視窗樣式換成 `WS_POPUP`：**沒有標題列、不能拖、不能縮放、沒有關閉按鈕**。
- 這不是 bug，但使用者會以為程式壞了。要：
  - 提供 Esc／F11 切換，並在第一次全螢幕時顯示幾秒提示（「按 Esc 或 F11 回到視窗」）。
  - 離開全螢幕後恢復 `WS_OVERLAPPEDWINDOW`（caption／resizable／sysMenu／maximizeBox）。
  - `Alt+F4` 仍然可以關，但不要假設使用者知道。
- 若產品不需要全螢幕，第一次啟動就不要預設全螢幕；那是最容易讓使用者困惑的預設。
- 做一個 `WindowInfo()` 診斷方法回傳位置、大小、狀態、所在螢幕、工作區、Win32 style；排錯時先看它。

### 3.6 多螢幕、RDP 與顯示設定變更

- 每次啟動都重新列舉、重新 clamp；不要相信上次的絕對座標。
- RDP／切換投影／改縮放比例後，螢幕表可能整個變；測試要涵蓋「啟動前後插拔螢幕」。
- 工作區原點不一定是 (0,0)；用 `screen.X`／`screen.Y`，不要假設主螢幕在左上。
- 全螢幕跨到別張螢幕時，先確認目標螢幕的工作區，再設大小；預設尺寸若比螢幕大，置中會算出負座標。

---

## 4. Windows 發佈、SmartScreen 與簽章

這一節是 Windows 桌面應用最常被誤判為「程式 bug」的地方。**SmartScreen 不是你的程式可以「修好」的**；它是作業系統對「未簽章／低信譽檔案」的政策。

### 4.1 先分類：你看到的是哪一種

| 現象 | 實際機制 | 處理方向 |
|---|---|---|
| 「Windows protected your PC」／「Windows 已保護您的電腦」，有「更多資訊 → 仍要執行」 | SmartScreen 應用程式信譽（通常伴隨 Mark-of-the-Web） | 簽章＋累積信譽；或 Microsoft Store |
| 「此應用程式無法執行，因為無法驗證」且可能沒有「仍要執行」 | Windows 11 Smart App Control | 受信任 CA 簽章＋信譽／Store；不能靠使用者按鈕繞過 |
| 「Operation did not complete successfully because the file contains a virus」 | Defender 防毒（不是 SmartScreen） | 送 FP（false positive，誤報）、簽章、乾淨建置；不要關防毒 |
| 只有 installer 被擋，解開後的 exe 不會 | installer 沒簽章 | installer 與 exe 都要簽 |
| 只有別台電腦被擋，自己這台不會 | 別台有 MOTW／沒有你快取到的信譽 | 這是正常現象；用乾淨 VM 重現 |
| 更新後又開始被擋 | 新檔案 hash 的信譽從零開始（未簽章） | 每一版都用同一張憑證簽章 |

### 4.2 為什麼會跳

Microsoft 的規則（2026 年現況）：

- SmartScreen 看兩個訊號：**發行者信譽**（有沒有簽章、憑證是否受信任）與**檔案 hash 信譽**（這個具體檔案有多少人下載且無惡意回報）。
- **未簽章**：每個新版本都要從零建立 hash 信譽；通常會看到警告，且企業政策可能不給「仍要執行」。
- **OV／EV 簽章**：會顯示已驗證的發行者名稱，但**第一次下載仍可能被標為未辨識**，直到信譽累積。EV **不再**像以前那樣直接繞過 SmartScreen；不要只為了這個買 EV。
- **自簽章**：對 SmartScreen 而言與未簽章幾乎一樣；只適合內部測試。
- **Microsoft Store**：由 Microsoft 重新簽章，Store 安裝的應用不會有下載警告（最可靠的做法）。
- **Smart App Control**（Windows 11）：未簽章或未知的程式可能**直接封鎖**，而且不一定有「仍要執行」。受信任 CA 簽章是主要通行證，但不是保證；SAC 仍會參考 app intelligence／信譽，新簽章程式也可能被擋。
- 信譽累積沒有精確門檻，通常要數週、數百次乾淨安裝；**消費者端沒有「手動送審以加速」的機制**（企業可透過 Microsoft Security Intelligence 入口送樣）。

> 重點：**簽章不會讓警告立刻消失**。它讓使用者看到「已驗證的發行者」，並讓同一張憑證的後續版本有機會繼承信譽；未簽章則是每一版都歸零。

### 4.3 什麼「不是」解法

以下都不會真正解決 SmartScreen，不要把它們寫進「修正」：

- 換 icon、加版本資訊、改 manifest、加 DPI awareness。
- 用 `-H windowsgui`、改檔名、改資料夾、改副檔名。
- 包成 zip／7z／自解壓縮檔。解壓後仍可能有 MOTW；而且這只是把警告延後。
- 提供 SHA256。校驗碼是給願意手動驗證的人用的，SmartScreen 不看它。
- 叫使用者「以系統管理員身分執行」。這不繞過 SmartScreen，還會帶來 UIPI／拖放／更新權限問題。
- 用 UPX／加殼／混淆。這會提高防毒誤報與信譽問題。
- 叫使用者關閉 SmartScreen／Smart App Control／Defender，或把程式加入排除。**這是降低使用者安全性的行為，不是產品修正。**
- 叫使用者對檔案「解除封鎖」（`Unblock-File`）。這只適合**你自己的本機測試**；不要把它當成給終端使用者的指示。

### 4.4 在本機重現（很重要）

開發機上直接 `go build` 的 exe **沒有 MOTW**，所以你不會看到使用者看到的警告。要重現：

```powershell
# 1) 看檔案有沒有 Mark-of-the-Web（Zone.Identifier alternate data stream）
Get-Item .\App.exe -Stream Zone.Identifier -ErrorAction SilentlyContinue

# 2) 沒有的話，模擬「從網路下載」；這只是為了重現，不是修正
Set-Content -Path .\App.exe -Stream Zone.Identifier `
  -Value "[ZoneTransfer]`r`nZoneId=3"

# 3) 看簽章狀態
Get-AuthenticodeSignature .\App.exe |
  Format-List Status, StatusMessage, SignerCertificate

# 4) 只在本機測試時解除封鎖
Unblock-File .\App.exe
```

- 最可靠的測試：**乾淨的 Windows VM**，用 Edge 從真正的 HTTPS URL 下載，雙擊執行，使用標準使用者帳號。
- 用 SMB／USB 拷貝通常不會帶 MOTW，所以你會「測不出來」。
- 測 installer 與 portable exe 兩種；測「全新快照」與「已快取信譽」兩種。
- 測試時不要只看「有沒有警告」，也要看警告上顯示的發行者名稱是否正確。

### 4.5 簽章流程（順序不能錯）

```text
1. 建置 exe（icon、manifest、版本資訊、ldflags buildTime 都已就位）
2. 簽 exe（Authenticode，SHA-256，RFC3161 timestamp）
3. 用已簽的 exe 打包 installer／MSIX
4. 簽 installer／MSIX
5. 對「已簽的最終產物」算 SHA-256
6. 寫 versions.json／SHA256SUMS
7. 上傳（先產物、後 manifest，原子替換）
8. 從 HTTPS 抓回來驗 hash 與簽章
```

**簽章後不要再改任何 byte**。改一個 byte 就會讓簽章失效；常見錯誤是「簽完之後為了測試改 buildTime」或「簽完之後才 strip」。要改就重建、重簽。

Wails v3 較新的 CLI 有包裝指令：

```powershell
wails3 sign GOOS=windows
```

若你的版本沒有，直接用 Windows SDK 的 `signtool`：

```powershell
signtool sign /fd SHA256 /td SHA256 /tr http://timestamp.digicert.com /a .\App.exe
signtool verify /pa /v .\App.exe
```

- **一定要 timestamp**。沒有 timestamp，憑證過期後舊版本的簽章會失效，已發佈的使用者可能突然被當成未簽章。timestamp 失敗就不要發佈那個簽章；重試或換 timestamp server，不要簽一個沒有時間戳的檔案。
- `SIGN_CERTIFICATE`／`SIGN_THUMBPRINT` 放在 `build/windows/Taskfile.yml` 或 CI secret；密碼用 `wails3 setup signing` 存到系統憑證保管庫，**不要進 repo、不要寫進 log**。
- 驗章不要只看 `Status = Valid`；更新器要**釘住預期的發行者**（thumbprint／public key／憑證主體），否則任何受信任憑證簽的檔案都會過關。
- 同一張憑證、同一個發行者身分，對信譽累積最有利；非必要不要換憑證。

### 4.6 憑證選項（2026 現況）

| 選項 | 第一次下載的 SmartScreen | 適用 |
|---|---|---|
| Microsoft Store | 不會有下載警告（Microsoft 重簽） | 一般消費者、可接受 Store 流程 |
| OV／EV 程式碼簽章 | 仍可能警告，直到信譽累積；會顯示發行者 | 獨立發佈；CI 簽章 |
| Azure Artifact Signing（前 Trusted Signing） | 仍可能警告，信譽累積；CI 友善、不用硬體 token | 沒有自有 HSM 的團隊 |
| 自簽章 | 與未簽章幾乎相同 | 內部測試、企業受控環境 |
| 不簽章 | 通常警告；Smart App Control 可能直接封鎖 | 不建議對外發佈 |

- Artifact Signing 需要身分驗證，起價約 US$9.99/月（以官方定價為準）；對 CI 管線比傳統 PFX 方便。
- EV 不再自動繞過 SmartScreen；它的價值主要在企業採購與憑證政策，不是「消除警告」。
- 憑證過期不影響**已 timestamp** 的舊簽章；但新版本要用有效憑證簽。
- 換憑證可能讓發行者信譽重新開始；把這點納入發佈計畫。

**決策樹（實務）**：

- **對外公開、要最小摩擦** → Microsoft Store（若產品適合）或 OV／EV／Artifact Signing；預期前期仍可能出現警告，靠信譽累積。
- **企業內部、受控機器** → 受控部署／WDAC／AppLocker／MSIX；不要叫使用者關閉 SmartScreen。
- **開源／預算有限** → 找提供 OSS 資格的簽章服務（例如 SignPath，資格以官方為準），或評估 Artifact Signing 的月費；公布 SHA-256 與官方下載來源，接受前期警告，不要把「關防護」寫進 README。
- **只有內部測試** → 自簽章可以，但不要把它當成對外發佈方案。

**常見誤解**：

| 誤解 | 事實 |
|---|---|
| 加 icon、版本資訊、manifest 就會過 | 不會；SmartScreen 看簽章、MOTW 與信譽，不看這些 |
| 自簽章也是簽章，應該有用 | 對 SmartScreen 幾乎等於沒簽；只適合內部 |
| 買 EV 就一定不會跳 | EV 不再自動繞過；新檔案仍要累積信譽 |
| 簽章後就永遠不會再跳 | 新版本／新 hash 仍可能被標為未辨識；簽章是必要條件，不是保證 |
| 叫使用者關 SmartScreen 就好 | 不要；企業政策可能不允許，而且這是降低安全性，不是產品修正 |

### 4.7 Installer、MSIX 與 portable

- `wails3 package GOOS=windows` 預設產 NSIS installer，內含 WebView2 bootstrapper。**installer 本身也要簽**；只簽裡面的 exe，使用者在下載 installer 時仍會被擋。
- MSIX 需要簽章與信任；企業 sideload 要先把憑證放進信任鏈。Microsoft Store 是最不容易遇到 SmartScreen 的路徑。
- Portable zip／單 exe：簽 exe；文件要寫清楚 WebView2 需求；沒有 installer 的 bootstrapper，缺 runtime 時要自己處理。
- 不要發佈 debug 版（DevTools、除錯埠、verbose log）。debug 版更容易被防毒標記，也讓使用者看到不該看的東西。
- 版本資訊中的 CompanyName／ProductName 要與簽章憑證的發行者一致或至少不矛盾；不一致會讓使用者更不信任。
- 支援文件可以教使用者從「檔案內容 → 數位簽章」確認發行者與時間戳；這比教他們關閉 SmartScreen 安全得多。

### 4.8 自動更新與簽章

- 若你的發佈有簽章，下載回來的更新檔**必須驗簽章**再換檔；不要只驗 SHA-256。SHA-256 只能證明「與 manifest 一致」，manifest 本身若被換掉就沒用。
- 若你的更新器會把舊 exe 改名成 `-prev.exe`，簽章會跟著檔案內容走，改名不影響；但**新 exe 必須是已簽的**。
- 不要用「在 exe 裡原地改 buildTime」的方式做測試或更新；那會破壞簽章。用 `-ldflags` 在建置時注入。
- 更新 manifest 要含 `sha256`、`size`、`buildTime`、`url`；若可行，再加 manifest 簽章或使用 Wails updater 的公鑰驗證。
- 以程式方式下載的檔案不一定有 MOTW，所以 SmartScreen 可能不跳；但 **Smart App Control／防毒／EDR 仍可能擋**。不要把「沒跳 SmartScreen」當成安全或相容性的證明。

### 4.9 防毒誤報與受控資料夾

- 「改名自己 → 啟動副本 → 換掉自己」是合法的更新手法，但行為特徵很像惡意程式。簽章、穩定版本資訊、避免加殼、送 FP，都能降低誤報。
- Windows Defender 的 **Controlled Folder Access** 可能擋住寫入「文件」「下載」；寫檔功能要有退路（app 目錄／暫存），並告訴使用者實際存到哪裡。
- 防毒可能短暫鎖住剛寫好的 exe；`os.Rename` 失敗要 retry／backoff，不要立刻刪掉使用者的檔案。
- 不要以程式方式加入防毒排除或關閉即時防護；這是使用者的安全設定。

### 4.10 企業與受控環境

- 群組原則可能移除 SmartScreen 的「仍要執行」；不要假設使用者一定能繞過。
- WDAC／AppLocker 可能要求簽章或特定發行者；簽章是必要條件，不是萬靈丹。
- 企業可透過 Microsoft Security Intelligence 入口送樣，或使用受控部署／Store／MSIX。
- 文件要寫清楚：OS 版本、WebView2 需求、installer 與 portable 差異、hash、回滾方式。
- 不要教使用者關閉 SmartScreen／Defender／Smart App Control 來「讓程式跑」。

### 4.11 Windows 發佈檢查表

> 本節只列 Windows 專屬項目；整體發佈流程再看 §9。

- [ ] exe 已簽章，且**有 timestamp**。
- [ ] installer／MSIX 也已簽章（不是只有裡面的 exe）。
- [ ] `signtool verify /pa /v` 或 `Get-AuthenticodeSignature` 顯示 Valid，發行者正確。
- [ ] 在乾淨 VM 用 Edge 從 HTTPS 下載，測 installer 與 portable exe。
- [ ] 測標準使用者（非管理員）、Windows 11 Smart App Control 開啟的機器。
- [ ] 測試機沒有你的開發工具、沒有快取信譽。
- [ ] WebView2 缺失時有清楚訊息／installer bootstrapper。
- [ ] 正式版沒有 DevTools／remote debugging port。
- [ ] 已發布 SHA-256 與 `versions.json`，並從線上抓回驗證。
- [ ] 保留上一版可回滾；使用者資料格式相容。
- [ ] 支援說明只教「向發行者確認後仍要執行」，不教關閉安全功能。

---

## 5. 自動更新

### 5.1 先用官方 updater，不要預設自己寫

較新的 Wails v3 有 `app.Updater`：providers（GitHub Releases、Wails manifest、Sparkle AppCast 等）、下載、簽章／digest 驗證、staging、helper 重啟、事件狀態機。

- 先確認你 pin 的版本有沒有 `app.Updater`；有就用，尤其是它已經處理「換掉執行中的自己」與 helper 的問題。
- 若版本沒有，或需求特殊（私有主機、自訂 manifest），再自己寫；**照 §5.4–§5.8 的關卡**，不要只做「下載→覆蓋」。
- 不管用哪個，都要測：中斷、壞 hash、舊 manifest、離線、唯讀目錄、回滾。

### 5.2 Windows 上不能覆蓋執行中的 exe

Windows 允許**改名**執行中的映像，但不能覆蓋或刪除。標準流程：

```text
App.exe（執行中）
  → 改名 App-prev.exe
  → App.exe.new 改名 App.exe
  → 啟動 App-prev.exe（當重啟 helper）
  → 舊行程結束
  → helper 等舊 PID 消失後，啟動新的 App.exe
```

- 改名／搬移要在**同一個磁碟區**；跨 volume 是複製＋刪除，對執行中的 exe 會失敗。
- 目標名稱若被佔用（上一次沒清乾淨），先嘗試刪除；刪不掉就換一個帶時間戳的名字，不要放棄更新。
- 保留 `-prev.exe` 直到新版本證明能跑；它是使用者最後的退路。
- 如果應用 mmap 了資料檔，換檔前先解除映射。

### 5.3 重啟 helper：為了解決 WebView2 獨佔

**不要**在舊行程裡「啟動新行程，然後自己 0.7 秒後結束」。新舊重疊時，新行程的 WebView2 會拿到 `0x8007139F`。

正確做法：

- 由 `App-prev.exe`（舊版副本）當 helper 啟動，帶參數：舊 PID、新 exe 路徑、舊 buildTime、必要時的新 debug port。
- helper **不建立 Wails 應用、不碰 WebView2**；它只等舊 PID 結束。
- 舊行程結束後，WebView2 的子行程可能還會晚一點放掉資料目錄；再等 300–500 ms。
- helper 啟動新 exe，觀察幾秒（例如 4 秒）：
  - 新 exe 正常活著 → helper 結束；新 exe 在幾秒後／正常關閉時刪掉 `-prev.exe`。
  - 新 exe 立刻以非 0 結束 → 把 `-prev.exe` 改名回 `App.exe`、跳訊息框、重新啟動舊版。
- 舊行程在交接時結束是**預期行為**，不要當成 crash；用一個 `handedOff` 旗標或專用 exit code 區分「交棒」與「正常關閉」，避免把使用者的退路刪掉。
- helper 本身若是舊 exe 的副本，簽章仍然有效；若是獨立 binary，也要簽章。

### 5.4 版本真相：`buildTime`，不是檔案時間

- 用 `-ldflags "-X main.buildTime=<RFC3339 UTC>"` 注入；發佈腳本要驗證 `-version` 輸出真的來自 ldflags。
- 退回「檔案 mtime」只在開發時可用；複製、解壓、CI checkout 都會改 mtime，線上比不出新舊。
- 伺服器端放 `versions.json`：

  ```json
  {
    "app": "MyApp",
    "channel": "stable",
    "buildTime": "2026-10-19T10:00:00Z",
    "url": "https://example.com/app/MyApp.exe",
    "size": 17216512,
    "sha256": "…"
  }
  ```

- 用戶端用 `buildTime` 比新舊；遠端至少比本地新 **60 秒**才算新（容忍時鐘／時區誤差）。
- `Last-Modified` 是**上傳時間**，不是建置時間；只能當舊主機的 fallback，而且會造成「更新完又說有新版」。不要把它當主要依據。
- 檢查更新在背景做，設定 timeout（例如 8 秒）；連不上不影響啟動，也不要阻塞 UI。
- manifest 要避免 CDN／瀏覽器快取：用 `Cache-Control: no-cache` 或版本化 URL；否則使用者會一直看到舊版本。
- 檢查失敗要顯示「檢查失敗／離線」，不要顯示「已是最新」；`checkOK=false` 與 `updateAvailable=false` 是不同狀態。
- 開發者本地建置（buildTime 與現在差不到 2 小時）可以跳過檢查，避免打擾；測試時用環境變數強制檢查。
- 拒絕遠端較舊或相同的版本；**不要自動降版**。伺服器回滾不應該讓已更新的使用者降版；要修就發一版新的。

### 5.5 下載後的驗證關卡（簽章必須在執行之前）

任何一關不過，都刪掉下載檔、不動使用者手上那一顆：

1. **大小**等於 manifest 的 `size`。
2. **SHA-256** 等於 manifest 的 `sha256`。
3. 檔頭是 `MZ`，且大小 ≥ 一個合理下限（例如 1 MiB），擋掉 HTML 錯誤頁／空檔。
4. （若有簽章）**先驗 Authenticode 簽章有效，且發行者是預期的 thumbprint／主體**。
5. 跑一次 `new.exe -version`，能解析出 buildTime。**這一步會執行下載檔，必須排在第 4 關之後**；若你的版本沒有簽章，至少要在沙箱／隔離環境驗，或改成讀 PE 版本資源，不要直接在本機執行。
6. 那個 buildTime 比目前新。

其他要求：

- 更新器在 Go 裡可以用 `WinVerifyTrust`（或等價的 Authenticode 驗證）實作第 4 關；不要只檢查「檔案有沒有簽章區段」，那不能證明簽章有效或發行者正確。
- 先下載到 `.part`，驗證通過才 rename 成正式名稱；失敗不留半成品。
- HTTPS；拒絕 redirect 到 HTTP；設定 timeout 與最大下載大小。
- 不要為了自架主機關閉 TLS 驗證或接受任意憑證；用正式憑證，必要時 pin。
- 啟動時清掉上次留下的 `.new`／`.old`，避免下一次誤用。
- 更新流程加鎖（`TryLock`），連點兩次只會有一次真的動手。

### 5.6 回滾與資料相容

- 保留上一版 exe，失敗時改名回去並重新啟動；訊息框要告訴使用者發生什麼。
- 新版本可能改設定格式／資料庫 schema；migration 要**向前相容**（舊版還能讀），或先備份。
- 觀察窗只有 4 秒抓不到「起來 5 秒後才崩」；若產品有長時間初始化，延長觀察或加健康檢查標記。
- 不要在使用者未儲存工作時自動重啟；更新前詢問，或延後到關閉時。

### 5.7 權限與安裝位置

- 更新前真的測試「exe 所在目錄可寫」：建一個暫存檔再刪掉。不可寫時**停用自動換檔**，但仍應檢查版本並引導使用者到官網手動下載；若產品決定完全不檢查，要在 UI 說明原因，不要靜默。
- 安裝在 `Program Files` 需要管理員權限才能換檔；不要為了更新自動提權。優先**按使用者安裝**（`%LocalAppData%\Programs\<App>`）。
- 安裝在受控資料夾／防毒保護區可能被擋；提供手動下載路徑。
- 磁碟空間不足、檔案被鎖、下載逾時都要有可讀的錯誤訊息。

### 5.8 更新流程測試

用本地 HTTP 伺服器，不要拿正式 exe 當白老鼠：

- 把 exe 複製到暫存目錄，建一份比它新的測試 exe（用 `-ldflags` 注入未來時間，**不要 byte-patch**）。
- 產生對應的 `versions.json`（buildTime／size／sha256 都對）。
- 跑完整流程：檢查 → 下載 → 驗證關卡（有簽章時**先驗簽**，通過後才執行 `-version`）→ 換檔 → helper → 新 exe 啟動 → 顯示改版說明。
- 測失敗矩陣：中斷下載、錯 hash、錯大小、HTML 錯誤頁、舊 manifest、缺 manifest、離線、唯讀目錄、磁碟滿、檔案被鎖。
- 驗證：舊 exe 是否變成 `-prev`、新 exe 是否正確、失敗是否回滾、`-prev` 是否在使用者正常關閉後才刪、有沒有留下 `.new`。
- 測試時給每個行程自己的 WebView2 資料目錄與 debug port，避免 `0x8007139F`。

---

## 6. macOS（順帶，但別忽略）

- **ad-hoc 簽章**（`codesign --sign -`）只能避免「已損毀」；未公證的 app 第一次會被 Gatekeeper 擋下。這不是檔案壞掉；正式解法仍是 Developer ID＋公證。
- **macOS 15（Sequoia）以前**可在 Finder 右鍵 →「打開」→ 再按「打開」繞過；**macOS 15 起這個右鍵繞過被移除**，使用者要到「系統設定 → 隱私權與安全性」按「仍要打開」。Apple 的說明：<https://developer.apple.com/news/?id=saqachfa>
- 正式解：Developer ID Application 憑證 ＋ `notarytool` 公證 ＋ `stapler` 釘票；用 `spctl --assess --type execute -vv App.app` 驗證。
- 下載的 `.app` 會有 `com.apple.quarantine`；`xattr -dr com.apple.quarantine` 是繞過，不是修正。不要教使用者這樣做。
- 打包用 `ditto -c -k --keepParent App.app App.zip`；一般 `zip` 可能破壞符號連結／簽章。
- 從 Finder 啟動的 app，**工作目錄是 `/`**，不是 `.app` 所在目錄。用 `os.Executable()`、`os.UserConfigDir()`，不要用相對路徑找資源。
- macOS 的自動更新是換整個 `.app` bundle，涉及簽章與公鑰；不要直接把 Windows 的「換一顆 exe」邏輯搬過來。helper 要放在 bundle 外，換完驗簽再啟動。
- 交叉編譯 x86_64 要 `CGO_ENABLED=1`、`GOARCH=amd64`、`CC="clang -arch x86_64"`；arm64 原生編。 universal 用 `lipo`。
- CI 的 bash 坑：`$VAR（` 全形括號會被當成變數名的一部分，`set -u` 下直接 unbound variable；一律寫 `${VAR}（`。

---

## 7. Go 層與跨平台細節

### 7.1 不要在持有 mutex 時 panic

- Go 的 `sync.Mutex` 不可重入。若在鎖內 panic，deferred 的 cleanup 又嘗試拿同一把鎖，會**永久卡死**；行程還活著，UI 卻像沒回應。
- 症狀：前端 `Runtime.evaluate` 逾時、視窗沒崩、Go 沒 crash log。
- 對策：鎖的臨界區只做不能失敗的事；先驗證／配置資源，再進鎖；panic 前確保解鎖；cleanup 不要重新 Lock。
- 會 panic 的 map 寫入、nil deref、slice 越界，都應在進鎖前排除。
- 若真的需要 `recover`，在 goroutine 邊界做，並先釋放資源；不要用 `recover` 掩蓋邏輯錯誤。

### 7.2 mmap 與檔案生命週期

- 檔案大小 0 不能 mmap；先檢查。
- 映射期間檔案被刪／改名在 Windows 上可能失敗；更新或刪除資料檔前先 `UnmapViewOfFile`／關閉 handle。
- 多 goroutine 共用映射要加鎖；回傳的 slice 在 unmap 後失效，不要讓它逃逸。
- 前端要求巨大區間時要驗證 offset／length，回 error 不 panic；負數視為錯誤，不要默默截斷。
- 只有檔案在允許的根目錄內才讀；拒絕 `..`、絕對路徑逃逸、symlink 逃逸。這是安全邊界，不是禮貌。

### 7.3 日誌與診斷

- GUI 版沒有 console；日誌寫檔，包含：版本、buildTime、OS、WebView2 版本、螢幕資訊、更新 URL、錯誤鏈。
- 提供 `-version`、`-selftest`、`-diag`、`-screens` 之類的 headless 旗標；讓 agent 在沒有 GUI 的環境也能驗證核心邏輯。
- 致命錯誤在 `application.New` 前用 message box；之後用 UI 顯示，不要只寫 log。
- 不要在 log 印憑證密碼、token、使用者私密路徑；需要時遮罩。

### 7.4 文字與命令列編碼（見姊妹文件）

> Windows／漢字／PowerShell 的共通坑已整理到 [yap-software-practice.md](./yap-software-practice.md) §4.1、§5；本節不重複。

---

## 8. 測試與診斷

### 8.1 分層測試

1. **Headless**：核心邏輯、檔案解析、查詢、更新 manifest 解析，不開 GUI。
2. **單元**：視窗狀態的 clamp、選螢幕、版本比較、hash 驗證；把它們寫成純函式。
3. **GUI 煙霧**：開視窗、確認 bridge、關視窗；用 CDP 或 Wails 測試工具。
4. **安裝／更新**：installer、portable、upgrade、rollback。
5. **作業系統層**：乾淨 VM、標準使用者、MOTW、WebView2 缺失、多螢幕、DPI、RDP。

### 8.2 GUI 自動化注意事項

- 每個測試行程自己的 `WebviewUserDataPath` 與 debug port。
- 等 `/json/version` 有回應再連；不要固定 sleep 2 秒。
- CDP websocket 需要 `--remote-allow-origins=*`。
- 測試結束正常關閉；硬殺會留下 WebView2 子行程與鎖。
- 清場只殺測試 PID／profile，不要全域殺瀏覽器。
- `production` build 沒有 DevTools；要測就建 debug 版，並另外確認正式版沒開埠。

### 8.3 一定要在「像使用者」的環境測

- 沒有 Go／Node／Wails CLI 的乾淨 Windows VM。
- 標準使用者（非管理員）。
- 從 HTTPS 下載、帶 MOTW 的產物。
- WebView2 已安裝與未安裝兩種。
- 離線／慢網／中斷下載。
- 125%／150%／200% 縮放、多螢幕、拔掉外接螢幕、RDP。
- 路徑含空格／中文；使用者名稱含中文。
- 防毒開啟；Controlled Folder Access 開啟。
- 安裝在 `Program Files` 與 `%LocalAppData%` 兩種。

### 8.4 不要假裝測過

- 「`go build` 成功」不等於「exe 能開」。
- 「本機雙擊能開」不等於「沒簽章也能過 SmartScreen」。
- 「加了簽章」不等於「第一次下載不會警告」。
- 「CDP 測過」不等於「正式版行為一致」（production tag 可能關掉東西）。
- 「更新流程跑過」不等於「中斷／壞檔／回滾都安全」。

---

## 9. 發佈前檢查表

> Windows 專屬細節見 §4.11；本節是整體發佈流程的檢查表，兩邊刻意重疊，避免漏項。

### 9.1 建置

- [ ] `go.mod`、`wails3` CLI、Taskfile 版本一致；沒有中途升級。
- [ ] 前端先建，assets 存在且非 0；exe 裡的 UI 是最新的。
- [ ] `.syso` 有 `-arch`、大小正常、架構正確；manifest 有 DPI／longPath／supportedOS。
- [ ] 使用 `-tags production`（或等價）與 `-H windowsgui`；`-version` 顯示 ldflags buildTime。
- [ ] 沒有把 debug 版、DevTools、remote debugging port 帶進正式產物。
- [ ] `-trimpath`；沒有把本機路徑／秘密嵌進 binary。

### 9.2 功能

- [ ] exe 雙擊能開；白屏／閃退已排除。
- [ ] `/wails/runtime.js` 200；`Call.ByName` 正常；host error 可觀測。
- [ ] 視窗在正確螢幕；第一次啟動、恢復、拔螢幕、改 DPI 都測過。
- [ ] 全螢幕有 Esc／F11 出口與提示；關閉能保存狀態。
- [ ] 外部連結用系統瀏覽器；沒有開出內嵌怪視窗。
- [ ] 大檔／大量資料不會卡死 UI；沒有逐列 IPC。

### 9.3 Windows 發佈

- [ ] exe 與 installer 都簽章、有 timestamp、驗章 Valid、發行者正確。
- [ ] 乾淨 VM 從 HTTPS 下載測試；SmartScreen／Smart App Control 行為已記錄。
- [ ] WebView2 缺失有處理；portable 與 installer 都測。
- [ ] SHA-256／`versions.json` 已發布，線上抓回驗證。
- [ ] 沒有教使用者關閉安全功能。

### 9.4 更新

- [ ] 版本比較用 buildTime，不用 mtime／Last-Modified。
- [ ] 下載有 size／sha256／MZ／較新等基本關卡；有簽章時**先驗簽、再執行 `-version`**。
- [ ] 舊 exe 改名、helper 等 PID、新 exe 啟動、失敗回滾都測過。
- [ ] 兩個行程不會搶同一個 WebView2 資料目錄。
- [ ] `-prev` 保留到新版本正常關閉；交接退出不會誤刪。
- [ ] 中斷／壞檔／離線／唯讀／磁碟滿都測過。

### 9.5 文件

- [ ] 安裝需求（OS、WebView2）寫清楚。
- [ ] SmartScreen 警告的說明是「向發行者確認後仍要執行」，不是「關閉防護」。
- [ ] 回滾步驟、手動下載、上一版位置寫清楚。
- [ ] 版本說明給使用者看的是「感覺到什麼」，不是 commit log。

---

## 10. 給 AI agent 的硬規則

1. **先讀版本，再寫程式**。`go.mod`、`wails3 version`、Taskfile 先看；不要用最新文件推測 pinned 版本的 API。
2. **不要中途升級 Wails／Go／CLI**，除非使用者明確要求；升級要單獨做、單獨測。
3. **建置順序固定**：前端 → 驗證 assets → `go build`。不要用「先編再補」的順序。
4. **編譯成功後一定要跑**：`-version`、`-selftest`、開窗、bridge 呼叫。沒有執行證據不要說完成。
5. **看到 `runtime/cgo`／`gcc not found` 先查 `.syso`**，不要先裝 gcc。
6. **不要混用原生 Win32 座標與 Wails 邏輯座標**；定位只用 `app.Screen`。
7. **不要讓兩個行程共用 WebView2 user data folder**；更新用 helper 等舊 PID，測試用獨立 dir。
8. **不要關閉 SmartScreen／Defender／Smart App Control**，也不要教使用者這樣做；要修就簽章、累積信譽、改用 Store／MSIX。
9. **不要在簽章後修改 binary**；要改就重建、重簽、重算 hash。
10. **不要未經同意簽章、上傳、發佈、改 DNS／伺服器**；憑證與密碼不進 repo、不進 log。
11. **不要宣稱 SmartScreen 已修正**，除非你在乾淨 VM 用 HTTPS 下載、帶 MOTW 測過；而且要知道「簽章不等於第一次不警告」。
12. **保留回滾路徑**：上一版 exe、舊設定、舊資料格式；更新失敗要能回去。
13. **把錯誤顯示出來**：host error、更新失敗、寫檔失敗、WebView2 缺失；不要靜默回空陣列。
14. **不要用 `[]byte` 過 JSON 橋**；base64 或批次處理。
15. **不要讓 panic 發生在鎖內**；先驗證，再進臨界區。
16. **測試要像使用者**：標準使用者、乾淨 VM、MOTW、無 WebView2、多螢幕、離線。開發機的綠燈不算。
17. **有簽章時先驗簽，再執行下載檔的 `-version`**；不要顛倒順序。

---

## 附錄 A：常見錯誤與第一反應

| 訊息／錯誤碼 | 常見原因 | 第一反應 |
|---|---|---|
| `0x8007139F`／`ERROR_INVALID_STATE` | 兩個行程共用 WebView2 user data folder；舊行程沒完全結束 | 等舊 PID＋緩衝；單一實例；測試分開 dir |
| `loadinternal: cannot find runtime/cgo` ＋ `gcc: not found` | 0 byte／錯架構 `.syso` 讓連結改走 external linker | 刪 `.syso`，用 `-arch` 重生成 |
| `WebView2 runtime not found`／初始化失敗 | 機器沒有 WebView2 | 安裝 Evergreen；installer bootstrapper；顯示下載連結 |
| `/wails/runtime.js` 404 | 用錯 asset handler | 改用 `BundledAssetFileServer` |
| `method not found`／`Call.ByName` reject | 名稱或套件路徑錯；service 沒註冊 | 印出實際名稱；確認 `application.NewService` |
| 頁面空白、console 有 `ReferenceError` | async boot 的錯誤被吞；漏 import | 加 catch；把錯誤顯示在 UI／log |
| `Access is denied` 寫 Downloads | Controlled Folder Access／權限 | 退路目錄；回報實際路徑；不要關防毒 |
| `The process cannot access the file` | 執行中的 exe／被防毒鎖住 | 改名而非覆蓋；retry／backoff；不要刪使用者資料 |
| `This app can't run on your PC` | 架構錯（arm64 vs amd64）或檔案損壞 | 檢查 `GOARCH`、`.syso` 架構、重新下載 |
| SmartScreen「Windows protected your PC」 | 未簽章＋MOTW＋無信譽 | §4；簽章；乾淨 VM 驗證 |
| 「無法驗證此應用程式」且可能沒有「仍要執行」 | Smart App Control | 受信任簽章／Store；不要教使用者關閉 |

---

## 附錄 B：參考資料

- Wails v3 — Windows Packaging（NSIS、WebView2 bootstrapper、`wails3 sign`）：<https://v3.wails.io/guides/build/windows/>
- [yap-software-practice.md](./yap-software-practice.md) — Windows／Bun／單檔 HTML／漢字／無損簡體／主題的共通實踐
- Wails v3 — Code Signing（Windows/macOS、`wails3 sign`、timestamp、憑證設定）：<https://v3.wails.io/guides/build/signing/>
- Wails v3 — Updater（`app.Updater`、providers、簽章驗證、staging／restart）：<https://v3.wails.io/guides/updater/>
- Wails v3 — Window Options（`Hidden`、`InitialPosition`、`StartState`、fullscreen）：<https://v3.wails.io/features/windows/options/>
- Wails v3 — Screen Information（邏輯／實體座標、工作區、多螢幕）：<https://v3.wails.io/features/screens/info/>
- Microsoft — SmartScreen reputation for Windows app developers（2026 現況：OV/EV、Store、Artifact Signing、EV 不再繞過）：<https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation>
- Microsoft — Smart App Control overview（未簽章／未知程式封鎖）：<https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/overview>
- Microsoft — Time Stamping Authenticode Signatures：<https://learn.microsoft.com/en-us/windows/win32/seccrypto/time-stamping-authenticode-signatures>
- Microsoft — `Zone.Identifier` Stream Name（Mark-of-the-Web 的資料流）：<https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-fscc/6e3f7352-d11c-4d76-8c39-2516a9df36e8>
- Apple — Updates to runtime protection in macOS Sequoia（macOS 15 起移除右鍵繞過 Gatekeeper）：<https://developer.apple.com/news/?id=saqachfa>
- Microsoft Security Intelligence — 檔案送樣（防毒誤報／企業審查）：<https://www.microsoft.com/en-us/wdsi/filesubmission>

---

> **最後一句**：Wails3 的坑大多不是「Go 寫錯」，而是**建置順序、Windows 平台契約、行程／WebView2 生命週期、以及發佈信譽**。先把這四件事當成設計約束，再寫功能。
