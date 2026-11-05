/**
 * 表格區塊：`<表>`（管線表）與 `<圖文字>`（框線字藝術）→ 版面塊。
 *
 *   bun run test/table-block.test.ts
 *
 * 驗的是作者 2026-11-06 定的規則：
 *   * 一列一行、每列仍是 `.docLine`（`id=L{n}`、`data-src`），每格是 `.lineText`
 *   * 空白格留空（不放「…」之類的符號）
 *   * 框線表只認「每列 │ 的個數」，不看字元位置（OCR 的框線寬度不可信）
 *   * 解析不了就拒絕：`<圖文字>` 退回等寬、`<表>` 退回普通文字
 */
import { parseTableBlock, splitPipeRow, isPipeAlignRow, cleanCell } from '../src/accelon26/table-block';
import { renderPageBlocks, tableHtml } from '../src/accelon26/render_accelon3';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + name + (detail ? '  ' + detail : '')); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
};

// ---- 管線表 ----------------------------------------------------------------
const pipe = [
  '表1　三種譯法',
  '項目 | 梵語 | 次數',
  ':--- | :---: | ---:',
  '涅槃 | nirvāṇa | 12',
  '不生 | anutpāda | 31',
];
const p = parseTableBlock(pipe);
ok('管線表：3 欄', !!p && p.cols === 3, JSON.stringify(p && { cols: p.cols }));
ok('管線表：表頭 3 格', !!p && p.header?.cells.length === 3 && p.header.cells[0] === '項目', JSON.stringify(p?.header));
ok('管線表：表頭那列不算內文', !!p && p.rows.length === 2, String(p?.rows.length));
ok('管線表：表說明', !!p && p.caption?.text === '表1　三種譯法', JSON.stringify(p?.caption));
ok('管線表：外語不變形', !!p && p.rows[0].cells[1] === 'nirvāṇa', JSON.stringify(p?.rows[0].cells));

ok('切格：首尾管線只是框', JSON.stringify(splitPipeRow('| a | b |')) === JSON.stringify(['a', 'b']),
  JSON.stringify(splitPipeRow('| a | b |')));
ok('切格：\\| 是字面的管線', JSON.stringify(splitPipeRow('a \\| b | c')) === JSON.stringify(['a | b', 'c']),
  JSON.stringify(splitPipeRow('a \\| b | c')));
ok('切格：標籤屬性裡的 | 不切', JSON.stringify(splitPipeRow('<術 sk="a|b">x</術> | y')) === JSON.stringify(['<術 sk="a|b">x</術>', 'y']),
  JSON.stringify(splitPipeRow('<術 sk="a|b">x</術> | y')));
ok('對齊列：--- 是真', isPipeAlignRow('--- | ---'));
ok('對齊列：| a | b | 不是', !isPipeAlignRow('| a | b |'));

ok('管線表：欄數不一致 → 拒絕',
  parseTableBlock(['a | b | c', 'd | e']) === null);
ok('管線表：只有一列（沒有表頭）→ 拒絕',
  parseTableBlock(['a | b']) === null);

// ---- 框線字藝術（taixu 的真實資料）-----------------------------------------
const box = [
  '　　　　┌──────┬──────┬──────┬──────┬──────┐',
  '　　　　│ 華　文　科 │ 梵　文　科 │ 歐　文　科 │ 翻　譯　科 │ 纂　述　科 │',
  '　　　　├──────┼──────┼──────┼──────┼──────┤',
  '<頁 id="17p135"/>',
  '　　　　│小學　　　　│古梵文　　　│英文　　　　│翻華為梵　　│佛教史志　　│',
  '　　　　│文學　　　　│波黎文　　　│德文　　　　│譯梵為華　　│佛教年鑑　　│',
  '　　　　│　　　　　　│　　　　　　│其餘諸國文屬│　　　　　　│圖書　　　　│',
  '　　　　└──────┴──────┴──────┴──────┴──────┘',
];
const b = parseTableBlock(box);
ok('框線表：5 欄', !!b && b.cols === 5, JSON.stringify(b && { cols: b.cols }));
ok('框線表：表頭＝第一列（後面接 ├┼┤）', !!b && b.header?.cells.join('/') === '華文科/梵文科/歐文科/翻譯科/纂述科',
  JSON.stringify(b?.header));
ok('框線表：頁碼列留在原位（第 1 列）', !!b && b.rows[0]?.page === '17p135', JSON.stringify(b?.rows[0]));
ok('框線表：3 列內容', !!b && b.rows.length === 4, String(b?.rows.length));
ok('框線表：空白格＝空字串（不是符號）', !!b && b.rows[3].cells[0] === '', JSON.stringify(b?.rows[3].cells));
ok('框線表：撐排空白去掉（華　文　科 → 華文科）', !!b && b.header!.cells[0] === '華文科', b?.header?.cells[0]);

// yinshun 的緣起圖：中間那列沒有邊框 → 必須拒絕
const diagram = [
  '　　　　　 +----------------------無--------------------+',
  '　　　　　 |　　　　　　　　　　　　　　　　　 |',
  '　　　　　 |　　來去相─── 運動、時間、空間　|',
  '　　　　　 生　 似續相─── 運動、時間、空間　滅',
  '　　　　　 |　　依緣相─── 運動、時間、空間　|',
  '　　　　　 +----------------------有--------------------+',
];
ok('圖解：不是表格 → 拒絕', parseTableBlock(diagram) === null);

ok('cleanCell：漢字間的空格去掉', cleanCell('華　文　科') === '華文科', cleanCell('華　文　科'));
ok('cleanCell：西文之間留一個空格', cleanCell('Dallas   Morning') === 'Dallas Morning', cleanCell('Dallas   Morning'));

// ---- 版面塊 ----------------------------------------------------------------
const lines = ['<表>', '說明一', '項目 | 值', '--- | ---', '甲 | 1', '乙 | 2', '</表>'];
const nums = lines.map((_, i) => 100 + i);
const blocks = renderPageBlocks(lines, nums, { hardBreaks: true });
const tb = blocks.find((x) => x.kind === 'table');
ok('版面塊：<表> 收成一個 table 塊', !!tb, JSON.stringify(blocks.map((b) => b.kind)));
ok('版面塊：表說明', tb?.table?.caption === '說明一', JSON.stringify(tb?.table?.caption));
ok('版面塊：表頭 1 列、內文 2 列',
  !!tb && tb.table?.head?.cells.length === 2 && tb.table.rows.length === 2,
  JSON.stringify(tb?.table && { head: tb.table.head?.cells.length, rows: tb.table.rows.length }));
ok('版面塊：每列都有自己的行號',
  !!tb && tb.table!.rows[0].no === 104 && tb.table!.rows[1].no === 105,
  JSON.stringify(tb?.table?.rows.map((r) => r.no)));
ok('版面塊：列 HTML 帶空白格', !!tb && tb.table!.rows.length === 2, '');

const cap = renderPageBlocks(['<表>廣文精舍學科編制表</表>', '正文'], [7, 8], { hardBreaks: true });
ok('版面塊：單行 <表> 當圖說', cap[0].kind === 'line' && cap[0].lines[0].cls === 'tableCaption',
  JSON.stringify(cap[0].lines[0]?.cls));
ok('版面塊：圖說的 data-src 是整行原文', cap[0].lines[0].raw === '<表>廣文精舍學科編制表</表>', cap[0].lines[0].raw);

const pre = renderPageBlocks(['<圖文字>', '┌─┬─┐', '│a│b│', '</圖文字>'], [1, 2, 3, 4], { hardBreaks: true });
ok('版面塊：解析不了的 <圖文字> 收成 pre 塊', pre.some((x) => x.kind === 'pre'),
  JSON.stringify(pre.map((b) => b.kind)));
ok('版面塊：pre 塊逐行保留原文', pre.find((x) => x.kind === 'pre')!.lines[1].raw === '│a│b│',
  JSON.stringify(pre.find((x) => x.kind === 'pre')!.lines.map((l) => l.raw)));

// ---- 表格前面那張「只有圖」的列（taixu 的真實形狀）--------------------------
const figPage = [
  '<表>廣文精舍學科編制表</表>',
  '<圖 f="images/09-0134.png"/>',
  '<圖文字>',
  '　　　　┌──────┬──────┐',
  '　　　　│ 華　文　科 │ 梵　文　科 │',
  '　　　　├──────┼──────┤',
  '　　　　│小學　　　　│古梵文　　　│',
  '　　　　└──────┴──────┘',
  '</圖文字>',
];
const f1 = renderPageBlocks(figPage, figPage.map((_, i) => 200 + i), { hardBreaks: true });
ok('圖在表格前面：整列被收掉（頁面從圖說開始）',
  !f1.some((b) => b.lines.some((l) => /inlineImgMissing|<img/.test(l.html))),
  JSON.stringify(f1.map((b) => b.kind)));
ok('圖在表格前面：只留下圖說＋表格', f1.length === 2 && f1[0].lines[0].cls === 'tableCaption' && f1[1].kind === 'table',
  JSON.stringify(f1.map((b) => b.kind)));

// 頁面剛好從「圖」那一行開始（表格在下一行）：也要收掉
const f2 = renderPageBlocks(figPage.slice(1), figPage.slice(1).map((_, i) => 201 + i), { hardBreaks: true });
ok('圖在表格前面：頁面從圖開始也收掉',
  !f2.some((b) => b.lines.some((l) => /inlineImgMissing|<img/.test(l.html))),
  JSON.stringify(f2.map((b) => b.kind)));

// 連排模式（hardBreaks:false）也要收掉
const f3 = renderPageBlocks(figPage, figPage.map((_, i) => 200 + i), { hardBreaks: false });
ok('圖在表格前面：連排模式也收掉',
  !f3.some((b) => b.lines.some((l) => /inlineImgMissing|<img/.test(l.html))),
  JSON.stringify(f3.map((b) => b.kind)));

// 連排時圖和文字黏在同一段：只拿掉圖，文字要留著
const f4 = renderPageBlocks(['正文一', '<圖 f="x.png"/>', '<表>', 'a | b', '--- | ---', 'c | d', '</表>'],
  [1, 2, 3, 4, 5, 6, 7], { hardBreaks: false });
ok('圖在表格前面：同段有文字時只拿掉圖',
  !f4.some((b) => b.lines.some((l) => /inlineImgMissing|<img/.test(l.html)))
  && f4[0].kind === 'para' && f4[0].lines.length === 1 && f4.some((b) => b.kind === 'table'),
  JSON.stringify(f4.map((b) => b.kind + ':' + b.lines.length)));

// 原圖收成「看原圖」（有 imageUrl 時才會真的解析出 <img>）
const withImg = renderPageBlocks(figPage, figPage.map((_, i) => 200 + i), {
  hardBreaks: true, imageUrl: (n) => 'blob:' + n,
});
const imgTable = withImg.find((b) => b.kind === 'table');
ok('原圖：收進表格的「看原圖」', !!imgTable?.table?.source?.html.includes('<img'),
  JSON.stringify(imgTable?.table?.source?.html?.slice(0, 60)));
ok('原圖：不再是一列', !withImg.some((b) => b.lines.some((l) => /inlineImg/.test(l.html))),
  JSON.stringify(withImg.map((b) => b.kind)));
const imgHtml = tableHtml(imgTable!.table!, () => '');
ok('原圖：tableHtml 長出 <details class="tblSrc">',
  imgHtml.includes('<details class="tblSrc"') && imgHtml.includes('看原圖'), imgHtml.slice(-160));

const withImgReflow = renderPageBlocks(figPage, figPage.map((_, i) => 200 + i), {
  hardBreaks: false, imageUrl: (n) => 'blob:' + n,
});
ok('原圖：連排模式也收進「看原圖」',
  !!withImgReflow.find((b) => b.kind === 'table')?.table?.source?.html.includes('<img'),
  JSON.stringify(withImgReflow.map((b) => b.kind)));

console.log(`\n${pass} pass, ${fail} fail`);
if (fail) process.exit(1);
