# ADB 共用 know-how（改個別 adb 前先看這一頁）

> 2026-11-01。目的：adb 是一個一個改的，但**容器、座標、缺字、字型、詞彙、`j`、
> 驗證**都是共用的。這一頁只抽「可重用的部分」；個別庫的來源、步驟與數字留在
> 該庫自己的文件（見 §10）。
>
> 原則：**共用規則改一處，所有庫都要跟著重跑／重驗**；不要只改閱讀器或只改
> 某一個產生器。

---

## 1. 先分三層

| 層 | 例子 | 會不會常改 | 文件 |
|---|---|---|---|
| **底座 adb** | `taisho`、`wxzj` | 只在 CBETA 換版時（一年 2–3 次） | `stable-adb.md`、`taisho-steps.md`、`wxzj-steps.md` |
| **標注／功能 adb** | `ys`、`tx`、`lc`、`yulinpo`、`fuyan`、`swjzz` | 可以常改，版本與底座脫鉤 | 各庫 steps／about |
| **工具／實驗** | `jingqun`、`taisho-study`、`goryeo_taisho` | 隨時 | 各自文件 |

底座只放經文；`<聯>`、`<嵌>`、`<术>`、`glossary`、`xrev` 等功能資料放功能 adb，
不要讓使用者為了小改動重下 300 MB。

---

## 2. 容器（幾乎每個庫都一樣）

建置一律走 `ts/src/adbauthor.ts`（`authorAdb()`），**不要手寫容器**。

| 容器 | 內容 | 誰產生 |
|---|---|---|
| `source` | 內文（一行一個 adb 行，bzip2 分塊） | `authorAdb` |
| `tokens` | 全文索引（`fullTextIndex:false` 時**不建**） | `authorAdb` |
| `tags` | 每個標籤的 VA 清單 | `authorAdb` |
| `tables` | `lines.physical`、`lines.virtual`、`blocks.virtual`、`tags.virtual`、`doclengths` | `authorAdb` |
| `attributes` / `attributes.sorted` | 標籤屬性（`頁.id`、`書.id`…） | `authorAdb`（由文字重算） |
| `caches` | 目錄要用的節點名（`t=`／`s=` 宣告） | `authorAdb` |
| `resources` | logo、圖檔（`<圖 n="312.svg"/>`） | `pack` 傳入 |
| `glossary`（選配） | 詞彙表（JSON Lines，未壓縮） | `terms.ts` 或各庫 `glossary.ts` |
| `xrev`（選配） | 反鏈快查（反引用的頁／書） | `ys` 的 `xrev.ts` 類工具 |
| `study`（選配） | 研究讀本的索引 block | `taisho-study` 專用 |
| `align`（選配） | 高麗藏⇄大正藏對照 | `goryeo_taisho` 專用 |

- 容器佈局與 Delphi accelon3 indexer 相同；`abx inspect` 可以看每個容器的
  blocks／bytes／names。
- `attributes`、`tables` 一律**從新文字重算**，不要照抄舊檔，否則 VA 對不上。
- 標籤要進目錄／快取，靠文字裡的 `t=`、`s=`、`l=` 宣告，不是另外寫設定檔。
- **純容器模式（2026-11-02）**：`authorAdb({ fullTextIndex: false })`（`tei-pack` 加
  `--no-index`）仍照 tokenizer 的 token 數推進 VA，所以 `tags`／`lines`／`blocks` 的
  VA 與有索引版本完全相同；差別是**不建 `tokens` 容器**（沒有 token 清單與 postings），
  搜尋 0 筆。適合還沒有 tokenizer 的語種，或「只要閱讀、不要全文檢索」的庫；
  正文、目錄、頁碼都不受影響。
- 「建置多花幾秒、檔案多幾 MB」可以接受；**不要把重算留給使用者每次開檔**。

---

## 3. 文字與 VA（所有座標的基礎）

| 規則 | 內容 |
|---|---|
| 一行 | 一個 `<lb>`／一個 adb 行；`MAXLINELEN` = 4,000 字（8,192 bytes），超過要在 pack 前切開（不切進標籤、不切開代理對） |
| 頁 | `<頁 id="NpMc"/>`（例 `51p185b`）；頁 id 是跨庫連結的錨，**不要改格式** |
| VA 單位 | 一個字元＝1；`&…;` strong pair＝1；IDS `⿰…`＝1；標籤＝4（skip 標籤 0） |
| 代理對 | **一個 supplementary 字元＝1 個 VA**（2026-11-01）；不要在 tokenizer 把它拆成兩半 |
| 漢字判定 | `\p{Script=Han}`（一定要 `u` flag），一次只測一個 code point |
| 位置 | `j`／`off`／`hanline` 是**漢字序號**（0 起）；換成 DOM `Range` 的 offset 才是 UTF-16 code unit |

**詞組搜尋與折行**（2026-11-05）：硬換行本身不佔 VA，所以被折行切開的詞仍搜得到；但標籤開、閉
**各佔 4 VA**——**連續行文**（前後還是同一句話）的折行處不要留下任何標籤邊界：`</粗>`＋換行＋
`<粗>`、`</引>`＋換行＋`<引>`，以及 `<术>`、`<聯>` 等成對標籤都一樣；否則該處多 8 個 VA，詞組就在
那裡斷掉、搜不到。只有前後**不是**連續行文（換段、標題→正文、獨立條目／表格／科判）才可以
各自開閉。docx 轉檔的完整規範見 `D:\2026\agent-norms\docx-accelon-pitfalls.md` §3.1。

三種「位置」不要混：

| 名稱 | 起點 | 單位 | 用在哪 |
|---|---|---|---|
| `j="a-b"` | 目標頁第一個可見漢字 | 漢字（end 不含） | `<聯 i="db?頁" q j>` 的目標反鏈 |
| `off` | 該頁第一個漢字 | 漢字 | `glossary` 每列（頁內位置） |
| `hanline` | 該行第一個漢字 | 漢字 | `glossary` 每列（行內位置，優先使用） |

共同實作：`ts/src/accelon26/han.ts`（`isHan`／`hanChars`／`hanCount`／`cpToUnit`）。
細節與遷移：`han-position.md`。

---

## 4. 缺字與字型（CBETA 系庫共用）

| 碼 | 處理 | 成品 |
|---|---|---|
| `<g ref="#CB…">` | 內文真字 → charDecl `unicode`／`normal_unicode` → 只有 PUA 就用 PUA | 真 Unicode 或 `&CB…;` |
| `<g ref="#SD-XXXX">`（4 hex） | `U+FA000 + XXXX` | 第 16 平面 PUA |
| `<g ref="#RJ-XXXX">`（4 hex） | `U+100000 + XXXX` | 第 16 平面 PUA |
| `<g ref="#SDxxxxx">`（5 hex，SAT） | charDecl 的 Unicode 序列（2–7 字） | 顯示時換成序列 |

- 缺字清單與規則：`missing-char.md`（**重要文件**）。
- 字型（全部內嵌，不假設使用者安裝）：
  - `accelon-siddham-unicode.woff2` 48.7 KiB（Noto Sans Siddham，OFL）
  - `accelon-siddham-extra.woff2` 12.1 KiB（81 個 Noto 排不出的字，從 CBETA 抽出）
  - `accelon-ranjana.woff2` 18.4 KiB（CBETA Ranjana）
- PUA → 序列對照：`pua-seq.tsv`（1,993 個）、`siddham-seq.ts`（SAT 3,673 個）。
- 顯示只在 renderer 換字，**adb 文字與 VA 不動**。

新庫若含梵字，先問三件事：SD 是 4 hex 還是 5 hex？CB 缺字有沒有 charDecl？
字型要覆蓋到哪些碼？（見 `siddham-ranjana.md`）

---

## 5. 詞彙（`glossary`）與術語（`<术>`）

- 文字用 `<术 sk|pi|tb="外語">漢詞</术>`；容器格式見 `glossary.md`。
- 產生器：`ts/src/terms/terms.ts` 的 `buildGlossaryRows()`／`glossaryLines()`
  （fuyan、ys 共用；詞表 `data/terms.tsv`，fuyan 是 canonical、ys 是 vendored copy）。
- `off`／`hanline` **一定要用 §3 的漢字規則**；否則點「恭御陀」會塗到「烏」
  （2026-11-01 實例）。
- 顯示：左欄「詞彙」分頁只在有 `glossary` 容器時出現；點整列跳第一次出現
  （`hanline` 優先），列尾 🔍 走全文檢索。

指令：

```powershell
bun run ts/tools/terms.ts apply      # 新文字：自動標 <术>
bun run ts/tools/terms.ts fix        # 既有標記：修斷詞
bun run ts/tools/terms.ts glossary   # 產生 glossary 容器內容
```

---

## 6. 連結與反鏈（`<聯>`／`j`／`xrev`）

```xml
<聯 i="taisho?8p848c" q="色即是空，空即是色；" j="52-60">色即是空，空即是色</聯>
```

| 欄位 | 意義 |
|---|---|
| `i` | `目標dbname?頁id`（accelon3 標準） |
| `q` | 目標頁原文（純漢字），沒有 `j` 時做文字比對 |
| `j` | 目標頁漢字索引 `起-訖`（0 起、end 不含） |

- 產生端與消費端**必須同一套漢字規則**（§3）；只改一邊會讓偏移換方向。
- 實戰坑與修復順序：`xref-j-lessons.md`；反鏈流程：`backlink-skill.md`。
- 驗證：`tools/xref-chip-test.ts`、`tools/page-mark-test.ts`、`tools/quote-test.ts`、
  `tools/note-xref-test.ts`，再加實機點晶片看色帶。

---

## 7. 建置流程（六步，所有庫通用）

```text
① 取源（CBETA XML／SAT／docx／舊 adb）
② 轉文字（一行一個 lb；tei2adb、y2adb、docx2accelon…）
③ 補資料（缺字、術語、頁碼、圖片 → 外部檔，不改 XML）
④ 連結（<聯>、<嵌>、j；最後才 patch，重跑轉換器後要再 patch）
⑤ 打包（tei-pack／pack.ts → authorAdb）
⑥ 驗證＋記帳＋發布
```

| 動作 | 工具 |
|---|---|
| TEI → 文字 | `go run ./cmd/tei2adb` |
| 文字 → adb | `bun run ts/tools/tei-pack.ts`（CBETA）／各庫 `pack.ts` |
| 檢查容器 | `go run ./cmd/abx inspect` |
| 版本清單 | `bun run ts/tools/make-adb-manifest.ts` |
| 上傳 adb | `bun run ts/tools/publish-adb.ts [--allow-large]` |
| 底座記帳 | `bun run ts/tools/cbeta-base.ts --check` |

每次換版**必做**：`deploy/adb-notes.json` 寫新 sha 的說明 → 在
[adb-version-log.md](./adb-version-log.md) 加一列 → `make-adb-manifest`
→ `publish-adb` → 官網 manifest 與兩站檔案 sha 對一次。

---

## 8. 改一個 adb 的檢查表

**新增**
- [ ] 決定放哪一層（底座／功能／工具），檔名＝`dbname.adb`
- [ ] 頁 id 格式（`NpMc` 或該庫既有格式）先定好，之後不要改
- [ ] 文字一行一個 lb；超過 4,000 字先切
- [ ] 缺字／梵字／術語／圖片的處理方式（§4–§6）
- [ ] `caches` 的 `t=`／`s=` 宣告；目錄樹要幾棵
- [ ] logo 命名 `<dbname>_logo.png`
- [ ] `adb-notes.json` 加說明；`index.txt`／manifest

**修改**
- [ ] 先確認「這次改的是共用規則還是這一庫的資料」
- [ ] 共用規則（漢字、VA、缺字、j）改完，**所有受影響的庫都要重跑**
- [ ] 頁 id 不變；VA 若變，記錄差異（哪一頁之後、幾個）
- [ ] 重跑對應的驗證（§6、§9）

**發布**
- [ ] `versions.json`／exe sha 兩站一致
- [ ] manifest 的 sha／size 與線上檔案一致
- [ ] `adb-version-log.md` 已加一列（日期／sha／大小／buildTime／工作區／說明）
- [ ] 大檔（>30 MB）只在換版時上傳，且 `--allow-large`

---

## 9. 已知問題與處理狀態（2026-11-01）

1. ✅ **漢字規則已集中**：閱讀器 `ts/src/accelon26/han.ts`（`\p{Script=Han}/u`）；
   Python 端 `ts/tools/han.py`（同樣範圍）。已改用它：
   - 本區 `ts/src/terms/terms.ts`
   - `D:\2026\fuyan`：`patch_xref_j.py`、`transclude05b.py`、`transclude_taisho.py`、
     `transclude_yinshun.py`、`expand_rong.py`、`taisho-pages.ts`、`ys-pages*.ts`
   - `D:\2026\ys`：`addj.ts`、`calibrate.ts`
   **規則**：新產生器不得再自己寫一份漢字範圍；Python 用
   `sys.path.insert(0, r'D:\2026\adb-converter\ts\tools'); from han import HAN`。
2. 🟡 **`j` 產生器**：頁座標的共用層已抽到 `ts/src/accelon26/page-text.ts`
   （`anchorIndex`／`anchorVa`／`blockOf`／`pageHanTextOf`，不碰 DOM，產生器可
   import）；但「引文比對」邏輯仍各庫一份（`patch_xref_j.py`、`addj.ts`、
   `calibrate.ts`）。下一步是把比對也抽成共用模組，見 §10 待辦。
3. ✅ **文件漂移**：`xref-j-lessons.md` §1、`glossary.md`、`terms.md`、
   `stable-adb.md`、`taisho-steps.md`、`wxzj-steps.md`、`missing-char.md` 已更新到
   2026-11-01。之後數字以 `abx inspect` 為準。
4. ⏳ **底座帳本過期**：`deploy/cbeta-base.json` 的 taisho／wxzj 還是舊 sha
   （現為 `13f78…`／`eb737…`），`cbeta-base --check` 會紅。內容沒變、只是
   tokenizer 修正；作者說可以慢點處理。
5. ✅ **工作區分工**：各 adb 工作區負責重建與發布；**但建置後要在
   [adb-version-log.md](./adb-version-log.md) 加一列**（日期／sha／大小／
   buildTime／工作區／說明），因為工作區日後可能停用，這一頁是維護依據。
   同一個 adb 同一時間只由一個工作區重建。
6. ✅ **`ys.adb` 的發布權**：由 `D:\2026\ys` 工作區負責；本區只讀、不發布。
7. ✅ **文件索引**：`docs/README.md` 已重寫，補上 knowhow、版本紀錄、terms、
   han-position、xref-j-lessons 等。

### 待辦

- [ ] 把「引文 → 頁內範圍」的比對抽成共用模組（Python／TS 各一份薄殼），
      讓 `patch_xref_j.py`／`addj.ts`／`calibrate.ts` 只處理來源格式。
- [ ] `cbeta-base.json` 記 taisho／wxzj 的新 sha（等作者決定）。
- [ ] 新 adb 工作區開工時，先把 `han.py`／`page-text.ts` 的路徑寫進它的
      `AGENTS.md` 或 README。

---

## 10. 相關文件

| 主題 | 文件 |
|---|---|
| 容器格式（二進位） | `FORMAT.md`、`SPEC.md` |
| 底座／功能分層、換版 | `stable-adb.md` |
| CBETA TEI → adb 六步 | `cbeta-adb-skill.md` |
| 大正藏建置 | `taisho-steps.md`、`taisho-about.md` |
| 卍續藏建置 | `wxzj-steps.md`、`wxzj-about.md` |
| 缺字／梵字／字型 | `missing-char.md`、`siddham-ranjana.md`、`pua.md` |
| 漢字位置（code point） | `han-position.md` |
| `<聯 j>` 實戰 | `xref-j-lessons.md` |
| 術語 `<术>` 共用機制 | `terms.md` |
| `glossary` 容器 | `../glossary.md` |
| 反鏈 | `backlink-skill.md` |
| 舊庫升級 | `old-adb-upgrade-skill.md` |
| 印順 `ys` | `ys.md`、`ys-steps.md`（`D:\2026\ys` 為準） |
| 福嚴 `fuyan` | `D:\2026\fuyan\README.md`、`REPORT-05B.md` |
| 開新 adb 工作區 | **`D:\2026\agent-norms\new-adb-workspace.md`**（canonical，2026-11-04 移出）；本區 `new-adb-workspace.md` 只有指標 |
