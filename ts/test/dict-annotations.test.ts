/** `<詞 py|zy>` 注音／拼音，以及 `<彈 t>` 提示標記。 */
import { Accelon3Renderer } from '../src/accelon26/render_accelon3';
import { bpmf2pinyin } from '../src/accelon26/bpmf2pinyin';
import { Tokenizer, isSkipTag } from '../src/tokenize';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + '  ' + detail); }
};
const ctx = { depthOf: new Map<string, number>(), levels: 0 };

ok('注音轉拼音', bpmf2pinyin('ㄧ ㄇㄠˊ ㄅㄨˋ ㄅㄚˊ') === 'yī máo bù bá', bpmf2pinyin('ㄧ ㄇㄠˊ ㄅㄨˋ ㄅㄚˊ'));

const r = new Accelon3Renderer(ctx);
const both = r.lineInfo('<詞 id="1" zy="ㄧ ㄇㄠˊ">一毛不拔</詞>', 1);
ok('zy：渲染注音＋拼音', both.html.includes('pronZy') && both.html.includes('pronPy') && both.html.includes('yī máo'), both.html);
ok('zy：詞頭文字保留', both.html.includes('一毛不拔'), both.html);

const r2 = new Accelon3Renderer(ctx);
const py = r2.lineInfo('<詞 id="1" py="yī máo">一毛不拔</詞>', 1);
ok('py：只渲染拼音', py.html.includes('pronPy') && !py.html.includes('pronZy'), py.html);

const r2b = new Accelon3Renderer(ctx);
const pinyinInZy = r2b.lineInfo('<詞 id="1" zy="yī máo">一毛不拔</詞>', 1);
ok('zy 放的是拼音時不要標成注音', pinyinInZy.html.includes('pronPy') && !pinyinInZy.html.includes('pronZy'), pinyinInZy.html);

const head = new Accelon3Renderer(ctx, { dictEntries: true }).lineInfo('<詞 id="1">一毛不拔</詞>', 1);
ok('詞頭預設用 dictHead（比正文大）', head.html.includes('class="dictHead"'), head.html);
const homograph = new Accelon3Renderer(ctx, { dictEntries: true }).lineInfo('<詞 a="2">阿房</詞>', 1);
ok('詞 a：詞頭顯示上標，內容仍是乾淨值', homograph.html.includes('阿<sup class="homograph">2</sup>房') && homograph.html.includes('房'), homograph.html);
const homographLink = new Accelon3Renderer(ctx, { dictEntries: true }).lineInfo('<聯 n="阿房" a="2">阿房</聯>', 1);
ok('聯 a：目標帶同形詞，連結文字不加 suptag', homographLink.html.includes('data-homograph="2"') && !homographLink.html.includes('<sup'), homographLink.html);
const notHead = new Accelon3Renderer(ctx, { dictEntries: true }).lineInfo('<詞 b="x">word</詞>', 1);
ok('cs 的詞譜 <詞 b> 不當詞頭', !notHead.html.includes('dictHead') && notHead.html.includes('class="word"'), notHead.html);
const ci = new Accelon3Renderer(ctx, { dictEntries: true }).lineInfo('<辭 b="x" j="0">word</辭>', 1);
ok('cs 新詞譜 <辭 b/j> 仍走 word', !ci.html.includes('dictHead') && ci.html.includes('class="word"'), ci.html);
const inlineWord = new Accelon3Renderer(ctx, { dictEntries: true }).lineInfo('<_詞>word</_詞>', 1);
ok('_詞 零 VA 行內詞不當詞頭', !inlineWord.html.includes('dictHead') && !inlineWord.html.includes('class="word"'), inlineWord.html);
const alias = new Accelon3Renderer(ctx).lineInfo('<_名>詞條</_名>', 1);
ok('_名 是另開分頁的連結', alias.html.includes('data-link="entry"') && alias.html.includes('data-newtab="1"') && alias.html.includes('詞條'), alias.html);

const r3 = new Accelon3Renderer(ctx);
const tan = r3.lineInfo('<彈 t="提示文字">看這裡</彈>', 1);
ok('彈：文字留在正文', tan.html.includes('看這裡'), tan.html);
ok('彈：t 放在 data-tip，不進正文', tan.html.includes('data-tip="提示文字"') && !tan.html.includes('>提示文字<'), tan.html);
ok('彈：tag 是 skip（VA=0）', isSkipTag('<彈>') && isSkipTag('</彈>'), 'isSkipTag');
const tk = new Tokenizer('<彈 t="提示<tag>文字">看這裡</彈>');
const first = tk.nextLiteral();
ok('彈：t 內有 tag 時整段不被切斷', first === '<彈 t="提示<tag>文字">', JSON.stringify(first));

const complex = new Accelon3Renderer(ctx).lineInfo('<彈 t="提示<tag>文字">看這裡</彈>', 1);
ok('彈：t 內的 tag 只留在 data-tip', complex.html.includes('data-tip="提示&lt;tag&gt;文字"') && complex.html.includes('看這裡'), complex.html);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
