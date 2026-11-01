# 開一個新的 adb 工作區（給作者與代理）

> 2026-11-01。作者說「從你這裡開 adb 工作文件夾」時，照這頁做：
> **先把 `AGENTS.md` 帶進新資料夾**（它會要求新工作區回母區讀紀律），
> 再開新工作區。新工作區只放「這一庫的資料與建置」，共用規則留在母區。

## 1. 先決定

| 項目 | 說明 |
|---|---|
| 資料夾 | `D:\2026\<name>`（與 `ys`、`fuyan` 同層）；已移出的專案不放在母區內 |
| `dbname` | 小寫英數，例 `fuyan`；成品 `D:\accelon3\<name>.adb` |
| 中文名 | `dbcname`，例「福嚴佛學院講義」 |
| 來源 | CBETA XML／SAT／docx／舊 adb；寫清楚版本與路徑 |
| 分層 | 底座（經文）／功能（標注、連結）／工具；見 `stable-adb.md` |

## 2. 建立資料夾與 AGENTS.md

```powershell
$name = 'newdb'
$dir  = "D:\2026\$name"
New-Item -ItemType Directory -Force $dir | Out-Null

Copy-Item 'D:\2026\adb-converter\docs\adb\new-adb-AGENTS.md' "$dir\AGENTS.md"
```

用編輯器把模板裡的佔位換掉：

- `{{DB}}` → `newdb`
- `{{TITLE}}` → 中文名
- `{{WORKDIR}}` → `D:\2026\newdb`
- `{{SOURCE}}` → 來源與版本（例「CBETA XML-P5 2026R2，T01–T55」）

> 不要直接複製母區 `D:\2026\adb-converter\AGENTS.md`：那是「工具與官網」工作區的
> 規則（成品放 `D:\accelon3`、viewer 位置、發佈權限…）。新工作區的 `AGENTS.md`
> 應該是**模板這一份**，它在 §0 要求新工作區回母區讀那幾份紀律文件。

## 3. 基本骨架

```text
D:\2026\<name>\
  AGENTS.md        ← 從模板複製、填好
  README.md        ← 來源、指令、成品、限制（給下一個接手的人）
  src\             ← 轉檔／patch／pack 腳本
  raw\ 或 data\    ← 原始檔（唯讀；大檔不進版控）
  out\             ← 中間產物、測試輸出（不進版控）
  docs\            ← 這一庫的 steps／notes（可選）
```

成品不要放 `out/` 或 `dist/`：**copy 到 `D:\accelon3\<name>.adb`**。

## 4. 開工前先讀（新工作區的 agent 也要讀）

1. `D:\2026\adb-converter\AGENTS.md`（母區規則）
2. `D:\2026\adb-converter\docs\adb\adb-knowhow.md`（共用 know-how）
3. `D:\2026\adb-converter\docs\adb\adb-version-log.md`（版本紀錄）
4. 依需要：`han-position.md`、`terms.md`、`glossary.md`、`missing-char.md`

## 5. 建置與記帳（不可省）

1. 建置、驗證、pack → `D:\accelon3\<name>.adb`
2. 在母區 `deploy/adb-notes.json` 寫這個 sha 的說明
3. 在母區 `docs/adb/adb-version-log.md` **加一列**（日期／sha 前 12／大小／
   buildTime／工作區／說明）
4. 要發布才跑 `publish-adb.ts`（大檔 `--allow-large`）；官網 exe release 仍由母區

## 6. 母區要補的文件

- `docs/README.md` 的索引加一列（這一庫的 about／steps）
- 若是公開庫：`deploy/adb-status.json`、`www/adb/index.txt`、`docs/adb/<name>-about.md`

## 7. 停用時

照 `new-adb-AGENTS.md` §7 交接：最後一次建置能重跑、版本紀錄有最後一列、
README 寫清楚「已停用，維護看母區哪一份」。
