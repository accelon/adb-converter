# `jingang.adb`／`jingang-group.adb`：舊金剛經讀本

> 這兩個是 **legacy**。新的研究讀本是 [taisho-study.adb](./taisho-study.md)，
> 已包含金剛、法華、大日三部經。

## 1. 關係

```text
jingang.adb
  → 只有金剛經與金剛經注疏
  → 被 taisho-study.adb 取代

taisho-study.adb
  → 金剛＋法華＋大日
  → dbname = study
```

- `D:\accelon3\jingang.adb` 已移除，不再是最終交付物。
- `build/jingang.adb`、`build/jingang-group.adb` 仍可能作為舊測試資料保留。
- `TERMINAL_DBS` 仍包含 `jingang`，是為了讓舊 adb 的選取選單不顯示「引用複製」；
  新讀本用 `study`。

## 2. 舊檔案

| 路徑 | 大小 | 用途 |
|---|---:|---|
| `build/jingang.adb` | 約 64 KB | 舊金剛經小庫 |
| `build/jingang-group.adb` | 約 830 KB | `<嵌>` 群組測試庫 |
| `jingqun/jingang.txt` | — | 舊作者源檔 |

## 3. 測試

舊 `<嵌>` 群組測試仍用：

```powershell
cd ts
bun run test:embed
```

它預設開 `../build/jingang-group.adb`，和 study 的 `<嵌>` 是同一套渲染機制。

## 4. 不要做

- 不要把 `jingang.adb` 再放回 `D:\accelon3` 當正式庫。
- 不要為舊 `jingang` 再加新功能；新功能進 `taisho-study.adb`。
- 不要用舊 `jingang` 的頁碼假設 study 的頁碼；study 依賴母庫 `taisho.adb`。
