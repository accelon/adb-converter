# adbviewer 架構（HTTP + Range 版，現行方案）

本文件取代 [adbviewer-assessment.md](adbviewer-assessment.md) 的可選方案討論與 [adbviewer-sidecar.md](adbviewer-sidecar.md) 的 sidecar 路線。

**決策（2026-02）**

| 項目 | 決定 |
|---|---|
| sidecar 旁檔 | **不做** |
| `file://` | **不支持** |
| 傳輸 | **HTTP `fetch()`，伺服器支援 Range** |
| 依 posting 長度排序 | **不做** |
| token 的數量欄位 | **用 posting list 的位元組長度**（不做精確命中數） |
| token 清單 | **先給數量；優先載入漢字；英數只顯示數量** |

伺服器：[ts/tools/serve-adb.ts](ts/tools/serve-adb.ts)（單檔、零 npm 依賴、Bun，**索引路徑不需要 libbz2**）
契約測試：[ts/tools/serve-contract.ts](ts/tools/serve-contract.ts) — 對 13j / yinshun / lawtw **45/45 通過**

---

## 1. 為什麼 Range 就夠了（實測）

adb 的容器是 `[16B 頭][資料區][packed 長度表]`，名稱表是最後一個資料塊。純靜態伺服器只能整檔抓，於是「列出 token」= 抓 286 MiB。**加上 Range 之後，每一項都變成幾百位元組到幾 MiB**：

| 動作 | 精確讀取範圍 | 13j | yinshun | lawtw | sbqs-04 |
|---|---|---:|---:|---:|---:|
| 開檔（256 B header，兩次） | `0-255` | 256 B | 256 B | 256 B | 256 B |
| 容器清單（每容器 16 B 頭） | 各容器頭 | 96 B | 128 B | 96 B | 96 B |
| 每容器長度表（有變長者） | `listStart` 起 | 8 KiB | 15 KiB | 325 KiB | 88 KiB |
| **token 名稱表（只為了列出 token）** | 最後一個資料塊 | **32 KiB** | **97 KiB** | **4.05 MiB** | **108 KiB** |
| 單一 posting list（最大者） | 該區塊 | 150 KiB | 483 KiB | 6.4 MiB | 6.5 MiB |
| 單一 source 區塊 | 該區塊 | ≤ 9.8 KiB | ≤ 10.3 KiB | ≤ 9.1 KiB | ≤ 13.9 KiB |
| 單一圖片（`resources` 不壓縮） | 該區塊 | — | ≤ 212 KiB | — | — |
| `tables/blocks.virtual`（VA→PA） | 該區塊 | 91 KiB | 703 KiB | 20.6 MiB | 26.7 MiB |

**沒有任何一項需要解碼 posting payload。** token 的「數量」欄位改用 **posting list 的位元組長度**，它直接從長度表得出：

```
postingBytes(i) = ends[i] - (i ? ends[i-1] : 0)
```

這個量之所以夠用（實測，見 §3.1）：它與真實命中數的**排序相關性幾乎是 1.0**（lawtw 前 200 名 0 次逆序、前 20 名完全重疊），而取得成本是

| 資料庫 | 位元組長度（免解碼） | 精確命中數（需解碼） | 加速 |
|---|---:|---:|---:|
| 13j（6,531） | **3 ms** | 16 ms | 5× |
| yinshun（9,516） | **1 ms** | 49 ms | 49× |
| lawtw（240,064） | **12 ms** | 1,098 ms | **92×** |
| sbqs-04（21,978） | **3 ms** | 674 ms | 225× |

連帶的三個簡化：

1. **伺服器不再需要 libbz2**（索引與計數全部來自 header + 長度表）；`--js-decoder` 可切換純 JS 後備，只有 `/block/source/<i>` 真的需要解壓。
2. `tables/doclengths` 的文件數也用同樣方式得到（`ends[i]-ends[i-1]`），不必解碼。
3. 開檔路徑完全不碰 `tokens` 容器的 286 MiB，也不再讀取任何 posting 區塊。

---

## 2. 伺服器契約

```bash
cd ts
bun run tools/serve-adb.ts --port 8787 --root D:\accelon3 --cors '*'
```

| 端點 | 回傳 | 用途 |
|---|---|---|
| `GET /api/db/<relpath>` | 原始位元組，**支援 Range**（206 / 416 / multipart、`ETag`、`If-Range`、`If-None-Match`） | 讀 16 B 容器頭、長度表、名稱表、單一圖片 |
| `GET /api/adb/<id>/counts` | header 摘要＋計數（JSON，不碰任何 payload） | **第一畫面**：distinct tokens、tag 命中、行數、VA 總長、文件數、資源數 |
| `GET /api/adb/<id>/classes` | 每個 token 類別的數量（JSON） | 「英數只顯示數量」的那個數量 |
| `GET /api/adb/<id>/items` | header＋每個容器的 `start/dataStart/listStart/count/totalBlockSize/blockSize/feature` | 前端不必自己解析容器頭 |
| `GET /api/adb/<id>/tokens` | 二進位 token 索引（名稱＋命中數＋類別），brotli/gzip | 右側 token 分頁 |
| `GET /api/adb/<id>/layout` | `u32 count, u32 srcBlockSize, u32 va[]` | VA→PA（二分搜尋 source 區塊） |
| `GET /api/adb/<id>/block/source/<i>` | 該 source 區塊**已解壓**的 UTF-16LE 位元組 | 中間視窗的文字視窗 |
| `GET /api/adb/<id>/block/<container>/<i>` | 該區塊原始位元組（tokens/tags/attributes/caches…） | 右側 tag 分頁、屬性 |
| 其他路徑 | 靜態檔（viewer 資產、抽取出的 XML） | 中間視窗的文件內容 |

`<id>` = 相對於 `--root`、去掉 `.adb` 的路徑，例如 `13j`、`yinshun/yinshun`。

### 2.1 `/tokens` 二進位格式（前端唯一要自己解的格式）

```
u32 count
repeat count times:
  u16 units           名稱碼元數
  u16*units           名稱（UTF-16LE，逐位元組原樣）
  varint postingBytes posting list 的位元組長度
  u8   cls            0=han 1=latin 2=digit 3=other
```

`postingBytes` 用 varint 是因為**它就是長度表裡那個 delta 本身**，所以存的數字精確等於 adb 在該 posting 上花的位元組數（含 4 B 的 `added` 欄位與 milestone 表）。實測傳輸量：13j 40 KiB、yinshun 111 KiB、lawtw 4.40 MiB（皆 brotli）。

**名稱必須以 UTF-16LE 原樣搬運**：93 庫中有 18 庫、362 個 token 名稱含未配對代理（如 13j 的 `⿱艹\ud85a`），任何 UTF-8 轉換都會變成 U+FFFD。詳見 [adbviewer-sidecar.md](adbviewer-sidecar.md) §2.1（該節的發現仍然有效，只是不再需要旁檔）。

### 2.2 Range 語意（已逐項驗證）

* 無 `Range` → `200` + `Accept-Ranges: bytes`
* `bytes=0-255` → `206` + `Content-Range: bytes 0-255/<size>`，位元組與檔案切片一致
* `bytes=-16` → 尾 16 位元組；`bytes=256-` → 到檔尾
* `bytes=0-15,32-47` → `206 multipart/byteranges`
* `start >= size` → `416` + `Content-Range: bytes */<size>`
* `last < first` 或無法解析 → 忽略 Range，回 `200`（**不可**回 206，否則前端會拿到錯誤資料）
* `If-Range` 不符 → 回完整 `200`；`If-None-Match` 相符 → `304`
* `HEAD` → 有標頭、無 body；`OPTIONS` → `204`，`Access-Control-Allow-Headers` **必須含 `Range`**（否則跨來源 range fetch 在 preflight 就被擋）
* 路徑穿越（`/api/db/../../etc/passwd`）→ `404`

> ⚠️ 前端必須把「伺服器忽略 Range」當成可偵測狀態：`res.status === 200` 但預期 206 時，代表整個檔案都下來了（或伺服器不支援），要據此降級而不是默默用錯位元組。

---

## 3. token 分頁：先數量、漢字優先

實測的三個庫分布（`/classes`，43/43 契約測試對帳過）：

| 資料庫 | distinct | 漢字 | 英數 | 其他 | 漢字命中／總命中 |
|---|---:|---:|---:|---:|---:|
| 13j | 6,531 | **6,510（99.7%）** | 0 | 21 | 641,568 / 800,549 |
| yinshun | 9,516 | **5,501（57.8%）** | 3,818 | 197 | 5,859,355 / 7,256,439（80.7%） |
| lawtw | 240,064 | **7,887（3.3%）** | 230,509 | 1,668 | 165,609,598 / 197,171,922（84.0%） |

lawtw 是這個決策的最強證據：**24 萬個 token 裡只有 7,887 個漢字，卻佔 84% 的命中**；剩下 23 萬個英數 token 只佔 16%。把英數折成一行數量，等於

* 預設要 render 的列數：240,064 → **7,887（32 倍）**
* 前端需要解析的字串數：240,064 → 7,887
* 但**傳輸量不變**（伺服器回的是同一個索引；4.39 MiB brotli）。若日後要省這 4.4 MiB，再加 `?classes=han` 參數即可——**現在不要做**，因為 `latin`/`digit` 的數量仍要由同一次掃描得出。

UI 行為建議：

```
混用輸入框（token 過濾）          [ 一        ]   排序: [Unicode ▾]（不做 posting 長度）
──────────────────────────────────────────────
漢字 7,887                      ← 預設只展開這一類
  一 96,937   乙 12,004   丁 8,331 …           ← 顯示命中數，可排序（Unicode / 命中數）
──────────────────────────────────────────────
英數 230,509（未載入）           ← 只顯示數量，點「載入」才展開
其他   1,668（未載入）
```

`/counts` 只讀 header 就能給出：distinct tokens、tag 命中總數、行數、VA 總長、文件數、資源數、區塊數——**第一畫面不需要任何 payload**。

---

## 4. 中間視窗（順帶釐清，尚未實作）

* 文件文字：`/block/source/<i>` 逐塊取，或直接用 `extract.ts` 產出的合法 XML 走靜態路徑（XML 不壓縮，Range 直接可用）。
* 一個文件跨幾個 source 區塊（yinshun 實測）：中位數 **20 塊（約 155 KiB 壓縮）**、最大 121 塊。→ 單一文件按需解壓在瀏覽器端也還算可行，但大型庫（四庫全書）會太慢，建議仍由伺服器提供。
* posting 高亮：`layout` 做二分搜尋定位 source 區塊 → `/block/source/<i>` 取文字 → 分詞器 `skiptokens` 定位 → 前後各取 N 個碼元 → 前端以字元位移上色。**這是唯一還沒被驗證的環節**，驗收方式見 §6。

---

## 5. 不做的事（明確排除）

| 排除項 | 理由 |
|---|---|
| sidecar 旁檔 | 伺服器端索引取代；少一個檔案、少一組同步問題 |
| `file://` | `script type="module"` 與 `fetch()` 在 `file://` 都被擋；且沒有伺服器就沒有 Range |
| 按 posting 長度排序 | 需求已移除；命中數排序保留（索引本來就有命中數） |
| 把 `tokens` 全部載入瀏覽器 | lawtw 282 MiB，永遠不做 |
| 用 milestone 猜命中數 | 實測錯誤率極高（yinshun 1,321/1,333 不符），見 [adbviewer-sidecar.md](adbviewer-sidecar.md) §2.2 |

---

## 6. 待辦與驗收

| 階段 | 工作 | 驗收 |
|---|---|---|
| ✅ 已完成 | HTTP 伺服器（Range + CORS + 7 個 API） | `bun run tools/serve-contract.ts --adb <adb>` → 43/43 |
| ✅ 已完成 | token 索引（名稱/命中數/類別）與 `/classes` | 三個庫的 token 數、命中總和、類別數與 `/tokens` 標頭逐項相符 |
| P1 | 前端：三欄骨架、`/counts` 首屏、漢字優先的 token 清單（虛擬滾動） | 13j/yinshun/lawtw 開檔 < 2 s；24 萬 token 庫預設只 render 漢字類 |
| P2 | VA→PA 定位（`layout` + `/block/source` + tokenizer） | 抽 1,000 個 posting，取出的字元 == `build/index-yinshun.json` 同 VA 的 token（100%） |
| P3 | 中間視窗（XML 文字 + 虛擬滾動）、posting 塗紅 | 點 posting 能定位並上色；上下文窗口 ±N 字正確 |
| P4 | 左側 meta／文件／圖片清單；右側 tag 分頁 | 圖片零遺漏；tag 命中數與 SPEC 相符 |
| P5 | 文件文字服務（大庫友善的伺服器端抽取 + 快取） | 四庫全書級單篇開啟 < 2 s |

---

## 7. 現行檔案對照

| 文件 | 狀態 |
|---|---|
| [adbviewer.md](adbviewer.md) | 原始需求（UI 規劃仍有效；「zero server side dependency / file:// / fetch 分段」已由本文件取代） |
| **本文件** | **現行架構** |
| [adbviewer-assessment.md](adbviewer-assessment.md) | 格式可行性與量測證據（仍有效）；§3.1 sidecar 一節已作廢 |
| [adbviewer-sidecar.md](adbviewer-sidecar.md) | sidecar 路線已作廢；**§2.1（未配對代理）與 §2.2（milestone 不可信）仍然有效** |
| [ts/tools/serve-adb.ts](ts/tools/serve-adb.ts) | 伺服器實作 |
| [ts/tools/serve-contract.ts](ts/tools/serve-contract.ts) | HTTP 契約測試 |
