# 本文分頁自帶 adb 上下文：重構交接（2026-11-01）

> **狀態（2026-11-01 第二輪）：已完成。** 實作說明、實測與剩下的缺口見 §10。
> 下面的 §1–§9 保留重構前的規劃與踩坑紀錄（事後對照用）。

這份文件是「把 docTab 從全域 adb 解耦」的交接單。新對話可以只讀這一份就動工；
背景規則仍以 `AGENTS.md` 與 `docs/system/ACCELON26-HANDOVER.md` 為準。

## 1. 目標

目前點一個「屬於別的 adb」的本文分頁，會**先把整個 adb 切過去**（`switchTo`），
因為本文渲染全部依賴全域 `reader`／`mapper`／`session`。

重構後要變成：

- 點分頁＝只換本文，**不換 adb**（左欄目錄、摘要、dbChip 都不動）。
- 只有使用者按「🌲 在目錄中顯示目前位置」（`#treeReveal`）時，才把 adb 切到
  該分頁所屬的庫。
- dbChip 用高亮（不是 active）標出「目前分頁屬於這個庫」。
- 跨庫分頁可以並存：A 庫的目錄／摘要 ＋ B 庫的本文。

## 2. 現況架構

### 2.1 全域物件（問題根源）

`ts/src/accelon26/viewer.ts:33-34`：

```ts
export let reader: AdbReader | null = null;
export let mapper: VaPaMapper | null = null;
```

`session`（`DbEditSession`）同樣是全域。本文區以下函式全部直接讀這三個全域：

| 位置 | 函式 | 用全域做什麼 |
|---|---|---|
| `doc-pane.ts:635` | `ensurePage` | `mapper.linesVirtual`、`reader.header.maxBlockOffset` 算頁界 |
| `doc-pane.ts:1462` | `renderDoc` | 畫行、`docText`、xref 錨點 |
| `doc-pane.ts:1726` | `renderPager` | `pageBounds(cur.realm, cur.page)` |
| `doc-pane.ts:564-575` | `boundsCache` / `boundsOfRealm` | 快取**只以 `from:to` 當 key**（跨庫會撞） |
| `doc-pane.ts:309-325` | `ensurePageIndex` | `pageIdxReader` 單一快取 |
| `doc-pane.ts:51-85` | 圖片 URL 快取 | `imageUrlsDb === reader` 判斷換庫 |
| `doc-pane.ts:2025` | `autoFitFont` | `mapper.lineLengthPercentile()` |
| `link.ts:276` | `revealCursorInTree` | 用 `dirTrees[dirActive]`、`cursorNode`、`mapper` |
| `xref.ts` / 註解 / 反查 | 多处 | 以 `reader`／`mapper` 換算 VA↔行 |

`dbs.ts:606 switchTo(id, front, activateTab)`：`saveInto(cur)` → `loadFrom(target)`，
`loadFrom` 內會 `restoreDocPane(...)`（共享模式下跳過），`snapshotDocPane`／
`restoreDocPane`（`doc-pane.ts:2122`／`2130`）把整組分頁連 cache 一起搬。

### 2.2 分頁結構（`doc-pane.ts:211`）

```ts
interface DocSession {
  id, realm, name, page, doc, pinned, cache, editing?, autoEdit?, showDiff?, history?
  dbId?, dbName?, dbCName?   // 共享 docTab 鋪路，2026-11-01 已加
}
```

`docTabs: DocSession[]`、`docActive: number` 都是模組層級單一陣列。

### 2.3 已完成的鋪路（不要重做）

- `dbId`／`dbName`／`dbCName` 已在 `link.ts` 建立分頁時寫入。
- `sharedDocTabsOn()`／`setSharedDocTabs()`（localStorage `accelon26.shareddoctabs`，預設 **off**）。
- `setTabDbSwitchHook()`＋`switchDocTab` 目前在共享模式下**會切 adb**（`doc-pane.ts:1685-1692`）——這次要拿掉這段。
- `activateTabForDb()`／`showEmptyDoc()`（`doc-pane.ts:2073`／`2080`）。
- 每個 adb 各自的摘要還原（`summary.ts` `repaintSummary`）已完成。
- `treeReveal` 按鈕已存在（`ui.ts:1372`，`accelon26.template.html:1919`），
  目前只展開目錄樹、捲到節點；要讓它順便切庫。

## 3. 重構後的行為規格

1. **切分頁**：只做 `stageActiveEditor()` → 換 `docActive` → 用該分頁自己的 ctx 畫；
   `reader`／`mapper`／`session` 全域**不動**，左欄不重畫。
2. **切 adb**（點 dbChip／下拉選單）：只換左欄與摘要；本文分頁條保留；
   若該庫有分頁就選中它，沒有就 `showEmptyDoc()`（現行共享模式行為保留）。
3. **treeReveal**：`revealCursorInTree()` 前先確認目前分頁的 `dbId`；
   若 ≠ active slot，先 `switchTo(dbId)`（並選中該分頁）再展開目錄。
4. **dbChip**：active＝現行樣式；另外加 `dbChip.owner`（淡色外框或小圓點）
   標出「有本文分頁的庫」，**不改變 active**。
5. **關閉 adb**：一併關閉（或標記失效）該庫的所有分頁，避免持有已關閉的
   reader／mapper（mmap／Blob 無法釋放）。
6. **共享分頁開關**：關閉時回到「一個 adb 一組分頁」的舊行為；
   切庫仍走 `snapshotDocPane`／`restoreDocPane`。開啟時才允許跨庫並存。

## 4. 建議步驟（由小到大，每步可測）

1. **加 ctx，不改行為**：`DocSession.ctx = { reader, mapper, session, dbId }`，
   建立分頁時填入（同庫分頁指到同一份物件，不複製）。跑既有測試，行為不變。
2. **`ensurePage`／`fetchPage`／`pageBounds` 改吃 ctx**：先把「算頁界」這條路
   改成參數化（這是偏移錯誤最敏感的地方）。
3. **`renderDoc`／`renderPager`／`goPage`／`scrollToVa` 改吃 ctx**；
   `boundsCache` 的 key 加上 `dbId`（`dbId + ':' + from + ':' + to`）。
4. **xref／註解／反查／字典**：`openInMain`、`openCharPosition`、`openTaishoAt`
   等入口在建立分頁時帶 ctx；渲染時用分頁 ctx，不用全域。
5. **拿掉 `switchDocTab` 的切庫分支**；`treeReveal` 加切庫；dbChip 加 owner 樣式。
6. **`snapshotDocPane`／`restoreDocPane`**：ctx 不是可序列化狀態，快照只存
   `dbId`；還原時用 `openDbs` 重新解析 ctx，解析不到就丟掉該分頁。

## 5. 主要檔案

- `ts/src/accelon26/doc-pane.ts`：主戰場（`DocSession`、`ensurePage`、`renderDoc`、
  `renderPager`、`goPage`、`boundsCache`、`switchDocTab`、`snapshot/restoreDocPane`）。
- `ts/src/accelon26/viewer.ts`：`reader`／`mapper`／`session` 的 export（先保留，
  最後可改成 getter 或標 `@deprecated`）。
- `ts/src/accelon26/dbs.ts`：`switchTo`／`loadFrom`／`saveInto`／`closeDb`、
  `renderDbTabs`（owner 樣式）。
- `ts/src/accelon26/link.ts`：建立分頁處（`sessionFor`、`deepestNode`、`treeReveal`）。
- `ts/src/accelon26/xref.ts`、`dict-pane.ts`、`text-pane.ts`、`rev-list.ts`、
  `edit-session.ts`：入口帶 ctx。
- `ts/src/accelon26/ui.ts`：`#treeReveal` 綁定、dbChip 事件。
- `ts/src/accelon26/accelon26.template.html`：`.dbChip.owner` 樣式（若需要）。

## 6. 坑（實際會踩）

- **`boundsCache` key 只有 realm**：不同庫相同 `from:to` 會互相污染，必須加 `dbId`。
- **`pageIdxReader`／`imageUrlsDb`／`lastDocLines`／`paintAsked`** 都是全域單例，
  跨庫切換時要一起參數化或清掉。
- **`docActive = -1`**（`showEmptyDoc`）時很多函式假設 `docSession()` 非 null；
  重構時把「沒有分頁」當正常狀態處理。
- **非同步競態**：`ensurePage` 回來時分頁可能已被關閉或 adb 已切走；渲染前要
  重新確認 `docTabs[docActive] === s`（現有 `renderPager` 已用「點擊時再取 session」解決）。
- **編輯器**：`activeEditor.s` 指向分頁；換分頁前一定 `stageActiveEditor()`。
- **修訂 diff／歷史**：`hasEditsInRange(es, bounds)` 的 `es` 是**按檔案**的
  edit session，跨庫分頁要拿 `t.ctx.session`，不能用全域。
- **關庫**：`closeDb` 要把該 `dbId` 的分頁一起關，否則 ctx 持有 mmap／Blob。
- **桌面版 mmap**：關閉 reader 後 `mapper` 失效，任何殘留分頁再畫會炸；
  失效分頁要嘛關掉、要嘛顯示「此庫已關閉」。

## 7. 測試

- `cd ts; bun run test/verify.ts`、`bun run test/index-match.ts`。
- 手動（必做，兩個庫以上）：
  1. taisho 開一頁 → fuyan 開一頁 → 點 taisho 分頁：adb 不變、左欄不動、頁碼正確。
  2. 兩庫各翻幾頁 → 互相切分頁：頁碼、捲動、色帶、xref 錨點都對。
  3. `treeReveal`：切到分頁所屬庫並展開到該節點。
  4. 關掉其中一庫：它的分頁消失或失效，另一庫不受影響。
  5. 共享分頁開／關各跑一次（關閉時行為要與現在完全相同）。
  6. 編輯一頁 → 切到另一庫分頁 → 切回：修訂數、diff 正確。
- `cd wails; go test ./...`（本重構不動 Go，但當回歸）。

## 8. 不要做的事

- 不要每個分頁各複製一份 `AdbReader`／`VaPaMapper`（記憶體會真的爆）；只存參考。
- 不要在沒被要求時 `release`／`deploy`／commit；成品仍只放 `D:\accelon3`。
- 不要改 `openDbs` 上限（5）與 adb 格式。
- 不要把 `sharedDocTabs` 預設改成開。

## 9. 成本

- 記憶體：ctx 每分頁只多 3 個參考＋`dbId`，可忽略；真正的用量本來就是
  「已開啟 adb 的 reader／mapper」＋「每個分頁一頁 cache」。共享模式下同時
  保留較多跨庫分頁時 cache 才會增加，可加「分頁上限」或 LRU 清 cache。
- 風險：中高，集中在頁界計算（`ensurePage`／`pageBounds`）與 xref 錨點；
  建議照第 4 節逐步做，每步都跑手動案例 1、2。

## 10. 完成紀錄（2026-11-01）

### 10.1 做成了什麼

`DocSession` 現在帶一個 **`ctx`**（`ts/src/accelon26/doc-ctx.ts` 的 `DocCtx`）：

```ts
interface DocCtx {
  dbId; reader; mapper; session; docs;      // 只存參考，不複製
  dbName; dbCName;                          // hover／提示條用
  file; fileName;                           // 編輯工作階段（按檔案）與 lastRead 的 key
}
```

- 本文區一切幾何與渲染都吃分頁自己的 ctx：`wholeRealm`／`docOfVa`／`edgeLine`／
  `boundsOfRealm`／`pageBounds`／`pageOfLine`／`fetchPage`／`ensurePage`／
  `renderDoc`／`renderPager`／`goPage`／`scrollToVa`／`paintHit`／`editSessionOf`。
  這些函式改成**第一個參數是 ctx**（或 `DocSession`），不再讀全域。
- `DocCtx` 由「左欄那一庫」（`activeDocCtx()`，全域 reader/mapper/session/docs）
  或 slot 快照組出來。`doc-pane` 不能 import `dbs`（會成環），所以：
  - `dbs.ts` 註冊 `setDocCtxResolver(ctxOfSlot)`：由 `dbId` 找回 ctx（還原快照用）。
  - `dbs.ts` 在 `loadFrom`／`registerOpenDb`／`closeDb` 同步 `setActiveDocDbId()`：
    `isActiveDocCtx(ctx)` 就是「這個分頁是不是左欄那一庫」。
- **頁界快取 key 加了 dbId**（`boundsKey = dbId + ':' + from + ':' + to`），這是原本
  最容易出錯的地方（不同庫相同 `from:to` 會互相污染）。
- 全域單例改成**跟著 reader 走**：`pageIdxCache`／`pageImages` 都是
  `WeakMap<AdbReader, …>`；關庫時 `dropPageImages()` 撤銷 blob URL。
- `editSessionOf(ctx)` 用 `ctx.file`，所以跨庫分頁的修訂數／diff／歷史是那一庫自己的。
- `switchDocTab` **不再切 adb**（`setTabDbSwitchHook` 已移除）。切到別庫的分頁
  只換本文；左欄目錄、摘要、dbChip 都不動。

### 10.2 只有「同一個庫」才有的裝飾

跨庫分頁（`!ownsActiveDb(s)`）時**不畫**這些（它們的資料都屬於左欄那一庫，
拿別庫的 VA 去查只會得到錯的節點）：

| 功能 | 跨庫分頁的行為 |
|---|---|
| 麵包屑 `renderAncestorTrail` | 改成提示條「本文來自《庫名》」＋「🌲 到它的目錄」鈕（按下去等於按 header 的 🌲） |
| 目錄游標 `paintTreeActive`／`syncCursorFromScroll` | 不動（`paintTreeActive` 自己會先判斷） |
| 回連結（反鏈） `paintReverseBar` | 不畫 |
| pager 的「上／下一個節點」`hasRealmNeighbor` | 不亮（鄰居來自目錄樹）；同庫分頁照舊 |
| `stepRealm` | 跨庫分頁直接回 false（不會誤跳） |

分頁條上，別庫的分頁加 `.docTab.foreign`（虛線下緣＋`⇄`），一眼看得出。
dbChip 則加 `.owner`（淡金外框＋小圓點）標「這個庫有本文分頁」，**不改 active**。

### 10.3 切庫／關庫

- **`treeReveal`（header 🌲）是唯一會因為本文而切庫的動作**：先看目前分頁的
  `ctx.dbId`，≠ active 就 `switchTo(dbId, false, 該分頁 index)`，再用
  `cursorNodeOf(s)`（本文中間那一行 → 節點）展開目錄。順帶修好一個舊問題：
  以前沒先捲動過目錄就不會動，現在一定會展開到目前位置。
- `closeDb` 先 `closeTabsForDb(dbId)`（一起關掉它的分頁、撤銷圖片），再移除 slot；
  `registerOpenDb` 取代同名庫／LRU 淘汰時也一樣。
- `openFile` 的收尾不再一律清空分頁條（`refreshDocTabsAfterOpen()`）：共享分頁
  開啟時，別的庫的分頁要留著；沒有分頁才整條收起。
- 共享分頁**關閉**時行為與以前完全相同：切庫仍走 `snapshotDocPane`／`restoreDocPane`，
  `restoreDocPane` 會用 `resolveDocCtx(dbId)` 重建 ctx，解析不到（庫已關）的分頁丟掉。

### 10.4 驗證

- `cd ts; bun run test/verify.ts`：12 passed。
- `cd ts; bun run test/index-match.ts`：token 索引 identical；`tag hits total` 的
  FAIL 是**既有**落差（`needs the docdef tag formats`），與本文區無關。
- **新工具** `cd ts; bun run tools/doctab-cross-test.ts`（24 項，全綠）：
  13j ＋ jingang-group 兩庫，實測 §3 的 1–6 條與共享分頁關閉時的舊行為
  （含：切分頁時 dbChip active 不動、左欄目錄列數不變、頁數是分頁那一庫的、
  `foreign` 標記、🌲 切庫、關庫連帶關分頁、關庫後 owner 減少、切走時記住捲動位置）。
  用法：`bun run tools/build-viewer.ts --o ../build/accelon26.html` 之後再跑。
- `cd ts; bun run tools/file-protocol-test.ts`（file:// 全餐）：**167 passed, 0 failed**，
  含「no page exceptions」。
- 迴歸：`tools/pager-cross-test.ts`、`tools/note-click-test.ts`、
  `tools/foreign-links-test.ts` 都 ok；`cd wails; go test ./...` ok。

### 10.5 順手修掉的既有測試債

`tools/file-protocol-test.ts` 有 8 個斷言在這一輪之前就已經是錯的（測的是更早被
拿掉的東西），會讓整個 file:// 測試卡在 `getComputedStyle(null)` 而跑不完。已按
**現在的實作**更新（每一處都有註解說明為什麼）：

| 舊斷言 | 現在 |
|---|---|
| `#dbHint` 文字是「← 開啟資料庫」 | 「← 按 📁 下載或開啟資料庫」 |
| 「進階模式」在設置頁「介面」分頁的最後一列 | 2026-10-31 重整成獨立的「進階」分頁 |
| 設置分頁固定 4 個（`介面｜辭典順序｜標籤樣式｜繁簡`） | 7 個（多了閱讀／進階／悉曇） |
| 麵包屑字級＝內文 | 0.86 倍（長路徑少佔寬度） |
| 一般文本要有 `.docHead` | 2026-10-31 起閱讀模式不畫 docHead |
| 「顯示原書頁碼」在 `section.setSection` 的「介面」區 | 設置頁改成分頁式 |
| 正文字級鈕在 `#docBar` | `.docTabTools`（分頁列右端） |
| 「點擊查字典」開關 `#setDictAuto` | 2026-10-28 起改由選取後浮動選單觸發，開關已無 |
| `#hbToggle`（原書分行的列） | 設定列改成 label 包住 checkbox |
| 點有命中的節點 → 開「那一節」 | 2026-10-31 起先跳到它的第一筆命中（realm 是整個檔）， 測試改成先清搜尋再點 |
| 右欄捲動不連動左樹：一按完就讀 `cursorNode` | 那是「下一幀」才定下來的，改成先等 600ms 再讀（中間那一欄換分頁也是非同步的） |

### 10.6 還沒做的事（留給下一輪）

- **跨庫分頁的 xref／註解／字典**：`revealDocLine`（`<註>`／腳注連動）與
  `linkToEntry`（`<聯 n="詞條">`）已經跟著本文分頁的 ctx 走；還沒跟的是
  `xref.ts` 的 `reverseItemsOf`／`openCharPosition`／`pageMarkerLine` 這幾支
  （它們吃「頁 id」與反鏈表，屬於左欄那一庫；跨庫分頁目前只是不畫回連結）。
  要做的話照 `linkToEntry` 的做法：入口多一個 `ctx?` 參數、內部改用 `ctx.reader`。
  至於 `openInMain`／`openTaishoAt`／`xrefJump` 這一類**「跳到別的庫」**的入口，
  本來就會 `activateDb()` 切庫（那是它們的用途，也是 §3.2 允許的切庫），所以
  不需要 ctx；只有「留在同一個本文分頁裡、但要查庫內資料」的才需要。
- **跨庫分頁的摘要（Summary）**：右欄摘要永遠是左欄那一庫的；要不要跟著分頁
  走（作者未定）。右欄「文字內容」與「詞典」也算同一個問題 —— 目前刻意都跟左欄。
- 共享分頁打開時的「分頁上限／LRU 清 cache」（§9 提過，還沒需要）。
- 桌面版（mmap）實機驗證跨庫分頁；目前只用 file:// 版測過。

