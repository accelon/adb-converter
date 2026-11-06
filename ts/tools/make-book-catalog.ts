#!/usr/bin/env bun
/**
 * 從 adb 檔頭產生 book-catalog.json（書目登錄）。
 *
 *   bun run tools/make-book-catalog.ts
 *
 * 只讀每個 adb 的檔頭，不解析正文；catalog 很小，會被打包進 accelon26。
 * 人工的 kind／status／alias 可以在 OVERRIDES 補。
 */
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { readAdbText } from '../src/adbtext';
import type { BookCatalogEntry, BookCollection, BookKind, BookStatus, WorkCatalogEntry } from '../src/accelon26/book-catalog-types';

const OUT = resolve(import.meta.dir, '../src/accelon26/book-catalog.json');
const DIRS: { dir: string; collection: BookCollection }[] = [
  { dir: 'D:/accelon3', collection: 'accelon3' },
  { dir: 'D:/2026/sz/accelon26', collection: 'sz' },
];

const DICTS = new Set(['cyd', 'hydzd', 'hanyudazidian', 'hanyu', 'hanyu3', 'gycd', 'hcy', 'gjhy', 'kangxi', 'swjz', 'swjzz', 'swjzzp', 'fgdict', 'ped', 'lex']);
const REFERENCES = new Set(['manual', 'taisho-study', 'swjzzsrc', 'goryeo_taisho']);
const GUIDES = new Set(['veda', 'vedic', 'sa', 'en', 'zh', 'zh2']);
const OVERRIDES: Record<string, Partial<BookCatalogEntry>> = {
  fgdict: { status: 'retired' },
  'cs-lex': { kind: 'reference', status: 'wip' },
  'cs-split': { status: 'wip' },
  cs: { status: 'wip' },
};

/** 多書 adb 內的 work；書名是引用身份，adb 只是目前的載體。 */
const WORKS: Record<string, { id: string; title: string; aliases: string[]; book: string }[]> = {
  '13j': [
    { id: 'yijing', title: '易', aliases: ['易', '周易', '易經'], book: '周易' },
    { id: 'shangshu', title: '尚書', aliases: ['尚書', '書經'], book: '尚書' },
    { id: 'shijing', title: '詩經', aliases: ['詩經', '毛詩', '詩'], book: '毛詩' },
    { id: 'zhouli', title: '周禮', aliases: ['周禮'], book: '周禮' },
    { id: 'yili', title: '儀禮', aliases: ['儀禮'], book: '儀禮' },
    { id: 'liji', title: '禮記', aliases: ['禮記'], book: '禮記' },
    { id: 'zuozhuan', title: '春秋左傳', aliases: ['春秋左傳', '左傳'], book: '左傳' },
    { id: 'gongyang', title: '春秋公羊傳', aliases: ['春秋公羊傳', '公羊傳'], book: '公羊傳' },
    { id: 'guliang', title: '春秋穀梁傳', aliases: ['春秋穀梁傳', '穀梁傳'], book: '穀梁傳' },
    { id: 'lunyu', title: '論語', aliases: ['論語'], book: '論語' },
    { id: 'xiaojing', title: '孝經', aliases: ['孝經'], book: '孝經' },
    { id: 'erya', title: '爾雅', aliases: ['爾雅'], book: '爾雅' },
    { id: 'mengzi', title: '孟子', aliases: ['孟子'], book: '孟子' },
  ],
};
/** 常見簡稱／引文寫法；catalog 是引文 resolver 的第一層比對。 */
const ALIASES: Record<string, string[]> = {
  taisho: ['大正藏', '大正新脩大藏經'],
  goryeo: ['高麗藏', '高麗大藏經'],
  wxzj: ['卍續藏', '卍新纂續藏經', '續藏經'],
  ys: ['印順', '印順法師'],
  yinshun: ['印順', '印順法師'],
  hanyu: ['漢語大詞典'],
  hydzd: ['漢語大字典'],
  cyd: ['成語典'],
  kangxi: ['康熙字典'],
  swjz: ['說文解字注'],
  swjzz: ['說文解字注'],
  fuyan: ['福嚴講義'],
  yulinpo: ['于淩波', '于凌波'],
  hcy: ['成語源流大辭典'],
  gjhy: ['古今漢語詞典'],
  cs: ['巴利三藏'],
  veda: ['吠陀', '奧義書'],
};

function headOf(path: string): { dbname: string; title: string; english: string } {
  const adb = readAdbText(path);
  try {
    const head = adb.lines.slice(0, 10).join('\n');
    const dbname = /<檔[^>]*\bn="([^"]+)"/.exec(head)?.[1] ?? '';
    const title = /<集(?:\s[^>]*)?>([^<]*)<\/集>/.exec(head)?.[1]?.trim() ?? '';
    const english = /<英文名>([^<]*)<\/英文名>/.exec(head)?.[1]?.trim() ?? '';
    return { dbname, title, english };
  } finally {
    adb.close();
  }
}

function kindOf(id: string): BookKind {
  if (DICTS.has(id)) return 'dict';
  if (REFERENCES.has(id)) return 'reference';
  if (GUIDES.has(id)) return 'guide';
  return 'text';
}

function aliasesOf(id: string, title: string, english: string, dbname: string): string[] {
  const out = [title, english, dbname.replace(/\.xml$/i, ''), id];
  // 「吠陀與奧義書（英譯）」也給一個不帶括號的別名
  const base = title.replace(/（[^）]*）\s*$/, '').trim();
  if (base && base !== title) out.push(base);
  return [...new Set(out.map((s) => s.trim()).filter(Boolean))];
}

const books: BookCatalogEntry[] = [];
for (const { dir, collection } of DIRS) {
  let names: string[];
  try { names = readdirSync(dir).filter((n) => n.endsWith('.adb')); } catch { continue; }
  for (const adb of names.sort()) {
    if (adb.includes('.build.')) continue;
    const path = join(dir, adb);
    const id = basename(adb, '.adb');
    let meta: { dbname: string; title: string; english: string };
    try { meta = headOf(path); } catch { continue; }
    const title = meta.title || id;
    const entry: BookCatalogEntry = {
      id,
      adb,
      dbname: meta.dbname || undefined,
      title,
      aliases: [...new Set([...aliasesOf(id, title, meta.english, meta.dbname), ...(ALIASES[id] ?? [])])],
      english: meta.english || undefined,
      collection,
      kind: kindOf(id),
      status: collection === 'sz' ? 'wip' : 'ready',
      size: statSync(path).size,
      pageScheme: DICTS.has(id) ? 'entry-name' : 'page-id',
      entryTag: DICTS.has(id) ? '詞' : undefined,
    };
    books.push({ ...entry, ...(OVERRIDES[id] ?? {}) });
  }
}

// 同一 id 只留一筆（以 accelon3 優先；重複檔名不應該放進 catalog）
const seen = new Set<string>();
const unique = books.filter((b) => {
  if (seen.has(b.id)) return false;
  seen.add(b.id);
  return true;
}).sort((a, b) => a.id.localeCompare(b.id));

const worksById = new Map<string, WorkCatalogEntry>();
for (const b of unique) {
  for (const w of WORKS[b.id] ?? []) {
    const at = worksById.get(w.id);
    const edition = {
      adb: b.id,
      book: w.book,
      edition: b.edition,
      status: b.status,
      pageScheme: 'page-id' as const,
    };
    if (at) {
      at.aliases = [...new Set([...at.aliases, ...w.aliases])];
      at.editions.push(edition);
    } else {
      worksById.set(w.id, { id: w.id, title: w.title, aliases: [...new Set(w.aliases)], editions: [edition] });
    }
  }
}
const works = [...worksById.values()].sort((a, b) => a.id.localeCompare(b.id));

const payload = { schema: 2, books: unique, works };
writeFileSync(OUT, JSON.stringify(payload, null, 2) + '\n', 'utf8');
console.log(`wrote ${OUT} (${unique.length} books, ${works.length} works, ${(JSON.stringify(payload).length / 1024).toFixed(1)} KiB)`);
