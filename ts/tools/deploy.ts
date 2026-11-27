/**
 * 部署到兩個站（作者 2026-10-29）：
 *   * 主站 https://shutonggui.cn/accelon26/（大陸）
 *   * 鏡像 https://nissaya.cn/accelon26/（境外）
 *
 *   cd ts && bun run tools/deploy.ts                # exe ＋ versions.json（兩站）
 *   cd ts && bun run tools/deploy.ts --site         # 另外上傳 www/（首頁、圖片、7z、研究用數據庫頁）
 *   cd ts && bun run tools/deploy.ts --site-only    # 只換 www/，完全不碰 exe／versions.json
 *   cd ts && bun run tools/deploy.ts --check        # 只驗線上，不上傳
 *   cd ts && bun run tools/deploy.ts --mirror-only  # 只做鏡像站（--primary-only 只做主站）
 *   cd ts && bun run tools/deploy.ts --site --no-adb  # 只發桌面版，不重生 adb manifest／公開頁
 *   cd ts && bun run tools/deploy.ts --check-adb     # 只比對站上 adb 與 manifest 的 sha256
 *   cd ts && bun run tools/deploy.ts --site --allow-adb-mismatch  # 明知不一致仍先上傳（少用）
 *
 * 海外慢線（作者 2026-11-25／2026-11-27）：**人在海外時，以下為預設**——
 *   cd ts && bun run tools/deploy.ts                 # 整組直推鏡像 nissaya＝發佈成功；
 *                                                    #   再請主站 shutonggui 從鏡像公網 curl 拉齊
 *                                                    #   （主站拉取失敗不翻發佈，只提示重試口令）
 *   cd ts && bun run tools/deploy.ts --no-primary    # 只推鏡像 nissaya，主站完全不碰
 *   cd ts && bun run tools/deploy.ts --pull-primary  # 事後只補「主站向鏡像拉齊」這一步
 *   cd ts && bun run tools/deploy.ts --push          # 人在對岸時：兩站都直推＋完整驗證（舊預設）
 *   cd ts && bun run tools/deploy.ts --setup-key     # 一次性：產生並裝好部署金鑰（rsync 前置）
 *   cd ts && bun run tools/deploy.ts --rsync         # 大檔改走 rsync：斷線可續傳／只傳差異
 *   cd ts && bun run tools/deploy.ts --pull-from https://中轉站/accelon26/  # 請伺服器 curl 來拉，
 *                                                    #   本機不再上傳；中轉站需與站上一樣的目錄結構
 *   cd ts && bun run tools/deploy.ts --cos           # 強制走騰訊雲 COS 中轉（見下方「COS 中轉」）
 *   cd ts && bun run tools/deploy.ts --no-cos        # 強制不走 COS（回到主站向鏡像公網拉齊）
 *   cd ts && bun run tools/deploy.ts --only adb/fuyan.html --rsync --primary-only  # 只精準換上
 *                                                    #   指定的 www/ 相對路徑（不重生／不碰 exe／adb 預檢）
 *   # rsync 需本機與站上都有 rsync；任一邊缺、或還沒 --setup-key，就自動逐檔退回 pscp。
 *   # --pull-from 對 versions.json 會把 url 改指各站自己；.adb 本體仍由 publish-adb.ts 管。
 *
 * COS 中轉（2026-11-27 量測後加入）：海外→廣州的公網上行只有 2～6 KB/s，而主站向鏡像
 * （境外機）公網 curl 也只有約 50 KB/s，所以發佈整包要 70～180 分鐘。實測比較：
 *   本機 → 廣州桶（全球加速域名 PUT）      20 MB ＝ 7.27 MB/s
 *   廣州機 → 同地域桶（169.254.*，內網 GET） 20 MB ＝ 87 MB/s、免費
 * 所以海外發佈改成：本機把「站上與本機不同」的檔 putObject 進桶 → 簽 15 分鐘的預簽名 GET
 * → 主站伺服端內網拉齊。站上不放任何憑證（只有短期簽名 URL），桶維持私有讀寫。
 * 憑證在 `.local/cos.env`（同 .gitignore，內容不印出）：COS_SECRET_ID／COS_SECRET_KEY（只給
 * COS 權限的子賬號密鑰）、COS_BUCKET、COS_REGION（預設 ap-guangzhou）。沒這檔就照舊走鏡像。
 * 位置自動判定：對主站做 TCP 連線計時，<120ms 視為人在國內 → 兩站直推、不碰 COS
 * （`--push` 強制直推、`--cos` 強制中轉、`--no-cos` 關閉自動）。
 * ⚠ 給桶加一條生命週期規則：`deploy/` 前綴 1 天後過期刪除（腳本只傳不刪，靠規則清理）。
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
// 只發桌面版、沒有要更新 adb：跳過 manifest／研究用數據庫頁的重生，
// 免得把還沒上傳的新 adb（ys／taisho…）寫進站上的 manifest。
const NO_ADB = args.includes('--no-adb');
const CHECK_ADB = args.includes('--check-adb');
const ALLOW_ADB_MISMATCH = args.includes('--allow-adb-mismatch');
// 海外慢線新增（作者 2026-11-25，皆為選配、不改變預設 pscp 路徑）：
//   --rsync            大檔（exe／zip）改用 rsync 傳輸：斷線可續傳、只傳差異。本機與伺服器
//                      都要有 rsync；任一邊缺就自動退回 pscp。建議先跑一次 --setup-key。
//   --setup-key        一次性：在本機產生 .local/deploy_ed25519 金鑰，並用現有密碼把公鑰裝到
//                      站上 ~/.ssh/authorized_keys（冪等，已存在就不重複加）。之後 rsync 走金鑰、
//                      免再寫密碼檔。
//   --pull-from <URL>  不在本機上傳，改成請伺服器用 curl 從公開中轉站「拉」同一組檔案
//                      （繞開你 overseas→國內的上行瓶頸）。中轉站需與站上同樣目錄結構。
//   --rsync-bin <路徑> 指定 rsync 執行檔（預設 PATH 上的 rsync）
//   --ssh-bin   <路徑> rsync 遠端 shell 用的 ssh（預設 PATH 上的 ssh）
//   --rsync                    大檔（exe／zip）嘗試走 rsync 斷線續傳；任一步失敗自動改 pscp 重傳。
//                              （註：本機 choco 版 cwRsync 在自動化／非互動環境下 spawn 會出
//                              dup()/cygwin-ssh 讀不到金鑰，實務上多半會退回 pscp。）
//   --pscp                     （保留）明確用 pscp；目前為預設。
const USE_RSYNC = args.includes('--rsync');
const SETUP_KEY = args.includes('--setup-key');
const RSYNC_BIN = opt('rsync-bin', 'rsync');
const SSH_BIN = opt('ssh-bin', 'ssh');
const PULL_FROM = opt('pull-from', '').replace(/\/+$/, '');
//   --only a/b.html,c.json   精準上傳（相對 www/ 的路徑，逗號分隔）：不重生 changelog/manifest/
//                            index、不碰 exe、不做 adb-sha 預檢——只把這些檔 .tmp→mv 原子換上。
//                            用於「只發 fuyan.html、不驚動別線未發布 adb」的單檔場景。
const ONLY = opt('only', '');
//   --probe                    診斷：對選定站點回報 rsync／curl／os（不上传、不重生）。
const PROBE = args.includes('--probe');
//   （海外模式，作者 2026-11-27 起預設）
//   預設＝鏡像 nissaya.cn 直推整組＋驗證通過＝發佈成功；主站 shutonggui.cn 從鏡像公網
//   伺服端 curl 拉齊（非致命，失敗只提示重試口令，不再從海外下載整包來比對）。
//   --push        放棄海外模式，回到舊「兩站都直推＋完整驗證」（人在對岸時用）。
//   --no-primary  只推鏡像，主站連拉都不做（之後另跑 --pull-primary）。
//   --pull-primary 只請主站從鏡像拉整組（補齊上次沒拉好的；不推鏡像）。
const PUSH_ALL = args.includes('--push');
const NO_PRIMARY = args.includes('--no-primary');
const PULL_PRIMARY = args.includes('--pull-primary');
//   --relay                    海外兩跳法：先把整組直推鏡像（nissaya，海外→海外快），核對鏡像每個
//                              檔都 == 本機 sha 後，再讓主站從鏡像 --pull-from 拉（伺服器端 curl，
//                              繞開你 overseas 的上行瓶頸）。核對不過就中止、不 pull（防倒退）。
const RELAY = args.includes('--relay');
//   --cos／--no-cos          主站拉齊那一步要不要走騰訊雲 COS 中轉（詳見檔案頭「COS 中轉」）。
//                            不加則自動：沒有 .local/cos.env 就不走；主站 TCP <120ms（人在國內）直推。
const COS_FORCE = args.includes('--cos');
const COS_OFF = args.includes('--no-cos');
const DEPLOY_KEY = resolve(LOCAL, 'deploy_ed25519');
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

// 本機 rsync 是否存在（探一次）。rsync 走金鑰免密碼，需先 --setup-key。
let _rsyncLocalChecked = false, _rsyncLocal = false;
function rsyncLocalOk(): boolean {
  if (!_rsyncLocalChecked) {
    try { _rsyncLocal = Bun.spawnSync({ cmd: [RSYNC_BIN, '--version'] }).exitCode === 0; } catch { _rsyncLocal = false; }
    _rsyncLocalChecked = true;
  }
  return _rsyncLocal;
}

function makeTransport(t: Target) {
  const fingerprint = hostFingerprint(t);
  const pwFile = pwPath(t);
  writeFileSync(pwFile, t.pass + '\n', { mode: 0o600 });

  const remote = (script: string, label: string): string => {
    const f = resolve(LOCAL, `.remote-${t.id}-${RUN_ID}.sh`);
    writeFileSync(f, script, { mode: 0o600 });  // COS 模式時檔內含 15 分鐘預簽名 URL，別留成全員可讀
    try {
      return sh([PLINK, '-batch', '-ssh', '-P', t.port, '-l', t.user, '-hostkey', fingerprint,
        '-pwfile', pwFile, '-m', f, t.host], `[${t.label}] ${label}`);
    } finally {
      rmSync(f, { force: true });
    }
  };

  const pscpUpload = (localPath: string, remotePath: string): void => {
    sh([PSCP, '-batch', '-P', t.port, '-hostkey', fingerprint, '-pwfile', pwFile, localPath,
      t.user + '@' + t.host + ':' + remotePath], `[${t.label}] 上傳 ${remotePath}`);
  };

  // rsync（選配 --rsync）：本機有 rsync ＋ 有部署金鑰 ＋ 站上有 rsync 才啟用；否則逐檔退回 pscp。
  let rsyncOn = false;
  if (USE_RSYNC) {
    if (!existsSync(DEPLOY_KEY)) console.error(`[${t.label}] ⚠ 還沒有部署金鑰（先跑 --setup-key）→ 這站用 pscp`);
    else if (!rsyncLocalOk()) console.error(`[${t.label}] ⚠ 本機找不到 rsync（${RSYNC_BIN}）→ 這站用 pscp`);
    else {
      try { rsyncOn = remote(`command -v rsync >/dev/null 2>&1 && echo YES || echo NO`, '探站上 rsync').trim().endsWith('YES'); } catch { rsyncOn = false; }
      if (!rsyncOn) console.error(`[${t.label}] ⚠ 站上沒有 rsync → 這站用 pscp`);
    }
  }
  const rsyncUpload = (localPath: string, remotePath: string): void => {
    const rsh = `${SSH_BIN} -i "${DEPLOY_KEY}" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -p ${t.port}`;
    sh([RSYNC_BIN, '-a', '--partial', '--info=progress2', '-z', '--timeout=180', '-e', rsh,
      localPath, `${t.user}@${t.host}:${remotePath}`], `[${t.label}] rsync 上傳 ${remotePath}`);
  };
  // 選 rsync 就嘗試；任一檔 rsync 失敗 → 立即退回 pscp 重傳該檔（絕不讓 --rsync 拖垮整次發佈）。
  const upload = (localPath: string, remotePath: string): void => {
    if (rsyncOn) {
      try { rsyncUpload(localPath, remotePath); return; }
      catch (e) { console.error(`[${t.label}] ⚠ rsync 失敗（${String((e as Error)?.message ?? e).split('\n')[0]}）→ 改用 pscp 重傳 ${remotePath}`); rsyncOn = false; }
    }
    pscpUpload(localPath, remotePath);
  };
  if (rsyncOn) console.log(`[${t.label}] 傳輸=rsync（斷線可續傳；失敗自動退 pscp）`);

  const done = (): void => { rmSync(pwFile, { force: true }); };
  return { upload, remote, done };
}

// ---- 部署金鑰（rsync 免密碼用）：本機產生一對，公鑰用現有密碼裝到站上 --------------
function ensureKeyPair(): void {
  if (existsSync(DEPLOY_KEY)) return;
  const SSH_KEYGEN = 'C:\\Program Files\\Git\\usr\\bin\\ssh-keygen.exe';
  if (!existsSync(SSH_KEYGEN)) die('找不到 ssh-keygen（' + SSH_KEYGEN + '）');
  sh([SSH_KEYGEN, '-t', 'ed25519', '-N', '', '-f', DEPLOY_KEY, '-C', 'accelon26-deploy'], '產生部署金鑰');
  console.log('已產生部署金鑰 ' + DEPLOY_KEY);
}
function installPubkey(t: Target): void {
  const pub = readFileSync(DEPLOY_KEY + '.pub', 'utf8').trim();
  const tr = makeTransport(t);
  try {
    tr.remote(
      `mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`
      + ` && grep -qxF '${pub}' ~/.ssh/authorized_keys || echo '${pub}' >> ~/.ssh/authorized_keys`,
      '裝公鑰 ' + t.host);
    console.log(`[${t.label}] 公鑰已在 ${t.user}@${t.host}（冪等，重複跑不會加兩次）`);
  } finally { tr.done(); }
}

// --setup-key：裝好金鑰就結束（rsync 的前置）。放在 makeTransport 之後，避開 const TDZ。
if (SETUP_KEY) {
  ensureKeyPair();
  for (const t of chosen) installPubkey(t);
  console.log('\n部署金鑰已裝到：' + chosen.map((t) => t.host).join('、'));
  console.log('之後上傳加 --rsync 即可斷線續傳／只傳差異（缺 rsync 的站會自動退回 pscp）。');
  process.exit(0);
}

// --probe：只診斷站上有沒有 rsync／curl、OS，不上傳。
if (PROBE) {
  for (const t of chosen) {
    const tr = makeTransport(t);
    try {
      const out = tr.remote(
        `printf 'rsync='; (command -v rsync >/dev/null 2>&1 && rsync --version 2>/dev/null | head -1) || echo 'NO'; `
        + `printf 'curl='; (command -v curl >/dev/null 2>&1 && curl --version 2>/dev/null | head -1) || echo 'NO'; `
        + `printf 'os='; (head -1 /etc/os-release 2>/dev/null) || uname -a`,
        'probe ' + t.host);
      console.log(`\n[${t.label}] ${t.host}\n${out}`);
    } catch (e) { console.error(`[${t.label}] probe 失敗：` + String((e as Error)?.message ?? e)); }
    finally { tr.done(); }
  }
  process.exit(0);
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
if (!SITE_ONLY && !PULL_FROM && !ONLY) {
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

/** 發佈集裡某個相對路徑對應的本機檔。versions.json 各站 url 不同，要給站才解得出來
 *  （不給＝不參與逐檔雜湊比對，兩跳法就是靠這個跳過它）。缺檔回 null。 */
function localFileFor(rel: string, t?: Target): string | null {
  if (rel === 'accelon26.exe') return EXE;
  if (rel === 'versions.json') return t ? manifestFor(t) : null;
  const p = resolve(ROOT, 'www', rel);
  return existsSync(p) ? p : null;
}

/** 一次 SSH 取得站上一批檔案的 sha256（缺檔的列會被過濾掉）。 */
function remoteShaMap(tr: ReturnType<typeof makeTransport>, t: Target, rels: string[]): Map<string, string> {
  const map = new Map<string, string>();
  if (!rels.length) return map;
  const out = tr.remote(`cd '${t.docroot}' && sha256sum ${rels.map((r) => `'${r}'`).join(' ')} 2>&1 || true`, '站上 sha 核對');
  for (const line of out.split(/\r?\n/)) {
    const mm = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim());
    if (mm) map.set(mm[2].trim(), mm[1].toLowerCase());
  }
  return map;
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
if (SITE && !CHECK_ONLY && !PULL_FROM) {
  for (const tool of ['make-changelog.ts', 'make-releases.ts']) {
    const gen = Bun.spawnSync({ cmd: ['bun', 'run', 'tools/' + tool], cwd: resolve(ROOT, 'ts'), stdout: 'inherit', stderr: 'inherit' });
    if (gen.exitCode !== 0) die(tool + ' 產生失敗');
  }
  // manifest 與研究用數據庫頁：`--no-adb` 時不碰（adb 由各 adb 工作區自己部署）。
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
      const localManifest = manifestFor(t);
      // 站上已經是本版的 exe＋versions.json 就整段跳過：海外那條線每個檔案都要重傳一次太貴，
      // 而發佈常常只是補網頁、桌面版沒動（比對在站上算 sha，不下載）。
      const on = remoteShaMap(tr!, t, ['accelon26.exe', 'versions.json']);
      if (on.get('accelon26.exe') === fileSha(EXE).toLowerCase() && on.get('versions.json') === fileSha(localManifest).toLowerCase()) {
        console.log(`[${t.label}] exe 與 versions.json 已是本版（build ${m.buildTime}）→ 跳過上傳`);
      } else {
        tr!.upload(EXE, t.docroot + '/accelon26.exe.tmp');
        tr!.remote(`cd '${t.docroot}' && chmod 644 'accelon26.exe.tmp' && [ -f accelon26.exe ] && cp -f accelon26.exe accelon26.exe.prev; mv -f 'accelon26.exe.tmp' 'accelon26.exe' && ls -l accelon26.exe`, '換上新的 exe');
        console.log(`[${t.label}] exe 已就位 build ${m.buildTime}`);
        tr!.upload(localManifest, t.docroot + '/versions.json.tmp');
        const out = tr!.remote(`cd '${t.docroot}' && chmod 644 'versions.json.tmp' && [ -f versions.json ] && cp -f versions.json versions.json.prev; mv -f 'versions.json.tmp' versions.json && cat versions.json`, '換上新的 versions.json');
        console.log(`[${t.label}] versions.json → ${(JSON.parse(out) as { url?: string }).url}`);
      }
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

// ---- 拉模式（--pull-from）：請伺服器用 curl 從公開中轉站抓，繞開本機 overseas 上行 ----
function pullRelList(): string[] {
  const rel: string[] = [];
  if (!SITE_ONLY) rel.push('accelon26.exe', 'versions.json');
  if (SITE) {
    for (const n of siteNames()) rel.push(n);
    for (const n of siteZipNames()) rel.push(n);
    for (const n of releaseNames()) rel.push('releases/' + n);
    if (!NO_ADB) for (const n of adbNames()) rel.push('adb/' + n);
  }
  return rel;
}
async function pullTarget(t: Target, base: string): Promise<void> {
  const baseU = base.replace(/\/+$/, '') + '/';
  const rel = pullRelList();
  console.log(`[${t.label}] 從中轉站拉 ${rel.length} 個檔（來源 ${baseU}）`);
  const tr = makeTransport(t);
  try {
    for (const r of rel) {
      const url = baseU + r;
      const tmp = `${t.docroot}/${r}.tmp`;
      const dst = `${t.docroot}/${r}`;
      // 原子替換：先 curl 到 .tmp，再 mv。versions.json 的 url 改指本站自己（鏡像不能指回中轉）。
      const steps = [
        `set -e`,
        `mkdir -p "$(dirname '${dst}')"`,
        `curl -fL --retry 3 --connect-timeout 20 -o '${tmp}' '${url}'`,
        `chmod 644 '${tmp}'`,
      ];
      if (r === 'versions.json') steps.push(`sed -i 's#"url"[[:space:]]*:[[:space:]]*"[^"]*"#"url": "${t.base}accelon26.exe"#' '${tmp}'`);
      steps.push(`mv -f '${tmp}' '${dst}'`);
      tr.remote(steps.join(' && '), '拉 ' + r);
      console.log(`[${t.label}] ← ${url}`);
    }
    console.log(`[${t.label}] 拉取完成`);
  } catch (e) {
    failures.push(t.label + '（pull）：' + String((e as Error)?.message ?? e));
  } finally { tr.done(); }
}

// ---- COS 中轉：本機經全球加速域名 putObject → 站上預簽名 GET 內網拉齊（2026-11-27）----
// 量測依據：海外→廣州公網上行 2～6 KB/s；本機→廣州桶（加速域名）7.27 MB/s；
// 廣州機→同地域桶（DNS 169.254.*.*，內網、免費）87 MB/s。站上只拿到 15 分鐘的簽名 URL，
// 不放任何密鑰。
interface CosCfg { put: any; get: any; bucket: string; region: string }

async function loadCos(): Promise<CosCfg | null> {
  const p = resolve(LOCAL, 'cos.env');
  if (!existsSync(p)) return COS_FORCE ? die('--cos 需要 ' + p + '（COS_SECRET_ID／COS_SECRET_KEY／COS_BUCKET）') : null;
  const e: Record<string, string> = {};
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m) e[m[1].toUpperCase()] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  if (!e.COS_SECRET_ID || !e.COS_SECRET_KEY || !e.COS_BUCKET) {
    if (COS_FORCE) die(p + ' 的 COS_SECRET_ID／COS_SECRET_KEY／COS_BUCKET 有空值');
    console.log('· .local/cos.env 不完整 → 主站改向鏡像公網拉齊');
    return null;
  }
  const COS = ((await import('cos-nodejs-sdk-v5')) as any).default;
  // 加速域名必須由 SDK 自己組 host 並配套簽名（UseAccelerate）；事後換域名會 SignatureDoesNotMatch。
  return {
    put: new COS({ SecretId: e.COS_SECRET_ID, SecretKey: e.COS_SECRET_KEY, UseAccelerate: true }),
    get: new COS({ SecretId: e.COS_SECRET_ID, SecretKey: e.COS_SECRET_KEY }),
    bucket: e.COS_BUCKET,
    region: e.COS_REGION || 'ap-guangzhou',
  };
}

/** 上傳一個本機檔到桶：先走分塊上傳（大檔不進記憶體），不行再整檔 putObject。 */
async function cosPut(cfg: CosCfg, key: string, file: string): Promise<void> {
  const base = { Bucket: cfg.bucket, Region: cfg.region, Key: key };
  try {
    await new Promise<void>((res, rej) => cfg.put.sliceUploadFile({ ...base, FilePath: file }, (e: unknown) => (e ? rej(e) : res())));
    return;
  } catch (e) {
    console.log('  · sliceUploadFile 失敗（' + JSON.stringify(e).slice(0, 160) + '）→ 改整檔 putObject');
  }
  await new Promise<void>((res, rej) => cfg.put.putObject({ ...base, Body: readFileSync(file) },
    (e: unknown) => (e ? rej(new Error('putObject ' + key + '：' + JSON.stringify(e).slice(0, 200))) : res())));
}

/** 站上下內網用的 15 分鐘預簽名 GET（普通廣州域名，站上解析到 169.254.*＝內網）。 */
function cosGetUrl(cfg: CosCfg, key: string): Promise<string> {
  return new Promise((res, rej) => cfg.get.getObjectUrl({ Bucket: cfg.bucket, Region: cfg.region, Key: key, Method: 'GET', Expires: 900, Sign: true },
    (e: unknown, d: { Url?: string } | undefined) => (e || !d?.Url) ? rej(new Error('COS 簽名失敗：' + JSON.stringify(e).slice(0, 200))) : res(d.Url)));
}

// 位置自動判定：主站 TCP 連線時間。實測馬來西亞→廣州 460～570ms、國內→國內 <40ms，取 120ms 為界。
let _near: boolean | null = null, _nearMs = 0;
async function primaryIsNear(t: Target): Promise<boolean> {
  if (_near !== null) return _near;
  for (const url of [t.base + 'versions.json', t.base]) {
    try {
      const p = Bun.spawn(['curl', '-s', '--noproxy', '*', '-r', '0-0', '-m', '10', '-o', '/dev/null',
        // 只要 time_connect（TCP 握手）；抓 1 byte 而不是 -I，避免 HEAD＋-o 的 write error
        '-w', '%{time_connect}', url], { stdout: 'pipe', stderr: 'ignore' });
      const ms = Number((await new Response(p.stdout).text()).trim()) * 1000;
      await p.exited;
      if (Number.isFinite(ms) && ms > 0) { _nearMs = ms; _near = ms < 120; return _near; }
    } catch { /* 換下一個 url 再試 */ }
  }
  console.log('· 探不到主站連線時間 → 依海外模式處理');
  _near = false;
  return false;
}

/** 這次該不該用 COS 中轉：--no-cos 關掉；--cos 強制；否則桶沒設或人在國內就不用。 */
async function cosFor(t: Target): Promise<CosCfg | null> {
  if (COS_OFF) return null;
  const cfg = await loadCos();
  if (!cfg) return null;
  if (!COS_FORCE && await primaryIsNear(t)) {
    console.log(`主站 ${t.host} TCP 連線 ${_nearMs.toFixed(0)}ms → 判定人在國內，直推不繞 COS`);
    return null;
  }
  return cfg;
}

/** 只把「站上與本機不同」的檔經桶換上主站；全一樣就整段跳過，一次 SSH 都不多花。
 *  回 false 代表這步沒做完（桶、站上 curl 或 sha 任一關卡出問題），呼叫端該退回向鏡像拉齊。 */
async function pullViaCos(t: Target, cfg: CosCfg): Promise<boolean> {
  const rel = pullRelList();
  const tr = makeTransport(t);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
  const made: string[] = [];
  let ok = true;
  try {
    const have = remoteShaMap(tr, t, rel.filter((r) => localFileFor(r, t) !== null));
    const todo: Array<[string, string]> = [];
    const want = new Map<string, string>();
    for (const r of rel) {
      const lp = localFileFor(r, t);
      if (!lp) { failures.push(`${t.label} ${r}：本機找不到對應檔案`); ok = false; continue; }
      const sha = fileSha(lp).toLowerCase();
      want.set(r, sha);
      if (have.get(r) === sha) continue;
      todo.push([r, lp]);
    }
    console.log(`[${t.label}] COS 中轉 ${cfg.bucket}：${rel.length} 檔中 ${todo.length} 檔需要更新` +
      (todo.length === rel.length ? '' : `（${rel.length - todo.length} 檔已是本版，跳過）`));
    if (!todo.length) return true;
    const urls = new Map<string, string>();
    const t0 = Date.now();
    let bytes = 0;
    for (const [r, lp] of todo) {
      const key = `deploy/${stamp}/${r}`;
      await cosPut(cfg, key, lp);
      made.push(key);
      urls.set(r, await cosGetUrl(cfg, key));
      bytes += statSync(lp).size;
      console.log(`  ↑ ${r}（${(statSync(lp).size / 1048576).toFixed(1)} MiB，累計 ${(bytes / 1048576).toFixed(1)} MiB）`);
    }
    const secs = (Date.now() - t0) / 1000;
    console.log(`  本機→廣州桶 ${cfg.region}（加速域名）：${(bytes / 1048576).toFixed(1)} MiB／${secs.toFixed(1)}s ≈ ${(bytes / 1048576 / secs).toFixed(2)} MB/s`);
    // 一個 SSH 批次拉完（海外→站上的 handshake 本身 0.5s，逐檔打太貴）；先 .tmp 再 mv，原子替換。
    const steps: string[] = ['set -e'];
    for (const [r] of todo) {
      const dst = `${t.docroot}/${r}`, tmp = `${dst}.cos.tmp`;
      steps.push(`mkdir -p "$(dirname '${dst}')"`, `curl -fsSL --retry 3 --connect-timeout 20 -m 600 -o '${tmp}' '${urls.get(r)}'`,
        `chmod 644 '${tmp}'`, `mv -f '${tmp}' '${dst}'`);
    }
    steps.push(`sha256sum ${todo.map(([r]) => `'${r}'`).join(' ')}`);
    const out = tr.remote(steps.join(' && '), 'COS 內網拉齊');
    const got = new Map<string, string>();
    for (const line of out.split(/\r?\n/)) {
      const mm = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim());
      if (mm) got.set(mm[2].trim().replace(/^\.?\//, ''), mm[1].toLowerCase());
    }
    for (const [r] of todo) {
      const g = got.get(r) ?? '';
      if (g === want.get(r)) console.log(`[${t.label}] ✓ ${r}（${(statSync(localFileFor(r, t)!).size / 1048576).toFixed(1)} MiB，內網拉齊）`);
      else { failures.push(`${t.label} ${r}：拉齊後 sha 不符（站上 ${g.slice(0, 12)}… ≠ 本機 ${String(want.get(r)).slice(0, 12)}…）`); ok = false; }
    }
  } catch (e) {
    console.warn('  ⚠ ' + t.label + '（COS 中轉）：' + String((e as Error)?.message ?? e));
    ok = false;
  } finally {
    tr.done();
    rmSync(resolve(LOCAL, `.versions-${t.id}.json`), { force: true });
    if (made.length) console.log(`  ⚠ 桶裡留了 ${made.length} 個對象（前綴 deploy/${stamp}/）；靠生命週期規則 1 天後清除`);
  }
  return ok;
}

// ---- 單檔精準上傳（--only）：不重生、不碰 exe／manifest、不做 adb 預檢 ----------
async function onlyPush(t: Target, rels: string[]): Promise<void> {
  const tr = makeTransport(t);
  try {
    for (const rel of rels) {
      const local = resolve(ROOT, 'www', rel);
      if (!existsSync(local)) { failures.push(`${t.label}：本地缺少 www/${rel}`); continue; }
      const tmp = `${t.docroot}/${rel}.tmp`;
      const dst = `${t.docroot}/${rel}`;
      tr.remote(`mkdir -p "$(dirname '${dst}')"`, '建立目錄 ' + rel);
      tr.upload(local, tmp);                                    // --rsync 時走 rsync，否則 pscp
      const out = tr.remote(`chmod 644 '${tmp}' && mv -f '${tmp}' '${dst}' && sha256sum '${dst}'`, '換上 ' + rel);
      const remoteSha = out.trim().split(/\s+/)[0].toLowerCase();
      const localSha = fileSha(local).toLowerCase();
      const ok = remoteSha === localSha;
      console.log(`[${t.label}] ${USE_RSYNC ? 'rsync' : 'pscp'} ${rel}（${statSync(local).size} B）sha ${localSha.slice(0, 12)}… ${ok ? '✓ 一致' : '✗ 與站上不符'}`);
      if (!ok) failures.push(`${t.label} ${rel}：上傳後 sha 不符`);
    }
  } catch (e) {
    failures.push(t.label + '（only）：' + String((e as Error)?.message ?? e));
  } finally { tr.done(); }
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

// ---- 兩跳法（--relay）：鏡像先直推 → 核對 → 主站從鏡像 pull --------------------------------
if (RELAY) {
  const mirror = targets.find((t) => t.id === 'mirror');
  const primary = targets.find((t) => t.id === 'primary');
  if (!mirror) die('--relay 需要 server.env 有 MIRROR_HOST（鏡像＝中转站）');
  if (MIRROR_ONLY || PRIMARY_ONLY) die('--relay 同時處理兩站，請不要加 --primary-only／--mirror-only');
  console.log(`\n=== 兩跳法 1/3：整組直推鏡像 ${mirror.host}（海外→海外，較快）===`);
  await deployTarget(mirror);                       // 依目前 SITE／NO_ADB／SITE_ONLY 旗標推整組到鏡像
  const rels = pullRelList();
  console.log(`\n=== 兩跳法 2/3：核對鏡像 ${rels.length} 個檔都 == 本機（防止 pull 到較舊版造成倒退）===`);
  let mism: string[] = [];
  const mt = makeTransport(mirror);
  try {
    const toHash = rels.filter((r) => localFileFor(r) !== null);
    const onMirror = remoteShaMap(mt, mirror, toHash);
    for (const r of toHash) {
      const lp = localFileFor(r)!;
      const want = fileSha(lp).toLowerCase(); const got = onMirror.get(r);
      if (!got) mism.push(`${r}：鏡像上沒有（pscp 可能未成功）`);
      else if (got !== want) mism.push(`${r}：鏡像 ${got.slice(0, 12)}… ≠ 本機 ${want.slice(0, 12)}…`);
    }
  } finally { mt.done(); }
  if (mism.length) {
    console.error('\n✗ 鏡像與本機不一致，已中止（不會 pull，避免把主站倒退）：');
    for (const x of mism) console.error('  - ' + x);
    process.exit(1);
  }
  console.log(`  ✓ 鏡像 ${toHash.length} 檔全部與本機一致`);
  console.log(`\n=== 兩跳法 3/3：主站 ${primary.host} 從鏡像 pull（伺服器端 curl）===`);
  await pullTarget(primary!, mirror.base);           // primary 從鏡像公開網址拉整組；versions.json url 改指主站
  console.log('\n驗證主站線上…');
  const urls = pullRelList();
  let bad = 0;
  for (const u of urls) {
    try { const r = await fetch(primary!.base + u, { method: 'HEAD', headers: { 'cache-control': 'no-cache' } }); if (!r.ok) { failures.push(`主站 ${primary!.base}${u} HTTP ${r.status}`); bad++; } }
    catch (e) { failures.push(`主站 ${primary!.base}${u}：` + String((e as Error)?.message ?? e)); bad++; }
  }
  if (!bad) console.log(`[主站] ✓ ${urls.length} 檔都在線上`);
  console.log('\n（.adb 本體不在 pull 集內；大 adb 另用 publish-adb --files …，或讓主站從鏡像 curl adb/<檔>.adb。）');
  if (failures.length) { console.error('\n✗ 兩跳法有問題：\n  - ' + failures.join('\n  - ')); process.exit(1); }
  console.log(`\n✓ 兩跳法完成：鏡像 ${mirror.base} 已同步、主站 ${primary!.base} 已從鏡像拉齊`);
  process.exit(0);
}

// ---- 海外模式（2026-11-27 起預設）：鏡像推完＝發佈成功；主站伺服端向鏡像拉齊 ----
/** 輕量線上核對：HEAD versions.json／exe 都在＋（可用時）SSH 伺服器端 exe sha，不下載整包。 */
async function lightVerify(t: Target): Promise<{ ok: boolean; why: string[] }> {
  const why: string[] = [];
  try {
    const vr = await fetch(t.base + 'versions.json', { headers: { 'cache-control': 'no-cache' } });
    if (!vr.ok) why.push('versions.json HTTP ' + vr.status);
    const er = await fetch(t.base + 'accelon26.exe', { method: 'HEAD', headers: { 'cache-control': 'no-cache' } });
    if (!er.ok) why.push('accelon26.exe HTTP ' + er.status);
    else if (manifest) {
      try {
        const tr = makeTransport(t);
        try {
          const sha = tr.remote(`cd '${t.docroot}' && sha256sum accelon26.exe`, '主站 exe sha').trim().split(/\s+/)[0].toLowerCase();
          if (sha !== manifest.sha256.toLowerCase()) why.push(`站上 exe sha ${sha.slice(0, 12)}… ≠ 本版 ${manifest.sha256.slice(0, 12)}…`);
        } finally { tr.done(); }
      } catch { /* 沒 SSH 就只信 HEAD */ }
    }
  } catch (e) { why.push(String((e as Error)?.message ?? e)); }
  return { ok: why.length === 0, why };
}

if (PULL_PRIMARY) {
  const mirror = targets.find((t) => t.id === 'mirror');
  const primary = targets.find((t) => t.id === 'primary');
  if (!mirror || !primary) die('--pull-primary 需要 server.env 同時有 HOST 與 MIRROR_HOST');
  const cfg = await cosFor(primary);
  console.log(`=== 主站 ${primary.host} 補齊（${cfg ? '本機經 COS 桶，站上內網拉齊' : '從鏡像 ' + mirror.base + ' 公網拉整組'}；不推鏡像）===`);
  let pulled = false;
  if (cfg) {
    pulled = await pullViaCos(primary, cfg);
    if (!pulled) console.warn('⚠ COS 中轉沒做完 → 退回主站向鏡像公網拉齊');
  }
  if (!pulled) await pullTarget(primary, mirror.base);
  const v = await lightVerify(primary);
  if (v.ok) console.log(`\n✓ 主站已拉齊 ${primary.base}`);
  else { console.error('\n✗ 主站仍未對齊：' + v.why.join('；') + '\n  稍後重試：bun run tools/deploy.ts --pull-primary'); process.exit(1); }
  process.exit(0);
}

const mirrorT = targets.find((t) => t.id === 'mirror');
const primaryT = targets.find((t) => t.id === 'primary');
let OVERSEAS = !CHECK_ONLY && !ONLY && !PULL_FROM && !RELAY && !MIRROR_ONLY && !PRIMARY_ONLY &&
               !PUSH_ALL && !!mirrorT && !!primaryT;
// 人在國內（主站 TCP <120ms）時不必繞鏡像，兩站都直推＝旧的預設行為。
if (OVERSEAS && !COS_FORCE && !COS_OFF && await primaryIsNear(primaryT!)) {
  console.log(`\n=== 主站 ${primaryT!.host} TCP 連線 ${_nearMs.toFixed(0)}ms → 判定人在國內：兩站直推（不走鏡像、不碰 COS）===`);
  OVERSEAS = false;
}
if (OVERSEAS && mirrorT && primaryT) {
  console.log(`\n=== 海外模式 1/2：整組直推鏡像 ${mirrorT.base}（exe／versions.json／網頁／adb 皆算；驗證鏡像＝發佈成功）===`);
  await deployTarget(mirrorT);
  try { await verifyTarget(mirrorT); }
  catch (e) { die('鏡像驗證失敗（發佈未完成）：' + String((e as Error)?.message ?? e)); }
  console.log(`\n✓ 發佈成功：鏡像 ${mirrorT.base}（含網頁）已是這一版`);
  if (NO_PRIMARY) {
    console.log('  主站依 --no-primary 未處理；要補齊時跑：bun run tools/deploy.ts --pull-primary');
    process.exit(0);
  }
  console.log(`\n=== 海外模式 2/2：補齊主站 ${primaryT.host}（失敗不翻發佈）===`);
  const f0 = failures.length;
  const cfg = await cosFor(primaryT);
  const viaCos = cfg ? await pullViaCos(primaryT, cfg) : false;
  if (cfg && !viaCos) console.warn('  ⚠ COS 中轉沒做完 → 退回主站向鏡像公網拉齊');
  if (!viaCos) await pullTarget(primaryT, mirrorT.base);  // 舊路：伺服端向鏡像 curl（對岸約 50 KB/s）
  const pullNotes = failures.splice(f0);             // 主站拉取問題轉為提示，不算發佈失敗
  for (const m of pullNotes) console.warn('  ⚠ ' + m);
  const v = await lightVerify(primaryT);
  if (v.ok) console.log(`  ✓ 主站已同步 ${primaryT.base}`);
  else {
    console.warn('  ⚠ 主站這次沒拉齊：' + v.why.join('；'));
    console.warn('  檔都在鏡像上，隨時補拉：bun run tools/deploy.ts --pull-primary');
  }
  console.log(`\n✓ 發佈完成（判定＝鏡像）：${mirrorT.base}；主站 ${v.ok ? '已同步' : '待補拉'}`);
  process.exit(0);
}

// ---- 主流程 --------------------------------------------------------------------
if (!CHECK_ONLY) {
  if (ONLY) {
    const rels = ONLY.split(',').map((s) => s.trim()).filter(Boolean);
    if (!rels.length) die('--only 沒有指定檔案');
    console.log(`單檔精準上傳：${rels.join('、')} → ${chosen.map((t) => t.label).join('、')}${USE_RSYNC ? '（rsync）' : '（pscp）'}`);
    for (const t of chosen) await onlyPush(t, rels);
  } else if (PULL_FROM) {
    for (const t of chosen) await pullTarget(t, PULL_FROM);
  } else {
    for (const t of chosen) await deployTarget(t);
    for (const t of chosen) rmSync(resolve(LOCAL, `.versions-${t.id}.json`), { force: true });
  }
}
// 驗證：--only 已在 onlyPush 內逐檔比對 sha，不再整站抓；拉模式只 HEAD 存在性；推模式完整驗證。
if (ONLY) {
  console.log('\n驗證線上（--only：HEAD 存在性）…');
  for (const t of chosen) {
    for (const rel of ONLY.split(',').map((s) => s.trim()).filter(Boolean)) {
      try {
        const r = await fetch(t.base + rel, { method: 'HEAD', headers: { 'cache-control': 'no-cache' } });
        if (!r.ok) failures.push(`${t.label} ${t.base}${rel} HTTP ${r.status}`);
        else console.log(`[${t.label}] ✓ ${rel} 在線（${r.headers.get('content-length')} B）`);
      } catch (e) { failures.push(`${t.label} ${t.base}${rel}：` + String((e as Error)?.message ?? e)); }
    }
  }
} else if (PULL_FROM) {
  console.log('\n驗證線上（拉模式：HEAD 存在性）…');
  for (const t of chosen) {
    const urls = pullRelList();
    if (SITE_ONLY) for (const n of siteZipNames()) if (!urls.includes(n)) urls.push(n);
    let bad = 0;
    for (const u of urls) {
      try {
        const r = await fetch(t.base + u, { method: 'HEAD', headers: { 'cache-control': 'no-cache' } });
        if (!r.ok) { failures.push(`${t.label} ${t.base}${u} HTTP ${r.status}`); bad++; }
      } catch (e) { failures.push(`${t.label} ${t.base}${u}：` + String((e as Error)?.message ?? e)); bad++; }
    }
    if (!bad) console.log(`[${t.label}] ✓ ${urls.length} 個檔都在線上`);
  }
} else {
  console.log('\n驗證線上…');
  for (const t of chosen) {
    try { await verifyTarget(t); } catch (e) { failures.push(t.label + ' 驗證：' + String((e as Error)?.message ?? e)); }
  }
}
if (failures.length) {
  console.error('\n✗ 有問題：');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log(CHECK_ONLY
  ? `\n線上都正常（--check：沒有上傳任何東西）。`
  : `\n已同步：${chosen.map((t) => t.base).join('、')}`);

