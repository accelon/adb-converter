# -*- coding: utf-8 -*-
"""sync_fuyan_meta_1124.py — 發版後把 fuyan.adb 這一版拼進四處（只手拼 fuyan 條）。

依据：母區 f53b2d8／a7d9868 的做法——adb-notes.json（sha 完整 64 位＋notes 累載，
留最新 9 條）、adb-history.json（unshift 一筆）、www/adb/manifest.json（只改 fuyan 條的
size/sha256/buildTime/date/notes/history）、www/adb/fuyan.html（版本表插一列）。
indent=2、最小 diff；其他 db 的條目一律不碰。
"""
import io, json, os, re, hashlib, datetime

ROOT = r'D:\2026\adb-converter'
ADB = r'D:\accelon3\fuyan.adb'
SHA = hashlib.sha256(open(ADB, 'rb').read()).hexdigest()
SIZE = os.path.getsize(ADB)
BUILD = datetime.datetime.fromtimestamp(os.path.getmtime(ADB), datetime.timezone.utc
                                       ).strftime('%Y-%m-%dT%H:%M:%SZ')
DATE = BUILD[:10]
NOTE = (
    '**《成佛之道講義》測試九（12 項）＋測試十（4 項）全部照辦**（厚觀法師 399／402，2026-11-24）：'
    '一、「中觀論論究的法相」一行起改標楷（12p360），並依囑全書檢索「印順法師／印順導師＋書名＋頁碼＋冒號」'
    '共四處（12p266、12p360、12p408 兩處）與「《太虛大師全書》＋頁碼＋冒號」一處（12p263）；'
    '二、「以無為法而有差別。」是局部引文，只把引號內改標楷（12p369）；'
    '三、「龍猛父子雖未明說…」至「《顯句論》說此經分了不了與前經義同。……」整段標楷（12p372）；'
    '四、「爾時，世尊告諸比丘」一行起標楷（12p373）；五、「4、《迴諍論》云：」下兩行標楷（12p373）；'
    '六、《成佛之道》四段標楷，出處「（參見《中論》卷4〈24觀四諦品〉（大正30，33b））」另起一行、'
    '《中論》前補「參見」二字（12p374）；七、演培法師《解深密經語體釋》「1、未種善根」～'
    '「5、未能積集福德智慧二種資糧」五段標楷（12p375）；八、四項【】依 07F 原稿刪中括號、'
    '比照一般科判反白（12p375）；九、十、「如七尺之身」「觀真空人」一行起標楷（12p377）；'
    '十一、A「（一）《如來藏之研究》，pp.246-247：」升科判，B 新增「（二）如來藏為染淨諸法所依」作科判、'
    '原文移到下面另起一段（12p387）；十二、「如來清淨藏」以下三行標楷（12p394）。'
    '測試十：一、第六地「現前地」段（一）～（六）全升科判，（二）（三）照 07G 改寫成短科判、'
    '長句下移另段（12p407-408）；二、「有部論師對緣起的解釋」整段標楷（12p408）；'
    '三、「〈十地品〉有濃厚的阿毘達磨氣息」整段標楷（12p408）；'
    '四、「☆☆（p.429）同歸佛道」作科判反白，掛在與「一、」「二、」同一層（12p429）。'
    '重建可重現（連打兩次 pack sha 一致），逐條截圖驗過畫面。'
)


def load(p):
    return json.load(io.open(os.path.join(ROOT, p), encoding='utf-8'))


def save(p, obj):
    io.open(os.path.join(ROOT, p), 'w', encoding='utf-8', newline='\n').write(
        json.dumps(obj, ensure_ascii=False, indent=2) + '\n')


# 1) deploy/adb-notes.json
n = load(r'deploy\adb-notes.json')
f = n['fuyan.adb']
f['sha256'] = SHA
f['notes'] = [NOTE] + [x for x in f['notes'] if x != NOTE][:8]
save(r'deploy\adb-notes.json', n)

# 2) deploy/adb-history.json
h = load(r'deploy\adb-history.json')
hist = h['fuyan.adb']
hist = [x for x in hist if x.get('sha256') != SHA]
hist.insert(0, {'buildTime': BUILD, 'sha256': SHA, 'size': SIZE, 'notes': [NOTE]})
h['fuyan.adb'] = hist
save(r'deploy\adb-history.json', h)

# 3) www/adb/manifest.json（只拼 fuyan 條）
m = load(r'www\adb\manifest.json')
cur = [d for d in m['dbs'] if d['file'] == 'fuyan.adb'][0]
cur['size'] = SIZE
cur['sha256'] = SHA
cur['buildTime'] = BUILD
cur['date'] = DATE
cur['notes'] = f['notes']
mh = cur.get('history') or []
mh = [x for x in mh if x.get('sha256') != SHA]
mh.insert(0, {'buildTime': BUILD, 'sha256': SHA, 'size': SIZE, 'notes': [NOTE]})
cur['history'] = mh
save(r'www\adb\manifest.json', m)

# 4) www/adb/fuyan.html（版本表插一列）
p = os.path.join(ROOT, r'www\adb\fuyan.html')
t = io.open(p, encoding='utf-8').read()
row_re = re.compile(r'( *)<tr>\n *<td>2026-11-24</td>\n *<td>394 ')
mm = row_re.search(t)
assert mm, '找不到 394 那一列（表格結構變了，先人工看）'
ind = mm.group(1)
short = (
    '照法師 399（測試九 12 項）＋402（測試十 4 項）逐條改：<br>'
    '字體類——引文起訖改標楷體共 10 條（12p360、369（局部引文只包引號內）、372、373×2、374、375、377×2、394），'
    '「印順法師／印順導師＋書名＋頁碼＋冒號」全書檢索四處（12p266、360、408×2）、'
    '「《太虛大師全書》＋頁碼＋冒號」一處（12p263）；<br>'
    '科判類——12p375 四項【】依 07F 刪括號升科判、12p387「（一）《如來藏之研究》」與新增'
    '「（二）如來藏為染淨諸法所依」升科判（原文下移另段）、12p407-408 第六地（一）～（六）全升科判'
    '（（二）（三）照 07G 改短）、12p429「☆☆（p.429）同歸佛道」升科判反白；<br>'
    '12p374 出處「（《中論》卷4…）」另起一行並補「參見」二字。重建可重現（連打兩次 sha 一致），逐條截圖驗畫面。'
)
newrow = ('%s<tr>\n'
          '%s  <td>%s</td>\n'
          '%s  <td>399／402 《成佛之道講義》測試九 12 項＋測試十 4 項（sha256 <code>%s&hellip;</code>）</td>\n'
          '%s  <td>%s</td>\n'
          '%s  <td>厚觀法師（2026-11-24 09:26、11:01）</td>\n'
          '%s</tr>\n\n' % (ind, ind, DATE, ind, SHA[:12], ind, short, ind, ind))
if SHA[:12] not in t:
    t = t[:mm.start()] + newrow + t[mm.start():]
    io.open(p, 'w', encoding='utf-8', newline='\n').write(t)
    print('fuyan.html 已插一列')
else:
    print('fuyan.html 已有這一版，未重複插')

print('SHA', SHA)
print('SIZE', SIZE)
print('BUILD', BUILD)
