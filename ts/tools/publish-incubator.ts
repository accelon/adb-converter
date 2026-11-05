/**
 * 把 incubator/projects.json 上傳到兩站（https://<host>/incubator/）。
 *
 *   cd ts && bun run tools/publish-incubator.ts
 *
 * 憑證沿用 .local/server.env（同 publish-yap）；網站根目錄＝DOCROOT 的上一層。
 */
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../..');
const LOCAL = resolve(ROOT, '.local');
const SRC = 'D:\\nissaya.cn\\html\\incubator\\projects.json';
const PLINK = 'C:\\Program Files\\PuTTY\\plink.exe';
const PSCP = 'C:\\Program Files\\PuTTY\\pscp.exe';
const SSH_KEYSCAN = 'C:\\Program Files\\Git\\usr\\bin\\ssh-keyscan.exe';
const SSH_KEYGEN = 'C:\\Program Files\\Git\\usr\\bin\\ssh-keygen.exe';

const envPath = resolve(LOCAL, 'server.env');
if (!existsSync(envPath)) throw new Error('找不到 ' + envPath);
const env: Record<string, string> = {};
for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
  if (m) env[m[1].toUpperCase()] = m[2].trim().replace(/^["']|["']$/g, '');
}
const DOCROOT = (env.DOCROOT || '/var/www/html/accelon26').replace(/\/+$/, '');
const SITE_ROOT = DOCROOT.replace(/\/[^/]+$/, '');
const REMOTE_DIR = SITE_ROOT + '/incubator';

interface Target { id: string; label: string; host: string; port: string; user: string; pass: string; base: string; key: string }
const targets: Target[] = [{
  id: 'primary', label: '主站', host: env.HOST, port: env.PORT || '22',
  user: env.USER, pass: env.PASS,
  base: (env.PRIMARY_URL || 'https://shutonggui.cn/').replace(/\/+$/, '') + '/incubator/',
  key: resolve(LOCAL, 'hostkey.txt'),
}];
if (env.MIRROR_HOST) {
  targets.push({
    id: 'mirror', label: '鏡像', host: env.MIRROR_HOST, port: env.MIRROR_PORT || env.PORT || '22',
    user: env.MIRROR_USER || env.USER, pass: env.MIRROR_PASS || env.PASS,
    base: `https://${env.MIRROR_HOST}/incubator/`,
    key: resolve(LOCAL, `hostkey-${env.MIRROR_HOST}.txt`),
  });
}

function fingerprint(t: Target): string {
  if (existsSync(t.key)) {
    const s = readFileSync(t.key, 'utf8').trim();
    if (s) return s;
  }
  const scan = Bun.spawnSync({ cmd: [SSH_KEYSCAN, '-t', 'ed25519', '-p', t.port, t.host], stdout: 'pipe', stderr: 'pipe' });
  const raw = new TextDecoder().decode(scan.stdout);
  if (!raw.trim()) throw new Error('ssh-keyscan 沒有回應（' + t.host + '）');
  const tmp = resolve(LOCAL, `.keyscan-${t.id}.tmp`);
  writeFileSync(tmp, raw);
  const fpr = Bun.spawnSync({ cmd: [SSH_KEYGEN, '-lf', tmp], stdout: 'pipe', stderr: 'pipe' });
  rmSync(tmp, { force: true });
  const m = /(SHA256:[A-Za-z0-9+/=]+)/.exec(new TextDecoder().decode(fpr.stdout));
  if (!m) throw new Error('算不出主機金鑰');
  writeFileSync(t.key, m[1] + '\n');
  return m[1];
}

function sh(cmd: string[], label: string): string {
  const r = Bun.spawnSync({ cmd, stdout: 'pipe', stderr: 'pipe' });
  const out = new TextDecoder().decode(r.stdout).trim();
  const err = new TextDecoder().decode(r.stderr).trim();
  if (r.exitCode !== 0) throw new Error(label + '（' + (err || out) + '）');
  return out;
}

const sha = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex');
const want = sha(SRC);

for (const t of targets) {
  const fp = fingerprint(t);
  const pw = resolve(LOCAL, `.pw-inc-${t.id}-${process.pid}.tmp`);
  writeFileSync(pw, t.pass + '\n', { mode: 0o600 });
  try {
    sh([PSCP, '-batch', '-P', t.port, '-hostkey', fp, '-pwfile', pw, SRC,
      `${t.user}@${t.host}:${REMOTE_DIR}/projects.json.tmp`], `[${t.label}] 上傳 projects.json`);
    const script = resolve(LOCAL, `.remote-inc-${t.id}-${process.pid}.sh`);
    writeFileSync(script, `cd '${REMOTE_DIR}' && chmod 644 projects.json.tmp && mv -f projects.json.tmp projects.json\n`);
    try {
      sh([PLINK, '-batch', '-ssh', '-P', t.port, '-l', t.user, '-hostkey', fp, '-pwfile', pw, '-m', script, t.host], `[${t.label}] 換上 projects.json`);
    } finally {
      rmSync(script, { force: true });
    }
  } finally {
    rmSync(pw, { force: true });
  }
  const r = await fetch(t.base + 'projects.json', { headers: { 'cache-control': 'no-cache' } });
  if (!r.ok) throw new Error(t.base + ' 讀不到（HTTP ' + r.status + '）');
  const got = createHash('sha256').update(new Uint8Array(await r.arrayBuffer())).digest('hex');
  if (got !== want) throw new Error(t.base + ' 內容與本機不同');
  console.log(`[${t.label}] ✓ ${t.base}projects.json`);
}
