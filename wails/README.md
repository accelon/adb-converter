# wails/ — accelon26 的 Wails3 桌面宿主

這個目錄是**獨立的 Go module**（`github.com/accelon/adb-converter/wails`，巢狀在倉庫根
module 裡，彼此不影響）。

> 通用的 Wails3 建置／WebView2／視窗坑見 [wails3-pitfalls.md](../wails3-pitfalls.md)；Windows／漢字／UI 見 [yap-software-practice.md](../yap-software-practice.md)；本文只記本專案的 Go 層與指令。

**產品的預設形態仍然是單檔 HTML**：`assets/index.html`（由倉庫根目錄的
TypeScript 建置腳本產生，例如 `bun run tools/build-desktop.ts`）。本目錄只有在
明確需要桌面 exe 時才建置；這裡的 Go 程式碼只是它的宿主，刻意做得極薄。

## Go 層做什麼

只註冊一個 Wails service `AdbHost`（`main.AdbHost`）：

| 方法 | 作用 |
| --- | --- |
| `ListAdbs()` | 列出**當前工作目錄**裡的 `*.adb`，每個檔案只讀前 256 位元組檔頭 |
| `Open(path)` | 驗證並 mmap 一個 `.adb`（快取），回傳檔頭資訊 |
| `ReadBase64(path, offset, length)` | UI 唯一的讀取入口，回傳該範圍的 base64 |
| `Close(path)` / `CloseAll()` | 解除 mmap |

- **不做任何 adb 格式解析**（除了 256 位元組檔頭裡的 dbname / dbcname），
  沒有事件、沒有 socket、沒有自訂協議。
- 檔案讀取用 Windows `CreateFileMappingW` + `MapViewOfFile`（直呼 kernel32，
  沒有引入新依賴）：映射一次，之後每次 `ReadBase64` 都不再有檔案系統 syscall。
- 為了安全，路徑必須是 `.adb` 且位於當前工作目錄之內；負的 offset / length
  一律視為錯誤，不會悄悄截斷。
- 前端約定：

  ```js
  const { Call } = await import("/wails/runtime.js");
  const list = await Call.ByName("main.AdbHost.ListAdbs");
  const b64  = await Call.ByName("main.AdbHost.ReadBase64", path, offset, length);
  ```

  `Handler` 必須用 `application.BundledAssetFileServer`；原因與常見錯誤見 [wails3-pitfalls.md](../wails3-pitfalls.md) §2.1。

## 命令（都在 wails/ 目錄下執行）

```powershell
go test ./...                                  # 單元測試（不需要 GUI）
go build -ldflags "-H windowsgui" -o ..\accelon3\accelon26.exe .   # 建置桌面 exe（GUI 子系統，雙擊不跳命令列）
cd ..\accelon3
accelon26.exe                                     # GUI（.adb 就在這個資料夾，會自動列出來）
accelon26.exe -selftest                           # 無 GUI 自檢
```

> exe 一律產在 `accelon3\`（工作文件夾，作者 2026-10）：那是 accelon3 的資料夾，
> 幾十個 `.adb` 都在裡面，建完直接雙擊就能測。`accelon3/` 不進版控。

`-selftest` 會在當前目錄列出所有 `.adb`（含中文顯示名），對
128 KiB x 200 次的 mmap+base64 讀取計時，驗證越界讀取會回報錯誤，然後結束。

Taskfile（可選，不依賴 npm/node）：`task build` / `task test` / `task run` / `task selftest`。
