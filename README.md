# adb-converter

Accelon3 `.adb` 資料庫的工具集與規格文件。

* **[SPEC.md](SPEC.md) — `.adb` 技術說明書（中文，以 Delphi 原始碼為權威依據）**
* [PASCAL-NOTES.md](PASCAL-NOTES.md) — 讀 `sourcecode\`（Delphi 7）原始碼的逐單元筆記
* [FORMAT.md](FORMAT.md) — 早期英文逆向筆記與驗證表
* `ts/` — Bun/TypeScript CLI（`analyze` / `inspect` / `export` / `bench`）
* `cmd/`, `internal/` — Go 版原型（純標準庫，零外部依賴；目前作為對照實作）

## 用法（Bun）

```bash
cd ts
bun run src/cli.ts analyze D:\accelon3\yinshun\yinshun.adb --top 12   # 結構 + metainfo
bun run src/cli.ts inspect D:\accelon3\yinshun\yinshun.adb           # 容器/行表摘要
bun run src/cli.ts export  D:\accelon3\yinshun\yinshun.adb -o out    # 匯出 XML
bun run src/cli.ts export  x.adb -o out --text adbjs                 # 逐位元組比對 JS 移植用
bun run test/verify.ts                                              # 12 項黃金測試
bun run test/index-match.ts                                         # 反向索引對拍認證
bun run tools/compare-index.ts <adb> --json index.json              # 重建索引並與 adb 內建索引逐位置比對
bun run tools/xml-lint.ts <adb|目錄>                              # XML 結構檢查（標籤堆疊/裸 &/屬性/宣告）
```

反向索引複刻（Delphi `TIndexer` 的 TS 版，見 [SPEC.md](SPEC.md) §15）：對 `yinshun.adb` 重建
**9,516 個 token / 7,256,439 個命中，逐 token、逐位置與 adb 內建索引完全一致**（`test/index-match.ts` 認證）。

`export` 的文本語義（兩者都已用獨立參考逐位元組驗證，見 [SPEC.md](SPEC.md) §7.4）：

| `--text` | 佈局 | 每塊行首 BOM | 跨塊代理對 | 行首 CR/LF |
|---|---|---|---|---|
| `delphi`（預設） | 固定步長網格（`i*srcblocksize`） | 保留 | 保留成一個字 | 跳過 |
| `adbjs` | 緊密拼接 | 丟棄 | 轉成兩個 U+FFFD | 不跳 |

`analyze` 會輸出：容器清單與大小、文字塊統計（塊數/壓縮/解壓/末塊）、行表與其他 tables 條數、
**unigram token 統計**（distinct/命中數/覆蓋率/CJK-ASCII 分佈/top N）、標籤清單與命中數、
**resources（圖片）統計**（數量/位元組/副檔名分佈）、**`集` 標題**與 **`檔` 文件清單與檔名**。

全庫掃描（93 個庫、11.24 GiB、47 億字、37 秒）：

```bash
bun run tools/scan-corpus.ts D:\accelon3    # -> build/corpus-scan.tsv
bun run tools/corpus-summary.ts             # 彙總表（見 SPEC.md §14）
```

範例（yinshun.adb，23.8 MiB，約 82 ms）：

```
text    : 1081 blocks, 8.2 MiB compressed -> 16.9 MiB text (8,847,831 chars)
tokens  : 9516 distinct, 7,256,439 hits; unigram 5712 distinct / 7,235,148 hits / 99.7%
          top: ，485377  的208635  。204939  是118657  一96937
tags    : 129 distinct -> 段41660 頁16994 聯13920 註11854 釋11853 節1570 經1563
resources: 457 files, 2.1 MiB, images 456 (99.2%)  .png:456
```

## 需求

* Bun ≥ 1.1（`bun run`）
* 匯出/深度分析需要 bzip2 解碼器：優先用 `libbz2`（`bun:ffi`，路徑可用 `ABX_LIBBZ2` 指定），
  找不到時回退到內附的純 JS 解碼器 `ts/src/vendor/bzip2.js`（可由 adbjs 的 MIT 授權程式碼而來）。

## 用舊 Accelon3.exe 驗收的小型測試檔

`ash
cd ts
bun run test:small        # 抽取 yinshun 前 10 個文件 -> build/yinshun-small.adb
`

產物：uild/yinshun-small.adb（約 3.55 MiB、42,280 行、51 張圖含 yinshun_logo.png）、uild/yinshun-small-report.json、以及子集抽取目錄 uild/yinshun-small/（XML + resources + manifest）。

驗收方式：用舊的 accelon3.exe 開啟 uild/yinshun-small.adb，確認可瀏覽、搜尋、顯示圖片。程式改動後重跑 un run test:small 即可重新產生同一份檔案再測。
