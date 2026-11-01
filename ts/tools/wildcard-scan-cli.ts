/**
 * 萬用字元掃描的 **CLI**（不開 GUI）：作者指定的驗收案例可以直接在命令列看結果。
 *
 *   bun run tools/wildcard-scan-cli.ts --adb D:\accelon3\taisho.adb --pattern ？象 [--top 10]
 *
 * 為什麼要有這支：
 *   * 桌面版開一個 331 MB 的 taisho 要幾十秒（mmap ＋ 行表 ＋ 目錄樹），用 GUI 測一輪太久；
 *   * 掃描本身（`wildcard.ts` 的同一套演算法：用 pattern 裡的漢字查索引 → 只掃那幾個 block）
 *     不需要 DOM，直接跑最快，也方便量時間。
 *
 * 輸出：總筆數、不同字串數、前 N 名（次數多的在前），以及各段耗時。
 */
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { AdbReader, SyncIO } from '../src/accelon26/adb';
import { SearchSession } from '../src/accelon26/search';
import { VaPaMapper } from '../src/accelon26/vapa';
import { parseWildcard, stripTags } from '../src/accelon26/wildcard-parse';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const ADB = resolve(opt('adb', resolve(import.meta.dir, '../../accelon3/taisho.adb')));
const PATTERN = opt('pattern', '？象');
const TOP = Number(opt('top', '10'));

if (!existsSync(ADB)) { console.error('missing ' + ADB); process.exit(2); }

const pat = parseWildcard(PATTERN);
if (!pat.ok || !pat.regex) { console.error('樣式有問題：' + (pat.error ?? '')); process.exit(2); }
console.log(`樣式 ${pat.raw}（${pat.describe}）`);
console.log(`adb   ${ADB}`);
console.log(`縮小用的字：${pat.narrowChar ?? '（沒有，全掃）'}`);

const t0 = performance.now();
const reader = await AdbReader.open(new SyncIO(ADB));
const mapper = new VaPaMapper(reader);
await mapper.init();
const tOpen = performance.now() - t0;
const total = mapper.sourceBlocks;
console.log(`開啟＋行表 ${tOpen.toFixed(0)} ms；source block ${total} 段；行數 ${mapper.lineCount.toLocaleString('en-US')}`);

const session = new SearchSession(reader);
let blocks: number[] = [];
let narrowNote = '';
if (pat.narrowChar) {
  const tL = performance.now();
  const st = await session.lookup(pat.narrowChar);
  const set = new Set<number>();
  for (const va of st.postings) set.add(mapper.blockOfVa(va));
  const narrowed = [...set].sort((a, b) => a - b);
  narrowNote = `「${pat.narrowChar}」posting ${st.postings.length.toLocaleString('en-US')} → ${narrowed.length.toLocaleString('en-US')} / ${total.toLocaleString('en-US')} 段（${(performance.now() - tL).toFixed(0)} ms）`;
  // 太分散（超過 60%）就和全掃一樣了，但還是照用（快一點點）
  blocks = narrowed;
}
if (!blocks.length) { blocks = Array.from({ length: total }, (_, i) => i); narrowNote = '全掃'; }
console.log('範圍：' + narrowNote);

const forms = new Map<string, number>();
const re = new RegExp(pat.regex.source, 'gu');
let hits = 0;
let chars = 0;
const t1 = performance.now();
let lastReport = t1;
for (let k = 0; k < blocks.length; k++) {
  const b = blocks[k];
  const raw = await reader.sourceText(b);
  const { text } = stripTags(raw);
  chars += text.length;
  for (const m of text.matchAll(re)) {
    hits++;
    forms.set(m[0], (forms.get(m[0]) ?? 0) + 1);
  }
  const now = performance.now();
  if (now - lastReport > 3000) {
    lastReport = now;
    const pct = Math.round(((k + 1) / blocks.length) * 100);
    console.log(`  ${pct}%　已掃 ${(k + 1).toLocaleString('en-US')} / ${blocks.length.toLocaleString('en-US')} 段`
      + `　找到 ${hits.toLocaleString('en-US')} 筆（${forms.size.toLocaleString('en-US')} 種）`
      + `　${((now - t1) / 1000).toFixed(1)} 秒`);
  }
}
const tScan = performance.now() - t1;
const top = [...forms.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, TOP);

console.log(`\n掃描 ${tScan.toFixed(0)} ms（${(chars / 1048576).toFixed(1)} M 字）`);
console.log(`命中 ${hits.toLocaleString('en-US')} 筆／${forms.size.toLocaleString('en-US')} 種字串`);
console.log(`前 ${TOP} 名：`);
for (const [text, n] of top) console.log(`  ${text}  ${n.toLocaleString('en-US')}`);
console.log(`\n總時間 ${((performance.now() - t0) / 1000).toFixed(1)} 秒`);
