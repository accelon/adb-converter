/**
 * vendor/Unihan_Variants.txt → 「無損簡體」對照表（`ts/src/accelon26/simplified-data.ts`）。
 *
 *   cd ts && bun run tools/gen-lossless.ts [--check]
 *
 * 概念（作者 2026-10，參考 ptk/lossless-simplified-chinese 的思路，資料改用 Unihan 自己算）：
 *
 *   * **無損簡體（safe）**：只做「一個繁 ↔ 一個簡」的轉換。凡是多個繁體字共用同一個
 *     簡體字（例：發／髮 → 发；乾／幹 → 干），一律**不轉**，保留原字 —— 這樣習慣讀
 *     簡體的人讀得順，又不會因為簡化而誤解個別字（作者舉例：中醫）。
 *   * **強制簡體（force）**：全部轉（Unihan 的 kSimplifiedVariant），不管合併。
 *
 * 做法：
 *   1. kSimplifiedVariant：繁 T → 簡 S（可能多個）
 *   2. kTraditionalVariant：簡 S → 繁 T（可能多個）
 *   3. 反向補齊兩邊（Unihan 兩個欄位常常只寫一邊）
 *   4. safe：只收「S 的繁體集合只有 T 一個，而且 T 本身不是別的字的簡體」
 *   5. force：所有 T→S（T 自己已經在「簡體字集合」裡的不動）
 *
 * 產物是兩行字串，每兩個字一組（繁,簡）：
 *   export const SAFE_PAIRS = "薩萨乾干…"
 *   export const FORCE_PAIRS = "…"
 * 檔頭有統計與來源。`--check` 只比對是否最新。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const ROOT = resolve(import.meta.dir, '../..');
const SRC = resolve(ROOT, 'vendor/Unihan_Variants.txt');
const OUT = resolve(ROOT, 'ts/src/accelon26/simplified-data.ts');
const CHECK = args.includes('--check');

if (!existsSync(SRC)) {
  console.error(`找不到 ${SRC}`);
  console.error('vendor/ 不進 git。需要時自己下載：');
  console.error('  https://github.com/CNMan/Unicode/blob/master/Unihan/Unihan_Variants.txt');
  console.error('（產物 ts/src/accelon26/simplified-data.ts 已 commit，建置不需要 vendor）');
  process.exit(2);
}

const isHan = (cp: number): boolean =>
  (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0xf900 && cp <= 0xfaff)
  || (cp >= 0x20000 && cp <= 0x2fa1f);

const simpOf = new Map<number, number[]>();   // 繁 → 簡
const tradOf = new Map<number, number[]>();   // 簡 → 繁

const add = (m: Map<number, number[]>, k: number, v: number) => {
  const list = m.get(k) ?? [];
  if (!list.includes(v)) list.push(v);
  m.set(k, list);
};

// ---- 異體字組（union-find）：kZVariant ＋ kSemanticVariant -------------------
// 作者 2026-10：同一個字的不同字形（說／説、眾／衆、醫／医…）算「同一個字」，
// 不算「多對一」的合併，所以無損模式可以放心轉。
const parent = new Map<number, number>();
const find = (x: number): number => {
  let p = parent.get(x);
  if (p === undefined) { parent.set(x, x); return x; }
  while (p !== x) {
    const up = parent.get(p) ?? p;
    if (up === p) break;
    parent.set(x, up);
    x = p; p = up;
  }
  return p;
};
const union = (a: number, b: number): void => {
  const ra = find(a), rb = find(b);
  if (ra !== rb) parent.set(ra, rb);
};
const VARIANT_FIELDS = new Set(['kZVariant', 'kSemanticVariant', 'kSpecializedSemanticVariant']);

/**
 * 簡體字本身也是常用繁體字的情況（作者 2026-10：否則「王后／王後」分不出來）。
 * Unihan 的資料看不出這件事（後、医 的結構一樣），所以列一張人工表；
 * 這些字的「繁→簡」在無損模式一律保留原字，強制模式照轉。
 */
const LOSSY_TARGETS = new Set([...'后台里干只几云面松咸借谷舍系复于郁冲准胡采累布卷秋千卜出板表别蒙划夸困厘了霉仆曲术涂向须折征志制朱筑姜御芸沾毡']);

const lines = readFileSync(SRC, 'utf8').split(/\r?\n/);
for (const line of lines) {
  if (!line || line.startsWith('#')) continue;
  const cols = line.split('\t');
  if (cols.length < 3) continue;
  const field = cols[1].trim();
  const a = Number.parseInt(cols[0].replace(/^U\+/, ''), 16);
  if (!Number.isFinite(a) || !isHan(a)) continue;
  if (VARIANT_FIELDS.has(field)) {
    for (const raw of cols[2].split(/\s+/)) {
      const b = Number.parseInt(raw.split('<')[0].replace(/^U\+/, ''), 16);
      if (Number.isFinite(b) && isHan(b) && b !== a) union(a, b);
    }
    continue;
  }
  if (field !== 'kSimplifiedVariant' && field !== 'kTraditionalVariant') continue;
  for (const raw of cols[2].split(/\s+/)) {
    const b = Number.parseInt(raw.split('<')[0].replace(/^U\+/, ''), 16);
    if (!Number.isFinite(b) || !isHan(b) || b === a) continue;
    if (field === 'kSimplifiedVariant') { add(simpOf, a, b); add(tradOf, b, a); }
    else { add(tradOf, a, b); add(simpOf, b, a); }
  }
}

// 「簡體字集合」：出現在 kSimplifiedVariant 目標（或 kTraditionalVariant 主字）的字
const simplifiedSet = new Set<number>();
for (const [t, list] of simpOf) { void t; for (const s of list) simplifiedSet.add(s); }

const pairs = (mode: 'safe' | 'force'): [number, number][] => {
  const out: [number, number][] = [];
  for (const [t, list] of simpOf) {
    if (simplifiedSet.has(t)) continue;          // 自己就是簡體字（干、后…）→ 不動
    // 產物是「每兩個字一組」的字串，只放 BMP 的字才不會對不齊（擴充 B 的字很少見）
    if (t > 0xffff) continue;
    for (const s of list) {
      if (s === t) continue;
      if (s > 0xffff) continue;
      if (mode === 'safe') {
        // 無損：S 不能是「本身也是常用繁體字」的簡體（后、台、里…）
        if (LOSSY_TARGETS.has(String.fromCodePoint(s))) continue;
        // T 只能對到這一個簡體
        if (list.length !== 1) continue;
        // S 的其他繁體寫法（除了 S 自己）必須都是「同一個字的異體」——同一組才算無損
        const others = (tradOf.get(s) ?? []).filter((x) => x !== s);
        if (!others.length) continue;
        const root = find(others[0]);
        if (!others.every((x) => find(x) === root)) continue;
        // 而且 T 自己也在這一組（否則就是把兩個不同的字併在一起）
        if (find(t) !== root) continue;
      }
      out.push([t, s]);
      break;                                      // 一個繁體只取第一個簡體（force）
    }
  }
  return out;
};

const safe = pairs('safe');
const force = pairs('force');
const str = (list: [number, number][]) => list.map(([t, s]) => String.fromCodePoint(t) + String.fromCodePoint(s)).join('');
if (str(safe).length % 2 || str(force).length % 2) {
  console.error('產物長度不是偶數（有非 BMP 的字混進來了）');
  process.exit(1);
}

const header = `/**
 * GENERATED FILE — do not edit.
 *
 * \`cd ts && bun run tools/gen-lossless.ts\` 從 \`vendor/Unihan_Variants.txt\` 重新產生
 * （kSimplifiedVariant／kTraditionalVariant；來源不進 git）。
 *
 * 每兩個字一組「繁體,簡體」：
 *   SAFE_PAIRS  —— 只收一對一的繁簡（無損）；多對一的（發／髮→发、乾／幹→干）不收，
 *                  所以讀起來是簡體，但不會因為合併而誤解（作者 2026-10）。
 *   FORCE_PAIRS —— 全部轉（強制簡體）。
 *
 * 統計：無損 ${safe.length} 組、強制 ${force.length} 組。
 */
`;

const body = `${header}export const SAFE_PAIRS = ${JSON.stringify(str(safe))};\n\nexport const FORCE_PAIRS = ${JSON.stringify(str(force))};\n`;
const existing = (() => { try { return readFileSync(OUT, 'utf8'); } catch { return ''; } })();

if (CHECK) {
  if (existing === body) { console.log(`OK：${OUT} 已是最新（無損 ${safe.length}／強制 ${force.length}）`); process.exit(0); }
  console.error(`NG：${OUT} 與 vendor/Unihan_Variants.txt 不一致（跑一次 gen-lossless.ts）`);
  process.exit(1);
}

writeFileSync(OUT, body, 'utf8');
console.log(`wrote ${OUT}`);
console.log(`  無損 ${safe.length} 組、強制 ${force.length} 組`);
const probe = (t: string) => {
  const s = safe.find(([a]) => String.fromCodePoint(a) === t);
  const f = force.find(([a]) => String.fromCodePoint(a) === t);
  return `${t}: 無損→${s ? String.fromCodePoint(s[1]) : '(不轉)'}　強制→${f ? String.fromCodePoint(f[1]) : '(不轉)'}`;
};
for (const t of ['薩', '髮', '發', '乾', '幹', '裡', '裏', '臺', '後', '醫']) console.log('  ' + probe(t));
