/**
 * 註號顯示形式（作者 2026-11-02）的單元測試。
 *
 *   bun run test/note-label.test.ts
 *
 * 新的 adb：`n="11.001@38"`（`@` 後是冊號，只為全 adb 唯一）→ 畫面顯示 `11.001`；
 * 舊 adb：`n="38.160"`（沒有 `@`）→ 原樣顯示。查表／比對仍用完整 n。
 */
import { noteLabel } from '../src/accelon26/note-label';

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
