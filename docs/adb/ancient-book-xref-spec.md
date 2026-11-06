# 古籍 ADB 與分散式 XREF 規範（canonical）

> 版本：2026-11-06  
> 適用：`D:\accelon3` 的古籍原文 adb、引用這些古書的詞典／引文 adb、以及 accelon26 的 xref runtime。  
> 這份文件是 **各 adb 工作區與引文分析 agent 的共同契約**。舊的 `backlink-skill.md`
> 是中央 `taisho` 時期的流程；50–100 本古書請以本文為準。

---

## 0. 定案摘要

1. **不要中央 `xref.adb`**。誰引用原文，誰在自己的 adb 存 outgoing links。
2. 原文 adb **不持久保存反向連結**；反向連結只在 runtime 由「目前已開啟的引用庫」注入。
3. 書目 metadata 很小，**打包進 accelon26**（`book-catalog.json`），不另做服務。
4. **引用目標是 work（書名身份），不是 adb 名稱**。《易》是 work，`13j.adb` 只是目前載體。
5. 引用庫用 `xout_<workId>` 容器；原文 adb 開啟時，依自己包含的 works 讀對應 bucket。
6. 反鏈是**部分集合**：只含目前已開啟的引用庫。UI 必須明示，不可假裝全網。
7. 缺原文 adb 時，用 work → edition → adb 的 catalog 映射引導下載；下載後重新點連結。

---

## 1. 角色與責任

| 角色 | 負責 |
|---|---|
| 原文 adb 工作區 | 正文、穩定 work／頁／條目錨點、`book-catalog` 基本資料；不建反鏈 |
| 引用 adb 工作區 | 引文、`xout_<workId>` outgoing links；不修改原文 |
| 引文分析 agent | 產出候選引文 TSV（書名、引文、位置提示、信心），不直接寫 `<聯>` |
| accelon26 | work catalog、LinkBus、缺書引導、點擊跳轉 |
| 母區 | catalog 匯入 app、release、部署；不代替各區改正文 |

各 adb 工作區只產出 adb／版本說明／sha256／大小；官網部署由母區統一處理。

---

## 2. 三層資料

```text
book-catalog.json
  books（adb 載體）＋ works（《易》《莊子》…）＋ editions
        │
        ├── 原文 adb：正文 + work/book/page 錨點
        │
        └── 引用 adb：正文 + xout_<workId> outgoing links
```

- `book-catalog` 不是全文索引，也不是連結圖。
- 原文 adb 不需要知道誰引用它。
- 引用 adb 不需要讀原文全文；它只記錄 work 錨點與引文。

---

## 3. Book catalog

### 3.1 檔案

- 來源：`ts/tools/make-book-catalog.ts`
- 產物：`ts/src/accelon26/book-catalog.json`
- 打包：viewer／exe 內建；runtime 有 `bookById()`、`findBooks()`、`workById()`、`findWorks()`。
- 目前 55 個 adb、13 個 works（十三經）、約 15 KiB。新增書或改別名後重跑 generator、重建 app。

### 3.2 books：adb 載體

```json
{
  "id": "13j",
  "adb": "13j.adb",
  "title": "十三經",
  "aliases": ["十三經", "十三經注疏"],
  "collection": "accelon3",
  "kind": "text",
  "status": "ready",
  "size": 2252537,
  "pageScheme": "page-id"
}
```

- `id` 是 adb 身份；**不要拿它當引用目標**。
- 同一個 work 可以在不同 adb／版本出現。

### 3.3 works：引用身份（重要）

```json
{
  "id": "yijing",
  "title": "易",
  "aliases": ["易", "周易", "易經"],
  "editions": [
    { "adb": "13j", "book": "周易", "edition": "十三經注疏本", "status": "ready" }
  ]
}
```

- **引用庫引用 `yijing`，不是 `13j`。**
- `editions[].adb` 是目前載體；`editions[].book` 是 adb 內 `<書 id>`。
- `13j.adb` 改名、拆成 `yijing.adb`、或換版本時，只改 edition mapping，引用不變。
- 一個 work 可以有多個 edition；resolver 依已安裝／版本 hint 選。

### 3.4 十三經目前 works

`13j` 內十三個 work：

| work id | 書名 | adb 內 book |
|---|---|---|
| `yijing` | 易 | `周易` |
| `shangshu` | 尚書 | `尚書` |
| `shijing` | 詩經 | `毛詩` |
| `zhouli` | 周禮 | `周禮` |
| `yili` | 儀禮 | `儀禮` |
| `liji` | 禮記 | `禮記` |
| `zuozhuan` | 春秋左傳 | `左傳` |
| `gongyang` | 春秋公羊傳 | `公羊傳` |
| `guliang` | 春秋穀梁傳 | `穀梁傳` |
| `lunyu` | 論語 | `論語` |
| `xiaojing` | 孝經 | `孝經` |
| `erya` | 爾雅 | `爾雅` |
| `mengzi` | 孟子 | `孟子` |

老莊、史書、說文解字等新書比照：先建 work entry，再指定 edition → adb／book。

### 3.5 新書流程

1. 原文 adb 放入 `D:\accelon3`（或 `sz` 的指定位置）。
2. 在 generator 的 `WORKS` 補 work（書名、別名、adb 內 book）。
3. 在 `ALIASES` 補常見引文寫法。
4. 跑 `bun run tools/make-book-catalog.ts`。
5. 重建 viewer／exe；catalog 已內嵌，不需要另發 catalog 檔。

---

## 4. 原文 ADB 的要求

### 4.1 穩定錨點

每個可被引用的位置，必須能用 **work＋字串錨點＋漢字範圍** 定位：

```text
workId?anchor#a-b
```

- `anchor` 在該 work 內唯一。
- `a-b` 是漢字序（code point），不是 byte offset。
- 不要用 VA 當 xref 目標；VA 只可作本庫 fallback。

頁 id 在 `<書>` 內重複是允許的，因為 work 已確定 book；例如：

```xml
<書 id="周易">周易</書>
<頁 n="1"/>
...
<書 id="尚書">尚書</書>
<頁 n="1"/>
```

work `yijing` 的 `page:1` 和 work `shangshu` 的 `page:1` 是不同位置，不衝突。

### 4.2 work 內的 book id

- `<書 id="...">` 是 adb 內的穩定 id；不要用顯示標題當 id。
- 單書 adb 可以省略 `book`，work edition 直接指向 adb。
- 多書 adb（十三經、史書合集）必須提供 `book`。

### 4.3 版本

原文改版時：

- `contentHash` 更新。
- work id／book id／page id 不可重排；必須改就新增 edition。
- 舊引用可能失效；LinkBus 點擊時驗證 anchor，失效就警告，不亂跳。

### 4.4 Anchor manifest 與 prebuild gate

Prebuild xout 只能寫「manifest 證明存在」的 anchor：

```text
anchorId, kind, parentBook, va/page, textHash
```

- anchorId 在 work 內唯一；重複 fail。
- `a-b` 相對 anchor 文字，不是 adb 全域 offset。
- xout record 要帶 targetTextHash；header 帶 targetEdition／manifestHash。
- 沒有 target manifest、版本不符、hash 不符：不要寫正式 xout；進 unresolved／stale。
- 13j 的 `<頁元>` 不是內頁 anchor；`page:` 只指 `<頁>`。
- swjz／swjzz／swjzzp 的 `char:w…` 以三者共有的 10,706 個 id 為準。

---

## 5. 引用 ADB 的要求

### 5.1 只存 outgoing links，按 work 分裝

```text
xout_<workId>      # 每個被引用的 work 一個 container
```

例：引用《易》就是 `xout_yijing`；引用《莊子》就是 `xout_zhuangzi`。

- **不要**用 `xout_13j`；13j 是載體，不是引用身份。
- 不要寫 `xin`、不要建全域反鏈表。
- 一個引用庫可以有多個 `xout_<workId>`。

### 5.2 Container 格式

UTF-8 JSON Lines，第一行 header：

```json
["XOUT1","yijing",2,"sha256:..."]
```

之後每行一筆 link：

```json
["entry:一毛不拔", 12345, 0, 3, "page:1", 0, 4, "天行健，君子以自強不息", "quote", 92]
```

欄位順序：

| # | 欄位 | 說明 |
|---:|---|---|
| 0 | `sourceAnchor` | 來源錨點（詞條／頁） |
| 1 | `sourceVa` | 來源 VA（fallback；未知用 -1） |
| 2 | `sourceA` | 來源起點（漢字序） |
| 3 | `sourceB` | 來源終點（不含） |
| 4 | `targetAnchor` | work 內錨點（`page:1`／`entry:…`） |
| 5 | `targetA` | 目標起點 |
| 6 | `targetB` | 目標終點 |
| 7 | `quote` | 原文引文；≤240 漢字，顯示／比對用 |
| 8 | `kind` | `quote`／`cite`／`mention`／`parallel` |
| 9 | `confidence` | 0–100；低於門檻不寫入 |

Header 第 3 欄是目標 edition 的 `contentHash`（可選）。

### 5.3 多版本

若同一個 work 有多個 edition：

- 預設只寫 primary edition；其他放 unresolved／alternates。
- 如果引用明確指向某版本，header 或 record 可加 edition 資訊（下一版擴充）。
- 不要讓同一個 target work 的 links 混在無法區分版本的 bucket。

### 5.4 不重複、不亂連

- 同一 `(sourceAnchor,targetAnchor,targetA,targetB,kind)` 只留一筆。
- 引文太短（少於 4 漢字）、只靠常用詞命中：不要自動寫入。
- 同一段引文命中多個 work：只寫 resolver 選定的 primary。

### 5.5 作者手寫 `<聯>` 與 generated xout

- 少量、精選、需要特殊顯示的連結可以保留 `<聯>`／`_名`。
- 大量引文一律走 `xout`，不要讓幾百萬個 `<聯>` 進入正文／VA。
- `<聯>` 目標可用 work id；格式見 tag 規範。

---

## 6. 引文分析 agent 的輸出契約

分析 agent 只產候選 TSV，不直接改 adb。最低欄位：

```text
source_db
source_anchor
source_a
source_b
quote_original
quote_normalized
target_title_raw
target_hint
analyzer
confidence
evidence
```

- `quote_original`：保留原字、標點。
- `quote_normalized`：去空白、標點、異體正規化；只給 resolver 比對。
- `target_title_raw`：詞典原文寫的書名（《易》、《周易》、《莊子》、Zhuangzi…）。
- `target_hint`：卷／篇／頁／「盡心上」等。
- `evidence`：分析理由或候選清單，供人工抽查。

Resolver 必須輸出：

- `accepted.tsv`：可寫入 xout 的 links。
- `unresolved.tsv`：書名或位置無法確定。
- `dead.tsv`：work 存在但 target anchor 不存在。
- 統計：解析率、歧義率、平均 confidence。

---

## 7. Resolver 規則

1. `target_title_raw` → `findWorks()`／work aliases。
2. 唯一命中 → `work_id`；多筆 → 用 edition／`target_hint`／引文比對排序。
3. work → edition：優先已安裝的 adb；多個版本時依 hint。
4. 依 edition 的 adb／book 定位 `targetAnchor`。
5. `quote_normalized` 與原文比對，容許異體與少量差異；取最小範圍。
6. 多候選：primary + alternates；只有 primary 寫入 xout。
7. 找不到 work：`unresolved`，不要猜一個相近書名。

---

## 8. LinkBus runtime

原文 adb **不存反鏈**。LinkBus 只維護目前已開啟的來源。

```text
引用庫開啟 → registerSource
原文開啟   → registerTarget（work list 由 catalog 決定）
關閉       → unregister
```

行為：

| 情況 | 結果 |
|---|---|
| 原文先開、引用庫後開 | 引用庫只讀 `xout_<原文 work>`，注入原文 view |
| 引用庫先開、原文後開 | 原文向已開啟引用庫要自己的 work buckets |
| 兩者都開 | 合併多來源 |
| 引用庫關閉 | 從原文 view 移除該來源 |
| 原文關閉 | 整個 view 丟掉 |

- 原文 adb 開啟時，用 `worksOfBook(adbId)` 取得自己包含的 works。
- 只快取「已開啟來源 × 當前原文 work」的 bucket；不要把所有 links 放進一個 global Map。
- 舊 `xrev`／屬性掃描只作 legacy fallback。
- UI 必須寫「反向連結（已開啟 N 個引用庫）」；沒有來源時顯示「尚未開啟引用庫」。
- 不提供「全網反鏈」承諾。

---

## 9. 缺原文 adb 的下載引導

當讀者點到一個 work，但本機沒有承載它的 adb：

1. `resolveWork(source)` → work；`editions` 找可下載的 adb。
2. 用 catalog 查出 `title`、`adb`、`id`、`status`。
3. 桌面版：
   - 開啟「取得更多 ADB」；
   - 狀態列寫「《易》（13j.adb）還沒安裝：已打開取得更多 ADB，下載後重新點一次連結」。
4. 網頁版：
   - 開 `https://shutonggui.cn/accelon26/adb/<adbId>.html`；
   - 若頁面不存在，顯示「尚未上架」，不要靜默失敗。
5. `status=wip`：不要引導下載，顯示「施工中」。
6. 下載完成後重新點連結；LinkBus 重新註冊。

這是「引用庫先開、原文庫未安裝」的標準流程；不要假設所有原文都已下載。

---

## 10. Build 與驗收

### 10.1 原文 adb

- [ ] catalog 有 work entry（書名、別名）與 edition（adb／book）。
- [ ] 多書 adb 的 `<書 id>` 穩定；work 的 book 對得上。
- [ ] 所有可引用位置在 work 內有唯一 anchor。
- [ ] page／entry 範圍用漢字序，不是 byte。
- [ ] 沒有為了 xref 改正文 VA。
- [ ] 重建後 `contentHash` 更新。

### 10.2 引用 adb

- [ ] 每個 work 只有一個 `xout_<workId>`。
- [ ] header schema `XOUT1`、work id、count 正確。
- [ ] 每筆 targetAnchor 在該 work 內可解析。
- [ ] 無重複 link；confidence 門檻生效。
- [ ] 沒有 `xin`、沒有中央 xref。
- [ ] 交付 xout 統計（work、links、unresolved、dead）。

### 10.3 runtime

- [ ] 原文先開、引用後開：反鏈出現。
- [ ] 引用先開、原文後開：反鏈出現。
- [ ] 關閉引用庫：反鏈消失。
- [ ] 兩個引用庫：合併；數字正確。
- [ ] 只讀 target work bucket，不讀其他 work。
- [ ] 缺書：引導下載，不跳錯頁。

---

## 11. 獨立發展與版本

- 原文 adb 可獨立改版，不需要重建任何引用庫。
- 引用 adb 可獨立改版，只重建自己的 `xout_*`。
- work 可以從 `13j` 搬到 `yijing.adb`；只改 catalog edition，引用不變。
- 原文改版導致 anchor 失效時，LinkBus 點擊時警告；不要自動跳到相似頁。
- catalog 改動（新 work、別名、edition）需要重建 app；adb 本體不用動。
- 部署仍由母區統一處理；各區交付 adb＋catalog 變更＋版本說明＋sha256／大小。

---

## 12. 與舊 `xrev`／`<聯>` 的關係

- 舊 `xrev`：per-source、所有 target 混在一個 container；保留作 legacy fallback。
- 新 `xout_<workId>`：per-source、per-work；新資料一律用這個。
- 舊 `<聯 i="db?page">`：仍可讀；新大量引文不要寫進正文。
- 舊 `backlink-skill.md` 的中央流程不再作為 50–100 本古書的目標架構。

---

## 13. 非目標

- 不做中央 `xref.adb`。
- 不保證原文一開啟就看到全部反鏈；只保證已開啟來源。
- 不把百萬級 links 放進正文 DOM。
- 不自動把不確定的引文連到相近版本。
- 不在原文 adb 寫入任何反向資料。

---

## 14. 參考

- `docs/adb/han-position.md`：漢字位置與 `j`／off 的座標系。
- `docs/adb/stable-adb.md`：底座／功能 adb 分層。
- `docs/adb/backlink-skill.md`：舊中央流程（legacy）。
- `ts/src/accelon26/book-catalog.ts`：catalog API（books／works）。
- `ts/src/accelon26/link-spec.ts`、`word-spec.ts`：tag 語義。
