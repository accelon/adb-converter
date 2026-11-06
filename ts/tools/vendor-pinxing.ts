/**
 * pinxing → accelon26：把**拼形描繪器 ＋ 字庫解碼器 ＋ 字庫**複製進來
 * （`ts/src/vendor/pinxing/`、`wails/assets/pinxing.bin.gz`）。
 *
 *   cd ts && bun run tools/vendor-pinxing.ts            # 產生／更新
 *   cd ts && bun run tools/vendor-pinxing.ts --check    # 只檢查：來源變了就 exit 1
 *
 * ## 方向
 *
 *   D:\2026\pinxing（Apache-2.0，字形庫目前仍由 D:\2023\glyphwiki 產出）
 *        │  這個工具
 *        ▼
 *   ts/src/vendor/pinxing/{lib-format.ts,pinxing.ts} + wails/assets/pinxing.bin.gz
 *
 * accelon26 **只認得 pinxing**：不 import 上游、不寫死上游路徑。字庫要換版時，
 * 先在 pinxing 那邊 `bun run fetch-lib`，再來這裡同步。
 *
 * ## 為什麼是「建置期複製」而不是共用資料夾
 *
 * accelon26 的建置必須能在**沒有 `D:\2026\pinxing`、也沒有 `D:\2023\glyphwiki`** 的機器上跑
 * （CI、macOS）。所以沿用 `variant-data.ts` 的先例：**生成物進版控、生成器留在本區**，
 * 並用 `--check` ＋ `ts/test/pinxing-vendor.test.ts`（golden 差分）鎖住「兩份是同一份」。
 *
 * ## 改寫規則（三條，都寫在這裡以免各說各話）
 *
 *   ① 拿掉 shebang（生成物前面有檔頭註解，shebang 只能在第一行）。
 *   ② 拿掉「node: 開頭」的 import（只在 CLI 段用得到）。
 *   ③ 拿掉 `if (import.meta.main) { … }` 之後的 CLI 段（瀏覽器沒有 `import.meta.main`）。
 *
 * ⚠ 只動「區塊」，不改任何一行邏輯；`--check` 會比對 sha256，來源一改就會紅。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const here = import.meta.dir;
const SRC = process.env.PINXING_DIR || 'D:/2026/pinxing';
const OUT = resolve(here, '../src/vendor/pinxing');
const LIB_DST = resolve(here, '../../wails/assets/pinxing.bin.gz');
const CHECK = process.argv.includes('--check');

/** 要搬的模組（`src/` 底下） */
const MODULES = ['lib-format.ts', 'pinxing.ts'];
/** 字庫（`lib/` 底下）：進版控 —— CI／macOS 的建置也要有字形。指紋由 golden 的 `libSha256` 釘住 */
const LIB_SRC = `${SRC}/lib/lib-cjk-all.bin.gz`;

const sha256 = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex').slice(0, 16);

function transform(src: string): { code: string; strippedImports: number; strippedCli: boolean } {
  let code = src;
  let strippedImports = 0;
  code = code.replace(/^#![^\n]*\n/, '');
  code = code.replace(/^import\s[^\n]*from\s"node:[^"]*";\n/gm, () => { strippedImports++; return ''; });
  const cliAt = code.indexOf('if (import.meta.main)');
  const strippedCli = cliAt >= 0;
  if (cliAt >= 0) {
    const lineStart = code.lastIndexOf('\n', cliAt) + 1;
    code = code.slice(0, lineStart).replace(/\n+$/, '\n');
  }
  return { code, strippedImports, strippedCli };
}

function header(name: string, sourceSha: string, sourceBytes: number): string {
  return `/* ---------------------------------------------------------------------------
 * ⚠ 生成檔，不要手改（改來源）。
 *
 * 來源：D:\\2026\\pinxing\\src\\${name}（sha256 ${sourceSha}，${sourceBytes} bytes）
 * 產生：ts/tools/vendor-pinxing.ts　→　重跑：cd ts && bun run tools/vendor-pinxing.ts
 * 檢查：bun run tools/vendor-pinxing.ts --check（來源變了會 exit 1）
 *
 * 改寫（三條，見生成器檔頭）：拿掉 shebang、「node: 開頭的 import」、CLI 段。
 * 授權：Apache-2.0（pinxing 自己的程式碼），不含 GPLv3 的 kage-engine。
 * --------------------------------------------------------------------------- */
`;
}

function alreadyThere(): boolean {
  return MODULES.every((m) => existsSync(`${OUT}/${m}`)) && existsSync(LIB_DST);
}

if (!existsSync(SRC)) {
  if (alreadyThere()) {
    console.warn(`⚠ 找不到來源（${SRC}），沿用已進版控的生成物。`);
    process.exit(0);
  }
  console.error(`找不到 pinxing 來源：${SRC}（用 PINXING_DIR 指定）`);
  process.exit(2);
}

let changed = 0;
for (const name of MODULES) {
  const p = `${SRC}/src/${name}`;
  if (!existsSync(p)) { console.error(`來源少了 ${p}`); process.exit(2); }
  const src = readFileSync(p, 'utf8');
  const { code, strippedImports, strippedCli } = transform(src);
  const out = header(name, sha256(src), Buffer.byteLength(src)) + code;
  const dst = `${OUT}/${name}`;
  const old = existsSync(dst) ? readFileSync(dst, 'utf8') : '';
  if (old !== out) {
    changed++;
    if (CHECK) {
      console.error(`✗ ${name} 與來源不同步（重跑 bun run tools/vendor-pinxing.ts）`);
    } else {
      mkdirSync(OUT, { recursive: true });
      writeFileSync(dst, out, 'utf8');
      console.log(`wrote ${dst}（拿掉 ${strippedImports} 個 node import${strippedCli ? '、CLI 段' : ''}）`);
    }
  }
}

// 字庫
{
  if (existsSync(LIB_SRC)) {
    const srcBytes = readFileSync(LIB_SRC);
    const cur = existsSync(LIB_DST) ? readFileSync(LIB_DST) : null;
    const same = cur && cur.length === srcBytes.length && sha256(cur) === sha256(srcBytes);
    if (!same) {
      changed++;
      if (CHECK) { console.error(`✗ wails/assets/pinxing.bin.gz 與來源不同步`); }
      else {
        mkdirSync(resolve(here, '../../wails/assets'), { recursive: true });
        writeFileSync(LIB_DST, srcBytes);
        console.log(`wrote ${LIB_DST}（${(srcBytes.length / 1048576).toFixed(2)} MB）`);
      }
    }
  } else if (!existsSync(LIB_DST)) {
    console.error(`找不到字庫：${LIB_SRC}（用 PINXING_DIR 指定），而且 wails/assets 也沒有`);
    process.exit(2);
  } else {
    console.warn(`⚠ 沒有來源字庫，沿用已進版控的 wails/assets/pinxing.bin.gz`);
  }
}

if (CHECK) {
  if (changed) process.exit(1);
  console.log(`✓ ${MODULES.length} 個模組＋字庫與 pinxing 同步`);
} else if (!changed) {
  console.log('（沒有變動）');
}
