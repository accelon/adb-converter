#!/usr/bin/env bun
/**
 * 金剛經群：把註疏中「引用經文」的段落與 T235 對齊。
 *
 * 做法：兩邊都只留漢字（做常見異體折疊），以 8 字 n-gram 建索引，
 * 逐段延伸最長共同前綴；>= 8 字且不是濫用短语的才收。
 *
 * 產出 build/jingqun/jingang-links.tsv
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const HERE = import.meta.dir;
const ROOT = resolve(HERE, '..');
/** 例：EMBED_DB=jingang EMBED_ROOT=金剛般若波羅蜜經 bun run jingqun/align.ts */
const DB = process.env.EMBED_DB || 'jingang';
const ROOT_TITLE = process.env.EMBED_ROOT || '金剛般若波羅蜜經';
const SRC = join(ROOT, 'build/jingqun', `${DB}.txt`);
const OUT = join(ROOT, 'build/jingqun', `${DB}-links.tsv`);
const HAN = /[\u3400-\u9fff\uf900-\ufaff]/;

interface Ch { ch: string; page: string; pi: number; line: number; off: number }
interface Work { no: string; title: string; body: string; lines: string[]; lineStarts: number[]; chars: Ch[]; pages: Map<string, Ch[]> }

const foldMap: Record<string, string> = {
  説: '說', 卽: '即', 著: '着', 於: '于', 祇: '祇', 只: '只',
  淨: '淨', 涅: '涅', 槃: '槃', 鉢: '缽', 缽: '缽', 惱: '惱', 腦: '腦',
  舍: '舍', 捨: '捨', 乞: '乞', 食: '食', 敷: '敷', 座: '座',
  須: '須', 鬚: '須', 無: '無', 无: '無', 為: '為', 爲: '為',
  云: '云', 於: '于', 與: '與', 与: '與', 佛: '佛', 告: '告',
  善: '善', 男: '男', 女: '女', 人: '人', 發: '發', 发: '發',
  阿: '阿', 耨: '耨', 多: '多', 羅: '羅', 三: '三', 藐: '藐',
  菩: '菩', 提: '提', 心: '心', 應: '應', 应: '應', 住: '住',
  降: '降', 伏: '伏', 其: '其', 唯: '唯', 然: '然', 願: '願',
  樂: '樂', 欲: '欲', 聞: '聞', 聞: '聞',
};
const fold = (ch: string) => foldMap[ch] ?? ch;

const NO_BY_TITLE: Record<string, string> = {
  '金剛般若波羅蜜經': '235',
  '金剛般若論': '1510a',
  '金剛般若波羅蜜經論': '1511',
  '金剛般若經疏': '1698',
  '金剛般若疏': '1699',
  '金剛般若經疏論纂要': '1701',
  '金剛般若波羅蜜經註解': '1703',
};
// 其他經群：從 jingqun.tsv 的 title → no 補齊（同題多本時以手動表優先）
for (const l of readFileSync(join(ROOT, 'jingqun/jingqun.tsv'), 'utf8').split(/\r?\n/).slice(1)) {
  if (!l) continue;
  const p = l.split('\t');
  if (p[7] && p[5] && !NO_BY_TITLE[p[7]]) NO_BY_TITLE[p[7]] = p[5];
}

function parseWork(part: string): Work | null {
  const m = /^<段\/><書 id="n\d+">([\s\S]*?)<\/書>/.exec(part);
  if (!m) return null;
  const title = m[1];
  const body = part.slice(m[0].length);
  const lines = body.split('\n');
  const chars: Ch[] = [];
  const lineStarts: number[] = [];
  const pages = new Map<string, Ch[]>();
  let page = '';
  let off = 0;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    lineStarts.push(off);
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '<') {
        const gt = line.indexOf('>', i);
        if (gt < 0) break;
        const tag = line.slice(i, gt + 1);
        const pm = /^<頁[^>]*\sid="([^"]+)"/.exec(tag);
        if (pm) page = pm[1];
        i = gt;
        continue;
      }
      const c = line[i];
      if (!HAN.test(c)) continue;
      const pc = pages.get(page) ?? [];
      const ch: Ch = { ch: fold(c), page, pi: pc.length, line: li, off: off + i };
      chars.push(ch);
      pc.push(ch);
      pages.set(page, pc);
    }
    off += line.length + 1;
  }
  // 沒有 <書> 標題的 section（不應該發生）用 no
  return { no: NO_BY_TITLE[title] ?? '', title, body, lines, lineStarts, chars, pages };
}

const raw = readFileSync(SRC, 'utf8');
const parts = raw.split(/(?=<段\/><書 id="n\d+">)/).filter((p) => p.startsWith('<段/>'));
const works = parts.map(parseWork).filter((w): w is Work => !!w);
const sutra = works.find((w) => w.title === ROOT_TITLE && w.chars.length > 100);
if (!sutra) throw new Error('找不到根經 ' + ROOT_TITLE);

const sf = sutra.chars.map((c) => c.ch).join('');
const N = 8;
const index = new Map<string, number[]>();
for (let i = 0; i + N <= sf.length; i++) {
  const k = sf.slice(i, i + N);
  const arr = index.get(k);
  if (!arr) index.set(k, [i]);
  else if (arr.length < 40) arr.push(i);
}

interface Hit { comm: Work; s0: number; c0: number; len: number; quote: string }
const hits: Hit[] = [];
const MIN = 9;
for (const w of works) {
  if (w === sutra) continue;
  const cf = w.chars.map((c) => c.ch).join('');
  let c0 = 0;
  while (c0 + MIN <= cf.length) {
    const k = cf.slice(c0, c0 + N);
    const cands = index.get(k);
    if (!cands) { c0++; continue; }
    let best = 0, bestS = -1;
    for (const s0 of cands) {
      let l = N;
      while (c0 + l < cf.length && s0 + l < sf.length && cf[c0 + l] === sf[s0 + l]) l++;
      if (l > best) { best = l; bestS = s0; }
    }
    if (best >= MIN && bestS >= 0) {
      const quote = sf.slice(bestS, bestS + best);
      // 太常見的短句（例如「須菩提於意云何」）不收
      const common = (index.get(quote.slice(0, N)) ?? []).length;
      if (best >= 9 && !quote.startsWith(ROOT_TITLE)) {
        hits.push({ comm: w, s0: bestS, c0, len: best, quote });
        c0 += best;
        continue;
      }
    }
    c0++;
  }
}

// 同一部註疏內，重疊的匹配只留最長
const kept: Hit[] = [];
for (const w of works) {
  const hs = hits.filter((h) => h.comm === w).sort((a, b) => a.c0 - b.c0 || b.len - a.len);
  const lastEnd = new Map<number, number>();
  for (const h of hs) {
    const end = h.c0 + h.len;
    // 與已收的重疊超過一半就丟
    let overlap = false;
    for (const k of kept) {
      if (k.comm !== w) continue;
      const ke = k.c0 + k.len;
      if (Math.max(0, Math.min(end, ke) - Math.max(h.c0, k.c0)) > Math.min(h.len, k.len) * 0.5) { overlap = true; break; }
    }
    if (!overlap) kept.push(h);
  }
}

// 每部註疏在每一頁只留最長的一筆；每一頁最多取 3 家（取最長），讓各註疏都有機會出現
const onePerWorkPage = new Map<string, Hit>();
for (const h of kept) {
  const key = h.comm.no + '|' + sutra.chars[h.s0].page;
  const prev = onePerWorkPage.get(key);
  if (!prev || h.len > prev.len) onePerWorkPage.set(key, h);
}
const byPage = new Map<string, Hit[]>();
for (const h of onePerWorkPage.values()) {
  const p = sutra.chars[h.s0].page;
  const arr = byPage.get(p) ?? [];
  arr.push(h);
  byPage.set(p, arr);
}
const final: Hit[] = [];
for (const arr of byPage.values()) {
  arr.sort((a, b) => b.len - a.len);
  const picked: Hit[] = [];
  const seenComm = new Set<string>();
  for (const h of arr) {
    if (picked.length >= 5) break;
    if (seenComm.has(h.comm.no)) continue;
    seenComm.add(h.comm.no);
    picked.push(h);
  }
  final.push(...picked);
}
const bySutra = new Map<number, Hit>();
for (const h of final) bySutra.set(h.s0, h);
const out: string[] = ['sutra_no\tsutra_page\tsutra_han\tsutra_line\tsutra_col\tsutra_quote\tcomm_no\tcomm_title\tcomm_page\tcomm_pi_start\tcomm_pi_end\tcomm_quote\tlen'];
for (const h of [...bySutra.values()].sort((a, b) => a.s0 - b.s0)) {
  const sc = sutra.chars[h.s0];
  const cc = h.comm.chars[h.c0];
  const ce = h.comm.chars[h.c0 + h.len - 1];
  out.push([
    sutra.no, sc.page, h.s0, sc.line, sc.off - sutra.lineStarts[sc.line], h.quote, h.comm.no, h.comm.title, cc.page, cc.pi, ce.pi + 1,
    h.comm.chars.slice(h.c0, h.c0 + h.len).map((c) => c.ch).join(''), h.len,
  ].join('\t'));
}
writeFileSync(OUT, out.join('\n') + '\n');
console.log(`works=${works.length} sutraChars=${sutra.chars.length} hits=${hits.length} kept=${kept.length} bySutra=${bySutra.size}`);
console.log(out.slice(1, 8).join('\n'));





