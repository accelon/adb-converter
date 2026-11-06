/** `<例 t="…"/>`：詞書體例分區的渲染與 HSV 色相（bun run test/example-marker.test.ts）。 */
import { Accelon3Renderer, readExampleScheme, setExampleScheme } from '../src/accelon26/render_accelon3';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + '  ' + detail); }
};

const ctx = { depthOf: new Map<string, number>(), levels: 0 };

const fake = { sourceText: async () => '<檔><集 scheme="注音,漢語拼音,釋義">成語典</集></檔>' };
const rawScheme = await readExampleScheme(fake);
ok('讀得到 <集 scheme>', rawScheme === '注音,漢語拼音,釋義', rawScheme);

setExampleScheme('注音,漢語拼音,釋義,典源');
const r = new Accelon3Renderer(ctx, { dictEntries: true });
const head = r.lineInfo('<例 t="注音"/>', 1);
ok('標記行是 liHeadLine', head.cls === 'liHeadLine', JSON.stringify(head));
ok('標記行有 liHead 標籤', head.html.includes('class="liHead"') && head.html.includes('注音'), head.html);
ok('標記行有 HSV 色', (head.style ?? '').includes('--li-color:rgb('), head.style ?? '');
ok('標記行有可見文字', head.visible === true);

const body = r.lineInfo('ㄧ　ㄇㄠˊ', 2);
ok('後續行不加 liBody', !body.cls && !body.style, JSON.stringify(body));

const short = new Accelon3Renderer(ctx, { dictEntries: true }).lineInfo('<例 t="注音">ㄧ　ㄇㄠˊ</例>', 1);
ok('短值：標籤與內容同一行', (short.html.match(/liHead/g) ?? []).length === 1 && short.html.includes('ㄧ　ㄇㄠˊ'), short.html);
ok('短值：後面沒有殘留分區狀態', !new Accelon3Renderer(ctx, { dictEntries: true }).lineInfo('下一行', 2).cls);

const next = r.lineInfo('<例 t="釋義"/>', 3);
ok('下一個例是新的標題行', next.cls === 'liHeadLine' && next.html.includes('釋義'), next.html);
ok('下一個例換色', (next.style ?? '') !== (head.style ?? ''), `${head.style} / ${next.style}`);

const reset = r.lineInfo('<詞 id="1">一毛不拔</詞>', 4);
const after = r.lineInfo('釋文', 5);
ok('詞條內文不加框', !reset.cls && !after.cls, JSON.stringify({ reset, after }));

setExampleScheme('釋義,注音');
const swapped = new Accelon3Renderer(ctx, { dictEntries: true }).lineInfo('<例 t="注音"/>', 1);
ok('集 scheme 的順序決定色相', (swapped.style ?? '') !== (head.style ?? ''), `${head.style} / ${swapped.style}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
