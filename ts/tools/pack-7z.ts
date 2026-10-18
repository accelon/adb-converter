/**
 * 只重打包官網下載檔（作者 2026-10-18）：exe ＋ README.txt／README-tc.txt → www/accelon26.7z。
 *
 *   bun run tools/pack-7z.ts                       # 用 D:\accelon26\accelon26.exe（已發佈的那顆）
 *   bun run tools/pack-7z.ts --exe <路徑>
 *
 * 什麼時候用：**只改到壓縮檔內容**（例如說明文字）時。它不動 exe、不動 versions.json，
 * 所以不會讓使用者的程式跳出「有新版本」。要連 exe 一起更新請跑 tools/release.ts。
 */
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { README_SIMPLIFIED, README_TRADITIONAL, writeTextFileBom } from './readme-text';

const args = process.argv.slice(2);
const opt = (n: string, d = '') => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const ROOT = resolve(import.meta.dir, '../..');
const EXE = resolve(opt('exe', 'D:\\accelon26\\accelon26.exe'));
const OUT = resolve(opt('out', resolve(ROOT, 'www', 'accelon26.7z')));
const SEVEN_ZIP = 'C:\\Program Files\\7-Zip\\7z.exe';
const FILES = ['accelon26.exe', 'README.txt', 'README-tc.txt'];

if (!existsSync(EXE)) { console.error('找不到 exe：' + EXE); process.exit(2); }
if (!existsSync(SEVEN_ZIP)) { console.error('找不到 7-Zip：' + SEVEN_ZIP); process.exit(2); }

const pkg = resolve(ROOT, 'build/pkg');
rmSync(pkg, { recursive: true, force: true });
mkdirSync(pkg, { recursive: true });
copyFileSync(EXE, resolve(pkg, 'accelon26.exe'));
writeTextFileBom(resolve(pkg, 'README.txt'), README_SIMPLIFIED);
writeTextFileBom(resolve(pkg, 'README-tc.txt'), README_TRADITIONAL);

mkdirSync(resolve(ROOT, 'www'), { recursive: true });
try {
  rmSync(OUT, { force: true });
} catch {
  // 最常見：7-Zip 檔案總管或檔案總管預覽還開著這個壓縮檔
  console.error('✗ 無法覆蓋 ' + OUT + '：它正被別的程式開著（把 7-Zip／檔案總管的那個視窗關掉再跑一次）');
  process.exit(3);
}
const r = Bun.spawnSync({
  cmd: [SEVEN_ZIP, 'a', '-t7z', '-mx=9', '-m0=lzma2', '-md=64m', '-mfb=64', '-y', OUT, ...FILES],
  cwd: pkg, stdout: 'pipe', stderr: 'pipe',
});
if (r.exitCode !== 0) {
  console.error(new TextDecoder().decode(r.stderr));
  process.exit(r.exitCode ?? 2);
}
console.log(`✓ ${OUT}（${(statSync(OUT).size / 1048576).toFixed(1)} MiB，含 exe ＋ 2 份 README）`);

// 列出內容，確認三樣東西都在壓縮檔根目錄
const list = Bun.spawnSync({ cmd: [SEVEN_ZIP, 'l', '-ba', OUT], stdout: 'pipe', stderr: 'pipe' });
const lines = new TextDecoder().decode(list.stdout).trim().split(/\r?\n/).filter(Boolean);
for (const line of lines) {
  const cols = line.trim().split(/\s+/);
  console.log('  ' + cols.slice(3).join(' '));
}
