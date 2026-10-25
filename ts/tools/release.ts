/**
 * 發佈流程（作者說「發布」時跑這支）：
 *
 *   cd ts && bun run tools/release.ts --items-file notes.txt [--console] [--out <目錄>]
 *   cd ts && bun run tools/release.ts --items "ASCII only;第二項" [--title "…"] [--url https://…] [--no-build]
 *
 * ⚠ Windows 的 PowerShell 會把中文命令列參數弄成亂碼（實際踩過：release_notes.json 變成
 *   亂碼並被 commit）。所以中文一律用 --items-file，檔案由編輯器／工具以 UTF-8 寫入。
 *
 * 做六件事：
 *   1. 把這一版的改版說明 append 到 wails/release_notes.json（更新後顯示給使用者的就是它）
 *   2. 先建 HTML（build-desktop.ts）、再用 -ldflags 把建置時間烙進 exe（順序不能顛倒！）
 *   3. 用 -version 驗一次 exe 裡的建置時間
 *   4. 產生 versions.json（版本真相：buildTime ＋ sha256；更新器先讀它，讀不到才退回 Last-Modified）
 *   5. 把 exe 打包成 www/accelon26.7z（官網的下載檔；7z 不進 git）
 *   6. 印出上傳指示，並確認線上的版本資訊
 *
 * 建置時間一定要用 -ldflags 注入：沒注入的 exe 只能退回「檔案修改時間」，
 * 而檔案時間會被複製／解壓改變，發佈版就無法判斷新舊了。
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, statSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { README_SIMPLIFIED, README_TRADITIONAL, writeTextFileBom } from './readme-text';
import { peSubsystem, subsystemLabel } from './pe-subsystem';

const args = process.argv.slice(2);
const opt = (n: string, d = '') => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const ROOT = resolve(import.meta.dir, '../..');
const WAILS = resolve(ROOT, 'wails');
const NOTES = resolve(WAILS, 'release_notes.json');
// exe 一律產在**工作文件夾的 accelon3/**（作者 2026-10）：那裡就是 accelon3 的資料夾，
// 幾十個 .adb 都在，建完直接雙擊就能看／測，不必先搬檔案。`--out <目錄>` 可以換地方。
const OUT_DIR = opt('out', resolve(ROOT, 'accelon3'));
const EXE = resolve(OUT_DIR, 'accelon26.exe');
const URL = opt('url', 'https://shutonggui.cn/accelon26/accelon26.exe');
const NO_BUILD = args.includes('--no-build');

const itemsFile = opt('items-file');
const items = (itemsFile
  ? readFileSync(resolve(process.cwd(), itemsFile), 'utf8').split(/\r?\n/).map((s) => s.trim())
  : opt('items').split(';').map((s) => s.trim())
).filter((s) => s && !s.startsWith('#'));
const title = opt('title', '');
if (!items.length && !args.includes('--no-build')) {
  console.log('（沒有 --items／--items-file：只建置，不加改版說明）');
  console.log('  加說明：bun run tools/release.ts --items-file notes.txt（一行一項，UTF-8）');
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
// 圖示（作者放在倉庫根目錄的 logo128.png）→ .ico → wails/accelon26.syso（go build 會自動連結）。
// 注意：wails3 generate syso **一定要給 -arch**，否則會產生 0 位元組的檔案，連結時會失敗。
// .syso 是建置產物（gitignore）；沒有 wails3 就跳過（只是沒有圖示，仍然可建置）。
function prepareIcon(): void {
  const png = resolve(ROOT, 'ts/src/accelon26/appicon.png');
  if (!existsSync(png)) { console.log('（沒有 logo128.png，略過圖示）'); return; }
  const ico = resolve(ROOT, 'build/windows/icon.ico');
  const syso = resolve(WAILS, 'accelon26.syso');
  mkdirSync(resolve(ROOT, 'build/windows'), { recursive: true });
  mkdirSync(resolve(ROOT, 'build/darwin'), { recursive: true });
  const best = (cmd: string[], label: string) => {
    const r = Bun.spawnSync({ cmd, cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
    if (r.exitCode !== 0) console.log('（' + label + ' 失敗，略過圖示：' + new TextDecoder().decode(r.stderr).trim().split('\n').slice(-1)[0] + '）');
    return r.exitCode === 0;
  };
  if (!best(['wails3', 'generate', 'icons', '-input', png, '-windowsfilename', ico, '-macfilename', resolve(ROOT, 'build/darwin/icon.icns')], 'icons')) return;
  if (!best(['wails3', 'generate', 'syso', '-arch', 'amd64', '-icon', ico, '-manifest', resolve(WAILS, 'windows.manifest'), '-out', syso], 'syso')) return;
  const size = existsSync(syso) ? statSync(syso).size : 0;
  if (size < 1024) {   // 0 位元組的 .syso 會讓 go build 失敗，一定要清掉
    console.log('（.syso 只有 ' + size + ' 位元組，不合法 → 刪掉）');
    rmSync(syso, { force: true });
    return;
  }
  console.log('（圖示已嵌入：' + ico.replace(ROOT + '\\', '') + ' → ' + syso.replace(ROOT + '\\', '') + '，' + (size / 1024).toFixed(0) + ' KiB）');
}

console.log('[2/3] 建置 exe（內嵌 HTML ＋ 注入建置時間' + (args.includes('--console') ? '，console 版' : '，GUI 版／雙擊不跳命令列') + '）');
// -H windowsgui：GUI 子系統，雙擊才不會跳出命令列視窗（要 console 版就加 --console）。
const ldflags = '-X main.buildTime=' + buildTime + (args.includes('--console') ? '' : ' -H windowsgui');
prepareIcon();
run(['go', 'build', '-ldflags', ldflags, '-o', EXE, '.'], WAILS, 'go build');

// 2.5) 子系統檢查（作者 2026-10-25）：使用者雙擊 exe 不該看到命令列視窗。
//      `go build` 預設是 console（3）；只有 -H windowsgui 才是 GUI（2）。
//      沒有這道檢查時，一次漏掉 flag 的本機重建就會把「黑視窗」版本發出去。
{
  const want = args.includes('--console') ? 3 : 2;
  const got = peSubsystem(EXE);
  console.log(`  子系統 ${got}（${subsystemLabel(got)}）`);
  if (got !== want) {
    console.error(
      `\n✗ exe 子系統是 ${got}，預期 ${want}（2=GUI、3=console）。` +
        (want === 2 ? '使用者會看到命令列視窗——請確認 -ldflags 含 -H windowsgui。' : ''),
    );
    process.exit(1);
  }
}

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

// 3.5) versions.json：版本真相。更新器先讀它（buildTime 比大小、sha256 驗下載），
//      讀不到才退回 Last-Modified。**一定要跟 exe 同一批上傳**（先 exe、後它）。
const sha256 = createHash('sha256').update(readFileSync(EXE)).digest('hex');
const MANIFEST_URL = URL.replace(/[^/]*$/, 'versions.json');
const manifest = {
  app: 'accelon26',
  channel: 'stable',
  buildTime,
  url: URL,
  size,
  sha256,
  releasedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
};
const manifestPath = resolve(OUT_DIR, 'versions.json');
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`\nversions.json → ${manifestPath}`);
console.log(`  buildTime ${buildTime}`);
console.log(`  sha256    ${sha256}`);
console.log(`  size      ${size}`);

// ---- 壓縮檔裡的使用說明（作者 2026-10-18）--------------------------------------
// 文字在 tools/readme-text.ts（一份簡體、一份繁體，UTF-8 帶 BOM ＋ CRLF）；
// tools/pack-7z.ts 也共用同一份，只改說明時不必重建 exe。

// 4) 官網下載檔：www/accelon26.7z（作者 2026-10-18）
//    官網 index.html 直接連到這個檔；7z 是發佈產物，不進 git（.gitignore 有 www/*.7z）。
//    壓縮檔裡除了 exe，還附兩份說明（作者 2026-10-18）：README.txt（簡體）、
//    README-tc.txt（繁體），都是 **UTF-8 帶 BOM ＋ CRLF**（Windows 記事本才不會亂碼）。
const SEVEN_ZIP = 'C:\\Program Files\\7-Zip\\7z.exe';
const WWW = resolve(ROOT, 'www');
const PKG_FILES = ['accelon26.exe', 'README.txt', 'README-tc.txt'];
let sevenZipOut = '';
if (existsSync(SEVEN_ZIP)) {
  // 先準備一個乾淨的資料夾，壓縮檔裡的東西才不會帶到奇怪的路徑。
  const pkg = resolve(ROOT, 'build/pkg');
  rmSync(pkg, { recursive: true, force: true });
  mkdirSync(pkg, { recursive: true });
  copyFileSync(EXE, resolve(pkg, 'accelon26.exe'));
  writeTextFileBom(resolve(pkg, 'README.txt'), README_SIMPLIFIED);
  writeTextFileBom(resolve(pkg, 'README-tc.txt'), README_TRADITIONAL);

  mkdirSync(WWW, { recursive: true });
  const archive = resolve(WWW, 'accelon26.7z');
  try {
    rmSync(archive, { force: true });
  } catch {
    console.error('✗ 無法覆蓋 ' + archive + '：可能被 7-Zip／檔案總管開著，請關掉那個視窗');
    process.exit(1);
  }
  console.log('\n[4/4] 打包官網下載檔 www/accelon26.7z（exe ＋ 兩份 README）');
  run([SEVEN_ZIP, 'a', '-t7z', '-mx=9', '-m0=lzma2', '-md=64m', '-mfb=64', '-y', archive, ...PKG_FILES], pkg, '7z');
  sevenZipOut = archive;
  console.log(`  ${archive}（${(statSync(archive).size / 1048576).toFixed(1)} MiB）`);
} else {
  console.log('\n（沒找到 7-Zip，略過 www/accelon26.7z：' + SEVEN_ZIP + '）');
}

// 5) 上傳指示 + 線上檢查（線上已有 versions.json 就以它為準）
console.log('\n上傳到 ' + URL.replace(/[^/]*$/, '') + '（順序不要顛倒：先 exe，後 versions.json）');
console.log('  1) ' + URL);
console.log('  2) ' + MANIFEST_URL);
if (sevenZipOut) console.log('  3) 官網首頁與下載檔：www/index.html、www/img/、www/accelon26.7z');
try {
  const mres = await fetch(MANIFEST_URL, { headers: { 'cache-control': 'no-cache' } });
  if (mres.ok) {
    const online = await mres.json() as { buildTime?: string; sha256?: string };
    console.log(`\n線上的 versions.json：buildTime ${online.buildTime}／sha256 ${String(online.sha256 ?? '').slice(0, 12)}…`);
    if (String(online.sha256 ?? '').toLowerCase() === sha256) {
      console.log('  線上就是這一版（sha256 相同）');
    } else if ((online.buildTime ?? '') > buildTime) {
      console.log('  線上比這一版新（使用者會被提示更新）');
    } else {
      console.log('  線上還是舊的（還沒上傳吧）');
    }
  } else {
    console.log(`\n線上還沒有 versions.json（HTTP ${mres.status}）→ 舊版程式會退回看 Last-Modified`);
    const head = await fetch(URL, { method: 'HEAD' });
    console.log('  線上的 Last-Modified：' + (head.headers.get('last-modified') ?? '（沒有！這樣程式不會提示更新）'));
  }
} catch (e) {
  console.log('\n（線上檢查失敗：' + String(e) + '）');
}
