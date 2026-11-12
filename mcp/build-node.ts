/**
 * 把 MCP server 打包成「客戶端用 Node 直接跑」的單檔（不佈署 exe、不依賴 Bun）。
 *
 *   cd ts（或 repo 根皆可）→ bun run mcp/build-node.ts
 *   → build/mcp-release/adb-mcp.cjs   （單一 CommonJS，內嵌整條只讀引擎）
 *
 *   跑法：node build/mcp-release/adb-mcp.cjs     （MCP 客戶端把 command 指到 node、args 指到此檔）
 *
 * 為什麼要 plugin：`src/bz2.ts` 頂層靜態 `import { dlopen } from 'bun:ffi'`。
 * bun:ffi 只有 Bun 有；Node 載入到這行就炸。打包時把 'bun:ffi' 換成「呼叫即拋錯」的
 * stub —— 執行期 createDecoder('auto') 構造 FfiDecoder 時 dlopen 丟錯、被 catch，
 * 自動退回內附的純 JS bzip2（讀 adb 只用到「解壓」，JS 後備完全夠、也正確）。
 * 這樣不用動 app 共用的 bz2.ts，Bun／Wails 那边的行為一模一樣。
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..'); // .../adb-converter
const OUT_DIR = resolve(ROOT, 'build/mcp-release');
mkdirSync(OUT_DIR, { recursive: true });

const bunFfiStub = {
  name: 'bun-ffi-stub',
  setup(build: any) {
    build.onResolve({ filter: /^bun:ffi$/ }, () => ({ path: 'bun-ffi-stub', namespace: 'bun-ffi-stub' }));
    build.onLoad({ filter: /.*/, namespace: 'bun-ffi-stub' }, () => ({
      contents:
        'export function dlopen(){ throw new Error("bun:ffi is unavailable in the Node build; the pure-JS bzip2 decoder is used instead"); }' +
        'export default { dlopen };',
      loader: 'js',
    }));
  },
};

const result = await Bun.build({
  entrypoints: [resolve(ROOT, 'mcp/server.ts')],
  target: 'node',
  format: 'cjs',
  outdir: OUT_DIR,
  naming: 'adb-mcp.cjs',
  plugins: [bunFfiStub],
  minify: true,
});

if (!result.success) {
  console.error('✗ 打包失敗');
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
const out = result.outputs[0];
import { statSync } from 'node:fs';
console.log(`✓ ${out.path}（${(statSync(out.path).size / 1024).toFixed(0)} KiB）`);
console.log('  跑法：node "build/mcp-release/adb-mcp.cjs"');
console.log('  其他平台／客戶端一樣用 node 跑這個 .cjs，不需 Bun、不需 repo 其他檔。');
