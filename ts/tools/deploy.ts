/**
 * 部署到兩個站（作者 2026-10-29）：
 *   * 主站 https://shutonggui.cn/accelon26/（大陸）
 *   * 鏡像 https://nissaya.cn/accelon26/（境外）
 *
 *   cd ts && bun run tools/deploy.ts                # exe ＋ versions.json（兩站）
 *   cd ts && bun run tools/deploy.ts --site         # 另外上傳 www/（首頁、圖片、7z、公開數據庫頁）
 *   cd ts && bun run tools/deploy.ts --site-only    # 只換 www/，完全不碰 exe／versions.json
 *   cd ts && bun run tools/deploy.ts --check        # 只驗線上，不上傳
 *   cd ts && bun run tools/deploy.ts --mirror-only  # 只做鏡像站（--primary-only 只做主站）
 *
 * 為什麼要兩個站：大陸使用者一般連不到 nissaya.cn；海外使用者連 nissaya.cn 比較快。
 * 程式會探測兩站並讓使用者選（見 ts/src/accelon26/mirror.ts），所以兩邊的 versions.json
 * 要各自指向自己的 exe（鏡像的 `url` 不能指回主站）。
 *
 * 帳密從 `.local/server.env` 讀（`.local/` 在 .gitignore，內容不會被印出來）：
 *   HOST/PORT/USER/PASS/DOCROOT          主站
 *   MIRROR_HOST（選用；有才部署鏡像）     鏡像站
 *   MIRROR_PORT/MIRROR_USER/MIRROR_PASS/MIRROR_DOCROOT  沒填就沿用上面的
 * 主機金鑰指紋分別存在 `.local/hostkey-<host>.txt`（主站也接受舊的 `.local/hostkey.txt`）。
 *
 * 上傳一律先寫 `.tmp` 再 `mv`（同一個檔案系統，原子替換），所以任何時刻讀者抓到的
 * 都是完整的一份。順序：先 exe／7z，後 versions.json。
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
const SITE_ONLY = args.includes('--site-only');
const MIRROR_ONLY = args.includes('--mirror-only');
const PRIMARY_ONLY = args.includes('--primary-only');
const SITE = WITH_SITE || SITE_ONLY;
if (MIRROR_ONLY && PRIMARY_ONLY) {
  console.error('✗ --mirror-only 與 --primary-only 不能同時用');
  process.exit(2);
}

interface Target {
  id: 'primary' | 'mirror';
  label: string;
  host: string;
  port: string;
  user: string;
  pass: string;
  docroot: string;
  base: string;
  hostkeyFile: string;
}

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
if (!env.HOST || !env.USER || !env.PASS) die('.local/server.env 的 HOST／USER／PASS 有空值');

const DOCROOT = (env.DOCROOT || '/var/www/html/accelon26').replace(/\/+$/, '');
const targets: Target[] = [{
  id: 'primary',
  label: '主站',
  host: env.HOST,
  port: env.PORT || '22',
  user: env.USER,
  pass: env.PASS,
  docroot: DOCROOT,
  base: (env.PRIMARY_URL || 'https://shutonggui.cn/accelon26/').replace(/\/+$/, '') + '/',
  hostkeyFile: resolve(LOCAL, 'hostkey.txt'),
}];
if (env.MIRROR_HOST) {
  const mhost = env.MIRROR_HOST;
  targets.push({
    id: 'mirror',
    label: '鏡像',
    host: mhost,
    port: env.MIRROR_PORT || env.PORT || '22',
    user: env.MIRROR_USER || env.USER,
    pass: env.MIRROR_PASS || env.PASS,
    docroot: (env.MIRROR_DOCROOT || DOCROOT).replace(/\/+$/, ''),
    base: (env.MIRROR_URL || `https://${mhost}/accelon26/`).replace(/\/+$/, '') + '/',
    hostkeyFile: resolve(LOCAL, `hostkey-${mhost}.txt`),
  });
}
const chosen = targets.filter((t) => (MIRROR_ONLY ? t.id === 'mirror' : PRIMARY_ONLY ? t.id === 'primary' : true));
if (!chosen.length) die(MIRROR_ONLY ? 'server.env 沒有 MIRROR_HOST，不能 --mirror-only' : '沒有可部署的站');

// ---- 主機金鑰：第一次用 ssh-keyscan 取得並記下來，之後固定比對 -------------------
function hostFingerprint(t: Target): string {
  for (const p of [t.hostkeyFile, ...(t.id === 'primary' ? [resolve(LOCAL, 'hostkey.txt')] : [])]) {
    if (existsSync(p)) {
      const s = readFileSync(p, 'utf8').trim();
      if (s) return s;
    }
  }
  const scan = Bun.spawnSync({ cmd: [SSH_KEYSCAN, '-t', 'ed25519', '-p', t.port, t.host], stdout: 'pipe', stderr: 'pipe' });
  const raw = new TextDecoder().decode(scan.stdout);
  if (!raw.trim()) die(`ssh-keyscan 沒有回應（${t.host}）`);
  const tmp = resolve(LOCAL, `.keyscan-${t.id}.tmp`);
  writeFileSync(tmp, raw);
  const fpr = Bun.spawnSync({ cmd: [SSH_KEYGEN, '-lf', tmp], stdout: 'pipe', stderr: 'pipe' });
  rmSync(tmp, { force: true });
  const m = /(SHA256:[A-Za-z0-9+/=]+)/.exec(new TextDecoder().decode(fpr.stdout));
  if (!m) die('算不出 ' + t.host + ' 的主機金鑰指紋');
  writeFileSync(t.hostkeyFile, m[1] + '\n');
  console.log(`（第一次連 ${t.host}：主機金鑰指紋 ${m[1]} 已記到 ${t.hostkeyFile.replace(ROOT + '\\', '')}）`);
  return m[1];
}

// ---- 共用工具 ------------------------------------------------------------------
function sh(cmd: string[], label: string): string {
  const r = Bun.spawnSync({ cmd, stdout: 'pipe', stderr: 'pipe' });
  const out = new TextDecoder().decode(r.stdout).trim();
  const err = new TextDecoder().decode(r.stderr).trim();
  if (r.exitCode !== 0) {
    console.error('✗ ' + label + '（exit ' + r.exitCode + '）');
    if (out) console.error(out);
    if (err) console.error(err);
    throw new Error(label);
  }
  return out;
}

function makeTransport(t: Target) {
  const fingerprint = hostFingerprint(t);
  const pwFile = resolve(LOCAL, `.pw-${t.id}.tmp`);
  writeFileSync(pwFile, t.pass + '\n', { mode: 0o600 });
  const upload = (localPath: string, remotePath: string): void => {
    sh([PSCP, '-batch', '-P', t.port, '-hostkey', fingerprint, '-pwfile', pwFile, localPath,
      t.user + '@' + t.host + ':' + remotePath], `[${t.label}] 上傳 ${remotePath}`);
  };
  const remote = (script: string, label: string): string => {
    const f = resolve(LOCAL, `.remote-${t.id}.sh`);
    writeFileSync(f, script);
    try {
      return sh([PLINK, '-batch', '-ssh', '-P', t.port, '-l', t.user, '-hostkey', fingerprint,
        '-pwfile', pwFile, '-m', f, t.host], `[${t.label}] ${label}`);
    } finally {
      rmSync(f, { force: true });
    }
  };
  const done = (): void => { rmSync(pwFile, { force: true }); };
  return { upload, remote, done };
}

const fileSha = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex');

// ---- 本地檔案 -------------------------------------------------------------------
const EXE = resolve(opt('exe', resolve(ROOT, 'accelon3', 'accelon26.exe')));
const MANIFEST = resolve(opt('manifest', resolve(ROOT, 'accelon3', 'versions.json')));
let manifest: { buildTime: string; url: string; size: number; sha256: string } | null = null;
if (!SITE_ONLY) {
  if (!existsSync(MANIFEST)) die('找不到 ' + MANIFEST + '（先跑 tools/release.ts）');
  manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as { buildTime: string; url: string; size: number; sha256: string };
  if (!existsSync(EXE)) die('找不到 ' + EXE);
  const exeSize = statSync(EXE).size;
  const exeSha = fileSha(EXE);
  if (exeSize !== manifest.size || exeSha.toLowerCase() !== manifest.sha256.toLowerCase()) {
    die('exe 與 versions.json 不一致（exe ' + exeSize + ' bytes／' + exeSha.slice(0, 12) + '…，' +
      'manifest ' + manifest.size + ' bytes／' + String(manifest.sha256).slice(0, 12) + '…）→ 重跑 release.ts');
  }
  console.log('本地檔案：exe ' + (exeSize / 1048576).toFixed(1) + ' MiB、sha256 ' + exeSha.slice(0, 12) + '…、build ' + manifest.buildTime);
}

/** 每一個站自己的 versions.json：下載網址要指向自己（鏡像的 url 不能指回主站）。 */
function manifestFor(t: Target): string {
  const m = { ...manifest!, url: t.base + 'accelon26.exe' };
  const path = resolve(LOCAL, `.versions-${t.id}.json`);
  writeFileSync(path, JSON.stringify(m, null, 2) + '\n');
  return path;
}

// ---- 官網（所有站一樣的檔案） ----------------------------------------------------
function siteNames(): string[] {
  const siteDir = resolve(ROOT, 'www');
  return readdirSync(siteDir).filter((n) => n.endsWith('.html') || n.endsWith('.zip') || n.endsWith('.json')).sort();
}
/** www/releases/*.zip：歷史版本；只補站上沒有的（比大小），不重新上傳整批。 */
function releaseNames(): string[] {
  const dir = resolve(ROOT, 'www', 'releases');
  return existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.zip')).sort() : [];
}

function adbNames(): string[] {
  const dir = resolve(ROOT, 'www', 'adb');
  return existsSync(dir)
    ? readdirSync(dir).filter((n) => n.endsWith('.html') || n.endsWith('.txt') || n.endsWith('.json')).sort()
    : [];
}

if (SITE && !CHECK_ONLY) {
  for (const tool of ['make-changelog.ts', 'make-releases.ts']) {
    const gen = Bun.spawnSync({ cmd: ['bun', 'run', 'tools/' + tool], cwd: resolve(ROOT, 'ts'), stdout: 'inherit', stderr: 'inherit' });
    if (gen.exitCode !== 0) die(tool + ' 產生失敗');
  }
  // manifest 與公開數據庫頁一起重生：施工中／下架狀態才不會和 index.txt 脫節。
  for (const argv of [['tools/make-adb-manifest.ts'], ['tools/make-adb-index.ts', '--index', resolve(ROOT, 'www/adb/index.txt')]]) {
    const gen = Bun.spawnSync({ cmd: ['bun', 'run', ...argv], cwd: resolve(ROOT, 'ts'), stdout: 'inherit', stderr: 'inherit' });
    if (gen.exitCode !== 0) die(argv[0] + ' 產生失敗');
  }
}

// ---- 每一個站 -------------------------------------------------------------------
const failures: string[] = [];

async function deployTarget(t: Target): Promise<void> {
  let tr: ReturnType<typeof makeTransport> | null = null;
  try {
    tr = CHECK_ONLY ? null : makeTransport(t);
    if (!CHECK_ONLY && !SITE_ONLY) {
      const m = manifest!;
      tr!.upload(EXE, t.docroot + '/accelon26.exe.tmp');
      tr!.remote(`cd '${t.docroot}' && chmod 644 'accelon26.exe.tmp' && [ -f accelon26.exe ] && cp -f accelon26.exe accelon26.exe.prev; mv -f 'accelon26.exe.tmp' 'accelon26.exe' && ls -l accelon26.exe`, '換上新的 exe');
      console.log(`[${t.label}] exe 已就位 build ${m.buildTime}`);
      const localManifest = manifestFor(t);
      tr!.upload(localManifest, t.docroot + '/versions.json.tmp');
      const out = tr!.remote(`cd '${t.docroot}' && chmod 644 'versions.json.tmp' && [ -f versions.json ] && cp -f versions.json versions.json.prev; mv -f 'versions.json.tmp' versions.json && cat versions.json`, '換上新的 versions.json');
      console.log(`[${t.label}] versions.json → ${(JSON.parse(out) as { url?: string }).url}`);
    }
    if (SITE) {
      const siteDir = resolve(ROOT, 'www');
      for (const name of siteNames()) {
        tr!.upload(resolve(siteDir, name), t.docroot + '/' + name + '.tmp');
        tr!.remote(`cd '${t.docroot}' && chmod 644 '${name}.tmp' && mv -f '${name}.tmp' '${name}'`, '換上 ' + name);
      }
      const img = resolve(siteDir, 'img');
      if (existsSync(img)) {
        tr!.remote(`cd '${t.docroot}' && mkdir -p img`, '建立 img/ 目錄');
        sh([PSCP, '-batch', '-r', '-P', t.port, '-hostkey', hostFingerprint(t), '-pwfile', resolve(LOCAL, `.pw-${t.id}.tmp`),
          img, t.user + '@' + t.host + ':' + t.docroot + '/'], `[${t.label}] 上傳 www/img/`);
      }
      // 歷史 release ZIP：只上傳站上沒有的（同一天重發會覆蓋同名檔）
      const relDir = resolve(ROOT, 'www', 'releases');
      if (existsSync(relDir)) {
        tr!.remote(`cd '${t.docroot}' && mkdir -p releases`, '建立 releases/ 目錄');
        for (const name of releaseNames()) {
          const local = resolve(relDir, name);
          const want = statSync(local).size;
          const listed = tr!.remote(`stat -c %s '${t.docroot}/releases/${name}' 2>/dev/null || echo 0`, '查 releases/' + name).trim();
          const have = Number(listed.split(/\r?\n/).pop() || 0);
          if (have === want) { console.log(`[${t.label}] releases/${name} 已在線上，跳過`); continue; }
          tr!.upload(local, t.docroot + '/releases/' + name + '.tmp');
          tr!.remote(`cd '${t.docroot}/releases' && chmod 644 '${name}.tmp' && mv -f '${name}.tmp' '${name}'`, '換上 releases/' + name);
          console.log(`[${t.label}] releases/${name} 已上傳`);
        }
      }
      const adbDir = resolve(ROOT, 'www', 'adb');
      if (existsSync(adbDir)) {
        tr!.remote(`cd '${t.docroot}' && mkdir -p adb`, '建立 adb/ 目錄');
        for (const name of adbNames()) {
          tr!.upload(resolve(adbDir, name), t.docroot + '/adb/' + name + '.tmp');
          tr!.remote(`cd '${t.docroot}/adb' && chmod 644 '${name}.tmp' && mv -f '${name}.tmp' '${name}'`, '換上 adb/' + name);
        }
      }
      console.log(`[${t.label}] 官網已上傳`);
    }
  } catch (e) {
    failures.push(t.label + '：' + String((e as Error)?.message ?? e));
  } finally {
    tr?.done();
  }
}

// ---- 驗證：從真正的網址抓回來比對 ------------------------------------------------
async function verifyTarget(t: Target): Promise<void> {
  if (SITE_ONLY) {
    const urls: string[] = siteNames();
    for (const n of adbNames()) urls.push('adb/' + n);
    for (const n of releaseNames()) urls.push('releases/' + n);
    for (const u of urls) {
      const r = await fetch(t.base + u, { method: 'HEAD', headers: { 'cache-control': 'no-cache' } });
      if (!r.ok) throw new Error(t.base + u + ' 讀不到（HTTP ' + r.status + '）');
    }
    console.log(`[${t.label}] ✓ 官網 ${urls.length} 個檔案都在線上`);
    return;
  }
  const mres = await fetch(t.base + 'versions.json', { headers: { 'cache-control': 'no-cache' } });
  if (!mres.ok) throw new Error(t.base + 'versions.json 讀不到（HTTP ' + mres.status + '）');
  const online = await mres.json() as { buildTime?: string; sha256?: string; size?: number; url?: string };
  if (String(online.sha256 ?? '').toLowerCase() !== manifest!.sha256.toLowerCase()) {
    throw new Error(t.base + 'versions.json 不是這一版（sha256 ' + String(online.sha256).slice(0, 12) + '…）');
  }
  if (online.url && !online.url.startsWith(t.base)) {
    throw new Error(t.base + 'versions.json 的下載網址指到別站：' + online.url);
  }
  const eres = await fetch(t.base + 'accelon26.exe', { headers: { 'cache-control': 'no-cache' } });
  if (!eres.ok) throw new Error(t.base + 'accelon26.exe 讀不到（HTTP ' + eres.status + '）');
  const buf = new Uint8Array(await eres.arrayBuffer());
  const got = createHash('sha256').update(buf).digest('hex');
  if (got.toLowerCase() !== manifest!.sha256.toLowerCase()) {
    throw new Error(t.base + 'exe 與 versions.json 不符（' + buf.byteLength + ' bytes，sha256 ' + got.slice(0, 12) + '…）');
  }
  console.log(`[${t.label}] ✓ versions.json 與 exe 都是 build ${online.buildTime}（${(buf.byteLength / 1048576).toFixed(1)} MiB，sha256 ${got.slice(0, 12)}…）`);
}

// ---- 主流程 --------------------------------------------------------------------
if (!CHECK_ONLY) {
  for (const t of chosen) await deployTarget(t);
  for (const t of chosen) rmSync(resolve(LOCAL, `.versions-${t.id}.json`), { force: true });
}
console.log('\n驗證線上…');
for (const t of chosen) {
  try { await verifyTarget(t); } catch (e) { failures.push(t.label + ' 驗證：' + String((e as Error)?.message ?? e)); }
}
if (failures.length) {
  console.error('\n✗ 有問題：');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log(CHECK_ONLY
  ? `\n線上都正常（--check：沒有上傳任何東西）。`
  : `\n已同步：${chosen.map((t) => t.base).join('、')}`);
