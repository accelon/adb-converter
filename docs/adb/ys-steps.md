# ys.adb 製作步驟（已搬到 `D:\2026\ys`）

`ys.adb` 的建置腳本、來源資料（附錄／後記／圖檔來源／u= 規則）與完整步驟，都已搬到
獨立的 repo：

- 程式與資料：`D:\2026\ys`（看它的 `README.md` 與 `docs/ys-steps.md`）
- 一鍵重建：`pwsh D:\2026\ys\build.ps1`
- **第一步（現在）**：仍需要本工作區（`D:\2026\adb-converter`）提供通用的 adb 工具
  （`authorAdb`、`MAXLINELEN`、adb reader），兩個 repo 放在同一個上層資料夾。
- **未來**：工具整理成可發佈的套件後，客戶只要 `D:\2026\ys` 就能在 CBETA 更新後自行重建。

`ys.adb` 與 `yinshun.adb` 的差異、以及對外說明，留在 [ys.md](./ys.md)。
