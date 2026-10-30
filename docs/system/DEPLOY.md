# 部署與線上更新（accelon26）

> 這份文件講兩件事：**怎麼把 exe／網站放上主站 `https://shutonggui.cn/accelon26/` 與
> 鏡像 `https://nissaya.cn/accelon26/`**，以及
> **使用者的 accelon26.exe 怎麼判斷、下載、換檔、失敗時怎麼辦**。
> 程式在 `wails/update.go`（Go）、`ts/src/accelon26/update-ui.ts`（UI）、
> `ts/src/accelon26/about.ts`（檢查結果的文字）、`ts/tools/release.ts`（發佈）、
> `ts/tools/deploy.ts`（上傳）。

## 0. 本機成品位置（2026-10-30）

`D:\accelon3` 是**本機書庫**，成品都放在那裡（`AGENTS.md` §1）：

| 檔案 | 從哪裡來 |
|---|---|
| `D:\accelon3\accelon26.exe` | `build\adbupd\accelon26.exe`（`go build` 之後 copy） |
| `D:\accelon3\accelon26.html` | `build\accelon26.html`（`build-viewer.ts` 之後 copy） |
| `D:\accelon3\*.adb` | `build\` 等建置產物，copy 過去 |

`build/` 只放建置中間檔與可重建的輸出。桌面版開機用 `ListAdbs` 列「工作目錄」與
「exe 所在資料夾」的 `*.adb`（不遞迴），所以 adb 放在 `D:\accelon3` 才找得到；
網頁版（file://）沒有資料夾掃描，使用者要自己選檔。

把檔案 copy 進去是**本地部署**，不算官網發佈；官網上線仍照 §2（只有使用者說「發佈」才做）。

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
  adb/…                 ← 公開數據庫：index.html／index.txt／manifest.json＋.adb 本體
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

改動本身記在 [wails/release_notes.draft.txt](../../wails/release_notes.draft.txt)：一行一條，
寫「使用者感覺到什麼」。這份草稿就是下一版的改版說明來源 —— 使用者更新時看到的內容。

`wails/assets/index.html`（exe 內嵌的那份）與 `www/accelon26.7z`、`versions.json`
**平常不用動**，發佈時 `release.ts` 會一起重建。

### 2.2 發佈（只在他說「發佈新版」時）

```powershell
cd ts
bun run tools/release.ts --items-file ../wails/release_notes.draft.txt
#   → 建 HTML → 建 exe（注入 buildTime）→ 追加改版說明 → versions.json → www/accelon26.7z
bun run tools/deploy.ts --site    # exe、versions.json、www/*.html、www/img/、7z → 主站＋鏡像，最後各站驗 sha256

bun run tools/deploy.ts           # 只換 exe ＋ versions.json（網站內容沒變時）
bun run tools/deploy.ts --site-only   # 只換 www/（改了首頁但不想發新版）
bun run tools/pack-7z.ts          # 只重打包壓縮檔（改 README、不動 exe）
```

發完把 `wails/release_notes.draft.txt` 裡那幾行清掉（檔頭留著）、連同新的
`release_notes.json` 一起 commit。

**macOS 版**跟著同一次發佈出：推一個 `mac-*` 標籤（見 [MACOS.md](./MACOS.md)），
CI 會建 arm64／x86_64 兩個 zip 並附到 Release，之後
`cd ts && bun run tools/deploy-macos.ts` 把它們傳上官網。

壓縮檔內容固定三樣：`accelon26.exe`、`README.txt`（簡體）、`README-tc.txt`（繁體）。
兩份說明是 **UTF-8 帶 BOM ＋ CRLF**（Windows 記事本才不會亂碼；編碼規則見 [yap-software-practice.md](./yap-software-practice.md) §4.1），文字在
[ts/tools/readme-text.ts](../../ts/tools/readme-text.ts)，`release.ts` 與 `pack-7z.ts` 共用。
壓縮檔裡的 exe 與 `versions.json` 的 sha256 相同 —— 下載安裝與自動更新是同一顆。

`release.ts` 會拒絕「建置時間不是來自 `-ldflags`」的 exe（那種 exe 複製到別台機器
建置時間就變了，線上比不出新舊）。

`deploy.ts` 做的事：

1. 比對本地 exe 與 `versions.json` 的 `size`／`sha256`，不一致就停（避免上傳錯的組合）。
2. 上傳 `accelon26.exe.tmp` → 遠端 `mv` 成 `accelon26.exe`（舊的存成 `.prev`）。
3. 上傳 `versions.json.tmp` → 遠端 `mv` 成 `versions.json`（舊的存成 `.prev`）。
4. 從 `https://shutonggui.cn/accelon26/` 抓回 `versions.json` 與整顆 exe，重算 sha256
   對照；不一致就以非 0 結束。

手動檢查（不開 GUI，在 `accelon3\` 目錄）：

```powershell
cd accelon3
.\accelon26.exe -version        # 建置時間、說明筆數、更新網址、versions.json 網址
.\accelon26.exe -check-update   # 真的連一次網，印出 JSON（updateAvailable／checkOK／note）
.\accelon26.exe -export 13j.adb # 導出文字與圖片（與「進階 → 容量 → 導出」同一條路），印出 JSON
```

### 2.3 一天多個修正：release candidate（作者 2026-10-27 指定；2026-10-30 更新）

一天內可能修好幾個 bug，**不要為每個修正另開日期版號**；每修好一批就出一個 RC：

* 版號：`2026-10-30 RC1`、`RC2`…（同一天往上編）。
* `release.ts` 現在**只認日期**（`--title` 會被忽略）：同一天重發會合併成一筆、
  覆蓋當天的 zip（`www/releases/accelon26-YYYY-MM-DD.zip`），不保留 RC 檔。
* 要讓官網顯示 RC 標籤：發佈後把 `wails/release_notes.json` 當天那一筆的 `title`
  改成 `accelon26 2026-10-30 RC1`，再跑 `bun run tools/deploy.ts --site`
  （會重生 `www/changelog.html`；`make-changelog.ts` 只在 title 與預設日期字串不同時才顯示它）。
* 說明第一行也寫「今日 RC1（日期）」，changelog 一眼就看得到。
* `release_notes.json` **同一天只保留一個條目**（`release.ts` 會合併），不要把 RC1、RC2…
  留成一串；使用者更新後看到的永遠是最新一份。
* 每個 RC 都上線（`versions.json` 的 buildTime 遞增），使用者才會收到線上更新；當天最後
  一個 RC 就是當天的正式版（標題保留 `RCn` 沒關係，下一個正式版再改）。
* 實例：2026-10-30 RC1 → buildTime `2026-10-30T02:06:08Z`、標題
  「accelon26 2026-10-30 RC1」、sha256 `4916ae0a7a1c…`。

## 清 build/（會長到幾 GB）

`build/` 是產出物＋探針的暫存：Chrome/Edge 的 profile、一次性的比較輸出、bench 語料、
adb 複本、`tmp-*-state` …很容易累積到幾個 GB（2026-10-18 清過一次：5,121 MB → 56 MB）。

```powershell
cd ts
bun run clean                       # 只留產物（accelon26.html、build/macos）＋截圖、pas/、tmp-*.ts
bun run clean --all                 # 除了產物全刪（截圖也刪）
bun run clean --dry-run             # 先看會刪什麼
```

## 3. 使用者的程式怎麼判斷

1. 啟動時（以及每 6 小時）背景檢查一次：
   `GET <更新站>/accelon26/versions.json`（`Cache-Control: no-cache`）。更新站預設主站
   `https://shutonggui.cn/accelon26/`，使用者可切到鏡像 `https://nissaya.cn/accelon26/`
   （見 §7.2）；目前這一站連不上時會自動退回另一站。
2. `buildTime` 比目前這顆 exe 晚 **60 秒以上**才算有新版本（容忍時鐘誤差）。
3. 沒有 `versions.json`（舊主機）才退回 `HEAD accelon26.exe` 的 `Last-Modified`。
   **這是 fallback，不是主要依據** —— 伺服器的 `Last-Modified` 是上傳時間，跟 exe 裡的
   建置時間不一定一致（本次實測差了 11 秒；若上傳慢一點就會變成「更新完又說有新版」）。
4. 有新版本：左上角 `accelon26` 閃動、hover 顯示「有新版本：線上 … — 點這裡更新」；
   點下去開「關於」，按「下載更新」→ `confirm` → 下載。
5. **不檢查更新的兩種情況**（不打擾使用者）：exe 所在資料夾不可寫（本專案目前的選擇；通用建議是仍檢查、只停用自動換檔，見指南 §5.7）；本機建置時間距現在
   不到 2 小時（開發者自己的 exe）。`-check-update` 會強制檢查，供發布前驗線。

## 4. 下載之後：五道關卡（任何一道不過都不換檔）

> 通用的換檔／WebView2 獨佔／helper 設計見 [wails3-pitfalls.md](./wails3-pitfalls.md) §5.2–§5.3；以下只記本專案的檔名、順序與時間。

| # | 檢查 | 不過的話 |
|---|---|---|
| 1 | `size` 與 `versions.json` 相同 | 丟掉下載檔，回報「下載大小不符」 |
| 2 | `sha256` 與 `versions.json` 相同 | 丟掉，回報「sha256 不符」 |
| 3 | 檔頭是 `MZ` 且 ≥ 1 MiB | 丟掉（擋錯誤頁） |
| 4 | 跑一次 `new.exe -version`，可解析出建置時間 | 丟掉，回報「驗證失敗」 |
| 5 | 那個建置時間比目前新 | 丟掉（擋「伺服器給了舊檔」） |

> 本專案未簽章，所以是五道；若加上簽章，驗簽要排在執行 `-version` 之前（指南 §5.5）。

換檔方式（Windows 允許改執行中映像的名字，但不能覆蓋）：

```
accelon26.exe  （執行中）→ 改名 accelon26-prev.exe      ← 上一版，可以直接雙擊
accelon26.exe.new        → 改名 accelon26.exe
舊行程啟動 accelon26-prev.exe -relaunch-pid <自己> -relaunch-exe <新 exe> -relaunch-from <舊建置時間>
0.7 秒後舊行程結束
```

**為什麼要中間那一支（重新啟動器）**：新舊行程不能同時用同一個 WebView2 使用者資料目錄（`8007139f`）；通用坑與 helper 設計見指南 §5.3。本專案的時序：舊行程**立刻**結束，由 prev 這支小程式等它真的結束（含 0.4 秒緩衝）再去開新版；這一支不開視窗、不碰 WebView2。

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
* 版本：桌面版／軟件內的「留言給作者」會帶 `build`、`buildText`；官網直接留言則由頁面抓
  `versions.json` 的 `buildTime`，後端再以同一個檔補一次，主旨、信件內文與 `messages.jsonl` 都會有版本。
* 發信人：有填 Email 時 `From` 用留言者的 email、`Reply-To` 也是留言者；SMTP 認證信箱放
  `Sender`（envelope sender 仍是 QQ 信箱）。沒填 Email 才用作者的 QQ 信箱當 From。
* 換收件地址或授權碼：改 `.local/smtp.json` 後重跑 `install-message-backend.ts`。

> 授權碼是 QQ 信箱「設定 → 帳號 → POP3/SMTP 服務」產生的 16 位字串，**不是登入密碼**。
> 沒有後端時（例如新機器還沒裝），表單一樣可用：會用使用者自己的郵件程式寄到同一個信箱。

## 7. 公開數據庫頁面（2026-10-18）

官網最下面（nav 最後一項與頁尾）連到 <https://shutonggui.cn/accelon26/adb/index.html>。

清單的真相在伺服器 `${DOCROOT}/adb/index.txt`：一行一個 `.adb` 檔名，`#` 開頭是註解；
**同一個目錄**就是公開的 `.adb` 本體（作者自己放上去的）。作者要加新資料庫時只改
`index.txt`，然後說一聲，我重跑一次產生器就好。

```powershell
cd ts && bun run tools/make-adb-index.ts        # 讀 index.txt → 寫 www/adb/index.txt ＋ index.html
cd ts && bun run tools/deploy.ts --site-only    # 連 www/adb/ 一起上傳，並從線上 HEAD 驗一次
```

產生器做的事（[ts/tools/make-adb-index.ts](../../ts/tools/make-adb-index.ts)）：

* 讀清單（預設抓線上 `index.txt`，也可 `--index <檔案>`）。
* **不上傳、不下載 adb**：到本機 `D:\accelon3` 找同名檔（`--adb-dir` 可改），同名取最淺層那份。
* 取四樣：中文名（檔頭 `dbcname`）、字數（解壓 source 區塊的字元數，跟程式裡「字數」同一算法）、
  建置日期（檔案時間 —— adb 檔頭沒有日期欄位）、檔案大小。
* 產出 `www/adb/index.html`（版面直接沿用 `www/index.html` 的 `<style>` 與頁首頁尾，官網改樣式
  時這頁會跟著改）與 `index.txt`（清單存檔）。

`deploy.ts --site`／`--site-only` 會把 `www/adb/*.html`、`*.txt`、`*.json` 一起傳上去（不會傳 `.adb`）。

`.adb` 本體用另一支同步兩站（只上傳 sha256 不同的檔，上傳後再算一次線上 sha256）：

```powershell
cd ts && bun run tools/publish-adb.ts                # index.txt 裡的全部 adb → 兩站
cd ts && bun run tools/publish-adb.ts --mirror-only  # 只補鏡像
cd ts && bun run tools/publish-adb.ts --files ys.adb
```

### 7.1 程式裡的「資料庫更新」（2026-10-29）

公開的 adb 換版時，桌面版要主動告訴讀者；**adb 和 exe 一樣有版本記錄**：
每一次建置都記 buildTime／sha256／size／改版說明，使用者看得到「從我這一版到最新版
之間每一次改變」，要不要更新由使用者按「更新」決定。

清單是 `${DOCROOT}/adb/manifest.json`（schema 2）：

```json
{ "schema": 2, "generated": "…", "dbs": [
  { "file": "ys.adb", "name": "印順法師佛學著作集", "size": 26541652,
    "sha256": "…", "buildTime": "2026-10-28T14:29:24Z", "notes": ["這一版改了什麼", "…"],
    "history": [
      { "buildTime": "2026-10-28T14:29:24Z", "sha256": "…", "size": 26541652, "notes": ["…"] },
      { "buildTime": "2026-10-27T…", "sha256": "…", "size": 26400000, "notes": ["上一版改了什麼"] }
    ], "doc": "ys.html" }
] }
```

* 產生：`cd ts && bun run tools/make-adb-manifest.ts`（讀 `www/adb/index.txt`、
  `deploy/adb-notes.json`、`deploy/adb-history.json`，到 `D:\accelon3` 取大小／
  sha256／buildTime／庫名）。
* **版本歷史**存在 `deploy/adb-history.json`（由新到舊；第一次跑會從舊 manifest 遷移）。
  同一個 sha256＝同一版；重建出不同內容就是新的一版。
* 清單＝`www/adb/index.txt`（公開頁面）＋`deploy/adb-extra.txt`（不列頁面但要納入更新的
  大檔，例如 taisho/wxzj）。App 只比對使用者資料夾裡實際有的檔。
* **新版本一定要有說明**：把新檔的 sha256 與 notes 寫進 `deploy/adb-notes.json`；沒有
  說明時產生器會失敗（`--allow-empty-notes` 只能緊急用）。使用者才不會「更新了卻
  不知道改了什麼」。
* 程式（`ts/src/accelon26/adb-update.ts` ＋ `wails/adbupdate.go`）開機時抓 manifest。
  `#dbTabs` 平常就有「資料庫版本」按鈕（有安裝公開資料庫時），sha256 不同時加上
  紅色的 **New**。對話盒有「可更新」與「版本記錄」兩個頁籤；「可更新」列出**本機版本之後的每一版**（跳過幾版也看得到每一次改變），
  「版本記錄」列出每一本已安裝公開資料庫的完整歷史。
* 下載走 Go：先寫同目錄 `.accelon26-*.tmp`，邊下邊算 sha256，**放棄或驗證失敗只刪
  暫存檔**；全部驗過才解除 mmap 並 `rename` 原子替換。進度用輪詢
  （`AdbDownloadStatus`），放棄用 `CancelAdbDownload`。
* 測試：`cd ts && bun run tools/adb-update-test.ts`（本機假官網：多版本歷史、跳版
  說明、版本記錄頁、New → 進度 → 放棄 → 原檔不變 → 再更新成功）。
  Go 端另有 `wails/adbupdate_test.go`。

### 7.2 更新鏡像：程式與 adb 都讓使用者選（2026-10-29）

| 站 | 位置 | 說明 |
|---|---|---|
| 大陸主站 | `https://shutonggui.cn/accelon26/` | 預設；大陸使用者一般只連得到這裡 |
| 境外鏡像 | `https://nissaya.cn/accelon26/` | 海外較快；大陸一般連不到 |

* 設定頁「更新 → 鏡像站」：**自動（依連線速度）／大陸主站／境外鏡像**；存在
  settings.json 頂層 `updateMirror`（`auto`／`primary`／`overseas`）。
* 自動：Go 對兩站的 `versions.json` 發 HEAD（2 秒上限），鏡像要明顯較快才切；
  只有鏡像連得上也切；兩站都不通留在主站。不是把 IP 送第三方，而是用「連不連得到
  nissaya.cn」判斷國內外。
* 選好後呼叫 `SetUpdateMirror()`：**exe 更新（versions.json／exe）與 adb
  manifest 都從同一站**；檢查失敗會退回另一站（`AppInfo.mirrorUsed／mirrorFallback`）。
* 發佈時 `deploy.ts` 預設同步兩站，並把鏡像的 `versions.json.url` 改寫成鏡像自己的
  exe；`publish-adb.ts` 同步 adb 本體；`deploy-macos.ts` 同步 macOS zip。
* 測試：`cd ts && bun run tools/mirror-test.ts`（見檔頭的 exe 建置指令）。

### 7.3 歷史版本與「一天一個 release」（2026-10-29）

* 每次發佈產生兩個一樣的 ZIP：
  * `www/accelon26.zip`：穩定檔名，首頁「下載 Windows 版」用。
  * `www/releases/accelon26-YYYY-MM-DD.zip`：**歷史版本**，用北京時間日期命名。
* **同一天最多一個 release**：同日重發會覆蓋當天那個 ZIP；`release_notes.json` 也會
  合併成當天唯一一筆（不再有 RC1／RC2 這種條目）。舊 ZIP 不會被刪。
* 官網「版本下載」頁（`releases.html`）由 `tools/make-releases.ts` 從
  `www/releases.json` 產生；清單有日期、建置時間、大小、sha256 與下載連結。
* `versions.json` 多了 `zip`／`zipSize`／`zipSha256`，首頁會把下載按鈕指到最新
  的日期 ZIP（抓不到時退回穩定的 `accelon26.zip`）。
* `deploy.ts --site` 會把 `releases/*.zip` 一起同步；已存在且大小相同的檔跳過，
  所以不會每次重新上傳所有歷史版本。
* 舊的 RC 說明可以用 `cd ts && bun run tools/release.ts --normalize` 一次合併成
  一天一筆（已於 2026-10-29 執行，10 天）。
* macOS 的 `.zip` 目前仍是固定檔名（`accelon26-macos-arm64.zip`／`x86_64`），
  還沒有做歷史版本；要的話可以照同一套日期命名再加。

### 7.4 公開資料庫的界線（2026-10-29）

* **<30 MB** 的 adb 可以經常更新；**>30 MB** 的底座仍可整檔下載，但只在 CBETA 換版等
  重大更新時才換版，且不列入桌面版的「全部更新」。伺服器每月流量只有 **1 TB**。
* `tools/publish-adb.ts` 對 >30 MB 的檔要求加 `--allow-large`；wip／revision 一律不上傳。
* `taisho.adb`、`wxzj.adb` 在 `deploy/adb-extra.txt` 裡，只納入 manifest 版本記錄
  （施工中 `status:wip`、`downloadable:false`）；官網「公開數據庫」顯示施工中，不給下載連結，
  兩站的 `adb/taisho.adb`、`adb/wxzj.adb` 已刪除（404）。整理完成後可改成 available，
  讓使用者整檔下載。
* `fgdict.adb` 作者要大修：已從 index／manifest 移除，兩站檔案刪除（404）。
* App 的 `adb-update.ts`：大型底座（>30 MB）照樣顯示「下載整檔」，但不列入「全部更新」；
  `downloadable:false` 才完全不出現下載按鈕。

## 8. 還沒做的（刻意留著）

- **Authenticode 簽章**：現在只驗 sha256，擋得住截斷／錯檔／中間被換，擋不住「主機被
  入侵」。要擋那個得買憑證並在 `release.ts` 裡簽名。
- **exe 更新的下載進度**：程式更新只有「正在下載新版本…」一行字；16 MB 在一般網路約幾秒，
  暫時夠用（**資料庫**更新已經有進度條與放棄，見 §7.1）。
- **目錄不可寫時的手動下載**：現在只顯示原因（「程式所在資料夾不可寫」），官網在那裡
  可以直接下載。
- **觀察窗只有 4 秒**：新版「起來 5 秒後才崩」抓不到（前五道關卡已經擋掉絕大多數情況）。
- **autoindex**：`index.html` 放上去之後目錄列表就不會出現；真要 `Options -Indexes` 得改
  `apache2.conf`（`AllowOverride None`，`.htaccess` 無效），那會動到整台伺服器的設定。
