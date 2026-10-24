/**
 * 「查字典」偏好（dict-settings.ts）的單元測試。
 *
 *   bun run test/dict-settings.test.ts
 */
const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
} as Storage;

import { autoDictOn, dictOrder, orderByFile, selectionDictOn, setAutoDict, setDictOrder, setSelectionDict } from '../src/accelon26/dict-settings';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + name + (detail ? '  ' + detail : '')); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
};

// ---- 自動查字典開關 --------------------------------------------------------
ok('預設開啟自動查字典', autoDictOn() === true);
setAutoDict(false);
ok('關閉後 autoDictOn=false、localStorage 是 0', autoDictOn() === false && store.get('accelon26.dict.auto') === '0');
setAutoDict(true);
ok('再打開 autoDictOn=true', autoDictOn() === true && store.get('accelon26.dict.auto') === '1');

// ---- 選取區自動查開關 ------------------------------------------------------
ok('預設開啟選取區自動查', selectionDictOn() === true);
setSelectionDict(false);
ok('關閉後 selectionDictOn=false、localStorage 是 0',
  selectionDictOn() === false && store.get('accelon26.dict.selection') === '0');
setSelectionDict(true);
ok('再打開 selectionDictOn=true', selectionDictOn() === true && store.get('accelon26.dict.selection') === '1');

// ---- 詞典順序（檔名） ------------------------------------------------------
ok('預設沒有順序', dictOrder().length === 0);
setDictOrder(['a.adb', 'a.adb', '', 'b.adb']);
ok('存檔名：去重、去空字串', JSON.stringify(dictOrder()) === JSON.stringify(['a.adb', 'b.adb']), JSON.stringify(dictOrder()));

const list = [{ file: 'a.adb' }, { file: 'b.adb' }, { file: 'c.adb' }];
const order = orderByFile(list, ['c.adb', 'missing.adb', 'a.adb']);
ok('依已存順序排；找不到的檔名略過；沒列到的（新詞典）排最後',
  JSON.stringify(order.map((x) => x.file)) === JSON.stringify(['c.adb', 'a.adb', 'b.adb']),
  JSON.stringify(order.map((x) => x.file)));
ok('順序裡有目前不存在的檔名：不會出現在結果、也不警告',
  orderByFile(list, ['missing.adb']).map((x) => x.file).join(',') === 'a.adb,b.adb,c.adb');
ok('空的順序：原清單不動', orderByFile(list, []).map((x) => x.file).join(',') === 'a.adb,b.adb,c.adb');

// 找不到的檔名仍留在存檔裡（下次檔案回來還在原位）
setDictOrder(['missing.adb', 'b.adb']);
ok('存檔保留目前找不到的檔名',
  JSON.stringify(dictOrder()) === JSON.stringify(['missing.adb', 'b.adb']), JSON.stringify(dictOrder()));

// 壞掉的值 → 當成沒有順序
store.set('accelon26.dict.order', '{oops');
ok('壞掉的 JSON：dictOrder 回空陣列（不丟錯）', dictOrder().length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
