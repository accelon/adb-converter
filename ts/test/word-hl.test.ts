/**
 * 詞級定位（vedic 的 `#N`／`#詞`）：位址切分與去變音符號（2026-11-04）。
 * DOM 反白由 `build/tmp-vedic-word-test.ts`（CDP）驗，這裡只釘住純函式。
 */
import { describe, expect, test } from 'bun:test';
import { foldWord, splitWordKey } from '../src/accelon26/word-hl';

describe('word-hl：位址與折疊', () => {
  test('splitWordKey：切掉 # 之後的 key；沒有 # 時 key 為空', () => {
    expect(splitWordKey('rv.10.90.3:1#puruṣa')).toEqual({ base: 'rv.10.90.3:1', key: 'puruṣa' });
    expect(splitWordKey('rv.10.90.3:1#1')).toEqual({ base: 'rv.10.90.3:1', key: '1' });
    expect(splitWordKey('rv.10.90.3:1')).toEqual({ base: 'rv.10.90.3:1', key: '' });
  });

  test('foldWord：去變音符號、只留 A-Za-z、lowercase', () => {
    expect(foldWord('pūruṣaḥ')).toBe('purusah');
    expect(foldWord('prajñaṃ')).toBe('prajnam');
    expect(foldWord('bhavatyātmanastu')).toBe('bhavatyatmanastu');
  });
});
