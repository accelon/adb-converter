import { describe, expect, test } from 'bun:test';
import { revPageKey, revPageWholeKey } from '../src/accelon26/page-text';

/**
 * 反鏈索引鍵的回歸測（2026-11-14，ybh 單 prompt-adb-converter-v9v10-reply.md §五）。
 * 病灶：ybh v14+ 把跨庫聯升級成 `i="taisho?30p279a#34-40"`，anchor 帶 `#a-b` 窗綴；
 * 建鍵若用 shortPageId（$ 錨不吃帶 # 的串）會保留窗綴，與查表的純頁欄鍵永不相交 →
 * 反鏈恒為 0（實測 n=2,403 vs 全庫 49,749）。revPageKey／revPageWholeKey 兩側都先剝窗綴。
 */
describe('反鏈頁欄鍵 revPageKey / revPageWholeKey', () => {
  test('帶 #a-b 窗綴的 anchor 與純頁欄，建出同一個鍵（核心對稱性）', () => {
    expect(revPageKey('taisho', '30p279a#34-40')).toBe('taisho?30p279a');
    expect(revPageKey('taisho', '30p279a')).toBe('taisho?30p279a');
    expect(revPageKey('taisho', '30p279a#34-40')).toBe(revPageKey('taisho', '30p279a'));
  });
  test('a/b/c 三欄整頁鍵：先剝窗綴再剝欄母', () => {
    expect(revPageWholeKey('taisho', '30p279a#34-40')).toBe('taisho?30p279');
    expect(revPageWholeKey('taisho', '30p279b')).toBe('taisho?30p279');
    // 帶窗綴的 b 欄與純 b 欄也得同鍵
    expect(revPageWholeKey('taisho', '30p279b#1-9')).toBe(revPageWholeKey('taisho', '30p279b'));
  });
  test('零填充頁：窗綴剝掉後仍走 shortPageId 歸一、兩側一致', () => {
    // vedic 式 `#詞` 窗綴同樣剝掉
    expect(revPageKey('sa', 'en#5-8')).toBe(revPageKey('sa', 'en'));
    // 冊號前導 0 不影響（shortPageId 只動 p 之後的頁號）
    expect(revPageKey('taisho', '02p108a#12-13')).toBe('taisho?02p108a');
  });
  test('無 # 的舊鍵行為不變（向後相容）', () => {
    expect(revPageKey('ys', '38p107')).toBe('ys?38p107');
    expect(revPageWholeKey('ys', '38p107c')).toBe('ys?38p107');
  });
});
