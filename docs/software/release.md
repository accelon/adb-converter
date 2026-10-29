# 發佈與部署

> 平常改 UI 只建單檔 HTML；只有作者說「發佈新版」才重建 exe、ZIP、versions.json。

## 1. 平常（不發佈）

```powershell
cd ts
bun run tools/build-viewer.ts
bun test test/render.test.ts
bun run test:embed
```

輸出 `build/accelon26.html`，可雙擊開、選 adb 看效果。
不要重建 exe；不要讓使用者跳一次沒有意義的更新。

## 2. 正式發佈

```powershell
cd ts
bun run tools/release.ts --items-file ../wails/release_notes.draft.txt
bun run tools/deploy.ts --site
```

`release.ts`：

1. 追加改版說明到 `wails/release_notes.json`
2. 建 HTML → `wails/assets/index.html`
3. 用 `-ldflags` 把 buildTime 烙進 exe
4. 產生 `accelon3/versions.json`
5. 打包 `www/accelon26.zip`
6. 驗證 `-version`

`deploy.ts --site`：

1. 上傳 exe
2. 上傳 versions.json（鏡像版本改寫下載 URL）
3. 上傳 `www/` 與 ZIP
4. 抓回線上 versions/exe 比對 sha256

## 3. 部署指令

```powershell
cd ts
bun run tools/deploy.ts --site-only    # 只換 www/
bun run tools/deploy.ts --site         # exe + versions + www
bun run tools/deploy.ts --site-only --mirror-only
bun run tools/deploy.ts --site-only --primary-only
```

帳密：`.local/server.env`，不進版控。

## 4. 版本檔案

```text
accelon3/versions.json
```

目前 10-29 正式版：

```json
{
  "buildTime": "2026-10-29T02:02:57Z",
  "size": 18264576,
  "sha256": "37d79399ea48…",
  "zipSize": 8953024
}
```

`versions.json` 是版本真相；`Last-Modified` 只是 fallback。

## 5. 下載包

```text
www/accelon26.zip
```

- 由 `release.ts` 用 7-Zip 的 `-tzip` 產生。
- 內容：`accelon26.exe`＋兩份 README。
- `deploy.ts` 的 `siteNames()` 只抓 `.html` 與 `.zip`。
- 官網首頁不再連 `.7z`。

## 6. 同日多個版本

- 一天多個修正可以用 RC。
- 更新說明同日只留一個條目：把上一筆的 `buildTime` 改成新的，`items` 就地增補。
- 不要把 RC1、RC2… 留成一串。

## 7. 目前狀態

- 官網：10-29 正式版（exe 18,264,576 bytes）。
- 本機：18,276,352 bytes，含後續注疏索引／頁碼選單修正。
- 若要把本機修正上線，必須重新 `release.ts` + `deploy.ts --site`。

## 8. 注意

- 中文參數在 PowerShell 容易亂碼；改版說明用 `--items-file`。
- 不要只上傳 exe 而不上傳 versions.json。
- 不要用網頁後台直接覆蓋；`deploy.ts` 用 `.tmp` → `mv` 原子替換。
- 鏡像部署偶爾會因 `.pw-mirror.tmp` 缺失失敗；重跑 `--mirror-only` 即可。
