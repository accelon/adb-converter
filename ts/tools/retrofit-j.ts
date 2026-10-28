#!/usr/bin/env bun
/**
 * 替現有 `<聯 i="taisho?頁" q="…">` 補上字元級範圍 `j="起-訖"`（不重算連結）。
 *
 *   bun run ts/tools/retrofit-j.ts --adb accelon3/ys.adb --out build/ys-j.adb
 *
 * 只做三件事：
 *   1. 解出 adb 的文字（含既有 `<聯>`）。
 *   2. 對每個有 `i="taisho?…"` 與 `q` 的聯，在目標頁的漢字串裡找 `q`，
 *      算 `j`（和 xref.renderForeign 的 lineHtml 同一種索引）；對不上就不寫。
 *   3. 用 adbauthor 重新打包（保留 resources／caches／validTags）。
 *
 * 選項：
 *   --adb <path>      來源 adb（必填）
 *   --out <path>      輸出 adb（必填）
 *   --taisho <path>   大正藏（預設 accelon3/taisho.adb）
 *   --cap <n>         頁面取幾個 code unit（預設 2000，和右欄渲染一致）
 *   --limit <n>       只處理前 n 行（除錯）
 */
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readAdbText } from '../src/adbtext';
import { authorAdb } from '../src/adbauthor';
import { AdbReader, SyncIO } from '../src/accelon26/adb';
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
const CAP = Number(opt('cap', '2000')) || 2000;
const LIMIT = Number(opt('limit', '0')) || 0;
if (!SRC || !existsSync(SRC)) { console.error('missing --adb'); process.exit(2); }
if (!OUT) { console.error('missing --out'); process.exit(2); }
const t0 = Date.now();

const isHan = (c: string): boolean => /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(c);
const canonCache = new Map<string, string>();
function canon(ch: string): string {
  let c = canonCache.get(ch);
  if (c) return c;
  const g = expandToken(ch);
  c = g.length > 1 ? [...g].sort()[0] : ch;
  canonCache.set(ch, c);
  return c;
}
function hanOf(s: string): string {
  let o = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '<') { const gt = s.indexOf('>', i); if (gt < 0) break; i = gt; continue; }
    if (isHan(s[i])) o += canon(s[i]);
  }
  return o;
}

const srcAdb = readAdbText(SRC);
const lines = srcAdb.lines.slice();
const srcHeader = srcAdb.header;

const tr = await AdbReader.open(new SyncIO(TAISHO));
const tagC = tr.containers.get('tags')!;
const pv = Int32Array.from(await tr.decodeBlockList('tags', tagC.names.indexOf('頁')));
const ids = (await tr.attributeValues('頁.id'))!.values;
const pageIdx = new Map(ids.map((v, k) => [v, k]));
const bv = await tr.blocksVirtual();
const pageCache = new Map<string, string>();
async function pageHan(id: string): Promise<string> {
  const hit = pageCache.get(id);
  if (hit !== undefined) return hit;
  const pi = pageIdx.get(id);
  if (pi === undefined) { pageCache.set(id, ''); return ''; }
  let blk = 0;
  for (let k = 0; k < bv.length; k++) { if (bv[k] <= pv[pi]) blk = k; else break; }
  let t = '';
  for (const off of [0, -1, 1, -2, 2, -3, 3, -4, 4, -5, 5, -6, 6, -8, 8]) {
    const b = blk + off; if (b < 0 || b >= bv.length) continue;
    const s = await tr.sourceText(b);
    const at = s.indexOf('<頁 id="' + id + '"');
    if (at >= 0) { t = s.slice(at); blk = b; break; }
  }
  if (!t) { pageCache.set(id, ''); return ''; }
  const gt = t.indexOf('>'); if (gt >= 0) t = t.slice(gt + 1);
  for (let b = blk + 1; t.indexOf('<頁 ') < 0 && b < bv.length; b++) t += await tr.sourceText(b);
  const cut = t.indexOf('<頁 '); if (cut > 0) t = t.slice(0, cut);
  let h = '';
  for (let i = 0; i < t.length && i < CAP; i++) {
    if (t[i] === '<') { const g = t.indexOf('>', i); if (g < 0) break; i = g; continue; }
    if (isHan(t[i])) h += t[i];
  }
  pageCache.set(id, h);
  return h;
}

const attr = (attrs: string, name: string): string => {
  const m = new RegExp('\\b' + name + '\\s*=\\s*"([^"]*)"').exec(attrs);
  return m ? m[1] : '';
};

/** 寬鬆對位：在頁面字串裡找與 q 最接近的一段（允許插字、漏字）。 */
function fuzzySpan(q: string, hay: string): { first: number; last: number; matched: number } | null {
  if (q.length < 8 || !hay) return null;
  const seeds = new Set<string>();
  for (let s = 0; s + 6 <= q.length && seeds.size < 8; s += 3) seeds.add(q.slice(s, s + 6));
  let best: { first: number; last: number; matched: number } | null = null;
  const greedy = (at: number) => {
    let i = 0, j = at, first = -1, last = -1, matched = 0;
    const stop = Math.min(hay.length, at + Math.min(240, q.length * 2 + 40));
    while (i < q.length && j < stop) {
      if (q[i] === hay[j]) {
        if (first < 0) first = j;
        last = j; i++; j++; matched++;
      } else {
        let k = 1;
        while (k <= 4 && j + k < stop && hay[j + k] !== q[i]) k++;
        if (k <= 4 && j + k < stop && hay[j + k] === q[i]) j += k;
        else i++;
      }
    }
    return { first, last, matched };
  };
  for (const seed of seeds) {
    let at = hay.indexOf(seed), n = 0;
    while (at >= 0 && n++ < 6) {
      const g = greedy(Math.max(0, at - 3));
      if (g.first >= 0 && (!best || g.matched > best.matched)) best = g;
      at = hay.indexOf(seed, at + 1);
    }
  }
  if (!best) return null;
  if (best.matched < Math.max(8, Math.ceil(q.length * 0.55))) return null;
  if (best.last - best.first + 1 > 220) return null;
  return best;
}

let links = 0, added = 0, skipped = 0, ambiguous = 0, fuzzy = 0;
const why = { noQ: 0, short: 0, noPage: 0, noMatch: 0, tiny: 0, fuzzy: 0 };
const total = LIMIT ? Math.min(LIMIT, lines.length) : lines.length;
for (let li = 0; li < total; li++) {
  const line = lines[li];
  if (!line.includes('<聯')) continue;
  const replacements: { at: number; len: number; text: string }[] = [];
  const re = /<聯([^>]*)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    const whole = m[0], attrs = m[1];
    const i = attr(attrs, 'i');
    const q = attr(attrs, 'q');
    if (!i.startsWith('taisho?') || !q) { if (i.startsWith('taisho?')) why.noQ++; continue; }
    links++;
    const qh = hanOf(q).slice(0, 80);
    if (qh.length < 4) { skipped++; why.short++; continue; }
    const phRaw = await pageHan(i.slice(7));
    const ph = [...phRaw].map(canon).join('');
    if (!ph) { skipped++; why.noPage++; continue; }
    let pos = -1;
    for (const L of [12, 10, 8, 6, 4]) {
      if (L > qh.length) continue;
      const probe = qh.slice(0, L);
      let at = ph.indexOf(probe);
      if (at < 0) continue;
      let first = at, hits = 0;
      while (at >= 0) { hits++; at = ph.indexOf(probe, at + 1); }
      if (hits > 1) ambiguous++;
      if (ph.slice(first, first + qh.length) === qh) { pos = first; break; }
    }
    let end = 0;
    let newQ: string | undefined;
    if (pos < 0) {
      const fz = fuzzySpan(qh, ph);
      if (!fz) { skipped++; why.noMatch++; continue; }
      pos = fz.first; end = fz.last + 1; newQ = phRaw.slice(pos, end); fuzzy++; why.fuzzy++;
    } else {
      end = Math.min(ph.length, pos + qh.length);
      newQ = phRaw.slice(pos, end);   // 用頁面原文（繁／異體）統一 q
    }
    if (end - pos < 4) { skipped++; why.tiny++; continue; }
    let a2 = attrs.replace(/\s+j\s*=\s*"[^"]*"/, '');
    if (newQ) a2 = a2.replace(/\s*q\s*=\s*"[^"]*"/, ' q="' + newQ + '"');
    a2 = a2.replace(/\s*$/, '');
    replacements.push({ at: m.index, len: whole.length, text: `<聯${a2} j="${pos}-${end}">` });
    added++;
  }
  if (replacements.length) {
    let out = line;
    for (const x of replacements.sort((a, b) => b.at - a.at)) out = out.slice(0, x.at) + x.text + out.slice(x.at + x.len);
    lines[li] = out;
  }
  if ((li + 1) % 20000 === 0) console.log('  ...', li + 1, '/', total, 'j', added, `${((Date.now() - t0) / 1000).toFixed(0)}s`);
}
console.log(`links ${links}；added j ${added}；skipped ${skipped}；ambiguous ${ambiguous}；` + JSON.stringify(why));

const r = await AdbReader.open(new SyncIO(SRC));
const resC = r.containers.get('resources');
const resources: { name: string; bytes: Buffer }[] = [];
if (resC) for (let i = 0; i < resC.count; i++) resources.push({ name: resC.names[i], bytes: Buffer.from(await r.readBlock('resources', i)) });
const cachedTags = (r.containers.get('caches')?.names ?? []).slice();
const srcTags = (r.containers.get('tags')?.names ?? []).slice();
const validTags = [...new Set([...srcTags.filter((n) => !n.startsWith('/')), '聯'])];
const out = await authorAdb({
  dbname: srcHeader.dbname, dbcname: srcHeader.dbcname, dbtype: srcHeader.dbType,
  features: srcHeader.features, srcBlockSize: srcHeader.srcBlockSize,
  lines, resources, cachedTags, validTags,
  log: (m) => console.error(m),
});
writeFileSync(OUT, Buffer.from(out.file));
console.log(`wrote ${OUT}（${(out.file.length / 1048576).toFixed(2)} MiB，${out.lines} 行，${out.tagNames.length} 種標記）`);
process.exit(0);
