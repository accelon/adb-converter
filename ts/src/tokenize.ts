/**
 * Faithful port of the Delphi tokenizer (tokenize.pas, unit tokenize) plus
 * diacritic.normalize. Every function name/comment refers to the Pascal
 * original so the two can be compared side by side.
 *
 * Differences that are deliberate:
 *   - the Pascal code reads past the end of a line (it relies on the NUL
 *     terminator and on whatever memory follows); here every scan stops at the
 *     end of the line.
 */
import { dia } from './dia';

/** tokenize.pas: TTokenizer.isblank */
export const isBlank = (c: number): boolean => c <= 0x20 || (c >= 0xf0b && c <= 0xf11);

/** tokenize.pas: isWestern */
export const isWestern = (c: number): boolean => c < 0x1fff;

/** tokenize.pas: isnumeric */
export const isNumeric = (c: number): boolean => c >= 0x30 && c <= 0x39;

/** tokenize.pas: isAlpha - ASCII letters, or a western character the diacritic
 *  table can translate (dia[c] !== c). */
export const isAlpha = (c: number): boolean =>
  (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || (c < 0x2000 && dia(c) !== c);

export const isAlphaNumeric = (c: number): boolean => isAlpha(c) || isNumeric(c);

/** tokenize.pas: isCJK */
export const isCJK = (c: number): boolean =>
  (c >= 0x3400 && c <= 0x9ff0) ||
  (c >= 0x2ff0 && c <= 0x2fff) ||
  (c >= 0xd800 && c <= 0xdfff) ||
  (c >= 0x3040 && c <= 0x3fff) ||
  (c >= 0xac00 && c <= 0xd7a3) ||
  (c >= 0x1100 && c <= 0x11ff) ||
  (c >= 0x3130 && c <= 0x318f) ||
  (c >= 0x3100 && c <= 0x312f);

/** tokenize.pas: isCJKpunc */
export const isCJKPunc = (c: number): boolean =>
  (c >= 0xff00 && c <= 0xffee) || (c >= 0x3000 && c <= 0x303f) || (c >= 0xfe50 && c <= 0xfe6f);

/** tokenize.pas: isTibet */
export const isTibet = (c: number): boolean => c >= 0xf00 && c <= 0xfff;

/** tokenize.pas: isTibetPunc */
export const isTibetPunc = (c: number): boolean => c >= 0xf0d && c <= 0xf11;

/** 緬甸文區（Myanmar）：U+1000–109F；擴充 A9E0–A9FF 也一起處理。 */
const isMyanmar = (c: number): boolean =>
  (c >= 0x1000 && c <= 0x109f) || (c >= 0xa9e0 && c <= 0xa9ff);

/** 泰文區（Thai）：U+0E00–0E7F。 */
const isThai = (c: number): boolean => c >= 0x0e00 && c <= 0x0e7f;

/**
 * 泰文也沒有空格分詞；Delphi tokenizer 會把每個泰文字母當一個 token。
 * `Intl.Segmenter('th', word)` 在 ICU 有泰文詞典，cllk 需要用這一條。
 */
const thSegmenter = (() => {
  try {
    return new Intl.Segmenter('th', { granularity: 'word' });
  } catch {
    return null;
  }
})();

/**
 * 日文（kmj 日譯）用。`Intl.Segmenter('ja', word)` 會把 `仏陀`、`説い` 切成詞；
 * 只有明確標成日文的庫才開，避免把中文庫的漢字亂切。
 */
const jaSegmenter = (() => {
  try {
    return new Intl.Segmenter('ja', { granularity: 'word' });
  } catch {
    return null;
  }
})();

/**
 * Burmese 沒有空格分詞；Delphi 的 tokenizer 把每個緬文字母當一個 western token，
 * cs-mm 的索引因此只有 113 個 token（幾乎是單字）。`Intl.Segmenter('my', word)`
 * 在 Bun／Chromium 的 ICU 有緬甸詞典，能切成 `အကျွန်ုပ်`、`သည်` 這種詞。
 */
const mySegmenter = (() => {
  try {
    return new Intl.Segmenter('my', { granularity: 'word' });
  } catch {
    return null;
  }
})();

/** tokenize.pas: isIDC */
export const isIDC = (c: number): boolean => c >= 0x2ff0 && c <= 0x2fff;

/** tokenize.pas: isSurrogate - 任何 high surrogate（ASCII 以外的補充平面字元） */
export const isSurrogate = (c: number): boolean => c >= 0xd800 && c <= 0xdbff;

/** 悉曇區（Unicode Siddham, U+11580–115FF） */
const SIDDHAM_START = 0x11580;
const SIDDHAM_END = 0x115ff;
/** <mapping type="unicode"> 的序列會用到：母音、子音、virama、母音符號 */
const SIDDHAM_VIRAMA = 0x115bf;
const isSiddhamConsonant = (cp: number): boolean => cp >= 0x1158e && cp <= 0x115ae;
const isSiddhamMark = (cp: number): boolean =>
  (cp >= 0x115af && cp <= 0x115bb) || cp === 0x115bc || cp === 0x115bd || cp === 0x115be;


/** tokenize.pas: isstrongpair */
export const isStrongPair = (c: number): boolean => c === 0x3c || c === 0x22 || c === 0x27 || c === 0x26;

/** tokenize.pas: ispair */
export const isPair = (c: number): boolean =>
  isStrongPair(c) || c === 0x28 || c === 0x7b || c === 0x5b;

/** tokenize.pas: getpair */
export function getPair(c: number): number {
  switch (c) {
    case 0x3c:
      return 0x3e; // < >
    case 0x26:
      return 0x3b; // & ;
    case 0x7b:
      return 0x7d; // { }
    case 0x5b:
      return 0x5d; // [ ]
    case 0x28:
      return 0x29; // ( )
    case 0x22:
      return 0x22; // " "
    case 0x27:
      return 0x27; // ' '
    default:
      return 0;
  }
}

/** tokenize.pas: isSkiptag - tags that do not advance the virtual address. */
const SKIP_TAGS = new Set<string>([
  '\u4eae', // 亮
  '\u9801', // 頁
  '\u7c97', // 粗
  '\u8a3b', // 註
  '\u806f', // 聯
  '\u9023', // 連
  '\u7dad', // 維
  'HL',
  'PN',
  'BOLD',
  'RM',
  'LINK',
  'SLINK',
  'NOTE',
]);

export function isSkipTag(tagText: string): boolean {
  if (!tagText) return false;
  let i = 0;
  if (tagText[i] === '<') i++;
  if (tagText[i] === '/') i++;
  let name = '';
  while (i < tagText.length && tagText[i] !== ' ' && tagText[i] !== '>') {
    name += tagText[i];
    i++;
  }
  return SKIP_TAGS.has(name);
}

/** tokenize.pas: parseTag - just the pieces the indexer needs. */
export interface TagAttr {
  name: string;
  value: string;
}

export interface ParsedTag {
  /** attributes as written; index.pas stores attributes with a non empty value */
  attributes: TagAttr[];
  /** name as written, e.g. `/頁` for a close tag */
  name: string;
  /** name without the leading slash (parsetag: shortname) */
  shortName: string;
  kind: 'open' | 'close' | 'both';
  /** underscore prefixed tags are not indexed (parsetag sets skip) */
  skip: boolean;
}

export function parseTag(fullTag: string): ParsedTag {
  const space = fullTag.indexOf(' ');
  let name = space > 0 ? fullTag.slice(0, space) : fullTag;
  let kind: ParsedTag['kind'] = fullTag.startsWith('/') ? 'close' : 'open';
  if (space <= 0 && fullTag.endsWith('/')) {
    name = name.slice(0, -1);
    kind = 'both';
  }
  if (fullTag.endsWith('/')) kind = 'both';

  const rawName = kind === 'close' ? '/' + name : name;
  let skip = false;
  if (kind === 'close') {
    if (name[1] === '_') {
      name = '/' + name.slice(2);
      skip = true;
    }
  } else if (name[0] === '_') {
    name = name.slice(1);
    skip = true;
  }
  const shortName = kind === 'close' ? name.slice(1) : name;
  if (isSkipTag(shortName)) skip = true;

  // attributes: name, name="value", name='value' or name=value (tokenize.pas:
  // parseTag walks the same shapes; an empty value is kept as '')
  const attributes: TagAttr[] = [];
  const rest = space > 0 ? fullTag.slice(space) : '';
  const attrRe = /\s+([^\s=/>]+)\s*(?:=\s*("[^"]*"|'[^']*'|[^\s>]*))?/g;
  let am: RegExpExecArray | null;
  while ((am = attrRe.exec(rest))) {
    let value = am[2];
    if (value === undefined) value = '';
    else if (value.startsWith('"') || value.startsWith("'")) value = value.slice(1, -1);
    attributes.push({ name: am[1], value });
  }
  return { name, shortName, kind, skip, attributes };
}

/**
 * diacritic.pas: normalize - western only (a token starting above U+1FFF is
 * returned unchanged), map each code unit through dia[] and lowercase.
 */
export function normalize(input: string): string {
  if (input === '') return input;
  if (input.charCodeAt(0) > 0x1fff) return input;
  let out = '';
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    out += String.fromCharCode(c <= 0x1fff ? dia(c) : c);
  }
  return out.toLowerCase();
}

/**
 * tokenize.pas: TTokenizer.nextLiteral - the tokenizer the indexer uses.
 * The tokenizer walks a single line; offsets are relative to the line start.
 */
export class Tokenizer {
  private readonly data: string;
  private ptr = 0;
  private tokenStart = 0;
  /**
   * 把悉曇連字（`ra+virama+dha…`）收成一個 token。**預設關閉**：
   * 現有 adb 的梵字是 PUA，文字裡若本來就有悉曇序列，合併會改變 VA 數
   * （實測 taisho 少 22 個），引文座標會跑掉。只有「文字本來就是序列、
   * 而且 adb 是以這個規則建索引」的新庫才開（2026-11-01）。
   */
  private readonly siddhamCluster: boolean;
  /** 這個庫是否是日文（kmj）：漢字／假名用 ICU 日文詞典切詞。 */
  private readonly japanese: boolean;

  constructor(line: string, opts: { siddhamCluster?: boolean; japanese?: boolean } = {}) {
    this.data = line;
    this.siddhamCluster = opts.siddhamCluster === true;
    this.japanese = opts.japanese === true;
  }

  get atEnd(): boolean {
    return this.ptr >= this.data.length;
  }

  /** tokenize.pas: TTokenizer.offset (character offset of the pending token) */
  get offset(): number {
    return this.tokenStart;
  }

  get ptrOffset(): number {
    return this.ptr;
  }

  private cur(): number {
    return this.ptr < this.data.length ? this.data.charCodeAt(this.ptr) : 0;
  }

  private at(i: number): number {
    return i < this.data.length ? this.data.charCodeAt(i) : 0;
  }

  /** tokenize.pas: TTokenizer.parseids */
  private parseIds(): string {
    let balance = 0;
    let out = '';
    do {
      if (isIDC(this.cur())) balance--;
      else balance++;
      out += this.data[this.ptr];
      this.ptr++;
    } while (balance !== 1 && this.ptr < this.data.length);
    return out;
  }

  /**
   * 悉曇連字（Unicode Siddham）：`ra + virama + dha + virama + la` 這種序列
   * 在 Noto Sans Siddham 裡是**一個**連字，所以也要算一個 token／VA。
   * 規則：子音（可跟 virama＋下一個子音，重複）＋可選的母音符號／anusvara。
   */
  private parseSiddham(): string {
    const start = this.ptr;
    const first = this.data.codePointAt(this.ptr) ?? 0;
    this.ptr += first > 0xffff ? 2 : 1;
    if (isSiddhamConsonant(first)) {
      for (;;) {
        if ((this.data.codePointAt(this.ptr) ?? 0) !== SIDDHAM_VIRAMA) break;
        this.ptr += 2;                       // 悉曇區在 supplementary plane（2 個 code unit）
        const next = this.data.codePointAt(this.ptr) ?? 0;
        if (!isSiddhamConsonant(next)) break; // 字尾 halant：virama 留在這個 token
        this.ptr += 2;
      }
    }
    for (;;) {
      const cp = this.data.codePointAt(this.ptr) ?? 0;
      if (!isSiddhamMark(cp)) break;
      this.ptr += 2;
    }
    return this.data.slice(start, this.ptr);
  }

  /**
   * 緬甸文：用 ICU 的 word segmenter 取**下一個詞**；不是一個字母一個 token。
   * 只在連續緬文（到空白／非緬文字元為止）上跑；標點由 segmenter 自己切。
   */
  private parseMyanmar(): string {
    const start = this.ptr;
    let end = start;
    while (end < this.data.length) {
      const cp = this.data.codePointAt(end) ?? 0;
      if (isBlank(cp) || !(isMyanmar(cp) || isCJKPunc(cp) || cp === 0x200b)) break;
      end += cp > 0xffff ? 2 : 1;
    }
    const text = this.data.slice(start, end);
    if (!text) {
      this.ptr++;
      return this.data[start] ?? '';
    }
    if (mySegmenter) {
      const first = mySegmenter.segment(text)[Symbol.iterator]().next().value as { segment?: string } | undefined;
      const seg = first?.segment ?? '';
      if (seg) {
        this.ptr = start + seg.length;
        return seg;
      }
    }
    this.ptr = end;
    return text;
  }

  /** 泰文：ICU 的 word segmenter；與緬文同一套做法。 */
  private parseThai(): string {
    const start = this.ptr;
    let end = start;
    while (end < this.data.length) {
      const cp = this.data.codePointAt(end) ?? 0;
      if (isBlank(cp) || !(isThai(cp) || isCJKPunc(cp) || cp === 0x200b)) break;
      end += cp > 0xffff ? 2 : 1;
    }
    const text = this.data.slice(start, end);
    if (!text) {
      this.ptr++;
      return this.data[start] ?? '';
    }
    if (thSegmenter) {
      const first = thSegmenter.segment(text)[Symbol.iterator]().next().value as { segment?: string } | undefined;
      const seg = first?.segment ?? '';
      if (seg) {
        this.ptr = start + seg.length;
        return seg;
      }
    }
    this.ptr = end;
    return text;
  }

  /** 日文：漢字／假名連續段用 ICU 日文詞典切；標點由 segmenter 自己切。 */
  private parseJapanese(): string {
    const start = this.ptr;
    let end = start;
    while (end < this.data.length) {
      const cp = this.data.codePointAt(end) ?? 0;
      if (isBlank(cp)) break;
      if (!(isCJK(cp) || isCJKPunc(cp) || cp === 0x200b)) break;
      end += cp > 0xffff ? 2 : 1;
    }
    const text = this.data.slice(start, end);
    if (!text) {
      this.ptr++;
      return this.data[start] ?? '';
    }
    if (jaSegmenter) {
      const first = jaSegmenter.segment(text)[Symbol.iterator]().next().value as { segment?: string } | undefined;
      const seg = first?.segment ?? '';
      if (seg) {
        this.ptr = start + seg.length;
        return seg;
      }
    }
    this.ptr = end;
    return text;
  }

  /** tokenize.pas: TTokenizer.nextLiteral */
  nextLiteral(): string {
    this.tokenStart = this.ptr;
    if (isBlank(this.cur())) {
      let out = '';
      while (!this.atEnd && isBlank(this.cur())) {
        out += this.data[this.ptr];
        this.ptr++;
      }
      return out;
    }

    if (this.japanese && (isCJK(this.cur()) || isCJKPunc(this.cur()))) return this.parseJapanese();
    if (isThai(this.cur())) return this.parseThai();
    if (isMyanmar(this.cur())) return this.parseMyanmar();

    if (isWestern(this.cur())) {
      const numberstart = isNumeric(this.cur());
      const alphastart = isAlpha(this.cur());

      if (isStrongPair(this.cur())) {
        const pairstart = this.ptr;
        const pp = getPair(this.cur());
        let pair = '';
        while (!this.atEnd && this.cur() !== pp) {
          pair += this.data[this.ptr];
          this.ptr++;
        }
        if (!this.atEnd && this.cur() === pp) {
          const closing = this.data[this.ptr];
          this.ptr++;
          return pair + closing;
        }
        // cannot form a pair, index only one char (2005.7.22)
        this.ptr = pairstart + 1;
        return this.data[pairstart];
      }

      let out = '';
      while (!this.atEnd && !isBlank(this.cur()) && isWestern(this.cur())) {
        if (isStrongPair(this.cur())) break;
        out += this.data[this.ptr];
        this.ptr++;
        const pp = this.at(this.ptr);
        if (alphastart) {
          if (!isAlpha(pp) && !isNumeric(pp)) break;
        } else if (isTibet(pp)) {
          if (!isTibet(pp) || isTibetPunc(pp)) break;
        } else if (numberstart) {
          if (!(isNumeric(pp) || pp === 0x2e)) break;
        } else {
          break;
        }
      }
      return out;
    }

    // ids handling
    if (isIDC(this.cur())) return this.parseIds();
    // 悉曇連字：整個 cluster 一個 token（見 parseSiddham；預設不開）
    if (this.siddhamCluster) {
      const cp = this.data.codePointAt(this.ptr) ?? 0;
      if (cp >= SIDDHAM_START && cp <= SIDDHAM_END) return this.parseSiddham();
    }
    if (isSurrogate(this.cur())) {
      // 一對代理＝一個字元（除非它其實不是成對的，才退一個 code unit）
      const cp = this.data.codePointAt(this.ptr) ?? 0;
      const len = cp > 0xffff ? 2 : 1;
      const out = this.data.slice(this.ptr, this.ptr + len);
      this.ptr += len;
      return out;
    }
    const out = this.data[this.ptr];
    this.ptr++;
    return out;
  }
}
