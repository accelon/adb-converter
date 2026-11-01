# 漢字位置：一律用 code point 計算（2026-11-01）

> 這一頁說明 `j="a-b"`、詞彙 `off`／`hanline`、字元色帶的「第幾個漢字」怎麼算，
> 以及為什麼改成 code point 之後**舊 adb 的 j 要重跑**。

## 1. 規則

- 漢字判定：`\p{Script=Han}`（**一定要 `u` flag**），一次只測**一個完整的
  code point**；不要拿它去測半個代理對。
- 位置：`j`／`off`／`hanline` 的索引是**漢字序號**（第幾個漢字，0 起）；
  換算成 DOM `Range` 的 offset 時才是 **UTF-16 code unit 索引**。
- 共用程式：`ts/src/accelon26/han.ts`

  | 函式 | 用途 |
  |---|---|
  | `isHan(ch)` | 一個 code point 是不是漢字 |
  | `hanChars(s)` / `hanCount(s)` | 去標籤後逐 code point 取漢字／數漢字 |
  | `cpToUnit(s, k)` | 漢字序號 → code unit 位移（給 Range） |

## 2. 為什麼要改

以前 `doc-pane.ts` 的 `domPosInLine()` 用
`/[\u3400-\u9fff\uf900-\ufaff]/` 逐 **code unit** 比對；擴充 B 區的字（例
「𩜁」U+29A41）是代理對，兩半都測不到 → 少算 1 個漢字。詞彙的 `off` 是逐 code
point 算的，於是：

```
fuyan.adb 05B-p274：「…馱那羯磔迦、羯𩜁伽、恭御陀、烏荼等」
點「恭御陀」→ 色帶塗到「烏」（偏 1 個字）
```

## 3. 改了哪些地方

| 檔案 | 改動 |
|---|---|
| `ts/src/accelon26/han.ts` | 新增共用 helper（見上表） |
| `ts/src/accelon26/doc-pane.ts` | `domPosInLine()` 逐 code point；回傳 offset 仍是 code unit |
| `ts/src/accelon26/xref.ts` | 所有 `HAN_RE` 改用共用的 `\p{Script=Han}/u`；`markLine`／`lineHtml`／`pageHanText`／`markFrom` 等逐 code point 掃 |
| `ts/src/terms/terms.ts` | `hanLen()` 改成逐 code point（fuyan／ys 的 `glossary` 位置都走這裡） |
| `D:\2026\fuyan\src\patch_xref_j.py` | `HAN` 加入 `\U00020000-\U0003FFFF` |
| `D:\2026\fuyan\src\{taisho-pages,ys-pages,ys-pages2}.ts` | 頁文字抽取改成 `\p{Script=Han}/u` |

> `D:\2026\fuyan\src\glossary.ts` 已在 2026-11-01 的術語重構中移除，`glossary`
> 改由共用的 `ts/src/terms/terms.ts` 產生（canonical 詞表 `data/terms.tsv`）。

`D:\2026\ys` 的 `glossary.ts`／`calibrate.ts` 本來就用 `\p{Script=Han}`，
不用重跑。

## 4. 遷移（j 已寫死在文字裡）

改了程式**不會**自動修正舊 adb 的 `j`；舊值是「少算擴充區漢字」的結果，
所以指向同一頁後面位置的連結會偏。各庫要重跑：

- **fuyan**（2026-11-01 已重跑）：
  ```powershell
  python src/patch_xref_j.py           # 依新規則重算 j
  bun run src/pack.ts out/05B.txt out/fuyan.adb fuyan 福嚴佛學院講義 logo/fuyan_logo.png out/svg
  Copy-Item out/fuyan.adb D:\accelon3\fuyan.adb -Force
  ```
  `out/svg` 是最後一個參數（圖表資源），漏了會只剩 logo。
- **ys／tx**：`glossary.ts`／`calibrate.ts` 已是 code point，不用重跑；
  但若 j 曾用別的 BMP-only 工具算過，仍要重跑 `addj`／`calibrate` 再 pack。
- **taisho.adb** 沒有 `j`，不用重打；ys／fuyan／tx 的 j 指向它的頁 id，頁 id 不變。

## 5. 驗收

- `bun run test/han.test.ts`（12 項）：
  `hanCount('羯𩜁伽恭御陀') === 6`、`isHan('𩜁')`、半個代理對不算、
  `cpToUnit` 的 code unit 位移正確。
- fuyan 實機（headless）：
  開 `fuyan.adb` → 詞彙搜「恭御陀」→ 點該列 → `CSS.highlights` 的
  `accelonCharBand` 文字正好是 **「恭御陀」**（不是「御陀烏」）。
- 既有：`tools/page-mark-test.ts`、`tools/quote-test.ts`、`tools/note-xref-test.ts` 通過。
  `tools/xref-chip-test.ts` 目前失敗在「分頁標籤要 `^T `」這個**既有**斷言
  （實際標籤是「大正26p625c」，改動前的 `build/accelon26.html` 也一樣失敗）。
