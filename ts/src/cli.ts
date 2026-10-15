#!/usr/bin/env bun
/**
 * abx - Accelon3 .adb exporter (TypeScript/Bun prototype)
 *
 *   abx export  [options] <file.adb|dir> ...
 *   abx analyze [--deep] [--top N] <file.adb> ...
  abx inspect <file.adb> ...
 *   abx bench   [options] <file.adb> ...
 */
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DecodePool, defaultJobs } from './pool';
import { exportAdb, inspectAdb } from './export';
import { analyzeAdb } from './analyze';
import { FORMAT_NAMES, BO_NAMED, BO_SORTED, BO_WITH_POINTER, FORMAT_MASK } from './format';
import type { DecoderKind } from './bz2';

const VERSION = '0.1.0';

interface Flags {
  out?: string;
  all: boolean;
  stdout: boolean;
  jobs?: number;
  fileJobs: number;
  decoder: DecoderKind;
  chunkMib: number;
  windowFactor: number;
  noOverwrite: boolean;
  quiet: boolean;
  json: boolean;
  progress: boolean;
  iters: number;
  top: number;
  deep: boolean;
  write?: string;
  discard: boolean;
  text: string;
  help: boolean;
}

const DEFAULTS: Flags = {
  all: false,
  stdout: false,
  fileJobs: 1,
  decoder: 'auto',
  chunkMib: 8,
  windowFactor: 2,
  noOverwrite: false,
  quiet: false,
  json: false,
  progress: true,
  iters: 3,
  top: 15,
  deep: false,
  discard: false,
  text: 'delphi',
  help: false,
};

function parseArgs(args: string[]): { flags: Flags; inputs: string[] } {
  const flags: Flags = { ...DEFAULTS };
  const inputs: string[] = [];
  const need = (i: number, name: string) => {
    if (i + 1 >= args.length) throw new Error(`${name} needs a value`);
    return args[i + 1];
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const eq = a.indexOf('=');
    const key = a.startsWith('--') && eq > 0 ? a.slice(0, eq) : a;
    const inline = a.startsWith('--') && eq > 0 ? a.slice(eq + 1) : undefined;
    const value = (name: string) => (inline !== undefined ? inline : need(i++, name));
    switch (key) {
      case '-o': case '--out': flags.out = value(key); break;
      case '--all': flags.all = true; break;
      case '--stdout': flags.stdout = true; break;
      case '-j': case '--jobs': flags.jobs = Number(value(key)); break;
      case '--file-jobs': flags.fileJobs = Number(value(key)); break;
      case '--decoder': flags.decoder = value(key) as DecoderKind; break;
      case '--chunk-mib': flags.chunkMib = Number(value(key)); break;
      case '--window': flags.windowFactor = Number(value(key)); break;
      case '--no-overwrite': flags.noOverwrite = true; break;
      case '-q': case '--quiet': flags.quiet = true; break;
      case '--json': flags.json = true; break;
      case '--no-progress': flags.progress = false; break;
      case '--top': flags.top = Number(value(key)); break;
      case '--deep': flags.deep = true; break;
      case '--iters': flags.iters = Number(value(key)); break;
      case '--write': flags.write = value(key); break;
      case '--discard': flags.discard = true; break;
      case '--text':
        flags.text = value(key);
        if (flags.text !== 'delphi' && flags.text !== 'adbjs') throw new Error('--text must be delphi or adbjs');
        break;
      case '-h': case '--help': flags.help = true; break;
      case '-v': case '--version': console.log(VERSION); process.exit(0); break;
      default:
        if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
        inputs.push(a);
    }
  }
  return { flags, inputs };
}

function expandInputs(inputs: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && /\.adb$/i.test(e.name)) out.push(p);
    }
  };
  for (const input of inputs) {
    const p = resolve(input);
    if (!existsSync(p)) throw new Error(`no such file or directory: ${input}`);
    if (statSync(p).isDirectory()) walk(p);
    else out.push(p);
  }
  return out;
}

const fmtBytes = (n: number) => {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MiB`;
  return `${(n / 1073741824).toFixed(2)} GiB`;
};

function usage(): void {
  console.log(`abx ${VERSION} - export Accelon3 .adb databases to XML

usage:
  abx export  [options] <file.adb | directory> ...
  abx analyze [--deep] [--top N] <file.adb> ...
  abx inspect <file.adb> ...
  abx bench   [options] <file.adb> ...

export options:
  -o, --out <dir>      output directory (default: next to each input file)
      --all            also extract the resources container
      --stdout         write the XML to stdout (single file output only)
  -j, --jobs <n>       decoder threads per file (default: ${defaultJobs()})
      --file-jobs <n>  files processed in parallel (default: 1)
      --decoder <kind> auto | ffi | js   (default: auto)
      --chunk-mib <n>  MiB of compressed data per work chunk (default: 8)
      --window <n>     chunks in flight per worker (default: 2)
      --no-overwrite   refuse to replace existing output files
  -q, --quiet          no progress, only errors
      --json           machine readable summary on stdout
  -h, --help           this text
`);
}

async function cmdExport(args: string[]): Promise<number> {
  const { flags, inputs } = parseArgs(args);
  if (flags.help || inputs.length === 0) {
    usage();
    return inputs.length === 0 && !flags.help ? 2 : 0;
  }
  const files = expandInputs(inputs);
  if (files.length === 0) throw new Error('no .adb files found');

  const totalIn = files.reduce((a, f) => a + statSync(f).size, 0);
  const avgIn = totalIn / files.length;
  const cpu = defaultJobs();
  // Workload shape decides where the parallelism goes:
  //   few big files    -> many decode threads inside one file, 1 file at a time
  //   many small files -> several files at once, each with a small read window
  //   tiny batch       -> no threads at all (thread start up costs more than the work)
  const poolSize = Math.max(1, Math.min(flags.jobs ?? (totalIn < 8 * 1048576 ? 1 : cpu), cpu));
  const fileJobs = Math.max(
    1,
    Math.min(flags.fileJobs ?? (files.length > 1 && avgIn < 64 * 1048576 ? cpu : 1), files.length),
  );
  const perFileWindow = Math.max(2, Math.ceil(poolSize / fileJobs) * 2);
  const pool = new DecodePool(poolSize, flags.decoder, poolSize === 1);
  const results: any[] = [];
  const t0 = performance.now();
  // with --stdout the XML goes to stdout, so all chatter must go to stderr
  const say = (...a: unknown[]) => (flags.stdout ? console.error : console.log)(...a);

  if (!flags.quiet && !flags.json) {
    say(`abx ${VERSION}: ${files.length} file(s), ${fmtBytes(totalIn)}, ${poolSize} decoder thread(s), ${fileJobs} parallel file(s)`);
    for (const n of pool.notes) say(`  note: ${n}`);
  }

  let failed = 0;
  const runOne = async (file: string) => {
    const outDir = flags.out ? resolve(flags.out) : dirname(file);
    if (!flags.stdout && !flags.discard) mkdirSync(outDir, { recursive: true });
    try {
      const r = await exportAdb(file, {
        outDir,
        all: flags.all,
        stdout: flags.stdout,
        noOverwrite: flags.noOverwrite,
        chunkBytes: Math.max(1, flags.chunkMib) * 1048576,
        windowFactor: flags.windowFactor,
        window: fileJobs > 1 ? perFileWindow : undefined,
        discard: flags.discard,
        text: flags.text === 'adbjs' ? 'adbjs' : 'delphi',
        progress: flags.progress && !flags.quiet && !flags.json,
        pool,
      });
      results.push(r);
      if (!flags.quiet && !flags.json) {
        const outs = [...r.xmlFiles, ...r.resourceFiles].map((f) => `${f.name} (${fmtBytes(f.bytes)})`).join(', ');
        say(
          `  ${r.header.dbname}: ${r.lines} lines, ${fmtBytes(r.textBytes)} text -> ${outs} in ${(r.ms / 1000).toFixed(2)}s ` +
            `[${(r.inBytes / 1048576 / (r.ms / 1000)).toFixed(1)} MiB/s in]`,
        );
      }
      for (const w of r.warnings) if (!flags.quiet) console.error(`  warning: ${w}`);
    } catch (e) {
      failed++;
      console.error(`  error: ${file}: ${(e as Error).message}`);
    }
  };

  // simple file level fan out, all files share the one decoder pool
  let cursor = 0;
  await Promise.all(
    Array.from({ length: fileJobs }, async () => {
      while (cursor < files.length) {
        const file = files[cursor++];
        await runOne(file);
      }
    }),
  );
  await pool.destroy();

  const ms = performance.now() - t0;
  const stats = {
    version: VERSION,
    files: files.length,
    failed,
    inBytes: totalIn,
    outBytes: results.reduce((a, r) => a + r.outBytes + r.resourceFiles.reduce((b, f) => b + f.bytes, 0), 0),
    lines: results.reduce((a, r) => a + r.lines, 0),
    ms: Math.round(ms),
    jobs: poolSize,
    fileJobs,
    peakRss: process.memoryUsage().rss,
    results,
  };
  if (flags.json) say(JSON.stringify(stats, null, 2));
  else if (!flags.quiet) {
    say(
      `total: ${files.length - failed}/${files.length} ok, ${fmtBytes(stats.inBytes)} in, ${fmtBytes(stats.outBytes)} out, ` +
        `${(ms / 1000).toFixed(2)}s, ${(stats.inBytes / 1048576 / (ms / 1000)).toFixed(1)} MiB/s, peak RSS ${fmtBytes(stats.peakRss)}`,
    );
  }
  return failed > 0 ? 1 : 0;
}

async function cmdAnalyze(args: string[]): Promise<number> {
  const { flags, inputs } = parseArgs(args);
  if (flags.help || inputs.length === 0) {
    usage();
    return inputs.length === 0 && !flags.help ? 2 : 0;
  }
  const files = expandInputs(inputs);
  const metas = [];
  for (const file of files) {
    const meta = analyzeAdb(file, { deep: flags.deep, top: flags.top });
    metas.push(meta);
    if (flags.json) continue;
    const h = meta.header;
    const pct = (a: number, b: number) => (b ? ((a / b) * 100).toFixed(1) + '%' : '-');
    console.log(`\n=== ${file}`);
    console.log(`  size ${fmtBytes(meta.size)}   ${meta.ms.toFixed(0)} ms`);
    console.log(`  dbname ${h.dbname}   dbcname ${h.dbcname}`);
    console.log(`  dbtype ${h.dbType}${h.isDictionary ? ' (dictionary)' : ''}${h.dbType & 4 ? ' (hidden)' : ''}  compression ${h.compression}  protection ${h.protection}  features ${h.features}  version ${h.version}`);
    console.log(`  srcblocksize ${h.srcBlockSize}  linecount ${h.lineCount}  tagcount ${h.tagCount}  maxblockoffset ${h.maxBlockOffset}  tokencount ${h.tokenCount}  crc32 ${h.crc32}`);
    console.log(`  containers:`);
    for (const c of meta.containers) {
      console.log(`    ${c.name.padEnd(18)} ${String(c.blocks).padStart(8)} blocks  ${fmtBytes(c.dataBytes).padStart(11)}${c.named ? '  named' : ''}${c.sampleNames.length ? '  e.g. ' + c.sampleNames.join(', ') : ''}`);
    }
    const t = meta.text;
    console.log(`  text: ${t.blocks} blocks, ${fmtBytes(t.compressedBytes)} compressed, ${fmtBytes(t.textBytes)} text (${t.chars.toLocaleString()} chars), last block ${t.lastBlockBytes} B${flags.deep ? `, non-full blocks ${t.blocksNotFull}` : ''}`);
    console.log(`  tables: lines.physical ${meta.tables.linesPhysical}  lines.virtual ${meta.tables.linesVirtual}  blocks.virtual ${meta.tables.blocksVirtual}  tags.virtual ${meta.tables.tagsVirtual}  doclengths ${meta.tables.docLengths}`);
    const tk = meta.tokens;
    console.log(`  tokens: ${tk.distinct} distinct, ${tk.totalHits.toLocaleString()} hits  (avg ${(tk.totalHits / Math.max(1, tk.distinct)).toFixed(2)})`);
    console.log(`    by length: ${tk.byLength.map((b) => `${b.len}:${b.distinct}(${b.hits})`).join('  ')}`);
    console.log(`    unigram: ${tk.unigram.distinct} distinct, ${tk.unigram.hits.toLocaleString()} hits, coverage ${pct(tk.unigram.hits, tk.totalHits)}  [cjk ${tk.unigramClasses.cjk} ascii ${tk.unigramClasses.ascii} digit ${tk.unigramClasses.digit} other ${tk.unigramClasses.other}]`);
    console.log(`    top: ${tk.top.map((x) => `${x.token}=${x.hits}`).join('  ')}`);
    if (tk.longest.length) console.log(`    longest: ${tk.longest.slice(0, 6).map((x) => `${x.token}(${x.hits})`).join('  ')}`);
    if (meta.collection) {
      const c2 = meta.collection;
      const titles = c2.sample.map((x) => x.name || '(unnamed)').join(' | ');
      console.log(`  collection: ${c2.tag} = ${c2.count} -> ${titles}`);
    }
    if (meta.documents) {
      const d = meta.documents;
      const titles = d.sample.map((x) => `${x.n}:${x.name || '(unnamed)'}`).join('  ');
      console.log(`  documents: ${d.tag} = ${d.count.toLocaleString()} (named: ${d.named})`);
      if (d.sample.length) console.log(`    e.g. ${titles}`);
    }
    console.log(`  tags: ${meta.tags.length} distinct -> ${meta.tags.slice(0, 12).map((x) => `${x.name}=${x.hits}`).join('  ')}`);
    const r = meta.resources;
    console.log(`  resources: ${r.count} files, ${fmtBytes(r.bytes)}  images ${r.images} (${fmtBytes(r.imageBytes)}, ${pct(r.imageBytes, r.bytes)})`);
    if (r.byExtension.length) console.log(`    ext: ${r.byExtension.slice(0, 8).map((e) => `${e.ext}:${e.count}(${fmtBytes(e.bytes)})`).join('  ')}`);
    for (const w of meta.warnings) console.error(`  warning: ${w}`);
  }
  if (flags.json) console.log(JSON.stringify(metas.length === 1 ? metas[0] : metas, null, 2));
  return 0;
}

async function cmdInspect(args: string[]): Promise<number> {
  const { flags, inputs } = parseArgs(args);
  if (inputs.length === 0) {
    usage();
    return 2;
  }
  for (const file of expandInputs(inputs)) {
    const info = inspectAdb(file);
    const h = info.header;
    console.log(`${file}  (${fmtBytes(statSync(file).size)})`);
    console.log(`  dbname      ${JSON.stringify(h.dbname)}  dbcname ${JSON.stringify(h.dbcname)}`);
    console.log(`  version ${h.version}  compression ${h.compression}  features ${h.features}  protection ${h.protection}  crc32 ${h.crc32}`);
    console.log(`  srcblocksize ${h.srcBlockSize}  linecount ${h.lineCount}  tagcount ${h.tagCount}  maxblockoffset ${h.maxBlockOffset}  andtagid ${h.andTagId}`);
    console.log(`  dbtype ${h.dbType} (dictionary: ${h.isDictionary})`);
    const describe = (label: string, bs: typeof info.outer | null) => {
      if (!bs) return;
      const flagsTxt = [
        bs.feature & BO_WITH_POINTER ? 'withpointer' : '',
        bs.feature & BO_SORTED ? 'sorted' : '',
        bs.feature & BO_NAMED ? 'named' : '',
        FORMAT_NAMES[bs.feature & FORMAT_MASK] ?? '?',
      ].filter(Boolean).join(',');
      console.log(
        `  ${label.padEnd(10)} @${bs.start} blocks=${bs.count} ${bs.lengths ? 'variable' : `fixed(${bs.blockSize})`} bytes=${bs.totalBlockSize} [${flagsTxt}]`,
      );
      if (bs.names.length) console.log(`             names: ${bs.names.join(', ')}`);
    };
    describe('outer', info.outer);
    describe('sources', info.sources);
    describe('tables', info.tables);
    describe('resources', info.resources);
    if (info.lineEnds.length) {
      const last = info.lineEnds[info.lineEnds.length - 1];
      console.log(`  lines.physical ${info.lineEnds.length} entries, last end offset ${last} bytes (${last / 2} chars)`);
    }
  }
  return 0;
}

async function cmdBench(args: string[]): Promise<number> {
  const { flags, inputs } = parseArgs(args);
  if (inputs.length === 0) {
    usage();
    return 2;
  }
  const files = expandInputs(inputs);
  const jobs = Math.max(1, flags.jobs ?? defaultJobs());
  const jobList = [1, Math.max(1, Math.floor(jobs / 4)), Math.max(1, Math.floor(jobs / 2)), jobs]
    .filter((v, i, a) => a.indexOf(v) === i)
    .sort((a, b) => a - b);
  console.log(`abx bench: decoder=${flags.decoder} chunk=${flags.chunkMib}MiB iterations=${flags.iters}`);
  for (const j of jobList) {
    const pool = new DecodePool(j, flags.decoder);
    let best = Infinity;
    let bytes = 0;
    let peak = 0;
    for (let it = 0; it < flags.iters; it++) {
      let inBytes = 0;
      const t0 = performance.now();
      for (const file of files) {
        const r = await exportAdb(file, {
          outDir: flags.write ?? '.',
          discard: !flags.write,
          chunkBytes: Math.max(1, flags.chunkMib) * 1048576,
          windowFactor: flags.windowFactor,
          pool,
        });
        inBytes += r.inBytes;
        peak = Math.max(peak, process.memoryUsage().rss);
      }
      const ms = performance.now() - t0;
      best = Math.min(best, ms);
      bytes = inBytes;
    }
    console.log(
      `  jobs=${String(j).padStart(3)}  best ${best.toFixed(1)} ms  ->  ${(bytes / 1048576 / (best / 1000)).toFixed(1)} MiB/s in  peak RSS ${fmtBytes(peak)}`,
    );
    await pool.destroy();
  }
  return 0;
}

const [cmd, ...rest] = process.argv.slice(2);
try {
  const code =
    cmd === 'export' ? await cmdExport(rest)
    : cmd === 'inspect' ? await cmdInspect(rest)
    : cmd === 'analyze' ? await cmdAnalyze(rest)
    : cmd === 'bench' ? await cmdBench(rest)
    : cmd === 'version' ? (console.log(VERSION), 0)
    : (usage(), cmd === undefined || cmd === 'help' ? 0 : 2);
  process.exit(code);
} catch (e) {
  console.error(`abx: ${(e as Error).message}`);
  process.exit(1);
}
