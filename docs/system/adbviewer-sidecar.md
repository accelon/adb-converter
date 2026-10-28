# Sidecar（索引旁檔）設計明細

> **狀態：本路線已作廢（2026-02）。** 現行方案是不做旁檔、只支援 HTTP + Range，索引由伺服器端建立並快取，見 [adbviewer-http.md](./adbviewer-http.md)。
> 本文件保留的原因：**§2.1（token 名稱含未配對代理，不可轉 UTF-8）與 §2.2（milestone 不可信）是實測事實，對現行方案同樣適用**；其餘（檔案配置、產生器、部署）僅供歷史參考。

對象：[adbviewer.md](./adbviewer.md) 的 viewer；上位評估見 [adbviewer-assessment.md](./adbviewer-assessment.md) §3.1。
本文所有數字都是本機實測（腳本見文末）。

---

## 1. 為什麼需要它：一個容器 328 MiB 的讀取

adb 的容器佈局是 `[16B 頭][資料區][packed 長度表]`，而 `boNamed` 的**名稱表是最後一個資料塊**。
所以「列出所有 token」在格式上等於「讀完整個 `tokens` 容器」：

| 資料庫 | tokens 容器 | 只為了「列出 token 清單」要付的下載/讀取量 |
|---|---:|---:|
| 13j | 1.16 MiB | 1.16 MiB（可接受） |
| yinshun | 10.22 MiB | 10.22 MiB（邊緣） |
| lawtw | **286.25 MiB** | 286.25 MiB（不可接受） |
| sbqs-04 | **327.87 MiB** | 327.87 MiB（不可接受） |

而「按 posting 大小排序」還要額外把 **21,978～240,064 個** posting list 全部解碼一次。

**sidecar 就是把這件事離線做一次，並只留下 UI 真正需要的摘要。**

---

## 2. 內容：四張表

| 表 | 內容 | 誰會用 |
|---|---|---|
| `tokens` | token 名稱（UTF-16LE 原樣）＋ 命中數 | 右側 token 分頁、過濾、兩種排序、二分搜尋 |
| `tags` | 標籤名＋命中數 | 右側 tag 分頁 |
| `documents` | 文件（`檔`）名稱＋虛擬位址範圍 | 左側文件清單 |
| `resources` | 資源名＋位元組偏移＋大小 | 左側圖片清單、圖片 viewer（`resources` 不壓縮，可直接抓單張） |
| `meta` | header 摘要＋每個容器的偏移與區塊數＋`blocks.virtual` | 開檔時不必再解析容器；VA→PA 定位 |

實測的容器 `feature`（yinshun，可作為產生器的對帳基準）：

```
source 0x00000000   tokens 0x10000001   tables 0x10000001   tags 0x10000001
attributes 0x10000004   attributes.sorted 0x30000004   caches 0x10000004   resources 0x30000000
header: version=0 compression=1 srcBlockSize=16384 maxBlockOffset=7676910
        tagCount=140693 lineCount=266916 andTagId=0 crc32=1532901652
```

（`0x10000000` = boNamed、`0x20000000` = boSorted、`0x40000000` = boWithPointer；
低 3 位是格式：1=hits、4=blocks。**名稱表的 feature 是內層容器的**，與此處無關。）

### 2.1 兩個必須「原樣保存」的地方（實測踩到）

**(a) token 名稱必須存 UTF-16LE，不能轉 UTF-8。**
本機 93 庫掃描結果：**18 庫、362 個 token 名稱含未配對代理**（`U+D800`–`U+DFFF` 單獨出現）：

```
jc       lone= 62/16857   "⿰丨\ud85a"  "⿰口\ud846"
thonzu   lone= 22/305734  "⿰⿱白万\ud84a"
wikipedia lone= 45/619339 "\ud800"  "\udf30"
13j      lone=  2/6531    "⿱艹\ud85a"  "\udcde"
```

若存 UTF-8（`TextEncoder`）或經過 `TextDecoder('utf-8')`，這些碼元全部變成 `U+FFFD`，
**無法還原、也無法與 adb 內的 token 名稱比對**。必須以 UTF-16LE 位元組保存，讀取時用
`TextDecoder('utf-16le')` 或 `String.fromCharCode(...u16array)`。

**(b) 名稱區塊本身可能是髒的。**
另有 **4 庫、67 筆**名稱含內嵌 NUL 與殘留位元組（寫入時的緩衝區殘渣）：

```
thonzu "⿰王⿱\u0000\u0000"        panna "⿰\u0000\u0000"        library "⿱⿰丰\u0000故"
swjz   "⿰⿱大\ud840\u0000ꮫꮫꮫꮫ"   swjz "⿰羽\ud840\u0000_note"
```

側車**不做任何清理**（清理會讓 sidecar 與 adb 不一致），顯示時才在 UI 層截斷於第一個 NUL 並標記。

**結論：`tokens.count` 必須等於 adb 內的 `tokens` 容器區塊數**，名稱逐位元組相同。
遇到「名稱陣列長度 ≠ 區塊數」的庫（例如空名稱被讀取器跳過）時，產生器要直接報錯而不是默默少寫。

### 2.2 命中數只能「逐一解碼」，沒有捷徑

`TPackedList` 的 milestone 表（每 512 B 一個 `{value, Count}`）看起來可以省下解碼，實測**不可信**：

| 資料庫 | 有 milestone 的區塊 | milestone 的 `Count` 與實際條數不符 |
|---|---:|---:|
| 13j | 382 / 6,531 | **379** |
| yinshun | 1,333 / 9,516 | **1,321** |
| lawtw | 5,239 / 240,064 | **5,205** |
| sbqs-04 | 8,017 / 21,978 | **7,978** |

所以：**命中數一律以 `countPackedList()` 解碼為準。** 成本可接受：

| 資料庫 | 全量解碼耗時 |
|---|---:|
| 13j | 17 ms |
| yinshun | 40 ms |
| lawtw（240,064 個 token） | 1.1 s |
| sbqs-04 | 0.67 s |

（這是**建 sidecar 時一次**的成本；沒有 sidecar 時，這個成本會落在使用者每次開檔上。）

---

## 3. 檔案配置 v1

單一檔案 `<db>.adbidx`（相對於 .adb 同目錄、同名），內容為：

```
┌─ 0   magic     "ABXIDX01"                     8 B
├─ 8   metaLen   u32                            JSON 區段長度（UTF-8）
├─ 12  metaJson  metaLen B                      見 §3.1
├─ …   secCount  u32                            固定 4
├─ …   secLen[4] u32*4                          tokens / tags / documents / resources 的位元組長度
└─ …   sections  依序串接                       見 §3.2–3.5
```

* 區段位移不必另存：`sectionsStart + Σ secLen[0..i-1]` 即可算出，`sectionsStart = 12 + metaLen + 4 + 16`。
* 所有整數 little endian。
* 沒有 checksum 欄位：完整性靠 §5 的身分欄位比對（別名、大小、header CRC32 已足夠）。

### 3.1 `metaJson`（UTF-8 JSON，人類可讀，方便 debug）

```jsonc
{
  "v": 1,
  "generator": "abx-mkidx 0.1 (2026-02)",
  "db": "yinshun", "dbcname": "印順法師佛學著作集",
  "identity": {                       // §5 的比對依據
    "fileSize": 24910598,
    "headerCrc32": 1532901652,        // header[0..251] 的 CRC32（SPEC §3）
    "tokensCount": 9516, "tagsCount": 129, "srcBlocks": 1081
  },
  "header": { "version": 0, "srcBlockSize": 16384, "compression": 1,
              "maxBlockOffset": 7676910, "tagCount": 140693,
              "lineCount": 266916, "dbType": 0, "andTagId": 0 },
  "containers": {                     // 開檔時不必再讀容器頭
    "source":  { "start": 272,      "dataStart": 288,      "count": 1081, "listStart": 8561639,
                 "totalBlockSize": 8561351, "blockSize": 0, "feature": 0 },
    "tokens":  { "start": 8563837,  "dataStart": 8563853,  "count": 9516, "listStart": 19263168,
                 "totalBlockSize": 10699315, "blockSize": 0, "feature": 0x10000001 },
    "tags":    { ... }, "tables": { ... }, "attributes": { ... },
    "attributes.sorted": { ... }, "caches": { ... }, "resources": { ... }
  },
  "tagNames":  ["檔", "集", "書", ...],          // 依 tag id 排序（= tags 容器區塊索引）
  "resourceNames": ["images/mc0198.png", ...],
  "docNames": ["yinshun.xml", "y01.xml", ...],   // 由 caches → .id → .n → 原文 解析後的名字
  "notes": ["yinshun 的 caches 不含 檔 鍵，文件名走 §10 第四步；caches 的 序/圖 兩鍵重建時有已知差異"]   // 品質備註，UI 可摺疊顯示
}
```

`metaJson` 對 lawtw 也只有 ~1 KiB（標籤／資源名稱很少），符合「小而易 debug」的目的。

### 3.2 `tokens` 區段（主要體積來源）

```
repeat count 次（count = identity.tokensCount，順序與 adb 的 tokens 容器一致）
    u16 units     名稱的**碼元數**（不含 NUL）
    u16*units     名稱（UTF-16LE，逐位元組取自 adb 的名稱區塊）
    varint hits   命中數（1–5 B；非 LEB128 亦無妨，此處是本檔自訂編碼，用 LEB128 即可）
```

* 名稱**不含**結尾 NUL（NUL 在 adb 內是分隔符，不是名稱的一部分）；內嵌 NUL 則原樣保留。
* 順序即 adb 的順序（UTF-16 碼元升序），因此「按 token Unicode 排序」= 原順序，「按 posting 大小排序」在讀入後本地排序。
* 因為名稱是 UTF-16LE，**排序語意與 Delphi 的 `indexofname` 完全一致**，不需要額外的對照表。
* 二分搜尋前綴過濾可直接在「碼元陣列」上做，不必先建 string。

### 3.3 `tags` 區段

```
repeat tagsCount 次
    u16 units + u16*units   標籤名
    varint hits             該標籤的命中數
```

標籤數只有 16–255（`TDocNode` 的 tag id 只有 8 位），所以這區段永遠 < 4 KiB。
viewer 要顯示 posting list 時，仍從 adb 的 `tags` 容器讀區塊（yinshun 0.25 MiB、sbqs 7.1 MiB，可接受）。

### 3.4 `documents` 區段

```
repeat docCount 次
    u32 vaStart, u32 vaEnd    虛擬位址範圍（末篇的 vaEnd = header.maxBlockOffset）
    u16 units + u16*units     顯示名稱（metaJson.docNames[i]）
```

`docNames` 放在 JSON（數量 ≤ 1,062），區段只放範圍；兩者依序對應。

### 3.5 `resources` 區段

```
repeat resCount 次
    u32 offset, u32 size      在 .adb 內的位元組位置（resources 不壓縮）
    u16 units + u16*units     資源名（metaJson.resourceNames[i]）
```

圖片 viewer 直接用 `Blob.slice(offset, offset+size)` 或 HTTP Range 取得，**不必碰其他容器**。

---

## 4. 實測體積與產生成本

| 資料庫 | tokens 容器 | sidecar v1 | gzip 後 | 相對節省 | 產生耗時 |
|---|---:|---:|---:|---:|---:|
| 13j（6,531 token） | 1.16 MiB | **33.8 KiB** | ~24 KiB | 97.2% | 17 ms |
| yinshun（9,516 token） | 10.22 MiB | **127.7 KiB** | ~92 KiB | 99.1% | < 0.1 s |
| sbqs-04（21,978 token） | 327.87 MiB | **221.7 KiB** | ~160 KiB | **99.97%** | 0.67 s |
| lawtw（240,064 token） | 286.25 MiB | **4.20 MiB** | ~3.0 MiB | 98.6% | 1.1 s |

lawtw 的 4.2 MiB 主要是 240,064 個 token 名稱本身（UTF-16LE 3.81 MiB ÷ 換算）＋命中數 varint 242 KiB；
其餘都在 250 KiB 以內。

**小庫不需要 sidecar**：`tokens` 容器 < ~32 MiB 時，viewer 直接讀容器（10 MiB 級別在瀏覽器只是一瞬間）。
全 93 庫的門檻分布（實測）：

| 門檻 | 需要 sidecar 的庫數 |
|---|---:|
| > 8 MiB | 64 / 93 |
| > 16 MiB | 50 / 93 |
| **> 32 MiB（建議預設）** | **43 / 93** |

也就是說：**用得到的庫佔一半**，但用不到的那一半完全零成本（沒有 sidecar 也能跑）。
`tokens.totalBlockSize > 32 MiB` 時，viewer 顯示「建議產生 sidecar」的一行提示即可，不要強制。

---

## 5. 產生器：`ts/tools/mkidx.ts`

```bash
cd ts
bun run tools/mkidx.ts <adb> [-o <adb>.adbidx]        # 單庫
bun run tools/mkidx.ts --dir D:\accelon3 [--jobs 4]   # 批次（93 庫）
bun run tools/mkidx.ts --verify <adb>                 # 只檢查既有 sidecar 是否過期
```

實作要點（幾乎全是既有程式碼）：

| 步驟 | 用什麼 |
|---|---|
| header／容器／名稱表 | [ts/src/format.ts](../../ts/src/format.ts)（`parseHeader`、`parseBlockSet`、`blockRange`） |
| 命中數 | `countPackedList()`（[ts/src/format.ts](../../ts/src/format.ts)），逐區塊讀取避免常駐 |
| 文件清單 | `tags.檔` 的命中表（虛擬位址範圍）＋名稱照 SPEC §10 的四步順序解析（`caches` → `檔.id` → `檔.n` → 回讀原文的標籤屬性）；yinshun 的 `檔.n` 是空字串，實際會走到第四步 |
| 資源清單 | `resources` 容器的名稱與 `blockRange` 偏移 |
| `blocks.virtual` | `tables/blocks.virtual` 解成 u32 陣列（VA→PA 定位用） |

**效能與記憶體**：對 240,064 個區塊逐一 `readAt` 是 240k 次 syscall（lawtw 1.1 s）。
若要更快，可依 §6.1 的推論批次讀取；正確性優先時先不要做這一層最佳化。

**錯誤處理原則**：

* `tokens` 名稱數 ≠ 區塊數 → 直接失敗（sidecar 會與 adb 不一致，比沒有 sidecar 更糟）。
* `parseHeader` 回 null（簽章不符）→ 拒絕產生。
* `compression` 非 0/1、`version > MINORVERSION` → 仍產生，但在 `metaJson.notes` 記錄。

---

## 6. 兩個被驗證過的「不要做」

### 6.1 不要用 milestone 猜條數
見 §2.2：1,321/1,333 不符。這條捷徑同時也是**錯誤**的，不只是不精確。

### 6.2 不要把 sidecar 併進 `.adb`
改寫 `.adb` 會破壞既有驗收（13j 逐位元組相同是目前的黃金標準），且舊 `accelon3.exe` 會拒讀。
旁檔是唯一不影響既有成果的選項；副檔名 `.adbidx` 建議加進 [.gitignore](../../.gitignore)（與 `*.adb`、`build/` 同級）。

### 6.3 不要用 JSON 當 token 表（但可以當 meta）
實測 lawtw：JSON 2.90 MiB / 30 ms vs binary 2.40 MiB / 34 ms。
`JSON.parse` 並不慢（30 ms），但體積多約 20%，且 24 萬個元素的物件陣列對 GC 不友善。
**meta 用 JSON（可讀）、tokens 用二進位（省空間）** 是兩者兼顧的折衷。

---

## 7. 完整性校驗（sidecar 與 adb 不同步時）

開檔時比對 `metaJson.identity`：

| 檢查 | 不符時的處理 |
|---|---|
| `fileSize` | 直接停用 sidecar |
| `headerCrc32`（`header[0..251]`） | 直接停用 sidecar |
| `db`（header 的 dbname） | 停用 |
| `tokensCount` / `tagsCount` / `srcBlocks` | 停用（改讀容器，較慢） |
| `generator` 版本與 viewer 支援範圍 | 停用並提示重新產生 |

停用時 **不能靜默**：狀態列顯示「sidecar 與 adb 不符，已忽略（token 清單會較慢）」。
理由：sidecar 是快取，錯了就丟掉；但使用者必須知道為什麼變慢。

---

## 8. 部署方式

| 情境 | sidecar 放哪 | 誰產生 |
|---|---|---|
| 本機 `file://` | 與 .adb 同目錄；使用者用檔案選取器**一次選兩個檔**（或選整個資料夾） | 開發者／使用者手動跑 `mkidx.ts` |
| 靜態網站（自家） | 靜態檔 `<db>.adbidx`，回應加 `Content-Encoding: gzip`（4.2 MiB → 3.0 MiB） | 發佈前批次產生 |
| 選配 Bun server | 伺服器啟動時檢查、缺了就即時產生並寫入磁碟（第二次開檔就快） | 伺服器自動 |

`.gitignore` 建議新增：`*.adbidx`（資料衍生物，不進版控，與 `*.adb` 同規則）。

---

## 9. 版本演進

* 檔頭 `magic` 已含版本（`ABXIDX01`）；viewer 不認得的版本就停用 sidecar（不報錯、不崩）。
* v2 候選（有需求再做，別提前做）：
  * 每 token 的 posting 位元組長度（讓「按命中數」之外還能按「posting 體積」排序）
  * 每文件的 token 分布（做「本篇有哪些 token」統計）
  * `tags.virtual`／`lines.physical` 的抽稀副本（目前 viewer 直接讀 `tables` 容器，最大 26.7 MiB）

---

## 10. 驗收清單（sidecar 部分）

- [ ] `mkidx.ts <13j.adb>`：tokens=6,531、命中總和=800,549、tags=17、sidecar ≤ 40 KiB
- [ ] `mkidx.ts <yinshun.adb>`：tokens=9,516、命中總和=7,256,439、tags=129、documents=45、resources=456、sidecar ≤ 140 KiB
- [ ] `mkidx.ts <lawtw.adb>`：tokens=240,064、命中總和=197,171,922、sidecar ≤ 4.5 MiB、耗時 ≤ 3 s
- [ ] round-trip：sidecar 內 240,064 個名稱為 UTF-16LE 逐位元組等同 adb 名稱區塊（含 362 個未配對代理的庫抽樣）
- [ ] 對 18 個含未配對代理的庫抽樣，確認讀出後**不經過 UTF-8**、不產生 U+FFFD
- [ ] 故意改動 adb（改 1 個位元組）後開啟，viewer 必須停用 sidecar 並顯示提示

---

## 11. 實測腳本（本文數字的來源）

| 腳本 | 量什麼 |
|---|---|
| `build/probe-sidecar.ts` | milestone 捷徑的正確性、JSON vs binary、round-trip |
| `build/probe-sidecar-size.ts` | sidecar v1 的精確體積 |
| `build/scan-names.ts` | 全 93 庫的未配對代理與髒名稱統計 |
| `build/probe-names.ts` | 單一名稱區塊的原始 UTF-16 碼元 dump |
| `build/probe-header.ts` | header 欄位與每個容器的 feature |
| `build/scan-tokens-threshold.ts` | 全 93 庫的 tokens 容器體積分布（誰真的需要 sidecar） |
