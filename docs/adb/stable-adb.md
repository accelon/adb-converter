# 底座 adb 與功能 adb：讓 `taisho`／`wxzj` 穩定（2026-10-29）

> **來源與權利（2026-10-29）**：Taisho 的文本與底本已屬 **public domain**；
> T56–T84 的數位文字取自 **SAT 2018**，依 SAT 2018 的授權標注；TEI 標記是按
> CBETA convention 整理的。taisho／wxzj 目前仍在施工中，先不提供下載。
>
> 作者要求：`taisho.adb`、`wxzj.adb` 要像 CBETA 一樣**一年只更新兩三次**；
> 我們做的高級功能放**獨立的 adb**，不要讓使用者每次改功能就重新下載 300 MB。
> 這份文件記現況審計、分層規則、以及接下來怎麼拆。

## 1. 現況審計（2026-10-29）

`taisho.adb`、`wxzj.adb` 的 `tags` 容器只有：

```text
檔 集 英文名 聯 隱 樹 引 摘要頭 冊 段 書 頁 序 卷 經 品 其他 會 分
```

`聯` 只出現在檔頭的「最新資料請到 cbeta.org」那個外部連結；**正文沒有** `<聯>`、
`<嵌>`、`<參考資料>`、經群或其他本專案加的標記。也就是說：這兩本目前已經是
「純 CBETA 經文底座」，問題不在內容，而在**重建時機**——以前只要管線修一個標題、
頁碼或 logo，就會重建整本，使用者就得重新下載。

真正含高級功能的是這幾本（2026-10-29 統計 linked 文字檔）：

| adb | 文字 | `<聯>` 數 | 性質 |
|---|---|---:|---|
| `ys.adb` | CBETA Y 部 | 25,920 | 經文＋字元級大正連結 |
| `tx.adb` | 太虛全書 | 4,487 | 經文＋大正連結 |
| `lc.adb` | 呂澂著作集 | 1,119 | 經文＋大正連結 |
| `yulinpo.adb` | 于淩波論著 | 1,506 | 經文＋大正連結 |

這些連結目前直接寫在 adb 的 source 裡，所以改一條連結就要重建整本（ys 25 MB）。
`taisho`／`wxzj` 反而沒有這個問題。

## 2. 三層規則

### A. 底座 adb（canon base）

* 成員：`taisho.adb`（CBETA T）、`wxzj.adb`（CBETA X），以後的純經文庫也比照。
* 只從**釘住的 CBETA XML-P5 版本**建置（目前 `2026R2`，commit `dbdea41…`）。
  T 藏比較特別：CBETA XML-P5 只有 T01–T55、T85；T56–T84 文本與底本為 public domain，
  數位文字取自 **SAT 2018**（依其授權標注）。`tei2adb -tei "A;B"` 會同一冊取第一個找得到的來源。
* **不放入**任何本專案的標記：`<聯>` 正文連結、`<嵌>`、`<參考資料>`、經群、校訂、
  書籤…。檔頭的 `<聯 l="…">`（連到 cbeta.org）是格式的一部分，不在此限。
* 重建時機：CBETA 發新版本（一年 2–3 次），或頁碼／格式真的必須跟著變。
* 帳本：`deploy/cbeta-base.json` 記 tag／commit／sha256／size。
  發佈前跑 `bun run tools/cbeta-base.ts --check`；底座 sha 變了但 tag 沒變，
  就表示「這次改動應該放功能 adb」。
* **<30 MB** 的 adb 可以經常更新；**>30 MB** 的底座仍可整檔下載，但只在 CBETA 換版等
  重大更新時才換版，且不列入桌面版的「全部更新」。伺服器每月 1 TB 流量，所以大檔要省著換。
* `publish-adb.ts` 對 >30 MB 的檔要求明確加 `--allow-large`；wip／revision 一律不上傳。
* 不列在「公開數據庫」頁面的大檔（taisho／wxzj）仍納入 manifest 版本記錄：清單來源是
  `www/adb/index.txt` ＋ `deploy/adb-extra.txt`；施工中時 `downloadable:false`，
  整理完成後可改成 available，讓使用者整檔下載。

### B. 標注 adb（annotated canon，過渡期）

* 成員：`ys.adb`、`tx.adb`、`lc.adb`、`yulinpo.adb` 等「經文＋連結」的庫。
* 現況是經文與連結同一個檔；目標是拆成：
  * `ys.adb`：純 CBETA Y 經文（底座，跟 Y 的 CBETA 版本）
  * `ys-xref.adb`：25,920 條連結（小檔，常更新）
* App 需要支援「同一個庫的 sidecar 疊加」：開啟 `ys.adb` 時自動讀 `ys-xref.adb`，
  把連結疊在對應頁／行上；搜尋、反鏈、跳至都用疊加後的結果。
* 在 App 支援前，**不要**為了改連結去重建 `taisho`／`wxzj`（它們本來就沒有連結）；
  重建 `ys` 等是過渡期的必要之惡，但可以只換那一本，不要連底座一起換。

### C. 功能 adb（feature）

* 例子：`jingang.adb`（金剛經注疏的 `<嵌>` 文內嵌入）、未來的 `jingqun.adb`（經群）。
* 命名：`<主題>.adb`，檔頭 `<參照 n="taisho"/>` 說明它以哪個底座為目標（未強制）。
* 只放功能資料，不放整本經文；版本與底座脫鉤，可以天天更新。
* 使用者可以只下載／更新功能 adb，底座不動。

## 2.1 2026-10-29 的基線

| adb | CBETA | 檔案 | 頁 id | 備註 |
|---|---|---:|---:|---|
| `taisho.adb` | 2026R2（T01–55、85）＋SAT 2018（T56–84） | 315.7 MiB | 238,278（全唯一） | 舊 2026 建置 311.3 MiB；2008 舊檔 230.4 MiB |
| `wxzj.adb` | 2026R2（X 全藏） | 235.3 MiB | 172,794（全唯一） | 舊 2026 建置 229.1 MiB；2008 舊檔 268.2 MiB |
| `ys.adb` | Y 2026R2 | 25.2 MiB | — | 只把 8 處 `27p661c` 改指 `27p661b`（頁界變動） |

## 3. 發佈檢查

```powershell
cd ts
bun run tools/cbeta-base.ts --check
# ✓ taisho.adb …  ✓ wxzj.adb …   → 底座沒動
# ✗ …                              → 見下面「換版」

# CBETA 換版後才重建底座，重建完記帳：
bun run tools/cbeta-base.ts --record taisho.adb build/taisho-2026R2.adb T
bun run tools/cbeta-base.ts --record wxzj.adb build/wxzj-2026R2.adb X
```

`--check` 只比對 `D:\accelon3\<檔名>`；若只是在 build/ 裡試作、還沒部署，不影響。

## 4. 換版流程（CBETA 發新版本時）

1. 更新 `D:\2026\xml-p5` 到新 tag（GitHub 直連不通時用 ghproxy，見 `.local/download-cbeta.ts`）。
2. 建底座：
   ```powershell
   build\tei2adb.exe -tei "D:\2026\xml-p5\T;D:\2023\sat2018\T" -vol 1-85 -release 2026.R2 -out build\tei-all-2026R2.txt
   bun run ts/tools/tei-pack.ts build\tei-all-2026R2.txt build\taisho-2026R2.adb taisho 大正新脩大藏經 logo\taisho_logo.png ""
   build\tei2adb.exe -tei D:\2026\xml-p5\X -canon X -vol 1-88 -release 2026.R2 -out build\wxzj-tei-2026R2.txt
   bun run ts/tools/tei-pack.ts build\wxzj-tei-2026R2.txt build\wxzj-2026R2.adb wxzj 卍新纂續藏經 logo\wxzj_logo.png ""
   ```
3. 驗證：頁 id 唯一、`abx inspect`、抽幾頁跟舊版比對、`probe-adb` 查詢。
4. 拷到 `D:\accelon3\`，跑 `cbeta-base.ts --record`，更新 `deploy/adb-notes.json`
   的版本說明（要寫「CBETA 2026.R2（2026-09-06）」），再 `make-adb-manifest.ts`。
5. 兩站同步 `publish-adb.ts`。

## 5. 還沒做（下一步）

* App 的 sidecar／疊加載入（B 層）：先支援 `*-xref.adb`，再做 `<嵌>`／經群。
* 把 `ys/tx/lc/yulinpo` 的連結抽成 `*-xref.adb`（需要新的 overlay 格式與渲染注入）。
* 功能 adb 的清單與獨立版本歷史（manifest 已支援每本 history，只要分開上架）。
