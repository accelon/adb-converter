/**
 * 架構守門測試：**後端**（索引／查詢）不可以 import **前端**（UI 模組）。
 *
 *   bun run test/backend-layout.test.ts
 *
 * 目的（作者 2026-10）：UI 改動不必跑 Go 端測試；反過來，後端模組也不能偷偷依賴
 * 畫面。這條界線由 `src/accelon26/backend.ts` 定住：
 *
 *   後端：adb.ts、vapa.ts、search.ts、query.ts、backend.ts、lossless.ts、
 *         variants.ts、simplified-data.ts、variant-data.ts
 *   前端：viewer.ts、summary.ts、doc-pane.ts、paint.ts、scopes.ts、ui.ts、
 *         text-pane.ts、link.ts、panes.ts、settings（template 相關）
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const BACKEND = [
  'adb.ts', 'vapa.ts', 'search.ts', 'query.ts', 'backend.ts',
  'lossless.ts', 'variants.ts', 'simplified-data.ts', 'variant-data.ts',
];
const FRONTEND = [
  './viewer', './summary', './doc-pane', './paint', './scopes', './ui',
  './text-pane', './link', './panes', './about', './engine-stats',
];

const dir = resolve(import.meta.dir, '..\\src\\accelon26');
let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + name + (detail ? '  ' + detail : '')); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
};

for (const file of BACKEND) {
  const src = readFileSync(resolve(dir, file), 'utf8');
  const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]).filter((s) => s.startsWith('./'));
  const bad = imports.filter((s) => FRONTEND.some((f) => s === f || s.startsWith(f + '/')));
  ok(`${file}：只依賴後端模組`, bad.length === 0, bad.length ? JSON.stringify(bad) : `imports ${imports.length} 個`);
}

// 前端可以 import 後端（單向），但 `backend.ts` 不能反向依賴 UI。
{
  const src = readFileSync(resolve(dir, 'backend.ts'), 'utf8');
  ok('backend.ts 沒有 import UI 模組', !FRONTEND.some((f) => src.includes(`from '${f}'`)));
}

// UI 只能透過 backend.ts 碰「多詞組／後端選擇」，不可以自己去挑 Go／TS。
{
  const ui = ['summary.ts', 'scopes.ts', 'ui.ts', 'doc-pane.ts', 'paint.ts']
    .map((f) => ({ f, src: readFileSync(resolve(dir, f), 'utf8') }));
  const leaked = ui.filter((u) => /searchQuery\(|SearchQuery/.test(u.src)).map((u) => u.f);
  ok('UI 不直接呼叫宿主查詢（一律經 backend.ts）', leaked.length === 0, leaked.join(',') || 'clean');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
