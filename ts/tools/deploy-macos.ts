/**
 * 把 macOS 版（build/macos/accelon26-macos-*.zip）上傳到
 * https://shutonggui.cn/accelon26/ ，然後從真正的網址抓回來比對 sha256。
 *
 *   cd ts && bun run tools/deploy-macos.ts            # 上傳 ＋ 驗證
 *   cd ts && bun run tools/deploy-macos.ts --check     # 只驗證線上檔案
 *   cd ts && bun run tools/deploy-macos.ts --dir D:\\2026\\adb-converter\\build\\macos
 *
 * 為什麼另外一支（不併進 deploy.ts）：deploy.ts 是「exe ＋ versions.json ＋ 官網」的
 * 原子替換流程，macOS 的 zip 跟它沒有先後關係 —— 而且 macOS 版沒有自動更新，
 * 這裡上傳的只是「給人下載的檔案」。
 *
 * 憑證：`.local/server.env`（HOST／PORT／USER／PASS／DOCROOT，`local/` 在 .gitignore）；
 * 主機金鑰指紋優先讀 `.local/hostkey.txt`。PuTTY 的 -pwfile 讓密碼不出現在命令列。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../..');
const LOCAL = resolve(ROOT, '.local');
const PLINK = 'C:\\Program Files\\PuTTY\\plink.exe';
const PSCP = 'C:\\Program Files\\PuTTY\\pscp.exe';

const args = process.argv.slice(2);
const opt = (n: string, d = '') => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const CHECK_ONLY = args.includes('--check');
const DIR = resolve(opt('dir', resolve(ROOT, 'build/macos')));

function die(msg: string): never {
  console.error('✗ ' + msg);
  process.exit(1);
}

// ---- 憑證（與 deploy.ts 同一份） ------------------------------------------------
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

const fingerprint = (() => {
  const cache = resolve(LOCAL, 'hostkey.txt');
  if (!existsSync(cache)) die('找不到 .local/hostkey.txt（先跑一次 tools/deploy.ts 讓它掃描並記下來）');
  return readFileSync(cache, 'utf8').trim();
})();

const pwFile = resolve(LOCAL, '.pw.tmp');
if (!CHECK_ONLY) writeFileSync(pwFile, PASS + '\n', { mode: 0o600 });

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

// ---- 要上傳的檔案：accelon26-macos-<arch>.zip（＋ .sha256） ----------------------
if (!existsSync(DIR)) die('找不到目錄 ' + DIR + '（先跑 wails/scripts/package-macos.sh）');
const zips = readdirSync(DIR).filter((n) => /^accelon26-macos-[a-z0-9_]+\.zip$/.test(n)).sort();
if (!zips.length) die(DIR + ' 裡沒有 accelon26-macos-*.zip（先跑 wails/scripts/package-macos.sh）');

const files: { name: string; local: string; size: number; sha256: string }[] = [];
for (const name of zips) {
  const local = resolve(DIR, name);
  const size = statSync(local).size;
  const sha256 = createHash('sha256').update(readFileSync(local)).digest('hex');
  files.push({ name, local, size, sha256 });
  console.log('本地：' + name + '  ' + (size / 1048576).toFixed(1) + ' MiB  sha256 ' + sha256.slice(0, 12) + '…');
}

const BASE = 'https://shutonggui.cn/accelon26/';

if (!CHECK_ONLY) {
  try {
    for (const f of files) {
      // 先傳成 .tmp 再原子改名：下載的人不會抓到半個檔案。
      upload(f.local, DOCROOT + '/' + f.name + '.tmp');
      remote(`cd '${DOCROOT}' && chmod 644 '${f.name}.tmp' && mv -f '${f.name}.tmp' '${f.name}' && ls -l '${f.name}'`, '換上 ' + f.name);
    }
  } finally {
    rmSync(pwFile, { force: true });
  }
}

// ---- 驗證：從真正的網址抓回來比對 ----------------------------------------------
console.log('\n驗證線上檔案…');
let bad = 0;
for (const f of files) {
  const res = await fetch(BASE + f.name, { headers: { 'cache-control': 'no-cache' } });
  if (!res.ok) {
    console.error('✗ ' + f.name + '：HTTP ' + res.status);
    bad++;
    continue;
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  const got = createHash('sha256').update(buf).digest('hex');
  if (buf.byteLength !== f.size || got.toLowerCase() !== f.sha256) {
    console.error('✗ ' + f.name + '：大小 ' + buf.byteLength + '（本地 ' + f.size + '）、sha256 ' + got.slice(0, 12) + '…');
    bad++;
    continue;
  }
  const lm = res.headers.get('last-modified');
  console.log('✓ ' + BASE + f.name + '（' + (buf.byteLength / 1048576).toFixed(1) + ' MiB，sha256 ' +
    got.slice(0, 12) + '…' + (lm ? '，Last-Modified ' + lm : '') + '）');
}
if (bad) die(bad + ' 個檔案驗不過');
console.log('\nmacOS 版已就位：' + BASE);
