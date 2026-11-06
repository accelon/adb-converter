# adb-skill — .adb 的讀取／搜尋引擎 ＋ CLI（原始碼版）

把這個資料夾解開，把要讀的 `.adb` 放在**同一個資料夾**，用 [Bun](https://bun.sh) 直接跑，
不需要閱讀器 UI、不需要編譯。資料夾裡附一個 `manual.adb`（accelon26 的說明手冊）可以試。

```powershell
bun --version            # 需要 Bun（1.1 以上）
bun run cli.ts list
bun run cli.ts info manual
bun run cli.ts toc manual
bun run cli.ts search manual 表格 -n 5
bun run cli.ts show manual 131-135
```

> 想要單檔 `.exe`（客戶沒有 Bun 時）：`bun build --compile --outfile adb-skill.exe cli.ts`
> （會把 Bun 執行環境一起打包，約 110 MB）。

## 命令

| 命令 | 作用 |
|---|---|
| `bun run cli.ts list` | 列出同目錄的 `.adb` |
| `bun run cli.ts info <db>` | 檔頭（書名、行數、VA 上限）、容器、標籤數、文件數、資源數 |
| `bun run cli.ts toc <db> [--json]` | 目錄樹（縮排、標籤、VA 範圍） |
| `bun run cli.ts search <db> <query> [-n 20] [--context N] [--json]` | 全文搜尋 |
| `bun run cli.ts show <db> <from>[-<to>] [--raw]` | 印某幾行 |
| `bun run cli.ts text <db> [--from N] [--to M] [--raw]` | 印一段連續文字 |
| `bun run cli.ts export <db> -o <dir>` | 每一檔一份純文字 |

- `<db>` 寫 `13j` 就會找同目錄的 `13j.adb`；也可以直接給路徑。
- **行號 0 起算**，和閱讀器狀態列的「行 N」一致（`show`、`search` 的輸出都用這個編號）。
- 搜尋：空白分開＝每個詞都要出現（AND）；連在一起＝詞組（字序相連，可跨硬換行）。
- 預設輸出是**去掉標籤的純文字**；要原始標記加 `--raw`。
- `--json` 給程式讀（`list`／`info`／`toc`／`search`）。

```powershell
bun run cli.ts search 13j 乾 -n 10                 # 十三經的「乾」
bun run cli.ts search 13j "君子終日乾乾" --context 1
bun run cli.ts export fgdict -o out\fgdict          # 整個詞典庫倒成純文字
```

## 二次開發：`engine.ts`

`engine.ts` 把讀取層包成一個物件，直接 import 就能用：

```ts
import { openAdb } from './engine';

const db = await openAdb('13j.adb');

db.title;        // '十三經'
db.lines;        // 42173
db.tags;         // ['書','章','節',…]
await db.raw(42);            // 第 42 行的原始標記
await db.line(42);           // 第 42 行去掉標籤的純文字
await db.text(0, 9);         // 0–9 行的純文字陣列
await db.toc();              // [{ depth, tag, label, va, vaEnd }]
await db.search('涅槃');      // { total, ms, missing, hits: [{ line, va, text }] }
```

`example.ts` 是一份可直接跑的範例：

```powershell
bun run example.ts
```

要更細的控制，`engine.ts` 也把底層一起 export 出來：

| 模組 | 內容 |
|---|---|
| `src/accelon26/adb.ts` | `AdbReader`：adb 檔頭、容器、區塊解壓（bzip2）、`SyncIO`（一般檔案）／`BlobIO`（瀏覽器 `File`） |
| `src/accelon26/vapa.ts` | `VaPaMapper`：VA ⇄ 行號 ⇄ 區塊、`lineText(n)`、`edgeLine(va)`、`docText()` |
| `src/accelon26/search.ts` | `SearchSession`：詞索引查詢（AND／詞組／萬用字元）、`loadTrees`／`loadTree`（目錄樹） |
| `src/accelon26/query.ts` | 查詢語法解析（`parseQuery`） |
| `src/tokenize.ts`、`src/unicode.ts`、`src/dia.ts` | 分詞、空白／標點判定、重音正規化 |
| `src/accelon26/variants.ts`、`variant-data.ts` | 異體字群組（搜尋時可一起找） |
| `src/vendor/bzip2.js` | 純 JS 的 bzip2（adb 的壓縮區塊） |

想接自己的前端：`AdbReader.open(new BlobIO(file))` 之後，`VaPaMapper`、
`SearchSession` 的用法和 CLI 一樣；`render_accelon3.ts` 那種「排版」不在此套件裡（它要 DOM）。

## 限制

- **只讀**：不會改 adb，也不能編輯。
- 搜尋走 adb 內建的詞索引：只找得到索引裡有的詞（標點、空白通常不進索引）；查不到時會印「索引裡沒有：…」。
- 預設一頁 20 筆（`-n` 可調）；`--json` 也只有 `-n` 筆，但 `total` 是全部命中數。
- `text` 不給 `--to` 會把整本印出來，請自己接 `| more` 或加 `--to`。
- 沒有 `<樹>` 宣告的庫（例如字典）`toc` 會是空的，用 `search` 或 `info` 就好。

## 這是什麼做的

和 accelon26 閱讀器**同一套**讀取層：解壓、VA 定位、詞索引、目錄樹。所以行號、頁碼、
搜尋結果都與閱讀器一致；閱讀器更新時，把 `src/` 裡對應的檔案換掉就好。
