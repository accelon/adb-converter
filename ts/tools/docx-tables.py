#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
docx 的 `w:tbl` → accelon 的 `<表>`（管線列）。

    python ts/tools/docx-tables.py <file.docx>              # 只列清單（幾張表、幾欄幾列、有沒有合併／圖）
    python ts/tools/docx-tables.py <file.docx> --emit       # 印出 <表> 區塊
    python ts/tools/docx-tables.py <file.docx> --emit -o out.txt --only 3

為什麼要有這支：福嚴的 `docx2accelon.py` 已經會走 `w:tbl`，但輸出是全形 `｜`
的純文字，而且 `--figures` 會先把表格整段換成 SVG。這裡給的是**讀者端
`<表>` 的正式格式**（ASCII `|` 分格），可以直接餵給 `table-block.ts`。

「`<表>` 能表達」的判斷（不能表達就只列進報告，不硬轉）：
  * 沒有巢狀表格
  * 沒有圖片（`w:drawing`／`w:pict`）
  * 欄數一致（`gridSpan` 會補空白格，讓欄數對齊）

合併儲存格：
  * `gridSpan`（橫向）→ 這一列多補幾個空字串，欄數才對得上。
  * `vMerge`（縱向）→ `restart` 保留文字、`continue` 留空（作者 2026-11-06：
    空白格留空）。閱讀器不畫框線跨列，視覺上就是「這一格延伸到下面」。

注意：`<表>` 的每一列＝原始的一行，所以格內不能換行；多段會被接成一行
（段落之間用一個空白）。真要換行就拆成兩列。
"""
from __future__ import annotations

import argparse
import sys
import zipfile
from dataclasses import dataclass, field

try:
    from lxml import etree
except ImportError:  # pragma: no cover
    sys.exit('需要 lxml：pip install lxml')

W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'


def q(tag: str) -> str:
    return W + tag


@dataclass
class Cell:
    text: str
    span: int = 1
    vmerge: str = ''          # '' | 'restart' | 'continue'
    image: bool = False
    nested: bool = False


@dataclass
class Table:
    index: int
    rows: list[list[Cell]] = field(default_factory=list)
    cols: int = 0

    @property
    def has_image(self) -> bool:
        return any(c.image for r in self.rows for c in r)

    @property
    def has_nested(self) -> bool:
        return any(c.nested for r in self.rows for c in r)

    @property
    def vmerges(self) -> int:
        return sum(1 for r in self.rows for c in r if c.vmerge)

    @property
    def spans(self) -> int:
        return sum(1 for r in self.rows for c in r if c.span > 1)

    @property
    def expressible(self) -> bool:
        return not self.has_image and not self.has_nested and self.cols >= 2 and len(self.rows) >= 2


def para_text(p) -> str:
    """一個 `w:p` 的文字：`w:t` 串起來，`w:tab`／`w:br` 當一個空白。"""
    out: list[str] = []
    for node in p.iter():
        tag = node.tag
        if tag == q('t'):
            out.append(node.text or '')
        elif tag == q('tab'):
            out.append('\t')
        elif tag in (q('br'), q('cr')):
            out.append(' ')
        elif tag == q('noBreakHyphen'):
            out.append('-')
    return ''.join(out)


def cell_of(tc) -> Cell:
    cell = Cell(text='')
    tcpr = tc.find(q('tcPr'))
    if tcpr is not None:
        gs = tcpr.find(q('gridSpan'))
        if gs is not None:
            try:
                cell.span = max(1, int(gs.get(q('val'), '1')))
            except ValueError:
                cell.span = 1
        vm = tcpr.find(q('vMerge'))
        if vm is not None:
            cell.vmerge = vm.get(q('val'), 'continue') or 'continue'
    if tc.find('.//' + q('drawing')) is not None or tc.find('.//' + q('pict')) is not None:
        cell.image = True
    if tc.find('.//' + q('tbl')) is not None:
        cell.nested = True
    paras = [para_text(p).strip() for p in tc.findall(q('p'))]
    cell.text = ' '.join([p for p in paras if p])
    return cell


def read_tables(path: str) -> list[Table]:
    with zipfile.ZipFile(path) as z:
        xml = z.read('word/document.xml')
    root = etree.fromstring(xml)
    body = root.find(q('body'))
    tables: list[Table] = []
    if body is None:
        return tables
    # 只取 body 的**頂層**表格（巢狀的由 cell.nested 標記，不另外展開）
    for i, tbl in enumerate(body.findall(q('tbl'))):
        t = Table(index=i + 1)
        for tr in tbl.findall(q('tr')):
            row = [cell_of(tc) for tc in tr.findall(q('tc'))]
            if row:
                t.rows.append(row)
        t.cols = max((sum(c.span for c in r) for r in t.rows), default=0)
        tables.append(t)
    return tables


def esc(text: str) -> str:
    """正文是 XML-ish：`<`／`&` 要跳脫，`|` 是分格字元要跳脫。"""
    s = text.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
    s = s.replace('|', '\\|')
    return s.replace('\t', ' ').strip()


def pipe_lines(t: Table, header: bool = True) -> list[str]:
    """每列都寫成 `| a | b |`。

    外框的 `|` 一定要有：空的第一格（vMerge 續列）若寫成 ` | b`，讀者端會把
    行首的 `|` 當成外框吃掉 → 少一欄 → 整張表被拒絕。寫成 `|  | b |` 就沒有歧義。
    """
    lines: list[str] = ['<表>']
    for ri, row in enumerate(t.rows):
        cells: list[str] = []
        for c in row:
            if c.vmerge == 'continue':
                cells.extend([''] * c.span)
            else:
                cells.append(esc(c.text))
                cells.extend([''] * (c.span - 1))
        while len(cells) < t.cols:
            cells.append('')
        cells = cells[:t.cols]
        lines.append('| ' + ' | '.join(cells) + ' |')
        if header and ri == 0:
            lines.append('| ' + ' | '.join(['---'] * t.cols) + ' |')
    lines.append('</表>')
    return lines


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('docx')
    ap.add_argument('--emit', action='store_true', help='印出 <表> 區塊')
    ap.add_argument('-o', '--out', default='', help='寫到檔案（預設 stdout）')
    ap.add_argument('--only', type=int, default=0, help='只輸出第 N 張表（1 起）')
    ap.add_argument('--no-header', action='store_true', help='第一列不當表頭（不加 ---）')
    args = ap.parse_args()

    tables = read_tables(args.docx)
    print(f'{args.docx}\n  頂層表格 {len(tables)} 張', file=sys.stderr)
    for t in tables:
        flag = 'OK ' if t.expressible else 'SKIP'
        extra = []
        if t.has_image:
            extra.append('有圖')
        if t.has_nested:
            extra.append('巢狀')
        if t.vmerges:
            extra.append(f'vMerge×{t.vmerges}')
        if t.spans:
            extra.append(f'gridSpan×{t.spans}')
        print(f'  {flag} #{t.index}  {len(t.rows)}列 × {t.cols}欄  {("、".join(extra)) or ""}',
              file=sys.stderr)

    if not args.emit:
        return 0

    chosen = [t for t in tables if args.only in (0, t.index)]
    blocks: list[str] = []
    for t in chosen:
        if not t.expressible:
            print(f'  （#{t.index} 不能用 <表> 表達，跳過）', file=sys.stderr)
            continue
        blocks.append('\n'.join(pipe_lines(t, header=not args.no_header)))
    text = '\n\n'.join(blocks) + ('\n' if blocks else '')
    if args.out:
        with open(args.out, 'w', encoding='utf-8') as f:
            f.write(text)
        print(f'  → {args.out}（{len(blocks)} 張表）', file=sys.stderr)
    else:
        sys.stdout.write(text)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
