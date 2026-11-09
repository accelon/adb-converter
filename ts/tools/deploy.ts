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
 *   cd ts && bun run tools/deploy.ts --site --no-adb  # 只發桌面版，不重生 adb manifest／公開頁
 *   cd ts && bun run tools/deploy.ts --check-adb     # 只比對站上 adb 與 manifest 的 sha256
 *   cd ts && bun run tools/deploy.ts --site --allow-adb-mismatch  # 明知不一致仍先上傳（少用）
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
// 只發桌面版、沒有要更新 adb：跳過 manifest／公開數據庫頁的重生，
// 免得把還沒上傳的新 adb（ys／taisho…）寫進站上的 manifest。
const NO_ADB = args.includes('--no-adb');
const CHECK_ADB = args.includes('--check-adb');
const ALLOW_ADB_MISMATCH = args.includes('--allow-adb-mismatch');
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

/** 每次執行獨立的暫存檔名：兩個部署同時跑時，才不會互相刪掉別人的密碼檔（2026-11-01） */
const RUN_ID = process.pid;
const pwPath = (t: Target): string => resolve(LOCAL, `.pw-${t.id}-${RUN_ID}.tmp`);

function makeTransport(t: Target) {
  const fingerprint = hostFingerprint(t);
  const pwFile = pwPath(t);
  writeFileSync(pwFile, t.pass + '\n', { mode: 0o600 });
  const upload = (localPath: string, remotePath: string): void => {
    sh([PSCP, '-batch', '-P', t.port, '-hostkey', fingerprint, '-pwfile', pwFile, localPath,
      t.user + '@' + t.host + ':' + remotePath], `[${t.label}] 上傳 ${remotePath}`);
  };
  const remote = (script: string, label: string): string => {
    const f = resolve(LOCAL, `.remote-${t.id}-${RUN_ID}.sh`);
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

// ---- 站上 adb 本體與 manifest 的一致性（作者 2026-11-09）------------------------
//
// 為什麼要有：taisho.adb（331 MB）、wxzj.adb（245 MB）要 publish-adb 加 --allow-large
// 才會上傳，沒加就靜默跳過；manifest 卻照樣從本機重生。結果站上是舊檔、manifest 是新檔，
// 使用者下載後 sha 對不上、更新失敗（2026-11-09 實際發生）。
// 這裡用遠端 sha256sum 比對，不必把幾百 MB 抓下來。

interface AdbManifestDb { file: string; sha256: string; size: number }

function readAdbManifest(): AdbManifestDb[] {
  const p = resolve(ROOT, 'www/adb/manifest.json');
  if (!existsSync(p)) return [];
  try {
    const m = JSON.parse(readFileSync(p, 'utf8')) as { dbs?: Array<{ file?: string; sha256?: string; size?: number }> };
    return (m.dbs ?? [])
      .filter((d) => d.file && d.sha256)
      .map((d) => ({ file: d.file!, sha256: d.sha256!, size: d.size ?? 0 }));
  } catch {
    return [];
  }
}

/** 回傳「站上 adb 與 manifest 不一致」的說明（空陣列＝都一致）。 */
function adbShaProblems(tr: ReturnType<typeof makeTransport>, t: Target, dbs: AdbManifestDb[]): string[] {
  if (!dbs.length) return [];
  const names = dbs.map((d) => `'${d.file}'`).join(' ');
  let listing = '';
  try {
    listing = tr.remote(`cd '${t.docroot}/adb' 2>/dev/null && sha256sum ${names} 2>&1 || true`, '比對站上 adb sha256');
  } catch (e) {
    return ['讀不到站上 adb：' + String((e as Error)?.message ?? e)];
  }
  const online = new Map<string, string>();
  for (const line of listing.split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim());
    if (m) online.set(m[2].trim(), m[1].toLowerCase());
  }
  const problems: string[] = [];
  for (const d of dbs) {
    const got = online.get(d.file);
    const want = d.sha256.toLowerCase();
    if (!got) problems.push(`${d.file}：站上沒有這個檔（manifest 有列）`);
    else if (got !== want) problems.push(`${d.file}：站上 ${got.slice(0, 12)}… ≠ manifest ${want.slice(0, 12)}…（${d.size} bytes）`);
  }
  return problems;
}

/** 對一個站做一致性檢查（自己的連線與清理）。 */
function checkAdbOn(t: Target, dbs: AdbManifestDb[]): { label: string; problems: string[] } {
  const tr = makeTransport(t);
  try {
    return { label: t.label, problems: adbShaProblems(tr, t, dbs) };
  } finally {
    tr.done();
  }
}

if (CHECK_ADB) {
  const dbs = readAdbManifest();
  if (!dbs.length) die('讀不到 www/adb/manifest.json 的 dbs');
  let bad = 0;
  for (const t of chosen) {
    const { label, problems } = checkAdbOn(t, dbs);
    if (!problems.length) { console.log(`[${label}] ✓ ${dbs.length} 個 adb 都與 manifest 一致`); continue; }
    bad += problems.length;
    console.error(`[${label}] ✗ 有 ${problems.length} 個不一致：`);
    for (const p of problems) console.error('  - ' + p);
  }
  if (bad) {
    console.error('\n先跑：bun run tools/publish-adb.ts --files <檔名> --allow-large');
    process.exit(1);
  }
  console.log(`\n✓ ${dbs.length} 個 adb 在 ${chosen.length} 個站都與 manifest 一致`);
  process.exit(0);
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
/** 頂層頁面／清單。ZIP 另外處理：站上同大小就不重傳（發佈 ZIP 不該被順手覆蓋）。 */
function siteNames(): string[] {
  const siteDir = resolve(ROOT, 'www');
  return readdirSync(siteDir).filter((n) => n.endsWith('.html') || n.endsWith('.json')).sort();
}
function siteZipNames(): string[] {
  const siteDir = resolve(ROOT, 'www');
  return readdirSync(siteDir).filter((n) => n.endsWith('.zip')).sort();
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

/** 文章頁在 /yap/（作者發表紀錄），不在 www/：由 tools/publish-yap.ts 上傳。 */

// 改版說明（changelog）與歷史版本頁（releases）**一定要重生**：它們是桌面版發布的一部分。
// 以前這一整段被 `!NO_ADB` 綁住，`--no-adb`（只發桌面版、adb 由各工作區發）時就會漏掉，
// 線上 changelog 因此還停在上一版的時間（2026-11-02 實際踩過）。
if (SITE && !CHECK_ONLY) {
  for (const tool of ['make-changelog.ts', 'make-releases.ts']) {
    const gen = Bun.spawnSync({ cmd: ['bun', 'run', 'tools/' + tool], cwd: resolve(ROOT, 'ts'), stdout: 'inherit', stderr: 'inherit' });
    if (gen.exitCode !== 0) die(tool + ' 產生失敗');
  }
  // manifest 與公開數據庫頁：`--no-adb` 時不碰（adb 由各 adb 工作區自己部署）。
  if (!NO_ADB) {
    for (const argv of [['tools/make-adb-manifest.ts'], ['tools/make-adb-index.ts', '--index', resolve(ROOT, 'www/adb/index.txt')]]) {
      const gen = Bun.spawnSync({ cmd: ['bun', 'run', ...argv], cwd: resolve(ROOT, 'ts'), stdout: 'inherit', stderr: 'inherit' });
      if (gen.exitCode !== 0) die(argv[0] + ' 產生失敗');
    }
  }
}

// ---- 每一個站 -------------------------------------------------------------------
const failures: string[] = [];

async function deployTarget(t: Target): Promise<void> {
  let tr: ReturnType<typeof makeTransport> | null = null;
  try {
    tr = CHECK_ONLY ? null : makeTransport(t);
    // 上傳任何東西之前，先確認站上的 adb 本體就是 manifest 寫的那一份（作者 2026-11-09）。
    // 不一致就停：否則使用者下載後 sha 對不上，更新一定失敗。
    if (SITE && !NO_ADB && !CHECK_ONLY) {
      const dbs = readAdbManifest();
      const problems = adbShaProblems(tr!, t, dbs);
      if (problems.length) {
        const detail = problems.map((p) => '  - ' + p).join('\n');
        if (!ALLOW_ADB_MISMATCH) {
          throw new Error('站上 adb 與 manifest 不一致（使用者會下載到 sha 不符的檔）：\n' + detail
            + '\n先跑：bun run tools/publish-adb.ts --files <檔名> --allow-large');
        }
        console.error(`[${t.label}] ⚠ 站上 adb 與 manifest 不一致（--allow-adb-mismatch，先繼續）：\n` + detail);
      } else {
        console.log(`[${t.label}] adb 本體與 manifest 一致（${dbs.length} 個檔）`);
      }
    }
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
      // 頂層 ZIP（accelon26.zip）：大小一樣就不動，免得只是發文章卻把發佈檔重寫一次
      for (const name of siteZipNames()) {
        const local = resolve(siteDir, name);
        const want = statSync(local).size;
        const listed = tr!.remote(`stat -c %s '${t.docroot}/${name}' 2>/dev/null || echo 0`, '查 ' + name).trim();
        const have = Number(listed.split(/\r?\n/).pop() || 0);
        if (have === want) { console.log(`[${t.label}] ${name} 已在線上（同大小），跳過`); continue; }
        tr!.upload(local, t.docroot + '/' + name + '.tmp');
        tr!.remote(`cd '${t.docroot}' && chmod 644 '${name}.tmp' && mv -f '${name}.tmp' '${name}'`, '換上 ' + name);
      }
      const img = resolve(siteDir, 'img');
      if (existsSync(img)) {
        tr!.remote(`cd '${t.docroot}' && mkdir -p img`, '建立 img/ 目錄');
        sh([PSCP, '-batch', '-r', '-P', t.port, '-hostkey', hostFingerprint(t), '-pwfile', pwPath(t),
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
      // `--no-adb`：adb 由各 adb 工作區自己部署，這裡連 adb/ 頁面都不要上傳
      const adbDir = resolve(ROOT, 'www', 'adb');
      if (!NO_ADB && existsSync(adbDir)) {
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
    const urls: string[] = [...siteNames(), ...siteZipNames()];
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
  const eres = await fetch(t.base + 'accelon26.exe', { method: 'HEAD', headers: { 'cache-control': 'no-cache' } });
  if (!eres.ok) throw new Error(t.base + 'accelon26.exe 讀不到（HTTP ' + eres.status + '）');
  const headLen = Number(eres.headers.get('content-length') ?? 0);
  // 官網下行只有約 6 Mbit/s（作者 2026-11-09）：先不抓整顆 exe。
  // 用 HEAD 的 content-length ＋ 遠端 sha256sum 比對；對不上才下載回來算，
  // 這樣正常發佈少抓 2 × 21 MB，而且錯的時候仍有完整的下載診斷。
  let remoteSha = '';
  try {
    const tr = makeTransport(t);
    try {
      remoteSha = tr.remote(`cd '${t.docroot}' && sha256sum accelon26.exe`, '比對 exe sha256').trim().split(/\s+/)[0].toLowerCase();
    } finally {
      tr.done();
    }
  } catch { /* 沒有 SSH 就退回下載驗證 */ }
  if (headLen === manifest!.size && remoteSha === manifest!.sha256.toLowerCase()) {
    console.log(`[${t.label}] ✓ versions.json 與 exe 都是 build ${online.buildTime}（${(headLen / 1048576).toFixed(1)} MiB，sha256 ${remoteSha.slice(0, 12)}…；HEAD＋伺服器 sha256，未下載）`);
    return;
  }
  const eres2 = await fetch(t.base + 'accelon26.exe', { headers: { 'cache-control': 'no-cache' } });
  if (!eres2.ok) throw new Error(t.base + 'accelon26.exe 讀不到（HTTP ' + eres2.status + '）');
  const buf = new Uint8Array(await eres2.arrayBuffer());
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

