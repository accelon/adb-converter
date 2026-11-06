# ADB 互連語法、規範與 13j／swjz／swjzz 定址例

> 給「雙向鏈結 agent」的交接文件。  
> 版本：2026-11-06  
> 請先讀完再動資料；這份文件的任務不是照抄，而是**從實例推導出更穩定的 13j、
> swjz、swjzz 標記定址方案**。  
> 更高層的 canonical 規範另見 `docs/adb/ancient-book-xref-spec.md`；兩份衝突時以
> canonical spec 為準，並把這裡的推導結果回寫給作者。

---

## 0. 任務摘要

目標：50–100 本古書，引用庫（詞典、類書、注疏）可以雙向連到原文，而原文 adb
不必知道誰引用它，也不需要中央 `xref.adb`。

這份文件要 agent 做的事：

1. 用本文的語法與實例，理解現有 `<聯>`、`<詞>`、`<辭>`、`<頁>`、`<字>` 的定址方式。
2. 分析 `13j.adb`、`swjz.adb`、`swjzz.adb` 的實際標記。
3. 推導並提出三者的**最佳化定址方案**（work-scoped anchor、char anchor、migration）。
4. 用具體例子與驗收清單回報，不要先改正文。

先不要做的：

- 不要改 `13j`／`swjz`／`swjzz` 的正文。
- 不要建中央 xref。
- 不要把所有引文寫成 inline `<聯>`。
- 不要把頁碼／VA／byte offset 當永久地址。

---

## 1. 名詞

| 名詞 | 意思 |
|---|---|
| **work** | 書名身份，例如《易》＝`yijing`、《說文解字注》＝`shuowen`。引用用 work，不用 adb。 |
| **edition** | 某個 work 的版本／載體，例如 `13j` 的 `周易`、`swjz`、`swjzz`。 |
| **adb** | 目前裝載 work 的檔案，例如 `13j.adb`、`swjz.adb`。adb 可改名／拆併。 |
| **anchor** | work 內的位置，例如 `page:1`、`char:w0010010`、`entry:一毛不拔`。 |
| **a-b** | anchor 內的漢字序範圍（code point），不是 byte offset。 |
| **xout** | 引用庫自己的 outgoing links，按 work 分裝。 |
| **LinkBus** | runtime 把已開啟引用庫的 xout 注入原文的機制。 |

---

## 2. 現有 tag 語法

### 2.1 詞／詞譜

| tag | VA | 用途 |
|---|---:|---|
| `<詞>` | 正常 | 詞典詞頭；有 `b/j/w` 時是詞譜 span |
| `<_詞>` | 0 | 零 VA 的行內詞；不是詞頭 |
| `<辭>` | 正常 | cs 的詞譜 span |
| `<_辭>` | 0 | 零 VA 的 cs 詞譜 |
| `<詞 zy="…" py="…">` | 正常 | 詞頭旁注音／拼音；`zy` 是注音，`py` 是拼音 |

例：

```xml
<詞 id="1" zy="ㄧ ㄇㄠˊ">一毛不拔</詞>
<辭 b="rAj|ghM" j="0">rājagahaṃ</辭>
```

### 2.2 連結 tag

| tag | 行為 |
|---|---|
| `<聯 n="詞條">文字</聯>` | entry link；在目前庫查詞頭，同頁跳 |
| `<聯 n="詞條" newtab="1">` | entry link；另開分頁 |
| `<聯 i="work?anchor#a-b" q="引文">文字</聯>` | 跨 work／跨頁 xref |
| `<_名>詞條</_名>` | 詞典別名／參見；目標是標籤文字；另開分頁 |
| `<_聯>` | 同 `<聯>`，零 VA |

目前 renderer 已把 entry／xref 統一成 `a[data-link="entry|xref"]`；`_名` 的目標是文字，
`聯 n` 的目標是 `n`，`聯 i` 的目標是 `i` 優先。

### 2.3 頁、書、字

```xml
<書 id="周易">周易</書>
<頁 n="1"/>
<章>乾</章>

<卷 n="01" id="v01">說文解字第一篇上</卷>
<字 id="w0010010">一</字>
```

- `書 id`／`字 id` 是 adb 內穩定 id；`頁 n` 常是書內頁碼。
- `頁 n` 可能在不同書重複；`字 id` 在 swjz／swjzz 目前是跨版本共用。
- 不要用 VA 當跨庫地址。

---

## 3. 地址語法

### 3.1 對外 URL

```text
workId?anchor#a-b
```

例：

```text
yijing?page:1#0-4
shuowen?char:w0010010#0-1
cyd?entry:一毛不拔#0-3
```

- `workId` 優先由 catalog 的 `works` 解析。
- 舊資料可以暫時用 adb id：`13j?page:1`、`swjz?char:w0010010`；新引用一律用 work。
- `anchor` 只在該 work 內唯一；不需要全 adb 唯一。
- `a-b` 可省略；省略表示整個 anchor。

### 3.2 anchor 類型

| 類型 | 寫法 | 適用 |
|---|---|---|
| 頁 | `page:<pageId>` | 有明確頁碼的書；book 由 work edition 決定 |
| 字 | `char:<charId>` | 說文這種以字條為單位的書 |
| 條目 | `entry:<headword>` | 詞典 |
| 章節 | `chapter:<id>` | 沒有頁／字 id 的書；最後手段 |
| 行 | `line:<n>` | 舊資料 fallback，不用於新連結 |

### 3.3 重要限制

- work 必須能映射到 edition（adb＋adb 內 book）。
- 同一個 work 的多個 edition 可以共用 anchor；例如 swjz／swjzz 的 `char:w0010010`。
- 同一個 adb 內不同書的 `page:1` 不衝突，因為 work 已確定是哪一本書。
- 若沒有 work，`13j?page:1` 會歧義；不要這樣寫新連結。

---

## 4. 引用資料：xout

引用庫不建反鏈，只寫 outgoing：

```text
xout_<workId>
```

例：引用《易》→ `xout_yijing`；引用《說文》→ `xout_shuowen`。

Header：

```json
["XOUT1","yijing",2,"sha256:..."]
```

Record：

```json
["entry:一毛不拔", 12345, 0, 3, "page:1", 0, 4, "天行健，君子以自強不息", "quote", 92]
```

欄位：

```text
sourceAnchor, sourceVa, sourceA, sourceB,
targetAnchor, targetA, targetB,
quote, kind, confidence
```

- `sourceAnchor` 是引用庫內的錨點。
- `sourceVa` 只是本庫 fallback；可 -1。
- `targetAnchor` 是 **work 內**的 anchor。
- `quote` ≤240 漢字；顯示與比對用。
- `kind`：`quote`／`cite`／`mention`／`parallel`。
- `confidence` 0–100；太低不要寫入。

不要建 `xin`，不要把所有 target 混在一個 `xrev`。舊 `xrev` 只作 legacy fallback。

---

## 5. 實例一：13j（十三經）

### 5.1 現況

```xml
<集>十三經</集>
<隱><樹 s="*" t="書">目錄</樹></隱>

<書 t="章,節,項." id="周易">周易</書>
<頁元 n="周易"/>
<頁 n="1"/>
周易
<章>乾</章>
☰☰乾．元．享．利．貞．初九．潛龍勿用．…

<書 id="尚書">尚書</書>
<頁 n="1"/>
尚書
…
```

實測：

- 42,173 行
- 13 個 `<書 id>`：周易、尚書、毛詩、周禮、儀禮、禮記、左傳、公羊傳、穀梁傳、
  論語、孝經、爾雅、孟子
- 950 個 `<頁>`，只有 285 個不同的 `n`；`n="1"` 在十三本書重複
- 沒有 `<字 id>`

### 5.2 問題

`13j?page:1` 無法知道是《易》還是《尚書》。目前資料的 `<頁 n="1">` 不能單獨當
xref 目標。

### 5.3 建議方向（請 agent 驗證）

work-scoped：

```text
yijing?page:1#0-4
shangshu?page:1#0-3
```

catalog：

```json
{
  "id": "yijing",
  "title": "易",
  "aliases": ["易", "周易", "易經"],
  "editions": [{ "adb": "13j", "book": "周易" }]
}
```

- 目標 anchor 仍是 `page:1`，但由 work 決定 book。
- 不必把 950 個 `<頁 n>` 全部改成全域唯一；work 已消除歧義。
- 若 agent 認為要加 `id`，請提出 migration，不要只改 `n`（`n` 是顯示頁碼）。
- 需要的驗收：13 個 work 的 `page:1` 都能各自定位；`yijing?page:1` 與
  `shangshu?page:1` 不互撞。

### 5.4 引用例

```xml
<聯 i="yijing?page:1#0-4" q="天行健，君子以自強不息">天行健</聯>
```

xout：

```json
["entry:一毛不拔", 12345, 0, 3, "page:1", 0, 4, "天行健，君子以自強不息", "quote", 92]
```

container：`xout_yijing`。

---

## 6. 實例二：swjz／swjzz／swjzzp（說文解字注）

### 6.1 現況

`swjz.adb`：

```xml
<集>說文解字注</集>
<樹 s="$字">字頭</樹>
<樹 s="*字">全文</樹>
<chaptertitle id="v01">說文解字第一篇<duan_note>上</duan_note></chaptertitle>
<author>金壇段玉裁注</author>
…
<字 id="w0010010" img="001a-01">一</字><圖 n="seal/U4E00.svg"/>
<說文異>惟初大極。道立於一。造分天地。化成萬物。</說文異>
<段注>漢書曰。元元本本。數始於一。</段注>
<說文>凡一之屬皆从一。</說文>
```

`swjzz.adb`：

```xml
<集>說文解字注</集>
<隱><樹 s="*" t="卷">目錄</樹><樹 s="$字">字頭</樹><樹 s="*字">全文</樹></隱>
<卷 n="序1" id="p01">說文解字注序</卷>
<卷 n="01" id="v01" t="部,字.">說文解字第一篇上</卷>
<部 t="字.">一部</部>
<字 id="w0010010" img="001a-01">一</字><圖 n="seal/U4E00.svg"/>
<說文異>惟初大極，道立於一，造分天地，化成萬物。</說文異>
<段注>《漢書》曰：“元元本本。數始於一。</段注>
```

實測：

| adb | 行數 | `<字 id>` | unique | `<頁>` | chapter／卷 id |
|---|---:|---:|---:|---:|---:|
| `swjz` | 78,671 | 10,706 | 10,706 | 0 | 31 |
| `swjzz` | 60,754 | 10,706 | 10,706 | 0 | 35 |
| `swjzzp` | 60,754 | 10,706 | 10,706 | 0 | 35 |

三者 `<字 id>` 集合**完全相同**（10,706 個，交集 10,706）。

### 6.2 問題

- 沒有 `<頁>`，不能用 page anchor。
- `<字 id="w0010010">` 是唯一且跨版本共用，是最穩定的 anchor。
- `chaptertitle id="v01"` 與 `卷 id="v01"` 對應，但章節 id 不是每個字都有；
  字 id 更細、更穩定。

### 6.3 建議方向（請 agent 驗證）

work：`shuowen`（說文解字注）。editions：

```json
{
  "id": "shuowen",
  "title": "說文解字注",
  "aliases": ["說文解字注", "說文", "段注"],
  "editions": [
    { "adb": "swjz", "edition": "說文解字注（章節版）" },
    { "adb": "swjzz", "edition": "說文解字注（卷字版）" },
    { "adb": "swjzzp", "edition": "說文解字注（P 版）" }
  ]
}
```

anchor：

```text
shuowen?char:w0010010#0-1
```

- 同一 work 的不同 edition 共用 `char:w0010010`。
- 引用不必指定 `swjz` 或 `swjzz`；resolver 依版本／已安裝選 edition。
- 若引用要指定版本，可在 link hint／edition 欄位表達，但 anchor 仍是 char id。

### 6.4 引用例

```xml
<聯 i="shuowen?char:w0010010#0-1" q="惟初大極，道立於一">一</聯>
```

xout：

```json
["entry:一", 0, 0, 1, "char:w0010010", 0, 1, "惟初大極，道立於一", "quote", 95]
```

container：`xout_shuowen`。

---

## 7. 雙向鏈結的行為

### 7.1 正向

引用庫的 `<聯>`／xout 點擊：

1. `work` 由 catalog 解析。
2. 選 edition（已安裝優先）。
3. 在 edition 的 adb／book 找 targetAnchor。
4. 開目標頁；`a-b` 塗範圍；`q` 可作 fallback。

### 7.2 反向（LinkBus）

- 原文 adb 不存反鏈。
- 原文開啟時，用 catalog 的 `worksOfBook(adbId)` 知道自己包含哪些 works。
- 對每個已開啟的引用庫，讀 `xout_<workId>`。
- 引用庫後開時，只注入開著的原文；原文後開時，向已開啟引用庫要 buckets。
- UI 顯示「已開啟 N 個引用庫」，不能假裝全網。

例：`13j` 開著，沒有引用庫 → 沒有反鏈；`cyd` 後開 → 它的 `xout_yijing` 注入；
`cyd` 關閉 → 反鏈消失。

---

## 8. 缺書時的下載引導

引用庫點到 work，但本機沒有承載它的 adb：

1. `resolveWork()` → work。
2. `editions` 找 ready 的 adb；有 installed 就用 installed。
3. 桌面版：開「取得更多 ADB」；狀態列寫《易》（13j.adb）未安裝。
4. 網頁版：開 `https://shutonggui.cn/accelon26/adb/<adbId>.html`。
5. `status=wip`：顯示施工中，不引導下載。
6. 下載後重新點連結。

---

## 9. 要 agent 推導與回報的內容

請不要只回「照做」。用上面實例回答：

### 9.1 13j

- work-scoped `page:<n>` 是否足夠？還是要在 `<頁>` 加穩定 `id`？
- 如果加 `id`，建議格式是什麼（例：`周易-1`／`yijing:1`）？如何不影響 `n` 顯示？
- 13 個 `<書 id>` 如何對應 work catalog？列出完整 mapping。
- 如何驗證 950 個頁 marker 與 13 個 work 的組合沒有互撞？
- migration 要改哪些標記？是否要重建 `13j.adb`？成本？

### 9.2 swjz／swjzz／swjzzp

- 三者 10,706 個 `<字 id>` 完全相同，是否可直接用 `char:<id>` 作跨版本 anchor？
- `chaptertitle id`／`卷 id` 是否需要 `chapter:` anchor？哪些引用需要章節而不是字？
- `swjz` 沒有 `<卷>`，`swjzz` 有；work／edition 如何表達才不會讓引用依賴 adb 排版？
- 是否需要在 `<字>` 加 `work`／`edition` 屬性？還是只靠 catalog edition？
- 如何處理同一字在不同版本內容差異（異體、標點、段注）？引用要指「字條」還是「某段」？
- `a-b` 範圍以字條內漢字計，還是全 adb 頁內漢字？請明確定義。

### 9.3 通用

- 提出最終 anchor grammar（work、page、char、entry、chapter）與 URL 例子。
- 提出 xout record 的最終欄位（是否需要 edition、targetHash、work id）。
- 提出 build 流程：catalog 更新、xout 產生、link validation、死鏈報表。
- 提出向後相容：舊 `13j?1`、舊 `swjz` 無 work 的連結怎麼 fallback。
- 提供 10–20 個測試案例（含重複頁、跨版本同字、缺 edition、a-b 邊界）。

### 9.4 回報格式

```text
1. 建議 anchor grammar
2. 13j mapping 表（work → book → page 規則）
3. swjz/swjzz/swjzzp mapping 表（work → edition → char）
4. 需要改的標記 diff 範例（少量）
5. 遷移步驟與風險
6. 驗收命令／測試案例
7. 尚未確定的問題
```

---

## 10. 驗收清單

- [ ] `yijing?page:1` 與 `shangshu?page:1` 各自定位到正確的書。
- [ ] `13j` 的 950 個 `<頁>` 都有可解析的 work 所屬。
- [ ] `shuowen?char:w0010010` 在 swjz／swjzz／swjzzp 都能定位。
- [ ] 10,706 個字 id 無重複、跨版本交集 10,706。
- [ ] xout 只用 `xout_<workId>`，沒有 `xin`、沒有中央 xref。
- [ ] targetAnchor 在 work 內唯一；a-b 用漢字序。
- [ ] 缺 edition／缺 adb 時有下載引導，不跳錯頁。
- [ ] 舊 `<聯 i="13j?1">` 有 legacy fallback 或明確 deprecation。
- [ ] 文件與 catalog 的 work id／aliases 一致。

---

## 11. 参考檔案

- `docs/adb/ancient-book-xref-spec.md`：canonical 分散式 xref 規範
- `docs/adb/han-position.md`：漢字位置與 `j`／off
- `ts/src/accelon26/book-catalog.json`：works／editions 現況
- `ts/src/accelon26/book-catalog.ts`：`findWorks`／`resolveWork`／`worksOfBook`
- `ts/src/accelon26/link-spec.ts`、`word-spec.ts`：tag 語義
- `ts/src/accelon26/xref.ts`：現有 xref 點擊與 legacy
- 實際資料：`D:\accelon3\13j.adb`、`swjz.adb`、`swjzz.adb`、`swjzzp.adb`
