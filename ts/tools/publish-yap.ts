/**
 * 把 yap 的文章頁上傳到兩站（https://<host>/yap/）。
 *
 *   cd ts && bun run tools/publish-yap.ts            # 上傳 ＋ 線上驗證
 *   cd ts && bun run tools/publish-yap.ts --check    # 只驗線上，不上傳
 *   cd ts && bun run tools/publish-yap.ts --src D:\nissaya.cn\html\yap
 *
 * 來源（網站工作目錄，兩站共用同一份）：
 *   <src>/index.html        發表紀錄（會連到下面的系列）
 *   <src>/essays/*.html     系列索引與三篇文章（由 tools/make-essays.ts 產生）
 *   <src>/essays/essays.css
 *
 * 遠端目錄：DOCROOT 的上一層 ＋ /yap（例：/var/www/html/accelon26 → /var/www/html/yap）；
 * 也可以用 server.env 的 YAP_DOCROOT 覆寫。
 *
 * 帳密與主機金鑰沿用 .local/server.env／.local/hostkey*.txt（同 deploy.ts），不會印出來。
 * 上傳一律先寫 .tmp 再 mv。
 *
 * --clean-accelon26-essays：一次性的收拾工作——把先前誤放到 /accelon26/essays/ 的
 * 檔案刪掉（兩站），刪完確認 404。
 */
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const CLEAN = args.includes('--clean-accelon26-essays');
const SRC = resolve(opt('src', 'D:\\nissaya.cn\\html\\yap'));

function die(msg: string): never {
  console.error('✗ ' + msg);
  process.exit(1);
}

// ---- 憑證（同 deploy.ts） ----------------------------------------------------------
const envPath = resolve(LOCAL, 'server.env');
if (!existsSync(envPath)) die('找不到 ' + envPath);
const env: Record<string, string> = {};
for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
  if (m) env[m[1].toUpperCase()] = m[2].trim().replace(/^["']|["']$/g, '');
}
if (!env.HOST || !env.USER || !env.PASS) die('.local/server.env 的 HOST／USER／PASS 有空值');

const DOCROOT = (env.DOCROOT || '/var/www/html/accelon26').replace(/\/+$/, '');
const YAP_DOCROOT = (env.YAP_DOCROOT || DOCROOT.replace(/\/[^/]+$/, '') + '/yap').replace(/\/+$/, '');

interface Target {
  id: 'primary' | 'mirror';
  label: string;
  host: string;
  port: string;
  user: string;
  pass: string;
  docroot: string;
  base: string;      // https://<host>/accelon26/
  siteBase: string;  // https://<host>/yap/
  hostkeyFile: string;
}

const targets: Target[] = [{
  id: 'primary',
  label: '主站',
  host: env.HOST,
  port: env.PORT || '22',
  user: env.USER,
  pass: env.PASS,
  docroot: YAP_DOCROOT,
  base: (env.PRIMARY_URL || 'https://shutonggui.cn/accelon26/').replace(/\/+$/, '') + '/',
  siteBase: '',
  hostkeyFile: resolve(LOCAL, 'hostkey.txt'),
}];
if (env.MIRROR_HOST) {
  targets.push({
    id: 'mirror',
    label: '鏡像',
    host: env.MIRROR_HOST,
    port: env.MIRROR_PORT || env.PORT || '22',
    user: env.MIRROR_USER || env.USER,
    pass: env.MIRROR_PASS || env.PASS,
    docroot: YAP_DOCROOT,
    base: (env.MIRROR_URL || `https://${env.MIRROR_HOST}/accelon26/`).replace(/\/+$/, '') + '/',
    siteBase: '',
    hostkeyFile: resolve(LOCAL, `hostkey-${env.MIRROR_HOST}.txt`),
  });
}
for (const t of targets) t.siteBase = new URL(t.base).origin + '/yap/';

// ---- 主機金鑰 ---------------------------------------------------------------------
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
  const tmp = resolve(LOCAL, `.keyscan-yap-${t.id}.tmp`);
  writeFileSync(tmp, raw);
  const fpr = Bun.spawnSync({ cmd: [SSH_KEYGEN, '-lf', tmp], stdout: 'pipe', stderr: 'pipe' });
  rmSync(tmp, { force: true });
  const m = /(SHA256:[A-Za-z0-9+/=]+)/.exec(new TextDecoder().decode(fpr.stdout));
  if (!m) die('算不出 ' + t.host + ' 的主機金鑰指紋');
  writeFileSync(t.hostkeyFile, m[1] + '\n');
  return m[1];
}

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

const RUN_ID = process.pid;
function makeTransport(t: Target) {
  const fingerprint = hostFingerprint(t);
  const pwFile = resolve(LOCAL, `.pw-yap-${t.id}-${RUN_ID}.tmp`);
  writeFileSync(pwFile, t.pass + '\n', { mode: 0o600 });
  const upload = (localPath: string, remotePath: string): void => {
    sh([PSCP, '-batch', '-P', t.port, '-hostkey', fingerprint, '-pwfile', pwFile, localPath,
      t.user + '@' + t.host + ':' + remotePath], `[${t.label}] 上傳 ${remotePath}`);
  };
  const remote = (script: string, label: string): string => {
    const f = resolve(LOCAL, `.remote-yap-${t.id}-${RUN_ID}.sh`);
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

// ---- 要上傳的檔案 -----------------------------------------------------------------
const essaysDir = resolve(SRC, 'essays');
if (!existsSync(resolve(SRC, 'index.html'))) die('找不到 ' + resolve(SRC, 'index.html'));
if (!existsSync(essaysDir)) die('找不到 ' + essaysDir + '（先跑 tools/make-essays.ts）');
const essayFiles = readdirSync(essaysDir).filter((n) => /\.(html|css)$/.test(n)).sort();
if (!essayFiles.includes('index.html')) die(essaysDir + ' 沒有 index.html');
console.log(`來源：${SRC}（index.html ＋ essays/ ${essayFiles.length} 個檔）`);
console.log(`遠端：${targets.map((t) => t.docroot).join('、')}`);

const sha = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex');

// ---- 上傳 -------------------------------------------------------------------------
const failures: string[] = [];
for (const t of targets) {
  if (CHECK_ONLY) continue;
  let tr: ReturnType<typeof makeTransport> | null = null;
  try {
    tr = makeTransport(t);
    tr.remote(`mkdir -p '${t.docroot}/essays'`, '建立 yap/essays/');
    tr.upload(resolve(SRC, 'index.html'), t.docroot + '/index.html.tmp');
    tr.remote(`cd '${t.docroot}' && chmod 644 index.html.tmp && mv -f index.html.tmp index.html`, '換上 yap/index.html');
    for (const name of essayFiles) {
      tr.upload(resolve(essaysDir, name), t.docroot + '/essays/' + name + '.tmp');
      tr.remote(`cd '${t.docroot}/essays' && chmod 644 '${name}.tmp' && mv -f '${name}.tmp' '${name}'`, '換上 yap/essays/' + name);
    }
    console.log(`[${t.label}] yap 已上傳（index.html ＋ ${essayFiles.length} 個檔）`);
    if (CLEAN) {
      tr.remote(`rm -rf '${DOCROOT}/essays'`, '移除 /accelon26/essays（先前放錯的位置）');
      console.log(`[${t.label}] /accelon26/essays 已移除`);
    }
  } catch (e) {
    failures.push(t.label + '：' + String((e as Error)?.message ?? e));
  } finally {
    tr?.done();
  }
}

// ---- 線上驗證 ---------------------------------------------------------------------
for (const t of targets) {
  try {
    const want = new Map<string, string>();
    want.set('index.html', sha(resolve(SRC, 'index.html')));
    for (const n of essayFiles) want.set('essays/' + n, sha(resolve(essaysDir, n)));
    for (const [rel, hash] of want) {
      const r = await fetch(t.siteBase + rel, { headers: { 'cache-control': 'no-cache' } });
      if (!r.ok) throw new Error(t.siteBase + rel + ' 讀不到（HTTP ' + r.status + '）');
      const got = createHash('sha256').update(new Uint8Array(await r.arrayBuffer())).digest('hex');
      if (got !== hash) throw new Error(t.siteBase + rel + ' 內容與本機不同（' + got.slice(0, 8) + '…）');
    }
    if (CLEAN) {
      const gone = await fetch(t.base + 'essays/', { headers: { 'cache-control': 'no-cache' } });
      if (gone.ok) throw new Error(t.base + 'essays/ 還在（HTTP ' + gone.status + '）');
      console.log(`[${t.label}] ✓ 舊位置 /accelon26/essays/ 已 404`);
    }
    console.log(`[${t.label}] ✓ yap ${want.size} 個檔案都在線上、內容一致`);
  } catch (e) {
    failures.push(t.label + ' 驗證：' + String((e as Error)?.message ?? e));
  }
}

if (failures.length) {
  console.error('\n✗ 有問題：');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('\n已同步：' + targets.map((t) => t.siteBase).join('、'));
