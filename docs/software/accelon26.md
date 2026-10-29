# Accelon26 閱讀器

> 同一份單檔 HTML 同時服務瀏覽器與桌面 Wails 宿主。
> 桌面宿主另外提供檔案系統、下載與更新；閱讀器 UI 本身兩邊共用。

## 1. 定位

```text
Accelon3 的跨平台平替
直接讀 .adb
單檔 HTML（build/accelon26.html）
桌面版把同一份 HTML 包進 Wails
```

## 2. 入口

```text
建置：bun run tools/build-viewer.ts
輸出：build/accelon26.html
桌面：bun run tools/build-desktop.ts → wails/assets/index.html
```

開啟：

```text
file:///…/accelon26.html  → 選 .adb
或桌面 accelon26.exe
```

## 3. 目錄

左欄每一棵 `<樹>` 一個 pane：

- `s="*"`：目錄樹
- `s="$書"`：書名
- `s="*詞"`：全文
- `s="*u=…"`：頻次

多個 `s="*"` 時，目錄上方出現樹選擇器；不是並排分頁。

### 3.1 study 的目錄

`taisho-study.adb` 只有一棵 `t="書"` 樹；每本書用 `t=` 宣告自己的下一層：

```text
<書 id="n2" t="品.">妙法蓮華經</書>
```

所以：

```text
大正藏研究 → 書 → 品／分
```

不再為每部經開一棵全域樹。

## 4. 注疏

`<嵌>` 晶片：

```text
<嵌 i="taisho?18p24b" j="210-237" t="…" n="1 家注疏"/>
```

- 點晶片：右欄展開注疏群
- `大正↗`：右欄開母庫目標頁並塗紅
- `study`／`jingang` 是終點庫，不顯示「引用複製」

study 另外有 `study/index` block 的注疏清單：

- 標題列「注疏」按鈕
- 只在有 study 庫時顯示
- 同時開 `taisho.adb` 也不消失
- 按下去切回 study 並開清單

詳見 [taisho-study.md](../adb/taisho-study.md)。

## 5. 選取選單

一般選取：

```text
加入書籤／搜尋／查字典／引用複製／複製
```

study 中選到可辨識的大正頁碼：

```text
18p14c
8p748c
T18n0890_p0014c
```

只留：

```text
打開經文
複製
```

「打開經文」需要母庫 [taisho.adb](../adb/taisho.md) 已開。

## 6. 桌面專屬

- `📁` 下拉：`⬇ 取得更多 ADB`
- 離線時該項變暗但不隱藏
- `＋ 加入 Obsidian` 只在進階模式
- Wails host 提供 `SaveAdb`、`StartNewAdbDownload`、mmap 讀取

詳見 [desktop.md](./desktop.md)。

## 7. 建置與測試

```powershell
cd ts
bun run tools/build-viewer.ts
bun run tools/build-desktop.ts
bun test test/render.test.ts
bun run test:embed
```

桌面 exe：

```powershell
cd wails
go build -ldflags "-H windowsgui" -o ..\accelon3\accelon26.exe .
```

## 8. 重要檔案

| 檔案 | 用途 |
|---|---|
| `ts/src/accelon26/accelon26.template.html` | 單檔 HTML 模板與 CSS |
| `ts/src/accelon26/ui.ts` | 主 UI、初始化 |
| `ts/src/accelon26/dbs.ts` | 開庫、分頁、下拉 |
| `ts/src/accelon26/scopes.ts` | 目錄樹／pane |
| `ts/src/accelon26/render_accelon3.ts` | `<融>`／`<嵌>` 渲染 |
| `ts/src/accelon26/bookmarks.ts` | 選取選單、頁碼辨識 |
| `ts/src/accelon26/study-index.ts` | 注疏清單 |
| `ts/src/accelon26/adb-store.ts` | 取得更多 ADB |
| `ts/src/accelon26/mirror.ts` | 鏡像選擇 |
| `ts/tools/build-viewer.ts` | 建置單檔 HTML |
| `ts/tools/build-desktop.ts` | 建置桌面 assets |
