# 部署與線上更新（accelon26）

> 這份文件講兩件事：**怎麼把 exe／網站放上 `https://shutonggui.cn/accelon26/`**，以及
> **使用者的 accelon26.exe 怎麼判斷、下載、換檔、失敗時怎麼辦**。
> 程式在 `wails/update.go`（Go）、`ts/src/accelon26/update-ui.ts`（UI）、
> `ts/src/accelon26/about.ts`（檢查結果的文字）、`ts/tools/release.ts`（發佈）、
> `ts/tools/deploy.ts`（上傳）。

## 1. 主機（2026-10-18 實測）

| 項目 | 值 |
|---|---|
| 作業系統 | Ubuntu 24.04 LTS（kernel 6.8），騰訊雲主機 |
| Web 伺服器 | Apache 2.4.58，只有一個 default vhost，`DocumentRoot=/var/www/html` |
| 這個資料夾 | `/var/www/html/accelon26`（`https://shutonggui.cn/accelon26/`） |
| 擁有者 | `yap:yap`、權限 `drwxrwxr-x` → **用 `yap` 登入就能直接寫，不需要 sudo** |
| sudo | `sudo -n` 不可用（要密碼）；目前部署不需要它 |
| 憑證 | `.local/server.env`（帳密，已在 `.gitignore`）＋ `.local/hostkey.txt`（主機金鑰指紋） |
| 連線工具 | `C:\Program Files\PuTTY\plink.exe`／`pscp.exe`（帳密登入）；`ssh-keyscan`／`ssh-keygen` 來自 Git |
| 其他 | 有 `rsync`、`sha256sum`、`curl`；HTTPS 與 HSTS 已經開好 |

`.local/` 裡的東西**永遠不進版控**，也不要把內容貼進對話。

### 資料夾應該長這樣

```
/var/www/html/accelon26/
  index.html            ← 官網首頁（www/index.html）
  accelon26.exe         ← 更新器抓的就是這支（唯一）
  versions.json         ← 版本真相：buildTime ＋ sha256 ＋ size
  accelon26.7z          ← 網站下載用的壓縮檔（裡面只有同一顆 exe）
  accelon26.exe.prev    ← 上一版 exe（deploy 自動留，伺服器端回滾用）
  versions.json.prev    ← 上一版版本資訊
  img/…                 ← 首頁圖片
```

使用者電腦上則是 `accelon26.exe` ＋（更新後暫時存在的）`accelon26-prev.exe`
—— 那是**上一版**，可以直接雙擊（見第 4 節）。

**不要**讓 exe 與 versions.json 分開上傳、也不要用網頁後台「直接覆蓋」——
`deploy.ts` 是先傳 `.tmp` 再 `mv`（同一個檔案系統，原子替換），所以任何時刻
讀者抓到的都是完整的一份。

## 2. 兩種節奏：平常改 UI，作者說「發佈新版」才發佈

### 2.1 平常（預設走這條）

改介面、文字、顏色時**只產生單檔 HTML**，不要重建 exe 或 macOS 的 `.app`
（作者 2026-10-18：那很費時間，而且會讓所有使用者跳一次沒有意義的更新提示）。

```powershell
cd ts
bun run tools/build-viewer.ts     # → build/accelon26.html（雙擊就能開，選 .adb 看效果）
bun test test/render.test.ts      # 22 項版面／渲染測試
```

改動本身記在 [wails/release_notes.draft.txt](wails/release_notes.draft.txt)：一行一條，
寫「使用者感覺到什麼」。這份草稿就是下一版的改版說明來源 —— 使用者更新時看到的內容。

`wails/assets/index.html`（exe 內嵌的那份）與 `www/accelon26.7z`、`versions.json`
**平常不用動**，發佈時 `release.ts` 會一起重建。

### 2.2 發佈（只在他說「發佈新版」時）

```powershell
cd ts
bun run tools/release.ts --items-file ../wails/release_notes.draft.txt
#   → 建 HTML → 建 exe（注入 buildTime）→ 追加改版說明 → versions.json → www/accelon26.7z
bun run tools/deploy.ts --site    # exe、versions.json、www/*.html、www/img/、7z，最後驗 sha256

bun run tools/deploy.ts           # 只換 exe ＋ versions.json（網站內容沒變時）
bun run tools/deploy.ts --site-only   # 只換 www/（改了首頁但不想發新版）
bun run tools/pack-7z.ts          # 只重打包壓縮檔（改 README、不動 exe）
```

發完把 `wails/release_notes.draft.txt` 裡那幾行清掉（檔頭留著）、連同新的
`release_notes.json` 一起 commit。

**macOS 版**跟著同一次發佈出：推一個 `mac-*` 標籤（見 [MACOS.md](MACOS.md)），
CI 會建 arm64／x86_64 兩個 zip 並附到 Release，之後
`cd ts && bun run tools/deploy-macos.ts` 把它們傳上官網。

壓縮檔內容固定三樣：`accelon26.exe`、`README.txt`（簡體）、`README-tc.txt`（繁體）。
兩份說明是 **UTF-8 帶 BOM ＋ CRLF**（Windows 記事本才不會亂碼），文字在
[ts/tools/readme-text.ts](ts/tools/readme-text.ts)，`release.ts` 與 `pack-7z.ts` 共用。
壓縮檔裡的 exe 與 `versions.json` 的 sha256 相同 —— 下載安裝與自動更新是同一顆。

`release.ts` 會拒絕「建置時間不是來自 `-ldflags`」的 exe（那種 exe 複製到別台機器
建置時間就變了，線上比不出新舊）。

`deploy.ts` 做的事：

1. 比對本地 exe 與 `versions.json` 的 `size`／`sha256`，不一致就停（避免上傳錯的組合）。
2. 上傳 `accelon26.exe.tmp` → 遠端 `mv` 成 `accelon26.exe`（舊的存成 `.prev`）。
3. 上傳 `versions.json.tmp` → 遠端 `mv` 成 `versions.json`（舊的存成 `.prev`）。
4. 從 `https://shutonggui.cn/accelon26/` 抓回 `versions.json` 與整顆 exe，重算 sha256
   對照；不一致就以非 0 結束。

手動檢查（不開 GUI）：

```powershell
D:\accelon26\accelon26.exe -version        # 建置時間、說明筆數、更新網址、versions.json 網址
D:\accelon26\accelon26.exe -check-update   # 真的連一次網，印出 JSON（updateAvailable／checkOK／note）
```

## 3. 使用者的程式怎麼判斷

1. 啟動時（以及每 6 小時）背景檢查一次：
   `GET https://shutonggui.cn/accelon26/versions.json`（`Cache-Control: no-cache`）。
2. `buildTime` 比目前這顆 exe 晚 **60 秒以上**才算有新版本（容忍時鐘誤差）。
3. 沒有 `versions.json`（舊主機）才退回 `HEAD accelon26.exe` 的 `Last-Modified`。
   **這是 fallback，不是主要依據** —— 伺服器的 `Last-Modified` 是上傳時間，跟 exe 裡的
   建置時間不一定一致（本次實測差了 11 秒；若上傳慢一點就會變成「更新完又說有新版」）。
4. 有新版本：左上角 `accelon26` 閃動、hover 顯示「有新版本：線上 … — 點這裡更新」；
   點下去開「關於」，按「下載更新」→ `confirm` → 下載。
5. **不檢查更新的兩種情況**（不打擾使用者）：exe 所在資料夾不可寫；本機建置時間距現在
   不到 2 小時（開發者自己的 exe）。`-check-update` 會強制檢查，供發布前驗線。

## 4. 下載之後：五道關卡（任何一道不過都不換檔）

| # | 檢查 | 不過的話 |
|---|---|---|
| 1 | `size` 與 `versions.json` 相同 | 丟掉下載檔，回報「下載大小不符」 |
| 2 | `sha256` 與 `versions.json` 相同 | 丟掉，回報「sha256 不符」 |
| 3 | 檔頭是 `MZ` 且 ≥ 1 MiB | 丟掉（擋錯誤頁） |
| 4 | 跑一次 `new.exe -version`，可解析出建置時間 | 丟掉，回報「驗證失敗」 |
| 5 | 那個建置時間比目前新 | 丟掉（擋「伺服器給了舊檔」） |

換檔方式（Windows 允許改執行中映像的名字，但不能覆蓋）：

```
accelon26.exe  （執行中）→ 改名 accelon26-prev.exe      ← 上一版，可以直接雙擊
accelon26.exe.new        → 改名 accelon26.exe
舊行程啟動 accelon26-prev.exe -relaunch-pid <自己> -relaunch-exe <新 exe> -relaunch-from <舊建置時間>
0.7 秒後舊行程結束
```

**為什麼要中間那一支（重新啟動器）**：新舊兩個行程不能同時用同一個 WebView2 使用者資料
目錄 —— 實測第二個行程會拿到 `8007139f` 直接開不起來。所以舊行程**立刻**結束，由 prev 這支
小程式等它真的結束（含 0.4 秒緩衝）再去開新版；這一支不開視窗、不碰 WebView2。

重新啟動器觀察新版 4 秒：新版若馬上結束（非 0），把 `accelon26-prev.exe` 改名回
`accelon26.exe`、跳一個訊息框、再把上一版開起來。新版跑得起來，`accelon26-prev.exe`
會在 6 秒後（以及正常關閉時）刪掉；刪不掉（重新啟動器還握著檔案）就留到下一次關閉。

新行程照 `-updated-from` 從內嵌的 `wails/release_notes.json` 挑出「比舊版新」的說明，
顯示 `#notesBox`；如果發佈時忘了加說明，也會顯示「已更新到 …」而不是靜悄悄。

## 5. 出事怎麼辦

- **新版起不來（使用者回報）**：程式會自動回滾並跳訊息框；萬一回滾沒成功，exe 旁邊的
  `accelon26-prev.exe` 可以直接雙擊，回到上一版（閱讀偏好等設定留在原處）。
- **線上這一版壞了（要退回上一版）**：

  ```bash
  ssh yap@shutonggui.cn
  cd /var/www/html/accelon26
  mv -f accelon26.exe.prev accelon26.exe
  mv -f versions.json.prev versions.json
  ```

  退版**不會**讓已經更新的使用者降版（他們的建置時間比線上還新）——這是刻意的：
  自動降版比留著新版更危險。真的必須降，就發一版新的（把修正併進去）。
- **網站首頁壞了**：`www/` 在 git 裡，`git checkout -- www` 後重跑 `deploy.ts --site`。
- **金鑰變了**（主機換過）：`deploy.ts` 會失敗；確認新指紋後刪掉 `.local/hostkey.txt`
  再跑一次（它會重新記錄）。

## 6. 留言給作者（表單後端，2026-10-18）

官網與軟件「關於」都有一個「留言給作者」，開 `https://shutonggui.cn/accelon26/message.html`。
留言**直接寄到 3820618924@qq.com**（使用者不必有自己的郵件程式）。

| 檔案 | 角色 |
|---|---|
| `www/message.html` | 表單頁（類型／稱呼／Email／微信／開始使用年份／內容） |
| `www/message.cgi` | 後端：Python 3 CGI，用 QQ 的 SMTP 寄信（標準庫，無第三方依賴） |
| `deploy/apache-accelon26-message.conf` | 只給 `/accelon26/` 開 `ExecCGI`（`a2enconf` 一個檔，可 `a2disconf` 還原） |
| `ts/tools/install-message-backend.ts` | 安裝／移除／測試（會用 sudo：裝 CGI、設定檔、`.local/smtp.json`） |

```
# 一次裝好（含寄一則測試留言）
cd ts && bun run tools/install-message-backend.ts --test
# 只檢查後端活著
curl -sS https://shutonggui.cn/accelon26/message.cgi      # → {"ready": true}
# 移除（留言頁會自動退回「用你的郵件程式寄」）
cd ts && bun run tools/install-message-backend.ts --uninstall
```

伺服器上的東西：

| 路徑 | 內容 |
|---|---|
| `/etc/accelon26-message/smtp.json` | SMTP 設定（`root:www-data 640`），來源是 `.local/smtp.json`（**不進版控**） |
| `/var/lib/accelon26-message/messages.jsonl` | 每一則留言的備份（寄信失敗也留著） |
| `/var/lib/accelon26-message/rate/` | 每個 IP 的送出時間（限流） |
| `${DOCROOT}/message.cgi` | 後端本體（`www-data 755`） |

行為：

* `POST` JSON → 驗長度 → honeypot（`website` 欄位必須空）→ 每 IP 每小時 5 則 → 記備份 → 寄信。
* 成功的回 `{"ok":true}`；資料問題回 4xx（頁面顯示訊息，不寄）；寄信失敗回 5xx（頁面**退回
  郵件程式**並提示，留言不會丟掉）。
* 「類型」只認 `回報錯誤`／`功能要求`／`改良建議`，其他值當作沒填。
* 換收件地址或授權碼：改 `.local/smtp.json` 後重跑 `install-message-backend.ts`。

> 授權碼是 QQ 信箱「設定 → 帳號 → POP3/SMTP 服務」產生的 16 位字串，**不是登入密碼**。
> 沒有後端時（例如新機器還沒裝），表單一樣可用：會用使用者自己的郵件程式寄到同一個信箱。

## 7. 還沒做的（刻意留著）

- **Authenticode 簽章**：現在只驗 sha256，擋得住截斷／錯檔／中間被換，擋不住「主機被
  入侵」。要擋那個得買憑證並在 `release.ts` 裡簽名。
- **下載進度**：UI 只有「正在下載新版本…」一行字；16 MB 在一般網路約幾秒，暫時夠用。
- **目錄不可寫時的手動下載**：現在只顯示原因（「程式所在資料夾不可寫」），官網在那裡
  可以直接下載。
- **觀察窗只有 4 秒**：新版「起來 5 秒後才崩」抓不到（前五道關卡已經擋掉絕大多數情況）。
- **autoindex**：`index.html` 放上去之後目錄列表就不會出現；真要 `Options -Indexes` 得改
  `apache2.conf`（`AllowOverride None`，`.htaccess` 無效），那會動到整台伺服器的設定。
