# Offtext 的事實層：給 AI 編輯的格式建議

> 前提：`.adb` 是紙書數位化的遺產格式（線性、頁／行、CD-ROM 成本模型）；offtext 是數位原生格式的探索；
> AI 是主要編輯者；內容必須基於紙書的事實。
>
> 一句話：**AI 編輯的瓶頸不是生成，是驗證。格式要為「編輯—驗證」迴圈設計，閱讀只是編譯出來的視圖。**
>
> 這份文件補充 [UPGRADE-DIRECTIONS.md](UPGRADE-DIRECTIONS.md) 的方向三，並修正它的優先序：
> 先做引用與驗證，再做檢索索引，容器最後。
>
> 表達層（自定義標籤、註冊表、standoff 位置）見 [OFFTEXT-TAG-LANGUAGE.md](OFFTEXT-TAG-LANGUAGE.md)；
> 本文件的 claim／evidence 是其中一組標籤，不是另一套格式。

---

## 0. 重新定位：三層，而不是兩種格式

現在是 `adb（紙書）→ offtext（條目）` 的兩層跳躍。缺的是中間那層：

| 層 | 內容 | 特性 | 誰在用 |
|---|---|---|---|
| **L0 證據層** | 紙書掃描／OCR／adb 文字；頁、行、VA 位址；hash | 不可變、可定址、可引用 | 引用解析、原文回看 |
| **L1 主張層** | claim（主詞—關係—受詞）＋ evidence（引用）＋ status | 原子、可驗證、可 diff | AI 編輯、審核、回歸測試 |
| **L2 閱讀層** | offtext 條目／TSV／HTML／圖譜 | 好讀、可展開、可匯出 | 讀者 |

現在 L0 直接跳到 L2：條目是一段散文，沒有「這句話憑什麼」的欄位。於是**唯一安全的事實策略就是少寫事實**——
`subject-spec.md` 的「不確定的年份、數字、人名不要寫」、`prompt-guide.md` 的「事實精度：不寫具體年份」，
都是這個缺口的症狀，不是編輯偏好。

**推論**：要讓 AI 敢寫精確的事實，先給它一個能附證據的位置。這就是 L1。

---

## 1. 七個建議

### 1.1 adb 只做「證據」，不要當「待轉換的格式」

adb 的價值不是它的容器，是它的**位址**：`檔`、`頁`、行表、VA 範圍、`註`／`釋`／`聯` 的位置。
這些正好是引用需要的錨點。

做法：

* 凍結 adb（唯讀、不改寫）；把它當 L0。
* 建一個 **citation resolver**：`(db, doc, vaStart, vaEnd) → {quote, page, hash}`。
  內部用行表（`lines.virtual`）與 `vapa` 取文字，不靠 VA 走訪、不走 XML 合法化。
* 頁碼由 `頁` 標籤／`頁.n` 屬性取得；沒有頁碼的庫用「行號 + 百分比」當後備錨點。
* 每個來源記 `sha256(quote)`，引用過期或原文變動時可偵測。

這樣「轉換」的工作從「把 4.7 G 字變成條目」縮小成「把引用解析到 span」。前者是不可完成的編輯工程，
後者是幾百行的服務。

### 1.2 把「主張」變成第一類物件；條目只是視圖

AI 不該直接改一段散文，它應該改**原子主張**：

```
claim = 主詞 + 關係 + 受詞（值） + 限定（時間／版本／範圍） + evidence[] + status
```

例（示意，fgdict）：

```jsonc
{"id":"c:fgdict:佛:01", "subject":"佛", "predicate":"詞源", "object":"梵語 buddha 的音譯",
 "type":"lexical", "evidence":["s:fgdict:p123:va4567"], "status":"verified"}
```

條目的散文是這些 claim 的**編譯結果**（或至少是「每句都掛得到 claim」的視圖）。
好處：

* 驗證單位變小（一句 vs 一條）；
* diff 有意義（改了哪個 claim，不是「這段文字變了」）；
* 可回歸測試（claim 集合是測資）；
* 可多來源（同一 claim 可有兩份 evidence，或兩個並存版本）。

> 注意：`^[...]` 引用是**閱讀導覽**，不是證據。它回答「讀者接下來可以看什麼」；
> 證據回答「這句話憑什麼」。兩者可以重疊，但不能互相代替。
>
> 在表達層，claim 就是 `^claim#id<…>【…】` 標籤、evidence 就是 `^src<…>` 零寬錨點
> （見 [OFFTEXT-TAG-LANGUAGE.md](OFFTEXT-TAG-LANGUAGE.md) §7）；下面的 JSON 是索引／快取，
> 不是另一份真相。

### 1.3 引用要「引文優先」，而且機器可驗證

只記頁碼不夠：頁碼會隨版本改變，也無法證明 AI 沒亂寫。用 **quote-first** 的錨點：

```jsonc
{"id":"s:fgdict:p123:va4567",
 "db":"fgdict", "doc":"fgdict1.xml", "edition":"佛光大辭典-1988", "page":"123",
 "va":[4567,4590], "quote":"佛，梵語 buddha 之音譯……",
 "hash":"sha256:…", "rights":"excerpt"}
```

這是 W3C Web Annotation 的 `TextQuoteSelector` ＋ `TextPositionSelector` 組合；頁面圖像用 IIIF。
驗證器做三件事：

1. `quote` 必須能在 `va` 範圍內找到（正規化異體字、標點、空白後比對）；
2. `hash` 必須等於目前解析出的文字；
3. claim 的 evidence id 必須存在，且由檢索服務發出（不是模型自己編的）。

第 3 點是關鍵：**citation id 由工具發，不讓模型發**。模型只能挑「檢索回來的證據」，不能發明出處。
這在機制上擋掉大部分幻覺，比事後人工抽查可靠。

權利也要一起設計：只存**短引文＋定位＋hash**，不複製整段；`rights` 分 `pd`／`licensed`／`excerpt`。
公開站只顯示可引用的引文，其餘顯示頁碼與摘要。

### 1.4 AI 工作流：檔案袋 → 草稿 → 驗證 → 審核 → 發布

```
dossier（該概念的所有原文段落＋既有 claim＋相鄰條目＋風格/讀者設定）
   │  AI 讀 dossier，只能引用 dossier 裡的 evidence id
   ▼
draft（散文 ＋ claim 表，一次產出；沒有 evidence 的句子不得標為事實）
   │  機械驗證：quote 命中、id 存在、長度、斷鏈、重複、日期/數字是否有證據
   ▼
review（人類看「句子 ↔ 引文」並排；高風險先審：年份、數字、人名、引文、爭議）
   │  接受／改寫／退回；記錄 reviewer 與時間
   ▼
publish（編譯成 TSV／HTML；寫入 provenance）
```

三個不可省的閘門：

* **無引用不得成為事實句**（可以寫成「一般理解」或刪掉）。
* **引文必須逐字命中**（不是「意思差不多」）。
* **高風險 claim 必須人工通過**（模型不能自我核准）。

### 1.5 不確定性、多來源、多版本是一等公民

紙書的事實經常是「這本書這樣說」，不是「舉世公認」。格式要能表達：

| 狀態 | 意義 | 顯示 |
|---|---|---|
| `draft` | AI 草稿，未審 | 編輯模式才看得到 |
| `verified` | 人工對過原文 | 正常，附來源 |
| `disputed` | 來源之間衝突 | 「多說並存」，列出各來源 |
| `superseded` | 被新版本取代 | 保留歷史，不刪 |

另外兩個欄位：

* `edition`：版本／印次。頁碼必須綁版本，否則「頁 123」沒有意義。
* `stance`：區分「來源說 P」與「我們斷定 P」。前者是引用，後者是編輯判斷；兩者的證據門檻不同。

### 1.6 格式策略：ledger 為真相，TSV 為編譯視圖（最小可行版）

不要一次改成 RDF／知識圖譜。最小可行的加法：

```
data/<id>.tsv            既有條目（閱讀視圖，不動）
data/<id>.sources.jsonl  來源與引文（L0 的投影）
data/<id>.claims.jsonl   主張與證據（L1）
data/<id>.ids.tsv        key → 穩定 id（改名／截斷用）
```

建置時：

1. 驗證所有 claim 的 evidence 可解析、quote 命中；
2. 驗證條目引用的 key 都存在、DAG 無環（既有規則）；
3. 編譯出 app 用的條目與「來源」區塊（或 `^src` 零寬標記）；
4. 產生 `index.bin`（給閱讀器與 AI 檢索用）。

這樣既有 16 科、1,831 條完全不動；新能力是**加法**。等到 claims 真的成為主要編輯對象，再把 TSV 改成
「從 claims 生成」——那時才有資格談 graph 為真相。

### 1.7 量測「事實品質」，不是只量格式

格式的黃金測試是「13j 逐位元組相同」；事實層的黃金測試是**引用與主張的回歸集**：

| 指標 | 定義 | 門檻（建議） |
|---|---|---|
| citation coverage | 有可解析 evidence 的 claim／全部 claim | ≥ 95% |
| quote match | 引文逐字命中／全部引文 | **100%（硬閘門）** |
| unsupported factual sentences | 含年份／數字／人名但無 evidence 的句子比例 | < 2% |
| review time | 每條 claim 的人工審核時間 | < 90 秒 |
| gold-set precision | 200 條人工核對的主張，AI 草稿的正確率 | ≥ 95% |
| dispute rate | 標成 `disputed` 的比例 | 追蹤，不設上限 |

gold set 要冷凍、版本化；每次換模型、改 prompt、改 schema 都跑一次。這是把「AI 編輯」從手工藝
變成工程的關鍵。

---

## 2. 最小 schema（可直接放進 repo）

```jsonc
// sources.jsonl
{"id":"s:<db>:<doc>:<vaStart>", "db":"…", "doc":"…", "edition":"…", "page":"…",
 "va":[123,145], "quote":"…", "hash":"sha256:…", "rights":"pd|licensed|excerpt"}

// claims.jsonl
{"id":"c:<domain>:<key>:<nn>", "subject":"…", "predicate":"…", "object":"…",
 "qualifiers":{"time":"…","place":"…","scope":"…"},
 "type":"lexical|textual|historical|quantitative|attribution|interpretation|synthesis",
 "evidence":["s:…"], "status":"draft|verified|disputed|superseded",
 "stance":"source|editor",
 "author":"ai:<model>@<date>", "reviewer":"human:<id>", "date":"YYYY-MM-DD"}

// ids.tsv：條目 key → 穩定條目 id（e:…）；claim 另用 c:…
佛	e-fgdict-fo
```

編譯後的閱讀層格式不變（仍是 `key<TAB>value`）：

```
佛	佛教的最高覺悟者，梵語 buddha 的音譯。……
```

閱讀器在條目下方顯示「來源」chips：佛光大辭典（1988）頁 123 ／ 某書卷 3；點擊看引文與原文位置。

驗證規則（建置時強制）：

1. `evidence` 非空；每個 id 存在且 quote 命中。
2. `type` 是 `historical|quantitative` 時，至少要有一條 evidence 帶非空 `quote`（原文引文），
   不能只有頁碼或轉述。
3. `subject` 必須是存在的條目 key 或 `ids.tsv` 的 id。
4. 同一 `id` 不得重複；同一 `(subject,predicate,object)` 重複要合併或標 `disputed`。
5. 條目散文若含年份／數字／人名，必須有對應 claim（用簡單的 regex＋人工抽查）。

---

## 3. 與 adb 的接口（四個呼叫）

| 呼叫 | 用途 | 實作 |
|---|---|---|
| `resolve(db, doc, vaStart, vaEnd)` | 取引文與頁碼 | 行表＋`vapa`；不用 VA 走訪 |
| `search(query, k)` | 取段落（dossier 的原料） | `tokens` postings＋行表；回傳 span |
| `page(db, doc, pageNo)` | 頁文字／頁圖像 | `頁` 標籤＋`頁.n`；有掃描就接 IIIF |
| `dossier(concept)` | 打包給 AI 的上下文 | 上述三者＋既有 claim／條目 |

這四個呼叫是 **adb** 對 AI 的全部價值。但紙書的事實往往不在 adb 裡：fgdict 的定義大量引用大正藏，
而大正藏與高麗藏是另外兩個 SQLite（`T.db`／`K.db`）。所以完整的證據介面還要加上 canon 的
`taisho(vol,page,col)` 與 `k_pcl(vol,pcl)` 解析，見 §8。**不要**把整本書丟進 prompt；不要讓模型自己回憶原文。

---

## 4. 12 週試點（修正上一份的順序）

| 週 | 工作 | 驗收 |
|---|---|---|
| 1–2 | citation parser（中文數字、`大X‧Y上/中/下`）＋resolver（fgdict → T.db pcl）；取 50 個詞建 evidence | 50 條可解析；quote 命中率 ≥50%；0 條假 pcl |
| 3–4 | 檢索服務（`search`／`dossier`）＋claim schema＋驗證器；K 平行比對（posmap） | dossier < 2 秒；驗證器抓假引用；20 條異文 |
| 5–6 | AI 草稿（散文＋claim 表，citation id 只能取自 dossier） | 50 條草稿：citation coverage ≥ 95%、無假 id |
| 7–8 | 審核介面（句子↔引文並排、風險排序）＋provenance | 每條審核 < 90 秒；可 revert |
| 9–10 | 200 條 gold set；量 precision；修 prompt／schema | gold precision ≥ 95% |
| 11–12 | 推到一本書（13j 或 fgdict 全庫）；讀者端來源 chips | 讀者可從條目跳到原文；無未標記的 AI 草稿 |

> 這份順序和上一份的差異：**先做「引用與驗證」，不是先做「全庫投影」或「索引」**。
> 沒有驗證層，投影得再多也只是不能被信任的文字。

---

## 5. 對上一份文件的三處修正

1. **方向三**（轉 offtext）：從「文字轉換」改成「錨點映射＋主張抽取」。P0 的產物不是 `offtags.tsv`，
   而是 `sources.jsonl`（可引用的 span）。
2. **方向二**（索引）：角色從「搜尋加速」變成「**檢索服務**」——AI 的 dossier 與讀者的搜尋共用同一份索引，
   但 AI 需要的是「段落＋錨點」，不是命中數。
3. **方向一**（容器）：從「閱讀容器」變成「**證據包**」——文字＋頁圖像＋hash＋版本，供長期引用；
   同樣是唯讀、不可變，但 manifest 的重點是 provenance，不是壓縮率。

優先序因此變成：**引用與驗證 > 檢索索引 > 證據容器**。

---

## 6. 不要做

| 不要 | 理由 |
|---|---|
| 讓模型自由產生 citation id | 幻覺無法機械阻擋；id 必須由工具發 |
| 只用頁碼當錨點 | 版本／印次不同，頁碼不穩定；要加引文與 hash |
| 把「來源說 P」和「P 為真」寫成同一句 | 人文來源經常互相矛盾；要保留立場 |
| 一開始就建完整本體／RDF／nanopublication | 100 條 claim 跑通之前，都是過度工程 |
| 讓 AI 直接改既有條目、不留 diff | 無法審核、無法回滾、無法歸因 |
| 把 AI 草稿與人工內容混在一起發布 | 讀者無法判斷可信度；要標記 |
| 用簡體轉換當 canonical | 異體字、避諱、版本差異會消失；轉換只能當顯示層 |
| 把 4.7 G 字全部變成條目 | 編輯與審核成本不可承受；先做有價值的書 |

---

## 7. 為什麼是現在

* adb 已經有**位址**（頁、行、VA），這是多數 OCR 專案沒有的；引用解析的成本比想像低。
* offtext 已經有**穩定的條目與引用網路**（1,831 條、2,322 個引用），可以直接掛證據，不用重寫。
* AI 已經能穩定產出結構化 JSON；缺的不是能力，是**約束**與**驗收**。
* 紙書的事實一旦有了引用，就可以被審核、被更新、被多版本並存——這是「數位原生」真正的意思：
  不是把紙書掃進電腦，而是讓知識**可驗證地生長**。

---

## 8. fgdict 的證據鏈：辭典 → 大正藏 → 高麗藏

> 2026-10-21 實測。這一節把前面的抽象建議落到 fgdict 的具體材料上。

### 8.1 三個資料庫

| 層 | 檔案 | 內容 | 規模 |
|---|---|---|---|
| 辭典（二次文獻） | `fgdict.adb` | 22,648 詞，1988 年佛光大辭典 | 19 MB |
| 大正藏（校勘本） | `T.db` | 6,901,609 行、11,995 卷 | 808 MB |
| 高麗藏（底本） | `K.db` | 3,446,825 行、6,594 卷 | 391 MB |
| 位置對照 | `posmap.db` | 6,357 組 T↔K 卷對照 | 20 MB |

T.db／K.db 都是 SQLite，`lines(vol, pcl, seq, page, col, line, text)`；`pcl` = 4 位頁號 + 欄 a–g +
2 位行號，和 adb 的「頁／行」模型同構。`juan` 表把 `(sutra, juan)` 對到起止 pcl，另有
`preface_lines`／`appendix_lines` 可排除序跋。`posmap.db` 的 `align` 表存 T 卷↔K 卷的起點與相似度，
另有對齊 blob。

### 8.2 fgdict 的三種引用

實測 22,648 條：

| 型態 | 數量 | 例 |
|---|---:|---|
| 大正藏頁欄引用 `(大<vol>‧<page><上/中/下>)` | **4,625** | `大日經卷一（大一八‧八下）：「一切智慧者…」` |
| 書名＋卷 | **約 19,411 次** | `大智度論卷四十三`、`摩訶僧祇律卷三十三` |
| 辭典自身頁碼 `<_頁 n="…"/>` | **6,955** | `<_頁 n="2277"/>` |

第一種可直接解析到 T.db：`大18‧8下` = vol 18、page 8、col c；查 `T18 p8c09` 得到
「一切智慧者　出現於世間」，與引文逐字相符（去掉標點與校勘符號後）。第二種需要「書名權威表」
才能對到經號（`大品般若經` → T0223、`大般若經` → T0220、`大智度論` → T1509）。第三種是辭典
1988 年版的印刷頁，用來標示「這段話在辭典的哪一頁」。

### 8.3 關係：辭典是索引，不是事實來源

```
K.db（高麗藏，底本） → T.db（大正藏，校勘本） → fgdict（1988 辭典，二次整理） → offtext（AI 編輯）
```

* **T 是學界引用的標準位址**（册／頁／欄／行），所以 claim 的主錨點應該是 **T pcl**。
* **K 是 T 的底本**；同一個 T 位址可用 `posmap.db` 對到 K 的卷與起點。兩邊文字不同時要記
  `variant`（韓國漢字／日本漢字、異體字、避諱），不能默默取一邊。
* **fgdict 的頁碼只證明「辭典這樣寫」**，不證明「事實如此」。它的價值是選題與整理，是 finding aid。
* 越過 K 的抄寫本／文物超出 scope；schema 不支援「witness 深度 > K」的 claim，避免假裝有證據。

例：`T0848` 卷一（T18, `0001a01`）↔ `K0427` 卷一（K13, `0863b01`），相似度 0.999。所以
`大日經卷一（大一八‧八下）` 這條 claim 可以同時給出 T18 p8c 的引文與 K13 的對應段落；兩邊用字
不同時記 `variant`，而不是選一邊。

T 的 11,995 卷中只有 **6,357 卷有 K 對照（53%）**；其餘沒有 K witness，`k_parallel` 必須允許
`null`，不可硬湊。

### 8.4 引用型別（union）

```jsonc
{"kind":"taisho", "vol":18, "page":8, "col":"c", "line":9, "quote":"一切智慧者，出現於世間…"}
{"kind":"work", "title":"大智度論", "juan":43, "quote":"…"}
{"kind":"fgdict_page", "page":2277}
{"kind":"k_pcl", "vol":11, "pcl":"0543a01"}
```

解析順序：中文數字 → 去 CBETA／SAT 標記 → 書名權威 → T pcl →（可選）K pcl → 引文比對。
`evidence_mode` 三種：`quote`（逐字，硬閘門）／`paraphrase`（轉述，需人審或語意比對）／
`reference`（只到卷，粗粒度）。

### 8.5 實測：引文不是每條都能逐字命中

以簡單規則（中文數字解析、去 `^…`／`【】`／`〔〕`／`｜`、去標點）測 4,625 條大正藏式引用：

| 結果 | 數量 | 說明 |
|---|---:|---|
| 逐字命中 | **1,349** | 下限；引文緊接引用之後的簡單規則 |
| 頁碼不存在 | 7 | T.db 沒有該頁 |
| 引用後沒有引文 | 143 | 純參考，走 `reference` 模式 |
| 有引文但未逐字命中 | 3,126 | 轉述、異體字、跨頁，或引文屬於下一條引用 |

兩個結論：**（a）引文原則是對的，但不能假設「有引用」等於「逐字」；（b）fgdict 大量條目是轉述，
AI 若把它當 quote 會錯。** 所以 schema 要分 `quote` / `paraphrase`，不能只有一個 `evidence` 欄。

### 8.6 對 AI 編輯的含義

* fgdict 條目的 dossier 應包含：辭典原文（含 `<_頁>`）＋它引用的 T 段落（pcl）＋K 對應段落＋
  異文＋相鄰條目。
* AI 寫 claim 時，主證據指向 **T pcl**；fgdict 頁碼放 `secondary`／`provenance`。
* 長條目（因明 13,769 字、中文大藏經 13,260 字、石窟 10,739、塔 10,310）不是 offtext 的「一條」，
  要切成節／claim，每個 claim 各自帶引用。**200 字上限的真正解法不是塞長文，而是切成可驗證的主張。**
* 版權：T／K 是公有領域；fgdict 1988 仍有版權。轉寫時盡量引 T 原文，fgdict 只作 finding aid。

### 8.7 兩週試點

| 工作 | 驗收 |
|---|---|
| 解析 4,625 條大正藏式引用 → `citations.jsonl` | 解析率 >95%；vol/page/col 100% 有值 |
| 建 Top-100 書名權威表（T.db `juan.name` ＋別名） | 抽 100 條 title+juan，80% 對到經號 |
| 抽 100 條 claim 解析到 T pcl；50 條比對 K | quote 命中 ≥50%；K 對應 ≥40 條；產出異文清單 |
| 人工核 20 條 | 0 條假 pcl；錯誤分類表 |

---

## 附錄：與現有標準的對應

| 需求 | 標準／先例 | 用多少 |
|---|---|---|
| 文字 span 引用 | W3C Web Annotation（TextQuote／TextPosition） | 直接用概念，不必上 RDF |
| 頁圖像 | IIIF Image API | 有掃描時用；沒有就只存頁碼 |
| 主張＋出處＋版本 | Nanopublication（assertion／provenance／publication info） | 借結構，不借 RDF 重量 |
| 事實查核 | Schema.org `ClaimReview` | 只在對外發布爭議事實時參考 |
| 版本控制 | git＋內容 hash | 直接用 |
