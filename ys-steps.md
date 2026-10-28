# ys.adb 製作步驟（CBETA Y → Accelon3）

`ys.adb` 是「印順法師佛學著作集」的另一個建置，來源是 **CBETA 官方 Y 部 XML**
（`cbeta-org/xml-p5`），不是舊的 `yinshun.adb`。

兩者定位：

| | `yinshun.adb` | `ys.adb` |
|---|---|---|
| 來源 | 舊的 accelon 版 corpus（`D:\2023\yinshun-corpus`） | CBETA Y 部 TEI P5 |
| 流通 | 很廣，**保持原樣** | 新能力都在這裡 |
| 內容 | 44 冊＋卷首附錄 | 44 冊（CBETA）＋附錄（舊版卷首）＋後記 |
| 大正鏈結 | 13,920 個（頁欄級為主） | 25,920 個（字元級，含 `q` 引文） |

`ys.adb` 的檔頭（`<集>`、`<隱>`、`<樹>`、`<引>`、`<摘要頭>`、`<參考資料>`、
`<英文名>`）與 `yinshun.adb` 相同，其他標記不強求一致。

---

## 0. 前置需求

- Go（`go run`）、Bun、PowerShell
- 網路（第一次抓 CBETA Y）
- 舊版 `D:\accelon3\yinshun.adb`（附錄來源，見 §4）
- 對照表 `D:\2026\offtext\alignments\yinshun-taisho.tsv`
- 語料 `D:\2023\yinshun-corpus\xml\y*.xml`（頁元與引文定位用）

工作目錄一律是 `D:\2026\adb-converter`。

---

## 1. 取得 CBETA Y

只需要 `Y/` 一個目錄，用 sparse clone（整庫 1.4 GB，Y 只有 49 MB）：

```powershell
cd D:\2026
git clone --filter=blob:none --sparse --depth 1 https://github.com/cbeta-org/xml-p5.git xml-p5
cd xml-p5
git sparse-checkout set Y
```

結果：`D:\2026\xml-p5\Y\Y01\Y01n0001.xml` … `Y44\…`（44 檔）。

CBETA 更新後，只要在同一個 clone 裡 `git pull`，再跑 §7 即可。

---

## 2. 轉換：`cmd/y2adb`

```powershell
go run ./cmd/y2adb -src 'D:\2026\xml-p5\Y' `
  -out 'build\ys-text.txt' `
  -lbs 'build\ys.lbs.tsv'
```

輸出：

- `build/ys-text.txt`：Accelon3 文字（一行一個 `<lb>` 行）
- `build/ys.lbs.tsv`：`冊<TAB>行號<TAB>lb`（除錯與人工核對用）

### 2.1 標記對照

| TEI | ys 文字 |
|---|---|
| `<body>` 開始 | `<檔 n="Y01n0001.xml">` |
| 冊標題（`title level="m"`） | `<書 l="目次" t="記" id="1">般若經講記</書>` |
| `<milestone unit="juan">` | `<卷 n="N">N</卷>` |
| `pb` 前綴類別改變 | `<頁元 n="書名" t="頁.">正文／附錄／後記</頁元>` |
| `<pb n="0065a"/>`（非 `type="old"`） | `<頁 id="22p0065a"/>`（`冊號`＋`p`＋`pb`） |
| `<lb/>`（非 `type="old"`） | 換行 |
| `<p>` | `<段/>` |
| `<head>`、`<jhead>` | `<章 u="文">…</章>` |
| `<note>` | 獨立一行 `〔註n〕` ＋內容（n 空時用序號） |
| `<app>` | 只留 `<lem>` 底本文字，`<rdg>` 略過 |
| `<note>`／`<app>` 以外的元素 | 只取文字，標籤丟棄 |

`<anchor>`、`<g>`、`<cb:mulu>`、`<back>` 一律跳過。

### 2.2 檔頭

`header` 常數直接沿用 `yinshun.adb` 的第一個 `<檔>`：

```text
<檔 n="ys.xml"><集 l="圖集,註釋群,編目資訊">印順法師佛學著作集</集>
<隱><樹 s="*" t="書" pf1="$書.id;.">目錄</樹>
<樹 s="*u=文" pf="$頁.id;)">頻次</樹><樹 s="~00602000">西文</樹></隱>
<隱><引>《$書;》：「$_;」( Y $*頁; )</引><摘要頭>$書;($頁;)</摘要頭>
<參考資料 n="taisho,wxzj"/></隱>
<英文名>Master Yinshun Corpus of Buddhist Studies</英文名></檔>
```

### 2.3 預期數字（2026-10 版）

```text
lines=305522 卷=460 書=44 段=31882 註=5230 頁=17510 頁元=73
```

頁元 **73**（CBETA 的 `pb` 前綴有 a、b、y、z），比語料／對照表的 **70** 多 3 個；
這是正常的，見 §5.1。

---

## 3. 附錄與後記：`ys/prep.ts`

```powershell
bun run ys/prep.ts
```

輸入 `build/ys-text.txt`，輸出 `build/ys-text-full.txt`：

```text
檔頭
  ＋ 44 冊（上一步的產物）
  ＋ 附錄（書 id 99，5 頁，ys/appendix.txt）
  ＋ 後記（書 id 100，頁 0p1，ys/ys-epilog26.txt）
```

### 3.1 後記

「2026年AI版後記」，約 1,500 字，獨立成書、放在**全書最後**、**沒有大正鏈結**。
書名與章名不重複：書名「2026年AI版後記」，章名「後記」。
內容六節：

1. 保存歷史文獻原貌（時代背景、不作刪改、與中華書局 2009 簡體版不同、
   僅供學術研究、遵守當地法規）
2. CBETA 刪除舊版內容（五篇卷首資料、「參與人員名單」、不尊重歷史、
   本版自動補回）
3. 授權與致謝（開發者葉健欣、基金會授權、2026 年 AI 版主要測試者陳裕文、
   增值部分 CC BY）
4. 無名者的光（常明法師逐字錄入七百萬字、德志法師組織第一版光碟與招募開發者、
   厚觀法師——印順導師關門弟子，二十多年維護系統、以學術學養逐字校勘；
   2017 年他號召三十幾位福嚴佛學院師生與推廣班學員查找引文在大正藏的精確位置——名字已不可考）
5. 感謝這個時代（DeepSeek、祖國的數字基建與生活環境、文化自信）
6. 回連結是怎麼做到的（給一般讀者的白話說明：每個字編門牌號碼、
   把「這裡就是大正某頁某欄」寫在號碼旁、另做一份按「被引用的一方」排好的倒過來目錄）

第 6 節刻意不用 VA、token、TEI、索引容器等術語；要改技術細節改
`ys-steps.md`，後記只留白話。

結語：「願此資料庫有助佛法的研究與流傳，也願讀者不忘前人的辛勞。年輕人有了 AI 神器，
更要勇於實現夢想，承擔起續佛慧命的責任。」

後記原始檔是 **`ys/ys-epilog26.txt`**，**已含 Accelon3 標記**（`<章>`、`<節>`、
`<段/>` 等，一行一個 adb 行）；`ys/prep.ts` 每次重建都直接讀這個檔，改字改它即可。

### 3.2 附錄（自動補入）

CBETA Y **沒有**舊版卷首那五頁。這五頁已抽出成 `ys/appendix.txt`（含標記）並進版控，
重建時直接讀檔，**不需要 `yinshun.adb`**：

| 頁 | 字數 |
|---|---|
| 00p印順導師略譜 | 10,962 |
| 00p印順導師著作出版年表 | 6,234 |
| 00p印順導師略傳 | 5,792 |
| 00p印順文教基金會簡介 | 268 |
| 00p參與人員名單 | 181 |

輸出時另立 `<檔 n="appendix.xml">`、`<書 … id="99">附錄（舊版卷首資料）</書>`，
頁 id 沿用 `00p…`。這樣 CBETA 日後補上或修改 Y 部 XML，重跑流程時
CBETA 的新文字與舊版附錄都會自動併回，不需要手動搬。

> 這五頁只存在 `yinshun.adb`（`D:\2023\yinshun-corpus` 的 `y00.xml`、
> `appendix.xml` 都沒有），所以 `yinshun.adb` 是必要輸入，請保留。

#### 分行要保留（2026-10-28 修正）

`ys/appendix.txt` 現在是 **1,552 行**，一行一個 adb 行，**照 `yinshun.adb` 原樣保存**。
它由一次性工具 `ys/extract-appendix.ts` 從 `D:\accelon3\yinshun.adb` 抽出：

```powershell
bun run ys/extract-appendix.ts     # 只在需要重取時跑
```

先前版本把每頁壓成一整行（最大的 35,143 字），結果踩到 Accelon3 的**行長上限
`MAXLINELEN = 8192` bytes（4,096 字）**：`lines.physical` 會把超長行截在 4,096 字，
內文卻完整打包，行表與內文從此錯開——附錄尾巴的「參與人員名單」「略傳」「略譜」
「基金會簡介」定位不到，搜尋「葉健欣」第二筆就顯示「VA …：無法定位」。
現在 `ys/pack.ts` 會先檢查行長，超過 4,096 字直接報錯，不會再默默產生壞檔。

---

## 4. 大正鏈結：`ys/calibrate.ts`

```powershell
bun run ys/calibrate.ts
```

輸入 `ys-text-full.txt` ＋ 對照表 ＋ 語料 XML，輸出 `build/ys-linked.txt`。

### 4.1 頁元對映（語料 70 頁元）

對照表的印順座標是 `<頁元>p<頁>.<行><字>`，頁元不是冊。規則是：
**同一檔案中 `pb.n` 首字元類別（`a`、`b`、數字）連續相同的區段，就是一個頁元**。

| 檔案類型 | 檔數 | 每檔頁元 | 小計 |
|---|---|---|---|
| `a` 段＋數字段（`a#`） | 10 | 2 | 20 |
| `a`＋`b`＋數字（`ab#`） | 8 | 3 | 24 |
| 純數字 | 26 | 1 | 26 |
| | **44** | | **70** |

`y00.xml`（目錄）不計。頁碼是「該頁元內第幾個 pb」（1 起算）。

### 4.2 定位流程

1. 從語料 XML 的 `<lb n="頁.行">` 取出該行的漢字（只用漢字，不含標點）
2. 依頁元對映把 `(頁元, 頁, 行, 字)` 換成語料文字
3. 在對應的 Y 卷（`yNN` ↔ `YNN`，兩邊標題一致）裡找該段文字：
   - 先精確比對（10 字種子＋最長連續匹配）
   - 失敗再用寬鬆比對（多個 6 字種子＋LCS，允許插字漏字，匹配 ≥10 字）
4. 同一目標且相鄰／重疊的區間先合併，再排除重疊
5. 在 `ys` 文字上用 `<聯 i="taisho?<卷>p<頁><欄>" q="<大正引文>">…</聯>` 包住
6. **位置一律用「原始字元」索引**（連標點一起算）：`locate()` 給的是漢字序號，
   換成原始位置時要走 `hanToRaw`。先前直接把漢字序號當字元位置，引文裡的「，」
   會把 `</聯>` 提前一個字——「過去未來色無常，況現在**色！**」就少塗了「色」。
7. 收尾多吃標點（作者 2026-10-28）：引文結尾通常落在標點上，`</聯>` 會往後吃
   緊接的 `，。！？；：、）」』】》〉…—·`，因為沒有人會把引文斷在標點前面。

`q` 是從大正文字按對照表 `(卷,頁,欄,行,字)` 抽出的引文（純漢字），
點 `<聯>` 時用來在大正頁面塗紅。

### 4.3 預期數字

```text
spans 10445  exact 9314  relaxed 1131  notfound 3683
accepted 8401
links 25920
```

`notfound` 多半是轉述、或兩邊文字差異過大。

### 4.4 為什麼不用座標直接插

實測語料「頁 65」與 CBETA `0065a` **不是同一頁**（Y22 的 `0065a` 只有 13 行，
語料同頁有 19 行以上），且語料 70 頁元、CBETA 73 頁元。
所以只能用「文字對位」，不能把 `(頁,行,字)` 直接當成 `pb`／`lb`。

---

## 5. 打包：`ys/pack.ts`

```powershell
bun run ys/pack.ts
```

- 讀 `build/ys-linked.txt`，以 `authorAdb`（`dbtype 0`）打包
- 資源：`logo/ys_logo.png`（資源名 `ys_logo.png`，Accelon26 會依
  `<dbname>_logo.png` 找封面）、`logo/yinshunfoundation.png`（年表頁的 `<嵌圖>`）
- 打包後把 header 的 `andtagid` 設回 0（與 `yinshun.adb` 一致）
- 打包前檢查每一行 ≤ 4,096 字（Accelon3 `MAXLINELEN`），超過直接報錯
- 輸出 `build/ys.adb`，並複製到 `D:\accelon3\ys.adb`

預期：`dbname ys`、`linecount 307141`、`25.2 MiB`、`resources 2`。

---

## 6. 驗證

```powershell
go run ./cmd/abx inspect 'D:\accelon3\ys.adb'
bun run ts/tools/probe-adb.ts --adb 'D:\accelon3\ys.adb' --query 涅槃
```

應看到：`dbname "ys"`、`linecount 307141`、`andtagid 0`，
檢索有結果且 `consoleErrors: null`。

目錄第一項是「般若經講記」，最後一項是「2026年AI版後記」（章名「後記」）。

鏈結回歸（需同時開 `ys.adb` 與 `taisho.adb`）：

- 大正 `51p185b` → 上方「回連結」應出現 12 個按鈕
- 點按鈕 → 右欄到 ys 該頁，引文塗紅
- 在 ys 該頁點 `<聯>` → 大正 `51p185b`，引文塗紅

---

## 7. 一鍵重建

CBETA Y 更新後：

```powershell
pwsh D:\2026\adb-converter\ys\build.ps1
```

流程：`y2adb` → `ys-prep` → `ys-calibrate` → `ys-pack`。

四步各自也可單獨跑（除錯時常用）。

---

## 8. 常見陷阱

1. **漢字計數**：對照表的「字」只數漢字，不含標點；抽引文、算位置都要先過濾。
2. **CJK 的 `\b`**：JS 的 `\b` 對漢字無效，`/<聯\b/` 永遠不匹配；要用 `/<聯/`。
3. **`type="old"`**：CBETA 的 `pb`／`lb` 有新旧兩套，只取沒有 `type="old"` 的。
4. **`lines.virtual` 不可靠**：它與原始字元的對應會漂移，切行會把標籤切斷；
   本流程不使用它。
5. **頁元不是冊**：70 是頁元數，不是 44 冊；`ys` 的 73 頁元是 CBETA 的 a/b/y/z 前綴。
6. **`<註>` 是腳註標記**：Accelon26 會把 `<註>內容</註>` 的內容隱藏，
   所以 `ys` 的註用純文字 `〔註n〕`，不要用 `<註>` 標籤。
7. **`<back>` 未收**：CBETA 的校注／新增校注（約 21 萬字）目前不入 `ys.adb`。
8. **`appendix` 來源是 `yinshun.adb`**：不要把 `D:\accelon3\yinshun.adb` 刪掉或覆蓋。

---

## 9. 已知限制與待辦

- 3,683 筆對照列未定位（轉述、版本差異）
- 註是純文字行，不是可點跳轉的腳註
- 跨行引文拆成「每行一個聯」（同一目標），視覺上是一串相鄰連結
- 寬鬆比對偶爾會落在卷中重複出現的相似句
- 反向塗紅的起點偶爾多帶一個標點
- `<back>` 校勘記未收（需要時另加開關）

---

## 10. 產物清單

| 檔案 | 說明 |
|---|---|
| `ys/ys-epilog26.txt` | 後記原始檔（含 Accelon3 標記） |
| `build/ys-text.txt` | y2adb 輸出（44 冊，含註） |
| `build/ys.lbs.tsv` | 行號 → 冊／lb |
| `build/ys-text-full.txt` | ＋附錄＋後記 |
| `build/ys-linked.txt` | ＋`<聯>` 鏈結 |
| `build/ys.adb` | 打包結果 |
| `D:\accelon3\ys.adb` | 部署位置 |
| `D:\2026\xml-p5\Y` | CBETA Y 稀疏 clone |
| `logo/ys_logo.png` | 封面圖 |
| `cmd/y2adb/main.go` | 轉換器 |
| `ys/appendix.txt` | 舊版卷首五頁（含標記） |
| `ys/prep.ts` | 附錄＋後記 |
| `ys/calibrate.ts` | 鏈結定位 |
| `ys/pack.ts` | 打包 |
| `ys/build.ps1` | 一鍵重建 |
