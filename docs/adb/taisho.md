# `taisho.adb`：大正藏母庫

> 這是 **母庫**，不是研究讀本。研究讀本 `taisho-study.adb` 依賴它。
> 除非作者明確要求，不要重建或覆蓋。

## 1. 角色

```text
taisho.adb  ──<融 i="taisho?18p55a" j="…">──┐
             ──<嵌 i="taisho?18p55a" …>────┤
                                            ↓
                                   taisho-study.adb
```

- 母庫提供正文頁、頁碼與目標頁。
- 研究讀本只存：
  - `<融 i="taisho?page" j="start-end">`
  - `<嵌 i="taisho?page" j="start-end" t="…" n="…"/>`
- 所以 `taisho.adb` 必須與 `taisho-study.adb` 一起開；只開讀本時，`大正↗` 會提示先開母庫。

## 2. 頁碼

大正頁碼格式：

```text
<冊>p<頁><欄>
8p748c
18p14c
85p1b
```

- `8p748c`＝第 8 冊、第 748 頁、c 欄。
- 研究讀本、注疏索引、頁碼選單都以這個字串當 key。
- 母庫的 `<頁 id="8p748c"/>` 是 `<融>` 與 `<嵌>` 的定位依據。

## 3. 目錄宣告

母庫檔頭目前有類似：

```text
<樹 s="*" t="冊,書,品." …>經目</樹>
<樹 s="$書" …>書名</樹>
<樹 s="*" t="冊,卷." …>分卷</樹>
<樹 s="*卷" …>分卷頻次</樹>
```

研究讀本**不直接沿用**這些目錄；它只借用母庫的正文與頁碼。
不要為了 study 的目錄去改母庫的 `<樹>`。

## 4. 目前檔案

| 路徑 | 大小 | 說明 |
|---|---:|---|
| `D:\accelon3\taisho.adb` | 326,434,708 | 作者原本的母庫，未動 |
| `D:\accelon3\taisho-85.adb` | 326,441,148 | 重建後母庫（測試用） |

`taisho-85.adb` 不是 study 讀本；不要把它當成 `taisho-study.adb`。

## 5. 相關程式

- `ts/src/accelon26/xref.ts`：`pageHanText`、`openTaishoAt`、目標頁與引文定位
- `ts/src/accelon26/embed.ts`：`<嵌>` 的開啟、塗紅、收合
- `ts/src/accelon26/render_accelon3.ts`：`<融>`／`<嵌>` 的渲染
- `jingqun/study-build.ts`：建置時從母庫抽頁

## 6. 注意

- 母庫的 `<頁>` 是正文頁，不是研究讀本的目錄節點。
- 同一個頁碼可能因 CBETA 版本不同而有異；目前以 `taisho.adb` 的頁碼為準。
- 若母庫換版，`<融>`／`<嵌>` 的頁碼與頁內字位都要重新驗證。
