# Accelon26／大正藏研究：2026-10-29 對話與實作總結

> 這份文件整理 2026-10-29 這一輪長對話的成果、資料格式、建置方式與未完成事項。
> 目的不是取代程式碼，而是讓下一個對話能快速接上，不必重讀整串對話。
>
> 相關文件：
> - [文件索引](../README.md)
> - [閱讀器](../software/accelon26.md)／[桌面宿主](../software/desktop.md)／
>   [官網](../software/website.md)／[發佈](../software/release.md)
> - [母庫 taisho.adb](../adb/taisho.md)／[研究讀本 taisho-study.adb](../adb/taisho-study.md)／
>   [舊 jingang](../adb/jingang.md)／[公開資料庫](../adb/public-databases.md)
> - [taisho-study-skill.md](../adb/taisho-study-skill.md)
> - [taisho-study-structure.md](../adb/taisho-study-structure.md)
> - [DEPLOY.md](./DEPLOY.md)

## 1. 一句話總結

把原本的 `jingang.adb` 擴成 `taisho-study.adb`：金剛、法華、大日三部經，加上每經不同的目錄、注疏群索引、可直接下載 adb 的桌面功能，以及官網鏡像／測速／ZIP 下載與 2026-10-29 正式版。

---

## 2. 目前產物

| 產物 | 路徑 | 大小／狀態 |
|---|---|---|
| 研究讀本 | `D:\accelon3\taisho-study.adb` | 1,226,874 bytes（約 1.2 MiB） |
| 注疏索引 JSON | `build/jingqun/study-index.json` | 363,662 bytes |
| 官網下載包 | `www/accelon26.zip` | 8,953,024 bytes |
| 正式版 exe | `accelon3\accelon26.exe`（發佈時） | 18,264,576 bytes |
| 本機桌面版 | `D:\accelon3\accelon26.exe` | 18,276,352 bytes（含後續本機功能） |

正式版的 `versions.json`：

```json
{
  "buildTime": "2026-10-29T02:02:57Z",
  "size": 18264576,
  "sha256": "37d79399ea484dcb1a8c48aa083c5916a7ec6608588ea5097153b7a134e6a2c9",
  "zipSize": 8953024
}
```

注意：`D:\accelon3\accelon26.exe` 是本機後來重建的版本（18,276,352 bytes），
比官網正式版多了後續的注疏索引／頁碼選單等修正；官網 ZIP 仍是 10-29 正式版。
若要讓官網也包含本機後續修正，必須再走一次 `release.ts` + `deploy.ts --site`。

---

## 3. `taisho-study.adb`

### 3.1 基本定位

```text
dbname  = study
dbcname = 大正藏研究
母庫    = taisho.adb
```

- 三部經：
  - 金剛般若波羅蜜經（T235）
  - 妙法蓮華經（T262）
  - 大毘盧遮那成佛神變加持經（T848）
- 只存正文指標與注疏群，不複製整部大正藏。
- `<融 i="taisho?page" j="start-end">`：建置時從母庫抽正文。
- `<嵌 i="taisho?page" j="start-end" t="…" n="…"/>`：建置時解析成注疏群晶片。
- `study` 型 adb 不保證與 Accelon3 相容；可以加 study 專用 block。

### 3.2 目錄：樹只到 `<書>`

最後定案不是為每部經開一棵全域樹，而是：

```text
<樹 s="*" t="書">大正藏研究</樹>
<樹 s="$書" …>書名</樹>
```

每本書用自己的 `t=` 宣告下一層：

```text
<書 id="n1" t="分.">金剛般若波羅蜜經</書>
<書 id="n2" t="品.">妙法蓮華經</書>
<書 id="n3" t="品.">大毘盧遮那成佛神變加持經</書>
```

結果：

```text
大正藏研究
├ 金剛般若波羅蜜經        32 分
├ 妙法蓮華經              28 品
└ 大毘盧遮那成佛神變加持經 36 品
```

- 法華**沒有卷**。
- 金剛**沒有卷**，只有昭明太子 32 分。
- 大日**沒有卷**，只有 36 品。
- 全文（`*詞`）樹已移除：study 沒有 `u=""`，不需要全文分頁。
- 不再用 `<群>` 把「N 家注疏」塞進樹裡；注疏改用 `study` block 清單。

### 3.3 金剛 32 分的來源

金剛 32 分不是手寫猜的：

1. `build/jingqun/map-jingang.ts`
2. 讀 `build/tei-all.txt` 裡 T2732〈梁朝傅大士頌金剛經〉的 32 個 `<分>`。
3. 用每個標題後文的 8 字窗口，對到 T235 的頁碼與頁內 Han 字位。
4. 輸出 `build/jingqun/jingang-fen.tsv`，目前 **32／32** 全對到。

### 3.4 目錄節點名 patch

CBETA TEI 有些品名前面帶經名，例如：

```text
妙法蓮華經方便品第二
```

目錄顯示：

```text
方便品第二
```

每部經一份 patch：

```text
jingqun/toc-patch/jingang.tsv   32 分（identity）
jingqun/toc-patch/fahua.tsv     28 品（去掉「妙法蓮華經」前綴）
jingqun/toc-patch/dari.tsv      36 品（去掉「大毘盧遮那成佛神變加持經」前綴）
```

格式：

```text
原文節點名<TAB>目錄顯示名
```

由 `build/jingqun/make-toc-patches.ts` 從 TEI 產生；`study-source.ts` 只改目錄顯示名，不改經文。

---

## 4. 注疏群：`study` block

### 4.1 為什麼不用樹

樹只適合層級，不適合展示「注疏名稱＋鏈結」。
把「3 家注疏」放進樹裡，使用者還是要再點開才知道是哪三家。

改成 `study` adb 內的一個結構化 block：

```text
taisho-study.adb
└ container: study
   └ block: index   ← UTF-8 JSON
```

### 4.2 內容

目前：

```text
1070 個注疏群
3 部經
1584 個注疏目標
```

每一群：

```json
{
  "book": "金剛般若波羅蜜經",
  "chapter": "法會因由分第一",
  "page": "8p748c",
  "rel": 19,
  "end": 90,
  "quote": "如是我聞：一時，佛在舍衛國祇樹給孤獨園…",
  "n": 3,
  "targets": [
    {
      "db": "taisho",
      "page": "33p228b",
      "range": "318-360",
      "label": "註解"
    }
  ]
}
```

欄位：

| 欄位 | 意思 |
|---|---|
| `book` | 哪一部經 |
| `chapter` | 哪一品／分 |
| `page` | 經文頁碼 |
| `rel` / `end` | 該頁的 Han 字範圍 |
| `quote` | 經文引文 |
| `n` | 家數 |
| `targets[].label` | 注疏名稱 |
| `targets[].db` | 目標庫，通常 `taisho` |
| `targets[].page` | 目標頁碼 |
| `targets[].range` | 目標頁內範圍 |

大日三家名稱已從被截斷的 `大毘盧遮那成`、`大日經疏妙印` 修正為：

```text
大日經疏
妙印鈔
口傳
```

### 4.3 如何生成

```powershell
bun run build/jingqun/make-study-index.ts
bun run ts/tools/tei-pack.ts build/jingqun/taisho-study-notes.txt build/taisho-study.adb `
  study 大正藏研究 "" ""
```

`make-study-index.ts` 讀：

```text
jingqun/taisho-study.txt
build/jingqun/study-groups.tsv
```

解析 `<書>`／`<品>`／`<分>`／`<融>`／`<嵌>`，用 `<融>` 的頁與字位決定章節，輸出
`build/jingqun/study-index.json`。

`tei-pack.ts` 只在 `dbname === 'study'` 且 JSON 存在時，加入：

```text
study/index
```

### 4.4 UI

桌面版與 HTML 版都有「注疏」按鈕（只在 study 庫顯示）：

- 清單按經／品分組
- 每列顯示頁碼、引文、注疏名稱
- 點注疏名稱 → 右欄開目標頁
- 點「經文」→ 回到該頁
- 可搜尋經名、品名、引文、注疏名

重要修正：按鈕不是綁 active DB，而是只要工作階段裡有 study 庫就保留；
按下去會自動切回 study。

---

## 5. 大正頁碼選取選單

在 `taisho-study` 中雙擊或選取下列位置：

```text
18p14c
8p748c
T18n0890_p0014c
```

選取區功能表只留：

```text
打開經文
複製
```

- 一般經文選取仍保留書籤、搜尋、字典、引用等功能。
- 「打開經文」需要先開著 `taisho.adb`。

實作在 `ts/src/accelon26/bookmarks.ts`。

---

## 6. 桌面版功能

### 6.1 取得更多 ADB

位置：`📁` 下拉第一項。

流程：

1. 同時向主站／鏡像取得 `adb/manifest.json`
2. 選下載較快的鏡像
3. 列出公開資料庫
4. 由 Go 宿主 `StartNewAdbDownload` 下載到執行檔旁
5. 驗證大小、sha256、adb 檔頭
6. 完成後 `refreshHostDbs()` 重刷 `📁` 清單

- 只顯示在桌面宿主。
- 離線時變暗但**不隱藏**；連線後恢復。
- 已安裝項目顯示「已安裝」，交給既有更新流程。

### 6.2 加入 Obsidian

- 只出現在進階模式。
- 一般使用者看不到資料夾／ZIP 轉檔入口。

### 6.3 選取頁碼

見上一節。

---

## 7. 官網

### 7.1 網域

```text
主站：https://shutonggui.cn/accelon26/
鏡像：https://nissaya.cn/accelon26/
```

- 正確拼字是 `shutonggui.cn`（有 g）。
- `taisho-study.cn` 是筆誤，工作區沒有任何檔案使用它。

### 7.2 鏡像策略

- 官網**不顯示**鏡像切換列。
- 主站載入後測 225 KB `img/search.jpg`：
  - 主站 < 1 秒：不打擾。
  - 主站慢：測 `nissaya.cn`；鏡像 < 主站 72% 才切。
- 測到鏡像較快時，把網段存進 `localStorage`（30 天）：
  - IPv4：/24
  - IPv6：/64
- 同一網段下次直接跳鏡像，不再下載測試圖。
- 網段改變（往返兩地）才重新測速。
- `?speed=1` 強制重測；`?stay=1` 留在主站。

### 7.3 首頁版本與下載

- 下載按鈕直接顯示：
  - 日期（由 `versions.json` 動態取得，Asia/Shanghai）
  - ZIP 大小
- 已移除「最新版」獨立列。
- 「更新說明」連結保留在導覽列與頁尾。
- 更新說明改用北京時間，修正 `2026-10-28T23:11Z` 被顯示成 10-28 的問題。
- 下載包由 `.7z` 改成 `.zip`；`release.ts` 與 `deploy.ts` 已同步。

### 7.4 已部署的 10-29 正式版

```text
buildTime  2026-10-29T02:02:57Z
sha256     37d79399ea48…
exe        18,264,576 bytes
zip        8,953,024 bytes
```

主站與鏡像都驗證過 `versions.json` 與 exe 一致。

---

## 8. 建置順序

### 8.1 只改 study 結構／注疏

```powershell
bun run jingqun/study-source.ts
bun run build/jingqun/make-study-index.ts
bun run jingqun/study-build.ts
bun run ts/tools/tei-pack.ts build/jingqun/taisho-study-notes.txt build/taisho-study.adb `
  study 大正藏研究 "" ""
```

### 8.2 改官網

```powershell
cd ts
bun run tools/build-viewer.ts
bun run tools/deploy.ts --site-only
```

### 8.3 正式發佈

```powershell
cd ts
bun run tools/release.ts --items-file ../wails/release_notes.txt
bun run tools/deploy.ts --site
```

只有作者明確說「發佈」時才重建 exe；平常改 UI 用 `build-viewer.ts`。

---

## 9. 已知限制

1. **注疏晶片與索引的數量不完全一致**
   - 索引：1070 群。
   - 正文成功定位的 `<嵌>`：1040 筆。
   - 原因是章節標題切開頁面後，少數跨標題的 `q` 不再連續；索引仍保留該群，正文晶片可能少數缺失。

2. **`study` block 不是 Accelon3 標準格式**
   - 這是刻意設計；study 型 adb 可以有自己的 block。
   - 不要把 `taisho-study.adb` 當成 Accelon3 可完全讀取的庫。

3. **官網正式版落後本機**
   - 10-29 正式版之後，本機又加了：
     - 注疏索引按鈕修正
     - 頁碼選單
     - study/index 與章節修正
   - 官網 ZIP 尚未包含這些後續本機修正。

4. **頁碼選單依賴 `taisho.adb`**
   - 「打開經文」是開母庫；沒有開母庫時只會提示。

5. **鏡像記憶只在主站 origin**
   - `localStorage` 是 per-origin；不同網域不共享。
   - 目前沒有手動切換列。

---

## 10. 檔案地圖

| 檔案 | 用途 |
|---|---|
| `jingqun/taisho-study.txt` | 作者源檔：書、目錄、融、嵌 |
| `jingqun/study-source.ts` | 產生源檔與 study-groups.tsv |
| `jingqun/study-build.ts` | 展開 `<融>`、定位 `<嵌>` |
| `build/jingqun/make-study-index.ts` | 產生 `study/index` JSON |
| `build/jingqun/map-jingang.ts` | T2732 32 分 → T235 |
| `build/jingqun/make-toc-patches.ts` | 產生每經目錄名 patch |
| `jingqun/toc-patch/*.tsv` | 目錄節點顯示名 |
| `ts/tools/tei-pack.ts` | 打包 adb，加入 `study/index` |
| `ts/src/accelon26/study-index.ts` | 注疏清單 UI |
| `ts/src/accelon26/bookmarks.ts` | 頁碼選取選單 |
| `ts/src/accelon26/adb-store.ts` | 取得更多 ADB |
| `www/index.html` | 官網首頁、測速換站、下載按鈕 |
| `ts/tools/release.ts` | 正式發佈（ZIP） |
| `ts/tools/deploy.ts` | 主站＋鏡像部署 |

---

## 11. 下一階段：文獻整理方法（待補）

這一輪主要是「把資料讀得到、找得到、連得到」。下一階段使用者要談的是更細緻的
佛學文獻整理方法。目前已知的缺口：

- 版本與異本：同一部經的不同刻本／校本／CBETA 版本，如何標識與比對。
- 書誌層級：冊／卷／品／分／頁／行，以及與 CBETA ID、Taisho 頁碼的對應。
- 注疏關係：作者、成書年代、傳承、引用與被引用，不只是「三家注疏」。
- 引文與出處：引用範圍、節引／轉引／異文，如何標記信心程度。
- 研究註記：不是所有註記都等於注疏；需要區分「原文」「註」「研究按語」。
- 資料出處與授權：TEI 來源、CBETA 版本、搬遷與再發佈的邊界。

這些不要用常識補；下一輪應由使用者給方法與判準，再落實到標記、block 或 UI。

---

## 12. 快速驗收清單

```text
[ ] D:\accelon3\taisho-study.adb 可開
[ ] 左欄三部經：32 分／28 品／36 品
[ ] 法華品名不含「妙法蓮華經」
[ ] 大日只有品，沒有卷
[ ] 上方「注疏」按鈕在同時開 taisho 時仍可見
[ ] 「注疏」清單 1070 群，可篩選「口傳」
[ ] 雙擊 18p14c，選單只有「打開經文」「複製」
[ ] 官網首頁日期 2026-10-29
[ ] 官網下載為 ZIP
```
