# -*- coding: utf-8 -*-
r"""漢字判定與位置的共用規則（Python 端）。

與 `ts/src/accelon26/han.ts` 同一套：漢字用 `\p{Script=Han}` 的等價範圍，
**逐 code point** 計（Python 3 的字串迭代本來就是 code point）。
所有 adb 工作區的 Python 產生器（fuyan 的 patch_xref_j.py、transclude…）
都應該 import 這裡，不要各自寫一份範圍。

    import sys
    sys.path.insert(0, r'D:\2026\adb-converter\ts\tools')
    from han import HAN, han_chars, han_count

範圍：BMP（Ext A＋URO＋相容）＋第 2 平面（Ext B–F、I）＋第 3 平面（Ext G/H）。
不含部首補充（2E80–2EFF）與小學類；閱讀器用 `\p{Script=Han}`，實務上正文不會
出現那些字。
"""
import re

HAN = re.compile(r'[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\U00020000-\U0003FFFF]')
TAG = re.compile(r'<[^>]*>')


def han_chars(s: str) -> str:
    """去掉標籤後，只留漢字（回傳字串，順序不變）。"""
    return ''.join(HAN.findall(TAG.sub('', s)))


def han_count(s: str) -> int:
    return len(han_chars(s))


def is_han(ch: str) -> bool:
    return bool(HAN.fullmatch(ch))
