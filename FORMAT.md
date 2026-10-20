# The Accelon3 `.adb` container format

Reverse engineered from [accelon/adbjs](https://github.com/accelon/adbjs) (`src/header.js`,
`src/romblock.js`, `src/list.js`, `src/adb.js`, `src/dump.js`), which in turn is a port of the
original Delphi source (`accelon3\basetype.pas`), and **verified byte for byte** against the
reference decoder on real data (see [Verification](#verification)).

All integers are **little endian**. `.adb` files are a random access container: nothing needs to
be loaded into memory to find a block, which is what makes multi GB files practical.

```
offset 0    256 bytes   file header
offset 256  16 bytes    top level ROMBlocks header
offset 272  ...         data blocks: source, tokens, tags, tables, attributes, caches
            ...         block name table (last data block, when feature & BO_NAMED)
            ...         packed length list
```

## 1. File header (256 bytes)

| offset | size | type | field | 13j.adb |
|-------:|-----:|------|-------|---------|
| 0 | 32 | ascii, NUL padded | `dbname` | `13j` |
| 32 | 48 | ascii | `signature` = `\r\nAccelon Search Engine\r\ndesigned by C.S.Yap` | same |
| 80 | 4 | u32 | `textterminator` (constant `0x1A1A1A1A`, unused by readers) | `0x1A1A1A1A` |
| 84 | 4 | i32 | `version` | 0 |
| 88 | 4 | i32 | `compression` — `1` = source blocks are bzip2 streams | 1 |
| 92 | 4 | i32 | `srcblocksize` — **decompressed** size of a source block | 16384 |
| 96 | 4 | i32 | `maxblockoffset` | 818554 |
| 100 | 4 | i32 | `andtagid` | 10 |
| 104 | 4 | i32 | `linecount` — number of entries in `lines.physical` | 42173 |
| 108 | 4 | i32 | `dbtype` — bit 1 (`2`) marks a dictionary | 0 |
| 112 | 4 | i32 | `protection` | 0 |
| 116 | 4 | i32 | `tagcount` | 4996 |
| 120 | 4 | i32 | `features` — `1` = auto simplified/traditional conversion | 0 |
| 124 | 4 | i32 | reserved | 0 |
| 128 | 64 | utf-16le, NUL padded | `dbcname` — display name | `十三經` |
| 192 | 16 | ascii | `serial` | empty |
| 208 | 20 | ascii | `pw` | empty |
| 228 | 23 | — | reserved, skipped by readers | — |
| 251 | 4 | u32 | `crc32` (read by the reference, never verified) | 505720320 |
| 255 | 1 | — | padding | — |

The 48 byte `signature` is the only format check available.

`dbname` is used for the default output file name; nothing else is needed to locate the text.

## 2. ROMBlocks containers

A container is a self describing array of byte blocks:

```
u32 feature        flags, see below
i32 signature      usually 0
u32 totalblocksize size of the data region (NOT including this header, NOT the length list)
i32 blocksize      0 = variable length blocks (a packed length list follows the data)
                   >0 = every data block is exactly this many bytes
--- data region, totalblocksize bytes ---
[packed length list]                (only when blocksize == 0)
```

`feature` flags:

| flag | meaning |
|------|---------|
| `0x40000000` | `boWithPointer` — a pointer table follows (unused by the reference) |
| `0x20000000` | `boSorted` |
| `0x10000000` | `boNamed` — the **last** data block holds the block name table |
| low 3 bits | format: 0 undefined, 1 hits, 2 ascii, 3 unicode, 4 blocks |

Observed: top level `0x10000000` (named), `source` container `0x00000000`, `tables` container
`0x10000001` (named + hits).

### Block addressing

The length list holds **cumulative END offsets** of the data blocks, so block `i` occupies
`data[ list[i-1] : list[i] ]` (`list[-1] == 0`). Offsets are relative to the start of the data
region. Because end offsets of whole sub containers are also what the parent stores, a sub
container that starts at file offset `X` ends the parent entry at `X + 16 + totalblocksize + listlen`.

Worked example (13j.adb): `source` data region = 897698 bytes, its length list = 208 bytes, so the
top level entry for `source` is `16 + 897698 + 208 = 897922`, and `tokens` starts at `272 + 897922
= 898194`.

### Block name table

When `boNamed` is set, the last data block is itself a complete ROMBlocks container (header, data,
length list) whose data blocks are UTF-16LE strings **with a trailing NUL that is not part of the
name** (the reference decodes `len - 2` bytes). `count` of the parent excludes this block.

13j.adb names: `source, tokens, tags, tables, attributes, caches`;
inside `tables`: `blocks.virtual, doclengths, lines.physical, lines.virtual, tags.virtual`.

## 3. The packed length list

```
u32 added                    size in bytes of the varint payload below
(added / 512) * 8 bytes      milestone table, one 8 byte entry per 512 payload bytes
added bytes                  varints
total size = 4 + floor(added/512)*8 + added
```

The milestone table is skipped by every known reader; its contents were not reverse engineered.
The varints, however, are **not standard LEB128**:

> The **low** 7 bit group comes first and its high bit is **clear**; every following higher group
> has its high bit **set**. A value ends when the next byte has a clear high bit — which is the
> first byte of the next value.

Standard LEB128(7807) is `ff 3d`; accelon3 stores `7f bc` (`0x7f + (0x3c << 7) = 7807`).

Values are deltas: `value[i] = value[i-1] + delta[i]`, i.e. the decoded list is a cumulative
offset table. A reference decoder that instead reads LEB128 silently produces wrong offsets, so
this detail matters for any reimplementation.

## 4. Where the text lives

* **`source` container** — every data block is an **independent bzip2 stream** whose decompressed
  size is `srcblocksize` (the last block is usually shorter). The blocks are stored back to back,
  so the whole container data region is also a valid *multi stream* bzip2 file and can be fed to
  `bzip2 -dc` in one go (verified: identical output). Decompressed content is **UTF-16LE** text.
* **`tables / lines.physical`** — a packed list of the **END offsets of every line**, in bytes into
  the concatenated UTF-16LE text of all source blocks. `>> 1` gives the UTF-16 code unit index,
  which is the offset used by JavaScript strings.
* **`tables / lines.virtual`** — the VA of each line, but it is the VA of the line's **last unit**
  (an *inclusive* end), not of the element that follows it: on 13j line 0 (`<集>十三經</集>`) stores
  10 while `<集>` costs 4 + three characters + a 4-unit closer, i.e. the next element `<隱>` sits at
  VA 11. So line *i* starts at `lines.virtual[i-1] + 1` (line 0 at 0). Getting this off by one
  shifts every element in the database by one VA unit (measured; see `ts/tools/check-element.ts`).
* Lines do **not** respect block boundaries (13j.adb: only 13 of 42173 line ends coincide with a
  block boundary), so line splitting must run on the reassembled stream.
* **`resources` container** (when present) — payloads stored **uncompressed**, one per file, with
  names from the block name table. The reference copies them out verbatim.
* `tokens`, `tags`, `attributes`, `caches`, `blocks.virtual`, `doclengths`, `lines.virtual`,
  `tags.virtual` are the search/annotation indexes of Accelon3. **Their internal structure has not
  been reverse engineered** — the reference exporter ignores them, and so does `abx`.

## 5. Text reconstruction and export semantics

The reference (`openADB.getXML`) does:

```
alltext = concat( bzip2_decode(source[i]) for i in 0..n-1 )   // then decoded as UTF-16LE
lines   = [ alltext[ end[i-1]>>1 : end[i]>>1 ] for i in 0..linecount-1 ]   // end[-1] = 0
xml     = lines.join('\n')
```

Notes and edge cases that `abx` reproduces deliberately:

* text past the last line offset is **dropped** by the reference (13j.adb has none: text length is
  exactly `end[last] = 1662312` bytes);
* the XML is written as **UTF-8 with no BOM and no XML declaration**;
* `dumpXML` then splits the XML text on every `<檔` (file) tag: the tag starts the next document,
  the file name comes from `n="..."` inside the following 200 characters, and the fallback name is
  `<dbname>.<index>.xml`. If more than one file is produced, a `<dbname>.lst` index containing the
  file names joined by `\n` is added.
* `dumpAll` additionally writes every `resources` block.

## 6. Verification

| check | result |
|-------|--------|
| 13j.adb through the reference decoder (`dumpXML`) vs `abx` | identical SHA-256 `d0a82266bc35c58e1c6ac896132ca5a1f6903dffce95c7b872eaac343a38a74d`, 2 484 602 bytes |
| per block bzip2 vs whole region multi stream decode | identical SHA-256 `446f0e5bb6c3a7ecfb468a97680c8c0a7e3fdf8a7df736faef0ff6076b3c931f`, 1 662 312 bytes |
| synthetic 3 × 13j container vs 3 copies of the reference XML | identical SHA-256 `4fcc896f50c58ea6d8f10e5e4da432c5173d3944f1150f838c8dc67abed7767c`, 7 453 808 bytes (also with 4 and 14 decode threads) |
| `linecount` vs `lines.physical` entries | 42173 = 42173 |

## 7. Open questions

1. **Milestone table semantics** — structure verified, contents unknown.
2. **`dbtype` dictionary databases** — code paths exist for `<檔>` splitting and were implemented
   from the reference, but no dictionary `.adb` sample was available to test against.
3. **`tokens` / `tags` / `attributes` / `caches`** — index structures, not decoded.
4. **`protection` / `pw`** — content protection is not handled at all.
5. **`features == 1`** (automatic simplified/traditional conversion) — ignored.
6. **Fixed size containers** (`blocksize > 0`) — supported in the reader, never observed in the wild.
7. **`maxblockoffset`, `andtagid`, `tagcount`** — semantics unclear, unused by the exporter.
8. **`crc32`** — algorithm and coverage unknown, never verified by the reference.
