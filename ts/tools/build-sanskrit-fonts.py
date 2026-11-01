#!/usr/bin/env python3
"""Build the Accelon webfonts for CBETA Siddham / Ranjana.

CBETA's `Siddam.ttf` / `Ranjana.ttf` do not map the PUA code points used in the
TEI (`&SD;` / `&RJ;`); they draw the Sanskrit glyphs at the *Big5 carrier*
characters listed in cbeta_sanskrit.csv (`char` column).  This script rebuilds
the cmap so the fonts can be used directly with the PUA text:

    SD-XXXX -> U+FA000 + XXXX   (plane 16 PUA-B)
    RJ-XXXX -> U+100000 + XXXX  (plane 16 PUA-B)

and subsets the result to those code points, then writes WOFF2.

Usage (needs `pip install fonttools brotli`):
    python build-sanskrit-fonts.py --src DIR --out DIR

`--src` must contain Siddam.ttf, Ranjana.ttf and cbeta_sanskrit.csv
(download: https://cbeta.org/files/fonts/siddam_20260728.zip,
 https://cbeta.org/files/fonts/ranjana_20230621.zip,
 https://raw.githubusercontent.com/cbeta-org/cbeta_gaiji/master/cbeta_sanskrit.csv)
"""
import argparse
import csv
import os
import sys

from fontTools.ttLib import TTFont, newTable
from fontTools.ttLib.tables._c_m_a_p import CmapSubtable
from fontTools import subset


def load_map(path):
    rows = list(csv.DictReader(open(path, encoding='utf-8'), delimiter='\t'))
    out = {}
    for r in rows:
        out[r['ID']] = r
    return out


def build(src_ttf, rows, family, out_path):
    font = TTFont(src_ttf)
    cmap = font.getBestCmap()
    new_map = {}
    missing = []
    for r in rows:
        ch = r['char']
        pua = int(r['pua'][2:], 16)
        gname = cmap.get(ord(ch)) if ch else None
        if not gname:
            missing.append(r['ID'])
            continue
        new_map[pua] = gname
    if missing:
        print(f'  missing carriers: {len(missing)} (first {missing[:5]})', file=sys.stderr)

    table = CmapSubtable.newSubtable(12)
    table.platformID = 3
    table.platEncID = 10
    table.language = 0
    table.cmap = new_map
    cmap_table = newTable('cmap')
    cmap_table.tableVersion = 0
    cmap_table.tables = [table]
    font['cmap'] = cmap_table

    # Rename so the webfont never shadows a user-installed Siddam/Ranjana.
    name = font['name']
    for rec in list(name.names):
        if rec.nameID in (1, 3, 4, 6, 16):
            rec.string = family
        elif rec.nameID == 2:
            rec.string = 'Regular'
        elif rec.nameID == 5:
            rec.string = 'Version 1.000 (Accelon edition)'
        elif rec.nameID in (7, 8, 9, 10, 11, 12, 13, 14, 17):
            rec.string = 'Accelon26 bundled webfont; glyphs (c) CBETA'

    opts = subset.Options()
    opts.name_IDs = ['*']
    opts.name_legacy = True
    opts.name_languages = ['*']
    opts.notdef_outline = True
    opts.recalc_bounds = True
    opts.layout_features = []
    opts.hinting = True
    opts.desubroutinize = False
    opts.drop_tables += ['FFTM']
    ss = subset.Subsetter(options=opts)
    ss.populate(unicodes=sorted(new_map))
    ss.subset(font)
    font.flavor = 'woff2'
    font.save(out_path)
    print(f'  {os.path.basename(out_path)}  {os.path.getsize(out_path)/1024:.1f} KiB  glyphs={len(font.getGlyphOrder())} cmap={len(new_map)}')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', required=True, help='dir with Siddam.ttf, Ranjana.ttf, cbeta_sanskrit.csv')
    ap.add_argument('--out', required=True, help='output dir (woff2 files)')
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    rows = load_map(os.path.join(args.src, 'cbeta_sanskrit.csv'))
    sd = [r for r in rows.values() if r['ID'].startswith('SD-')]
    rj = [r for r in rows.values() if r['ID'].startswith('RJ-')]
    print(f'SD rows={len(sd)}  RJ rows={len(rj)}')
    build(os.path.join(args.src, 'Siddam.ttf'), sd, 'Accelon Siddham', os.path.join(args.out, 'accelon-siddham.woff2'))
    build(os.path.join(args.src, 'Ranjana.ttf'), rj, 'Accelon Ranjana', os.path.join(args.out, 'accelon-ranjana.woff2'))


if __name__ == '__main__':
    main()
