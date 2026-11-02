/**
 * 緬文 tokenizer 回歸（2026-11-02）：緬甸文沒有空格分詞，舊 tokenizer 會把每個字母
 * 當一個 token；現在用 Intl.Segmenter('my', word)。這個測試只看 token 邊界，不依賴 adb。
 */
import { expect, test } from 'bun:test';
import { Tokenizer } from '../src/tokenize';

test('緬文：一個詞是一個 token，不是逐字母', () => {
  const tk = new Tokenizer('ဘုရား');
  expect(tk.nextLiteral()).toBe('ဘုရား');
  expect(tk.nextLiteral()).toBe('');
});

test('緬文：空白仍是分隔，下一個詞完整', () => {
  const tk = new Tokenizer('ဘုရား တရား');
  expect(tk.nextLiteral()).toBe('ဘုရား');
  expect(tk.nextLiteral()).toBe(' ');
  expect(tk.nextLiteral()).toBe('တရား');
});

test('緬文：長詞不會被切開（အကျွန်ုပ်）', () => {
  const tk = new Tokenizer('အကျွန်ုပ်သည်');
  expect(tk.nextLiteral()).toBe('အကျွန်ုပ်');
  expect(tk.nextLiteral()).toBe('သည်');
});

test('泰文：一個詞是一個 token，不是逐字母', () => {
  const tk = new Tokenizer('พระพุทธเจ้า');
  expect(tk.nextLiteral()).toBe('พระพุทธเจ้า');
  expect(tk.nextLiteral()).toBe('');
});

test('泰文：空白仍是分隔', () => {
  const tk = new Tokenizer('พระ พุทธ');
  expect(tk.nextLiteral()).toBe('พระ');
  expect(tk.nextLiteral()).toBe(' ');
  expect(tk.nextLiteral()).toBe('พุทธ');
});

test('日文：漢字詞用日文詞典切（kmj 模式）', () => {
  const tk = new Tokenizer('仏陀は法を説いた', { japanese: true });
  expect(tk.nextLiteral()).toBe('仏陀');
  expect(tk.nextLiteral()).toBe('は');
  expect(tk.nextLiteral()).toBe('法');
});

