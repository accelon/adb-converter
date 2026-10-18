/**
 * 安裝／移除「留言給作者」的後端（作者 2026-10-18）。
 *
 *   cd ts && bun run tools/install-message-backend.ts            # 安裝（會動到 Apache 設定一次）
 *   cd ts && bun run tools/install-message-backend.ts --test     # 安裝後寄一則測試留言
 *   cd ts && bun run tools/install-message-backend.ts --uninstall
 *
 * 做什麼（全部用 sudo，密碼從 .local/server.env 讀；只在這次連線用，不留在主機）：
 *   1. www/message.cgi → /var/www/html/accelon26/message.cgi（www-data 755）
 *   2. deploy/apache-accelon26-message.conf → /etc/apache2/conf-available/ + a2enconf
 *   3. .local/smtp.json → /etc/accelon26-message/smtp.json（root:www-data 0640）
 *   4. /var/lib/accelon26-message（www-data 可寫：留言備份與限流）
 *   5. apache2ctl configtest → systemctl reload apache2（configtest 不過就不 reload）
 *
 * 沒有 smtp.json 的 password 就不會安裝（先讓使用者去 QQ 信箱產生授權碼）。
 * 不想裝也可以：留言頁會自動退回「用你的郵件程式寄出」，一樣寄得到。
 */
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../..');
const LOCAL = resolve(ROOT, '.local');
const PLINK = 'C:\\Program Files\\PuTTY\\plink.exe';
const PSCP = 'C:\\Program Files\\PuTTY\\pscp.exe';

const args = process.argv.slice(2);
const UNINSTALL = args.includes('--uninstall');
const TEST = args.includes('--test');

function die(msg: string): never {
  console.error('✗ ' + msg);
  process.exit(1);
}

const envPath = resolve(LOCAL, 'server.env');
const smtpPath = resolve(LOCAL, 'smtp.json');
if (!existsSync(envPath)) die('找不到 ' + envPath);
const env: Record<string, string> = {};
for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
  if (m) env[m[1].toUpperCase()] = m[2].trim().replace(/^["']|["']$/g, '');
}
const HOST = env.HOST;
const PORT = env.PORT || '22';
const USER = env.USER;
const PASS = env.PASS;
const DOCROOT = (env.DOCROOT || '/var/www/html/accelon26').replace(/\/+$/, '');
if (!HOST || !USER || !PASS) die('.local/server.env 的 HOST／USER／PASS 有空值');

const fpPath = resolve(LOCAL, 'hostkey.txt');
if (!existsSync(fpPath)) die('缺少 .local/hostkey.txt（先跑一次 tools/deploy.ts 讓它記錄主機指紋）');
const fingerprint = readFileSync(fpPath, 'utf8').trim();

const pwFile = resolve(LOCAL, '.pw.tmp');

function sh(cmd: string[], label: string): string {
  const r = Bun.spawnSync({ cmd, stdout: 'pipe', stderr: 'pipe' });
  const out = new TextDecoder().decode(r.stdout).trim();
  const err = new TextDecoder().decode(r.stderr).trim();
  if (r.exitCode !== 0) {
    console.error('✗ ' + label + '（exit ' + r.exitCode + '）');
    if (out) console.error(out);
    if (err) console.error(err);
    process.exit(1);
  }
  return out;
}

function upload(localPath: string, remotePath: string): void {
  sh([PSCP, '-batch', '-P', PORT, '-hostkey', fingerprint, '-pwfile', pwFile, localPath, `${USER}@${HOST}:${remotePath}`], '上傳 ' + remotePath);
}

function remote(script: string, label: string): string {
  const f = resolve(LOCAL, '.remote.sh');
  writeFileSync(f, script);
  const out = sh([PLINK, '-batch', '-ssh', '-P', PORT, '-l', USER, '-hostkey', fingerprint, '-pwfile', pwFile, '-m', f, HOST], label);
  rmSync(f, { force: true });
  return out;
}

writeFileSync(pwFile, PASS + '\n', { mode: 0o600 });

// 這支腳本會用 sudo 執行（密碼由呼叫方從 stdin 餵給 sudo -S）。
const PRIV = UNINSTALL
  ? `set -e
a2disconf accelon26-message || true
rm -f /etc/apache2/conf-available/accelon26-message.conf
rm -f ${DOCROOT}/message.cgi
apache2ctl configtest
systemctl reload apache2
echo UNINSTALLED`
  : `set -e
install -o www-data -g www-data -m 755 /tmp/acc-message.cgi ${DOCROOT}/message.cgi
install -d -o www-data -g www-data -m 755 /var/lib/accelon26-message /var/lib/accelon26-message/rate
install -d -o root -g www-data -m 750 /etc/accelon26-message
install -o root -g www-data -m 640 /tmp/acc-smtp.json /etc/accelon26-message/smtp.json
install -m 644 /tmp/acc-message.conf /etc/apache2/conf-available/accelon26-message.conf
a2enconf accelon26-message >/dev/null
apache2ctl configtest
systemctl reload apache2
rm -f /tmp/acc-message.cgi /tmp/acc-message.conf /tmp/acc-smtp.json
echo INSTALLED`;

// ---- 執行 -------------------------------------------------------------------
try {
  if (!UNINSTALL) {
    if (!existsSync(smtpPath)) die('找不到 .local/smtp.json（複製範本並填 password＝QQ 授權碼）');
    const smtp = JSON.parse(readFileSync(smtpPath, 'utf8')) as Record<string, unknown>;
    if (!String(smtp.password ?? '').trim()) die('.local/smtp.json 的 password 還是空的：請填 QQ 信箱的「授權碼」（不是登入密碼）');
    for (const k of ['host', 'port', 'user', 'password', 'to']) {
      if (!String(smtp[k] ?? '').trim()) die('.local/smtp.json 缺少 ' + k);
    }
    upload(resolve(ROOT, 'www', 'message.cgi'), '/tmp/acc-message.cgi');
    upload(resolve(ROOT, 'deploy', 'apache-accelon26-message.conf'), '/tmp/acc-message.conf');
    upload(smtpPath, '/tmp/acc-smtp.json');
  }
  // sudo 要從 stdin 讀密碼，所以特權指令另外放一個檔案（stdin 留給密碼）。
  const pwFileRemote = '/tmp/acc-pw';
  const localPw = resolve(LOCAL, '.remote-pw');
  writeFileSync(localPw, PASS + '\n', { mode: 0o600 });
  upload(localPw, pwFileRemote);
  rmSync(localPw, { force: true });
  const privLocal = resolve(LOCAL, '.priv.sh');
  writeFileSync(privLocal, PRIV);
  upload(privLocal, '/tmp/acc-setup.sh');
  rmSync(privLocal, { force: true });
  const out = remote(`set -e
PW=$(cat ${pwFileRemote})
rm -f ${pwFileRemote}
printf '%s\\n' "$PW" | sudo -S -p '' bash /tmp/acc-setup.sh
rm -f /tmp/acc-setup.sh`, UNINSTALL ? '移除後端' : '安裝後端');
  console.log(out);
} finally {
  rmSync(pwFile, { force: true });
}

console.log(UNINSTALL ? '✓ 已移除留言後端（留言頁會自動退回郵件程式）' : '✓ 後端已安裝：' + `https://${HOST}/accelon26/message.cgi`);

const base = `https://${HOST}/accelon26/`;
const ready = await (async () => {
  try {
    const r = await fetch(base + 'message.cgi', { headers: { 'cache-control': 'no-cache' } });
    return { ok: r.ok, status: r.status, body: (await r.text()).slice(0, 200) };
  } catch (e) {
    return { ok: false, status: 0, body: String(e) };
  }
})();
console.log(`GET message.cgi → ${ready.status} ${ready.body}`);

if (TEST && !UNINSTALL) {
  const payload = {
    type: '回報錯誤',
    name: '安裝測試',
    email: '',
    wechat: '',
    start: '不記得了',
    message: '這是一則安裝測試留言（tools/install-message-backend.ts --test）。收到就代表表單後端可以寄信。',
    website: '',
  };
  const r = await fetch(base + 'message.cgi', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  console.log(`POST 測試留言 → ${r.status} ${(await r.text()).slice(0, 300)}`);
  if (!r.ok) console.error('（測試留言沒有寄出：看上面的錯誤訊息；密碼錯最常見）');
}
