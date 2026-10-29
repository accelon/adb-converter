/**
 * 把 macOS 版（build/macos/accelon26-macos-*.zip）同步到主站與鏡像，
 * 然後從真正的網址抓回來比對 sha256。
 *
 *   cd ts && bun run tools/deploy-macos.ts            # 兩站
 *   cd ts && bun run tools/deploy-macos.ts --check     # 只驗證線上檔案
 *   cd ts && bun run tools/deploy-macos.ts --mirror-only
 *   cd ts && bun run tools/deploy-macos.ts --dir D:\\2026\\adb-converter\\build\\macos
 *
 * 為什麼另外一支（不併進 deploy.ts）：deploy.ts 是「exe ＋ versions.json ＋ 官網」的
 * 原子替換流程，macOS 的 zip 跟它沒有先後關係 —— 而且 macOS 版沒有自動更新，
 * 這裡上傳的只是「給人下載的檔案」。
 *
 * 憑證：`.local/server.env`（HOST／PORT／USER／PASS／DOCROOT／MIRROR_HOST…，`local/` 在
 * .gitignore）；主機金鑰指紋分別讀 `.local/hostkey-<host>.txt`（主站也接受 `hostkey.txt`）。
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
const MIRROR_ONLY = args.includes('--mirror-only');
const PRIMARY_ONLY = args.includes('--primary-only');
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
if (!env.HOST || !env.USER || !env.PASS) die('.local/server.env 的 HOST／USER／PASS 有空值');

interface Target { id: 'primary' | 'mirror'; label: string; host: string; port: string; user: string; pass: string; docroot: string; base: string; hostkey: string }
const DOCROOT = (env.DOCROOT || '/var/www/html/accelon26').replace(/\/+$/, '');
const targets: Target[] = [{
  id: 'primary', label: '主站', host: env.HOST, port: env.PORT || '22', user: env.USER, pass: env.PASS,
  docroot: DOCROOT, base: (env.PRIMARY_URL || 'https://shutonggui.cn/accelon26/').replace(/\/+$/, '') + '/',
  hostkey: resolve(LOCAL, 'hostkey.txt'),
}];
if (env.MIRROR_HOST) {
  const h = env.MIRROR_HOST;
  targets.push({
    id: 'mirror', label: '鏡像', host: h, port: env.MIRROR_PORT || env.PORT || '22',
    user: env.MIRROR_USER || env.USER, pass: env.MIRROR_PASS || env.PASS,
    docroot: (env.MIRROR_DOCROOT || DOCROOT).replace(/\/+$/, ''),
    base: (env.MIRROR_URL || `https://${h}/accelon26/`).replace(/\/+$/, '') + '/',
    hostkey: resolve(LOCAL, `hostkey-${h}.txt`),
  });
}
const chosen = targets.filter((t) => (MIRROR_ONLY ? t.id === 'mirror' : PRIMARY_ONLY ? t.id === 'primary' : true));
if (!chosen.length) die('沒有可上傳的站');

function fingerprint(t: Target): string {
  for (const p of [t.hostkey, ...(t.id === 'primary' ? [resolve(LOCAL, 'hostkey.txt')] : [])]) {
    if (existsSync(p)) return readFileSync(p, 'utf8').trim();
  }
  die('缺少 ' + t.hostkey + '（先跑一次 tools/deploy.ts 讓它掃描並記下來）');
}

// ---- 要上傳的檔案：accelon26-macos-<arch>.zip（＋ .sha256） ----------------------
if (!existsSync(DIR)) die('找不到目錄 ' + DIR + '（先跑 wails/scripts/package-macos.sh）');
const zips = readdirSync(DIR)
  .filter((n) => /^accelon26-macos-[a-z0-9_]+\.zip(\.sha256)?$/.test(n))
  .sort();
if (!zips.length) die(DIR + ' 裡沒有 accelon26-macos-*.zip（先跑 wails/scripts/package-macos.sh）');

const files: { name: string; local: string; size: number; sha256: string }[] = [];
for (const name of zips) {
  const local = resolve(DIR, name);
  const size = statSync(local).size;
  const sha256 = createHash('sha256').update(readFileSync(local)).digest('hex');
  files.push({ name, local, size, sha256 });
  console.log('本地：' + name + '  ' + (size / 1048576).toFixed(1) + ' MiB  sha256 ' + sha256.slice(0, 12) + '…');
}

const sh = (cmd: string[], label: string): string => {
  const r = Bun.spawnSync({ cmd, stdout: 'pipe', stderr: 'pipe' });
  const out = new TextDecoder().decode(r.stdout).trim();
  const err = new TextDecoder().decode(r.stderr).trim();
  if (r.exitCode !== 0) { console.error('✗ ' + label + '（exit ' + r.exitCode + '）\n' + out + '\n' + err); process.exit(1); }
  return out;
};

let bad = 0;
for (const t of chosen) {
  const fp = fingerprint(t);
  const pwFile = resolve(LOCAL, `.pw-macos-${t.id}.tmp`);
  if (!CHECK_ONLY) writeFileSync(pwFile, t.pass + '\n', { mode: 0o600 });
  try {
    if (!CHECK_ONLY) {
      console.log(`\n[${t.label}] 上傳 ${files.length} 個檔案…`);
      for (const f of files) {
        sh([PSCP, '-batch', '-P', t.port, '-hostkey', fp, '-pwfile', pwFile, f.local,
          t.user + '@' + t.host + ':' + t.docroot + '/' + f.name + '.tmp'], `[${t.label}] 上傳 ${f.name}`);
        const rf = resolve(LOCAL, `.remote-macos-${t.id}.sh`);
        writeFileSync(rf, `cd '${t.docroot}' && chmod 644 '${f.name}.tmp' && mv -f '${f.name}.tmp' '${f.name}' && ls -l '${f.name}'\n`);
        sh([PLINK, '-batch', '-ssh', '-P', t.port, '-l', t.user, '-hostkey', fp, '-pwfile', pwFile, '-m', rf, t.host], `[${t.label}] 換上 ${f.name}`);
        rmSync(rf, { force: true });
      }
    }
    console.log(`\n[${t.label}] 驗證線上檔案…`);
    for (const f of files) {
      const res = await fetch(t.base + f.name, { headers: { 'cache-control': 'no-cache' } });
      if (!res.ok) { console.error('✗ ' + f.name + '：HTTP ' + res.status); bad++; continue; }
      const buf = new Uint8Array(await res.arrayBuffer());
      const got = createHash('sha256').update(buf).digest('hex');
      if (buf.byteLength !== f.size || got.toLowerCase() !== f.sha256) {
        console.error('✗ ' + f.name + '：大小 ' + buf.byteLength + '（本地 ' + f.size + '）、sha256 ' + got.slice(0, 12) + '…');
        bad++;
        continue;
      }
      console.log('✓ ' + t.base + f.name + '（' + (buf.byteLength / 1048576).toFixed(1) + ' MiB，sha256 ' + got.slice(0, 12) + '…）');
    }
  } finally {
    rmSync(pwFile, { force: true });
  }
}
if (bad) die(bad + ' 個檔案驗不過');
console.log('\nmacOS 版已就位：' + chosen.map((t) => t.base).join('、'));
