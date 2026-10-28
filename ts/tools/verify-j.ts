#!/usr/bin/env bun
/**
 * 驗證／修正 repair-window 產出的 `j`：把 q 放回「頁 id 的所有出現」的原文裡找，
 * 找到才留 `j`（位置以原文重新算），找不到就整條還原成舊標籤。
 *
 *   bun run ts/tools/verify-j.ts --old accelon3/ys.adb --new build/ys-window.adb --out build/ys-window-fixed.adb
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readAdbText } from '../src/adbtext';
import { authorAdb } from '../src/adbauthor';
import { AdbReader, SyncIO } from '../src/accelon26/adb';

const ROOT = resolve(import.meta.dir, '../..');
const args = process.argv.slice(2);
const opt = (n: string) => { const k = args.indexOf('--' + n); return k >= 0 ? args[k + 1] : undefined; };
const OLD = resolve(ROOT, opt('old')!), NEW = resolve(ROOT, opt('new')!), OUT = resolve(ROOT, opt('out')!);
const oldA = readAdbText(OLD), newA = readAdbText(NEW);
const lines = newA.lines.slice();
const tr = await AdbReader.open(new SyncIO(resolve(ROOT, 'accelon3/taisho.adb')));
const bv = await tr.blocksVirtual();
const isHan = (c: string) => /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(c);
const han = (s: string) => { let o = ''; for (let i = 0; i < s.length; i++) { if (s[i] === '<') { const g = s.indexOf('>', i); if (g < 0) break; i = g; continue; } if (isHan(s[i])) o += s[i]; } return o; };
const attr = (attrs: string, name: string) => new RegExp('\\b' + name + '\\s*=\\s*"([^"]*)"').exec(attrs)?.[1] ?? '';

// 收集每個頁 id 的所有 `<頁 ...>` 出現位置
const byId = new Map<string, { b: number; off: number }[]>();
for (let b = 0; b < bv.length; b++) {
  const s = await tr.sourceText(b);
  let at = s.indexOf('<頁');
  while (at >= 0) {
    const gt = s.indexOf('>', at);
    if (gt > at) {
      const tag = s.slice(at, gt + 1);
      const id = /id="([^"]*)"/.exec(tag)?.[1];
      if (id) { const a = byId.get(id) ?? []; a.push({ b, off: at }); byId.set(id, a); }
    }
    at = s.indexOf('<頁', at + 2);
  }
}
console.log('page ids', byId.size);
const cache = new Map<string, string[]>();
async function textsOf(id: string): Promise<string[]> {
  const hit = cache.get(id); if (hit) return hit;
  const list: string[] = [];
  for (const p of byId.get(id) ?? []) {
    let t = (await tr.sourceText(p.b)).slice(p.off);
    for (let b = p.b + 1; t.indexOf('<頁 ') < 0 && b < bv.length && t.length < 4500; b++) t += await tr.sourceText(b);
    const cut = t.indexOf('<頁 ', 1);
    if (cut > 0) t = t.slice(0, cut);
    const gt = t.indexOf('>'); if (gt >= 0) t = t.slice(gt + 1);
    list.push(han(t).slice(0, 4000));
  }
  cache.set(id, list); return list;
}

let kept = 0, fixed = 0, reverted = 0;
const linesOut = await Promise.all(lines.map(async (line, li) => {
  const oldLine = oldA.lines[li] ?? '';
  if (!line.includes('<聯')) return line;
  const reps: { at: number; len: number; text: string }[] = [];
  let k = 0;
  for (const m of line.matchAll(/<聯([^>]*)>/g)) {
    const whole = m[0], attrs = m[1];
    // 對應舊標籤
    const oldTags = [...oldLine.matchAll(/<聯([^>]*)>/g)];
    const oldWhole = oldTags[k]?.[0] ?? whole;
    k++;
    if (!/\bj="/.test(attrs)) continue;
    if (/\bj="/.test(oldWhole)) continue;   // 舊檔已有的 j 不動
    const i = attr(attrs, 'i'), q = attr(attrs, 'q');
    if (!i.startsWith('taisho?') || !q) { reps.push({ at: m.index, len: whole.length, text: oldWhole }); reverted++; continue; }
    const qh = han(q);
    const texts = await textsOf(i.slice(7));
    let best: { text: string; first: number } | null = null;
    for (const txt of texts) {
      const at = txt.indexOf(qh);
      if (at >= 0) { best = { text: txt, first: at }; break; }
    }
    if (!best) { reps.push({ at: m.index, len: whole.length, text: oldWhole }); reverted++; continue; }
    const end = best.first + qh.length;
    const newQ = best.text.slice(best.first, end);
    let a2 = attrs.replace(/\s+j\s*=\s*"[^"]*"/, '').replace(/\s*q\s*=\s*"[^"]*"/, ' q="' + newQ + '"').replace(/\s*$/, '');
    const tag = `<聯${a2} j="${best.first}-${end}">`;
    reps.push({ at: m.index, len: whole.length, text: tag });
    if (newQ !== q || tag !== oldWhole) fixed++;
    kept++;
  }
  let out = line;
  for (const r of reps.sort((a, b) => b.at - a.at)) out = out.slice(0, r.at) + r.text + out.slice(r.at + r.len);
  return out;
}));
console.log(`kept ${kept}（位置修正 ${fixed}）；reverted ${reverted}`);
const r = await AdbReader.open(new SyncIO(NEW));
const resC = r.containers.get('resources');
const resources: { name: string; bytes: Buffer }[] = [];
if (resC) for (let x = 0; x < resC.count; x++) resources.push({ name: resC.names[x], bytes: Buffer.from(await r.readBlock('resources', x)) });
const cachedTags = (r.containers.get('caches')?.names ?? []).slice();
const srcTags = (r.containers.get('tags')?.names ?? []).slice();
const validTags = [...new Set([...srcTags.filter((n) => !n.startsWith('/')), '聯'])];
const out = await authorAdb({
  dbname: newA.header.dbname, dbcname: newA.header.dbcname, dbtype: newA.header.dbType,
  features: newA.header.features, srcBlockSize: newA.header.srcBlockSize,
  lines: linesOut, resources, cachedTags, validTags,
  log: (m) => console.error(m),
});
writeFileSync(OUT, Buffer.from(out.file));
console.log(`wrote ${OUT}（${(out.file.length / 1048576).toFixed(2)} MiB）`);
process.exit(0);
