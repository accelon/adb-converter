# ys/ — ys.adb 的來源資料與建置腳本

這個目錄是 `ys.adb` 的**可重建來源**。有了這裡的檔案，重建 `ys.adb`
不需要 `yinshun.adb`，也不需要 CBETA 以外的任何資料庫。

## 檔案

| 檔案 | 說明 |
|---|---|
| `ys-foreword.txt` | 「印順法師著作全集 2026 年 AI 版序」原始檔，**含 Accelon3 標記**（`<檔>`、`<書>`、`<卷>`、`<頁元>`、`<頁>`、`<章>`、`<節>`、`<段/>`）。一行一個 adb 行，改字直接改這個檔。 |
| `appendix.txt` | 舊版卷首五頁（參與人員名單、印順導師略傳、略譜、著作出版年表、基金會簡介），含 `<頁>` 與內文標記。 |
| `prep.ts` | 把序文、CBETA 內文、附錄併成 `build/ys-text-full.txt`。 |
| `calibrate.ts` | 依對照表把 `<聯 i="taisho?…" q="…">` 插入文字（字元級鏈結）。 |
| `pack.ts` | 用 `authorAdb` 打包 `ys.adb`（含 `logo/ys_logo.png`）。 |
| `build.ps1` | 一鍵重建：`y2adb` → `prep` → `calibrate` → `pack`。 |

## appendix.txt 的來源

`appendix.txt` 是從舊版 `yinshun.adb` 抽出的（頁 id 以 `00p` 開頭的五頁），
2026-10-28 抽出，內容如下（字數為漢字數）：

| 頁 id | 標題 | 字數 |
|---|---|---|
| `00p印順導師略譜` | 印順導師略譜 | 10,962 |
| `00p印順導師著作出版年表` | 印順導師著作出版年表 | 6,234 |
| `00p印順導師略傳` | 印順導師略傳 | 5,792 |
| `00p印順文教基金會簡介` | 印順文教基金會簡介 | 268 |
| `00p參與人員名單` | 參與人員名單 | 181 |

CBETA 的 Y 部 XML（`cbeta-org/xml-p5` 的 `Y/`）沒有這五頁；把它們放進版本控制，
是為了讓 `ys.adb` 永久可重建，不必假設本機還留著舊的 `yinshun.adb`。

若要從某個 `yinshun.adb` 重新抽出（例如日後找到更完整的版本），頁面結構是：

```text
<檔 n="appendix.xml">
<書 l="附錄" t="記" id="99">附錄（舊版卷首資料）</書>
<卷 n="1">1</卷>
<頁元 n="附錄" t="頁.">舊版卷首</頁元>
<頁 id="00p…"/>（該頁文字，標記照舊）
…
```

## 重建

```powershell
pwsh D:\2026\adb-converter\ys\build.ps1
```

需要：Go、Bun、`D:\2026\xml-p5\Y`（CBETA Y 的 sparse clone）、
`D:\2026\offtext\alignments\yinshun-taisho.tsv`、`D:\2023\yinshun-corpus\xml`。

## 建置結果（2026-10-28）

```text
linecount 305551
卷 460、書 44（CBETA）＋書 0（序文）＋書 99（附錄）
頁 17510、頁元 73（CBETA 的 a/b/y/z 前綴）
<聯> 25920
dbname ys、dbcname 印順法師佛學著作集、dbtype 0、andtagid 0
```

完整步驟與陷阱見上層的 `ys-steps.md`。
