/**
 * 發佈流程（作者說「發布」時跑這支）：
 *
 *   cd ts && bun run tools/release.ts --items-file notes.txt   # 一行一項（UTF-8，推薦）
 *   cd ts && bun run tools/release.ts --items "ASCII only;第二項" [--title "…"] [--url https://…] [--no-build]
 *
 * ⚠ Windows 的 PowerShell 會把中文命令列參數弄成亂碼（實際踩過：release_notes.json 變成
 *   亂碼並被 commit）。所以中文一律用 --items-file，檔案由編輯器／工具以 UTF-8 寫入。
 *
 * 做四件事：
 *   1. 把這一版的改版說明 append 到 wails/release_notes.json（更新後顯示給使用者的就是它）
 *   2. 先建 HTML（build-desktop.ts）、再用 -ldflags 把建置時間烙進 exe（順序不能顛倒！）
 *   3. 用 -version 驗一次 exe 裡的建置時間
 *   4. 印出上傳指示，並（給了 --url 的話）HEAD 一次確認線上的 Last-Modified
 *
 * 建置時間一定要用 -ldflags 注入：沒注入的 exe 只能退回「檔案修改時間」，
 * 而檔案時間會被複製／解壓改變，發佈版就無法判斷新舊了。
 */
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const opt = (n: string, d = '') => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const ROOT = resolve(import.meta.dir, '../..');
const WAILS = resolve(ROOT, 'wails');
const NOTES = resolve(WAILS, 'release_notes.json');
const EXE = resolve(ROOT, 'build/desktop/accelon26.exe');
const URL = opt('url', 'https://shutonggui.cn/accelon26/accelon26.exe');
const NO_BUILD = args.includes('--no-build');

const itemsFile = opt('items-file');
const items = (itemsFile
  ? readFileSync(resolve(process.cwd(), itemsFile), 'utf8').split(/\r?\n/).map((s) => s.trim())
  : opt('items').split(';').map((s) => s.trim())
).filter((s) => s && !s.startsWith('#'));
const title = opt('title', '');
if (!items.length && !args.includes('--no-build')) {
  console.error('用法：bun run tools/release.ts --items-file notes.txt（一行一項，UTF-8）');
  console.error('      bun run tools/release.ts --items "ASCII only;…" [--title "…"] [--url …] [--no-build]');
  process.exit(2);
}

// 1) 改版說明
const buildTime = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const notes = existsSync(NOTES) ? JSON.parse(readFileSync(NOTES, 'utf8')) : [];
if (items.length) {
  notes.push({ buildTime, title: title || `accelon26 ${buildTime.slice(0, 10)}`, items });
  writeFileSync(NOTES, JSON.stringify(notes, null, 2) + '\n');
  console.log(`改版說明已加入（${notes.length} 版）：${buildTime}`);
  for (const it of items) console.log('  · ' + it);
  // 中文有沒有變成亂碼，肉眼確認一下（Windows 命令列很容易）
  if (items.some((it) => /[\uFFFD\uE000-\uF8FF]/.test(it) || it.includes('\uFFFD'))) {
    console.error('警告：說明文字看起來是亂碼，請改用 --items-file。');
    process.exit(1);
  }
}

if (NO_BUILD) {
  console.log('（--no-build：只更新了說明，沒有重建成 exe）');
  process.exit(0);
}

// 2) 先 HTML 再 exe（順序反了 exe 會內嵌到舊的 UI）
const run = (cmd: string[], cwd: string, label: string) => {
  const r = Bun.spawnSync({ cmd, cwd, stdout: 'inherit', stderr: 'inherit' });
  if (r.exitCode !== 0) { console.error(label + ' 失敗（exit ' + r.exitCode + '）'); process.exit(1); }
};
console.log('\n[1/3] 建置單檔 HTML → wails/assets/index.html');
run(['bun', 'run', 'tools/build-desktop.ts'], resolve(ROOT, 'ts'), 'HTML 建置');
console.log('[2/3] 建置 exe（內嵌 HTML ＋ 注入建置時間）');
run(['go', 'build', '-ldflags', `-X main.buildTime=${buildTime}`, '-o', EXE, '.'], WAILS, 'go build');

// 3) 驗證 exe 裡的建置時間
console.log('[3/3] 驗證 exe');
const ver = Bun.spawnSync({ cmd: [EXE, '-version'], cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
const verText = new TextDecoder().decode(ver.stdout).trim();
console.log(verText.split('\n').map((l) => '  ' + l).join('\n'));
const size = statSync(EXE).size;
console.log(`\nexe: ${EXE}（${(size / 1048576).toFixed(1)} MiB）`);
if (!verText.includes('from ldflags')) {
  console.error('警告：建置時間不是來自 -ldflags，發佈版會無法判斷新舊！');
  process.exit(1);
}

// 4) 上傳指示 + 線上檢查
console.log('\n把這個檔案上傳到：');
console.log('  ' + URL);
console.log('（伺服器要送出 Last-Modified，程式就是靠它判斷線上版本比執行中的新）');
try {
  const head = await fetch(URL, { method: 'HEAD' });
  const lm = head.headers.get('last-modified');
  console.log('\n線上的 Last-Modified：' + (lm ?? '（沒有！這樣程式不會提示更新）'));
  if (lm) {
    const online = new Date(lm).getTime();
    const mine = new Date(buildTime).getTime();
    console.log(online > mine ? '  線上比這一版新（使用者會被提示更新）' : '  線上還是舊的（還沒上傳吧）');
  }
} catch (e) {
  console.log('\n（線上檢查失敗：' + String(e) + '）');
}
