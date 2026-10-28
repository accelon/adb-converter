# goryeo.adb（高麗藏）產生步驟，與「高麗藏 → 大正藏」轉址

> 目的：用 `D:\2023\tripitaka-migrator\k-txt` 產生一份 accelon3 可讀的 `goryeo.adb`，
> 附帶高麗版經號、卷號、冊頁欄行，並把「高麗藏 ⇄ 大正藏」的字元級對齊表內嵌在檔案裡。
>
> 定位：**大正藏是主藏**。高麗藏 adb 自帶「與大正藏對齊」的資訊；`taisho.adb` 不需要知道
> 世界上還有其他藏。其他藏（yinshun 等）先用大正藏頁碼定位，再由 UI 透過高麗藏 adb 的
> 對齊表轉到高麗藏。

## 0. 成品（2026-10-28）

| 項目 | 數值 |
|---|---|
| 檔案 | 158.4 MiB |
| 冊 | 45（K01–K41、K44–K47；K42/43 無卷資料） |
| 書 | 1,507（1,502 部經；5 部跨冊，id 用 `K0001V01` 區分） |
| 卷 | 6,594（＝ juaninfo.tsv 筆數） |
| 頁欄 | 150,969 |
| 行 | 3,432,943（一行＝一個 pcl 行） |
| tokens | 10,440 種／57,202,225 筆 |
| 內嵌對齊 | `align/posmap` 12.6 MiB（6,357 卷） |
| resources | `goryeo_logo.png` |
| 檔頭 | `dbname=goryeo`、`dbcname=高麗大藏經`、`dbtype=4`、`srcBlockSize=16384`、`andtagid=21`（頁） |

## 1. 來源

| 用途 | 路徑 |
|---|---|
| 正文 | `D:\2023\tripitaka-migrator\k-txt\K01.tsv … K47.tsv`（高麗藏再雕本，東國大學 KABC 文字） |
| 卷界 | `k-txt\juaninfo.tsv`（經號／冊號／經名／卷號／起點／終點／總行數） |
| 對齊 | `D:\2023\tripitaka-migrator\posmap.db`（6,357 卷的 1:1 對應段） |
| logo | `logo/goryeo_logo.png` |

## 2. 文字處理（k-txt 的標記）

k-txt 每行是「頁行碼 TAB 文字」，文字裡混了三種 ASCII 標記：

| 標記 | 出現次數 | 意義 | 處理 |
|---|---|---|---|
| `^p` | 528,698 | 段落起點（可能在一行中間） | 刪除，保留前後漢字 |
| `^half` | 191,472 | 小字（夾註）開始 | 刪除，保留夾註文字 |
| `^jN` | 6,594 | 卷起點（單獨一行，沒有頁行碼） | 整行略過（卷界改由 juaninfo 決定） |

只移除 ASCII 標記、不動任何漢字——這一點很重要：`posmap.db` 的行幾何是用
「每行漢字數」算的，刪掉非漢字不會改變座標，所以對齊表可以直接套在新 adb 上。

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

:: 2) 大正藏文字也要一份卷起始行（給對齊表的 T 側用；不改 taisho.adb）
go run ./cmd/tei2adb -tei D:\2023\sat2018\T -vol 1-85 -out build\tei-all.txt -lines build\taisho.lines.tsv

:: 3) posmap.db + 兩份 sidecar → 內嵌用二進位表
bun run ts/tools/posmap-dump.ts D:\2023\tripitaka-migrator\posmap.db build\posmap.bin build\taisho.lines.tsv build\goryeo.lines.tsv

:: 4) 打包
bun run ts/tools/goryeo-pack.ts build\goryeo-text.txt build\goryeo.adb build\posmap.bin logo\goryeo_logo.png
```

`tei2adb -lines` 只寫 sidecar，**文字輸出與不帶 `-lines` 時完全相同**（已用 SHA256 比對）。

## 5. `align/posmap` 二進位格式（v2）

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

每行平均約 2 bytes，所以 6,357 卷的行表只佔幾 MB。

## 6. 高麗藏 → 大正藏 怎麼轉

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

### accelon26 的 API（已實作）

```js
window.__accelon26.posmapConvert('K01p0001a0105')
// { ok:true, from:'K01p0001a0105', to:'T05p0001a0404',
//   tsutra:'0220', tjuan:1, ksutra:'0001', kjuan:1, exact:true, adjust:'preface' }

window.__accelon26.posmapAtLine(588)      // 目前 adb 的行號 → 位址 → 換址
// { from:'K01p0009c0100', to:'T05p0005c0500', … }
```

`posmapAtLine` 需要 `align` 容器，目前由 **goryeo.adb** 提供；讀 taisho.adb 時若要換址，
UI 需先載入 goryeo.adb 的 `align`（或同時開著 goryeo.adb）。

## 7. 主藏架構（為什麼 taisho.adb 不必改）

```text
yinshun.adb ──<聯 i="taisho?51p185b">──▶ taisho.adb（主藏）
                                              │
                                              │  goryeo.adb 的 align 說：
                                              │  T51p185b ⇄ K17p815a03
                                              ▼
                                          goryeo.adb（帶經文＋對齊）
```

- 大正藏是連結的共通座標；所有藏都用「大正藏頁碼」互相定位。
- 每個「從藏」只記錄自己與大正藏的對齊（`align`），大正藏不需要知道從藏的存在。
- 之後要加第三、第四藏，只要各自帶一份 `align`（T 側座標不變），UI 就能做多藏互轉。
- `align` 是外層容器，accelon3 只按名字取 `source/tokens/…`，不認識的容器直接忽略：
  閱讀、檢索不受影響；換址能力只實作在 accelon26。

## 8. 驗證

| 檢查 | 結果 |
|---|---|
| 卷數 vs juaninfo | 6,594 / 6,594 |
| accelon26 開檔 | 目錄樹 45 冊、本文、搜尋正常（「涅槃」29,108 筆） |
| 換址對帳 | 與 `posmap.db` 原實作隨機比對：T→K 300/300、K→T 300/300 相同 |
| 行號換址 | `posmapAtLine(588)` → `K01p0009c0100` → `T05p0005c0500` |
| 首頁 id 鏈 | `頁.id=1p1a` → VA 297 → `<頁 id="1p1a"/>` |

## 9. 已知限制

1. **只有對得上的卷**：posmap 收 6,357 卷，高麗藏共 6,594 卷，其餘卷（內容差異大或卷數不同）沒有對照。
2. **75 個 T 卷沒有行號**（卷號與 TEI 檔名不一致），只能按位址轉，不能由 taisho 行號反推。
3. **對齊粗略的卷**（`coarse`）轉換結果僅供參考，API 會在 `note` 說明。
4. 高麗藏沒有品／附文的結構標記（k-txt 沒有），只有冊／書／卷／頁。
5. 校勘不在 goryeo.adb（k-txt 本來就沒有）。

## 10. 檔案

| 檔案 | 說明 |
|---|---|
| `cmd/k2adb/main.go` | k-txt → adb 文字（含 `-lines`） |
| `ts/tools/posmap-dump.ts` | posmap.db → 內嵌二進位表（v2，含行號） |
| `ts/tools/goryeo-pack.ts` | 文字 + 對照表 + logo → goryeo.adb |
| `ts/src/accelon26/posmap.ts` | 換址核心（解析、行列查詢、雙向轉換） |
| `build/posmap.bin` | 12.6 MiB 對照表（可重建） |
| `build/goryeo.adb` | 成品 |
| `build/goryeo.lines.tsv`、`build/taisho.lines.tsv` | 卷起始行 sidecar |
