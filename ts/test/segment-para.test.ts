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

  test('沒有 <段> 的庫不受影響：仍然只有空行分段', () => {
    const blocks = renderPageBlocks(['第一行', '第二行', '', '第三行'], [1, 2, 3, 4], { hardBreaks: false }, ctx);
    expect(blocks.map((b) => b.kind + ':' + b.lines.length)).toEqual(['para:2', 'para:1']);
  });

  test('原書分行（預設）：每一行仍是自己的版面塊', () => {
    const blocks = renderPageBlocks(['<段 n="1"/>甲', '乙', '<段 n="2"/>丙'], [1, 2, 3], { hardBreaks: true }, ctx);
    expect(blocks.map((b) => b.kind)).toEqual(['line', 'line', 'line']);
  });
});
