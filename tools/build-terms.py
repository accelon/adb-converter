# -*- coding: utf-8 -*-
"""build-terms.py — 由 ys.adb 的 glossary 產生常用詞表（canonical 在 adb-converter）

    python tools/build-terms.py --glossary <glossary.jsonl>
                                [--out data/terms.tsv] [--fixes data/term-fixes.tsv]

glossary.jsonl 由 ys.adb 的 glossary 容器匯出（一行一筆 JSON）。

來源：
  1. ys.adb 的 glossary —— 它是「CBETA <foreign> 標到哪裡就記到哪裡」，
     所以常把前面的動詞／虛詞一起收進來（得四增上心、以一切法空性…）。
     這裡把開頭的上下文詞剝掉：剩下的必須是 glossary 本身的詞、或不是虛詞開頭。
  2. 作者人工列出的修正（見 CORRECTIONS）；這些優先，會覆蓋 glossary 的寫法。
  3. 太長的（>8 漢字）與明顯的句子片段整條丟掉。

輸出欄位：漢詞 \t 語言(sk/pi/tb) \t 外語
"""
import argparse
import json
import re
import sys

sys.stdout.reconfigure(encoding='utf-8')

HAN = re.compile(r'[\u3400-\u9fff\uf900-\ufaff\U00020000-\U0003FFFF]')
DEFAULT_GLOSS = r'D:\2026\ys\build\glossary.jsonl'
DEFAULT_OUT = r'D:\2026\adb-converter\data\terms.tsv'
DEFAULT_FIXES = r'D:\2026\adb-converter\data\term-fixes.tsv'
GLOSS = DEFAULT_GLOSS
OUT = DEFAULT_OUT
FIXES = DEFAULT_FIXES

# 開頭的上下文詞（動詞、虛詞、方位、部派名…）：剝掉才不會把「得四增上心」整個標成術語
LEAD = [
    '得', '從', '以', '作', '依', '修', '入', '加', '再', '說', '名', '是', '有', '約', '經', '能',
    '在', '如', '立', '稱', '答', '合', '勸', '晉', '又名', '再說', '已經得', '一一', '經中', '經說',
    '這應該從', '這兩部經所說', '息滅一切', '南方', '印度本土', '錫蘭', '弟子', '持經譬喻師', '經中立七種',
]

# 作者人工確認的修正：錯誤寫法 → 正確寫法（可帶外語）
CORRECTIONS = [
    ('得四增上心', '四增上心', None, None),
    ('得無生法忍', '無生法忍', 'sk', 'anutpattika-dharma-kṣānti'),
    ('得無相心三昧', '無相心三昧', None, None),
    ('得滅盡定', '滅盡定', None, None),
    ('得現法涅槃', '現法涅槃', None, None),
    ('從想受滅', '想受滅', None, None),
    ('以一切法空性', '一切法空性', 'sk', 'sarvadharma-śūnyatā'),
    ('作心解脫', '心解脫', None, None),
    ('依龍樹', '龍樹', 'sk', 'Nāgārjuna'),
    ('依空觀', '空觀', None, None),
    ('修不淨', '不淨', None, None),
    ('修彌勒', '彌勒', None, None),
    ('修無常想', '無常想', None, None),
    ('入正性離生', '正性離生', None, None),
    ('入正性決定', '正性決定', None, None),
    ('加滅盡定', '滅盡定', None, None),
    ('再說無所有', '無所有', None, None),
    ('勸老友梵志陀然', '陀然', None, None),
    ('南方阿闍黎耶龍叫', '龍叫', None, None),
    ('印度本土分別說者', '分別說者', None, None),
    ('又名三解脫門', '三解脫門', None, None),
    ('可破壞', '破壞', 'pi', 'khaya'),
    ('合名十二甘露門', '甘露門', None, None),
    ('名為集', '集', 'sk', 'samudaya'),
    ('名優陀延王', '優陀延王', None, None),
    ('名四梵住', '四梵住', None, None),
    ('名室利楞伽', '室利楞伽', None, None),
    ('名無量心解脫', '無量心解脫', None, None),
    ('名柔順忍', '柔順忍', None, None),
    ('名龍叫', '龍叫', None, None),
    ('在南印度大眾部', '大眾部', None, None),
    ('在大眾部', '大眾部', None, None),
    ('在羅什', '羅什', None, None),
    ('在阿瑜陀國', '阿瑜陀國', None, None),
    ('如南傳赤銅鍱部', '赤銅鍱部', None, None),
    ('已經得法現觀', '法現觀', None, None),
    ('弟子羅睺羅跋陀羅', '羅睺羅跋陀羅', 'sk', 'Rāhulabhadra'),
    ('息滅一切戲論', '戲論', None, None),
    ('持經譬喻師法救', '法救', 'sk', 'Dharmatrāta'),
    ('是量的因', '量的因', 'pi', 'pamāṇa-karaṇa'),
    ('有羅睺羅密多羅', '羅睺羅密多羅', 'sk', 'Rāhulamitra'),
    ('晉竺法護', '竺法護', 'sk', 'Dharmarakṣa'),
    ('有自相作意', '自相作意', 'sk', 'svalakṣaṇa-manasikāra'),
    ('稱說大空部', '說大空部', 'sk', 'Mahāsuññatavāda'),
    ('立內空', '內空', 'sk', 'adhyātma-śūnyatā'),
    ('立散空', '散空', 'sk', 'avakāraśūnyatā'),
    ('約涅槃', '涅槃', 'pi', 'nibbāna'),
    ('答摩犍提', '摩犍提', 'sk', 'Māgandiya'),
    ('經中立七種界', '界', 'sk', 'dhātu'),
    ('經柔順忍', '柔順忍', 'sk', 'ānulomikī-dharma-kṣānti'),
    ('經說五安穩住', '五安穩住', 'pi', 'pañca-phāsurihārā'),
    ('經部師室利羅多', '室利羅多', 'sk', 'Śrīrāta'),
    ('能得無生法忍', '無生法忍', 'sk', 'anutpattika-dharma-kṣānti'),
    ('說無我我所', '無我我所', 'pi', 'anattan-attaniya'),
    ('說無自性', '無自性', 'sk', 'niḥsvabhāva'),
    ('說般若波羅蜜', '般若波羅蜜', 'sk', 'prajñāpāramitā'),
    ('說阿惟越致', '阿惟越致', 'sk', 'avaivartika'),
    ('這兩部經所說不動', '不動', 'pi', 'āṇañja'),
    ('這應該從自相', '自相', 'sk', 'svalakṣaṇa'),
    ('錫蘭大寺派', '大寺派', 'sk', 'Mahāvihāra-vāsināḥ'),
    # 前面少字（要補齊的長詞）
    ('動作意', '不動作意', 'pi', 'āṇañja-manasikaroti'),
    ('可得空', '不可得空', 'sk', 'anupalambha-śūnyatā'),
    ('心三昧', '無所有心三昧', 'pi', 'ākiñcaññāceto-samādhi'),
]


FUNC_START = set('為是有之而則即若於其彼此所與')


def han_len(s):
    return len(HAN.findall(s))


# 明顯不是詞的條目（glossary 是「CBETA 標到哪裡就記到哪裡」，會留下句子片段）
JUNK_SUBSTR = ['名叫', '一位', '之為', '為有', '叫作', '名為', '所說', '這應該', '這樣', '如是說',
               '之中', '之一', '之二', '之時', '之處', '以上', '以下', '所謂']
JUNK_EXACT = {'之為我', '為有為', '名叫福貴', '有名叫福貴'}


def is_junk(han):
    if han in JUNK_EXACT:
        return True
    for w in JUNK_SUBSTR:
        if w in han and han_len(han) >= 3:
            return True
    return False




def main():
    global GLOSS, OUT, FIXES
    ap = argparse.ArgumentParser()
    ap.add_argument('--glossary', default=GLOSS)
    ap.add_argument('--out', default=OUT)
    ap.add_argument('--fixes', default=FIXES)
    a = ap.parse_args()
    GLOSS, OUT, FIXES = a.glossary, a.out, a.fixes
    raw = {}
    for line in open(GLOSS, encoding='utf-8'):
        line = line.strip()
        if not line or line.startswith('["GLOSSARY1"'):
            continue
        try:
            r = json.loads(line)
        except ValueError:
            continue
        if len(r) < 3:
            continue
        lang, foreign, han = r[0], r[1], r[2]
        n = han_len(han)
        if n < 2 or n != len(han) or n > 8:
            continue
        key = han
        cur = raw.get(key)
        cnt = r[3] if len(r) > 3 else 1
        if cur is None or cnt > cur[0]:
            raw[key] = (cnt, lang, foreign)

    # 剝掉開頭的上下文詞
    table = {}
    for han, (cnt, lang, foreign) in raw.items():
        if is_junk(han):
            continue
        best = han
        for w in LEAD:
            if han.startswith(w) and len(han) > len(w) + 1:
                rest = han[len(w):]
                # 剩下的部分本身是詞就剝；或它不是虛詞開頭、長度也夠（作三菩伽→三菩伽）。
                # 但「有為空」不能剝成「為空」——剩下的是虛詞開頭就保留原樣（2026-11-01）。
                if han_len(rest) >= 2 and (rest in raw or rest[0] not in FUNC_START):
                    best = rest
                    break
        if best in table:
            continue
        table[best] = (lang, foreign)

    # 作者修正優先
    for wrong, right, lang, foreign in CORRECTIONS:
        src = table.pop(wrong, None)                 # 舊的（錯誤）寫法，可拿它的外語
        cur = table.get(right)
        if foreign:
            table[right] = (lang or (src[0] if src else 'sk'), foreign)
        elif src:
            table[right] = (lang or src[0], src[1])
        elif cur:
            table[right] = (lang or cur[0], cur[1])

    rows = sorted((h, l, f) for h, (l, f) in table.items() if f)
    with open(OUT, 'w', encoding='utf-8', newline='\n') as fh:
        fh.write('# 常用詞表：漢詞\t語言\ta外語（資料來源：ys.adb glossary 清理 ＋ 作者修正）\n')
        for h, l, f in rows:
            fh.write('%s\t%s\t%s\n' % (h, l, f))
    # 明確修正表（fix_terms.py 用；不靠猜）
    fx = FIXES
    with open(fx, 'w', encoding='utf-8', newline='\n') as fh:
        fh.write('# 術語斷詞修正：錯的寫法\t正確寫法\n')
        for wrong, right, _l, _f in CORRECTIONS:
            if wrong != right:
                fh.write('%s\t%s\n' % (wrong, right))
    print('寫出 %s：%d 條（原始 %d 條）' % (OUT, len(rows), len(raw)))
    print('寫出 %s：%d 條修正' % (fx, len([c for c in CORRECTIONS if c[0] != c[1]])))


if __name__ == '__main__':
    main()


