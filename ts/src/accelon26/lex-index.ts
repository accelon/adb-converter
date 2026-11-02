/**
 * `lex.adb` 的詞條解析與「中文反查」索引（2026-11-03）。
 *
 * 刻意**不碰 DOM、不碰 window**：畫面在 `lex-pane.ts`，這裡只有資料，
 * 所以 `ts/test/lex-pane.test.ts` 可以直接吃（bun test，不需要瀏覽器）。
 *
 * lex.adb 的格式（一詞一塊，見 sz `src/decomp/build-lexicon-adb.ts`）：
 *
 *   `<塊 id="w000001" w="dhamma">(dhamma)</塊>`
 *   `3,867 次`
 *   `法`
 *   `詞件：sad + dhamma`／`格位：主 · 属`／`上下文：…`／`PTS：…`／`義項：…`／`詞幹：…`
 *
 * 中文反查＝把「塊 → 次數 → 中文」三段配起來，建 `漢詞 → 巴利候選` 的表；
 * 這是漢語譯本（沒有逐詞語法）選取文字後「查詞」的資料來源。
 */
import type { AdbReader } from './adb';
import { VaPaMapper } from './vapa';

export interface LexEntry {
  word: string;
  count?: string;
  gloss?: string;
  parts?: string;
  cases?: string;
  context?: string;
  pts?: string;
  senses?: string[];
  stem?: string;
}

export interface HanCandidate {
  /** 巴利詞形（lex.adb 的 `塊 w="…"`） */
  word: string;
  /** lex.adb 的「中文」行 */
  gloss: string;
  /** 次數（字串，保留千分位） */
  count: string;
}

const XML_ENT: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function unescapeXml(s: string): string {
  return s.replace(/&(lt|gt|amp|quot|apos);/g, (_all, k: string) => XML_ENT[k] ?? _all);
}

/** 去掉標籤與實體，留純文字（lex.adb 的詞條行都是這種一行一欄的格式）。 */
export function cleanText(s: string): string {
  return unescapeXml(s.replace(/<[^>]*>/g, '')).trim();
}

/** 詞條裡「欄名：」開頭的行；中文釋義是第一個不是欄名的行。 */
const ENTRY_KEYS = ['詞件：', '格位：', '上下文：', 'PTS：', '義項：', '詞幹：', '樣本：', '推估：', '詞族：'];

/** 一個詞條的幾行 → 結構（欄名沒出現就留 undefined；不做猜測）。 */
export function parseLexEntry(lines: string[]): LexEntry {
  const first = cleanText(lines[0] ?? '');
  const entry: LexEntry = { word: first.replace(/^[（(]\s*/, '').replace(/\s*[）)]$/, '').trim() };
  const senses: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    const s = cleanText(lines[i]);
    if (!s) continue;
    let m: RegExpExecArray | null;
    if ((m = /^([\d,]+)\s*次$/.exec(s))) entry.count = m[1];
    else if (s.startsWith('詞件：')) entry.parts = s.slice(3);
    else if (s.startsWith('格位：')) entry.cases = s.slice(3);
    else if (s.startsWith('上下文：')) entry.context = s.slice(4);
    else if (s.startsWith('PTS：')) entry.pts = s.slice(4);
    else if (s.startsWith('義項：')) senses.push(s.slice(3));
    else if (s.startsWith('詞幹：')) entry.stem = s.slice(3);
    else if (!entry.gloss) entry.gloss = s;
  }
  if (senses.length) entry.senses = senses;
  return entry;
}

/** 比對用的漢詞折疊：去掉空白與句讀（選取常帶標點）。 */
export function foldHan(s: string): string {
  return s.replace(/[\s，。、；：·．,.;:!?！？「」『』【】\[\]（）()《》〈〉…—–-]/g, '').trim();
}

const countOf = (s: string): number => Number((s || '').replace(/[^\d]/g, '')) || 0;

/**
 * lex.adb 的行 → 中文反查表（純函式，測試直接吃這個）。
 *
 * 只要「塊 → 次數 → 第一行不是欄名的文字」三段就夠，不必逐塊讀 VA。
 */
export function buildHanIndex(lines: string[]): Map<string, HanCandidate[]> {
  const out = new Map<string, HanCandidate[]>();
  let word = '';
  let count = '';
  let awaitingGloss = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const block = /^<塊(?=[\s>])([^>]*)>/.exec(line);
    if (block) {
      const w = /\bw="([^"]*)"/.exec(block[1])?.[1] ?? '';
      word = w ? cleanText(w) : '';
      count = '';
      awaitingGloss = false;
      continue;
    }
    if (!word) continue;
    const c = /^([\d,]+)\s*次$/.exec(line);
    if (c) { count = c[1]; awaitingGloss = true; continue; }
    if (!awaitingGloss) continue;
    awaitingGloss = false;
    if (ENTRY_KEYS.some((k) => line.startsWith(k))) continue;   // 沒有中文釋義
    const gloss = cleanText(line);
    if (!gloss) continue;
    const key = foldHan(gloss);
    if (!key) continue;
    const list = out.get(key);
    if (list) list.push({ word, gloss, count });
    else out.set(key, [{ word, gloss, count }]);
  }
  return out;
}

const hanIndexCache = new WeakMap<AdbReader, Promise<Map<string, HanCandidate[]>>>();

/**
 * 建中文反查表：lex.adb 的 source 是**沒有換行的連續文字**（行界在 `lines` 容器裡），
 * 所以要用 `VaPaMapper.lineText()` 一行一行取，不能對 source 直接 `split('\n')`。
 * 74,219 塊／360,797 行，第一次約幾秒；同一個 reader 只做一次。
 */
export function hanIndex(r: AdbReader): Promise<Map<string, HanCandidate[]>> {
  let p = hanIndexCache.get(r);
  if (!p) {
    p = (async () => {
      const m = new VaPaMapper(r);
      await m.init();
      const n = m.lineCount;
      const lines: string[] = new Array(n);
      for (let i = 0; i < n; i++) lines[i] = await m.lineText(i);
      return buildHanIndex(lines);
    })();
    hanIndexCache.set(r, p);
  }
  return p;
}

/** 漢詞 → 候選（先整段相同，再子字串；都依次數排序）。 */
export function hanCandidates(index: Map<string, HanCandidate[]>, han: string, limit = 40): HanCandidate[] {
  const key = foldHan(han);
  if (!key) return [];
  const exact = index.get(key);
  if (exact?.length) return [...exact].sort((a, b) => countOf(b.count) - countOf(a.count));
  const out: HanCandidate[] = [];
  for (const [k, list] of index) {
    // 釋義含選取（選取比釋義短，例如選「呵责」找「呵责羯磨」）
    if (k.includes(key)) { out.push(...list); continue; }
    // 選取含釋義（選取帶了前後字，例如選「呵责羯磨品」）：單字釋義太容易誤中（的／中／不…），
    // 只在釋義 ≥ 2 字時才走這條，否則任意長選取都會冒出幾十個不相干的詞。
    if (k.length >= 2 && key.includes(k)) out.push(...list);
  }
  return out.sort((a, b) => countOf(b.count) - countOf(a.count)).slice(0, limit);
}
