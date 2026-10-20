/**
 * Keep the vendored copies of the shared norms/module in sync with
 * D:\2026\agent-norms (canonical).
 *
 *   cd ts
 *   bun run sync:norms          # copy canonical -> this repo
 *   bun run check:norms         # fail if the vendored copy drifted
 *
 * The repo keeps vendored copies so Bun builds and GitHub CI do not depend on
 * a sibling directory. Edit the canonical files in agent-norms, then sync.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../..');
const AGENT = process.env.AGENT_NORMS
  ? resolve(process.env.AGENT_NORMS)
  : resolve(ROOT, '../agent-norms');
const CHECK = process.argv.includes('--check');

type Pair = { from: string; to: string; label: string; transform?: (text: string) => string };

const PAIRS: Pair[] = [
  {
    from: resolve(AGENT, 'yap-software-practice.md'),
    to: resolve(ROOT, 'yap-software-practice.md'),
    label: 'yap-software-practice.md',
  },
  {
    from: resolve(AGENT, 'wails3-pitfalls.md'),
    to: resolve(ROOT, 'wails3-pitfalls.md'),
    label: 'wails3-pitfalls.md',
  },
  {
    from: resolve(AGENT, 'lossless-simplified/lossless.ts'),
    to: resolve(ROOT, 'ts/src/accelon26/lossless.ts'),
    label: 'lossless.ts',
  },
  {
    from: resolve(AGENT, 'lossless-simplified/simplified-data.ts'),
    to: resolve(ROOT, 'ts/src/accelon26/simplified-data.ts'),
    label: 'simplified-data.ts',
  },
  {
    from: resolve(AGENT, 'lossless-simplified/gen-lossless.ts'),
    to: resolve(ROOT, 'ts/tools/gen-lossless.ts'),
    label: 'gen-lossless.ts',
    // The project copy differs only in the CLI example and the default output path.
    transform: (text) =>
      text
        .replace(' *   bun run gen-lossless.ts', ' *   bun run tools/gen-lossless.ts')
        .replace('[--out simplified-data.ts]', '[--out ../src/accelon26/simplified-data.ts]')
        .replace(
          "resolve(import.meta.dir, 'simplified-data.ts')",
          "resolve(import.meta.dir, '../src/accelon26/simplified-data.ts')",
        ),
  },
];

if (!existsSync(AGENT)) {
  console.error(`找不到 agent-norms：${AGENT}`);
  console.error('設定 AGENT_NORMS 指向共用目錄，或先把 agent-norms clone 到 D:\\2026\\agent-norms。');
  process.exit(2);
}

let failed = 0;
let changed = 0;

for (const { from, to, label, transform } of PAIRS) {
  if (!existsSync(from)) {
    console.error(`✗ ${label}: canonical 不存在 ${from}`);
    failed++;
    continue;
  }
  const canonical = transform
    ? Buffer.from(transform(readFileSync(from, 'utf8')), 'utf8')
    : readFileSync(from);
  const vendored = existsSync(to) ? readFileSync(to) : null;
  const same = vendored !== null && Buffer.compare(canonical, vendored) === 0;

  if (CHECK) {
    if (same) {
      console.log(`ok  ${label}`);
    } else {
      console.error(`✗ ${label}: ${relative(ROOT, to)} 與 canonical 不同（跑 bun run sync:norms）`);
      failed++;
    }
    continue;
  }

  if (same) {
    console.log(`ok  ${label}（已同步）`);
    continue;
  }

  mkdirSync(dirname(to), { recursive: true });
  writeFileSync(to, canonical);
  console.log(`→ ${label}（${relative(ROOT, to)}）`);
  changed++;
}

if (CHECK) {
  if (failed) {
    console.error(`\n${failed} 個檔案與 agent-norms 不同步`);
    process.exit(1);
  }
  console.log('\n全部同步');
  process.exit(0);
}

console.log(`\n完成：${changed} 個檔案更新`);
