/**
 * `<註 n pg>`／`<釋 n pg>` 標籤級解析（純函式，無瀏覽器依賴——bun 可直接測）。
 *
 * 從 notes.ts 抽出（厚觀法師 2026-11-17 UID 299：法華每品注號重起，同一 n 全書
 * 有幾十條，只有 pg 相同才是同一條；notes.ts 本體載入會拉進 viewer 瀏覽器模組，
 * 測試環境進不去）。
 */
import { decodeXmlEntities } from '../xml-entities';

export function noteTagAt(line: string, tag: string, n: string, wantPg = ''): { end: number; selfClose: boolean } | null {
  const re = new RegExp('<' + tag + '(\\s[^>]*)?>', 'g');
  let m: RegExpExecArray | null;
  let fallback: { end: number; selfClose: boolean } | null = null;
  while ((m = re.exec(line))) {
    const attrs = m[1] ?? '';
    const nm = /\bn\s*=\s*"([^"]*)"/.exec(attrs) ?? /\bn\s*=\s*'([^']*)'/.exec(attrs);
    if (!nm || decodeXmlEntities(nm[1]) !== n) continue;
    const hit = { end: m.index + m[0].length, selfClose: /\/\s*$/.test(attrs) };
    // `wantPg`：同一 n 在別品也有時，必須認標籤自己的 `pg=`；
    // 無 pg 的標籤只當退路，不蓋過 pg 相符的那條。
    if (wantPg) {
      const pm = /\bpg\s*=\s*"([^"]*)"/.exec(attrs) ?? /\bpg\s*=\s*'([^']*)'/.exec(attrs);
      const tagPg = pm ? decodeXmlEntities(pm[1]) : '';
      if (tagPg === wantPg) return hit;
      if (!tagPg && !fallback) fallback = hit;
      continue;
    }
    return hit;
  }
  return fallback;
}
