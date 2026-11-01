/**
 * 漢字判定與「漢字位置」計算（2026-11-01）。
 *
 * 以前各處用 `[\u3400-\u9fff\uf900-\ufaff]` 逐 **UTF-16 code unit** 比對，
 * 擴充 B 區以後的字（如「𩜁」U+29A41，代理對）兩半都測不到，於是少算 1 個字；
 * 但 glossary／Python 端是逐 code point 算的，`j="a-b"` 的字元色帶就會偏。
 *
 * 這裡統一：
 *   - 判定用 `\p{Script=Han}`（**一定要有 u flag**，只測「一個完整的 code point」）
 *   - 位置（給 Range 用的 offset）仍是 **UTF-16 code unit 索引**
 *   - code point 索引 → code unit 位移用 `cpToUnit()`
 */
export const HAN_RE = /\p{Script=Han}/u;

/** 這個「字」（一個完整 code point，不是半個代理對）是不是漢字。 */
// 舊名（terms.ts 等還在用）：與 HAN_RE 同一個判斷
export const HAN = HAN_RE;

export const isHan = (ch: string): boolean => HAN_RE.test(ch);

/** 去掉標籤後，逐 code point 取出漢字。 */
export const hanChars = (s: string): string[] =>
  [...s.replace(/<[^>]*>/g, '')].filter((c) => isHan(c));

/** 漢字數（`j` 的座標就是這個）。 */
export const hanCount = (s: string): number => hanChars(s).length;

/** code point 索引 → UTF-16 位移（Range.setStart 吃的是 code unit）。 */
export const cpToUnit = (s: string, k: number): number => {
  let u = 0;
  for (let i = 0, n = 0; i < s.length && n < k; n++) {
    const w = (s.codePointAt(i) ?? 0) > 0xffff ? 2 : 1;
    i += w;
    u = i;
  }
  return u;
};
