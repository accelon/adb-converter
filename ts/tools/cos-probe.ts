/**
 * COS 中轉探測（2026-11-27）：量「海外 → 廣州桶」的實際上傳速率，並給出
 * 「廣州機 → 同地域 COS 內網」的驗證指令。只探測，不碰站上任何檔案。
 *
 *   cd ts && bun run tools/cos-probe.ts              # 20MB，普通域名＋加速域名各一輪
 *   cd ts && bun run tools/cos-probe.ts --size 5     # 換大小（MB）
 *   cd ts && bun run tools/cos-probe.ts --accel-only # 只測加速域名（普通域名已證實只有幾 KB/s）
 *   cd ts && bun run tools/cos-probe.ts --sign-only  # 只對上一次上傳成功的 key 簽 GET、印站上指令，不傳輸
 *   cd ts && bun run tools/cos-probe.ts --key probe/xxx.bin  # 指定桶裡既有的對象
 *
 * 憑證從 `.local/cos.env` 讀（`.local/` 在 .gitignore，內容不會被印出來）：
 *   COS_SECRET_ID / COS_SECRET_KEY   只給 COS 權限的子賬號密鑰
 *   COS_BUCKET                       桶全名（含 -APPID 後綴）
 *   COS_REGION                       預設 ap-guangzhou
 *
 * 判讀：普通廣州域名從海外打過去通常比直連站上還慢；加速域名若明顯更快，
 * 發佈就改走「本機 putObject → 站上預簽名 GET 內網拉齊」。
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import COS from 'cos-nodejs-sdk-v5';

const ROOT = resolve(import.meta.dir, '../..');
const LOCAL = resolve(ROOT, '.local');
const OUT = resolve(ROOT, 'out');
const args = process.argv.slice(2);
const opt = (n: string, d = '') => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const die = (m: string): never => { console.error('✗ ' + m); process.exit(1); };

const envPath = resolve(LOCAL, 'cos.env');
if (!existsSync(envPath)) die('找不到 ' + envPath + '（填好子賬號密鑰再跑）');
const env: Record<string, string> = {};
for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
  if (m) env[m[1].toUpperCase()] = m[2].trim().replace(/^["']|["']$/g, '');
}
const SECRET_ID = env.COS_SECRET_ID, SECRET_KEY = env.COS_SECRET_KEY;
const BUCKET = env.COS_BUCKET || die('.local/cos.env 缺 COS_BUCKET');
const REGION = env.COS_REGION || 'ap-guangzhou';
if (!SECRET_ID || !SECRET_KEY) die('.local/cos.env 的 COS_SECRET_ID／COS_SECRET_KEY 是空的');

const HOST_NORMAL = `${BUCKET}.cos.${REGION}.myqcloud.com`;
const HOST_ACCEL = `${BUCKET}.cos.accelerate.myqcloud.com`;
const SIZE_MB = Number(opt('size', '20')) || 20;
const SIGN_ONLY = args.includes('--sign-only');
const cos = new COS({ SecretId: SECRET_ID, SecretKey: SECRET_KEY });
// 加速域名要由 SDK 自己組 host 並配套簽名（base.js 的 UseAccelerate → region:'accelerate'）；
// 事後把 URL 裡的域名換字串會拿到 SignatureDoesNotMatch。
const cosAccel = new COS({ SecretId: SECRET_ID, SecretKey: SECRET_KEY, UseAccelerate: true });

async function signUrl(key: string, method: 'GET' | 'PUT', accel = false): Promise<string> {
  const d = await new Promise<{ Url?: string; url?: string }>((res, rej) =>
    (accel ? cosAccel : cos).getObjectUrl({ Bucket: BUCKET, Region: REGION, Key: key, Method: method, Expires: 900, Sign: true },
      (e: Error | null, data: { Url?: string; url?: string } | undefined) => (e || !data) ? rej(e ?? new Error('簽名失敗')) : res(data)));
  // SDK 回傳的是大寫 Url；兩者都收，免得哪天改版又踩一次
  return d.Url ?? d.url ?? die('簽名回傳裡找不到 Url');
}

// 印出「站上抓內網」的指令：先確認對象真的在桶裡，再簽 15 分鐘的 GET
async function showPullCmd(k: string): Promise<void> {
  const head = await new Promise<{ size?: string } | null>((res) =>
    cos.headObject({ Bucket: BUCKET, Region: REGION, Key: k },
      (e: unknown, d: { headers?: Record<string, string> } | undefined) =>
        res(e ? null : { size: d?.headers?.['content-length'] })));
  if (!head) { console.log('⚠ 桶裡查不到 ' + k + '，站上抓它會拿到 NoSuchKey；先看上面哪一輪上傳回 code=200。'); return; }
  console.log('【站上驗證內網用這條（廣州機 OrcaTerm 直接貼；對象已確認存在，' + (head.size ?? '?') + ' bytes）】');
  console.log(`  curl -o /dev/null -sS -m 60 -w 'code=%{http_code} size=%{size_download} time=%{time_total}s speed=%{speed_download}B/s\\n' \\\n    '${await signUrl(k, 'GET')}'`);
  console.log('  getent hosts ' + HOST_NORMAL + '     ← 期待 169.254.*.*，代表走內網\n');
}

mkdirSync(resolve(OUT, 'probe'), { recursive: true });
const KEYFILE = resolve(OUT, 'probe', 'last-key.txt');
// 站上要抓的是「已經在桶裡的那個對象」；每輪都新生成 key 會讓站上的 GET 拿到 NoSuchKey
const key = opt('key') || (SIGN_ONLY && existsSync(KEYFILE) ? readFileSync(KEYFILE, 'utf8').trim()
  : `probe/cos-probe-${SIZE_MB}m-${Date.now().toString(36)}.bin`);
const file = resolve(OUT, key.split('/').pop()!);
if (!SIGN_ONLY && !opt('key')) {
  if (!existsSync(file) || statSync(file).size !== SIZE_MB * 1024 * 1024) {
    console.log(`造 ${SIZE_MB}MB 隨機測試檔 → ${file}`);
    writeFileSync(file, randomBytes(SIZE_MB * 1024 * 1024));
  }
  console.log('本地 sha256 =', createHash('sha256').update(readFileSync(file)).digest('hex'));
}

console.log(`\n桶 ${BUCKET}  地域 ${REGION}  測試 key ${key}\n`);
if (SIGN_ONLY) {
  if (!opt('key') && !existsSync(KEYFILE)) die('桶裡還沒有上傳成功過的對象；先跑一次不帶 --sign-only 的探測');
  await showPullCmd(key);
  process.exit(0);
}

const legs: Array<readonly [string, string, string]> = [
  ['普通域名（跨地域公網）', HOST_NORMAL, await signUrl(key, 'PUT')],
  ['全球加速域名', HOST_ACCEL, await signUrl(key, 'PUT', true)],
];
// 普通域名從海外穩定只有幾 KB/s，測過一次就夠；大檔時跳過它，別白等幾分鐘
for (const [label, host, url] of (args.includes('--accel-only') ? legs.slice(1) : legs)) {
  console.log(`=== 上傳 ${SIZE_MB}MB → ${label}（${host}）===`);
  const body = resolve(OUT, 'probe', 'resp.xml');
  const p = Bun.spawn(['curl', '-sS', '--noproxy', '*', '-m', '180', '-T', file, url, '-o', body,
    // 上傳要看 speed_upload／size_upload；PUT 時 speed_download 恆為 0，會誤判成「完全沒速度」
    '-w', 'code=%{http_code} uploaded=%{size_upload} time=%{time_total}s speed=%{speed_upload}B/s'],
    { stdout: 'pipe', stderr: 'pipe' });
  const out = await new Response(p.stdout).text();
  const err = await new Response(p.stderr).text();
  const code = await p.exited;
  console.log('  ' + out.trim() + (code ? `  (curl exit ${code})` : ''));
  const xml = existsSync(body) ? readFileSync(body, 'utf8') : '';
  const cosCode = /<Code>([^<]+)<\/Code>/.exec(xml)?.[1];
  if (cosCode && cosCode !== 'Success') console.log('  ⚠ COS 回 ' + cosCode + '：' + (/<Message>([^<]+)<\/Message>/.exec(xml)?.[1] ?? '').slice(0, 160));
  if (code && err.trim()) console.log('  ⚠ curl：' + err.trim().split('\n')[0]);
}
console.log('\n判讀：加速域名明顯快 → 發佈走「本機 putObject ＋ 站上預簽名 GET 內網拉齊」。');
console.log('      兩者都很慢 → 改 B1：另建新加坡桶當上傳落點，開跨地域復制到廣州桶。');
writeFileSync(KEYFILE, key);
await showPullCmd(key);
console.log('⚠ 上面印出的簽名 URL 有效 15 分鐘，含短期存取憑證，別貼到公開場合；只把 speed= 那一段貼回來就好。');
