/**
 * 悉曇字／蘭札字測試頁的資料（作者 2026-10-31）。
 *
 * 經文取自 CBETA XML-P5：
 *   T21n1213_p0072b08《千臂軍荼利梵字真言》
 *   X23n0446_p0762b05《七俱胝佛母所說準提陀羅尼經會釋》蘭札字段落（0762b05–0762b08）
 *
 * 字型碼位規則（cbeta_gaiji/cbeta_sanskrit.csv）：
 *   SD-XXXX → U+FA000 + XXXX（Unicode 第 16 平面私用區）
 *   RJ-XXXX → U+100000 + XXXX（同上）
 * 這裏用 ⟦SD-XXXX⟧ 佔位，執行時換成 PUA 字元；原始 TS 不藏不可見字元。
 */

export interface SanskritSample {
  font: 'siddham' | 'ranjana';
  title: string;
  source: string;
  url: string;
  lines: string[];
}

export const SANSKRIT_SAMPLES: SanskritSample[] = [
  {
    font: 'siddham',
    title: '千臂軍荼利梵字真言',
    source: 'T21n1213_p0072b08',
    url: 'https://cbetaonline.dila.edu.tw/zh-tw/T21n1213_p0072b08',
    lines: [
      "⟦SD-D5B5⟧⟦SD-A5A9⟧⟦SD-A5ED⟧⟦SD-A5FD⟧⟦SD-B448⟧⟦SD-AA5E⟧⟦SD-A5F2⟧⟦SD-A5F1⟧⟦SD-D7C4⟧⟦SD-A5A9⟧⟦SD-A5F0⟧⟦SD-E0BD⟧⟦SD-C9FD⟧⟦SD-A656⟧",
      "⟦SD-A9BD⟧⟦SD-A5B6⟧⟦SD-A54B⟧⟦SD-A5F7⟧⟦SD-D7C4⟧⟦SD-A5E5⟧⟦SD-A6A9⟧⟦SD-A5F1⟧⟦SD-A6B4⟧⟦SD-A6A2⟧⟦SD-A5AA⟧⟦SD-A5B5⟧⟦SD-A557⟧⟦SD-A5F7⟧",
      "⟦SD-D7C4⟧⟦SD-A5A9⟧⟦SD-A5ED⟧⟦SD-A656⟧⟦SD-A9BD⟧⟦SD-A94F⟧⟦SD-A57B⟧⟦SD-A5F1⟧⟦SD-D7C4⟧⟦SD-A5AB⟧⟦SD-A7D7⟧⟦SD-AABC⟧⟦SD-AABC⟧⟦SD-E04A⟧",
      "⟦SD-A64C⟧⟦SD-A557⟧⟦SD-A572⟧⟦SD-CF55⟧⟦SD-D7C4⟧⟦SD-A656⟧⟦SD-A9BD⟧⟦SD-A440⟧⟦SD-A5FE⟧⟦SD-A5F1⟧⟦SD-D7C4⟧⟦SD-CFC9⟧⟦SD-A440⟧⟦SD-A5FD⟧",
      "⟦SD-A579⟧⟦SD-E1F8⟧⟦SD-E1A3⟧⟦SD-A4DA⟧⟦SD-A5D9⟧⟦SD-A5F1⟧⟦SD-D7C4⟧⟦SD-A5E0⟧⟦SD-A5FD⟧⟦SD-A657⟧⟦SD-A5F1⟧⟦SD-D7C4⟧⟦SD-CFC5⟧⟦SD-A67C⟧",
      "⟦SD-E043⟧⟦SD-A67A⟧⟦SD-A64A⟧⟦SD-D7C4⟧⟦SD-E3AD⟧⟦SD-D9F9⟧⟦SD-A95F⟧⟦SD-A662⟧⟦SD-E04D⟧⟦SD-D7C4⟧⟦SD-A66A⟧⟦SD-A64A⟧⟦SD-A5B5⟧⟦SD-A5FD⟧",
      "⟦SD-A66A⟧⟦SD-A5B6⟧⟦SD-A662⟧⟦SD-A6A8⟧⟦SD-CDAA⟧⟦SD-A5F1⟧⟦SD-D7C4⟧⟦SD-A656⟧⟦SD-A9BD⟧⟦SD-A440⟧⟦SD-A5A9⟧⟦SD-A441⟧⟦SD-D7C4⟧⟦SD-A656⟧",
      "⟦SD-A9BD⟧⟦SD-A65D⟧⟦SD-A55C⟧⟦SD-B769⟧⟦SD-D7C4⟧⟦SD-A64C⟧⟦SD-CBA7⟧⟦SD-CF56⟧⟦SD-A662⟧⟦SD-A640⟧⟦SD-A64B⟧⟦SD-A5F1⟧⟦SD-D7C4⟧⟦SD-A67A⟧",
      "⟦SD-B7A3⟧⟦SD-A5AA⟧⟦SD-A458⟧⟦SD-A5F1⟧⟦SD-A6B4⟧⟦SD-A5FD⟧⟦SD-A6B4⟧⟦SD-A67B⟧⟦SD-D7C4⟧⟦SD-CFC5⟧⟦SD-E0BC⟧⟦SD-A5FD⟧⟦SD-AAC2⟧⟦SD-A557⟧",
      "⟦SD-D7C4⟧⟦SD-A5B7⟧⟦SD-A663⟧⟦SD-A47C⟧⟦SD-A658⟧⟦SD-B355⟧⟦SD-D7C4⟧⟦SD-A658⟧⟦SD-A5A9⟧⟦SD-A5F1⟧⟦SD-A440⟧⟦SD-A4B8⟧⟦SD-A658⟧⟦SD-E040⟧",
      "⟦SD-A557⟧⟦SD-A440⟧⟦SD-A5FE⟧⟦SD-A5F1⟧⟦SD-D7C4⟧⟦SD-A557⟧⟦SD-DA4A⟧⟦SD-A564⟧⟦SD-E074⟧⟦SD-CFC5⟧⟦SD-DA78⟧⟦SD-A557⟧⟦SD-A444⟧⟦SD-C9FD⟧",
      "⟦SD-A64C⟧⟦SD-D7C4⟧⟦SD-E0AA⟧⟦SD-A64C⟧⟦SD-D957⟧⟦SD-D7C4⟧⟦SD-E1D3⟧⟦SD-A64E⟧⟦SD-D957⟧⟦SD-E043⟧⟦SD-A64E⟧⟦SD-D957⟧⟦SD-D7C4⟧⟦SD-A6A8⟧",
      "⟦SD-A5A9⟧⟦SD-D957⟧⟦SD-A56F⟧⟦SD-A6A8⟧⟦SD-D957⟧⟦SD-D7C4⟧⟦SD-A5B5⟧⟦SD-A47C⟧⟦SD-D957⟧⟦SD-D7C4⟧⟦SD-A5E5⟧⟦SD-A563⟧⟦SD-A444⟧⟦SD-C9FD⟧",
      "⟦SD-A64C⟧⟦SD-D7C4⟧⟦SD-E1F0⟧⟦SD-C0A6⟧⟦SD-A5B3⟧⟦SD-A557⟧⟦SD-A54C⟧⟦SD-A5F1⟧⟦SD-D7C4⟧⟦SD-A656⟧⟦SD-A9C5⟧⟦SD-A54B⟧⟦SD-D7C4⟧⟦SD-DA74⟧",
      "⟦SD-CFC1⟧⟦SD-CFC1⟧⟦SD-CFC1⟧⟦SD-CFC1⟧⟦SD-CFC1⟧⟦SD-D7C4⟧⟦SD-A5C1⟧⟦SD-E046⟧⟦SD-D957⟧⟦SD-A5C1⟧⟦SD-E046⟧⟦SD-D957⟧⟦SD-A5C1⟧⟦SD-E046⟧",
      "⟦SD-A5C1⟧⟦SD-E046⟧⟦SD-D957⟧⟦SD-D7C4⟧⟦SD-A94F⟧⟦SD-A57B⟧⟦SD-B349⟧⟦SD-A5F1⟧⟦SD-A444⟧⟦SD-A642⟧⟦SD-D957⟧⟦SD-D7C4⟧⟦SD-E0BC⟧⟦SD-A642⟧",
      "⟦SD-D957⟧⟦SD-A55B⟧⟦SD-A642⟧⟦SD-D957⟧⟦SD-D7C4⟧⟦SD-A6A8⟧⟦SD-A6A8⟧⟦SD-A6A8⟧⟦SD-D7C4⟧⟦SD-A6AA⟧⟦SD-A6AA⟧⟦SD-A6AA⟧⟦SD-D7C4⟧⟦SD-E0AA⟧",
      "⟦SD-E0AA⟧⟦SD-E0AA⟧⟦SD-A67C⟧⟦SD-E1E3⟧⟦SD-A55B⟧⟦SD-D7C4⟧⟦SD-A5E5⟧⟦SD-E04B⟧⟦SD-A5B5⟧⟦SD-A56F⟧⟦SD-B065⟧⟦SD-A6A9⟧⟦SD-D5B4⟧",
    ],
  },
  {
    font: 'ranjana',
    title: '七俱胝佛母所說準提陀羅尼經會釋',
    source: 'X23n0446_p0762b05',
    url: 'https://cbetaonline.dila.edu.tw/zh-tw/X23n0446_p0762b05',
    lines: [
      "想⟦RJ-CCBA⟧唵字安於頂，以大拇指觸頭上。",
      "次想⟦RJ-C977⟧左字（即者字），兩目瞳人上俱。",
      "想⟦RJ-CBC2⟧禮字，復以大拇指觸左右眼上。",
      "次想⟦RJ-C9BD⟧祖字（即主字）安於頸上，用大拇指觸。",
      "次想⟦RJ-CBC2⟧禮字當心，以大拇指觸。",
    ],
  },
]

/** 只收錄測試頁用到的梵字（ID → IAST 羅馬拼音）。 */export const SANSKRIT_ROMAN: Record<string, string> = {
  "SD-A5A9": "na",
  "SD-A5ED": "mo",
  "SD-A5FD": "ra",
  "SD-B448": "tna",
  "SD-AA5E": "tra",
  "SD-A5F2": "yā",
  "SD-A5F1": "ya",
  "SD-A5F0": "maḥ",
  "SD-E0BD": "śca",
  "SD-C9FD": "ṇḍa",
  "SD-A656": "va",
  "SD-A9BD": "jra",
  "SD-A5B6": "pā",
  "SD-A54B": "ṇa",
  "SD-A5F7": "ye",
  "SD-A5E5": "ma",
  "SD-A6A9": "hā",
  "SD-A6B4": "kṣa",
  "SD-A6A2": "se",
  "SD-A5AA": "nā",
  "SD-A5B5": "pa",
  "SD-A557": "ta",
  "SD-A94F": "kro",
  "SD-A57B": "dha",
  "SD-A5AB": "ni",
  "SD-A7D7": "tya",
  "SD-AABC": "pra",
  "SD-E04A": "jvā",
  "SD-A64C": "li",
  "SD-A572": "dī",
  "SD-CF55": "tta",
  "SD-A440": "ka",
  "SD-A5FE": "rā",
  "SD-CFC9": "u",
  "SD-A579": "daṃ",
  "SD-E1F8": "ṣṭre",
  "SD-E1A3": "tka",
  "SD-A4DA": "ṭa",
  "SD-A5D9": "bha",
  "SD-A5E0": "bhai",
  "SD-A657": "vā",
  "SD-CFC5": "a",
  "SD-A67C": "si",
  "SD-E043": "mu",
  "SD-A67A": "sa",
  "SD-A64A": "la",
  "SD-E3AD": "bu",
  "SD-D9F9": "ddha",
  "SD-A95F": "gra",
  "SD-A662": "śa",
  "SD-E04D": "kti",
  "SD-A66A": "śo",
  "SD-A6A8": "ha",
  "SD-CDAA": "stā",
  "SD-A441": "kā",
  "SD-A65D": "vai",
  "SD-A55C": "tū",
  "SD-B769": "rya",
  "SD-CBA7": "kṛ",
  "SD-CF56": "ttā",
  "SD-A640": "ri",
  "SD-A64B": "lā",
  "SD-B7A3": "rva",
  "SD-A458": "ga",
  "SD-A67B": "sā",
  "SD-E0BC": "su",
  "SD-AAC2": "pre",
  "SD-A5B7": "pi",
  "SD-A663": "śā",
  "SD-A47C": "ca",
  "SD-A658": "vi",
  "SD-B355": "ghna",
  "SD-A4B8": "ji",
  "SD-E040": "nāṃ",
  "SD-DA4A": "dya",
  "SD-A564": "thā",
  "SD-E074": "oṃ",
  "SD-DA78": "mṛ",
  "SD-A444": "ku",
  "SD-E0AA": "hu",
  "SD-E1D3": "cu",
  "SD-A64E": "lu",
  "SD-A56F": "da",
  "SD-A563": "tha",
  "SD-E1F0": "mū",
  "SD-C0A6": "rtva",
  "SD-A5B3": "naṃ",
  "SD-A54C": "ṇā",
  "SD-A9C5": "jro",
  "SD-DA74": "hūṃ",
  "SD-CFC1": "hūṃ",
  "SD-A5C1": "pha",
  "SD-E046": "ṭ",
  "SD-B349": "gna",
  "SD-A642": "ru",
  "SD-A55B": "tu",
  "SD-A6AA": "hi",
  "SD-E1E3": "ddhyaṃ",
  "SD-E04B": "ndra",
  "SD-B065": "svā",
  "RJ-CCBA": "oṃ",
  "RJ-C977": "ca",
  "RJ-CBC2": "le",
  "RJ-C9BD": "cu",
};

/**
 * Noto 排不出來的 81 個 CBETA 悉曇字（沒有 romanized 或是兩個音節）。
 * 字形從 CBETA 的 `Siddam.ttf` 抽出，做成 12.1 KiB 的補充字型（2026-11-01）。
 */
export const EXTRA_GAIJI: string[] = [
  'SD-CFC2', 'SD-CFC3', 'SD-CFC4', 'SD-D5B4', 'SD-D5B5', 'SD-D7C4', 'SD-D7FE', 'SD-D950',
  'SD-D953', 'SD-D957', 'SD-D959', 'SD-D95B', 'SD-D9C6', 'SD-D9D9', 'SD-DA53', 'SD-E046',
  'SD-E058', 'SD-E06D', 'SD-E076', 'SD-E0B4', 'SD-E0F9', 'SD-E140', 'SD-E14D', 'SD-E152',
  'SD-E15D', 'SD-E165', 'SD-E167', 'SD-E242', 'SD-E275', 'SD-E2BC', 'SD-E2BD', 'SD-E2C4',
  'SD-E2D4', 'SD-E2D7', 'SD-E341', 'SD-E347', 'SD-E349', 'SD-E355', 'SD-E35A', 'SD-E35B',
  'SD-E36C', 'SD-E36D', 'SD-E377', 'SD-E378', 'SD-E37D', 'SD-E3BA', 'SD-E3BE', 'SD-E3C0',
  'SD-E3C2', 'SD-E3E6', 'SD-E3F0', 'SD-E459', 'SD-E463', 'SD-E46E', 'SD-E470', 'SD-E47A',
  'SD-E47B', 'SD-E47D', 'SD-E47E', 'SD-E4A1', 'SD-E4A3', 'SD-E4A7', 'SD-E4A8', 'SD-E4A9',
  'SD-E4AD', 'SD-E4AF', 'SD-E4B2', 'SD-E4C6', 'SD-E4CB', 'SD-E4CE', 'SD-E4D0', 'SD-E4DE',
  'SD-E4E3', 'SD-E4E5', 'SD-E4E6', 'SD-E4E8', 'SD-E4E9', 'SD-E4EB', 'SD-E4EF', 'SD-E4F0',
  'SD-E4FD',
];

/** 這 81 個字在《悉曇藏》（T84 No. 2702）p0405c 的實際用例。 */
export const EXTRA_SAMPLE = {
  title: '《悉曇藏》',
  source: 'T84n2702_p0405c',
  url: 'https://cbetaonline.dila.edu.tw/zh-tw/T84n2702_p0405c',
  line: '源由字生増干異形⟦SD-CFC4⟧室梨字猶有奢羅之象錯成印文。若篆籕也',
};
