# backlink-skill.md — 把古籍 adb 的引文接回大正藏

> 適用：任何以「經云…」「…曰：…」「…說：…」引用經論的 Accelon3 `.adb`。
> 做完的庫：`tx.adb`（太虛全書，2026-10）、`yulinpo.adb`（于淩波，2026-10）、
> `ys.adb`（印順，2026-10）、`lc.adb`（呂澂，2026-10）。工具：`ts/tools/backlink.ts`。
>
> 下文指令在倉庫根目錄執行。

## 交付規則（先讀；2026-10-28 作者指示）

**鏈結版打包後，最終 `.adb` 一定要放到 `accelon3\<dbname>.adb`，才算完成。**
repo 裡的 `accelon3/` 是指到 `D:\accelon3` 的 junction；Accelon26 直接掃這個資料夾，
作者要開起來測試。只留在 `build\` 不算交付。

- 檔名＝`dbname`（例：`yulinpo.adb` → `yulinpo`）。
- 複製後比對兩邊 SHA-256，必須相同。
- 若 adb 正被 Accelon26 開著，先寫 `<name>.adb.new` 再 rename 做原子替換。
- 回報時寫出：`accelon3\<name>.adb`、檔案大小、SHA-256。

## 什麼時候用

- 來源庫有大量逐字引文，想讓讀者點一下跳 `taisho.adb` 的對應頁。
- 想讓大正藏頁面反過來顯示「回連結（某書）」，和多個庫一起看。
- 不適合：純語錄、沒有引號的長篇轉述（寧可少連，不要亂連）。

## 先決條件

| 項目 | 要求 |
|---|---|
| 大正藏 | `accelon3/taisho.adb`（85 冊版，頁 id `NpMc`，如 `8p749a`） |
| 原始檔 | 未加 `<聯>` 的來源 adb（先備份成 `build/<slug>-original.adb`） |
| 執行環境 | Bun ≥ 1.1，仓库 `ts/` |
| 標記知識 | 來源庫的 skip tags、`caches`、logo、`dbname`（見下方「打包要保留」） |

## 一、五步流程

### 1. 備份、解出

```bat
copy accelon3\yulinpo.adb build\yulinpo-original.adb
```

`backlink.ts` 會用 `src/adbtext.ts` 把 `source` 解成一行一個 pcl 行，寫到
`build/<slug>-text.txt`。

### 2. 選 cue（引文提示語）

cue 決定「抽哪些引文」，搜尋只負責「連得對不對」。同一個庫先具名、再泛用：

| 庫 | cue | 候選 | 連上 |
|---|---|---:|---:|
| 太虛 `tx` | `經曰：`、`經上說：`、`經云：`、`法華云：『`、`：『` | 3,796 | 2,450（64.5%） |
| 于淩波 `yulinpo` | `經上說：`、`經云：`、`經曰：`、`論云：`、`曰：`、`云：`、`又說：`、`說：`、`：「`、`：『` | 5,325 | 1,238（23.2%） |

規則：

- 有開引號（`：『`、`法華云：『`）的 cue：引號在 cue 裡時，短句門檻 6 字；
  引號在 cue 後面（`經云：「…」`）時，門檻 4 字。
- 沒有引號的 cue：收到 `。！？；」』` 或 160 字為止，門檻 6 字。
- 不同 cue 抽到同一段（`云：` vs `經云：`）用（行、起點）去重。
- 泛用 `：「` 會連到禪宗語錄、古德法語；只要大正藏有同文就算命中，不保證是「經」。

### 3. 搜尋（先乾跑）

```bat
bun run ts/tools/backlink.ts --src build/yulinpo-original.adb --slug yulinpo ^
  --cues "經上說：,經云：,經曰：,論云：,曰：,云：,又說：,說：,：「,：『" --no-pack
```

先看 `build/<slug>-matches.json`：

- `matched / n`：引文前 8 字以上連續吻合（n ≤ 8 時容許少一字）。
- `book`：命中的大正 `書`；`anchor`：頁碼。
- 抽 20 筆人工看：有沒有「同一句話連到不相干的註疏」。
- 命中率太低（<15%）→ cue 太泛或版本用字差太多；太高（>80%）→ 可能只連到常見短句。

搜尋演算法（`backlink.ts` 內）：

1. 引文只留漢字，依 `variants.ts` 正規化異體字。
2. **切成單字**，取 `taisho.adb` 的 `tokens` posting；挑 posting 最短的字當錨點。
3. 其他字要落在錨點前後 **20 個 VA**（`MAXGAP`，容許標點與 `<頁>` 位移），
   得到候選 VA（最多 400 個）。
4. 候選 VA 附近取原文（`VaPaMapper.context`），用前 24 字做前綴比對
   （12/8/6/4 字 probe），容許異體與少數差異。
5. 引文前 30 字與大正 `書` 標題的最長共同子串 ≥2 時，優先挑那一部（避免先命中
   後代註疏）；同分挑 VA 較早的候選。
6. 只包實際吻合的那一段；`q` 存大正原文（≤160 字），給回連結定位／塗紅。

### 4. 套用、打包

```bat
bun run ts/tools/backlink.ts --src build/yulinpo-original.adb --slug yulinpo --dbname yulinpo ^
  --cues "經上說：,經云：,經曰：,論云：,曰：,云：,又說：,說：,：「,：『" --out build\yulinpo.adb
```

- `--dbname` **必須等於檔名**（`tx.adb` → `tx`、`yulinpo.adb` → `yulinpo`）。
  回連結靠檔頭 dbname 找庫；沿用舊的 `9999`／`taixu` 會找不到來源庫。
- `--logo logo/xxx_logo.png`：資源名改成 `<dbname>_logo.png`，舊 `*_logo.*` 移除。
- `--reuse`：沿用上次的 `<slug>-quotes.json`／`<slug>-matches.json`，只重做套用與打包。
- **打包後一定把最終檔複製到 `accelon3\<dbname>.adb`**（見上面的交付規則），
  再比對 SHA-256；只寫在 `build\` 不算完成。

### 5. 驗收、上架

見下一節。

## 二、打包時一定要保留的東西

`backlink.ts` 已自動處理，換工具時別漏：

| 項目 | 為什麼 |
|---|---|
| `validTags` | 正文用 `<大唐西域記>` 這類尖括號包書名時，不設會多出 150+ 個假標記（于淩波）。 |
| `cachedTags` | 舊 docdef 的 caches 在 adb 之外；沿用才不會掉目錄（太虛 37 鍵）。 |
| `dualSelfClosingTags` | 舊 docdef 把 `<平裝/>`、`<精裝/>` 自閉合卻仍索引 `/平裝`、`/精裝`。 |
| `resources` | 原樣帶過去（678 個圖檔＋logo）；只換 logo。 |
| `dbname = 檔名` | 反連結解析來源庫用。 |
| `<聯>` 是 skip tag | 不佔 VA；頁碼、`頁.id` 不變。 |

## 三、驗收清單

- [ ] 去掉所有 `<…>` 後，新舊文字**逐行相同**。
- [ ] `頁.id` 數量、順序、內容相同。
- [ ] `caches` 每個鍵的**值**相同（鍵的順序可以不同）。
- [ ] `聯.i` 每個頁碼都存在於 `taisho.adb`；`q` 的前 8 個漢字在那一頁。
- [ ] 每行 `<聯>` 開關平衡（原本的 `<聯 l=…>` 除外）、沒有巢狀。
- [ ] 實機：中間點聯→右欄大正頁並塗紅；右欄回連結→中間來源頁。
- [ ] 多庫：大正頁的回連結同時列出多個庫（如印順＋太虛＋于淩波）。
- [ ] 最終 `.adb` 已放到 `accelon3\<dbname>.adb`，兩邊 SHA-256 相同（作者可直接在 Accelon26 測試）。
- [ ] 公開：`index.txt`／`index.html` 有這個檔；下載檔 SHA-256 與本地相同；舊檔 404。

## 四、上架（公開資料庫）

1. **寫差異說明**（可選但建議）：`<name>.md` → `www/adb/<name>.html`
   ```bat
   bun run ts/tools/md-page.ts --md tx.md --out www/adb/tx.html --title "tx.adb 與 taixu.adb 有什麼不同"
   ```
2. **清單**：`www/adb/index.txt` 一行一筆；有說明頁加 TAB：
   ```text
   tx.adb	tx.html
   ```
3. **重生成頁面**（讀本機 adb 檔頭算字數、日期、大小）：
   ```bat
   bun run ts/tools/make-adb-index.ts --index www/adb/index.txt
   ```
4. **上網頁**：
   ```bat
   bun run ts/tools/deploy.ts --site-only
   ```
5. **上 adb 本體**（deploy 不傳 `.adb`）：用 `.local/server.env` 的帳密，
   `pscp` 傳到 `/var/www/html/accelon26/adb/<name>.adb.tmp`，遠端 `mv` 成正式檔；
   改名的話再 `rm` 舊檔。
6. **驗證**：
   - `HEAD https://shutonggui.cn/accelon26/adb/<name>.adb` → 200，大小正確；
   - 下載回來比 SHA-256；
   - 舊檔名 → 404；
   - `index.txt`／`index.html` 不含舊檔名。

## 五、已完成成果（2026-10-28）

| 庫 | dbname | 候選 | 連上 | `<聯>` | 目標頁 | 備註 |
|---|---|---|---:|---:|---:|---:|---|
| `tx.adb` 太虛 | `tx` | 3,796 | 2,450 | 4,484 | 1,204 | logo `tx_logo.png`；舊 `taixu.adb` 已下架 |
| `yulinpo.adb` 于淩波 | `yulinpo` | 5,325 | 1,238 | 1,506 | 460 | 原 dbname `9999` 改成 `yulinpo` |
| `ys.adb` 印順 | `ys` | — | — | 25,918 | 4,894 | 2026-10-28 用 `retrofit-j.ts` 補 `j` 25,095 |
| `lc.adb` 呂澂 | `lc` | 1,826 | 861 | 1,119 | 551 | CBETA LC 重建；cue 加泛用 `「`（8 字以上引文）；`j` 1,119 |

### 三個庫共同引用的經典（交集 47 頁／23 部）

| 共同頁 | 太虛 | 印順 | 于淩波 | 書名 |
|---:|---:|---:|---:|---|
| 11 | 55 | 26 | 56 | 成唯識論 |
| 4 | 21 | 91 | 17 | 大乘起信論 |
| 4 | 14 | 81 | 28 | 中論 |
| 3 | 27 | 50 | 6 | 楞伽阿跋多羅寶經 |
| 3 | 14 | 22 | 15 | 解深密經 |
| 2 | 16 | 18 | 25 | 大乘廣五蘊論 |
| 2 | 4 | 32 | 5 | 攝大乘論本 |
| 2 | 12 | 24 | 2 | 妙法蓮華經 |
| 2 | 3 | 3 | 8 | 唯識三十論頌 |
| 1 | 11 | 11 | 1 | **金剛般若波羅蜜經**（什譯，8p749a） |

完整清單見 [`shared-xref-tx-ys-ylp.md`](./shared-xref-tx-ys-ylp.md)：
```bat
bun run ts/tools/xref-shared.ts accelon3/tx.adb accelon3/ys.adb accelon3/yulinpo.adb --book 金剛 --md shared-xref-tx-ys-ylp.md
```

三庫同時開著讀《金剛經》`8p749a` 時，回連結那一排會列出 31 條（印順、于淩波、太虛）：

![三庫回連結：金剛經 8p749a](../../build/shared3-xref.png)

## 六、坑

1. **dbname 沒改**：`taixu.adb` 的檔頭是 `taixu`、`yulinpo.adb` 是 `9999`。
   不改的話，大正頁面看得到「回連結」按鈕，但按下去找不到來源庫。
2. **logo 名稱**：`logo.ts` 只認 `<dbname>_logo.*`；改檔名就要一起改資源名。
3. **正文尖括號**：`<大唐西域記>` 不是標記；不設 `validTags` 會暴增假標記、
   caches 也會跟著亂。
4. **cue 重疊**：`云：` 會命中 `經云：` 的同一段；靠（行、起點）去重，不要重複插聯。
5. **短句**：4 字以下不抽；`：『` 這種 cue 內含開引號的，6 字才收。
6. **改寫／節引**：太虛常憑記憶引（「阿陀那識甚深細，習氣種子如瀑流」 vs
   《解深密經》「一切種子」），對不上就放掉，不要硬連。
7. **長引文**：只包實際吻合的前段（最多 80 字），`q` 只存 160 字。
8. **`lines.virtual` 會位移**：重建索引後與舊檔最多差幾十個 VA（Delphi 版對
   自閉合標記的計法不同）；頁的定位走 `attributes/頁.id → tags/頁`，不受影響。
9. **公開舊檔**：下架前先備份；伺服器刪除後網址會 404（`yinshun.adb`、`taixu.adb`
   都是這樣處理）。

## 七、字級範圍 j（2026-10-28，accelon26 專用）

```xml
<聯 i="taisho?8p848c" q="色即是空，空即是色；" j="52-60">色即是空，空即是色</聯>
```

- `j="起-訖"`：目標頁**可見漢字**的索引（0 起算、end 不含）。和
  `xref.renderForeign()` 的 `lineHtml()` 同一套算法：跳過 `<…>` 標記、只數
  `[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]`、從 `<頁 …/>` 之後算、
  頁面取 2000 code unit（和右欄渲染的 `maxChars` 一致）。
- **`聯.i` 不變**，`j` 不重複 `taisho?`（有 `j` 必有 `i`，目標庫／頁看 `i`）。
  舊 accelon3 只會多存一個 `聯.j` 屬性，不影響閱讀。
- `backlink.ts` 在搜尋命中時順便算 `j`：把目標頁的漢字串取出來，用 `q` 的前
  12/10/8/6/4 字找位置（取離 VA 最近的一個），確認整段等於 `q` 的前綴才寫。
  對不上（跨頁、頁邊界、版本差異）就不寫 `j`。
- 覆蓋率：`tx` 4,337/4,484、`yulinpo` 1,450/1,506、`ys` 25,095/25,918、
  `lc` 1,119/1,119；逐個回驗 0 bad／0 超出頁面。
- 既有 `<聯 i q>` 只補 `j`：`ts/tools/retrofit-j.ts --adb … --out …`（不動 `i`／`q`／正文）。
- `--reuse` 會沿用舊的 `<slug>-matches.json`；舊檔沒有 `j` 就不會有，補 `j` 要
  重新跑搜尋（不要加 `--reuse`）。
- 閱讀器：`<a data-j>` → `renderForeign(..., range)`；先用 `j` 切 `pn[起,訖]`，
  必須等於 `q` 的漢字前綴才塗；不等就退回原本的 `q` 文字比對（所以錯的 `j`
  不會標錯地方）。
- 驗收：每個 `聯.j` 的切片要等於 `q` 的前幾個字；沒有 `j` 的錨點仍可用 `q` 定位。
- 實戰坑（CJK `\b`、重複頁 id、attribute 陣列不對齊、6 字前綴誤中）與修復順序見
  [`xref-j-lessons.md`](xref-j-lessons.md)。
