/**
 * 把公開資料庫的 .adb 同步到主站與鏡像（作者 2026-10-29）。
 *
 *   cd ts && bun run tools/publish-adb.ts                       # index.txt 裡的每一個 adb，兩站
 *   cd ts && bun run tools/publish-adb.ts --files swjzz.adb,ys.adb
 *   cd ts && bun run tools/publish-adb.ts --mirror-only         # 只補鏡像
 *   cd ts && bun run tools/publish-adb.ts --primary-only
 *
 * 來源是本機 `D:\accelon3`（作者維護的那一份）；只上傳線上 sha256 不同的檔案，
 * 上傳一律 `.tmp` → 原子 mv，再從真正的網址抓回來驗 sha256。
 *
 * 帳密與站點設定在 `.local/server.env`（見 tools/deploy.ts 的說明）。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../..');
const LOCAL = resolve(ROOT, '.local');
const PLINK = 'C:\\Program Files\\PuTTY\\plink.exe';
const PSCP = 'C:\\Program Files\\PuTTY\\pscp.exe';

const args = process.argv.slice(2);
const opt = (n: string, d = '') => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const MIRROR_ONLY = args.includes('--mirror-only');
const PRIMARY_ONLY = args.includes('--primary-only');
const SRC_DIR = resolve(opt('dir', 'D:\\accelon3'));

const env: Record<string, string> = {};
for (const line of readFileSync(resolve(LOCAL, 'server.env'), 'utf8').split(/\r?\n/)) {
  const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
  if (m) env[m[1].toUpperCase()] = m[2].trim().replace(/^["']|["']$/g, '');
}
if (!env.HOST || !env.USER || !env.PASS) { console.error('server.env 缺少 HOST/USER/PASS'); process.exit(2); }

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
if (!chosen.length) { console.error('沒有可同步的站'); process.exit(2); }

// 檔案清單：--files，或 www/adb/index.txt 的每一筆
function indexFiles(): string[] {
  const out: string[] = [];
  const p = resolve(ROOT, 'www/adb/index.txt');
  if (existsSync(p)) {
    for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (t && !t.startsWith('#')) out.push(t.split(/\t+|\s{2,}/)[0].trim());
    }
  }
  // 不列在頁面、但要同步的大檔（taisho/wxzj）
  const extra = resolve(ROOT, 'deploy/adb-extra.txt');
  if (existsSync(extra)) {
    for (const line of readFileSync(extra, 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (t && !t.startsWith('#') && !out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
    }
  }
  return out;
}
const MAX_PUBLIC = 30 * 1024 * 1024;   // 大於 30 MB 的底座仍可整檔下載，但要明確加 --allow-large
const ALLOW_LARGE = args.includes('--allow-large');
let statuses: Record<string, { status?: string }> = {};
try { statuses = JSON.parse(readFileSync(resolve(ROOT, 'deploy/adb-status.json'), 'utf8')); } catch { /* none */ }
const requested = (opt('files', '') ? opt('files', '').split(',') : indexFiles()).map((s) => s.trim()).filter(Boolean);
const files: string[] = [];
for (const name of requested) {
  if (statuses[name]?.status && statuses[name].status !== 'available') {
    console.warn('  ! ' + name + ' 狀態是 ' + statuses[name].status + '，不公開上傳（施工中）');
    continue;
  }
  const p = resolve(SRC_DIR, name);
  const size = existsSync(p) ? statSync(p).size : 0;
  if (size > MAX_PUBLIC && !ALLOW_LARGE) {
    console.warn('  ! ' + name + ' ' + (size / 1048576).toFixed(1) + ' MB > 30 MB：大型底座要整檔散布時加 --allow-large');
    continue;
  }
  files.push(name);
}
if (!files.length) { console.error('沒有要上傳的 adb（施工中的庫不上傳；>30 MB 需 --allow-large）'); process.exit(2); }

const shaOf = (b: Uint8Array | Buffer): string => createHash('sha256').update(b).digest('hex');
const local = new Map<string, { path: string; sha: string; size: number }>();
for (const name of files) {
  const path = resolve(SRC_DIR, name);
  if (!existsSync(path)) { console.error('找不到 ' + path); process.exit(2); }
  const buf = readFileSync(path);
  local.set(name, { path, sha: shaOf(buf), size: buf.length });
  console.log(`本機 ${name}  ${(buf.length / 1048576).toFixed(1)} MiB  sha256 ${shaOf(buf).slice(0, 16)}…`);
}

const sh = (cmd: string[], label: string): string => {
  const r = Bun.spawnSync({ cmd, stdout: 'pipe', stderr: 'pipe' });
  const out = new TextDecoder().decode(r.stdout).trim();
  const err = new TextDecoder().decode(r.stderr).trim();
  if (r.exitCode !== 0) { console.error(`✗ ${label}（exit ${r.exitCode}）\n${out}\n${err}`); throw new Error(label); }
  return out;
};

function fingerprint(t: Target): string {
  for (const p of [t.hostkey, ...(t.id === 'primary' ? [resolve(LOCAL, 'hostkey.txt')] : [])]) {
    if (existsSync(p)) { const s = readFileSync(p, 'utf8').trim(); if (s) return s; }
  }
  console.error('缺少主機金鑰：' + t.hostkey + '（先用 deploy.ts 連一次）');
  process.exit(2);
}

let failures = 0;
for (const t of chosen) {
  const fp = fingerprint(t);
  const pw = resolve(LOCAL, `.pw-${t.id}.tmp`);
  writeFileSync(pw, t.pass + '\n', { mode: 0o600 });
  const remote = (script: string): string => {
    const f = resolve(LOCAL, `.remote-${t.id}.sh`);
    writeFileSync(f, script);
    try {
      return sh([PLINK, '-batch', '-ssh', '-P', t.port, '-l', t.user, '-hostkey', fp, '-pwfile', pw, '-m', f, t.host], `[${t.label}] ssh`);
    } finally { rmSync(f, { force: true }); }
  };
  try {
    console.log(`\n=== ${t.label} ${t.base} ===`);
    remote(`mkdir -p '${t.docroot}/adb'\n`);   // 新主機第一次同步時還沒有 adb/
    const listing = remote(`cd '${t.docroot}/adb' && sha256sum ${files.map((n) => `'${n}'`).join(' ')} 2>&1 || true\n`);
    const online = new Map<string, string>();
    for (const line of listing.split(/\r?\n/)) {
      const m = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim());
      if (m) online.set(m[2].trim(), m[1]);
    }
    for (const name of files) {
      const l = local.get(name)!;
      const o = online.get(name);
      if (o === l.sha) { console.log(`  = ${name} 已是最新`); continue; }
      console.log(`  ↑ ${name}（${o ? '線上不同' : '線上沒有'}）…`);
      sh([PSCP, '-batch', '-P', t.port, '-hostkey', fp, '-pwfile', pw, l.path,
        `${t.user}@${t.host}:${t.docroot}/adb/${name}.tmp`], `[${t.label}] 上傳 ${name}`);
      const out = remote(`cd '${t.docroot}/adb' && chmod 644 '${name}.tmp' && mv -f '${name}.tmp' '${name}' && ls -l '${name}' && sha256sum '${name}'\n`);
      console.log(out.split(/\r?\n/).map((s) => '    ' + s).join('\n'));
    }
    // 線上 sha256 複驗（不必重新下載 100 MB）
    const again = remote(`cd '${t.docroot}/adb' && sha256sum ${files.map((n) => `'${n}'`).join(' ')}\n`);
    for (const line of again.split(/\r?\n/)) {
      const m = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim());
      if (!m) continue;
      const name = m[2].trim();
      const ok = m[1] === local.get(name)?.sha;
      console.log(`  ${ok ? '✓' : '✗'} ${name}  ${m[1].slice(0, 16)}…`);
      if (!ok) failures++;
    }
  } catch (e) {
    console.error('✗ ' + t.label + '：' + String((e as Error)?.message ?? e));
    failures++;
  } finally {
    rmSync(pw, { force: true });
  }
}
if (failures) process.exit(1);
console.log(`\n✓ ${files.length} 個 adb 在 ${chosen.length} 個站都與本機一致`);
