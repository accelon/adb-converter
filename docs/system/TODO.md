# TODO

依優先序排列；每項附「驗收方式」，完成後把狀態改為 ✅ 並註明證據。

---

## 1. 擴大舊程式（accelon3.exe）實機驗收 ⭐

- [ ] 開 `build/stand13j.adb`（與原檔逐位元組相同）→ 瀏覽 / 搜尋 / 圖片
- [ ] 開 `build/newyinshun.adb`（10/11 容器逐位元組相同）→ 同上
- [ ] 開 `build/yinshun-small.adb`（已通過 ✅ 首次驗收：可讀、logo 與內文圖片正常）

**驗收方式**：用 EXE 開啟上述檔案，記錄可讀/不可讀與症狀；若失敗，指出是哪個容器或欄位。
**重跑**：`cd ts && bun run test:small` 可重新產生小型驗收檔。

---

## 2. caches 的靜態/動態宣告分離（唯一剩下的格式差異）

現況：yinshun 獨立建庫時 `caches` 48 鍵中 `序`、`圖` 兩鍵不同（我多寫了宣告之前的實例）。
已排除的來源：`l=`、`t=`、`s=`、`c=…cached` 四條屬性路徑（`index.pas:992`/`1006` 的 `CreateChildTag` → `docdef.eval('TAG x cached')`）。

- [ ] 若取得各庫的**建庫定義檔（docdef）**：以它為輸入，分離靜態 `cached` 旗標與動態宣告，兩鍵即可對上
- [ ] 否則採務實作法：由原檔 caches 的 docnode 序號反推「每個 cached 標籤的起始序號」，當作建庫參數（與 `--drop-punct`、`--dual-closing` 同類）

**驗收方式**：`bun run tools/cachekeys.mjs <原檔> <新檔>` 顯示 0 鍵不同；`compare-adb.ts` 從 1 failed 變 0 failed。

---

## 3. per-tag `tfDontCare`（`/圖` 3 筆）

- [ ] 由 docdef 取得每個標籤的 format（`tfSingle`/`tfPair`/`tfDontCare`），取代目前「以原檔是否有 `/x` 鍵推斷」的做法

**驗收方式**：`compare-adb.ts --strict` 對 yinshun 為 0 failed, 0 notes。
**備註**：規格已明文允許 tags/postings 數量不同，故此項優先序低於 1、2。

---

## 4. 全庫批次統計（93 庫）

- [ ] 對所有 `.adb` 跑「`extract` → `rebuild-adb --infer` → `compare-adb`」，輸出每庫的 block 相符率
- [ ] 分類：完全位元組相同 / 僅允許差異 / 需人工規則；列出需要新規則的庫與規則
- [ ] 統計 XML 合法率與修復分佈（已有 `xml-lint.ts --json` 的 93 庫結果可用）

**驗收方式**：產生 `build/corpus-rebuild.tsv` 與彙總段落（放 SPEC.md 或獨立報告）。

---

## 5. Go 版同步（次要）

- [ ] `internal/adb` 目前停在舊語義（無 delphi/adbjs 雙模式、無 `dualTags`、無 attributes/caches 生成等）
- [ ] 二選一：同步新規則，或明確標記為「僅交叉參考、不再維護」

---

## 6. 相容性與穩健性

- [ ] `--pascal-line-end` 兼容開關：模擬 Pascal `nextLiteral` 在行尾未閉合 `<` 時讀進下一行緩衝區的越界行為（目前採規範版本，DFB_J 因此少 56 個 token 命中）
- [ ] 合法化修復的可逆性：把「逃脫/刪除」的位置也記進 manifest，讓 XML → ADB 能還原到更接近原檔（目前控制字元刪除不可逆）
- [ ] `andtagid` 之外，檢查是否還有其他「依整庫計算」的 header 欄位在子集/改庫時需要重算

---

## 7. 工程整理

- [ ] 一鍵測試：`bun run test:all`（`verify.ts` + `index-match.ts` + `test:small`）
- [ ] CI（GitHub Actions）：跑上面的一鍵測試；**不得**觸及 `*.adb`/`*.xml`（本機資料，見 `.gitignore`）
- [ ] 清理 `build/` 下的臨時診斷腳本（`build/*.mjs`、`build/*.py`）：把仍有用的收進 `ts/tools/` 並加註解，其餘刪除
- [ ] SPEC.md 與 HANDOVER.md 隨每次規則修正同步（尤其 §17.3 規則表與 §17.4 限制）

---

## 注意事項（每次提交前）

- **絕不提交** `*.adb`、`*.xml`、`build/`、`sourcecode/`、`accelon3/`（`.gitignore` 已排除；提交前用
  `git diff --cached --name-only` 再確認一次）
- 產物（小檔、報表）留在 `build/`，只在文件裡引用路徑
