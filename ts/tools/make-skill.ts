/**
 * 一次性：把 adb-skill 需要的 TypeScript 模組（含傳遞相依）抄成一個可交付的資料夾。
 * 客戶有 bun，解開直接 `bun run cli.ts`；`engine.ts` 是二次開發的入口。
 *
 * 來源：ts/tools/adb-skill/{cli,engine,example}.ts ＋ README.md（版控在這裡）
 * 產出：build/adb-skill/  （再壓成 adb-skill-YYYYMMDD.zip）
 *
 *   cd ts && bun run tools/make-skill.ts
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve } from 'node:path';

const TS = resolve(import.meta.dir, '..');            // D:\2026\adb-converter\ts
const OUT = resolve(TS, '../build/adb-skill');        // D:\2026\adb-converter\build\adb-skill
const SRC = join(TS, 'tools/adb-skill');

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const seen = new Set<string>();

function copyModule(file: string): void {
  const abs = resolve(TS, file);
  if (seen.has(abs)) return;
  seen.add(abs);
  if (!existsSync(abs)) { console.warn('MISSING ' + file); return; }
  const dest = join(OUT, file);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(abs, dest);
  const text = readFileSync(abs, 'utf8');
  for (const m of text.matchAll(/(?:from|import)\s+['"](\.[^'"]+)['"]/g)) {
    const spec = m[1];
    const base = normalize(join(dirname(abs), spec));
    const candidates = spec.endsWith('.js')
      ? [base.replace(/\.js$/, '.ts'), base]
      : [base + '.ts', base, join(base, 'index.ts')];
    const hit = candidates.find((c) => existsSync(c));
    if (!hit) { console.warn(`MISSING import ${spec} from ${relative(TS, abs)}`); continue; }
    copyModule(relative(TS, hit).replace(/\\/g, '/'));
  }
}

for (const f of [
  'src/accelon26/adb.ts',
  'src/accelon26/vapa.ts',
  'src/accelon26/search.ts',
  'src/accelon26/query.ts',
  'src/accelon26/variants.ts',
  'src/accelon26/variant-data.ts',
  'src/tokenize.ts',
  'src/unicode.ts',
  'src/dia.ts',
  'src/han.ts',
  'src/xml-entities.ts',
  'src/vendor/bzip2.js',
]) copyModule(f);

// 套件自己的檔案：`../../src/...` → `./src/...`（解開後 src/ 就在旁邊）
for (const f of ['cli.ts', 'engine.ts', 'example.ts']) {
  const text = readFileSync(join(SRC, f), 'utf8').replace(/\.\.\/\.\.\/src\//g, './src/');
  writeFileSync(join(OUT, f), text, 'utf8');
}
copyFileSync(join(SRC, 'README.md'), join(OUT, 'README.md'));

const files = [...seen].map((f) => relative(TS, f).replace(/\\/g, '/')).sort();
console.log('抄了 ' + files.length + ' 個模組：');
for (const f of files) console.log('  ' + f);
console.log('套件：cli.ts engine.ts example.ts README.md');
