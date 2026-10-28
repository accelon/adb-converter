# old-adb-upgrade-skill：把舊 accelon3 `.adb` 升級（保留 i、加上 j）

> 這份是「舊庫不動正文、只換索引與連結」的操作手冊。
> 輸入是一顆 Delphi 時代的 `.adb`（沒有大正鏈結、schema 寫在 adb 外面），
> 輸出是同一份文字、但索引重建、`dbname=檔名`、可加 `<聯 i q j>` 的新庫。
>
> 已做過的升級：
>
> | 舊庫 | 新庫 | 主要變化 |
> |---|---|---|
> | `taixu.adb`（2006） | `tx.adb` | dbname `tx`、logo `tx_logo.png`、4,484 個 `<聯>`（4,337 個帶 `j`） |
> | `yulinpo.adb`（2006） | `yulinpo.adb`（原地升級） | dbname `9999`→`yulinpo`、1,506 個 `<聯>`（1,450 帶 `j`） |
>
> 從 CBETA 重建的新庫（`ys.adb`、`lc.adb`）走的是 `cbeta-adb-skill.md`，
> 不適用本文件的前半段（那些庫的正文是重生的，不是舊 adb 的文字）。

---

## 交付規則（先讀）

1. **最終檔一定要放到 `accelon3\<dbname>.adb`**；只寫在 `build\` 不算完成。
2. 檔名＝`dbname`（`tx.adb`→`tx`、`yulinpo.adb`→`yulinpo`）。
   反連結靠檔頭 dbname 找庫，名子不對，按鈕會找不到來源。
3. 覆蓋前先備份舊檔（`build\<name>-original.adb`），複製後比對 SHA-256。
4. 若 Accelon26 正開著，舊檔會被映射鎖住：先改名成 `.old`（或 `<name>.adb.new`
   再 rename），不要直接覆寫；改名後再放新檔。
5. 回報：檔名、大小、SHA-256、`聯.i`／`聯.q`／`聯.j` 數量、驗收結果。

---

## 0. 先量舊庫（不要憑印象）

```ts
import { readAdbText } from './ts/src/adbtext';
import { AdbReader, SyncIO } from './ts/src/accelon26/adb';
const t = readAdbText('accelon3/taixu.adb');
console.log(t.header);                 // dbname/dbcname/dbType/srcBlockSize/andTagId
console.log(t.tagNames);               // 開標籤＋/收尾
console.log(t.lines.length, t.lines.join('').length);
const r = await AdbReader.open(new SyncIO('accelon3/taixu.adb'));
console.log(r.containers.get('caches')?.names);      // 目錄快取鍵
console.log(r.containers.get('resources')?.names);   // 圖片／logo
console.log((await r.attributeValues('頁.id'))?.values.length);
```

要記下：

| 欄位 | 為什麼 |
|---|---|
| `dbname` / `dbcname` / `dbtype` / `srcBlockSize` | 打包時照舊（dbname 改成檔名） |
| `tags` 的**開標籤**清單 | 當 `validTags`，避免正文 `<書名>` 變假標記 |
| `caches` 的鍵 | 當 `cachedTags`，否則目錄／頻次會少段 |
| 有沒有 `/平裝`、`/精裝` 這種「自閉合卻有 close hit」 | 要 `dualSelfClosingTags` |
| `resources` | 全部原樣帶過去（logo 可換） |
| `頁.id` 數量與順序 | 升級後必須一模一樣 |
| `lines.virtual` | 重建後可能小幅位移，正常（見 §4） |

---

## 1. 解出文字（不動正文）

```ts
const adb = readAdbText('accelon3/taixu.adb');
const lines = adb.lines;   // 一行一個 pcl 行，含 accelon 標記
```

舊庫的**正文就是 adb 裡的 source**；升級只做兩件事：

1. 在文字上插 `<聯>`（可選）。
2. 用 `ts/src/adbauthor.ts` 重建索引。

**不要**重新排版、不要改標點、不要合併行；去標記後必須逐行相同。

---

## 2. 保留舊 schema（最容易漏）

`authorAdb` 預設是「從零建庫」，舊庫的 docdef 在 adb 外面，所以要把 schema 餵進去：

```ts
const srcTags = r.containers.get('tags')!.names;                 // 含 /收尾
const validTags = [...new Set([...srcTags.filter(n => !n.startsWith('/')), '聯'])];
const cachedTags = r.containers.get('caches')!.names;            // 例：37 鍵
const dualSelfClosingTags = ['平裝', '精裝'];                    // 掃出來的
const resources = /* 從舊 resources 逐塊讀出 */;

await authorAdb({
  dbname: 'tx', dbcname: '太虛大師全書', dbtype: 0, srcBlockSize: 16384,
  lines, resources, validTags, cachedTags, dualSelfClosingTags,
});
```

| 參數 | 漏了會怎樣 |
|---|---|
| `validTags` | 正文用 `<大唐西域記>` 包書名時，tag 表暴增 150+ 種假標記，caches 也亂 |
| `cachedTags` | 目錄／頻次只從 `t=` 宣告處開始，前面幾卷的節點不見 |
| `dualSelfClosingTags` | `/平裝`、`/精裝` 這種 close hit 消失，舊 accelon3 的版本篩選受影響 |
| `resources` | 圖片、logo 全部不見 |
| `dbname=檔名` | 大正頁面的「回連結」按鈕找不到來源庫 |
| `andtagid` | 由 `authorAdb` 依新 tag 表算，不要手抄舊值（tag 順序會變） |

---

## 3. 加字元級連結：`<聯 i q j>`（本 skill 的重點）

`backlink.ts` 會抽引文、查大正、套用並打包；**`i` 不變，`j` 是新增的精度**。

```xml
<聯 i="taisho?8p848c" q="色即是空，空即是色；" j="52-60">色即是空，空即是色</聯>
```

* `i`：`taisho?頁id`，accelon3 標準格式，**不要改**。
* `q`：目標頁的純漢字原文（≤160 字），給文字比對與回連結定位。
* `j`：目標頁「可見漢字」索引 `起-訖`（0 起算、end 不含），只寫數字；
  有 `j` 必有 `i`，庫／頁看 `i`。舊 accelon3 只會多存一個 `聯.j` 屬性，
  不影響閱讀；`聯` 是 skip tag，不佔 VA、不改頁碼。
* **`j` 的座標系**和右欄 `renderForeign()` 的 `lineHtml()` 一致：
  從 `<頁 id="…">` 之後起算、跳過 `<…>`、只數
  `[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]`、頁面取 2000 code unit。
  這不是來源端的「原始字元索引」，兩種座標不要混（見 §4）。
* 算不出 `j`（跨頁、頁邊界、`q` 對不上）就**不要寫**；閱讀器會退回 `q` 比對。

指令（以于淩波為例）：

```bat
bun run ts/tools/backlink.ts --src build\yulinpo-original.adb --slug yulinpo ^
  --dbname yulinpo ^
  --cues "經上說：,經云：,經曰：,論云：,曰：,云：,又說：,說：,：「,：『" ^
  --out build\yulinpo.adb
```

太虛（公開版 `tx`、換 logo）：

```bat
bun run ts/tools/backlink.ts --src build\taixu-original.adb --slug taixu ^
  --dbname tx --logo logo\tx_logo.png --out build\tx.adb
```

先乾跑看命中率與樣本（不打包）：

```bat
bun run ts/tools/backlink.ts --src ... --no-pack
```

`--reuse` 會沿用舊的 `<slug>-matches.json`；**舊檔沒有 `j` 就不會補**，
要補 `j` 必須重跑搜尋（不要加 `--reuse`）。

### 3.1 既有連結只補 `j`（不重算 `i`／`q`）

已經有 `<聯 i q>` 的庫（`ys`、`lc`、`tx`、`yulinpo` 的舊版）可以只補 `j`：

```bat
bun run ts/tools/retrofit-j.ts --adb accelon3\ys.adb --out build\ys-j.adb
bun run ts/tools/retrofit-j.ts --adb accelon3\lc.adb --out build\lc-j.adb
```

頁內對不上時，再用「目標頁＋前後頁、單字命中率、寬鬆對位」補：

```bat
bun run ts/tools/repair-window.ts --adb accelon3\ys.adb --out build\ys-window.adb
bun run ts/tools/verify-j.ts --old accelon3\ys.adb --new build\ys-window.adb --out build\ys-window-fixed.adb
```

`verify-j.ts` 會把每個新 `j` 放回頁 id 的**實際出現**（大正藏有重複頁 id）重新驗證，
找不到就整條還原，所以不會留下指錯的 `j`。實戰細節見
[`xref-j-lessons.md`](xref-j-lessons.md)。

- 對每個 `taisho?頁`＋`q`，在目標頁漢字串裡找 `q` 前 12/10/8/6/4 字，算 `j`；
  對不上就用寬鬆對位（6 字種子＋容許插漏字）找頁面上最接近的一段，找到才寫 `j`。
- 有 `j` 的聯，`q` 會改成目標頁的原文切片（繁簡／異體統一，保證和 `j` 完全一致）；
  `i`、正文不動。沒有 `j` 的聯保留原 `q`，閱讀器照舊用文字比對。
- 2026-10-28 實測：`ys` 25,095/25,918（頁內寬鬆 1,189＋前後頁 915）、`lc` 1,119/1,119；
  其餘 576 條頁內／前後頁都找不到足夠相似文字（另有 247 條沒有 `q` 的內部連結），
  屬舊連結本身的對位錯誤，不是 `j` 的錯。

---

## 4. 兩種座標（升級時最常錯）

| 用途 | 座標 | 為什麼 |
|---|---|---|
| 來源端：`<聯>` 要包哪一段 | **原始字元索引**（連標點一起算） | 用漢字序號會讓 `</聯>` 在「，」前提前一個字 |
| 目標端：`j="起-訖"` | **可見漢字索引**（跳過標點與標記） | 右欄塗紅就是按漢字在數；和 `lineHtml()` 同一個索引 |

`backlink.ts` 內部已分開處理：插聯用原始字元，`j` 用漢字。

---

## 5. 驗收（升級版）

- [ ] 去掉所有 `<…>` 後，新舊文字**逐行相同**（307,141 行也要逐行比）。
- [ ] `頁.id` 數量、順序、內容相同（`tx` 16,441、`yulinpo` 1,309）。
- [ ] `caches` 每個鍵的**值**相同（鍵的順序可以不同）。
- [ ] `tags` 集合＝舊庫開標籤＋`聯`；沒有 `<大唐西域記>` 這類假標記。
- [ ] `聯.i` 每個頁碼存在於 `taisho.adb`；`q` 前 8 字在那一頁。
- [ ] 每個 `聯.j` 的切片等於 `q` 的漢字前綴；沒有 `j` 的錨點可退回 `q`。
- [ ] 每行 `<聯>` 開關平衡、沒有巢狀。
- [ ] 實機：中間點聯 → 右欄大正頁只塗 `j` 那段；右欄反鏈 → 中間來源頁。
- [ ] 多庫：大正頁同時列出多個庫（`tx`＋`ys`＋`yulinpo`）。
- [ ] 公開：`index.txt`／`index.html` 有名稱；下載 SHA-256 相同；舊檔（若改名）404。

---

## 6. 上架（與 cbeta-adb-skill 相同）

1. 備份舊檔 → `build/<name>-original.adb`。
2. 安裝到 `accelon3\<dbname>.adb`（被鎖住就先 rename 舊檔）。
3. 公開清單 `www/adb/index.txt`；有說明頁加 `\t<name>.html`。
4. `bun run ts/tools/make-adb-index.ts --index www/adb/index.txt`
5. `bun run ts/tools/deploy.ts --site-only`
6. `.adb` 本體另外用 pscp 上傳（deploy 不傳 `.adb`），改名時舊檔 `rm`。
7. 驗證線上大小／SHA-256／舊網址 404。

---

## 7. 坑

1. **dbname 沒改**：`taixu`、`9999` 要改成檔名，否則反鏈找不到來源庫。
2. **正文尖括號**：`<大唐西域記>` 不是標記；`validTags` 不設會暴增假標記。
3. **caches 順序**：新舊鍵順序可以不同，但**值**要一樣；不要用順序判斷成敗。
4. **`lines.virtual` 位移**：重建索引後與舊檔最多差幾十個 VA（Delphi 版對自閉合
   標記的計法不同）；頁的定位走 `attributes/頁.id → tags/頁`，不受影響。
5. **檔案被鎖**：Accelon26 開著時，Windows 會拒絕覆寫 mapped file；
   先 rename 成 `.old` 再放新檔（本專案 `tx.adb`、`yulinpo.adb` 都這樣做過）。
6. **logo 名稱**：`logo.ts` 只認 `<dbname>_logo.*`；改檔名要一起換資源名。
7. **`j` 不是原始字元索引**：拿來源端的字元位置去當 `j`，會和右欄差幾個字；
   一定要用目標頁的漢字串重算。
8. **沒有 `j` 不是錯**：跨頁／頁邊界／`q` 對不上時本來就算不出，閱讀器會用
   `q` 比對；不要為了湊數亂寫。

---

## 8. 檔案

| 檔案 | 說明 |
|---|---|
| `ts/tools/backlink.ts` | 抽引文、大正搜尋、套用 `<聯 i q j>`、打包 |
| `ts/tools/retrofit-j.ts` | 既有 `<聯 i q>` 只補 `j`（不重算連結） |
| `ts/tools/repair-window.ts` | 目標頁＋前後頁、單字命中率、寬鬆對位補 `j` |
| `ts/tools/verify-j.ts` | 把新 `j` 放回頁 id 的實際出現驗證，失敗就還原 |
| `ts/src/adbauthor.ts` / `author-core.ts` | 重建 adb（validTags／cachedTags／dual） |
| `ts/src/accelon26/xref.ts` | 閱讀器：反鏈、`j` 範圍、fallback |
| `ts/src/accelon26/doc-pane.ts` | 中間反鏈逐頁掛（不是只掛文件第一頁） |
| `ts/tools/xref-shared.ts` | 多庫共同引用的大正頁／經典 |
| `backlink-skill.md` | 連結流程與 cue 調校的完整 runbook |
| `cbeta-adb-skill.md` | 從 CBETA 重建新庫（j 的規格也在 §4） |
