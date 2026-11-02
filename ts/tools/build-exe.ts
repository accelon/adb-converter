#!/usr/bin/env bun
/**
 * 建桌面版 exe（一個指令做完「HTML → go build → 放到指定資料夾 → 印建置時間」）。
 *
 *   bun run tools/build-exe.ts --out D:\2026\sz\accelon26
 *
 * 為什麼要有這支（作者 2026-11-03）：
 *   sz 的 adb 有十幾個，用單檔 HTML 測不方便（file:// 一次只能自己選檔），
 *   桌面版會用 `ListAdbs` 把 exe 旁／工作目錄的 adb 全部列出來。
 *   所以這條分支的驗證一律**建 exe**，放到該庫的資料夾（不是 `D:\accelon3`）。
 *
 * 參數：
 *   --out <dir>        exe 要放的資料夾（預設 build/adbupd，只留在專案內）
 *   --build-time <iso> 指定烙進 exe 的建置時間（預設現在，UTC）
 *   --console          建 console 版（除錯用；預設 -H windowsgui）
 *   --no-assets        不重建 HTML（只有重新連結 exe 時用；會內嵌舊 UI，小心）
 *   --no-verify        不跑 `exe -version` 回報
 *
 * 順序不能顛倒：先 HTML 再 exe，否則 exe 內嵌的是舊 UI（release.ts 也這樣做）。
 */
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../..');
const WAILS = resolve(ROOT, 'wails');
const args = process.argv.slice(2);
const opt = (n: string, d: string): string => {
  const i = args.indexOf('--' + n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const has = (n: string): boolean => args.includes('--' + n);

const OUT_DIR = resolve(opt('out', resolve(ROOT, 'build/adbupd')));
const BUILD_TIME = opt('build-time', new Date().toISOString().replace(/\.\d+Z$/, 'Z'));
const BUILT = resolve(ROOT, 'build/adbupd/accelon26.exe');

const run = (cmd: string[], cwd: string, label: string): void => {
  const r = Bun.spawnSync({ cmd, cwd, stdout: 'inherit', stderr: 'inherit' });
  if (r.exitCode !== 0) {
    console.error(label + ' 失敗（exit ' + r.exitCode + '）');
    process.exit(1);
  }
};

if (process.platform !== 'win32') {
  console.error('這支只建 Windows exe（wails 宿主）。');
  process.exit(2);
}

// 1) 單檔 HTML → wails/assets/index.html（內嵌用）
if (!has('no-assets')) {
  console.log('[1/3] 建置單檔 HTML → wails/assets/index.html');
  run(['bun', 'run', 'tools/build-desktop.ts'], resolve(ROOT, 'ts'), 'HTML 建置');
} else {
  console.log('[1/3] 略過 HTML 重建（--no-assets：內嵌的是現有 wails/assets/index.html）');
}

// 2) go build（建置時間一定要用 ldflags 注入，否則 exe 只能退回檔案修改時間）
console.log('[2/3] go build → ' + BUILT);
mkdirSync(dirname(BUILT), { recursive: true });
const ldflags = '-X main.buildTime=' + BUILD_TIME + (has('console') ? '' : ' -H windowsgui');
run(['go', 'build', '-ldflags', ldflags, '-o', BUILT, '.'], WAILS, 'go build');

// 3) 放到指定資料夾（獨立檔案，不做 hardlink，免得兩個資料夾連動）
const name = opt('name', 'accelon26');
const target = resolve(OUT_DIR, name + '.exe');
mkdirSync(OUT_DIR, { recursive: true });
if (resolve(target) !== BUILT) {
  try {
    copyFileSync(BUILT, target);
  } catch (e) {
    // 最常见：那個 exe 正在跑（Windows 會鎖檔）。不要幫使用者關掉他正在看的視窗。
    const code = (e as { code?: string }).code ?? '';
    if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
      console.error('\n✗ 寫不進 ' + target + '（' + code + '）');
      console.error('  那個 exe 正在執行（或還被別的程式開著）。請關掉視窗後重跑：');
      console.error('    bun run tools/build-exe.ts --out ' + OUT_DIR);
      console.error('  或者換一個檔名放旁邊（兩個 exe 也可以）：');
      console.error('    bun run tools/build-exe.ts --out ' + OUT_DIR + ' --name accelon26-new');
      console.error('  剛剛建好的 exe 仍在：' + BUILT);
      process.exit(3);
    }
    throw e;
  }
}
const size = statSync(resolve(target) === BUILT ? BUILT : target).size;
console.log('[3/3] ' + target + '  ' + (size / 1048576).toFixed(2) + ' MiB  buildTime=' + BUILD_TIME);

// 驗一下真的跑得起來、回報的是這次的建置時間
if (!has('no-verify')) {
  const r = Bun.spawnSync({ cmd: [target, '-version'], stdout: 'pipe', stderr: 'pipe' });
  const out = new TextDecoder().decode(r.stdout).trim();
  if (r.exitCode !== 0 || !out) {
    console.error('（exe -version 沒有回報：exit ' + r.exitCode + '）');
    process.exit(1);
  }
  console.log('驗證：' + out.split(/\r?\n/).filter((l) => /build time|exe:/.test(l)).join(' ｜ '));
}

console.log('完成。雙擊 ' + target + ' 測試（桌面版會列出資料夾裡的 adb）。');
