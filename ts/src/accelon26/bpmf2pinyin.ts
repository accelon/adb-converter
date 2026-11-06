// bpmf2pinyin — 注音符號（帶聲調）→ 漢語拼音（帶聲調）。自用轉換表，無外部依賴。
// 無聲調符＝1 聲；ˊ=2 ˇ=3 ˋ=4 ˙=5(輕聲不標)。音節以空格/全形空格分隔；（變）兩讀原樣保留。
// 對齊來源「漢語拼音」欄（含 ueng→weng、ün→yun、iou/ui→uī、iou→iū 等例外）。

const INITIAL: Record<string, string> = {
  'ㄅ': 'b', 'ㄆ': 'p', 'ㄇ': 'm', 'ㄈ': 'f', 'ㄉ': 'd', 'ㄊ': 't', 'ㄋ': 'n', 'ㄌ': 'l',
  'ㄍ': 'g', 'ㄎ': 'k', 'ㄏ': 'h', 'ㄐ': 'j', 'ㄑ': 'q', 'ㄒ': 'x', 'ㄓ': 'zh', 'ㄔ': 'ch',
  'ㄕ': 'sh', 'ㄖ': 'r', 'ㄗ': 'z', 'ㄘ': 'c', 'ㄙ': 's',
};
const MEDIAL: Record<string, 'i' | 'u' | 'ü'> = { 'ㄧ': 'i', 'ㄨ': 'u', 'ㄩ': 'ü' };
// 純韻母（無韻頭）本體
const FIN: Record<string, string> = {
  'ㄚ': 'a', 'ㄛ': 'o', 'ㄜ': 'e', 'ㄝ': 'e', 'ㄞ': 'ai', 'ㄟ': 'ei', 'ㄠ': 'ao', 'ㄡ': 'ou',
  'ㄢ': 'an', 'ㄣ': 'en', 'ㄤ': 'ang', 'ㄥ': 'eng', 'ㄦ': 'er',
};
const TONE: Record<string, number> = { 'ˉ': 1, 'ˊ': 2, 'ˇ': 3, 'ˋ': 4, '˙': 5 };
const VOWELS = 'aeiouü';
const MARKS: Record<string, string> = {
  a1: 'ā', a2: 'á', a3: 'ǎ', a4: 'à',
  e1: 'ē', e2: 'é', e3: 'ě', e4: 'è',
  i1: 'ī', i2: 'í', i3: 'ǐ', i4: 'ì',
  o1: 'ō', o2: 'ó', o3: 'ǒ', o4: 'ò',
  u1: 'ū', u2: 'ú', u3: 'ǔ', u4: 'ù',
  'ü1': 'ǖ', 'ü2': 'ǘ', 'ü3': 'ǚ', 'ü4': 'ǜ',
};
function addTone(syl: string, tone: number): string {
  if (tone === 5) return syl;                      // 輕聲不標；1 聲標 macron（對齊來源）
  let idx = syl.search(/[ae]/);                  // a/e 優先
  if (idx < 0) { const ou = syl.indexOf('ou'); if (ou >= 0) idx = ou; }   // ou 標 o
  if (idx < 0) {                                  // 否則最後一個母音（iu→u、ui→i、in→i）
    let last = -1;
    for (let i = 0; i < syl.length; i++) if (VOWELS.includes(syl[i])) last = i;
    idx = last;
  }
  if (idx < 0) return syl;
  const ch = syl[idx];
  const g = MARKS[ch + tone];
  return g ? syl.slice(0, idx) + g + syl.slice(idx + 1) : syl;
}

// (韻頭, 韻尾bopomofo) → 韻母拼法（有聲母情境；零聲母 y/w 之後另外處理）
function rimeWithMed(med: '' | 'i' | 'u' | 'ü', finB: string): string {
  if (!finB) return '';
  if (med === 'i') return ({ 'ㄚ': 'ia', 'ㄛ': 'io', 'ㄜ': 'ie', 'ㄝ': 'ie', 'ㄠ': 'iao', 'ㄡ': 'iu', 'ㄢ': 'ian', 'ㄣ': 'in', 'ㄤ': 'iang', 'ㄥ': 'ing' }[finB]) ?? FIN[finB];
  if (med === 'u') return ({ 'ㄚ': 'ua', 'ㄛ': 'uo', 'ㄞ': 'uai', 'ㄟ': 'ui', 'ㄡ': 'uou', 'ㄢ': 'uan', 'ㄣ': 'un', 'ㄤ': 'uang', 'ㄥ': 'ong' }[finB]) ?? FIN[finB];
  if (med === 'ü') return ({ 'ㄝ': 'üe', 'ㄢ': 'üan', 'ㄣ': 'ün', 'ㄥ': 'iong' }[finB]) ?? ('ü' + (FIN[finB] || ''));
  return FIN[finB] || '';
}

function one(token: string): string {
  if (!token) return '';
  if (!/[ㄅ-ㄩ]/.test(token)) return token;         // 無注音符號（標點、（一）、來源髒值）原樣保留
  let tone = 1;
  if (token[0] === '˙') { tone = 5; token = token.slice(1); }          // 輕聲點在前（˙ㄌㄜ→le）
  else { const last = token[token.length - 1]; if (last in TONE) { tone = TONE[last]; token = token.slice(0, -1); } }
  let ini = '';
  if (token[0] in INITIAL) { ini = INITIAL[token[0]]; token = token.slice(1); }
  let med: '' | 'i' | 'u' | 'ü' = '';
  if (token[0] in MEDIAL) { med = MEDIAL[token[0]]; token = token.slice(1); }
  const finB = token;

  let syl: string;
  if (!ini) {
    if (!med && !finB) return '';
    if (!med) { syl = FIN[finB] || ''; }                       // a o e ai ao ou an en ang eng er
    else if (med === 'i') syl = !finB ? 'yi' : ({ 'ㄚ': 'ya', 'ㄛ': 'yo', 'ㄜ': 'ye', 'ㄝ': 'ye', 'ㄠ': 'yao', 'ㄡ': 'you', 'ㄢ': 'yan', 'ㄣ': 'yin', 'ㄤ': 'yang', 'ㄥ': 'ying' }[finB]) ?? ('y' + FIN[finB]);
    else if (med === 'u') syl = !finB ? 'wu' : ({ 'ㄚ': 'wa', 'ㄛ': 'wo', 'ㄞ': 'wai', 'ㄟ': 'wei', 'ㄢ': 'wan', 'ㄣ': 'wen', 'ㄤ': 'wang', 'ㄥ': 'weng' }[finB]) ?? ('w' + FIN[finB]);
    else syl = !finB ? 'yu' : ({ 'ㄝ': 'yue', 'ㄢ': 'yuan', 'ㄣ': 'yun', 'ㄥ': 'yong' }[finB]) ?? ('yu' + FIN[finB]);
  } else {
    const empty = (ini === 'zh' || ini === 'ch' || ini === 'sh' || ini === 'r' || ini === 'z' || ini === 'c' || ini === 's');
    if (!med && !finB) syl = ini + (empty ? 'i' : '');          // zhi chi shi ri zi ci si
    else if (med && !finB) {                                    // 聲母+韻頭無韻尾：ㄅㄨ→bu、ㄐㄩ→ju、ㄌㄩ→lü
      const m = med === 'ü' ? ((ini === 'j' || ini === 'q' || ini === 'x') ? 'u' : 'ü') : med;
      syl = ini + m;
    } else {
      let rime = rimeWithMed(med, finB);
      if (med === 'ü' && (ini === 'j' || ini === 'q' || ini === 'x')) rime = rime.replace('ü', 'u'); // ju qu xu / jue / juan / jun
      syl = ini + rime;
    }
  }
  return addTone(syl, tone);
}

export function bpmf2pinyin(zy: string): string {
  if (!zy) return '';
  return zy.split(/（變）/).map((seg) =>
    seg
      .replace(/([。，、；：（）])/g, ' $1 ')      // 標點/括號獨立成 token（無注音符號者原樣保留）
      .split(/[\s　]+/).filter(Boolean).map(one).join(' ')
      .replace(/\s+([。，、；：])/g, '$1')        // 貼回標點
  ).join(' （變） ');
}
