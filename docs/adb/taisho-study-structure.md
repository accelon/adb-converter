# 大正藏研究：每部經的目錄結構

> canonical 入口是 [taisho-study.md](./taisho-study.md)；本頁專講逐經目錄、
> TOC patch 與 `study/index` block 的細節。

作者 2026-10-29：study 型 adb 不必與 Accelon3 兼容，可以依需要加標籤。
目錄樹**只定義到 `<書>`**；每本書用自身的 `t=` 宣告自己的下一層，法華只取「品」。

## 樹宣告

```text
<樹 s="*" t="書">大正藏研究</樹>       ← 只有這一棵目錄樹
<樹 s="$書" …>書名</樹>                ← 書名清單
```

每本書：

```text
<書 id="n1" t="分.">金剛般若波羅蜜經</書>
<書 id="n2" t="品.">妙法蓮華經</書>
<書 id="n3" t="品.">大毘盧遮那成佛神變加持經</書>
```

所以左欄會是：

```text
大正藏研究
├ 金剛般若波羅蜜經  32
│  └ 法會因由分第一 … 應化非真分第三十二
├ 妙法蓮華經        28
│  └ 序品第一 … 普賢菩薩勸發品第二十八
└ 大毘盧遮那成佛神變加持經 36
   └ 入真言門住心品第一 … 真言事業品第五
```

## 數量

| 經 | 大正號 | 書下層 | 數量 |
|---|---|---|---:|
| 金剛般若波羅蜜經 | T235 | 分（昭明太子 32 分） | **32** |
| 妙法蓮華經 | T262 | 品 | **28** |
| 大毘盧遮那成佛神變加持經 | T848 | 品 | **36** |

- 法華**不取卷**：只保留 28 品。
- 金剛不取卷：只保留 32 分。
- 全文（`*詞`）樹已移除；study 沒有 `u=""`，不需要全文分頁。

## 目錄節點名 patch

CBETA TEI 有些品名前面帶經名，例如：

```text
妙法蓮華經方便品第二
```

目錄只顯示：

```text
方便品第二
```

每個經一份 patch：

```text
jingqun/toc-patch/jingang.tsv   32 分（原文已無經名，identity）
jingqun/toc-patch/fahua.tsv     28 品（去掉「妙法蓮華經」前綴）
jingqun/toc-patch/dari.tsv      36 品（去掉「大毘盧遮那成佛神變加持經」前綴）
```

格式：

```text
原文節點名<TAB>目錄顯示名
```

由 `build/jingqun/make-toc-patches.ts` 從 TEI 抽出；`study-source.ts` 讀取後只改
目錄節點名，不改經文。若 CBETA 換版、品名有增刪，重跑這支即可。

## 注疏索引 block

注疏群**不放在樹裡**。`study` adb 多一個 `study` 容器，裡面一個 `index` block：

```text
study/index  ← build/jingqun/study-index.json（UTF-8 JSON）
```

每筆：

```json
{
  "book": "大毘盧遮那成佛神變加持經",
  "chapter": "入真言門住心品第一",
  "page": "18p24b",
  "quote": "是密印相，當用定慧手作空心合掌…",
  "targets": [
    { "label": "大日經疏", "db": "taisho", "page": "39p…", "range": "…" },
    { "label": "妙印鈔", "db": "taisho", "page": "58p…", "range": "…" },
    { "label": "口傳", "db": "taisho", "page": "58p684c", "range": "149-176" }
  ]
}
```

桌面版標題列有「注疏」按鈕（只在 `dbname=study` 顯示），打開是清單：

```text
經文頁碼＋引文
  大日經疏  ↗
  妙印鈔    ↗
  口傳      ↗
```

- 點注疏名稱 → 右欄大正目標頁
- 點「經文」→ 回到這一頁
- 可直接篩選經文、品名、注疏名

產生：

```powershell
bun run build/jingqun/make-study-index.ts
bun run ts/tools/tei-pack.ts build/jingqun/taisho-study-notes.txt build/taisho-study.adb `
  study 大正藏研究 "" ""
```

## 金剛 32 分

`build/jingqun/map-jingang.ts` 從 TEI T2732〈梁朝傅大士頌金剛經〉的 `<分>` 取 32 個標題，
對到 T235 的頁／字位，輸出 `build/jingqun/jingang-fen.tsv`；目前 32／32。

## 建置

```powershell
bun run jingqun/study-source.ts
bun run jingqun/study-build.ts
bun run ts/tools/tei-pack.ts build/jingqun/taisho-study-notes.txt build/taisho-study.adb `
  study 大正藏研究 "" ""
```

## 變更原則

- 每部經的層級由該書的 `t="…"` 決定；不要再為每部經開一棵全域 `<樹>`。
- 新增經文時，先從 TEI 確認它的卷／品／章標籤，再決定 `t=`；不要凭常識補。
- 若日後要加閱讀器專用的導覽資料，才考慮新增 block；目前標籤已足夠。


