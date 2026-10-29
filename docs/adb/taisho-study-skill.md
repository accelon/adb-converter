# 大正藏研究（`taisho-study.adb`）

> 這份是舊的 skill 入口；canonical 文件是
> [taisho-study.md](./taisho-study.md)。本頁保留早期建置與注疏說明。

> 由 `jingang.adb` 更名／擴充而來：金剛經＋妙法蓮華經＋大日經，
> 依賴母庫 `taisho.adb`；小庫只存讀本正文與 `<嵌>` 指針。

## 三個讀本

目錄層級每經不同，依 TEI 抽取；規則與數量見
[taisho-study-structure.md](./taisho-study-structure.md)。

| 書 | 來源 | 自動 `<嵌>` |
|---|---|---:|
| 金剛般若波羅蜜經 | T235 | 92 |
| 妙法蓮華經 | T262 | 297 |
| 大毘盧遮那成佛神變加持經 | T848 | 681 |

大日經另加一筆手動 **T2214 口傳** 對位，形成：

```text
大日經 T0848
  → 大日經疏 T1796
  → 大日經疏妙印鈔 T2213
  → 大日經疏妙印鈔口傳 T2214（depth 3）
```

## 源檔

`jingqun/taisho-study.txt`，只有：

```text
<融 i="taisho?8p748c" j="0-181"></融>
<嵌 i="taisho?8p748c" j="19-90"/>
```

## 建置

```powershell
bun run jingqun/study-source.ts
bun run jingqun/study-build.ts
bun run ts/tools/tei-pack.ts build/jingqun/taisho-study-notes.txt build/taisho-study.adb `
  study 大正藏研究 "" ""
```

產出：

```text
taisho-study.adb  0.8 MiB
3 本書、1062 個已定位 <嵌>
```

## 閱讀

```text
D:\accelon3\taisho-study.adb
D:\accelon3\taisho.adb
```

先開 `taisho.adb`，再開 `taisho-study.adb`；點 `<嵌>` 的 `大正↗` 會在右欄開目標並塗紅。

`jingang`／`study` 是終點庫：選取選單不顯示「引用複製」。
