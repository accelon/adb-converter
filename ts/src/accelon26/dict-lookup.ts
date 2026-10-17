/**
 * 詞典查詢（作者 2026-10）
 *
 * 詞典型 adb（`<集 c="… isdict …">` 或宣告 `$詞`／`$字` 的樹）的詞條名稱有一張現成的
 * **名稱表**（`caches/<詞>`，`reader.cachedStrings(tag)`），與 `tags` 容器的實例 VA
 * 一一對應 —— 所以不必掃本文就能做二分搜尋。
 *
 * 使用方式：
 *   1. `dictLookup(text)`：把游標所在位置往後抓到標點為止的一句話，對每個詞典型 adb
 *      用**開頭模式**（二分搜尋）找出「這句話的前綴剛好是一個詞條」的所有詞條，
 *      依詞條長度由長到短排序。
 *   2. `renderEntry(row)`：把某個詞條的正文渲染成 HTML（給右欄「詞典」分頁下半部）。
 *
 * 多個詞典型 adb 會一起查（`openDbs` 之外也包含 catalog 裡還沒打開的）。
 */
import { AdbReader, BlobIO, type AdbSource } from './adb';
import { VaPaMapper } from './vapa';
import { catalog } from './dbs';
import { renderPageBlocks } from './render_accelon3';

export interface DictRow {
  /** catalog key：同一份檔案只建一次索引 */
  key: string;
  db: string;
  label: string;
  va: number;
  vaEnd: number;
}

interface DictIndex {
  key: string;
  db: string;
  tag: string;
  reader: AdbReader;
  mapper: VaPaMapper;
  /** 依 label 排序（UTF-16 code unit；JS `<` 就是這個順序） */
  rows: { label: string; va: number; vaEnd: number }[];
}

const indexes = new Map<string, DictIndex>();
const building = new Map<string, Promise<DictIndex | null>>();
/** 已經確定「不是詞典」的檔（避免每次點字都重開） */
const notDict = new Set<string>();

/**
 * 詞條標籤的候選。作者 2026-10：**有 `$詞`（`<樹 s="$詞">`）就算詞典型**，
 * `c="isdict"` 只是補充 —— 用它當唯一標準會漏掉像佛光大辭典這種沒標 isdict 的庫。
 */
const ENTRY_TAGS = ['詞', '字', '詞條', '字頭'];

/** 從來源前幾行找 `<樹 s="$X">` 宣告的詞條標籤（`$詞`／`$字`…） */
async function declaredEntryTags(mapper: VaPaMapper): Promise<string[]> {
  const out: string[] = [];
  try {
    let head = '';
    for (let i = 0; i < 12; i++) {
      const line = await mapper.lineText(i);
      if (!line) continue;
      head += line + '\n';
      if (i >= 2 && /<樹/.test(head) && /<(書|章|節|詞|字)\b/.test(head)) break;
    }
    for (const m of head.matchAll(/<樹(?:\s[^>]*)?\ss\s*=\s*"\$([^".\s]+)/g)) {
      if (!out.includes(m[1])) out.push(m[1]);
    }
  } catch {
    /* 讀不到就只用候選清單 */
  }
  return out;
}

/**
 * 這個 adb 是不是詞典型？判斷方式：
 *   1. `<樹 s="$詞">`／`<樹 s="$字">` 宣告的詞條標籤（作者：有 `$詞` 就算）
 *   2. 該標籤有一張**現成的名稱表**（`caches/<詞>`），長度與 `tags` 容器的實例數相同
 *      —— 那就是排好序的詞條表（二分搜尋靠它，不必掃本文）
 *   3. 沒有 `$` 宣告時才退回 詞／字／詞條／字頭 的候選清單
 */
async function entryTagOf(
  reader: AdbReader,
  mapper: VaPaMapper,
): Promise<{ tag: string; names: string[]; vas: number[] } | null> {
  const tags = reader.containers.get('tags');
  if (!tags) return null;
  const declared = await declaredEntryTags(mapper);
  const order = [...declared, ...ENTRY_TAGS.filter((t) => !declared.includes(t))];
  for (const tag of order) {
    const ti = tags.names.indexOf(tag);
    if (ti < 0) continue;
    let names: string[] = [];
    try {
      names = await reader.cachedStrings(tag);
    } catch {
      names = [];
    }
    if (names.length < 50) continue;
    const vas = await reader.decodeBlockList('tags', ti);
    if (vas.length !== names.length) continue;
    return { tag, names, vas };
  }
  return null;
}

/** 建一個詞典型 adb 的索引（詞條名稱表 ＋ 對應的 VA），並依名稱排序 */
async function buildIndex(key: string, db: string, file: AdbSource): Promise<DictIndex | null> {
  const reader = await AdbReader.open(new BlobIO(file));
  const mapper = new VaPaMapper(reader);
  await mapper.init();
  const found = await entryTagOf(reader, mapper);
  if (!found) {
    reader.io.close?.();
    return null;
  }
  const { tag, names, vas } = found;
  const rows = names.map((label, i) => ({
    label,
    va: vas[i],
    vaEnd: i + 1 < vas.length ? vas[i + 1] : Math.min(reader.header.maxBlockOffset, vas[i] + 4000),
  }));
  rows.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : a.va - b.va));
  return { key, db, tag, reader, mapper, rows };
}

/** 取得（必要時建立）某個 catalog entry 的詞典索引；不是詞典回 null */
export async function dictIndexOf(key: string): Promise<DictIndex | null> {
  if (indexes.has(key)) return indexes.get(key)!;
  if (notDict.has(key)) return null;
  const pending = building.get(key);
  if (pending) return pending;
  const entry = catalog.find((e) => e.key === key);
  if (!entry) return null;
  const p = (async () => {
    const idx = await buildIndex(key, entry.name, entry.file);
    if (!idx) { notDict.add(key); return null; }
    indexes.set(key, idx);
    return idx;
  })();
  building.set(key, p);
  const out = await p;
  building.delete(key);
  return out;
}

/** 二分搜尋：第一個 label >= text 的索引 */
function lowerBound(rows: { label: string }[], text: string): number {
  let lo = 0, hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].label < text) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/**
 * 開頭模式查詢（作者 2026-10 修正版）：只取**這句話本身的前綴**（由長到短）當詞條名，
 * 不再列出「以整句話開頭」的其他詞條 —— 否則點「般若經」會錯誤地帶出「般若經十喻」
 * 「般若經典」。那些更長的詞條改在使用者**點選某個詞條之後**才提供（`relativesOf()`）。
 */
export async function lookupInIndex(idx: DictIndex, sentence: string, maxPrefix = 16): Promise<DictRow[]> {
  const text = sentence.replace(/\s+/g, '');
  if (!text) return [];
  const out: DictRow[] = [];
  const seen = new Set<number>();
  const push = (r: { label: string; va: number; vaEnd: number }) => {
    if (seen.has(r.va)) return;
    seen.add(r.va);
    out.push({ key: idx.key, db: idx.db, label: r.label, va: r.va, vaEnd: r.vaEnd });
  };
  const top = Math.min(text.length, maxPrefix);
  // 由長到短：`比丘尼戒` → 比丘尼戒／比丘尼／…／比丘（單字也要，康熙字典的詞條就是單字）
  for (let k = top; k >= 1; k--) {
    const prefix = text.slice(0, k);
    const at = lowerBound(idx.rows, prefix);
    if (at < idx.rows.length && idx.rows[at].label === prefix) push(idx.rows[at]);
  }
  // 完全沒有「剛好是前綴」的詞條時，才退回「以這段話開頭」的詞條：
  //   順世（詞典只有「順世外道」）→ 找得到；般若經（詞典有「般若」）→ 不會多列
  //   「般若經十喻」「般若經典」（作者 2026-10 指定的行為）。
  if (!out.length) {
    for (let k = top; k >= 2 && !out.length; k--) {
      const prefix = text.slice(0, k);
      let at = lowerBound(idx.rows, prefix);
      for (let i = 0; i < 30 && at + i < idx.rows.length; i++) {
        const r = idx.rows[at + i];
        if (!r.label.startsWith(prefix)) break;
        push(r);
      }
    }
  }
  // 長的先列；同樣長度時「和句首共同前綴較長」的排前面
  out.sort((a, b) => b.label.length - a.label.length
    || commonPrefix(b.label, text) - commonPrefix(a.label, text)
    || (a.label < b.label ? -1 : 1));
  return out;
}

/** 這個詞條和其他詞條的共同前綴長度（排序用） */
function commonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/**
 * 某一列的「親戚」：作者 2026-10 的兩個分頁
 *   * `start`（開頭）：以這個詞條開頭的其他詞條（般若 → 般若經典、般若經十喻…）
 *   * `end`（結尾）：以這個詞條結尾的其他詞條（…般若）
 * 中間符合的不列（作者指定不用）。
 *
 * 開頭的排序：**共同前綴愈長愈前面**（般若經典／般若經十喻 比 般若二種相 更貼近）。
 */
export function relativesOf(
  idx: DictIndex,
  label: string,
  kind: 'start' | 'end',
  limit = 200,
  context = '',
): { label: string; va: number; vaEnd: number }[] {
  const out: { label: string; va: number; vaEnd: number }[] = [];
  if (!label) return out;
  if (kind === 'start') {
    let at = lowerBound(idx.rows, label);
    for (let i = 0; i < limit + 40 && at + i < idx.rows.length; i++) {
      const r = idx.rows[at + i];
      if (!r.label.startsWith(label)) break;
      if (r.label === label) continue;
      out.push(r);
      if (out.length >= limit) break;
    }
    // 排序：和「點到的那句話」共同前綴較長的先（般若經十喻／般若經典 比 般若二種相
    // 更貼近），其次短的先（細節較少 → 較好掃讀），最後照字典序。
    const ref = context || label;
    out.sort((a, b) => commonPrefix(b.label, ref) - commonPrefix(a.label, ref)
      || a.label.length - b.label.length || (a.label < b.label ? -1 : 1));
    return out;
  }
  // 結尾：沒有反向索引，掃描整個名稱表（353k 條的漢語大詞典約數十毫秒；只收前 limit 筆）
  for (const r of idx.rows) {
    if (r.label !== label && r.label.endsWith(label)) {
      out.push(r);
      if (out.length >= limit) break;
    }
  }
  out.sort((a, b) => a.label.length - b.label.length || (a.label < b.label ? -1 : 1));
  return out;
}

/** 對所有 catalog 裡的詞典型 adb 一起查（多個詞典同時使用時會全部列出） */
export async function dictLookup(sentence: string): Promise<DictRow[]> {
  const rows: DictRow[] = [];
  for (const e of catalog) {
    const idx = await dictIndexOf(e.key);
    if (!idx) continue;
    rows.push(...(await lookupInIndex(idx, sentence)));
  }
  rows.sort((a, b) => b.label.length - a.label.length || (a.label < b.label ? -1 : 1));
  return rows;
}

/** 某個詞條的「開頭／結尾」親戚（跨詞典一起查；作者 2026-10 的第二層清單） */
export function relativesOfRow(row: DictRow, kind: 'start' | 'end', limit = 200, context = ''): DictRow[] {
  const idx = indexes.get(row.key);
  if (!idx) return [];
  return relativesOf(idx, row.label, kind, limit, context)
    .map((r) => ({ key: row.key, db: idx.db, label: r.label, va: r.va, vaEnd: r.vaEnd }));
}

/** 某個詞條本身（給「親戚」清單點選用：它可能不在目前的 rows 裡） */
export function rowOf(key: string, label: string): DictRow | null {
  const idx = indexes.get(key);
  if (!idx) return null;
  const at = lowerBound(idx.rows, label);
  const r = idx.rows[at];
  if (r && r.label === label) return { key, db: idx.db, label: r.label, va: r.va, vaEnd: r.vaEnd };
  return null;
}

/** 把一個詞條的正文渲染成 HTML（右欄「詞典」分頁下半部） */
export async function renderEntry(row: DictRow): Promise<string> {
  const idx = indexes.get(row.key);
  if (!idx) return '';
  const dt = await idx.mapper.docText(row.va, row.vaEnd);
  if (!dt || !dt.lines.length) return '<div class="note">（這個詞條沒有正文）</div>';
  const blocks = renderPageBlocks(dt.lines, dt.lineNumbers, { hardBreaks: true, pageMarks: false });
  return blocks.map((b) => {
    if (b.kind === 'line') return '<div class="docLine"><div class="lineText">' + b.lines[0].html + '</div></div>';
    const tag = b.kind === 'heading' ? 'div' : 'p';
    const cls = b.kind === 'heading' ? 'docPara docParaHeading' : 'docPara';
    const inner = b.lines.map((l) => '<span class="docLine"><span class="lineText">' + l.html + '</span></span>').join('');
    return '<' + tag + ' class="' + cls + '">' + inner + '</' + tag + '>';
  }).join('');
}

/** 診斷／測試：目前建好索引的詞典 */
export function dictIndexState(): { db: string; tag: string; entries: number }[] {
  return [...indexes.values()].map((i) => ({ db: i.db, tag: i.tag, entries: i.rows.length }));
}
