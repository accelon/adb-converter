/**
 * 註號顯示形式（作者 2026-11-02）的單元測試。
 *
 *   bun run test/note-label.test.ts
 *
 * 新的 adb：`n="11.001@38"`（`@` 後是冊號，只為全 adb 唯一）→ 畫面顯示 `11.001`；
 * 舊 adb：`n="38.160"`（沒有 `@`）→ 原樣顯示。查表／比對仍用完整 n。
 */
import { noteLabel, parseNoteQuery } from '../src/accelon26/note-label';

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown): void => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); }
};

eq("noteLabel('11.001@38')", noteLabel('11.001@38'), '11.001');
eq("noteLabel('38.160')（舊格式不變）", noteLabel('38.160'), '38.160');
eq("noteLabel('0.001@13')", noteLabel('0.001@13'), '0.001');
eq("noteLabel('11.001')（本來就沒有 @）", noteLabel('11.001'), '11.001');
eq("noteLabel('')", noteLabel(''), '');
eq("noteLabel('@38')（沒有紙本號：保留原樣）", noteLabel('@38'), '@38');
eq("noteLabel('a@b@c')（只切第一個 @）", noteLabel('a@b@c'), 'a');

// `[^…]` 查詢（跳到註／釋）：一定要有前綴，否則會和目錄路徑 1.2.3 衝突
eq("[^11.001] → 跳到註", parseNoteQuery('[^11.001]'), { key: '11.001', label: '11.001', to: 'ref' });
eq("[^11.001]: → 跳到釋", parseNoteQuery('[^11.001]:'), { key: '11.001', label: '11.001', to: 'body' });
eq('[^11.001@38] 保留完整 key、label 去掉 @冊', parseNoteQuery('[^11.001@38]'), { key: '11.001@38', label: '11.001', to: 'ref' });
eq('[^11.001@38]: 跳到釋', parseNoteQuery('[^11.001@38]:'), { key: '11.001@38', label: '11.001', to: 'body' });
eq('舊 adb [^38.160]', parseNoteQuery('[^38.160]'), { key: '38.160', label: '38.160', to: 'ref' });
eq('空白容錯', parseNoteQuery('  [^11.001]  '), { key: '11.001', label: '11.001', to: 'ref' });
eq('裸的 11.001 不是註語法（是目錄路徑）', parseNoteQuery('11.001'), null);
eq('裸的 1.2.3 不是註語法', parseNoteQuery('1.2.3'), null);
eq('[^] 空的不是註語法', parseNoteQuery('[^]'), null);
eq('沒有右括號不是註語法', parseNoteQuery('[^11.001'), null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
