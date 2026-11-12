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
 *
 * 只用到本地 adb（預設 D:\accelon3）；缺少的檔案會略過該段，不算失敗。
 */
import { existsSync } from 'node:fs';
import { AdbReader, SyncIO } from '../src/accelon26/adb';
import { VaPaMapper } from '../src/accelon26/vapa';
import { anchorVa, nodeAnchorInfo, nodeSpanText } from '../src/accelon26/page-text';

const args = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const YBH = opt('ybh', 'D:/accelon3/ybh-v2.adb');
const V3 = opt('v3', 'D:/accelon3/ybh-v3.adb');
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