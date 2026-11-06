/**
 * pinxing-vendor.test.ts — **accelon26 內嵌的描繪器／字庫與 pinxing 是同一份**。
 *
 *   cd ts && bun run test/glyph-vendor.test.ts
 *
 * 三件事：
 *   1. `ts/src/vendor/glyph/` 是生成物，**SHA 指紋與 golden 一致**（40 字 × 4 情境 × 24 hex）。
 *   2. 解碼結果與 golden 記錄的字庫 sha256 一致（拿到別的字庫就會紅）。
 *   3. `lib-format` 的 lazy 解碼與全解**逐字形相同**（抽 2,000 個，收在測試裡）。
 *
 * 沒有字庫檔就**跳過**（exit 0）—— CI／macOS 沒有 pinxing checkout 也要能綠。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { decodeLibrary, decodeLibraryLazy, indexOfCodePoint, keyOfIdx, toKageData } from '../src/vendor/pinxing/lib-format';
import { LitePinxing, LitePolygons } from '../src/vendor/pinxing/pinxing';

const here = import.meta.dir;
const ROOT = resolve(here, '..');          // ts/
const GOLDEN = JSON.parse(readFileSync(resolve(here, 'golden/pinxing-golden.json'), 'utf8')) as {
  libSha256: string; cases: string[]; svg: Record<string, string>;
};
const LIB = process.env.PINXING_LIB
  || (process.env.PINXING_DIR ? `${process.env.PINXING_DIR}/lib/lib-cjk-all.bin.gz` : 'D:/2026/pinxing/lib/lib-cjk-all.bin.gz');

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}${detail ? '：' + detail : ''}`); }
};

console.log('pinxing-vendor：內嵌描繪器／字庫與 pinxing 的一致性');

// ① 生成物沒被手改（檔頭 sha 與來源一致，見 tools/vendor-pinxing.ts）
{
  const p = resolve(ROOT, 'src/vendor/pinxing/pinxing.ts');
  const src = readFileSync(p, 'utf8');
  ok('pinxing.ts 有「生成檔」檔頭', src.startsWith('/* ----') && src.includes('生成檔，不要手改'));
  ok('lib-format.ts 存在且非空', readFileSync(resolve(ROOT, 'src/vendor/pinxing/lib-format.ts'), 'utf8').length > 10_000);
}

if (!existsSync(LIB)) {
  console.log(`  … 找不到字庫 ${LIB}（設 PINXING_LIB 或 PINXING_DIR），跳過比對`);
  console.log(`\n${pass} 項通過（跳過 ${fail ? 0 : 0} 項）`);
  process.exit(fail ? 1 : 0);
}

const gz = new Uint8Array(readFileSync(LIB));
const sha = createHash('sha256').update(gz).digest('hex');
ok('字庫檔與 golden 記錄的一致', sha === GOLDEN.libSha256, `golden ${GOLDEN.libSha256.slice(0, 12)}… / 實際 ${sha.slice(0, 12)}…`);

const bytes = new Uint8Array(Bun.gunzipSync(gz));
const lib = decodeLibraryLazy(bytes);

// ② 40 字 × 4 情境的 SVG 指紋（與 pinxing 的 tools/make-golden.ts 對帳）
{
  let bad = 0, checked = 0;
  const firstBad: string[] = [];
  for (const [key, want] of Object.entries(GOLDEN.svg)) {
    const m = /^U\+([0-9A-F]+)@(.+)$/.exec(key);
    if (!m) continue;
    const cp = parseInt(m[1]!, 16);
    const caseName = m[2]!;
    const c = /^text-(\d+)-dpr(\d+)$/.exec(caseName);
    const emPx = c ? Number(c[1]) : 0;
    const dpr = c ? Number(c[2]) : 1;
    const gi = indexOfCodePoint(lib, cp);
    if (gi === undefined) { bad++; firstBad.push(`${key}: 字庫沒有`); continue; }
    const sub = new Map<string, string>();
    const st = [gi]; const seen = new Set<number>();
    while (st.length) {
      const i = st.pop()!;
      if (seen.has(i)) continue;
      seen.add(i);
      const g = lib.glyphs[i]!;
      sub.set(keyOfIdx(lib, i), toKageData(g, lib));
      for (const s of g.strokes) if (s.kind === 99 && s.ref !== null) st.push(s.ref);
    }
    const k = new LitePinxing('songti');
    k.emPx = emPx; k.dpr = dpr;
    for (const [a, b] of sub) k.parts.set(a, b);
    const p = new LitePolygons();
    k.makeGlyph(p, keyOfIdx(lib, gi));
    const got = createHash('sha256').update(p.generateSVG()).digest('hex').slice(0, 24);
    checked++;
    if (got !== want) { bad++; if (firstBad.length < 3) firstBad.push(`${key}: ${got} ≠ ${want}`); }
  }
  ok(`${checked} 筆 SVG 指紋與 pinxing 相同`, bad === 0, firstBad.join('；'));
}

// ③ lazy 與全解逐字形相同（抽 2,000）
{
  const eager = decodeLibrary(bytes);
  let bad = 0, n = 0;
  const step = Math.max(1, Math.floor(eager.glyphs.length / 2000));
  for (let i = 0; i < eager.glyphs.length; i += step) {
    n++;
    const a = toKageData(eager.glyphs[i]!, eager);
    const b = toKageData(lib.glyphs[i]!, lib);
    const ta = eager.glyphs[i]!.tight, tb = lib.glyphs[i]!.tight;
    if (a !== b || !ta || !tb || ta.join() !== tb.join()) bad++;
  }
  ok(`lazy 解碼抽驗 ${n} 個字形（筆畫＋緊框）`, bad === 0, `${bad} 個不一致`);
}

console.log(`\n${pass} 項通過、${fail} 項失敗`);
if (fail) process.exit(1);
