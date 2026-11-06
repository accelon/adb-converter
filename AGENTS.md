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
- **adb 工作區只負責產出 adb，不自行部署**（作者 2026-11-06）：`ys`、`fuyan`、`tx`
  等工作區把 `*.adb`、版本說明、`sha256`／大小交給本區就好；**官網與鏡像的 adb 上傳、
  `manifest`／公開數據庫頁更新，由本區在桌面 RC 時一起做**（程序＋這一輪有更新的 adb）。
  原因：桌面版更新通常就是為了新 adb，分成兩邊部署會慢、也容易程式與資料不同步。
  各 adb 工作區仍負責建置、內容正確性與版本紀錄；本區不修改已移出工作區的正文。
- **`ys.adb` 的建置由 `D:\2026\ys` 工作區負責**（作者 2026-10-29）：
  本工作區不改 ys 的正文／資料；部署已改由本區統一處理（見上一條）。ys 工作區也可能
  直接修改本區的 `docs/adb/ys*.md`，那些檔案以那邊為準；本區只改閱讀器與官網。
- 還在這裡的 adb 實驗（例如 `jingqun`）可以改，但要知道它將來可能搬走。
- **開新工作區一律到 `D:\2026\agent-norms` 拿模板**（作者 2026-11-04，改 2026-11-01 舊做法）：
  adb 庫用 `D:\2026\agent-norms\new-adb-AGENTS.md`，一般專案用
  `new-workspace-AGENTS.md`；步驟看 `D:\2026\agent-norms\new-workspace.md`（adb 另有
  `new-adb-workspace.md`）。本區 `docs/adb/new-adb-workspace.md`、`new-adb-AGENTS.md`
  只剩一行指標，**不要在那裡補內容**。新工作區的 `AGENTS.md` 會要求它回 agent-norms
  讀紀律，並回本區讀「共用 know-how、版本紀錄」。
- **成品一律放 `D:\accelon3`**（作者 2026-10-30）：`*.adb`、`accelon26.html`、
  `accelon26.exe` 都在那個資料夾；`build/` 只放建置中間檔與可重建的輸出。
  桌面版開機用 `ListAdbs` 列出工作目錄與 exe 所在資料夾的 `*.adb`，放在別處它找不到。
  網頁版（file://）不能掃資料夾，使用者在 `accelon26.html` 要自己選檔。
- **官網 adb 只從 `D:\accelon3` 上傳**（作者 2026-11-06）：測好的 adb 都放這裡，
  `deploy.ts`／`publish-adb.ts` 也以這裡為來源；不要從 adb 工作區的 `out/`／`build/`
  直接上傳。`D:\2026\sz\accelon26` 的 sz 系列**尚未正式上網**，不要放進
  `www/adb/index.txt`／manifest，也不要上傳。
- **例外：sz 與其巴利譯本的 adb 一律放 `D:\2026\sz\accelon26`，不放 `D:\accelon3`**
  （作者 2026-11-03）：`cs`、`cs-mm`、`cllk`、`ccc`、`yh`、`hz`、`pku`、`xsq`、`sc`、`kmj`、
  `lex`，以及 veda 群的 `veda`／`sa`／`en`／`zh`。這些庫還在密集重建，放同一區才不會
  兩份檔案互相比舊；`D:\accelon3` 只留已定稿／要發佈的庫。
- **改前端就立刻跑煙霧測試**（作者 2026-11-03 教訓）：`cd ts && bun run tools/smoke.ts`（dev server 在 8790）；新增或搬動 import 之後再跑 `bun run tools/check-cycles.ts`（基準 64 個環，變多就會 exit 1）。原因：循環 import 不會被 build／型別檢查擋下，只會在執行時讓 `boot()` 中途死掉——按鈕全部沒反應、卻沒有例外訊息，2026-11-03 為此查了半個下午。
- **桌面版只開與 exe 同一資料夾的 adb**（作者 2026-11-03）：adb 之間會互相聯動（`<聯>`、對照、詞典），單獨拿到別處經常不能用，所以入口直接限制：`ListAdbs` 只掃 exe 資料夾，`Open` 也擋掉資料夾外的路徑。
- **viewer 一律寫到 `D:\accelon3\accelon26.html`**（作者 2026-10-31，已交代多次）：
  `bun run tools/build-viewer.ts` 的預設輸出現在就是那裡，不必再手動從 `build/` 覆寫；
  `build/accelon26.html` 只是舊位置／`-o` 指定時才會用到。改完 HTML／CSS／前端 TS
  就直接重建到 `D:\accelon3`，不必等發佈；exe 仍然只在發佈時換。
- **建置成本 vs 使用者每次成本**（作者 2026-10-31）：能預先算好、存進 adb 的資料
  （容器／屬性／快取）就不要留給閱讀器每次重算；建置多花幾秒、檔案多幾 MB 可忽略，
  不要為了省建置時間／空間讓使用者每次等。詳見
  `docs/system/ACCELON26-HANDOVER.md` §0.3。
- **官網上自己的更新記錄**（作者 2026-11-05 允許）：各 adb 工作區可以自己更新 `www/adb/<db>.html`
  與 `deploy/adb-history.json` 裡 `<db>.adb` 那一筆（`buildTime`／`sha256`／`size`／`notes`）；
  `index.html`、`manifest.json`、別人的頁面仍歸母區。細節見
  `D:\2026\agent-norms\new-adb-workspace.md` §5.1。
- **版本紀錄分工**（作者 2026-11-06）：每一個 adb 工作區在自己的 repo 維護 `version-log.md`
  （建置完先寫那裡）；本區 `docs/adb/adb-version-log.md` 是**彙整版**，只在使用者說
  「發佈」時，到各工作區取最新的 `version-log.md` 合併過來（並寫 `deploy/adb-notes.json`）。
  各區清單與欄位規則見該檔的「各工作區的 version-log.md」；新工作區沒有這一頁時，本區幫它建。

## 2. 目前的重要狀態（2026-10-29）

- 官網公開數據庫 **7 個**：`13j`、`swjzz`、`tx`、`yulinpo`、`ys`（都 <30 MB）
  ＋ `taisho`（331 MB 大檔）＋ `wxzj`（2026-10-31 開放，234.4 MB 大檔）。
- `taisho.adb`：2026-10-29 起 **available／可下載**（`large:true`、不列入「全部更新」，
  只能整檔下載）；製作說明是 `www/adb/taisho.html`（來源 `docs/adb/taisho-about.md`）。
- `wxzj.adb`：2026-10-31 起 **available／可下載**（`large:true`、不列入「全部更新」，
  只能整檔下載）；製作說明是 `www/adb/wxzj.html`（來源 `docs/adb/wxzj-about.md`）。
  2026-10-31 重建：SD／RJ 梵字換成 PUA（內嵌字型），CB 缺字剩 1,772 碼，
  見 `docs/adb/missing-char.md`。
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
| `build/` | 建置產物、暫存、測試；通常不進 git（**成品 copy 到 `D:\accelon3`**） |
| `.local/` | 伺服器帳密、主機指紋、下載清單；**已在 gitignore，勿印出內容** |

外部資料（唯讀，除非使用者明確要求）：

- `D:\accelon3\`：**本機書庫，成品都放這裡**（`*.adb`、`accelon26.html`、`accelon26.exe`，
  見 §1）。換版時覆寫同名檔；其他檔案不要動。
- `D:\2026\xml-p5\`：CBETA XML-P5 checkout。
- `D:\2023\sat2018\`：T56–T84 的 SAT 2018 來源。
- `D:\2026\ys\`：已移出的 ys／tx 專案。
- `D:\2026\wisdomlight\`：金剛經平行本（六漢譯＋梵本，`samples/jingang`）；不要重做，
  之後直接接它的 `works.tsv`／`anchor_map.tsv`。

## 4. 常用指令

```powershell
# 前端／桌面開發（成品 copy 到 `D:\accelon3`：html、exe；見 §1）
cd ts
bun run tools/build-desktop.ts          # HTML → wails/assets/index.html
cd ..\wails
go build -ldflags "-X main.buildTime=2026-10-29T00:00:00Z -H windowsgui" -o ..\build\adbupd\accelon26.exe .
copy ..\build\accelon26.html D:\accelon3\accelon26.html
copy ..\build\adbupd\accelon26.exe D:\accelon3\accelon26.exe

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

- **腳注 `pg` 屬性（2026-11-01，作者定案）**：從 **docx** 轉來的 adb（`fuyan`、`yl38`…）每節重新編號，
  所以 `<註>`／`<釋>` **要帶 `pg="<頁 id>"`**（建置時把頁 id 一起寫進去，不要改 `n` 的規則）；
  從 **TEI** 來的（`ys`、`taisho`、`wxzj`）註號本身唯一，**不需要 `pg`**。
  閱讀器配對順序是「pg 相同 → 同頁最近 → 頁碼最近」，兩種來源並存。詳見 `docs/adb/stable-adb.md` §3.1。
- **術語 `<术 sk|pi|tb>`（2026-11-01）**：所有含梵／巴／藏對照的庫共用 `ts/src/terms/terms.ts` ＋ `data/terms.tsv` ＋ `data/term-fixes.tsv`；新文字用 `bun run tools/terms.ts apply`，既有標記用 `fix`，glossary 容器用 `glossary`。詳見 `docs/adb/terms.md`。

## 5. 發佈規則

- **作者說「發佈」＝建置＋部署＋commit（2026-11-02 指示）**：跑完 `tools/release.ts` 與
  `tools/deploy.ts`（兩個站同步、線上驗證）之後，把程式碼 **commit 並 push**，
  不要留一批未提交的改動。commit 訊息用繁體中文，寫清楚這一版改了什麼。
- **只有使用者明確說「發佈」才跑 `release.ts`**。它會建置、寫 `versions.json`、
  產生 `www/accelon26.zip` 與 `www/releases/accelon26-YYYY-MM-DD.zip`。
- 一天最多一個 release；同日重發會合併 `release_notes.json` 並覆蓋當天 ZIP，
  不保留 RC 檔。
- 歷史 release ZIP 不刪；`deploy.ts --site` 只補站上沒有的。
- 發佈後兩站都要同步，並驗證線上 `versions.json`、exe sha、歷史 ZIP 與 404 狀態。
- 不要未經指示改 `deploy/adb-status.json` 的 `wip`／`revision`，也不要把
  `fgdict.adb` 重新上傳（`taisho.adb`／`wxzj.adb` 已分別於 2026-10-29、2026-10-31
  開放，見 §2；底座換版仍照「一年兩三次」）。
- 把新的 adb／html／exe 放進 `D:\accelon3` 是**本地部署**（見 §1），不算官網發佈；
  官網上線仍然只在使用者說「發佈」時做。

## 6. 改動與回報

- **背景工作與行程（2026-11-04 作者指示）**：不要讓 dev server／CDP 測試／瀏覽器／exe 留在背景。
  起背景工作要記下 job id；收工前用 `job_list` 加
  `Get-CimInstance Win32_Process -Filter "Name='bun.exe'"` 檢查，把 bun／node／`accelon26`／
  測試瀏覽器（`--user-data-dir=...build/...`）一併收掉。**不能只 kill pwsh 外層**——
  子行程會變孤兒繼續跑（2026-11-04 留下 7 個 bun，作者風扇一直吹）。
  長跑工作要加 timeout；回報前確認 `Get-Process bun,accelon26` 沒有殘留，
  除非使用者明說要留 dev server。canonical 版見
  `D:\2026\agent-norms\yap-software-practice.md` §12（所有工作區）。
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
- **代寫或改稿作者的文章（散文、發表稿、後記）之前**，先讀 canonical 文風規範
  `D:\2026\agent-norms\writing-skill.md`（§1 語域 D 抒情散文、§2.8 留白「畫公仔唔使畫出腸」、
  §7.5 骨架）；本區的落地清單在 `docs/essays/README.md`。
- 不確定是否算「發佈」時，先問；官網／線上不要直接覆寫（`D:\accelon3` 是本機書庫，
  位置與做法見 §1、§3、§5）。

## 7. 文件入口

- `docs/README.md`：文件索引
- `docs/system/DEPLOY.md`：部署、鏡像、release、manifest
- `docs/adb/stable-adb.md`：底座／功能 adb 分層、CBETA 換版流程、30 MB 與流量政策
- `docs/adb/taisho-steps.md`、`wxzj-steps.md`：底座建置
- `docs/adb/wittern-related-jingang-fahua.md`：Wittern Related Texts 的比對結果
- `D:\2026\ys\AGENTS.md`：已移出的 ys／tx 專案規則

## glossary 容器與「詞彙」分頁（2026-10-31，ys.adb 專用）

ys.adb 現在多一個外層容器 `glossary`（1 個 block、**未壓縮** UTF-8 JSON Lines）：

```text
["GLOSSARY1", 4107]
["sk","svabhāva","自性",12]
```

- `ts/src/accelon26/glossary.ts`：`loadGlossary()` 讀取並快取（WeakMap per reader）、
  `foldGlossary()` 去掉變音符號／大小寫／空白（只給輸入比對用）、
  `matchGlossary()` 漢詞子字串或外語 fold 後子字串。效能（2026-10-31）：`loadGlossary()` 先把每列的 `fold`（外語去變音符號）與 `simp`（漢詞強制簡體）算好存進記憶體，查詢只做字串比對；實測載入約 50 ms、每次查詢（篩選＋排序＋組 HTML）約 1 ms（4,107 列）；輸入去抖 120 ms、一次只重畫 300 列（字串一次 innerHTML，不再逐列 createElement）。
- 左欄多一個「詞彙」分頁（`data-tab="glossary"`），只有庫裡有 `glossary` 容器時才顯示
  （`syncTreeTabs()` 內用 `hasGlossary(reader)` 判斷）。
- 畫面：`renderGlossary()`（scopes.ts）列出「漢詞＋外語（原樣）＋次數」，依語言分組；
  點一列會把漢詞丟進全文搜尋。
- 顯示保留變音符號；輸入可省略、可不分大小寫。
- 「詞彙」分頁有「漢語／外語」排序選單（2026-10-31）：漢語依漢詞排、外語依外語排（都忽略變音符號）；圓圈小字「梵／巴／藏」一律放在**外語前面**，三色不同（`.glossLang.sk/.pi/.tb`）；選「外語」排序時外語排在漢詞前面。漢詞、外語都可以點：點**整列**＝直接跳到該詞第一次出現（`glossary` 每列帶 `page`＋`off`，優先走 `openCharPosition({anchor:"L"+(line-1), a:hanline})`（行號＋行內漢字，2026-10-31 實測正確）；沒有 hanline 才用頁＋頁內位移，再不行才 `jumpToAdbLine()`）；列尾的 🔍＝全文檢索（`runSearch()`），不改輸入區、只更新摘要（2026-10-31 作者指定）。輸入不限語言，漢詞或外語都可以；另有「任意／開頭／中間／結尾」位置選單（`#glossaryMatch`，漢語外語通用，語意同 s="$詞" 的比對位置）。
- 選取文字 → 浮動選單「查看」多一顆：選到漢詞寫「查梵語／查巴利語／查藏語」，選到外語（可省略變音符號）寫「查漢語」；按鈕文字會帶出對應語（例：選「光音天」→「查梵語 Ābhāsvāra」；選 Ābhāsvāra →「查漢語 光音天」）；**一個對應語一顆按鈕**（例「涅槃」→ 查梵語 mahā-parinirvāṇa、查梵語 nirvāṇa、查巴利語 nibbāna 三顆），查不到就不顯示。注意：`showMenu()` 一定要 `void fillGlossary(info)`；`runAction('gloss')` 走 `openDictLookup()`，否則按鈕永遠不出現、函式還會被 bundler 刪掉（2026-10-31 實際踩過）。按下後用**詞典**查「對應語」（選漢詞→查外語、選外語→查漢詞；不是改「詞彙」輸入區）。
- **西文查詢**（2026-10-31）：全文索引只有正文，`<术>` 的外語在屬性裡。查詢若全是拉丁字母，`runSearch()` 會先用詞彙表把外語換成漢詞（候選最多 4 個，逐一試到索引找得到為止），摘要會附註「（西文「Apalāla」→ 阿鉢羅、降伏阿波羅）」；沒有詞彙表就照原樣查。\n- 沒有 `glossary` 的庫（taisho、fgdict…）行為完全不變。

---

## 語義分句與軌號（canonical）

指導性原則見 `D:\2026\agent-norms\shutonggui.md`（書同軌）：句級地址、最小切分、
軌號（`track_id`）與 crosswalk。本區只放實作與資料，不另存一份原則再改。
