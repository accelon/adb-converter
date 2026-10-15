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

## 文件

* **[HANDOVER.md](HANDOVER.md) — 技術交件（先看這份）**：管線、工具、驗證結果、規則摘要、限制
* [SPEC.md](SPEC.md) — `.adb` 協定規格（§15 索引複刻、§17 管線與驗證狀態）
* [PASCAL-NOTES.md](PASCAL-NOTES.md) — Delphi 原始碼逐單元筆記
* [FORMAT.md](FORMAT.md) — 早期英文逆向筆記
* [TODO.md](TODO.md) — 待辦與後續計畫

## 需求

* Bun ≥ 1.1
* bzip2：優先用 `libbz2`（`bun:ffi`，可用 `ABX_LIBBZ2` 指定路徑）；解壓有內附純 JS 後備（`ts/src/vendor/bzip2.js`，MIT），**壓縮必須有 libbz2**

## 已知限制（詳見 HANDOVER.md §5）

* yinshun 獨立建庫時 `caches` 剩 `序`、`圖` 兩鍵不同（cached 旗標的動態宣告時機；來源疑在 adb 之外的建庫定義檔）
* per-tag `tfDontCare`（`/圖` 3 筆，規格允許 postings 不同）
* Pascal 行尾越界讀的行為差異；XML 合法化修復不可逆

## 注意

`*.adb`、`*.xml`、`build/`、`sourcecode/`、`accelon3/` **不進版控**（見 `.gitignore`）——資料檔與中間產物只留在本機。
