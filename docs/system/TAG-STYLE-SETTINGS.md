# 標籤樣式設定（設計稿＋mockup）

> 狀態：**已實作（2026-10-22）**；設計稿保留作規格，實作重點與驗證見交接文件 §15。
>
> **2026-10-22 作者回覆（定案）**：
>
> 1. 設置用**分頁**（介面／標籤樣式／繁簡）；2. 覆寫以**整個標籤**為單位；3. 「各 adb」的鍵＝**adb 檔名**（重建 adb 不會動到設定）；
> 4. 自訂顏色**也套到目錄色點與 breadcrumb**；5. `settings.json` v1 只放**標籤樣式**（主題／繁簡留在 localStorage）；
> 6. 字型：**exe 列出使用者已安裝的字型**，html 版只列**內建已知字型**；
> 7. 大小上限 300%、auto 維持 180%；8. 沒有 `s="*"` 樹的庫仍顯示頁面，但只給全域預設清單；
> 9. 設置視窗 **940px**。
>
> 另外：**天干地支是同一個設定（共 22 層）**——從使用者指定的底色開始，**每深一層色相 +30°**（只轉色相，飽和度／亮度不變）。
>
> **2026-10-22 第二輪調整（現行設計）**：
>
> 1. 標籤樣式最上面多一列**本文**：顏色、字級（**pt**，8–30）、字型。本文的字級存在
>    `tagStyle.body.size`（per-adb 可覆寫；沒自訂時用文件字級 `DOCFS`）；標籤的大小仍是
>    **本文的百分比**。
> 2. **移除預覽卡**：每一列的 `.tchip` 直接示範該標籤（字型／顏色／字級）；**天干地支只示範
>    「甲」**，不再畫 22 格 ramp（22 層的色相推算保留）。
> 3. 內置標籤增加 **文、項、部、經**；**\<經\> 沒有自訂字型時預設楷體**
>    （`DFKai-SB`／`KaiTi`／楷體堆疊）。
> 4. 主題「護眼」改名**春綠**；新增**秋黃**（黃棕紙色）。
> 5. 本文的顏色／字型／字級都存在 `tagStyle.body`（settings.json v1 的 additive 欄位）。
>
> * mockup：`ts/mockup/tag-style-settings.html`（單檔、離線可開；用 Edge／Chrome 雙擊即可）
> * 需求原文：設置頁面增加一分頁，設定渲染標籤的**顏色**、**相對本文的大小（%）**、**字型**（第二種當第一種缺字時的 fallback）；有 global setting（已知標籤：章 節 篇 書 詞 天干地支），預設 **auto style（按層次塗色）**；也可以為各 adb 改設定，預設繼承 global；http／file 版存 localStorage，exe 版存 exe 旁的 `settings.json`（不可寫才退到系統設定的區域），並在 About 顯示 `settings.json` 的位置；`settings.json` 要有版本號以供分享。

---

## 1. mockup 怎麼看

1. 雙擊 `ts/mockup/tag-style-settings.html`（file://，不需要伺服器）。
2. 上方灰條是 mockup 自己的工具列：
   * **看**：`設置 → 標籤樣式`（預設是「介面」分頁）、`本文`（看設定套在目錄與內文的樣子）、`關於頁`（看 settings.json 要顯示在哪）。
   * **主題**：暗／亮／護眼（和正式版同一組變數）。
   * **環境**：桌面版 exe／網頁版 file://（切換儲存位置、字型清單來源與 About 的顯示）。
   右邊的**設計說明**抽屜列出已定案與待作者決定的事項。
3. 設置裡的「此資料庫／全域預設」可以切換；示範資料在「全域」放了章、節、天干地支，「此庫」放了書，
   所以切來切去就看得到**繼承**與**覆寫**的差別。天干地支是一列設定＋22 層色相階梯。
4. 這一頁**不會**寫入 localStorage 或 `settings.json`；「匯出 JSON」只下載示範內容，「匯入」只套用到這一頁的記憶體。

也可以直接用網址開某個狀態（方便貼給人看）：

```
…/tag-style-settings.html?scope=global&theme=light
…/tag-style-settings.html?env=web#about        ← 網頁版的 About
…/tag-style-settings.html?nowrite=1            ← 模擬 exe 資料夾不可寫
```

mockup 的資料是示意（目錄樹、命中數、字型清單都是假的）；版面、互動、JSON 形狀才是要確認的東西。

### 1.1 已驗證的互動（headless Chromium 實際點過）

* 切換**全域／此庫**：來源標籤、繼承／覆寫、「重設」都正確。
* **自訂一個標籤**的顏色／大小：預覽、目錄色點、breadcrumb 與 JSON 立即更新；JSON 只出現改過的鍵。
* **天干地支**是一列設定＋22 層 ramp：自訂底色 `#ff0000` 後，甲＝紅、乙＝30°（`rgb(255,128,0)`）、
  第 22 層＝270°；切到「此庫」時整組繼承全域，ramp 仍在。
* **桌面／網頁**切換：字型清單從「已安裝（示意 18 個）」變成「內建（11 個）」。
* **匯入 v1** `settings.json`：顏色／大小套用、舊資料被取代（版本 > 1 會拒絕）。
* **About**：exe 旁 `C:\accelon3\settings.json`、`%APPDATA%` 退路、網頁 `localStorage` 三種都正確。
* 全程**沒有 JS 例外**。

---

## 2. 介面

### 2.1 設置頁：分頁（作者 2026-10-22 後續調整）

「設置」改成**分頁**；作者後來把主題／介面／進階**合併成「介面」**，移到最左邊：

```
設置
├─ 介面（主題／介面／進階）   ← 最左、預設
├─ 標籤樣式（新）
└─ 繁簡
```

> **已定案：分頁**（第一題）。標籤清單很長，一頁到底會把主題／繁簡擠到很下面；
> 主題／介面／進階都是「閱讀環境」的設定，合成一個分頁剛好。

### 2.2 作用範圍：全域／此資料庫

分頁最上面是一個二選一：

| 範圍 | 意思 | 檔案裡的位置 |
|---|---|---|
| **全域預設** | 出廠預設；沒被 adb 覆寫的庫都繼承它 | `profiles.global` |
| **此資料庫** | 只影響目前打開的這一本 adb；**預設全部繼承全域** | `profiles.adb["<adb 檔名>"]` |

* 選「此資料庫」時，橫幅會說「此庫目前 N 個自訂、其餘繼承全域」；每一列的右邊有來源標籤
  （`自動`／`全域`／`繼承全域`／`此庫`／`全域・天干地支`／`此庫・天干地支`）與「重設」。
* 選「全域預設」時，改的是所有庫的預設值。
* 換庫（開另一個 adb）時，這頁自動切到該庫；沒有設定就是全部繼承。
* **鍵＝adb 檔名**（作者 2026-10-22）：重新建置 adb 不會改動 `settings.json`，同檔名就繼續套用；
  檔名改了就是另一筆（舊的那筆留著，不會自動刪）。

### 2.3 每個標籤一列：顏色、大小、字型

| 欄位 | 控制項 | 說明 |
|---|---|---|
| 樣式 | `自動`／`自訂`（全域）；`繼承全域`／`自訂`（此庫） | 自動＝用下一節的 auto style；自訂＝這一列有自己的值 |
| 顏色 | 色票＋hex | 預設是主題的 `--tag-text-N`；自訂是任意色 |
| 大小 | 滑桿 50–300%＋數字 | **相對本文**（本文 16px＝100%）；auto 時顯示「依層次算出來的值」 |
| 字型 | 兩個下拉：第一種／第二種 fallback | 第二種只在第一種**沒有這個字形**時才用到（瀏覽器逐字 fallback） |
| 來源 | `自動`／`全域`／`繼承全域`／`此庫` | 讓讀者知道現在的值是從哪裡來的 |

* 自訂列的左側有一條 accent 色條，和「自動」一眼分得出來。
* 未自訂的列，控制項是**唯讀但顯示目前生效的值**（灰掉），所以不用切來切去也看得到結果。
* **天干地支是同一個設定（22 層）**（作者 2026-10-22）：只有**一列**，設定底色／大小／字型；
  22 個標籤（甲乙丙…癸、子丑…亥）的顏色由底色**每層色相 +30°** 產生（只轉色相，S／L 不變），
  另外附一條 22 格色相階梯讓你看結果。個別字**不再分開設定**。
  繼承只有兩層：**此庫天干地支 → 全域天干地支 → auto**。
* **字型清單來源**（作者 2026-10-22）：桌面版由宿主列出**使用者已安裝**的字型；
  網頁版（file://、http）只列**內建已知字型**（瀏覽器不能可靠列舉系統字型）。
  兩者都存在 `settings.json` 的字型名（字串），匯入別人的設定時，清單裡沒有的字型名也會原樣保留。

### 2.4 即時預覽

分頁上方有一個小預覽：書／甲（天干地支第一層）／章／節四個標題＋一段本文，字級都以本文 16px 為基準，
下面一行顯示目前「章」的 `font-family` 與字型來源。改任何一列，預覽、背後的目錄色點、本文 breadcrumb
都會**立即**跟著變（實作時重繪目前這一頁，不重讀 adb）。

### 2.5 儲存與分享

分頁最下面一張卡：

* **設定檔版本**：`v1`、`format: accelon26-settings`。
* **儲存位置**：exe 版 `C:\accelon3\settings.json`（可寫入）或退路
  `%APPDATA%\accelon26\settings.json`；網頁版 `localStorage['accelon26.settings']`。
  mockup 有一個「模擬 exe 資料夾不可寫入」的勾選框，可以看退路長什麼樣。
* **分享**：`匯出 JSON`／`匯入…`／`複製 JSON`。
* **JSON 預覽**：切換「settings.json（只存差異）」與「此庫現在生效的值」——前者是真正寫進檔案的內容，
  後者是合併後的結果（含來源）。

---

## 3. `settings.json` v1

```jsonc
{
  "format": "accelon26-settings",
  "version": 1,
  "updated": "2026-10-22T10:14:02Z",
  "profiles": {
    "global": {
      "tagStyle": {
        "tags": {
          "章": { "color": "#7cc0ff", "size": 125, "font": "DFKai-SB", "font2": "Source Han Serif TC" },
          "節": { "color": "#9fe08a", "size": 120, "font": "", "font2": "" }
        },
        "groups": {
          "天干地支": { "color": "#e0a54a", "size": 105, "font": "DFKai-SB", "font2": "PMingLiU" }
        },
        "body": { "color": "#d8d8d8", "font": "", "font2": "" }
      }
    },
    "adb": {
      "yinshun.adb": {
        "name": "印順法師佛學著作集",
        "tagStyle": {
          "tags": { "書": { "color": "#ffd479", "size": 140, "font": "Source Han Serif TC", "font2": "PMingLiU" } },
          "groups": {},
          "body": { "font": "DFKai-SB" }
        }
      }
    }
  }
}
```

| 欄位 | 型別 | 說明 |
|---|---|---|
| `format` | string | 固定 `"accelon26-settings"`（用來認檔，不靠副檔名） |
| `version` | integer | **格式版本**，現在是 `1`；讀到比自己大的版本要拒絕並提示「這個檔案比程式新」 |
| `updated` | string | RFC3339；只給人看，不參與比對 |
| `profiles.global.tagStyle.tags` | object | 標籤名 → 樣式（只放**自訂**的） |
| `profiles.global.tagStyle.groups` | object | 群組名（只有 `天干地支`）→ 樣式（22 層的**底色**；各層顏色由此推算，不存） |
| `profiles.global.tagStyle.body` | object | **本文**的顏色／字型（第二種 fallback）／字級（pt 8–30）；沒有 size 時用文件字級 |
| `profiles.adb.<檔名>` | object | 每本 adb 的差異；**鍵＝adb 檔名**（作者 2026-10-22），`name` 是 dbname、只給人看 |

單一樣式的欄位：

| 欄位 | 型別 | 範圍 | 省略時 |
|---|---|---|---|
| `color` | `#rrggbb` | | 用 auto（主題的 tag 色）；`天干地支` 的 `color` 是**底色**；本文用主題字色 |
| `size` | number | 標籤 50–300（%）；本文 8–30（pt） | 標籤用 auto（依層次）；本文用文件字級 |
| `font` | string | 字型名；`""`＝本文／系統預設 | 用本文的字型；`經` 的內建預設是「楷體」 |
| `font2` | string | 第二種字型；`""`＝沒有 fallback | 只用第一種＋系統 fallback |

* **只存差異**：沒改過的標籤不出現在檔案裡，所以換版本、分享、合併都不會把別人的設定蓋掉。
* 標籤的 `size` 是**相對本文的百分比**（`font-size: 125%`）；本文自己的字級是**pt**（8–30，
  設定頁直接編集文件字級），標籤的 % 以它為基準，所以改本文字級時所有標籤一起縮放。
* 顏色是字面 hex，不是主題變數——分享給別人時不會因為對方用亮色／春綠／秋黃主題而變色（auto 才會跟著主題）。
* **重建 adb 不會改動 `settings.json`**：設定只以檔名為鍵，不會寫回 adb；同檔名就繼續套用。

---

## 4. 繼承與優先序

```
一般標籤：（此資料庫）此庫.標籤 → 全域.標籤 → auto
天干地支：（此資料庫）此庫.天干地支 → 全域.天干地支 → auto（22 層顏色由底色 +30°/層推算）
```

* 一個標籤只要在某一層有自訂，就整組（顏色／大小／字型）用那一層；**不做單欄位繼承**（v1）。
* 「重設」＝刪掉那一層的條目，效果回到上一層。
* 天干地支**沒有**個別字的覆寫（作者 2026-10-22：同一個設定、共 22 層）。

---

## 5. auto style（預設）

* **顏色**：主題的 8 個標籤色相。正式版的 `tagChromaIndex(tag, depth)` 是「這個標籤在樹中第一次
  出現的順序 mod 8」，所以同一個標籤在目錄、本文、breadcrumb 同色。auto 直接用
  `--tag-text-N`（標題字色）與 `--tag-N`（目錄色點）。
* **大小**：沿用現在的公式——第 d 層（0 起算）＝ `min(1em + d×2px, 1.8em)`。
  本文 16px 時換算成百分比：第 1 層 100%、第 2 層 112.5%、第 3 層 125%、第 4 層 137.5%……
  上限 180%。設定頁把這個「算出來的值」直接顯示在大小欄（不可改），讀者才知道 auto 現在多大。
* **字型**：本文的字型（`DOC_TEXT_FAMILY`＝微軟正黑體…）。

> 這一節的數字要和 `render_accelon3.ts` 的 `LEVEL_STEP_PX`／`LEVEL_MAX_SCALE` 同步；
> 如果以後改公式，設定頁的顯示也要跟著改。

---

## 6. 已知標籤清單

| 類別 | 標籤 | 備註 |
|---|---|---|
| 結構 | 書 篇 章 節 詞 | 一般庫的層級標籤；`詞` 是詞典型 adb 的標籤 |
| 序數群組 | **天干地支**：甲乙丙丁戊己庚辛壬癸＋子丑寅卯辰巳午未申酉戌亥（22 個） | **同一個設定**；顏色＝指定底色，每層色相 +30°；沒有個別覆寫 |
| 此庫其他 | 由目前 adb 的 `<樹>` 實例收集（例：yinshun 的 記 部 項 編 干…） | 換庫時這一段會換；不在預設清單也能調 |

清單是「顯示用」的：真正的來源是 adb 的樹實例（`tags` 容器）；沒有 `s="*"` 樹的庫（例如 fgdict）
這頁仍然顯示，但只有全域預設清單（「此庫」沒有樹就沒有可列舉的標籤），不做整頁隱藏。

---

## 7. 儲存策略

| 環境 | 位置 | 備註 |
|---|---|---|
| 網頁版（file://、http） | `localStorage['accelon26.settings']`（JSON 字串） | 同一瀏覽器／同一 origin；清網站資料就回預設。`匯出`可以把 JSON 存檔分享 |
| 桌面版 exe | **exe 同一個資料夾的 `settings.json`** | 與 exe 一起搬走、備份最直覺；更新 exe 不會動到它 |
| 桌面版（exe 資料夾不可寫） | `os.UserConfigDir()/accelon26/settings.json`（Windows：`%APPDATA%\accelon26\settings.json`） | 例如裝在 `Program Files`、或受控資料夾存取。**只有寫不進去時才用** |

實作要點：

* 開機讀一次；讀不到就當全部預設（不建檔）。**第一次改設定才寫檔**，所以乾淨的程式不會在
  exe 旁邊多一個檔案。
* 寫入用「暫存檔＋rename」避免半個 JSON；寫失敗就退回記憶體並在 About／設定頁顯示原因。
* exe 版用宿主（Go）讀寫，比照現有的 `exportDirs()`：`os.Executable()` → 同資料夾；不可寫
  （`dirWritable()` 已有）→ `os.UserConfigDir()`。About 要顯示**實際使用的那一個**，
  而不是「偏好」的那一個。
* 網頁版的 `localStorage` 可能被私密模式擋掉：失敗時只影響「記住」，設定在這次瀏覽仍有效。
* 既有的 `localStorage` 鍵（`accelon26.theme`、`accelon26.advanced`…）這一版**不動**；
  `settings.json` v1 只放標籤樣式（已定案）。

---

## 8. 渲染怎麼套（定案做法）

目前標題的顏色是 `render_accelon3.ts` 直接寫在 `style` 的 `--tagtext`，大小是行內 `font-size`；
目錄色點與 breadcrumb 則各自用 `depthColor()`／`tagChromaIndex`。

**做法（作者 2026-10-22 同意）**：新增 `tag-style.ts`，提供 `tagStyleOf(tag, depth)`：

1. 有自訂 → 回傳 `{color, sizePct, font, font2}`；沒有 → 回傳 null（用原本的 auto 公式）。
2. **本文標題**：`render_accelon3.ts` 的 `headingStyle()` 先問 `tagStyleOf`；自訂就輸出該顏色／
   `font-size: N%`／`font-family`（第二種接在後面），auto 維持原本的 `--tagtext`＋`min(1em+depth*2px,1.8em)`。
   行內樣式最直接，也不必處理 CSS 優先序。
3. **目錄色點**：`scopes.ts: depthColor(tag, depth)` 先問 `tagStyleOf(tag)?.color`，沒有才用 `--tag-N`。
4. **breadcrumb**：`doc-pane.ts` 目前用 `--tag-text-N`；改成先問 `tagStyleOf`，自訂用 hex。
5. **天干地支**：`tagStyleOf` 對 22 個成員回傳 `rampColor(底色, index)`（色相 +30°），
   大小／字型用群組那一組。
6. **改設定時**：`tagStyleChanged()` → 重繪目前這一頁（`rerenderDoc()`）、目錄樹（`renderDirTree()`）
   與 breadcrumb；**不重讀 adb、不重算索引**。字級變了只影響畫面重排，不影響分頁行數。
7. 換庫時：`setActiveDb(檔名, dbname)` → 重算合併結果 → 重繪目前畫面。

效能：每次改動只重繪可見的一頁＋目錄已掛載的列，成本與換主題相近。

---

## 9. About 頁

在現有的 meta 清單（版本／執行環境／程式檔／開發者）中間加一列：

```
設定檔   C:\accelon3\settings.json  [v1]   （開啟資料夾）
         與 accelon26.exe 放在一起，可以直接備份／分享。
```

* 網頁版顯示 `localStorage['accelon26.settings']`，並說明「沒有檔案，換瀏覽器就回預設」。
* exe 資料夾不可寫時顯示退路的完整路徑（並說明原因）。
* 旁邊可以有「匯出」；「開啟資料夾」沿用 `RevealInFolder`（macOS 是 Finder）。
* 資料來源：`AppInfo` 已經有 `exeDir`／`dirWritable`，再加一個 `settingsPath`（Go 決定實際位置）
  就夠，不必讓 UI 自己猜路徑。

---

## 10. 分享與版本

* `version` 是**格式版本**；讀到 `version > 1` 就拒絕（提示「這個設定檔比程式新，請更新 accelon26」）。
* 匯入時保留未知的 top-level 欄位（將來的版本加東西不會被舊版洗掉）；只覆蓋 `profiles` 裡認得的鍵。
* 匯出檔名建議 `accelon26-settings.json`；About／設定頁都提供同一份。
* 分享時「只存差異」很重要：對方沒改過的標籤不會被你蓋掉；要整份覆蓋則由使用者自己選
  （v1 先不做「整份取代」，只做合併）。

---

## 11. 定案紀錄（2026-10-22 作者回覆）

| # | 問題 | 決定 |
|---|---|---|
| 1 | 分頁 vs 一頁到底 | **分頁**；標籤樣式是第一個分頁 |
| 2 | 整個標籤 vs 單欄位覆寫 | **整個標籤**（顏色／大小／字型一起） |
| 3 | adb 鍵 | **adb 檔名**（`yinshun.adb`）；重建 adb 不會動到 `settings.json` |
| 4 | 自訂色是否套目錄色點／breadcrumb | **要**（本文標題、色點、breadcrumb 同色） |
| 5 | settings.json 範圍 | **v1 只放標籤樣式**；主題／繁簡照舊在 localStorage |
| 6 | 字型清單 | **exe 列出使用者已安裝的字型；html 版只列內建已知字型** |
| 7 | 大小上限 | 自訂 50–300%；**auto 維持 180%** |
| 8 | 沒有 `s="*"` 樹的庫 | **仍顯示**；只有全域預設清單（「此庫」沒有樹就沒有標籤資料） |
| 9 | 設置視窗寬度 | **940px**（顏色／大小／字型／來源一列看完） |
| — | 天干地支 | **同一個設定（22 層）**：指定底色，每深一層**色相 +30°**；沒有個別字覆寫 |

---

## 12. 實作清單（已完成）

| 檔案 | 工作 | 狀態 |
|---|---|---|
| `ts/src/accelon26/tag-style.ts`（新） | 合併設定、天干地支 22 層 ramp、`tagStyleOf()`、變更通知 | 完成 |
| `ts/src/accelon26/settings.ts`（新） | 讀寫 adapter（localStorage／宿主）、v1 驗證、匯入匯出、About 路徑 | 完成 |
| `ts/src/accelon26/ui.ts` | 設置分頁（標籤樣式）與控制項、初始化、變更後重繪 | 完成 |
| `ts/src/accelon26/accelon26.template.html` | 分頁 markup、CSS（940px、天干地支 ramp） | 完成 |
| `ts/src/accelon26/render_accelon3.ts` | 標題顏色／大小／字型先問 `tagStyleOf` | 完成 |
| `ts/src/accelon26/scopes.ts`／`doc-pane.ts` | 目錄色點、breadcrumb 的顏色 | 完成 |
| `ts/src/accelon26/about.ts`／`viewer.ts` | About「設定檔」一列；換庫時 `setActiveDb` | 完成 |
| `ts/src/accelon26/host.ts`／`wails/*.go` | `LoadSettings`／`SaveSettings`／`SettingsInfo`／`Fonts` | 完成 |
| `ts/test/*`／`wails/*_test.go` | 合併／ramp／版本／退路／字型清單的測試 | 完成 |

**驗證**：`test/tag-style.test.ts` **32/32**（含本文、經楷體、真的 renderer 的顏色／大小／字型）、
`go test ./...`、file:// 全套 192/192（yinshun）、182/182（fgdict；含新增的本文列／示範／秋黃）、桌面版 6/6
（exe 旁 settings.json、158 個已安裝字型、寫檔／讀回、About 路徑）。詳見交接文件 §15／§17。
