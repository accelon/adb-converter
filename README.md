# adb-converter

Accelon3 `.adb` 資料庫的**解析 / 匯出 / 重建**工具（Bun + TypeScript），附規格書與驗證。

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

## 網頁版編輯（2026-10-24）

`build/accelon26.html` 現在可以在瀏覽器裡直接修錯字：按本文右上角的鉛筆進入編輯態，
離開自動暫存，db 分頁會出現「n 頁修訂」；按存檔圖示重建並下載新的 `.adb`，
修訂 diff 存在 adb 的 `revisions` 容器（舊 accelon3.exe 不會讀）。目前限制 50 MB 以下。
詳見 [EDIT-MODE.md](EDIT-MODE.md)。

## 文件

* **[ACCELON26-HANDOVER.md](ACCELON26-HANDOVER.md) — accelon26 應用（桌面版＋官網）的交接文件（先看開頭的「現況」，本輪細節在 §13）**
* [HANDOVER.md](HANDOVER.md) — 轉換管線的技術交件：工具、驗證結果、規則摘要、限制
* [DEPLOY.md](DEPLOY.md) — 主機、部署、更新器、回滾，以及 `bun run clean`
* [MACOS.md](MACOS.md) — macOS 版怎麼建、怎麼簽、怎麼上傳
* [wails3-pitfalls.md](wails3-pitfalls.md) — Wails3 桌面版共通避坑（Windows SmartScreen、WebView2、更新器、macOS Gatekeeper）
* [yap-software-practice.md](yap-software-practice.md) — 作者預設做法（Windows／Bun／單檔 HTML／Wails3、漢字、無損簡體、主題）
* [SPEC.md](SPEC.md) — `.adb` 協定規格（§15 索引複刻、§17 管線與驗證狀態）
* [UPGRADE-DIRECTIONS.md](UPGRADE-DIRECTIONS.md) — 容器／索引／轉 offtext 三個方向的改進評估與優先序
* [OFFTEXT-FACT-LAYER.md](OFFTEXT-FACT-LAYER.md) — 給 AI 編輯的事實層：claim／evidence／驗證與 12 週試點
* [OFFTEXT-TAG-LANGUAGE.md](OFFTEXT-TAG-LANGUAGE.md) — 自定義標籤語法、註冊表、standoff 位置與 AI 調色盤
* [accelon-vs-tei.md](accelon-vs-tei.md) — Accelon 風格 XML（H1–H6 擴充）與 TEI 巢式結構對照：轉換處方與實測陷阱
* [PASCAL-NOTES.md](PASCAL-NOTES.md) — Delphi 原始碼逐單元筆記
* [FORMAT.md](FORMAT.md) — 早期英文逆向筆記
* [TODO.md](TODO.md) — 待辦與後續計畫

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
`tags`／`tokens` 命中表、`tables` 行表），不要回讀內文硬算。詳見 [HANDOVER.md](HANDOVER.md) §0 與 [SPEC.md](SPEC.md) §2.1。

`*.adb`、`*.xml`、`build/`、`sourcecode/`、`accelon3/` **不進版控**（見 `.gitignore`）——資料檔與中間產物只留在本機。
