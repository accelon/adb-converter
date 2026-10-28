#!/usr/bin/env bun
/**
 * 說文解字注引用書目 `swjzzsrc.adb` 的文字產生器。
 *
 *   bun run ts/tools/swjzzsrc2adb.ts <out.txt> [--shuowen build/shiwen-ref.json] [--src D:\2026\swjzz\src]
 *
 * 收書（陸續擴充：在 `BOOKS` 加一筆就好）：
 *
 *   | 書 | 來源 | 版本 |
 *   |---|---|---|
 *   | 說文解字（大徐本） | shuowen.org 開放資料（Apache-2.0） | 大徐本，附反切、徐鉉注、重文 |
 *   | 爾雅 | Kanripo KR1j0002 | 四部叢刊影明鈔本（郭璞注） |
 *   | 周易 | Kanripo KR1a0001 | TLS 正文 |
 *   | 尚書 | Kanripo KR1b0001 | TLS 正文 |
 *   | 廣韻 | Kanripo KR1j0055 | 四庫全書（重修廣韻） |
 *
 * 輸出結構（左欄目錄＝書 → 卷／篇 → 條／字）：
 *
 *   <書 n="1" id="swjz" t="卷.">說文解字（大徐本）</書>
 *   <卷 n="1" t="部.">說文解字第一篇</卷>
 *   <部 t="字.">一部</部>
 *   <字 id="sw0001">一</字>
 *   <說文>惟初太始，道立於一，造分天地，化成萬物。凡一之屬皆从一。</說文>
 *   <反切>於悉切</反切>
 *
 *   <書 n="2" id="erya" t="篇.">爾雅</書>
 *   <篇 t="條.">釋詁第一</篇>
 *   <條>初哉首基肇祖元胎俶落權輿，始也。<注>尚書曰三月哉生魄…</注></條>
 *
 * `條` 是「一句／一條」的單位，帶 `id`（例如 `E.釋詁第一.3`），
 * 之後段注要 `<聯 i="swjzzsrc?E.釋詁第一.3">` 指過來時就有錨點可用。
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { loadShiwenRef, type ShiwenRef } from '../src/swjz-ref';

const MAX_LINE_CHARS = 4000;

// ── 參數 ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
let shuowenRefPath = 'build/shiwen-ref.json';
let srcRoot = 'D:/2026/swjzz/src';
const positional: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--shuowen') { shuowenRefPath = args[++i]; continue; }
  if (args[i] === '--src') { srcRoot = args[++i]; continue; }
  positional.push(args[i]);
}
const outPath = positional[0];
if (!outPath) {
  console.error('usage: bun run ts/tools/swjzzsrc2adb.ts <out.txt> [--shuowen ref.json] [--src 目錄]');
  process.exit(2);
}

// ── 輸出小工具 ──────────────────────────────────────────────────────────
const out: string[] = [];
const stats = new Map<string, number>();
const bump = (k: string) => stats.set(k, (stats.get(k) ?? 0) + 1);
const warnings: string[] = [];
let maxLine = 0;

function push(raw: string) {
  const s = raw.replace(/[\r\n]+/g, '').trimEnd();
  if (!s.trim()) return;
  if (s.length > MAX_LINE_CHARS) {
    warnings.push(`長行 ${s.length} 字：${s.slice(0, 40)}…`);
    let rest = s;
    while (rest.length > MAX_LINE_CHARS) {
      let cut = -1;
      for (const ch of ['。', '；', '，', '　']) {
        const at = rest.lastIndexOf(ch, MAX_LINE_CHARS);
        if (at > cut) cut = at;
      }
      if (cut <= 0) cut = MAX_LINE_CHARS;
      out.push(rest.slice(0, cut + 1));
      rest = rest.slice(cut + 1);
    }
    if (rest) out.push(rest);
    return;
  }
  out.push(s);
  if (s.length > maxLine) maxLine = s.length;
}
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ── Kanripo（mandoku）文字清理 ──────────────────────────────────────────
/**
 * 一行 Kanripo 文字 → 乾淨的一行：
 *   去掉頁碼 `<pb:…>`、行尾 `¶`、`&KRxxxx;` 缺字、小字括號裡的換行斜線 `/`。
 *   小字 `(…)` 轉成 `<注>…</注>`（四部叢刊的雙行小字就是注）。
 */
function cleanKanripo(line: string): string {
  let s = line
    .replace(/<pb:[^>]*>/g, '')
    .replace(/¶/g, '')
    .replace(/&KR\d+;/g, '□')
    .replace(/^#.*$/, '')
    .trim();
  // 小字：ASCII 括號 → <注>；括號裡的 `/` 是原書換行，去掉
  s = s.replace(/\(([^()]*)\)/g, (_m, inner: string) => `<注>${inner.replace(/\//g, '')}</注>`);
  return s;
}

function kanripoFiles(repo: string): string[] {
  const dir = `${srcRoot}/${repo}-master`;
  return readdirSync(dir)
    .filter((f) => /_\d+\.txt$/.test(f))
    .sort()
    .map((f) => `${dir}/${f}`);
}
function readKanripo(repo: string): string[] {
  const lines: string[] = [];
  for (const f of kanripoFiles(repo)) {
    for (const raw of readFileSync(f, 'utf8').split('\n')) lines.push(raw);
  }
  return lines;
}
function juanOf(repo: string): string[] {
  return kanripoFiles(repo).map((f) => {
    const m = /#\+PROPERTY:\s*JUAN\s*(.+)/.exec(readFileSync(f, 'utf8'));
    return (m?.[1] ?? '').trim();
  });
}

// ── 各書 ────────────────────────────────────────────────────────────────

/** 說文解字（大徐本）：卷 → 部 → 字。 */
function emitShuowen(ref: ShiwenRef) {
  const entries = Object.entries(ref)
    .filter(([, e]) => e.i > 0)
    .sort((a, b) => a[1].i - b[1].i);
  bump('書');
  push(`<書 n="1" id="swjz" t="卷.">說文解字（大徐本）</書>`);
  let curVol = '';
  let curRad = '';
  const seenVols = new Set<string>();
  let volNo = 0;
  let ord = 0;
  for (const [head, e] of entries) {
    // 原資料少數條目的 volume 空白或跳回前一卷；只有「沒見過的卷」才開新卷，
    // 否則那幾條會把同一篇切成好幾段。
    if (e.v && e.v !== curVol && !seenVols.has(e.v)) {
      curVol = e.v;
      seenVols.add(e.v);
      curRad = '';
      volNo++;
      bump('卷');
      push(`<卷 n="${volNo}" t="部.">說文解字第${toCn(Number(e.v))}篇</卷>`);
    }
    if (e.r && e.r !== curRad) {
      curRad = e.r;
      bump('部');
      push(`<部 t="字.">${esc(e.r)}部</部>`);
    }
    ord++;
    bump('字');
    const id = `S${String(ord).padStart(5, '0')}`;
    push(`<字 id="${id}">${esc(head)}</字>`);
    if (e.e) { bump('說文'); push(`<說文>${esc(e.e)}</說文>`); }
    if (e.p) { bump('反切'); push(`<反切>${esc(e.p)}</反切>`); }
    if (e.x) { bump('徐鉉'); push(`<徐鉉>${esc(e.x)}</徐鉉>`); }
    for (const v of e.vars) {
      ord++;
      bump('字');
      push(`<字 id="S${String(ord).padStart(5, '0')}">${esc(v.h)}</字>`);
      if (v.e) { bump('說文'); push(`<說文>${esc(v.e)}</說文>`); }
    }
  }
}

/** 一句一條：Kanripo 的詩文類（周易、尚書）。 */
function emitSentences(opts: {
  id: string; n: string; title: string; repo: string; headRe: RegExp; prefix: string; ordered?: boolean;
}) {
  bump('書');
  push(`<書 n="${opts.n}" id="${opts.id}" t="篇.">${esc(opts.title)}</書>`);
  let unit: string | null = null;
  let unitNo = 0;
  let buf = '';
  let curUnitId = '';
  /** 新的一篇：一定要「先寫篇節點、再寫它的條」，否則條會掛到上一個篇的 id。 */
  const openUnit = (name: string) => {
    unitNo++;
    curUnitId = `${opts.prefix}.${unitNo}`;
    unit = name;
    seq = 0;
    bump('篇');
    push(`<篇 id="${esc(curUnitId)}" t="條.">${esc(name)}</篇>`);
  };
  let seq = 0;
  let curNo = -1;
  const flushBuf = () => {
    const t = buf.trim();
    buf = '';
    if (!t) return;
    seq++;
    bump('條');
    push(`<條 id="${esc(curUnitId)}.${seq}">${t}</條>`);
  };
  for (const raw of readKanripo(opts.repo)) {
    const cleaned = cleanKanripo(raw);
    if (!cleaned) continue;
    const m = opts.headRe.exec(cleaned);
    if (m) {
      const no = Number(m[1]) || 0;
      if (opts.ordered && no && no <= curNo) continue;   // 重複的目次
      if (opts.ordered) curNo = no || curNo;
      flushBuf();
      openUnit((m[m.length - 1] ?? cleaned).trim());
      continue;
    }
    if (unit === null) continue;
    buf += cleaned;
    if (/[。！？」]$/.test(buf) || buf.length > 800) flushBuf();
  }
  flushBuf();
}

/**
 * 爾雅：`(…)` 是郭璞注。
 *
 * 這份四部叢刊明鈔本的轉錄**篇名順序是亂的**：卷首的目次、正文的篇名交錯出現，
 * 釋言第二、釋鳥第十七 的標題甚至晚了好幾卷才出現。單趟照順序切篇會把整篇文字
 * 掛到前一篇去，所以分兩趟：先把每條歸給「最近一個篇名」，再按爾雅的固定篇序輸出。
 */
const ERYA_ORDER = ['釋詁', '釋言', '釋訓', '釋親', '釋宫', '釋器', '釋樂', '釋天', '釋地',
  '釋丘', '釋山', '釋水', '釋草', '釋木', '釋蟲', '釋魚', '釋鳥', '釋獸', '釋畜'];

function emitErya(repo: string) {
  bump('書');
  push(`<書 n="2" id="erya" t="篇.">爾雅</書>`);
  const bySection = new Map<string, { label: string; lines: string[] }>();
  let cur = '';
  let curLabel = '';
  let buf = '';
  const flushBuf = () => {
    const t = buf.trim();
    buf = '';
    if (!t) return;
    if (!cur) return;                       // 篇名之前（卷首目次）不歸任何篇
    let sec = bySection.get(cur);
    if (!sec) { sec = { label: curLabel, lines: [] }; bySection.set(cur, sec); }
    sec.lines.push(t);
  };
  for (const raw of readKanripo(repo)) {
    const cleaned = cleanKanripo(raw);
    if (!cleaned) continue;
    const m = /^(釋\S{1,2})(第[一二三四五六七八九十]+)$/.exec(cleaned);
    if (m) {
      if (ERYA_ORDER.indexOf(m[1]) < 0) continue;
      flushBuf();
      cur = m[1];
      curLabel = cleaned;
      continue;
    }
    if (!cur) continue;
    // 行首就是注：上一條的注還沒完（四部叢刊的雙行小字會跨行）；
    // 這種行的尾巴（最後一個 </注> 之後）通常是下一條的正文，要切給下一條。
    if (cleaned.startsWith('<注>') && buf) {
      const tail = cleaned.lastIndexOf('</注>');
      if (tail >= 0) {
        buf += cleaned.slice(0, tail + 4);
        flushBuf();
        buf = cleaned.slice(tail + 4);
      } else {
        buf += cleaned;
      }
      continue;
    }
    flushBuf();
    buf = cleaned;
  }
  flushBuf();
  // 按爾雅的固定篇序輸出（只出有內容的篇）
  let unitNo = 0;
  for (const name of ERYA_ORDER) {
    const sec = bySection.get(name);
    if (!sec?.lines.length) continue;
    unitNo++;
    bump('篇');
    push(`<篇 id="E.${unitNo}" t="條.">${esc(sec.label)}</篇>`);
    sec.lines.forEach((t, i) => {
      bump('條');
      push(`<條 id="E.${unitNo}.${i + 1}">${t}</條>`);
    });
  }
}

/** 廣韻：一卷一檔，一行一條（韻目與小韻都在同一行裡）。 */
function emitGuangyun(repo: string) {
  bump('書');
  push(`<書 n="5" id="guangyun" t="卷.">廣韻</書>`);
  const juans = juanOf(repo);
  const files = kanripoFiles(repo);
  let volNo = 0;
  files.forEach((f, i) => {
    const label = (juans[i] || '').trim();
    const lines: string[] = [];
    for (const raw of readFileSync(f, 'utf8').split('\n')) {
      const cleaned = cleanKanripo(raw);
      if (!cleaned || cleaned.startsWith('#')) continue;
      if (/^欽定四庫全書$/.test(cleaned)) continue;
      if (/^　?廣韻卷/.test(cleaned)) continue;
      lines.push(cleaned);
    }
    if (!lines.length) return;
    volNo++;
    bump('卷');
    // 第 0 檔是目次／序（JUAN=0），其餘是卷一…卷五
    const name = !label || label === '0' ? '序' : label;
    push(`<卷 n="${volNo}" t="條.">廣韻${esc(name)}</卷>`);
    lines.forEach((cleaned, k) => {
      bump('條');
      push(`<條 id="G.${volNo}.${k + 1}">${cleaned}</條>`);
    });
  });
}

/** 說明（來源、版本、授權、怎麼加書）。 */
function emitAbout() {
  bump('書');
  push('<書 n="0" id="about" t="條.">說明</書>');
  const lines = [
    '本庫是《說文解字注》（段玉裁）注文的引用書目，供 swjzz.adb 的段注引文對照。',
    '目前收：說文解字（大徐本）、爾雅、周易、尚書、廣韻。以後在 ts/tools/swjzzsrc2adb.ts 的 BOOKS 表加一筆即可擴充。',
    '說文解字（大徐本）：shuowen.org 開放資料（github.com/shuowenjiezi/shuowen，Apache-2.0），附反切、徐鉉注與重文。',
    '爾雅：Kanripo KR1j0002，四部叢刊影明鈔本（晉 郭璞注），注文以 <注> 標記。',
    '周易：Kanripo KR1a0001（TLS 正文）。',
    '尚書：Kanripo KR1b0001（TLS 正文）。',
    '廣韻：Kanripo KR1j0055，四庫全書本《重修廣韻》（宋 陳彭年等）。',
    'Kanripo 漢籍リポジトリ（www.kanripo.org）為公開領域漢籍的全文化計畫；四部叢刊、四庫全書底本均為公有領域。',
    '缺字（Kanripo 的 &KRxxxx;）以「□」表示；原書小字以 <注> 標記。',
  ];
  lines.forEach((l, i) => {
    bump('條');
    push(`<條 id="A.${i + 1}">${esc(l)}</條>`);
  });
}
function toCn(n: number): string {
  const d = '〇一二三四五六七八九';
  if (n <= 10) return n === 10 ? '十' : d[n];
  if (n < 20) return '十' + d[n - 10];
  return d[Math.floor(n / 10)] + '十' + (n % 10 ? d[n % 10] : '');
}

// ── 主流程 ──────────────────────────────────────────────────────────────
const ref = loadShiwenRef(shuowenRefPath);
push('<檔 n="swjzzsrc">');
push('<集 c="isdict" l="說文,反切,徐鉉,注,條,篇,卷,部">說文解字注引用書目</集>');
push('<隱><樹 s="*" t="書">目錄</樹><樹 s="$字">說文字頭</樹><樹 s="*書">全文</樹></隱>');

emitAbout();
emitShuowen(ref);
emitErya('KR1j0002');
emitSentences({ id: 'zhouyi', n: '3', title: '周易', repo: 'KR1a0001', headRe: /^\*\*\s*《(.+?)》$/, prefix: 'Y' });
emitSentences({ id: 'shangshu', n: '4', title: '尚書', repo: 'KR1b0001', headRe: /^\*\*\s*(\d+)\s*《(.+?)》$/, prefix: 'B', ordered: true });
emitGuangyun('KR1j0055');

const text = out.join('\n') + '\n';
writeFileSync(outPath, text, 'utf8');
console.error(`lines ${out.length} chars ${text.length} maxLine ${maxLine}`);
console.error([...stats.entries()].map(([k, v]) => `${k}:${v}`).join(' '));
if (warnings.length) {
  console.error(`warnings ${warnings.length}:`);
  for (const w of warnings.slice(0, 10)) console.error('  ' + w);
}
