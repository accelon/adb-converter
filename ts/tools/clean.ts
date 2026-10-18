/**
 * 清 build/（作者 2026-10）：這個資料夾是「產出物 ＋ 探針的暫存」，一直沒清會長到幾 GB
 * （2026-10-18 清過一次：5,121 MB → 56 MB，幾乎都是 Chrome/Edge 的 profile、
 *  一次性的比較輸出、bench 語料、adb 複本與 tmp-*-state）。
 *
 *   bun run tools/clean.ts            只留產物與今天的截圖（建議的日常清理）
 *   bun run tools/clean.ts --all      除了產物全部刪（截圖也刪）
 *   bun run tools/clean.ts --dry-run  只印不刪
 *
 * 會保留（重建要花時間或是有紀念價值）：
 *   build/accelon26.html   單檔 HTML（雙擊就能看）
 *   build/macos/           macOS 的 .app zip（deploy-macos 要用；也能從 GitHub Release 重下）
 *   build/site-shots/      驗證用的截圖（--all 時一併刪）
 *   build/pas/             舊版 Delphi 轉換器的參照原始碼（其他地方沒有）
 *   build/tmp-*.ts         臨時探針腳本（很小，下次還能用）
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../..');
const BUILD = resolve(ROOT, 'build');
const args = new Set(process.argv.slice(2));
const dry = args.has('--dry-run');
const all = args.has('--all');

/** 一定留下來的（產物） */
const ALWAYS = new Set(['accelon26.html', 'macos']);
/** 日常清理也留下來的（參考資料／今天的截圖／探針腳本） */
const USUALLY = ['site-shots', 'pas'];
const KEEP_RE = /^tmp-[^/]*\.ts$/;

function sizeOf(p: string): number {
  let total = 0;
  const st = statSync(p);
  if (!st.isDirectory()) return st.size;
  for (const e of readdirSync(p, { withFileTypes: true })) {
    const child = resolve(p, e.name);
    try {
      total += sizeOf(child);
    } catch { /* 檔案在掃描時消失（瀏覽器 profile 常常這樣），忽略 */ }
  }
  return total;
}

function rm(p: string): void {
  if (dry) return;
  rmSync(p, { recursive: true, force: true, maxRetries: 3 });
}

const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`;

if (!existsSync(BUILD)) {
  console.log('沒有 build/（還沒建置過）');
  process.exit(0);
}

let freed = 0;
let kept = 0;
const removed: string[] = [];

for (const name of readdirSync(BUILD)) {
  const p = resolve(BUILD, name);
  const keep = ALWAYS.has(name)
    || (!all && USUALLY.includes(name))
    || KEEP_RE.test(name);
  let bytes = 0;
  try {
    bytes = sizeOf(p);
  } catch {
    bytes = 0;
  }
  if (keep) {
    kept += bytes;
    continue;
  }
  removed.push(`${mb(bytes).padStart(10)}  ${name}`);
  freed += bytes;
  rm(p);
}

if (removed.length) {
  console.log(removed.join('\n'));
} else {
  console.log('（沒有要清的東西）');
}
console.log(`\n${dry ? '會刪' : '已刪'} ${removed.length} 項，${mb(freed)}；留下 ${mb(kept)}` +
  (dry ? '（--dry-run，沒有真的刪）' : ''));
if (all) console.log('（--all：截圖與參考資料也刪掉了；build/macos 與 accelon26.html 留著）');
