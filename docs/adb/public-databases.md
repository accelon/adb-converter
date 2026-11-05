# 官網公開資料庫（`www/adb`）與桌面下載

> 這一頁處理「官網有哪些 adb、manifest 長什麼樣、桌面版怎麼抓」。
> 不是單一 adb 的正文結構；各個 adb 的內容見 [ADB 索引](./taisho-study.md)。

## 1. 官網位置

```text
https://shutonggui.cn/accelon26/adb/
https://nissaya.cn/accelon26/adb/
```

主要檔案：

```text
www/adb/index.html       公開資料庫頁
www/adb/index.txt        清單摘要
www/adb/manifest.json    schema 2 清單
www/adb/*.adb            實際資料庫
```

### 1.1 官方委託製作與置頂（2026-11-05）

`deploy/adb-status.json` 的每一筆可以加兩個公開頁專用的欄位：

```json
"fuyan.adb": { "status": "available", "official": true, "pin": 1 }
```

- `official: true`：題名旁加「官方委託製作」金色標記，整列淡金底。
- `pin`：置頂順序（1 最前）；沒有的照 `index.txt` 的順序。
- 這兩個欄位只給 `ts/tools/make-adb-index.ts` 用，**不進** `manifest.json`。

目前：`fuyan.adb`（1）、`ys.adb`（2）、`tx.adb`（3）。
2026-11-05 同一天，`yl38.adb`（福嚴講義（空之探究））下架：已從 `index.txt`／manifest 移除，
兩站檔案刪除（404），同一份講義以單本書版 `fuyan.adb` 為準。

## 2. `manifest.json`

Schema 2，大致：

```json
{
  "schema": 2,
  "generated": "2026-10-29T01:50:52Z",
  "dbs": [
    {
      "file": "13j.adb",
      "name": "十三經",
      "size": 2252537,
      "sha256": "…",
      "buildTime": "2006-01-18T17:34:52Z",
      "date": "2006-01-19",
      "notes": [],
      "history": [
        {
          "buildTime": "…",
          "sha256": "…",
          "size": 2252537,
          "notes": []
        }
      ]
    }
  ]
}
```

- `file`：相對於 `adb/` 的檔名。
- `name`：顯示名。
- `size`／`sha256`：下載驗證。
- `buildTime`：版本時間。
- `history`：由新到舊的建置紀錄。
- `notes`：改版說明。

## 3. 桌面版如何抓

`📁` → `⬇ 取得更多 ADB`：

1. 讀主站／鏡像的 `adb/manifest.json`
2. 比較下載速度
3. 列出未安裝的資料庫
4. `StartNewAdbDownload` 下載到執行檔旁
5. 驗證大小、sha256、adb 檔頭
6. `refreshHostDbs()` 重刷 `📁`

下載 URL：

```text
<站>/accelon26/adb/<file>
```

- 伺服器沒有 CORS，所以下載走 Go 宿主，不走 WebView fetch。
- 已安裝的庫顯示「已安裝」；更新交给既有的「資料庫版本」流程。
- 離線時「取得更多 ADB」變暗但不隱藏。

## 4. 各 adb 的文件

公開資料庫很多，不在這裡逐一重寫。與本輪直接相關的：

- [taisho.adb](./taisho.md)：母庫
- [taisho-study.adb](./taisho-study.md)：研究讀本
- [jingang.adb](./jingang.md)：舊金剛讀本

其他 adb（13j、yinshun、fgdict、swjzz…）請看 `docs/adb/` 下既有的專門文件，
或 `www/adb/index.html` 的說明。
