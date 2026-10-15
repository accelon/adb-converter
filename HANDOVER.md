# 技術交件：Accelon3 `.adb` 解析、匯出與重建（Bun / TypeScript）

本文件是本次工作的**交付說明**：做了什麼、怎麼用、驗證到什麼程度、有哪些已知限制。
格式細節請搭配 [SPEC.md](SPEC.md)（協定規格）與 [PASCAL-NOTES.md](PASCAL-NOTES.md)（Delphi 原始碼逐單元筆記）閱讀。

---

## 1. 目標與成果

| 目標 | 狀態 | 主要證據 |
|---|---|---|
| (1) 舊 ADB → **完全合法的 XML** + 完整取出圖片等 resources | ✅ 達成 | Python `xml.etree`(expat) 逐檔驗證：yinshun 45/45、13j 1/1、DFB_J 1/1、boyang 1/1、kangxizidian 2/2；圖片零遺漏（456 / 0 / 192 / 190 / 4） |
| (2) 把 indexer 移植到 Bun，能從 XML 生成**舊程式可讀的新 ADB** | ✅ 達成 | **13j.adb 僅憑 XML + manifest 重建後與原檔逐位元組相同（SHA-256 一致）**；`yinshun-small.adb`（前 10 文件）已由 **accelon3.exe 實機開啟成功，logo 與內文圖片正常顯示** |
| (3) 新舊 ADB **逐 block 比對** | ✅ 達成 | `tools/compare-adb.ts`：逐容器、逐區塊（按名稱配對），並區分「必須相同」與「允許不同」（tokens/tags 的 postings） |

---

## 2. 管線與工具

```
adb ──extract──▶ 合法 XML（每檔一份）+ resources/** + manifest.json ──rebuild──▶ 新 adb
                        │                                                          │
                        └──────────────── compare-adb ◀───────────────────────────┘
```

| 工具（`ts/` 下執行） | 說明 |
|---|---|
| `bun run tools/extract.ts <adb> -o <dir>` | 匯出：每個 `檔` 一份合法 XML；`resources/` 為原樣位元組；`manifest.json` 記錄原始 header(base64)、容器名稱/順序、`cachedTags`、`tagKeys`、`dualClosing`、`singleCharTokens`、每檔修復統計與 sha256 |
| `bun run tools/rebuild-adb.ts <dir> [-o new.adb] [--from orig.adb] [--infer]` | **從 XML 建新 adb（不需要原檔）**；`--from` 提供原檔作參照，`--infer` 自動推斷建庫參數 |
| `bun run tools/compare-adb.ts <orig.adb> <new.adb> [--strict]` | 逐 block 比對與驗收 |
| `bun run tools/xml-lint.ts <adb\|目錄> [--json]` | 掃描 XML 結構問題（標籤堆疊、裸 `&`、未閉合、未宣告標籤、`tags.virtual` 對帳） |
| `bun run tools/make-small.ts <adb> [--docs 10]` | **產生給舊 EXE 驗收的小型 adb**（只留前 N 個文件 + 用到的圖片 + logo） |
| `bun run test/verify.ts` / `test/index-match.ts` | XML 黃金測試 12 項；反向索引逐 token 認證 |
| `bun run test:small` | **固化驗收**：抽取 yinshun 前 10 文件 → `build/yinshun-small.adb` → 自我驗證 |

模組（`ts/src/`）：`format`（容器/表格解析）、`decode`/`bz2`（bzip2 解壓與 libbz2 壓縮）、`textstream`、`tokenize`（Delphi 分詞器移植）、`dia`（重音表，由 Pascal 生成）、`unicode`（空白/可忽略判定與 TNT Trim）、`index-builder`（索引器移植）、`packedlist`、`romblock`、`crc32`、`sort`（Delphi 不穩定 quicksort）、`adbwrite`、`adbtext`、`xmlrepair`、`resources`、`han`。

---

## 3. 驗證結果

### 3.1 13j.adb（2,252,537 B）

```
extract → rebuild（不給原檔）→ 與原檔逐位元組相同
SHA-256 5eacedd292c1ef29… == 5eacedd292c1ef29…
容器：source 102/102、tokens 6531/6531、tags 17/17、tables 5/5、
      attributes 6/6、caches 5/5，文字 0.8 M 碼元
```

### 3.2 yinshun.adb（24,910,598 B）

```
source 1081/1081、tokens 9516/9516、tables 5/5、attributes 76/76、
attributes.sorted 3/3、resources 456/456、文字 8.4 M 碼元  —— 全部逐位元組相同
僅：caches 48 鍵中 2 鍵（序、圖）不同；tags 的 /圖 差 3 筆（postings，規格允許）
```

### 3.3 實機驗收（由使用者執行）

```
accelon3.exe 開啟 build/yinshun-small.adb：
  可開啟、可瀏覽、logo 與內文圖片正常顯示  ✅
  （3.75 MiB、42,280 行、52 張資源）
```

---

## 4. 已釘死的關鍵規則（實作依據）

完整版見 [SPEC.md](SPEC.md) §15、§17.3。要點：

* **虛擬位址**：索引 token `+1`、空白 token `+1`、非 skip 標籤 `+4`（`TAGLENGTH`）；`header.maxblockoffset := voff`
* **分詞**：CJK 逐字；代理對取 2 碼元；IDC 用 `parseids`；`<...>`／`"..."`／`&...;` 成對；空白整段為一 token
* **文字語義**：固定步長網格（`blk*srcblocksize`）+ 每塊 NUL 結尾；行首 CR/LF 跳過
* **容器**：`16B 標頭（feature/signature/totalblocksize/blocksize）+ 資料塊 + TPackedList(累計長度)`（`boWithPointer` 再加指標表）；名稱塊為最後一個資料塊（UTF-16LE + NUL）
* **`TPackedList`**：`u32 added | floor(added/512)*8（milestone：value,Count）| varints`（非 LEB128；milestone 於跨越 512-byte 邊界時寫入）
* **CRC-32**：初值 `CRC_MAGIC=$55AA55AA`、反射式 `$EDB88320`、**欄位在 offset 252、覆蓋前 252 位元組**
* **排序**：`tokens`/`tables` 名稱按 UTF-16 碼元升序；`tags` 首次出現順序；`attributes.sorted` 內層用 Delphi **不穩定 quicksort**（平手順序已重現）；`resources` 為 `boSorted|boNamed`、名稱塊 feature 為 **`0x3`**
* **屬性**：key = `<tag>.<attr>`；空值不存；`i`(linkto) 於 `#` 截斷；docnode = `(tagid<<24)|n`，`tagid` = 標籤在 `tags` 容器的區塊索引
* **caches**：`cached` 且非 `tfSingle`；`open` 起累積原始 token（含空白），`close` 存 `trimcacheline`（去標籤、於 CR／；／。 截斷接 `…`、trim），`tkBoth` 存空字串；docnode 用**加入本實例之前**的計數；`MAXCACHELINE=256`
* **header.andtagid**：是「頁碼標籤在 `tags` 容器的區塊索引」，子集重建時必須重算（`index.pas: endbuilding` 邏輯）

---

## 5. 已知限制

1. **caches 動態宣告時機**：yinshun 的 `序`、`圖` 兩鍵仍有差異。查過 `l=`/`t=`/`s=`/`c=…cached` 四條路徑皆非其來源，推斷該旗標來自 **adb 之外的建庫定義檔**（資訊邊界）。務實解法：把「每個 cached 標籤的起始序號」由原檔反推成建庫參數。
2. **per-tag `tfDontCare`**：自閉合標籤是否同時寫入 `/x`（雙索引）依建庫定義檔；已由「原檔是否有 `/x` 鍵」逐標籤判斷，yinshun 的 `/圖` 仍有 3 筆差異（屬 postings，規格允許）。
3. **Pascal 行尾越界讀**：`nextLiteral` 在行尾未閉合 `<` 時會讀進下一行緩衝區；本實作採規範版本（行尾停止），故少數 token 命中數略少（DFB_J 少 56）。
4. **合法化修復不可逆**：為讓 XML 合法，抽取器會刪除 C0 控制字元、逃脫裸 `&`/`<`、補缺漏收尾標籤 → 這些庫的文字與原檔不同（規格允許，但 block 內容因此不同）。
5. **尚未做的批次統計**：全 93 庫的「抽取 → 獨立重建 → 比對」統計。

---

## 6. 倉庫內容與不上傳規則

`.gitignore` 已排除：**所有 `.adb`、`.xml`、`build/`（中間產物）**、`sourcecode/`（Delphi 參考原始碼，非本次產出）、以及暫存/日誌。

上傳的是**關鍵程式碼與文件**：

```
ts/src/*.ts            解析、分詞、索引器、寫入器、修復、資源、工具模組
ts/tools/*.ts          extract / rebuild-adb / compare-adb / xml-lint / make-small / roundtrip-* …
ts/test/*.ts           黃金測試與反向索引認證
SPEC.md                協定規格（含 §15 索引複刻、§17 管線與驗證狀態）
PASCAL-NOTES.md        Delphi 原始碼逐單元筆記
FORMAT.md              早期英文逆向筆記
README.md              快速上手
HANDOVER.md            本文件
go/、cmd/、internal/   Go 版交叉實作（次要，未同步新規則）
```

---

## 7. 如何重跑驗證

```bash
# 1) XML 合法性（需要 Python）
python build/xml-check.py <抽取目錄>

# 2) 反向索引對拍（9,516 token / 7,256,439 命中）
cd ts && bun run test/index-match.ts

# 3) XML 黃金測試（12 項）
cd ts && bun run test/verify.ts

# 4) 位元組級 round-trip（整檔重寫比對）
cd ts && bun run tools/roundtrip-adb.ts <adb>

# 5) 只憑 XML 重建 + 逐 block 比對
cd ts && bun run tools/rebuild-adb.ts <抽取目錄> -o new.adb
cd ts && bun run tools/compare-adb.ts <原檔.adb> new.adb

# 6) 舊 EXE 驗收檔（固化）
cd ts && bun run test:small     # -> build/yinshun-small.adb
```

---

## 8. 後續建議

1. 用舊 EXE 開 `build/stand13j.adb`（與原檔逐位元組相同）與 `build/newyinshun.adb`，擴大實機驗收範圍。
2. 若你手上有各庫的**建庫定義檔（docdef）**，可一舉解決限制 1、2。
3. 全庫批次統計（93 庫）與 Go 版同步新規則。
