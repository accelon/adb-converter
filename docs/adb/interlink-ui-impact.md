# 互聯對 accelon26 UI 的影響與定案

> 版本：2026-11-06 v0.1（依作者 19:25 定案整理）
> 範圍：閱讀器 UI／runtime；不含 cct 建置與 gycd resolver 的實作。
> 契約：canonical 仍是 [`ancient-book-xref-spec.md`](./ancient-book-xref-spec.md)；
> 本文只記錄「UI 看到什麼、需要資料給什麼」，衝突時以 canonical 為準並回頭改本文。

---

## 0. 一句話

**頁不再是必要條件**；地址改成 `work?語意段#a-b`。UI 要新增兩層——正文的
**引文帶**、段末的**反**——再加上**書／版本 identity**與**唯讀閘門**；
目錄樹、麵包屑、搜尋分組已經支援十三經，不動。

---

## 1. 定案

| # | 題目 | 決定 | 備註 |
|---:|---|---|---|
| 1 | 錨點 | 用 `書／章／節／項／篇／卷／字／詞` 的 `tag.id`；**不要求 `<頁 id>`** | 段範圍取目錄樹 `vaEnd`；`頁` 只留給 taisho、ys |
| 2 | 位址前綴 | adb id 或 work id 都可以 | **多 work 的 adb 一律用 work id**；單 work 的 adb 才可用 adb id |
| 3 | 13j 改名 | `13j` → **`jing`**（純字母，短） | 引用用 work id，改名不影響引用；`swjz` 系列不動；不做舊地址相容 |
| 4 | 對外地址 | 只做「引用字串＋跳至」；**不做 URL／API** | 短期內是內部規定 |
| 5 | 引文帶 | **常駐淡底線**，hover 顯示目標；設定可關 | 不是 hover 才畫底線 |
| 6 | 反鏈粒度 | **到段**；段末 chip `反 N · M 處`；dropdown top 10 **平列**；「全部」→ 左欄「引文」頁籤（current work） | **不做 sticky**；分組未定，先全部羅列 |
| 7 | 書 dropdown | header 加；只在 `worksOfBook(adb).length > 1` 顯示；同 tab、Ctrl 新 tab；tab 標題帶書名 | 例：`尚書·堯典` |
| 8 | 唯讀 | catalog 加 `editable:false`；生成物只能 rebuild | 13j 只有 2.2 MB，不能靠 50 MB 規則擋 |
| 9 | 版本 | `swjz`＝預設 target（hub、其他字典的 root reference）；`swjzz`＝引文豐富的 source；兩者都收 | 不做版本 picker；UI 顯示版本 |
| 10 | `#` 語義 | `#a-b` 固定為漢字範圍（含尾）；詞序另用 `:w`／`@` | 避免 `…/經元年#3` 被 word-hl 當第 3 個詞 |
| 11 | 卷 | **只作 container／scope，不作引用單位**；引用仍用最深 semantic anchor；xout 可帶 `targetScope` | 作者不喜歡卷（非 semantic、跨版有差），但卷太常用，至少用它把範圍收斂到約一萬字 |

> 版本註：現有 `accepted.tsv` 只有 gycd 一個來源，指向 `swjz` 8,229 條、`swjzz` 47 條。
> 作者說的「swjzz 含有大量引文」是指它**作為來源**（正文引用其他書）的 outgoing，
> 要等 swjzz 的 `xout_*` 建好才會進 UI；兩件事不要混為一談。

---

## 2. 今天的斷點（為什麼 UI 要動）

1. **`anchorIndex()` 只認 `attributes/頁.id`**（[`page-text.ts`](../../ts/src/accelon26/page-text.ts:30)）。
   `13j` 只有 `頁.n`、`gycd` 連 `<頁>` 都沒有 → 兩邊都回 `null`；右欄
   `renderForeign` 會說「這個庫沒有頁碼表」（[`xref.ts`](../../ts/src/accelon26/xref.ts:770)），
   反鏈掃描也直接早退（[`xref.ts`](../../ts/src/accelon26/xref.ts:395)）。
   所以 13j 目前**不能當連結目標**，gycd 也**不能當來源**——互聯是全新的 runtime，不是舊功能調參。
2. **`work id` 被當成 adb 名**：`handleXref` 只切 `?`（[`xref.ts`](../../ts/src/accelon26/xref.ts:1490)），
   `yijing?乾` 會找不到 adb，`guideMissingDb` 於是回報「《易》（13j.adb）還沒安裝」——
   即使 13j 就開著（[`xref.ts`](../../ts/src/accelon26/xref.ts:1470)）。
3. **引用複製對 13j 會產生 `13j?L123#a-b`**（[`bookmarks.ts`](../../ts/src/accelon26/bookmarks.ts:611)）：
   沒有頁 id、`citationEntryTag` 也空（13j 的樹是 `s="*"`），只能落到行號；改版就斷。
4. **語法接不住新地址**：`zuozhuan?隱公/經元年#0-4` 的 `/` 不在 `ANCHOR_RE`
   （[`char-position.ts`](../../ts/src/accelon26/char-position.ts:23)），`findCharPosition`
   會丟掉 prefix、只抓最後一個 `#` token；`char:w0010010` 也沒有分支。
5. **catalog 已過時**：13j 寫 `pageScheme:"page-id"`、swjz 寫 `entryTag:"詞"`（實際是 `字`）；
   `shuowen` 這個 work **根本不在 catalog**（只有 swjz／swjzz 兩本書）；generator 的
   `WORKS` 以 `13j` 為 key、`id` 由檔名推（[`make-book-catalog.ts`](../../ts/tools/make-book-catalog.ts:32)）。

---

## 3. 資料契約要先補（比 UI 優先）

### 3.1 xout 的 source 定位（blocker）

目前 `D:\2026\gycd\interlink\accepted.tsv`／`xout-candidates.csv` 的
`source_anchor` 其實是**被引書名**（詩經、左傳…），`source_a=0`、
`source_b=引文長`，是相對**引文**而不是詞條。這與 canonical §5.2 的
「`sourceAnchor`＝來源錨點（詞條／頁）」直接衝突；照寫進 xout，每條 link 的來源
都會變成「詞條：詩經」。

最低要補：

```text
source_entry      詞.id 或詞條名稱（gycd 的 詞.id／caches/詞）
source_va         詞條起始 VA
source_a/b        相對詞條的漢字序（不是相對引文）
source_line/han   可選；有給時 UI 不必再算
source_quote_hash 可選；詞條改版時判斷 stale
targetScope       可選；最近一個穩定容器（卷／章／篇）的 id
targetScopeKind   juan／zhang／pian…；targetScope 是哪一種
```

`targetScope` 只作 fallback：深錨還在時完全不看它；深錨失效或舊資料沒有深錨時，
runtime 用它在**一卷（約一萬字）內**用引文比對落地，不要整本搜。

同時把舊欄位 `source_anchor` 改名 `cited_title`（詞典原文寫的書名），避免和 xout 的
`sourceAnchor` 撞名。

### 3.2 座標轉換只做一次

xout 的 `target_b` 是**右開**（`COVERAGE.md` 口徑），`#a-b` 是**含尾**。
轉換只能在 resolver 做一次；cct 量到的 6,677 條 off-by-one 就是這裡混用。

### 3.3 讓 UI 只查可見行

xout 按 `sourceVa` 排序，build 時另存一份 `(sourceVa, byteOffset)` 索引
（或每個詞條一筆）。UI 只對畫面上那幾行查，不要一次 parse 全部。
13j 現有 61,562 條、說文 8,276 條；四庫全開會更多。

### 3.4 catalog

- `id: "jing"`、`adb: "jing.adb"`、`title: "十三經"`；`kind:"text"`。
- `WORKS` 的 key 改 `jing`；13 個 work id 不變。
- 新增 `shuowen` work，editions：`swjz`（章節版，primary）、`swjzz`（卷字版）、`swjzzp`（P 版）；
  `book` 可省略（單書 adb），`edition` 要有人看得懂的名字。
- `pageScheme` 增加 `'seg'`／`'char'`；13j＝`seg`、swjz 系列＝`char`。
- 有卷的 work／edition 加 `fallbackScope: "juan"`（例 史記、漢書、文選）；`jing` 不填。
- 新增 `editable?: false`；`jing`、`swjz`、`swjzz` 都要標。
- `make-book-catalog.ts` 的 `id` 目前由檔名推，改名後自然變 `jing`，但 `WORKS` 要同步。

### 3.5 唯讀

`isReadOnlyEdit()` 目前只看 50 MB（[`doc-pane.ts`](../../ts/src/accelon26/doc-pane.ts:1569)）。
改成同時看 catalog 的 `editable:false`：隱藏編輯／F2／存檔，保留書籤、筆記、複製。
**13j 改名後，localStorage 以 dbname 為 key 的書籤／上次閱讀會留在 `13j`**；
既然不做相容，接受孤兒化，但要在 release note 寫一句。

---

## 4. UI 設計

### 4.1 錨點索引與 resolver

新增 `segment-index.ts`（不碰 DOM，可單元測試）：

```ts
interface SegmentAnchor {
  id: string;            // 章/節/項/篇/卷/字/詞 的 id
  tag: string;           // 哪一種節點（給顯示與消歧）
  va: number;            // 節點起始
  endVa: number;         // 段末（下一個同層或更淺的節點；沒有就用父節點 end）
  label: string;         // 顯示文字
}
```

- 索引來源：`attributes/<tag>.id`（只收有 id 的；說文 540 個無 id 附錄字自然排除）。
- 不要寫死標籤；史記用卷、莊子用篇。
- `anchorVa()` 的順序：`頁`（既有庫）→ `seg/char/entry/juan`（新庫）→ `塊.段`（sz）→ `null`。
  `juan` 只作 fallback／`targetScope`，不搶 semantic anchor。
- work／adb 解析順序：
  1. 已開啟的 adb（dbname、檔名）；
  2. catalog 的 work id／alias → edition（已安裝優先；`shuowen` 預設 `swjz`）；
  3. catalog 的 adb id／alias；
  4. 都沒有才走缺書引導。
- 多 work adb：`jing?元年` 有歧義（公羊、穀梁都有）→ 要求 work id；
  `jing?左傳/隱公/經元年` 可以，但對外不必。

### 4.2 落點（segment landing）

- 右欄／本側開 segment：從 `va` 畫到 `endVa`，不是畫到下一頁。
- 標題：`workTitle · path`（例「尚書 · 虞書 · 堯典」）；不要顯示頁碼。
- `hanCount=0` 的結構節點（虞書、國風…）：自動降到第一個有文字的子節點；
  段末 chip 也掛在那個子節點。
- `#a-b`：段內第 a–b 個漢字（含尾），用 `resolveCharPosition` 的 segment 分支，
  回傳 `CharBandHit` 給 `highlightCharBand`。
- 右欄分頁標題：`short + ' ' + anchorBase` 目前會顯示 `jing 乾`；改成
  `尚書 堯典` 這類人可讀寫法。

### 4.3 引文帶（forward）

- 只畫在**來源庫**（gycd、cyd、swjzz…）的正文；目標庫不畫自己的 incoming。
- 資料：xout record 的 `source_entry`＋`source_a/b`；先換成 absolute line/han，
  再用 [`paint.ts`](../../ts/src/accelon26/paint.ts:52) 的 `markRange` 包
  `<a class="citeBand" data-xref="...">`（跨節點已處理）。
- 視覺：常駐淡底線（`text-decoration: underline dotted` 或 2px 底線），
  hover 跳出「《尚書·堯典》」小卡；不要用高飽和底色（69,838 條會變彩虹）。
- 點擊：`openCharPosition({db: workId, anchor, a, b})`；目標 work 不在 catalog／未安裝
  → 走缺書引導，不要靜默。
- 同一個詞條的引文帶上限（例如 20 條）＋「更多」；超出的只在左欄「引文」頁籤看。
- 設定頁加「顯示引文連結」開關（預設開）。

### 4.4 反鏈（reverse）

- 單位：**段**。只顯示在段末（`endVa` 的最後一行之後），**不做 sticky**。
- chip 文字：`反 N · M 處`；N＝已開啟來源的 link 數，M＝去重後的
  `(anchor, a, b)` 數（同一句被多個詞條引用只算一處）。
- 只在該段有引用時出現；沒有引用庫或 0 條 → 不掛 chip。
- dropdown（平列，top 10，依「來源數→引用次數」排）：
  - 每列：引文（截 40 字）＋「N 個來源」；
  - 點列：跳到該 `a-b`（段內高亮）；
  - 底部：「全部 M 處」→ 左欄「引文」頁籤。
- 左欄「引文」頁籤（新 tab，僅在目前 adb 可當 target 且有來源時顯示）：
  - current work 範圍；
  - 平列該 work 的「處」，依次數排；點列跳段＋高亮；
  - 虛擬清單（曲禮上 398 處、全 work 可能上千）。
- 措辭：chip 用短標「反」；面板標題用「引用」；頁面版（taisho）維持「反鏈」。
  標題寫「已開啟 N 個引用庫」，沒有來源時寫「尚未開啟引用庫」。
- 資料來源：每個已開啟來源 adb 的 `xout_<work>`；只讀目前 adb 包含的 works
  （`worksOfBook`）。不要建全域 Map。

### 4.5 書 dropdown

- options＝`worksOfBook(adbId)`；顯示 `work.title`；目前 work 打勾。
- 切換：跳該 work 第一個有文字的 segment；同一個 tab（Ctrl／⌘ 新 tab）。
- doc tab 名稱：`work.title + '·' + leafLabel`；breadcrumb 仍由 tag 祖先產生。
- 只有 1 個 work 的 adb 不顯示。
- 同一 work 的多個 edition 同時開著時，晶片顯示 `說文解字注·swjz`／`·swjzz`
  （`registerOpenDb` 以 dbname 去重；顯示名相同不再互相取代，2026-11-06 已改）。

### 4.6 引用複製與跳至

- 格式：`《尚書·堯典》「彼茁者葭…」(shangshu?堯典#12-34)`。
- 前綴用 **work id**（不是 `jing`）；說文用 `shuowen?w0010010#0-3`，不指定 edition。
- 無 page 的 adb 不再產生 `?L123`；`L` 只留給真的沒有語意節點的庫。
- `findCharPosition` 先認完整 `prefix?path#a-b`，再退回「最後一個 `#` token」；
  `ANCHOR_RE` 要接受 `/`（消歧路徑）。
- 貼上整段引用 → 跳至（既有行為），不做 URL。

### 4.7 stale 與版本

- xout header 的 `manifestHash`／每筆 `targetTextHash` 與目前 target 不符時：
  chip 加 `stale` 樣式（灰、可點），dropdown／左欄顯示「依 X 版，原文已差 N 字」，
  點擊仍跳但標示，不靜默假裝正確。
- `shuowen` 的 edition：預設 `swjz`；若只裝 `swjzz`，resolver 退到它，UI 顯示
  「說文解字注（卷字版）」。不做 picker，未來可加「換版本」小按鈕。

### 4.8 卷：container，不是 citation unit

作者 2026-11-06：不喜歡卷（不是 semantic unit、不同版本也有差），但卷太常用，
必須標；至少可以把範圍收斂到約一萬字。現況要先分清楚：

| 庫 | 卷標記 | 卷 id | 現在怎麼用 |
|---|---|---|---|
| `jing`（十三經） | **無** `<卷>` | — | 章 259／節 1,448／項 300；章最大 **6,918 字**、p90 743 |
| `swjz`（說文章節版） | 無 `<卷>`；有 `chaptertitle` 31 個 | `chaptertitle.id`（v01…） | 章節只用 `v01` 這套 id |
| `swjzz`（說文卷字版） | `<卷>` 35 個 | `卷.id` 35（p01、v01…） | 卷 → 部 → 字；卷只用來分組 |
| `taisho` | `<卷>`（樹 `t="冊,卷."`） | **無 `卷.id`** | 只作閱讀／熱圖分組；anchor 是 `頁.id` |
| `shiji`／`hanshu`／`wenxuan`（計畫） | 將有 `<卷>` | 需新建 `vNNN` | 卷是目前唯一穩定的粗粒度容器 |

原則：

1. **引用一律用最深的 semantic anchor**（章／節／項／篇／字／詞）；卷只在沒有更深錨點時
   當 `juan:` fallback。不要把 `卷` 寫進正常引用。
2. 卷 id 用 canonical 卷次：說文用 `v01`（現有），新庫可用 `v001`；同一個 work 內位數
   一致即可。序／附錄另給（`p01`）；上／下卷用 `v001a`／`v001b`。不要用 adb 出現次序、
   不要用中文數字、不要只用 `卷.n`。
3. 不同 edition 的卷界不同時，**catalog 的 edition mapping 吸收差異**；work 層的引用不變。
   說文兩版就是實例：不要用卷號，用兩版共有的 `chapter:v01`（31 個，swjz 的
   `chaptertitle.id` 與 swjzz 的 `卷.id` 對得上）。
4. `jing` **不要加卷**：章最大 6,918 字，已經在「一萬字」內；再加一層只會讓地址更長。
5. `shiji`／`hanshu`／`wenxuan` 建置時一定要輸出 `<卷 id="vNNN" n="卷NNN">`；
   沒有 id 就無法用卷收斂，等於放棄最常用的引用單位。
6. UI：breadcrumb 照常顯示卷（container，顏色淡）；引用複製不用卷。只有卷時才寫
   `shiji?juan:v012#a-b`，顯示《史記·卷十二》；若 landing 是靠卷內引文比對，標
   「定位到卷」而不是假裝精確到段。
7. 反鏈：掛最深節點；只有卷時掛卷末。一卷約一萬字，chip 可能很遠；作者已定不做
   sticky，接受這個代價。
8. 卷最大的價值是 **fallback 範圍**：深錨失效時，只在該卷（≤約一萬字）內用引文比對，
   不要整本 work 搜。`xout` 的 `targetScope` 就是為此存在（§3.1）。

---

## 5. 工作分解

| 階段 | 內容 | 主要檔案 | 依賴 |
|---|---|---|---|
| **P0** | catalog：`jing` 改名、`shuowen` work、`pageScheme seg/char`、`editable:false`；work→adb resolver；修正「未安裝」誤報 | `make-book-catalog.ts`、`book-catalog-types.ts`、`xref.ts` | 無（可先做） |
| **P1** | `segment-index.ts`＋`anchorVa` 分支＋segment landing＋`#a-b`＋引用複製＋跳至語法＋書 dropdown＋`juan:` fallback（先只有邏輯，等有卷的庫） | 新 `segment-index.ts`、`page-text.ts`、`xref.ts`、`char-position.ts`、`bookmarks.ts`、`doc-pane.ts`、`ui.ts` | **可先用 swjz 試**（字 id 已存在），jing 重建後再驗 |
| **P2** | xout loader／索引＋引文帶＋段末反鏈＋左欄「引文」＋stale | 新 `xout.ts`、`doc-pane.ts`、`paint.ts`、`scopes.ts`、`ui.ts` | gycd 補 `source_entry`；jing／swjzz 有 xout |
| **P3** | 版本 badge／換版本、熱圖整合、效能調校 | 各處 | P2 數據 |

先用 **swjz** 當 pilot 的理由：`字.id` 10,706 筆已存在、它是 hub（5,291 個字頭有引用、
最多 10 條／字），可以先驗證 segment landing 與反鏈 chip，不必等 jing 重建。

---

## 6. 驗收

- [ ] `jing` 開著時，`yijing?乾#0-4`、`shangshu?堯典#12-34` 都在正確段落高亮。
- [ ] `jing?左傳/隱公/經元年` 能消歧；`jing?元年` 給「請用 work id」而不是亂跳。
- [ ] `shuowen?w0010010` 在只裝 swjz、只裝 swjzz、兩者都裝時都能落地（預設 swjz）。
- [ ] 段末 `反 N · M 處` 與資料一致（曲禮上：801／398）；top 10 平列；全部→左欄。
- [ ] 沒有引用庫時不出 chip，狀態列／空狀態說明「尚未開啟引用庫」。
- [ ] 引文帶只畫在來源庫；hover 顯示《尚書·堯典》；點擊到正確 a-b。
- [ ] 生成物不能編輯（編輯／F2 隱藏），書籤／筆記仍可用。
- [ ] 引用複製→貼上跳至 round-trip；不產生 `?L…`（有語意節點的庫）。
- [ ] 有卷的庫（建好後）：`shiji?juan:v012#a-b` 落在該卷並高亮；深錨失效時只在該卷內比對。
- [ ] 說文兩版：`shuowen?chapter:v01` 在 swjz／swjzz 指向同一個章；卷界不同不影響。
- [ ] `jing` 不出現任何卷 anchor（它沒有 `<卷>`，也不需要）。

---

## 7. 未定／風險

1. **dropdown 分組**：作者指示先平列；之後可能按來源詞典或詞條分組。資料多了再定。
2. **dropdown 每列點下去**：目前設計是「跳到該處」；「開來源詞條」要等 `source_entry` 有資料。
   要不要一列兩個動作（點＝跳處、箭頭＝開來源）？
3. **13j 改名**：localStorage 舊書籤／上次閱讀會孤兒化（不做相容）。可接受嗎？
4. **swjz／swjzz 的 edition 切換**：先只顯示、不做 picker；若使用者常要在兩版間跳，再加。
5. **xout 解析成本**：四庫全開時 links 可能上百萬；必須有 build-time offset 索引，
   否則開庫會卡。
6. **同名段**：work 內已用 `/` 消歧；跨 work 同名（公羊／穀梁「元年」）靠 work id，
   UI 不要用裸段名當唯一 key。
7. **0 漢字節點**：段末 chip 要掛到有文字的子節點；breadcrumb 仍顯示結構節點。

---

## 8. 參考

- [`ancient-book-xref-spec.md`](./ancient-book-xref-spec.md)：canonical（catalog、xout、LinkBus）
- [`interlink-markup-handoff.md`](./interlink-markup-handoff.md)：13j／swjz 定址例
- `D:\2026\cct\docs\link-efficiency-2026-11-06.md`：69,838 條實測、off-by-one 分析
- `D:\2026\cct\docs\anchor-proposal-13j-swjz.md`：2,007 節點、textHash 復現
- `D:\2026\gycd\interlink\COVERAGE.md`：四庫覆蓋率、座標系
