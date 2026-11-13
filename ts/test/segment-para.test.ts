/**
 * `<段 n="…">` 必須是**段首**（作者 2026-11-03）。
 *
 * 實際踩過：kmj（光明寺日譯）在「原書分行」關閉（連排）時，整頁連成一大坨，
 * 段與段之間沒有空行，而連排模式只認「空行」分段 → ¶39、¶40… 全擠在同一段裡。
 *
 * 規則：`<段 n>` 在行首 → 這一行另起一段；在行中 → 至少插一個 `<br class="para">`。
 */
import { describe, expect, test } from 'bun:test';
import { Accelon3Renderer, renderPageBlocks, type RenderContext } from '../src/accelon26/render_accelon3';

const ctx: RenderContext = { depthOf: new Map<string, number>(), levels: 0 };

const textOf = (html: string): string => html.replace(/<[^>]*>/g, '');

describe('<段> 的分段行為', () => {
  test('連排模式：沒有空行也要一段一段分開', () => {
    const blocks = renderPageBlocks(
      ['<段 n="1"/>甲文', '甲文的下一行', '<段 n="2"/>乙文', '<段 n="3"/>丙文'],
      [1, 2, 3, 4],
      { hardBreaks: false },
      ctx,
    );
    expect(blocks.map((b) => b.kind)).toEqual(['para', 'para', 'para']);
    expect(blocks.map((b) => b.lines.length)).toEqual([2, 1, 1]);
    // 每一段的第一行都要以段碼開頭
    expect(blocks.map((b) => /class="segChip"/.test(b.lines[0].html))).toEqual([true, true, true]);
    expect(textOf(blocks[1].lines[0].html)).toBe('¶2乙文');
  });

  test('段碼在行中：插一個 <br class="para">，不與前文黏在同一行', () => {
    const r = new Accelon3Renderer(ctx, { hardBreaks: false });
    const html = r.line('前文<段 n="3"/>後文', 1);
    expect(html).toContain('<br class="para">');
    expect(html.indexOf('<br class="para">')).toBeLessThan(html.indexOf('class="segChip"'));
    expect(textOf(html)).toBe('前文¶3後文');
  });

  test('「標題＋段」同行：標題自成 heading 塊，段與續行合成一段', () => {
    // ccc／cs-mm／sc／yh 的實際形狀：`<小節>[小戒]</小節><段 n="7"/>比丘們…`
    const ctx3: RenderContext = { depthOf: new Map([['小節', 3], ['段', 4]]), levels: 5 };
    const blocks = renderPageBlocks(
      ['<小節>[小戒]</小節><段 n="7"/>比丘們！這是那小量', '、低量的戒量狀態。', '<小節>[常恆論]</小節><段 n="30"/>另有沙門'],
      [1, 2, 3],
      { hardBreaks: false },
      ctx3,
    );
    expect(blocks.map((b) => b.kind + ':' + b.lines.length))
      .toEqual(['heading:1', 'para:2', 'heading:1', 'para:1']);
    // 標題塊：只有標題，沒有段碼；段落塊：從段碼開始
    expect(blocks[0].lines[0].html).toContain('class="h"');
    expect(blocks[0].lines[0].html).not.toContain('segChip');
    expect(blocks[1].lines[0].html.startsWith('<button')).toBe(true);
    // DOM id：標題帶 -h，正文保留原本行號（塗紅／捲動以有文字的那一塊為準）
    expect(blocks[0].lines[0].idSuffix).toBe('-h');
    expect(blocks[1].lines[0].idSuffix ?? '').toBe('');
    expect(blocks[1].lines[0].no).toBe(blocks[0].lines[0].no);
  });

  test('原書分行：「標題＋段」同行也切成兩列（id 不重複）', () => {
    const ctx3: RenderContext = { depthOf: new Map([['小節', 3], ['段', 4]]), levels: 5 };
    const blocks = renderPageBlocks(['<小節>[小戒]</小節><段 n="7"/>比丘們…'], [9], { hardBreaks: true }, ctx3);
    expect(blocks.map((b) => b.kind)).toEqual(['line', 'line']);
    expect(blocks[0].lines[0].idSuffix).toBe('-h');
    expect(blocks[1].lines[0].idSuffix ?? '').toBe('');
  });

  test('沒有 <段> 的庫不受影響：仍然只有空行分段', () => {
    const blocks = renderPageBlocks(['第一行', '第二行', '', '第三行'], [1, 2, 3, 4], { hardBreaks: false }, ctx);
    expect(blocks.map((b) => b.kind + ':' + b.lines.length)).toEqual(['para:2', 'para:1']);
  });

  test('原書分行（預設）：每一行仍是自己的版面塊', () => {
    const blocks = renderPageBlocks(['<段 n="1"/>甲', '乙', '<段 n="2"/>丙'], [1, 2, 3], { hardBreaks: true }, ctx);
    expect(blocks.map((b) => b.kind)).toEqual(['line', 'line', 'line']);
  });

  // 陳裕文 2026-11-13：「請文章段落開頭空二格，方便區分。」
  // `<段/>` 寫在行尾時（fuyan 有 7,192 個），縮排在塊尾沒有字跟著 → 畫面上一點都看不到。
  test('行尾 <段/>：縮排要落到下一塊的開頭，不能留在標題塊尾', () => {
    const ctx3: RenderContext = { depthOf: new Map([['目', 3]]), levels: 5 };
    const IND = '<span class="paraIndent">　　</span>';
    const blocks = renderPageBlocks(
      ['<目>（三）標題</目><段/>', '《增支部》說到慈心的八功德', '誦的。'],
      [780, 781, 782],
      { hardBreaks: false },
      ctx3,
    );
    expect(blocks.map((b) => b.kind)).toEqual(['heading', 'para']);
    expect(blocks[0].lines[0].html.includes('paraIndent')).toBe(false);
    expect(blocks[1].lines[0].html.startsWith(IND)).toBe(true);
    // 續行不能跟著縮
    expect(blocks[1].lines[1].html.startsWith(IND)).toBe(false);
  });

  test('段內行尾 <段/>：下一行接在同一塊，不重複搬縮排', () => {
    const IND = '<span class="paraIndent">　　</span>';
    const blocks = renderPageBlocks(['甲句<段/>', '乙句'], [1, 2], { hardBreaks: false }, ctx);
    expect(blocks.length).toBe(1);
    // 同一塊是連排：<br> 之後接著就是下一行，縮排留在原處即可
    expect(blocks[0].lines[0].html.endsWith(IND)).toBe(true);
    expect(blocks[0].lines[1].html.startsWith(IND)).toBe(false);
  });
});
