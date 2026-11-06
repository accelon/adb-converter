/**
 * 詞／詞譜標籤的規格（2026-11-06 refactor）。
 *
 * 這裡只判斷「這個 tag 是詞典詞頭、詞譜 span、還是一般行內詞」，
 * 不負責 HTML 或點擊；renderer 依 WordSpec 組 span，link 不屬於這一層。
 *
 *   <詞>      正常 VA；詞典模式沒有 b/j/w 時是詞頭（dictHead）
 *   <_詞>     零 VA；永遠不是詞頭
 *   <辭>      正常 VA；cs 的詞譜，沒有 b/j/w 時只留文字
 *   <_辭>     零 VA；cs 詞譜的行內版
 */
import { bpmf2pinyin } from './bpmf2pinyin';

export type WordTag = '詞' | '辭';

export interface WordPron {
  /** 注音；資料把拼音放在 zy 時為空 */
  zy: string;
  /** 拼音；由 zy 動態轉出，或資料直接給 py */
  py: string;
}

export interface WordSpec {
  /** 去掉底線後的標籤名 */
  tag: WordTag;
  /** 原始 tag 是否帶底線（零 VA） */
  zeroVa: boolean;
  /** 詞典詞頭：只有 <詞>、沒有 b/j/w、且 dictEntries 模式 */
  dictHead: boolean;
  /** 要不要長 .word span（有 b/j/w） */
  wordSpan: boolean;
  b: string;
  j: string;
  w: string;
  /** 同形詞編號（`<詞 a="2">`）；顯示在詞頭第一個字之後。 */
  homograph: string;
  /** 注音／拼音（可選） */
  pron: WordPron | null;
}

/**
 * @param name 原始 tag 名（可帶底線）
 * @param get 取屬性值的函式（已解 XML entity）
 * @param dictEntries 目前是不是詞典模式
 */
export function parseWordSpec(
  name: string,
  get: (name: string) => string,
  dictEntries: boolean,
): WordSpec | null {
  const zeroVa = name.startsWith('_');
  const tag = (zeroVa ? name.slice(1) : name) as WordTag;
  if (tag !== '詞' && tag !== '辭') return null;

  const b = get('b');
  const j = get('j');
  const w = get('w');
  const homograph = get('a').trim();
  const wordSpan = !!(b || j || w);
  const dictHead = !zeroVa && tag === '詞' && dictEntries && !wordSpan;

  const zyRaw = get('zy').trim();
  const py = get('py').trim();
  // zy 依定義是注音；但 cyd 目前有些資料把拼音放在 zy。只有注音符號才當注音。
  const zy = /[\u3100-\u312f]/.test(zyRaw) ? zyRaw : '';
  const pyText = py || (zy ? bpmf2pinyin(zy) : zyRaw);
  const pron = zy || pyText ? { zy, py: pyText } : null;

  return { tag, zeroVa, dictHead, wordSpan, b, j, w, homograph, pron };
}
