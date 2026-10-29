/**
 * CBETA 底座 adb 的版本帳本（作者 2026-10-29）。
 *
 * 目的：`taisho.adb`、`wxzj.adb` 這種「純經文底座」只跟著 **CBETA XML-P5 的正式版本**
 * 更新（一年 2–3 次）；平常不要因為我們改工具、加功能就重建，讓使用者一直下載 300 MB。
 *
 *   cd ts && bun run tools/cbeta-base.ts --check
 *   cd ts && bun run tools/cbeta-base.ts --record taisho.adb build/taisho-2026R2.adb T
 *   cd ts && bun run tools/cbeta-base.ts --record wxzj.adb build/wxzj-2026R2.adb X
 *
 * `--record` 會讀 `D:\2026\xml-p5` 目前的 tag／commit，寫進 `deploy/cbeta-base.json`。
 * `--check` 比對 `D:\accelon3\<檔名>` 的 sha256 與帳本：
 *   - 一樣：這批底座沒有被動過（正常）。
 *   - 不一樣：底座被重建了。若 CBETA 沒有發新版本，這個改動應該做成 feature adb，
 *     而不是換掉底座；真的換版才 `--record`。
 *
 * 這個帳本不影響程式執行，只是發佈前的紀律檢查。`make-adb-manifest.ts` 的版本歷史
 * 仍以 sha256 為準。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../..');
const LEDGER = resolve(ROOT, 'deploy/cbeta-base.json');
const SOURCE = resolve('D:\\2026\\xml-p5');
const PUBLISHED = resolve('D:\\accelon3');

const args = process.argv.slice(2);
const opt = (n: string, d = '') => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const CHECK = args.includes('--check');
const RECORD = args.includes('--record');

function git(...a: string[]): string {
  const r = Bun.spawnSync({ cmd: ['git', '-C', SOURCE, ...a], stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error('git ' + a.join(' ') + '：' + new TextDecoder().decode(r.stderr).trim());
  return new TextDecoder().decode(r.stdout).trim();
}

function sourceInfo(): { tag: string; commit: string; date: string } {
  if (!existsSync(SOURCE)) throw new Error('找不到 CBETA 來源：' + SOURCE);
  const tag = git('describe', '--tags', '--exact-match', 'HEAD');
  const commit = git('rev-parse', 'HEAD');
  const date = git('show', '-s', '--format=%cs', 'HEAD');
  return { tag, commit, date };
}

function sha256(p: string): string {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

interface Ledger {
  source: string;
  tag: string;
  commit: string;
  sourceDate: string;
  updatedAt: string;
  files: Record<string, { canon: string; sha256: string; size: number; builtAt: string }>;
}

function load(): Ledger | null {
  if (!existsSync(LEDGER)) return null;
  return JSON.parse(readFileSync(LEDGER, 'utf8')) as Ledger;
}

if (CHECK) {
  const l = load();
  if (!l) { console.error('還沒有 ' + LEDGER + '；先 --record 一次'); process.exit(2); }
  const info = sourceInfo();
  let bad = 0;
  console.log(`帳本：CBETA ${l.tag}（${l.sourceDate}，${l.commit.slice(0, 12)}）`);
  if (info.tag !== l.tag) {
    console.log(`  ! 來源 checkout 是 ${info.tag}，帳本是 ${l.tag}（換版了？）`);
    bad++;
  }
  for (const [name, rec] of Object.entries(l.files)) {
    const p = resolve(PUBLISHED, name);
    if (!existsSync(p)) { console.error(`  ✗ ${name} 不存在（${p}）`); bad++; continue; }
    const sha = sha256(p);
    const size = statSync(p).size;
    const ok = sha === rec.sha256 && size === rec.size;
    console.log(`  ${ok ? '✓' : '✗'} ${name}  ${(size / 1048576).toFixed(1)} MiB  sha256 ${sha.slice(0, 16)}…`);
    if (!ok) {
      bad++;
      console.log(`      帳本 ${rec.sha256.slice(0, 16)}… / ${(rec.size / 1048576).toFixed(1)} MiB（${rec.canon}，CBETA ${l.tag}）`);
      console.log('      底座被重建了。CBETA 沒有換版的話，改動應該放 feature adb；真要換版才 --record。');
    }
  }
  process.exit(bad ? 1 : 0);
}

if (RECORD) {
  const i = args.indexOf('--record');
  const name = args[i + 1];
  const file = args[i + 2];
  const canon = args[i + 3] || name.replace(/\.adb$/i, '').toUpperCase();
  if (!name || !file) {
    console.error('用法：--record <發佈檔名> <本機 adb> [canon]');
    process.exit(2);
  }
  const p = resolve(file);
  if (!existsSync(p)) { console.error('找不到 ' + p); process.exit(2); }
  const info = sourceInfo();
  const l = load() ?? { ...info, source: 'cbeta-org/xml-p5', updatedAt: new Date().toISOString(), files: {} };
  // 換版時保留舊檔記錄？只留目前版本，以免 --check 比對到已下架的舊底座。
  l.source = 'cbeta-org/xml-p5';
  l.tag = info.tag;
  l.commit = info.commit;
  l.sourceDate = info.date;
  l.updatedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  l.files[name] = {
    canon,
    sha256: sha256(p),
    size: statSync(p).size,
    builtAt: l.updatedAt,
  };
  writeFileSync(LEDGER, JSON.stringify(l, null, 2) + '\n', 'utf8');
  console.log(`記下 ${name}：CBETA ${info.tag}（${info.date}）sha256 ${l.files[name].sha256.slice(0, 16)}…`);
  process.exit(0);
}

console.log('用法：--check 或 --record <發佈檔名> <本機 adb> [canon]');
process.exit(2);
