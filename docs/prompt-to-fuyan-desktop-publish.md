# 給 fuyan 線：發桌面版（Windows＋macOS）＋fuyan bug fix＋回 任玄

> 用法：整段貼給 `D:\2026\fuyan`（或負責桌面發佈的工作區）的 agent。母區（`D:\2026\adb-converter`）已把下列修復提交到 main，等桌面版由 fuyan 線自壓自發。

## 一、母區已提交、待這版桌面帶上的修復（依序）

- `4cae5b4` 厚觀法師 11-18 三處顯示 bug：① boxd 定寬包裝不再誤注進 inline SVG（HG03.338 註20／033 註19 圖後半丟失）② 反白科判條注號高反差（p.891 注127~130）③ 橫跨表頭 colspan 文字置中（p.1147~1150）。
- `6f4defd` 跨庫「開另一藏經文」：開 taisho 選段→右鍵「開高麗藏經文」在中間欄開對應《高麗藏》正文並標同段；開 goryeo 反之。對照表 `goryeo_taisho.adb` 未開會自動從資料夾載入（不建可見 db 頁籤）；**找不到對方 adb（如 goryeo.adb）時只給「看圖版」、不給「開經文」**。
- `acb2f64` `#editBtn` 編輯態視覺差異（原 CSS 換行被寫成字面 `` `n ``，`.editBtn.on` 整條被丟棄）。
- `ed411a4` **taisho 卷首「引用複製」缺頁碼**：選區落在第一個 `<頁>` 標記之前（譯者行／如是我聞那段）時，`pageIdAtVa` 回空 → 定位串變成 `taisho?#181-199` 少了 `1p1a`。現兜底取首頁 id，`$頁;`／`$URL;` 都補回頁碼。（任玄 2026-11-19 來信＋截圖。）

> `02f9595` 是官網 adb 清單改動（暫時隱藏佛光大辭典＋dbWarn 去重），屬**數據端**、不進 exe；發佈官網 adb 頁另說（見下）。

## 二、發桌面版（依母區 DEPLOY／AGENTS）

1. **先把這輪未提交的桌面源檔收乾淨再壓**：目前母區工作樹髒的 `ts/src/accelon26/xref.ts`、`doc-pane.ts`、`render_accelon3.ts`（chanyao↔chanyaoscan 掃描互鏈那批）與 `wails/release_notes.draft.txt` 是**你們線**的在制改動——由你們確認無誤後提交，別讓 release 從半套工作樹打包。
2. Windows：`cd ts && bun run tools/release.ts`（生成 exe＋versions.json＋zip）→ `bun run tools/deploy.ts --site --no-adb`（兩站 exe＋versions＋changelog/releases；`--no-adb` 不碰 adb 頁）。
3. macOS：推 `mac-<date>` 標籤 → Actions `build-macos` 從**已提交** commit 出 arm64／x86_64 → 從 Release 下載（objects 若限速用 `curl -C -` 續傳；残留 curl 佔檔會令 pscp「Cannot open file」，先殺程序）→ `bun run tools/deploy-macos.ts` 兩站驗 sha。
4. 上線後兩站各驗 `versions.json`／exe sha 一致。

## 三、fuyan bug fix

- 法師本輪來信（維摩經講義 5 題、法華經講義 2 題、中論講義、空之探究講義 6＋3 題等，見信箱）按既有紀律：外觀類逕改→驗畫面→發版→回信；書名/頁 id/內容取捨照法師要求。
- chanyao↔chanyaoscan：第 2–10 冊尚未掃描建庫（連結目前只到第一冊）；`check-cycles` 現為 65（比基準 64 多一條，來自這批 chanyao import），發佈前請確認那條新循環無害。

## 四、回 任玄（renxuanrenxuan@icloud.com，信箱 UID 326）

- 內容：taisho 卷首「引用複製」缺頁碼已修（選區在頁首時自動帶出第一冊第一頁頁碼），新版桌面已上線。
- **必附版本時間**：新 exe 的 Alt+A 建置時間＋buildTime UTC＋sha 前 12（HG05.058 因不附版本被退 N 次）。
- 收件/cc 一律從**來信 From 頭現場解析**，禁用工具輸出裡的脫敏佔位串（`gp***@` 之類，550 只缺副本、難察）。查 Sent 防雙回 → `--dry-run` → 實寄 → 再核 Sent＋退信匣。

## 五、官網 adb 頁（暫時隱藏佛光大辭典）——另行

- 母區已把 `fgdict.adb` 從 `www/adb/index.txt` 移除並重生 `index.html`（檔留伺服器、直接網址仍可下載，要還原把那行加回）。
- 但 `make-adb-manifest` 目前被 **`chanyao.adb` 新版（sha `d59962ad…`）無說明**合理攔下 → 官网 adb 頁發佈要等 chanyao 線補 `deploy/adb-notes.json` 說明後走 `deploy.ts --site-only`（不帶 `--no-adb`）；或先精準只傳 `www/adb/index.html`。
