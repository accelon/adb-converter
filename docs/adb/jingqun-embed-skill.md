# 經注疏引用關係與 `<嵌>` 文內嵌入（skill）

> 目標：讀者看《金剛經》經文時，段落旁有「▸ 3 家注疏」這類晶片；
> 點一下就在同一頁、緊貼經文的地方列出各註疏對**這一段**的解釋，再點收合。
> 不必開新頁，也不必離開正在讀的經文。
>
> 這是 offtext `^[引用]` 的 accelon 版：正文不動，展開的內容是另一段文字。
>
> 要把整段經文直接融入本文、做成獨立小庫，見
> [jingqun-notes-skill.md](./jingqun-notes-skill.md) 的 `<融>`。

![金剛經頁面上的「▸ 5 家注疏」、正文亮起、各家「大正↗」鏈結與展開的引文](../../build/jingqun/embed-highlight-test.png)

## 1. 兩個部分

| 部分 | 位置 | 做什麼 |
|---|---|---|
| **資料** | `jingqun/group.ts` → `build/jingqun/<db>-groups.tsv` | 把同一段經文的所有註疏匹配收成一群 |
| **注入** | `jingqun/inject-group.ts` → `<db>-embed-group.txt` | 段落前放 `<嵌始>`，段落後放 `<嵌 q t n>` |
| **執行期** | `render_accelon3.ts`／`embed.ts`／`xref.ts` | 晶片渲染、亮起正文、點擊取多家引文、插回 DOM |
| **驗證** | `ts/tools/embed-test.ts` | 開 adb、點晶片、確認正文亮起與引文插入 |

## 2. `<嵌>` 語法

```text
<嵌始 i="taisho?8p749a" j="73-145"/>經文段落…<嵌 i="taisho?8p749a" j="73-145" t="db?page@start-end@label|…" n="5 家注疏"/>
```

| 標籤／屬性 | 必填 | 說明 |
|---|---|---|
| `<嵌始 i="…" j="…"/>` | 是 | 段落起點零寬標記；展開時從這裡開始亮起正文 |
| `<嵌 i="…" j="…" …/>` | 是 | 晶片，放在**整段經文之後** |
| `i` | 是 | 段落所在頁（與 `<融>`／`<聯>` 同一套 `db?page`） |
| `j` | 是 | 段落的頁內漢字範圍（0 起、end 不含） |
| `q` | 選填 | 顯式引文；沒有 `q` 時建置可由 `i`／`j` 抽出 |
| `t` | 是 | 目標清單，`|` 分隔。每項 `db?page@start-end@label`：目標頁、該頁漢字範圍、顯示名 |
| `n` | 建議 | 晶片文字，例如 `3 家注疏`、`5 家注疏` |

例：

```text
佛告須菩提：「<嵌始 i="taisho?8p749a" j="73-145"/>諸菩薩摩訶薩應如是降伏其心：…實無眾生得滅度者。<嵌 i="taisho?8p749a" j="73-145" t="taisho?33p158b@14-54@纂要|…" n="5 家注疏"/>
```

點擊後**不重複正文**，只在同一頁插入各家解釋：

```html
<div class="embedBlock">
  <div class="embedHead">本段經文共有 5 家注疏 <button>收合</button></div>
  <div class="embedItems">
    <div class="embedItem"><div class="embedSrc">纂要</div><div class="embedText">…</div></div>
    <div class="embedItem"><div class="embedSrc">天親論</div><div class="embedText">…</div></div>
    <div class="embedItem"><div class="embedSrc">註解</div><div class="embedText">…</div></div>
  </div>
</div>
```

- 標題固定寫「本段經文共有 N 家注疏」；晶片仍顯示短版「N 家注疏」。
- 正文用 `CSS.highlights` 的 `embedLit` 亮起（`::highlight(embedLit)`），跨行也可以；
  不再顯示 `.embedSegment`，所以不會重複正文。
- `q` 讓資料層知道「這一段」是哪一句；`t` 裡每一家只取目標頁的引文所在句。
- 再點晶片或按「收合」移除 `.embedBlock`，同時取消正文亮起。
- 註：小庫 `jingqun/jingang.txt` 的建置流程可只用 `i`／`j` 從 `<融>` 正文抽出 `q`；
  `q` 可省略，也不會進入 adb。執行期只需要 `i`／`j`／`t`／`n`。

### 2.1 各家注疏的「大正」鏈結

群組面板裡每一家名稱旁都有一個 `大正↗` 小按鈕：

| 操作 | 結果 | 視覺 |
|---|---|---|
| 點 `大正↗` | 在**對側**（右欄）開該註疏的大正原文頁，並塗紅目標段落 | 按鈕填色、右欄外框閃一下 |
| Ctrl/⌘ + 點 | 在**本側**（中間）開一個新的經文分頁 | 中間外框閃一下、分頁列多一頁 |

面板標題右側有「點：右欄 · Ctrl+點：本側」提示；按鈕用 `aria-label`／`title`
說明，滑過會變成實心 accent，箭頭 `↗` 指出「往對側」。

實作：`renderEmbedGroup()` 在 `.embedSrc` 產生
`button.embedTLink[data-topen][data-trange][data-tlabel]`；
`embed.ts` 接到 `openTaishoAt()`；`openTaishoAt()` 普通點走
`openForeignTab()`（右欄），Ctrl 走 `linkTo(..., { newTab: true })`（中間新分頁），
再對 `#colRight`／`#docText` 加 `.embedFlash` 動畫。

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
6. 群裡的 `q` 取原文切片（含標點），並往前擴到最近的句讀／開引號；
   這就是展開時要亮起的正文範圍。`t` 列出各家目標。

產出 `build/jingqun/jingang-groups.tsv`：

```text
group_id  sutra_no  sutra_page  sutra_han  sutra_len  sutra_line  sutra_col
sutra_end_line  sutra_end_col  sutra_quote  targets  n_works
```

`sutra_line`/`sutra_col` 是亮起範圍的起點；`sutra_end_line`/`sutra_end_col`
是整段之後（含收引號、句讀）的晶片位置。不再有所謂「插在第一個句讀」的中間位置。

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
- 在段落起點插 `<嵌始 i="taisho?頁id" j="起-訖"/>`；
- 在段尾插 `<嵌 i="taisho?頁id" j="起-訖" t="多家" n="N 家注疏"/>`，
  也就是**整段經文之後**；
- 同一行多個位置由後往前插，避免 offset 位移；
- 輸出 `build/jingqun/jingang-embed-group.txt`。

### 3.6 打包與驗證

```powershell
bun run ts/tools/tei-pack.ts build/jingqun/jingang-embed-group.txt build/jingang-group.adb `
  jingang 金剛經經論群 logo/taisho_logo.png ""

bun run tools/embed-test.ts --adb ../build/jingang-group.adb --book 金剛般若波羅蜜經
```

`embed-test.ts` 會：開 adb → 找經文 → 數晶片 → 點第一個 → 等 `.embedDoc` →
確認**沒有重複的 `.embedSegment`**、正文 `embedLit` 有亮起 → 截圖；
再測「收合」、`大正↗`（右欄）與 Ctrl+`大正↗`（本側新分頁）。成功輸出：

```text
ok: 53 chips; first = 本段經文共有 5 家注疏 正文已亮起 · 點：右欄 · Ctrl+點：本側 收合
extra: { "closed": "ok", "hasSegment": false, "lit": true,
         "tlink": true, "rightText": "金剛經經論群 | …", "newMiddleTabs": 1 }
```

## 4. 執行期實作

| 檔案 | 位置 | 說明 |
|---|---|---|
| `ts/src/accelon26/render_accelon3.ts` | `name === '嵌始'`／`'嵌'`（約 L405） | `<嵌始>` → 零寬 `.embedSegStart`；`<嵌>` → `button.embedChip[data-key]` |
| `ts/src/accelon26/embed.ts` | `openEmbed` / `lightSegment` / `closeEmbed` | 點擊、插入 `.embedBlock`、用 CSS Highlight 亮起正文、收合 |
| `ts/src/accelon26/xref.ts` | `renderEmbedGroup`（約 L1545） | 解析 `t` 清單，逐家呼叫 `renderEmbed(..., bare)`，組成 `.embedGroup`＋`大正↗` |
| `ts/src/accelon26/xref.ts` | `openTaishoAt`（約 L1710） | 右欄開原文；Ctrl 在本側開新分頁；觸發 `.embedFlash` |
| `ts/src/accelon26/xref.ts` | `renderEmbed`（約 L1438） | 頁碼 → 區塊 → 引文切片 → `lineHtml`；`j`/`q` 定位 |
| `ts/src/accelon26/xref.ts` | `lineHtml`（約 L263） | 嵌入文字裡的 `<聯>`、`<嵌>` 仍可點 |
| `ts/src/accelon26/accelon26.template.html` | `.embedChip`／`.embedBlock`／`::highlight(embedLit)` | 晶片、內嵌框、正文亮起、來源列 |

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
| `build/jingqun/embed-highlight-test.png` | 點開「5 家注疏」、正文亮起的截圖 |

## 9. 下一步

- 人工看 92 群，補 `foldMap`，把 1698/1699 的短引文拉高。
- 群組晶片目前最多 5 家；若要更多，放寬 `group.ts` 的 `slice(0, 5)`。
- 加循環偵測與巢狀深度上限。
- 把 `group.ts` 的 `NO_BY_TITLE` 從 `jingqun.tsv` 自動建，讓其他經群不用手寫。

