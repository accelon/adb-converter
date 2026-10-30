# Accelon26 閱讀器

> 同一份單檔 HTML 同時服務瀏覽器與桌面 Wails 宿主。
> 桌面宿主另外提供檔案系統、下載與更新；閱讀器 UI 本身兩邊共用。

## 1. 定位

```text
Accelon3 的跨平台平替
直接讀 .adb
單檔 HTML（build/accelon26.html）
桌面版把同一份 HTML 包進 Wails
```

## 2. 入口

```text
建置：bun run tools/build-viewer.ts
輸出：build/accelon26.html
桌面：bun run tools/build-desktop.ts → wails/assets/index.html
```

開啟：

```text
file:///…/accelon26.html  → 選 .adb
或桌面 accelon26.exe
```

## 3. 目錄

上方資料庫晶片（`dbChip`）顯示**短名**：`taisho` → 大正、`wxzj` → 卍續、`goryeo` → 高麗、
`ys` → 印順、`tx` → 太虛、`lc` → 呂澂（2026-10-30）。短名的來源依序是
`<集 b="印順">…</集>` 的 `b=`（下次 rebuild 後才有）、上面的缺省表、最後才是庫名；
下拉清單的完整庫名（`.dbPickName`）不變。

左欄每一棵 `<樹>` 一個 pane：

- `s="*"`：目錄樹
- `s="$書"`：書名
- `s="*詞"`：全文
- `s="*u=…"`：頻次
- `m="taisho"`／`m="goryeo"`：高麗⇄大正（換算位置）

多個 `s="*"` 時，目錄上方出現樹選擇器；不是並排分頁。

### 3.1 study 的目錄

`taisho-study.adb` 只有一棵 `t="書"` 樹；每本書用 `t=` 宣告自己的下一層：

```text
<書 id="n2" t="品.">妙法蓮華經</書>
```

所以：

```text
大正藏研究 → 書 → 品／分
```

不再為每部經開一棵全域樹。

### 3.2 高麗⇄大正（`m="taisho"`）

`goryeo_taisho.adb` 帶兩藏逐字對照表，檔頭宣告：

```text
<隱><樹 m="taisho">高麗⇄大正</樹></隱>
```

- `m=` 的值是預設來源側，分頁名取 `<樹>` 的文字。
- 空著不顯示清單，只顯示說明：
  - 文字 → 找經名；數字 → 找經號（大正、高麗一起找）；`T`／`K` 前綴只找那一藏；
    `1.2` = 第 1 經第 2 卷；也可以貼位置（`T05p0002c0405`）或選取選單複製的
    字元級位置（`taisho?5p2c j=2-8`）。
- 清單一經一筆，例如輸入 `1`：

  ```text
  大般若波羅蜜多經 卷1   [大正]
  長阿含經 卷1           [高麗]
  ```

  - 每一筆前面有一個圈字，表示經名與卷從哪一藏來：**大正＝白底紅字、高麗＝藍底紅字**
    （`border:0`，2026-10-30）；右邊那顆是**要去的那一藏**。
  - **按經名**（圈字那一藏）就切到那一藏；**按右邊那顆**則去另一藏（對照），都在中間開啟（`openInMain`）。
  - 位置查詢時，右邊那顆就是位置所在的那一藏；字元級位置會順便把 `j` 指到的字塗色帶。
  - 位置只在滑過時以 tooltip 顯示；位址查詢顯示**字元級**（`T05p0002c0405 ⇄ K01p0004c2202`），不占列高。
    `-0507` 這種範圍會顯示起訖（`…0405 → …0507 ⇄ …2202 → …2307`）；`-0003a` 只給頁＋欄，
    表示到那一欄尾；`-` 後面不能跨冊。按下去時本文會跳到該位置，並把那一行（範圍就那幾行）
    塗上 `jumpHit` 色帶。
- 圖版不在這一欄：需要看圖版時，在經文裡選取，用選取選單的「查看 → 看大正藏／高麗藏圖版」。
- 沒有 `goryeo_taisho.adb` 時，這個分頁不出現，其他庫的選取選單也沒有高麗藏圖版。
- 換址不需要經文；`goryeo_taisho.adb` 只有兩行文字。詳見
  [goryeo-steps.md](../adb/goryeo-steps.md)。

## 4. 注疏

`<嵌>` 晶片：

```text
<嵌 i="taisho?18p24b" j="210-237" t="…" n="1 家注疏"/>
```

- 點晶片：右欄展開注疏群
- `大正↗`：右欄開母庫目標頁並塗紅（**Ctrl/⌘+點**：切到那個庫，在中間開啟）
- 右欄的跨庫分頁也可以 **Ctrl/⌘+點**：切到那個庫，在中間開啟同一頁（2026-10-30）
- `study`／`jingang` 是終點庫，不顯示「引用複製」

study 另外有 `study/index` block 的注疏清單：

- 標題列「注疏」按鈕
- 只在有 study 庫時顯示
- 同時開 `taisho.adb` 也不消失
- 按下去切回 study 並開清單

詳見 [taisho-study.md](../adb/taisho-study.md)。

## 5. 選取選單

選取本文後出現的浮動選單是**兩層**（2026-10-30）：第一層三組（**複製／搜尋／查看**），
滑過或點一下就在右邊展開第二層。

| 第一層 | 第二層 |
|---|---|
| **複製** | **引用複製**／**複製文字**／融入引用／嵌入引用／**複製字元級位置**／（大正藏、高麗藏）**複製高麗⇄大正位址** |
| **搜尋** | 這個庫現在有、而且能接受輸入的左欄分頁：目錄／名詞／頻次／原書分頁／跳至／西文／高麗⇄大正（名稱取自分頁標題）。點一個就把選取文字送進去、並切到那一頁。 |
| **查看** | 查字典／開《…》（選到經名時）／看大正藏圖版／看高麗藏圖版 |

底下另有一行「☆ 加入書籤」（保留原本的書籤功能）。

- **字元級位置**：`資料庫?頁 id j=起-止`，例 `taisho?5p2c j=12-34`（`j` 是這一頁第幾個漢字，
  起止都包含；沒有 `<頁>` 的庫用行號 `L123`）。區段跨頁時只記到起始頁。
- **高麗⇄大正位址**：兩側的 posmap 位址範圍，例 `T05p0002c0405-T05p0002c0612`；
  只在大正藏／高麗藏、而且對照表載入時出現（貼進「高麗⇄大正」的輸入框就能查）。
- 終點庫（`jingang`／`study`）不顯示「引用複製」。

study 中選到可辨識的大正頁碼：

```text
18p14c
8p748c
T18n0890_p0014c
```

選單只留「查看→打開經文」與「複製→複製文字」。
「打開經文」需要母庫 [taisho.adb](../adb/taisho.md) 已開。

讀大正藏或高麗藏時，「查看」裡有（2026-10-30）：

```text
看大正藏圖版     DIA：index.html?id=Tv05p0002#?c=0&m=0&s=0&cv=10&xywh=0%2C1783%2C2236%2C837
看高麗藏圖版     KABC：dataId=ABC_IT_K0647_T_001&imgId=017_0815_a
```

- 大正藏圖版只需冊與頁，讀 `taisho.adb` 就有；**hash 會指到選取所在的欄**
  （a／b／c = 上／中／下欄）：
  - `#?c=0&m=0&s=0&cv=10&xywh=0%2C<y>%2C2236%2C837`
  - `w=2236`、`h=837` 是 1080p 下一欄的大小；`y` 取三等分：a=214、b=1001、c=1783；x 固定 0。
- 高麗藏圖版需要經號、卷、冊、頁、欄；要有 `goryeo_taisho.adb` 的對照表才顯示。
- 目前只把網址交給系統瀏覽器，不在閱讀器裡顯示圖版。

### 5.1 跳至接受字元級位置

左欄「跳至」貼上「複製字元級位置」的字串（`taisho?5p2c j=12-34`）按 Enter：

- 如果字串指的庫不是現在這個，會**切回那個庫**（已開的分頁；網頁版要先開過）。
- 跳到那一頁，並只用 CSS Custom Highlight（`::highlight(accelonCharBand)`）把
  `j` 指到的**那幾個字**塗色帶（不是整行）；重畫或換頁就清掉。
- 手寫 `taisho?5p2c j=0-4` 也可以；沒有 `j` 的純頁 id 行為不變（列頁 id 清單）。

## 6. 桌面專屬

- `📁` 下拉：`⬇ 取得更多 ADB`
- 離線時該項變暗但不隱藏
- `＋ 加入 Obsidian` 只在進階模式
- Wails host 提供 `SaveAdb`、`StartNewAdbDownload`、mmap 讀取

詳見 [desktop.md](./desktop.md)。

## 7. 建置與測試

```powershell
cd ts
bun run tools/build-viewer.ts
bun run tools/build-desktop.ts
bun test test/render.test.ts
bun run test:embed
```

桌面 exe：

```powershell
cd wails
go build -ldflags "-H windowsgui" -o ..\accelon3\accelon26.exe .
```

## 8. 重要檔案

| 檔案 | 用途 |
|---|---|
| `ts/src/accelon26/accelon26.template.html` | 單檔 HTML 模板與 CSS |
| `ts/src/accelon26/ui.ts` | 主 UI、初始化 |
| `ts/src/accelon26/dbs.ts` | 開庫、分頁、下拉 |
| `ts/src/accelon26/scopes.ts` | 目錄樹／pane |
| `ts/src/accelon26/render_accelon3.ts` | `<融>`／`<嵌>` 渲染 |
| `ts/src/accelon26/bookmarks.ts` | 選取選單、頁碼辨識、圖版按鈕 |
| `ts/src/accelon26/posmap.ts` | 高麗藏 ⇄ 大正藏換址核心（`columnLineOf`） |
| `ts/src/accelon26/map-pane.ts` | 左欄「高麗⇄大正」分頁、由本文位置求位址 |
| `ts/src/accelon26/map-index.ts` | `map/index`（卷目錄）解析 |
| `ts/src/accelon26/plates.ts` | DIA／KABC 圖版網址 |
| `ts/src/accelon26/study-index.ts` | 注疏清單 |
| `ts/src/accelon26/adb-store.ts` | 取得更多 ADB |
| `ts/src/accelon26/mirror.ts` | 鏡像選擇 |
| `ts/tools/build-viewer.ts` | 建置單檔 HTML |
| `ts/tools/build-desktop.ts` | 建置桌面 assets |
