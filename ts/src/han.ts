/**
 * Han character helpers, used by the index comparison to ignore the punctuation
 * and whitespace differences that different tokenizer builds introduce.
 */

/** CJK ideographs: URO, Ext A, compatibility, Ext B..F and the CJK symbols that
 *  are ideographs rather than punctuation (々 〆 〇). */
export function isHanCodePoint(cp: number): boolean {
  if (cp >= 0x3400 && cp <= 0x4dbf) return true; // Ext A
  if (cp >= 0x4e00 && cp <= 0x9fff) return true; // URO
  if (cp >= 0xf900 && cp <= 0xfaff) return true; // compatibility ideographs
  if (cp >= 0x20000 && cp <= 0x2fa1f) return true; // Ext B..F + compatibility supplement
  if (cp === 0x3005 || cp === 0x3007) return true; // 々 〇
  return false;
}

/** True when the string contains at least one Han character. */
export function hasHan(s: string): boolean {
  for (const ch of s) if (isHanCodePoint(ch.codePointAt(0)!)) return true;
  return false;
}

/** True when every code point of the string is Han (a pure Han token). */
export function isAllHan(s: string): boolean {
  let any = false;
  for (const ch of s) {
    if (!isHanCodePoint(ch.codePointAt(0)!)) return false;
    any = true;
  }
  return any;
}
