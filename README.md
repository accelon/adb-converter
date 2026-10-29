# adb-converter

Accelon3 `.adb` 資料庫的**解析 / 匯出 / 重建**工具（Bun + TypeScript），附規格書與驗證。

## 鏡像站

- **廣州**：<https://shutonggui.cn/accelon26/>
- **境外**：<https://nissaya.cn/accelon26/>

官網不顯示切換列。主站載入後以 225 KB 的 `img/search.jpg` 測速：
主站超過約 1 秒才測 `nissaya.cn`；鏡像明顯更快（< 主站 72%）才自動切過去。
主站正常就不打擾；偵測失敗則留在原站。
測到 nissaya 較快時，會把 **IPv4 /24 或 IPv6 /64 網段**與時間存進 `localStorage`（30 天）；
同一網段下次直接跳 nissaya，不再下載測試圖。網段變了（往返兩地）才重新測速。

## 文件

- [文件索引](docs/README.md)：軟件、各 adb、對話紀錄分開整理
- [2026-10-29 對話總結](docs/system/2026-10-29-accelon26-session.md)

## 2026-10-29 對話總結

這一輪把 `jingang.adb` 擴成 `taisho-study.adb`（金剛／法華／大日）、加入逐經目錄、
`study/index` 注疏索引、桌面版「取得更多 ADB」、頁碼選取選單，以及官網鏡像測速、
ZIP 下載與 10-29 正式版。完整脈絡、資料格式、建置指令與已知限制見
[2026-10-29-accelon26-session.md](./docs/system/2026-10-29-accelon26-session.md)。

## 現在能做什麼

| 能力 | 指令 | 驗證狀態 |
|---|---|---|
| 舊 ADB → **完全合法的 XML** + 完整圖片 | `extract.ts` | Python(expat) 逐檔驗證：yinshun 45/45、13j 1/1、DFB_J/boyang/kangxizidian 全通過；圖片零遺漏 |
| **只憑 XML 重建 ADB**（舊程式可讀） | `rebuild-adb.ts` | `13j.adb` 重建後與原檔**逐位元組相同**（SHA-256 一致）；`yinshun-small.adb` 已由 **accelon3.exe 實機開啟、圖片正常** |
| 新舊 ADB **逐 block 比對** | `compare-adb.ts` | 逐容器、逐區塊（按名稱配對），區分「必須相同」與「允許不同」 |
| 反向索引複刻對拍 | `compare-index.ts` | yinshun **9,516 token / 7,256,439 命中，逐位置完全一致** |
| XML 結構掃描 | `xml-lint.ts` | 93 庫已掃；`mismatch=18,348`、`entity=11,870`、`unterminated=464` 等已量化 |

## 快速開始

```bash
cd ts

# 1) 匯出合法 XML + 圖片
bun run tools/extract.ts D:\accelon3\yinshun\yinshun.adb -o ../build/xyinshun

# 2) 只憑 XML 重建 ADB（不需要原檔）
bun run tools/rebuild-adb.ts ../build/xyinshun -o ../build/newyinshun.adb

# 3) 逐 block 比對
bun run tools/compare-adb.ts D:\accelon3\yinshun\yinshun.adb ../build/newyinshun.adb

# 4) 產生給舊 accelon3.exe 的驗收檔（前 10 文件 + 用到的圖片 + logo）
bun run test:small          # -> ../build/yinshun-small.adb

# 5) 測試
bun run test/verify.ts      # XML 黃金測試 12 項
bun run test/index-match.ts # 反向索引認證
```

舊版 CLI（結構分析/匯出）仍可用：`bun run src/cli.ts analyze|inspect|export|bench <adb>`

## 閱讀位置（2026-10-25）

每一份 adb（用檔名＋大小區分，所以 `13j.adb`、`13j-v1.adb` 各自記）會把**最後閱讀的
節點與頁**存在 `localStorage`（`accelon26.lastRead.v1`）；重新開啟或更新 accelon26
版本後仍會回到那一頁。

## 加入 Obsidian（2026-10-25）

📁（adb 選單）多了「加入 Obsidian（資料夾／.zip）」：選一個 Obsidian vault，**輸入檔名**（`.adb` 可省略，中文也可以），當場轉成 `.adb`。
網頁版把建好的 adb **下載**到「下載」資料夾；桌面版寫到**執行檔旁邊**（捷徑的開始位置
不同也找得到）。兩邊都會更新 adb 清單並開啟新庫。轉換在頁面裡完成（Bun 不參與），
與 CLI `bun run md2adb` 產生的檔案**逐位元組相同**。詳見
[OBSIDIAN-TO-ADB.md](./docs/adb/OBSIDIAN-TO-ADB.md) §11。

## 網頁版編輯（2026-10-24）

`build/accelon26.html` 現在可以在瀏覽器裡直接修錯字：按本文右上角的鉛筆進入編輯態，
離開自動暫存，db 分頁會出現「n 頁修訂」；按存檔圖示重建並下載新的 `.adb`，
修訂 diff 存在 adb 的 `revisions` 容器（舊 accelon3.exe 不會讀）。目前限制 50 MB 以下。
詳見 [EDIT-MODE.md](./docs/system/EDIT-MODE.md)。

## 文件

文件分成兩區：`docs/adb/` 是 `.adb` 格式、轉換、語料與反鏈；`docs/system/` 是 accelon26 應用、部署、offtext 與開發規範。根目錄只留這份 README。

### ADB：格式、轉換、語料、反鏈

* [SPEC.md](./docs/adb/SPEC.md) — `.adb` 協定規格（§15 索引複刻、§17 管線與驗證狀態）
* [FORMAT.md](./docs/adb/FORMAT.md) — 早期英文逆向筆記（容器格式）
* [PASCAL-NOTES.md](./docs/adb/PASCAL-NOTES.md) — Delphi 原始碼逐單元筆記
* [accelon-vs-tei.md](./docs/adb/accelon-vs-tei.md) — Accelon 風格 XML 與 TEI 巢式結構對照
* [UPGRADE-DIRECTIONS.md](./docs/adb/UPGRADE-DIRECTIONS.md) — 容器／索引／轉 offtext 三個方向的改進評估
* [HANDOVER.md](./docs/adb/HANDOVER.md) — 轉換管線的技術交件：工具、驗證、限制
* [cbeta-adb-skill.md](./docs/adb/cbeta-adb-skill.md) — CBETA TEI → accelon `.adb` 的六步流程（含 `<聯 i q j>` 規格）
* [old-adb-upgrade-skill.md](./docs/adb/old-adb-upgrade-skill.md) — 舊 accelon3 `.adb` 升級：保留 schema／頁碼／caches，補 `<聯 i q j>`
* [backlink-skill.md](./docs/adb/backlink-skill.md) — 引文接回大正藏的完整 runbook（cue、單字 VA、`j`、打包、上架）
* [xref-j-lessons.md](./docs/adb/xref-j-lessons.md) — `<聯 j>` 字元級反鏈的實戰筆記：座標、重複頁 id、驗證與工具鏈
* [broken-quote.md](./docs/adb/broken-quote.md) — 尚無精確 `j` 的 823 條 `<聯>` 清單，待人工校正
* [broken-quote-elsewhere.md](./docs/adb/broken-quote-elsewhere.md) — 576 條有 `q` 的全文檢索結果（0 條整句、237 條前綴、339 條找不到）
* [taisho-steps.md](./docs/adb/taisho-steps.md) — 大正藏 1–85 冊
* [jingqun.md](./docs/adb/jingqun.md) — 大正藏「經／論／律→注→疏」繼承表（379 部註疏、479 節點、81 群）
* [jingqun-embed-skill.md](./docs/adb/jingqun-embed-skill.md) — 金剛經經群：註疏引用對齊與 `<嵌>` 文內嵌入（transclusion）
* [jingqun-notes-skill.md](./docs/adb/jingqun-notes-skill.md) — 金剛經注疏讀本小 adb：`<融>` 融入經文、`<嵌>` 段落注疏
* [taisho-study-skill.md](./docs/adb/taisho-study-skill.md) — 大正藏研究：金剛＋法華＋大日，依賴母庫
* [goryeo-steps.md](./docs/adb/goryeo-steps.md) — 高麗藏
* [lc-steps.md](./docs/adb/lc-steps.md) — 呂澂佛學著作集（1,119 個大正鏈結）
* [ys-steps.md](./docs/adb/ys-steps.md) — 印順（Y 部）：建置已搬到 `D:\2026\ys`（本檔只留指引）
* [stable-adb.md](./docs/adb/stable-adb.md) — 底座 adb（taisho／wxzj）怎麼跟 CBETA 版本走，功能為什麼要放獨立 adb
* [swjzz-steps.md](./docs/adb/swjzz-steps.md) — 說文解字注（含「說文／說文異／段注」三種標記怎麼判）
* [swjzzsrc-steps.md](./docs/adb/swjzzsrc-steps.md) — 說文解字注引用書目：說文解字、爾雅、周易、尚書、廣韻（可持續加書）
* [swjzz-citations.md](./docs/adb/swjzz-citations.md) — 段注引書統計（「X曰」與書名出現次數）
* [swjzz-seal.md](./docs/adb/swjzz-seal.md) — 說文小篆字型 → SVG → adb resources（不必裝 TTF）
* [pua.md](./docs/adb/pua.md) — 缺字清單（PUA／？／只有圖／U+FFFD），待逐條處理
* [swjzz-punct.md](./docs/adb/swjzz-punct.md) — 借外部標點補進 swjz.xml（swjzzp.adb，含書名號）
* [tx.md](./docs/adb/tx.md) — `tx.adb` 與舊版 `taixu.adb` 的差異
* [ys.md](./docs/adb/ys.md) — `ys.adb` 與舊版 `yinshun.adb` 的差異
* [taixu-links.md](./docs/adb/taixu-links.md) — 太虛全書的經文引用連到大正藏
* [shared-xref-tx-ys.md](./docs/adb/shared-xref-tx-ys.md) — 太虛／印順共同引用的大正頁
* [shared-xref-tx-ys-ylp.md](./docs/adb/shared-xref-tx-ys-ylp.md) — 太虛／印順／于淩波三庫共同引用
* [report-fgdict.md](./docs/adb/report-fgdict.md) — `fgdict.adb` 測試報告
* [OBSIDIAN-TO-ADB.md](./docs/adb/OBSIDIAN-TO-ADB.md) — Obsidian vault → adb 方案評估
* [OBSIDIAN-TO-ADB-LOG.md](./docs/adb/OBSIDIAN-TO-ADB-LOG.md) — 上述方案的開發紀錄

### 系統：accelon26、部署、offtext、開發規範

* **[ACCELON26-HANDOVER.md](./docs/system/ACCELON26-HANDOVER.md) — accelon26 應用（桌面版＋官網）交接文件（先看「現況」）**
* [architecture.md](./docs/system/architecture.md) — Accelon26 系統架構
* [DEPLOY.md](./docs/system/DEPLOY.md) — 主機、部署、更新器、回滾
* [MACOS.md](./docs/system/MACOS.md) — macOS 版建置、簽章、上傳
* [wails3-pitfalls.md](./docs/system/wails3-pitfalls.md) — Wails3 桌面版避坑
* [yap-software-practice.md](./docs/system/yap-software-practice.md) — 作者預設做法（Windows／Bun／單檔 HTML／Wails3）
* [EDIT-MODE.md](./docs/system/EDIT-MODE.md) — 網頁版編輯態與修訂 diff
* [TAG-STYLE-SETTINGS.md](./docs/system/TAG-STYLE-SETTINGS.md) — 標籤樣式設定（設計稿）
* [adbviewer.md](./docs/system/adbviewer.md) — adb viewer
* [adbviewer-http.md](./docs/system/adbviewer-http.md) — HTTP + Range 版架構
* [adbviewer-sidecar.md](./docs/system/adbviewer-sidecar.md) — Sidecar 索引旁檔設計
* [adbviewer-assessment.md](./docs/system/adbviewer-assessment.md) — 可行性評估
* [OFFTEXT-FACT-LAYER.md](./docs/system/OFFTEXT-FACT-LAYER.md) — 給 AI 編輯的事實層
* [OFFTEXT-TAG-LANGUAGE.md](./docs/system/OFFTEXT-TAG-LANGUAGE.md) — 自定義標籤語法與註冊表
* [TODO.md](./docs/system/TODO.md) — 待辦與後續計畫
* [THIRD-PARTY.md](./docs/system/THIRD-PARTY.md) — 第三方授權

## 共用規範與模塊

`yap-software-practice.md`、`wails3-pitfalls.md`、`ts/src/accelon26/lossless.ts`、`simplified-data.ts` 的 **canonical** 版本在 [agent-norms](https://github.com/accelon/agent-norms)。本 repo 保留 vendored 副本，Bun 建置與 GitHub CI 不依賴旁邊的資料夾。

改 canonical 後，在 `ts/` 跑：

```powershell
bun run sync:norms     # 複製到本 repo
bun run check:norms    # 確認沒有 drift（發佈前跑）
```

`ts/tools/gen-lossless.ts` 是專案版（預設輸出到 `ts/src/accelon26/simplified-data.ts`）；canonical 版在 `agent-norms/lossless-simplified/`。`sync:norms` 會同步它，只改寫 CLI 範例與預設輸出路徑。

「自解說」導覽的可重用模組與 agent skill 也在 agent-norms：`self-explaining-tour/`、`skills/self-explaining-tour/`。本專案的 `ts/tour/` 是目前實際在用的實作與參考。

## 需求

* Bun ≥ 1.1
* bzip2：優先用 `libbz2`（`bun:ffi`，可用 `ABX_LIBBZ2` 指定路徑）；解壓有內附純 JS 後備（`ts/src/vendor/bzip2.js`，MIT），**壓縮必須有 libbz2**

## 已知限制（詳見 HANDOVER.md §5）

* yinshun 獨立建庫時 `caches` 剩 `序`、`圖` 兩鍵不同（cached 旗標的動態宣告時機；來源疑在 adb 之外的建庫定義檔）
* per-tag `tfDontCare`（`/圖` 3 筆，規格允許 postings 不同）
* Pascal 行尾越界讀的行為差異；XML 合法化修復不可逆

## 注意

`.adb` 是**光盤時代**的格式，seek 很貴：**新功能先查 adb 內已有的資料**（`caches` 字串表、`attributes` 實例屬性、
`tags`／`tokens` 命中表、`tables` 行表），不要回讀內文硬算。詳見 [HANDOVER.md](./docs/adb/HANDOVER.md) §0 與 [SPEC.md](./docs/adb/SPEC.md) §2.1。

`*.adb`、`*.xml`、`build/`、`sourcecode/`、`accelon3/` **不進版控**（見 `.gitignore`）——資料檔與中間產物只留在本機。



