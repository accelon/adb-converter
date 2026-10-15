# adbview 交接文件（2026-02，給下一個對話）

純瀏覽器 `.adb` 檢視器原型。**單檔 HTML，可從 `file://` 雙擊開啟**，無伺服器、無 sidecar、無 npm 依賴。
所有資料來自 `Blob.slice().arrayBuffer()` 隨機讀取。

---

## 1. 建置與測試指令

```powershell
cd D:\2026\adb-converter\ts

# 建置（產出 ../build/adbview.html，約 155 KiB 單檔）
bun run tools/build-viewer.ts

# 瀏覽器端（file:// 真實測試；--port 每次換一個避免殘留）
bun run tools/file-protocol-test.ts --adb ..\13j.adb --port 9601
bun run tools/file-protocol-test.ts --adb D:\accelon3\yinshun\yinshun.adb --port 9602
bun run tools/file-protocol-test.ts --adb D:\accelon3\fgdict.adb --port 9603
bun run tools/browser-test.ts --adb D:\accelon3\yinshun\yinshun.adb --port 9604   # http 來源

# 單元測試（Bun，不需瀏覽器）
bun run test/vapa.test.ts --adb ..\13j.adb
bun run test/adbview.test.ts --adb ..\13j.adb
bun run test/search.test.ts --adb ..\13j.adb
bun run test/search.test.ts --adb D:\accelon3\yinshun\yinshun.adb
bun run test/tree.test.ts                     # 13j + yinshun 兩庫
bun run tools/verify-vapa.ts --adb ..\13j.adb --max-hits 2   # VA 對帳（13j 需 100%）
```

**每次跑瀏覽器測試前必須清場**，否則 CDP websocket 會 `ws error`：

```powershell
Get-Process msedge -ErrorAction SilentlyContinue | Stop-Process -Force
Remove-Item -Recurse -Force D:\2026\adb-converter\build\.chrome-profile* -ErrorAction SilentlyContinue
```

## 2. 檔案地圖

| 檔案 | 角色 |
|---|---|
| `ts/src/adbview/adb.ts` | 格式核心。`AdbIO.read(offset,length)` 是唯一原語；`BlobIO`（瀏覽器，含 **128 KiB 區塊快取**）／`SyncIO`（Bun）。容器／長度表／名稱表解析、`tokens()`、`documents()`、`attributeValues()`、`decodeUtf16()` |
| `ts/src/adbview/vapa.ts` | **VA↔PA 映射器**。`init()`、`elementAt`、`lineSpans`、`phraseSpans`、`textOfVaSpan`、`nodeLabel`、`lineLengthPercentile`、`loadAnchors`、`validate` |
| `ts/src/adbview/search.ts` | 搜尋：`loadTrees`（`<樹>`）、`parseScope`／`parseTiers`、`loadInstanceAttrs`（屬性指標查表）、`loadTree`（逐實例 `t=`）、`buildTree`／`flattenTree`、`phraseMatch`、`searchSummary`、`SearchSession` |
| `ts/src/adbview/viewer.ts` | UI（原生 DOM，無框架）：三分頁欄、目錄樹、頻次、西文、摘要、字級、進階模式 |
| `ts/src/adbview/adbview.template.html` | 版面與 CSS（由 build 內嵌） |
| `ts/tools/build-viewer.ts` | 把 UI 打包成**傳統 script 並 inline** 進單一 HTML |
| `ts/src/tokenize.ts`、`ts/src/unicode.ts` | 分詞器與 Unicode 判定（照 Delphi 移植） |

## 3. 已驗證的格式知識（可直接信任）

* **VA（虛擬位址）= token 序號**：token +1、連續空白 +1、標籤開／閉**各 +4**、skip 標籤 +0。
* **PA（實體位址）= blockIndex × srcBlocksize + 區塊內位移**（UTF-16LE，srcBlocksize 16384）。
* **硬換行不佔 VA** → 被硬換行切開的中文詞是**連續的 VA 範圍**（13j 行界 90.5% 的 VA 差恰為 1）。
* **版面模型＝自訂標題（h1~h6 的推廣）**：標籤＝一行標題、**不包住內容**；範圍＝**到下一個同樣的標籤**（沒有就到 `</檔>`）。
  因此「同標籤不互相巢狀」是可驗證的不變量（13j 0 個、yinshun 0 個）。
* **`t=` 是逐實例宣告**，沒宣告的實例在該處停止下探；`t="章,節,項."` 的**第一項是直接子層**，
  其餘是**同層兄弟槽位**（會**繼承**到子層之下，所以 `章` 即使沒有 `t=` 也能收 `節`/`項`）。
  宣告只寫一次（13j 的 13 本書只有第一本帶 `t=`），其餘同標籤實例沿用。
* **`s=` 的種類**（Pascal `formatter.pas:1472 createSearchSchemes` + `tokenize.pas:717 parseTAV`）：

  | `s=` | 意義 | 現況 |
  |---|---|---|
  | `*` | 全文 | ✅ 分頁「目錄」（搜尋摘要移到右欄「摘要」） |
  | `*u=文` | **屬性過濾**（attr `u`, value `文`）→ 收集所有 `<tag>.u` 表值為 `文` 的實例 | ✅ 分頁「頻次」（yinshun 6,978 段／40 個標籤） |
  | `*文` | **標籤名** → `<文>` 的實例 | 未接（fgdict 是 `*詞`，22,648 段） |
  | `~X` | **token 清單**：`settoken(adb, X)`，X 是**字面 token 名**（**不是**碼點範圍） | ⚠️ 分頁「西文」已建但內容為空（見待辦） |
  | `$詞` | 標籤包裹（`parsetav` → tag `詞`），允許 tofind 出現在詞首／中／尾 | 未接（fgdict 有） |
  | `@X` / `^X` / `%` | 字表／主題表／反向連結 | 未接 |
  | `頁.n` | `tag.attr`：樹從 `<頁>` 起，名字取 `n` 屬性 | 未接（fgdict 有） |

  另有 `t`（subtree）、`p`（paging）、`o`（columns）三個屬性**尚未讀取**；
  **分頁名應取 `<樹>…</樹>` 的元素內容**（`ss.caption := removetag(getnNodeValue(dn))`），
  目前是用 `s=` 推導（fgdict 的三個 `<樹>` 內容都是空的，需要 fallback）。
* **屬性容器是「不掃內文」的關鍵**：`attributeValues(key)` 回傳的 `pointers` 低位 24 bits 是
  **1-based 實例序號**、高位 byte 是 tag id，所以每個屬性值都能直接對應到 `tags` 容器的實例。

## 4. 效能（已解決的兩件大事）

**開檔**：yinshun 24 MiB 原本 **3,525 ms → 60 ms**。原因不是 SSD、不是解壓，而是
`Blob.slice()` 被呼叫 **10,489 次**（每次約 0.33 ms 固定成本，與長度無關）。
`BlobIO` 加 128 KiB 區塊快取後降到 **19 次**。
細分可用 `window.__adbview.openBreakdown()` 或 `state()` 取得（狀態列只顯示人看得懂的資訊）。

**自動字級（「不換行」）**：可用寬度必須取**中間欄**（`docTextWidth()`，扣除左右欄與列內 gap）；
量測必須在**無寬度約束**的容器（把探針放進 `.docBody` 會被裁到欄寬，導致算出荒謬的 40px）。
上限只約束「常見長行」（≤1.4×P90），超長行容許橫向捲動。

## 5. 目前測試狀態

| 測試 | 結果 |
|---|---|
| `file-protocol-test.ts`（13j） | **61/61** |
| `file-protocol-test.ts`（yinshun） | 62 passed, **2 failed** |
| `file-protocol-test.ts`（fgdict） | 57 passed, **3 failed** |
| `browser-test.ts`（http, yinshun） | 19/19 |
| `test/tree.test.ts` | 40/40 |
| `test/search.test.ts`（13j / yinshun） | 19/19、17/17 |
| `test/adbview.test.ts` / `test/vapa.test.ts` | 22/22、13/13 |

## 6. 待辦事項（依建議順序）

### P0 — 已診斷、待修

1. **fgdict 的 6/7 本書名取不到**（`#2`…`#7` fallback），連帶 3 個測試失敗。
   fgdict 有 `書.l`、`書.t`、`頁.n` 屬性表，但我目前只用內文取名。
   → 讓 `nodeLabel` 先查 `<tag>.n`／`<tag>.l` 屬性（用 `attributeValues` 的指標對到實例序號），失敗才走內文。
2. **「西文」分頁清單為空**（`latinMeta` 與列表皆空 → `renderLatin` 走進「找不到 `s="~…"` 樹」分支）。
   → 先用 `state().scopes`（診斷欄位仍在）確認 `~` 那棵樹有沒有進 `dirTrees`，
     再查 `loadTree` 對它是否回傳 0 個實例。註：Pascal 的 `~X` 是 `settoken`（字面 token 名），
     與先前「U+0060–U+2000 碼點範圍」的理解不符，**需要作者確認語意**。
3. **「頻次」查詢路徑沒有可信的自動驗證**：測試在 `input` 事件後輪詢 `#freqList .snippet`，
   但未輸入狀態的清單本來就非空，所以立刻通過、讀到舊值。
   → 改成輪詢 `#freqMeta` 內容含「命中」。**用 `edit` 工具逐字改，不要用 PowerShell 字串取代**（見 §7）。
   功能碼本身已寫好（全庫 `session.search(q)` → 二分搜尋歸段 → 依命中數排序 → 0 不顯示）。

### P1 — 未實作的規格

4. **`$詞` 分頁**（fgdict）：分段＝`<詞>` 的 22,648 個實例，命中＝落在段內者，段名＝包裹的 innerText。
   **`*詞` 與 `$詞` 在我的實作會相同** —— 需向作者確認 `*詞` 是否要求「命中從詞首開始」。
5. **`頁.n`（tag.attr）scope** 與 `@`／`^`／`%` 三種。
6. **讀 `<樹>` 元素內容當分頁名**，並讀 `t`/`p`/`o` 屬性（`o` 是 columns）。
7. **目錄樹與頻次改為純屬性查表**：目前節點名稱仍會走內文（13j 的 `書.n` 不存在，
   但 `書.l`/`頁.n` 之類可用），fgdict 6,978 段的取名已限制在顯示的前 200 列。

### P2 — 測試覆蓋缺口

8. 「Ctrl 展開後收合，再展開不該還開著子孫」（已修，無斷言）。
9. 「點標籤型節點（VA 指向 tag，`lineSpans` 回空陣列）也要捲到該行」（已修，無斷言）。
10. 測試改成**資料庫感知**：書數（13/44/7）、有無「頻次／西文／`$詞`」分頁都依 `s=` 宣告決定，
    不要寫死 13 本或「右欄預設關閉」這類假設。

## 7. 工作注意事項（踩過的坑）

* **不要用 PowerShell 的 `Get-Content`/`Set-Content` 或 `-replace` 改 `.ts`**：
  本專案檔案是 UTF-8 無 BOM，PS 會把中文變亂碼、也曾把程式碼改壞成語法錯誤。請用編輯工具逐字改。
* **測試的 page-eval 字串內不要放 TypeScript 型別註解**（`const x: number[]`），
  也不要用未轉義的 `${}`／反引號 —— 兩者都會造成 `SyntaxError`。
* 瀏覽器測試之間的**時序**：繪圖是非同步的，請輪詢「結果特徵」而不是固定 `setTimeout`；
  也不要輪詢「本來就非空」的元素。
* CDP 啟動參數必須含 `--remote-allow-origins=*`，否則 websocket 握手失敗。
* 測試用的診斷入口都在 `window.__adbview`（`state()`、`openBreakdown()`、`fitDebug()`、
  `pinnedSpans()`、`treeDebug()`、`debugDoc()`、`setCols()`、`setAdvanced()`、`showTab()`）。
* `.gitignore` 已排除 `*.adb`、`build/`、`sourcecode/`，所以資料庫與建置產物不會進版控。

## 8. 主要資料庫

| 檔案 | 大小 | 特色 |
|---|---|---|
| `D:\2026\adb-converter\13j.adb` | 2.25 MB | 十三經。單檔、13 書、四層（書→章→節→項 2,020 節點） |
| `D:\accelon3\yinshun\yinshun.adb` | 24.9 MB | 印順法師全集。45 文件、456 資源、三棵 `<樹>`（`*`／`*u=文`／`~00602000`） |
| `D:\accelon3\fgdict.adb` | 18.2 MB | 佛光大辭典。三棵 `<樹>`（`$詞`／`*詞`／`頁.n`）、`<詞>` 22,648 個 |
