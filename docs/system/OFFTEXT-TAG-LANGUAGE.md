# Offtext 的表達層：自定義標籤語法與註冊表

> 前提：選 offtext 不是為了編輯方便，是為了 Markdown 給不了的表達力——自定義、語意化、可重疊、
> 可抽取的標籤。手工編輯麻煩一點可以接受，表達力不能妥協。
>
> 一句話：**表達力來自「語法 ＋ 註冊表 ＋ 位置模型」，不是來自更多標籤。沒有註冊表的自定義標籤，
> 只是更難維護的 Markdown。**

---

## 0. Markdown 到底缺什麼

| 需求 | Markdown | offtext 應有 |
|---|---|---|
| 自定義語意 | 只有固定語法（強調、連結、標題、code） | `^term【…】`、`^src<…>`、`^var<…>` 任意定義 |
| 行內 span | 巢狀有限、不能帶屬性 | 任意 tag ＋ attrs ＋ span |
| 零寬標記 | 沒有 | `^pg3`、`^src<…>`（不佔文字） |
| 重疊註記 | 不可能（HTML 也不鼓勵） | standoff：同一段文字可有多個 tag |
| 機器可讀 schema | 沒有 | 標籤註冊表（型別、屬性、驗證器） |
| 未知語法容忍 | 渲染成字面 | 保留、降級、不丟內容 |
| 抽取／合併 | 靠正則，脆弱 | 位置＋tag id，可精確抽取 |
| 多目標輸出 | 固定 | HTML／Markdown／plain／JSON 各自 renderer |

Markdown 的擴充（MDX、directives）要嘛綁 JS，要嘛沒有 schema；它們是「文件裡跑程式」，
不是「文件裡放語意」。offtext 的定位應該是後者。

**但目前實作只做了 `^[...]` 一種標籤。** `basicofftag.md` 描述的 `^pg3`、`^name<attrs>`、
`^ck1【…】`、多層 id，在 `nestedtext-core.ts`／`editor/parse.ts` 裡都還沒有。也就是說，
你要的表達力目前只存在於規格書，不在程式裡。第一件事不是加內容，是把這一層做成真的。

---

## 1. 三個層次，不要混在一起

| 層 | 責任 | 產物 |
|---|---|---|
| **語法層** | 把 `^…` 字串切成 token／AST，記位置 | `{tag, id, attrs, start, end}` |
| **語意層** | 這個 tag 是什麼、允許什麼屬性、怎麼驗證 | 標籤註冊表（JSON） |
| **位置層** | 標籤落在哪、能不能重疊、怎麼序列化 | inline 或 standoff |

三者分開，才能「加一個標籤」不用改 parser、不用改 renderer、不用改 AI prompt。

---

## 2. 語法：先正規化，再談擴充

### 2.1 正規形式

```
offtag   := '^' name (id)? (param)* (attrs)? (span)?
name     := [a-z_]+
id       := '#' [0-9A-Za-z_.-]+
param    := ('@' | ':' | '/' | '-' | '~' | '|') [^\s^<>【】]+
attrs    := '<' (attr (','? attr)*)? '>'
attr     := key ('=' value)?
value    := '"' ([^"\\] | '\\' .)* '"' | [^\s,>]+
span     := open inner close        // open/close 是配對括號，見 2.3
```

例：

```
^pg3                                 零寬，頁碼 3
^src<t=T18.0848c09 q="一切智慧者">   零寬，引用錨點
^term#t1【涅槃】                      span，術語
^note#n1<kind=editor>【編者按】       span，附屬性
^var<w=K>【説】                       span，異文（高麗藏作「説」）
^[佛]                                引用（`^ref` 的糖）
```

### 2.2 正規化規則（新內容一律這樣寫）

1. **id 一律加 `#`**。舊的 `^pg3` 仍接受（向後相容），但新內容不要依賴「數字開頭就是 id」。
2. **name 不含數字**（`[a-z_]+`）。要編號用 id，不要用 `^pg1`、`^pg2` 當不同 tag。
3. **屬性值含空白、`>`、`"` 時必須加引號**；跳脫只有 `\"` 與 `\\`。
4. **span 的開括號決定收括號**（見 2.3），不允許用 `]` 收 `【`。
5. **`^` 是保留字**；文字中要寫字面的 `^`，用 `^^`。這是唯一需要跳脫的字元。
6. **未知語法當普通文字**，不要讓 parser 丟例外（現在的 `^[` 找不到 `]` 就是這樣處理）。

### 2.3 括號配對

`basicofftag.md` 已經列了可用的成對括號（Unicode 值相差 1）：`()`, `「」`, `『』`, `〔〕`, `（）`,
`【】`, `《》`, `〈〉`, `︽︾`, `︿﹀`, `﹁﹂`, `﹃﹄`, `﹙﹚`, `﹝﹞`, `‘’`, `“”`, `〝〞`。
`︵︶` 保留給拼形式。

parser 用**配對表**，不要用「codepoint + 1」硬算；`‘’`、`“”` 的差值雖然是 1，但表格比較安全。
巢狀 span 的收括號要按堆疊配對，不能只用 `indexOf`。

### 2.4 巢狀與重疊

* **巢狀**（`^term【…^note【…】…】`）：支援，深度上限 8；超過就當文字。
* **重疊**（同一段文字同時是 term 與 src）：inline 語法**表達不了**，這是 Markdown 也有的限制。
  解法不是發明更複雜的 inline 語法，而是把 canonical 換成 standoff（§4）。
* 目前的「夾文不能有 `^`、最多 16 字」是為了簡化 parser；要表達力就必須放寬（至少允許巢狀與更長的 span），
  代價是 parser 與 renderer 變複雜。這個代價值得付，因為它是你選 offtext 的原因。

### 2.5 `^[...]` 的角色

`^[目標]`、`^[顯示名|目標]`、`^[目標@domain]` 保留為**引用**的糖，等價於 `^ref` + span：
`^ref<to=目標>`。好處是既有 1,831 條不用改；壞處是 parser 要認兩種形式。建議：

* 新內容可以用 `^ref<to=…>【顯示名】`；
* 舊內容 `^[...]` 照舊；
* 內部 AST 一律轉成同一種 ref 節點。

---

## 3. 標籤註冊表：表達力的護欄

沒有註冊表，自定義標籤會變成每個作者一套方言：AI 看不懂、renderer 不認識、讀者看到一堆 `^foo`。
註冊表不是限制表達力，是讓表達力**可被工具使用**。

### 3.1 一個標籤的定義

```jsonc
{
  "name": "src",
  "kind": "zero",                    // zero | span | ref | block
  "status": "stable",                // experimental | stable | deprecated
  "since": "1.0",
  "scope": ["entry", "claim"],       // 允許出現的地方
  "attrs": {
    "t": { "type": "string", "required": true, "pattern": "^T\\d{1,2}\\.\\d{1,4}[a-c]\\d{0,2}$" },
    "q": { "type": "string" },
    "k": { "type": "string" }
  },
  "content": "none",                 // none | text | inline
  "render": "citation-chip",
  "validate": "resolve-taisho",      // 可選；指向一個 resolver
  "doc": "大正藏引用錨點；t=T<vol>.<page><col><line>"
}
```

### 3.2 六個核心標籤（先做這些）

| tag | kind | 用途 | 主要屬性 |
|---|---|---|---|
| `ref`／`^[…]` | ref | 條目引用 | `to`, `domain`, `display` |
| `src` | zero | 引用錨點（T/K/辭典頁） | `t`, `k`, `q`, `page` |
| `term` | span | 術語、關鍵詞 | `id`, `lang` |
| `note` | span | 註、按語 | `kind`, `n` |
| `pg` | zero | 頁碼／原書分頁 | `n`, `edition` |
| `fig` | zero | 圖片 | `n`, `alt` |

進階：`claim`（span，帶 `status`／`type`）、`var`（span，異文）、`quote`（span，逐字引文）、
`link`（URL）、`hide`（排版用）。

### 3.3 未知標籤的規則

* **保留，不丟**：未知 tag 原樣留在 AST／存檔裡。
* **降級渲染**：zero 看不見；span 只渲染內文；ref 顯示目標名。
* **編輯器警告**：`^foo` 標黃，提示「未註冊」。
* **AI 草稿拒絕**：AI 只能用註冊表裡的 tag；新 tag 要走提案（§6）。

這是「可擴充」和「不混亂」之間的唯一可行折衷。

### 3.4 來源映射也放在註冊表

轉換 adb 時，`註`→`^note`、`頁`→`^pg`、`圖`→`^fig`、`聯`→`^ref` 的規則不要散在 extractor 裡。
註冊表可以宣告：

```jsonc
"srcmap": {
  "adb": { "註": "note", "釋": "note", "頁": "pg", "圖": "fig", "聯": "ref" }
}
```

轉換器只認這張表；新增一個來源標籤時，改資料不改程式。這也是「表達層」與「轉換層」的分界。

### 3.5 全域與科目本地標籤

* **核心 tag**（`ref`／`src`／`term`／`note`／`pg`／`fig`）全域註冊，所有科目共用。
* **科目本地 tag**：科目可以在 `data/<id>.tags.json` 宣告自己的 tag（醫學的 `^dose`、法律的 `^article`）。
  本地 tag 只在該科目有效；不要跨科使用——要跨科就升級成核心 tag。
* AI 的調色盤 = 核心 tag ＋ 當前科目的本地 tag；切換科目時調色盤跟著換。

這樣「表達力」可以是每個領域自己的，而不是把全世界的 tag 都塞進一個全域表。

---

## 4. 位置模型：inline 寫，standoff 存

### 4.1 為什麼要 standoff

Markdown 和目前的 offtext 都是 inline：標籤和文字在同一條字串裡。inline 的限制是**重疊**——
一段文字同時是「術語」和「引文」時，`^term【…】` 與 `^quote【…】` 無法互相包住而不改變語意。

standoff 把文字與標註分開：

```jsonc
text: "涅槃是佛教的核心概念。"
annotations: [
  {"tag":"term",  "id":"t1", "start":0, "end":2, "attrs":{}},
  {"tag":"quote",            "start":0, "end":2, "attrs":{}},
  {"tag":"src",              "start":0, "end":0, "attrs":{"t":"T12.0345a01"}},
  {"tag":"note",  "id":"n1", "start":0, "end":2, "attrs":{}}
]
```

同一段文字可以有三個標註；文字本身不變。這正是 adb 的模型（文字＋位置），也是
`basicofftag.md` 說的「offtag 可以抽走、合併、過濾、再併入」。offtext 既然以此為設計目標，
canonical 就應該是 standoff，而不是 inline。

### 4.2 兩種寫法，一個模型

* **inline（作者寫的）**：`^term【涅槃】`。
* **standoff（機器存的）**：`{tag, start, end}`。

流程：inline → parser → annotations；renderer 從 annotations 產生 HTML／Markdown。
inline 能表達的（巢狀、零寬）直接轉；表達不了的（重疊）只能在 standoff 補。

### 4.3 重疊的序列化

需要把 standoff 寫回 inline 時：

* 不重疊的 span：正常輸出。
* 重疊的 span：**不要**硬塞進 inline。存 standoff；需要 inline 版時，拆成多段並共用同一個 `id`
  與 `cont=1`（續段），由 renderer 合併。拆段會讓文字看起來被切開，所以 inline 版只給人看，
  不作為 canonical。
* 結論：**inline 是方便的作者介面，不是完整的儲存格式。** 接受這一點，才不會為了「inline 也能表達重疊」
  發明一套沒人看得懂的語法。

### 4.4 位置單位

* 以 **Unicode code point** 計（`Array.from(text).length`），與 `editor/parse.ts` 的 `charLength` 一致。
* 與 JS 字串索引（UTF-16 code unit）之間要有一層轉換；astral 字元（如 U+20BB7）只算一個位置。
* 不接受未配對代理；匯入 adb 文字時先檢查（adb 內有 362 個未配對代理的 token 名稱）。

---

## 5. 渲染與匯出：Markdown 是投影，不是來源

每個 tag 在註冊表指定 renderer：

| 目標 | `term` | `src` | `note` | `fig` |
|---|---|---|---|---|
| HTML | `<span class=term>` | 來源 chip | 上標＋popover | `<img>` |
| Markdown | `**涅槃**` 或 `<span>` | `[^1]` 腳註 | 腳註 | `![]()` |
| plain | 內文 | 省略 | 省略 | `[圖]` |
| JSON | `{type:"term",text:"涅槃"}` | `{t:…}` | `{n:1}` | `{src:…}` |

重點：**Markdown 匯出一定是有損的**，這沒關係；offtext 是來源，Markdown 是給外部工具的投影。
反過來（Markdown → offtext）不做，或只做一次性匯入，不承諾 round-trip。

這樣「Markdown 表達力不夠」就不再是問題：你不需要在 Markdown 裡表達，你只需要匯出。

---

## 6. AI 與標籤：給調色盤，不給自由發揮

AI 是主要編輯者，但它不該發明標籤。做法：

1. **調色盤（palette）由註冊表生成**：每個 tag 一行——名稱、kind、屬性、一個例子、一句用途。
   放進 system prompt，長度可控（20 個 tag ≈ 1–2 KB）。
2. **AI 只能使用調色盤裡的 tag**；驗證器拒絕未註冊 tag。
3. **新 tag 提案**：AI 可以輸出 `proposal: {name, why, example}`，由人審核後加入註冊表、
   renderer、測試；通過後才進調色盤。
4. **AI 的輸出形式**：文字＋標註串流（或 inline），而不是純散文；diff 以 annotation 為單位。
5. **可解釋性**：每個 tag 的 `doc` 就是 AI 的說明書；不要讓 AI 從名字猜語意。

這樣表達力是**可擴充的**（加 tag 很容易），但不會變成**不可維護的**（每個 tag 都有定義與 renderer）。

---

## 7. claim／evidence 是標籤家族，不是另一個格式

上一份文件的 claim 表，在表達層就是幾個 tag：

```
^src<t=T18.0848c09 q="一切智慧者">        引用錨點（零寬）
^claim#c1<status=verified type=lexical>【佛，梵語 buddha 的音譯】  主張（span）
^var<w=K>【説】                          異文
^note#n1【編者按】                        註
```

好處：

* 一個 parser、一個註冊表、一個 renderer；
* claim 不再是一張與正文脫節的 JSON 表，而是文字上的標註；
* `claim` 的 `status`／`type` 由註冊表驗證；`src` 由 resolver 驗證；
* 抽取 index（給 AI 檢索）時，掃 annotations 即可，不需要另外維護 sidecar。

`claims.jsonl` 仍然可以有，但它是**索引／快取**，不是真相；真相是「文字＋標註」。

---

## 8. 容器：TSV 不夠的時候

TSV 的限制不是「一條一行」，而是：

* value 不能換行、不能含 tab；
* 不能存重疊標註；
* 長條目（fgdict 因明 13,769 字）沒有地方放段落結構；
* 屬性多了以後，一行會很長、diff 很醜。

三個選項：

| 方案 | 優點 | 缺點 | 何時用 |
|---|---|---|---|
| A. TSV ＋ 跳脫 | 改動最小 | 可讀性差；重疊仍不行 | 短期 |
| B. 區塊格式 `.otx` | 多行、段落、可讀、diff 友善 | 要新 parser／工具 | **長條目／匯入內容**（建議） |
| C. JSONL | 好程式處理 | 人難讀、diff 差 | 機器 intermediary |

建議：**短條目留 TSV，長條目用 `.otx` 區塊格式，編譯時合成同一份文件模型。**
`.otx` 例：

```
{id:"fgdict", name:"佛光大辭典"}

@entry 佛
佛教的最高覺悟者，梵語 buddha 的音譯。^src<t=T18.0848c09 q="…">

@entry 因明
^h2【梵語與漢譯】
…
^h2【印度諸派】
…
```

`@entry` 是區塊層的 tag；`##` 只是內文的標題（或改用 `^h2【…】`，避免和 Markdown 撞）。
重點是**entry 邊界明確、value 可多行、標註仍用同一套語法**。

---

## 9. 先做什麼（兩週）

| 週 | 工作 | 驗收 |
|---|---|---|
| 1 | 語法 spec＋parser（正規形式＋舊 `^[…]`＋巢狀＋跳脫） | `basicofftag.md` 的每個例子都能 parse；未知語法不 crash |
| 1 | 註冊表 JSON＋6 個核心 tag（ref／src／term／note／pg／fig） | 每個 tag 有 attrs、renderer、validator 名稱 |
| 2 | inline ↔ standoff 轉換＋位置（code point） | 100 條隨機片段 round-trip；重疊案例有測試 |
| 2 | renderer（HTML／Markdown／plain）＋未知 tag 降級 | 同一條 entry 三種輸出；未知 tag 不丟字 |
| 2 | 端到端：fgdict「佛」＋`^src` 指向 T18 | 點 source chip 看到 T 原文 |

先不要做：完整 schema 語言、GUI 標籤編輯器、所有 tag 的 renderer、1,831 條的遷移。

---

## 10. 不要做

| 不要 | 理由 |
|---|---|
| 沒有註冊表就讓作者自創 tag | 半年後沒人知道 `^xq` 是什麼；AI 也無法用 |
| 用 Markdown＋外掛當 canonical | 表達力仍受限，且 schema 在程式裡，不在資料裡 |
| 為重疊發明複雜 inline 語法 | 直接 standoff；inline 只做作者介面 |
| 一次註冊 50 個 tag | 先 6 個跑通；tag 是成本，不是越多越好 |
| 讓 AI 自由發明 tag | 調色盤＋提案流程 |
| 把 TSV 改成資料庫 | 先解決表達層，容器是最後一步 |

---

## 11. 風險

| 風險 | 對策 |
|---|---|
| 語法歧義（`^pg3`、`^name:param`） | 正規形式＋舊形式相容層；parser 測試集 |
| 巢狀／跳脫讓 parser 變慢 | 一次 parse 快取 AST；entry 級快取 |
| 標籤膨脹 | 註冊表審核；`status: experimental` 到期淘汰 |
| renderer 爆炸 | 共用 5 種 primitive（chip／span／block／figure／link） |
| inline 與 standoff 不一致 | 單一方向：inline → standoff；standoff 是真相 |
| 舊內容不相容 | `^[…]` 保留；未知 tag 降級；逐條遷移，不強制 |

---

## 附錄：與 Markdown／TEI 的定位

| | Markdown | TEI | offtext |
|---|---|---|---|
| 語意 | 固定 | 固定但龐大 | 自定義＋註冊表 |
| 標籤 | 無 | 元素 | offtag |
| 位置 | inline | inline（樹） | inline 寫、standoff 存 |
| 重疊 | 不行 | 不行（樹） | 可以 |
| 工具 | 遍地 | 學術 | 自己寫（所以語法要小） |
| 適合 | 通用文件 | 學術交換 | 知識庫／AI 編輯 |

offtext 的競爭優勢不是「比 Markdown 好寫」，而是「比 Markdown 更能裝語意，又比 TEI 小」。
把這句話守住，就不會在「更方便」和「更表達」之間走錯方向。
