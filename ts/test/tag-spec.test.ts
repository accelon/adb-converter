/** Tag refactor：word-spec / link-spec 的契約（2026-11-06）。 */
import { parseWordSpec } from '../src/accelon26/word-spec';
import { isLinkTag, parseLinkSpec } from '../src/accelon26/link-spec';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + '  ' + detail); }
};
const get = (attrs: Record<string, string>) => (n: string) => attrs[n] ?? '';

const head = parseWordSpec('詞', get({ id: '1' }), true);
ok('詞：詞典模式是 dictHead', !!head && head.dictHead && !head.wordSpan && !head.zeroVa, JSON.stringify(head));

const homo = parseWordSpec('詞', get({ a: '2' }), true);
ok('詞 a：保留同形詞編號', !!homo && homo.homograph === '2', JSON.stringify(homo));

const inline = parseWordSpec('_詞', get({}), true);
ok('_詞：零 VA，不是詞頭', !!inline && inline.zeroVa && !inline.dictHead && !inline.wordSpan, JSON.stringify(inline));

const ci = parseWordSpec('辭', get({ b: 'x', j: '0' }), true);
ok('辭：詞譜 span，不是詞頭', !!ci && ci.wordSpan && !ci.dictHead && !ci.zeroVa, JSON.stringify(ci));

const ciInline = parseWordSpec('_辭', get({ b: 'x', j: '0' }), true);
ok('_辭：零 VA 詞譜', !!ciInline && ciInline.zeroVa && ciInline.wordSpan && !ciInline.dictHead, JSON.stringify(ciInline));

const zy = parseWordSpec('詞', get({ zy: 'ㄧ ㄇㄠˊ' }), false);
ok('zy 注音：同時產生拼音', !!zy?.pron && zy.pron.zy === 'ㄧ ㄇㄠˊ' && zy.pron.py === 'yī máo', JSON.stringify(zy));

const pyInZy = parseWordSpec('詞', get({ zy: 'yī máo' }), false);
ok('zy 放拼音：不標成注音', !!pyInZy?.pron && pyInZy.pron.zy === '' && pyInZy.pron.py === 'yī máo', JSON.stringify(pyInZy));

const alias = parseLinkSpec('_名', get({}));
ok('_名：entry／另開分頁', !!alias && alias.kind === 'entry' && alias.newTab && alias.target === '', JSON.stringify(alias));

const entry = parseLinkSpec('聯', get({ n: '一毛不拔' }));
ok('聯 n：entry／同頁', !!entry && entry.kind === 'entry' && !entry.newTab && entry.target === '一毛不拔', JSON.stringify(entry));

const entryHomo = parseLinkSpec('聯', get({ n: '阿房', a: '2' }));
ok('聯 n a：entry 同形詞目標', !!entryHomo && entryHomo.kind === 'entry' && entryHomo.homograph === '2', JSON.stringify(entryHomo));

const entryNew = parseLinkSpec('聯', get({ n: '一毛不拔', newtab: '1' }));
ok('聯 n newtab：另開分頁', !!entryNew && entryNew.kind === 'entry' && entryNew.newTab, JSON.stringify(entryNew));

const xref = parseLinkSpec('聯', get({ i: 'taisho?51p185b', q: '引文', j: '3-5' }));
ok('聯 i：xref 帶 q/j', !!xref && xref.kind === 'xref' && xref.target === 'taisho?51p185b' && xref.quote === '引文' && xref.range === '3-5', JSON.stringify(xref));

const both = parseLinkSpec('聯', get({ n: '詞條', i: 'ys?38p74a#229-231' }));
ok('聯 i 優先於 n', !!both && both.kind === 'xref', JSON.stringify(both));
ok('空聯不是連結', parseLinkSpec('聯', get({})) === null);

ok('isLinkTag', isLinkTag('_名') && isLinkTag('聯') && isLinkTag('_聯') && !isLinkTag('詞'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
