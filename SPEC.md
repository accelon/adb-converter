# Accelon3 `.adb` 技術說明書

本文是 `.adb` 容器的完整技術規格：結構、欄位、尋址模型、文字與標籤模型，以及匯出建議。
內容以 **Delphi 7 原始碼**為權威依據（`sourcecode\`，讀碼入口 `accelon3.dpr`），並以
[`ts/`](ts/src/cli.ts) 的 Bun 實作在真實資料上驗證。

* 讀碼筆記（逐單元、含 Pascal 片段）：[PASCAL-NOTES.md](PASCAL-NOTES.md)
* 早期英文逆向筆記與驗證表：[FORMAT.md](FORMAT.md)
* Bun CLI：`bun run src/cli.ts analyze|inspect|export ...`（見 [§11](#11-bun-工具)）

驗證資料：`13j.adb`（十三經，2.1 MiB）、`yinshun.adb`（印順法師佛學著作集，23.8 MiB）、
`D:\accelon3` 下 93 個資料庫（11.5 GiB，含 24 個字典庫、43 個含 resources）。

---

## 1. 單元職責與讀碼路徑

| 單元 | 職責 |
|---|---|
| `accelon3.dpr` | 工程檔，列出全部單元（`adb`、`romblock`、`lists`、`srcpack`、`basetype`、`exporter`…） |
| `basetype.pas` | `TDbHeader`、`TDocNode`、`TTag`、`DBTYPE_*`、`FEATURE_*`、標籤中英對照表 |
| `romblock.pas` | `TROMBlocks`：所有容器（block 陣列）的解析 |
| `lists.pas` | `TPackedList`：變長整數表（長度表、命中表、行表） |
| `srcpack.pas` | `TSrcPacker`／`TSrcUnpacker`：文字 block 的壓縮打包與解壓、**行提取** |
| `adb.pas` | `TAccelonDB`：頭部裝載與校驗、容器掛載、標籤／屬性／文件（`TDocNode`）模型 |
| `winfo.pas` | `Button3Click`：Delphi 端唯一的「逐行 dump XML」實作（調試級） |
| `exporter.pas` | GUI 的渲染式匯出（HTML/TXT 摘錄），**不是**原始 dump |
| `converter\convert_to_xml.pas` | 只是外部格式轉換 DLL 的插件管理器，與 adb 無關 |
| `codeconv.pas`／`cunicode.pas` | `convertcode`：BIG5／GB 等碼表轉換（與檔案內部編碼無關） |

---

## 2. 總體佈局

```
offset 0      256 B          檔案頭 TDbHeader
offset 256     16 B          頂層 TROMBlocks 容器頭
offset 272     …             頂層資料區：source / tokens / tags / tables / attributes /
                             attributes.sorted / caches / resources / topics（存在者才掛載）
               …             頂層「名字塊」（feature & boNamed，最後一個資料塊）
               …             頂層 packed length list
```

`adb.pas: TAccelonDB.create` 會依名字掛載容器：`source`、`tables`、`tags`、`tokens`、
`caches`、`topics`、`attributes`、`attributes.sorted`、`resources`（後幾者可能不存在）。

---

## 3. 檔案頭（256 位元組）

`basetype.pas: TDbHeader`（記錄本身 255 B，檔案中補 1 B 對齊）：

| 偏移 | 大小 | 型別 | 欄位 | 說明 |
|---:|---:|---|---|---|
| 0 | 32 | char[32] | `dbname` | 資料庫短名，預設輸出檔名 |
| 32 | 48 | char[48] | `signature` | `\r\nAccelon Search Engine\r\ndesigned by C.S.Yap`（唯一的格式識別） |
| 80 | 4 | integer | `textterminator` | 常數 `0x1A1A1A1A` |
| 84 | 4 | integer | `version` | 建立此檔的 Accelon3 版本；開啟時要求 `version <= MINORVERSION` |
| 88 | 4 | integer | `compression` | `0=NO_COMPRESSION`（存原文）、`1=COMPRESSION_BZIP2`（每塊獨立 bzip2 流） |
| 92 | 4 | integer | `srcblocksize` | **位元組**為單位的文字塊大小（通常 16384 = 8192 個 UTF-16 碼元） |
| 96 | 4 | integer | `maxblockoffset` | 虛擬位址總長 **+1**（實測：最後 `lines.virtual` 值 +1） |
| 100 | 4 | integer | `andtagid` | AND 檢索用的標籤 id |
| 104 | 4 | integer | `linecount` | 行數（= `lines.physical` 條數 = `lines.virtual` 條數） |
| 108 | 4 | integer | `dbtype` | 位掩碼：`1=IGNOREBLANK`、`2=DICTIONARY`、`4=HIDDEN` |
| 112 | 4 | integer | `protection` | `1=USB_SERIAL`、`2=DRM`（檢查碼被註解停用） |
| 116 | 4 | integer | `tagcount` | 標籤命中總數（= `tags.virtual` 條數） |
| 120 | 4 | integer | `features` | `1=FORCE_SIMPLIFIED`（強制簡體）、`2=CUSTOM_CONV`（自訂轉換） |
| 124 | 4 | integer | `reserved2` | 未使用 |
| 128 | 64 | widechar[32] | `dbcname` | 顯示名稱（UTF-16LE，NUL 結尾） |
| 192 | 16 | char[16] | `serial` | USB 序號 / 序號欄位 |
| 208 | 20 | byte[20] | `pw` | 密碼／SHA1（`has_password` = 有非零位元組） |
| 228 | 23 | byte[23] | `reserved` | 保留（`255-32-48-4*13-64-16-20`） |
| 251 | 4 | cardinal | `crc32` | 對 `header[0..250]` 的 CRC32（`CRC_MAGIC` 初值） |

校驗（`adb.pas: TAccelonDB.create`）：

```pascal
if header.version >= $50902 and crc32 <> header.crc32 then Raise 'CRC checksum error';
if header.maxblockoffset = 0 then Raise 'adb header error';
tokencount := header.maxblockoffset - header.tagcount;   // 只是推導值，非命中數
```

⚠️ `header.tokencount` 只是上式，**不等於** token 索引的命中總數（實測 13j：813558 vs 800549）。

---

## 4. 容器：`TROMBlocks`

```pascal
TROMBlocksHeader = record
  feature: cardinal;        // $40000000 withPointer / $20000000 sorted / $10000000 named
  signature: integer;       // 通常 0
  totalblocksize: integer;  // **資料區**大小（不含 16 B 頭、不含長度表）
  blocksize: integer;       // 0 = 變長（後面接 packed list）；>0 = 定長
end;
```

載入順序（`romblock.pas: loadAt`）：

```
[16 B 頭][資料區 totalblocksize B][packed length list][withPointer 時: fcount*4 B 指標表]
若 boNamed：資料區的**最後一塊**是名字塊（本身又是一個完整 TROMBlocks），讀完 fcount--
```

區塊定址（**權威語義**）：

```pascal
// romblock.pas: TROMBlocks.get(i)
if blocksize > 0 then [i*blocksize, (i+1)*blocksize)
else                   [flengths[i], flengths[i+1])
```

`flengths[i]` 走 `TPackedList` 的預設屬性 `getdata(i)`，其語義是
**`i=0` 回傳 0、`i≥1` 回傳第 `i-1` 個儲存值**（`lists.pas: getdata`）。因此
`blocks[i] = [ends[i-1], ends[i])`（`ends[-1]=0`），且長度表條數 = 資料塊數（含名字塊）。

名字塊內容是 UTF-16LE 字串（NUL 結尾），`indexofname` 以 **`(len+1)*2` 位元組**比對。

---

## 5. `TPackedList`：變長整數表

```
u32 added                    // 後續 varint 載荷的位元組數
floor(added/512) × 8 B       // 里程碑表：TMileStone = (value: cardinal, Count: cardinal)
added B                      // varint 載荷
總大小 = 4 + floor(added/512)*8 + added      // lists.pas: SerializedSize
```

**varint 不是 LEB128**（`lists.pas` 常數即為定義）：

```pascal
MASK_LEADBYTE = $0;      // 首（低位）位元組：bit7 = 0
MASK_FOLLOWBYTE = $80;   // 後續（更高位）位元組：bit7 = 1
MileDistance = 512; MileDistanceShift = 9;
```

規則：**低位組在前且 bit7 清零**，每個更高位組 bit7 置 1；值在下一個 bit7 為 0 的位元組處結束，
而那一位元組屬於**下一個值**。以 7807 為例：標準 LEB128 是 `ff 3d`，adb 存的是 `7f bc`
（`0x7f + (0x3c<<7)`）。

`next()`（`lists.pas:803`）的實際迴圈：**每個讀到的位元組都累加**，並依「下一個位元組的 bit7」
決定是否繼續 —— 與上述規則等價；`prev()`、`gobegin/first`（`curvalue` 從 0 起算）亦同。

值是**累積**的（delta 編碼）：`v[i] = v[i-1] + delta[i]`。里程碑表讀取時被跳過，不參與解碼。

---

## 6. 頂層容器清單

| 容器 | 結構 | 用途 / 實測（yinshun） |
|---|---|---|
| `source` | 每個 block = 一段文字（見 §7） | 1081 塊，8.2 MiB 壓縮 → 16.9 MiB 文字 |
| `tokens` | 每塊 = 一個 token 的命中表（packed list，虛擬位址） | 9516 個 token，10.2 MiB |
| `tags` | 每塊 = 一個標籤的命中表（packed list，虛擬位址） | 129 個標籤，257.6 KiB |
| `attributes` | 每塊名 = `<標籤>.<屬性>`；**塊本身又是一個容器**，其資料塊 = 屬性值（UTF-16LE、NUL 結尾），其 **boWithPointer 指標表** = 擁有該值的 docnode | 76 塊，1.2 MiB；實測 `檔.n` 的 feature=`0x40000003`、45 塊、45 個指標 |
| `attributes.sorted` | 同上（依值排序的版本，供值範圍檢索） | 3 塊（`書.id`、`聯.i`、`頁.id`） |
| `caches` | 每塊名 = 標籤名，塊本身是容器，第 i 塊 = 該標籤第 i+1 個命中的**節點值**（用於免去回讀原文） | 48 塊（yinshun）；實測 13j/kangxi 的 `集` 快取即資料庫標題 |
| `tables` | 5 個固定子塊（見 §8） | 703 KiB |
| `resources` | 每塊 = 一個原始檔案（**不壓縮**） | 457 檔，2.1 MiB（456 張 PNG） |
| `topics` | 選用 | 少數庫才有 |

`tags` / `tokens` 的塊名就是標籤名／token 字串；**塊索引 = 標籤 id**（見 §9）。

---

## 7. 文字模型（`srcpack.pas` 為權威）

### 7.1 每塊獨立壓縮、NUL 結尾

```pascal
decompressed.SetSize(header.srcblocksize + 4);
Count := DecompressionStream.read(pbuf^, decompressed.size);
inc(pbuf,count); pinteger(pbuf)^ := 0;          // 4 B 0 結尾
...
result := result + widestring(p);               // 取用到**第一個 NUL 碼元**為止
```

* `compression=0` 時不壓縮，直接使用原資料（`srcpack.pas:266`）。
* 文字是 **UTF-16LE**；每塊有效文字 = 到第一個 `U+0000` 或解壓長度為止（取較小者）。
* 本語料 93 個庫中，非末塊一律滿 16384 B，且無內嵌 NUL（見 §11 的統計）。

### 7.2 物理位址 = 固定步長

```pascal
blk1 := s div header.srcblocksize;              // s,e 是**位元組**位址
inc(p, (s mod header.srcblocksize) div 2);      // 塊內偏移 → 碼元索引
```

即使某塊解壓後不足 `srcblocksize`，**後續位址仍按固定網格推進**（缺的位元組不會讓偏移前移）。
所以「把各塊緊密拼接」只在所有非末塊都滿長時才等價。

### 7.3 行提取（`getrange_physical`）

```pascal
function getrange_physical(s, e: TPhysicalAddress): widestring;
begin
  blk1 := s div header.srcblocksize;  blk2 := e div header.srcblocksize;
  for i := blk1 to blk2 do begin
    p := pwidechar(getblock(i).memory);
    if i = blk2 then begin                       // 末塊：依行尾截斷
      pend := p; inc(pend, (e mod header.srcblocksize) div 2);
      pendsave := pend^; pend^ := #0;
    end;
    if i = blk1 then begin                       // 首塊：定位到行首，並跳過 CR/LF
      inc(p, (s mod header.srcblocksize) div 2);
      if p^ = #13 then inc(p);
      if p^ = #10 then inc(p);
    end;
    result := result + widestring(p);            // 中間塊整塊（到自己的 NUL）
    if i = blk2 then pend^ := pendsave;
  end;
  result := convertcode(result, cc);             // 碼表轉換（cc=CONV_NONE 不變）
end;

function getline(i) = getrange_physical(PALines[i], PALines[i+1]);
```

**行 i 的區間**（Pascal 權威語義，`getdata` 索引）：

| 行 | 物理區間 |
|---|---|
| 0 | `[0, PALines[0])` |
| i | `[PALines[i-1], PALines[i])` |

整個文件的行數 = **`lines.virtual` 條數**（Delphi dump 的迴圈上界），實測與 `lines.physical`、
`header.linecount` 三者相等。

### 7.4 碼元語義（兩種模式，均已逐位元組驗證）

Pascal 全程以 widechar 拼接：**不丟 BOM、不拆跨塊代理對**。跨塊的代理對在 Pascal 中就是兩個相鄰
碼元，仍是同一個字；而 adbjs 用 JS `TextDecoder` **逐塊**解碼，會 (a) 吞掉每塊開頭的 `U+FEFF`、
(b) 把跨塊代理對變成兩個 `U+FFFD` —— 那是 JS 移植的副作用，**不是原始行為**。

Bun 匯出器以 `--text` 提供兩種語義，兩者都已用獨立參考驗證：

| 模式 | 佈局 | BOM | 跨塊代理對 | 行首 CR/LF | U+0000 |
|---|---|---|---|---|---|
| `--text delphi`（預設） | 固定步長網格 | 保留 | 保留成一個字 | 跳過 | 逐塊截斷 |
| `--text adbjs` | 緊密拼接 | 每塊丟棄 | 轉成兩個 U+FFFD | 不跳 | 保留 |

`kangxi.adb`（含 3 個塊首 BOM、12 個跨塊代理對）的實測：

| 來源 | 位元組 | SHA-256（前 16） |
|---|---:|---|
| adbjs（JS 參考實作 `dumpXML`） | 12,904,331 | `b0566c8b63c63582` |
| Bun `--text adbjs` | 12,904,331 | `b0566c8b63c63582` ✓ |
| 獨立 eager 模型（照 `getrange_physical` 偽碼） | 12,904,294 | `958ec65292ab9cd1` |
| Bun `--text delphi` | 12,904,294 | `958ec65292ab9cd1` ✓ |

`yinshun.adb`（45 檔輸出、266,916 行）的串流匯出與 eager 模型同一 SHA-256
（`c9ab05bff45e63e5…`，24,011,306 位元組）✓。

**實測附註**：本語料 93 個庫的文字中 **CR/LF/NUL 碼元數皆為 0**
（13j 831,156 字、yinshun 8,847,831 字、miuking 20,160,532 字皆為 0），且非末塊一律滿 16,384 位元組
—— 因此「跳過行首 CR/LF」「NUL 截斷」「固定步長 vs 緊密拼接」在本語料多為等價；
真正造成差異的是 BOM 與跨塊代理對（見上表）。這些防禦性語義仍已實作，以應付未見過的檔案。

---

## 8. `tables` 子塊

| 子塊名 | 內容 |
|---|---|
| `blocks.virtual` | 每個 source 塊的**虛擬起始位址**（條數 = 塊數） |
| `lines.physical` | 每行的**物理結束位址**（`getdata` 語義，條數 = 行數） |
| `lines.virtual` | 每行的**虛擬結束位址**（條數 = 行數） |
| `tags.virtual` | 每個標籤命中的虛擬位址（條數 = `header.tagcount`） |
| `doclengths` | 文件長度表（yinshun 45 條、13j 1 條） |

虛擬位址空間（`TVirtualAddress`）比物理位址小（yinshun：7,676,909 vs 17,695,662 位元組）：
標籤本身佔用物理字元但不佔（或只佔 1 單位）虛擬空間；`maxblockoffset` = 虛擬總長 + 1。

---

## 9. 標籤與文件（`TDocNode`）模型

```pascal
TDocNode = (tagid and $FF) shl 24 or (n and $FFFFFF);   // 高 8 位=標籤 id，低 24 位=第 n 個命中
tagid    = tags 容器中的塊索引（= 標籤名在名字塊中的序號）  // adb.pas: gettagid
pos(dn)  = tags[tagid] 命中表[ n ]                       // n 為 1-based
range(dn)= [ pos(dn), pos(dn+1) )，若 pos(dn+1) 不存在則到 header.maxblockoffset
```

**命中表的索引語義（實測校正）**：`TPackedList.getdata(0)` 回傳虛擬值 0（不消耗儲存值），
`getdata(n)`（n≥1）回傳第 n 個**儲存值**。因此每個命中恰好存一個值、**沒有隱含前置 0**：

| 庫 | 標籤 | 儲存值數 | 首值 | 末值 | 解讀 |
|---|---|---:|---:|---:|---|
| yinshun | `檔` | 45 | 0 | 7641310 | 45 篇；第 1 篇的 VA 就是 0（`<檔 n="yinshun.xml">` 位於文字開頭） |
| yinshun | `集` | 1 | 4 | 4 | 全庫只有一個 `集` |
| 13j | `集` | 1 | 0 | 0 | `集` 就是文字的第一個標籤 |
| 13j | `書` | 13 | 29 | 775582 | 13 部書 |

* `header.tagcount` = `tables/tags.virtual` 的條數，**不等於**各標籤命中數之和
  （13j：5009 vs 4996；yinshun：170428 vs 140693）→ `tags.virtual` 是另一套視圖（待查，見 §13）。
* `檔`（`translatetagname`：FILE）就是「文件／篇」標籤：<br>
  第 n 篇的虛擬範圍 = `[檔命中表[n-1], 檔命中表[n])`（末篇到 `header.maxblockoffset`）。
  檔名可見 §10 的解析順序；**不是**每個庫都有 `檔`（13j、kangxi、說文解字都沒有 → 應輸出單一檔）。
* 標籤名有中英對照表（`basetype.pas: translatetagname`）：`檔=FILE`、`集=COLLECTION`、
  `書=BK`、`頁=PN`、`頁元=PU`、`段=PR`、`樹=TREE`、`隱=HIDE`、`粗=BOLD`、`註=RM`、`釋=RN`、
  `聯=LINK`／`WIDELINK`、`連=SLINK`、`圖=IMAGE`、`嵌圖=EIMAGE`、`圖片=WPIMAGE`、`摘要頭=MERGEHEAD` …
* 標籤成對出現時，命中表同時存在開標籤與閉標籤（實測：`頁` 與 `/頁` 條數相同）。

---

## 10. 屬性與節點值

`attributes` 容器的**塊名 = `<標籤>.<屬性>`**（實測 yinshun：`檔.n`、`集.l`、`樹.s`、`樹.t`；
13j：`樹.s`、`樹.t`、`書.t`、`書.id`）。每個屬性塊又是一個容器：

```
屬性塊（feature = boWithPointer|boUnicode = $40000003）
  資料塊[i] = 屬性值（UTF-16LE，NUL 結尾）
  指標表[i] = 擁有該值的 docnode（tagid<<24 | n）
```

屬性名常數（`basetype.pas`）：

```
t=tree  k=keyword  p=paging  l=leaf  n=name  s=scope  c=command  f=file
o=order  i=linkto  id=id  y=style  pf=prefix  sf=suffix  pw=password  u=url
```

**節點值的解析順序**（`adb.pas: getnNodeValue`，取得檔名／集名時必須照此順序）：

1. `caches[標籤]` 的快取字串（第 i 塊 = 第 i+1 個命中；空字串視為無值）；
2. 屬性 `.<id>`（值首字母轉大寫）；
3. 屬性 `.<n>`；
4. 都沒有時**回讀原文**（註解原文寫 "retrieve from source, Slow!"）：命中的虛擬位址正好指向標籤本身，
   所以可直接讀 `<檔 n="...">` 的 `n` 屬性。

實測：13j/kangxi/shouwen 的 `集` 由 (1) 得到標題（十三經／康熙字典／說文解字）；
yinshun 的 `檔.n` 屬性值是**空字串**（24/16 位元組的 0），必須走 (4) 才拿到 `yinshun.xml, y01.xml …`。

⚠️ 讀取 UTF-16LE 字串時**不能用 `indexOf(0)`**：ASCII 字元的高位位元組就是 0x00
（`<` = `3C 00`），必須找 2 位元組對齊的 `00 00` 才是真正的終止符。

---

## 11. Bun 工具

```bash
cd ts
bun run src/cli.ts analyze <file.adb> [--deep] [--top N] [--json]   # 結構/metainfo
bun run src/cli.ts inspect <file.adb>                               # 容器與行表摘要
bun run src/cli.ts export  <file.adb> -o <dir> [--all] [-j N]       # 匯出 XML（+resources）
bun run src/cli.ts bench   <file.adb> [-j N] [--iters N]            # 吞吐/記憶體
```

`analyze` 輸出（實測）：

**yinshun.adb（23.8 MiB，82 ms）**

```
containers: source 1081 塊/8.2 MiB, tokens 9516 塊/10.2 MiB, tables 5 塊/703 KiB,
            attributes 76 塊/1.2 MiB, attributes.sorted 3 塊/761 KiB, tags 129 塊/257 KiB,
            caches 48 塊/386 KiB, resources 456 塊/2.1 MiB
text       : 1081 塊, 8.2 MiB 壓縮 → 16.9 MiB 文字 (8,847,831 字), 末塊 714 B
tables     : lines.physical 266916 = lines.virtual 266916 = header.linecount
             blocks.virtual 1081, tags.virtual 140693, doclengths 45
tokens     : 9516 個 distinct, 7,256,439 命中 (平均 762)
             unigram: 5712 個 distinct、7,235,148 命中、覆蓋 99.7%
                      [CJK 5501 / ASCII 46 / 數字 9 / 其他 156]
             top: ，485377  的208635  。204939  是118657  一96937
tags       : 129 個 → 段41660 頁16994 /頁16994 聯13920 /聯13920 註11854 釋11853 節1570 經1563
collection : 集 = 1 → 印順法師佛學著作集
documents  : 檔 = 45（檔名：yinshun.xml, y01.xml, y02.xml, …）
resources  : 457 檔 2.1 MiB，其中 456 張 PNG 佔 99.2%，1 個無副檔名 17.2 KiB
```

**13j.adb（2.1 MiB，36 ms）**

```
containers: source 102 塊/877 KiB, tokens 6531 塊/1.2 MiB, tags 17 塊/8.7 KiB,
            tables 5 塊/90.6 KiB, attributes 6 塊/10.8 KiB, caches 5 塊/24.8 KiB（無 resources）
text       : 102 塊, 877 KiB 壓縮 → 1.6 MiB 文字 (831,156 字), 末塊 4568 B
tokens     : 6531 distinct / 800,549 命中；unigram 6526 個 / 800,541 命中 / 覆蓋 100%
             top: ．151563 之23064 也14359 不12038 子12016 以10738
tags       : 節1448 /節1448 頁937 項300 /項300 章259 書13 頁元13 集1
resources  : 0
```

**kangxi.adb（11.2 MiB 字典庫，dbtype=6 = DICTIONARY|HIDDEN，242 ms）**

```
containers: source 632 塊/4.0 MiB, tokens 49691 塊/5.8 MiB, tags 16 塊/301 KiB,
            tables 5 塊/538 KiB, attributes 3 塊/179 B, caches 2 塊/452 KiB,
            resources 1 塊/85.8 KiB (kangxi_logo.png)
text       : 632 塊, 4.0 MiB 壓縮 → 9.9 MiB 文字 (5,173,338 字), 末塊 2361 B
tokens     : 49691 distinct / 3,614,337 命中；unigram 49259 個 / 3,505,693 命中 / 覆蓋 97.0%
             top: 。273455 【216738 】216192 ，179146 韻99127 切71443
             （含羅馬拼音 token：chuang 75、shuang 51、kangxi 1）
tags       : 16 個 → 字46024 /字46024 拼34064 注33924 古1290 樹2 集1
```

字典庫可直接由標籤命中數取得條目數（此例 **`字` = 46024 條**），比遍歷 `<檔>` 標籤更快。

---

## 12. 匯出／轉換建議

1. **行文本**：`getline(i)` 的語義（§7.3）——含行首 CR/LF 跳過、末塊截斷、中間塊到 NUL 為止。
2. **行數**：以 `lines.virtual` 條數為上界（實測等於 `lines.physical`；若不同則以 virtual 為準）。
3. **編碼**：輸出 UTF-8（Delphi 的 `winfo.pas` dump 直接寫 UTF-16LE + `0A 0A 0D 00` 分隔，
   屬調試級格式，不建議沿用）；行分隔用 `\n`。
4. **多檔拆分**：用 `tags` 的 `檔` 命中表取得每篇的虛擬範圍（`[hit[n-1], hit[n])`），
   檔名按 §10 的順序解析（`caches` → `檔.id` → `檔.n` → 標籤原文）；沒有 `檔` 標籤的庫輸出單一檔
   （`<dbname>.xml`）。
5. **resources**：原樣複製（未壓縮），名字即相對路徑（如 `images/mc0198.png`）。
6. **碼元語義**：以 `--text delphi`（預設）與 Accelon3 一致（保留 BOM、不拆代理對）；
   需要與 adbjs 逐位元組比對時用 `--text adbjs`（見 §7.4 的驗證表）。
7. **Bun 已實作**：`exportAdb(..., { text: 'delphi' | 'adbjs' })`；`LineSplitter` 的
   `stripNul` / `skipCrLf` / `keepBom` 三個開關對應上表；`decodeChunk` 的 `model` 決定佈局。
   驗證入口：`bun run test/verify.ts`（12 項，含兩種模式的黃金雜湊與執行緒數無關性）。

---

## 13. 未解 / 待查

1. `caches` 的鍵在部分庫是**標籤名**（yinshun 的 `集`、kangxi 的 `字`），在 yinshun 又以**單字**
   （Ａ/一/乙/丁…）出現 → 兩種用途並存，未完全釐清。
2. `topics` 容器的內部結構（多數庫沒有）。
3. `doclengths` 的語義（yinshun 45 條、13j 1 條、kangxi 26 條）。
4. `tags.virtual` 的條數（= `header.tagcount`）小於各標籤命中數之和（13j 差 13、yinshun 差 29735）
   → 兩者的關係待查。
5. `features=1/2`（強制簡體、自訂轉換）的具體轉換規則。
6. `protection`（USB 序號 / DRM）的檢查流程已被註解停用；密碼 `pw` 的作用未查。
7. 虛擬位址 ↔ 物理位址的完整映射（`toPhysical` / `getPA` / tokenizer 的 `skiptokens`），
   本文只用到「標籤命中的 VA 指向標籤起點」這一性質。
8. 里程碑表 `(value, Count)` 的讀取優化路徑（`goMileStone` / `MilestonebyOffset`）語義。

---

## 14. 語料掃描（實測證據）

`D:\accelon3` 全部 93 個 `.adb`（含 24 個字典庫）以 Bun 分析器全量掃描：

```bash
cd ts
bun run tools/scan-corpus.ts D:\accelon3     # -> build/corpus-scan.tsv（每庫一列）
bun run tools/corpus-summary.ts              # 彙總 + markdown 表格
```

| 指標 | 數值 |
|---|---:|
| 資料庫數 / 總大小 | 93 / **11.24 GiB** |
| 文字總量 | **4,714,981,075 字**（4.71 G） |
| 行數 | 173,213,108 |
| source 塊數 | 575,604 |
| token 索引命中 | 3,620,798,231 |
| unigram 命中 | 3,483,998,059（**96.2%**） |
| distinct unigram（各庫相加） | 1,020,461 |
| distinct dbname | 72（語料中有重複副本） |
| 字典庫（`dbtype & 2`） | 24 |
| 含 `檔` 標籤的庫 / 文件總數 | 62 / 1,062 |
| 含 resources 圖片的庫 | 43（95,360 張圖，0.74 GiB） |
| resources 總數 | 95,404 |
| 分析錯誤 | 0 |
| 分析耗時 | 37.4 s（≈ 300 MiB/s of .adb） |

最大的庫（`dbtype`、字形與行數對照）：

| MiB | 字數 | 行數 | unigram 數 | 檔 | 名稱 |
|---:|---:|---:|---:|---:|---|
| 664 | 217,101,859 | 11,119,147 | 21,978 | 1 | 四庫全書集部 |
| 615 | 231,530,120 | 9,329,997 | 23,930 | 1 | 四庫全書子部 |
| 589 | 307,513,885 | 7,126,311 | 9,345 | 0 | 中華民國法規(專業) |
| 452 | 173,126,151 | 4,909,122 | 12,004 | 0 | 宗教學研究論文 |
| 386 | 152,567,471 | 6,490,439 | 21,364 | 1 | 四庫全書史部 |
| 338 | 129,740,847 | 4,742,351 | 13,886 | 0 | 中醫笈成 |

字典庫（前 4 名）：

| MiB | 字數 | unigram 數 | 檔 | 圖片 | 名稱 |
|---:|---:|---:|---:|---:|---|
| 262.4 | 2,962,113 | 4,246 | 1 | 45,004 | 二南堂 |
| 200.3 | 118,572,445 | 22,390 | 0 | 0 | 維基百科 |
| 156.6 | 74,789,896 | 13,321 | 0 | 0 | 漢語大詞典 v3 |
| 151.5 | 63,857,621 | 13,285 | 1 | 511 | 漢語大詞典 |

完整逐庫資料（93 列 × 24 欄）在 `build/corpus-scan.tsv`。

---

## 15. 反向索引的複刻與驗證（TypeScript 對 Delphi）

用 TypeScript 重新實作 `index.pas: TIndexer` 的建索引流程，對 `yinshun.adb` 重建
`tokens` 容器（token → 虛擬位址列表），並與 adb 內建索引做逐 token、逐位置比對。

```bash
cd ts
bun run tools/compare-index.ts D:\accelon3\yinshun\yinshun.adb --json ../build/index-yinshun.json
bun run test/index-match.ts        # 認證測試（沒有該 adb 時自動 skip）
```

### 15.1 分詞規則（`tokenize.pas: TTokenizer.nextLiteral`）

| 輸入 | 產生的 token |
|---|---|
| 空白（`c <= 0x20`，或 `0xF0B..0xF11`） | 一整段連續空白算**一個** token（消耗 1 VA，不入索引） |
| `<...>` / `"..."` / `'...'` / `&...;` | 成對讀取（`<`→`>`、`&`→`;`、`{`→`}`、`[`→`]`、`(`→`)`）；找不到配對時只取首字元 |
| 西文字母開頭 | 連續 `isAlpha`/數字；`isAlpha` = A–Z/a–z **或** `dia[c] ≠ c`（可由重音表轉換） |
| 數字開頭 | 連續數字與 `.` |
| 藏文（`pp` 落在 `0xF00..0xFFF`） | 連續藏文字母（`0xF0D..0xF11` 標點斷開） |
| 其他西文字元（非字母/數字） | 單字元 |
| CJK（`0x3400..0x9FF0` 等範圍） | **每個字一個 token** |
| 代理對（`0xD840..0xDBFF` 開頭） | 取 **2 個碼元**（astral 字元為一個 token） |
| IDC（`0x2FF0..0x2FFF`） | `parseids`：以括號平衡計數持續讀取（如 `⿰具阝` 三碼元成一個 token） |

之後每個 token 經 `diacritic.normalize`（首字元 > U+1FFF 則原樣返回，否則逐碼元查 `dia[]` 並轉小寫；
`dia[]` 由 `tools/gen-dia.ts` 從 Pascal 生成，903 項非恆等映射）。

### 15.2 虛擬位址（VA）算術（`index.pas`）

```
addtoken     hits.add(voff); inc(voff)             每個索引 token +1
空白 token    if not ignoreBlank then inc(voff)      每個空白 token +1（非每字元）
dotag        TagsVirtualAddress.add(voff)            每個「有效」標籤實例記一筆
             (putindex) taghits.add(voff)
             if not tag.skip then inc(voff, 4)       TAGLENGTH = 4
每行         linesPhysical.add(累計位元組); linesVirtual.add(voff-1)
每塊         blocksVirtual.add(進入新 source 塊時的 voff)
收尾         header.maxblockoffset := voff
```

實測算術（yinshun）：`7,256,439 (tokens) + 84,451 (blanks) + 4 × 84,005 (非 skip 標籤) = 7,676,910`
= `header.maxblockoffset` ✓

### 15.3 兩個容易漏掉的細節

1. **`trim()` 是 TNT 的 Unicode 版**：`index.pas` 的 uses 順序 `sysutils, tntsysutils, ...` 讓後者優先，
   所以 `if trim(token)<>''` 用的是 `TntSysUtils.Trim`（依 `cUnicodeChar.pas` 的
   `IsWhiteSpace` / `IsControl` / `IsIgnorable`）。這使 **U+3000（表意空格）與
   U+206B/206D/206E（不可見運算子）** 的 token 被判定為空白 → 消耗 1 VA 但不寫入索引
   （yinshun 有 64,878 個 U+3000；若用 SysUtils.Trim 會多出 64,881 個命中）。
2. **Trim 必須按碼點掃描**：按碼元會把代理對（astral CJK，如 U+25ECA）誤判為 `Cs` 可忽略字元而刪除；
   yinshun 有 35 個這樣的字被索引，必須保留。

### 15.4 驗證結果（`yinshun.adb`，23.8 MiB，266,916 行）

| 檢查 | 結果 |
|---|---|
| `header.maxblockoffset` | 7,676,910 = 7,676,910 ✓ |
| `header.tagcount` | 140,693 = 140,693 ✓ |
| `tokens` 容器：key 集合 | 9,516 = 9,516 ✓ |
| `tokens` 容器：命中總數 | 7,256,439 = 7,256,439 ✓ |
| **每個 token 的位址列表** | **逐位置完全相同（9,516/9,516）** ✓ |
| `tables/tags.virtual` (140,693)、`blocks.virtual` (1,081)、`lines.physical`/`lines.virtual` (266,916)、`doclengths` (45) | 逐值完全相同 ✓ |
| `tags` 容器（附帶） | 差 `tfDontCare` 自閉合標籤的 `/x` 額外命中（29,735 筆）：該格式來自建庫時的**標籤定義檔**，adb 內沒有存，故列為已知外部輸入 |

TS 產生的索引以 JSON 輸出（`build/index-yinshun.json`，約 56 MiB：token → 位址陣列 + 標籤 + 統計）。

### 15.5 只比漢字（跨 tokenizer 版本的比對方式）

不同年份建置的 adb 可能用不同版本的 tokenizer／設定（標點是否入索引、空白政策、`dia[]` 表版本），
絕對虛擬位址因此會整體偏移。此時改用**順序比對、忽略位址、只取含漢字的 token**：

```
bun run tools/compare-index.ts <adb>      # 輸出末段 "Han token sequence ..." 一行
```

| 資料庫 | 漢字 token 序列 | 完整 token 索引（逐位置） |
|---|---|---|
| yinshun.adb | ✅ 相同（5,859,438 個） | ✅ 完全一致（免參數） |
| 13j.adb | ✅ 相同（641,576 個） | ✅ 完全一致（需 `--drop-punct "().,"`） |
| kangxi.adb | ✅ 相同（2,375,181 個） | ❌ 系統性偏移（見 §15.6） |

漢字判定範圍：U+3400–4DBF、U+4E00–9FFF、U+F900–FAFF、U+20000–2FA1F，另加 `々`(3005) `〇`(3007)。

### 15.6 kangxi.adb 為何只有漢字層級能對上

- 該庫**索引了 U+3000**（yinshun 不索引），且用了**不同的 `dia[]` 表**（把 `ˇ ˊ ˋ` 等聲調符號
  映射掉，本版原始碼不映射）。
- 標籤的 `skip`（是否 `inc(voff,4)`）判定不同 → `maxblockoffset` 相差 17,058
  （我的 4,904,271 vs adb 4,887,213），`tags.virtual` 從第 33 筆起偏 2、`blocks.virtual` 第 1 筆偏 10。
- 因此 token 命中數差 12,678、位置全數偏移；但**漢字序列完全一致**，說明分詞與漢字處理本身沒錯，
  差異全在「建庫政策 + 標籤定義」，那些不在 adb 內（需原始 docdef）。

---

## 16. Indexer 的 XML 語法錯誤訊息與容忍度

`indexer.dpr` 只是 GUI 啟動器（`windex.pas` + `index.pas` + `verify.pas`）；標籤／XML 的檢查全部在
`TIndexer.dotag` → `TDocDef.Validate`（`document.pas:276`）。所有訊息都經 `index.pas:1200 printerr`
加上定位後輸出：

```
printlog(ffilename+'('+inttostr(lineindex+1)+'): '+s);    // 檔名(行號): 訊息
```

| # | 訊息 | 條件 | 後果 |
|---|---|---|---|
| 1 | `Undefine tag  <x>` | 標籤名不在定義中（且 `allowUndefTag=false`） | 該標籤**整個跳過**：不進 `tags.virtual`、不佔 VA，但文字仍保留該標籤 |
| 2 | `invalid Single Tag x` | `tfSingle` 的標籤寫成 `<x>` 或 `</x>` | 同上（回傳 false） |
| 3 | `invalid Pair Tag x` | `tfPair` 的標籤寫成自閉合 `<x/>` | 同上 |
| 4 | `x missing close tag!` | 同名標籤已 `opened` 又遇到開標籤 | 僅警告，索引照做 |
| 5 | `x missing open tag!` | 遇到 `</x>` 但同名標籤未 opened | 僅警告 |
| 6 | `Undefine attribute a for <x>` | 屬性未在定義中（且 `allowUndefAttribute=false`） | 標籤跳過 |
| 7 | `Null value of attribute a for <x>` | 屬性值為空（且 `allowNullAttribute=false`） | 標籤跳過 |
| 8 | `duplicate attribute:<tag>` | 同一標籤出現同名屬性（`tokenize.pas:661`） | 重複者忽略 |
| 9 | `too many attributes:<tag>` | 屬性數 > `MAXATTRIBUTE=12`（`tokenize.pas:668`） | 其後屬性不再解析 |
| 10 | `invalid tag:<tag>` | `validate` 回傳 false（`index.pas:880`） | 標籤跳過（#1/#2/#3/#6/#7 之後的統一訊息） |
| 11 | `error token <` / `>` / `&` | `addtoken` 拒絕裸的 `<`、`>`、`&`（`index.pas:651`） | 該 token **不佔 VA** → 之後所有位置少 1 |
| 12 | `exceed line length` | 單行 > `MAXLINELEN=8192` 位元組（`index.pas:777`） | **來源文字被截斷**（索引仍依整行建立）→ 匯出文字會少掉該行尾段 |
| 13 | `previously defined tag without cached setting:x` | 定義衝突（`index.pas:1001`） | 警告 |
| 14 | `error` | `srcpack.getPA`：標籤的實體區塊超出該行（`srcpack.pas:361`） | 內部映射不一致 |
| 15 | `no block!` | 寫入時沒有任何資料塊（`rombuilder.pas:142`） | 產生空的容器 |
| 16 | `Err:…` / `invalid command:…` | 定義語言（`command.pas:151/250`）解析失敗 | 定義被忽略 |
| 17 | `assert('no Tag defined')` | 定義檔中沒有 `TAG` 命令（`document.pas:106`） | **例外中斷** |
| 18 | `assert('Too many different types of tags')` | 不同標籤名 > 255（`TDocNode` 的 tag id 只有 8 位元） | **例外中斷** |

**檢查不到的情形**（想找出 adb 的 XML 問題時要另外處理）：

* **跨名嵌套錯誤**（`<a><b></a></b>`）：`Validate` 只用 `tag.desc.opened` 追蹤**同名**開合，
  沒有堆疊，所以不同名標籤交錯不會報錯。
* **文字中的 `<` 與 `&`**：只有當它剛好被切成裸 token（#11）才會報錯；`<` 後面有 `>` 就會被當成標籤。
* 非法 XML 字元（控制字元）、`]]>`、BOM 等一律不檢查。
* 匯出端不做修補：`tokenize.pas: makeValidXML`（補上缺漏開合標籤）只被 `formatter.pas:512` 的
  檢視器使用，**索引與匯出路徑都不會呼叫它** → 來源不平衡的標籤會原樣帶進匯出的 XML。

**實務上如何用 adb 反查 XML 問題**（不需要原始 docdef）：

1. 比較「文字中的標籤實例數」與 `tables/tags.virtual` 的條數：不相等代表有標籤在 build 時被判無效
   （#1–#7）而被跳過。13j／yinshun 兩者相等、`invalidTags=0` ✓。
2. 比較 `tags` 容器中 `x` 與 `/x` 的清單長度：相差過大代表開合不平衡（`tfDontCare` 標籤本來就會差，
   需先扣除）。
3. 掃描文字中的裸 `<`（後面沒有對應 `>`）與 `&`（沒有 `;`）：這些是 #11 的候選，會讓 VA 少一格。

### 16.1 `xml-lint` 工具（實作上面三點 + 標籤堆疊檢查）

```bash
cd ts
bun run tools/xml-lint.ts <file.adb | 目錄> [--max N] [--json]     # --json -> build/xml-lint.json
```

檢查項與輸出格式：

| kind | 意義 |
|---|---|
| `mismatch` | `</x>` 沒有對應開標籤，或關閉的標籤與堆疊頂端不同名（附開標籤行號） |
| `unclosed` | 檔尾仍未關閉的標籤（附開標籤行號） |
| `file-boundary` | 遇到新的 `檔` 時，仍有非 `檔` 的標籤未關閉 → 拆出的每個檔各自不合法 |
| `separator` | `檔` 被當成「不閉合的文件分隔標籤」使用（yinshun 即如此）→ 每個匯出檔都會帶一個未閉合的 `<檔>` |
| `entity` | 文字中有裸的 `&`（不是 `&amp;`／`&#...;` 形式） |
| `unterminated` | `<` 之後找不到 `>`（下一個 `<` 先出現） |
| `attribute` | 屬性沒有值或值沒有加引號 |
| `undeclared` | 標籤名不在 `tags` 容器（＝build 時的宣告集）中：索引器當時報 `Undefine tag`／`invalid tag` 並跳過它 |

`tags.virtual=N tagInstances=M` 是第 1 點的即時對帳（相等代表沒有標籤在 build 時被丟棄）。

實測：**13j.adb 完全乾淨**（42,173 行、4,996 個標籤、`tags.virtual` 對帳相等、無任何 issue）；
**yinshun.adb 只有 `separator`**（46 個 `<檔>` 從不閉合，屬格式用法，但匯出的 XML 需自行補上收尾標籤）。

---

## 17. Extractor / Indexer 管線（Bun）與驗證狀態

### 17.1 流程與工具

    adb --extract--> XML（完全合法）+ resources/ + manifest.json --rebuild--> 新 adb
                                                                            |
                                                        compare-adb <-------+

| 工具 | 作用 |
|---|---|
| `tools/extract.ts` | adb -> 每個 檔 一個合法 XML + `resources/**`（圖片原樣位元組）+ `manifest.json`（原始 header base64、容器名稱/順序、`cachedTags`、`tagKeys`、`dualClosing`、`singleCharTokens`、修復統計與 sha256） |
| `tools/rebuild-adb.ts` | XML + manifest -> 新 adb（**不需要原檔**）；`--from` 可提供原檔作參照，`--infer` 自動推斷建庫參數 |
| `tools/compare-adb.ts` | 逐容器、逐區塊（按名稱配對）比對；區分「必須相同」（source/resources/attributes/caches/tables/文字）與「允許不同」（tokens/tags 的 postings） |
| `tools/xml-lint.ts` | 掃描 adb 的 XML 結構問題（標籤堆疊、裸 `&`、未閉合、未宣告標籤、`tags.virtual` 對帳） |

### 17.2 已驗證結果

| 庫 | XML 合法性（Python expat） | 獨立建庫（只給 XML） |
|---|---|---|
| 13j.adb | 1/1 | **逐位元組相同（SHA-256 一致）**：source 102/102、tokens 6531/6531、tags 17/17、tables 5/5、attributes 6/6、caches 5/5、文字 0.8 M 碼元 |
| yinshun.adb | 45/45（109,024 元素） | 11 個容器 10 個位元組相同（source 1081/1081、tokens 9516/9516、tables 5/5、attributes 76/76、attributes.sorted 3/3、resources 456/456、文字 8.4 M 碼元）；caches 48 鍵中 2 鍵（序、圖）不同；tags 的 /圖 差 3 筆（目標允許） |
| DFB_J / boyang / kangxizidian | 1/1、1/1、2/2 | resources/attributes/caches 位元組相同；source/tokens 因刻意的 XML 合法化修復而不同 |

### 17.3 已釘死的建庫規則（實作依據）

* 虛擬位址：索引 token +1、空白 token +1、非 skip 標籤 +4；`header.maxblockoffset := voff`
* 分詞：CJK 逐字、代理對取 2 碼元、IDC 用 `parseids`、`<...>`/`"..."`/`&...;` 成對
* 文字語義：固定步長網格 + 每塊 NUL 結尾（`srcpack.pas`）；行首 CR/LF 跳過
* 容器：變長塊 = 16B 標頭 + 資料 + TPackedList(累計長度)（+ `boWithPointer` 指標表）；名稱塊為最後一個資料塊（UTF-16LE + NUL）
* `TPackedList`：`u32 added | floor(added/512)*8 (milestone value,Count) | varints`（非 LEB128；milestone 於跨越 512-byte 邊界時寫入）
* header CRC-32：初值 `CRC_MAGIC=$55AA55AA`、反射式多項式 `$EDB88320`、欄位在 offset 252 且覆蓋前 252 位元組
* 排序：`tokens`/`tables` 名稱按 UTF-16 碼元升序；`tags` 首次出現順序；`attributes.sorted` 內層值用 Delphi 不穩定 quicksort（平手順序已重現）
* 屬性：key = `<tag>.<attr>`、空值不存、`i`（linkto）在 `#` 截斷、docnode = `(tagid<<24)|n`，`tagid` = 標籤在 `tags` 容器的區塊索引
* caches：`cached` 且非 `tfSingle` 的標籤；open 起累積原始 token（含空白）、close 時存 `trimcacheline` 結果（去標籤、於 CR/；/。 截斷接 …、trim）、`tkBoth` 存空字串；docnode 用加入本實例之前的計數；`MAXCACHELINE=256`

### 17.4 已知限制（尚未完全對上者）

1. **caches 動態宣告時機**：`cached` 旗標可在 build 中由 `t=`/`s=` 屬性動態加註（`index.pas:1006` -> `CreateChildTag(value,' cached')` -> `docdef.eval('TAG x cached')`）。目前以「原檔 caches 容器名稱」為初始集合，導致 yinshun 的 序（多 1 筆）與 圖（多 3 筆）不同；`t=` 的生效時機/範圍（是否追溯）尚未確定。
2. **per-tag `tfDontCare`**：自閉合標籤是否同時寫入 `/x`（雙索引）依建庫定義檔；已由「原檔是否有 `/x` 鍵」逐標籤判斷，yinshun 的 `/圖` 仍有 3 筆差異（目標允許）。
3. **Pascal 行尾越界讀**：`nextLiteral` 在行尾未閉合 `<` 時會讀進下一行緩衝區；我採規範版本，故部分 token 命中數略少（DFB_J 少 56）。
4. **合法化修復不可逆**：抽取器會刪除 C0 控制字元、逃脫裸 `&`/`<`、補缺漏收尾標籤 -> 這些庫的文字與原檔不同（目標允許，但 block 內容因此不同）。

### 17.5 未在本機驗證者

最終「Delphi 舊程式可讀」需以實機 EXE 開啟新 adb 確認；本機只有原始碼、沒有編譯檔。最接近的證據是 13j 逐位元組相同（原檔由 Delphi 寫出，位元組相同即讀取行為等價）。