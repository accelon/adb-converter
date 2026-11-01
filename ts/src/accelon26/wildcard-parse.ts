/**
 * 萬用字元的**語法**（作者 2026-11-01）：純函式，不碰 DOM、不碰 adb。
 *
 *   ？  恰好一個漢字（？？＝兩個）
 *   ＊  1–4 個漢字（WILD_MANY_MAX；不給「不特定長度」）
 *
 * 其他字元照字面比對（標點、數字、拉丁字母都可以）。**至少要有一個字**，
 * 單獨的 ？／＊ 一律拒絕。不支援 regex 語法（. [ ] ( ) | + ^ $ \）。
 *
 * 掃描引擎在 wildcard.ts（需要 reader／mapper）；命令列工具只 import 這支。
 */






/** `＊` 最多幾個漢字（作者指定：不要「不特定長度」） */
export const WILD_MANY_MAX = 4;
/** 一個模式最多幾個 `？` */
const MAX_ANY = 6;
/** 一個模式最多幾個 `＊` */
const MAX_MANY = 2;
/** 模式最長幾個字元 */
const MAX_LEN = 40;

const HAN = '\\p{Script=Han}';

/** 設定頁／提示要顯示的語法說明 */
export function wildcardHint(): string {
  return `？＝恰好 1 個漢字、＊＝1–${WILD_MANY_MAX} 個漢字；至少要有 1 個字（不能只打萬用字元）；`
    + '只比對漢字，不支援 . [ ] ( ) | + ^ $ \\';
}

export interface WildPart {
  k: 'lit' | 'any' | 'many';
  /** lit：原文 */
  s?: string;
  /** any：幾個漢字 */
  n?: number;
}

export interface WildPattern {
  raw: string;
  parts: WildPart[];
  ok: boolean;
  error?: string;
  /** 字面區段（由長到短排好；縮小掃描範圍用） */
  literals: string[];
  /** 拿去查索引的字（最長字面區段裡的第一個漢字；沒有就 null＝全掃） */
  narrowChar: string | null;
  regex: RegExp | null;
  /** 給人看的樣式說明，例如「？象 ＝ 任意 1 個漢字 ＋ 象」 */
  describe: string;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const hasHan = (s: string): boolean => /\p{Script=Han}/u.test(s);

const firstHan = (s: string): string => {
  for (const ch of s) if (hasHan(ch)) return ch;
  return '';
};

/**
 * 解析使用者輸入的樣式。`？`／`？`（全形）都接受；`＊`／`*` 都接受。
 * 不合法就回 `{ ok:false, error }`（UI 直接顯示，不要丟例外）。
 */
export function parseWildcard(raw: string): WildPattern {
  const empty: WildPattern = {
    raw: raw ?? '', parts: [], ok: false, literals: [], narrowChar: null, regex: null, describe: '',
  };
  const src = (raw ?? '').trim();
  if (!src) return { ...empty, error: '請輸入樣式，例如 ？象（任意一個漢字後面接「象」）' };
  if ([...src].length > MAX_LEN) return { ...empty, error: `樣式太長（最多 ${MAX_LEN} 個字元）` };
  const s = src.replace(/？/g, '?').replace(/＊/g, '*');
  if (/[.[\]()|+^$\\]/.test(s)) {
    return { ...empty, error: '不支援 . [ ] ( ) | + ^ $ \\ ；要「任一個漢字」請用 ？，1–4 個請用 ＊' };
  }
  const parts: WildPart[] = [];
  let anyRun = 0;
  let anyTotal = 0;
  let manyCount = 0;
  const flushAny = (): void => {
    if (!anyRun) return;
    parts.push({ k: 'any', n: anyRun });
    anyTotal += anyRun;
    anyRun = 0;
  };
  for (const ch of s) {
    if (ch === '?') { anyRun++; continue; }
    if (ch === '*') {
      flushAny();
      if (parts.length && parts[parts.length - 1].k === 'many') {
        return { ...empty, error: '兩個 ＊ 不能連在一起（＊ 已經是 1–' + WILD_MANY_MAX + ' 個漢字）' };
      }
      manyCount++;
      if (manyCount > MAX_MANY) return { ...empty, error: `最多 ${MAX_MANY} 個 ＊` };
      parts.push({ k: 'many' });
      continue;
    }
    flushAny();
    const last = parts[parts.length - 1];
    if (last && last.k === 'lit') last.s = (last.s ?? '') + ch;
    else parts.push({ k: 'lit', s: ch });
  }
  flushAny();
  if (!parts.some((p) => p.k === 'lit')) {
    return { ...empty, error: '至少要有一個字：只有萬用字元的查詢等於「列出全部」，請加上要找的字（例如 ？象）' };
  }
  if (anyTotal > MAX_ANY) return { ...empty, error: `最多 ${MAX_ANY} 個 ？` };
  const literals = parts.filter((p) => p.k === 'lit').map((p) => p.s ?? '').filter(Boolean)
    .sort((a, b) => b.length - a.length);
  // 縮小範圍用的字：最長字面區段裡的第一個漢字（單一漢字才有現成的索引 token）
  let narrowChar = firstHan(literals[0] ?? '');
  if (!narrowChar) for (const l of literals) { narrowChar = firstHan(l); if (narrowChar) break; }
  // 有單一漢字能用最好；字面區段只有多字詞時，退而用最後一個漢字也可以（索引是單字 token）
  const source = parts.map((p) => (p.k === 'lit' ? escapeRe(p.s ?? '')
    : p.k === 'any' ? `${HAN}{${p.n}}` : `${HAN}{1,${WILD_MANY_MAX}}`)).join('');
  const describe = parts.map((p) => (p.k === 'lit' ? p.s ?? ''
    : p.k === 'any' ? (p.n === 1 ? '任意漢字' : `任意${p.n}個漢字`)
      : `任意1–${WILD_MANY_MAX}個漢字`)).join(' ＋ ');
  return {
    raw: src, parts, ok: true, literals,
    narrowChar: narrowChar || null,
    regex: new RegExp(source, 'gu'),
    describe,
  };
}

/** 去掉 XML 標籤，並記住每個字在原文的位置（`？` 只比漢字，標籤不能干擾比對） */
export function stripTags(raw: string): { text: string; map: number[] } {
  const out: string[] = [];
  const map: number[] = [];
  let inTag = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inTag) { if (ch === '>') inTag = false; continue; }
    if (ch === '<') { inTag = true; continue; }
    out.push(ch);
    map.push(i);
  }
  return { text: out.join(''), map };
}
