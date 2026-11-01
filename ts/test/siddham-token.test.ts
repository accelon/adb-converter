/**
 * 悉曇連字（`ra+virama+dha…`）在 tokenizer 裡可以收成**一個** token（一個 VA）。
 *
 *   bun run test/siddham-token.test.ts
 *
 * 這個規則**預設關閉**：現有 adb（taisho）的文字裡本來就有悉曇序列，
 * 合併會讓 VA 少 22 個、引文座標跑掉（2026-11-01 實測）。只有新庫、
 * 而且是以這個規則建索引時才開 `{ siddhamCluster: true }`。
 */
import { readFileSync } from 'node:fs';
import { Tokenizer } from '../src/tokenize';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + name + (detail ? '  ' + detail : '')); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
};

function literals(s: string, cluster = false): string[] {
  const tk = new Tokenizer(s, { siddhamCluster: cluster });
  const out: string[] = [];
  for (;;) {
    out.push(tk.nextLiteral());
    if (tk.atEnd) break;
  }
  return out;
}

const RA = '\u{115A8}', VIRAMA = '\u{115BF}', DHA = '\u{115A0}', LA = '\u{115A9}';
const rdhla = RA + VIRAMA + DHA + VIRAMA + LA;

const on = literals(rdhla, true);
ok('開啟後：rdhla 連字是一個 token', on.length === 1 && on[0] === rdhla, JSON.stringify(on));

const off = literals(rdhla);
ok('預設：rdhla 仍是原本的逐字 token', off.length === 5, String(off.length));

const two = literals(rdhla + rdhla, true);
ok('兩個連字是兩個 token', two.length === 2, JSON.stringify(two));

const mixed = literals(rdhla + '說', true);
ok('連字＋漢字＝2 個 token', mixed.length === 2 && mixed[1] === '說', JSON.stringify(mixed));

const halant = literals(RA + VIRAMA, true);
ok('字尾 halant 也是一個 token', halant.length === 1 && halant[0] === RA + VIRAMA, JSON.stringify(halant));

const pua = literals('\u{F0001}', true);
ok('PUA 單字仍是 1 個 token', pua.length === 1, JSON.stringify(pua));

// 1,993 個實際會用到的序列，開啟後全部必須是 1 個 token
const rows = JSON.parse(readFileSync(new URL('../../build/pua-seq.json', import.meta.url), 'utf8')) as
  { pua: string; id: string; seq: string; note: string }[];
const seqs = rows.filter((r) => r.seq);
let bad: string[] = [];
for (const r of seqs) {
  if (literals(r.seq, true).length !== 1) bad.push(r.id);
}
ok(`${seqs.length} 個梵字序列開啟後都是 1 個 token`, bad.length === 0, bad.slice(0, 5).join(','));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

