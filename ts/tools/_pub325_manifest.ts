/**
 * 325 批：manifest 外科更新（只動 fuyan.adb，不碰 chanyao——平行線未發布新構建）。
 * 原因：make-adb-manifest 全量重生會被 chanyao 550338c4f088 無說明擋下（合理），
 * 本檔照 make-adb-manifest 的契約手工更新 fuyan 一筆＋上傳兩站 adb/manifest.json。
 * 憑證只從 .local/server.env 讀、不印出。
 */
import { readFileSync, writeFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../..');
const LOCAL = resolve(ROOT, '.local');
const PSCP = 'C:\\Program Files\\PuTTY\\pscp.exe';
const PLINK = 'C:\\Program Files\\PuTTY\\plink.exe';

const env: Record<string, string> = {};
for (const line of readFileSync(resolve(LOCAL, 'server.env'), 'utf8').split(/\r?\n/)) {
  const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
  if (m) env[m[1].toUpperCase()] = m[2].trim().replace(/^["']|["']$/g, '');
}
if (!env.HOST || !env.USER || !env.PASS) { console.error('server.env 缺 HOST/USER/PASS'); process.exit(2); }

const SHA = process.env.ADB_SHA ?? 'f52c07a33b86e7fe2522c612c8891e44efb3c0c176f5cbd5cf4daca640118fcc';
const SIZE = Number(process.env.ADB_SIZE ?? 26563928);
const BT = process.env.ADB_BT ?? '2026-11-19T11:23:04Z';
const DATE = process.env.ADB_DATE ?? '2026-11-19';
const NOTES = JSON.parse(readFileSync(resolve(ROOT, 'deploy/adb-notes.json'), 'utf8'))['fuyan.adb'].notes as string[];

const MP = resolve(ROOT, 'www/adb/manifest.json');
const man = JSON.parse(readFileSync(MP, 'utf8'));
const db = man.dbs.find((d: any) => d.file === 'fuyan.adb');
if (!db) { console.error('manifest 裡沒有 fuyan.adb'); process.exit(2); }
if (db.sha256 === SHA) {
  console.log('manifest 已是新版（冪等跳過）');
} else {
  const hist = db.history ?? (db.history = []);
  if (!hist.some((h: any) => h.sha256?.toLowerCase() === SHA)) {
    hist.unshift({ buildTime: BT, sha256: SHA, size: SIZE, notes: NOTES });
  }
  if (hist.length > 30) hist.length = 30;
  db.sha256 = SHA; db.size = SIZE; db.buildTime = BT; db.date = DATE; db.notes = NOTES;
  man.generated = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  writeFileSync(MP, JSON.stringify(man, null, 2) + '\n');
  console.log('本地 manifest 已更新 fuyan.adb →', SHA.slice(0, 12));
}

function sh(cmd: string[], label: string): string {
  const r = Bun.spawnSync({ cmd, stdout: 'pipe', stderr: 'pipe' });
  const out = new TextDecoder().decode(r.stdout).trim();
  const err = new TextDecoder().decode(r.stderr).trim();
  if (r.exitCode !== 0) { console.error(`✗ ${label}\n${out}\n${err}`); throw new Error(label); }
  return out;
}

const DOCROOT = (env.DOCROOT || '/var/www/html/accelon26').replace(/\/+$/, '');
const targets = [{
  id: 'primary', label: '主站', host: env.HOST, port: env.PORT || '22', user: env.USER, pass: env.PASS,
  docroot: DOCROOT, hostkey: resolve(LOCAL, 'hostkey.txt'),
}];
if (env.MIRROR_HOST) {
  const h = env.MIRROR_HOST;
  targets.push({
    id: 'mirror', label: '鏡像', host: h, port: env.MIRROR_PORT || env.PORT || '22',
    user: env.MIRROR_USER || env.USER, pass: env.MIRROR_PASS || env.PASS,
    docroot: (env.MIRROR_DOCROOT || DOCROOT).replace(/\/+$/, ''),
    hostkey: resolve(LOCAL, `hostkey-${h}.txt`),
  });
}

for (const t of targets) {
  if (!existsSync(t.hostkey)) { console.error('缺少 ' + t.hostkey); process.exit(2); }
  const fp = readFileSync(t.hostkey, 'utf8').trim();
  const pw = resolve(LOCAL, `.pw-${t.id}.tmp`);
  writeFileSync(pw, t.pass + '\n', { mode: 0o600 });
  try {
    const remote = (script: string): string => {
      const f = resolve(LOCAL, `.remote-${t.id}.sh`);
      writeFileSync(f, script);
      try {
        return sh([PLINK, '-batch', '-ssh', '-P', t.port, '-l', t.user, '-hostkey', fp, '-pwfile', pw, '-m', f, t.host], `[${t.label}] ssh`);
      } finally { rmSync(f, { force: true }); }
    };
    console.log(`\n=== ${t.label} ===`);
    sh([PSCP, '-batch', '-P', t.port, '-hostkey', fp, '-pwfile', pw, MP,
      `${t.user}@${t.host}:${t.docroot}/adb/manifest.json.tmp`], `[${t.label}] 上傳 manifest.json`);
    const out = remote(`cd '${t.docroot}/adb' && chmod 644 manifest.json.tmp && mv -f manifest.json.tmp manifest.json && sha256sum manifest.json && grep -o '"file": "fuyan.adb"[^}]*' manifest.json | head -c 120`);
    console.log(out);
    // 線上抓回驗 sha
    const chk = remote(`sha256sum '${t.docroot}/adb/fuyan.adb'`);
    console.log(`[${t.label}] fuyan.adb 線上 sha：`, chk.split(/\s/)[0].slice(0, 16) + '…', chk.split(/\s/)[0] === SHA ? '✓' : '✗ 不符！');
  } finally {
    rmSync(pw, { force: true });
  }
}
console.log('\n完成');
