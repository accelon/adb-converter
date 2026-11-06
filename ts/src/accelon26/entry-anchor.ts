/**
 * 詞書類 adb（沒有 `<頁>`）的引用定位。
 *
 * cyd／swjzz 這類詞典用 `<樹 s="$詞">`／`s="$字">` 宣告「詞條就是閱讀單位」。
 * 引用時用**詞條名稱**當錨點（例 `cyd?一毛不拔#0-3`），`#` 後是**這一條**的
 * 第幾個漢字（不是全庫行號，也不是頁碼）；和頁碼引用一樣可直接貼到「跳至」。
 * 詞條名稱不適合放進 URL 時才退回 `tag＋id`（例 `cyd?詞1#0-3`）。
 */
import type { AdbReader } from './adb';
import type { VaPaMapper } from './vapa';
import { hanCount } from './han';

export interface EntryAnchor {
  tag: string;
  id: string;
  /** 詞條名稱（`caches/<tag>` 的名稱表）；沒有名稱表時是空字串。 */
  name: string;
  startVa: number;
  endVa: number;
  startLine: number;
  /** 下一條的起始行（不含） */
  endLine: number;
}

const tagCache = new WeakMap<AdbReader, string>();

/** 檔頭 `<樹 s="$X">` 宣告的詞條標籤；只回有 `X.id` 實例的標籤。 */
export async function citationEntryTag(r: AdbReader): Promise<string> {
  const hit = tagCache.get(r);
  if (hit !== undefined) return hit;
  let tag = '';
  try {
    const raw = await r.sourceText(0);
    const tail = raw.indexOf('</檔>');
    const head = tail >= 0 ? raw.slice(0, tail + 5) : raw;
    const declared: string[] = [];
    for (const m of head.matchAll(/<樹(?:\s[^>]*)?\ss\s*=\s*"\$([^".\s]+)/g)) {
      if (!declared.includes(m[1])) declared.push(m[1]);
    }
    const names = r.containers.get('tags')?.names ?? [];
    for (const cand of declared) {
      if (!names.includes(cand)) continue;
      const av = await r.attributeValues(cand + '.id').catch(() => null);
      if (av?.values?.length) { tag = cand; break; }
    }
  } catch { /* 沒有 tags 或讀不到檔頭 */ }
  tagCache.set(r, tag);
  return tag;
}

async function tagVas(r: AdbReader, tag: string): Promise<number[]> {
  const at = r.containers.get('tags')?.names.indexOf(tag) ?? -1;
  if (at < 0) return [];
  return r.decodeBlockList('tags', at).catch(() => []);
}

async function tagNames(r: AdbReader, tag: string): Promise<string[]> {
  return r.cachedStrings(tag).catch(() => [] as string[]);
}

function entryFromIndex(
  vas: number[], av: { values: string[] }, names: string[], i: number, tag: string, m: VaPaMapper,
): EntryAnchor | null {
  if (i < 0 || i >= vas.length) return null;
  const startVa = vas[i];
  const endVa = vas[i + 1] ?? Number.MAX_SAFE_INTEGER;
  return {
    tag,
    id: String(av.values[i] ?? ''),
    name: String(names[i] ?? ''),
    startVa,
    endVa,
    startLine: m.lineOfVa(startVa),
    endLine: endVa === Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : m.lineOfVa(endVa),
  };
}

/** 某個 VA 所在的詞條（最後一個開始 <= va 的 `<tag>`）。 */
export async function entryAt(r: AdbReader, m: VaPaMapper, tag: string, va: number): Promise<EntryAnchor | null> {
  if (!tag) return null;
  const vas = await tagVas(r, tag);
  if (!vas.length) return null;
  let lo = 0, hi = vas.length - 1, i = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (vas[mid] <= va) { i = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (i < 0) return null;
  const av = await r.attributeValues(tag + '.id').catch(() => null);
  if (!av?.values?.length) return null;
  return entryFromIndex(vas, av, await tagNames(r, tag), i, tag, m);
}

/** 用詞條名稱找詞條（例 `一毛不拔`）；同名時取第一條。 */
export async function entryByName(r: AdbReader, m: VaPaMapper, tag: string, name: string): Promise<EntryAnchor | null> {
  if (!tag || !name) return null;
  const names = await tagNames(r, tag);
  // `caches/<tag>` 正常是排好序的名稱表；但 cyd 目前是「條目順序」（一毛不拔、
  // 掩耳盜鈴…），不是字典序。排序好的用 binary search lower bound；不是排序的
  // 就從頭找第一個（引用永遠從頭找，作者 2026-11-06）。
  let sorted = true;
  for (let i = 1; i < names.length; i++) {
    if (String(names[i - 1]) > String(names[i])) { sorted = false; break; }
  }
  let first = -1;
  if (sorted) {
    let lo = 0, hi = names.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const v = String(names[mid]);
      if (v < name) lo = mid + 1;
      else {
        if (v === name) first = mid;
        hi = mid - 1;
      }
    }
  } else {
    first = names.findIndex((v) => String(v) === name);
  }
  if (first < 0) return null;
  const av = await r.attributeValues(tag + '.id').catch(() => null);
  if (!av?.values?.length) return null;
  const vas = await tagVas(r, tag);
  return entryFromIndex(vas, av, names, first, tag, m);
}

/** 用 `tag+id` 找詞條（例 `詞1`）；舊引用相容。 */
export async function entryById(r: AdbReader, m: VaPaMapper, tag: string, id: string): Promise<EntryAnchor | null> {
  if (!tag || !id) return null;
  const av = await r.attributeValues(tag + '.id').catch(() => null);
  if (!av?.values?.length) return null;
  const i = av.values.findIndex((v) => String(v) === id);
  if (i < 0) return null;
  const vas = await tagVas(r, tag);
  return entryFromIndex(vas, av, await tagNames(r, tag), i, tag, m);
}

/** 詞條第一行 `<tag …>` 之後的位置；同一行前面可能還有上一條的尾巴。 */
async function entryLineText(m: VaPaMapper, entry: EntryAnchor, line: number): Promise<{ text: string; prefixHan: number }> {
  const raw = await m.lineText(line);
  if (line !== entry.startLine) return { text: raw, prefixHan: 0 };
  const at = raw.indexOf('<' + entry.tag);
  const close = at >= 0 ? raw.indexOf('>', at) : -1;
  const cut = close >= 0 ? close + 1 : 0;
  return { text: raw.slice(cut), prefixHan: hanCount(raw.slice(0, cut)) };
}

/** 從詞條開頭到 (line, 行內第 han 個漢字) 的漢字數；han 是相對於整行。 */
export async function entryHanOffset(m: VaPaMapper, entry: EntryAnchor, line: number, han: number): Promise<number> {
  const end = Math.min(line, entry.endLine - 1);
  let total = 0;
  for (let i = entry.startLine; i <= end; i++) {
    const { text, prefixHan } = await entryLineText(m, entry, i);
    if (i === line) return total + Math.max(0, han - prefixHan);
    total += hanCount(text);
  }
  return total;
}

/** 詞條內第 k 個漢字（0 起）→ 絕對行與該行第幾個漢字。 */
export async function entryLineOfHan(m: VaPaMapper, entry: EntryAnchor, k: number): Promise<{ line: number; han: number }> {
  const last = Math.min(entry.endLine - 1, entry.startLine + 10000);
  let total = 0;
  let lastLine = entry.startLine;
  for (let i = entry.startLine; i <= last; i++) {
    const { text, prefixHan } = await entryLineText(m, entry, i);
    const h = hanCount(text);
    if (k < total + h) return { line: i, han: prefixHan + (k - total) };
    total += h;
    lastLine = i;
  }
  const { prefixHan } = await entryLineText(m, entry, lastLine);
  return { line: lastLine, han: Math.max(0, prefixHan + total - 1) };
}
