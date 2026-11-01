# taisho.adb（大正藏 1–85 冊）產生步驟

> 目的：用 **CBETA XML-P5 2026.R2**（T 1–55、85）＋ SAT 2018（T56–84，public domain 文本）重建一份 **accelon3 相容** 的 `taisho.adb`，
> 涵蓋 1–85 冊，`頁 id` 仍是 `NpMc`，讓 `yinshun.adb` 之類的舊庫用
> `<聯 i="taisho?51p185b">` 就能跳到新檔。
>
> 成品：`build/taisho-85.adb`（部署時改名 `taisho.adb`）。

## 0. 成品數據（2026-11-01 第二批；CBETA 2026.R2）

| 項目 | 數值 |
|---|---|
| 檔案 | 314.7 MiB（329,957,672 bytes） |
| SHA-256 | `AB9C58023B633614E0E2D9E3641C38F061DEABB2CC99A3EA22A8C0EA3E90534A` |
| 文字 | 6,745,515 行（max VA 122,054,261） |
| 冊／書／卷 | 85／3,000／17,998 |
| 頁欄（`<頁 id="NpMc"/>`） | 238,278（全部唯一） |
| 標記 | 36 種 |
| tokens | 27,225 種／120,969,738 筆 |
| resources | `taisho_logo.png`（297,879 bytes） |
| 檔頭 | `dbname=taisho`、`dbcname=大正新脩大藏經`、`dbtype=4`、`srcBlockSize=16384`、`compression=1`、`andtagid=21`（頁） |

> **2026-11-01 重打包（tokenizer）**：代理對改成「一個 supplementary 字元＝1 個 VA」
> （見 [han-position.md](./han-position.md)）。文字裡原本就有 14 個悉曇字元，
> 舊規則各算 2 個 token；現在各算 1 個，所以 maxVA 122,054,275 → **122,054,261**、
> hits 少 14。**頁 id、行界、文字內容都不變**。

> **缺字改成 Unicode（2026-10-31）**：`<g ref="#CB…"/>` 不再留 `&CB…;`。規則：
> `<g>` 內文只有一個字就用它；否則用 `teiHeader/charDecl` 的 `<mapping type="unicode">`
> （含 `normal_unicode`）；只有 PUA 對應的沿用 PUA 字元。CB 缺字已全部換掉（`&CB…;` 0 個）；
> 其中 **931 碼／2,425 次只有 PUA**（charDecl 沒有 unicode），文字裡是 plane-15 PUA，
> 因此不會出現在 `taisho-missing-gaiji.tsv`，另見
> [missing-char.md](./missing-char.md) §4.4 與 `docs/adb/taisho-pua-gaiji.tsv`。
>
> **PUA → 通用字（2026-11-01 第二批）**：這 931 碼裡，CBETA 外字庫有
> `norm_big5_char` 的 **216 碼／1,047 次**已換成通用字（1 字換 1 字）。plane-15 PUA
> 2,425 → **1,378 次**、931 → **715 碼**；`&CB…;` 仍 0。頁 id、行數（6,745,515）、
> maxVA（122,054,261）與每行 VA 都不變。成品 329,957,672 bytes、SHA-256
> `AB9C58023B633614E0E2D9E3641C38F061DEABB2CC99A3EA22A8C0EA3E90534A`、
> tokens 27,225（舊 27,429；少 216 個 PUA、多 12 個新通用字 token）。
> 替換帳是 `build/pua-norm.tsv`，工具 `tools/pua-norm.py`（見 [missing-char.md](./missing-char.md) §2.5）。
>
> **SAT 梵字（&SD）也換掉了（2026-10-31 第二次重建）**：SAT 2018 的 `&SD-XXXX;`
> 依 `SD-XXXX → U+FA000+XXXX` 換成第 16 平面 PUA，115,246 次／895 碼全部歸零，
> 由內嵌的 Accelon Siddham 字型顯示。SAT 另有 `&SDxxxxx;`（無連字號、非 4 位 hex）
> 3,665 碼／3,672 次，沒有公式可換，保留原樣（多為悉曇連字，`charDecl` 有
> 對應的 Unicode 序列，見 [missing-char.md](./missing-char.md)）。
> 行數與頁欄不變（6,745,515 行、238,278 頁）；tokens 28,410 → 27,429（含 2026-11-01 代理對修正）。
>
> **2026-10-31 之後的 `tei2adb`**：SD／RJ 不再需要 charDecl，會直接依
> `SD-XXXX → U+FA000+XXXX`／`RJ-XXXX → U+100000+XXXX` 換成 PUA，並由內嵌的
> Siddam／Ranjana 字型顯示；CB 缺字只有 PUA 時沿用 PUA。完整規則見
> [missing-char.md](./missing-char.md)。
>
> **行表修正（2026-10-29）**：`index-builder` 的 `lines.physical` 照 Delphi `addbuffer`
> 把每行長度截在 `MAXLINELEN`（8192 bytes = 4,096 字）。舊版有一行 5,427 字
> （第 4,479,231 行），之後 2.27M 行的位移全部短少 2,662 bytes，造成 69,454 行
> 斷在標籤內（`<頁 id="63p967` 被切成兩行，閱讀器顯示成文字）。現在
> `tei-pack.ts` 打包前會把超過 4,000 字的行切開（不切進標籤、不切開代理對），
> 全表掃描 6,745,515 行：**斷在標籤內 0 行**。內文逐字相同（解壓後
> SHA-256 `b4b2f621…` 與舊版一致），只有行界不同。
>
> 上一版（有缺陷）：331,018,733 bytes、SHA-256 `b4ef2398…`、6,745,532 行。

> **這是純經文底座**：正文沒有本專案加的 `<聯>`／`<嵌>`／經群；那些放獨立 adb。
> 只有 CBETA 換版才重建（帳本見 `deploy/cbeta-base.json`、`tools/cbeta-base.ts --check`）。

## 1. 來源

| 用途 | 路徑 |
|---|---|
| 正文 T 1–55、85 | `D:\2026\xml-p5\T`（CBETA XML-P5 2026R2，commit `dbdea41`） |
| 正文 T 56–84 | `D:\2023\sat2018\T`（SAT 2018；文本與底本為 public domain，數位文字依 SAT 2018 授權標注，TEI 標記按 CBETA convention） |
| 格式與對照 | `D:\accelon3\taisho.adb.old-2026-10-29`（上一版） |
| logo | `logo/taisho_logo.png` |

`D:\2023\sat2018\T` 的 `cbeta` 符號連結、`t-txt`（SAT 文字）都**不是**這條管線的輸入。

## 2. 工具

| 檔案 | 語言 | 作用 |
|---|---|---|
| `cmd/tei2adb/main.go` | Go | TEI → adb 文字（一行一個 pcl 行，標記內嵌） |
| `ts/tools/tei-pack.ts` | bun | 文字 → `.adb`（source/tokens/tags/tables/attributes/caches/resources 全部重建） |

打包走 `ts/src/adbauthor.ts` → `ts/src/author-core.ts`，與 accelon3 Delphi indexer 同一個容器佈局；
`attributes`、`attributes.sorted` 是**從新文字重算**的（不是照抄舊檔），所以 VA 一定對得上新內容。

## 3. 指令

```bat
:: 1) TEI → 文字（約 8 分鐘；-tei 可用 ; 串多個根目錄，同一冊取第一個找得到的）
build\tei2adb.exe -tei "D:\2026\xml-p5\T;D:\2023\sat2018\T" -vol 1-85 -release 2026.R2 -out build\tei-all-2026R2.txt

:: 1.5) plane-15 PUA 有 norm_big5_char 的換成通用字（2026-11-01 起；216 碼／1,047 次）
::      第一次先 make 產生 build\pua-norm.tsv，之後可直接 apply
python tools\pua-norm.py make
python tools\pua-norm.py apply build\tei-all-2026R2.txt build\tei-all-2026R2-norm.txt

:: 2) 文字 → adb（約 75 秒；最後的 "" 表示不要加 posmap align）
bun run ts/tools/tei-pack.ts build\tei-all-2026R2-norm.txt build\taisho-2026R2-norm.adb taisho 大正新脩大藏經 logo\taisho_logo.png ""
```

`build\tei-all-2026R2.txt`（tei2adb 原始輸出）要保留，`pua-norm.py make` 靠它重算
替換帳；`build\tei-all-2026R2-norm.txt` 才是打包的輸入。規則與驗證見
[missing-char.md](./missing-char.md) §2.5。

指定單冊做 pilot：

```bat
go run ./cmd/tei2adb -tei D:\2023\sat2018\T -vol 1 -out build\tei-T01.txt
bun run ts/tools/tei-pack.ts build\tei-T01.txt build\taisho-T01.adb taisho 大正新脩大藏經 logo\taisho_logo.png
```

## 4. 驗證

```bat
go run ./cmd/abx inspect build\taisho-85.adb
bun run ts/tools/probe-adb.ts --adb build\taisho-85.adb --query 涅槃
bun run build/tmp-idcheck2.ts build\taisho-85.adb 51p185b
```

`tmp-idcheck2.ts` 走的就是 accelon3 `id2docnode()` 的路徑：
`attributes/頁.id` → 記錄指標 → `tags/頁` → VA → 內文。實際輸出：

```text
頁.id=51p185b → tag=頁 ord=145467 va=77500257 blk=9850
   prefix="<頁 id=\"51p185b\"/>然絲。絲喻佛性。文字喻妄相。又云。水不離波…"
頁.id=56p1a   → va=83926433  prefix="<頁 id=\"56p1a\"/>勝鬘經義疏此是夫勝鬘者…"
```

**accelon3 相容的關鍵**（少一項，`yinshun` 就連不進來）：

1. 檔頭 `dbname=taisho`（`taisho?…` 靠它找檔）、`dbtype=4`、`compression=1`、`srcBlockSize=16384`
2. 容器齊全：`source / tokens / tags / tables / attributes / attributes.sorted / caches / resources`
3. `頁 id` 格式 `NpMc`（`51p185b`，冊＋頁＋欄）
4. `attributes` 有 `頁.id`、`書.id`、`冊.id`（`enablefastidlookup` 只認 `*.id`）
5. `<檔>` 裡 7 棵 `<樹>` 宣告照舊（`t="冊,書,品."`、`s="$書"`…）

## 5. 標記對照表（TEI → adb）

| TEI | adb | 說明 |
|---|---|---|
| `<pb n="0001a" ed="T"/>` | `<頁 id="1p1a"/>` | 冊號取自目錄（T01→1），頁碼去前導零 |
| `<lb n="0001a01" ed="T"/>` | 換行 | 一行 = 一個 pcl 行 |
| 無 `<pb>` 的冊（56–84） | `<頁 id="…"/>` | 由 `lb n` 前 5 碼（`0001a`）推得 |
| `<cb:juan fun="open"><cb:jhead>…` | `<卷>…</卷>` | `fun="close"` 的 jhead 重複標題，丟棄 |
| `<cb:div type="xu">`＋`<head>` | `<序>…</序>` | |
| `type="pin"` | `<品>` | |
| `type="jing"` | `<經>` | 標題含「（一）第一分初…」前綴 |
| `type="fen"` | `<分>` | |
| `type="other"` | `<其他>` | |
| `type="taisho-notes"` | 整段丟棄 | `<back>` 裡的校註清單，只有標題沒有正文 |
| `<cb:mulu>` | 丟棄 | 內容與 `<head>` 重複，還帶「1 大本經」這種編號 |
| `<head>`／`<jhead>` | 標題文字 | 去掉內嵌 `note`／`app` |
| `<cb:docNumber>` | 純文字 `No. 1` | |
| `<byline>` | 純文字 | |
| `<app><lem>` | 文字 | 取 CBETA 採用的讀法 |
| `<app><rdg>`、`<note>`（含巢狀） | 丟棄 | 校勘不進 adb |
| `<g ref="#CB00178"/>` | `㮈`（Unicode）；沒有對應才 `&CB00178;` | 2026-10-31：`<g>` 內有替代字優先，其次 `charDecl` 的 `<mapping type="unicode">`；都沒有才留碼位並記進缺字表 |
| `<cb:tt>` 內 `xml:lang="sa"/"pi"`、`place="foot"` | 丟棄 | 梵／巴對照不進正文 |
| 檔案根 `T01n0001` | `<段/><書 id="n1">長阿含經</書>` | 書 id 依出現順序 `n1…n3000` |
| 冊目錄 | `<冊 id="N">部名</冊>` | 部名見 §6 |
| 56–84 冊檔頭題名 | `<書 id="…">題名</書>` | 檔頭是「大正新脩大藏經數位版, No. N 題名」，取 `No.` 之後的文字 |

## 6. 部名

- 1–55、85：沿用舊 `taisho.adb` 的 56 個冊名。
- 56–84：依作者提供的經號分段，取該冊出現的部名（跨部就逗號並列）：

| 經號 | 部 |
|---|---|
| 2185–2245 | 續經疏部 |
| 2246–2247 | 續律疏部 |
| 2248–2295 | 續論疏部 |
| 2296–2700 | 續諸宗部 |
| 2701–2731 | 悉曇部 |
| 2732–2920 | 古逸部 |

實際結果：56–61 續經疏部、62 續律疏部＋續論疏部、63–69 續論疏部、
70 續論疏部＋續諸宗部、71–83 續諸宗部、84 續諸宗部＋悉曇部、85 古逸部全＋疑似部全。

## 7. 已知差異（不是 bug）

1. **文字是 CBETA 2026.R2（T01–55、85）＋SAT 2018（T56–84，public domain 文本）**：CBETA XML-P5 沒有 56–84 冊，
   這 29 冊取 SAT 2018（文本與底本為 public domain，數位文字依 SAT 2018 授權標注）；用字、標點、修訂讀法都跟 2005 版不同。
2. **校勘不進 adb**：`<app>` 只取 `lem`（CBETA 採用的讀法），`<note>`／`<rdg>` 全丟。
   舊 adb 也沒有校勘結構。
3. **缺字大多已換成 Unicode**（2026-10-31）：`<g>` 內有替代字就用它；自閉合的就查 `teiHeader/charDecl` 的
   `<mapping type="unicode">`。`&SD-XXXX;` 已全部換成 PUA；仍換不掉的
   `&SDxxxxx;`（3,665 碼／3,672 次，悉曇連字）保留 `&…;`，列在
   `docs/adb/taisho-missing-gaiji.tsv`。
4. **品／附文不刻意對齊舊 adb**：定位靠 vol/page/column/line，不靠品節點。
5. **resources 只有 logo**：沒有缺字圖（缺字已多數換成 Unicode；少數 SAT 缺字仍是 `&…;`）。
6. 舊 adb 的 `其他` 標題裡有 `&lac;`（闕文）實體，CBETA 2026.R2 沒有；兩邊節點數必然不同。

### 7.1 2026-10-28 補：56–84 冊的書名

原本 `sutraTitle()` 只認 `<title level="m" xml:lang="zh-Hant">`，而 56–84 冊的檔頭是

```xml
<title xml:lang="zh-Hant">大正新脩大藏經數位版, No. 1 勝鬘經義疏</title>
```

所以 541 部書的 `<書>` 是空的（`<書 id="n2268"></書>`），目錄整批空白。
現在 `sutraTitle()` 會 fallback 到這個格式，取 `No. N ` 之後的題名。
重建後 3,000 部書名全部非空（`cachedStrings('書')` 驗證）。

## 8. TEI 解析筆記（後續解析的起點）

### 8.1 檔案結構

```text
<TEI xml:id="T01n0001">
  <teiHeader> … <title level="m" xml:lang="zh-Hant">長阿含經</title> …
    <charDecl> … <char xml:id="CB00166"> … <mapping type="unicode">U+267DB</mapping>
  <text><body>
    <milestone unit="juan"/>
    <pb n="0001a" ed="T"/>
    <lb n="0001a01" ed="T"/><cb:docNumber>No. 1</cb:docNumber>
    <cb:div type="xu"><cb:mulu type="序">序</cb:mulu><head>…</head> … </cb:div>
    <cb:juan n="001" fun="open"><cb:mulu type="卷"/><cb:jhead>佛說…卷第一</cb:jhead></cb:juan>
    <cb:div type="jing"><cb:mulu level="2" type="經">1 大本經</cb:mulu><head>（一）第一分初…</head>
      <p xml:id="…">…<lb/>…<app><lem>辨</lem><rdg>辯</rdg></app>…</p>
    </cb:div>
  </body>
  <back><cb:div type="taisho-notes"><head>大正 校註</head><note …/></cb:div></back>
</TEI>
```

### 8.2 元素清單（正文相關）

| 元素 | 出現 | 處理 |
|---|---|---|
| `pb` | 1–55、85 冊每欄一個 | → `頁` |
| `lb` | 每行一個（含 56–84 冊） | → 行界；56–84 兼作頁欄來源 |
| `cb:juan` | `fun="open"`／`"close"` | open 的 `jhead` → `卷`；close 丟棄 |
| `cb:mulu` | 卷/序/經/品/其他/會/分 | 丟棄（與 head 重複） |
| `cb:div` | `type="xu,pin,jing,fen,other,taisho-notes"` | 前五種 → 序/品/經/分/其他 |
| `head`／`cb:jhead` | 標題 | 取純文字 |
| `cb:docNumber` | `No. 1` | 純文字 |
| `byline` | 譯者 | 純文字 |
| `p` | 段落 | 只收文字（不換行） |
| `app`/`lem`/`rdg` | 校勘 | lem 收、rdg 丟 |
| `note` | `type=orig/mod/rest`、`place=foot/inline/text` | 全丟（含巢狀） |
| `cb:tt`/`cb:t` | 梵巴對照 | sa/pi、place=foot 丟 |
| `g` | `ref="#CB00178"` | → 替代字／charDecl 的 Unicode；沒有才 `&CB00178;` |
| `span class="tx"` | 56–84 冊 | 無語意，照收文字 |
| `anchor`、`milestone`、`space`、`br` | | 忽略 |

### 8.3 踩過的坑

1. **`juan fun="close"` 也帶 `jhead`** → 每個檔案會出現兩次卷標題，卷數直接翻倍。
2. **`mulu` 的文字會漏進正文**（`1 分1 大本經`）→ 必須整段跳過。
3. **`cb:tt` 的梵巴並列**（`佛說長阿含經Dīrgha-āgamaDīgha-nikāya卷第一`）→ 只收 `xml:lang="zh-Hant"`。
4. **`note` 會巢狀**（`note` 裡還有 `note`）→ 用 skip 深度遞迴跳過。
5. **`<back>` 的 `taisho-notes`** 只有 `<head>大正 校註</head>`，正文全在 note 裡 → 整段丟，否則每部經尾巴都多一個空標題。
6. **56–84 冊沒有 `<pb>`**，頁欄只能從 `lb n` 的前 5 碼推，且同一欄的第一行要補 `頁` 標記。
7. **`title level="m"` 內可能嵌 `<g>`**（如 `佛說<g ref="#CB00178"/>女祇域因緣經`）→ 取經名時要清標記。
8. **`charDecl` 的 charmap**：`CB00166` → `U+F00A6`（PUA）／`U+267DB`；2026-10-31 起解析 `<mapping type="unicode">`（不採用 PUA），PUA 只在沒有 unicode 時才考慮（目前不用）。
9. **檔名＝冊/經/卷**：`T01n0001_001.xml` → 冊 1、經 0001、卷 001；排序後即是閱讀順序。
10. **`lb` 的 `ed` 屬性**有三種寫法（`ed="T"`、無 `ed`、屬性順序不同），不能用字串比對，要解析屬性。

### 8.4 統計（85 冊全量）

| 元素 | 數量（轉換後 adb） |
|---|---|
| 冊 | 85 |
| 書 | 3,000 |
| 卷 | 17,998 |
| 序 | 601 |
| 經 | 2,363 |
| 品 | 5,352 |
| 分 | 289 |
| 會 | 102 |
| 其他 | 24,827 |
| 頁 | 238,278（全部唯一；舊檔有重複頁） |

## 8.5 來源交叉核對

T2250《阿毘達磨俱舍論指要鈔》（T63，頁 807a）在 **Kanseki Repository（漢籍リポジトリ）**
也有收錄，可作 SAT 2018 文字之外的獨立核對。這也支持 T56–T84 的文本本身是公開可得的；
我們的 TEI 標記則是按 CBETA convention 另外整理的。

## 9. 後續工作

1. **缺字（2026-11-01 第二批）**：CB 缺字已按 `<g>` 內文與 `charDecl` 換成 Unicode；
   plane-15 PUA 有 `norm_big5_char` 的 216 碼／1,047 次已換成通用字，剩下 715 碼／1,378 次
   （只有組字式，清單 `docs/adb/taisho-pua-gaiji.tsv`、IDS 用
   `docs/adb/taisho-ids-input.tsv`）。
   SAT 2018 的 `&SD-XXXX;` 已換成 PUA（115,246 次／895 碼，字型已內嵌）。
   剩下 `&SDxxxxx;`（3,665 碼）是悉曇連字，`charDecl` 有 Unicode 序列但沒有單一碼位，
   列在 `docs/adb/taisho-missing-gaiji.tsv`；閱讀器顯示時已換成序列，用內嵌的
   Noto Sans Siddham 子集排（2026-10-31，`siddham-seq.ts`）。完整規則見
   [missing-char.md](./missing-char.md)。
2. **校勘**（若以後要）：`app/lem/rdg` 與 `note type="mod"` 已有完整資料，可另設標記與面板。
3. **圖片資源**：舊 adb 的 35,981 張缺字圖可選擇性沿用（先確認字號對得上）。
4. **品／附文**：若要跟舊 adb 對齊，用舊 `taisho-struct.tsv` 的標題清單逐冊比對。
5. **`caches`**：目前只有 `冊/書/卷`；若目錄樹要顯示 `品` 節點，需確認 `t="冊,書,品."` 的 cache 是否要補。

## 10. 檔案

| 檔案 | 說明 |
|---|---|
| `cmd/tei2adb/main.go` | TEI → 文字（含所有規則；改規則從這裡改） |
| `ts/tools/tei-pack.ts` | 文字 → adb（含 logo） |
| `build/tei-all.txt` | 中間產物，372 MB UTF-8，可重新產生（`build/` 不進版控） |
| `build/tei-all-2026R2-norm.txt` | 換過通用字的打包輸入（與原始輸出行數相同） |
| `tools/pua-norm.py`、`build/pua-norm.tsv` | PUA → 通用字工具與 216 列替換帳 |
| `docs/adb/taisho-gaiji-dict.tsv`、`.md` | 剩下 715 碼的 glyph（dict.cbeta.org）＋組字式＋第一次出現 |
| `build/taisho-85.adb` | 成品（部署為 `taisho.adb`） |
| `build/tmp-idcheck2.ts` | 錨點鏈驗證 |
| `build/taisho-struct.tsv` | 舊 adb 的結構清單（冊/書/卷/序/…＋標題），對照用 |
