# 文件索引

這個目錄把「軟件」與「各個 adb」分開記錄。**改任何一個 adb 之前，先看
[adb-knowhow.md](./adb/adb-knowhow.md)**——容器、座標、缺字、字型、詞彙、`j`、
驗證都是共用的。

## 先讀

| 文件 | 內容 |
|---|---|
| [adb/adb-knowhow.md](./adb/adb-knowhow.md) | **共用 know-how**：容器、VA、漢字位置、缺字／字型、`glossary`／`<术>`、`<聯 j>`、建置六步、檢查表、已知問題 |
| [adb/adb-version-log.md](./adb/adb-version-log.md) | **版本紀錄（彙整版）**：各 adb 每次建置的日期／sha／大小／工作區／說明。各 adb 工作區自己維護 `version-log.md`，本頁在發佈前由本區彙整（`bun run tools/version-log-status.ts` 看還缺哪幾列） |
| [adb/new-adb-workspace.md](./adb/new-adb-workspace.md) | 開新 adb 工作區（**已移到 agent-norms**）：canonical 是 `D:\2026\agent-norms\new-adb-workspace.md`，模板 `new-adb-AGENTS.md`；本區只留指標 |
| [adb/stable-adb.md](./adb/stable-adb.md) | 底座／標注／功能三層、CBETA 換版流程、30 MB 與流量政策 |
| [adb/missing-char.md](./adb/missing-char.md) | **重要**：缺字（`&CB;`／`&SD;`／`&RJ;`）與字型 |
| [adb/han-position.md](./adb/han-position.md) | 漢字位置一律 code point；`j`／`off`／`hanline` 與 Range 的換算、遷移 |

## 軟件

| 文件 | 內容 |
|---|---|
| [software/accelon26.md](./software/accelon26.md) | 閱讀器本體：UI、目錄、注疏、選取選單、建置 |
| [software/desktop.md](./software/desktop.md) | Wails 桌面宿主：取得更多 ADB、離線、Obsidian 進階模式 |
| [software/website.md](./software/website.md) | 官網：鏡像測速、首頁、ZIP 下載、日期 |
| [software/release.md](./software/release.md) | 正式發佈、`versions.json`、部署與目前版本 |

## ADB 個別庫

| 文件 | 內容 |
|---|---|
| [adb/taisho.md](./adb/taisho.md) | 母庫 `taisho.adb`：頁碼、目錄、`<融>`／`<嵌>` 的依賴 |
| [adb/taisho-steps.md](./adb/taisho-steps.md)、[taisho-about.md](./adb/taisho-about.md) | 大正藏建置步驟與成品說明（含 SAT 2018） |
| [adb/wxzj-steps.md](./adb/wxzj-steps.md)、[wxzj-about.md](./adb/wxzj-about.md) | 卍新纂續藏建置與成品說明 |
| [adb/ys.md](./adb/ys.md)、[adb/ys-steps.md](./adb/ys-steps.md) | 印順 `ys.adb`（建置以 `D:\2026\ys` 為準） |
| [adb/taisho-study.md](./adb/taisho-study.md) | 研究讀本 `taisho-study.adb`：三經、逐經目錄、注疏索引 |
| [adb/jingang.md](./adb/jingang.md) | 舊 `jingang.adb`／`jingang-group.adb` 與遷移關係 |
| [adb/public-databases.md](./adb/public-databases.md) | 官網公開資料庫 manifest 與桌面下載 |
| [adb/goryeo-steps.md](./adb/goryeo-steps.md) | 高麗藏 `goryeo.adb` 建置步驟；工作區 `D:\2026\goryeo`（2026-11-01 建立） |
| `D:\2026\fuyan\README.md`、`REPORT-05B.md` | 福嚴 `fuyan.adb`（外部工作區） |
| [github.com/accelon/vedic](https://github.com/accelon/vedic) | **吠陀與奧義書三語平行** `veda.adb`＋`sa`／`en`／`zh`（獨立 repo，本地 `D:\2026\vedic`；成品仍產到 `D:\2026\sz\accelon26`） |

## 共用機制與工具鏈

| 文件 | 內容 |
|---|---|
| [adb/terms.md](./adb/terms.md) | `<术 sk\|pi\|tb>` 標記、常用詞表、`terms.ts` 三種指令 |
| [adb/table.md](./adb/table.md) | **表格**：`<表>` 語法（管線列）、框線字藝術自動轉換、`docx` 表格轉換、塗紅契約與限制 |
| [glossary.md](./glossary.md) | `glossary` 容器格式、詞彙分頁行為、跳位置與效能 |
| [adb/xref-j-lessons.md](./adb/xref-j-lessons.md) | `<聯 j>` 字元級反鏈的座標系、七個坑、修復順序 |
| [adb/ancient-book-xref-spec.md](./adb/ancient-book-xref-spec.md) | **canonical**：50–100 本古書、catalog、分散式 `xout`、LinkBus、缺書下載引導 |
| [adb/interlink-markup-handoff.md](./adb/interlink-markup-handoff.md) | 給雙向鏈結 agent 的語法整合與 13j／swjz／swjzz 定址實例、推導任務 |
| [adb/backlink-skill.md](./adb/backlink-skill.md) | 反鏈（誰引用這一頁）的舊中央流程（legacy） |
| [adb/cbeta-adb-skill.md](./adb/cbeta-adb-skill.md) | CBETA TEI → adb 的六步流程與檢查表 |
| [adb/off-to-accelon.md](./adb/off-to-accelon.md) | **`.off` → Accelon XML** 的規格：對照表（區／書／塊／段）、一行一句、註文分檔、`塊.段` 定位、驗收清單 |
| [adb/old-adb-upgrade-skill.md](./adb/old-adb-upgrade-skill.md) | 舊 adb 升級 |
| [adb/pua.md](./adb/pua.md) | 缺字清單（PUA／IDS／書影） |
| [adb/siddham-ranjana.md](./adb/siddham-ranjana.md) | 悉曇／蘭札碼位、字型、設置頁測試 |
| [adb/FORMAT.md](./adb/FORMAT.md)、[adb/SPEC.md](./adb/SPEC.md) | adb 二進位格式與規格 |
| [adb/PASCAL-NOTES.md](./adb/PASCAL-NOTES.md) | 舊 Delphi indexer 對照筆記 |

## 系統與部署

| 文件 | 內容 |
|---|---|
| [system/DEPLOY.md](./system/DEPLOY.md) | 部署、鏡像、release、manifest |
| [system/ACCELON26-HANDOVER.md](./system/ACCELON26-HANDOVER.md) | 閱讀器整體交接文件 |
| [system/refactor-doctab-adb.md](./system/refactor-doctab-adb.md) | 本文分頁自帶 adb 上下文：重構交接單 |
| [system/THIRD-PARTY.md](./system/THIRD-PARTY.md) | 第三方元件與字型授權 |
| [system/TODO.md](./system/TODO.md) | 待辦 |

## 對話紀錄

| 文件 | 內容 |
|---|---|
| [system/2026-10-29-accelon26-session.md](./system/2026-10-29-accelon26-session.md) | 2026-10-29 長對話的時序摘要與決策背景 |
