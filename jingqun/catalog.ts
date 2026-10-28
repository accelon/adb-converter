#!/usr/bin/env bun
/**
 * 由 TEI 檔頭 + 大正經錄（taisho.tsv / taisho56-84.tsv）建一份 3,000 筆書目。
 * 輸出 build/jingqun/catalog.tsv：
 *   idx  書 id 順序（= adb <書> 的出現順序）
 *   vol  冊
 *   no   經號（含 a/b 後綴）
 *   juan 卷數
 *   lei  部類（CBETA 分類；56–84 留空）
 *   bu   部
 *   title 題名
 *   author 作者／譯者
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const HERE = import.meta.dir;
const ROOT = resolve(HERE, '..');
const T = process.env.TAISHO_TEI ?? 'D:\\2023\\sat2018\\T';
const CATALOG_SRC = process.env.TAISHO_CATALOG ?? 'D:\\2023\\sat2018\\taisho.tsv';

const cat = new Map<string, { lei: string; bu: string; title: string; author: string }>();
for (const line of readFileSync(CATALOG_SRC, 'utf8').split(/\r?\n/)) {
  if (!line) continue;
  const p = line.split('\t');
  cat.set(`${p[3].padStart(2, '0')}:${p[4].toLowerCase()}`, {
    lei: p[1], bu: p[2], title: p[6], author: p[7] ?? '',
  });
}

interface Book { vol: number; no: string; root: string; title: string; author: string; juan: number }
const books: Book[] = [];
const filesPerRoot = new Map<string, number>();

for (const volDir of readdirSync(T).sort()) {
  const vol = Number(volDir.slice(1));
  if (!Number.isFinite(vol)) continue;
  const dir = join(T, volDir);
  const seen = new Set<string>();
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith('.xml')) continue;
    const root = f.replace(/_\d+\.xml$/, '');
    filesPerRoot.set(root, (filesPerRoot.get(root) ?? 0) + 1);
    if (seen.has(root)) continue;
    seen.add(root);
    const fd = Bun.file(join(dir, f));
    const head = (await fd.slice(0, 20000).text()).split('</fileDesc>')[0];
    let title = (/<title level="m"[^>]*>([\s\S]*?)<\/title>/.exec(head)?.[1] ?? '').replace(/<[^>]+>/g, '');
    if (!title) {
      // 56–84 冊的檔頭只有「大正新脩大藏經數位版, No. N 題名」
      const t = (/<title[^>]*>([\s\S]*?)<\/title>/.exec(head)?.[1] ?? '').replace(/<[^>]+>/g, '');
      title = /No\.\s*\d+\s*(.+)$/.exec(t)?.[1]?.trim() ?? t;
    }
    const author = (/<author>([\s\S]*?)<\/author>/.exec(head)?.[1] ?? '').replace(/<[^>]+>/g, '').trim();
    const m = /^T(\d\d)n(\d{4})([a-z]?)$/i.exec(root);
    if (!m) throw new Error('bad root ' + root);
    books.push({ vol, no: (m[2] + m[3]).toLowerCase(), root, title, author, juan: 0 });
  }
}

const out: string[] = ['idx\tvol\tno\tjuan\tlei\tbu\ttitle\tauthor\troot'];
const missing: string[] = [];
books.forEach((b, i) => {
  const c = cat.get(`${String(b.vol).padStart(2, '0')}:${b.no}`);
  if (!c) missing.push(`${b.vol}:${b.no}`);
  b.juan = filesPerRoot.get(b.root) ?? 0;
  out.push([i + 1, b.vol, b.no, b.juan, c?.lei ?? '', c?.bu ?? '',
    b.title.replace(/[\t\n]/g, ' '), b.author.replace(/[\t\n]/g, ' '), b.root].join('\t'));
});
writeFileSync(join(ROOT, 'build/jingqun/catalog.tsv'), out.join('\n') + '\n');
console.log(`books=${books.length} roots=${filesPerRoot.size} missingCatalog=${missing.length}`);
if (missing.length) console.log('missing: ' + missing.slice(0, 40).join(', '));
const byLei = new Map<string, number>();
for (const b of books) {
  const c = cat.get(`${String(b.vol).padStart(2, '0')}:${b.no}`);
  const k = c?.lei ?? '(56-84)';
  byLei.set(k, (byLei.get(k) ?? 0) + 1);
}
console.log([...byLei].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join('\n'));
