# lc.adb 製作步驟（CBETA LC → Accelon3）

`lc.adb` 是《呂澂佛學著作集》的 Accelon26 版，來源是 **CBETA 官方 LC 部 XML**
（`cbeta-org/xml-p5/LC`），再由 `backlink.ts` 把書中的經論引文接回 `taisho.adb`。

| 項目 | 值 |
|---|---|
| 檔名／`dbname` | `lc.adb` / `lc` |
| 顯示名 | 呂澂佛學著作集 |
| 來源 | CBETA TEI P5，`LC01n0001.xml` … `LC08n0007.xml`（8 檔） |
| 收錄 | 8 書、127 卷、46,145 行、3,058 頁、8,505 段 |
| 標題 | 522 個（章／節／項，依 `cb:mulu level`） |
| 大正鏈結 | **1,119 個 `<聯>`（861 筆引文、551 個大正頁、155 部書）** |
| 字元範圍 `j` | **1,119/1,119**（2026-10-28 補；含 36 條前後頁對位） |
| 封面 | `logo/lc_logo.png`（320×480，234,606 B） |
| 檔案 | 約 3.9 MiB，`dbtype 0`，`andtagid 0` |

---

## 0. 前置需求

- Go（`go run`）、Bun、PowerShell
- CBETA LC 的 sparse clone：`D:\2026\xml-p5\LC`
- 大正藏：`accelon3/taisho.adb`（85 冊版）
- 工作目錄一律 `D:\2026\adb-converter`

```powershell
cd D:\2026\xml-p5
git sparse-checkout add LC
```

> 2026-10 實測 GitHub 直連會斷，指令要加
> `git -c http.proxy=socks5h://127.0.0.1:1080 sparse-checkout add LC`；
> 只壞在拉 blob 時，也可以直接用 raw.githubusercontent 抓 8 個 XML 到 `LC\LC0N\`。

---

## 1. 轉換：`cmd/lc2adb`

```powershell
go run ./cmd/lc2adb -src D:\2026\xml-p5\LC `
  -out build\lc-text.txt -lbs build\lc.lbs.tsv
```

輸出：`build/lc-text.txt`（一行一個 `<lb>` 行）、`build/lc.lbs.tsv`（冊／行號／lb 對照）。

### 1.1 標記對照

| TEI | lc 文字 |
|---|---|
| `<body>` 開始 | `<檔 n="LC01n0001.xml">` |
| `title level="m"` | `<書 l="目次" t="章,節,項." id="N">印度佛學源流略講</書>` |
| `<milestone unit="juan" n="N"/>` | `<卷 n="N">N</卷>` |
| `<pb n="a001a"/>` | `<頁 id="1pa001a"/>`（冊號＋`p`＋原書頁欄） |
| `<lb/>` | 換行（一行一個 lb） |
| `<p>` | `<段/>` |
| `<head>` ＋ 前面的 `<cb:mulu level="1|2|3">` | `<章 t="節,項." u="文">`／`<節 t="項." u="文">`／`<項 u="文">` |
| `<note place="inline">` | 留在原位，寫成「（…）」 |
| `<app><lem>` | 只留底本文字；`<rdg>` 丟棄 |
| `<g ref="#CB…">字</g>` | 保留裡面的字（不要整段跳過） |
| `<anchor>`／`<cb:juan>`／`<jhead>` | 丟棄 |
| `<back>`（校注附錄） | 整段不收 |

### 1.2 檔頭

```text
<檔 n="lc.xml"><集 l="圖集,註釋群,編目資訊">呂澂佛學著作集</集>
<隱><樹 s="*" t="書" pf1="$書.id;.">目錄</樹>
<樹 s="*u=文" pf="$頁.id;)">頻次</樹><樹 s="~00602000">西文</樹></隱>
<隱><引>《$書;》：「$_;」( LC $*頁; )</引><摘要頭>$書;($頁;)</摘要頭>
<參考資料 n="taisho,wxzj"/></隱>
<英文名>Corpus of Lü Cheng's Buddhist Studies</英文名></檔>
```

`書` 宣告 `t="章,節,項."`、`章` 宣告 `t="節,項."`、`節` 宣告 `t="項."`；沒有 `t=`
的節點在左欄展不開。`u="文"` 供「頻次」樹（`s="*u=文"`）使用。

LC 有 522 個 `<cb:mulu>`，其中 30 個**沒有配對的 `<head>`**（如「前言」「經典簡介」
「先序四義」，以及《新編漢文大藏經目錄》的「經疏」「律疏」等分類）。轉換器先把
mulu 文字緩衝：下一個元素是 `<head>` 就丟掉（目次副本），否則自己輸出成標題。
所以標題數是 522，不是 492。

### 1.3 預期數字

```text
lines=46145 卷=127 書=8 標題=522 段=8505 註=2735 頁=3058
最長行=270 字（上限 4,096 字，安全）
```

---

## 2. 先打包底本

`backlink.ts` 需要一顆沒有 `<聯>` 的來源 adb：

```powershell
bun run lc/pack.ts build/lc-base.adb --base
```

`--base` 強制讀 `build/lc-text.txt`，不會誤讀上一次的 `lc-linked.txt`。

---

## 3. 大正鏈結：`backlink.ts`

```powershell
bun run ts/tools/backlink.ts --src build/lc-base.adb --slug lc --dbname lc `
  --taisho accelon3/taisho.adb `
  --cues "經云：,論曰：,論云：,曰：,云：,說：,：「,：『,頌曰：,文云：,又云：,所謂「,「" `
  --no-pack
```

- cue 的用法見 `backlink-skill.md`。
- 最後一個 `「` 是**泛用引號**：抽所有 8 個漢字以上的引文（含術語以外的長句）。
  沒有它，只抽得到 1,037 筆；加了之後 1,826 筆，命中從 503 增到 861。
- 呂澂常把引文放在「……說：」「……云：」「……曰：」之後；`說：`／`云：`／`曰：`
  會連同「經云：」「論曰：」「又云：」等一起命中（cue 是字串比對，較長的 cue 先抽、
  同一位置去重）。
- `--no-pack`：只寫 `build/lc-linked.txt`、`lc-quotes.json`、`lc-matches.json`，
  打包交給下一步以順便換 logo。

### 3.1 預期結果

```text
抽出 1826 筆引文
大正藏命中 861/1826
套用 861 筆（重疊 70）→ 1119 個錨點
```

- 551 個不同的大正頁、155 部書。
- 命中最多：辯中邊論 72、出三藏記集 44、因明入正理論 41、大乘莊嚴經論 39、
  因明入正理論疏 37、菩提資糧論 33、解脫道論 28、妙法蓮華經 27、大般涅槃經 25。
- 其餘多為呂澂的轉述、比對或改寫（例如「諸法不完全是剎那滅，有些法是暫住的」），
  對不上就放掉，不硬連。

---

## 4. 打包：`lc/pack.ts`

```powershell
bun run lc/pack.ts
```

- 讀 `build/lc-linked.txt`，`authorAdb`（`dbtype 0`）重建全部索引
- 資源：`logo/lc_logo.png`（資源名 `lc_logo.png`）
- 打包前檢查每行 ≤ 4,096 字（`MAXLINELEN`）
- 檔頭 `andtagid` 設回 0
- 輸出 `build/lc.adb`，並原子替換 `D:\accelon3\lc.adb`
- 交付規則（2026-10-28 作者指示）：**最終 adb 一定要在 `accelon3\lc.adb`**，
  作者才能用 Accelon26 就地測試；只留在 `build\` 不算完成。`lc/pack.ts` 會自動
  複製並比對兩邊 SHA-256，不同就報錯。

預期：`dbname lc`、`linecount 46145`、`tagcount 15144`、`resources 1`、約 3.9 MiB。

---

## 5. 驗證

```powershell
bun run lc/validate.ts
go run ./cmd/abx inspect build\lc.adb
bun run ts/tools/probe-adb.ts --adb build/lc.adb --query 涅槃
bun run lc/test-ui.ts
```

2026-10-28 實測：

```text
lines 46145 46145
text same true
dbname lc -> lc andtagid 0 -> 0
tags 27 -> 29
頁.id 3058 3058 same
caches keys 3 3 same
anchors 1119 checked 1119 missPage 0 qBad 0
unbalanced lines 0
nested 0
```

實機（`lc/test-ui.ts`）：搜「觀察義禪」→ 中間欄點 `<聯>` → 右欄到
`taisho 49p586c`，塗紅 1 處；大正頁上方的回連結列出 2 條呂澂
（《中國佛學源流略講》332a、540a）。

---

## 6. 一鍵重建

```powershell
pwsh D:\2026\adb-converter\lc\build.ps1
```

流程：`lc2adb` → `pack --base` → `backlink --no-pack` → `pack` → `validate`。
四步也可單獨跑（除錯時常用）。

---

## 7. 坑

1. **頁 id 會撞**：8 個檔的 `pb n` 都從 `a001a` 起算；一定要加冊號
   （`1pa001a`…`8pa001a`），否則 `頁.id` 重複，跳頁與回連結都會錯。
2. **`<cb:mulu>` 有時在 `<head>` 裡面**（anchor 之後），層級要在 `</head>` 才拿得到；
   轉換器先把 head 文字緩衝，收尾再決定 `<章>`／`<節>`／`<項>`。
3. **`<jhead>` 不是正文標題**：LC01／LC02 的「呂澂佛學論著選集卷四」只是來源版本題，
   當成章會多出一個假節點；`lc2adb` 直接跳過。
4. **行內註不要獨立成行**：LC 正文 2,735 個 `<note place="inline">` 都是行內小註，
   用「（…）」留在原位；若照 ys 的 `〔註n〕` 會把句子切斷。
5. **`<back>` 是校注附錄**：`</body>` 之後的 `CBETA 校注`／`呂澂佛學著作集 校注`
   目前不入庫（約 4,700 條），免得把校勘文字混進正文。
6. **全角空格**：`第一講　原始佛學` 的 U+3000 是標題的一部分，不要用
   `strings.Fields` 收成半角空格。
7. **logo 太大**：原圖 1664×2496、3.2 MB；縮成 320×480 後 234 KB，
   與 `ys_logo.png`／`taisho_logo.png` 同尺寸。原圖留在 `build/lc-logo-original.png`。
8. **cue 太泛會誤連**：`：「` 會抽到非佛典的引文（傳記、序跋），但只有在大正藏
   找到同文才會套用；寧可少連，不要為了數量放寬到 4 字。
9. **每個 `<檔>` 要從新行開始**：上一個檔最後一行不一定有 `<lb>`；直接寫下一個
   `<檔>` 會把檔頭接在正文尾巴。`lc2adb` 在寫檔頭前先 `ensureLine()`，8 個檔界
   各自獨立。

---

## 8. 產物清單

| 檔案 | 說明 |
|---|---|
| `cmd/lc2adb/main.go` | CBETA LC TEI → adb 文字 |
| `lc/pack.ts` | 打包（含 logo、行長檢查、andtagid） |
| `lc/validate.ts` | 文字／頁碼／caches／錨點驗收 |
| `lc/test-ui.ts` | 實機點連結＋回連結測試 |
| `lc/build.ps1` | 一鍵重建 |
| `build/lc-text.txt` | 轉換輸出（46,145 行） |
| `build/lc-base.adb` | 未加 `<聯>` 的底本 |
| `build/lc-linked.txt` | 套好 `<聯>` 的文字 |
| `build/lc.adb` | 最終資料庫 |
| `D:\accelon3\lc.adb` | 部署位置 |
| `logo/lc_logo.png` | 封面（320×480） |
| `build/lc-logo-original.png` | 原始封面（1664×2496，不進版控） |
| `D:\2026\xml-p5\LC` | CBETA LC 來源 |

