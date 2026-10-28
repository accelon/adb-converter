# Accelon3 解码实现：读 Pascal 源码的权威结论

读码顺序：`accelon3.dpr`（工程/单元清单）→ `basetype.pas`（头部与常量）→ `romblock.pas`（容器）
→ `lists.pas`（TPackedList）→ `srcpack.pas`（文本块/行/解码）→ `winfo.pas`（Delphi 端的 XML dump）
→ `exporter.pas`、`converter\convert_to_xml.pas`（后者只是插件管理器，与 adb 无关）。

源码为 Delphi 7（ANSI/Big5），UTF-8 转码副本在 `build\pas\`（由 `sourcecode\` 生成）。

## 1. 文件头（`basetype.pas: TDbHeader`）

```pascal
dbname:array[0..31] of char;  signature:array[0..47] of char;
textterminator, version, compression, srcblocksize, maxblockoffset,
andtagid, linecount, dbtype, protection, tagcount, features, reserved2 : integer;
dbcname:array[0..30] of widechar; dbcname_terminator:widechar;   // $80
serial:array[0..15] of char;  pw:array[0..19] of byte;
reserved:array[0..255-32-48-4*13-64-16-20] of byte;             // 23 字节
crc32:cardinal;
```

* 注释里的锚点：`dbtype` 在 `$6C`、`protection` 在 `$70`、`dbcname` 在 `$80`、`crc32` 在 251 —— 与本仓库
  `FORMAT.md` 里逆向出的偏移**逐字节一致**（记录本身 255 字节，.adb 头部 256，末字节填充）。
* 常量（`basetype.pas:189`）：`NO_COMPRESSION=0`、`COMPRESSION_BZIP2=1`；
  `DBTYPE_IGNOREBLANK=1 / DBTYPE_DICTIONARY=2 / DBTYPE_HIDDEN=4`（dbtype 是位掩码）；
  `FEATURE_FORCE_SIMPLIFIED=1`、`FEATURE_CUSTOM_CONV=2`。
* `maxblockoffset` = 虚拟地址总长 + 1（yinshun: VA 末值 7676909 → 7676910 ✓；kangxi 4887212 → 4887213 ✓）。

## 2. 容器（`romblock.pas` / `lists.pas`）

```pascal
TROMBlocksHeader = record feature:cardinal; signature,totalblocksize,blocksize:integer end;
// get(i): blocksize>0 → [i*blocksize, +blocksize)
//         else          → [flengths[i], flengths[i+1])
// loadAt: 数据区 → packedlist → (boWithPointer 时) 指针表 → boNamed 时最后一个数据块是名字块
```

* `boNamed=$10000000`，名字块是**最后一个数据块**，读取后 `dec(fcount)` ✓ 与本仓库实现一致。
* `flengths[i]` 走 `TPackedList` 的默认属性 `getdata(i)`，其语义是：**i=0 返回 0，i≥1 返回第 i-1 个存储值**
  （`lists.pas:1029` 的 `if curcount>=i then break`）。所以 `blocks[i] = [ends[i-1], ends[i])`，
  正好等于“存储值就是各块累积结束偏移”这一实现 ✓（本仓库 `format.ts` / `format.go` 即如此）。
* packed list 权威定义（`lists.pas`）：
  * `MASK_LEADBYTE=$0`、`MASK_FOLLOWBYTE=$80`、`MileDistance=512`、`TMileStone=(value,Count)` 8 字节；
  * 布局 `added:u32 | nMileStone*8 | added 字节 varint`，`nMileStone = added div 512`，`SerializedSize=4+added+nMileStone*8`；
  * `next()`：**每个字节都累加**（含高 bit 清零的终止字节），依据*下一个*字节的高 bit 决定是否继续 ——
    与 `FORMAT.md` 里“不是标准 LEB128”的记录完全一致，也与两个实现一致 ✓。
  * 里程碑 `(value,Count)` = 该处绝对值与条目序号；读取时会跳过，不参与解码。

## 3. 文本块与行（`srcpack.pas`）

```pascal
function TSrcUnPacker.getblock(blockid): TMemoryStream;      // 每块一个独立 bzip2 流
  decompressed.SetSize(header.srcblocksize+4);
  Count := DecompressionStream.read(pbuf^, decompressed.size);
  inc(pbuf,count); pinteger(pbuf)^:=0;                       // 4 字节 0 结尾

function TSrcUnPacker.getline(i) = getrange_physical(PALines[i], PALines[i+1]);

function getrange_physical(s,e): widestring;
  blk1 := s div header.srcblocksize;  blk2 := e div header.srcblocksize;   // 字节寻址
  for i:=blk1 to blk2 do begin
    p := pwidechar(getblock(i).memory);
    if i=blk2 then pend := p + (e mod srcblocksize) div 2;  pend^:=#0;     // 末块按行尾截断
    if i=blk1 then begin inc(p,(s mod srcblocksize) div 2);
                        if p^=#13 then inc(p); if p^=#10 then inc(p); end; // 跳过行首 CR/LF
    result := result + widestring(p);                                      // 到本块首个 NUL
  end;
  result := convertcode(result,cc);
```

由此得到若干**权威语义**（此前未实现或实现不同）：

| 项 | 权威语义 |
|---|---|
| `srcblocksize` | 单位是**字节**（=8192 个 UTF-16 码元），物理地址 = `块号*srcblocksize + 块内字节偏移` |
| 每块文本 | 以 `widestring(p)` 取用 → **到本块第一个 NUL 码元为止**（不是“到解压长度为止”） |
| 短块 | 物理地址按**固定步长**推进；若某块解压后不足 `srcblocksize`，后续偏移仍按网格定位（不会整体前移） |
| 行 | 行 i = 物理区间 `[PALines[i], PALines[i+1])`；**行数取 `lines.virtual` 的条数** |
| 行首 | **跳过 CR 再跳过 LF**（最多 2 个码元，仅对整行的起始生效，不对中间块生效） |
| 码元 | Pascal 全程按 widechar 拼接：**不丢 BOM、不拆跨块代理对**（adbjs 的丢 BOM / 拆代理对是 JS 移植副作用） |
| 编码 | `convertcode(result,cc)` 负责 BIG5/GB↔Unicode（cc=CONV_NONE 时不变），与 .adb 内部 UTF-16 存储无关 |

Delphi 端确实有一个“导出 XML”按钮：`winfo.pas:346 Button3Click`，它对 `0..VALines.count-1` 逐行
`getline(i)`，原样写 UTF-16LE，然后写 4 字节常量 `#10#10#13#0`（ANSI 常量 → 实际字节 `0A 0A 0D 00`）。
这是调试级 dump，不是规范；本仓库导出用 UTF-8 + `\n` 分隔更通用。

## 4. yinshun.adb 实测（`D:\accelon3\yinshun\yinshun.adb`，23.76 MiB）

```
dbname=yinshun  dbcname=印順法師佛學著作集  dbtype=0  compression=1  srcblocksize=16384
blocks=1081   lines.physical=266916   lines.virtual=266916   header.linecount=266916
maxblockoffset=7676910   tagcount=140693   resources=457
解压尺寸：仅末块 942 字节，其余全为 16384；无短块、无内嵌 NUL
紧密拼接 vs 固定步长网格切行：结果完全相同（同一 SHA-256）
文字中的 CR / LF / NUL 码元数：0 / 0 / 0（换行完全由行表定义；`getrange_physical`
的 CR/LF 跳过与 NUL 截断在本语料是防御性代码）
流式导出（45 档）与 eager 模型同一 SHA-256：c9ab05bff45e63e5… / 24,011,306 字节
```

## 5. 本仓库实现与权威语义的差异

以下四项**已在 Round 3 全部实现并逐字节验证**（Bun 导出器，`--text delphi` 为默认）：

1. **行首 CR/LF 跳过**：已实现（`LineSplitter.skipCrLf`）。实测本语料 93 个库的 CR/LF 码元数**皆为 0**
   （13j 831,156 字 / yinshun 8,847,831 字 / miuking 20,160,532 字皆为 0），故属防御性语义
   （先前「584 行 / 6612 行」的计数是失效的一次性脚本误报）。
2. **文本语义以 Pascal 为默认**：`--text delphi`（默认；保留每块行首 BOM、不拆跨块代理对）与
   `--text adbjs`（丢 BOM、代理对转 U+FFFD，逐字节等同 JS 移植）。kangxi.adb 上两模式各自对上一份
   独立参考：adbjs 12,904,331 B / `b0566c8b…`，delphi 12,904,294 B / `958ec652…`。
3. **固定步长 + NUL 截断**：已实现（`decodeChunk` 的 `model: 'delphi'` 以 `i*srcblocksize` 布局，
   `LineSplitter.stripNul` 逐块去除 U+0000 padding）。yinshun 45 档流式导出与 eager 模型同一 SHA-256
   （`c9ab05bff45e63e5…`，24,011,306 字节）。
4. **TS/TextDecoder BOM bug**：已修（`keepBom` → `new TextDecoder('utf-16le', { ignoreBOM: true })`）；
   另修「UTF-16 字符串不能用 `indexOf(0)`」——ASCII 高位字节就是 0x00，必须找对齐的 `00 00`。

验证入口：`cd ts && bun run test/verify.ts` → 12 项全过（含两种模式的黄金哈希、线程数无关性）。

## 6. 仍未读的关键单元

* `adb.pas`（47 KB）：头部装载/校验、`loadTag`、`tags.virtual`/`doclengths`、文档（`檔`）枚举、`features` 处理。
* `formatter.pas` / `textview.pas`：标签跨行渲染与 `makevalidxml`（若要做“合法 XML”输出需参考）。
* `codeconv.pas`（113 KB）：`convertcode` 的具体码表（BIG5/GB 库）。
