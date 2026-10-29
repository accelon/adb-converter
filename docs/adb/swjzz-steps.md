# swjzz.adb（說文解字注，kanji-database 版）產生步驟

> 目的：把 [説文解字注データ](https://kanji-database.sourceforge.net/dict/swjz/index.html)（`swjz.xml`，
> 經韵樓臧版影印本轉錄，GPL）轉成 accelon3／accelon26 可讀的 `swjzz.adb`。
>
> 名字用 `swjzz`（多一個 z＝「注」）是為了跟 Delphi 時代的舊庫 `swjz.adb` 分開：
> 舊庫正文也是《說文解字注》，但 schema 是 2006 年的（`粗`／`duan_note`／`chaptertitle`），
> 沒有 `$字` 名稱表，也沒有「詞典」查詢要用的 `caches/字`。舊庫原封不動留著。

## 0. 成品（2026-10-28，第二版）

| 項目 | 數值 |
|---|---|
| 檔案 | `accelon3\swjzz.adb`，5,350,410 bytes（5.10 MiB） |
| SHA-256 | `caa4c711a83374bde30415240f85e929ed61bc614c155e67f4913d5db13bde06` |
| 行 | 60,754（一行＝一個 adb 行） |
| 內文 | 2,187,949 字（含標記；純文字 1,330,606 字），260 個 16 KiB 來源區塊 |
| tokens | 15,601 種／1,255,748 筆命中 |
| 標記 | 41 個（21 個開標籤），tag 命中 123,854 |
| 卷 | 35（31 卷正文 ＋ 4 篇序） |
| 部 | 542（540 部；水部跨「十一篇上之一／之二」兩卷，各有一個實例） |
| 部目 | 540（第十五卷的 540 部首目錄） |
| 節 | 14（部目的十四個分段） |
| 字頭 | **10,706** 條（`<字 id img>`，`caches/字` 同長） |
| 說文 | 24,323 條 → `<說文>` 16,824 條（其中 1,112 條大徐本沒有這個字頭，無從核對）、`<說文異>` 7,499 條 |
| 段注 | 23,934 條 |
| 篆／注／構形 | 185／130／863 |
| 檔頭 | `dbname=swjzz`、`dbcname=說文解字注`、`dbtype=2`（DICTIONARY）、`srcBlockSize=16384`、`andtagid=0`（沒有 `<頁>`） |

> 第二版只多做一件事：拿**大徐本《說文解字》**（shuowen.org 開放資料，一字一 JSON）逐條核對
> 段注本的說文片段——核得到的是 `<說文>`，核不到的是 **`<說文異>`**（段玉裁改字、或用古字）。
> 段注文本身照樣是 `<段注>`，三種標記可以各自設樣式。引用書目另見 `swjzzsrc.adb`。

## 1. 來源

| 用途 | 路徑 |
|---|---|
| 正文 | `swjz.xml`（6,219,586 bytes，sha256 `a3705e25dca84304069b35c4eecf97f486f1a2dacc7489375c8a4a6b4e3c8c4a`） |
| 取得 | `https://fastly.jsdelivr.net/gh/cjkvi/cjkvi-dict@master/swjz.xml`（GitHub raw 在本地被重置，jsDelivr 鏡像可用） |
| schema | `swjz.rnc`（同 repo；本轉換器的標記對照就是照它） |
| 標題頁 | https://kanji-database.sourceforge.net/dict/swjz/index.html |

原檔的結構（`swjz.rnc`）：

```text
book/@title
  volumes
    preface            prefacetitle ＋ content（王念孫序）
    catalogs           volume_num ＋ chaptertitle/@href（分卷目錄，轉換時丟棄）
    chapter ×31        chaptertitle(id= v01…v28, v15a/v15b, v29, v30)、author、
                       (shuowen+ , part_wordnum?)+ 、volume_wordnum? 、endchapter
                       第十五卷（v29／v30）換成 shuowen2（敘文 ＋ section/part_word）
    preface            prefacetitle ＋ content ×3（後敘、跋、說文解字讀序）
```

`shuowen` 是 `(wordhead, text_note2?)+`——**一個 `<shuowen>` 可以有好幾個字頭**（例如「一」與
「弌」同一個 shuowen）。這是第一個坑：只取 `shuowen` 的第一個 `wordhead` 會少掉 1,280 條
（9,426 個 shuowen 裡有 1,088 個帶 2 個以上字頭，最多 6 個）。

## 2. 標記對照

| swjz.xml | swjzz.adb | 備註 |
|---|---|---|
| `book/@title` | `dbcname` | 打包時給 |
| `preface/prefacetitle` | `<卷 n="序N" id="pNN">序名</卷>` | 4 篇（前序、後敘、跋、讀序），內容行照原文 |
| `catalogs` | 丟棄 | 目錄樹改由 `<卷 t>` 宣告 |
| `chapter/chaptertitle` | `<卷 n="01" id="v01" t="部,字.">說文解字第一篇上</卷>` | 篇號取 `id`（`v15a`→`15a`）；`duan_note` 只有「上／下」這種兩三字才併進標題 |
| `chaptertitle/duan_note`（長） | `<段注>` 一行 | 章首那段考證（v29 開頭） |
| `chapter/author` | `<作者>` | 校字者 |
| `shuowen` 開頭的第一個 `wordhead` | `<部 t="字.">X部</部>` | 部的名字＝該部**第一個字頭**＋「部」 |
| `shuowen/wordhead` | `<字 id="w0010010" img="001a-01">一</字>` | `id`／`img` 原樣留著（`img` 指向原書頁面影像，本庫不含圖） |
| `shuowen/explanation` | `<說文>` | 許氏原文（原書大字） |
| `shuowen/duan_note` | `<段注>` | 段玉裁注（原書小字） |
| `duan_note/note` | `<注>` | 段注裡的小注 |
| `seal_script` | `<篆>` | 篆文／聲符的字形標記 |
| `part_wordnum` | `<部數>文五　　重一</部數>` | 一部之末的「文N　重N」 |
| `volume_wordnum` | `<卷數>` | 一卷之末的統計 |
| `endchapter` | `<篇末>` | 篇末題 |
| `addenda/addenda_title` | `<補遺>補漆注。</補遺>` ＋ `<說文>`／`<段注>` | 3 處 |
| `publishdate` | `<出版>` | 嘉慶二十年… |
| `shuowen2` 的 `explanation`／`duan_note` | 直接給 `<說文>`／`<段注>` | 第十五卷的敘文 |
| `section/section_num` | `<節 t="部目.">說文解字第一</節>` | 540 部目的十四段 |
| `section/part_word` | `<部目 n="1">一</部目>` | `n`＝部序（原文「部一」） |
| `<!--⿰氵㫄-->` | `<構形>⿰氵㫄</構形>` | UCS 沒有的字，原檔用 XML 註解記 IDS |

檔頭三行（決定左欄有哪些分頁、詞典要不要查它）：

```text
<檔 n="swjz.xml">
<集 c="isdict" l="說文,段注,篆,注,構形,部數,卷數,篇末,補遺,作者,出版">說文解字注</集>
<隱><樹 s="*" t="卷">目錄</樹><樹 s="$字">字頭</樹><樹 s="*字">全文</樹></隱>
```

* `c="isdict"`：設定頁「只列出 c=isdict」與詞典查詢都看這個標記。
* `s="*" t="卷"`：目錄樹第一層是 `<卷>`，往下的層級由每個實例自己的 `t=` 決定
  （`<卷 t="部,字.">` → 部 → 字；`<卷 t="節,部目.">` → 節 → 部目；序那幾卷沒有 `t=`，是葉節點）。
* `s="$字"`：名詞分頁的字頭表，名稱直接來自 `caches/字`。
* `s="*字"`：全文分頁，按 `<字>` 分段統計命中。

## 3. 指令

```powershell
# 0) 大徐本《說文解字》參考表（比對與 swjzzsrc 共用；shuowen.org 的 data/*.json）
bun run ts/tools/shiwen-ref.ts D:\2026\swjzz\src\shuowen-master\data D:\2026\swjzz\build\shiwen-ref.json

# 1) swjz.xml → 一行一個 adb 行（會印出各標記數量，未知元素與長行都會警告）
bun run ts/tools/swjz2adb.ts D:\2026\swjzz\swjz.xml D:\2026\swjzz\build\swjz.txt --ref D:\2026\swjzz\build\shiwen-ref.json

# 2) 打包（validTags／cachedTags 都寫在腳本裡；行長 >4,096 字會直接拒打包）
bun run ts/tools/swjz-pack.ts D:\2026\swjzz\build\swjz.txt D:\2026\swjzz\build\swjzz.adb

# 3) 驗收
go run ./cmd/abx inspect D:\2026\swjzz\build\swjzz.adb
bun run ts/tools/probe-adb.ts --adb D:\2026\swjzz\build\swjzz.adb --query 天     # 開庫、目錄、檢索
bun run ts/tools/probe-swjzz.ts                                                 # 三層目錄、字頭表、正文（PASS 才算過）

# 4) 交付（檔名＝dbname）
Copy-Item D:\2026\swjzz\build\swjzz.adb D:\2026\adb-converter\accelon3\swjzz.adb
Get-FileHash D:\2026\swjzz\build\swjzz.adb, D:\2026\adb-converter\accelon3\swjzz.adb -Algorithm SHA256
```

`swjz-pack.ts` 的三個關鍵參數：

| 參數 | 值 | 漏了會怎樣 |
|---|---|---|
| `dbtype` | `2`（DICTIONARY） | 右欄「詞典」不認這個庫 |
| `cachedTags` | `字 部 卷 節 部目` | 沒有 `caches/字` 就沒有字頭名稱表，點字查詞、名詞分頁、二分搜尋全部失效 |
| `validTags` | 轉換器會產生的 21 個標記（含 `說文異`） | 漏一個就靜默少一批 tag hit（`abx inspect` 的 `tagcount` 會對不上） |

## 4. 說文／說文異是怎麼判的

`shiwen-ref.json` 是「字頭 → 大徐本說文本文」，比對前兩邊都先正規化：

1. 去掉 accelon 標記與所有標點（段注本用「。」、大徐本用「，」，不去標點幾乎每條都對不上）。
2. 把段玉裁慣用的古字歸一到通行字（`㠯→以`、`朙→明`、`內→内`、`尙→尚`…，見 `ts/src/swjz-ref.ts` 的
   `GLYPH_VARIANTS`）。**不會**歸一 大／太 這種會改變文意的字——那正是要標出來的段改。

判準：正規化後，片段如果是大徐本同字條目的子字串 → `<說文>`；不是 → `<說文異>`。
字頭在大徐本裡找不到（異體字、缺字，1,112 條）→ 一律 `<說文>`（無從判斷）。

結果：`<說文>` 16,824（含 1,112 條無參考）、`<說文異>` 7,499。抽樣看，`說文異` 有真的段改
（一：大徐「惟初太始」→段「惟初大極」；福：大徐「祐也」→段「備也」；神：大徐「从示、申」→段「从示。申聲。」），
也有純用字差異（說文異裡約六成是 ≤2 字的差異）。

## 5. 五個踩過的坑

1. **`shuowen` 可以有多個 `wordhead`。** 1,280 個 shuowen 帶 2 個以上字頭（一／弌、元／…），
   要逐個 `wordhead` 開新的 `<字>`，不能只取第一個。
2. **部界是 `part_wordnum` 的「後一個」字頭。** `part_wordnum` 是某一部的結尾統計，
   它後面的第一個 `wordhead` 才是下一部的部首——所以部標籤要「遇到新字頭时才開」。
3. **水部橫跨兩卷。** 「十一篇上之一」整卷只有水部，卷末沒有 `part_wordnum`，
   「之二」開頭仍是水部。轉換器會把部首名帶到下一卷（`carryPart`），
   兩卷各有一個 `<部>水部</部>`，不然「之二」的字頭會掛不到任何部下。
4. **`chaptertitle` 的 `duan_note` 有兩種。** 一種是「上／下」（併進標題），
   一種是整段考證（第十五卷開頭），後者要另外給一行 `<段注>`；混在一起會讓標題長到 100 字。
5. **U+FFFD。** 原檔有 1 個字頭是 U+FFFD（`w4230012`，`img="575a-03"`，只有原書影像有那個字），
   照原樣保留；另有 12 個字頭原文就是 `（图164A-01）` 這種「只有圖」的佔位，也照原樣保留。

## 6. 驗收（2026-10-28 第二版）

```text
abx inspect
  dbname swjzz  dbcname 說文解字注  dbtype 2 (dictionary: true)
  linecount 60754  tagcount 123854  maxblockoffset 1752020  srcblocksize 16384
  outer: source tokens tags tables attributes attributes.sorted caches（無 resources）

容器的資料面
  tags/字 10,706 ＝ caches/字 10,706（詞典二分搜尋靠這個相等）
  tags: 說文 16,824／說文異 7,499／段注 23,934／篆 185／注 130／構形 863
  attributes: 字.id 10,706、字.img 10,706、卷.id 35、卷.n 35、部目.n 540

閱讀器（build\accelon26.html，Edge headless，file:// 載入）
  目錄　 卷 35 列 → 展開「說文解字第一篇上」→ 部（一部、𠄞部、示部…）→ 字（一、弌、元…）✓
  名詞　 字頭表 10,706 條；輸入「江」→ 1 條 ✓
  全文　 s="*字" 分頁存在 ✓
  本文　 點「天」→ 條文（說文＋段注）正常，無殘留標記 ✓
  consoleErrors: null
```

> 詞典分頁（點字查詞條）在 21:5x 的無痕實測有查到「天《說文解字注》」並渲染條文；
> 之後幾次 headless 重跑時好時壞（`dictList` 空的、提示停在「目前沒有詞典型 adb」），
> 但資料面的前提（`caches/字` 與 `tags/字` 同長、`集 c="isdict"`、`樹 s="$字"`）每次都成立，
> 所以 `probe-swjzz.ts` 把它降成 WARN。要確認就手動開 Accelon26 點字看看。

## 7. 引書統計

`ts/tools/swjzz-cites.ts` 掃段注輸出 [swjzz-citations.md](./swjzz-citations.md)：23,934 條段注、
「X曰」第一名是 **廣韵曰 255**，其次 毛傳 240、方言 238、釋名 196、鄭玄 179、左傳 128、廣雅 121、
玉篇 117、釋詁 116、顏師古 100。引用書目庫見 [swjzzsrc-steps.md](./swjzzsrc-steps.md)。

## 8. 已知限制／之後可做

* **沒有圖片資源。** 原檔的 `wordhead@img`（如 `001a-01`）指向 kanji-database 發行包裡的頁面影像，
  本庫只保留屬性、不含 `resources`（所以也沒有 logo）。要放圖就照 `D:\2026\ys\pack.ts` 的作法加 `logo\swjzz_logo.png`。
* **說文／說文異／段注在閱讀器裡同一個樣式。** 版面靠標記而非字級：要分辨三層，
  可在「設置 → 標籤樣式 → 此資料庫」把 `段注` 調成 90% 大小／次要色、`說文異` 給另一個顏色。
* **`說文異` 不是「段改」清單。** 判準只是「這一段在大徐本同字條目裡找不到」，
  其中約六成是 1–2 字的用字差異；要判斷段玉裁到底改了什麼，還是得一條一條看注。
* **15 個字頭是「只有圖」的**（`（图164A-01）` 這類，另有 1 個 U+FFFD），出現在字頭表裡是原文的樣子。
* 舊庫 `swjz.adb`（Delphi 時代，5.2 MiB）沒有動；它的 `<字>` 有 11,246 筆是因為把 540 個部目也算成字頭，
  本庫把部目獨立成 `<部目>`，所以是 10,706。

