# 詞彙表（`glossary`）：漢梵對照 + 直接跳位置

> 2026-10-31 定案。資料端在 `D:\2026\ys`（`glossary.ts` + `pack.ts`）與
> `D:\2026\fuyan`（共用 `ts/src/terms/terms.ts`），閱讀器端在
> `ts/src/accelon26/glossary.ts`、`scopes.ts`（`renderGlossary`）、`bookmarks.ts`
> （選取選單）、`summary.ts`（西文查詢）。
> `ys.adb` 已於 2026-11-01 發布；`fuyan.adb` 的 `glossary` 於同日重建。

## 1. 容器格式

外層容器 `glossary`，1 個 block、**未壓縮** UTF-8 JSON Lines：

```text
["GLOSSARY1", 4105]
["sk","Ābhāsvāra","光音天",1,279653,"38p0077a",148,6]
```

欄位：`lang`（`sk`／`pi`／`tb`）、`foreign`、`han`、`count`、`line`（1 起）、
`page`（`<頁 id>`）、`off`（該頁第幾個漢字，0 起）、`hanline`（該行第幾個漢字，0 起）。

- 漢字計數**先剝掉標籤**（`<[^>]*>`），跟閱讀器 `ts/src/accelon26/han.ts` 的
  `hanChars()`／`hanCount()` 一致：**逐 code point**（擴充 B 區的代理對算 1 個）；
  否則 `<术>`／`<註>` 本身的漢字會被算進去，位置越跳越遠。
- 同（語言＋外語＋漢詞）去重，`count` 累計，位置取第一次出現。
- 舊版 `ys.adb` 沒有這個容器，閱讀器就不顯示「詞彙」分頁（向下相容）。

## 2. 閱讀器行為

| 位置 | 行為 |
|---|---|
| 左欄「詞彙」分頁 | 只有庫裡有 `glossary` 才出現（`hasGlossary()`） |
| 排序選單 | 漢語＝依漢詞、外語＝依外語（都忽略變音符號；用預先算好的 `simp`／`fold`） |
| 位置選單 | 任意／開頭／中間／結尾（漢語外語通用） |
| 每列 | 圓圈小字「梵／巴／藏」放在**外語前面**；選外語排序時外語在前 |
| 點整列 | **直接跳到該詞第一次出現**：`openCharPosition({ anchor:'L'+(line-1), a:hanline })`；沒有 `hanline` 才用頁＋`off`，再不行才整行跳 |
| 列尾 🔍 | 全文檢索（`runSearch()`），不改輸入區 |
| 選取文字 → 查看 | 漢詞→每個對應外語一顆「查 …」；外語→每個漢詞一顆；按下用**詞典**查（`openDictLookup`），不改「詞彙」輸入區 |
| 全文搜尋打西文 | 若全是拉丁字母，先用詞彙表換成漢詞（候選最多 4 個，逐一試），摘要附註換詞 |

## 3. 效能（2026-10-31 實測）

- `loadGlossary()`：4,081 列約 50 ms（第一次開；WeakMap 快取）。
- 每次查詢＝篩選＋排序＋組 HTML 約 **1 ms**（預算 `fold`／`simp`，字串比較不用 `localeCompare`）。
- 首屏只畫 80 列，其餘「顯示更多」（WebView 一次排版 300 列會卡）。

## 4. 已知限制

- `openCharPosition({anchor:'L'+n})` 的 `n` 目前是 **0 起**（`linesVirtual[n]`），所以呼叫端傳 `line-1`。
  若哪天閱讀器改成 1 起，這裡要一起改。
- 頁＋`off` 那條路在 ys 會出現「找不到頁標記」（`pageMarkerLine` 只檢查該行與前一行），
  所以優先用「行號＋`hanline`」。
- 塗色終點是 inclusive：`highlightCharBand()` 的終點用 `domPosInLine(..., after=true)`，
  呼叫端傳「最後一個字的索引」；這也修好了「跳至 j 範圍」少塗一個字的舊問題。
- 詞表本身仍有少量雜訊（單字詞、長詞），見 `D:\2026\ys\build\term-table.tsv` 與
  `remaining-one-char-terms.tsv`；那是術語抽取的長尾，不影響容器格式。

## 5. 重建與驗證

```powershell
# 資料端（會寫 D:\accelon3\ys.adb，不發布）
pwsh D:\2026\ys\build.ps1

# 閱讀器
cd D:\2026\adb-converter\ts
bun run tools/build-viewer.ts        # 預設輸出 D:\accelon3\accelon26.html
bun test test/render.test.ts
```

驗證：

1. 開 `D:\accelon3\accelon26.html`，選 `D:\accelon3\ys.adb`，左欄應有「詞彙」。
2. 查 `涅槃` → 排序／位置選單可用；點一列跳到第一次出現且**整詞塗滿、不含標點**。
3. 全文搜尋打 `apalala` → 摘要顯示「（西文「apalala」→ 阿鉢羅…）」並列出命中。
4. 選取「光音天」→ 查看 → 「查梵語 Ābhāsvāra」→ 詞典開啟該外語。

## 6. 目前狀態（2026-11-01）

| 項目 | 值 |
|---|---|
| `D:\accelon3\ys.adb` | 28,289,175 bytes、SHA256 `3F55ACE26791D7BD…`、**已發布**（ys 工作區） |
| `glossary` | 4,105 列（ys；fuyan 988 列） |
| `accelon26.html` | `D:\accelon3\accelon26.html` |
| 線上 ys.adb | 與本機同一個 `3F55ACE2…`（2026-11-01） |
