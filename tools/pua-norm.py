# -*- coding: utf-8 -*-
"""taisho CB 缺字：plane-15 PUA → 通用字（norm_big5_char）對照與套用。

背景（見 docs/adb/missing-char.md）：
  taisho 文字裡的 CB 缺字，若 charDecl 只有 PUA，會是 U+F0000 + CB 編號
  （例 CB04636 → U+F121C）。其中一部分在 CBETA 外字庫 cbeta_gaiji.csv 有
  norm_big5_char（通用字）：unicode 與 norm_unicode 都空、norm_big5_char 非空。
  這些換成通用字（1 字換 1 字，仍是 1 個 VA；不動標記、不動行序）。

用法（在工作區根目錄）：
  python tools/pua-norm.py make                     # 掃原始文字 → build/pua-norm.tsv
  python tools/pua-norm.py make <raw.txt>           # 指定別的 tei2adb 輸出
  python tools/pua-norm.py apply <in.txt> <out.txt> # 套用映射（只換 216 碼）
  python tools/pua-norm.py check <text.txt>         # 統計 plane-15 PUA

注意：
  - make 要讀 **tei2adb 的原始輸出**（build/tei-all-2026R2.txt）。這份檔案要保留；
    若只剩正規化後的文字，PUA 已換掉，make 會得到 0 列。
  - build/pua-norm.tsv 是這次替換的完整帳（code / pua / char / count），
    留著就可反向查「哪個通用字來自哪個 CB 碼」。
"""
import collections
import csv
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)

RAW_TEXT = 'build/tei-all-2026R2.txt'
GAIJI_CSV = 'build/fonts/cbeta_gaiji.csv'
MAP_TSV = 'build/pua-norm.tsv'

# plane-15 PUA（U+F0000–U+FFFFD）＝ CB 缺字只有 PUA 對應時的碼位
PUA_RE = re.compile('[\U000F0000-\U000FFFFD]')


def read_tsv(path):
    with open(path, encoding='utf-8') as f:
        return list(csv.DictReader(f, delimiter='\t'))


def scan_pua(path):
    """逐行掃 plane-15 PUA，回傳 Counter(碼位 → 次數)。串流讀，避免 377 MB 全進記憶體。"""
    cnt = collections.Counter()
    with open(path, encoding='utf-8') as f:
        for line in f:
            for m in PUA_RE.finditer(line):
                cnt[ord(m.group(0))] += 1
    return cnt


def make(text=RAW_TEXT):
    """依規則產生 build/pua-norm.tsv（預期 216 列／1,047 次）。"""
    gaiji = {r['ID']: r for r in read_tsv(GAIJI_CSV)}
    cnt = scan_pua(text)
    if not cnt:
        sys.exit(f'{text} 裡沒有 plane-15 PUA：請確認這是 tei2adb 的原始輸出（不是已正規化的文字）')

    rows = []
    for cp, n in cnt.items():
        code = 'CB%05d' % (cp - 0xF0000)
        e = gaiji.get(code)
        if not e:
            continue
        # 規則：unicode 與 norm_unicode 都空、norm_big5_char 非空
        if e['unicode'] or e['norm_unicode'] or not e['norm_big5_char']:
            continue
        ch = e['norm_big5_char']
        if len(ch) != 1:
            sys.exit(f'{code} 的 norm_big5_char 不是一個字元：{ch!r}')
        if ord(ch) > 0xFFFF:
            sys.exit(f'{code} 的 norm_big5_char 不在 BMP，會改變 VA：{ch!r}')
        if int(e['pua'][2:], 16) != cp:
            sys.exit(f'{code} 的 PUA 對不上：csv={e["pua"]} text=U+{cp:X}')
        rows.append((code, cp, ch, n))

    # 次數多的排前面；同次數依 CB 編號
    rows.sort(key=lambda r: (-r[3], r[0]))
    with open(MAP_TSV, 'w', encoding='utf-8', newline='') as f:
        w = csv.writer(f, delimiter='\t', lineterminator='\n')
        w.writerow(['code', 'pua', 'char', 'count'])
        for code, cp, ch, n in rows:
            w.writerow([code, 'U+%X' % cp, ch, n])

    total = sum(r[3] for r in rows)
    print(f'{text}: plane-15 PUA {len(cnt)} 碼／{sum(cnt.values())} 次')
    print(f'{MAP_TSV}: {len(rows)} 列／{total} 次（unicode 與 norm_unicode 空、norm_big5_char 非空）')
    return rows


def apply(src, dst):
    """把 src 裡映射到的 PUA 換成通用字，逐行寫到 dst（行序、標記不動）。"""
    rows = read_tsv(MAP_TSV)
    table = {}
    for r in rows:
        cp = int(r['pua'][2:], 16)
        ch = r['char']
        if 0xF0000 + int(r['code'][2:]) != cp:
            sys.exit(f'{r["code"]} 與 {r["pua"]} 不一致')
        table[cp] = ch

    n = 0
    with open(src, encoding='utf-8') as fi, open(dst, 'w', encoding='utf-8', newline='') as fo:
        for line in fi:
            if not PUA_RE.search(line):
                fo.write(line)
                continue
            holder = [0]

            def repl(m):
                ch = table.get(ord(m.group(0)))
                if ch is None:
                    return m.group(0)
                holder[0] += 1
                return ch

            fo.write(PUA_RE.sub(repl, line))
            n += holder[0]

    left = scan_pua(dst)
    print(f'{src} → {dst}')
    print(f'替換 {n} 次（映射 {len(table)} 碼）；剩下 plane-15 PUA {len(left)} 碼／{sum(left.values())} 次')


def check(path):
    cnt = scan_pua(path)
    print(f'{path}: plane-15 PUA {len(cnt)} 碼／{sum(cnt.values())} 次')
    for cp, n in cnt.most_common(10):
        print('  CB%05d U+%X %d' % (cp - 0xF0000, cp, n))


def main(argv):
    if len(argv) < 2 or argv[1] not in ('make', 'apply', 'check'):
        print(__doc__)
        return 2
    if argv[1] == 'make':
        make(argv[2] if len(argv) > 2 else RAW_TEXT)
    elif argv[1] == 'apply':
        if len(argv) != 4:
            print('usage: python tools/pua-norm.py apply <in.txt> <out.txt>')
            return 2
        apply(argv[2], argv[3])
    else:
        if len(argv) != 3:
            print('usage: python tools/pua-norm.py check <text.txt>')
            return 2
        check(argv[2])
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
