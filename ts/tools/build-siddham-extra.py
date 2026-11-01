#!/usr/bin/env python3
"""Build the small CBETA Siddham fallback font for glyphs Noto cannot render.

1,993 of the 2,074 CBETA Siddham glyphs can be expressed as Unicode sequences
and rendered by Noto Sans Siddham.  The remaining 81 (no romanization, or two
syllables such as `traṭ`) have no sequence; this script extracts just those
glyphs from CBETA's `Siddam.ttf` and maps them to their PUA code points, so the
big 415 KiB font is no longer needed.

Usage:
    python ts/tools/build-siddham-extra.py [--src build/fonts] [--out ts/src/accelon26/fonts]
"""
import argparse
import csv
import json
import os
import sys

from fontTools.ttLib import TTFont, newTable
from fontTools.ttLib.tables._c_m_a_p import CmapSubtable
from fontTools import subset


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', default='build/fonts')
    ap.add_argument('--out', default='ts/src/accelon26/fonts')
    ap.add_argument('--seq', default='build/pua-seq.json')
    args = ap.parse_args()

    seq = {r['pua']: r['seq'] for r in json.load(open(args.seq, encoding='utf-8'))}
    rows = list(csv.DictReader(open(os.path.join(args.src, 'cbeta_sanskrit.csv'), encoding='utf-8'), delimiter='\t'))
    keep = [r for r in rows if r['ID'].startswith('SD-') and not seq.get(r['pua'], '')]
    print(f'SD rows without sequence: {len(keep)}')

    font = TTFont(os.path.join(args.src, 'Siddam.ttf'))
    cmap = font.getBestCmap()
    new_map = {}
    for r in keep:
        ch = r['char']
        pua = int(r['pua'][2:], 16)
        gname = cmap.get(ord(ch)) if ch else None
        if gname:
            new_map[pua] = gname
    print(f'  mapped {len(new_map)} glyphs')

    table = CmapSubtable.newSubtable(12)
    table.platformID = 3
    table.platEncID = 10
    table.language = 0
    table.cmap = new_map
    cmap_table = newTable('cmap')
    cmap_table.tableVersion = 0
    cmap_table.tables = [table]
    font['cmap'] = cmap_table

    family = 'Accelon Siddham Extra'
    name = font['name']
    for rec in list(name.names):
        if rec.nameID in (1, 3, 4, 6, 16):
            rec.string = family
        elif rec.nameID == 2:
            rec.string = 'Regular'
        elif rec.nameID == 5:
            rec.string = 'Version 1.000 (Accelon edition)'
        elif rec.nameID in (7, 8, 9, 10, 11, 12, 13, 14, 17):
            rec.string = 'Accelon26 bundled fallback; glyphs (c) CBETA'

    opts = subset.Options()
    opts.name_IDs = ['*']
    opts.name_legacy = True
    opts.name_languages = ['*']
    opts.notdef_outline = True
    opts.recalc_bounds = True
    opts.layout_features = []
    opts.hinting = True
    opts.drop_tables += ['FFTM']
    ss = subset.Subsetter(options=opts)
    ss.populate(unicodes=sorted(new_map))
    ss.subset(font)
    font.flavor = 'woff2'
    out = os.path.join(args.out, 'accelon-siddham-extra.woff2')
    font.save(out)
    print(f'  {os.path.basename(out)}  {os.path.getsize(out)/1024:.1f} KiB  glyphs={len(font.getGlyphOrder())} cmap={len(new_map)}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
