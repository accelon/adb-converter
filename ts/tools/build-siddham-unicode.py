#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""重建 Accelon Siddham Uni（Noto Sans Siddham 子集）。

    python ts/tools/build-siddham-unicode.py

來源：Google Fonts 的 NotoSansSiddham-Regular.ttf（SIL OFL 1.1）。
只留 U+11580–115FF（悉曇區），保留 GSUB／GPOS 連字規則，輸出 WOFF2。
需要 fonttools 與 brotli（本專案用 `PYTHONPATH=build/py`）。

成品：ts/src/accelon26/fonts/accelon-siddham-unicode.woff2
授權：ts/src/accelon26/fonts/OFL-NotoSansSiddham.txt
"""
import os
import sys
import urllib.request

from fontTools import subset
from fontTools.ttLib import TTFont

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SRC_DIR = os.path.join(ROOT, 'build', 'fonts', 'noto')
SRC = os.path.join(SRC_DIR, 'NotoSansSiddham-Regular.ttf')
OUT = os.path.join(ROOT, 'ts', 'src', 'accelon26', 'fonts', 'accelon-siddham-unicode.woff2')
URL = 'https://fonts.gstatic.com/s/notosanssiddham/v21/OZpZg-FwqiNLe9PELUikxTWDoCCeGqnd.ttf'


def main() -> int:
    os.makedirs(SRC_DIR, exist_ok=True)
    if not os.path.exists(SRC):
        print('下載', URL)
        urllib.request.urlretrieve(URL, SRC)

    font = TTFont(SRC)
    opts = subset.Options()
    opts.flavor = 'woff2'
    opts.layout_features = ['*']       # 保留 GSUB／GPOS，連字才會成形
    opts.name_IDs = ['*']
    opts.notdef_outline = True
    sub = subset.Subsetter(options=opts)
    sub.populate(unicodes=range(0x11580, 0x11600))
    sub.subset(font)
    font.flavor = 'woff2'
    font.save(OUT)
    print('wrote', OUT, os.path.getsize(OUT), 'bytes')
    return 0


if __name__ == '__main__':
    sys.exit(main())
