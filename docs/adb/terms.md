# 術語標記（`<术 sk|pi|tb="外語">漢詞</术>`）的共用機制

作者 2026-11-01：**所有含梵／巴／藏對照的 adb 都走這一套**，不要每個庫各寫一份。

## 檔案

| 路徑 | 內容 |
|---|---|
| `data/terms.tsv` | **常用詞表**（canonical）。一行 `漢詞 \t 語言(sk/pi/tb) \t 外語`，約 3,300 條，作者可直接編輯 |
| `data/term-fixes.tsv` | **明確修正表**（錯的寫法 → 正確寫法）。`fix` 只依這張表，不猜 |
| `ts/src/terms/terms.ts` | 共用實作：`loadTerms`／`loadFixes`／`applyTerms`／`fixTerms`／`buildGlossaryRows`／`glossaryLines` |
| `ts/tools/terms.ts` | 命令列入口（下面） |

## 命令列

```bash
# 1) 自動標注：給「還沒有 <术>」的文字（docx 轉出來的標記）
bun run tools/terms.ts apply --text out/05B.txt            # 只報告
bun run tools/terms.ts apply --text out/05B.txt --write    # 寫回

# 2) 修正斷詞：給「已經有 <术>」的文字（CBETA <foreign> 轉出來的 ys 等）
bun run tools/terms.ts fix --text build/ys-linked.txt --write

# 3) 產生 glossary 容器內容（JSON Lines）
bun run tools/terms.ts glossary --text out/05B.txt --out out/glossary.jsonl

# 4) 只檢查現況
bun run tools/terms.ts check --text out/05B.txt
```

`--terms`／`--fixes` 可以指向別的檔案（consumer 的 vendored copy）；預設吃 `data/` 這一份。

## 規則

**apply**（自動標注）
- 只在「文字片段」比對：跳過 `<…>` 標籤與 `<聯>…</聯>` 晶片；已經有 `<术>` 的行不重做。
- 最長優先、不重疊；漢詞至少 2 字（詞表已過濾）。

**fix**（修正既有標記）
- 多包：標籤內文字是 `term-fixes.tsv` 的錯誤寫法、且正確寫法較短 →
  把前面多出來的字搬到標籤外（`<术>得四增上心</术>` → `得<术>四增上心</术>`）。
- 少包：正確寫法較長、且標籤前剛好是缺的那幾個字 →
  把前面的字吃進標籤（`無所有` + `<术>心三昧</术>` → `<术>無所有心三昧</术>`）。
- 不做「猜」的規則；要更寬的處理請先加進 `term-fixes.tsv`（或 `data/terms.tsv`）。

**glossary**
- 同（語言＋外語＋漢詞）只留一筆並累計次數；位置記 `line`／`page`／`off`／`hanline`。
- 漢字只算 BMP（與閱讀器 `domPosInLine`、`xref.ts` 的 `HAN_RE` 一致）；
  擴充 B 區的字（如「𩜁」）目前不計，否則跳頁位置會偏。

## 詞表的來源與維護

- 初始版本由 ys.adb 的 `glossary` 容器清理而來（剝掉 CBETA 標記順手包進去的動詞／虛詞、
  丟掉句子片段），再加上作者人工修正。
- 詞表是純文字，**作者直接編輯即可**；改完重跑 `apply`／`fix` 與該庫的打包。
- 產生器（fuyan 端）：`python src/build_terms.py`，輸出 `data/terms.tsv` 與 `data/term-fixes.tsv`，
  再複製到這裡；canonical 以這裡為準。

## 消費端

| 庫 | 用法 |
|---|---|
| fuyan | `docx2accelon.py` 產生標記後跑 `terms.ts apply`；打包時 `glossary.ts` 建容器（或直接用 `terms.ts glossary` 的輸出） |
| ys | `build.ps1` 在 `addj.ts` 之後、`check-links.py` 之前跑 `terms.ts fix --write` |
| 其他 | 只要正文是中文、有梵／巴／藏對照，都照同一套：先 `apply`（新文字）或 `fix`（舊標記），再打包 |
