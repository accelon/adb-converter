/**
 * 萬用字元掃描引擎（作者 2026-11-01）。語法在 `wildcard-parse.ts`，這裡需要 reader／mapper。
 *
 * 速度：先用 pattern 裡最長那段字的第一個漢字去查 **token 索引**，把 posting 換成
 * source block（`VaPaMapper.blockOfVa`），只解壓那幾個 block 來比對；
 * 沒有可用字才退回全掃。本來就慢，所以提供進度與中斷。
 */
import { AdbReader, BlobIO, type AdbSource } from './adb';
import { SearchSession } from './search';
import { VaPaMapper } from './vapa';
import { activeSlot, catalog, openDbs } from './dbs';
import { resolveDocCtx } from './doc-ctx';
import { stripTags, type WildPattern } from './wildcard-parse';

export * from './wildcard-parse';

/** 每個庫最多記幾種不同的命中字串（超過只計次數，不再新增） */
const MAX_FORMS_PER_DB = 5000;
/* ------------------------------------------------------------------ 掃描 */

export interface WildForm {
  /** 命中的字串（原樣） */
  text: string;
  count: number;
  /** 第一次出現的位置（開庫後跳過去用） */
  dbKey: string;
  dbName: string;
  line: number;
}

export type WildDbState = 'pending' | 'running' | 'done' | 'error' | 'aborted';

export interface WildDbRow {
  key: string;
  name: string;
  file: string;
  hits: number;
  forms: number;
  /** 這個庫掃了幾個 source block */
  blocks: number;
  /** 這個庫總共有幾個 block（沒縮小就＝blocks） */
  totalBlocks: number;
  /** 縮小用了哪個字（沒有就空字串） */
  narrow: string;
  ms: number;
  state: WildDbState;
  error?: string;
}

export interface WildProgress {
  phase: 'idle' | 'scanning' | 'done' | 'aborted';
  db: string;
  dbIndex: number;
  dbTotal: number;
  blocksDone: number;
  blocksTotal: number;
  hits: number;
  forms: number;
  ms: number;
}

export interface WildRun {
  progress: WildProgress;
  dbs: WildDbRow[];
  forms: WildForm[];
}

let run: WildRun = {
  progress: { phase: 'idle', db: '', dbIndex: 0, dbTotal: 0, blocksDone: 0, blocksTotal: 0, hits: 0, forms: 0, ms: 0 },
  dbs: [],
  forms: [],
};
let seq = 0;
let aborted = false;

export const wildState = (): WildRun => run;

/** 隨時中斷（下一個 block 之前就會停） */
export function abortWildSearch(): void {
  aborted = true;
  if (run.progress.phase === 'scanning') run.progress = { ...run.progress, phase: 'aborted' };
}



const newlinesUpTo = (s: string, end: number): number => {
  let n = 0;
  for (let i = 0; i < end && i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
};

/** 一個庫要掃的 block（有字可用就只掃那幾個；沒有就全部） */
async function blocksToScan(
  mapper: VaPaMapper, session: SearchSession | null, narrowChar: string,
): Promise<{ blocks: number[]; total: number; narrow: string }> {
  const total = mapper.sourceBlocks;
  const all: number[] = [];
  for (let b = 0; b < total; b++) all.push(b);
  if (!narrowChar || !session) return { blocks: all, total, narrow: '' };
  try {
    const st = await session.lookup(narrowChar);
    if (!st.postings.length) return { blocks: all, total, narrow: '' };
    const set = new Set<number>();
    for (const va of st.postings) set.add(mapper.blockOfVa(va));
    const blocks = [...set].sort((a, b) => a - b);
    // 太分散就沒有意義（例如「的」出現在每個 block）：留給呼叫端決定要不要全掃
    if (blocks.length > total * 0.6) return { blocks: all, total, narrow: '' };
    return { blocks, total, narrow: narrowChar };
  } catch {
    return { blocks: all, total, narrow: '' };
  }
}

interface DbLike {
  key: string;
  name: string;
  file: string;
  reader: AdbReader;
  mapper: VaPaMapper;
  session: SearchSession;
  /** 暫時開的 reader：用完要關 */
  temp: boolean;
}

/** 開啟（或借用）一個庫來掃 */
async function dbFor(entry: { key: string; name: string; file: AdbSource }): Promise<DbLike> {
  const live = openDbs.find((d) => d.file.name === entry.file.name && d.file.size === entry.file.size);
  const ctx = live ? resolveDocCtx(live.id) : null;
  if (ctx) {
    const session = ctx.session ?? new SearchSession(ctx.reader);
    if (!ctx.session) await session.init();
    return { key: entry.key, name: entry.name, file: entry.file.name, reader: ctx.reader, mapper: ctx.mapper, session, temp: false };
  }
  const reader = await AdbReader.open(new BlobIO(entry.file));
  const mapper = new VaPaMapper(reader);
  await mapper.init();
  const session = new SearchSession(reader);
  await session.init();
  return { key: entry.key, name: entry.name, file: entry.file.name, reader, mapper, session, temp: true };
}

export interface WildOptions {
  /** 'single'＝只掃目前 active 的那一庫；'all'＝掃清單上的每一庫 */
  scope: 'single' | 'all';
  /** 進度回呼（已經節流過，約 8 次/秒） */
  onProgress?: (state: WildRun) => void;
}

/**
 * 開始掃描。回傳結果（同時也留在 `wildState()`）。
 * 再呼叫一次會中止前一輪（`seq`），所以 UI 不必自己處理兩輪交錯。
 */
export async function startWildSearch(pat: WildPattern, opts: WildOptions): Promise<WildRun> {
  if (!pat.ok || !pat.regex) {
    return { ...run, progress: { ...run.progress, phase: 'idle' } };
  }
  const mySeq = ++seq;
  aborted = false;
  const t0 = performance.now();

  // 要掃哪些庫
  const entries: { key: string; name: string; file: AdbSource }[] = [];
  if (opts.scope === 'single') {
    const slot = activeSlot();
    if (slot) entries.push({ key: slot.id + '', name: slot.name, file: slot.file });
  } else {
    for (const e of catalog) entries.push({ key: e.key, name: e.name, file: e.file });
  }
  run = {
    progress: {
      phase: 'scanning', db: '', dbIndex: 0, dbTotal: entries.length,
      blocksDone: 0, blocksTotal: 0, hits: 0, forms: 0, ms: 0,
    },
    dbs: entries.map((e) => ({
      key: e.key, name: e.name, file: e.file.name, hits: 0, forms: 0, blocks: 0, totalBlocks: 0,
      narrow: '', ms: 0, state: 'pending' as WildDbState,
    })),
    forms: [],
  };
  const allForms = new Map<string, WildForm>();
  let totalHits = 0;
  let lastPaint = 0;
  const paint = (force = false): void => {
    const now = performance.now();
    if (!force && now - lastPaint < 120) return;
    lastPaint = now;
    run.progress = { ...run.progress, ms: Math.round(now - t0), hits: totalHits, forms: allForms.size };
    run.forms = [...allForms.values()].sort((a, b) => b.count - a.count || a.text.localeCompare(b.text));
    run.dbs = [...run.dbs];
    opts.onProgress?.(run);
  };
  const maxForms = MAX_FORMS_PER_DB * Math.max(1, entries.length);

  for (let di = 0; di < entries.length; di++) {
    if (mySeq !== seq || aborted) break;
    const row = run.dbs[di];
    row.state = 'running';
    const dbT0 = performance.now();
    let db: DbLike | null = null;
    try {
      db = await dbFor(entries[di]);
      const plan = await blocksToScan(db.mapper, db.session, pat.narrowChar ?? '');
      row.narrow = plan.narrow;
      row.totalBlocks = plan.total;
      run.progress = { ...run.progress, db: row.name, dbIndex: di, blocksDone: 0, blocksTotal: plan.blocks.length };
      paint(true);
      const vaBlocks = db.mapper.blocksVirtualStored;
      let prevBlock = -1;
      let prevText = '';
      let prevFirstLine = 0;
      for (let k = 0; k < plan.blocks.length; k++) {
        if (mySeq !== seq || aborted) { row.state = 'aborted'; break; }
        const b = plan.blocks[k];
        const raw = await db.reader.sourceText(b);
        const { text } = stripTags(raw);
        const firstLine = db.mapper.lineOfVa(vaBlocks[b] ?? 0);
        // 和上一個 block 連著的話，把它的尾巴接上來（跨 block 邊界的命中才不會漏）
        const join = prevBlock === b - 1 ? prevText : '';
        const hay = join + text;
        for (const m of hay.matchAll(pat.regex)) {
          const at = m.index ?? 0;
          const hit = m[0];
          if (!hit) continue;
          // 命中的開頭在前一個 block 的尾巴裡時，行號要用前一個 block 的起點算
          const line = at < join.length
            ? prevFirstLine + newlinesUpTo(join, at)
            : firstLine + newlinesUpTo(text, at - join.length);
          row.hits++;
          totalHits++;
          const cur = allForms.get(hit);
          if (cur) cur.count++;
          else if (allForms.size < maxForms) allForms.set(hit, { text: hit, count: 1, dbKey: row.key, dbName: row.name, line });
        }
        row.blocks++;
        prevBlock = b;
        prevText = text.length > 64 ? text.slice(-64) : text;
        prevFirstLine = firstLine;
        if ((k & 15) === 0) {
          run.progress = { ...run.progress, db: row.name, dbIndex: di, blocksDone: row.blocks, blocksTotal: plan.blocks.length };
          paint();
        }
      }
      if (row.state === 'running') row.state = 'done';
    } catch (e) {
      row.state = 'error';
      row.error = String((e as Error)?.message ?? e).slice(0, 120);
    } finally {
      if (db?.temp) { try { db.reader.io.close?.(); } catch { /* 已關 */ } }
      row.ms = Math.round(performance.now() - dbT0);
      // 這個庫有幾種不同的命中字串
      let n = 0;
      for (const f of allForms.values()) if (f.dbKey === row.key) n++;
      row.forms = n;
      run.progress = { ...run.progress, dbIndex: di + 1, blocksDone: 0, blocksTotal: 0 };
      paint(true);
    }
  }

  const stopped = aborted || mySeq !== seq;
  run.progress = { ...run.progress, phase: stopped ? 'aborted' : 'done', ms: Math.round(performance.now() - t0) };
  paint(true);
  return run;
}
