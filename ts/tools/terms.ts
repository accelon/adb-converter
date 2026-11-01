/**
 * terms.ts — 術語標記的命令列入口（給各庫的 docx→標記流程呼叫）
 *
 *   bun run tools/terms.ts apply --text out/05B.txt [--write]      # 依詞表自動標注 <术>
 *   bun run tools/terms.ts fix   --text build/ys-linked.txt [--write]  # 修正既有 <术> 的斷詞
 *   bun run tools/terms.ts glossary --text out/05B.txt --out out/glossary.jsonl
 *   bun run tools/terms.ts check --text out/05B.txt                # 只報告（預設）
 *
 * 預設都是「只報告不寫檔」，加 --write 才改；所有庫共用 data/terms.tsv 與
 * data/term-fixes.tsv（canonical 在 adb-converter，consumer 可 vendored copy）。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DEFAULT_FIXES,
  DEFAULT_TERMS,
  applyTerms,
  buildGlossaryRows,
  fixTerms,
  glossaryLines,
  loadFixes,
  loadTerms,
} from '../src/terms/terms';

const args = process.argv.slice(2);
const cmd = args[0] ?? 'check';
const opt = (n: string, d = ''): string => {
  const i = args.indexOf('--' + n);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d;
};
const WRITE = args.includes('--write');
const TEXT = resolve(opt('text', ''));
const TERMS = resolve(opt('terms', DEFAULT_TERMS));
const FIXES = resolve(opt('fixes', DEFAULT_FIXES));

if (!TEXT || !existsSync(TEXT)) {
  console.error('usage: bun run tools/terms.ts <apply|fix|glossary|check> --text <file> [--write] [--terms x.tsv] [--fixes y.tsv]');
  process.exit(2);
}

const terms = loadTerms(TERMS);
const text = readFileSync(TEXT, 'utf8');
console.log(`詞表 ${terms.size} 條（${TERMS}）`);

if (cmd === 'apply') {
  const r = applyTerms(text, terms);
  const top = [...r.words.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  console.log(`標記 ${r.marks} 處、${r.words.size} 個詞`);
  for (const [w, n] of top) console.log(`  ${w} ×${n}`);
  if (WRITE) {
    writeFileSync(TEXT, r.text, 'utf8');
    console.log('已寫回 ' + TEXT);
  }
} else if (cmd === 'fix') {
  const fixes = loadFixes(FIXES);
  const r = fixTerms(text, terms, fixes);
  console.log(`多包修正 ${r.moved}、少包修正 ${r.extended}`);
  for (const s of r.samples) console.log('  ' + s);
  if (WRITE) {
    writeFileSync(TEXT, r.text, 'utf8');
    console.log('已寫回 ' + TEXT);
  }
} else if (cmd === 'glossary') {
  const rows = buildGlossaryRows(text);
  const out = resolve(opt('out', 'glossary.jsonl'));
  writeFileSync(out, glossaryLines(rows).join('\n') + '\n', 'utf8');
  console.log(`詞彙 ${rows.length} 筆 → ${out}`);
} else {
  const a = applyTerms(text, terms);
  const fixes = loadFixes(FIXES);
  const f = fixTerms(text, terms, fixes);
  console.log(`檢查：未標記可補 ${a.marks} 處；既有標記可修 ${f.moved + f.extended} 處`);
}
