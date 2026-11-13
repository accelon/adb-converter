/**
 * 通用節點錨點（科判等結構節點）測試。
 *
 *   bun run test/anchor-node.test.ts [--ybh <path>] [--taisho <path>] [--sa <path>]
 *
 * 驗收：
 *   1. ybh 單一節點：anchorVa("kpD14-020") 落在 <科14 n="kpD14-020"> 那行（同值跨著作時取文件序第一筆）。
 *   2. ybh 命名空間：anchorVa("T1579#kpD03-001") 與 anchorVa("PXJ-H#kpD03-001") 為不同 VA。
 *   3. 節點範圍：nodeAnchorInfo 的 vaEnd > va；nodeSpanText 含節點標題與其下交叉引。
 *   4. 回歸：taisho 頁 id（30p328c）與 sa 塊.段（rv.1.2.1）行為不變；不存在的錨點回 null。
 *   5. ybh v3 卷級別名（章 id＝W-V）：T1579-1/-4/-21#kpD01-001 各自精確；篇級同值取
 *      文件序最後一筆；卷內沒有該值回 null（不退回篇級）。
 *   6. ybh v4 `<嵌 sub="1">`：子樹界＝下一個同層或更淺錨點（含子孫、不跨章）；
 *      `<節聯>` 的 parseLinkSpec（n= 同庫、i= 拆 db、無目標 null）。
 *
 * 只用到本地 adb（預設 D:\accelon3）；缺少的檔案會略過該段，不算失敗。
 */
import { existsSync } from 'node:fs';
import { AdbReader, SyncIO } from '../src/accelon26/adb';
import { VaPaMapper } from '../src/accelon26/vapa';
import { anchorVa, nodeAnchorInfo, nodeSpanText, nodeSubtreeEnd } from '../src/accelon26/page-text';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const YBH = opt('ybh', 'D:/accelon3/ybh-v2.adb');
const V3 = opt('v3', 'D:/accelon3/ybh-v3.adb');
const V4 = opt('v4', 'D:/accelon3/ybh-v4.adb');
const TAISHO = opt('taisho', 'D:/accelon3/taisho.adb');
const SA = opt('sa', 'D:/accelon3/sa.adb');

let pass = 0, fail = 0, skip = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + name + (detail ? '  ' + detail : '')); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
};
const skipped = (msg: string) => { skip++; console.log('  skip ' + msg); };

const open = (p: string) => AdbReader.open(new SyncIO(p));

/** 最小 DOM shim：xref 會拉進整個 UI 圖，載入期就碰 window/document；
 *  只為測 renderEmbed 的字串輸出，補幾個空殼即可。 */
function installDomShim(): void {
  const el = () => ({
    style: {}, dataset: {}, hidden: false, textContent: '', innerHTML: '',
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute() {}, removeAttribute() {}, append() {}, appendChild() {}, remove() {},
    addEventListener() {}, removeEventListener() {}, querySelector() { return null; },
    querySelectorAll() { return []; }, after() {}, insertBefore() {},
    getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
    focus() {}, closest() { return null; }, contains() { return false; }, getAttribute() { return null; },
  });
  const doc: any = {
    readyState: 'complete', hidden: false, activeElement: null,
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    getElementById() { return null; }, createElement() { return el(); }, createTextNode() { return el(); },
    createRange() { return { setStart() {}, setEnd() {}, setStartAfter() {}, setEndBefore() {}, getBoundingClientRect: el().getBoundingClientRect }; },
    body: el(), documentElement: el(), head: el(),
  };
  const g: any = globalThis;
  g.window = g; g.document = doc; g.self = g;
  g.navigator = { clipboard: { writeText: async () => {}, write: async () => {} }, userAgent: 'bun' };
  g.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  g.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {} });
  g.requestAnimationFrame = () => 0; g.cancelAnimationFrame = () => {};
  g.CSS = { highlights: new Map() };
  g.location = { href: 'file:///test', search: '', hash: '' };
}

// ── ybh：通用節點錨點 ─────────────────────────────────────────
if (!existsSync(YBH)) {
  skipped('缺 ' + YBH + '（ybh 段略過）');
} else {
  console.log('\n=== ybh：' + YBH + ' ===');
  const r = await open(YBH);
  const mp = new VaPaMapper(r); await mp.init();
  const lineAt = async (va: number) => (await mp.lineText(mp.edgeLine(va)));

  // 1. 純值（同值跨著作時取文件序第一筆）
  const bare = await anchorVa(r, 'kpD14-020');
  ok('bare kpD14-020 可解析', bare != null, String(bare));
  if (bare != null) {
    ok('bare 落在 <科14 n="kpD14-020">', (await lineAt(bare)).includes('<科14 n="kpD14-020"'));
  }

  // 2. 命名空間：同 id 不同著作 → 不同 VA
  const a = await anchorVa(r, 'T1579#kpD03-001');
  const b = await anchorVa(r, 'PXJ-H#kpD03-001');
  ok('T1579#kpD03-001 可解析', a != null, String(a));
  ok('PXJ-H#kpD03-001 可解析', b != null, String(b));
  ok('兩個命名空間 VA 不同', a != null && b != null && a !== b, `${a} vs ${b}`);
  if (a != null) ok('T1579 命中 <科03 n="kpD03-001">', (await lineAt(a)).includes('<科03 n="kpD03-001"'));
  if (b != null) ok('PXJ-H 命中 <科03 n="kpD03-001">', (await lineAt(b)).includes('<科03 n="kpD03-001"'));

  // 3. 節點範圍與取文（<嵌> 用同一組函式）
  const info = await nodeAnchorInfo(r, 'T1579#kpD03-001');
  ok('nodeAnchorInfo 有 vaEnd', !!info && info.vaEnd != null && info.vaEnd > info.va, info ? `${info.va}→${info.vaEnd}` : '(null)');
  if (info) {
    ok('命名空間解出 T1579', info.ns === 'T1579', info.ns);
    const txt = await nodeSpanText(r, info.va, info.vaEnd);
    ok('節點範圍文字非空', txt.length > 0, txt.length + ' chars');
    ok('含節點標題「問答標列十七地名」', txt.includes('問答標列十七地名'));
    ok('含其下交叉引（T1580-1#kpD04-003）', txt.includes('〔T1580-1#kpD04-003〕'));
  }

  // 3.5 <嵌> 端到端：renderEmbed 的節點分支（動態載入 xref，需先裝 DOM shim）
  installDomShim();
  const { renderEmbed } = await import('../src/accelon26/xref');
  const emb = await renderEmbed('ybh', 'kpD14-020', '', '', '出體', false, r);
  ok('<嵌> 節點內容非空', emb.html.length > 0, emb.html.length + ' chars');
  ok('<嵌> 含節點標題文字', emb.html.includes('明其中可得諸法'));
  ok('<嵌> 不是錯誤訊息', !emb.html.includes('找不到') && !emb.html.includes('沒有頁碼表'));

  // 4. 找不到
  ok('未知錨點回 null', (await anchorVa(r, 'no-such-anchor')) == null);
  ok('命名空間不存在回 null', (await anchorVa(r, 'T1579#nope-999')) == null);
  ok('快取後結果一致', (await anchorVa(r, 'T1579#kpD03-001')) === a);
}

// ── ybh v3：卷級 NS 別名（章 id＝W-V）─────────────────────────
if (!existsSync(V3)) skipped('缺 ' + V3 + '（卷級別名略過）');
else {
  console.log('\n=== ybh v3 卷級別名：' + V3 + ' ===');
  const r = await open(V3);
  const mp = new VaPaMapper(r); await mp.init();
  const lineAt = async (va: number) => mp.lineText(mp.edgeLine(va));

  // 雙層檔頭：篇 id 與章 id（W-V）都要存在
  const pianId = await r.attributeValues('篇.id').catch(() => null);
  const zhangId = await r.attributeValues('章.id').catch(() => null);
  ok('篇 id 存在（雙層檔頭）', !!pianId && (pianId.values?.length ?? 0) > 0, String(pianId?.values?.length ?? 0));
  ok('章 id 存在且形如 W-V', !!zhangId && /-\d+$/.test(zhangId.values?.[0] ?? ''), (zhangId?.values?.[0] ?? '(none)'));

  // kpD01-001 在 T1579 的多卷重複（-1/-4/-11/-16/-20/-21）→ 卷級必須各自精確
  const v1 = await anchorVa(r, 'T1579-1#kpD01-001');
  const v4 = await anchorVa(r, 'T1579-4#kpD01-001');
  const v21 = await anchorVa(r, 'T1579-21#kpD01-001');
  ok('T1579-1#kpD01-001 可解析', v1 != null, String(v1));
  ok('T1579-4#kpD01-001 可解析', v4 != null, String(v4));
  ok('T1579-21#kpD01-001 可解析', v21 != null, String(v21));
  ok('三卷 VA 互不相同', v1 != null && v4 != null && v21 != null && new Set([v1, v4, v21]).size === 3, `${v1}/${v4}/${v21}`);
  for (const [q, va] of [['T1579-1', v1], ['T1579-4', v4], ['T1579-21', v21]] as [string, number | null][]) {
    if (va != null) ok(q + ' 落在 n="kpD01-001" 的節點', (await lineAt(va)).includes('n="kpD01-001"'));
  }

  // 篇級同值多卷：語義＝文件序最後一筆（與 T1579-21 相同）——README 已寫死
  const pian = await anchorVa(r, 'T1579#kpD01-001');
  ok('篇級 T1579#kpD01-001 = 最後一卷（last）', pian != null && pian === v21, `${pian} vs ${v21}`);

  // 卷內沒有該值 → null（不退回篇級）
  ok('T1579-2#kpD03-001 卷內不存在 → null', (await anchorVa(r, 'T1579-2#kpD03-001')) == null);

  // 驗收鉤子：卷 1 的 kpD03-001
  const hook = await anchorVa(r, 'T1579-1#kpD03-001');
  ok('驗收鉤子 T1579-1#kpD03-001 可解析', hook != null, String(hook));
  if (hook != null) ok('鉤子落在 <科03 n="kpD03-001">', (await lineAt(hook)).includes('n="kpD03-001"'));
}

// ── ybh v4：<嵌 sub="1"> 子樹界 ＋ <節聯> 解析 ────────────────
if (!existsSync(V4)) skipped('缺 ' + V4 + '（子樹／節聯段略過）');
else {
  console.log('\n=== ybh v4 子樹與節聯：' + V4 + ' ===');
  const r = await open(V4);
  const mp = new VaPaMapper(r); await mp.init();

  // 節聯 parseLinkSpec（純函式，不碰 DOM）
  const { isLinkTag, parseLinkSpec } = await import('../src/accelon26/link-spec');
  ok('節聯／_節聯 屬 link model', isLinkTag('節聯') && isLinkTag('_節聯'));
  const s1 = parseLinkSpec('節聯', (a) => (a === 'n' ? 'T1579-1#kpD03-001' : ''));
  ok('節聯 n= → kind node、同庫', s1?.kind === 'node' && s1.target === 'T1579-1#kpD03-001' && (s1 as { db?: string }).db === '', s1 ? s1.kind : 'null');
  const s2 = parseLinkSpec('節聯', (a) => (a === 'i' ? 'jingang?33p158a' : ''));
  ok('節聯 i= → 拆出 db＋anchor', s2?.kind === 'node' && s2.target === '33p158a' && (s2 as { db?: string }).db === 'jingang');
  ok('節聯沒有 n/i → null', parseLinkSpec('節聯', () => '') == null);

  // 子樹界：科01（有子）→ 界必須比首個子節點深、且不跨下一卷的章
  const top = await nodeAnchorInfo(r, 'T1579-1#kpD01-001');
  ok('T1579-1#kpD01-001 可解析', top != null, top ? String(top.va) : '');
  if (top) {
    const se = await nodeSubtreeEnd(r, top.va);
    ok('子樹界 > 節點且首筆界 < 子樹界（有深度）', se != null && se > top.va && top.vaEnd < se, `va=${top.va} first=${top.vaEnd} sub=${se}`);
    const subTxt = await nodeSpanText(r, top.va, se, 6000);
    ok('子樹文字含後代標題（五識身相應地）', subTxt.includes('五識身相應地'));
    ok('子樹不跨入下一卷（無「卷第2」）', !subTxt.includes('卷第2'), 'len ' + subTxt.length);
    // 葉節點：D1 問 → 子樹界＝同層下一兄弟 D2 答（=首筆界）
    const leaf = await nodeAnchorInfo(r, 'T1579-1#kpD04-001');
    if (leaf) {
      const lse = await nodeSubtreeEnd(r, leaf.va);
      ok('葉節點子樹界＝首筆界（同層下一兄弟）', lse === leaf.vaEnd, `${lse} vs ${leaf.vaEnd}`);
    }
    // renderEmbed 端到端：sub 覆寫範圍、不带 sub 維持舊行為
    installDomShim();
    const { renderEmbed, embedNodeBody } = await import('../src/accelon26/xref');
    const plain = await renderEmbed('ybh', 'T1579-1#kpD01-001', '', '', 'C1', false, r);
    const subEmb = await renderEmbed('ybh', 'T1579-1#kpD01-001', '', '', 'C1', false, r, { sub: true, max: 6000 });
    ok('sub 嵌比不 sub 長（含整棵子樹）', subEmb.html.length > plain.html.length, `${plain.html.length} → ${subEmb.html.length}`);
    ok('sub 嵌含後代「五識身相應地」', subEmb.html.includes('五識身相應地'));
    ok('不 sub 的舊行為不變（停在首個子節點界前）', plain.html.length < subEmb.html.length && !plain.html.includes('問答標列十七地名'), `${plain.html.length} vs ${subEmb.html.length}`);
    // 樹形渲染（作者：科判要有樹，不能舖平）
    const tiers = (subEmb.html.match(/class="embedTier"/g) ?? []).length;
    ok('sub 嵌把科判渲染成 embedTier 块（≥4 層）', tiers >= 4, 'tiers=' + tiers);
    ok('tier 縮排隨深度遞增（1.2/2.4em 都在）',
      subEmb.html.includes('padding-left:1.2em') && subEmb.html.includes('padding-left:2.4em'));
    ok('樹形輸出不再用 <br> 平舖標題行', !/<br>▸ /.test(subEmb.html), '');
    const t1 = embedNodeBody('<科02 n="kpD02-001">子科</科02>說明文字。');
    ok('標題後同行文字掛同層縮排', t1.includes('embedTier') && t1.includes('padding-left:1.2em') && t1.includes('說明文字'), t1);
    const t2 = embedNodeBody('詳見<節聯 n="W1-1#kpD02-002">子科二</節聯>一段。');
    ok('嵌入內容裡的節聯仍可點（data-link="node"）',
      t2.includes('data-link="node"') && t2.includes('data-node="W1-1#kpD02-002"'), t2);
    const t3 = embedNodeBody('<科01 n="a">甲</科01>正文一。\n<科02 n="b">乙</科02>正文二。');
    ok('純文字行逐行成 block、順序不變', t3.indexOf('正文一') < t3.indexOf('乙') && t3.split('embedBodyLine').length === 3, t3);
  }
}

// ── 回歸：taisho 頁 id ───────────────────────────────────────
if (!existsSync(TAISHO)) skipped('缺 ' + TAISHO + '（頁 id 回歸略過）');
else {
  console.log('\n=== taisho 回歸：' + TAISHO + ' ===');
  const r = await open(TAISHO);
  const va = await anchorVa(r, '30p328c');
  ok('頁 id 30p328c 仍可解析', va != null, String(va));
}

// ── 回歸：sa 塊.段 ──────────────────────────────────────────
if (!existsSync(SA)) skipped('缺 ' + SA + '（塊.段回歸略過）');
else {
  console.log('\n=== sa 回歸：' + SA + ' ===');
  const r = await open(SA);
  const va = await anchorVa(r, 'rv.1.2.1');
  ok('塊.段 rv.1.2.1 仍可解析', va != null, String(va));
  ok('塊.段不存在的段回 null', (await anchorVa(r, 'rv.1.2.9999')) == null);
}

console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
if (fail) process.exit(1);