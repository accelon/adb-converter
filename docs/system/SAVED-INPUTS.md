# 已存輸入（saved inputs）設計稿

> 狀態：**設計稿，尚未實作**（2026-11-12）。
> 目的：把使用者輸入過的「位置」與「查詢詞」記下來，下次不必重打；跨庫共用常用詞。
> 落點：左欄搜尋框 `#query` 下方的既有「提示卡」，升級成四頁合一的分頁卡。

---

## 1. 要解決的問題

1. **位置**：從選取文字的「引用複製」得到 `db?頁#起-止` 之類字串，貼進 `#query` 就能跳；
   但每次都要重新複製、貼上。希望能**存成清單，點一下就跳回**。
2. **per adb 輸入**：在某庫常查的詞（例：`13j` 的「乾」、`taisho` 的「如是我聞」），
   希望能存在該庫名下，下次打開該庫直接可見。
3. **global 輸入詞**：常用的跨庫詞（例「般若」「緣起」），**到別的庫也不必重打**。

## 2. 現況定位（已核對原始碼）

- **主輸入框是 `#query`**（`accelon26.template.html` 約 2354 行，左欄「目錄」分頁的 searchBar）。
  作者 2026-11-01 已把「跳至」**併進這個框**：先當全文搜尋；搜尋不到才判讀
  頁 id／大正引用／字元級位置／目錄路徑／節點序號（`ui.ts` 的 `query.oninput`、`queryModeOf()`）。
  因此**只需增強 `#query` 一處，就同時涵蓋「搜」與「跳」**。
- **「提示卡」＝ `#jumpCheatCard`**（template 約 3119 行，樣式 `.cheatCard` 約 1674 行），
  由 `ui.ts` 的 `wireJumpCheat()`（約 1482 行）綁在 `#query` 與 `#jumpQuery`：
  輸入框取得 focus、內容空白、停 1.5 秒 → 錨在輸入框正下方顯示；一有輸入或 blur 即收。
  **這是最適合掛分頁的位置**（零新浮層、零新左欄分頁）。
- **既有儲存慣例**：
  - `bookmarks.ts`：`accelon26.bookmarks.v1` = `Record<dbname, Bookmark[]>`，有匯出／匯入。
  - `read-state.ts`：另有 per-db `searchQuery`，但那是「上次查詢」的 session 還原，不是「清單」。
- **「引用複製」**：`bookmarks.ts` 的 `citationForSelection()` 產生 `db?頁#起-止`；
  `#query` 貼上這種字串會**直接跳**（`ui.ts` 的 `insertFromPaste` 判斷）。
- **當前庫名**：`reader.header.dbname`（提示卡 `fill()` 已在用）。

## 3. 設計：四頁合一

把 `#jumpCheatCard` 升級成帶分頁的卡，**提示卡本身就變成「已存輸入」的家**：

```
┌ .cheatCard（錨在 #query 正下方，沿用現有定位邏輯）────────┐
│ .ccTabs  [提示] [位置] [此庫] [全域]                      │
│ ──────────────────────────────────────────────────────── │
│ .ccPane[data-cc="hint"]   ← 現有語法說明（照舊）          │
│ .ccPane[data-cc="pos"]    ← 位置清單（點即跳）            │
│ .ccPane[data-cc="db"]     ← 此庫查詢詞（點即搜）          │
│ .ccPane[data-cc="global"] ← 全域查詢詞（任何庫都在，點即搜）│
│ .ccFoot  ＋存目前輸入   ·   清空   ·   匯出               │
└────────────────────────────────────────────────────────┘
```

### 3.1 分頁語義與點擊行為（三類不可混）

| 分頁 | 內容 | 存到哪裡 | 點一下 |
|---|---|---|---|
| 提示 | 語法說明 | 無 | — |
| 位置 | `db?page#a-b`、頁 id、頁行、字元位置 | `positions[dbname]` | 填 `#query` → `jumpByQuery()` **跳** |
| 此庫 | 全文查詢詞 | `terms[dbname]` | 填 `#query` → `runSearch()` **搜** |
| 全域 | 全文查詢詞 | `global[]` | 同上；**任何庫都顯示** |

> 位置與「此庫」分開，是因為「跳」與「搜」走不同管線。
> 「全域」只放「詞」，**不放位置**——A 庫的頁位置到 B 庫沒有意義。

### 3.2 顯示／收起狀態機（改 `wireJumpCheat()`）

- `focus`：先 `fill()`（既有，依 adb 換例子）；**若該庫或全域有存項**，立即 `show()`；
  否則維持原本「空白 1.5 秒才 `show()`」顯示「提示」分頁。
- `show()` 的守門條件沿用：`activeElement===input && !input.value.trim() && jumpCheatOn()`。
  但**當焦點已進到卡內的分頁在瀏覽時**，不要因輸入框空白就收——把 `blur` 觸發的 `hide`
  放寬為「輸入框與卡都沒有焦點」才收。
- `input`／`scroll`／`resize` 仍 `hide()`（既有行為）。
- 記住最後停留的分頁：`accelon26.savedInputs.tab`，下次 focus 回到同一頁。

## 4. 資料模型與儲存

只存**文字**，不存 VA／座標。書籤存 `va` 是為了同庫精準定位；本功能目的是「免重打」，
存字串最穩，跨版本、跨庫都不會壞。

```ts
// localStorage: accelon26.savedInputs.v1
type SavedItem = { id: string; text: string; label?: string; at: number };

interface SavedStore {
  positions: Record<string, SavedItem[]>; // 位置：key = dbname
  terms:     Record<string, SavedItem[]>; // per adb 查詢詞：key = dbname
  global:    SavedItem[];                 // 全域查詢詞
}
```

- `label` 由 `text` 推（頁 id，或詞的前 12 字），省空間。
- 每桶上限 **100**；同 `text` 去重（保留較新的 `at`）。
- 位置裡的庫名前綴沿用 `urlPageId()` 的正規化（例如 `fuyan` 去 `yl` 前綴）。
- 全部 `localStorage` 存取包 `try/catch`（無痕模式），與既有 `jumpCheatOn()` 同款。

## 5. 資料層：新增 `ts/src/accelon26/saved-inputs.ts`

仿 `bookmarks.ts`，**只做資料與持久化、不碰 UI**，可獨立先寫先測：

```ts
type Bucket = 'pos' | 'db' | 'global';

list(dbname: string, bucket: Bucket): SavedItem[];
add(dbname: string, bucket: Bucket, text: string, label?: string): SavedItem; // 去重＋上限
remove(dbname: string, bucket: Bucket, id: string): void;
clear(dbname: string, bucket?: Bucket): void;
exportAll(): string;            // JSON
importAll(json: string): void;  // 合併，不覆蓋
isPosition(text: string): boolean; // 用 queryModeOf() 的判定，排除「全文」
```

## 6. 三個入口

1. **卡片底「＋ 存目前輸入」**：
   把 `#query.value` 存進「當前分頁」。
   - 提示分頁：按鈕隱藏（沒有可存目標）。
   - 位置分頁：需 `isPosition(text)` 為真，否則按鈕 disabled＋提示「這不是位置寫法」。
   - 此庫分頁：`add(dbname,'db', text)`；全域分頁：`add('','global', text)`。
2. **選取選單「複製」第二層加「☆ 存為位置」**（`#selMenu`，`ui.ts` 約 2625 行使用
   `citationForSelection` 之處）：
   `add(dbname,'pos', citationForSelection(sel))`。
   **這就是「引用複製，化為位置」**——不必先複製到剪貼簿。
3. **點存項執行**：
   `input.value = text; syncQueryMode();`
   位置 `void jumpByQuery(text)`、詞 `void runSearch(text)`；然後收卡。
   移除：項目尾端 `✕`，或右鍵／長按。

## 7. 要改的檔案

| 檔案 | 改動 | 大小 |
|---|---|---|
| `accelon26.template.html` | `#jumpCheatCard`（約 3119 行）內加 `.ccTabs`＋三個 `.ccPane`＋`.ccFoot`；新增 `.ccTabs` 樣式 | 小 |
| `saved-inputs.ts`（新檔） | 第 5 節的資料 API | 新檔 |
| `ui.ts` | `wireJumpCheat()`（約 1482 行）接分頁切換、渲染、點項執行；`#selMenu` 加「存為位置」 | 中 |
| 設置頁（可選） | 清空／匯出／匯入（照抄書籤的匯出匯入） | 小 |

## 8. 邊界與注意

- **只存文字**：不存 VA／行號；貼回 `#query` 即走現成語法解析，與「貼上引用複製即跳」同一條路。
- **跨庫安全**：此庫／位置以 `dbname` 分桶；全域不分庫。
- **窄屏**：卡片寬度沿用 `min(max(width,320), innerWidth-16)`；分頁過多可橫向捲。
- **無痕模式**：`localStorage` 例外一律吞掉，功能退化為不可持久，不報錯。
- **不回歸**：既有「貼上引用複製字串直接跳」「跳至語法提示 1.5 秒」都要保持。

## 9. 驗收清單

1. `13j` 搜「君子終日乾乾」→「＋ 存目前輸入」（此庫）→ 重開仍在（localStorage）。
2. 切到 `cyd`：「此庫」只顯示 cyd 的；「全域」仍顯示在 `13j` 存的（跨庫不必重打）。
3. `yinshun` 選字 →「☆ 存為位置」→「位置」出現 `y38p…`；點它 → 正確跳到並塗字元色帶。
4. 貼「引用複製」字串到 `#query` 仍能直接跳（既有行為不回歸）。
5. 空輸入 focus：有存項就出卡；沒存項時「提示」分頁仍 1.5 秒才出、不閃。
6. 無痕模式不報錯；窄屏卡寬正確。
7. 每桶超過 100 項時最舊的會被汰除；同字重存不會重複。

## 10. 落地順序建議

1. 先寫 `saved-inputs.ts`（純資料層，不碰共用 UI），附簡單自測。
2. 等 `accelon26.template.html` 的並行改動收斂後，再加卡片分頁與 `ui.ts` 接線。
   （本功能剛好要動 `template` 與 `ui.ts`；若同時有別的改動在同一批檔案，先協調，
   避免覆蓋未提交的變更。）