/**
 * Unicode character predicates, ported from the Delphi sources:
 *
 *   cUnicodeChar.pas  IsWhiteSpace   (line 190)
 *                     IsControl      (line 209)
 *                     IsIgnorable    (line 226, "Derived from 'Cf' + 'Cc' + 'Cs' - White_Space")
 *
 * Why they matter for the index: index.pas has
 *
 *     uses sysutils, tntsysutils, lists, ...
 *
 * and in Delphi a later unit in the uses clause wins, so the `trim(token)` in
 * TIndexer.parse is TntSysUtils.Trim (Unicode aware) and not SysUtils.Trim.
 * TNT's Trim drops leading/trailing characters of these classes, which is how a
 * token like U+3000 (ideographic space) or U+206B (invisible operator) ends up
 * in the blank branch of the indexer (it consumes one virtual address but is
 * never written to the index). Fitting this rule made every token of yinshun.adb
 * match the stored index exactly.
 */

/** cUnicodeChar.pas: IsWhiteSpace */
export const isWhiteSpace = (c: number): boolean => {
  if (c >= 0x0009 && c <= 0x000d) return true;
  switch (c) {
    case 0x0020:
    case 0x0085:
    case 0x00a0:
    case 0x1680:
    case 0x2028:
    case 0x2029:
    case 0x202f:
    case 0x3000:
      return true;
    default:
      return c >= 0x2000 && c <= 0x200a;
  }
};

/** cUnicodeChar.pas: IsControl */
export const isControl = (c: number): boolean => c <= 0x001f || (c >= 0x007f && c <= 0x009f);

/** cUnicodeChar.pas: IsControlOrWhiteSpace */
export const isControlOrWhiteSpace = (c: number): boolean => isControl(c) || isWhiteSpace(c);

/** cUnicodeChar.pas: IsIgnorable */
export const isIgnorable = (c: number): boolean => {
  if (c >= 0x0000 && c <= 0x0008) return true;
  if (c >= 0x000e && c <= 0x001f) return true;
  if (c >= 0x007f && c <= 0x0084) return true;
  if (c >= 0x0086 && c <= 0x009f) return true;
  switch (c) {
    case 0x06dd:
    case 0x070f:
    case 0x180e:
    case 0xe0000:
    case 0xe0001:
      return true;
    default:
      break;
  }
  if (c >= 0x180b && c <= 0x180d) return true;
  if (c >= 0x200c && c <= 0x200f) return true;
  if (c >= 0x202a && c <= 0x202e) return true;
  if (c >= 0x2060 && c <= 0x2069) return true;
  if (c >= 0x206a && c <= 0x206f) return true;
  if (c >= 0xd800 && c <= 0xdfff) return true;
  if (c >= 0xfe00 && c <= 0xfe0f) return true;
  if (c === 0xfeff) return true;
  if (c >= 0xfff0 && c <= 0xfff8) return true;
  if (c >= 0xfff9 && c <= 0xfffb) return true;
  if (c >= 0x1d173 && c <= 0x1d17a) return true;
  if (c >= 0xe0002 && c <= 0xe001f) return true;
  if (c >= 0xe0020 && c <= 0xe007f) return true;
  return c >= 0xe0080 && c <= 0xe0fff;
};

/**
 * Characters TNT's Unicode aware Trim removes at both ends of a string.
 *
 * NOTE: the surrogate range (Cs) of IsIgnorable is excluded here. TNT's Trim
 * sees a surrogate *pair* (an astral character) as one code point and keeps it,
 * and yinshun.adb really does index 35 such characters. A *lone* surrogate is
 * also kept: 13j.adb has a single U+DCDE token in its index, so the build did
 * not treat it as ignorable either.
 */
export const isTrimCodePoint = (cp: number): boolean =>
  isWhiteSpace(cp) || isControlOrWhiteSpace(cp) || (isIgnorable(cp) && !(cp >= 0xd800 && cp <= 0xdfff));

/**
 * TntSysUtils.Trim equivalent: strip leading/trailing whitespace/control/
 * ignorable characters (used by TIndexer.parse to recognise a blank token).
 *
 * The scan is by CODE POINT, not by code unit: a surrogate pair (an astral CJK
 * character such as U+25ECA) is one code point and is not ignorable, so it is
 * kept - trimming it would wrongly drop those tokens from the index (verified
 * against yinshun.adb, which indexes 35 such characters).
 */
export function tntTrim(s: string): string {
  const cpLen = (i: number): number => {
    const c = s.charCodeAt(i);
    return c >= 0xd800 && c <= 0xdbff && i + 1 < s.length ? 2 : 1;
  };
  let a = 0;
  let b = s.length;
  while (a < b) {
    const cp = s.codePointAt(a)!;
    if (!isTrimCodePoint(cp)) break;
    a += cp > 0xffff ? 2 : 1;
  }
  while (b > a) {
    const last = s.charCodeAt(b - 1);
    let cp = last;
    let start = b - 1;
    if (last >= 0xdc00 && last <= 0xdfff && b - 2 >= a) {
      const hi = s.charCodeAt(b - 2);
      if (hi >= 0xd800 && hi <= 0xdbff) {
        cp = 0x10000 + ((hi - 0xd800) << 10) + (last - 0xdc00);
        start = b - 2;
      }
    }
    if (!isTrimCodePoint(cp)) break;
    b = start;
  }
  void cpLen;
  return s.slice(a, b);
}
