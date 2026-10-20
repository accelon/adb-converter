# 操作導覽：劇本怎麼寫

> 這一份是 accelon26 的實作。可重用版本（format／player／compiler／shell／example＋agent skill）在
> [agent-norms/self-explaining-tour](https://github.com/accelon/agent-norms/tree/main/self-explaining-tour)；新專案從那裡開始。

一份 `.tour` 檔就是一份導覽。它會經過編譯變成「宏」（二進位＋base64，人不可讀），
內嵌進 `accelon26.html`，由內建的播放器一步一步做給使用者看。

```
ts/tour/*.tour   →  bun run tools/build-tours.ts  →  src/accelon26/tour-data.ts  →  build/accelon26.html
```

改完劇本一定要**重跑編譯器**，否則 `bun run test/tour.test.ts` 會紅（它會比對「劇本 ⇄ 宏」是否同步）。

```bash
cd ts
bun run tools/build-tours.ts          # 編譯（錯誤會帶檔名與行號）
bun run tools/build-tours.ts --check  # 只驗證有沒有過期
bun run tools/build-viewer.ts         # 重建 HTML（宏會被 bundle 進去）
bun run tools/tour-test.ts            # 真瀏覽器從頭播到尾（13j／yinshun／fgdict 各跑一次）
```

## 檔案長什麼樣

```markdown
@id     first-run
@title  第一次使用
@intro  十分鐘走一遍：開庫、查詞、看本文。

### 開啟資料庫
左邊的 📁 是 **adb 選單**。第一次用，按最上面的「＋ 加入 adb」。

> 指向 #dbPickBtn
> 你來 按一下 📁，選一個 .adb => api:db
> 等頁面 api:db 120000
```

六條規則：

| 寫法 | 意思 |
|---|---|
| `@id/@title/@intro/@require` | 檔頭資訊（放在第一個 `###` 之前）。`@id` 必須等於檔名 |
| `### 標題` | 開始一個場景 |
| `> 指令 參數` | 一個動作 |
| 其他每一行 | 這個場景的說明文字（支援 `**粗體**`、`` `等寬` ``、空行分段） |
| `# 註解` | 編譯器丟掉 |
| 場景外的文字 | 會報錯（放進場景，或寫成 `@intro`） |

## 指令

中文與英文都可以，參數用空白分隔；`=>` 是「目標 => 內容」的分隔線。

| 中文 | 英文 | 寫法 | 做什麼 |
|---|---|---|---|
| `指向` | `point` | `指向 #dbPickBtn` | 聚光燈照過去 |
| `不指向` | `unpoint` | `不指向` | 收掉聚光燈 |
| `點` | `click` | `點 #settingsBtn` | 真的點下去（走瀏覽器事件） |
| `輸入` | `type` | `輸入 #query => 般若` | 設值 ＋ 觸發 input（debounce 的搜尋會跑） |
| `按鍵` | `key` | `按鍵 Enter #query` | 派送 keydown（省略選擇器＝目前焦點） |
| `等` | `wait` | `等 600` | 停一下，讓眼睛跟上（毫秒） |
| `等頁面` | `waitFor` | `等頁面 #searchList .snippet 8000` | 輪詢到條件成立；最後一個純數字是逾時 |
| `分頁` | `tab` | `分頁 左 dir` | 切換某一欄的分頁（左｜右） |
| `側欄` | `side` | `側欄 右 開` | 顯示／收起某一欄 |
| `設定` | `set` | `設定 simmode 1` | `advanced`／`variants`／`pagemarks`／`simmode`／`hardbreaks`／`raw` |
| `說` | `say` | `說 這裡是摘要` | 場景中途換氣泡文字（同場景分兩段講） |
| `呼叫` | `call` | `呼叫 dictLookup => 般若` | 白名單函式：`openSettings`／`openSearchAll`／`runSearchAll`／`dictLookup`／`search`／`openAbout`… |
| `你來` | `user` | `你來 按一下 📁 => api:db` | **等使用者自己做**（氣泡出現「我做好了」「略過」）；條件成立就自動過 |
| `停` | `tap` | `停` / `停 看完再點一下` | 停在這裡，等使用者**在畫面任何地方點一下**（或按空白／→／Enter）才繼續 |
| `需要` | `require` | `需要 api:db` | 條件不成立就停在這裡等（最多 120 秒） |
| `若非` | `skipIf` | `若非 !#colLeft .tabBtn[data-tab=freq]` | 條件成立就整場跳過（「這個庫沒有這個分頁」） |

## 條件

用在 `等頁面`、`你來`、`需要`、`若非`；前面加 `!` 就是否定。

| 寫法 | 意思 |
|---|---|
| `#id` / `.cls` | 選擇器命中的元素**存在且看得見**（有面積、不是 `visibility:hidden`） |
| `!#settingsBox:not([hidden])` | 反過來：它看不到 |
| `count:#searchList .snippet >= 1` | 數量比較（`>= <= == != > <`）；清單是分批掛的，就靠這個 |
| `api:db` / `api:db=13j` | 讀 `__accelon26.state()` 的屬性（`db`、`dict`、`leftTab`、`rightTab`…） |
| `text:#dbPickBtn=📁` | 文字內容包含 |

## 寫的時候注意

1. **介紹介面的場景要用 `停`，不要用 `等`**。自動跑完的介紹，讀者來不及看第二眼；
   `停` 讓他自己決定節奏（作者 2026-10-18 對第一個場景的要求）。
2. **不要用 `等` 等資料**。開庫、目錄樹、搜尋結果都是非同步的：用 `等頁面 count:…`。
   固定 `sleep` 在慢機器上就是隨機失敗，在快機器上就是浪費。
3. **指著彈窗裡面的東西時，先關彈窗再往下走**（`不指向` → `點 #settingsClose`）。
   否則聚光燈會照在一塊已經消失的地方，氣泡會顯示「⚠ 找不到」。
4. **每個資料庫都不一樣**。沒有 `s="*"` 的庫（例如 fgdict）沒有「目錄」分頁，`#query` 也看不到——
   這種場景開頭放一行 `若非 !#colLeft .tabBtn[data-tab=dir]`。
5. **檔案對話框不能自動化**（瀏覽器安全限制）。「開檔」那一步永遠是 `你來`。
6. **場景要能單獨看懂**。使用者可能只按「重播本場景」，也可能從中段接續。
7. 編譯器會擋掉打錯的 `#id`、`data-tab`、`api:` 路徑 —— 這是導覽最常見的死法（指著空氣，卻沒有任何錯誤）。
8. 入口在**「關於」（左上角 accelon26）→「▶ 操作導覽」**；關於頁預設在啟動時顯示。

## 相關

- `src/accelon26/tour-format.ts`：opcode 表與編解碼（改格式要 `TOUR_FMT+1`）
- `src/accelon26/tour.ts`：播放器（聚光燈、氣泡、等待、鍵盤）
- `tools/build-tours.ts`：編譯器與靜態檢查
- `tools/tour-test.ts`：全播測試
- `../architecture.md` §9
