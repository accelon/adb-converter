import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
const cdir = 'D:/2023/yinshun-corpus/xml';
const files = readdirSync(cdir).filter(f => /^y\d+\.xml$/.test(f) && !/^y00\.xml$/.test(f)).sort();
const units: { vol: number; fileNo: number; pages: string[] }[] = [];
let vno = 0;
for (const f of files) {
  const s = readFileSync(cdir + '/' + f, 'utf8');
  const pbs = [...s.matchAll(/<pb\b[^>]*\bn="([^"]*)"/g)].map(m => m[1]);
  const fileNo = Number(/^y(\d+)/.exec(f)![1]);
  const cls = (p: string) => /^\d/.test(p) ? '#' : p[0];
  let run = '', pages: string[] = [];
  const flush = () => { if (run) { vno++; units.push({ vol: vno, fileNo, pages }); } };
  for (const p of pbs) { const c = cls(p); if (c !== run) { flush(); run = c; pages = []; } pages.push(p); }
  flush();
}
const byVol = new Map(units.map(u => [u.vol, u]));
const isHan = (c: string) => /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(c);
const hanOf = (s: string) => Array.from(s).filter(isHan).join('');
const lineMaps = new Map<number, Map<string, string>>();
for (const f of files) {
  const fileNo = Number(/^y(\d+)/.exec(f)![1]);
  const raw = readFileSync(cdir + '/' + f, 'utf8');
  const body = raw.slice(raw.indexOf('<body'), raw.indexOf('</body>'));
  const parts = body.split(/<lb\s*\n?\s*n="([^"]*)"\s*\/>/);
  const map = new Map<string, string>();
  for (let i = 1; i + 1 < parts.length; i += 2) if (!map.has(parts[i])) map.set(parts[i], hanOf(parts[i + 1].replace(/<[^>]*>/g, '')));
  lineMaps.set(fileNo, map);
}
const text = readFileSync('D:/2026/adb-converter/build/ys-text-full.txt', 'utf8');
const lines = text.split('\n');
if (lines[lines.length - 1] === '') lines.pop();
const lineCjk = lines.map(l => hanOf(l.replace(/<[^>]*>/g, '')));
const volOfLine: number[] = new Array(lines.length).fill(0);
let cur = 0;
for (let i = 0; i < lines.length; i++) { if (lines[i].includes('<檔 n="')) { const m = /<檔 n="Y(\d+)/.exec(lines[i]); cur = m ? Number(m[1]) : 0; } volOfLine[i] = cur; }
const volText = new Map<number, string>(); const volLines = new Map<number, number[]>(); const volStarts = new Map<number, number[]>();
for (let v = 1; v <= 44; v++) { volText.set(v, ''); volLines.set(v, []); volStarts.set(v, []); }
for (let i = 0; i < lines.length; i++) { const v = volOfLine[i]; if (!v) continue; const t = volText.get(v)!; volStarts.get(v)!.push(t.length); volLines.get(v)!.push(i); volText.set(v, t + lineCjk[i]); }
function locate(v: number, pos: number): { line: number; cjk: number } | null {
  const starts = volStarts.get(v)!, ls = volLines.get(v)!;
  if (!starts.length) return null;
  let lo = 0, hi = starts.length - 1, k = 0;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (starts[m] <= pos) { k = m; lo = m + 1; } else hi = m - 1; }
  const line = ls[k]; const cjk = pos - starts[k];
  if (cjk < 0 || cjk > lineCjk[line].length) return null;
  return { line, cjk };
}
function alignLen(q: string, hay: string, at: number): number {
  // q 對 hay[at..] 做最長共同子序列長度（允許插刪）
  const n = q.length, m = Math.min(hay.length - at, q.length * 2 + 8);
  let prev = new Int32Array(m + 1), best = 0;
  for (let i = 1; i <= n; i++) {
    const cur = new Int32Array(m + 1);
    for (let j = 1; j <= m; j++) {
      cur[j] = q[i - 1] === hay[at + j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return prev[m];
}
const align = readFileSync('D:/2026/offtext/alignments/yinshun-taisho.tsv', 'utf8').split(/\r?\n/).filter(l => l && !l.startsWith('#')); align.shift();
const qrows = readFileSync('D:/2026/adb-converter/build/aln-quotes2.tsv', 'utf8').split(/\r?\n/).filter(Boolean);
const qById = new Map<string, string>(); for (const l of qrows) { const f = l.split('\t'); qById.set(f[0], f[2]); }
type Span = { vol: number; start: number; end: number; tag: string };
const spans: Span[] = [];
let exact = 0, relaxed = 0, notfound = 0;
for (const l of align) {
  const f = l.split('\t');
  const u = byVol.get(Number(f[1])); if (!u) { notfound++; continue; }
  const lm = lineMaps.get(u.fileNo)!;
  const pS = u.pages[Number(f[2]) - 1]; if (pS == null) { notfound++; continue; }
  const pE = (Number(f[5]) ? u.pages[Number(f[5]) - 1] : pS) ?? pS;
  const get = (p: string, ln: string) => lm.get(`${p}.${ln}`) ?? '';
  let quote = '';
  if (f[2] === f[5] && f[3] === f[6]) quote = get(pS, f[3]).slice(Number(f[4]), Number(f[7]));
  else {
    quote = get(pS, f[3]).slice(Number(f[4]));
    if (f[2] === f[5]) for (let L = Number(f[3]) + 1; L < Number(f[15]); L++) quote += get(pS, String(L).padStart(2, '0'));
    quote += get(pE, f[15]).slice(0, Number(f[16]));
  }
  const q = hanOf(quote);
  if (q.length < 8) { notfound++; continue; }
  const hay = volText.get(u.fileNo)!;
  // 1) 精確
  let best = -1, bestLen = 0;
  const probe = q.slice(0, 10);
  let at = hay.indexOf(probe), guard = 0;
  while (at >= 0 && guard++ < 40) {
    let k = 0; while (k < q.length && at + k < hay.length && hay[at + k] === q[k]) k++;
    if (k > bestLen) { bestLen = k; best = at; }
    at = hay.indexOf(probe, at + 1);
  }
  let mode = 'exact';
  // 2) 寬鬆：用 6 字種子找候選，再做 LCS 對位
  if (best < 0 || bestLen < 8) {
    mode = 'relaxed';
    const seeds = new Set<string>();
    for (let s = 0; s + 6 <= q.length && seeds.size < 8; s += 3) seeds.add(q.slice(s, s + 6));
    let bestScore = 0;
    for (const seed of seeds) {
      let p = hay.indexOf(seed), g2 = 0;
      while (p >= 0 && g2++ < 20) {
        const sc = alignLen(q, hay, Math.max(0, p - 4));
        if (sc > bestScore) { bestScore = sc; best = Math.max(0, p - 4); bestLen = sc; }
        p = hay.indexOf(seed, p + 1);
      }
    }
    if (bestLen < 10) { notfound++; continue; }
  }
  const anchor = `${Number(f[8])}p${Number(f[9])}${f[10]}`;
  const tq = (qById.get(f[0]) ?? '').slice(0, 160);
  spans.push({ vol: u.fileNo, start: best, end: best + bestLen, tag: `<聯 i="taisho?${anchor}" q="${tq}">` });
  if (mode === 'exact') exact++; else relaxed++;
}
console.log('spans', spans.length, 'exact', exact, 'relaxed', relaxed, 'notfound', notfound);
// 合併同標籤且相鄰/重疊的區間
const byVolume = new Map<number, Span[]>();
for (const s of spans) { const a = byVolume.get(s.vol) ?? []; a.push(s); byVolume.set(s.vol, a); }
const accepted: Span[] = [];
for (const [, arr] of byVolume) {
  arr.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Span[] = [];
  for (const s of arr) {
    const last = merged[merged.length - 1];
    if (last && last.tag === s.tag && s.start <= last.end + 1) { last.end = Math.max(last.end, s.end); }
    else merged.push({ ...s });
  }
  let lastEnd = -1;
  for (const s of merged) if (s.start >= lastEnd) { accepted.push(s); lastEnd = s.end; }
}
console.log('accepted', accepted.length);
type Ev = { line: number; pos: number; open?: string; close?: number };
const evs: Ev[] = [];
for (const s of accepted) {
  const a = locate(s.vol, s.start), b = locate(s.vol, s.end - 1);
  if (!a || !b) continue;
  if (a.line === b.line) { evs.push({ line: a.line, pos: a.cjk, open: s.tag }); evs.push({ line: b.line, pos: b.cjk + 1 }); }
  else {
    evs.push({ line: a.line, pos: a.cjk, open: s.tag });
    evs.push({ line: a.line, pos: lineCjk[a.line].length });
    for (let m = a.line + 1; m < b.line; m++) { evs.push({ line: m, pos: 0, open: s.tag }); evs.push({ line: m, pos: lineCjk[m].length }); }
    evs.push({ line: b.line, pos: 0, open: s.tag });
    evs.push({ line: b.line, pos: b.cjk + 1 });
  }
}
const byLine = new Map<number, Ev[]>();
for (const e of evs) { const arr = byLine.get(e.line) ?? []; arr.push(e); byLine.set(e.line, arr); }
function wrap(line: string, list: Ev[]): string {
  const opens = new Map<number, string[]>(), closes = new Map<number, number>();
  for (const e of list) { if (e.open) { const a = opens.get(e.pos) ?? []; a.push(e.open); opens.set(e.pos, a); } else closes.set(e.pos, (closes.get(e.pos) ?? 0) + 1); }
  let out = '', i = 0, cjk = 0;
  const fire = (p: number) => { for (let k = 0; k < (closes.get(p) ?? 0); k++) out += '</聯>'; for (const t of opens.get(p) ?? []) out += t; };
  while (i < line.length) { if (line[i] === '<') { const gt = line.indexOf('>', i); if (gt < 0) break; out += line.slice(i, gt + 1); i = gt + 1; continue; } fire(cjk); out += line[i]; i++; cjk++; }
  fire(cjk); return out;
}
for (const [idx, list] of byLine) lines[idx] = wrap(lines[idx], list);
writeFileSync('D:/2026/adb-converter/build/ys-linked.txt', lines.join('\n') + '\n');
console.log('links', lines.reduce((n, l) => n + (l.match(/<聯 /g) || []).length, 0));
