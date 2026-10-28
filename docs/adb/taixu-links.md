# tx.adb：太虛全書引用的經文 → 大正藏

> 目的：讀太虛大師全書時，書中引用的經文可以點一下跳到 `taisho.adb` 的對應頁；
> 反過來讀大正藏時，右欄「回連結（太虛大師全書）」可以回到太虛引用的那一頁。
>
> 成品：`accelon3/tx.adb`（dbname `tx`；原檔備份 `build/taixu-original.adb`）。
> 與舊版 `taixu.adb` 的差異見 [`tx.md`](./tx.md)。

## 0. 成品數據（2026-10-28）

| 項目 | 數值 |
|---|---|
| 檔案 | 21,685,303 bytes（原 20,475,406） |
| 檔頭 | `dbname=tx`、`dbcname=太虛大師全書` |
| 文字 | 214,956 行（未變） |
| 引文候選 | 3,796 筆（四種明確 cue 283 筆＋泛用「：『」3,513 筆） |
| 成功連上 | 2,450 筆（64.5%） |
| `<聯>` 錨點 | 4,484 個（引文跨行時每行一個錨點） |
| 目標頁 | 1,204 頁（大正藏） |
| `聯.i` / `聯.q` / `聯.j` | 4,484 / 4,484 / 4,337 |
| logo | `tx_logo.png`（320,214 B，來自 `logo/tx_logo.png`） |

命中率（依 cue）：

| cue | 命中／候選 |
|---|---|
| 經曰： | 8 / 21 |
| 經上說： | 3 / 10 |
| 經云： | 128 / 244 |
| 法華云：『 | 6 / 8 |
| ：『（泛用） | 2,305 / 3,513 |

## 1. 標記格式

```xml
楞嚴經云：「<聯 i="taisho?19p131c" q="自未得度，先度人者，菩薩發心。" j="61-73">自未得度先度人者，菩薩</聯>
發心」。
```

* `i="taisho?頁碼"`：頁碼沿用大正藏 adb 的 `<頁 id>`（`NpMc`：冊＋頁＋欄），
  和 `yinshun.adb`／`ys.adb` 的跨庫錨點同一個格式。
* `q="…"`：大正藏那一頁的原文（最多 160 字），給回連結把按鈕嵌到被引用的那一行、
  以及在小視窗裡比對用；內容不含標記。
* `j="起-訖"`：可選，**字級範圍**。數字是目標頁「可見漢字」的索引（0 起算、end 不含），
  和 accelon26 `renderForeign` 的 `lineHtml()` 同一種算法。有 `j` 必有 `i`，
  `j` 不再重複 `taisho?`；舊 accelon3 忽略它。對不上 `q` 時 accelon26 會退回文字比對。
* `聯` 是 **skip tag**（不佔 VA），所以插入後頁碼不變；頁 id（`attributes/頁.id`）
  16,441 筆與原檔一字不差。整個索引重算後 `tables/lines.virtual` 會與原檔有
  小位移（最多 52 個 VA；Delphi 版對少數自閉合標記的計法不同），頁的定位一律走
  新的 `attributes/頁.id → tags/頁` 指標，所以不受影響。
* 引文跨行時，每一行各自開／關一個同目標的 `<聯>`（和 `ys.adb` 的做法一致），
  不讓 `<聯>` 包住別的標記。

## 2. 流程

```bat
:: 從「原始」taixu.adb 重建公開版 tx.adb（dbname tx、換上新 logo）
bun run ts/tools/backlink.ts --src build/taixu-original.adb --reuse ^
  --dbname tx --logo logo/tx_logo.png --out build/tx.adb

:: 只處理四種明確 cue（不碰泛用「：『」）
bun run ts/tools/backlink.ts --src build/taixu-original.adb --explicit --dbname tx --logo logo/tx_logo.png --out build/tx.adb

:: 重跑搜尋（不用 --reuse）：重新抽引文、查大正藏，約 30 秒＋打包 90 秒
bun run ts/tools/backlink.ts --src build/taixu-original.adb --dbname tx --logo logo/tx_logo.png --out build/tx.adb

:: 換掉正式檔
copy build\tx.adb accelon3\tx.adb
```

四個階段都在 `ts/tools/backlink.ts` 裡：

1. **解出 accelon3 標記**：用 `src/adbtext.ts` 讀 `source`，一行一個 pcl 行（含標記）。
2. **抽引文**：找「經曰：」「經上說：」「經云：」「法華云：『」與泛用「：『」，
   取引號內文字；沒有引號的（例如「經云：人人皆可成佛」）收到句末標點為止。
   記錄每一段的（行、起訖字元），跨行時分段記錄。
3. **去大正藏搜尋**（近似查詢）：
   * 引文只留漢字，**切成單字**，用 `taisho.adb` 的 `tokens` posting 取每個字的 VA；
   * 挑 posting 最短的字當錨點，逐一檢查其他字是否落在錨點前後 20 個 VA 內
     （`MAXGAP=20`，容許標點與 `<頁>` 標記造成的位移），得到候選 VA；
   * 候選 VA 附近取原文（`VaPaMapper.context`），用引文前 24 字做前綴比對，
     容許異體字（`variants.ts` 的分組正規化）與中間少數字差異；
   * 引文前面 30 字與大正 `書` 標題的最長共同子串 ≥2 時，優先挑那一部（避免
     先命中後代註疏）；同分再挑 VA 較早（經部在註疏之前）的候選。
   * 接受門檻：8 字以上連續吻合（引文 ≤8 字時容許少一字）；只包到實際吻合的
     那段，引文後面的虛詞／差異不強求。
4. **套回原文並重新打包**：`ts/src/adbauthor.ts` 重建 source/tokens/tags/tables/
   attributes/attributes.sorted/caches，`resources`（678 個圖檔）與 `caches` 的
   37 個鍵全部沿用原檔；`dbcname`、`dbtype`、`srcBlockSize` 也照舊。`--dbname tx`
   把檔頭改成 `tx`（閱讀器靠它找來源庫），`--logo` 把 `taixu_logo.png` 換成
   `tx_logo.png`。原檔的 `平裝`／`精裝` 是「自閉合卻有 close hit」的舊 docdef 寫法，
   重建時由 `--src` 的 tag 表自動辨認（`dualSelfClosingTags`），所以 `tags` 120 種、
   `andtagid=18` 與原檔一致。

## 3. 驗收

* **頁碼**：2,450 筆命中的 `taisho?頁碼` 全部存在於 `taisho.adb` 的 `頁.id`；
  每筆 `q` 的前 8 個漢字都真的出現在那一頁（`build/tmp-taixu-validate.ts`）。
* **文字不變**：把新舊 `taixu-text.txt` 的所有標記去掉後逐字相同。
* **結構**：`caches` 37 個鍵的長度與內容與原檔**完全相同**（含 `集`、`節` 697、
  `項` 675、`章` 1,441…）；`頁.id` 16,441 筆順序相同；`resources` 678 筆（只換
  logo）；`tags` 120 種、`andtagid=18` 都與原檔相同（`平裝`／`精裝` 這種「自閉合
  但仍有 close hit」的舊 docdef 寫法也照原樣重建）；`lines.virtual` 重算，與原檔
  最多差 52 個 VA（見 §1）。
* **標記**：每行 `<聯>` 開關數平衡（3 個原本的 `<聯 l=…>` 除外）、沒有巢狀 `<聯>`。
* **字級範圍**：4,337 個 `聯.j` 逐個對回目標頁的漢字，切片必須等於 `q` 的前幾個字
  （0 bad／0 超出頁面）；其餘沒有 `j` 的錨點由閱讀器用 `q` 比對。
* **實機**：`build/accelon26.html` 載入 `tx.adb`＋`taisho.adb` 後，
  中間點聯 → 右欄顯示大正藏該頁並只塗 `j` 那一段；
  右欄「回連結（太虛大師全書）」→ 中間回到太虛那一頁
  （見 `build/tx-j.png`、`build/shared-xref-demo.png`、`build/tx-logo.png`）。

## 4. 已知限制

1. **只連「找得到」的引文**：太虛常憑記憶引用或改寫（例如「阿陀那識甚深細，
   習氣種子如瀑流」與《解深密經》的「一切種子」不同），這類引文目前不連。
2. **同一段文字見於多處**時只連一處：優先引文前文提到的經名，其次較早的冊頁；
   同一個句子在別處（例如註疏）也出現時，不會重複標。
3. `q` 只存前 160 字；很長的引文只連到實際吻合的前段（最多 80 字）。
4. 「：『」是泛用規則，包含禪宗語錄、古德法語等；只要大正藏裡有同一段文字就連，
   不保證是「經」。

## 5. 與印順的書一起看（多 adb 反鏈）

同時開 `tx.adb`、`ys.adb`、`taisho.adb`，點太虛文中《金剛經》的引文 → 右欄開大正
`8p749b`，「回連結」那一排會同時列出兩個庫：

> 回連結（印順法師佛學著作集、太虛大師全書）：成佛註 387a、中觀 162a、性空 255a、
> 太虛大師全書 251、32、38…（共 39 條，先顯示 10 條，按「＋29」再放）

截圖：`build/shared-xref-demo.png`。兩庫共引 **224 頁、54 部經**，完整清單見
[shared-xref-tx-ys.md](./shared-xref-tx-ys.md)；重新產生：

```bat
bun run ts/tools/xref-shared.ts accelon3/tx.adb accelon3/ys.adb --book 金剛 --md shared-xref-tx-ys.md
```

共同頁數最多的幾部：

| 共同頁 | 太虛連結 | 印順連結 | 書名 |
|---:|---:|---:|---|
| 36 | 154 | 258 | 妙法蓮華經 |
| 23 | 170 | 128 | 維摩詰所說經 |
| 21 | 124 | 230 | 楞伽阿跋多羅寶經 |
| 16 | 39 | 170 | 中論 |
| 14 | 71 | 46 | 成唯識論 |
| 13 | 42 | 164 | 大乘起信論 |
| 11 | 113 | 82 | 金剛般若波羅蜜經 |
| 9 | 85 | 45 | 大佛頂如來密因修證了義諸菩薩萬行首楞嚴經 |
| 7 | 16 | 37 | 景德傳燈錄 |
| 4 | 15 | 40 | 六祖大師法寶壇經 |

## 6. 檔案

| 檔案 | 說明 |
|---|---|
| `ts/tools/backlink.ts` | 四階段工具（解出／抽引文／搜尋／套用＋打包；`--dbname`／`--logo`） |
| `ts/tools/xref-shared.ts` | 找多個 adb 共同引用的大正經典與頁（多庫反鏈用） |
| `shared-xref-tx-ys.md` | 太虛＋印順共同引用的 54 部經、224 頁清單（產生檔） |
| `tx.md` | `tx.adb` 與舊版 `taixu.adb` 的差異（公開版說明頁 `www/adb/tx.html` 由此產生） |
| `build/taixu-text.txt` | 解出的 accelon3 標記文字（中間產物） |
| `build/taixu-quotes.json` | 抽出的引文與分段位置 |
| `build/taixu-matches.json` | 大正藏命中（頁碼、原文、吻合字數） |
| `build/taixu-linked.txt` | 套上 `<聯>` 的文字 |
| `build/tx.adb` | 打包成品（dbname `tx`、`tx_logo.png`） |
| `build/taixu-original.adb` | 舊版備份（2006-01-20），也是重建的來源 |
