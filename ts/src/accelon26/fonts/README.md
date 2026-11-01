# 梵字 Web Font（悉曇／蘭札）

2026-11-01 起，**悉曇字改用 Noto Sans Siddham**（OFL，48.7 KiB），不再內嵌
CBETA 的 `Siddam.ttf`（子集後 415.6 KiB）。Noto 排不出來的 81 個字，從 CBETA
的字型抽出輪廓，做成 12.1 KiB 的補充字型。

| 檔案 | 用途 | 大小 |
|---|---|---|
| `accelon-siddham-unicode.woff2` | 悉曇 Unicode（U+11580–115FF，保留 GSUB） | 48.7 KiB |
| `accelon-siddham-extra.woff2` | 81 個只有 PUA、Noto 排不出來的悉曇字 | 12.1 KiB |
| `accelon-ranjana.woff2` | 蘭札（RJ，Noto 沒有） | 18.4 KiB |

- `accelon-siddham.woff2`（CBETA 全部 2,074 字）**已不再內嵌**，只留著做歷史對照；
  需要時可重跑腳本。
- 閱讀器把 `SD-XXXX` 的 PUA（`U+FA000+XXXX`）在**顯示時**換成 Unicode 序列，
  由 Noto 排；序列在 `ts/src/accelon26/pua-seq.ts`（1,993 個）。
- 對照表：`pua-seq.ts`（`python build/gen-pua-seq.py`）、`siddham-seq.ts`
  （SAT 的 `&SDxxxxx;`，`python build/gen-siddham-seq.py`）。

## 重新產生

```powershell
$env:PYTHONPATH='build\py'
python ts/tools/build-siddham-unicode.py        # Noto 子集
python ts/tools/build-siddham-extra.py          # 81 個 CBETA 補充字形
python ts/tools/build-sanskrit-fonts.py --src build/fonts --out ts/src/accelon26/fonts   # 全部（含舊的 accelon-siddham.woff2）
```

## 授權

- Noto Sans Siddham：SIL OFL 1.1（`OFL-NotoSansSiddham.txt`）。
- CBETA 字型（Ranjana、Extra 的來源）：免費提供非營利及個人研究使用。
- 詳見 `docs/system/THIRD-PARTY.md`。

**不要手改 WOFF2**；要換字型版本就重跑上面的腳本。
