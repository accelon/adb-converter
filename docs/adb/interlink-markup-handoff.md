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
| **anchor** | work 內的位置，例如 `seg:乾`、`char:w0010010`、`entry:一毛不拔`。 |
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
yijing?seg:乾#a-b
shuowen?char:w0010010#a-b
cyd?entry:一毛不拔#0-3
```

- `workId` 優先由 catalog 的 `works` 解析。
- 舊資料可以暫時用 adb id：`13j?seg:乾`、`swjz?char:w0010010`；新引用一律用 work。
- `anchor` 只在該 work 內唯一；不需要全 adb 唯一。
- `a-b` 可省略；省略表示整個 anchor。

### 3.2 anchor 類型

| 類型 | 寫法 | 適用 |
|---|---|---|
| 語意段落 | `seg:<path>` | **13j 專用**；書→章→節→項，完整路徑 |
| 字 | `char:<charId>` | 說文這種以字條為單位的書 |
| 條目 | `entry:<headword>` | 詞典 |
| 頁 | `page:<pageId>` | 有真正穩定頁碼的書；**13j 不用** |
| 行 | `line:<n>` | 舊資料 fallback，不用於新連結 |

### 3.3 重要限制

- work 必須能映射到 edition（adb＋adb 內 book）。
- 同一個 work 的多個 edition 可以共用 anchor；例如 swjz／swjzz 的 `char:w0010010`。
- **13j 不能用 page**：`<頁 n="1">` 在十三本書重複，且頁不是引用單位；用語意段落。
- 13j 的 `seg:` 必須是完整祖先路徑，不能只用最深層標題（左傳的「經元年」會重複）。
- swjz／swjzz 用 `char:`，不用頁或行。

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
["entry:一毛不拔", 12345, 0, 3, "seg:乾", 0, 4, "天行健，君子以自強不息", "quote", 92]
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
<章>虞書</章>
<節>堯典</節>
…
```

實測：

- 42,173 行
- 13 個 `<書 id>`：周易、尚書、毛詩、周禮、儀禮、禮記、左傳、公羊傳、穀梁傳、
  論語、孝經、爾雅、孟子
- 259 個 `<章>`、1,448 個 `<節>`、300 個 `<項>`
- 950 個 `<頁>`，只有 285 個不同的 `n`；`n="1"` 在十三本書重複
- 沒有 `<字 id>`

各 work 的語意層級不同：

| work | 章 | 節 | 項 | 例子 |
|---|---:|---:|---:|---|
| 周易 | 69 | 0 | 0 | `章/乾` |
| 尚書 | 4 | 60 | 0 | `章/虞書` → `節/堯典` |
| 毛詩 | 6 | 34 | 300 | `章/國風` → `節/周南` → `項/關雎` |
| 周禮 | 6 | 369 | 0 | `章/天官冢宰` → `節/大宰` |
| 左傳 | 12 | 499 | 0 | `章/隱公` → `節/經元年` |
| 論語 | 20 | 0 | 0 | `章/學而` |
| 孟子 | 14 | 0 | 0 | `章/梁惠王上` |

### 5.2 問題

`13j?page:1` 無法知道是《易》還是《尚書》。而且 **page 不是引用單位**：
引用《尚書》會說「堯典」，引用《詩經》會說「周南·關雎」，引用《左傳》會說
「隱公·經元年」，不會說「第 1 頁」。

只用最深層標題也不夠：左傳的「經元年」在每個公之下都可能重複，必須保留祖先路徑。

### 5.3 建議方向：semantic segment

不要用 page；給語意節點加穩定 `id`，anchor 用完整路徑：

```xml
<書 id="周易">
  <章 id="乾">乾</章>
  …
<書 id="尚書">
  <章 id="虞書">虞書</章>
  <節 id="堯典">堯典</節>
  …
<書 id="毛詩">
  <章 id="國風">國風</章>
  <節 id="周南">周南</節>
  <項 id="關雎">關雎</項>
```

```text
yijing?seg:乾#a-b
shangshu?seg:虞書/堯典#a-b
shijing?seg:國風/周南/關雎#a-b
```

- `id` 只在該 work 內唯一；顯示文字可以照舊，不必等於 id。
- 祖先路徑用 `/` 串起；`seg:` 必須是完整路徑。
- `<頁>`／`<頁元>` 不再是 xref target；只作閱讀顯示。
- catalog 的 edition 只指 adb／book，不指 page。

### 5.4 引用例

```xml
<聯 i="yijing?seg:乾#0-4" q="天行健，君子以自強不息">天行健</聯>
```

xout：

```json
["entry:一毛不拔", 12345, 0, 3, "seg:乾", 0, 4, "天行健，君子以自強不息", "quote", 92]
```

container：`xout_yijing`。

### 5.5 要 agent 回答

- 13j 的 `<章>`／`<節>`／`<項>` 應如何加 `id`？用原文標題、slug，還是建置序號？
- 完整路徑的 escaping／分隔符規則（`/` 是否會出現在標題？）。
- 沒有最深層節點的 work（例如只有 `<章>`）如何定義 segment？
- 同一個標題在不同祖先下重複（左傳「經元年」）如何驗證唯一？
- 引用只到 work 層（沒有章節）時，anchor 用什麼？
- 需不需要保留 `page` 作 fallback？作者已定：**13j 不用書頁**，所以不要以 page 作 primary。

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

## 7. Prebuild xout 的穩定定位 gate

Prebuild 可以離線跑，但**不能接受模糊定位**。只有通過以下 gate 的 link 才可寫入 xout。

### 7.1 Target anchor manifest

每個 target edition 建置時要產生一份 anchor manifest（可放 adb 的 `anchors` 容器，
或由建置工具輸出）：

```text
anchorId, kind, parentBook, ancestorPath, physicalVa, textHash
```

例：

```text
yijing   seg:乾             書=周易   path=乾
shangshu seg:虞書/堯典      書=尚書   path=虞書/堯典
shuowen  char:w0010010      book=—   va=...
```

- `anchorId` 在 work 內唯一；manifest 有重複就直接 fail。
- `a-b` 是相對 anchor 文字的漢字序，不是 adb 全頁 offset。
- 原文改版後 anchorId 不變；變的是 `textHash`。
- 13j 的 anchor 是語意路徑，不是 page；`<頁>`／`<頁元>` 不進 manifest。

### 7.2 xout 記錄要帶穩定資訊

```json
["XOUT1","yijing",2,"targetManifestHash","targetEdition"]
...
["entry:一毛不拔",12345,0,3,"seg:乾",0,4,"天行健...","quote",92,"targetTextHash"]
```

最低要求：

- `targetAnchor` 只能是 manifest 裡存在的 id。
- `targetA/B` 必須落在該 anchor 的文字範圍內。
- `targetTextHash` 對應 anchor 的 normalized text；不吻合就標 stale。
- header 的 `targetEdition`／`manifestHash` 讓 runtime 知道這批 xout 是對哪一版算的。

### 7.3 Prebuild 驗收

- [ ] `yijing?seg:乾` 與 `shangshu?seg:虞書/堯典` 都存在且唯一。
- [ ] 13j 的 `<頁元>`／`<頁>` 不當成 `seg:` anchor（它們不是引用單位）。
- [ ] 13j 每個 work 的 segment path 在該 work 內唯一；祖先路徑完整。
- [ ] swjz／swjzz／swjzzp 的 10,706 個 `char:` id 全部存在，交集 10,706。
- [ ] 每個 accepted link 的 quote 能在 target anchor 內精確或容許異體地對上。
- [ ] dead／ambiguous 不寫入 xout，只進 report；超過門檻 fail。
- [ ] 沒有 manifest 的 target（未建置／版本不符）不得 prebuild 成正式 xout。

### 7.4 為什麼 13j 不直接用 page

- `<頁 n="1">` 在十三本書重複；`13j?page:1` 有歧義。
- 頁不是引用單位；引用是「尚書·堯典」「左傳·隱公·經元年」這種語意段落。
- 頁碼會因版本／排版變動；semantic path 才是穩定身份。
- swjz／swjzz 沒有 `<頁>`；只能用 `<字 id>`。
- VA 會隨版本／切分變動，不能當永久 anchor。
- 所以 target 必須是 `work + anchorId`；`seg:`／`char:` 才是 anchor 的種類。

---

## 8. 雙向鏈結的行為

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

## 9. 缺書時的下載引導

引用庫點到 work，但本機沒有承載它的 adb：

1. `resolveWork()` → work。
2. `editions` 找 ready 的 adb；有 installed 就用 installed。
3. 桌面版：開「取得更多 ADB」；狀態列寫《易》（13j.adb）未安裝。
4. 網頁版：開 `https://shutonggui.cn/accelon26/adb/<adbId>.html`。
5. `status=wip`：顯示施工中，不引導下載。
6. 下載後重新點連結。

---

## 10. 要 agent 推導與回報的內容

請不要只回「照做」。用上面實例回答：

### 9.1 13j

- 13j 的 semantic segment 應如何加 `id`？（原文標題、slug、建置序號？）
- 完整祖先路徑要包含哪些層？只用最深層標題為何不夠（左傳例子）？
- 13 個 `<書 id>` 如何對應 work catalog？列出完整 mapping。
- 如何驗證 259 章、1,448 節、300 項的路徑在各自 work 內唯一？
- 哪些引用只需要到「書」層？沒有章節的 work 如何定義 root segment？
- migration 要改哪些標記？是否要重建 `13j.adb`？成本？
- 作者已定：**13j 不用書頁**；不要再提 page 作 primary。

### 9.2 swjz／swjzz／swjzzp

- 三者 10,706 個 `<字 id>` 完全相同，是否可直接用 `char:<id>` 作跨版本 anchor？
- `chaptertitle id`／`卷 id` 是否需要 `chapter:` anchor？哪些引用需要章節而不是字？
- `swjz` 沒有 `<卷>`，`swjzz` 有；work／edition 如何表達才不會讓引用依賴 adb 排版？
- 是否需要在 `<字>` 加 `work`／`edition` 屬性？還是只靠 catalog edition？
- 如何處理同一字在不同版本內容差異（異體、標點、段注）？引用要指「字條」還是「某段」？
- `a-b` 範圍以字條內漢字計，還是全 adb 頁內漢字？請明確定義。

### 9.3 通用

- 提出最終 anchor grammar（work、seg、char、entry）與 URL 例子。
- 提出 xout record 的最終欄位（是否需要 edition、targetHash、work id）。
- 提出 build 流程：catalog 更新、xout 產生、link validation、死鏈報表。
- 提出向後相容：舊 `13j?1`、舊 `swjz` 無 work 的連結怎麼 fallback。
- 提供 10–20 個測試案例（含重複頁、跨版本同字、缺 edition、a-b 邊界）。

### 9.4 回報格式

```text
1. 建議 anchor grammar
2. 13j mapping 表（work → book → semantic path 規則）
3. swjz/swjzz/swjzzp mapping 表（work → edition → char）
4. 需要改的標記 diff 範例（少量）
5. 遷移步驟與風險
6. 驗收命令／測試案例
7. 尚未確定的問題
```

---

## 11. 驗收清單

- [ ] `yijing?seg:乾` 與 `shangshu?seg:虞書/堯典` 各自定位到正確的書與段落。
- [ ] 13j 的 13 個 work、259 章、1,448 節、300 項都有可解析的祖先路徑。
- [ ] `13j` 的 `<頁>`／`<頁元>` 不當 xref primary；只作閱讀顯示。
- [ ] `shuowen?char:w0010010` 在 swjz／swjzz／swjzzp 都能定位。
- [ ] 10,706 個字 id 無重複、跨版本交集 10,706。
- [ ] xout 只用 `xout_<workId>`，沒有 `xin`、沒有中央 xref。
- [ ] targetAnchor 在 work 內唯一；a-b 用漢字序。
- [ ] 缺 edition／缺 adb 時有下載引導，不跳錯頁。
- [ ] 舊 `<聯 i="13j?1">` 有 legacy fallback 或明確 deprecation。
- [ ] 文件與 catalog 的 work id／aliases 一致。

---

## 12. 参考檔案

- `docs/adb/ancient-book-xref-spec.md`：canonical 分散式 xref 規範
- `docs/adb/han-position.md`：漢字位置與 `j`／off
- `ts/src/accelon26/book-catalog.json`：works／editions 現況
- `ts/src/accelon26/book-catalog.ts`：`findWorks`／`resolveWork`／`worksOfBook`
- `ts/src/accelon26/link-spec.ts`、`word-spec.ts`：tag 語義
- `ts/src/accelon26/xref.ts`：現有 xref 點擊與 legacy
- 實際資料：`D:\accelon3\13j.adb`、`swjz.adb`、`swjzz.adb`、`swjzzp.adb`

