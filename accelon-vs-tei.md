# Accelon 風格 XML（H1–H6 擴充）與 TEI 巢式結構對照

> **一句話**：Accelon 的 XML 是「**帶位址的標記流**」——標籤是插在文字裡的游標／里程碑，範圍由「下一個同標籤」推導；
> TEI 是「**巢狀文件樹**」——範圍由收尾標籤顯式界定。兩者可以描述同一部書，但一邊容許交錯、重疊、無根、標籤不閉合，
> 另一邊要求嚴格的樹狀合法 XML。
>
> **這個差別最大的回報**：Accelon 的文字可以**任意取一行或數行單獨渲染**，不需要祖先、根或前後文；
> 「不合法」不是缺陷，而是為了這件事付的代價（見 §4）。
>
> 對照來源：`13j.adb`、`yinshun.adb`、`fgdict.adb`、`kangxizidian` 的實際內文（`build/` 匯出樣本）、
> Delphi 原始碼與 [SPEC.md](SPEC.md)、[FORMAT.md](FORMAT.md)、[ts/src/xmlrepair.ts](ts/src/xmlrepair.ts)。2026-10-16。

---

## 1. 兩份心智模型

| | Accelon 風格 XML | XML / TEI |
|---|---|---|
| 局部可渲染 | **任一（連續）區間可單獨渲染**：只需要那幾行（見 §4） | 片段無法單獨解析；章節資訊要先取到根的路徑 |
| 本質 | 檢索資料庫的內文流（`source` 容器解壓後就是它） | 交換用的文件實例 |
| 樹從哪來 | 由標籤實例的**位置推導**（衍生） | 由元素**嵌套**直接表示 |
| 標籤語義 | 自訂 h1–h6：標記一個「點」，範圍到**下一個同標籤** | `<div>` ＋ `<head>`：範圍＝元素本身 |
| 合法 XML | **不保證**（無根、交錯、未閉合、裸 `&`） | 必須合法（單一根、正確嵌套） |
| 層級 | 由 `t=` 宣告決定，標籤名不帶層級 | 由 `<div>` 嵌套深度（或 `div1…div7`）決定 |
| 誰定義標籤 | 外部 docdef（`TAG`／`ATTR`／`skip`／`cached`…） | ODD（`<schemaSpec>`）→ RELAX NG／DTD |
| 檢索 | 內建反向索引（`tokens`／`tags` 容器）＋ `s=` scope | 文件不含索引；查詢（XPath／CQL）在文件之外 |
| 位址 | VA／PA 雙位址系；標籤佔 4 VA（skip 則 0） | 無；位置＝DOM 路徑 |

## 2. 同一段內容，兩種寫法

### 2.1 十三經（`13j.adb`）

Accelon 內文（原樣；行與行之間只是換行，不是標籤）：

~~~xml
<集>十三經</集>
<隱><樹 s="*" t="書">目錄</樹></隱>
<書 t="章,節,項." id="周易">周易</書>
<頁元 n="周易"/>

<頁 n="1"/>
周易

<章>乾</章>
☰☰乾．元．享．利．貞．初九．潛龍勿用．…（本文）
~~~

TEI 等價：

~~~xml
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <fileDesc>
      <titleStmt><title>十三經</title></titleStmt>
      <publicationStmt><p/></publicationStmt>
      <sourceDesc><p>13j.adb</p></sourceDesc>
    </fileDesc>
  </teiHeader>
  <text>
    <body>
      <div type="book" n="周易" xml:id="bk-zhouyi">
        <head>周易</head>
        <pb n="1"/>
        <div type="chapter" xml:id="bk-zhouyi-ch1">
          <head>乾</head>
          <p>☰☰乾．元．享．利．貞．初九．潛龍勿用．…</p>
        </div>
      </div>
    </body>
  </text>
</TEI>
~~~

三個關鍵位移：

1. `<章>乾</章>` 的 `</章>` **關的是標題，不是本章** → TEI 要把 `</div>` 移到本章末尾。
2. `<頁 n="1"/>` 是**里程碑**，不是容器 → TEI 保留成空元素 `<pb n="1"/>`，位置不變。
3. `<集>`／`<樹>`／`<書 t=…>` 是書目與檢索宣告，不屬於正文 → 書目移入 `teiHeader`；
   樹宣告在 TEI 沒有對應元素（見 §7）。

### 2.2 佛光大辭典（`fgdict.adb`）

`fgdict.xml`（第 1 檔；整檔只有宣告）：

~~~xml
<檔 n="fgdict.xml">
<集>佛光大辭典</集>
<英文名>Foguang Buddhist Dictionary</英文名>

<樹 s="$詞">名相</樹>
<樹 s="*詞">全文</樹>
<樹 s="頁.n" t="書,頁.">原書分頁</樹>
</檔>
~~~

`fgdict1.xml`（正文開始）：

~~~xml
<書 l="序,版本,編輯" t="詞.">佛光大辭典(一)</書>
…
<_頁 n="1"/>

<詞>一</詞>
(一)數之單位。如「第一」或「一位」。
　　(二)表示所有、皆是之義。
~~~

TEI 等價（詞條用 `<entry>`，見 TEI §9 Dictionaries）：

~~~xml
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <fileDesc>
      <titleStmt>
        <title>佛光大辭典</title>
        <title type="english">Foguang Buddhist Dictionary</title>
      </titleStmt>
      …
    </fileDesc>
  </teiHeader>
  <text>
    <body>
      <div type="volume" n="1">
        <head>佛光大辭典(一)</head>
        <pb n="1"/>
        <entry xml:id="fg-0001">
          <form type="lemma"><orth>一</orth></form>
          <sense n="1"><p>(一)數之單位。如「第一」或「一位」。</p></sense>
          <sense n="2"><p>(二)表示所有、皆是之義。</p></sense>
        </entry>
      </div>
    </body>
  </text>
</TEI>
~~~

注意 `<_頁 n="1"/>` 的前導底線，見 §6.4。

## 3. 核心差異：範圍是「推導」的，不是「界定」的

~~~
Accelon:   <章>乾</章>        …本文…            <章>坤</章>   …本文…
           └─ 標題 ─┘   └── 章「乾」的範圍 ──┘  └─ 標題 ─┘

TEI:       <div type="chapter"><head>乾</head>…本文…</div>
           └──────── 章「乾」的範圍＝這個元素 ────────┘
~~~

Accelon 這側的推導規則（實作見 [search.ts](ts/src/adbview/search.ts)）：

1. **節點範圍** ＝ `[自己, 下一個同標籤實例)`：`vaEnd` 是下一個同標籤的位址，不是 `</章>` 的位置。
2. **層級** ＝ `<樹 t="…">` 宣告的層序；每個實例可用自己的 `t=` 再往下加層（`<書 t="章,節,項.">`），
   結尾的 `.`（常數 `STOPNESTING`，[basetype.pas:223](sourcecode/basetype.pas#L223)）＝末層、不再下探。
3. **同標籤不可互相嵌套**（`<h2>` 包 `<h2>` 的寫法在此格式無意義）。
4. 父節點的範圍會**延伸**到能容納子節點（書標籤在章之前，章的範圍仍算在書內）。

所以同一份內文可以同時是很多棵樹：`頁` 平時是里程碑（`single` ＋ `SKIP`），
在 `<樹 s="頁.n" t="書,頁.">` 裡卻是第 2 層節點；`書` 在 13j 是根（`<樹 t="書">`），
在 fgdict 是容器（`<書 t="詞.">`）。TEI 沒有這個自由度：元素在樹上的層級是固定的，
要第二種視圖得用 `standOff` 或另寫 schema。

## 4. 最大的好處：任一（連續）區間都能獨立渲染

> 這是整個格式的設計紅利，也是它「不合法」的真正原因：**節點的開頭就在節點自己身上**，
> 沒有任何必要資訊放在「邊界」上，所以任意切片都不會切斷一個容器，
> 也完全不受其他 node 影響。

### 4.1 機制：資訊就地在「點」上

1. **開頭就地**：標籤實例就在文字流的那個位置。要渲染第 500 行，只需要第 500 行。
2. **名字就地**：節點標題在標籤自己的內容（`<章>乾</章>`）、或它自己的屬性（`n=`、`id=`、`l=`）、或 `caches`。
3. **子層就地**：下一層由**這個節點自己的** `t=` 宣告（逐實例），不是靠「現在有幾個開標籤還開著」推導。
4. **沒有收尾**：不需要配對，所以不存在「半個 `<p>`」，切片也沒有起點限制。
5. **位址 O(1)**：`tables/lines.physical`／`lines.virtual` 是**累積**行表，定位某一行只是二分搜尋；
   內容只解該行跨越的 `source` 塊（每塊獨立 bzip2）。`srcpack.pas` 的 `getrange_physical(s, e)`
   本身就是「給我任意位元組區間」的一級 API（SPEC §7.3）。

### 4.2 實測：切片到底有多自足

掃描 yinshun 45 檔 ＋ fgdict 4 檔 ＋ 13j ＋ kangxi（51 檔、927,994 行）：

| 項目 | 數量 | 比例 |
|---|---:|---:|
| 完全沒有標籤的行（本來就是純文字） | 828,900 | 89.3% |
| 有標籤的行 | 99,094 | 10.7% |
| 開標籤總數 | 141,467 | — |
| **收尾不在同一行的開標籤** | **5,048** | **3.6%** |

那 5,048 個的分佈：`字` 2,444、`釋` 1,241、`聯` 464、`圖文字` 451、`注` 252、`頌` 116、`檔` 49、`詞` 23、`時` 8。
`章`、`書`、`節`、`頁`、`段` 在樣本中**一次都沒有跨行** → 區塊結構 100% 就地自足。

結論：**文字與區塊結構永遠可以直接渲染**；只有「跨行的行內標註」在切片邊緣會少掉開標籤——
那一小段仍然顯示文字，只是少一層樣式或註釋歸屬。分頁（每頁 200 行）能成立就是靠這個性質。

### 4.3 為什麼 TEI 做不到

- TEI 的層級資訊放在**邊界**上：`<div type="chapter" n="3">` 的 `@type`／`@n` 與 `<head>乾</head>`，
  都在片段的**前面**。切一段中間的 `<p>` 出來，片段沒有根、有未配對的收尾，解析器直接拒絕；
  就算補一個假根，也答不出「這是第幾章」。
- TEI 也有「就地」的元素：`<pb>`／`<cb>`／`<lb>`／`<milestone>`。這正是原書分頁一定要用它們的原因；
  但章節層級沒有這種形式——`<div>` 只能是容器。
- TEI §21 的幾種重疊解法（空元素定界、切段＋`@part`／`@next`／`@prev`、`standOff`），
  本質都是在**繞過「開合必須配對」**這個限制；Accelon 一開始就不配對，所以不必繞。
- 代價正好相反：TEI 一份檔案同時是資料與結構；Accelon 的結構是外掛的索引，必須另外存。

### 4.4 這正是 adb 把「文字」與「索引」分開存的原因

- `source` ＝ 可任意切片渲染的文字流；`tags`／`tokens`／`tables`／`attributes` ＝ 全域上下文
  （「這一行在哪一章」、「這一章有幾個命中」、「第幾頁」）。
- 所以 adbview 的渲染成本只跟**畫面大小**有關，與資料庫大小無關：
  每個節點只載入自己的 VA 區間、200 行一頁、用 `Blob.slice()` 讀任意塊。
  `.adb` 能做到 4.7 G 字規模，這是根本原因。
- TEI 要做同樣的事，得先把整棵樹載入或先「補齊祖先」，成本隨文件大小成長。
- 歷史脈絡：`.adb` 在**光盤時代**成形，當時 random seek 極貴，所以佈局刻意讓「一次 seek 就取得畫面所需的連續區塊」
  （`caches` 先算好節點值、行表累積、每塊獨立 bzip2 且連續）——見 [SPEC.md](SPEC.md) §2.1。

## 5. 逐項對照表

| 面向 | Accelon 風格 XML | XML / TEI |
|---|---|---|
| 片段獨立渲染 | 任一行／任一 VA 區間都可直接渲染；樹是外掛的索引（見 §4） | 必須有根與祖先才能解析，結構資訊放在邊界上 |
| 根元素 | 沒有。頂層是並排的兄弟（`<集>…`、`<隱>…`、`<書>…`、文字…） | 必須單一根 `<TEI>` |
| 文件邊界 | `<檔 n="…">` 是**不閉合的檔分隔**（yinshun） | 一檔一個 `<TEI>`；合集用 `<teiCorpus>`／`<group>` |
| 標頭 | 用一般對標籤 `<集>`／`<英文名>`／`<參考資料>` 塞在正文最前面 | 強制 `<teiHeader>`（fileDesc／encodingDesc／profileDesc／revisionDesc） |
| 章節 | `<章>`、`<節>`、`<項>`…（名字自訂） | `<div type="…">`，標題用 `<head>` |
| 層級 | 由 `t=` 逐實例宣告 | 由嵌套深度；或 `div1…div7`（編號分層，兩種不可混用，TEI §4.1.2） |
| 標題 | 標籤的**內容**就是標題，範圍靠下一個實例 | `<div>` 內的第一個 `<head>` |
| 段落 | `<段/>`（single 標籤）＋靠換行分行 | `<p>…</p>` |
| 頁／欄／行 | `<頁 n="1"/>`、`<欄/>`（single，`SKIP`） | `<pb n="1"/>`、`<cb/>`、`<lb/>`；通用時 `<milestone unit="…" n="…"/>`（TEI §3.10） |
| 行內強調 | `<粗>…</粗>` | `<hi rend="bold">` |
| 註解 | `<註 n="…">`、`<釋 n="…">` | `<note>`、`<note type="…">` |
| 連結 | `<聯 n="…">`、`<連 n="…">`（目標在 `n`） | `<ref target="#id">`、`<ptr target="#id">`；整批用 `<linkGrp>/<link>` |
| 圖片 | `<圖 f="…" l="…"/>` | `<graphic url="…" facs="…"/>` |
| 引用 | `<引>`（格式由 `pf`／`pf1`／`sf` 等前後綴屬性描述） | `<quote>`／`<cit>`／`<bibl>`，格式用 `@rend` |
| 詞條 | `<詞>…</詞>` 包住詞頭（＋ `caches/詞` 字串表） | `<entry><form type="lemma"><orth>…</orth></form>` |
| 標籤宣告 | 外部 docdef：`TAG 頁 single ATTR n SKIP`、`TAG 集 pair cached`… | ODD → RNG／DTD schema |
| 屬性存放 | 外置於 `attributes` 容器的 `<標籤>.<屬性>` 塊；正文只留標籤＋值 | 寫在元素上；`xml:id`、`n`、`type`、`rend`、`facs`… |
| 屬性名的角色 | `t`＝樹層序、`s`＝檢索 scope、`n`＝名／連結目標、`l`＝葉、`c`＝命令、`p`＝分頁、`o`＝排序、`i`＝linkto、`id`、`f`＝檔、`y`＝樣式、`pf/sf`＝前後綴 | `n`／`type` 只是資料；樹、檢索、分頁**不在**屬性裡 |
| 唯一識別 | `id=` 屬性＋`聯 n=` 指向；同名值可能重複 | `xml:id`（全樹唯一）＋`@target` |
| 檢索索引 | 內建 `tokens`（yinshun 9,516 個）＋`tags` 命中表；`s=` scope 決定「搜什麼」 | 文件不含索引；`<standOff>`／`<linkGrp>`／外部資料庫 |
| 重疊結構 | 免費（標籤可任意交錯、重疊） | 不允許；靠 TEI §21 的策略 |
| 文字外的資料 | `caches`（標籤→節點值字串表）、`attributes.sorted`、`tables` | 元素本身；或 `standOff` |
| 編碼 | UTF-16LE 碼元流，行界由 `tables/lines.*` 指出 | UTF-8／UTF-16 由 XML declaration 宣告，行界不具語義 |
| 非法字元 | 只警告（裸 `<` 讓 VA 少一格而已） | 解析失敗 |
| 驗證 | `TDocDef.Validate`：只查**同名**開合，沒有堆疊；跨名交錯不報錯（SPEC §16） | well-formedness ＋ schema 驗證 |

## 6. Accelon 相對 HTML `<h1>…<h6>` 的「擴充」

1. **標籤名任意**：`<章>`、`<詞>`、`<頁>` 都是資料庫自訂名，甚至可以拿標點當標籤名
   （yinshun 有一個標籤名是 U+FF61 半形句點，見 [xmlrepair.ts](ts/src/xmlrepair.ts#L66)）。
2. **層級外置**：`<h1>…<h6>` 用名字表達層級；Accelon 用 `t="章,節,項."` 宣告，
   同一個標籤可以在不同樹、不同層。
3. **成對與否由 docdef 決定**：`single`（里程碑，如 `頁`）、`pair`（`書`、`章`）、`dontcare`（`圖`）。
   寫錯格式（`<頁>…</頁>`、`<章/>`）會整支丟掉並印 `invalid Single Tag`／`invalid Pair Tag`（SPEC §16）。
4. **可以不佔位址**：VA 是索引座標系，標籤預設佔 4 格。要「隱形」有兩條路：
   - docdef 寫 `SKIP`：`TAG PN single ATTR n SKIP`（[index.pas:191](sourcecode/index.pas#L191)）；
   - 名字前加 `_`：`<_頁 n="1"/>` 會被拆成標籤 `頁` ＋ `skip=true`（[tokenize.pas:630](sourcecode/tokenize.pas#L630)）。
   實測 fgdict：內文有 **6,959 個 `<_頁 n="N"/>`、0 個 `<頁>`**，而 `tags` 容器裡的名字是 `頁`、
   命中數 6,959 → `_` 在索引時就被剝掉，且不佔 VA。
   另有硬編碼的預設 skip 標籤：`亮 頁 粗 註 聯 連 維` 與 `HL PN BOLD RM LINK SLINK NOTE`（[tokenize.pas:94](sourcecode/tokenize.pas#L94)）。
5. **`cached`**：宣告為 cached 的標籤，內文會**去標籤、截斷、trim** 後存進 `caches/標籤名`，
   讓「取節點名」不必回讀原文（fgdict 的 `caches/詞` 就是 22,648 個詞頭；`MAXCACHELINE=256`）。
6. **`s=` 檢索 scope**：把搜尋視圖寫進文件本身——
   `*` 全文、`$詞` 只搜 `<詞>` 包裹的內文、`*u=文` 用 `<文>` 分段統計、
   `~00602000` 只搜該碼點區間的 token、`頁.n` 以 `頁` 的 `n` 屬性為鍵。
7. **`t=` 逐實例長出樹**：`<樹 s="*" t="書">` 只給第一層，`<書 t="章,節,項.">` 再給下一層。
8. **不需要合法，因為範圍是衍生的**：跨名嵌套（`<a><b></a></b>`）、未閉合、裸 `&` 都只影響 VA 或靜靜通過，
   沒有「開合必須配對」這個約束要維護，這正是 §4 能成立的前提。
   唯一用堆疊修補的是檢視器的 `makeValidXML`（[tokenize.pas:745](sourcecode/tokenize.pas#L745)），
   索引與匯出路徑都不呼叫它。

## 7. TEI 那一側的對等機制

| Accelon 機制 | TEI 對等／替代 |
|---|---|
| `<章>`／`t=` 樹 | `<div type="chapter" n="…"><head>…</head>` 嵌套 |
| `<頁 n="1"/>`（SKIP） | `<pb n="1"/>`；欄 `<cb/>`、行 `<lb/>`；自訂 `<milestone unit="…" n="…"/>` |
| `<聯 n="…">` | `<ref target="#xml:id">`／`<ptr>`；整批參照 `<linkGrp>/<link>` |
| `<註>`／`<釋>` | `<note>`（可 `@type`、`@place`） |
| `<圖 f="…"/>` | `<graphic url="…"/>`（或 `<figure>`） |
| `<引 pf1=…>`（用屬性表達前後綴） | `<quote>`／`<cit>`／`<bibl>`；格式交給 `@rend`／樣式表 |
| `<隱>` | 無對應；用 `@rend`，或移入 `teiHeader`／`standOff` |
| `<樹 s=…>`（檢索視圖） | 無對應元素；ODD 客製 ＋ 查詢端（XPath／CQL）表達 |
| `<詞>` ＋ `caches/詞` | `<entry><form><orth>`（TEI §9 Dictionaries） |
| 重疊／交錯 | TEI §21：多重編碼、空元素定界、切段＋`@part`／`@next`／`@prev`、`standOff`、非 XML |
| docdef（`TAG`／`ATTR`／`SKIP`／`cached`） | ODD（`<schemaSpec>`）產生的 RNG／DTD |
| `檔`（不閉合的分檔符） | 一檔一個 `<TEI>`；合集用 `<teiCorpus>`／`<text><group>` |

## 8. 轉換處方

### 8.1 Accelon → TEI

1. 先做**合法化**（[xmlrepair.ts](ts/src/xmlrepair.ts) 已實作整條；只有要交給 XML 工具才需要，
   adbview 直接渲染並不需要，見 §4）：補根、逃脫裸 `&`／`<`、
   補或丟收尾標籤、屬性補引號、丟 C0 控制字元與孤立代理、必要時把標籤名改寫成安全名。
2. 切文件：碰到 `<檔>` 開一份新 `<TEI>`；最後一個開著的 `<檔>` 補 `</檔>` 或用檔案邊界。
3. 建 `teiHeader`：`集` → `titleStmt/title`、`英文名` → 第二個 `title`、
   `參考資料` → `sourceDesc`／`listBibl`、`書 l=` 的葉清單 → `@rend` 或 `profileDesc`。
4. 依 `t=` 鏈把每個標籤實例轉成 `<div type="<標籤>">`：`<head>`＝該標籤的內容，
   `</div>` 放在範圍末端（下一個同標籤之前，且要包住子層）。
5. single 標籤（`頁`、`欄`、`頁元`、`圖`）→ 空元素（`<pb/>`、`<cb/>`、`<milestone/>`、`<graphic/>`）。
6. 行內標籤（`粗`、`聯`、`註`、`釋`）→ `<hi>`、`<ref>`、`<note>`；
   `聯 n=` 的目標要用 `xml:id` 重建。
7. 標籤外的純文字行聚成 `<p>`（Accelon 沒有段落容器，只有 `<段/>` 或換行）。
8. 交叉核對：用 expat 驗 well-formedness，再比對「文字中的標籤實例數」與 `tags` 容器命中數（SPEC §16 第 1 點）。

### 8.2 TEI → Accelon

1. 寫 docdef：`TAG <名> single|pair [ATTR …] [SKIP] [cached]`；`<div type>` 對應的標籤多半用 `pair`，
   `<pb/>` 對應的用 `single ATTR n SKIP`。
2. 為每棵要給讀者的樹寫 `<樹 s="…" t="…">`；`t=` 列出層序，末層加 `.`。
   注意 `.` 是宣告層語法，不會出現在文字裡。
3. 把嵌套的 `<div>` **展平**成「標題對標籤 ＋ 範圍到下一實例」：
   `<div><head>乾</head><p>…</p></div>` → `<章>乾</章>` ＋ 本文。
4. 空元素轉 single 標籤；要讓里程碑不佔位址時，用 `<頁 n="1"/>`（docdef `SKIP`）或 `<_頁 n="1"/>`（`_` 前綴）。
5. 屬性：`@n` 留成 `n=`、`@xml:id` 留成 `id=`、其餘自訂屬性照抄；
   帶語義的屬性名（`t`／`s`／`l`／`p`／`o`／`i`／`y`）必須照 Accelon 的定義使用。
6. 重建索引：`tokens`／`tags`／`tables` 由 [index-builder.ts](ts/src/index-builder.ts) 依 VA 規則重算，
   不從 TEI 帶進來。

## 9. 實測陷阱（都可在本機複驗）

| 陷阱 | 實測 |
|---|---|
| 標籤不閉合 | yinshun 的 `<檔>` 從不閉合（`xml-lint` 判為 `separator`）；匯出時補 `</檔>` |
| 交錯／錯收尾 | 全語料 `xml-lint`：`mismatch=18,348`、`entity=11,870`、`unterminated=464`（[README.md](README.md)） |
| 裸 `&` | 12,000+ 處；XML 解析器直接拒絕，`xmlrepair` 改成 `&amp;` |
| 標籤名是標點 | yinshun 有一個標籤名 U+FF61；XML 1.0 第 5 版其實允許，但 expat 等老解析器不接受 → 匯出器改寫成 `_uXXXX` |
| 漢字標籤名 | `詞`、`書`、`頁` 在 XML 1.0 是合法 NameStartChar（#x3001–#xD7FF），不必改寫，但要留意工具鏈 |
| `_` 前綴 | fgdict 內文是 `<_頁 n="1"/>` → 索引成 `頁` 且 skip；直接餵 XML 解析器時它的名字是 `_頁` |
| `cached` 的文字有損 | `caches/詞` 是去標籤、截斷、trim 過的；要完整詞條得回讀原文 |
| 同名標籤宣告兩次 | 預設 docdef 裡 `TAG RM pair`（釋）與 `TAG RM single ATTR n SKIP`（註）同名（[index.pas:212](sourcecode/index.pas#L212)、[index.pas:221](sourcecode/index.pas#L221)）→ 建庫只印警告 |
| 標籤被丟但文字還在 | docdef 沒宣告的標籤（`Undefine tag`）整支跳過：不佔 VA、不進 `tags`，但**文字仍留在內文** |
| 屬性空值 | yinshun 的 `檔.n` 值是空字串，得改走 `caches` 或回讀原文（SPEC §10） |

## 10. 什麼時候用哪一種

- **要任意切片渲染（只載當前畫面）、要檢索、要比對位址、要保留原書的搜尋視圖** → Accelon／`.adb`：
  任意一行都能單獨渲染（§4），索引與文字同檔，標籤可以不佔位址，內文可以「不合法」，
  換來任意視圖與 4.7 G 字規模的即時搜尋。
- **要交換、要長期保存、要給別人用工具讀** → TEI：合法 XML、schema 可驗，書目與標註分層
  （`teiHeader`／`standOff`）。
- **兩者互補**：`adb` 當「索引 ＋ 原樣內文」，TEI 當「交換／典藏格式」。
  轉換的難點只有一個——把「下一個同標籤」推導成「巢狀 `div`」，其餘是機械替換。

## 11. 附錄

### A. 預設標籤宣告（[index.pas:137](sourcecode/index.pas#L137) `defaulttag`）

~~~pascal
TAG FILE pair ATTR n            // 檔
TAG COLLECTION pair cached      // 集
TAG BK pair                     // 書
TAG BOLD pair                   // 粗
TAG CHAPTER pair                // 章
TAG SECTION pair                // 節
TAG ENAME pair                  // 英文名
TAG TREE pair                   // 樹
TAG EXCERPT pair                // 引
TAG MERGEHEAD pair              // 摘要頭
TAG LINKDB single               // 參考資料
TAG HIDE pair                   // 隱
TAG IMAGE single ATTR f ATTR l  // 圖
TAG EIMAGE single ATTR f ATTR l // 嵌圖
TAG IMAGETXT pair               // 圖文字
TAG PN single ATTR n SKIP       // 頁
TAG SUB single ATTR n SKIP      // 上標
TAG COL single                  // 欄
TAG PU                          // 頁元
TAG PR single ATTR a            // 段
TAG SK pair TAG PALI pair TAG TIBET pair
TAG RM pair                     // 釋
TAG LINK pair ATTR n SKIP       // 聯
TAG SLINK pair ATTR n           // 連
TAG RM single ATTR n SKIP       // 註
TAG RN pair ATTR n              // 釋
~~~

docdef 可用的命令：`TAG`、`ATTR`、`skip`、`cached`、`ignore`、`single`、`pair`、
`andtag`、`DUMP`、`version`、`hidden`、`isdict`、`maxchar`。
沒有 `TREE` 命令——樹是 `樹` 標籤 ＋ `t=`／`s=` 屬性（[document.pas:179](sourcecode/document.pas#L179)）。

### B. 中文 ↔ 英文標籤名（[basetype.pas:520](sourcecode/basetype.pas#L520) `translatetagname`）

| 中文 | 英文 | 中文 | 英文 |
|---|---|---|---|
| 亮 | HL | 頁 | PN |
| 樹 | TREE | 頁元 | PU |
| 檔 | FILE | 註 | RM |
| 英文名 | ENAME | 釋 | RN |
| 參考資料 | LINKDB | 聯 | LINK |
| 段 | PR | 維 | WIKILINK |
| 集 | COLLECTION | 連 | SLINK |
| 書 | BK | 圖 | IMAGE |
| 粗 | BOLD | 嵌圖 | EIMAGE |
| 併 | MERGE | 圖片 | WPIMAGE |
| 隱 | HIDE | 摘要頭 | MERGEHEAD |
| 引 | EXCERPT | 圖文字 | IMAGETXT |

### C. 本機樣本

| 檔案 | 內容 |
|---|---|
| `build/oracle/13j.xml` | 13j 全文（42,173 行）；從 `<書 t="章,節,項." id="周易">` 起 |
| `build/out-yinshun-delphi/yinshun.xml` | yinshun 第 1 檔：`<集>`＋三個 `<樹>`＋`<引>/<摘要頭>/<參考資料>` |
| `build/out-yinshun-delphi/y01.xml` | yinshun 正文：`<書 l="目次,序" t="記" id="1">`、`<頁元 t="頁.">`、`<頁 id="1pa1"/>` |
| `build/oracle-kangxi/kangxi.xml` | 字典庫：`<字>一</字>` ＋ `<拼>/<注>/<古>` |
| `build/tei-cmp-fgdict/` | `bun run src/cli.ts export ../fgdict.adb -o ../build/tei-cmp-fgdict` 的輸出 |

以上都在 `build/`，不進版控；用 `bun run src/cli.ts export` 可隨時重生。
