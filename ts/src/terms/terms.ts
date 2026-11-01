/**
 * terms.ts — 術語（`<术 sk|pi|tb="外語">漢詞</术>`）的共用機制
 *
 *   import { loadTerms, loadFixes, applyTerms, fixTerms, buildGlossaryRows } from './terms';
 *
 * 為什麼放在 adb-converter：
 *   凡是「中文正文＋梵/巴/藏對照」的庫（ys、fuyan、tx…）都要同一套標記與詞表，
 *   放在這裡才不會每個庫各寫一份、各自漂移。詞表本體是 `data/terms.tsv`
 *   （一行 `漢詞 \t 語言 \t 外語`）與 `data/term-fixes.tsv`（錯→對），
 *   由作者維護；consumer 可以 vendored copy，但 canonical 在這。
 *
 * 兩個動作：
 *   applyTerms() — 給「還沒有 `<术>`」的文字（例：docx 轉出來的標記）自動標注。
 *   fixTerms()   — 給「已經有 `<术>`」的文字（例：CBETA `<foreign>` 轉出來的 ys）修正斷詞：
 *                  前面多包的字搬到標籤外、少包的字從前面補進來（只依 term-fixes.tsv，不猜）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Lang = 'sk' | 'pi' | 'tb';
export interface Term {
  lang: Lang;
  foreign: string;
}

const HAN = /[\u3400-\u9fff\uf900-\ufaff]/;
const TAG_SPLIT = /(<[^>]*>)/;

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_TERMS = resolve(HERE, '../../../data/terms.tsv');
export const DEFAULT_FIXES = resolve(HERE, '../../../data/term-fixes.tsv');

/** 讀詞表：回傳 漢詞 → { lang, foreign } */
export function loadTerms(path = DEFAULT_TERMS): Map<string, Term> {
  const out = new Map<string, Term>();
  if (!existsSync(path)) return out;
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (!raw.trim() || raw.startsWith('#')) continue;
    const [han, lang, foreign] = raw.split('\t');
    if (!han || !foreign) continue;
    if (lang !== 'sk' && lang !== 'pi' && lang !== 'tb') continue;
    out.set(han, { lang, foreign });
  }
  return out;
}

/** 讀明確修正表：回傳 錯的寫法 → 正確寫法 */
export function loadFixes(path = DEFAULT_FIXES): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(path)) return out;
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (!raw.trim() || raw.startsWith('#')) continue;
    const [wrong, right] = raw.split('\t');
    if (wrong && right && wrong !== right) out.set(wrong, right);
  }
  return out;
}

const hanLen = (s: string): number => s.replace(/<[^>]*>/g, '').replace(/[^\u3400-\u9fff\uf900-\ufaff]/g, '').length;

export interface ApplyResult {
  text: string;
  marks: number;
  words: Map<string, number>;
}

/**
 * 自動標注：把文字裡的詞表詞包成 `<术>`。
 * 規則：只在文字片段比對（跳過標籤與 `<聯>…</聯>` 晶片）、最長優先、不重疊。
 */
export function applyTerms(text: string, terms: Map<string, Term>): ApplyResult {
  const maxLen = [...terms.keys()].reduce((m, k) => Math.max(m, k.length), 2);
  const words = new Map<string, number>();
  let marks = 0;
  const out: string[] = [];
  for (const line of text.split('\n')) {
    if (line.includes('<术 ') || line.startsWith('<檔') || line.startsWith('<書') || line.startsWith('<頁')) {
      out.push(line);
      continue;
    }
    const parts = line.split(TAG_SPLIT);
    let inLink = false;
    for (let i = 0; i < parts.length; i++) {
      if (i % 2 === 1) {
        if (parts[i].startsWith('<聯')) inLink = true;
        else if (parts[i].startsWith('</聯')) inLink = false;
        continue;
      }
      if (inLink || !parts[i]) continue;
      const seg = parts[i];
      let res = '';
      for (let j = 0; j < seg.length; ) {
        let hit: string | null = null;
        for (let L = Math.min(maxLen, seg.length - j); L >= 2; L--) {
          const cand = seg.slice(j, j + L);
          if (terms.has(cand) && hanLen(cand) === L) {
            hit = cand;
            break;
          }
        }
        if (hit) {
          const t = terms.get(hit)!;
          res += `<术 ${t.lang}="${t.foreign.replace(/"/g, '&quot;')}">${hit}</术>`;
          words.set(hit, (words.get(hit) ?? 0) + 1);
          marks++;
          j += hit.length;
        } else {
          res += seg[j];
          j += 1;
        }
      }
      parts[i] = res;
    }
    out.push(parts.join(''));
  }
  return { text: out.join('\n'), marks, words };
}

export interface FixResult {
  text: string;
  moved: number;
  extended: number;
  samples: string[];
}

/**
 * 修正既有 `<术>` 的斷詞（只依 term-fixes.tsv）：
 *   多包：`<术 …>得四增上心</术>` → `得<术 …>四增上心</术>`
 *   少包：前面 4 個字是「無所有」、標記是「心三昧」→ `<术 …>無所有心三昧</术>`
 */
export function fixTerms(text: string, terms: Map<string, Term>, fixes: Map<string, string>): FixResult {
  const samples: string[] = [];
  let moved = 0;
  let extended = 0;

  // 1) 多包：錯誤寫法比正確寫法長
  let step1 = text.replace(/<术 (sk|pi|tb)="([^"]*)">([^<]*)<\/术>/g, (whole, lang, foreign, body) => {
    if (body.includes('<')) return whole;
    const right = fixes.get(body);
    if (!right || right.length >= body.length || !terms.has(right)) return whole;
    const prefix = body.slice(0, body.length - right.length);
    const t = terms.get(right)!;
    moved++;
    if (samples.length < 40) samples.push(`多包：${body} → ${prefix} + <${right}>`);
    return `${prefix}<术 ${t.lang}="${t.foreign.replace(/"/g, '&quot;')}">${right}</术>`;
  });

  // 2) 少包：正確寫法比現在長，且前面剛好是缺的那幾個字
  const re = /<术 (sk|pi|tb)="([^"]*)">([^<]*)<\/术>/g;
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(step1))) {
    const [whole, lang, foreign, body] = m;
    const right = fixes.get(body);
    if (right && right.length > body.length) {
      const add = right.length - body.length;
      const start = m.index;
      if (start >= add && step1.slice(start - add, start) === right.slice(0, add)) {
        const t = terms.get(right) ?? { lang: lang as Lang, foreign };
        out += step1.slice(last, start - add) + `<术 ${t.lang}="${t.foreign.replace(/"/g, '&quot;')}">${right}</术>`;
        last = m.index + whole.length;
        extended++;
        if (samples.length < 40) samples.push(`少包：${right.slice(0, add)} + ${body} → ${right}`);
        continue;
      }
    }
    out += step1.slice(last, m.index) + whole;
    last = m.index + whole.length;
  }
  out += step1.slice(last);
  return { text: out, moved, extended, samples };
}

export interface GlossaryRow {
  lang: Lang;
  foreign: string;
  han: string;
  count: number;
  line: number;
  page: string;
  off: number;
  hanline: number;
}

/**
 * 由已標好的文字建 glossary 容器內容（JSON Lines）。
 * 位置以「該頁第幾個漢字」與「該行第幾個漢字」記錄，供閱讀器跳頁；
 * 漢字只算 BMP（與閱讀器 domPosInLine 一致）。
 */
export function buildGlossaryRows(text: string): GlossaryRow[] {
  const map = new Map<string, GlossaryRow>();
  const lines = text.split('\n');
  const starts: number[] = [];
  let acc = 0;
  for (const l of lines) {
    starts.push(acc);
    acc += l.length + 1;
  }
  const lineAt = (pos: number): number => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  type Ev = { pos: number; page?: string; tag?: RegExpExecArray };
  const evs: Ev[] = [];
  const pageRe = /<頁 id="([^"]+)"/g;
  let pm: RegExpExecArray | null;
  while ((pm = pageRe.exec(text))) evs.push({ pos: pm.index, page: pm[1] });
  const tagRe = /<术 (sk|pi|tb)="([^"]*)">([^<]*)<\/术>/g;
  let tm: RegExpExecArray | null;
  while ((tm = tagRe.exec(text))) evs.push({ pos: tm.index, tag: tm });
  evs.sort((a, b) => a.pos - b.pos);

  let page = '';
  let since = 0;
  let last = 0;
  for (const ev of evs) {
    since += hanLen(text.slice(last, ev.pos));
    last = ev.pos;
    if (ev.page) {
      page = ev.page;
      since = 0;
      continue;
    }
    const m = ev.tag!;
    const lang = m[1] as Lang;
    const foreign = m[2].replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
    const han = m[3].replace(/\s+/g, '');
    if (!foreign || !han) continue;
    const key = `${lang}\u0000${foreign}\u0000${han}`;
    const hit = map.get(key);
    if (hit) {
      hit.count++;
      continue;
    }
    const li = lineAt(ev.pos);
    map.set(key, {
      lang,
      foreign,
      han,
      count: 1,
      line: li + 1,
      page,
      off: since,
      hanline: hanLen(text.slice(starts[li], ev.pos)),
    });
  }
  const order: Record<string, number> = { sk: 0, pi: 1, tb: 2 };
  return [...map.values()].sort(
    (a, b) => (order[a.lang] ?? 9) - (order[b.lang] ?? 9) || a.han.localeCompare(b.han) || a.foreign.localeCompare(b.foreign),
  );
}

/** glossary 容器的 JSON Lines（第一行是 `["GLOSSARY1", n]`） */
export function glossaryLines(rows: GlossaryRow[]): string[] {
  const out = [JSON.stringify(['GLOSSARY1', rows.length])];
  for (const r of rows) out.push(JSON.stringify([r.lang, r.foreign, r.han, r.count, r.line, r.page, r.off, r.hanline]));
  return out;
}

export { HAN };
