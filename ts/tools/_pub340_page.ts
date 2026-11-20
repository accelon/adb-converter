/**
 * 一次性：把 www/adb/fuyan.html 精準上傳兩站（.tmp→mv 原子替換＋線上 sha 複查）。
 * 用於「deploy --no-adb 連 adb/ 頁面都不傳、但 fuyan.html 改版說明要跟上」的情境。
 * 不動 exe／versions.json／manifest.json／adb 檔。憑證沿用 .local/server.env（不打印）。
 *   cd ts && bun run tools/_pub340_page.ts
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../..');
const LOCAL = resolve(ROOT, '.local');
const PLINK = 'C:\\Program Files\\PuTTY\\plink.exe';
const PSCP = 'C:\\Program Files\\PuTTY\\pscp.exe';
const PAGE = 'fuyan.html';

function die(m: string): never { console.error('✗ ' + m); process.exit(1); }
const envPath = resolve(LOCAL, 'server.env');
if (!existsSync(envPath)) die('找不到 ' + envPath);
const env: Record<string, string> = {};
for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
  if (m) env[m[1].toUpperCase()] = m[2].trim().replace(/^["']|["']$/g, '');
}
if (!env.HOST || !env.USER || !env.PASS) die('server.env 的 HOST/USER/PASS 有空值');
const DOCROOT = (env.DOCROOT || '/var/www/html/accelon26').replace(/\/+$/, '');
const targets = [{ id: 'primary', label: '主站', host: env.HOST, port: env.PORT || '22', user: env.USER, pass: env.PASS,
  docroot: DOCROOT, hostkey: resolve(LOCAL, 'hostkey.txt') }];
if (env.MIRROR_HOST) targets.push({ id: 'mirror', label: '鏡像', host: env.MIRROR_HOST, port: env.MIRROR_PORT || env.PORT || '22',
  user: env.MIRROR_USER || env.USER, pass: env.MIRROR_PASS || env.PASS,
  docroot: (env.MIRROR_DOCROOT || DOCROOT).replace(/\/+$/, ''),
  hostkey: resolve(LOCAL, `hostkey-${env.MIRROR_HOST}.txt`) });

const LP = resolve(ROOT, 'www/adb', PAGE);
if (!existsSync(LP)) die('找不到 ' + LP);
const localSha = createHash('sha256').update(readFileSync(LP)).digest('hex');
console.log(`本機 www/adb/${PAGE}  sha256 ${localSha.slice(0, 16)}…`);

function sh(cmd: string[], label: string): string {
  const r = Bun.spawnSync({ cmd, stdout: 'pipe', stderr: 'pipe' });
  const out = new TextDecoder().decode(r.stdout);
  const err = new TextDecoder().decode(r.stderr);
  if (r.exitCode !== 0) die(`${label}（exit ${r.exitCode}）\n${err || out}`);
  return out;
}

for (const t of targets) {
  console.log(`\n=== ${t.label} https://${t.host}/ ===`);
  if (!existsSync(t.hostkey)) die(`缺少 ${t.hostkey}`);
  const fp = readFileSync(t.hostkey, 'utf8').trim();
  const pw = resolve(LOCAL, `.pw-${t.id}.tmp`);
  writeFileSync(pw, t.pass + '\n', { mode: 0o600 });
  try {
    sh([PSCP, '-batch', '-P', t.port, '-hostkey', fp, '-pwfile', pw, LP,
      `${t.user}@${t.host}:${t.docroot}/adb/${PAGE}.tmp`], `[${t.label}] 上傳 ${PAGE}`);
    const rs = resolve(LOCAL, `_rem-${t.id}.sh`);
    writeFileSync(rs, `cd '${t.docroot}/adb' && chmod 644 '${PAGE}.tmp' && mv -f '${PAGE}.tmp' '${PAGE}' && sha256sum '${PAGE}'\n`, { mode: 0o600 });
    const out = sh([PLINK, '-batch', '-ssh', '-P', t.port, '-l', t.user, '-hostkey', fp, '-pwfile', pw, '-m', rs, t.host], `[${t.label}] ssh`);
    const m = /([0-9a-f]{64})/.exec(out);
    if (m && m[1] === localSha) console.log(`  ✓ ${PAGE} 線上 sha 一致（${localSha.slice(0, 16)}…）`);
    else console.log(`  ✗ 線上 sha 不符：${out.trim().slice(0, 80)}`);
    rmSync(rs, { force: true });
  } finally {
    rmSync(pw, { force: true });
  }
}
console.log('\n完成');
