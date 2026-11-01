# 悉曇字／蘭札字：碼位、字型與測試頁

> 作者 2026-10-31。這一頁記錄 CBETA 梵字（悉曇 SD、蘭札 RJ）在 accelon26 的
> 碼位換算、字型建置，以及「設置 → 悉曇」測試頁的來源。

## 1. 結論（先看這個）

| 梵字碼 | Unicode 碼位 | 例 |
|---|---|---|
| `SD-XXXX` | `U+FA000 + XXXX`（第 16 平面私用區） | `SD-D5B5` → `U+1075B5` |
| `RJ-XXXX` | `U+100000 + XXXX`（第 16 平面私用區） | `RJ-CCBA` → `U+10CCBA` |

- `XXXX` 是十六進位；CBETA 的 `cbeta_sanskrit.csv` 的 `pua` 欄就是結果。
- CBETA TEI 的 `<g ref="#SD-…">`／`<g ref="#RJ-…">`（舊式 `&SD;`）在 `taisho.adb`
  裏已換成上面的 PUA 字元；所以閱讀器只要「讓這些碼位有字型」就能顯示。
- 兩個碼位區間都在 **Unicode 第 16 平面（U+100000–U+10FFFD）**，系統字型不會有；
  必須自帶 Web Font。

## 2. 為甚麼不能直接用 CBETA 原字型

`cbeta.org` 下載的 `Siddam.ttf`／`Ranjana.ttf` **不是**用 PUA 碼位排字。它們把梵字
畫在「Big5 載體字」上：`cbeta_sanskrit.csv` 的 `char` 欄就是那個字。例如：

| 梵字碼 | PUA | 載體字（Big5） | 原字型用哪個字畫 |
|---|---|---|---|
| `SD-D5B5` | `U+1075B5` | `桮`（Big5 `0xD5B5`） | `桮` |
| `SD-A5A9` | `U+1045A9` | `巧`（na） | `巧` |
| `RJ-CCBA` | `U+10CCBA` | `抮`（oṃ） | `抮` |

所以原字型只適合「把經文換成 Big5 載體字再套字型」的舊做法；直接拿 PUA 經文去排，
只會看到豆腐。

**本專案的處理**：`ts/tools/build-sanskrit-fonts.py` 讀 `cbeta_sanskrit.csv`，
把每個載體字對到的 glyph 重新掛到 PUA 碼位（cmap format 12），再子集化成 WOFF2：

```text
ts/src/accelon26/fonts/accelon-siddham.woff2   415.6 KiB（2074 字）
ts/src/accelon26/fonts/accelon-ranjana.woff2    18.4 KiB（166 字）
```

建置產物（WOFF2）放在 `ts/src/accelon26/fonts/`；平日建置不需要重新產生，也不需要網路。

### 2.1 SAT 的悉曇連字（2026-10-31 新增）

SAT 2018 的梵字碼不是 `SD-XXXX`，而是 `SD` + 5 位 hex（例 `SDFF878`＝`rdhla`）；
一個碼是一個**連字**，`charDecl` 給的是 2–7 個悉曇字母的 Unicode 序列
（`U+115A8 RA` ＋ `U+115BF VIRAMA` ＋ …）。這種碼沒有單一 PUA 可換，所以
`taisho.adb` 裡仍是 `&SDxxxxx;`（一個碼一個 VA）。

顯示時由閱讀器換成序列，用 **Noto Sans Siddham** 子集排連字：

```text
ts/src/accelon26/fonts/accelon-siddham-unicode.woff2   48.7 KiB（U+11580–115FF）
ts/src/accelon26/siddham-seq.ts                        3,673 碼 → 序列
```

- 授權：SIL OFL 1.1（`OFL-NotoSansSiddham.txt`），可自由嵌入。
- 產生：`python ts/tools/build-siddham-unicode.py`（子集保留 GSUB，連字才會成形）。
- 渲染：`render_accelon3.ts` 的 `emit()` → `<span class="sdSeq">序列</span>`；
  adb 文字與 VA 都不變。詳見 [missing-char.md](./missing-char.md) §4.4。

## 3. 測試頁（設置 → 悉曇）

沒有 `taisho.adb` 的讀者也可以看字型效果。測試頁在：

```text
設置（齒輪）→ 悉曇
```

頁面直接內嵌兩段 CBETA 經文（資料在 `ts/src/accelon26/siddham-demo-data.ts`），
並附「梵字碼 → Unicode → 羅馬拼音 → 次數」對照表。

頁面上有「字形右邊顯示 IAST 轉寫」核取方塊（作者 2026-10-31）：

- 預設關閉；打開後在每個梵字右邊以較小的灰字顯示 IAST（**不加括號**），
  字本身仍有 `title` 提示。
- 偏好存在這台電腦的 `localStorage['accelon26.sanskritIast']`；只影響這一頁，
  不寫進 `settings.json`。
- 打開後一行會變寬，允許在「字＋轉寫」之間換行（以 `<wbr>`，不影響複製）。

| 字型 | 位置 | 來源 |
|---|---|---|
| 悉曇 | `T21n1213_p0072b08` | 《千臂軍荼利梵字真言》，T21 no. 1213，p. 72b08（251 字） |
| 蘭札 | `X23n0446_p0762b05` | 《七俱胝佛母所說準提陀羅尼經會釋》，X23 no. 0446，p. 762b05–08 |

CBETA Online：
- <https://cbetaonline.dila.edu.tw/zh-tw/T21n1213_p0072b08>
- <https://cbetaonline.dila.edu.tw/zh-tw/X23n0446_p0762b05>

CBETA Online 的梵字其實是 **GIF**（`images/sd-gif/…`、`images/rj-gif/…`），
不是字型；測試頁則用字型直接排字，方便核對。讀者可把兩邊並排比對。

## 4. 字型的來源與授權

- 悉曇：`https://cbeta.org/files/fonts/siddam_20260728.zip`（Siddam 1.062，2023-06-21）
- 蘭札：`https://cbeta.org/files/fonts/ranjana_20230621.zip`（Ranjana 2.000，2023-06-21）
- 梵字資料表：`https://github.com/cbeta-org/cbeta_gaiji` 的 `cbeta_sanskrit.csv`
- 授權：CBETA 字型免費提供**非營利及個人研究使用**；各來源字型著作權屬原作者。
  本專案只做子集化與 cmap 改寫，並在程式中標注來源。若要商業使用，請依 CBETA
  網站的說明另行取得授權。

## 5. 重新產生字型

需要 Python 3、`fonttools`、`brotli`：

```powershell
pip install fonttools brotli

# 1) 解壓 CBETA 字型 zip 到 build/fonts（Siddam.ttf、Ranjana.ttf）
# 2) 下載 cbeta_sanskrit.csv 到同一個資料夾
python ts/tools/build-sanskrit-fonts.py --src build/fonts --out ts/src/accelon26/fonts
```

腳本會：
1. 依 `char` 欄找原字型的 glyph；
2. 把 cmap 換成 PUA（`SD → 0xFA000+XXXX`、`RJ → 0x100000+XXXX`）；
3. 子集化、改名（`Accelon Siddham`／`Accelon Ranjana`）並輸出 WOFF2。

## 6. 閱讀器怎麼用

- `ts/tools/page-build.ts` 在**建置單檔 HTML**時讀 WOFF2，以 data URI 寫進
  `@font-face`（`unicode-range: U+100000-10FFFD`）。因此：
  - 網頁版 `D:\accelon3\accelon26.html` 一個檔案帶著走，不需要旁邊的字型檔；
  - 桌面版 `wails/assets/index.html` 吃到同一份，exe 內嵌，不假設使用者安裝字型。
- 字型家族加在本文與 UI 的字型堆疊最前面（`tag-style.ts` 的 `BODY_STACK`、
  `doc-pane.ts` 的 `DOC_TEXT_FAMILY`、模板的 `body`／`#docText .docBody`）。
  因為字型只涵蓋第 16 平面私用區，不會影響一般漢字。
- 蘭札字身比悉曇小很多，`@font-face` 用 `size-adjust:160%` 讓它和漢字並排時
  視覺大小一致。

## 7. 已驗證／未驗證

- 已用 Edge headless 實際載入 `D:\accelon3\accelon26.html`，在「悉曇」分頁
  確認 251 字悉曇與 5 句蘭札都以此字型顯示（非豆腐、非 GIF）。
- 已抽樣比對 CBETA Online 的 GIF（`SD-D5B5.gif` 等）與字型輸出的字形，形狀一致。
- 已回查 `taisho.adb`：梵字 token `U+1075B5` 的 posting 指向實體行 1620582，
  該行前 14 個字元的序列與 XML `pT21p0072b0801` 完全相同
  （`U+1075B5 U+1045A9 U+1045ED U+1045FD U+105448 U+104A5E U+1045F2 U+1045F1
  U+1077C4 U+1045A9 U+1045F0 U+1080BD U+1069FD U+104656`），
  可見 `taisho.adb` 用的就是這一串 PUA，不是載體字。
- 尚未在 iOS／舊版 Safari 驗證 `size-adjust` 與第 16 平面 Web Font；
  桌面版（WebView2）與 Chromium 正常。

