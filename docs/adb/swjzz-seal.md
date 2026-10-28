# 說文小篆 → SVG → adb resources（不必裝字型）

> 目的：`BeiShiDaShuoWenXiaoZhuan-1.ttf` 是說文小篆字型，但讀者不會為了一個庫去裝字型。
> 把每個字頭的小篆輪廓轉成 SVG，放進 `.adb` 的 `resources`，正文用 `<圖 n="…"/>` 引用——
> 閱讀器把 resources 裡的字檔轉成 blob URL，字型沒裝也看得到。

## 0. 成品（2026-10-28）

| 項目 | 數值 |
|---|---|
| `accelon3\swjzz.adb` | **20,435,719 bytes**（原 5,350,410） |
| SHA-256 | `05788458ec0f6967e0d8c54929e928ce370d3c839d0907a37a465d6ced4d1b77` |
| resources | 7,052 個 `seal/Uxxxx.svg`，13.85 MiB |
| 內文 | 多 7,073 個 `<圖 n="seal/U4E00.svg"/>`（緊接在字頭後面） |
| 覆蓋 | 10,660 個字頭中 **7,052 有篆形（66%）**；3,608 個字型沒有（罕用字、非 Big5） |
| 沒有小篆的備份 | `build/swjzz-noseal.adb`（舊的 5.35 MB 版） |

## 1. 為什麼要自己解 TTF

這個字型的 **cmap 是 Big5 碼**：subtable 是 platform 3 / encoding 4（本該是 Unicode BMP），
但裡面的碼是 `0x8140`、`0x81A1`… 也就是 Big5 雙位元組。`opentype.js` 直接判
「No valid cmap sub-tables」而拒讀，所以 `ts/tools/seal-svg.ts` 自己讀：

1. `cmap` format 4 → `Big5 碼 → gid`。
2. `loca` / `glyf` → 輪廓（簡單字形＋composite 遞迴），二次曲線。
3. 輪廓 → SVG path（`M/L/Q/Z`，y 軸翻成 SVG 座標）。
4. `viewBox` 用字形自己的 bbox（+24 單位留白）——這套篆形常常超出 em 框，用 em 框會被切掉。

Unicode → Big5 的對照表用 Python 的 `cp950`／`big5hkscs` 產生（`D:\2026\swjzz\big5.tsv`，18,345 對）。

## 2. 指令

```powershell
# 0) Unicode → Big5 對照（一次就好，產出 big5.tsv）
python D:\2026\swjzz\big5gen.py

# 1) 只把「字頭」轉成 SVG（省空間；不加 --chars-from 會轉整個 Big5 範圍）
bun run ts/tools/seal-svg.ts --ttf D:\2026\swjzz\BeiShiDaShuoWenXiaoZhuan-1.ttf ^
  --big5 D:\2026\swjzz\big5.tsv --out D:\2026\swjzz\build\seal2 ^
  --chars-from D:\2026\swjzz\build\heads.txt
#   → build/seal2/U4E00.svg … ＋ build/seal-manifest.tsv（name / 字 / gid / resource 名）

# 2) 轉文字時把 <圖> 插在字頭後面
bun run ts/tools/swjz2adb.ts D:\2026\swjzz\swjz.xml D:\2026\swjzz\build\swjz-seal.txt ^
  --ref D:\2026\swjzz\build\shiwen-ref.json --seal D:\2026\swjzz\build\seal-manifest.tsv

# 3) 打包時把 SVG 目錄塞進 resources（第 6 個參數）
bun run ts/tools/swjz-pack.ts D:\2026\swjzz\build\swjz-seal.txt D:\2026\swjzz\build\swjzz-seal.adb ^
  swjzz "說文解字注" D:\2026\swjzz\build\seal2
```

## 3. 閱讀器怎麼顯示（2026-10-28 改為 inline SVG）

作者指示「不必考慮 accelon3 相容性、可以沿用 `<圖>`」，所以 SVG 不再走 blob URL 的 `<img>`：

* `doc-pane.ts`：`resolvePageImages()` 遇到 `.svg` 不建 blob，改成存**原文**（`svgTexts`），
  並把 `svgText` 傳給渲染器；PNG／JPG 照舊走 blob URL（yinshun 那些圖不受影響）。
* `render_accelon3.ts`：`<圖 n="…"/>` 若拿得到 SVG 原文，就輸出 inline
  `<svg class="inlineSvg" viewBox="…" preserveAspectRatio="xMidYMid meet">`（會濾掉 `<script>` 與 `on*`）；
  拿不到才退回 `<img class="inlineImg">`，再拿不到才畫佔位方塊。
* CSS（`accelon26.template.html`）：`.lineText svg.inlineSvg { height:1.5em; width:auto; color:inherit; fill:currentColor }`，
  滑過放大到 2.4em。

好處：字形跟著**字色／主題**走（深色主題是淺色線條，不必鋪白底字卡）、可以用 CSS 縮放、
也沒有每個字一張 blob URL 的開銷。

驗收（`probe-swjzz`）：`svgInline: 1`、`svgBox: "17x24"`（1.5em）、`svgColor: rgb(216,216,216)`（主題字色）。

重建閱讀器（單檔 HTML）：

```powershell
cd ts
bun run tools/build-viewer.ts -o D:\2026\adb-converter\build\accelon26.html
Copy-Item ..\build\accelon26.html D:\accelon3\accelon26.html
```

> 桌面版 `accelon26.exe` 是把 HTML **內嵌**在執行檔裡的，要重打 Wails 才會更新；
> `accelon3\accelon26.html`（雙擊版）已經換成新版。

## 4. 已知限制

* **3,608 個字頭沒有篆形**：這些字不在 Big5（`𠄞`、`𢂇` 這種擴充區字）或字型本身沒收；
  它們的 `<字>` 行沒有 `<圖>`，閱讀器不會畫佔位方塊（沒有圖就不加標籤）。
* **只有輪廓**：沒有做筆順、也沒有保留原字型的 `hintg`；小尺寸（1.5em）下線條會略糊，
  滑過放大就清楚。
* **顏色**：SVG 用 `fill="currentColor"`，但 `<img>` 不會繼承外層顏色，實際上是黑色；
  白底卡片讓它在深色主題也讀得懂。
* **大小**：resources 13.85 MB（平均 2.1 KB／字）。要縮小可以：
  1. 只做正篆、不做重文（少 1,215 個）；
  2. path 用相對座標、去掉重複指令；
  3. 改成一個 SVG sprite＋symbol（但 `<img>` 不能跨檔引用 `#id`，要走 inline `<svg>`，得改渲染器）。
* 這版 **沒有標點**（`swjzzp.adb` 維持原樣）。要「標點＋小篆」就對 `swjz-punct.xml` 再跑一次
  §2 的 2、3 步。
