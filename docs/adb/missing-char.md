# 缺字與字型處理（CBETA 底座）

> 作者 2026-10-31。**重要文件**：說明 `&CB;`、`&SD;`、`&RJ;` 三種缺字在
> TEI → adb 的處理規則、目前 `taisho.adb`／`wxzj.adb` 的實際數字，以及
> 悉曇／蘭札字型的來源與嵌入方式。

## 0. 一句話

- **CB 缺字**：有真 Unicode 就換；只有 PUA 的若 CBETA 外字庫有
  `norm_big5_char`（通用字）就換通用字；都沒有才保留 `&CBxxxxx;`，並列進
  `taisho-missing-gaiji.tsv`／`wxzj-missing-gaiji.tsv`。
- **SD／RJ 梵字**：一律換成 Unicode 第 16 平面私用區
  （`SD-XXXX → U+FA000+XXXX`、`RJ-XXXX → U+100000+XXXX`），由內嵌的
  CBETA Siddam／Ranjana Web Font 顯示；**不再留 `&SD-…;`／`&RJ-…;`**。
  （SAT 2018 另有 `&SDxxxxx;` 這種非 4 位 hex 的碼，沒有公式，仍保留，見 §4.4。）

## 1. 三種字碼

| 類別 | TEI 寫法 | 解碼 | 目標 |
|---|---|---|---|
| CB 缺字 | `<g ref="#CB00178"/>` | `teiHeader/charDecl` 的 `<mapping type="unicode">`／`normal_unicode`（轉換器**不讀**外部 CSV；`cbeta_gaiji.csv` 供事後核對與 §2.5 的通用字替換） | 真 Unicode；沒有就 `&CB00178;` |
| 悉曇 | `<g ref="#SD-D5B5">…</g>` | `SD-XXXX` 的 XXXX 是十六進位 | `U+FA000 + XXXX`（例 `U+1075B5`） |
| 蘭札 | `<g ref="#RJ-CCBA">…</g>` | 同上 | `U+100000 + XXXX`（例 `U+10CCBA`） |

補充：

- `&CB…;`／`&SD-…;`／`&RJ-…;` 是 **adb 文字裡的未解碼佔位**，不是 TEI 實體；
  轉換成功就不會出現在成品。
- SD／RJ 的公式與 CBETA 的 `cbeta_gaiji` 專案 `cbeta_sanskrit.csv` 的 `pua` 欄完全一致
  （2,240 個梵字碼全部驗過，0 個例外）。
- 梵字碼的區間換算後都在 **Unicode 第 16 平面（U+100000–U+10FFFD）**；
  系統字型不會有，必須自帶字型（見 §5）。

## 2. 轉換規則（`cmd/tei2adb`）

### 2.1 `<g>` 的處理順序

```text
<g ref="#CB…">內文</g>
  1. 內文是「單一真字」且不是 PUA        → 用內文
  2. 否則 charDecl 的 unicode／normal_unicode → 用 charDecl
  3. charDecl 只有 PUA 對應              → 用 PUA 字元（沿用舊版行為）
  4. 都沒有                              → 留 &CB…;，記進 missing 清單

<g ref="#SD-XXXX">內文</g> 或 <g ref="#RJ-XXXX">…</g>
  1. 內文是單一 plane 16 PUA              → 用內文（CBETA 已給的梵字）
  2. 否則按公式算 U+FA000／U+100000       → 用算出的 PUA
  3. 都沒有                              → 留 &SD-…;／&RJ-…;，記進 missing 清單
```

- 自閉合 `<g ref="#…"/>` 沒有內文，直接走 charDecl／公式。
- **CB 的內文若是 PUA**（例 `CB15131` 內文是 `U+F3B1B`），不直接採用；
  會改用 charDecl 的真 Unicode；只有 PUA 對應時才用 charDecl 的 PUA
  （2026-10-31 補回，避免重建後把 6,688 個字變成 `&CB…;` 實體）。
- `charDecl` 是**每個 XML 檔自己的 `teiHeader`**；同一個 CB 碼在不同檔可能宣告不同。

### 2.2 缺字清單

沒有解碼的碼會寫成 TSV（`code`、`count`），檔名依藏別：

| 藏 | 檔名 |
|---|---|
| T 藏 | `taisho-missing-gaiji.tsv` |
| X 藏 | `wxzj-missing-gaiji.tsv` |

2026-10-31 之前檔名寫死成 `taisho-missing-gaiji.tsv`，重建 wxzj 會蓋掉 taisho 的清單；
現在已依 `-canon` 分開。

### 2.3 對 adb 的影響

- 一個 `&CB…;`（9 bytes 以上）換成一個 Unicode 字（UTF-8 3–4 bytes），
  檔案通常會變小、token 數也會變（實體字串不再是一個「拉丁 token」）。
- 梵字從 `&SD-…;` 換成 plane 16 PUA：**單獨替換不會改變 VA**（兩邊都是一個 token）；
  只有同時刪掉／新增別的文字或標籤，整體 VA 才會變動。頁 id（`NpMc`）不受影響。

### 2.4 VA 不變式（重要，2026-10-31）

**一個缺字／梵字，在 adb 文字裡必須恰好佔 1 個 VA（= 1 個 token）。**
這樣將來換表示方式（例如 `D:\2023\glyphwiki` 的構形）時，已經算好的引文座標不會跑掉。

目前 tokenizer 的實際行為（`ts/src/tokenize.ts`）：

| 寫法 | token 數 | VA |
|---|---:|---:|
| `&CB00178;`、`&SD-D5B5;`、`&RJ-CCBA;` | 1 | +1（`&`…`;` 是 strong pair） |
| 單一 BMP 字（含 BMP PUA） | 1 | +1 |
| 單一 supplementary 字（含第 16 平面 PUA） | 1（surrogate pair） | +1 |
| IDS 組字式 `⿰口口` | 1（`parseIds`） | +1 |
| 普通兩個字 `口口` | 2 | +2（**不可**拿來取代單一缺字） |
| 標籤 `<圖 …/>` | 1 個 tag | **+4**（`TAGLENGTH`）；open+close 是 +8 |

所以：

- **CB 缺字**：換成一個真 Unicode 字，或保留 `&CB…;`（都是一個 token）。
- **SD／RJ**：換成一個 plane 16 PUA（surrogate pair，仍是一個 token）。
- **將來用 glyphwiki**：最穩的是「同一個 PUA 碼位，換字型的 glyph」——文字仍是
  一個字元，VA 不變；若一定要用標籤，必須重新計算所有座標（tag 成本 4），
  不能假設只是換圖。
- **組字式**：IDS（`⿰…`）目前會被 `parseIds` 收成一個 token，所以用 IDS 取代
  一個缺字不會多佔 VA；但顯示端要能組字。
- 回歸測試：`ts/test/gaiji-va.test.ts`（`bun run test/gaiji-va.test.ts`）。

### 2.5 plane-15 PUA → 通用字（2026-11-01）

`tei2adb` 只讀 `charDecl`；`norm_big5_char` 在外部 `cbeta_gaiji.csv`，所以替換放在
**tei2adb 之後、tei-pack 之前**（工具：`tools/pua-norm.py`）：

```text
build\tei2adb.exe ... -out build\tei-all-2026R2.txt
python tools\pua-norm.py make                                        # 產生 build\pua-norm.tsv
python tools\pua-norm.py apply build\tei-all-2026R2.txt build\tei-all-2026R2-norm.txt
bun run ts/tools/tei-pack.ts build\tei-all-2026R2-norm.txt build\taisho-2026R2-norm.adb ...
```

- 條件：文字裡是 plane-15 PUA（`U+F0000+編號`）、`cbeta_gaiji.csv` 的 `unicode` 與
  `norm_unicode` 都空、`norm_big5_char` 非空且是 BMP 單字。
- 1 字換 1 字；替換字是 BMP（1 個 token），原本是 supplementary（也是 1 個 token），
  所以行界、頁 id、VA 都不變。
- 帳在 `build/pua-norm.tsv`（`code／pua／char／count`，216 列）；原始
  `build/tei-all-2026R2.txt` 要保留，`make` 才能重跑。
- 2026-11-01 實際：216 碼／1,047 次；plane-15 PUA 2,425 次／931 碼 → 1,378 次／715 碼。

## 3. `taisho.adb` 現況

- 成品：`D:\accelon3\taisho.adb`，**2026-11-01 第二次重打包**（329,957,672 bytes；
  SHA-256 `AB9C58023B63…`）。
  - 第一次（11-01 早上）：代理對改成一個字元＝1 VA（329,957,320 bytes）。
  - 第二次（11-01 晚上）：plane-15 CB PUA 有通用字的 216 碼／1,047 次換成
    `norm_big5_char`；plane-15 PUA 2,425 → 1,378 次、931 → 715 碼。
    頁 id、行數、maxVA 都不變（見 §2.5）。
- **CB 缺字已全部換掉**：`&CB…;` 0 個；只剩 715 碼只有組字式的 plane-15 PUA（見 §4.4）。
  這 715 碼的 glyph（dict.cbeta.org／`cbeta-org/gaiji-CB`）、組字式、部首等整理在
  [taisho-gaiji-dict.md](./taisho-gaiji-dict.md) 與 `docs/adb/taisho-gaiji-dict.tsv`。
- **SAT 的 `&SD-XXXX;` 也全部換成 PUA**：115,246 次／895 碼（`U+FA000+XXXX`）。
- 仍有 `&SDxxxxx;`（無連字號、非 4 位 hex）3,665 碼／3,672 次，列在
  `docs/adb/taisho-missing-gaiji.tsv`；這些是悉曇連字，`charDecl` 有 Unicode 序列，
  不是單一碼位。

## 4. `wxzj.adb` 2026-10-31 重建

### 4.1 舊文字（2026-10-29）vs 新文字

| 項目 | 舊 `wxzj-tei-2026R2.txt` | 新 `wxzj-tei-2026R2-new.txt` |
|---|---|---|
| `&CB…;` | 81,857 次／4,990 碼 | **18,688 次／1,772 碼** |
| `&SD-…;` | 4,062 次／513 碼 | **0** |
| `&RJ-…;` | 702 次／108 碼 | **0** |
| PUA 字元 | 30,235 次／2,746 碼（含 CB PUA） | **4,764 次／621 碼**（全部是 SD／RJ） |

新文字 4,262,468 行；`&CB…;` 只剩沒有 Unicode 的 1,772 碼。

### 4.2 新成品

| 項目 | 數值 |
|---|---|
| 檔案 | `build/wxzj-2026R2-new.adb`（245,818,762 bytes／234.4 MiB） |
| SHA-256 | `EB7374EE5A0387E912B0E14338097234BEB6B3A2406708FC0478252AB607569F` |
| 行數 | 4,262,468（`tei-pack` 把 3 行超長行切開） |
| 冊／書／卷 | 86／1,236／8,937 |
| 頁（`<頁 id>`） | 172,794（全部唯一） |
| tokens | 17,665 種／83,567,635 筆（舊：23,391／83,654,260） |
| 標記 | 30 種 |
| maxVA | 84,453,795 |
| resources | `wxzj_logo.png`（273,121 bytes） |

### 4.3 剩下的 CB 缺字

- 清單：`docs/adb/wxzj-missing-gaiji.tsv`（1,772 碼／18,688 次）。
- 最常見的：`CB15106`（1,655）、`CB15131`（1,587）、`CB15156`（1,442）、
  `CB15179`（1,155）、`CB15111`（1,110）、`CB16014`（1,011）、`CB10437`（997）。
- 這 1,772 碼在 CBETA 的 `cbeta_gaiji.csv` 裡都**沒有 `unicode`／`norm_unicode`**；
  它們只有 `composition`（組字式），其中 257 碼另有 `norm_big5_char`（通用字）。
- **`norm_big5_char` 可採用（政策 2026-11-01 更新）**：那是 CBETA 給的「通用字」
  （例 `CB15131` 的 composition 是 `[邱-丘+(看-目)]`，norm 是 `邦`）。taisho 已用它把
  216 碼／1,047 次只有 PUA 的 CB 缺字換成通用字，頁 id／行數／VA 不變（見 §2.5、§4.4）。
  wxzj 的 257 碼因這一版沒有重建，先保留 `&CB…;`；下次重建 wxzj 時再比照處理。
- 全部 1,772 碼都有 composition，未來可考慮用 IDS／組字或 glyphwiki 構形產生字形
  （見 §7）。

### 4.4 三庫缺字總表（2026-11-01 更新）

| 庫 | `&CB…;` | CB（只有 PUA，文字裡是 PUA 字元） | `&SD-XXXX;` | `&SDxxxxx;`（SAT 另一型） | 說明 |
|---|---|---|---|---|---|
| `taisho.adb` | **0** | **715 碼／1,378 次** | **0** | 3,665 碼／3,672 次 | SD-XXXX 115,246 次已全部換成 plane 16 PUA；plane-15 PUA 已有 216 碼／1,047 次換成通用字 |
| `wxzj.adb` | 1,772 碼／18,688 次 | 0 | 0 | 0 | 全部有 composition |
| `ys.adb` | **0** | 0 | 0 | 0 | CBETA Y 部 gaiji 484 個全部解出（missing=0） |

> **「只有 PUA」的 CB 缺字**：`tei2adb` 在 charDecl 沒有 unicode、只有 PUA 對應時，
> 會沿用 PUA 字元（不寫成 `&CB…;`），所以它們**不會**出現在
> `taisho-missing-gaiji.tsv`。2026-11-01 之前 taisho 有 **931 碼／2,425 次**屬於這一類；
> 其中 **216 碼／1,047 次**有 `norm_big5_char`，已換成通用字
> （例 `CB04636`→`璿`、151 次），剩下 **715 碼／1,378 次**只有組字式。要找回它們：
> 掃文字裡的 plane-15 PUA，碼位 `U+F0000 + 編號`（`CB04636` → `U+F121C`），
> 清單在 `docs/adb/taisho-pua-gaiji.tsv`（`build/pua-only.py` 產生）。

- 合併清單：`docs/adb/missing-gaiji-final.tsv`（6,160 列；欄位
  `db, kind, code, count, composition, unicode, norm_big5`，`kind` 為
  `cb`／`cb-pua`／`sd`），由 `build/missing-report.py` 從
  `build/*-missing-gaiji.tsv` ＋ `build/fonts/cbeta_gaiji.csv` ＋ SAT 的
  `charDecl` 產生。
- wxzj 的 1,772 個組字式：**700** 個只用 `*`／`/`／`@`（可直接拼），
  **1,039** 個含 `-`（需要「取代」語意），**71** 個含 `?`（字根未知，可能畫不出）。
- `taisho` 的 3,665 個 `&SDxxxxx;` 是 **SAT 自己的 5 位 hex 梵字碼**（不是 CBETA 的
  `SD-XXXX`）：一個碼＝一個**悉曇連字（conjunct）**，`charDecl` 用
  `<mapping type="unicode">` 記成 2–7 個悉曇字母的序列
  （例 `SDFF878`＝`rdhla`＝`𑖨𑖿𑖠𑖿𑖩`＝ra＋virama＋dha＋virama＋la）。
  序列長度 1–12 個字元不等，**不能**用單一 PUA 表示。
- 為什麼這麼多：悉曇文本裡每一個不同的連字都各自一碼，而且幾乎都只出現一次
  （3,665 碼／3,672 次）。
- 能不能對到現有字型？用 `romanized` 去對 CBETA 的 2,240 個單一字形：
  1,657 碼有對到（其中 1,418 碼的 PUA 在我們字型的 cmap 內），**但不可靠**——
  這 1,657 碼只有 350 種 romanized，等於大量不同的連字共用同一個拼音，
  自動對會挑錯字形。所以沒有轉。
- **顯示（2026-10-31 已完成）**：閱讀器把 `&SDxxxxx;` 換成 Unicode 序列，
  用 **Noto Sans Siddham** 子集（SIL OFL 1.1）排連字。
  - 字型：`ts/src/accelon26/fonts/accelon-siddham-unicode.woff2`（48.7 KiB，
    U+11580–115FF，保留 GSUB）；`python ts/tools/build-siddham-unicode.py` 重建。
  - 對照表：`ts/src/accelon26/siddham-seq.ts`（3,673 碼，`python build/gen-siddham-seq.py`）。
  - 規則：`render_accelon3.ts` 的 `emit()` 遇到 `&SD…;` 就輸出
    `<span class="sdSeq">序列</span>`；adb 文字、raw、VA 都不變（找不到序列就照舊）。
  - 測試：`bun run test/siddham-seq.test.ts`（8 項）。
- 另一個方向（未做）：把連字畫成單一字形放進自帶字型（PUA 或 GSUB）。
- **PUA 梵字的 Noto（2026-11-01 起為預設）**：`docs/adb/pua-seq.tsv` 把 2,074 個 SD
  的 PUA 對到 Unicode 序列（1,993 個可排成一個連字；81 個沒有 romanized 或
  是兩個音節，保留 PUA）。閱讀器在**顯示時**替換（`ts/src/accelon26/pua-seq.ts`），
  Noto 排不出來的 81 個字用從 CBETA 抽出的 12.1 KiB 補充字型
  （`accelon-siddham-extra.woff2`）。原本 415.6 KiB 的 CBETA 悉曇字型不再內嵌。
  adb 文字仍是 PUA，VA 不變。
- 未來的顯示方向：保留 `&…;` 佔位（**仍算 1 個 VA**，見 §2.4），由閱讀器
  查表用 glyphwiki 的自由組字即時畫出，不動 adb 文字與引文座標。

## 5. 字型處理（悉曇／蘭札）

### 5.1 為什麼不能直接用原字型

CBETA 下載的 `Siddam.ttf`／`Ranjana.ttf` **不是**用 PUA 排字；它們把梵字畫在
「Big5 載體字」上（`cbeta_sanskrit.csv` 的 `char` 欄）。所以原字型只適合
「把經文換成載體字再套字型」的舊做法。

本專案用 `ts/tools/build-sanskrit-fonts.py`：

1. 依 `char` 欄找到原字型的 glyph；
2. 把 cmap 改寫成 PUA（`SD → U+FA000+XXXX`、`RJ → U+100000+XXXX`，cmap format 12）；
3. 子集化、改名（`Accelon Siddham`／`Accelon Ranjana`），輸出 WOFF2。

成品：

| 檔案 | 大小 | 字數 |
|---|---|---|
| `ts/src/accelon26/fonts/accelon-siddham.woff2` | 415.6 KiB | 2,074 |
| `ts/src/accelon26/fonts/accelon-ranjana.woff2` | 18.4 KiB | 166 |

### 5.2 閱讀器怎麼用

- `ts/tools/page-build.ts` 在**建置單檔 HTML**時把 WOFF2 以 data URI 放進
  `@font-face`（`unicode-range: U+100000-10FFFD`）；網頁版一個檔案帶著走，
  桌面版 `wails/assets/index.html` 也內嵌同一份，**不假設使用者安裝字型**。
- 字型家族加在本文／UI 字型堆疊最前面（`tag-style.ts`、`doc-pane.ts`、模板）。
  只涵蓋第 16 平面私用區，不影響一般漢字。
- 蘭札字身較小，`@font-face` 用 `size-adjust:160%`。
- 字型來源：CBETA（Siddam 1.062、Ranjana 2.000，2023-06-21）；
  免費提供非營利及個人研究使用。詳見 `docs/adb/siddham-ranjana.md`。

### 5.3 wxzj 的覆蓋率

新 wxzj 文字有 621 個不同的 SD／RJ 梵字（4,764 次）；**621 個全部在
Siddam／Ranjana 字型的 cmap 內**，沒有缺字。CB PUA（`U+F0000` 附近）
新文字已不使用，所以不需要 CB 字型。

## 6. 檢查指令

文字檔（Windows PowerShell，用 Python 避免 250 MB 檔卡住）：

```powershell
python -c "import re; s=open('build/wxzj-tei-2026R2-new.txt',encoding='utf-8').read(); [print(p, len(re.findall(p,s))) for p in [r'&CB[0-9A-F]+;', r'&SD-[0-9A-F]+;', r'&RJ-[0-9A-F]+;']]"
```

adb：

```powershell
go run ./cmd/abx inspect build\wxzj-2026R2-new.adb
bun run ts/tools/probe-adb.ts --adb build\wxzj-2026R2-new.adb --query 般若
```

抽梵字行：用 `AdbReader` 找 token `U+10CCBA` 的 posting，再用 `VaPaMapper` 取
`lineText()`（見 `build/wxzj-verify.ts` 的一次性寫法）。2026-10-31 實測：
文字檔 `&CB` 18,688 次／1,772 碼、`&SD` 0、`&RJ` 0、PUA 621 碼；adb 掃 source
blocks 因區塊邊界會少算 19 次 `&CB`，以文字檔為準。

## 7. 待辦

1. **wxzj 的 1,772 個 CB 缺字**：`docs/adb/missing-gaiji-final.tsv` 已備好
   `code／count／composition`；下一步用 `D:\2023\glyphwiki` 的自由組字畫出。
   組字式規則（CBETA 官方，`archive2.cbeta.org/format/rare-rule.php`）：

   | 符號 | 意義 | IDS 對應 |
   |---|---|---|
   | `*` | 橫向連接（明＝日\*月） | ⿰ |
   | `/` | 縱向連接（音＝立/日） | ⿱ |
   | `@` | 包含（因＝囗@大） | ⿴ |
   | `-` | 去掉某部分（青＝請-言） | 取代／刪除 |
   | `-+` | 去掉某部分再以另一部分代替（閒＝間-日+月） | 取代 |
   | `?` | 字根特別、尚未找到 | 佔位 |

   **不要**把組字式當成 Unicode 字的 IDS 來驗證：兩者測起來只有約 46% 相同，
   因為 CB 缺字本來就是「與 Unicode 字很像但不完全相同」的構形（官方欄位
   `norm_unicode` 就是在說這件事）。直接依上表解樹、用自由組字畫即可。
2. **taisho 的 SAT `&SD-XXXX;`**：✅ 2026-10-31 已換成 PUA（115,246 次／895 碼）；
   剩下的 `&SDxxxxx;`（3,665 碼）是悉曇連字，等 Unicode 悉曇字型。
3. **`norm_big5_char` 的使用**：2026-11-01 起政策改為**可採用**；taisho 已用它把
   216 碼／1,047 次只有 PUA 的 CB 缺字換成通用字（規則與帳見 §2.5、§4.3，
   `build/pua-norm.tsv`）。wxzj 的 1,772 碼中 257 碼也有 `norm_big5_char`，
   等 wxzj 下次重建再比照處理。
4. **缺字 UI**：目前 `&CB…;` 在閱讀器顯示成文字；可考慮加「缺字」樣式或
   點擊顯示 composition／書影（未做）。

## 8. 相關檔案

| 檔案 | 說明 |
|---|---|
| `cmd/tei2adb/main.go` | `<g>` → Unicode／PUA 的規則；缺字 TSV |
| `ts/tools/tei-pack.ts` | 文字 → adb |
| `docs/adb/wxzj-steps.md` | wxzj 建置步驟與本版數據 |
| `docs/adb/taisho-steps.md` | taisho 建置步驟 |
| `docs/adb/siddham-ranjana.md` | 梵字碼位與字型細節 |
| `docs/adb/missing-gaiji-final.tsv` | **三庫合併缺字總表**（6,160 列） |
| `build/missing-report.py` | 產生上面那張表的腳本 |
| `tools/pua-norm.py`、`build/pua-norm.tsv` | plane-15 PUA → 通用字的替換工具與帳（216 列） |
| `docs/adb/taisho-ids-input.tsv` | 只剩組字式的 715 碼（`code／composition／count`），給 IDS／glyphwiki |
| `docs/adb/taisho-gaiji-dict.tsv`、`.md` | 715 碼的 glyph 路徑＋組字式＋部首＋第一次出現（2026-11-01 從 dict.cbeta.org 抓） |
| `build/gaiji-gif/`、`build/gaiji-contact-sheet.png` | 715 個缺字 GIF（165 KB）與總覽圖 |
| `build/pilot-364.html`、`build/pilot-364-results.tsv` | 364 碼構形序試點（112 碼組字成功、含圖 HTML） |
| `docs/adb/taisho-gaiji-locations.md`、`.tsv` | 12 碼構形序試點的大正位置（pb／lb）與 CBETA online 連結 |
| `build/gaiji-locations.html` | 12 碼的 CBETA 缺字圖 vs 構形序組字對照（含 CBETA online 連結） |
| `docs/adb/wxzj-missing-gaiji.tsv` | wxzj 剩下的 1,772 個 CB 缺字 |
| `docs/adb/taisho-pua-gaiji.tsv` | taisho 剩下的 715 碼 plane-15 PUA（只有組字式） |
| `docs/adb/taisho-missing-gaiji.tsv` | taisho 剩下的 SAT SD 清單（3,665 碼） |
| `ts/src/accelon26/fonts/` | 內嵌的 Siddam／Ranjana WOFF2 |
