/**
 * adb-skill：不需要 UI 的 .adb 讀取／搜尋 CLI。
 *
 *   adb-skill list                    列出同目錄的 .adb
 *   adb-skill info   <db>             檔頭、容器、詞數、行數、文件數
 *   adb-skill toc    <db> [--json]    目錄樹（縮排；附 VA 範圍）
 *   adb-skill search <db> <query>     全文搜尋（空白＝AND；連寫＝詞組）
 *                    [-n 20] [--json] [--context 0]
 *   adb-skill show   <db> <from>[-<to>] [--raw]   印某幾行（預設去標籤）
 *   adb-skill text   <db> [--from N] [--to M] [--raw]
 *   adb-skill export <db> -o <dir>    每一檔一份純文字
 *
 * `<db>` 可以寫 `13j`（找同目錄的 13j.adb）或直接給路徑。
 * 行號與閱讀器一致（0 起算，狀態列「行 N」就是這個 N）。
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { AdbReader, SyncIO } from '../../src/accelon26/adb';
import { VaPaMapper } from '../../src/accelon26/vapa';
import { SearchSession, loadTrees, loadTree } from '../../src/accelon26/search';

const argv = process.argv.slice(2);
/** `-n 3`／`--json`／`--from 10`：選項與值分開收，其餘照順序當位置參數 */
const opts = new Map<string, string>();
const positional: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i] ?? '';
  if (a.startsWith('-')) {
    const name = a.replace(/^--?/, '');
    const v = argv[i + 1];
    if (v !== undefined && !v.startsWith('-')) { opts.set(name, v); i++; } else { opts.set(name, '1'); }
    continue;
  }
  positional.push(a);
}
const cmd = positional.shift() ?? 'help';
const rest: string[] = [];
const flag = (name: string): string | undefined => opts.get(name);
const has = (name: string): boolean => opts.has(name);
const jsonOut = has('json');
const RAW = has('raw');

/** 去掉標籤、解 XML 實體（`--raw` 時不動） */
const plain = (s: string): string => s
  .replace(/<[^>]*>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&amp;/g, '&');

function resolveDb(name: string): string {
  if (!name) throw new Error('要指定資料庫（例：adb-skill search 13j 涅槃）');
  if (existsSync(name)) return resolve(name);
  const withExt = name.endsWith('.adb') ? name : name + '.adb';
  if (existsSync(withExt)) return resolve(withExt);
  throw new Error(`找不到資料庫：${name}（同目錄要有 ${withExt}）`);
}

async function openDb(name: string): Promise<{ reader: AdbReader; mapper: VaPaMapper; file: string }> {
  const file = resolveDb(name);
  const reader = await AdbReader.open(new SyncIO(file));
  const mapper = new VaPaMapper(reader);
  await mapper.init();
  return { reader, mapper, file };
}

const fmt = (n: number): string => n.toLocaleString('en-US');

function usage(): void {
  console.log(`adb-skill — .adb 讀取／搜尋 CLI（不需要 UI）

  adb-skill list                     列出同目錄的 .adb
  adb-skill info   <db>              檔頭、容器、詞數、行數、文件數
  adb-skill toc    <db> [--json]     目錄樹（縮排＋VA 範圍）
  adb-skill search <db> <query>      全文搜尋（空白＝AND，連寫＝詞組）
                   [-n 20] [--json] [--context 0]
  adb-skill show   <db> <from>[-<to>] [--raw]
  adb-skill text   <db> [--from N] [--to M] [--raw]
  adb-skill export <db> -o <dir>     每一檔一份純文字

  <db> 可寫 13j（找 13j.adb）或直接給路徑。行號與閱讀器一致（0 起算）。`);
}

async function main(): Promise<void> {
  switch (cmd) {
    case 'list': {
      const files = readdirSync(process.cwd()).filter((f) => /\.adb$/i.test(f)).sort();
      if (jsonOut) { console.log(JSON.stringify(files)); return; }
      if (!files.length) { console.log('（這個資料夾沒有 .adb）'); return; }
      for (const f of files) console.log(f);
      return;
    }
    case 'info': {
      const { reader, file } = await openDb(positional[0] ?? '');
      const h = reader.header;
      const info = {
        file: basename(file),
        dbname: h.dbname,
        dbcname: h.dbcname,
        lines: h.lineCount,
        maxVA: h.maxBlockOffset,
        tags: (reader.containers.get('tags')?.names ?? []).filter((n) => !n.startsWith('/')).length,
        docs: (await reader.documents()).length,
        resources: reader.containers.get('resources')?.count ?? 0,
        containers: reader.order,
      };
      if (jsonOut) { console.log(JSON.stringify(info, null, 2)); return; }
      for (const [k, v] of Object.entries(info)) console.log(`${k.padEnd(11)} ${Array.isArray(v) ? v.join(', ') : v}`);
      return;
    }
    case 'toc': {
      const { reader, mapper } = await openDb(positional[0] ?? '');
      const trees = await loadTrees(reader);
      if (!trees.length) { console.log('（這個庫沒有 <樹> 宣告）'); return; }
      const nodes = (await loadTree(reader, trees[0])) as unknown as {
        depth?: number; tag: string; label?: string; va: number; vaEnd: number;
      }[];
      // loadTree 不算標籤文字（閱讀器是畫到哪一列才解）；這裡用「該節點起始行去掉標籤」補。
      const labelCache = new Map<number, string>();
      const labelOf = async (n: { tag: string; va: number; label?: string }): Promise<string> => {
        if (n.label) return n.label;
        const hit = labelCache.get(n.va);
        if (hit !== undefined) return hit;
        const line = mapper.edgeLine(n.va);
        const raw = await mapper.lineText(line);
        let t = raw.replace(new RegExp('^\\s*<' + n.tag + '(?=[\\s>])[^>]*>'), '');
        const close = t.indexOf('</' + n.tag + '>');
        if (close >= 0) t = t.slice(0, close);
        const out = plain(t).trim();
        labelCache.set(n.va, out);
        return out;
      };
      const rows = [];
      for (const n of nodes) {
        rows.push({ depth: n.depth ?? 0, tag: n.tag, label: await labelOf(n), va: n.va, vaEnd: n.vaEnd });
      }
      if (jsonOut) { console.log(JSON.stringify(rows, null, 2)); return; }
      for (const r of rows) console.log(`${'  '.repeat(r.depth)}${r.tag} ${r.label}  [va ${r.va}…${r.vaEnd}]`);
      return;
    }
    case 'search': {
      const db = positional[0] ?? '';
      const query = positional.slice(1).join(' ').trim();
      if (!query) throw new Error('search 需要查詢字串（例：adb-skill search 13j 涅槃）');
      const limit = Number(flag('n') ?? 20);
      const ctx = Number(flag('context') ?? 0);
      const { reader, mapper } = await openDb(db);
      const s = new SearchSession(reader);
      await s.init();
      const res = await s.search(query, 5000);
      // 同一行可能有多個命中位置（詞組在行內出現多次）：只留第一筆，行號才不會重複
      const seen = new Set<number>();
      const hits: { va: number; line: number; text: string }[] = [];
      for (const h of res.hits) {
        const line = mapper.edgeLine(h.va);
        if (seen.has(line)) continue;
        seen.add(line);
        hits.push({ va: h.va, line, text: plain(await mapper.lineText(line)) });
        if (hits.length >= limit) break;
      }
      if (jsonOut) {
        console.log(JSON.stringify({ query, total: res.hits.length, truncated: res.truncated, missing: res.missing, ms: Math.round(res.ms), hits }, null, 2));
        return;
      }
      console.log(`「${query}」命中 ${fmt(res.hits.length)}${res.truncated ? '+' : ''} 筆（${Math.round(res.ms)} ms）`);
      if (res.missing.length) console.log(`索引裡沒有：${res.missing.join('、')}`);
      for (const h of hits) {
        console.log(`\n[行 ${h.line}] ${h.text}`);
        for (let k = Math.max(0, h.line - ctx); k <= h.line + ctx; k++) {
          if (k !== h.line) console.log(`  ${k}: ${plain(await mapper.lineText(k))}`);
        }
      }
      return;
    }
    case 'show': {
      const db = positional[0] ?? '';
      const m = /^(\d+)(?:-(\d+))?$/.exec(positional[1] ?? '');
      if (!m) throw new Error('show 需要 行號 或 起-迄（例：103 或 103-110）');
      const from = Number(m[1]);
      const to = m[2] ? Number(m[2]) : from;
      const { mapper } = await openDb(db);
      for (let i = from; i <= to; i++) {
        const raw = await mapper.lineText(i);
        console.log(RAW ? raw : plain(raw));
      }
      return;
    }
    case 'text': {
      const { reader, mapper } = await openDb(positional[0] ?? '');
      const total = reader.header.lineCount;
      const from = Math.max(0, Number(flag('from') ?? 0));
      const to = Math.min(total - 1, Number(flag('to') ?? total - 1));
      for (let i = from; i <= to; i++) {
        const raw = await mapper.lineText(i);
        console.log(RAW ? raw : plain(raw));
      }
      return;
    }
    case 'export': {
      const db = positional[0] ?? '';
      const out = flag('o');
      if (!out) throw new Error('export 需要 -o <dir>');
      const { reader, mapper, file } = await openDb(db);
      const dir = resolve(out);
      mkdirSync(dir, { recursive: true });
      const name = basename(file).replace(/\.adb$/i, '');
      const dump = async (from: number, to: number): Promise<string[]> => {
        const lines: string[] = [];
        for (let i = from; i <= to && i < reader.header.lineCount; i++) lines.push(plain(await mapper.lineText(i)));
        return lines;
      };
      const docs = await reader.documents();
      if (!docs.length) {
        const target = join(dir, name + '.txt');
        const lines = await dump(0, reader.header.lineCount - 1);
        writeFileSync(target, lines.join('\n') + '\n', 'utf8');
        console.log(`→ ${target}（${fmt(lines.length)} 行）`);
        return;
      }
      for (const d of docs) {
        const first = Math.max(0, mapper.edgeLine(d.vaStart));
        const last = Math.max(first, mapper.edgeLine(Math.max(d.vaStart, d.vaEnd - 1)));
        const target = join(dir, `${name}.${String(d.i).padStart(2, '0')}-${d.name.replace(/[\\/:*?"<>|]/g, '_')}.txt`);
        const lines = await dump(first, last);
        writeFileSync(target, lines.join('\n') + '\n', 'utf8');
        console.log(`→ ${target}（${fmt(lines.length)} 行）`);
      }
      return;
    }
    default:
      usage();
  }
}

main().catch((e) => {
  console.error('錯誤：' + (e as Error).message);
  process.exit(1);
});
