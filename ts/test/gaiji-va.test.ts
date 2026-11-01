/**
 * 缺字／梵字在 VA 上必須恰好佔 **一個** token（一個 VA 位）。
 *
 *   bun run test/gaiji-va.test.ts
 *
 * 這是「引文座標不變」的前提：`&CB…;`／`&SD-…;`／`&RJ-…;` 由 tokenizer 的
 * strong pair（`&` … `;`）視為一個 literal；換成一個 Unicode 字（BMP 或
 * surrogate pair）也仍是一個 literal。若換成兩個字（例如組字式 `⿰口口`）
 * 就會多佔 VA，將來改字型／glyphwiki 時座標會跑掉。
 */
import { Tokenizer } from '../src/tokenize';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + name + (detail ? '  ' + detail : '')); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
};

/** 依序取出所有 literal；用同一個 Tokenizer，和 vapa.ts 的 walk 一樣。 */
function literals(s: string): string[] {
  const tk = new Tokenizer(s);
  const out: string[] = [];
  for (;;) {
    out.push(tk.nextLiteral());
    if (tk.atEnd) break;
  }
  return out;
}

const cb = literals('&CB00178;');
ok('&CB…; 是一個 token', cb.length === 1 && cb[0] === '&CB00178;', JSON.stringify(cb));

const sd = literals('&SD-D5B5;');
ok('&SD-…; 是一個 token', sd.length === 1 && sd[0] === '&SD-D5B5;', JSON.stringify(sd));

const rj = literals('&RJ-CCBA;');
ok('&RJ-…; 是一個 token', rj.length === 1 && rj[0] === '&RJ-CCBA;', JSON.stringify(rj));

const bmp = literals(String.fromCodePoint(0xe000));
ok('BMP PUA 字是一個 token', bmp.length === 1 && bmp[0] === String.fromCodePoint(0xe000));

const sup = literals(String.fromCodePoint(0x1075b5));
ok('第 16 平面 PUA（surrogate pair）是一個 token', sup.length === 1 && sup[0] === String.fromCodePoint(0x1075b5));

const cjk = literals(String.fromCodePoint(0x267db));
ok('Unicode 擴充區漢字（surrogate pair）是一個 token', cjk.length === 1 && cjk[0] === String.fromCodePoint(0x267db));

const two = literals('&CB00178;&CB00179;');
ok('兩個相鄰缺字是兩個 token（正確）', two.length === 2, JSON.stringify(two));

const composition = literals('⿰口口');
ok('IDS 組字式（⿰…）仍是一個 token（parseIds）', composition.length === 1, JSON.stringify(composition));

const plainTwo = literals('口口');
ok('兩個普通字是兩個 token（不可用來取代單一缺字）', plainTwo.length === 2, JSON.stringify(plainTwo));

const mixed = literals('說&CB00178;法');
ok('缺字夾在文字中仍只佔一個 token', mixed.length === 3 && mixed[1] === '&CB00178;', JSON.stringify(mixed));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
