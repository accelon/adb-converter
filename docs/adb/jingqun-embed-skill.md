# 經注疏引用關係與 `<嵌>` 文內嵌入（skill）

> 目標：讀者看《金剛經》經文時，段落旁有「▸ 3 家注疏」這類晶片；
> 點一下就在同一頁、緊貼經文的地方列出各註疏對**這一段**的解釋，再點收合。
> 不必開新頁，也不必離開正在讀的經文。
>
> 這是 offtext `^[引用]` 的 accelon 版：正文不動，展開的內容是另一段文字。

![金剛經頁面上的「▸ 3 家注疏」與展開的三家引文](../../build/jingqun/embed-group-test.png)

## 1. 兩個部分

| 部分 | 位置 | 做什麼 |
|---|---|---|
| **資料** | `jingqun/group.ts` → `build/jingqun/<db>-groups.tsv` | 把同一段經文的所有註疏匹配收成一群 |
| **注入** | `jingqun/inject-group.ts` → `<db>-embed-group.txt` | 在段落前插入 `<嵌 q="段落" t="多家目標" n="N 家注疏"/>` |
| **執行期** | `render_accelon3.ts`／`embed.ts`／`xref.ts` | 晶片渲染、點擊取多家引文、插回 DOM |
| **驗證** | `ts/tools/embed-test.ts` | 開 adb、點晶片、確認引文插入 |

## 2. `<嵌>` 語法

```text
<嵌 q="經文段落" t="db?page@start-end@label|db?page@start-end@label|…" n="3 家注疏"/>
```

| 屬性 | 必填 | 說明 |
|---|---|---|
| `q` | 是 | **被解釋的經文段落**（可含標點；定位時只算漢字） |
| `t` | 是 | 目標清單，`|` 分隔。每項 `db?page@start-end@label`：目標頁、該頁漢字範圍、顯示名 |
| `n` | 建議 | 晶片文字，例如 `3 家注疏`、`5 家注疏` |
| `i` / `j` | 舊版 | 單一目標的舊寫法（`<嵌 i="…" q="…" j="…"/>`）；新資料一律用 `q`＋`t` |

例：

```text
<嵌 q="如是我聞：一時，佛在舍衛國祇樹給孤獨園…" t="jingang?33p228b@318-360@註解|jingang?25p781b@97-127@天親論|jingang?33p155c@271-300@纂要" n="3 家注疏"/>
```

點擊後在同一頁插入：

```html
<div class="embedBlock">
  <div class="embedHead">3 家注疏 <button>收合</button></div>
  <div class="embedSegment">「如是我聞：一時，佛在舍衛國…」</div>
  <div class="embedItems">
    <div class="embedItem"><div class="embedSrc">註解</div><div class="embedText">…</div></div>
    <div class="embedItem"><div class="embedSrc">天親論</div><div class="embedText">…</div></div>
    <div class="embedItem"><div class="embedSrc">纂要</div><div class="embedText">…</div></div>
  </div>
</div>
```

- `q` 讓讀者一眼知道「這一段」是哪一句；也讓同一段的多家註疏可以分組。
- `t` 裡每一家只取目標頁的引文所在句，不是整頁。
- 再點晶片或按「收合」移除 `.embedBlock`。
- 嵌入文字裡的 `<聯>` 仍可點；`<嵌>` 也會再畫成晶片（巢狀引用），目前沒有循環偵測。

## 3. 建一個經群（以金剛經為例）

### 3.1 選根與工作清單

從 [`jingqun/jingqun.tsv`](../../jingqun/jingqun.tsv) 找 `f_jingang` 群。金剛經有三個譯本；
Pilot 取 T235（羅什）與六部註疏：

```text
235   金剛般若波羅蜜經
1510a 金剛般若論（無著）
1511  金剛般若波羅蜜經論（天親）
1698  金剛般若經疏（智顗）
1699  金剛般若疏（吉藏）
1701  金剛般若經疏論纂要（宗密）
1703  金剛般若波羅蜜經註解（宗泐）
```

### 3.2 抽出文字（只留這幾部）

`tei2adb` 新增 `-no`：

```powershell
go run ./cmd/tei2adb -tei D:\2023\sat2018\T -vol 8-85 `
  -no 235,1510a,1511,1698,1699,1701,1703 `
  -out build\jingqun\jingang.txt
```

一本書一個 `<段/><書 id="nX">…</書>`，頁碼 `<頁 id="8p748c"/>` 保留。

### 3.3 對齊（quote alignment）

```powershell
bun run jingqun/group.ts
```

可換經群：

```powershell
$env:EMBED_DB = 'jingang'
$env:EMBED_ROOT = '金剛般若波羅蜜經'
bun run jingqun/group.ts
```

做法：

1. 兩邊只留漢字；`foldMap` 折疊常見異體（説→說、卽→即、著→着、於→于…）。
2. 本經建 8 字 n-gram 索引（同一 n-gram 最多 40 個位置）。
3. 每部註疏掃 8 字窗口，延伸最長共同前綴；`>= 9` 字才收。
4. 去掉以經題開頭的匹配，以及同一部註疏內重疊的子句。
5. **依經文位置重疊分群**：同一段經文的所有註疏收成一群；每群最多 5 家，
   群長上限 90 個漢字（避免一個晶片包住整頁）。
6. 群裡的 `q` 取原文切片（含標點），`t` 列出各家目標。

產出 `build/jingqun/jingang-groups.tsv`：

```text
group_id  sutra_no  sutra_page  sutra_han  sutra_len  sutra_line  sutra_col
sutra_quote  targets  n_works
```

金剛 pilot：**92 群**，1–5 家不等（5 家 14 群、4 家 32 群、3 家 26 群）。

### 3.4 人工檢查（很重要）

打開 `jingang-groups.tsv`，至少看：

- `sutra_quote` 是不是完整、可讀的經文段落；
- `targets` 的 `page@start-end` 在目標頁是否真的對得上；
- 同一段是否被拆成太多群（`sutra_len` 太短）或一群太長（>90 字）；
- 太短的（9–11 字）是否只是「須菩提於意云何」這種通用句。

必要時直接改 TSV，或把 `foldMap` 加進新的異體字。

### 3.5 注入 `<嵌>`

```powershell
bun run jingqun/inject-group.ts
```

- 讀 `jingang-groups.tsv` 與 `jingang.txt`；
- 依 `sutra_line`/`sutra_col` 把 `<嵌 q="段落" t="多家" n="N 家注疏"/>` 插在段落前；
- 同一行多個位置由後往前插，避免 offset 位移；
- 輸出 `build/jingqun/jingang-embed-group.txt`。

### 3.6 打包與驗證

```powershell
bun run ts/tools/tei-pack.ts build/jingqun/jingang-embed-group.txt build/jingang-group.adb `
  jingang 金剛經經論群 logo/taisho_logo.png ""

bun run tools/embed-test.ts --adb ../build/jingang-group.adb --book 金剛般若波羅蜜經
```

`embed-test.ts` 會：開 adb → 找經文 → 數晶片 → 點第一個 → 等 `.embedDoc` →
讀引文與 `<mark>` → 截圖。成功輸出
`ok: 54 chips; first = 3 家注疏 收合`。

## 4. 執行期實作

| 檔案 | 位置 | 說明 |
|---|---|---|
| `ts/src/accelon26/render_accelon3.ts` | `name === '嵌'`（約 L407） | `<嵌>` → `<button class="embedChip" data-embed-targets …>` |
| `ts/src/accelon26/embed.ts` | `openEmbed` / `initEmbed` | 點擊、載入、插入 `.embedBlock`、收合 |
| `ts/src/accelon26/xref.ts` | `renderEmbedGroup`（約 L1540） | 解析 `t` 清單，逐家呼叫 `renderEmbed(..., bare)`，組成 `.embedGroup` |
| `ts/src/accelon26/xref.ts` | `renderEmbed`（約 L1438） | 頁碼 → 區塊 → 引文切片 → `lineHtml`；`j`/`q` 定位 |
| `ts/src/accelon26/xref.ts` | `lineHtml`（約 L263） | 嵌入文字裡的 `<聯>`、`<嵌>` 仍可點 |
| `ts/src/accelon26/accelon26.template.html` | `.embedChip`／`.embedBlock` | 晶片、內嵌框、來源列、塗紅 |

`renderEmbed` 的定位流程：

1. `readerFor(db)` → `anchorVa` → `blockOf`；
2. 在附近 block 找 `<頁 id="anchor">`（VA 與 block 邊界不一定對齊）；
3. 取頁文字到下一頁；建「漢字 → 原始字元」對照；
4. `j` 優先；用 `q` 前 12 字驗證，對不上就退回 `q` 搜尋；
5. 前後擴到句號／分號邊界（最多 900 字）；
6. `lineHtml(piece, markFrom, markTo)` 產生可點的引文。

## 5. 限制與坑

1. **異體字**：`foldMap` 只收常見的。像「則／即」「說／説」會讓 9 字匹配斷掉；
   必要時加字，或把 `MIN` 降到 8 並人工複核。
2. **重複頁碼**：大正藏同一頁可能被多部書共用（例如 T235 與其他般若經都在第 8 冊）。
   `anchorVa` 取第一個 `<頁 id>`；`<嵌>` 的 `q` 可以幫忙找對段落，但**跳頁**仍可能到錯的書。
   Pilot 的 `jingang.adb` 把 T235 與註疏放在同一庫，頁碼不撞；要注入完整 `taisho-85` 前，
   先確認這一冊的頁碼重複情形。
3. **巢狀**：`lineHtml` 會把嵌入文字裡的 `<嵌>` 再畫成晶片，但沒有循環偵測；
   A 嵌 B、B 嵌 A 會一直展開。
4. **分群粗細**：`group.ts` 用「經文位置重疊、群長 ≤90 漢字」分群；太短會切成很多晶片，
   太長會把好幾句收在同一群。要調 `group.ts` 的 `<= 90` 與 gap。
5. **沒有編輯介面**：目前改 `groups.tsv` 或 `foldMap` 要手動；`embed-test.ts` 只驗證一個晶片。
6. **完整 `taisho-85`**：`jingqun/inject-full.ts` 仍用舊的單一 `<嵌 i>` 格式；若要全庫用群組格式，
   需把 `inject-group.ts` 的邏輯接到 `tei-all.txt`。這條路會遇到第 2 點的重複頁碼。 
   建議先把 T235 放進獨立小庫（`jingang-group.adb`），確認閱讀體驗後再處理全庫。

## 6. 換到其他經群

1. 在 `jingqun.tsv` 找 `f_*` 群與 root。
2. 用 `tei2adb -no` 抽 root + 註疏。
3. `EMBED_DB`／`EMBED_ROOT` 指到新檔與新根，跑 `group.ts`、`inject-group.ts`。
4. 在 `group.ts` 的 `NO_BY_TITLE` 補同題多本（例：`金剛般若波羅蜜經論` 有 1510b/1511）。
5. `foldMap` 補該經常用異體字。
6. `tei-pack` 成新 adb，`embed-test.ts --book` 指到新經名。

## 7. 指令總表

```powershell
# 1) 抽文字
go run ./cmd/tei2adb -tei D:\2023\sat2018\T -vol 8-85 -no 235,1510a,1511,1698,1699,1701,1703 -out build\jingqun\jingang.txt

# 2) 分段＋對齊（可加 EMBED_DB / EMBED_ROOT）
bun run jingqun/group.ts

# 3) 注入群組 <嵌 q="段落" t="多家">
bun run jingqun/inject-group.ts

# 4) 打包
bun run ts/tools/tei-pack.ts build\jingqun\jingang-embed-group.txt build\jingang-group.adb jingang 金剛經經論群 logo\taisho_logo.png ""

# 5) 建 viewer（改了 render/embed/xref 之後）
cd ts; bun run tools/build-viewer.ts

# 6) 驗證
bun run tools/embed-test.ts --adb ../build/jingang-group.adb --book 金剛般若波羅蜜經
```

## 8. 檔案

| 檔案 | 說明 |
|---|---|
| `jingqun/group.ts` | 註疏引文 → 本經對齊、依段落分群 → `<db>-groups.tsv` |
| `jingqun/inject-group.ts` | 把 groups 注入 `<嵌 q t n>`，產生 `<db>-embed-group.txt` |
| `jingqun/align.ts` | 舊版：逐筆對齊（單一目標） |
| `jingqun/inject.ts` | 舊版：逐筆注入 `<嵌 i>` |
| `jingqun/inject-full.ts` | 把單一 `<嵌>` 注入完整 `tei-all.txt`（實驗） |
| `build/jingqun/jingang-groups.tsv` | 92 群（同一段經文的多家註疏） |
| `build/jingqun/jingang-embed-group.txt` | 已注入群組 `<嵌>` 的 T235 + 註疏 |
| `build/jingang-group.adb` | 金剛經經論群 demo 庫（0.8 MiB） |
| `ts/tools/embed-test.ts` | 端對端測試 |
| `build/jingqun/embed-group-test.png` | 點開「3 家注疏」的截圖 |

## 9. 下一步

- 人工看 92 群，補 `foldMap`，把 1698/1699 的短引文拉高。
- 群組晶片目前最多 5 家；若要更多，放寬 `group.ts` 的 `slice(0, 5)`。
- 加循環偵測與巢狀深度上限。
- 把 `group.ts` 的 `NO_BY_TITLE` 從 `jingqun.tsv` 自動建，讓其他經群不用手寫。
