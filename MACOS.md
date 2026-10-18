# macOS 版（實驗，2026-10）

一句話：**能編、能跑**，但第一版沒有自動更新，也不靠游標決定開在哪張螢幕。

macOS 版與 Windows 版共用同一份 Go 程式與同一份單檔 HTML；差別只在
`wails/sys_*.go` 與 `wails/window_*.go` 這兩組平台檔（Windows 用 kernel32／Win32，
macOS 用 `syscall.Mmap`／`open`／`osascript`／Wails 的 NSScreen 表）。

## 怎麼拿到

1. 官網 <https://shutonggui.cn/accelon26/> →「下載 macOS 版」（Apple Silicon）或「下載與安裝」
   裡的 Intel 版：
   * `accelon26-macos-arm64.zip`（M 系列）
   * `accelon26-macos-x86_64.zip`（Intel）
2. 解開 → `accelon26.app` → 拖進「應用程式」。
3. **第一次開啟要在 Finder 上按右鍵 →「打開」→ 再按一次「打開」。**
   這是 macOS 對「未經 Apple 公證的程式」的規定，不是檔案壞掉。

備用來源：GitHub → Actions → **build-macos** → Run workflow（或推 `mac-*` 標籤），跑完下載
artifact `accelon26-macos-arm64`／`accelon26-macos-x86_64`；推標籤時 zip 也會附到
[Release](https://github.com/accelon/adb-converter/releases)（不需要登入就能下載）。
三邊的檔案都是同一個 `wails/scripts/package-macos.sh` 包出來的，並附 `.sha256` 可以核對。

> CI 用到現在踩過的坑（留給以後的自己）：`*.adb` 在 `.gitignore`，所以倉庫裡沒有語料，
> `-selftest` 要自己造一個檔；`$VAR（全形括號）` 在 bash 會被當成變數名（`set -u` 直接
> unbound variable），一律寫 `${VAR}（`。

## 這一版有／沒有什麼

有：

* macOS 11 以上、Apple Silicon（arm64）與 Intel（x86_64）。
* 介面與 Windows 版完全相同（單檔 HTML，`wails/assets/index.html`）。
* mmap 讀 `.adb`（`syscall.Mmap`）、Go 的查詢後端、bzip2 解壓（與 TS 逐字相同，測試會驗）。
* **新版本提示**：照樣去讀 `versions.json`，線上比你的 `.app` 新就讓左上角閃、About 顯示
  「發現新版本」；只是下載要自己來（見下）。
* 視窗位置／大小／全螢幕狀態會記住：`~/Library/Application Support/accelon26/window.json`。
* 「留言給作者」等外部連結用 `open` 開系統瀏覽器。
* 「＋ 加入 adb」用 WKWebView 的 NSOpenPanel（Wails v3 有實作），拖放檔案也可以。

沒有（第一版刻意不做，或平台限制）：

* **不會自己換檔**：Windows 換的是一顆 `accelon26.exe`；macOS 要換整個 `.app`，還牽涉簽章
  與公證。所以 `updatesSupported()` 在 darwin 回 `false` —— 它只管「安裝」，不管「檢查」：
  版本檢查每個平台都做，`InstallUpdate` 則直接拒絕並回一句「請到官網下載」。
  About 的「下載更新」按鈕在 macOS 上就是開官網，使用者自己下載新的 `.app` 換掉舊的。
* **用游標決定啟動螢幕**：取滑鼠座標要碰 `NSEvent`／`CGEvent`（cgo）。改成問「視窗自己
  落在哪張螢幕」——macOS 開新視窗時會放在使用者正在用的那張，這其實也夠準。
* `-screens` 沒有 Win32 的樣式欄位（macOS 沒有 `GWL_STYLE`），只印 Wails 的螢幕表。
* 「工作目錄裡的 `.adb`」在 macOS 上幾乎永遠是空的：從 Finder 開的 app，工作目錄是 `/`。
  用「＋ 加入 adb」或把檔案拖進視窗就好（這條路走瀏覽器的 File API，不經 Go 的 mmap）。

## 自己建（作者平常走這條）

需要 Xcode Command Line Tools（`xcode-select --install`）。三行：建 HTML、編譯、打包。

```bash
cd ts && bun run tools/build-desktop.ts    # 產生 wails/assets/index.html（不需要 npm install）

cd ../wails
CGO_ENABLED=1 go build -tags production -trimpath \
  -ldflags "-X main.buildTime=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  -o ../build/macos/arm64/accelon26 .
bash scripts/package-macos.sh arm64          # → build/macos/accelon26-macos-arm64.zip
```

`-tags production` 是 Wails 的發佈模式（關掉 DevTools 選單與除錯日誌）；想看 DevTools 就去掉它
再建一次。

`scripts/package-macos.sh` 就是 CI 用的那一支（Info.plist、icns、ad-hoc 簽章、`ditto` 壓縮），
所以本機編的與 Actions 編的 `.app` 是同一個形狀。第一個參數是架構，第二個（可選）是指定
執行檔位置，例如 `bash scripts/package-macos.sh arm64 ../build/macos/accelon26`。

## 放上官網

```bash
cd ts && bun run tools/deploy-macos.ts        # 上傳 build/macos/*.zip，再從線上抓回來比 sha256
cd ts && bun run tools/deploy-macos.ts --check  # 只驗證，不上傳
```

Windows 這台要裝 PuTTY（`pscp`／`plink`）而且 `.local/server.env` 有帳密才會動；上傳一律先
`xxx.tmp` 再原子改名，所以下載的人不會抓到半個檔案。首頁的連結就是
`https://shutonggui.cn/accelon26/accelon26-macos-arm64.zip` 與 `…-x86_64.zip`
（`www/index.html` 的主視覺與「下載與安裝」都有）。

## Intel（x86_64）版

CI 已經順便做了（在 arm64 runner 上交叉編譯，Apple clang 可以產生 x86_64）。本機要自己編：

```bash
cd wails
GOARCH=amd64 CGO_ENABLED=1 CC="clang -arch x86_64" go build -tags production -trimpath \
  -ldflags "-X main.buildTime=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  -o ../build/macos/x86_64/accelon26 .
bash scripts/package-macos.sh x86_64          # → build/macos/accelon26-macos-x86_64.zip
```

（也可以在 Intel 的 Mac 上直接 `GOARCH=amd64` 不帶 `CC` 編譯。）

## 以後可以加

1. 自動更新（下載 `.zip`、解開換掉 `.app`、重啟）——需要先有穩定的簽章。
2. 公證（Apple Developer 帳號，每年 US$99）：公證過的 `.app` 第一次開不用右鍵。
3. 檔案關聯（`CFBundleDocumentTypes`，雙擊 `.adb` 直接開）。
4. 游標選螢幕（一支 cgo 的 `CGEventGetLocation`，`#cgo LDFLAGS: -framework ApplicationServices`）。
5. CI 直接把 zip 傳到官網（需要把 HOST／USER／PASS 放進 repo secrets，並在 runner 上裝 `sshpass`）。
