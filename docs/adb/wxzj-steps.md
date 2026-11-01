# wxzj.adb（卍新纂續藏經）產生步驟

> 2026-10-31 依 **CBETA XML-P5 2026.R2** 重建（缺字／梵字處理更新）。
> 來源是 `D:\2026\xml-p5\X` 的 X 藏 TEI；產物部署到 `D:\accelon3\wxzj.adb`。
> 缺字與字型的完整規則見 [missing-char.md](./missing-char.md)。

## 成品（2026-10-31，CBETA 2026.R2）

| 項目 | 數值 |
|---|---|
| 檔案 | `build/wxzj-2026R2-new.adb`（234.4 MiB／245,818,762 bytes） |
| SHA-256 | `EB7374EE5A0387E912B0E14338097234BEB6B3A2406708FC0478252AB607569F` |
| 文字 | 4,262,468 行 |
| 冊／書／卷 | 86／1,236／8,937 |
| 序／品／其他 | 2,207／416／75,646 |
| 頁欄（`<頁 id>`） | 172,794（全部唯一） |
| tokens | 17,665 種／83,567,635 筆 |
| 標記 | 30 種 |
| maxVA | 84,453,795 |

> **2026-11-01 重打包**：代理對改成一個 supplementary 字元＝1 個 VA，文字裡 1 個
> 罕用字不再各算 2 個 token（maxVA 84,453,796 → 84,453,795）。頁 id、行界、
> 文字內容不變；見 [han-position.md](./han-position.md)。
| resources | `wxzj_logo.png`（273,121 bytes） |
| 檔頭 | `dbname=wxzj`、`dbcname=卍新纂續藏經`、`dbtype=4`、`srcBlockSize=16384`、`compression=1`、`andtagid=21`（頁） |

> **純經文底座**：只跟 CBETA 換版；本專案的功能標記不放這裡。

### 2026-10-31 缺字／梵字處理

| 項目 | 舊文字（2026-10-29） | 新文字（2026-10-31） |
|---|---|---|
| `&CB…;` | 81,857 次／4,990 碼 | **18,688 次／1,772 碼** |
| `&SD-…;` | 4,062 次／513 碼 | **0** |
| `&RJ-…;` | 702 次／108 碼 | **0** |
| PUA 字元 | 30,235 次／2,746 碼（含 CB PUA） | **4,764 次／621 碼**（全部 SD／RJ，字型全部覆蓋） |

- 剩下的 1,772 個 CB 碼在 CBETA `cbeta_gaiji.csv` 裡都沒有 `unicode`／`norm_unicode`，
  只有 composition；保留 `&CB…;`，清單在 `docs/adb/wxzj-missing-gaiji.tsv`。
- **VA 不變式**：`&CB…;`／`&SD-…;`／`&RJ-…;` 與替換後的單一 Unicode／PUA 字
  都是一個 token＝一個 VA；單獨替換不會移動引文座標（見
  [missing-char.md](./missing-char.md) §2.4、`ts/test/gaiji-va.test.ts`）。
- 規則、font 覆蓋率、為什麼不用 `norm_big5_char`：見 [missing-char.md](./missing-char.md)。

## 指令

```bat
:: 1) X TEI → 文字（約 15 秒；X06、X52 是空目錄，會自動跳過）
build\tei2adb.exe -tei D:\2026\xml-p5\X -canon X -vol 1-88 -release 2026.R2 -out build\wxzj-tei-2026R2-new.txt

:: 2) 文字 → adb（約 1 分鐘；最後一個空字串＝不加 posmap align）
bun run ts/tools/tei-pack.ts build\wxzj-tei-2026R2-new.txt build\wxzj-2026R2-new.adb wxzj 卍新纂續藏經 logo\wxzj_logo.png ""
```

`-canon X` 會：

- 選用 `xHeader`（`dbname=wxzj`、舊 wxzj 的 7 棵樹與 `<引>`）。
- 讀 `X01`…`X88` 目錄；`X06`、`X52` 沒有檔案，跳過。
- 冊名沿用舊 wxzj 的 86 個名稱（`x01.經部、律部` … `x88.史傳部十四`）。
- X 藏的 `cb:div type="commentary"｜"orig"｜"w"｜"note"` 歸到 `其他`；
  `<note>` 元素、`<app><rdg>` 等校勘仍照舊丟棄。
- X 藏同時有 `ed="X"` 與 `ed="R"` 的 `pb`／`lb`；只採用 X 的頁碼，
  且同一頁 id 只保留一次（避免 R 對照頁把 44p521b 之類重複數十次）。
- `<g ref="#CB…">`／`#SD-…`／`#RJ-…` 依 `missing-char.md` §2 換成 Unicode／PUA；
  沒有 Unicode 的 CB 保留 `&CB…;` 並寫進 `wxzj-missing-gaiji.tsv`。

## 2026-10-28 重建新知（X 藏特有）

1. **X 藏頁碼有兩套**：`<pb ed="X">` 是卍續藏頁碼，`<pb ed="R">` 是嘉興藏對照頁碼；
   `<lb>` 也常同時有 `ed="X"`／`ed="R"`。只取 `ed="X"`，R 只作對照，不進 adb。
2. **R 頁碼會讓頁 id 重複**：若連 R 的 `pb` 都收，`44p521b` 這類頁 id 會重複數十次；
   只收 X 後還要再按頁 id 去重（全域一次）。
3. **沒有 `<pb>` 的檔案不能拿 R 的 `<lb>` 補頁**：`ed="R"` 的 lb 會在同一行反覆切換頁欄，
   造成 `44p521b`／`44p634b` 交替重複；X 的 lb fallback 也只認 `ed="X"`。
4. **X 的 div 類型比 T 多**：`commentary`、`orig`、`w`、`note` 都歸到 `其他`
   （舊 wxzj 的 `其他` 本來就是最大宗）；`taisho-notes`、`<note>`、`<rdg>` 仍丟棄。
5. **X06、X52 是空目錄**：來源有 88 個 X 冊目錄，實際有檔的是 86 冊，和舊 wxzj 一致。
6. **冊名不是放諸四海皆準**：X 冊名要用舊 wxzj 的 `x01.經部、律部` … `x88.史傳部十四`，
   不能拿 T 藏的部名表。
7. **驗收要看頁 id 唯一性**：`attributes/頁.id` 的 unique 數要等於 tag 數；
   這次 172,794 頁、unique 172,794。

## 驗證

```bat
go run ./cmd/abx inspect build\wxzj-2026R2-new.adb
bun run ts/tools/probe-adb.ts --adb build\wxzj-2026R2-new.adb --query 般若
```

實測：

```text
db=wxzj，目錄 86 列
第一冊 x01.經部、律部
第 1 頁 id=1p1a，正文「圓覺經佚文…」
般若：28,202 筆命中（文字未變，仍是 23 群）
```

缺字／梵字統計：

```powershell
python -c "import re; s=open('build/wxzj-tei-2026R2-new.txt',encoding='utf-8').read(); [print(p, len(re.findall(p,s))) for p in [r'&CB[0-9A-F]+;', r'&SD-[0-9A-F]+;', r'&RJ-[0-9A-F]+;']]"
```

2026-10-31 實測：`&CB` 18,688／1,772、`&SD` 0、`&RJ` 0、PUA 4,764／621。

## 引用查核（2026-10-31）

發佈前查了本機的 `ys.adb`／`yinshun.adb`：

- `ys.adb`：**0 個** `wxzj?` 連結；只有檔頭 `<參考資料 n="taisho,wxzj"/>` 宣告，
  沒有頁碼座標可失效。
- `yinshun.adb`（舊印順庫，不在公開清單）：34 個不同 `wxzj?` 連結（52 次）。
  新舊 wxzj 的頁 id 集合完全相同（172,794，0 增、0 減），所以沒有因這次重建失效。
- `yinshun.adb` 有 3 個連結在 **2026-10-29 版與 2008 舊檔就已經找不到**：
  `24p194a-b`、`54p5b`、`58p84a`（X24／X54／X58 的頁碼本身有跳號；
  `24p195a`、`54p50a`、`58p86a` 存在）。這是舊引用本身的問題，不是這次重建造成。
- **2026-10-31 作者裁定：不修，記下即可。** `yinshun.adb` 已下架、不在公開清單，
  這 3 個連結是舊引用本身的跳號；保留本節記錄，不再為它重建或補頁。

## 部署與回退

```bat
:: 部署（若 accelon26 正開著舊檔，先關閉或重新啟動；Windows 會鎖住 mmap）
copy /Y build\wxzj-2026R2-new.adb D:\accelon3\wxzj.adb
```

`wxzj.adb` 已於 **2026-10-31 開放**：`deploy/adb-status.json` 改為 `available`，
兩站都有整檔下載（`large:true`、不列入「全部更新」）。官網頁面是 `www/adb/wxzj.html`
（來源 `docs/adb/wxzj-about.md`），manifest 版本記錄已更新。

舊檔保留在：

- `build\wxzj-old-2026-10-28.adb`（2008 舊檔）
- `build\wxzj-2026R2.adb`（2026-10-29 版；缺字仍是實體）

## 與 2008 舊檔的差異

- 文字、頁欄、書名來自 CBETA XML-P5 2026.R2，不再沿用 2008 XML。
- 舊檔 281,237,612 bytes／4.4M 行／1,253 書；新檔 234.4 MiB／4,262,468 行／1,236 書。
- 頁欄 172,662 → 172,794（只取 X 頁碼，R 對照頁不進 adb；全部唯一）。
- 校勘只取 CBETA 採用讀法。
- 缺字：2026-10-29 版有 81,857 次 `&CB…;`、4,062 次 `&SD-…;`、702 次 `&RJ-…;`；
  2026-10-31 版只剩 18,688 次 `&CB…;`，SD／RJ 已全部換成 PUA（字型顯示）。
