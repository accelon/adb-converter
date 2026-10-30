# goryeo.adb（高麗藏）產生步驟，與「高麗藏 ⇄ 大正藏」轉址

> 目的：用 `D:\2023\tripitaka-migrator\k-txt` 產生一份 accelon3 可讀的 `goryeo.adb`，
> 附帶高麗版經號、卷號、冊頁欄行。**逐字對照表已抽成獨立的 `goryeo_taisho.adb`**
> （2026-10-30），`goryeo.adb` 只剩經文。
>
> 定位：**大正藏是主藏**。高麗藏 adb 自帶「與大正藏對齊」的資訊；`taisho.adb` 不需要知道
> 世界上還有其他藏。其他藏（yinshun 等）先用大正藏頁碼定位，再由 UI 透過對照表轉到高麗藏。

## 0. 成品（2026-10-30）

| 項目 | 數值 |
|---|---|
| 檔案 | `build/goryeo.adb` 145.8 MiB（152,864,921 bytes） |
| 冊 | 45（K01–K41、K44–K47；K42/43 無卷資料） |
| 書 | 1,507（1,502 部經；5 部跨冊，id 用 `K0001V01` 區分） |
| 卷 | 6,594（＝ juaninfo.tsv 筆數） |
| 頁欄 | 150,969 |
| 行 | 3,432,943（一行＝一個 pcl 行） |
| tokens | 10,440 種／57,202,225 筆 |
| 對照表 | **不在這個檔**：`build/goryeo_taisho.adb` 2.20 MiB（2,304,141 bytes；`align/posmap` 1.78 MiB ＋ `map/index` 428 KiB） |
| resources | `goryeo_logo.png` |
| 檔頭 | `dbname=goryeo`、`dbcname=高麗大藏經`、`dbtype=4`、`srcBlockSize=16384`、`andtagid=21`（頁） |

**放哪裡**：`goryeo.adb` 與 `goryeo_taisho.adb` 都放在 `D:\accelon3`（所有 adb 的書庫，
`accelon26.exe` 也在那裡）。桌面版開機用 `ListAdbs` 列出那兩個資料夾（工作目錄與 exe
所在目錄）的 `*.adb`，所以把 `goryeo_taisho.adb` 放在 `taisho.adb` 旁邊，讀大正藏時
「看高麗藏圖版」就會自己出現，不必先手動開它。

`align` 容器抽出來的理由：對照表與經文無關，分開之後

- `goryeo.adb` 換版（換底本、校勘）不必重下對照表；
- 讀 `taisho.adb` 的人只要多帶一個 2.2 MB 的小檔，就能雙向換址、看高麗藏圖版；
- accelon3 讀 `goryeo.adb` 不受影響（本來就不認識 `align`）。

**為什麼不是 13 MB**：對照表的內容（GYPOS2，13,203,511 bytes）存進 adb 之前先用
raw DEFLATE 壓成 1.78 MiB（14.1%）。這和 migrator 的 `public/posmap.pos`
（1,618,468 bytes，zstd 19）是同一份資料的兩種包法，差別只在壓縮器；`map/index`
沒有再壓（428 KiB，只解析一次）。卷題尾巴的 `^p`／`^half〔別名〕…` 是 migrator 的標記，建置時切掉（2026-10-30）；所以查「長阿含」不會再出現「中本起經」。

## 1. 來源

| 用途 | 路徑 |
|---|---|
| 正文 | `D:\2023\tripitaka-migrator\k-txt\K01.tsv … K47.tsv`（高麗藏再雕本，東國大學 KABC 文字） |
| 卷界 | `k-txt\juaninfo.tsv`（經號／冊號／經名／卷號／起點／終點／總行數） |
| 對齊 | `D:\2023\tripitaka-migrator\posmap.db`（6,357 卷的 1:1 對應段） |
| 對照表的卷題 | `t-txt\juaninfo.tsv`、`k-txt\juaninfo.tsv` |
| logo | `logo/goryeo_logo.png` |

## 2. 文字處理（k-txt 的標記）

k-txt 每行是「頁行碼 TAB 文字」，文字裡混了三種 ASCII 標記：

| 標記 | 出現次數 | 意義 | 處理 |
|---|---|---|---|
| `^p` | 528,698 | 段落起點（可能在一行中間） | 刪除，保留前後漢字 |
| `^half` | 191,472 | 小字（夾註）開始 | 刪除，保留夾註文字 |
| `^jN` | 6,594 | 卷起點（單獨一行，沒有頁行碼） | 整行略過（卷界改由 juaninfo 決定） |

只移除 ASCII 標記、不動任何漢字——這一點很重要：`posmap.db` 的行幾何是用
「每行漢字數」算的，刪掉非漢字不會改變座標，所以對照表可以直接套在新 adb 上。

## 3. 結構規則

| 元素 | 規則 |
|---|---|
| 冊 | 每個 `K??.tsv` 一個 `<冊 id="N">高麗藏第N冊</冊>` |
| 書 | 每個經號一個（跨冊者每冊各一個，id = `K{經號}V{冊:02d}`，`n="經號"`） |
| 卷 | juaninfo 每列一個 `<卷 id="{經號}-{卷}" n="{卷}">卷題</卷>`；卷題取該卷第一行的文字（與 juaninfo 的經名一致） |
| 頁 | 頁行碼換成 `<頁 id="NpMc"/>`（N＝冊、p、頁、欄） |
| 行 | 一行一個 pcl 行（供行號定位與換址） |
| 段 | 每部經開頭一個 `<段/>` |

## 4. 指令

```bat
:: 1) k-txt → adb 文字（附「卷起始行」sidecar）
go run ./cmd/k2adb -k D:\2023\tripitaka-migrator\k-txt -out build\goryeo-text.txt -lines build\goryeo.lines.tsv

:: 2) 文字 → goryeo.adb（只放經文）
bun run ts/tools/goryeo-pack.ts build\goryeo-text.txt build\goryeo.adb logo\goryeo_logo.png

:: 3) 對照表 → goryeo_taisho.adb（在版本庫根目錄跑；預設路徑見 goryeo-taisho-pack.ts）
::    align 直接從 goryeo.adb 抽（抽過之後就從 build\posmap.bin 讀）
::    卷題／卷界取自兩藏的 juaninfo.tsv
bun run ts/tools/goryeo-taisho-pack.ts

:: 若要把對照表重新產生（posmap.db → 二進位）
bun run ts/tools/posmap-dump.ts D:\2023\tripitaka-migrator\posmap.db build\posmap.bin

:: 4) 放進書庫（桌面版開機就會列出）
copy build\goryeo.adb        D:\accelon3\goryeo.adb
copy build\goryeo_taisho.adb D:\accelon3\goryeo_taisho.adb
```

## 5. `goryeo_taisho.adb` 的內容

| 容器 | 內容 |
|---|---|
| `align/posmap` | 兩藏逐字對照（6,357 卷）；raw DEFLATE，1.78 MiB（解壓 12.6 MiB），格式見下 |
| `map/index` | 給左欄「高麗⇄大正」用的卷目錄（6,357 筆）：兩側經號／卷號／卷題／起訖 |
| 文字 | 兩行：檔頭 ＋ `<段/>`。檔頭宣告 `<隱><樹 m="taisho">高麗⇄大正</樹></隱>` |
| 檔頭 | `dbname=goryeo_taisho`、`dbcname=高麗⇄大正`、`dbtype=4` |

`map/index`（little-endian，`GYMAP1`）：`u32 n`、`u32 nStr`、字串表（u32 長度＋UTF-16LE）、
每筆 40 bytes：`u32 tTitle, u32 kTitle, 4B tsutra, 4B ksutra, u16 tjuan, u16 kjuan,
u8 tvol, u8 kvol, u16 flags, u32 tstart, tend, kstart, kend`。
`tstart` 等是 `page*1000 + col*100 + line`。

### `align/posmap` 的存放方式

區塊開頭兩種都吃（`posmap.ts` 的 `decodePosMapBytes` 自動判別）：

```text
"GYPOS2\0\0" …                    未壓縮（build/posmap.bin 原樣；舊檔）
"GYPOSZ\1\0" u32 rawLen ×N        raw DEFLATE（RFC 1951）；解壓後就是上面的 GYPOS2
```

瀏覽器端用 `src/inflate.ts` 的 `inflateRaw`（和 zip 匯入同一個解壓器），13.2 MB
約 80 ms；`PosMap.parse` 只解一次（`map-pane.ts` 按 reader 快取）。
要存未壓縮的就加 `--no-compress`。

### 解壓後的 `align/posmap` 二進位格式（v2）

外層容器 `align` 只有一個名為 `posmap` 的區塊（`BO_NAMED`）。little-endian：

```text
magic  8B  "GYPOS2\0\0"
u32        count                       // 6,357
每筆 44B + blob：
  4B  tsutra ascii   2B tjuan
  4B  ksutra ascii   2B kjuan
  1B  t_vol  4B t_start 4B t_end       // 大正藏冊號與 seq 範圍（page*1000+col*100+line）
  1B  k_vol  4B k_start 4B k_end       // 高麗藏冊號與 seq 範圍
  4B  t_line 4B k_line                 // 該卷在 taisho.adb / goryeo.adb 的起始行（0-based，0xFFFFFFFF＝無）
  4B  len    len bytes 的 AlignBody
```

`AlignBody`（posmap.ts 的 `encodeAlign` 原樣）：

```text
u8 版本=1  u8 flags(bit0=coarse)
兩側幾何：
  u32 vol, u32 nLines, u32 han（總漢字數）
  nLines × u32（lineSeq 差分量）
  nLines × u32（每行漢字數）
u32 tBody0,tBody1,tPre,tPost
u32 kBody0,kBody1,kPre,kPost
u32 nRuns；nRuns × (gapT,gapK,len)  // 1:1 對應段，漢字座標
```

`t_line`／`k_line` 是 posmap-dump 當時的 sidecar，**只供除錯**；UI 不用它
（大正藏 adb 是 CBETA 文字，對照表的 T 側是 SAT 文字，兩者斷行不完全一樣）。

## 6. 位置換算怎麼做

### 位址格式（沿用 migrator 的 `posfmt.ts`）

```text
K01p0001a0105   高麗藏 第1冊 第0001頁 a欄 第01行 第05個字之前
T05p0002c0405   大正藏 第5冊 第0002頁 c欄 第04行 第05個字之前
```

偏置只數漢字（CJK 表意字符），標點、ASCII、標記都不計。

### 演算法

```text
位址 (vol,page,col,line,off)
  → seq = page*1000 + col*100 + line
  → 在 align 索引找「該冊、seq 落在範圍內」的那一卷
  → 行：findLine(geometry, seq) → 行索引
  → 漢字位移 x = lineStart[行] + off
  → 序文／附文修正：x 夾到 [body0, body1]
  → 對應段：mapOffset(runs, x) → y（反向用 mapOffsetRev）
  → 另一側：lineIndexAt(y) → 該行的 pcl + 行內偏置
```

「對應段」是兩藏之間 1:1 的字元對應，替代字（如「峰/峯」）不改變位移差，
所以整卷可以壓成個位數段；真正的插入／刪除才留下段界。落在單邊插文時取最近位置並標記
`exact:false`。

### 由「本文的位置」求位址（UI）

大正藏 adb（CBETA）與對照表的 T 側（SAT）斷行不同，所以**不要用 adb 行號**推位址：

1. 由選取位置找最近的 `<頁 id="NpMc">`（頁／欄）。
2. 從頁標記那一行起算「這一欄第幾個漢字」（頁標記可能不在行首：卷首是
   `…<卷>卷題</卷><頁 id="…"/>`，卷題就是這一欄的第 1 行）。
3. 用對照表的幾何 `columnLineOf(side, vol, page, col, colChar)` 換成該側的 pcl 行號與行內偏置。

`columnLineOf` 只看「這一欄第幾個字」，所以兩藏斷行不同也不影響；頁與欄是共通的。

### accelon26 的 API

```js
window.__accelon26.posmapConvert('K01p0001a0105')
// { from:'K01p0001a0105', to:'T01p0001b1101', tsutra:'0001', ksutra:'0647', … }

window.__accelon26.posmapAtLine(1461695)   // 目前 adb 的行號 → 位址 → 換址
window.__accelon26.mapState()              // 對照表的筆數、卷目錄筆數、預設方向
```

`posmapConvert` 需要開著 `goryeo_taisho.adb`（桌面版放在 exe 旁邊就會自動找到）。

## 7. 主藏架構（為什麼 taisho.adb 不必改）

```text
yinshun.adb ──<聯 i="taisho?51p185b">──▶ taisho.adb（主藏）
                                              │
                                              │  goryeo_taisho.adb 的 align 說：
                                              │  T51p185b ⇄ K17p815a03
                                              ▼
                                          goryeo.adb（帶經文）
```

- 大正藏是連結的共通座標；所有藏都用「大正藏頁碼」互相定位。
- 每個「從藏」只記錄自己與大正藏的對齊（`align`），大正藏不需要知道從藏的存在。
- 之後要加第三、第四藏，只要各自帶一份 `align`（T 側座標不變），UI 就能做多藏互轉。
- `align`／`map` 是外層容器，accelon3 只按名字取 `source/tokens/…`，不認識的容器直接忽略：
  閱讀、檢索不受影響；換址與圖版只在 accelon26。

### 左欄「高麗⇄大正」分頁（`<樹 m="taisho">`）

`goryeo_taisho.adb` 檔頭宣告：

```text
<隱><樹 m="taisho">高麗⇄大正</樹></隱>
```

- `m=` 的值是預設的來源側（`taisho`／`goryeo`），分頁名取 `<樹>` 的文字。
- 分頁列出 `map/index` 的 6,357 卷（可選），也可以直接輸入位址（`T05p0002c0405`、
  `K01p0001a0105`、`5p2c`）。選一卷或按 Enter 就換算，並給「在……開啟」與圖版按鈕。
- 它不需要內文，所以 `goryeo_taisho.adb` 只有兩行文字。

### 原書圖版（2026-10-30）

讀 `taisho.adb`／`goryeo.adb` 時，選取本文後選單會多出：

| 按鈕 | 網址 |
|---|---|
| 看大正藏圖版 | `https://dia.dila.edu.tw/uv3/index.html?id=Tv05p0002`（`T`＋`v`＋冊2位＋`p`＋頁4位） |
| 看高麗藏圖版 | `https://kabc.dongguk.edu/viewer/view?dataId=ABC_IT_K0647_T_001&imgId=017_0815_a`（經號4位／卷3位；冊3位／頁4位／欄） |

- 大正藏圖版只要冊與頁，讀 `taisho.adb` 就有。
- 高麗藏圖版要知道經號、卷、冊、頁、欄：
  - 讀 `goryeo.adb` 時，`<書 id="K0647V17">` 與 `<卷 n="1">` 就寫在 adb 裡，**不需要**對照表；
  - 讀 `taisho.adb` 時要先換算，所以需要 `goryeo_taisho.adb` 的對照表；沒有表就不出現那一顆按鈕。
- 少數大經在 KABC 被切成 a/b/c/d 幾個 dataId（大般若 0001 每 150 卷、0648／0952 的 b），
  卷參數要扣偏移（見 `ts/src/accelon26/plates.ts` 的 `K_SPLIT`）。
- 這一輪只把網址帶去瀏覽器，不在閱讀器裡顯示圖版。

## 8. 驗證

| 檢查 | 結果 |
|---|---|
| 卷數 vs juaninfo | 6,594 / 6,594 |
| 對照表卷數 | 6,357（＝ posmap.db align 筆數） |
| `align` 內容 | 解壓後與原 `goryeo.adb` 的 `align/posmap` 位元組完全相同（13,203,511 bytes）；存進 adb 的是 1,863,650 bytes 的 raw DEFLATE |
| 抽表後經文 | `goryeo.adb` 抽樣 60 行、檔頭、resources 與抽表前相同；tokens 10,440／57,202,225 不變 |
| accelon26 開檔 | 目錄樹 45 冊、本文、搜尋正常（「涅槃」29,108 筆） |
| 換址對帳 | 與 `posmap.db` 原實作隨機比對：T→K 300/300、K→T 300/300 相同 |
| 文字級對帳（本輪） | `ts/tools/map-check.ts`：兩側各抽 40 卷，換到的頁／欄有 92.5% 含來源文字（其餘是異文或對齊粗略的卷） |
| 對照分頁／圖版 | `ts/tools/map-test.ts`：6,357 卷、位址換算、兩顆圖版按鈕的網址、讀 taisho／goryeo 的選取選單、goryeo 單獨開（沒有對照表時只看高麗藏圖版）都通過；`D:\accelon3` 的成品也跑過同一組測試 |
| 檔案一致 | `build\` 與 `D:\accelon3\` 的 `goryeo.adb`／`goryeo_taisho.adb` SHA-256 相同（`0EC958DB…`／`577767FA…`） |
| 壓縮表可讀 | 同一份 2.20 MiB 的 adb 在瀏覽器解壓後仍是 6,357 卷；`map-test` 五階段（含只開 taisho／只開 goryeo）與 `map-check` 兩方向（92.5%）都通過 |

## 9. 已知限制

1. **只有對得上的卷**：posmap 收 6,357 卷，高麗藏共 6,594 卷，其餘卷（內容差異大或卷數不同）沒有對照。
2. **行號與字內偏置是近似值**：頁／欄正確；欄內第幾個字由對照表的幾何算，遇到異文或
   對齊粗略（`coarse`）的卷可能差幾個字。圖版網址只用到頁／欄，不受影響。
3. **75 個 T 卷**的卷號與 TEI 檔名不一致，對照表有筆、卷題由經號補；這些卷的行號換算不可靠。
4. 高麗藏沒有品／附文的結構標記（k-txt 沒有），只有冊／書／卷／頁。
5. 校勘不在 `goryeo.adb`（k-txt 本來就沒有）。
6. `align` 的 `t_line`／`k_line` 是舊 sidecar，**不要拿來換址**（大正藏的斷行已改為 CBETA）。

## 10. 檔案

| 檔案 | 說明 |
|---|---|
| `cmd/k2adb/main.go` | k-txt → adb 文字（含 `-lines`） |
| `ts/tools/goryeo-pack.ts` | 文字 ＋ logo → `goryeo.adb`（不含對照表） |
| `ts/tools/goryeo-taisho-pack.ts` | 對照表 ＋ 卷題 → `goryeo_taisho.adb` |
| `ts/tools/posmap-dump.ts` | posmap.db → 二進位表（v2） |
| `ts/src/accelon26/posmap.ts` | 換址核心（解析、行列查詢、雙向轉換、`columnLineOf`） |
| `ts/src/accelon26/map-index.ts` | `map/index` 解析 |
| `ts/src/accelon26/map-pane.ts` | 左欄「高麗⇄大正」分頁、由本文位置求位址 |
| `ts/src/accelon26/plates.ts` | DIA／KABC 圖版網址 |
| `ts/tools/map-test.ts` | 對照分頁與圖版選單的瀏覽器煙霧測試 |
| `ts/tools/map-check.ts` | 對照表的文字級驗證（兩側各抽 N 卷） |
| `build/posmap.bin` | 12.6 MiB 未壓縮對照表（建置中間檔，可重建） |
| `build/goryeo.adb` | 高麗藏經文（145.8 MiB） |
| `build/goryeo_taisho.adb` | 對照表（2.20 MiB；`align` 壓縮） |
| `D:\accelon3\goryeo.adb`、`D:\accelon3\goryeo_taisho.adb` | 書庫位置（桌面版開機列出；與 `taisho.adb` 同一個資料夾） |
| `build/goryeo.lines.tsv`、`build/taisho.lines.tsv` | 卷起始行 sidecar（除錯用） |

## 12. 上架官網（2026-10-30）

`goryeo_taisho.adb` 已經公開上架（2.2 MB，未超過 30 MB）：兩站都有，sha256 與本機一致。

- 說明頁：`www/adb/goryeo_taisho.html`（來源 `docs/adb/goryeo-taisho-about.md`，
  用 `ts/tools/md-page.ts` 產生）；頁面連到 <https://shutonggui.cn/tripitaka-migrator/>。
- 清單與更新：`www/adb/index.txt`、`deploy/adb-status.json`（available）、
  `deploy/adb-notes.json`（這一版的說明）→ `make-adb-index.ts`、`make-adb-manifest.ts`。
- 上傳：`bun run tools/publish-adb.ts --files goryeo_taisho.adb`（兩站、逐一驗 sha256）。
