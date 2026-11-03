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

import { dictOnlyIsdict, dictOrder, orderByFile, setDictOnlyIsdict, setDictOrder } from '../src/accelon26/dict-settings';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + name + (detail ? '  ' + detail : '')); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
};

// 「自動查字典」「選取區自動查」兩個開關已經移除（2026-10-28 起查詞由選取選單明確觸發），
// `autoDictOn`／`selectionDictOn` 不再存在；那兩段測試一併刪掉，免得整支測試載入就失敗。

// ---- 只列出 c="isdict"（顯示過濾；作者 2026-10-26） --------------------------
ok('預設列出全部：dictOnlyIsdict=false', dictOnlyIsdict() === false);
setDictOnlyIsdict(true);
ok('勾選後 dictOnlyIsdict=true、localStorage 是 1',
  dictOnlyIsdict() === true && store.get('accelon26.dict.isdictonly') === '1');
setDictOnlyIsdict(false);
ok('取消後 dictOnlyIsdict=false、localStorage 是 0',
  dictOnlyIsdict() === false && store.get('accelon26.dict.isdictonly') === '0');

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
