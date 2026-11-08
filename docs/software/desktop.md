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
- 下載到目前工作用的資料夾（以檔案開啟時是該檔所在資料夾）；寫不進去才退到執行檔旁／下載資料夾。
- 已安裝項目交給既有的「資料庫版本」更新。

### 2.2 加入 Obsidian

- 只出現在進階模式。
- 一般使用者看不到資料夾／ZIP 轉檔入口。
- 轉出的 adb 寫到目前工作用的資料夾（以檔案開啟時是該檔所在資料夾），完成後刷新清單。

### 2.3 以檔案開啟（雙擊 .adb，作者 2026-11-08）

Windows 的檔案關聯、把 `.adb` 拖到 exe、或命令列直接給路徑，都會把完整路徑當第一個參數傳進來：

1. `main` 用 `splitLaunchArg` 從參數挑出第一個存在的 `.adb`（其他參數照舊給 `flag`；
   `-export` 這類「吃一個值」的旗標後面的路徑不會被搶走），記進 `AdbHost.launchAdb`。
2. `applyLaunch` 把工作目錄切到那個檔的資料夾（`os.Chdir`；失敗只記 log，仍用絕對路徑開）。
3. `ListAdbs` 依序：**啟動檔所在資料夾（啟動檔本身排第一）→ 宿主 adb 資料夾 → exe 資料夾**；
   同一路徑只列一次。`AdbDir` 回報啟動檔資料夾。
4. 前端 `bootDesktop` 先恢復上次開著的分頁，再把啟動檔開到最上面（active），狀態列顯示
   「已開啟 …（雙擊的檔案）」；📁 清單這次啟動預設照「資料夾」排
   （`dbPickSort = {k:'dir'}`，不寫回使用者的排序偏好）。
5. 只有出現兩個以上資料夾時，📁 清單才多一欄「資料夾」，並在**不同資料夾的第一列畫一條分界線**
   （照資料夾排時；換成 ID／日期等其他排序就沒有線，因為兩夾的書會交錯）。
6. `Open` 的白名單＝啟動檔資料夾＋宿主 adb 資料夾＋exe 資料夾（其他路徑仍拒絕）。
7. 更新既有 adb 時寫回**那個檔所在的資料夾**；新下載／Obsidian 轉出寫到目前工作用的資料夾。
8. About（點左上角 `accelon26`）多一列「.adb 檔案」：**只做一件事**——把 .adb 改指到現在
   這支 exe（寫 HKCU，不需要管理員）。現在的 exe 就是關聯的那支時，只顯示路徑、沒有按鈕；
   關聯到別的 exe 時出現一顆「改用這個 exe 開啟」；**完全沒有關聯、或關聯的 exe 已經不存在**
   （視同未設定）時按鈕加大高亮（「關連 adb」）。關連成功後彈出小視窗告知「以後雙擊 .adb 即可」。
   這是因為老客戶把 exe 複製到每個放 adb 的資料夾（工具書型 adb 分散各處），跑到哪一支就該由
   那一支開啟。
   Windows 10/11 的「預設應用程式」（UserChoice）擋住時，說明文字會提示去 Windows 設定改。
   診斷：`accelon26.exe -assoc` 印出關聯 JSON；`-assoc-set` 直接設定。

## 3. 更新

- `versions.json` 是版本真相。
- 主站／鏡像 base 由 `mirror.ts` 選擇。
- 下載 exe 走 Go，不經 WebView CORS。
- 官網 ZIP 與 exe 更新是兩條流程；`release.ts` 會一起產生。

## 4. 重要 Go 方法

| 方法 | 用途 |
|---|---|
| `ListAdbs` | 列 啟動檔資料夾／宿主 adb 資料夾／exe 資料夾 的 adb（依序、去重） |
| `LaunchAdb` | 這次啟動指定的 .adb（雙擊檔案；沒有就空字串） |
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
