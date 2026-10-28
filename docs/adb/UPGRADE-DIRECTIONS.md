# ADB 格式的三個改進方向：容器、索引、轉 Offtext

> 目的：以目前**已驗證**的 `.adb` 知識為基礎，分別討論（一）容器格式、（二）索引結構、
> （三）檔案格式轉換到 `D:\2026\offtext` 的升級路徑，並給出三者的先後次序與驗收方式。
>
> 立場：這是一份**取捨文件**，不是規格書。每個方向都給出「現況 → 可選方案 → 建議 → 何時回頭」。
> 文中數字若標「估」代表估算，其餘都有實測或文件依據（見附錄 C）。

## 摘要（先講結論）

1. **容器**：閱讀器不缺這個；缺的是「新產物」的存檔格式。建議 adb v0 凍結為遺產唯讀格式，
   另外做一個唯讀、不可變、64 位、footer 目錄、per-chunk CRC 的 v3；**不要**做增量資料庫。
2. **索引**：三段之中投報率最高。先把字典與 postings 分離、postings 分塊、每 256 筆加 skip；
   再加 df／tf 與欄位化屬性。這解決 lawtw 240k 詞、6.4 MiB 單一 posting 的隨機讀問題。
3. **轉換**：不要整庫轉。以「文件／章」為單位，用 standoff（純文字＋位置表）避開 XML 合法化；
   先 fgdict（22,648 條，最接近 offtext）再 13j（結構）最後 yinshun（註）。
4. **順序**：價值排序是轉換 > 索引 > 容器；依賴排序才是容器 < 索引 < 轉換。先做 90 天計畫的
   P0（fgdict 投影），用真實資料決定其餘兩項要不要做。

---

## 0. 基線：我們現在確定什麼

### 0.1 已釘死的事實

| 層面 | 事實 | 依據 |
|---|---|---|
| 容器 | 256 B 檔頭 → 16 B 容器頭 → 資料區 → packed 長度表（變長時）；`boNamed` 的名稱表是**最後一個資料塊** | [SPEC.md](./SPEC.md) §3–§5、[FORMAT.md](./FORMAT.md) |
| 定址 | 全部 offset 是 **32 位**（`totalblocksize`、`maxblockoffset`、`linecount`、`tagcount` 都是 Delphi `integer`） | `basetype.pas`、`romblock.pas` |
| 文字 | UTF-16LE；PA = `blockIndex × 16384 + 區塊內位移`；行界由累積表提供 | [SPEC.md](./SPEC.md) §7–§8 |
| 索引 | `tokens`／`tags` 是「一鍵一區塊」的 VA 命中表；`attributes` 是值＋擁有者指標；`caches` 是預先算好的字串 | [SPEC.md](./SPEC.md) §6、§9–§10 |
| 重建 | 只憑 XML 重建 `13j.adb` 與原檔**逐位元組相同**；yinshun 11 個容器 10 個相同 | [HANDOVER.md](./HANDOVER.md) §3 |
| 反向索引 | yinshun 9,516 個 token、7,256,439 個命中，**逐位置相同** | [SPEC.md](./SPEC.md) §15.4 |
| 語料 | 93 庫、11.24 GiB、4,714,981,075 字、3,620,798,231 個 token 命中、575,604 個 source 塊 | [SPEC.md](./SPEC.md) §14 |
| 讀取 | yinshun 開檔 60 ms（原 3,525 ms）、翻頁約 90 ms；taisho（241 MB）靠行表把 `elementAt` 從 >25 s 降到 4.5 ms | [ACCELON26-HANDOVER.md](../system/ACCELON26-HANDOVER.md) §5 |
| Range | lawtw 列 token 只需讀名稱塊 **4.05 MiB**（不用讀 286 MiB 的 postings）；單一 posting 最大 **6.4 MiB** | [adbviewer-http.md](../system/adbviewer-http.md) §1 |
| 完整性 | 檔頭 CRC 只在 `version ≥ $50902` 時檢查；現有語料 `version = 0`，等於**沒有**完整性檢查 | [SPEC.md](./SPEC.md) §3 |

### 0.2 三個容易誤判的地方

1. **milestone 表不能拿來省解碼。** 實測 `Count` 與實際條數不符（yinshun 1,321/1,333、13j 379/382），
   現有讀取器全部跳過它。任何「用 milestone 隨機存取」的設計，必須先重新驗證 `value` 的語義。
2. **token 名稱不能轉 UTF-8。** 93 庫中有 18 庫、362 個名稱含未配對代理（例如 13j 的 `⿱艹\ud85a`）；
   一經 UTF-8 編解碼就變成 U+FFFD，無法還原，也無法再與 adb 比對。
3. **VA 走訪不可信。** fgdict 的 `elementAt` 會漂移（最差 +94,246），行表才是 ground truth。
   任何新索引若需要「VA→PA」，必須以 `lines.virtual`／`blocks.virtual` 為準。

### 0.3 成本模型已經換了

`.adb` 是 CD-ROM 時代的格式：seek 幾十到幾百毫秒、順序讀便宜、容量小。它的每一個決定都在省 seek。
2026 年的稀缺資源完全不同：

| 舊假設 | 新現實 | 對格式的含義 |
|---|---|---|
| random seek 很貴 | SSD seek ~50 µs；HTTP Range 是 1 個 RTT | 單檔不再是唯一答案；「幾次小讀取」可以接受 |
| 容量有限 | 磁碟便宜；**瀏覽器記憶體**與**網路流量**才是上限 | 不該把 286 MiB 的索引整包丟給前端 |
| 寫入是一次性出版 | 內容會持續修訂、增量合併 | 唯讀存檔與編輯格式要分開 |
| CPU 不是瓶頸 | 手機解 bzip2 很貴；建索引是 CPU 密集 | codec 要可選；索引要預先編譯 |
| 索引先算好＝快 | 先算好的代價是**重算整庫** | 索引要能區域重建／分段 |

**判準**（後面每個方案都用這六條評分）：

1. 正確性可驗證（能重現、能 diff、能回歸）
2. 冷啟動（開檔到第一屏）
3. 查詢延遲與**跨網路抓取的位元組數**
4. 重建／增量成本
5. 可演進（版本、schema、工具鏈）
6. 向後相容（`accelon3.exe`、既有 `.adb`、既有驗收）

---

## 1. 方向一：容器格式

### 1.1 現況的七個硬邊界

| # | 邊界 | 具體 | 什麼時候會痛 |
|---|---|---|---|
| 1 | 32 位尺寸 | 單一容器資料區 ≤ 2 GiB；`maxblockoffset` 約 ≤ 2.1×10^9；VA 總長受限 | 合庫、超大工具書、把整批語料裝一檔 |
| 2 | 8 位 tag id | 不同標籤名 > 255 直接 assert；docnode 的 `n` 只有 24 位（單標籤 ≤ 16,777,215 命中） | 新標籤體系、把多庫合併 |
| 3 | 沒有區塊級校驗 | 檔頭 CRC 在 `version = 0` 時不檢查；沒有任何 per-block hash | 靜默損壞、傳輸截斷、備份比對 |
| 4 | 只有 bzip2、固定 16 KiB | 無 codec 選擇；16 KiB 對 bzip2 而言偏小（比率與 CPU 都不理想） | 手機、低階機、超大庫 |
| 5 | 整檔重寫 | 寫入器在記憶體組裝整檔；改一個字要重建所有容器 | 11 GiB 語料的維護、增量出版 |
| 6 | 目錄在資料裡 | 名稱表是最後一個資料塊；列 token 要讀完整個名稱塊（lawtw 4.05 MiB） | 遠端開庫、詞表瀏覽 |
| 7 | 沒有 manifest／schema | 沒有格式版本協商、沒有來源／授權／雜湊、沒有欄位型別 | 長期保存、工具鏈、跨語言實作 |

> 注意：這些邊界**目前沒有一個擋住閱讀器**。yinshun 24 MB 開檔 60 ms、taisho 241 MB 可讀。
> 所以「換容器」不是為了修 bug，而是為了**新產物**（轉換後的語料、索引包、增量出版）。

### 1.2 要解什麼、不要解什麼

要解：

* 完整性（per-chunk CRC + 全檔 hash）
* 64 位尺寸與更大的 block
* codec 可選（瀏覽器原生 vs 桌面／伺服器）
* 目錄／manifest 獨立，遠端可只讀幾百位元組
* 唯讀存檔的**可重現建置**（同樣輸入 → 同樣位元組）

不要解（至少不在第一版）：

* 增量更新、交易、並發寫入（作者在文字層編輯，編譯器重建）
* 加密／DRM（舊的 `protection`／`pw` 已是死碼）
* 把 adb 改成資料庫引擎（SQLite 已經存在，沒必要重造）

**關鍵判斷：存檔格式應該唯讀、不可變、整檔替換（atomic rename）。**
「增量」是編輯格式的責任，不是存檔格式的責任。這條如果守住，複雜度會少一個數量級。

### 1.3 三個候選

| 方案 | 優點 | 缺點 | 適用 |
|---|---|---|---|
| **A. adb v3：chunk + footer TOC 的單檔** | 3 次讀取就能開（footer → TOC → meta）；64 位；per-chunk CRC；codec 可選；Range 友善；實作小（讀寫各幾百行） | 要自己寫讀寫器與工具；沒有現成生態 | **新產物的存檔格式**（建議） |
| **B1. ZIP64** | 工具遍地、per-entry CRC、壓縮可選、中央目錄在尾端 | 不能「只解一個 entry 的一部分」；要把文字切成很多 entry 才能隨機讀，entry 數暴增（11 GiB／64 KiB ≈ 18 萬） | 匯出／交換，不當執行格式 |
| **B2. SQLite** | B-tree、交易、增量、FTS5、跨語言 | 單寫多讀；CJK 分詞要自訂 tokenizer；瀏覽器要 WASM；與「單檔雙擊」的體驗不同 | 編輯後端／索引庫，不當閱讀容器 |
| **B3. Parquet** | 欄列式、壓縮好、分析生態 | 不適合全文隨機讀；不支援「取一行文字」 | 屬性／統計的離線分析 |
| **C. 目錄包**（manifest + text/*.zst + postings/*.bin + attrs/*.parquet） | 建置／CI／git 友善；可平行；可局部重建 | 不便發佈（多檔）、容易被改壞 | **建置中間產物**（建議） |

建議的組合是 **C → A**：建置時用目錄包（可平行、可 diff、可只重建一塊），發佈時打包成 A（單檔、
可 Range、可校驗）。B 系列只在「需要交易或 SQL 查詢」時才引入，不進閱讀路徑。

### 1.4 v3 草案

```
┌──────────────────────────────────────────────────────────────┐
│ 前置頭 32 B（可選，方便 file(1) 辨識）                        │
│   magic "ADB3" (4) │ ver u16 │ flags u16 │ chunkCount u32 │ … │
├──────────────────────────────────────────────────────────────┤
│ chunk 0 … chunk n-1（依 offset 排序，4 KiB 對齊）              │
│   text / lines / dict / postings / attrs / resources / meta   │
├──────────────────────────────────────────────────────────────┤
│ TOC：chunkCount × 32 B                                        │
│   offset u64 │ compLen u32 │ rawLen u32 │ crc32c u32          │
│   id u32 │ kind u8 │ codec u8 │ flags u16                     │
├──────────────────────────────────────────────────────────────┤
│ footer 64 B                                                   │
│   magic "ADB3END" (8) │ tocOffset u64 │ chunkCount u32        │
│   tocCrc32c u32 │ fileSize u64 │ reserved                     │
└──────────────────────────────────────────────────────────────┘
```

規則：

* **開檔 3 次讀取**：尾 64 B → TOC → `meta` chunk。其餘按需。
* **TOC 大小與 chunk 數成正比**：11 GiB／64 KiB ≈ 18 萬筆 × 32 B ≈ 5.8 MiB，冷開不可接受。
  所以 chunk 要用 256 KiB–1 MiB，或把 TOC 分層（根 TOC ＋ 各 kind 的子 TOC，按需載入）；
  冷開只讀根。這是 v3 唯一需要提早決定的取捨。
* **Range 不支援時要偵測並降級**（整檔下載），不能默默用錯位元組——沿用
  [adbviewer-http.md](../system/adbviewer-http.md) §2.2 的教訓。
* **不可變**：任何修改都產生新檔，`rename` 替換；不做 in-place 更新。
* **CRC32C**（Castagnoli），不是舊的 CRC32；每 chunk 一個，TOC 自己再一個。
* **codec 逐 chunk 記錄**：`0=none, 1=deflate-raw, 2=zstd, 3=bzip2(legacy), 4=brotli`。
  瀏覽器 `DecompressionStream` 原生提供的是 deflate／gzip，zstd／brotli 需要 WASM 或宿主支援；
  遇到不認得的 codec 要能**明確報錯**，不能默默吐錯資料。
* **文字編碼逐 chunk 記錄**：`utf16le` 或 `utf-8`。CJK 為主時 UTF-16LE 的未壓縮體積較小；
  UTF-8 對 ASCII 與混合文本較好——**用實測決定，不要先驗假設**。任何情況下都不得有損轉換
  （未配對代理要嘛保留 UTF-16，要嘛以 `\uD85A` 形式跳脫，不能變成 U+FFFD）。
* **meta chunk** 是 UTF-8 JSON（≤ 64 KiB）：`schema`、`db`、`title`、`lang`、`created`、
  `source{file, sha256, headerCrc32}`、`text{encoding, chunkSize, lineTable}`、`counts`、
  `rights`、`provenance`、`notes`。
* **資源**（圖片）逐檔一個 chunk、`codec=none`，並在 meta 記 sha256；重複圖片以 hash 去重。

### 1.5 相容與遷移

1. **adb v0 凍結**：不再改格式、不再改寫既有檔。它是「遺產唯讀格式」，由 `AdbReader` 繼續支援。
2. **讀取器分派**：看 magic。`\r\nAccelon Search Engine` → v0；`ADB3` → v3。
3. **不回寫**：`13j.adb` 逐位元組相同是黃金標準，任何「順手升級 adb」的改動都會破壞它，
   且舊 `accelon3.exe` 會拒讀。新管線只**讀** v0、只**寫** v3。
4. **驗收語料**：13j、yinshun、fgdict、kangxi、lawtw、sbqs-04、taisho（涵蓋小／中／大、字典／全文、
   壞名稱／未配對代理）。

### 1.6 不要做的事

| 不要 | 理由 |
|---|---|
| 在 `.adb` 上做旁檔索引（sidecar） | 2026-02 已否決；HTTP + Range 取代了它，少一個同步問題 |
| 把 milestone 當 skip table | 實測 `Count` 不可信；先用新的 skip 表，不要賭舊資料 |
| 用 JSON 存 postings | 體積多約 20%，GC 不友善（lawtw 實測） |
| 名稱轉 UTF-8 | 362 個未配對代理會永久損壞 |
| 把 v3 做成可交易資料庫 | 複雜度爆炸，且與「單檔存檔」目標衝突 |

---

## 2. 方向二：索引結構

### 2.1 現況：五個容器＋一個字典塊，各自為政

| 結構 | 形狀 | 實測成本／限制 |
|---|---|---|
| `tokens` | 一 token 一區塊；區塊內是累積 VA 的 delta varint | 240,064 個 token（lawtw）；最大 posting 6.4 MiB；**沒有 df／tf／位置** |
| `tags` | 一標籤一區塊；VA 列表 | docnode = `tagid<<24 │ n`；範圍＝下一個命中 |
| `tables` | 累積行表／塊表 | 這是 taisho 崩潰的解法：VA→行改成二分搜尋 |
| `attributes` | 每個 `<tag>.<attr>` 一個容器；值＋擁有者指標 | `attributes.sorted` 只有 3 個鍵；沒有型別 |
| `caches` | 每標籤一個字串容器 | 免回讀原文；但與 `tokens` 一樣是「一鍵一容器」 |
| 字典 | 就是 `tokens` 的名稱塊 | 列 token 要讀完整個名稱塊（lawtw 4.05 MiB） |

### 2.2 七個結構性弱點

1. **沒有 skip／分塊**：一個 6.4 MiB 的 posting 只能整塊解壓；AND／片語查詢無法提早結束。
2. **沒有 df／tf／位置**：BM25 目前用「VA 差」近似文件長度、用命中計數當 tf；
   要做 WAND／Block-Max 就必須有 df 與 tf。
3. **字典與 postings 綁死**：沒有 offset 表，prefix／fuzzy 只能線性掃；跨庫也沒有共享詞彙。
4. **跨庫查詢要逐庫開**：`allsearch` 對每個 catalog 庫開 reader、讀 token 表；沒有全域 term id。
5. **屬性是 per-key 容器**：不是 typed column；做 facet／range／排序都要逐容器解。
6. **索引不能預編譯**：瀏覽器每次開庫重建 `SearchSession`；伺服器則是現算（雖然有快取）。
7. **沒有增量**：改一份文件＝整庫重建索引。

### 2.3 改進分級

| 級別 | 改動 | 解決什麼 | 風險 |
|---|---|---|---|
| **P0** | 字典獨立（offset＋df＋postings 位置）；postings 以 64 KiB 分塊；每 256 筆一個 skip（lastVa、byte offset） | 大 posting 的隨機讀、AND 的範圍過濾、遠端只抓需要的塊 | 低；不動 adb，只在新產物實作 |
| **P1** | 加 tf／positions（或 doc-level tf）；Block-Max；文件表（title／長度／VA 範圍） | 正確的 BM25、WAND 提早結束、摘要定位 | 中；索引變大 |
| **P2** | 屬性欄位化（typed columns）；跨庫全域 term id；預編譯二進位索引 | facet／range、跨庫搜尋、秒開 | 中高；要改前端 |
| **P3** | 分段（segment）＋墓碑＋合併 | 增量重建 | 高；與「唯讀存檔」衝突，只有編輯後端需要 |

### 2.4 P0 格式草案（index pack）

```
header   magic "ADBIDX02" (8) │ ver u16 │ flags u16 │ termCount u32
         │ docCount u32 │ dictOff u64 │ dictLen u32 │ namesOff u64 │ …
dict     termCount × {
           nameOff u32, nameLen u16,     // 指向 names blob（UTF-16LE 或 UTF-8，逐項 flag）
           df u32,                       // 文件頻率
           cf u64,                       // 總命中
           postOff u64, postLen u32,     // 第一塊的位置
           postChunks u16,               // 分塊數
           firstVa u32
         }
names    名稱 blob（可前綴壓縮：front coding）
postings 每 term：{ count u32, skip[chunkCount] { lastVa u32, byteOff u32 } }
         然後是 delta varint（沿用現有編碼，reader 已驗證）
docs     { id u32, titleRef, vaStart u32, vaEnd u32, len u32 }
```

* skip 每 256 筆一筆；超大 posting（> 1M 命中）可改成 1024，`chunkShift` 記在 term 裡。
* 字典固定欄位約 32 B／筆：lawtw 240k 詞 ≈ 7.7 MiB；名稱 blob 用 front coding 另有折扣。
  若要再小，把字典依首碼分桶、對 `postOff` 做差分（估可到 4–5 MiB，需實測）。
* 這份索引**不進 adb**，也不做 adb 旁檔；它只存在於 v3 產物或轉換後的 bundle 裡。

### 2.5 驗收

| 指標 | 方法 | 目標（估） |
|---|---|---|
| 單詞查詢 p95 | lawtw／sbqs-04 上 20 個高頻詞＋20 個低頻詞 | 低頻 < 5 ms；高頻 < 50 ms |
| 跨網路位元組 | 一次查詢抓了幾個 chunk | 低頻 1 塊；高頻 ≤ 8 塊 |
| df 正確性 | 與 `countPackedList()` 全解碼對拍 | 100% 相同 |
| 片語正確性 | 現有 `phraseMatch` 測試集 | 100% 相同 |
| 記憶體 | 開庫後 heap | lawtw < 150 MB（現況取決於是否載入全 token 表） |

> 注意：這些是**新產物**的指標，不是 adb 的。adb 路徑不動，現有 60 ms 開檔與 90 ms 翻頁不會退步。

---

## 3. 方向三：轉換到 `D:\2026\offtext`

### 3.1 兩個模型其實很像，也很不像

| 維度 | `.adb` | offtext |
|---|---|---|
| 本質 | 帶位址的標記流＋反向索引 | 條目（key→value）＋行內引用 |
| 位址 | VA／PA 雙位址；標籤佔 4 VA | 無位址；引用按 key 解析 |
| 範圍 | 標籤範圍＝到下一個同標籤 | 條目＝一行；展開＝遞迴查表 |
| 單位 | 檔（書）→ 章／節 → 行 | 科目（domain）→ 條目 |
| 索引 | 預先算好、二進位、可 Range | 執行時 `buildIndex()`、記憶體、`Map` |
| 編輯 | 整庫重建 | 改一行、存檔 |
| 規模 | 4.71 G 字、11.24 GiB | 1,831 條、196 KB、平均 33 字 |

兩邊的共同點是「**文字＋位置標記**」；差別在**粒度**與**執行模型**。

### 3.2 四個 gap（先量清楚再談工具）

1. **粒度**：offtext 的 key ≤ 16 字、value 平均 33 字、硬上限 200 字（超過不內嵌）。
   adb 一行可能數百字，一本書數十萬字。
   yinshun 8.8 M 字／45 檔 ≈ 196 k 字／檔；若每 33 字一條，**一本書約 6,000 條**；
   全庫 45 本 ≈ 27 萬條。以「章」為單位則每章數百條，才落在目前執行模型可承受的範圍。
2. **語意**：adb 的標籤是**版面**（h1–h6 的推廣），不是知識鏈結；`註`／`釋` 才是「注中有注」的原料，
   `聯` 才是跨檔鏈結，`頁` 是里程碑。把它們直接當成 offtext 的引用，會得到一棵目錄樹，不是 DAG。
3. **規模**：offtext 現在一次載入全部 TSV、在瀏覽器建索引。4.71 G 字不可能；
   即使一本 664 MB 的庫（四庫全書集部）也不可能。全語料只有 **1,062 個 `檔`**（62 庫有 `檔`），
   所以「檔」是合理的轉換單位——但單檔仍可能 20 萬字（yinshun），要再下切到「章」。
   **轉換單位必須是「文件／章」，不是「庫」。**
4. **表達力**：TSV 只有 `key<TAB>value`；沒有 id、沒有錨點、沒有零寬標記、沒有來源欄位、
   不能存 tab／換行。這些正是 adb 內容需要的。

### 3.3 映射規則（草案）

| adb | offtext | 說明 |
|---|---|---|
| `檔`（FILE） | domain（或 domain 的 `parent`） | 檔名 `n=` 可當 id；一本書一個 domain |
| `集`（COLLECTION） | domain 的 `name`／meta | 資料庫標題 |
| `書`／`冊` | domain 群組或 TOC 條目 | 多書庫（13j、fgdict）才有 |
| `樹`＋`t=` | 目錄（TOC） | 由 `t=` 決定層級；沒有 docdef 時先用標籤順序 |
| `章`／`節`／`項` | 條目 key（標題） | 標題 > 16 字要截斷，另存穩定 id |
| 段落（行） | value（長文模式）或拆句 | **不要每行一條**；行是版面，不是概念 |
| `註`／`釋` | 註條目＋零寬標記 | 這是「注中有注」的核心；範圍語義要逐庫確認 |
| `頁`／`頁元` | 錨點 `^pg3`（或 `^pg<id=3>`） | 零寬；可做原書分頁 |
| `圖`／`嵌圖` | 圖片 offtag＋resources | `n=` 對到資源檔名 |
| `聯`（`i=`） | `^[目標]` 或 URL offtag | `i=` 在 `#` 截斷；目標不存在時不可硬連 |
| `隱`／`粗` 等 | 樣式 offtag 或忽略 | 不影響知識層 |

**最重要的一條：用 standoff（純文字＋位置表），不要走「合法 XML」路線。**
`extract.ts` 的 XML 合法化會刪控制字元、逃脫 `&`／`<`、補收尾標籤，這些是**不可逆**的
（[SPEC.md](./SPEC.md) §17.4）。而 standoff 只需要「文字」與「標籤位置」，不平衡、裸 `&`、未閉合
都不影響；這正好也是 adb 的本來面目（[accelon-vs-tei.md](./accelon-vs-tei.md) §1）。

### 3.4 四階段路徑

#### P0：無損投影（機械、可完全驗證）

產物（每個庫一份）：

```
out/<db>/
  manifest.json          # 來源 hash、header、容器清單、統計
  text/<doc>.txt         # 逐檔原文（UTF-16LE 或 UTF-8 + 跳脫；不修復）
  offtags.tsv            # doc, tag, id, start, end, attrs（位置＝UTF-16 碼元）
  resources/**           # 原樣位元組 + sha256
```

驗收：

* 重組文字與 adb 原文逐字元相同（不是「合法 XML 相同」）。
* adb 中每個標籤實例恰好對到一筆 offtag；`tags.virtual` 對帳相等。
* 資源零遺漏、hash 相符。

工具：`extract.ts --no-repair` 取文字；位置由 `tokenize.ts`＋行表重算（**不要**用 VA 走訪）。
試點：**fgdict**（19 MB、22,648 個 `詞`、定義型內容）——它本來就是「一條一詞」，最接近 offtext；
其次是 **13j**（2.1 MB、13 書、4.2 萬行），測結構與頁碼。

#### P1：結構與註（半自動）

* 由 `t=`／`樹` 建 TOC；標題→條目；`頁`→錨點；`圖`→圖片；`聯`→引用。
* `註`／`釋`：抽成註條目，於錨點插入零寬標記（需要 offtext 先支援，見 3.5）。
* 產出「覆蓋率報告」：標題覆蓋、註覆蓋、斷鏈清單、超長 value 清單。

驗收：每個標題都有條目；每個註都有錨點；斷鏈率 < 0.5%（或全數列出待人工處理）。

#### P2：知識化（editorial／LLM，不可全自動）

* 依 `goal.md` 第 4 點：把一本書濃縮成 offtext；每條 30–90 字、1–4 個引用。
* 建立 DAG（`knowledge.md`）：高階概念由基礎概念組成；用 `knowledge-audit` 驗證環與反轉。
* **保留 provenance**：每條記來源 `db/doc/VA 範圍`，可回溯原文。

驗收：符合 `subject-spec.md` 的自檢表；DAG 無環、層級反轉低於門檻；人工抽樣 20 條。

#### P3：執行環境（offtext 端）

* domain 延遲載入（先 TOC，再按需抓 text chunk）；預編譯索引；伺服器端搜尋。
* 大 domain 的虛擬滾動；匯出只含可達子集。

驗收：10 M 字的 domain 開檔 < 1 s、記憶體 < 200 MB、搜尋 p95 < 100 ms（估）。

### 3.5 offtext 需要先補的能力

| 能力 | 現況 | 為什麼需要 | 相容做法 |
|---|---|---|---|
| 零寬標記 | parser 只認 `^[...]` | 頁碼、註錨點不能改變閱讀文字 | 先支援 `^name#id` 與 `^name<attrs>`（basicofftag 的子集），沒有 `[` 即零寬 |
| 條目 id | key 即識別 | 標題 > 16 字、同科同名、改名 | 另建 `ids.tsv`（key→id）或在 meta 放對照；**不要加第三欄**，現行 parser 會把 tab 之後全當 value |
| 長文 value | 內嵌上限 200 字 | 字典定義、段落 | 超過上限改為「區塊展開」，或外部 text chunk |
| 跳脫 | 不能存 tab／換行 | 原文含 tab、多行 | `\t`／`\n` 跳脫；或匯入內容用 JSONL |
| 錨點／註／圖 | 只有引用 | P1 的產物 | offtag 型別＋渲染規則 |
| domain 階層 | 扁平 | 書→章→節 | meta 加 `parent`；TOC domain |
| 預編譯索引 | 每次 `buildIndex()` | 10^5 條以上 | 建置時產生 binary index |
| provenance | 無 | 回溯、授權 | meta／條目可選欄位 |

這些都是**向後相容的加法**：既有 TSV 不動，新欄位可選，編譯器把超集正規化成現行格式。

### 3.6 規模策略

* **一次一本書（或一章）**，不是一次一庫。domain 數量可以很多，但同時載入的很少。
* 先做**詞典庫**（fgdict 22,648 條、kangxi 46,024 條）：條目界線清楚、價值密度高、可驗證。
* 散文庫（yinshun、taisho、四庫）先做「結構＋註」，知識化只挑高價值篇章。
* 不做「全語料上網」：4.71 G 字不是瀏覽器的目標；目標是「讀一本書時，旁邊有一層可展開的知識」。

### 3.7 風險

| 風險 | 影響 | 對策 |
|---|---|---|
| 沒有 docdef | 層級／`cached`／`tfDontCare` 不可知，TOC 可能錯 | 逐庫抽樣；必要時以 `t=` 與標籤順序近似；文件標明 |
| 未配對代理 | UTF-8 轉換損壞 | 保留 UTF-16 或跳脫；P0 加檢查清單 |
| XML 修復不可逆 | 文字與原檔不同 | 走 standoff、用 `--no-repair` |
| 授權 | 不能公開散布 | 轉換前先標 rights；只做本機／私有 deployment |
| 編輯成本 | 知識化無法自動 | 先做「結構＋註」的自動層，知識層按書排優先序 |
| 雙軌維護 | adb reader 與 offtext runtime 分叉 | 明確分工：adb 唯讀遺產、offtext 新寫入；不互相回寫 |

---

## 4. 三者的耦合與先後

### 4.1 依賴關係

```
依賴方向（誰需要誰）：

    轉換 P0／P1 ──需要──▶ 容器或目錄包（放 text＋offtag＋resources）
    轉換 P2／P3 ──需要──▶ 索引 ──需要──▶ 容器
    容器 ──不依賴其他方向

價值方向（哪個先做）：

    轉換  >  索引  >  容器
```

但**施工順序相反**：先做轉換的 P0（不需要新容器、不需要新索引），用真實資料逼出需求；
P1 只需要 offtag 的位置與錨點；索引是 P2／P3（搜尋、大 domain）才需要；容器則等「多檔／大檔／校驗」
真的成為問題。所以三者的**價值排序**是轉換 > 索引 > 容器，**依賴排序**才是容器 < 索引 < 轉換。

### 4.2 取捨對照（粗估）

| 方向 | 投報率 | 前置依賴 | 工作量（人日，估） | 主要風險 |
|---|---|---|---|---|
| 容器 v3 | 閱讀器低／新產物中 | 無 | 15–20 | 自寫格式與工具鏈；容易過度設計 |
| 索引 P0 | 高（大庫查詢、遠端流量） | 無（另建產物） | 10–15 | 與現有 postings 逐位元對拍 |
| 轉換 P0／P1 | **最高**（產品價值） | offtext 少量擴充 | 20–30 | 語意判讀、授權、編輯成本 |

> 工作量只算「工程」，不含知識化（P2）的編輯與審稿；那部分以「每本書」計，不能用人日估。

### 4.3 90 天建議

| 週 | 工作 | 產出 | 驗收 |
|---|---|---|---|
| 1–2 | fgdict → P0 投影 | `out/fgdict/`（text＋offtags＋resources） | 文字逐字元相同；22,648 個 `詞` 全對到 |
| 3–4 | offtext 加零寬標記＋id＋長文（向後相容） | 可載入 P0 產物的最小 reader | 既有 16 科測試全綠 |
| 5–6 | 13j → P1（TOC／章節／頁碼） | 可瀏覽的 13 經 offtext | 標題／頁碼覆蓋 100% |
| 7–8 | index pack P0（字典＋分塊＋skip） | lawtw／13j 對拍 | df 100%、p95 達標 |
| 9–10 | v3 規格＋讀寫器（先不接前端） | `adb3` CLI＋黃金測試 | 6 個庫 round-trip；CRC 可偵測損壞 |
| 11–12 | yinshun 註試點＋決策回顧 | 報告＋下一步 | 依 §5 指標決定是否全量 |

> 若目標是「AI 編輯、以紙書事實為依據」，優先序要再改一次：**引用與驗證 > 檢索索引 > 證據容器**。
> 理由與 schema 見 [OFFTEXT-FACT-LAYER.md](../system/OFFTEXT-FACT-LAYER.md)。

### 4.4 決策點（什麼情況下不要做）

* **如果 offtext 只服務手寫的 10^4 條**：不要做容器、不要做 index pack；只補零寬標記與長文即可。
* **如果 `accelon3.exe` 相容是硬需求**：永遠不要改 adb；新格式只能是**額外**產物。
* **如果主要通道是網站而非桌面**：codec 與 Range 的權重上升，bzip2 應淘汰，deflate／brotli 優先。
* **如果沒有授權**：轉換只做本機，不進公開站；先把 rights 欄位做出來。

---

## 5. 量測與驗收（怎麼知道改對了）

### 5.1 固定測試語料

| 庫 | 用途 | 特徵 |
|---|---|---|
| 13j（2.1 MB） | 黃金回歸 | 逐位元組重建、無資源、1 檔 |
| fgdict（19 MB） | 詞典／長文 | 22,648 詞、7 書、資源 |
| yinshun（24 MB） | 註／多檔 | 45 檔、456 圖、9,516 token |
| kangxi（11 MB） | 字典／BOM／代理對 | 46,024 字、跨塊代理對 |
| lawtw（~300 MB） | 大索引 | 240,064 token、197 M 命中 |
| taisho（241 MB） | 大庫／行表 | 87.9 M VA、4.98 M 行 |

### 5.2 指標

| 類別 | 指標 | 量法 |
|---|---|---|
| 正確性 | 文字 hash、標籤數、df、片語結果 | 與現有 extract／compare-index 對拍 |
| 冷啟動 | 開檔→第一屏 | `performance.now()`；三個 percentile |
| 查詢 | p50／p95；抓取位元組 | 20 高頻＋20 低頻＋10 片語 |
| 索引 | 體積、建置時間、記憶體 | 建置腳本輸出 |
| 轉換 | 覆蓋率、斷鏈、超長、人工抽樣 | P0／P1 報告 |
| 回歸 | 13j 逐位元組、yinshun 10/11 容器 | 既有 `compare-adb` |

### 5.3 不可退步的清單

1. `13j.adb` 重建逐位元組相同。
2. yinshun 的 source／tokens／tables／attributes／resources 位元組相同（caches 2 鍵、tags 3 筆除外）。
3. 反向索引 9,516／7,256,439 逐位置相同。
4. accelon26 的 file-protocol 測試（13j 159、yinshun 182、fgdict 173）全綠。

---

## 6. 一句話總結

* **容器**：不要為了閱讀器換容器；為「新產物」做一個唯讀、可校驗、64 位、footer 目錄的 v3，
  adb 凍結成遺產格式。
* **索引**：投報率最高。先把字典與 postings 分離、分塊、加 skip；再談 tf／df 與欄位化。
* **轉換**：以「文件／章」為單位、用 standoff 避開 XML 合法化；先 fgdict 再 13j；
  offtext 先補零寬標記、id、長文、延遲載入——這些都是加法，不動既有 16 科。

---

## 附錄 A：v3 讀取流程（偽碼）

```
open(rangeReader):
  footer = read(size-64, 64)
  assert footer.magic == "ADB3END"
  toc = read(footer.tocOffset, footer.chunkCount*32)
  assert crc32c(toc) == footer.tocCrc32c
  meta = fetchChunk(toc, "meta")          # 驗 CRC、解 codec、JSON.parse
  return Reader(meta, toc, rangeReader)

fetchChunk(toc, id):
  e = toc[id]
  raw = read(e.offset, e.compLen)
  assert crc32c(raw) == e.crc32c
  return decode(e.codec, raw)
```

## 附錄 B：adb → offtext 檢查清單（P0 用）

- [ ] `extract.ts --no-repair` 的文字與 adb 原文逐字元相同
- [ ] 每個 `tags` 實例都有 offtag；`tags.virtual` 對帳相等
- [ ] `檔` 的 `n=` 全部取得（caches → `.id` → `.n` → 原文四步）
- [ ] 資源數與 sha256 全部相符
- [ ] 未配對代理／內嵌 NUL 清單為空，或已標記
- [ ] 超長行（> 8192 B）與超長 value 清單已產出
- [ ] 每個 `註`／`釋` 的範圍已人工抽樣確認
- [ ] TOC 深度與 `t=` 宣告一致（抽樣 3 庫）

## 附錄 C：資料來源

* 格式與驗證：[FORMAT.md](./FORMAT.md)、[SPEC.md](./SPEC.md)、[HANDOVER.md](./HANDOVER.md)、[PASCAL-NOTES.md](./PASCAL-NOTES.md)
* 讀取器與效能：[ACCELON26-HANDOVER.md](../system/ACCELON26-HANDOVER.md) §4–§5、[architecture.md](../system/architecture.md)
* Range 與 sidecar 的教訓：[adbviewer-http.md](../system/adbviewer-http.md)、[adbviewer-sidecar.md](../system/adbviewer-sidecar.md) §2
* 標記模型：[accelon-vs-tei.md](./accelon-vs-tei.md)
* offtext：[datastructure.md](../../../offtext/datastructure.md)、[tech.md](../../../offtext/tech.md)、
  [basicofftag.md](../../../offtext/basicofftag.md)、[subject-spec.md](../../../offtext/subject-spec.md)、[goal.md](../../../offtext/goal.md)
* 本文件實測：offtext `data/*.tsv` 共 16 檔、1,831 條、290 個對照頁、2,322 個引用、196 KB、
  平均 value 33 字（最大 596）。
