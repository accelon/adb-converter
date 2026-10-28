#!/usr/bin/env bun
/**
 * 套用 find-elsewhere.ts 找到的 29 條：3 條改 i、26 條補 j。
 *
 *   bun run ts/tools/apply-elsewhere.ts --adb accelon3/ys.adb --out build/ys-elsewhere-fixed.adb
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readAdbText } from '../src/adbtext';
import { authorAdb } from '../src/adbauthor';
import { AdbReader, SyncIO } from '../src/accelon26/adb';

const ROOT = resolve(import.meta.dir, '../..');
const args = process.argv.slice(2);
const opt = (n: string, d?: string) => { const k = args.indexOf('--' + n); return k >= 0 ? args[k + 1] : d; };
const SRC = resolve(ROOT, opt('adb', 'accelon3/ys.adb')!);
const OUT = resolve(ROOT, opt('out', 'build/ys-elsewhere-fixed.adb')!);
const TSV = resolve(ROOT, opt('tsv', 'build/ys-elsewhere.tsv')!);

const isHan = (c: string) => /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(c);
const han = (s: string) => Array.from(s).filter(isHan).join('');
const rows = readFileSync(TSV, 'utf8').split(/\r?\n/).filter(Boolean).slice(1).map((l) => {
  const f = l.split('\t');
  return { src: f[0], line: Number(f[1]), old: f[2], q: f[3], found: f[4] === '1', neu: f[5], same: f[6] === '1', prefix: Number(f[7]), full: f[8] === '1' };
}).filter((r) => r.full && r.found);
console.log('rows', rows.length, 'move', rows.filter((r) => !r.same).length, 'same', rows.filter((r) => r.same).length);

const db = readAdbText(SRC);
const lines = db.lines.slice();
const tr = await AdbReader.open(new SyncIO(resolve(ROOT, 'accelon3/taisho.adb')));
const bv = await tr.blocksVirtual();
const pos = new Map<string, { b: number; off: number }[]>();
for (let b = 0; b < bv.length; b++) {
  const s = await tr.sourceText(b);
  let at = s.indexOf('<頁');
  while (at >= 0) {
    const gt = s.indexOf('>', at);
    if (gt > at) {
      const tag = s.slice(at, gt + 1);
      const id = /id="([^"]*)"/.exec(tag)?.[1];
      if (id) { const a = pos.get(id) ?? []; a.push({ b, off: at }); pos.set(id, a); }
    }
    at = s.indexOf('<頁', at + 2);
  }
}
const cache = new Map<string, string[]>();
async function textsOf(id: string): Promise<string[]> {
  const hit = cache.get(id); if (hit) return hit;
  const list: string[] = [];
  for (const p of pos.get(id) ?? []) {
    let t = (await tr.sourceText(p.b)).slice(p.off);
    for (let b = p.b + 1; t.indexOf('<頁 ') < 0 && b < bv.length && t.length < 4500; b++) t += await tr.sourceText(b);
    const cut = t.indexOf('<頁 ', 1);
    if (cut > 0) t = t.slice(0, cut);
    const gt = t.indexOf('>'); if (gt >= 0) t = t.slice(gt + 1);
    list.push(han(t).slice(0, 4000));
  }
  cache.set(id, list); return list;
}

const attr = (attrs: string, name: string) => new RegExp('\\b' + name + '\\s*=\\s*"([^"]*)"').exec(attrs)?.[1] ?? '';
const byLine = new Map<number, typeof rows>();
for (const r of rows) { const a = byLine.get(r.line) ?? []; a.push(r); byLine.set(r.line, a); }

let fixed = 0, moved = 0, skipped = 0;
for (const [lineNo, list] of byLine) {
  const line = lines[lineNo - 1];
  if (!line) { skipped += list.length; continue; }
  const tags = [...line.matchAll(/<聯([^>]*)>/g)];
  const used = new Set<number>();
  const reps: { at: number; len: number; text: string }[] = [];
  for (const r of list) {
    const qh = han(r.q);
    let tagIdx = -1;
    for (let k = 0; k < tags.length; k++) {
      if (used.has(k)) continue;
      const a = tags[k][1];
      if (attr(a, 'i') !== 'taisho?' + r.old) continue;
      const tq = han(attr(a, 'q'));
      if (tq && qh && (tq === qh || tq.startsWith(qh.slice(0, Math.min(8, qh.length))) || qh.startsWith(tq.slice(0, Math.min(8, tq.length))))) { tagIdx = k; break; }
    }
    if (tagIdx < 0) { skipped++; continue; }
    used.add(tagIdx);
    const m = tags[tagIdx];
    let j = '';
    let qNew = r.q;
    for (const txt of await textsOf(r.neu)) {
      const at = txt.indexOf(qh);
      if (at >= 0) { j = `${at}-${at + qh.length}`; qNew = txt.slice(at, at + qh.length); break; }
    }
    if (!j) { skipped++; continue; }
    let a2 = m[1].replace(/\s+j\s*=\s*"[^"]*"/, '').replace(/\s*q\s*=\s*"[^"]*"/, ' q="' + qNew + '"').replace(/\s*i\s*=\s*"[^"]*"/, ' i="taisho?' + r.neu + '"').replace(/\s*$/, '');
    reps.push({ at: m.index!, len: m[0].length, text: `<聯${a2} j="${j}">` });
    fixed++;
    if (r.neu !== r.old) moved++;
  }
  if (reps.length) {
    let out = line;
    for (const x of reps.sort((a, b) => b.at - a.at)) out = out.slice(0, x.at) + x.text + out.slice(x.at + x.len);
    lines[lineNo - 1] = out;
  }
}
console.log(`fixed ${fixed}（moved ${moved}）；skipped ${skipped}`);
if (fixed !== rows.length) console.error('warn: not all applied');

const resC = (await AdbReader.open(new SyncIO(SRC))).containers.get('resources');
const resources: { name: string; bytes: Buffer }[] = [];
if (resC) {
  const r = await AdbReader.open(new SyncIO(SRC));
  for (let k = 0; k < resC.count; k++) resources.push({ name: resC.names[k], bytes: Buffer.from(await r.readBlock('resources', k)) });
}
const r2 = await AdbReader.open(new SyncIO(SRC));
const cachedTags = (r2.containers.get('caches')?.names ?? []).slice();
const srcTags = (r2.containers.get('tags')?.names ?? []).slice();
const validTags = [...new Set([...srcTags.filter((n) => !n.startsWith('/')), '聯'])];
const out = await authorAdb({
  dbname: db.header.dbname, dbcname: db.header.dbcname, dbtype: db.header.dbType,
  features: db.header.features, srcBlockSize: db.header.srcBlockSize,
  lines, resources, cachedTags, validTags,
  log: (m) => console.error(m),
});
writeFileSync(OUT, Buffer.from(out.file));
console.log(`wrote ${OUT}（${(out.file.length / 1048576).toFixed(2)} MiB，${out.lines} 行）`);
process.exit(0);
