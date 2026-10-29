# wxzj.adb（卍新纂續藏經）產生步驟

> 2026-10-29 依 **CBETA XML-P5 2026.R2** 重建。來源是 `D:\2026\xml-p5\X` 的 X 藏 TEI；
> 產物部署到 `D:\accelon3\wxzj.adb`。

## 成品（2026-10-29，CBETA 2026.R2）

| 項目 | 數值 |
|---|---|
| 檔案 | 235.3 MiB（246,706,405 bytes） |
| SHA-256 | `f4f1cbc999535d51362ed432073df3d5919555465920171b622c967eb8ba1ad9` |
| 文字 | 4,262,487 行 |
| 冊／書／卷 | 86／1,236／8,937 |
| 頁欄（`<頁 id>`） | 172,794（全部唯一） |
| tokens | 23,391 種／83,654,260 筆 |
| 標記 | 30 種 |
| resources | `wxzj_logo.png`（273,121 bytes） |
| 檔頭 | `dbname=wxzj`、`dbcname=卍新纂續藏經`、`dbtype=4`、`srcBlockSize=16384`、`compression=1` |

> **純經文底座**：只跟 CBETA 換版；本專案的功能標記不放這裡。

## 指令

```bat
:: 1) X TEI → 文字（約 5 分鐘；X06、X52 是空目錄，會自動跳過）
build\tei2adb.exe -tei D:\2026\xml-p5\X -canon X -vol 1-88 -release 2026.R2 -out build\wxzj-tei-2026R2.txt

:: 2) 文字 → adb（最後一個空字串＝不加 posmap align）
bun run ts/tools/tei-pack.ts build\wxzj-tei-2026R2.txt build\wxzj-2026R2.adb wxzj 卍新纂續藏經 logo\wxzj_logo.png ""
```

`-canon X` 會：

- 選用 `xHeader`（`dbname=wxzj`、舊 wxzj 的 7 棵樹與 `<引>`）。
- 讀 `X01`…`X88` 目錄；`X06`、`X52` 沒有檔案，跳過。
- 冊名沿用舊 wxzj 的 86 個名稱（`x01.經部、律部` … `x88.史傳部十四`）。
- X 藏的 `cb:div type="commentary"｜"orig"｜"w"｜"note"` 歸到 `其他`；
  `<note>` 元素、`<app><rdg>` 等校勘仍照舊丟棄。
- X 藏同時有 `ed="X"` 與 `ed="R"` 的 `pb`／`lb`；只採用 X 的頁碼，
  且同一頁 id 只保留一次（避免 R 對照頁把 44p521b 之類重複數十次）。

## 2026-10-28 重建新知（X 藏特有）

1. **X 藏頁碼有兩套**：`<pb ed="X">` 是卍續藏頁碼，`<pb ed="R">` 是嘉興藏對照頁碼；
   `<lb>` 也常同時有 `ed="X"`／`ed="R"`。只取 `ed="X"`，R 只作對照，不進 adb。
2. **R 頁碼會讓頁 id 重複**：若連 R 的 `pb` 都收，`44p521b` 這類頁 id 會重複數十次；
   只收 X 後還要再按頁 id 去重（全域一次）。
3. **沒有 `<pb>` 的檔案不能拿 R 的 `<lb>` 補頁**：`ed="R"` 的 lb 會在同一行反覆切換頁欄，
   造成 `44p521b`／`44p634b` 交替重複；X 的 lb fallback 也只認 `ed="X"`。
4. **X 的 div 類型比 T 多**：`commentary`、`orig`、`w`、`note` 都歸到 `其他`
   （舊 wxzj 的 `其他` 本來就是最大宗）；`taisho-notes`、`<note>`、`<rdg>` 仍丟棄。
5. **X06、X52 是空目錄**：來源有 88 個 X 冊目錄，實際有檔的是 86 冊，和舊 wxzj 一致。
6. **冊名不是放諸四海皆準**：X 冊名要用舊 wxzj 的 `x01.經部、律部` … `x88.史傳部十四`，
   不能拿 T 藏的部名表。
7. **驗收要看頁 id 唯一性**：`attributes/頁.id` 的 unique 數要等於 tag 數；
   這次 172,794 頁、unique 172,794。

## 驗證

```bat
go run ./cmd/abx inspect build\wxzj.adb
bun run ts/tools/probe-adb.ts --adb build\wxzj.adb --query 般若
```

實測：

```text
db=wxzj，目錄 86 列
第一冊 x01.經部、律部
第 1 頁 id=1p1a，正文「圓覺經佚文…」
般若：28,190 筆命中，23 群（依冊），consoleErrors=null
```

## 部署與回退

```bat
:: 部署（若 accelon26 正開著舊檔，先關閉或重新啟動；Windows 會鎖住 mmap）
copy /Y build\wxzj.adb D:\accelon3\wxzj.adb
```

這次部署前的舊檔保留在：

- `D:\accelon3\wxzj.adb.old-2026-10-28`
- `build\wxzj-old-2026-10-28.adb`

## 與 2008 舊檔的差異

- 文字、頁欄、書名來自 CBETA XML-P5 2026.R2，不再沿用 2008 XML。
- 舊檔 281,237,612 bytes／4.4M 行／1,253 書；新檔 235.3 MiB／4,262,487 行／1,236 書。
- 頁欄 172,662 → 172,794（只取 X 頁碼，R 對照頁不進 adb；全部唯一）。
- 校勘只取 CBETA 採用讀法；缺字仍是 `&CB…;` 佔位。
