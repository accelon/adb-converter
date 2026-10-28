# cbeta-adb-skill：把 CBETA 的 XML 變成 accelon 的 `.adb`

> 這份是「換一部藏經」時的操作手冊：輸入是 CBETA 的 TEI P5 XML（`cbeta-org/xml-p5`），
> 輸出是一顆 accelon3 相容的 `.adb`。已經走過這條路的有三個成品，可以直接照抄：
>
> | 成品 | 轉換器 | 打包 | 步驟文件 |
> |---|---|---|---|
> | `taisho.adb`（大正藏 1–85 冊） | `cmd/tei2adb` | `ts/tools/tei-pack.ts` | `taisho-steps.md` |
> | `ys.adb`（印順法師佛學著作集，Y 部） | `cmd/y2adb` | `ys/pack.ts` | `ys-steps.md` |
> | `goryeo.adb`（高麗藏） | `cmd/k2adb`（k-txt，不是 TEI） | `ts/tools/goryeo-pack.ts` | `goryeo-steps.md` |
>
> 新庫請挑最接近的那一支當模板，**不要從零寫**；真正要重寫的通常只有「標記對照表」那一段。

---

## 0. 先想清楚三件事

1. **誰要連進來？** 如果舊庫要用 `<聯 i="taisho?51p185b">` 指過來，`頁 id` 就必須沿用
   `NpMc`（冊＋`p`＋頁欄），檔頭 `dbname` 也必須是 `taisho`。改名就等於斷連結。
2. **一本書一檔，還是一部一檔？** `檔`＝來源檔（`<檔 n="Y01n0001.xml">`），
   目錄樹的第一層通常是 `書`，不是 `檔`。兩者不要混。
3. **要不要目錄層級？** 要能在左欄展開，就必須有 `<書 t="章,節,項.">` 與
   `<章 t="節,項.">` 這種**逐層宣告**；只寫 `<書>` 而不宣告 `t=`，樹只有一層。

---

## 1. 心智模型（五分鐘）

`.adb` 是「一份文字 ＋ 一堆索引」的容器：

```text
source        壓縮後的文字（UTF-16LE，bzip2，每 16 KiB 一個區塊）
tokens        詞 → 出現位置（VA）
tags          標籤 → 出現位置
tables        doclengths / lines.physical / lines.virtual / blocks.virtual / tags.virtual
attributes    標籤的屬性（`頁.id`、`書.id`…），`enablefastidlookup` 只認 `*.id`、`*.i`
caches        `t=`／`s="*…"` 宣告要快取的標籤內文（目錄、頻次靠它）
resources     圖片（logo、插圖）
```

* **一行 ＝ 一個 `<lb>`**。adb 沒有「段落」概念，段落是 `<段/>` 標記出來的。
* **VA** 是「字的位置」，不是位元組位移；`頁 id` 只是標在 VA 上的一個標籤，
  跳頁＝找到那個標籤的 VA。
* 標籤可以**不寫收尾**：`<聯>…` 會在下一個 `<聯>` 或 `</聯>` 結束。要精確控制就寫 `</聯>`。

檔頭（前 256 bytes）決定 accelon3 怎麼認這顆庫：

| 欄位 | 意義 | 常見值 |
|---|---|---|
| `dbname` | 檔名／`聯` 前綴 | `taisho`、`ys`、`goryeo` |
| `dbcname` | 顯示名稱 | 大正新脩大藏經 |
| `dbtype` | 0 一般／4 大正這類多冊藏 | 照舊庫 |
| `compression` | 1＝bzip2 | 1 |
| `srcBlockSize` | 16384 | 16384 |
| `andtagid` | `頁` 標籤的 id（打包後要對） | `y2adb` 最後把它設 0 |

> 打包一律走 `ts/src/adbauthor.ts`（Node）或 `ts/src/author-core.ts`（瀏覽器），
> 它會**重算** tokens/tags/attributes/caches，不要手寫容器。

---

## 2. 六步流程

```text
① 取源  →  ② XML → 文字（Go 轉換器）  →  ③ 補資料（外部檔）
        →  ④ 連結（可選）  →  ⑤ 打包  →  ⑥ 驗證＋部署
```

### ① 取源

```powershell
# CBETA TEI P5（稀疏 clone 即可，只拿要的部）
git clone --filter=blob:none --sparse https://github.com/cbeta-org/xml-p5 D:\2026\xml-p5
cd D:\2026\xml-p5
git sparse-checkout set Y          # 或 T / X / J …
```

`xml-p5/T` 是**一經一卷一檔**（`T01n0001.xml`…），`Y` 是一冊一檔（`Y01n0001.xml`），
檔名規則先確認，`-vol` 之類的參數通常就是靠它。

### ② XML → 文字（一行一個 `<lb>`）

```powershell
go run ./cmd/tei2adb -tei D:\2026\xml-p5\T -vol 1-85 -out build\tei.txt
go run ./cmd/y2adb  -src D:\2026\xml-p5\Y -out build\ys-text.txt -lbs build\ys.lbs.tsv
```

轉換器只要做三件事：

1. **切行**：`<lb>` 就換行（`nl()`），行內其他東西都寫在同一行。
2. **對照標記**：見 §3 的表；不認識的元素只取文字、丟標籤。
3. **寫檔頭與目錄宣告**：第一行是 `<檔 n="…">` ＋ `<集>` ＋ `<隱><樹 …></隱>`。

`y2adb` 的輸出長這樣（一行就是一行）：

```text
<檔 n="Y34n0032.xml">
<書 l="目次" t="章,節,項." id="34">印度佛教思想史</書>
<卷 n="1">1</卷>
<頁元 n="印度佛教思想史" t="頁.">序分頁</頁元>
<頁 id="34pa001a"/>
<章 t="節,項." u="文">第一章 「佛法」</章>
<節 t="項." u="文">第一節 佛法興起與印度的時代文明</節>
<段/>釋迦牟尼（Śākyamuni，以下簡稱「釋尊」）誕生於印度…
```

### ③ 補資料（外部檔，不要改 XML）

CBETA 沒有的東西，做成**進版控的外部檔**，重建時合併：

| 缺什麼 | 外部檔 | 併入方式 |
|---|---|---|
| 卷首附錄、後記、序（CBETA 沒收） | `ys/appendix.txt`、`ys/ys-epilog26.txt` | `ys/prep.ts`：檔頭 ＋ 正文 ＋ 附錄 ＋ 後記 |
| `u="文"`（頻次 `s="*u=文"` 需要） | `ys/u-attrs.txt`（標籤→u 值） | `ys/prep.ts` 掃一遍，缺 `u=` 的開標籤補上 |
| 目錄層級（CBETA 只有 `cb:mulu level`） | 轉換器直接讀 `level` | `章`／`節`／`項` |

**原則**：外部檔只放「標記」，不放正文；正文永遠從 CBETA 重建，這樣 CBETA 修字才會同步。

### ④ 連結（可選）

要跟另一顆庫互相跳（例如印順引大正），就插入 `<聯 i="taisho?51p185b" q="大正原文">引文</聯>`：

* `i` ＝ `目標dbname?頁id`；`q` ＝ 大正那一段的純漢字原文（給對方頁面塗紅／回連結定位用）。
* 做法見 `ys/calibrate.ts`：讀對照表 → 在目標庫文字裡比對 → 插標籤。
* 位置一律用**原始字元索引**（連標點一起算），不要用「漢字序號」當字元位置，
  否則引文裡的「，」會讓 `</聯>` 提前一個字。
* 收尾多吃標點（`，。！？；：、）」』】》〉`），因為沒有人把引文斷在標點前面。

### ⑤ 打包

```powershell
bun run ts/tools/tei-pack.ts build\tei.txt build\taisho-85.adb taisho 大正新脩大藏經 logo\taisho_logo.png
bun run ys/pack.ts      # 印順：多了 logo、附錄圖、行長檢查
```

打包前**一定要檢查行長**：

```ts
const over = lines.filter((l) => l.length * 2 > 8192);   // MAXLINELEN = 8192 bytes = 4,096 字
```

超過 4,096 字的行，`lines.physical` 會被截斷、內文卻完整，行表從此錯開——
附錄尾巴定位不到、搜尋結果「VA …：無法定位」，而且**不會有任何錯誤訊息**。

### ⑥ 驗證 + 部署

```powershell
go run ./cmd/abx inspect build\taisho-85.adb     # 檔頭、容器、計數
bun run ts/tools/probe-adb.ts --adb build\taisho-85.adb --query 涅槃   # 真的開起來檢索一次
bun run ts/tools/check-tabs.ts --adb build\taisho-85.adb               # 左欄分頁有沒有出來
```

驗收清單：

- [ ] `abx inspect` 的 `linecount`、`tagcount`、`srcblocksize` 與預期相符
- [ ] 目錄能展開到第二、第三層（展不開＝`t=` 沒宣告）
- [ ] 搜一個常用字，摘要能定位（不是「VA …：無法定位」）
- [ ] 抽 3–5 個 `頁 id`，用 `tmp-idcheck2.ts` 走 `attributes/頁.id → tags/頁` 找得到
- [ ] `probe-adb` 的 `consoleErrors: null`
- [ ] 上架後從公開網址抓一次 sha256，與本機一致

---

## 3. TEI → adb 標記對照（最小公約數）

| TEI | adb | 備註 |
|---|---|---|
| `<?xml?>`/`<teiHeader>` | 丟棄 | 只留 `<text><body>` |
| `<pb n="0065a" ed="T"/>` | `<頁 id="22p0065a"/>` | `冊號`＋`p`＋原書頁欄；冊號由檔名或目錄推 |
| `<lb n="0065a01"/>` | 換行 | 一行一個 lb |
| `<cb:juan fun="open">` | `<卷 n="1">1</卷>` | `fun="close"` 的重複標題丟棄 |
| `<head>` / `<cb:jhead>` | `<章>`／`<節>`／`<項>` | 層級看前面的 `<cb:mulu level="1|2|3">` |
| `<p>` | `<段/>` | 段落 |
| `<note>` | 獨立一行 `〔註n〕` | **不要**用 `<註>`（會被當腳註標記隱藏） |
| `<app><lem>` | 取文字 | CBETA 採用的讀法 |
| `<app><rdg>` / `<back>` | 丟棄 | 校勘與卷末校註清單 |
| `<cb:mulu>` | 丟棄內容，只讀 `level` | 與 `<head>` 重複、還帶編號 |
| `<g ref="#CB00178"/>` | `&CB00178;` | 缺字先留碼位（之後可用構形序換真字） |
| `<cb:tt xml:lang="sa">` | 丟棄 | 梵巴對照 |
| 檔名 `T01n0001` | `<書 id="n1">長阿含經</書>` | id 依出現順序，`enablefastidlookup` 要它 |

檔頭（第一行）宣告樹，決定左欄有哪些分頁：

```text
<集 l="圖集,註釋群,編目資訊">印順法師佛學著作集</集>
<隱>
  <樹 s="*" t="書" pf1="$書.id;.">目錄</樹>
  <樹 s="*u=文" pf="$頁.id;)">頻次</樹>
  <樹 s="~00602000">西文</樹>
</隱>
<隱><引>《$書;》：「$_;」( Y $*頁; )</引><摘要頭>$書;($頁;)</摘要頭><參考資料 n="taisho,wxzj"/></隱>
```

> `s="*"` 是目錄（依 `書` 分組）、`s="$詞"` 是名詞、`s="*u=文"` 是頻次、`s="~…"` 是西文。
> 這些只是宣告，實際的層級還要靠每個實例自己的 `t=`。

---

## 4. 五個一定會踩的坑

1. **`t=` 沒宣告 → 目錄只有一層。**
   `<書 t="章,節,項.">`、`<章 t="節,項.">`、`<節 t="項."` 一層一層寫；
   結尾的 `.` 表示「這是末層」。沒寫 `t=` 的節點會被當葉節點，展不開。

2. **行長超過 4,096 字 → 行表錯位（靜默）。**
   附錄的大表格最容易中。打包前檢查，或讓轉換器把長行切開。

3. **標籤名字尾端有填充 → 詞條顯示亂碼。**
   舊 Delphi 產的 adb（如 `swjz.adb`）名字是「NUL 結尾＋`U+ABAB` 填充」。
   讀名字要切在第一個 `\0`（`adb.ts` 的 `cleanName`）。

4. **代理對（BMP 以外的字）被當成半個字。**
   `[...s]` 拿到的是「字」，`ch.charCodeAt(0)` 只看到高代理。
   判斷孤代理要 `ch.length === 1`，否則 `𢁓`、`𠀀` 全部變豆腐塊。

5. **`u=` 漏了就從頻次消失。**
   CBETA 沒有 `u=`；`ys/u-attrs.txt` 補上 `<章>/<節>/<項>` 的 `u="文"`，
   否則那幾段在 `s="*u=文"` 的頻次裡等於不存在。

---

## 5. 新庫開工檢查表

```text
[ ] 決定 dbname／dbcname／dbtype／頁 id 格式（要不要和舊庫連？）
[ ] 確認 XML 的檔名規則、卷／冊資訊從哪裡來
[ ] 挑模板：tei2adb（T/X）、y2adb（Y）、k2adb（k-txt）、或複製一支再改標記表
[ ] 寫「TEI → adb」對照表（照 §3 填空）
[ ] 目錄層級：mulu level 或 head 的巢狀深度 → 章/節/項，並寫上 t=
[ ] 外部檔：附錄／後記／u=… 要不要？放哪？
[ ] 打包前檢查行長 ≤ 4,096 字
[ ] 驗證：abx inspect、probe-adb、目錄展開、抽頁 id、sha256
[ ] 寫一份 xxx-steps.md（照 ys-steps.md 的骨架）
[ ] 上架：公開資料庫 index.txt 加一行；有說明頁就加第二欄
```

---

## 6. 相關文件

| 文件 | 內容 |
|---|---|
| `taisho-steps.md` | 大正藏 1–85 冊，tei2adb 的完整參數與部名對照 |
| `ys-steps.md` | 印順（Y 部）：目錄層級、補 `u=`、字元級對位、標點收尾 |
| `goryeo-steps.md` | 高麗藏：k-txt（TSV）→ adb |
| `FORMAT.md` | adb 二進位格式（容器、packed list、檔頭） |
| `DEPLOY.md` | 官網、exe、公開資料庫的上架流程 |
