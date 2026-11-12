# adb MCP — 讓 AI 直接讀 `.adb` 的 MCP 伺服器

把 accelon26 的 `.adb` **讀取／搜尋引擎**包成一個 [Model Context Protocol](https://modelcontextprotocol.io) 伺服器。
裝好之後，AI 助手（QwenWork、Claude Desktop 等支援 MCP 的客戶端）就能直接呼叫工具去
**列庫、看檔頭、走詞索引搜尋、讀目錄樹、取某幾行**——**往後只要是「讀 adb」，不必再翻 `ts/tools/adb-skill` 的 ADBEngine 原始碼、也不必手打 CLI**。

- 只讀：不改 `.adb`、不匯出、不寫檔。
- 零依賴：自己講 stdio 上的 newline-delimited JSON-RPC，**不裝 `@modelcontextprotocol/sdk`**（與本 repo「全專案無 npm 依賴」一致）。
- 與 accelon26 閱讀器**同一套讀取層**（`ts/tools/adb-skill/engine.ts`）：行號、VA、搜尋結果都與閱讀器一致。
- 兩種跑法：**一般使用者**從 GitHub Release 下載單檔 `adb-mcp.cjs`，用 **Node** 直接跑（不需 Bun、不需整個 repo）；**開發者**用 Bun 直接跑原始碼 `mcp/server.ts`。

## 需要的東西

- 執行：**Node ≥ 18**（跑 Release 的 `adb-mcp.cjs`）；或 **Bun ≥ 1.1**（跑原始碼、或自己重新打包）。
- 要讀的 `.adb` 放在搜尋目錄裡（預設 `D:\accelon3` ＋ repo 根 `D:\2026\adb-converter`，見下方「adb 搜尋目錄」）。

## 安裝（從 GitHub Release，一般使用者）

1. 到 <https://github.com/accelon/adb-converter/releases> 下載最新 `adb-mcp` 那一版的 **`adb-mcp.zip`**（約 145 KiB，跨平台單一檔）。
2. 解開得到 `adb-mcp.cjs`（內嵌整條只讀引擎，不需要 repo 其他檔案）。
3. 先確認能跑（Node 直接讀 stdio 上的 JSON-RPC）：

   ```powershell
   echo {"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}} | node adb-mcp.cjs
   ```

   會看到六個工具的名字，就代表成功（除錯訊息走 stderr，stdout 只有協定內容）。
4. 把 `command`／`args` 指到這個檔案接進你的 MCP 客戶端（見下方「連線到你的 MCP 客戶端」）。

> `.zip` 旁附 `adb-mcp.zip.sha256`；解壓後可用 `Get-FileHash adb-mcp.zip`（Windows）或 `shasum -a 256`（macOS/Linux）核對。

## 執行（開發者，用 Bun 跑原始碼）

```powershell
bun run D:\2026\adb-converter\mcp\server.ts
```

單跑不會有畫面——它講的是 **stdio**（標準輸入輸出）的 JSON-RPC，等 MCP 客戶端接進來。
除錯訊息一律走 stderr（`[adb-mcp] ready · 6 tools · searchDirs: ...`），stdout 只有協定訊息。

重新打包 Node 單檔（改完 `server.ts` 後）：

```powershell
bun run D:\2026\adb-converter\mcp\build-node.ts   # → build/mcp-release/adb-mcp.cjs
```

## 工具

| 工具 | 參數 | 回傳 |
|---|---|---|
| `adb_list` | — | 各搜尋目錄及其中的 `.adb` 清單、合計數 |
| `adb_info` | `db` | 書名（`title`／`dbname`）、行數、VA 上限、標籤數、文件數、資源數、容器、標籤名 |
| `adb_tags` | `db` | 標籤清單＋每個標籤的實例數（開標籤計數） |
| `adb_toc` | `db`, `limit=200` | 目錄樹 `[{depth,tag,label,va,vaEnd}]`；無 `<樹>` 宣告的庫回空，改用 `adb_search` |
| `adb_search` | `db`, `query`, `limit=20` | `{total, ms, missing, hits:[{line,va,text}]}`。空白＝AND，連寫＝詞組，支援 `+ - * .` 萬用字元 |
| `adb_read` | `db`, `from`, `to?`, `raw?` | 連續幾行文字（預設去標籤；`raw=true` 保留原始標記） |

建議用法就是本 repo 的既有慣例：**先 `adb_info`／`adb_search`（引擎端查詢）定位，再用 `adb_read` 取那幾行**；不要用 `adb_read` 整本抽取。
`db` 可以寫 `13j`（找 `13j.adb`）、`taisho`、或絕對路徑 `D:\accelon3\cyd.adb`。行號 0 起算，與閱讀器狀態列「行 N」相同。

### 實測範例（對 `D:\accelon3` 真庫）

```
adb_info  13j   → 十三經，行數 42,173，VA 上限 818,554，標籤 9，容器 source/tokens/tags/tables/attributes/caches
adb_search 13j "君子終日乾乾" → 命中 2 筆（5 ms）
adb_toc   13j   → 2,020 個節點（書 周易 → 章 乾 坤 屯 …）
adb_search taisho "如是我聞" → 3,210 筆（241 MB 庫，928 ms）
```

## 連線到你的 MCP 客戶端

MCP 客戶端會**自己啟動這個程式**（spawn）再透過 stdio 溝通。把下面這段存進各家的設定檔即可。

### 用 Release 的 `adb-mcp.cjs`（Node；一般使用者）

```json
{
  "mcpServers": {
    "accelon26-adb": {
      "command": "node",
      "args": ["C:\\Users\\你\\adb-mcp\\adb-mcp.cjs"],
      "env": { "ADB_MCP_DIRS": "D:\\accelon3;D:\\2026\\adb-converter" }
    }
  }
}
```

`args` 換成你解開 `adb-mcp.zip` 後那個 `adb-mcp.cjs` 的實際路徑。macOS/Linux 同理，路徑用 `/`。

### 用 repo 原始碼（Bun；開發者）

```json
{
  "mcpServers": {
    "accelon26-adb": {
      "command": "bun",
      "args": ["run", "D:\\2026\\adb-converter\\mcp\\server.ts"],
      "env": { "ADB_MCP_DIRS": "D:\\accelon3;D:\\2026\\adb-converter" }
    }
  }
}
```

兩段只差在 `command`／`args`：一個 `node` 跑打包好的 `.cjs`、一個 `bun` 跑原始碼；工具、行為完全相同。

### 只有本機要試、不想改全域設定

各客戶端的 MCP 設定檔位置不同（Claude Desktop 在 `%APPDATA%\Claude\claude_desktop_config.json`；
其他客戶端見其「Connectors / MCP / 伺服器」頁新增一個 **stdio** 類型、命令同上）。設定後重啟客戶端，
在工具清單裡應能看到 `adb_list`、`adb_info`、`adb_search` 等六個工具。

## adb 搜尋目錄

`adb_*` 的 `db` 參數照下面順序解析成實際檔案：

1. 直接是存在的檔案或相對路徑 → 用它；
2. 加 `.adb` 後存在 → 用它；
3. 拿檔名到**搜尋目錄**逐一找 `<name>.adb`。

搜尋目錄＝環境變數 `ADB_MCP_DIRS`（用 `;` 或路徑分隔符分隔多個）；沒設時用預設：

- `D:\accelon3`（accelon26 桌面版放成品 adb 的地方）
- repo 根 `D:\2026\adb-converter`

`adb_list` 會把每個目錄是否存在、各有幾本一起報出來，方便核對設定。

## 協定相容性

- **MCP 2026-07-28（無狀態）**：實作 `server/discover`（新規範 MUST）、結果附 `resultType:"complete"`、
  `tools/list` 附 `ttlMs`／`cacheScope`；每個請求讀 `_meta.io.modelcontextprotocol/protocolVersion`。
- **舊握手（2024-11-05 ～ 2025-11-25）**：照常處理 `initialize`／`notifications/initialized`／`tools/list`／`tools/call`。
- 版本採**回顯**（echo）：用客戶端要求的那一版回覆；不認識才退回最新正式版。因此新舊客戶端都接得上。
- 每個工具結果同時給 `content`（給模型讀的文字）與 `structuredContent`（給程式讀的結構）。

## 與 ADBEngine 的關係

| 想要的 | 以前 | 現在 |
|---|---|---|
| 列庫 | `bun run cli.ts list` | `adb_list` |
| 檔頭 | `bun run cli.ts info 13j` | `adb_info db=13j` |
| 目錄樹 | `bun run cli.ts toc 13j` | `adb_toc db=13j` |
| 全文搜尋 | `bun run cli.ts search 13j 涅槃` | `adb_search db=13j query=涅槃` |
| 讀某幾行 | `bun run cli.ts show 13j 8-11` | `adb_read db=13j from=8 to=11` |

底下仍是 `engine.ts` 的 `AdbEngine`（`openAdb → info/toc/search/line/raw`），CLI 與 MCP 共用同一顆引擎；
差別是 MCP 讓 AI 助手**自己判斷該查什麼、該讀哪幾行**，不需要人再去翻引擎原始碼或記 CLI 語法。
`engine.ts` 更新（例如新增查詢語法）時，這個 MCP 自動跟著受益。

## 限制

- 唯讀，且**只提供 tools**（不宣告 resources／prompts）。
- 搜尋走 adb 內建詞索引：只找得到索引裡有的詞（標點、空白通常不進索引）；查不到時 `missing` 會列出。
- 單次 `adb_read` 上限 5,000 行；`adb_search` 單次最多回 500 筆（`total` 仍是全部命中數，引擎內部最多掃 5,000）。
- 沒有 `<樹>` 宣告的庫（多半是詞典）`adb_toc` 回空，用 `adb_info`／`adb_search`／`adb_tags`。
- Release 的 `adb-mcp.cjs` 是純 Node、跨平台單一檔：解壓走內附的純 JS bzip2（**讀 adb 只需解壓，不需要 libbz2、也不需要 Bun**），比原生 libbz2 慢數倍但結果逐位元組相同。開發機用 Bun 跑原始碼時，有 `libbz2` 會自動走原生加速。
