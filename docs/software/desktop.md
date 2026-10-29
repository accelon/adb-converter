# Accelon26 桌面宿主（Wails）

> 桌面版不是另一套閱讀器；它把同一份單檔 HTML 包進 Wails，外加檔案系統、
> adb 下載、更新與資料夾整合。

## 1. 架構

```text
wails/assets/index.html   ← 由 tools/build-desktop.ts 產生
        ↓ go:embed
accelon26.exe
        ↓
Wails WebView + Go host
        ↓
D:\accelon3\*.adb
```

- WebView 只負責 UI。
- Go host 負責：
  - 列 adb、mmap 讀取
  - 儲存 adb、下載、覆寫
  - 版本／鏡像／更新
- 網頁版用 `Blob.slice()` 讀檔；桌面版用 host 的 mmap。

## 2. `📁` 下拉

桌面版：

```text
⬇ 取得更多 ADB
──────────────
已開啟過的 adb
```

網頁版：

```text
＋ 加入 adb
```

### 2.1 取得更多 ADB

只在桌面顯示。流程：

1. 讀主站／鏡像 `adb/manifest.json`
2. 比較下載速度
3. 列出公開資料庫
4. Go `StartNewAdbDownload` 下載
5. 驗證 size／sha256／adb 檔頭
6. `refreshHostDbs()` 重刷 `📁`

- 離線時變暗但**不隱藏**；`online` 後恢復。
- 下載到執行檔旁（不可寫才退到工作目錄／下載資料夾）。
- 已安裝項目交給既有的「資料庫版本」更新。

### 2.2 加入 Obsidian

- 只出現在進階模式。
- 一般使用者看不到資料夾／ZIP 轉檔入口。
- 轉出的 adb 寫到執行檔旁，完成後刷新清單。

## 3. 更新

- `versions.json` 是版本真相。
- 主站／鏡像 base 由 `mirror.ts` 選擇。
- 下載 exe 走 Go，不經 WebView CORS。
- 官網 ZIP 與 exe 更新是兩條流程；`release.ts` 會一起產生。

## 4. 重要 Go 方法

| 方法 | 用途 |
|---|---|
| `ListAdbs` | 列工作目錄／exe 目錄的 adb |
| `Open`／`ReadBase64` | mmap 讀取 |
| `SaveAdb` | Obsidian 轉出的 adb |
| `StartNewAdbDownload` | 下載本機沒有的公開 adb |
| `StartAdbDownload` | 更新既有 adb |
| `AdbDownloadStatus` | 輪詢進度 |
| `FetchText` | 讀 manifest |
| `SetUpdateMirror`／`ProbeMirror` | 鏡像 |

## 5. 建置

```powershell
cd ts
bun run tools/build-desktop.ts

cd ..\wails
go build -ldflags "-H windowsgui" -o ..\accelon3\accelon26.exe .
```

## 6. 目前本機檔案

```text
D:\accelon3\accelon26.exe      18,276,352 bytes（本機後續修正版）
D:\accelon3\accelon26.html     同步的單檔 HTML
```

官網正式版 exe 仍是 10-29 release（18,264,576 bytes），發布流程見
[release.md](./release.md)。

## 7. 注意

- 桌面 exe 與 website ZIP 要一起發佈，否則官網下載的版本會落後本機。
- 不要在一般模式露出 Obsidian 入口。
- 取代正在使用的 exe／adb 時，Windows 可能鎖檔；先關程式或改名舊檔。
