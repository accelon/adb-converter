# 編輯態（file:// 網頁版）

2026-10-24 起，build/accelon26.html 可以直接在瀏覽器裡修錯字：
打開一頁 → 按鉛筆 → 改字 → 按「完成」→ db 分頁出現「n 頁修訂」→ 按存檔圖示
產生新的 .adb（下載）。

## 使用方式

1. 雙擊 build/accelon26.html，選一個 .adb（目前只開放 50 MB 以下）。
2. 點目錄或摘要打開一頁，按本文右上角的鉛筆（✎）。
3. 直接改文字。標籤會塗紅；標籤屬性可以改，但刪掉 < 或 > 會刪掉整個標籤（成對的開／閉標籤一起刪）。
4. 加標記：把一個 tag 複製到剪貼簿（例：<b>），選取一段文字，貼上 → 自動變成
   <b>選取文字</b>。
5. 離開這一頁（換頁、換分頁、換庫）會自動暫存；回來時自動回到編輯態。
6. 本文分頁變紅＝這份文件有未產生的修訂；db 分頁顯示「n 頁修訂」。
7. 按 db 分頁的存檔圖示 → 確認 → 產生並下載 <dbname>-vN.adb。
8. 進階模式 → 右欄「修訂」分頁，看每次 rebuild 的版本、頁面、行號與改了哪個字；
   最新一版有「退回上一版」，會下載回滾後的 adb（目前檔案不變）。

## 重建管線

原始碼：src/accelon26/rebuild-browser.ts

1. 用 AdbReader 的 sourceText + lines.physical 取回全部 lines。
2. 把每一頁的 old/new lines 由下往上套回 base（edit-session.ts）。
3. buildIndex 重建 tokens/tags/tables/attributes；caches 重新產生（允許與原檔有小差異）。
4. 內文用 bzip2 wasm（libbz2 1.0.8）壓縮；輸出與系統 libbz2 相同，所以 13j 無編輯重建是 byte-identical。
5. 新增一個 named container「revisions」，每次 rebuild 追加一個 JSON block；舊的 accelon3.exe 不會讀它。
6. 重算 header 的 linecount / maxblockoffset / tagcount / crc32。

## revisions 格式

revisions 的每個 block 是 UTF-8 JSON：

{
  "format": "accelon26-revision/1",
  "id": "v1",
  "parent": null,
  "createdAt": "2026-10-24T15:00:00.000Z",
  "base": { "name": "13j", "size": 2252537, "lineCount": 42173, "headerCrc": 123 },
  "pages": [{
    "first": 8, "last": 33, "doc": "13j",
    "oldLineCount": 26, "newLineCount": 26,
    "changes": [{ "line": 8, "kind": "replace", "at": 3,
                  "oldText": "甲", "newText": "乙",
                  "oldLine": "...", "newLine": "..." }],
    "oldLines": ["..."]
  }]
}

oldLines 是回滾用：修訂頁最新一版的「退回上一版」會把頁面還原成 oldLines，
重建一份不含該筆修訂的 adb 並下載（revisions 容器同時移除那一筆）。

## 已知限制

* 只支援 50 MB 以下（記憶體與瀏覽器下載考量）；更大的庫之後改走 Go。
* caches 是重新產生的，可能和原檔的「序」「節」「圖」有已知的小差異（作者已同意）。
* 不檢查標籤語法；壞標記照原樣寫入。
* 檔案是下載，不是原地覆寫；要繼續編輯新檔，請重新選取它。
* 沒有 Bun 也能用：CodeMirror 與 bzip2 都是 vendored 進單檔 HTML 的。

## 驗證

cd ts
bun run test/edit-session.test.ts
bun run test/rebuild-browser.test.ts        # 需要 repo 根目錄的 13j.adb
bun run tools/build-viewer.ts

瀏覽器端測試可用 tools/shot.ts 的 CDP 模式（見 .local/edit-ui-test.ts 的暫存腳本）。
