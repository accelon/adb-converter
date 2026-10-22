/**
 * 標籤樣式（tag-style.ts）的單元測試：合併、天干地支 22 層、序列化與版本。
 *
 *   bun run test/tag-style.test.ts
 */
import {
  BODY_KEY, GROUP_ID, GROUP_TAGS, SETTINGS_VERSION, STRUCTURAL_TAGS, applySettingsFile, bodyStyleOf,
  counts, defaultFontOf, entryOf, fontFamilyOf, memberIndex, parseSettings, rampColor, resetTagStyles,
  setActiveDb, setEntry, tagStyleOf, toSettingsFile,
} from '../src/accelon26/tag-style';
import { Accelon3Renderer } from '../src/accelon26/render_accelon3';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + name + (detail ? '  ' + detail : '')); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
};

resetTagStyles();
setActiveDb('yinshun.adb', '印順法師佛學著作集');

// ---- 合併與繼承 ------------------------------------------------------------
ok('auto：沒有自訂 → tagStyleOf 回 null', tagStyleOf('章') === null);

setEntry('global', '章', { color: '#7cc0ff', size: 125, font: 'DFKai-SB', font2: 'Noto Serif CJK TC' });
ok('全域自訂：章有自訂樣式', tagStyleOf('章')?.color === '#7cc0ff' && tagStyleOf('章')?.size === 125);

setEntry('adb', '章', { color: '#ff0000', size: 200 });
ok('此庫覆寫：章用此庫的顏色／大小、字型沒有就留 null（＝本文）',
  tagStyleOf('章')?.color === '#ff0000' && tagStyleOf('章')?.size === 200 && tagStyleOf('章')?.font === null,
  JSON.stringify(tagStyleOf('章')));

setEntry('adb', '章', null);
ok('刪除此庫覆寫：章回到全域', tagStyleOf('章')?.color === '#7cc0ff' && entryOf('adb', '章') === undefined);

ok('大小被夾在 50–300',
  (() => { setEntry('global', '節', { size: 999 }); const a = tagStyleOf('節')?.size; setEntry('global', '節', { size: -5 }); const b = tagStyleOf('節')?.size; setEntry('global', '節', null); return a === 300 && b === 50; })());

// ---- 天干地支：同一個群組、22 層、色相 +30° --------------------------------
ok('天干地支 22 個、甲是第 0 層、亥是第 21 層',
  GROUP_TAGS.length === 22 && memberIndex('甲') === 0 && memberIndex('亥') === 21 && memberIndex('章') === -1);

setEntry('global', GROUP_ID, { color: '#ff0000', size: 105, font: '' });
const jia = tagStyleOf('甲')!;
const yi = tagStyleOf('乙')!;
const hai = tagStyleOf('亥')!;
ok('21 個成員都用群組那一組（大小 105）',
  GROUP_TAGS.every((t) => tagStyleOf(t)?.size === 105));
ok('甲＝0°、乙＝+30°、亥＝+270°（色相每層 +30°）',
  jia.color === rampColor('#ff0000', 0) && yi.color === rampColor('#ff0000', 1) && hai.color === rampColor('#ff0000', 21),
  JSON.stringify({ jia: jia.color, yi: yi.color, hai: hai.color }));
ok('rampColor 只轉色相：第 1 層是 hsl(30.0 100.0% 50.0%)', rampColor('#ff0000', 1) === 'hsl(30.0 100.0% 50.0%)', rampColor('#ff0000', 1));
ok('成員不能單獨設定（setEntry 會被忽略）', (() => { setEntry('global', '甲', { color: '#00ff00' }); return entryOf('global', '甲') === undefined; })());
// 群組「本身」也要查得到（設定頁那一列）
const groupSelf = tagStyleOf(GROUP_ID);
ok('群組本身：tagStyleOf(天干地支) 回群組的底色／大小',
  groupSelf?.color === '#ff0000' && groupSelf?.size === 105, JSON.stringify(groupSelf));
setEntry('adb', GROUP_ID, { color: '#00ff00', size: 120 });
ok('此庫的天干地支覆寫：群組本身與 22 個成員都換',
  tagStyleOf(GROUP_ID)?.color === '#00ff00' && tagStyleOf(GROUP_ID)?.size === 120
  && tagStyleOf('甲')?.size === 120 && tagStyleOf('甲')?.color === rampColor('#00ff00', 0));
setEntry('adb', GROUP_ID, null);

// ---- 序列化：只存差異、adb 鍵＝檔名 ----------------------------------------
setEntry('global', '章', { color: '#7cc0ff', size: 125 });
setEntry('adb', '節', { color: '#00ff00', size: 113 });
const file = toSettingsFile();
const adb = file.profiles.adb?.['yinshun.adb'];
ok('settings.json v1：format／version', file.format === 'accelon26-settings' && file.version === SETTINGS_VERSION);
ok('全域只放改過的章與天干地支',
  !!file.profiles.global?.tagStyle?.tags?.['章'] && !!file.profiles.global?.tagStyle?.groups?.[GROUP_ID]
  && !file.profiles.global?.tagStyle?.tags?.['節'], JSON.stringify(file.profiles.global));
ok('此庫的鍵＝檔名、name 是中文庫名',
  !!adb && adb.name === '印順法師佛學著作集' && adb.tagStyle?.tags?.['節']?.color === '#00ff00',
  JSON.stringify(adb));

// ---- 讀回來（round-trip） --------------------------------------------------
const text = JSON.stringify(file);
const parsed = parseSettings(text);
ok('parseSettings：合法的 v1', parsed.ok && parsed.file?.version === 1 && parsed.file?.profiles.adb?.['yinshun.adb'] != null);
resetTagStyles();
setActiveDb('yinshun.adb', '印順法師佛學著作集');
if (parsed.file) applySettingsFile(parsed.file);
ok('applySettingsFile：章與天干地支都回來',
  tagStyleOf('章')?.color === '#7cc0ff' && tagStyleOf('甲')?.color === rampColor('#ff0000', 0));
ok('counts：全域 2、此庫 1', counts().global === 2 && counts().adb === 1, JSON.stringify(counts()));

// ---- 版本與格式 ------------------------------------------------------------
const badFormat = parseSettings(JSON.stringify({ format: 'x', version: 1, profiles: {} }));
ok('不是 accelon26-settings → 拒絕', !badFormat.ok, badFormat.error || '');
const newer = parseSettings(JSON.stringify({ format: 'accelon26-settings', version: 2, profiles: {} }));
ok('版本比程式新 → 拒絕（提示更新）', !newer.ok && /更新|新/.test(newer.error || ''), newer.error || '');
const broken = parseSettings('{oops');
ok('壞掉的 JSON → 拒絕', !broken.ok, broken.error || '');

// ---- 重建 adb 不動設定（同檔名仍套用） -------------------------------------
setActiveDb('yinshun.adb', '印順法師佛學著作集（重建後）');
ok('換到同檔名的重建 adb：設定還在', tagStyleOf('章')?.color === '#7cc0ff');

// ---- 本文樣式（作者 2026-10-22） -------------------------------------------
ok('內置標籤多了文／項／部／經',
  ['文', '項', '部', '經'].every((t) => (STRUCTURAL_TAGS as readonly string[]).includes(t)));
ok('經的預設字型是楷體（跨平台堆疊）',
  defaultFontOf('經') === '楷體' && fontFamilyOf({ font: '楷體' }).includes("'DFKai-SB', 'KaiTi', '楷體'"));

setEntry('global', BODY_KEY, { color: '#ff0000', font: 'DFKai-SB', font2: 'Noto Serif CJK TC', size: 99 });
const bs = bodyStyleOf();
ok('本文：bodyStyleOf 回顏色／字型／字級（size 夾在 8–30pt）',
  bs?.color === '#ff0000' && bs?.font === 'DFKai-SB' && bs?.font2 === 'Noto Serif CJK TC'
  && bs?.size === 30 && entryOf('global', BODY_KEY)?.size === 30, JSON.stringify(bs));
setEntry('adb', BODY_KEY, { color: '#00ff00' });
ok('本文：此庫可以覆寫（整個條目）', bodyStyleOf()?.color === '#00ff00');
setEntry('adb', BODY_KEY, null);
const bodyFile = toSettingsFile();
ok('settings.json 存本文的顏色／字型／字級（pt）',
  bodyFile.profiles.global?.tagStyle?.body?.color === '#ff0000'
  && bodyFile.profiles.global?.tagStyle?.body?.font === 'DFKai-SB'
  && bodyFile.profiles.global?.tagStyle?.body?.size === 30,
  JSON.stringify(bodyFile.profiles.global?.tagStyle?.body));
{
  const rr = parseSettings(JSON.stringify(bodyFile));
  resetTagStyles();
  setActiveDb('yinshun.adb', '印順法師佛學著作集');
  if (rr.file) applySettingsFile(rr.file);
  ok('本文樣式 round-trip', bodyStyleOf()?.color === '#ff0000'
    && bodyStyleOf()?.font === 'DFKai-SB' && bodyStyleOf()?.size === 30);
}
setEntry('global', BODY_KEY, null);
ok('重設本文回到 null', bodyStyleOf() === null);

// ---- 渲染：<經> 沒有自訂字型時用楷體 ---------------------------------------
{
  const r = new Accelon3Renderer({ depthOf: new Map([['經', 1]]), levels: 2 });
  const html = r.line('<經>甲</經>');
  ok('renderer：<經> 預設楷體堆疊', html.includes("'DFKai-SB', 'KaiTi', '楷體'"), html);
}
setEntry('global', '經', { color: '#00aaff' });
{
  const r = new Accelon3Renderer({ depthOf: new Map([['經', 1]]), levels: 2 });
  const html = r.line('<經>乙</經>');
  ok('renderer：<經> 只改顏色時仍保留預設楷體',
    html.includes('--tagtext:#00aaff') && html.includes("'DFKai-SB', 'KaiTi', '楷體'"), html);
}
setEntry('global', '經', null);

// ---- 渲染：自訂顏色／大小／字型（第一種 → 第二種 → 本文） --------------------
setEntry('global', '章', { color: '#7cc0ff', size: 200, font: 'DFKai-SB', font2: 'Noto Serif CJK TC' });
{
  const r = new Accelon3Renderer({ depthOf: new Map([['章', 1]]), levels: 2 });
  const html = r.line('<章>甲</章>');
  ok('renderer：標題套用自訂顏色、大小與字型（第二種當 fallback）',
    html.includes('font-size:200%') && html.includes('--tagtext:#7cc0ff')
    && html.includes("font-family:'DFKai-SB', 'Noto Serif CJK TC'"),
    html);
}
setEntry('global', '章', null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
