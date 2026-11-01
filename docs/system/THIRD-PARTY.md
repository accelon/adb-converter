# Third-party notices

本專案執行期沒有 npm 依賴；以下兩個元件以 vendored 形式放在 ts/src/vendor/，只隨
單檔 HTML 一起發出。

## CodeMirror 6

* 套件：@codemirror/state、@codemirror/view、@codemirror/commands（build 時打包）
* 授權：MIT
* 檔案：ts/src/vendor/codemirror/codemirror.js、LICENSE-state／LICENSE-view／LICENSE-commands
* 重新產生：ts/tools/build-codemirror.ts（開發用；需要 npm 安裝上述套件）

## bzip2-wasm

* 來源：bzip2-wasm 1.0.1（Zorian Medwid），內含 bzip2 1.0.8
* 授權：bzip2-1.0.6（見 ts/src/vendor/bzip2-wasm/LICENSE）
* 檔案：bzip2.mjs、bzip2.wasm、bzip2-wasm-data.ts
* 重新產生 base64：ts/tools/gen-bzip2-wasm.ts
* 已把 import.meta.url 兩處改成單檔可用的字串；wasmBinary 由 bzip2-wasm.ts 直接提供，不再 fetch 旁邊的 .wasm。

## CBETA 悉曇／蘭札字型

* 來源：CBETA（財團法人佛教電子佛典基金會）
  - Siddam 1.062（2023-06-21）：https://cbeta.org/files/fonts/siddam_20260728.zip
  - Ranjana 2.000（2023-06-21）：https://cbeta.org/files/fonts/ranjana_20230621.zip
  - 梵字資料表：https://github.com/cbeta-org/cbeta_gaiji（`cbeta_sanskrit.csv`）
* 授權：CBETA 免費提供**非營利及個人研究使用**；字型著作權屬原作者。商業使用請另洽 CBETA。
* 檔案：`ts/src/accelon26/fonts/accelon-siddham.woff2`、`accelon-ranjana.woff2`
  （子集化＋cmap 改寫；只含測試頁與 CBETA 梵字資料表用到的字）
* 重新產生：`ts/tools/build-sanskrit-fonts.py`（需要 Python、fonttools、brotli）
* 說明：`docs/adb/siddham-ranjana.md`

## Noto Sans Siddham（Unicode 悉曇）

* 來源：Google Fonts / Noto Project（https://github.com/notofonts/siddham）
* 授權：SIL Open Font License 1.1（`ts/src/accelon26/fonts/OFL-NotoSansSiddham.txt`）
* 檔案：`ts/src/accelon26/fonts/accelon-siddham-unicode.woff2`
  （子集到 U+11580–115FF，保留 GSUB 連字規則）
* 用途：SAT 2018 的悉曇連字（`&SDxxxxx;`）與 CBETA 悉曇 PUA 在顯示時換成
  Unicode 序列後用它排版；文字仍是 `&SDxxxxx;`／PUA，一個碼一個 VA。
* 重新產生：`python ts/tools/build-siddham-unicode.py`（需要 fonttools、brotli）

## CBETA 悉曇補充字形（Accelon Siddham Extra）

* 來源：CBETA `Siddam.ttf`（2023-06-21），只抽 Noto 排不出來的 81 個字形
* 授權：CBETA 免費提供非營利及個人研究使用（同 Ranjana）
* 檔案：`ts/src/accelon26/fonts/accelon-siddham-extra.woff2`（12.1 KiB）
* 重新產生：`python ts/tools/build-siddham-extra.py`
* 說明：`docs/adb/missing-char.md` §4.4
