# swjzzsrc.adb（說文解字注引用書目）

> 《說文解字注》段玉裁的注文引了大量古書。這顆庫把**被引用的書**收在一起，
> 讓段注的引文（「廣韵曰…」「方言曰…」）有一個可以直接翻查、之後可以連過去的底本。
> 這是一顆**會一直長大**的庫：`ts/tools/swjzzsrc2adb.ts` 的 `BOOKS` 表加一筆就多一本書。

## 0. 成品（2026-10-28，第一版）

| 項目 | 數值 |
|---|---|
| 檔案 | `accelon3\swjzzsrc.adb`，3,409,624 bytes（3.25 MiB） |
| SHA-256 | `708cfa83bac673cb0aa9d8156e480562ed02e3a560b7342733f9353e585bfd61` |
| 行 | 44,892 |
| 內文 | 1,445,423 字（含標記），171 個 16 KiB 來源區塊 |
| tokens | 19,441 種／511,125 筆命中 |
| 標記 | 27 個（`書 卷 部 篇 字 條 說文 反切 徐鉉 注`） |
| 書 | 6（說明、說文解字（大徐本）、爾雅、周易、尚書、廣韻） |
| 卷 | 20（說文 14 篇 ＋ 廣韻 6 卷） |
| 部 | 540（說文 540 部） |
| 篇 | 143（爾雅 19、周易 66、尚書 58） |
| 字頭 | 11,048（說文 9,833 正條 ＋ 1,215 重文） |
| 條 | 11,893（`<條 id="…">`，帶穩定 id） |
| 檔頭 | `dbname=swjzzsrc`、`dbcname=說文解字注引用書目`、`dbtype=2`、`srcBlockSize=16384` |

## 1. 收書與版本

| 書 | 來源 | 版本／授權 | 在庫裡的形式 |
|---|---|---|---|
| 說文解字（大徐本） | [shuowenjiezi/shuowen](https://github.com/shuowenjiezi/shuowen)（shuowen.org 開放資料） | 大徐本，附反切、徐鉉注、重文；Apache-2.0 | 卷 → 部 → 字 → `說文`／`反切`／`徐鉉` |
| 爾雅 | Kanripo KR1j0002 | 四部叢刊影海鹽張氏涉園藏明鈔本（晉 郭璞注） | 篇 → 條（郭注以 `<注>` 夾在條內） |
| 周易 | Kanripo KR1a0001 | TLS 正文 | 篇（卦＋十翼）→ 條 |
| 尚書 | Kanripo KR1b0001 | TLS 正文 | 篇 → 條 |
| 廣韻 | Kanripo KR1j0055 | 四庫全書《重修廣韻》（宋 陳彭年等） | 卷（序＋卷一…卷五）→ 條 |

* Kanripo（漢籍リポジトリ，www.kanjiro.org → www.kanripo.org）以 GitHub repo 一書一 repo 的形式發布，
  底本（四部叢刊、四庫全書）都是公有領域。**GitHub 直連在本地被封**，
  但 `api.github.com` 與 `codeload.github.com`（zip）可以通，所以下載走 codeload：
  `https://codeload.github.com/kanripo/KR1j0002/zip/refs/heads/master`。
* **ctext.org 不能用**：本站對這個網路位置直接回 403「Access to ctext.org is unavailable from your current location」，
  並在頁面明言禁止自動下載。所以改用上述兩個可以合法取得的來源；`說文解字（不含注）` 用 shuowen.org 的開放資料，
  比四部叢刊的頁面轉錄乾淨得多（一萬多個 JSON、欄位已經分好）。

## 2. 結構與錨點

```text
<檔 n="swjzzsrc">
<集 c="isdict" l="說文,反切,徐鉉,注,條,篇,卷,部">說文解字注引用書目</集>
<隱><樹 s="*" t="書">目錄</樹><樹 s="$字">說文字頭</樹><樹 s="*書">全文</樹></隱>

<書 n="1" id="swjz" t="卷.">說文解字（大徐本）</書>
<卷 n="1" t="部.">說文解字第一篇</卷>
<部 t="字.">一部</部>
<字 id="S00001">一</字>
<說文>惟初太始，道立於一，造分天地，化成萬物。凡一之屬皆从一。</說文>
<反切>於悉切</反切>

<書 n="2" id="erya" t="篇.">爾雅</書>
<篇 id="E.1" t="條.">釋詁第一</篇>
<條 id="E.1.1">初哉首基肇祖元胎俶落權輿始也<注>尚書曰三月哉生魄詩曰令終有俶又田俶載</注></條>
```

* **`<條 id>`**：每條都有穩定 id（`Y.1.3`＝周易第 1 篇第 3 條、`E.釋詁第一.12`、`G.3.105`…）。
  之後段注要指過來就寫 `<聯 i="swjzzsrc?E.1.1">`，格式與 `taisho?8p848c` 一樣（見 `backlink-skill.md`）。
  `字` 的 id 是 `S00001` 這種流水號，重文緊接正條。
* `s="$字"` 讓它同時是「詞典型 adb」：點本文的「江」會在右欄列出說文解字的字頭。
* `s="*書"` 全文分頁可以按書統計命中。

## 3. 指令

```powershell
# 1) 文字（--src 指到放 Kanripo repo 解壓目錄的上一層）
bun run ts/tools/swjzzsrc2adb.ts D:\2026\swjzz\build\swjzzsrc.txt ^
  --shuowen D:\2026\swjzz\build\shiwen-ref.json --src D:\2026\swjzz\src

# 2) 打包
bun run ts/tools/swjzzsrc-pack.ts D:\2026\swjzz\build\swjzzsrc.txt D:\2026\swjzz\build\swjzzsrc.adb

# 3) 驗收
go run ./cmd/abx inspect D:\2026\swjzz\build\swjzzsrc.adb
bun run ts/tools/probe-swjzz.ts --adb D:\2026\swjzz\build\swjzzsrc.adb ^
  --db swjzzsrc --root 說文解字 --rows 6
```

## 4. 怎麼加一本書

1. 找 Kanripo 的書號（`docs/../src/KR-Catalog-master/KR/KR*.txt`，或 GitHub 的 `kanripo` 組織），
   例如 廣雅＝`KR1j0008`、釋名＝`KR1j0007`、方言＝`KR1j0006`、玉篇＝`KR1j0022`、毛詩＝`KR1c0001`、左傳＝`KR1e0001`。
2. `https://codeload.github.com/kanripo/KR1j0006/zip/refs/heads/master` 下載、解壓到 `D:\2026\swjzz\src\`。
3. 在 `swjzzsrc2adb.ts` 主流程加一行（`emitSentences` 適合一句一條的詩文，`emitGuangyun` 適合一行一條的類書／韻書），
   並在 `emitAbout()` 的說明文字補一行來源。
4. 重跑 §3 的兩步與驗收，把 `.adb` 覆蓋到 `accelon3\swjzzsrc.adb`（比對 SHA-256）。

`emitSentences` 的 `headRe` 抓的是篇名（第 1 個括號裡的文字），`ordered: true` 會擋掉卷首重複的目次。

## 5. 已知限制

* **廣韻沒有拆小韻。** 四庫本轉錄是連續行，小韻首字與反切夾在行內（`(苦紅切十四)空(空虚…)`），
  這裡只做到「一卷一條」，沒有把每個小韻切成節點。要拆得另寫一層（`○` 分隔＋括號內的反切）。
* **爾雅篇序是重排過的。** 明鈔本轉錄的篇名順序亂（釋言、釋鳥的標題晚好幾卷才出現），
  轉換器先按「最近篇名」歸條，再照爾雅固定篇序輸出；若某條恰好跨在篇名之間，可能歸錯篇。
* **缺字**：Kanripo 的 `&KRxxxx;` 一律寫成「□」，沒有回填 Unicode。
* **沒有校勘**：這是拿來查引用出處的語料，不是定本；要引用請回原書。
* `說文解字` 用大徐本（shuowen.org），與段注本（`swjzz.adb`）用字不同是正常的——`swjzz` 的 `<說文異>` 就是標這個差異。
