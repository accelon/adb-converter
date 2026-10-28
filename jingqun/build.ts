#!/usr/bin/env bun
/**
 * 建「經 → 注 → 疏」繼承表。
 *
 * 資料來源（依可信度）：
 *   1. CBETA TEI 正文的 `No. X [cf. No. Y]`：Y 就是本部註疏所釋的本經（或本論）。
 *   2. 人工種子：續經疏部（56–61 冊）等沒有 cf 的作品，依題名與大正藏部類次序指定。
 * 本版不使用純字面猜測；每一筆不是 cf 就是人工種子（見 evidence 欄）。
 *
 * 產出：
 *   jingqun/jingqun.tsv          逐筆（一本書一列，進版控）
 *   build/jingqun/jingqun.json   依 family → 經 → 注 → 疏 的巢狀樹
 *   build/jingqun/jingqun.html   同一棵樹的離線檢視
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const HERE = import.meta.dir;
const ROOT = resolve(HERE, '..');

interface Book { idx: number; vol: number; no: string; juan: number; lei: string; bu: string; title: string; author: string; root: string; }
const CAT: Book[] = readFileSync(join(ROOT, 'build/jingqun/catalog.tsv'), 'utf8')
  .split(/\r?\n/).slice(1).filter(Boolean)
  .map((l) => {
    const p = l.split('\t');
    return { idx: +p[0], vol: +p[1], no: p[2], juan: +p[3], lei: p[4], bu: p[5], title: p[6], author: p[7], root: p[8] };
  });

const CF = new Map<string, string>();
for (const l of readFileSync(join(ROOT, 'build/jingqun/cf.tsv'), 'utf8').split(/\r?\n/).slice(1)) {
  if (!l) continue;
  const p = l.split('\t');
  if (p[2]) CF.set(p[0], p[1 + 1]);
}

const normNo = (s: string) => s.toLowerCase().replace(/^0+/, '');
const byNo = new Map<string, Book[]>();
for (const b of CAT) {
  const k = normNo(b.no);
  if (!byNo.has(k)) byNo.set(k, []);
  byNo.get(k)!.push(b);
}
const bookOf = (no: string): Book | undefined => {
  const k = normNo(no);
  const exact = byNo.get(k);
  if (exact?.length) return exact[0];
  // 0236 → 0236a/0236b、0893 → 0893a/b/c：經號有字母後綴時取第一本
  const pref = [...byNo.keys()].filter((x) => x.startsWith(k) && x.length === k.length + 1 && /[a-z]$/.test(x)).sort();
  return pref.length ? byNo.get(pref[0])![0] : undefined;
};
/** 取得書目裡的正式經號（補前導零、補字母） */
const canonNo = (no: string): string => bookOf(no)?.no ?? no;

/** 族（同一部經的不同譯本歸為一族） */
const FAMILIES: Record<string, { label: string; roots: string[] }> = {
  f_renben: { label: '人本欲生', roots: ['0014'] },
  f_yinchi: { label: '陰持入', roots: ['0603'] },
  f_boruo: { label: '般若部（大般若／大品）', roots: ['0220', '0223'] },
  f_jingang: { label: '金剛般若', roots: ['0235', '0236a', '0236b', '0239'] },
  f_renwang: { label: '仁王般若', roots: ['0245', '0246'] },
  f_xinjing: { label: '般若心經', roots: ['0251'] },
  f_shengfomu: { label: '聖佛母般若', roots: ['0257'] },
  f_fahua: { label: '法華', roots: ['0262'] },
  f_jingang_sanmei: { label: '金剛三昧', roots: ['0273'] },
  f_wuliangyi: { label: '無量義', roots: ['0276'] },
  f_puxian: { label: '觀普賢', roots: ['0277'] },
  f_huayan: { label: '華嚴', roots: ['0278', '0279'] },
  f_shidi: { label: '十地', roots: ['0286', '0287'] },
  f_dabaoji: { label: '大寶積', roots: ['0310'] },
  f_daji: { label: '大集', roots: ['0397'] },
  f_mile_wensuo: { label: '彌勒菩薩所問', roots: ['0349'] },
  f_shengman: { label: '勝鬘', roots: ['0353'] },
  f_wuliangshou: { label: '無量壽', roots: ['0360'] },
  f_guanwuliangshou: { label: '觀無量壽', roots: ['0365'] },
  f_amituo: { label: '阿彌陀', roots: ['0366'] },
  f_niepan: { label: '涅槃', roots: ['0374', '0375'] },
  f_yijiao: { label: '遺教', roots: ['0389'] },
  f_yaoshi: { label: '藥師', roots: ['0449', '0450'] },
  f_mile: { label: '彌勒', roots: ['0452'] },
  f_wenshu: { label: '文殊問菩提', roots: ['0464'] },
  f_weimo: { label: '維摩', roots: ['0475', '0476'] },
  f_shengsiswei: { label: '勝思惟梵天', roots: ['0587'] },
  f_jinguangming: { label: '金光明', roots: ['0663', '0665'] },
  f_lengqie: { label: '楞伽', roots: ['0670', '0671', '0672'] },
  f_fodi: { label: '佛地', roots: ['0680'] },
  f_yulanpen: { label: '盂蘭盆', roots: ['0685'] },
  f_wenshi: { label: '溫室', roots: ['0701'] },
  f_dashengsi: { label: '大乘四法', roots: ['0772'] },
  f_sishier: { label: '四十二章', roots: ['0784'] },
  f_yuanjue: { label: '圓覺', roots: ['0842'] },
  f_dari: { label: '大日', roots: ['0848'] },
  f_jingangding: { label: '金剛頂', roots: ['0865'] },
  f_yuqi: { label: '瑜祇', roots: ['0867'] },
  f_suxidi: { label: '蘇悉地', roots: ['0893a'] },
  f_lengyan: { label: '楞嚴', roots: ['0945'] },
  f_zunsheng: { label: '尊勝', roots: ['0967'] },
  f_kongque: { label: '孔雀', roots: ['0982'] },
  f_putichang: { label: '菩提場', roots: ['1008'] },
  f_qingguanyin: { label: '請觀音', roots: ['1043'] },
  f_qianshou: { label: '千手', roots: ['1060'] },
  f_shiyimian: { label: '十一面', roots: ['1071'] },
  f_bukong: { label: '不空羂索', roots: ['1092'] },
  f_dasuiqiu: { label: '大隨求', roots: ['1153'] },
  f_zhuanfalun: { label: '轉法輪', roots: ['0109'] },
  f_ahan: { label: '阿含', roots: ['0125'] },
  f_liqiu: { label: '理趣', roots: ['0243'] },
  f_jieshenmi: { label: '解深密', roots: ['0675', '0676'] },
  f_ahan_extra: { label: '阿含（單經）', roots: ['1508'] },
  // ── 論群（論 → 疏） ──
  f_jushe: { label: '俱舍論', roots: ['1558'] },
  f_zhonglun: { label: '中論', roots: ['1564'] },
  f_shier: { label: '十二門論', roots: ['1568'] },
  f_bailun: { label: '百論', roots: ['1569', '1571'] },
  f_zhangzhen: { label: '掌珍論', roots: ['1578'] },
  f_yujiashidi: { label: '瑜伽師地論', roots: ['1579'] },
  f_dichi: { label: '菩薩地持經', roots: ['1581'] },
  f_chengweishi: { label: '成唯識論', roots: ['1585', '1586', '1590'] },
  f_shecheng: { label: '攝大乘論', roots: ['1595'] },
  f_bianzhongbian: { label: '辯中邊論', roots: ['1600'] },
  f_baifa: { label: '百法明門論', roots: ['1614'] },
  f_fajie: { label: '大乘法界無差別論', roots: ['1626'] },
  f_yinming: { label: '因明', roots: ['1628', '1630'] },
  f_qixin: { label: '大乘起信論', roots: ['1666', '1667'] },
  f_zhaolun: { label: '肇論', roots: ['1858'] },
  f_zhiguan: { label: '摩訶止觀', roots: ['1911'] },
  f_guanxin: { label: '觀心論', roots: ['1920'] },
  f_shibuer: { label: '十不二門', roots: ['1927'] },
  f_huayanfajie: { label: '華嚴一乘法界圖', roots: ['1887a'] },
  f_rudao: { label: '大乘入道次第', roots: ['1864'] },
  f_yinyuanxin: { label: '因緣心論', roots: ['1654'] },
  f_daogan: { label: '大乘稻芉經', roots: ['0712'] },
  f_tianqingwen: { label: '天請問經', roots: ['0592'] },
  f_sifen: { label: '四分律', roots: ['1428', '1429', '1430'] },
  f_fanwang: { label: '梵網經', roots: ['1484'] },
  f_yingluo: { label: '瓔珞本業經', roots: ['1485'] },
  f_faju: { label: '法句經', roots: ['2901'] },
  f_lun: { label: '獨立論書', roots: ['1505', '1506', '1534'] },
};

const rootToFamily = new Map<string, string>();
for (const [fid, f] of Object.entries(FAMILIES)) for (const r of f.roots) rootToFamily.set(normNo(r), fid);

type Override = { root: string; parent?: string; conf?: 'high' | 'medium' | 'low'; note?: string };
/**
 * 沒有 cf 的作品，或 cf 指向另一部註疏時的人工指定。
 * root：本經經號；parent：直接所釋的註疏經號（省略＝直接掛在 root 下）。
 */
const MANUAL: Record<string, Override> = {
  // ── 釋經論部 ──
  '1505': { root: '', note: '四阿含摘要，獨立論書（無單一本經）' },
  '1506': { root: '', note: '三法度論，獨立論書' },
  '1507': { root: '0125', conf: 'medium', note: '分別功德論釋增壹阿含' },
  '1508': { root: '', note: '阿含口解十二因緣經本身是經' },
  '1510a': { root: '0235' },
  '1510b': { root: '0235' },
  '1511': { root: '0235' },
  '1512': { root: '0235' },
  '1513': { root: '0239' },
  '1514': { root: '0239' },
  '1515': { root: '0235' },
  '1516': { root: '0257' },
  '1517': { root: '0257' },
  '1518': { root: '0257' },
  '1519': { root: '0262' },
  '1520': { root: '0262' },
  '1521': { root: '0286', conf: 'medium', note: '十住毘婆沙論釋十住經（十地品舊譯）' },
  '1522': { root: '0287' },
  '1523': { root: '0310' },
  '1524': { root: '0360' },
  '1525': { root: '0349', conf: 'medium', note: '同大寶積經彌勒菩薩所問會' },
  '1526': { root: '0397', conf: 'medium', note: '釋大集經寶髻菩薩品（大集中之一集）' },
  '1527': { root: '0374' },
  '1528': { root: '0374' },
  '1529': { root: '0389' },
  '1530': { root: '0680' },
  '1531': { root: '0464' },
  '1532': { root: '0587' },
  '1533': { root: '0109' },
  '1534': { root: '', note: '三具足經未譯入大正藏，僅存此論' },
  '1535': { root: '0772' },
  // ── 經疏部（沒有 cf 的） ──
  '1695': { root: '0220', note: '大般若經般若理趣分' },
  '1702': { root: '0235', parent: '1701', note: '刊定記釋纂要' },
  '1706': { root: '0245', parent: '1705', note: '神寶記釋仁王疏' },
  '1713': { root: '0251', parent: '1712', note: '連珠記釋略疏' },
  '1717': { root: '0262', parent: '1716', note: '釋籤釋玄義' },
  '1718': { root: '0262' },
  '1719': { root: '0262', parent: '1718', note: '文句記釋文句' },
  '1723': { root: '0262' },
  '1724': { root: '0262', parent: '1723', note: '義決釋玄贊' },
  '1726': { root: '0262', note: '觀音品' },
  '1727': { root: '0262', parent: '1726', note: '記釋觀音玄義' },
  '1728': { root: '0262', note: '觀音品' },
  '1729': { root: '0262', parent: '1728', note: '記釋觀音義疏' },
  '1735': { root: '0279' },
  '1736': { root: '0279', parent: '1735', note: '隨疏演義鈔釋華嚴疏' },
  '1750': { root: '0365' },
  '1751': { root: '0365', parent: '1750', note: '妙宗鈔釋觀經疏' },
  '1765': { root: '0375' },
  '1766': { root: '0375', parent: '1765', note: '發源機要釋涅槃玄義' },
  '1767': { root: '0375' },
  '1774': { root: '0452', conf: 'medium', note: '三彌勒經（上生／下生／成佛），暫掛上生經' },
  '1777': { root: '0475' },
  '1778': { root: '0475' },
  '1779': { root: '0475', parent: '1778', note: '垂裕記釋維摩略疏' },
  '1780': { root: '0475', note: '淨名＝維摩' },
  '1781': { root: '0475' },
  '1783': { root: '0663' },
  '1784': { root: '0663', parent: '1783', note: '拾遺記釋金光明玄義' },
  '1785': { root: '0663' },
  '1786': { root: '0663', parent: '1785', note: '文句記釋金光明文句' },
  '1797': { root: '0848', note: '大日經供養次第法' },
  '1800': { root: '1043' },
  '1801': { root: '1043', parent: '1800', note: '闡義鈔釋請觀音經疏' },
  // ── 續經疏部（56–61 冊，全部沒有 cf） ──
  '2185': { root: '0353' }, '2186': { root: '0475' },
  '2187': { root: '0262' }, '2188': { root: '0262' }, '2189': { root: '0262' },
  '2190': { root: '0262' }, '2191': { root: '0262' }, '2192': { root: '0262' },
  '2193': { root: '0276' }, '2194': { root: '0277' },
  '2195': { root: '0262', note: '附無量義經、普賢經開示抄' },
  '2196': { root: '0665' }, '2197': { root: '0665' }, '2198': { root: '0665' }, '2199': { root: '0665' },
  '2200': { root: '0246' }, '2201': { root: '0235' },
  '2202': { root: '0251' }, '2204': { root: '0251' },
  '2205': { root: '0279', parent: '1736', note: '纂釋釋華嚴演義鈔' },
  '2207': { root: '0360', note: '淨土三部（無量壽／觀經／阿彌陀）' },
  '2209': { root: '0365', parent: '1750', note: '傳通記釋觀經疏' },
  '2210': { root: '0366' },
  '2211': { root: '0848' }, '2212': { root: '0848' },
  '2213': { root: '0848', parent: '1796' }, '2214': { root: '0848', parent: '2213' },
  '2215': { root: '0848', parent: '1796' }, '2216': { root: '0848', parent: '1796' },
  '2217': { root: '0848', parent: '1796' }, '2218': { root: '0848', parent: '1796' },
  '2219': { root: '0848', parent: '1796' }, '2220': { root: '0848', parent: '1797' },
  '2221': { root: '0865' }, '2222': { root: '0865' }, '2223': { root: '0865' },
  '2224': { root: '0865' }, '2225': { root: '0865', parent: '2223' }, '2226': { root: '0865' },
  '2227': { root: '0893a' }, '2228': { root: '0867' }, '2229': { root: '0867', parent: '2228' },
  '2230': { root: '1008' },
  '2231': { root: '0848', conf: 'low', note: '儀軌解釋，非直接釋經' },
  '2232': { root: '0865', conf: 'low', note: '題名未能確指所釋' },
  '2233': { root: '0945' }, '2234': { root: '0945' }, '2235': { root: '0945' },
  '2236': { root: '0243' }, '2237': { root: '0243' }, '2238': { root: '0243' }, '2239': { root: '0243' },
  '2240': { root: '0243', parent: '1003' }, '2241': { root: '0243', parent: '1003' },
  '2242': { root: '1153' }, '2243': { root: '1060' }, '2244': { root: '0982' }, '2245': { root: '1092' },
  // ── 論疏部中直接釋經論的五部 ──
  '1816': { root: '0235', parent: '1510a', note: '會釋金剛般若論' },
  '1817': { root: '0235', parent: '1510a', note: '般若末後一頌' },
  '1818': { root: '0262', parent: '1519', note: '法華論疏' },
  '1819': { root: '0360', parent: '1524', note: '願生偈註' },
  '1820': { root: '0389', parent: '1529', note: '遺教經論疏節要' },
  // ── 論疏部（1821–1850，其餘 30 部） ──
  '1823': { root: '1558', note: '頌疏釋俱舍論本頌' },
  '1825': { root: '1568' },
  '1826': { root: '1568' },
  '1828': { root: '1579' },
  '1832': { root: '1585' },
  '1845': { root: '1666' },
  '1846': { root: '1666' },
  '1847': { root: '1666', parent: '1846', note: '義記別記' },
  '1848': { root: '1666', parent: '1846', note: '筆削記刪主義記' },
  // ── 續論疏部（62–69 冊；2246–2248 是律疏，不列入） ──
  '2249': { root: '1558' }, '2250': { root: '1558' }, '2251': { root: '1558' }, '2252': { root: '1558' },
  '2253': { root: '1558', parent: '1823' }, '2254': { root: '1558', parent: '1823' },
  '2255': { root: '1564', parent: '1824' }, '2256': { root: '1564' },
  '2257': { root: '1568', parent: '1825' },
  '2258': { root: '1578', note: '掌珍量噵' },
  '2259': { root: '1579' },
  '2260': { root: '1585', parent: '1830' }, '2261': { root: '1585', parent: '1832' },
  '2262': { root: '1585' }, '2263': { root: '1585' }, '2264': { root: '1585' },
  '2265': { root: '1585' }, '2266': { root: '1585', parent: '1830' }, '2267': { root: '1585' },
  '2268': { root: '1586', note: '注三十頌' },
  '2269': { root: '1595' },
  '2270': { root: '1630', parent: '1840' }, '2271': { root: '1630', parent: '1840' },
  '2272': { root: '1630', parent: '1840' }, '2273': { root: '1630', parent: '1840' },
  '2274': { root: '1630', parent: '1840' }, '2275': { root: '1630' },
  '2276': { root: '1630', parent: '1840' }, '2277': { root: '1630' }, '2278': { root: '1630' },
  '2279': { root: '1630', parent: '1842' }, '2280': { root: '1630', parent: '1840' },
  '2281': { root: '1630', conf: 'low', note: '明本抄，因明類，暫掛因明入正理論' },
  '2282': { root: '1630', conf: 'low', note: '明要抄，因明類，暫掛因明入正理論' },
  '2283': { root: '1666' },
  '1668': { root: '1666', note: '釋摩訶衍論，釋起信論' },
  '2284': { root: '1666', parent: '1668' }, '2285': { root: '1666', parent: '1668' },
  '2286': { root: '1666', parent: '1668' }, '2287': { root: '1666', parent: '1668' },
  '2288': { root: '1666', parent: '1668' }, '2289': { root: '1666', parent: '1668' },
  '2290': { root: '1666', parent: '1668' },
  // ── 古逸部（沒有 cf 的） ──
  '2766': { root: '0449', conf: 'medium', note: '藥師經疏，疑與 T449 同本' },
  '2785': { root: '0772', parent: '1535', note: '大乘四法經論廣釋開決記' },
  '2804': { root: '1586', note: '唯識三十論要釋' },
  '2806': { root: '1595', conf: 'medium', note: '攝大乘論類抄，暫掛攝大乘論釋' },
  '2807': { root: '1595', conf: 'medium', note: '攝大乘論類抄，暫掛攝大乘論釋' },
  '2808': { root: '1595', conf: 'medium', note: '攝大乘論類抄，暫掛攝大乘論釋' },
  '2809': { root: '1595', conf: 'medium', note: '攝大乘論類抄，暫掛攝大乘論釋' },
  // ── 律疏部／續律疏部／古逸律疏 ──
  '1804': { root: '1428', note: '四分律刪繁補闕行事鈔' },
  '1805': { root: '1428', parent: '1804', note: '資持記釋行事鈔' },
  '1806': { root: '1429', note: '四分律比丘含注戒本' },
  '1807': { root: '1429', note: '四分比丘戒本疏' },
  '1808': { root: '1428', note: '四分律刪補隨機羯磨' },
  '1809': { root: '1428', note: '僧羯磨' },
  '1810': { root: '1428', note: '尼羯磨' },
  '2246': { root: '1484', note: '梵網經開題' },
  '2247': { root: '1484', parent: '1813', note: '日珠鈔釋梵網經菩薩戒本疏' },
  '2248': { root: '1428', parent: '1805', note: '資行鈔釋資持記' },
  '2787': { root: '1429', parent: '1806', note: '四分戒本疏，cf 1429/1806' },
  '2788': { root: '1429', conf: 'medium', note: '律戒本疏，暫掛四分律比丘戒本' },
  '2789': { root: '1429', conf: 'medium', note: '律戒本疏，暫掛四分律比丘戒本' },
  '1003': { root: '0243', note: '理趣釋（密教部）' },
};

/** cf 指到另一部註疏時：cf 經號 → 應繼承的根本經／論 */
const CF_PARENT: Record<string, string> = {
  '1511': '0235', '1519': '0262', '1522': '0287', '1535': '0772', '1775': '0475',
  '1823': '1558', '1824': '1564', '1825': '1568', '1830': '1585', '1832': '1585',
  '1840': '1630', '1842': '1630', '1846': '1666', '1668': '1666',
  '2733': '0235', '2777': '0475', '2782': '0712', '2810': '1614', '1864': '1864',
};

/** 古逸部中確定是註疏的作品（其餘疑偽經、史傳、儀文不列入） */
const GUYI_TARGETS = new Set([
  '2732', '2733', '2734', '2735', '2736', '2737', '2738', '2739', '2740', '2741',
  '2744', '2745', '2746', '2747', '2748', '2749', '2750', '2751', '2752',
  '2753', '2754', '2755', '2756', '2757', '2758', '2759', '2760', '2761', '2762', '2763',
  '2764a', '2764b', '2765', '2766', '2767', '2768', '2769', '2770', '2771', '2772',
  '2773', '2774', '2775', '2776', '2777', '2778', '2780', '2781', '2782', '2783',
  '2784', '2785', '2786', '2797', '2798', '2799', '2800', '2801', '2802', '2803',
  '2804', '2805', '2806', '2807', '2808', '2809', '2810', '2811', '2812', '2813',
  '2814', '2815', '2816', '2823', '2902',
  '2787', '2788', '2789',
]);

/** 續律疏部（T62；不在續論疏的範圍） */
const LVSHU_TARGETS = new Set(['2246', '2247', '2248']);

/** 諸宗部中確定是「註疏」的作品（其餘多為獨立論書、語錄、儀軌） */
const ZONG_TARGETS = new Set(['1859', '1860', '1887b', '1912', '1921', '1928']);

/** 額外納入的根節點（本身不是註疏，但被引用；或使用者點名要看） */
const EXTRA_ROOTS: { no: string; note?: string }[] = [
  { no: '0675', note: '解深密經異譯' },
  { no: '0676', note: '大正藏無註疏；卍續藏 X21 有圓測疏' },
  { no: '1003', note: '理趣釋，釋大樂金剛不空真實三麼耶經' },
];

const isTarget = (b: Book) =>
  b.bu === '釋經論部' || b.bu === '經疏部' || b.bu === '論疏部' || b.bu === '律疏部' ||
  (b.vol >= 56 && b.vol <= 61) ||
  (b.vol >= 62 && b.vol <= 69 && !['2246', '2247', '2248'].includes(b.no)) ||
  GUYI_TARGETS.has(b.no) || ZONG_TARGETS.has(b.no) || LVSHU_TARGETS.has(b.no) ||
  ['1816', '1817', '1818', '1819', '1820', '1003', '1668'].includes(b.no);

/** 由題名取體裁（長的先比） */
const GENRES = [
  '憂波提舍', '優波提舍', '優婆提舍', '義疏', '略疏', '疏', '註解', '註', '注', '大意', '玄義', '文句',
  '義記', '集解', '贊述', '述讚', '玄贊', '宗要', '遊意', '要解', '通贊疏', '古迹', '寶窟',
  '連義述文贊', '決疑論', '頌釋章', '骨目', '略策', '玄樞', '註釋', '羽足', '開題', '祕釋',
  '私記', '傳通記', '連珠記', '刊定記', '垂裕記', '拾遺記', '神寶記', '闡義鈔', '演義鈔',
  '纂釋', '妙印鈔', '演奧鈔', '指心鈔', '疏鈔', '口傳', '集成編', '深意鈔', '融貫鈔',
  '同學鈔', '本義抄', '法義', '疏記', '節要', '會釋', '義決', '略記',
  '釋籤', '述義', '指歸', '偈釋', '文次第', '勘註', '顯義抄', '略抄', '記', '抄', '儀',
  '讚述', '纂要', '幽贊', '方軌', '妙宗鈔', '機要', '釋文', '開門訣', '音義集', '音義',
  '修行法', '義釋', '種子釋', '衆釋', '義訣', '論釋', '論頌', '贊', '釋',
];
const normTitle = (t: string) => t.replace(/\(第\d+卷-第\d+卷\)/g, '').trim();
const genreOf = (raw: string): string => {
  const title = normTitle(raw);
  if (/^[註注]/.test(title)) return '注';
  if (title.includes('疏注經')) return '注';
  if (title.endsWith('略敘') || title.endsWith('大意')) return '大意';
  if (title.endsWith('玄義一部')) return '玄義';
  for (const g of GENRES) if (title.endsWith(g)) return g;
  if (title.endsWith('論') || title.endsWith('釋論')) return '論';
  if (title.endsWith('經')) return '經';
  return '其他';
};
const rootClass = (b: Book): '經' | '論' | '律' => {
  const t = normTitle(b.title);
  if (b.bu === '諸宗部') return '論';                 // 肇論、摩訶止觀、十不二門…
  if (b.bu === '律部' && /(律|戒本|羯磨|戒經)$/.test(t)) return '律';
  if (t.endsWith('經')) return '經';
  if (b.bu === '釋經論部') return '論';
  return /論/.test(t) || /(憂波提舍|優波提舍|釋)$/.test(t) ? '論' : '經';
};

/** 同題異本的版本提示（題名一樣時靠這個分辨） */
const EDITION_NOTES: Record<string, string> = {
  '0220': '六百卷（三冊）', '0223': '大品般若', '0236a': '同本異卷', '0236b': '同本異卷',
  '0278': '六十華嚴', '0279': '八十華嚴', '0374': '北本', '0375': '南本',
  '0663': '四卷本', '0665': '十卷本', '0670': '四卷本', '0671': '十卷本', '0672': '七卷本',
  '0675': '異譯', '0893a': '三卷', '0893b': '三卷', '0893c': '三卷',
};

interface Node {
  key: string; idx: number; no: string; vol: number; title: string; author: string; genre: string;
  depth: number; cls: '經' | '論' | '律' | '注' | '疏'; parent: string; root: string;
  family: string; conf: string; evidence: string; note: string;
}

const nodes = new Map<string, Node>();
const nodeKey = (no: string) => normNo(no);

function addBook(b: Book, opts: { depth: number; parent: string; root: string; conf: string; evidence: string; note?: string }) {
  const key = nodeKey(b.no);
  const cls: Node['cls'] = opts.depth === 0
    ? rootClass(b)
    : opts.depth === 1 ? '注' : '疏';
  nodes.set(key, {
    key, idx: b.idx, no: b.no, vol: b.vol, title: b.title, author: b.author, genre: genreOf(b.title),
    depth: opts.depth, cls, parent: opts.parent, root: opts.root,
    family: rootToFamily.get(nodeKey(opts.root)) ?? (opts.depth === 0 ? `f_${nodeKey(b.no)}` : 'f_other'),
    conf: opts.conf, evidence: opts.evidence,
    note: [EDITION_NOTES[b.no], opts.note].filter(Boolean).join('；'),
  });
}

// 1) 先把所有 target 作品建節點（parent 稍後解析）
const targets = CAT.filter(isTarget);
const pending: { b: Book; root: string; parent: string; conf: string; evidence: string; note: string }[] = [];
for (const b of targets) {
  const man = MANUAL[b.no];
  const cf = CF.get(b.root) ?? '';
  let root = man?.root ?? '';
  let parent = man?.parent ?? '';
  let conf = man?.conf ?? 'high';
  let evidence = man ? 'manual' : '';
  let note = man?.note ?? '';
  if (!man && cf) {
    const tgt = bookOf(cf);
    if (tgt) {
      const cpRoot = CF_PARENT[normNo(tgt.no)];
      if (cpRoot) {
        // cf 指到另一部註疏：它是 parent，root 再往上繼承
        root = cpRoot; parent = tgt.no; evidence = `cf:No.${cf}`;
      } else if (!['1517', '1518'].includes(tgt.no)) {
        root = tgt.no; evidence = `cf:No.${cf}`;
      }
    }
  }
  // 獨立論書／經缺：自己就是根
  if (man && !man.root) {
    root = b.no;
    if (!note.includes('獨立')) note = (note ? note + '；' : '') + '獨立（無本經）';
  }
  root = canonNo(root);
  if (!parent) parent = root;
  pending.push({ b, root, parent, conf, evidence: evidence || 'todo', note });
}

// 2) 把 root 節點補進來
const rootNos = new Set<string>();
for (const p of pending) if (p.root) rootNos.add(nodeKey(p.root));
for (const e of EXTRA_ROOTS) rootNos.add(nodeKey(e.no));
const pendingByNo = new Map(pending.map((p) => [normNo(p.b.no), p]));
for (const no of rootNos) {
  if (nodes.has(no)) continue;
  const b = bookOf(no);
  if (!b) { console.warn('missing root', no); continue; }
  const extra = EXTRA_ROOTS.find((e) => nodeKey(e.no) === no);
  const p = pendingByNo.get(no);
  addBook(b, {
    depth: 0, parent: '', root: b.no,
    conf: p?.conf ?? 'high', evidence: p?.evidence ?? 'root',
    note: [p?.note, extra?.note].filter(Boolean).join('；'),
  });
}

// 2b) 同一族的其他譯本即使沒有註疏，也補成根節點（顯示用）
for (const f of Object.values(FAMILIES)) {
  for (const rno of f.roots) {
    if (nodes.has(nodeKey(rno))) continue;
    const b = bookOf(rno);
    if (b) addBook(b, { depth: 0, parent: '', root: b.no, conf: 'high', evidence: 'root' });
  }
}

// 3) 建 target 節點（parent 可能還不是節點，稍後補）
for (const p of pending) {
  if (p.b.no === p.root) continue;
  const parentNode = nodes.get(nodeKey(p.parent));
  const depth = parentNode ? parentNode.depth + 1 : 1;
  addBook(p.b, { depth, parent: p.parent, root: p.root, conf: p.conf, evidence: p.evidence, note: p.note });
}

// 4) 補 parent 節點（例如 1041 理趣釋），再重算 depth / class
for (let round = 0; round < 5; round++) {
  let changed = false;
  for (const n of nodes.values()) {
    if (!n.parent || nodes.has(nodeKey(n.parent)) || nodeKey(n.parent) === nodeKey(n.no)) continue;
    const b = bookOf(n.parent);
    if (!b) { console.warn('missing parent', n.parent, 'for', n.no); continue; }
    const pn = [...nodes.values()].find((x) => nodeKey(x.no) === nodeKey(n.parent));
    addBook(b, { depth: (pn?.depth ?? 0) + 1, parent: pn?.parent ?? '', root: n.root, conf: 'high', evidence: 'parent-of', note: '' });
    changed = true;
  }
  if (!changed) break;
}
// 重算 depth
for (let round = 0; round < 8; round++) {
  let changed = false;
  for (const n of nodes.values()) {
    if (!n.parent) { if (n.depth !== 0) { n.depth = 0; changed = true; } continue; }
    const p = nodes.get(nodeKey(n.parent));
    if (p && n.depth !== p.depth + 1) { n.depth = p.depth + 1; changed = true; }
  }
  if (!changed) break;
}
for (const n of nodes.values()) {
  const b = bookOf(n.no);
  n.cls = n.depth === 0 ? (b ? rootClass(b) : '經') : n.depth === 1 ? '注' : '疏';
}

// 5) 檢查
const problems: string[] = [];
for (const n of nodes.values()) {
  if (n.depth > 0 && !nodes.has(nodeKey(n.parent))) problems.push(`${n.no} 缺 parent ${n.parent}`);
  if (n.depth > 0 && !nodes.has(nodeKey(n.root))) problems.push(`${n.no} 缺 root ${n.root}`);
  // 循環
  let cur = n, hops = 0;
  while (cur.parent && hops++ < 20) {
    const p = nodes.get(nodeKey(cur.parent));
    if (!p) break;
    if (nodeKey(p.no) === nodeKey(n.no)) { problems.push(`${n.no} 循環`); break; }
    cur = p;
  }
}
console.log(`nodes=${nodes.size} problems=${problems.length}`);
if (problems.length) console.log(problems.slice(0, 20).join('\n'));

// 6) 輸出 TSV（family → root → 樹狀深度優先）
const famOrder = new Map(Object.keys(FAMILIES).map((f, i) => [f, i]));
const dispTitle = (t: string) => t.replace(/\(第\d+卷-第\d+卷\)/g, '').trim();
const list: Node[] = [];
const seen = new Set<string>();
const walk = (n: Node) => {
  if (seen.has(n.key)) return;
  seen.add(n.key);
  list.push(n);
  const kids = [...nodes.values()].filter((c) => c.parent && nodeKey(c.parent) === n.key)
    .sort((a, b) => a.idx - b.idx);
  for (const c of kids) walk(c);
};
for (const fid of Object.keys(FAMILIES)) {
  for (const rno of FAMILIES[fid].roots) {
    const r = nodes.get(nodeKey(rno));
    if (r) walk(r);
  }
}
for (const n of nodes.values()) if (!seen.has(n.key)) walk(n);
const head = ['family', 'family_label', 'class', 'depth', 'idx', 'no', 'vol', 'title', 'author', 'genre', 'parent_no', 'parent_title', 'root_no', 'root_title', 'conf', 'evidence', 'note'];
const lines = [head.join('\t')];
for (const n of list) {
  const parentNode = nodes.get(nodeKey(n.parent));
  const rootNode = nodes.get(nodeKey(n.root));
  lines.push([
    n.family, FAMILIES[n.family]?.label ?? n.family, n.cls, n.depth, n.idx, n.no, n.vol,
    dispTitle(n.title), n.author, n.genre, n.parent, parentNode ? dispTitle(parentNode.title) : '',
    n.root, rootNode ? dispTitle(rootNode.title) : '',
    n.conf, n.evidence, n.note,
  ].join('\t'));
}
writeFileSync(join(HERE, 'jingqun.tsv'), lines.join('\n') + '\n');

// 7) 輸出巢狀 JSON
interface JNode { no: string; idx: number; title: string; author: string; genre: string; cls: string; depth: number; conf: string; evidence: string; note?: string; children: JNode[] }
const groups: { family: string; label: string; roots: JNode[] }[] = [];
for (const [fid, f] of Object.entries(FAMILIES)) {
  const roots: JNode[] = [];
  for (const rno of f.roots) {
    const r = nodes.get(nodeKey(rno));
    if (!r) continue;
    const build = (n: Node): JNode => ({
      no: n.no, idx: n.idx, title: dispTitle(n.title), author: n.author, genre: n.genre, cls: n.cls, depth: n.depth,
      conf: n.conf, evidence: n.evidence, note: n.note || undefined,
      children: [...nodes.values()].filter((c) => c.parent && nodeKey(c.parent) === nodeKey(n.no))
        .sort((a, b) => a.idx - b.idx).map(build),
    });
    roots.push(build(r));
  }
  if (roots.length) groups.push({ family: fid, label: f.label, roots });
}
writeFileSync(join(ROOT, 'build/jingqun/jingqun.json'), JSON.stringify(groups, null, 2));

// 8) 統計
const stat = (pred: (n: Node) => boolean) => list.filter(pred).length;
console.log(`TSV rows=${list.length}`);
console.log(`經=${stat((n) => n.cls === '經')} 注=${stat((n) => n.cls === '注')} 疏=${stat((n) => n.cls === '疏')}`);
console.log(`depth1=${stat((n) => n.depth === 1)} depth2=${stat((n) => n.depth === 2)} depth3=${stat((n) => n.depth === 3)}`);
console.log(`families=${groups.length}`);


