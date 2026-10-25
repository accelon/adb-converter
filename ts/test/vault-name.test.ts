/**
 * 「加入 Obsidian」的檔名規則：含與不含 `.adb` 都要通，中文檔名要留住，
 * 而 adb 檔頭只能 ASCII —— 這幾條是使用者直接看到的行為，所以單獨測。
 */
import { describe, expect, test } from 'bun:test';
import { normalizeVaultName, suggestStem } from '../src/vault-name';

describe('normalizeVaultName', () => {
  test('accepts a name with and without .adb', () => {
    expect(normalizeVaultName('lunyu')).toEqual({ stem: 'lunyu', file: 'lunyu.adb', dbname: 'lunyu' });
    expect(normalizeVaultName('lunyu.adb')).toEqual({ stem: 'lunyu', file: 'lunyu.adb', dbname: 'lunyu' });
    expect(normalizeVaultName('  lunyu.ADB ')).toEqual({ stem: 'lunyu', file: 'lunyu.adb', dbname: 'lunyu' });
  });

  test('keeps a Chinese file name but stores an ASCII dbname', () => {
    expect(normalizeVaultName('論語')).toEqual({ stem: '論語', file: '論語.adb', dbname: 'adb' });
    expect(normalizeVaultName('論語.adb')).toEqual({ stem: '論語', file: '論語.adb', dbname: 'adb' });
    expect(normalizeVaultName('lunyu 論語')).toEqual({ stem: 'lunyu 論語', file: 'lunyu 論語.adb', dbname: 'lunyu' });
  });

  test('strips path separators and characters Windows rejects', () => {
    expect(normalizeVaultName('../etc/passwd')?.file).toBe('etcpasswd.adb');
    expect(normalizeVaultName('a:b*c?d"e<f>g|h')?.file).toBe('abcdefgh.adb');
    expect(normalizeVaultName('..\\..\\x')?.file).toBe('x.adb');
  });

  test('rejects empty or punctuation-only names', () => {
    expect(normalizeVaultName('')).toBeNull();
    expect(normalizeVaultName('   ')).toBeNull();
    expect(normalizeVaultName('...')).toBeNull();
    expect(normalizeVaultName('.adb')).toBeNull();
    expect(normalizeVaultName('///')).toBeNull();
  });

  test('keeps the stem at most 60 chars and the dbname at most 31', () => {
    const long = 'a'.repeat(80);
    const n = normalizeVaultName(long)!;
    expect(n.stem.length).toBe(60);
    expect(n.dbname.length).toBe(31);
    expect(n.file.endsWith('.adb')).toBe(true);
  });

  test('the file name survives a round trip through the dialog', () => {
    for (const raw of ['lunyu', 'lunyu.adb', '十三經', 'my book', 'a-b_c.d']) {
      const n = normalizeVaultName(raw)!;
      const again = normalizeVaultName(n.file)!;
      expect(again.stem).toBe(n.stem);
      expect(again.file).toBe(n.file);
      expect(again.dbname).toBe(n.dbname);
    }
  });
});

describe('suggestStem', () => {
  test('uses the ASCII part of the vault name', () => {
    expect(suggestStem('my-vault')).toBe('my-vault');
    expect(suggestStem('My Vault')).toBe('My-Vault');
  });

  test('falls back to the zip name, then to empty', () => {
    expect(suggestStem('《論語句讀新詮》', 'lunyu.zip')).toBe('lunyu');
    expect(suggestStem('《論語句讀新詮》', '《論語句讀新詮》.zip')).toBe('');
  });
});
