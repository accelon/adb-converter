/**
 * Obsidian vault → adb lines (`vault-plan.ts`).
 *
 *   bun run test/vault-plan.test.ts
 *
 * 作者 2026-10-25 的錯誤回報：筆記裡有 `<`、`>` 或 `&` 時，整個匯入被
 * 「line contains <, > or & (would corrupt the markup)」擋掉。這些字在
 * Accelon3 的 XML 方言裡要寫成實體（`&lt;`／`&gt;`／`&amp;`）；本測試確認
 * 計畫器會跳脫它們、而渲染器會還原成畫面上的原字。
 */
import { AdbReader, BlobIO } from '../src/accelon26/adb';
import { Accelon3Renderer } from '../src/accelon26/render_accelon3';
import { authorAdb } from '../src/adbauthor';
import { planVault } from '../src/vault-plan';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + name + (detail ? '  ' + detail : '')); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
};

const files = [
  {
    path: '01-〈A&B篇〉/01-01第一章.md',
    text: '甲 < 乙 & 丙 > 丁\n> 引用\n[[般若|空 & 有]]\n![圖](a&b.png)',
  },
  { path: 'A&B.md', text: '字 & 義' },
  { path: 'a&b.png', bytes: new Uint8Array([1, 2, 3]) },
];

const plan = planVault(files, { title: 'A&B <測試>' });
ok('含 < > & 的 vault 不再丟錯', plan.lines.length > 0, `${plan.lines.length} lines`);

const body = plan.lines.find((l) => l.includes('甲'))!;
ok('本文的 < > & 變成 XML 實體',
  body === '甲 &lt; 乙 &amp; 丙 &gt; 丁', body);

ok('blockquote 的 > 也跳脫',
  plan.lines.includes('&gt; 引用'), plan.lines.find((l) => l.includes('引用')) ?? '');

const link = plan.lines.find((l) => l.startsWith('<聯'))!;
ok('連結的目標與顯示文字都跳脫',
  link === '<聯 n="般若">空 &amp; 有</聯>', link);

const img = plan.lines.find((l) => l.startsWith('<圖'))!;
ok('圖檔名有 & 時屬性也跳脫',
  img === '<圖 n="a&amp;b.png"/>', img);

ok('集名／篇名／章名／字頭都跳脫',
  plan.lines[0] === '<集 t="集">A&amp;B &lt;測試&gt;</集>'
  && plan.lines.includes('<篇 t="章">A&amp;B第一</篇>')
  && plan.lines.includes('<章>第一章</章>')
  && plan.lines.includes('<字>A&amp;B</字>'),
  [plan.lines[0], ...plan.lines.filter((l) => l.startsWith('<篇') || l.startsWith('<章') || l.startsWith('<字'))].join(' ｜ '));

// 畫面：adb 存的是實體，渲染器解回原字後再跳脫成 HTML —— 讀者看到的是原字。
const r = new Accelon3Renderer({
  depthOf: new Map([['集', 0], ['篇', 0], ['章', 1], ['字', 0]]),
  levels: 2,
});
ok('渲染後畫面仍是原字（HTML 只跳脫一次）',
  r.line(body, 1) === '甲 &lt; 乙 &amp; 丙 &gt; 丁', r.line(body, 1));
const linkHtml = r.line(link, 1);
ok('連結文字與 data-entry 解回原字',
  linkHtml.includes('data-entry="般若"') && linkHtml.endsWith('>空 &amp; 有</a>'), linkHtml);

// 作者原本就可能寫了實體（`&lt;` 是四個字）：要保留成文字，不能解成 `<`。
const encoded = planVault([{ path: '01-〈A篇〉/01-01第一章.md', text: '&lt;' }]);
const encLine = encoded.lines.find((l) => l.includes('amp'))!;
ok('原本的 &lt; 再多跳脫一層（只解一層才還原成文字）',
  encLine === '&amp;lt;', encLine);
ok('&lt; 在畫面上是文字 &lt;，不是 <',
  r.line(encLine, 1) === '&amp;lt;', r.line(encLine, 1));

// 不是圖片的 ![[…]]：留下原文（一樣跳脫），並給一則 warning。
const note = planVault([{ path: '01-〈A篇〉/01-01第一章.md', text: '![[a&b.txt]]' }]);
ok('非圖片附件留原文並跳脫',
  note.lines.includes('![[a&amp;b.txt]]') && note.warnings.some((w) => w.includes('a&b.txt')),
  note.lines.find((l) => l.includes('a&amp;b')) ?? '');

// 端到端：真的建一個 adb，名稱表（目錄／詞典標籤的來源）要解回 `A&B`。
const built = await authorAdb({
  dbname: 'vault',
  dbcname: 'A&B <測試>',
  lines: plan.lines,
  resources: plan.resources.map((r) => ({ name: r.name, bytes: Buffer.from(r.bytes) })),
});
const reader = await AdbReader.open(new BlobIO(new Blob([built.file])));
const labels = await reader.cachedStrings('字');
ok('adb 的 caches/字 把實體解回原字',
  labels.includes('A&B'), JSON.stringify(labels));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
