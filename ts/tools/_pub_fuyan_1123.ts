/**
 * 一次性（2026-11-23）：把 www/adb/manifest.json 與 fuyan.html 精準上傳兩站（.tmp→mv 原子替換＋線上 sha 複查）。
 * 用於 fuyan.adb fff3972f8dd5 發佈：只拼 fuyan 一條進 manifest、fuyan.html 加版本列；
 * 依作者交接單 §4-5「勿批次 regen、不重生 index」，不走 deploy.ts --site-only。
 * 不動 exe／versions.json／adb 檔／index.html／其他頁面。憑證沿用 .local/server.env（不打印）。
 *   cd ts && bun run tools/_pub_fuyan_1123.ts
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../..');
const LOCAL = resolve(ROOT, '.local');
const PLINK = 'C:\\Program Files\\PuTTY\\plink.exe';
const PSCP = 'C:\\Program Files\\PuTTY\\pscp.exe';
const PAGES = ['manifest.json', 'fuyan.html'];

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

const locals = PAGES.map((p) => {
  const lp = resolve(ROOT, 'www/adb', p);
  if (!existsSync(lp)) die('找不到 ' + lp);
  const sha = createHash('sha256').update(readFileSync(lp)).digest('hex');
  console.log(`本機 www/adb/${p}  sha256 ${sha.slice(0, 16)}…`);
  return { p, lp, sha };
});

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
    for (const l of locals) {
      sh([PSCP, '-batch', '-P', t.port, '-hostkey', fp, '-pwfile', pw, l.lp,
        `${t.user}@${t.host}:${t.docroot}/adb/${l.p}.tmp`], `[${t.label}] 上傳 ${l.p}`);
    }
    const mv = locals.map((l) => `chmod 644 '${l.p}.tmp' && mv -f '${l.p}.tmp' '${l.p}'`).join(' && ');
    const rs = resolve(LOCAL, `_rem-${t.id}.sh`);
    const shas = locals.map((l) => `sha256sum '${l.p}'`).join(' && ');
    writeFileSync(rs, `cd '${t.docroot}/adb' && ${mv} && ${shas}\n`, { mode: 0o600 });
    const out = sh([PLINK, '-batch', '-ssh', '-P', t.port, '-l', t.user, '-hostkey', fp, '-pwfile', pw, '-m', rs, t.host], `[${t.label}] ssh`);
    const found = out.match(/[0-9a-f]{64}/g) ?? [];
    for (let i = 0; i < locals.length; i++) {
      const l = locals[i]!;
      if (found[i] === l.sha) console.log(`  ✓ ${l.p} 線上 sha 一致（${l.sha.slice(0, 16)}…）`);
      else console.log(`  ✗ ${l.p} 線上 sha 不符：${found[i] ?? '讀不到'}`);
    }
    rmSync(rs, { force: true });
  } finally {
    rmSync(pw, { force: true });
  }
}
console.log('\n完成');
