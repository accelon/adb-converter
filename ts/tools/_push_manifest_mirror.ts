/**
 * 一次性：只把本地 www/adb/manifest.json 推到「鏡像」（.tmp→mv＋線上 sha 複查）。
 * 用於「鏡像 adb 檔已換新版、主站上傳仍在進行、清單兩站都還指舊版」的補位：
 * 鏡像先一致讓海外讀者能更新，主站維持舊檔舊清單的自洽狀態不受動。
 *   cd ts && bun run tools/_push_manifest_mirror.ts
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../..');
const LOCAL = resolve(ROOT, '.local');
const PLINK = 'C:\\Program Files\\PuTTY\\plink.exe';
const PSCP = 'C:\\Program Files\\PuTTY\\pscp.exe';

function die(m: string): never { console.error('✗ ' + m); process.exit(1); }
const env: Record<string, string> = {};
for (const line of readFileSync(resolve(LOCAL, 'server.env'), 'utf8').split(/\r?\n/)) {
  const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
  if (m) env[m[1].toUpperCase()] = m[2].trim().replace(/^["']|["']$/g, '');
}
if (!env.MIRROR_HOST) die('server.env 沒有 MIRROR_HOST');
const MP = resolve(ROOT, 'www/adb/manifest.json');
if (!existsSync(MP)) die('找不到 ' + MP);
const localSha = createHash('sha256').update(readFileSync(MP)).digest('hex');
console.log('本地 manifest.json sha256 ' + localSha.slice(0, 16) + '…');

const host = env.MIRROR_HOST;
const port = env.MIRROR_PORT || env.PORT || '22';
const user = env.MIRROR_USER || env.USER;
const pass = env.MIRROR_PASS || env.PASS;
const docroot = (env.MIRROR_DOCROOT || env.DOCROOT || '/var/www/html/accelon26').replace(/\/+$/, '');
const hkPath = resolve(LOCAL, `hostkey-${host}.txt`);
if (!existsSync(hkPath)) die('缺少 ' + hkPath);
const fp = readFileSync(hkPath, 'utf8').trim();

function sh(cmd: string[], label: string): string {
  const r = Bun.spawnSync({ cmd, stdout: 'pipe', stderr: 'pipe' });
  const out = new TextDecoder().decode(r.stdout);
  const err = new TextDecoder().decode(r.stderr);
  if (r.exitCode !== 0) die(`${label}（exit ${r.exitCode}）\n${err || out}`);
  return out;
}

const pw = resolve(LOCAL, `.pw-mtmp.tmp`);
writeFileSync(pw, pass + '\n', { mode: 0o600 });
try {
  sh([PSCP, '-batch', '-P', port, '-hostkey', fp, '-pwfile', pw, MP,
    `${user}@${host}:${docroot}/adb/manifest.json.tmp`], '上傳 manifest.tmp');
  const rs = resolve(LOCAL, '_rem-mtmp.sh');
  writeFileSync(rs, `cd '${docroot}/adb' && chmod 644 manifest.json.tmp && mv -f manifest.json.tmp manifest.json && sha256sum manifest.json\n`, { mode: 0o600 });
  const out = sh([PLINK, '-batch', '-ssh', '-P', port, '-l', user, '-hostkey', fp, '-pwfile', pw, '-m', rs, host], 'ssh');
  const m = /([0-9a-f]{64})/.exec(out);
  if (m && m[1] === localSha) console.log('✓ 鏡像 manifest 線上 sha 一致');
  else die('線上 sha 不符：' + out.trim().slice(0, 120));
  rmSync(rs, { force: true });
} finally {
  rmSync(pw, { force: true });
}
console.log('完成（主站未動）');
