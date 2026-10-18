/**
 * 部署到 https://shutonggui.cn/accelon26/（作者 2026-10-18 把這個資料夾交給助手管）。
 *
 *   cd ts && bun run tools/deploy.ts            # exe ＋ versions.json
 *   cd ts && bun run tools/deploy.ts --site     # 另外上傳 www/（首頁、圖片、7z）
 *   cd ts && bun run tools/deploy.ts --site-only # 只換 www/，完全不碰 exe／versions.json
 *   cd ts && bun run tools/deploy.ts --check    # 只驗線上，不上傳
 *
 * `--site-only` 是給「只是改了首頁」用的：不然為了改一行字就得先發一版新 exe，
 * 讓所有 Windows 使用者白更新一次。macOS 的 zip 另外用 tools/deploy-macos.ts 上。
 *
 * 帳密從 `.local/server.env` 讀（`.local/` 在 .gitignore，內容不會被印出來）；
 * 主機金鑰指紋從 `.local/hostkey.txt` 讀，沒有就 `ssh-keyscan` 一次並存起來
 * —— 之後伺服器換金鑰就會失敗（這是刻意的，不是壞掉）。
 *
 * 為什麼要有這支：網站、exe、versions.json 必須同一批上線，而且**先 exe、後
 * versions.json** —— 讀者永遠不會先看到新版本號、卻抓到舊的位元組。上傳一律先寫
 * `.tmp` 再 `mv`（同一個檔案系統，原子替換），所以網站上不會出現半個檔案。
 */
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../..');
const LOCAL = resolve(ROOT, '.local');
const PLINK = 'C:\\Program Files\\PuTTY\\plink.exe';
const PSCP = 'C:\\Program Files\\PuTTY\\pscp.exe';
const SSH_KEYSCAN = 'C:\\Program Files\\Git\\usr\\bin\\ssh-keyscan.exe';
const SSH_KEYGEN = 'C:\\Program Files\\Git\\usr\\bin\\ssh-keygen.exe';

const args = process.argv.slice(2);
const opt = (n: string, d = '') => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const CHECK_ONLY = args.includes('--check');
const WITH_SITE = args.includes('--site');
// --site-only：只換官網（www/*.html、7z、img/），**不碰** exe 與 versions.json。
// 用在「只是改了首頁」的時候 —— 否則為了改一行字，得先發一版新的 exe，
// 讓所有 Windows 使用者白更新一次。
const SITE_ONLY = args.includes('--site-only');
const SITE = WITH_SITE || SITE_ONLY;
const EXE = resolve(opt('exe', 'D:\\accelon26\\accelon26.exe'));
const MANIFEST = resolve(opt('manifest', 'D:\\accelon26\\versions.json'));

function die(msg: string): never {
  console.error('✗ ' + msg);
  process.exit(1);
}

// ---- 憑證 ---------------------------------------------------------------------
const envPath = resolve(LOCAL, 'server.env');
if (!existsSync(envPath)) die('找不到 ' + envPath + '（照 .local/server.env 的範本填一次）');
const env: Record<string, string> = {};
for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
  if (m) env[m[1].toUpperCase()] = m[2].trim().replace(/^["']|["']$/g, '');
}
const HOST = env.HOST;
const PORT = env.PORT || '22';
const USER = env.USER;
const PASS = env.PASS;
const DOCROOT = (env.DOCROOT || '/var/www/html/accelon26').replace(/\/+$/, '');
if (!HOST || !USER || !PASS) die('.local/server.env 的 HOST／USER／PASS 有空值');

/** 主機金鑰指紋：第一次用 ssh-keyscan 取得並記下來，之後就固定比對。 */
function hostFingerprint(): string {
  const cache = resolve(LOCAL, 'hostkey.txt');
  if (existsSync(cache)) return readFileSync(cache, 'utf8').trim();
  const scan = Bun.spawnSync({ cmd: [SSH_KEYSCAN, '-t', 'ed25519', '-p', PORT, HOST], stdout: 'pipe', stderr: 'pipe' });
  const raw = new TextDecoder().decode(scan.stdout);
  if (!raw.trim()) die('ssh-keyscan 沒有回應（主機 ' + HOST + '）');
  const tmp = resolve(LOCAL, '.keyscan.tmp');
  writeFileSync(tmp, raw);
  const fpr = Bun.spawnSync({ cmd: [SSH_KEYGEN, '-lf', tmp], stdout: 'pipe', stderr: 'pipe' });
  rmSync(tmp, { force: true });
  const m = /(SHA256:[A-Za-z0-9+/=]+)/.exec(new TextDecoder().decode(fpr.stdout));
  if (!m) die('算不出主機金鑰指紋');
  writeFileSync(cache, m[1] + '\n');
  console.log('（第一次連線：主機金鑰指紋 ' + m[1] + ' 已記到 .local/hostkey.txt）');
  return m[1];
}

const fingerprint = hostFingerprint();

// PuTTY 的 -pwfile：把密碼寫進暫存檔再刪掉，避免密碼出現在命令列（工作管理員看得到）。
const pwFile = resolve(LOCAL, '.pw.tmp');
writeFileSync(pwFile, PASS + '\n', { mode: 0o600 });

function sh(cmd: string[], label: string): string {
  const r = Bun.spawnSync({ cmd, stdout: 'pipe', stderr: 'pipe' });
  const out = new TextDecoder().decode(r.stdout).trim();
  const err = new TextDecoder().decode(r.stderr).trim();
  if (r.exitCode !== 0) {
    console.error('✗ ' + label + '（exit ' + r.exitCode + '）');
    if (out) console.error(out);
    if (err) console.error(err);
    process.exit(1);
  }
  return out;
}

function upload(localPath: string, remotePath: string): void {
  sh([PSCP, '-batch', '-P', PORT, '-hostkey', fingerprint, '-pwfile', pwFile, localPath, USER + '@' + HOST + ':' + remotePath],
    '上傳 ' + remotePath);
}

function remote(script: string, label: string): string {
  const f = resolve(LOCAL, '.remote.sh');
  writeFileSync(f, script);
  const out = sh([PLINK, '-batch', '-ssh', '-P', PORT, '-l', USER, '-hostkey', fingerprint, '-pwfile', pwFile, '-m', f, HOST], label);
  rmSync(f, { force: true });
  return out;
}

// ---- 本地檔案 ---------------------------------------------------------------
let manifest: { buildTime: string; url: string; size: number; sha256: string } | null = null;
let BASE = 'https://shutonggui.cn/accelon26/';
if (!SITE_ONLY) {
  if (!existsSync(MANIFEST)) die('找不到 ' + MANIFEST + '（先跑 tools/release.ts）');
  manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as { buildTime: string; url: string; size: number; sha256: string };
  BASE = manifest.url.replace(/[^/]*$/, '');
}

if (!CHECK_ONLY) {
  try {
    if (!SITE_ONLY) {
      const m = manifest!;
      if (!existsSync(EXE)) die('找不到 ' + EXE);
      const exeSize = statSync(EXE).size;
      const exeSha = createHash('sha256').update(readFileSync(EXE)).digest('hex');
      if (exeSize !== m.size || exeSha.toLowerCase() !== m.sha256.toLowerCase()) {
        die('exe 與 versions.json 不一致（exe ' + exeSize + ' bytes／' + exeSha.slice(0, 12) + '…，' +
          'manifest ' + m.size + ' bytes／' + String(m.sha256).slice(0, 12) + '…）→ 重跑 release.ts');
      }
      console.log('本地檔案：exe ' + (exeSize / 1048576).toFixed(1) + ' MiB、sha256 ' + exeSha.slice(0, 12) + '…、build ' + m.buildTime);

      // 1) exe 先上（先 .tmp，再原子改名；舊的那顆留成 .prev 以備回滾）
      upload(EXE, DOCROOT + '/accelon26.exe.tmp');
      console.log(remote(`cd '${DOCROOT}' && chmod 644 'accelon26.exe.tmp' && [ -f accelon26.exe ] && cp -f accelon26.exe accelon26.exe.prev; mv -f 'accelon26.exe.tmp' 'accelon26.exe' && ls -l accelon26.exe`, '換上新的 exe'));
      // 2) 再上 versions.json（讀者看到新版本號時，exe 一定已經就位）
      upload(MANIFEST, DOCROOT + '/versions.json.tmp');
      console.log(remote(`cd '${DOCROOT}' && chmod 644 'versions.json.tmp' && [ -f versions.json ] && cp -f versions.json versions.json.prev; mv -f 'versions.json.tmp' versions.json && cat versions.json`, '換上新的 versions.json'));
    }
    // 3) 官網（--site 或 --site-only）：www/ 下的所有 .html 與 .7z（首頁、留言頁、下載檔）
    if (SITE) {
      const siteDir = resolve(ROOT, 'www');
      const names = readdirSync(siteDir).filter((n) => n.endsWith('.html') || n.endsWith('.7z')).sort();
      for (const name of names) {
        const p = resolve(siteDir, name);
        upload(p, DOCROOT + '/' + name + '.tmp');
        remote(`cd '${DOCROOT}' && chmod 644 '${name}.tmp' && mv -f '${name}.tmp' '${name}'`, '換上 ' + name);
      }
      const img = resolve(ROOT, 'www', 'img');
      if (existsSync(img)) {
        // pscp -r 需要遠端目錄先存在（否則 remote filespec … not a directory）
        remote(`cd '${DOCROOT}' && mkdir -p img`, '建立 img/ 目錄');
        sh([PSCP, '-batch', '-r', '-P', PORT, '-hostkey', fingerprint, '-pwfile', pwFile, img, USER + '@' + HOST + ':' + DOCROOT + '/'],
          '上傳 www/img/');
      }
    }
  } finally {
    rmSync(pwFile, { force: true });
  }
}

// ---- 驗證：從真正的網址抓回來比對 --------------------------------------------
if (SITE_ONLY) {
  // 只換官網：確認首頁／留言頁／下載檔真的在線上（不碰 versions.json 與 exe）。
  console.log('\n驗證線上網頁…');
  try {
    const siteDir = resolve(ROOT, 'www');
    const names = readdirSync(siteDir).filter((n) => n.endsWith('.html') || n.endsWith('.7z')).sort();
    for (const name of names) {
      const r = await fetch(BASE + name, { method: 'HEAD', headers: { 'cache-control': 'no-cache' } });
      if (!r.ok) die(BASE + name + ' 讀不到（HTTP ' + r.status + '）');
      console.log('✓ ' + BASE + name + '（' + (r.headers.get('content-length') ?? '?') + ' bytes）');
    }
    console.log(CHECK_ONLY
      ? '\n線上官網都在（--check：沒有上傳任何東西）。'
      : '\n官網已更新：' + BASE + '（exe 與 versions.json 沒動）');
  } catch (e) {
    die('驗證失敗：' + String(e));
  }
} else {
console.log('\n驗證線上檔案…');
try {
  const mres = await fetch(BASE + 'versions.json', { headers: { 'cache-control': 'no-cache' } });
  if (!mres.ok) die('線上的 versions.json 讀不到（HTTP ' + mres.status + '）');
  const online = await mres.json() as { buildTime?: string; sha256?: string; size?: number };
  if (String(online.sha256 ?? '').toLowerCase() !== manifest!.sha256.toLowerCase()) {
    die('線上的 versions.json 不是這一版（sha256 ' + String(online.sha256).slice(0, 12) + '…）');
  }
  const eres = await fetch(BASE + 'accelon26.exe', { headers: { 'cache-control': 'no-cache' } });
  if (!eres.ok) die('線上的 exe 讀不到（HTTP ' + eres.status + '）');
  const buf = new Uint8Array(await eres.arrayBuffer());
  const got = createHash('sha256').update(buf).digest('hex');
  if (got.toLowerCase() !== manifest!.sha256.toLowerCase()) {
    die('線上的 exe 與 versions.json 不符（' + buf.byteLength + ' bytes，sha256 ' + got.slice(0, 12) + '…）');
  }
  const lm = eres.headers.get('last-modified');
  console.log('✓ versions.json 與 exe 都是 build ' + online.buildTime + '（' + (buf.byteLength / 1048576).toFixed(1) + ' MiB，sha256 ' + got.slice(0, 12) + '…）');
  console.log('✓ Last-Modified：' + (lm ?? '（沒有；不影響，有 versions.json 就以它為準）'));
  console.log('\nhttps://shutonggui.cn/accelon26/ 已是最新。');
} catch (e) {
  die('驗證失敗：' + String(e));
}
}
