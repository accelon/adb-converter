# AGENTS.md — adb-converter 工作區規則

## 1. 這個工作區在做什麼

這裡主要是 **accelon26 閱讀器**（Web／Wails 桌面版）與**官網**（兩個鏡像站）的開發、
建置、測試與部署。

ADB 的發展初期也可能在這裡做（`jingqun/`、`lc/`、`build/` 的實驗資料與工具），
但 **adb 成熟、穩定後會移出這個工作區**，成為獨立專案，例如：

- `ys.adb`／`tx.adb` → `D:\2026\ys`（已移出，見該目錄的 `AGENTS.md`）

原則：

- 這個工作區只改 **accelon26** 與**官網管理**；已移出的 adb 專案不要在這裡改。
- 要改已移出的 adb，先確認使用者要回哪個工作區；不要跨區複製檔案。
- 還在這裡的 adb 實驗（例如 `jingqun`）可以改，但要知道它將來可能搬走。

## 2. 目前的重要狀態（2026-10-29）

- 官網公開數據庫只列 **5 個 <30 MB** 的庫：`13j`、`swjzz`、`tx`、`yulinpo`、`ys`。
- `taisho.adb`、`wxzj.adb`：**施工中**（`status:wip`、`downloadable:false`），
  官網與桌面版都不提供下載；兩站檔案已刪除（404）。
  **不要**在沒有使用者明確指示下把它們改成 available 或重新上傳。
- `fgdict.adb`：作者要大修，已下架（不在 index／manifest，兩站 404）。
- T56–T84 的文本與底本為 public domain；數位文字取自 SAT 2018，依其授權標注；
  TEI 標記按 CBETA convention 整理。詳見 `docs/adb/stable-adb.md`。
- 30 MB 是**更新頻率／批量更新**的分界，不是下載上限：
  - <30 MB：可經常更新。
  - >30 MB：仍可整檔下載，但只在 CBETA 換版等重大更新時換版，且不列入
    「全部更新」；App 顯示「下載整檔」。
- 伺服器每月只有 **1 TB** 流量；大檔要省著換。
- 正式 release 一天最多一個；同日重發覆蓋當天日期 ZIP，不保留 RC。
- 官網 exe 目前仍是已發佈版；不要假設本機 `build/` 的測試 exe 已上線。

## 3. 目錄地圖

| 路徑 | 內容 |
|---|---|
| `ts/` | accelon26 前端（Bun/TypeScript）、`tools/` 建置／部署／測試工具 |
| `wails/` | Wails 桌面宿主（Go）；`wails/assets/` 是內嵌前端 |
| `cmd/` | Go 工具（`tei2adb`、`abx` 等） |
| `www/` | 官網；`www/adb/` 是公開資料庫頁與 manifest |
| `deploy/` | 部署設定、adb 狀態／版本歷史、發布清單 |
| `docs/` | 軟件、adb、系統與交接文件 |
| `jingqun/`、`lc/` | 還在這裡的 adb 實驗／資料 |
| `build/` | 建置產物、暫存、測試；通常不進 git |
| `.local/` | 伺服器帳密、主機指紋、下載清單；**已在 gitignore，勿印出內容** |

外部資料（唯讀，除非使用者明確要求）：

- `D:\accelon3\`：本機 adb 書庫／部署位置；不要任意覆寫。
- `D:\2026\xml-p5\`：CBETA XML-P5 checkout。
- `D:\2023\sat2018\`：T56–T84 的 SAT 2018 來源。
- `D:\2026\ys\`：已移出的 ys／tx 專案。
- `D:\2026\wisdomlight\`：金剛經平行本（六漢譯＋梵本，`samples/jingang`）；不要重做，
  之後直接接它的 `works.tsv`／`anchor_map.tsv`。

## 4. 常用指令

```powershell
# 前端／桌面開發
cd ts
bun run tools/build-desktop.ts          # HTML → wails/assets/index.html
cd ..\wails
go build -ldflags "-X main.buildTime=2026-10-29T00:00:00Z -H windowsgui" -o ..\build\adbupd\accelon26.exe .

# 測試（依改動挑相關的；不確定就全跑）
cd ts
bun run test/verify.ts
bun run test/index-match.ts
bun run tools/adb-update-test.ts
bun run tools/mirror-test.ts
cd ..\wails
go test ./...

# 官網（需要 .local/server.env；不要把帳密印出來）
cd ts
bun run tools/deploy.ts --site          # exe＋versions＋官網＋manifest
bun run tools/deploy.ts --site-only     # 只同步官網頁面／manifest，不動 exe

# adb 清單與公開頁
cd ts
bun run tools/make-adb-manifest.ts
bun run tools/make-adb-index.ts --index ../www/adb/index.txt
bun run tools/publish-adb.ts            # >30 MB 需加 --allow-large；wip 一律跳過
bun run tools/cbeta-base.ts --check
```

- `deploy.ts --site` 會自動重生 changelog、版本下載頁、adb manifest 與公開數據庫頁。
- `publish-adb.ts` 會拒絕 `wip`／`revision` 的庫；>30 MB 要明確 `--allow-large`。
- 不要把 `.local/server.env`、主機指紋或密碼貼進回覆、log、commit。

## 5. 發佈規則

- **只有使用者明確說「發佈」才跑 `release.ts`**。它會建置、寫 `versions.json`、
  產生 `www/accelon26.zip` 與 `www/releases/accelon26-YYYY-MM-DD.zip`。
- 一天最多一個 release；同日重發會合併 `release_notes.json` 並覆蓋當天 ZIP，
  不保留 RC 檔。
- 歷史 release ZIP 不刪；`deploy.ts --site` 只補站上沒有的。
- 發佈後兩站都要同步，並驗證線上 `versions.json`、exe sha、歷史 ZIP 與 404 狀態。
- 不要未經指示改 `deploy/adb-status.json` 的 `wip`／`revision`，也不要把
  `taisho.adb`／`wxzj.adb`／`fgdict.adb` 重新上傳。

## 6. 改動與回報

- 文件、UI、註解用繁體中文；程式識別字用英文。
- 優先用小而集中的 diff；不要碰與任務無關的檔案。
- 工作區可能同時有其他人的未提交改動；**不要** `git add -A`、`git restore .`、`git reset --hard`
  或大範圍 checkout。除非使用者要求，不要自動 commit。
- 大型 `.adb`／`.zip` 是建置產物，已被 gitignore；不要 force-add。
- 有行為、數字、流程或路徑變動時，順手更新對應文件：
  - 官網／部署：`docs/system/DEPLOY.md`
  - adb 底座：`docs/adb/stable-adb.md`
  - 金剛／法華家族：`docs/adb/wittern-related-jingang-fahua.md` 等
- 回報時說清楚：改了什麼、跑了哪些測試、還有什麼沒驗證。
- 不確定是否算「發佈」時，先問；不要直接把產物覆寫到 `D:\accelon3` 或線上。

## 7. 文件入口

- `docs/README.md`：文件索引
- `docs/system/DEPLOY.md`：部署、鏡像、release、manifest
- `docs/adb/stable-adb.md`：底座／功能 adb 分層、CBETA 換版流程、30 MB 與流量政策
- `docs/adb/taisho-steps.md`、`wxzj-steps.md`：底座建置
- `docs/adb/wittern-related-jingang-fahua.md`：Wittern Related Texts 的比對結果
- `D:\2026\ys\AGENTS.md`：已移出的 ys／tx 專案規則
