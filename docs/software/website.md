# 官網（`www/`）

> 官網是純靜態 HTML＋CSS＋少量 JS；下載包、公開資料庫與鏡像都在這裡。
> 閱讀器本體在 [accelon26.md](./accelon26.md)，桌面功能在 [desktop.md](./desktop.md)。

## 1. 網域

```text
主站：https://shutonggui.cn/accelon26/
鏡像：https://nissaya.cn/accelon26/
```

- 正確拼字：`shutonggui.cn`（有 g）。
- `taisho-study.cn` 是筆誤；工作區沒有使用。
- 兩個站由 `ts/tools/deploy.ts` 同步。

## 2. 首頁

`www/index.html`：

- 不顯示鏡像切換列。
- 下載按鈕直接顯示日期與 ZIP 大小。
- 「更新說明」連結在導覽列與頁尾。
- 日期由 `versions.json` 動態取得，固定用 `Asia/Shanghai`。
- 下載包是 `.zip`，不是 `.7z`。

### 2.1 測速換站

主站載入後：

1. 抓 225 KB `img/search.jpg` 測速。
2. 主站 < 1 秒：不打擾。
3. 主站慢：測 `nissaya.cn` 同一張圖。
4. 鏡像 < 主站 72% 才切。
5. 切過去時把網段存進 `localStorage`（30 天）。

網段：

```text
IPv4 → /24
IPv6 → /64
```

下次同網段直接跳鏡像，不再下載測試圖；網段變了才重測。

除錯參數：

```text
?speed=1   強制重測
?stay=1    留在主站
```

## 3. 下載

```text
www/accelon26.zip
```

內容：

```text
accelon26.exe
README.txt
README-tc.txt
```

- `release.ts` 產生 ZIP。
- `deploy.ts --site` 上傳 exe／versions／ZIP／www。
- 下載按鈕的日期來自 `versions.json`，不寫死。

## 4. 更新說明

```text
www/changelog.html
```

由 `ts/tools/make-changelog.ts` 從 `wails/release_notes.json` 產生。

- 日期用北京時間。
- 修正過 UTC 造成 `2026-10-28T23:11Z` 顯示成 10-28 的問題。
- 同日多個 RC 合併成一個條目，避免一天多筆。

## 5. 公開資料庫

```text
www/adb/index.html
www/adb/manifest.json
www/adb/*.adb
```

詳見 [public-databases.md](../adb/public-databases.md)。

## 6. 部署

```powershell
cd ts
bun run tools/deploy.ts --site-only   # 只換 www/
bun run tools/deploy.ts --site        # exe＋versions＋www
```

驗證：

- `--site-only`：HEAD 檢查 www 檔案。
- `--site`：抓回 `versions.json` 與 exe，比對 sha256。

部署帳密在 `.local/server.env`，不進版控。

## 7. 目前版本

```text
buildTime  2026-10-29T02:02:57Z
exe        18,264,576 bytes
sha256     37d79399ea48…
zip        8,953,024 bytes
```

官網版本落後本機後續修正；發布見 [release.md](./release.md)。
