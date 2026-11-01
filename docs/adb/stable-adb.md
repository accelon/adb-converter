# 底座 adb 與功能 adb：讓 `taisho`／`wxzj` 穩定（2026-10-29）

> 共用規則（容器、VA、漢字位置、缺字、詞彙、`j`）集中在
> [adb-knowhow.md](./adb-knowhow.md)；這一頁只談「哪一層、什麼時候換版」。

> **來源與權利（2026-10-29）**：Taisho 的文本與底本已屬 **public domain**；
> T56–T84 的數位文字取自 **SAT 2018**，依 SAT 2018 的授權標注；TEI 標記是按
> CBETA convention 整理的。**taisho 已於 2026-10-29 開放整檔下載**；`wxzj` 也在
> **2026-10-31 開放整檔下載**（234.4 MiB）。
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
* 缺字（`&CB;`／`&SD;`／`&RJ;`）與梵字字型的規則、目前數字：
  [missing-char.md](./missing-char.md)。2026-10-31 重建 wxzj 後，SD／RJ 已全部換成 PUA
  （內嵌字型顯示），CB 只剩沒有 Unicode 的 1,772 碼。taisho 於 2026-11-01 把
  plane-15 PUA 有 `norm_big5_char` 的 216 碼換成通用字，剩 715 碼只有組字式。
* `publish-adb.ts` 對 >30 MB 的檔要求明確加 `--allow-large`；wip／revision 一律不上傳。
* `taisho.adb`（331 MB）已列入 `www/adb/index.txt`，狀態 available、`downloadable:true`、
  `large:true`、不列入桌面版的「全部更新」；`wxzj.adb` 於 2026-10-31 開放，
  同樣是 `large:true`、整檔下載（清單來源是 `www/adb/index.txt` ＋ `deploy/adb-extra.txt`）。

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

## 2.1 2026-10-31 的基線

| adb | CBETA | 檔案 | 頁 id | 備註 |
|---|---|---:|---:|---|
| `taisho.adb` | 2026R2（T01–55、85）＋SAT 2018（T56–84） | 314.7 MiB | 238,278（全唯一） | 2026-11-01 第二批：plane-15 PUA 216 碼／1,047 次換通用字（2,425→1,378 次、931→715 碼）；329,957,672 bytes、6,745,515 行、tokens 27,225、maxVA 122,054,261 |
| `wxzj.adb` | 2026R2（X 全藏） | 234.4 MiB | 172,794（全唯一） | 2026-11-01 重打包（代理對＝1 VA）：245,818,762 bytes、tokens 17,665、maxVA 84,453,795；2026-10-29 版 235.3 MiB；2008 舊檔 268.2 MiB |
| `ys.adb` | Y 2026R2 | 27.0 MiB | — | 2026-11-01 重建：術語斷詞修正、glossary 重建（28,289,175 bytes；漢梵對照 8,966、xrev 20,752） |

## 3. 發佈檢查

```powershell
cd ts
bun run tools/cbeta-base.ts --check
# ✓ taisho.adb …  ✓ wxzj.adb …   → 底座沒動
# ✗ …                              → 見下面「換版」

# CBETA 換版後才重建底座，重建完記帳：
bun run tools/cbeta-base.ts --record taisho.adb build/taisho-rebuild.adb T
bun run tools/cbeta-base.ts --record wxzj.adb build/wxzj-2026R2.adb X
```

`--check` 只比對 `D:\accelon3\<檔名>`；若只是在 build/ 裡試作、還沒部署，不影響。

## 3.1 `<註>`／`<釋>` 的 `pg` 屬性：docx 要、TEI 不要（作者 2026-11-01）

腳注用 `<註 n="45"/>`（正文的引用）與 `<釋 n="45">…</釋>`（檔尾或段落旁的注文）配對，
閱讀器（`ts/src/accelon26/notes.ts` 的 `pickNote`）的配對順序是：

1. **`pg` 相同 → 直接取**（`<註 … pg="yl38p24"/>` ↔ `<釋 … pg="yl38p24">`）
2. 否則同頁（由 `<頁>` 的 VA 推）最近一條
3. 否則 n 相同、離目前頁最近那條

所以：

* **從 docx 轉來的 adb（福嚴講義 `fuyan`／`fuyan-反鏈版`、空之探究 `yl38`／`yl38-test`…）要寫 `pg`。**
  原書每一「節」都從 1 重新編號，同一個 n 在一本書裡有好多條（yl38 的 `n=45` 有 9 條），
  只靠「同頁／最近」會配到別節；`pg` 就是每條註／釋自己那一頁的頁 id（`<頁 id="…">` 的 id，
  例如 `yl38p24`）。建置時把頁 id 一併寫進 `<註>` 與 `<釋>` 的 `pg` 屬性即可，
  不必改 n 的規則（每節重編是原書格式）。**新的 docx 來源一律帶 `pg`**（成本很小）。
* **從 TEI 來的 adb（`ys`、`taisho`、`wxzj`…）不需要 `pg`。** CBETA 的註號本身唯一
  （ys 是 `13.001` 這種帶卷／序的寫法），一個 n 只對一條釋，配對不會有歧義；
  閱讀器沒有 `pg` 就自動退化到 (2)(3)，行為與以前相同。
* `fuyan.adb` 的注釋就在正文裡、n 也不重複（`註.n`／`釋.n` 各 1,254），目前沒有 `pg` 也正確。
  2026-11-01 實測：`yl38.adb` 有 `註.pg` 1,271／`釋.pg` 1,269；`yl38-test.adb` 與 `fuyan*.adb` 還沒有。

驗證工具：`cd ts; bun run tools/note-link-test.ts`（hover 與點擊必須落在同一條；
含「45／46／13／14／23 各在兩個不同節各測一次」），`tools/note-probe.ts --n 45 --page yl38p24`
可列出某個 n 的所有註／釋分佈；App 內另有 `__accelon26.notePagesOf(n)`。

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
