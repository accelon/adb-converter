# adbviewer 可行性評估與設計建議

> **狀態（2026-02）：架構決策已改。** 現行方案是「不做 sidecar、不支援 `file://`、只走 HTTP + Range，索引由伺服器端建立」，見 [adbviewer-http.md](./adbviewer-http.md)。
> 本文件的**格式量測與可行性結論仍然有效**（§2 的容器體積、bzip2 成本、posting 規模）；§3.1 的 sidecar 建議、§3.2 的「模式 A/B/C」與 §8 的三個決策已作廢。

評估日期：2026-02（以本機 93 庫語料與 `ts/` 既有程式為依據）
評估對象：[adbviewer.md](./adbviewer.md)
實測腳本：`build/probe-viewer.ts`、`build/probe-tokens.ts`、`build/probe-containers.ts`

---

## 0. 結論（先看這段）

**可行，但 adbviewer.md 的「技術架構」那一行必須改寫。** 其餘（三欄介面、左中右三區的內容規劃）方向正確、可以照做。

| 原始要求 | 評估 | 說明 |
|---|---|---|
| 純前端 SPA、zero server dependency | ✅ 可行 | `Blob.slice()` 就能對本機檔案做隨機讀取，不需要把 664 MiB 讀進記憶體 |
| 以 URL 參數帶入 adb 名稱 | ⚠️ 部分可行 | URL 只能帶「名稱」，拿不到檔案內容；本機檔案必須由使用者選取 |
| 用 fetch 分段讀取、不要整檔載入 | ❌ **對大型庫做不到** | adb 的區塊長度表在**容器資料之後**，且 `tokens` 容器動輒 286–328 MiB；只為了列出 token 名稱就得下載整個容器（實測見 §2） |
| 左側 meta／文件清單／圖片清單 | ✅ 可行 | 資料來源都很小（`tags` ≤ 7.1 MiB、`resources` 名稱表 17 KiB、`tables` 需抽稀） |
| 中間 XML 檢視 + posting 塗紅 | ⚠️ 可行但要換做法 | VA→PA 映射在 SPEC 仍屬未解（§13.7），應改走「已抽取的合法 XML + 物理位址」路線 |
| 右側 token／tag／圖片清單 | ⚠️ 可行但需 sidecar | 240,064 個 token 的「點閱次數」需要逐一解碼 posting list，不能每次開檔重算 |

**建議架構一句話**：單一 HTML（零依賴，`file://` 可跑）＋ 建庫時產生 `.adbidx.json` sidecar（把「token→命中數」離線算好）＋ 選配的單檔 Bun 伺服器（提供 Range 與按需解壓）。

---

## 1. 現有可重用資產（成本評估）

| 資產 | 位置 | 對 viewer 的價值 |
|---|---|---|
| 容器／header／packed list 解析 | [ts/src/format.ts](../../ts/src/format.ts) | 幾乎可直接移植（只需把 `node:fs` 換成 IO 介面） |
| 分詞器（Delphi 移植） | [ts/src/tokenize.ts](../../ts/src/tokenize.ts)、[ts/src/unicode.ts](../../ts/src/unicode.ts) | 定位 posting 到文字位置的必要元件 |
| 純 JS bzip2 解壓（MIT vendored） | [ts/src/vendor/bzip2.js](../../ts/src/vendor/bzip2.js) | 瀏覽器端可用的唯一解壓後備 |
| 合法 XML 抽取 | [ts/tools/extract.ts](../../ts/tools/extract.ts)、[ts/src/xmlrepair.ts](../../ts/src/xmlrepair.ts) | 中間視窗的「已驗證文字來源」，避免自己重寫渲染 |
| 語料實測數據 | [SPEC.md](../adb/SPEC.md) §14、`build/corpus-scan.tsv` | 效能預算的来源 |

也就是說：**viewer 不需要新寫解析器**，只需要 (a) 一層 IO 抽象、(b) 一個 sidecar 產生器、(c) UI。

---

## 2. 實測證據（本次評估新跑）

### 2.1 容器體積：為什麼「fetch 分段」不成立

| 資料庫 | 大小 | source | **tokens** | tables | tags | 名稱表 |
|---|---:|---:|---:|---:|---:|---:|
| 13j | 2.15 MiB | 0.86 MiB | 1.16 MiB | 0.09 MiB | 0.01 MiB | 25.6 KiB |
| yinshun | 23.8 MiB | 8.17 MiB | 10.22 MiB | 0.69 MiB | 0.25 MiB | 87.5 KiB |
| lawtw | 588.9 MiB | 202.2 MiB | **286.3 MiB** | 20.1 MiB | 6.7 MiB | 3.81 MiB |
| sbqs-04.ji | 664.0 MiB | 294.5 MiB | **327.9 MiB** | 26.7 MiB | 7.1 MiB | 85.9 KiB |

關鍵事實（格式層面，非實作選擇）：

1. 容器是 `[16B 頭][資料區][packed 長度表]`，而 `boNamed` 的**名稱表是最後一個資料塊**。
   → 想知道任何一個區塊在檔案裡的偏移，就必須先讀到容器尾端的長度表；要列出所有 token 名稱，就必須讀完整個 `tokens` 容器。
2. `TPackedList` 是**累積 delta 編碼**（非 LEB128），只能從頭循序解。
   → 沒有「二分搜尋第 i 個區塊」的可能。
3. `resources` 不壓縮，是唯一可以真正「跳著抓」的容器。

**所以：`tokens` 容器大小就是「開啟後可列出 token 清單」的下載量。** 對 yinshun 是 10 MiB（可接受），對 lawtw 是 286 MiB（不可接受）。這正是需要 sidecar 的理由。

### 2.2 一個 bzip2 區塊的成本（決定「按需解壓」是否可行）

| 資料庫 | 壓縮區塊 | libbz2(ffi) p50 | 純 JS p50 | 純 JS 全掃 |
|---|---:|---:|---:|---:|
| 13j | 7,807 B → 16,384 B | 0.57 ms | 1.49–2.53 ms | 0.2–0.3 s |
| yinshun | 8,505 B | 0.55 ms | 1.6 ms | 1.8 s |
| lawtw（37,539 塊） | 3,770 B | 0.34 ms | 1.33 ms | **50 s** |
| sbqs-04（26,502 塊） | 12,773 B | 0.68 ms | 4.44 ms | **118 s** |

結論：**單塊按需解壓完全可行**（點一下就 1–4 ms）；整庫解壓不可行。因此 viewer 必須是「解壓當前可見區塊 + LRU 快取」，而不是啟動時解壓全部。

### 2.3 posting 規模（決定 UI 必須虛擬化）

| 資料庫 | token 數 | 命中總數 | 最大單一 posting | p99 posting | 最大命中數 |
|---|---:|---:|---:|---:|---:|
| 13j | 6,531 | 800,549 | 150 KiB | 2.4 KiB | 151,563 |
| yinshun | 9,516 | 7,256,439 | 483 KiB | 22 KiB | 485,377 |
| sbqs-04 | 21,978 | 195,306,463 | **6.3 MiB** | 297 KiB | **6,225,858** |
| lawtw | **240,064** | 197,171,922 | **6.2 MiB** | 3.0 KiB | **6,153,970** |

→ token 清單要能撐 24 萬列、posting 清單要能撐 620 萬列；兩者都必須 windowing（只 render 可見列），且 posting 只需解到「使用者看到的那一段」為止（delta 累積正好支援這種「前綴解碼」）。

### 2.4 容器偏移實測（sidecar 的輸入）

`bun run build/probe-containers.ts <adb>` 對 yinshun 的輸出（節錄）：

```
container          start   dataStart     count   listStart  totalBlockSize  blockSize   maxBlock   minBlock
source                 272         288      1081     8561639         8561351          0      10537        714
tokens             8563837     8563853      9516    19263168        10699315          0     494455          5
tables            19275292    19275308         5    19995178          719870          0     283098        138
tags              22079595    22079611       129    22343373          263762          0      59323          5
caches            22343572    22343588        48    22738533          394945          0     119242         42
resources         22738637    22738653       456    24909451         2170798          0     216881        256
```

可讀出的三個設計事實：

1. **沒有任何「索引在檔頭」的欄位** — 想取 `tokens` 的第 i 塊，最小代價是：讀 16 B 容器頭 + 讀 `listStart` 起 4 B 取 `added` + 讀整份長度表（35 KiB @ sbqs-04），再算累積和。這是每次開檔都要付的固定成本（小），但**不含**「列出 token 名稱」。
2. 單一塊的最大值都很小（source 最大 10.5 KiB 壓縮、resources 最大 217 KiB）→ **按需讀取單塊完全實用**。
3. `header.version` 在本語料是 **0**（`compression=1`、`srcBlockSize=16384`）。依 SPEC §3，CRC 只在 `version >= $50902` 時檢查，所以這些檔案**根本不會被驗 CRC**；viewer 的「meta」分頁應顯示 CRC 狀態但註明「此檔版本低於門檻，未校驗」，不要誤報為通過。


---

## 3. 建議架構

```
┌─ 前端：viewer.html（單檔、零依賴、可用 file:// 開啟）
│    ├─ adbio.ts     IO 抽象：Blob slice / fetch Range / Bun server API
│    ├─ adb-core.ts  format.ts + packedlist.ts 的瀏覽器版（無 node:fs）
│    ├─ bz2-lite.ts  vendor/bzip2.js + LRU 區塊快取
│    ├─ geo.ts       VA→PA 定位（用 tokenize.ts）、caches/attributes 取名
│    └─ ui/          CSS Grid 三欄；token / posting / 文件 / 圖片清單皆虛擬滾動
│
├─ sidecar（建庫時產生，跟 .adb 放一起）：<db>.adbidx.json
│    header 摘要、容器 offset、token→命中數、tag 名稱、resources 名稱
│
└─ 選配：abx-viewer-server（單檔 Bun，零 npm 依賴）
     POST /open          → 回傳 meta + 容器結構（前端不必自己解析）
     GET  /block?c=..&i= → 回傳單一已解壓區塊（ffi libbz2）
     GET  /adb?range=..  → 支援 HTTP Range 的原始位元組（含 CORS）
```

三種執行模式，前端程式碼同一份：

| 模式 | 開啟方式 | 適用 | 限制 |
|---|---|---|---|
| **A. 本機檔案** | 拖入 `.adb`（+ `.adbidx.json`） | 單機、離線、發表用 | 無 sidecar 時 token 清單需讀整個 tokens 容器 |
| **B. URL + Range** | `viewer.html?adb=<url>` | 內網／自家伺服器 | 伺服器必須支援 `Range` 與 CORS；大型庫仍需 sidecar |
| **C. Bun server API** | `?api=http://127.0.0.1:8787` | 664 MiB 級大庫、要快 | 需要啟動一個行程 |

### 3.1 Sidecar 格式（`.adbidx.json`）

> 本節在首輪評估後已展開為獨立文件：[adbviewer-sidecar.md](./adbviewer-sidecar.md)（含二進位配置、實測體積、產生方式、完整性校驗）。以下保留摘要。

```jsonc
{
  "v": 1,
  "db": "yinshun", "dbcname": "印順法師佛學著作集",
  "fileSize": 24910598,
  "srcBlockSize": 16384, "compression": 1, "lineCount": 266916,
  "containers": {                       // 每個容器的絕對偏移，前端不必重算
    "source": { "start": 272, "dataStart": 288, "count": 1081, "listStart": 8569.., "totalBlockSize": .., "blockSize": 0 },
    "tokens": { ... }, "tags": { ... }, "tables": { ... }, "resources": { ... }
  },
  "tokens": {                            // 依 UTF-16 碼元升序（與 adb 相同），可直接二分搜尋
    "count": 9516,
    "hitCounts": [485377, 208635, ...],  // 讓「按 posting 大小排序」不必解 10 MiB
    "namesFile": "yinshun.adbidx.names"  // 可選：名稱表另存二進位（UTF-16LE + u16 長度）避免 JSON.parse 成本
  },
  "tags": [{ "id": 0, "name": "檔", "hits": 45 }, ...],
  "documents": [{ "n": 1, "name": "yinshun.xml", "range": [0, 7641310] }, ...],
  "resources": [{ "name": "images/mc0198.png", "offset": 123, "size": 4567 }, ...]
}
```

設計要點：

* `tokens` 區塊用**平行陣列**（`hitCounts` 為 number 陣列）而非 `[{token,count}]`，可省 3–5 倍體積；yinshun 約 60 KiB，lawtw 約 4–6 MiB。
* **token 名稱必須以 UTF-16LE 原樣保存，不可轉 UTF-8**：實測 93 庫中有 18 庫、362 個 token 名稱含**未配對代理**（如 13j 的 `⿱艹\ud85a`、`\udcde`），另有 67 筆含內嵌 NUL 的殘留位元組；轉 UTF-8 會變成 U+FFFD 而無法還原。詳見 [adbviewer-sidecar.md](./adbviewer-sidecar.md) §2.1。
* 體積控制：`tags`／`documents`／`resources` 都很小（KB 級）；`blocks.virtual` 另存 u32 陣列。
* 產生器就是一支 Bun CLI（放 `ts/tools/mkidx.ts`），複用現有 `format.ts` 與 `countPackedList()`；對 240,064 個 token 全掃約 1.1 秒（實測），93 庫可批次產生，屬 [TODO.md](./TODO.md) §4 那類離線工作。
* **milestone 捷徑不可用**：`TPackedList` 的最後一個 milestone 的 `Count` 不等於條數（yinshun 1,321 個區塊不符、lawtw 5,205 個不符），命中數只能逐一解碼；但 40 ms（yinshun）～1.1 s（lawtw）的成本完全可接受。
* sidecar 是**可選加速品**，不是格式依賴：沒有它 viewer 仍可運作（只是 token 清單要付全容器下載）。小型庫（`tokens` 容器 < ~32 MiB）可直接讀容器，不必生成 sidecar。

### 3.2 不要做的事（best practice）

1. **不要試圖把 adb 拆成「前端可任意 Range」的格式**——格式已定，動它等於做一次全庫重寫；sidecar 才是正解。
2. **不要在瀏覽器裡整庫解壓**（sbqs-04 全掃 118 秒、664 MiB 記憶體）。
3. **不要為了顯示 XML 而重新發明渲染器**——用 `extract.ts` 的輸出（已用 Python expat 驗證 45/45、13j 1/1），viewer 只做「文字 + 高亮」。
4. **不要把 token 清單與 posting 清單一次 render 成 DOM**（24 萬／620 萬列必爆）。
5. **不要用 `JSON.parse` 一次吃 4 MiB 以上的 sidecar 在主執行緒**——丟進 Web Worker。
6. **不要假設 `fetch` 一定有 Range**：Python `http.server` 預設不回 `Accept-Ranges`；跨來源時若無 CORS 連 `Content-Range` 都讀不到 → 模式 B 必須在 UI 上明示「伺服器不支援 Range，已降級」。

---

## 4. adbviewer.md 建議修訂

| 原文 | 建議改為 |
|---|---|
| zero server side dependency, a SPA served by http or file:// | 零依賴單檔 SPA，`file://` 直接可用；另附**選配**單檔 Bun 伺服器（提供 Range 與按需 libbz2 解壓），非必要 |
| 以 url 參數可帶入 adb 名稱，用 fetch 分段讀取文件 | URL 只能帶入**名稱／URL**；本機檔案由使用者選取（`Blob.slice` 隨機讀取）。分段讀取的原則是「只讀需要的容器與區塊」：meta/文件/圖片清單可即時取得；token 清單靠 sidecar；source 只解當前可見區塊 |
| 不要將整個 adb 載入內存 | 保留，並量化：單一記憶體物件 ≤ 32 MiB、解壓快取 ≤ 128 MiB、全程不建立整檔 ArrayBuffer |
| 左側 圖片清單 | `resources` 容器**不壓縮**，可直接以 Range 取單張圖並用 `Blob` + `URL.createObjectURL` 顯示（唯一能真正跳著讀的容器） |
| 中間 上方 2/3 XML 內容檢視，先不要渲染 | 先做**純文字 + 虛擬滾動**，高亮以「物理位址區間」標記；XML 樹狀渲染留待之後 |
| 下方 1/3 posting list…posting 位置塗紅 | 保留，但補上定位演算法（§5.2）；上下文窗口固定 ±N 字，且只解該位置所屬的 source 區塊 |
| 右側 token 分頁…按 postings 大小排序、按 token Unicode | 保留；`hitCounts` 來自 sidecar，兩個排序都是 O(n log n) 記憶體操作（24 萬列無壓力）。另建議加：只顯示 unigram／只看 CJK／只看命中數 ≥ N |
| （新增） | sidecar `.adbidx.json` 的產生與版本相容策略 |
| （新增） | 錯誤與降級路徑：CRC 不符、`version > MINORVERSION`、`compression=0`、無 `檔` 標籤（單檔庫）、無 sidecar |

### 4.1 `file://` 的兩個實作陷阱（一定要先決定，否則會白做）

1. **`<script type="module">` 在 `file://` 會被 CORS 擋掉**（Chrome/Edge：`Origin 'null' has been blocked`）。
   → 單檔目標必須是「**全部 inline 進一個 .html 的傳統 script**」，用 Bun 打包（`bun build --target=browser --format=iife --minify`）把 `format/packedlist/bzip2/tokenize` 全部內嵌，而不是拆成多個 ESM 檔。
2. **`fetch()` 在 `file://` 一律失敗**（連同目錄的 sidecar 也讀不到）。
   → 模式 A 的 sidecar 必須由使用者一併選取（兩個檔案，或一個資料夾），或用 `<input type="file" webkitdirectory>`；不可偷偷 `fetch('./x.adbidx.json')`。


---

## 5. 關鍵技術細節（實作前必須先決定）

### 5.1 IO 抽象（同一份前端吃三種來源）

```ts
interface AdbIO {
  size(): number;
  read(offset: number, length: number): Promise<Uint8Array>;   // 唯一原語
  close?(): void;
}
// BlobIO      : File.slice(offset, offset+length).arrayBuffer()
// HttpIO      : fetch(url, { headers: { Range: `bytes=${o}-${o+l-1}` } })
// ServerIO    : fetch(`${api}/block?...`)   // 伺服器已解壓，回傳 16 KiB 而非 8 KiB 壓縮
```

`format.ts` 目前所有函式都吃 `fd`（node:fs）；只要把它換成 `read(offset,len)`，其餘邏輯可原封不動移植——這是整個計畫最省工的一步。

### 5.2 posting → 文字位置（VA→PA）

SPEC §13.7 明說「虛擬位址 ↔ 物理位址的完整映射」尚未解。但 `srcpack.pas: getPA/toPhysical` 的演算法是完整的，且 `ts/src/tokenize.ts` 已有分詞器：

```
1. VABlocks.justsmaller(va) → blk（二分搜尋 tables/blocks.virtual，1081–37539 筆，記憶體無壓力）
2. paBlk = blk * srcBlockSize；解壓該 source 區塊（只有這一塊）
3. 依 getPA 的三個轉折：
     - VALines.justsmaller(va)：取該行最近的標籤加速（可先略過，用 vdiff = va - vablk + 1）
     - 若 '<' 與 '>' 都在：先前進到下一個 '<'，vdiff -= TAGLENGTH(4)
     - tokenizer.skiptokens(vdiff) 後 skipblanks
4. 由 p 往前後各取 N 個碼元 → 上下文
```

風險與對策：`getPA` 依賴「最近的標籤在哪一行」這種內部狀態，移植時容易只對 99% 的位置。**建議以 `tools/compare-index.ts` 的驗證方式驗收**：隨機抽 1,000 個 posting，用 viewer 的定位函式取出的字元，必須與 `build/index-yinshun.json` 中同一 VA 的 token 一致（yinshun 已有 9,516 token × 7,256,439 命中的完整對拍資料）。這是本計畫**最需要先做的一件事**，因為它決定中間視窗能不能「精準塗紅」。

替代方案（較省事、先上線）：文件層級先走 `extract.ts` 產生的合法 XML，高亮以「物理位址」為座標；VA→PA 定位當作第二階段。

### 5.3 文字語義

必須沿用 SPEC §7.4 的 `delphi` 模型（保留 BOM、不拆跨塊代理對、行首 CR/LF 跳過、每塊 NUL 截斷）；`decode.ts` 已把兩種模式與三個開關實作好了，直接搬。**不要**用瀏覽器 `TextDecoder` 逐塊解碼（那是 adbjs 的副作用語義，會吞 BOM、產生 U+FFFD）。

### 5.4 記憶體預算（硬性）

| 項目 | 上限 | 依據 |
|---|---:|---|
| 單次 `read()` | 1 MiB | 最大的單一 source 區塊 10.5 KiB 壓縮；`resources` 圖片最大 216,881 B（yinshun 實測） |
| 解壓區塊 LRU | 64 塊 × 16 KiB = 1 MiB | 足夠覆蓋一次捲動 |
| 已解碼 posting | 前綴解碼至需要的索引為止；上限 200 萬筆 | 避免 620 萬筆 × 4 B = 25 MiB 常駐 |
| token 清單 | 24 萬筆 × ~40 B ≈ 10 MiB | 需要 sidecar 或全容器讀取 |
| 禁區 | 不建立整檔 ArrayBuffer、不把容器 > 32 MiB 整體載入 | lawtw `tokens` = 286 MiB |

---

## 6. 分階段計畫與驗收

| 階段 | 工作 | 驗收方式 |
|---|---|---|
| P0 | IO 抽象 + `format.ts`/`packedlist.ts` 瀏覽器化 | 對 13j/yinshun 解析出的容器摘要與 `cli.ts analyze` 完全一致 |
| P1 | sidecar 產生器 `ts/tools/mkidx.ts` | 對 yinshun：tokens=9,516、總命中 7,256,439、tags=129、documents=45、resources=456 全部與 SPEC §11 相符 |
| P2 | VA→PA 定位模組 + 對拍測試 | 抽 1,000 posting，取出的文字 == `build/index-yinshun.json` 對應 token（100% 一致才算過） |
| P3 | UI 骨架（CSS Grid 三欄、虛擬滾動、深色主題） | 24 萬列 token 清單滾動 ≥ 50 fps；無 DOM 節點數爆炸 |
| P4 | 三種 IO 模式 | A：`file://` 開 yinshun 可用；B：Range 失效時顯示降級提示；C：Bun server 對 sbqs-04 開檔 < 1 s、單塊解壓 < 5 ms |
| P5 | 圖片 viewer、meta 分頁、tag 分頁 | 圖片零遺漏（與 `resources` 名稱表對帳）；tag 命中數與 SPEC 相符 |

**建議先做的三件事**：P0 → P1 → P2。P2 若失敗，中間視窗就得退回「XML 文字 + 物理座標」方案，屆時再調整整體設計。

---

## 7. 風險清單

| 風險 | 影響 | 對策 |
|---|---|---|
| VA→PA 定位無法做到 100% | 中間視窗塗紅位置偏移 | 先以對拍資料驗證；失敗則降級為文件層級高亮 |
| 大型庫無 sidecar 時不可用 | 664 MiB 級庫開啟後要讀 328 MiB | UI 明示並提供「產生 sidecar」的 CLI 指引 |
| `fetch` Range 不可靠（CORS／無 Range 標頭） | 模式 B 失效 | 內建自製 Bun server；UI 偵測 `Content-Range` 後降級 |
| 純 JS bzip2 在低階裝置慢 | 捲動卡頓 | 預解壓前後各 1 塊；Web Worker 解壓；有 libbz2 時走伺服器 |
| 瀏覽器 `Blob.slice` 對 > 2 GiB 檔案 | 無法開啟超大檔 | 本語料最大 664 MiB，安全；仍應在 UI 檢查 `file.size` |
| tagged 圖片的資源名編碼／路徑 | 圖片顯示失敗 | 沿用 `ts/src/resources.ts` 的取法，不做二次解讀 |
| 93 庫的 `caches`/`attributes` 差異 | 檔名解析失敗 | 照 SPEC §10 的四步順序（caches → id → n → 原文），並允許 fallback |
| sidecar 與 adb 不同步 | 顯示錯誤資料 | sidecar 記錄 `fileSize` + 前 256 B header 的 CRC32，開檔時比對，不符即忽略 |
| 名稱含未配對代理／內嵌 NUL（18 庫有） | 顯示成 U+FFFD、比對失敗 | sidecar 以 UTF-16LE 原樣保存；顯示時截斷於第一個 NUL 並標記「原始位元組異常」 |

---

## 8. 需要你確認的三個決策

1. **伺服器**：是否接受「選配單檔 Bun 伺服器」？若不接受，664 MiB 級資料庫就必須依賴 sidecar（仍可運作，只是首次開啟較慢）。
2. **sidecar**：是否同意把「token→命中數」離線產生（`ts/tools/mkidx.ts`）？這是「按 posting 大小排序」在 24 萬 token 級別仍能秒開的唯一辦法。
3. **框架**：建議零依賴（原生 DOM + 自寫虛擬滾動，與 `ts/` 的「無 npm 依賴」風格一致）。若要用 React/Vue，就需要引入打包流程，會與 `file://` 單檔目標衝突。
