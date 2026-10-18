# macOS 版（實驗，2026-10）

一句話：**能編、能跑**，但第一版沒有自動更新，也不靠游標決定開在哪張螢幕。

macOS 版與 Windows 版共用同一份 Go 程式與同一份單檔 HTML；差別只在
`wails/sys_*.go` 與 `wails/window_*.go` 這兩組平台檔（Windows 用 kernel32／Win32，
macOS 用 `syscall.Mmap`／`open`／`osascript`／Wails 的 NSScreen 表）。

## 怎麼拿到

1. GitHub → Actions → **build-macos** → Run workflow（或推 `mac-*` 標籤）。
2. 跑完在下載 artifact `accelon26-macos-arm64`（裡面的 zip 已含 ad-hoc 簽章）。
3. 解開 → `accelon26.app` → 拖進「應用程式」。
4. **第一次開啟要在 Finder 上按右鍵 →「打開」→ 再按一次「打開」。**
   這是 macOS 對「未經 Apple 公證的程式」的規定，不是檔案壞掉。

產出同時附 `accelon26-macos-arm64.zip.sha256`。

## 這一版有／沒有什麼

有：

* macOS 11 以上、Apple Silicon（arm64）。
* 介面與 Windows 版完全相同（單檔 HTML，`wails/assets/index.html`）。
* mmap 讀 `.adb`（`syscall.Mmap`）、Go 的查詢後端、bzip2 解壓（與 TS 逐字相同，測試會驗）。
* 視窗位置／大小／全螢幕狀態會記住：`~/Library/Application Support/accelon26/window.json`。
* 「留言給作者」等外部連結用 `open` 開系統瀏覽器。
* 「＋ 加入 adb」用 WKWebView 的 NSOpenPanel（Wails v3 有實作），拖放檔案也可以。

沒有（第一版刻意不做，或平台限制）：

* **自動更新**：Windows 換的是一顆 `accelon26.exe`；macOS 要換整個 `.app`，還牽涉簽章與
  公證。Go 層 `updatesSupported()` 在 darwin 回 `false`，完全**不連網**，About 會顯示
  「macOS 版暫不支援自動更新，請到官網下載新版」，按鈕改成開官網。
* **用游標決定啟動螢幕**：取滑鼠座標要碰 `NSEvent`／`CGEvent`（cgo）。改成問「視窗自己
  落在哪張螢幕」——macOS 開新視窗時會放在使用者正在用的那張，這其實也夠準。
* `-screens` 沒有 Win32 的樣式欄位（macOS 沒有 `GWL_STYLE`），只印 Wails 的螢幕表。
* 「工作目錄裡的 `.adb`」在 macOS 上幾乎永遠是空的：從 Finder 開的 app，工作目錄是 `/`。
  用「＋ 加入 adb」或把檔案拖進視窗就好（這條路走瀏覽器的 File API，不經 Go 的 mmap）。

## 自己建（不用 CI）

需要 Xcode Command Line Tools（`xcode-select --install`）。

```bash
cd ts && bun install && bun run tools/build-desktop.ts   # 產生 wails/assets/index.html
cd ../wails
CGO_ENABLED=1 go build -trimpath -o ../build/macos/accelon26 .
```

`.app` 的外殼（Info.plist、icns、ad-hoc 簽章、ditto 壓縮）看
`.github/workflows/build-macos.yml` 的後半段，照抄即可。

## Intel（x86_64）版

第一版只出 arm64。要 Intel 版，兩個辦法：

* 多一個 job：`runs-on: macos-13`（Intel runner）。
* 或在 arm64 runner 上交叉編譯（Apple clang 可以產生 x86_64）：

  ```bash
  GOARCH=amd64 CGO_ENABLED=1 CC="clang -arch x86_64" go build -o ../build/macos/accelon26-amd64 .
  ```

## 以後可以加

1. 自動更新（下載 `.zip`、解開換掉 `.app`、重啟）——需要先有穩定的簽章。
2. 公證（Apple Developer 帳號，每年 US$99）：公證過的 `.app` 第一次開不用右鍵。
3. 檔案關聯（`CFBundleDocumentTypes`，雙擊 `.adb` 直接開）。
4. 游標選螢幕（一支 cgo 的 `CGEventGetLocation`，`#cgo LDFLAGS: -framework ApplicationServices`）。
