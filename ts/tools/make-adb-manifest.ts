/**
 * 產生公開資料庫的更新清單 `www/adb/manifest.json` **與版本歷史**
 * `deploy/adb-history.json`（作者 2026-10-29：adb 也像 exe 一樣維護版本）。
 *
 *   cd ts && bun run tools/make-adb-manifest.ts
 *   bun run tools/make-adb-manifest.ts --allow-empty-notes   # 緊急：允許沒有說明
 *
 * 每一筆 adb 在清單裡有：
 *   file／name／size／sha256／buildTime（檔案建置時間）／notes（這一版改了什麼）
 *   history：**由新到舊**的每一次建置（buildTime＋sha256＋size＋notes）
 *
 * 版本識別用 sha256：同一個 sha 就是同一版；重建出不同內容就是新的一版。
 * 新版本**必須**在 `deploy/adb-notes.json` 有對應 sha 的說明，否則這支會失敗
 * （作者要求：讓使用者知道每一次改變）。歷史存在 `deploy/adb-history.json`，
 * 第一次跑會從舊的 `www/adb/manifest.json` 遷移（每一本一版）。
 *
 * 說明檔格式（只放「目前這一版」的說明；歷史已寫進 adb-history.json）：
 *   { "ys.adb": { "sha256": "…", "notes": ["…", "…"] } }
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const opt = (n: string, d = '') => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const ALLOW_EMPTY = args.includes('--allow-empty-notes');

const ROOT = resolve(import.meta.dir, '../..');
const INDEX = resolve(opt('index', resolve(ROOT, 'www/adb/index.txt')));
const ADB_DIR = resolve(opt('adb-dir', resolve(ROOT, 'accelon3')));
const NOTES = resolve(opt('notes', resolve(ROOT, 'deploy/adb-notes.json')));
const HISTORY = resolve(opt('history', resolve(ROOT, 'deploy/adb-history.json')));
const OUT = resolve(opt('out', resolve(ROOT, 'www/adb/manifest.json')));

interface HistEntry { buildTime: string; sha256: string; size: number; notes: string[] }
type History = Record<string, HistEntry[]>;

const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

// ---- 清單 ---------------------------------------------------------------------
const raw = readFileSync(INDEX, 'utf8');
const entries = raw.split(/\r?\n/)
  .map((s) => s.trim())
  .filter((s) => s && !s.startsWith('#'))
  .map((s) => {
    const [file, doc] = s.split(/\t+|\s{2,}/);
    return { file: file.trim(), doc: (doc ?? '').trim() };
  });
// 「不列在頁面、但納入更新」的大檔（deploy/adb-extra.txt）：已有這些檔的 App 會看到更新。
const extraPath = resolve(ROOT, 'deploy/adb-extra.txt');
if (existsSync(extraPath)) {
  for (const line of readFileSync(extraPath, 'utf8').split(/\r?\n/)) {
    const file = line.trim();
    if (!file || file.startsWith('#') || entries.some((e) => e.file.toLowerCase() === file.toLowerCase())) continue;
    entries.push({ file, doc: '' });
  }
}

// ---- 說明（目前這一版）--------------------------------------------------------
let notes: Record<string, { sha256?: string; notes?: string[] }> = {};
// 公開狀態（施工中的庫仍記在 manifest，但不提供下載）
let statuses: Record<string, { status?: string; label?: string; note?: string; source?: string; licenseNote?: string; crossCheck?: string }> = {};
try {
  statuses = JSON.parse(readFileSync(resolve(ROOT, 'deploy/adb-status.json'), 'utf8')) as typeof statuses;
} catch { /* 沒有就全部視為 available */ }
try {
  notes = JSON.parse(readFileSync(NOTES, 'utf8')) as typeof notes;
} catch (e) {
  console.warn('（讀不到 ' + NOTES + '：新版本會沒有說明）');
}

// ---- 歷史：優先讀 adb-history.json；第一次從舊 manifest 遷移 -------------------
let history: History = {};
if (existsSync(HISTORY)) {
  history = JSON.parse(readFileSync(HISTORY, 'utf8')) as History;
  delete (history as Record<string, unknown>)._comment;
} else if (existsSync(OUT)) {
  const old = JSON.parse(readFileSync(OUT, 'utf8')) as {
    dbs?: { file: string; size: number; sha256: string; buildTime?: string; date?: string; notes?: string[] }[];
  };
  for (const db of old.dbs ?? []) {
    if (!db.file || !db.sha256) continue;
    history[db.file] = [{
      buildTime: db.buildTime || (db.date ? db.date + 'T00:00:00Z' : ''),
      sha256: db.sha256,
      size: db.size,
      notes: db.notes ?? [],
    }];
  }
  console.log(`（第一次跑：從 ${OUT.replace(ROOT + '\\', '')} 遷移了 ${Object.keys(history).length} 本的版本記錄）`);
}

// ---- 找本機的 adb（同名取最淺層那一份）----------------------------------------
const local = new Map<string, { path: string; depth: number }>();
const walk = (dir: string, depth: number) => {
  let list;
  try { list = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of list) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { walk(p, depth + 1); continue; }
    if (!/\.adb$/i.test(e.name)) continue;
    const key = e.name.toLowerCase();
    const hit = local.get(key);
    if (!hit || depth < hit.depth) local.set(key, { path: p, depth });
  }
};
if (existsSync(ADB_DIR)) walk(ADB_DIR, 0);
console.log(`清單 ${entries.length} 個；本機 ${ADB_DIR} 找到 ${local.size} 個 .adb`);

const asciiZ = (b: Uint8Array, from: number, to: number) => {
  let s = '';
  for (let i = from; i < to && b[i]; i++) s += String.fromCharCode(b[i]);
  return s.trim();
};
const utf16z = (b: Uint8Array, from: number, to: number) => {
  let s = '';
  for (let i = from; i + 1 < to; i += 2) {
    const cu = b[i] | (b[i + 1] << 8);
    if (!cu) break;
    s += String.fromCharCode(cu);
  }
  return s.trim();
};

const missing: { file: string; sha256: string; size: number }[] = [];
const dbs: Record<string, unknown>[] = [];

for (const e of entries) {
  const hit = local.get(e.file.toLowerCase());
  if (!hit) {
    console.warn(`  ! 本機找不到 ${e.file}（${ADB_DIR}）→ 略過這一筆`);
    continue;
  }
  const st = statSync(hit.path);
  const head = new Uint8Array(await Bun.file(hit.path).slice(0, 256).arrayBuffer());
  const name = utf16z(head, 128, 192) || asciiZ(head, 0, 32) || e.file.replace(/\.adb$/i, '');
  const sha256 = createHash('sha256').update(Buffer.from(await Bun.file(hit.path).arrayBuffer())).digest('hex');
  const buildTime = iso(st.mtimeMs);
  const dd = new Date(st.mtimeMs);
  const date = `${dd.getFullYear()}-${String(dd.getMonth() + 1).padStart(2, '0')}-${String(dd.getDate()).padStart(2, '0')}`;

  const hist = history[e.file] ?? (history[e.file] = []);
  let idx = hist.findIndex((h) => h.sha256?.toLowerCase() === sha256);
  if (idx < 0) {
    const pending = notes[e.file];
    const words = pending && pending.sha256?.toLowerCase() === sha256 ? (pending.notes ?? []) : [];
    if (!words.length && !ALLOW_EMPTY) {
      missing.push({ file: e.file, sha256, size: st.size });
      continue;
    }
    hist.unshift({ buildTime, sha256, size: st.size, notes: words });
    idx = 0;
  } else {
    // 同一版重跑：補上大小；允許把說明改好（sha 沒變，文字可以修）
    hist[idx].size = st.size;
    const pending = notes[e.file];
    if (pending && pending.sha256?.toLowerCase() === sha256 && pending.notes?.length) {
      hist[idx].notes = pending.notes;
    }
    if (!hist[idx].buildTime) hist[idx].buildTime = buildTime;
    if (hist[idx].buildTime.endsWith('T00:00:00Z')) hist[idx].buildTime = buildTime; // 舊清單只有日期
  }
  // 目前這一版一定要排在歷史最前面（回退到舊版時也一樣：最近「發佈」的是它）
  if (idx > 0) {
    const [cur] = hist.splice(idx, 1);
    cur.buildTime = buildTime;
    hist.unshift(cur);
    console.warn(`  ! ${e.file} 目前是舊版內容（回退）→ 移到歷史最前面`);
  }
  if (hist.length > 30) hist.length = 30;

  const latest = hist[0];
  const stt = statuses[e.file] ?? {};
  const status = stt.status || 'available';
  dbs.push({
    file: e.file,
    name,
    size: latest.size,
    sha256: latest.sha256,
    buildTime: latest.buildTime,
    date,
    notes: latest.notes,
    ...(e.doc ? { doc: e.doc } : {}),
    status,
    statusLabel: stt.label || (status === 'available' ? '' : '施工中'),
    statusNote: stt.note || '',
    ...(stt.source ? { source: stt.source } : {}),
    ...(stt.licenseNote ? { licenseNote: stt.licenseNote } : {}),
    ...(stt.crossCheck ? { crossCheck: stt.crossCheck } : {}),
    downloadable: status === 'available',
    large: latest.size > 30 * 1024 * 1024,
    bulkUpdate: latest.size <= 30 * 1024 * 1024,
    history: hist,
  });
  const old = hist.length - 1;
  console.log(`  ${e.file}  ${name}  ${(latest.size / 1048576).toFixed(1)} MB`
    + `  最新 ${latest.buildTime}  ${hist.length} 版${old ? `（含 ${old} 個舊版）` : ''}`);
}

if (missing.length) {
  console.error('\n✗ 有新版沒有說明（作者要求：每一次改變都要讓使用者知道）：');
  for (const m of missing) {
    console.error(`  ${m.file}  sha256 ${m.sha256}  ${m.size} bytes`);
  }
  console.error('\n請在 ' + NOTES.replace(ROOT + '\\', '') + ' 加上對應 sha256 的 notes，');
  console.error('或暫時用 --allow-empty-notes（不建議）。');
  process.exit(1);
}

// ---- 寫歷史與清單 ---------------------------------------------------------------
const histOut: Record<string, unknown> = {
  _comment: '公開資料庫的版本歷史（由 ts/tools/make-adb-manifest.ts 維護；新的在前）。'
    + 'buildTime 是建置時的本機檔案時間，sha256 是那一版的內容。',
};
for (const [file, hist] of Object.entries(history)) if (file !== '_comment') histOut[file] = hist;
writeFileSync(HISTORY, JSON.stringify(histOut, null, 2) + '\n', 'utf8');

const manifest = {
  schema: 2,
  generated: iso(Date.now()),
  dbs,
};
writeFileSync(OUT, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
console.log(`\n寫好 ${OUT.replace(ROOT + '\\', '')}（${dbs.length} 個資料庫、schema 2）`);
console.log(`版本歷史 ${HISTORY.replace(ROOT + '\\', '')}`);
console.log('上傳：cd ts && bun run tools/deploy.ts --site-only');
