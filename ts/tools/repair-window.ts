#!/usr/bin/env bun
/**
 * 第二輪修補：對沒有 `j` 的 `<聯 i q>`，取目標頁及前後頁，
 * 用單字命中率＋寬鬆對位找引文；找到就改 `i`（必要時換頁）、`q`、`j`。
 *
 *   bun run ts/tools/repair-window.ts --adb accelon3/ys.adb --out build/ys-window.adb
 *
 * 和 retrofit-j.ts 的差別：
 *   - 頁面文字改用「第 k 個 <頁> 標記到下一個 <頁>」精確取，不用 id 反查
 *     （大正藏有重複頁 id，例如 31p613b 有兩個）。
 *   - 目前頁找不到，會試前一頁／後一頁；找到就順便改 i。
 *   - 先算單字命中率，太低直接放棄並列進 give-up 檔。
 */
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readAdbText } from '../src/adbtext';
import { authorAdb } from '../src/adbauthor';
import { AdbReader, SyncIO } from '../src/accelon26/adb';
import { VaPaMapper } from '../src/accelon26/vapa';
import { expandToken } from '../src/accelon26/variants';

const ROOT = resolve(import.meta.dir, '../..');
const args = process.argv.slice(2);
const opt = (n: string, d?: string): string | undefined => {
  const k = args.indexOf('--' + n);
  return k >= 0 && args[k + 1] && !args[k + 1].startsWith('--') ? args[k + 1] : d;
};
const SRC = resolve(ROOT, opt('adb', '')!);
const OUT = resolve(ROOT, opt('out', '')!);
const TAISHO = resolve(ROOT, opt('taisho', 'accelon3/taisho.adb')!);
const CAP = 4000;
if (!existsSync(SRC)) { console.error('missing --adb'); process.exit(2); }

const isHan = (c: string) => /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(c);
const cc = new Map<string, string>();
function canon(ch: string): string {
  let c = cc.get(ch); if (c) return c;
  const g = expandToken(ch); c = g.length > 1 ? [...g].sort()[0] : ch; cc.set(ch, c); return c;
}
function hanRaw(s: string): string {
  let o = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '<') { const g = s.indexOf('>', i); if (g < 0) break; i = g; continue; }
    if (isHan(s[i])) o += s[i];
  }
  return o;
}
function hanCanon(s: string): string { return [...hanRaw(s)].map(canon).join(''); }

const src = readAdbText(SRC);
const lines = src.lines.slice();
const header = src.header;
const tr = await AdbReader.open(new SyncIO(TAISHO));
const tc = tr.containers.get('tags')!;
const pv = Int32Array.from(await tr.decodeBlockList('tags', tc.names.indexOf('頁')));
const ids = (await tr.attributeValues('頁.id'))!.values;
const bv = await tr.blocksVirtual();
const byId = new Map<string, number[]>();
ids.forEach((id, k) => { const a = byId.get(id) ?? []; a.push(k); byId.set(id, a); });

const mapper = new VaPaMapper(tr); await mapper.init();
const pageCache = new Map<number, string>();
async function pageRaw(k: number): Promise<string> {
  const hit = pageCache.get(k); if (hit !== undefined) return hit;
  const c = await mapper.context(pv[k], 0, CAP + 500);
  let t = c?.text ?? '';
  if (t.startsWith('<頁')) { const g = t.indexOf('>'); if (g >= 0) t = t.slice(g + 1); }
  const cut = t.indexOf('<頁 ');
  if (cut > 0) t = t.slice(0, cut);
  if (t.length > CAP) t = t.slice(0, CAP);
  const out = hanRaw(t);
  pageCache.set(k, out); return out;
}
function fuzzySpan(q: string, hay: string): { first: number; last: number; matched: number } | null {
  if (q.length < 8 || !hay) return null;
  const seeds = new Set<string>();
  for (let s = 0; s + 6 <= q.length && seeds.size < 8; s += 3) seeds.add(q.slice(s, s + 6));
  let best: { first: number; last: number; matched: number } | null = null;
  const greedy = (at: number) => {
    let i = 0, j = at, first = -1, last = -1, matched = 0;
    const stop = Math.min(hay.length, at + Math.min(300, q.length * 2 + 50));
    while (i < q.length && j < stop) {
      if (q[i] === hay[j]) { if (first < 0) first = j; last = j; i++; j++; matched++; }
      else {
        let k = 1; while (k <= 4 && j + k < stop && hay[j + k] !== q[i]) k++;
        if (k <= 4 && j + k < stop && hay[j + k] === q[i]) j += k; else i++;
      }
    }
    return { first, last, matched };
  };
  for (const seed of seeds) {
    let at = hay.indexOf(seed), n = 0;
    while (at >= 0 && n++ < 8) {
      const g = greedy(Math.max(0, at - 3));
      if (g.first >= 0 && (!best || g.matched > best.matched)) best = g;
      at = hay.indexOf(seed, at + 1);
    }
  }
  if (!best) return null;
  if (best.matched < Math.max(8, Math.ceil(q.length * 0.55))) return null;
  if (best.last - best.first + 1 > 300) return null;
  return best;
}

const attr = (attrs: string, name: string) => {
  const m = new RegExp('\\b' + name + '\\s*=\\s*"([^"]*)"').exec(attrs);
  return m ? m[1] : '';
};

let links = 0, fixed = 0, moved = 0, gaveUp = 0;
const giveups: string[] = [];
for (let li = 0; li < lines.length; li++) {
  const line = lines[li];
  if (!line.includes('<聯')) continue;
  const reps: { at: number; len: number; text: string }[] = [];
  for (const m of line.matchAll(/<聯([^>]*)>/g)) {
    const whole = m[0], attrs = m[1];
    const i = attr(attrs, 'i'), q = attr(attrs, 'q');
    if (!i.startsWith('taisho?') || !q || /\bj="/.test(attrs)) continue;
    links++;
    const qh = hanCanon(q).slice(0, 80);
    if (qh.length < 6) { gaveUp++; giveups.push(`${i}\t${q}`); continue; }
    const base = byId.get(i.slice(7));
    if (!base || !base.length) { gaveUp++; giveups.push(`${i}\t${q}`); continue; }
    let best: { pageIdx: number; first: number; last: number; matched: number; page: string } | null = null;
    for (const k of base) {
      for (const off of [0, -1, 1]) {
        const kk = k + off; if (kk < 0 || kk >= ids.length) continue;
        const raw = await pageRaw(kk);
        if (!raw) continue;
        const h = [...raw].map(canon).join('');
        // 單字命中率：太少就跳過
        let hit = 0; const seen = new Set<string>();
        for (const ch of qh) { if (seen.has(ch)) continue; seen.add(ch); if (h.includes(ch)) hit++; }
        if (hit < Math.max(6, Math.ceil(seen.size * 0.5))) continue;
        let first = h.indexOf(qh), last = -1;
        if (first >= 0) last = first + qh.length - 1;
        else {
          const g = fuzzySpan(qh, h);
          if (!g) continue;
          first = g.first; last = g.last;
        }
        const score = last - first + 1;
        if (!best || score > best.matched) best = { pageIdx: kk, first, last, matched: score, page: raw };
      }
    }
    if (!best) { gaveUp++; giveups.push(`${i}\t${q}`); continue; }
    const newPage = ids[best.pageIdx];
    const newQ = best.page.slice(best.first, best.last + 1);
    let a2 = attrs.replace(/\s+j\s*=\s*"[^"]*"/, '').replace(/\s*q\s*=\s*"[^"]*"/, ' q="' + newQ + '"');
    if (newPage !== i.slice(7)) { a2 = a2.replace(/\bi\s*=\s*"[^"]*"/, ' i="taisho?' + newPage + '"'); moved++; }
    a2 = a2.replace(/\s*$/, '');
    reps.push({ at: m.index, len: whole.length, text: `<聯${a2} j="${best.first}-${best.last + 1}">` });
    fixed++;
  }
  if (reps.length) {
    let out = line;
    for (const r of reps.sort((a, b) => b.at - a.at)) out = out.slice(0, r.at) + r.text + out.slice(r.at + r.len);
    lines[li] = out;
  }
  if ((li + 1) % 20000 === 0) console.log('  ...', li + 1, '/', lines.length, 'fixed', fixed, 'giveUp', gaveUp);
}
console.log(`links ${links}；fixed ${fixed}（換頁 ${moved}）；giveUp ${gaveUp}`);
writeFileSync(resolve(ROOT, 'build/ys-window-giveup.tsv'), giveups.map((s) => s.replace(/\t/g, '\t')).join('\n') + '\n');

const r = await AdbReader.open(new SyncIO(SRC));
const resC = r.containers.get('resources');
const resources: { name: string; bytes: Buffer }[] = [];
if (resC) for (let k = 0; k < resC.count; k++) resources.push({ name: resC.names[k], bytes: Buffer.from(await r.readBlock('resources', k)) });
const cachedTags = (r.containers.get('caches')?.names ?? []).slice();
const srcTags = (r.containers.get('tags')?.names ?? []).slice();
const validTags = [...new Set([...srcTags.filter((n) => !n.startsWith('/')), '聯'])];
const out = await authorAdb({
  dbname: header.dbname, dbcname: header.dbcname, dbtype: header.dbType,
  features: header.features, srcBlockSize: header.srcBlockSize,
  lines, resources, cachedTags, validTags,
  log: (m) => console.error(m),
});
writeFileSync(OUT, Buffer.from(out.file));
console.log(`wrote ${OUT}（${(out.file.length / 1048576).toFixed(2)} MiB，${out.lines} 行）`);
process.exit(0);
