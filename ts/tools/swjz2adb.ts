#!/usr/bin/env bun
/**
 * 《說文解字注》XML（kanji-database.sourceforge.net／cjkvi-dict 的 `swjz.xml`）
 * → accelon 文字（一行一個 adb 行，一行＝一個 `<lb>`）。
 *
 *   bun run ts/tools/swjz2adb.ts <swjz.xml> <out.txt>
 *
 * 標記對照（左邊是 swjz.rnc 的元素）：
 *
 *   book/@title                 → 檔頭 dbcname（打包時另給）
 *   volumes/preface             → `<卷 n="序N" id="pNN">序名</卷>` ＋ 正文行
 *   volumes/catalogs            → 丟棄（目錄樹改由 `<卷 t>` 逐層宣告）
 *   chapter/chaptertitle        → `<卷 n id t="部,字.">說文解字第N篇上</卷>`
 *   author                      → `<作者>`
 *   shuowen                     → `<部 t="字.">X部</部>` ＋ `<字 id img>X</字>` ＋ 正文行
 *   shuowen/explanation         → `<說文>`
 *   shuowen/duan_note           → `<段注>`（內含 note→`<注>`、seal_script→`<篆>`）
 *   part_wordnum                → `<部數>文五　重一</部數>`（一部之末）
 *   volume_wordnum              → `<卷數>`
 *   endchapter                  → `<篇末>`
 *   addenda/addenda_title       → `<補遺>`
 *   publishdate                 → `<出版>`
 *   shuowen2（第十五卷）        → 敘文 ＋ `<節 t="部目.">說文解字第一</節>` ＋ `<部目 n>一</部目>`
 *   <!--IDS-->                  → `<構形>⿰氵㫄</構形>`（UCS 以外的字，XML 註解裡記的構形）
 *
 * 交付前一定要跑 §5 的驗收（abx inspect、probe-adb、目錄展開、行長）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { loadShiwenRef, normShiwen, type ShiwenRef } from '../src/swjz-ref';

/** 一行最多 4096 字（MAXLINELEN = 8192 bytes）；超過會讓 lines.physical 靜默錯位。 */
const MAX_LINE_CHARS = 4000;

type Node = string | El;
interface El {
  name: string;
  attrs: Record<string, string>;
  kids: Node[];
}

const ATTR_RE = /([\w.:-]+)\s*=\s*"([^"]*)"/g;
function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(ATTR_RE)) out[m[1]] = decodeEnt(m[2]);
  return out;
}
function decodeEnt(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

/** 極簡 XML：元素、文字、註解（註解保留成 `#comment`，IDS 要用）。 */
function parseXml(xml: string): El {
  const root: El = { name: '#root', attrs: {}, kids: [] };
  const stack: El[] = [root];
  const re =
    /<!--([\s\S]*?)-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<\/([A-Za-z_][\w.:-]*)\s*>|<([A-Za-z_][\w.:-]*)((?:\s[^>]*?)?)(\/?)>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const addText = (t: string) => {
    if (t) stack[stack.length - 1].kids.push(t);
  };
  while ((m = re.exec(xml))) {
    addText(xml.slice(last, m.index));
    last = re.lastIndex;
    if (m[1] !== undefined) {
      stack[stack.length - 1].kids.push({ name: '#comment', attrs: {}, kids: [m[1]] });
    } else if (m[2] !== undefined) {
      addText(m[2]);
    } else if (m[3] !== undefined) {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].name === m[3]) {
          stack.length = i;
          break;
        }
      }
    } else if (m[4] !== undefined) {
      const el: El = { name: m[4], attrs: parseAttrs(m[5] ?? ''), kids: [] };
      stack[stack.length - 1].kids.push(el);
      if (m[6] !== '/') stack.push(el);
    }
  }
  addText(xml.slice(last));
  return root;
}

/** 內文的空白：來源用 TAB／CRLF 排版，去掉；句中的空白保留（段注引文有）。 */
function clean(s: string): string {
  return s.replace(/[\r\n\t]+/g, '').replace(/^ +| +$/g, '');
}
function plain(n: Node): string {
  if (typeof n === 'string') return clean(n);
  if (n.name === '#comment') return '';
  return n.kids.map(plain).join('');
}
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 行內元素：段注裡的 note／seal_script／IDS 註解都保留成標記，不吞字。 */
// ── 大徐本《說文解字》核對（可選） ───────────────────────────────────────
/** 現在這一段說文是誰的（`<字>` 的下一行起算）。 */
let curHead: string | null = null;

/**
 * 一段許慎原文：先看大徐本有沒有這一段，核不到就標 `<說文異>`。
 * 沒有給 `--ref` 時一律標 `<說文>`（舊行為）。
 */
function shiwenTag(text: string): string {
  const body = text.replace(/^<說文>|<\/說文>$/g, '');
  if (!ref || !curHead) return `<說文>${body}</說文>`;
  const e = ref[curHead];
  if (!e) { stats.說文無參考++; return `<說文>${body}</說文>`; }
  const n = normShiwen(body);
  if (n.length < 2 || normShiwen(e.e).includes(n)) { stats.說文++; return `<說文>${body}</說文>`; }
  stats.說文異++;
  return `<說文異>${body}</說文異>`;
}

function inline(n: Node, comments: boolean): string {
  if (typeof n === 'string') return esc(clean(n));
  switch (n.name) {
    case '#comment': {
      const c = clean(n.kids.map((k) => (typeof k === 'string' ? k : '')).join(''));
      return comments && c ? `<構形>${esc(c)}</構形>` : '';
    }
    case 'note': return `<注>${n.kids.map((k) => inline(k, true)).join('')}</注>`;
    case 'seal_script': return `<篆>${n.kids.map((k) => inline(k, true)).join('')}</篆>`;
    case 'explanation': return shiwenTag(`<說文>${n.kids.map((k) => inline(k, true)).join('')}</說文>`);
    case 'duan_note': return `<段注>${n.kids.map((k) => inline(k, true)).join('')}</段注>`;
    default: return n.kids.map((k) => inline(k, comments)).join('');
  }
}
function kidsOf(el: El, name: string): El[] {
  return el.kids.filter((k): k is El => typeof k !== 'string' && k.name === name);
}
function child(el: El, name: string): El | undefined {
  return el.kids.find((k): k is El => typeof k !== 'string' && k.name === name);
}
/** 元素自己的文字（去掉註解）：標題、字頭、部數用。 */
function selfText(el: El, includeComments = false): string {
  return el.kids
    .map((k) => {
      if (typeof k === 'string') return clean(k);
      if (k.name === '#comment') return includeComments ? clean(plain(k)) : '';
      return selfText(k, includeComments);
    })
    .join('');
}

/** 只取「直接掛在這一層」的文字（不含子元素的文字）。
 *  混層元素（chaptertitle／part_wordnum／endchapter）要這樣取，子元素的 duan_note 才不會重複。 */
function directText(el: El): string {
  return el.kids.map((k) => (typeof k === 'string' ? clean(k) : '')).join('');
}

// ── 輸出 ────────────────────────────────────────────────────────────────
const out: string[] = [];
const stats = {
  卷: 0, 部: 0, 部目: 0, 節: 0, 字: 0, 說文: 0, 說文異: 0, 說文無參考: 0, 段注: 0, 篆: 0, 注: 0, 構形: 0,
  部數: 0, 卷數: 0, 篇末: 0, 補遺: 0, 作者: 0, 出版: 0, 序: 0, 長行: 0, 空行: 0,
};
const warnings: string[] = [];
const unknown = new Map<string, number>();
let maxLine = 0;
let maxLineHead = '';

/** 一行可能太長（來源的單一段注最長 1,287 字，理論上不會，但撐不住就硬切在句號後）。 */
function push(raw: string) {
  const s = raw.replace(/[\r\n]+/g, '');
  if (!s.trim()) { stats.空行++; return; }
  if (s.length > MAX_LINE_CHARS) {
    stats.長行++;
    warnings.push(`長行 ${s.length} 字：${s.slice(0, 40)}…`);
    // 在最近的「。」「；」切開，剩下的照切
    let rest = s;
    while (rest.length > MAX_LINE_CHARS) {
      let cut = -1;
      for (const ch of ['。', '；', '，']) {
        const at = rest.lastIndexOf(ch, MAX_LINE_CHARS);
        if (at > cut) cut = at;
      }
      if (cut <= 0) cut = MAX_LINE_CHARS;
      out.push(rest.slice(0, cut + 1));
      rest = rest.slice(cut + 1);
    }
    rest && out.push(rest);
  } else {
    out.push(s);
  }
  if (s.length > maxLine) { maxLine = s.length; maxLineHead = s.slice(0, 40); }
}
const bump = (k: keyof typeof stats) => { stats[k]++; };

// ── 走訪 ────────────────────────────────────────────────────────────────

/** 一個 shuowen／section 的正文：explanation 與 duan_note 交替，各佔一行。 */
function emitNotePairs(parent: El) {
  for (const k of parent.kids) {
    if (typeof k === 'string') continue;
    if (k.name === 'explanation') { push(inline(k, true)); }
    else if (k.name === 'duan_note') { bump('段注'); push(inline(k, true)); }
    else if (k.name === 'note') { bump('注'); push(`<注>${k.kids.map((x) => inline(x, false)).join('')}</注>`); }
    else if (k.name === 'seal_script') { bump('篆'); push(`<篆>${k.kids.map((x) => inline(x, false)).join('')}</篆>`); }
    else if (k.name === 'wordhead' || k.name === 'addenda_title' || k.name === 'part_word'
      || k.name === 'part_wordnum' || k.name === 'volume_wordnum' || k.name === 'endchapter'
      || k.name === 'author' || k.name === 'addenda' || k.name === 'publishdate' || k.name === 'section') {
      // 由呼叫端處理（這裡不會出現）
    } else if (k.name !== '#comment') {
      unknown.set(k.name, (unknown.get(k.name) ?? 0) + 1);
      push(inline(k, true));
    }
  }
}

/** 標題文字＋短注（上／下）併進標題；長注（章首那段考證）另起 `<段注>` 行。 */
function titleAndNote(el: El): { label: string; longNotes: string[] } {
  const title = directText(el);
  const notes = kidsOf(el, 'duan_note').map((k) => directText(k));
  const shortAll = notes.every((n) => n.length <= 3);
  return {
    label: notes.length && shortAll ? title + notes.join('') : title,
    longNotes: shortAll ? [] : notes,
  };
}

/** 上一卷末尾沒有 `<part_wordnum>`（部還沒結束，跨卷）時，下一卷要沿用部首名。 */
let carryPart: string | null = null;

/** 一個字頭（wordhead）：`<部>`（必要時先開）＋`<字 id img>頭</字>`。 */
function emitWordhead(wh: El, state: { part: string | null }) {
  const head = selfText(wh);
  const ids = selfText(wh, true).slice(head.length);
  if (!head) warnings.push('wordhead 沒有字頭');
  if (!state.part) {
    // 水部橫跨「十一篇上之一／之二」：上一卷沒收部，這裡沿用部首名（不另立新部）
    const label = carryPart ?? head;
    carryPart = null;
    state.part = label;
    bump('部');
    push(`<部 t="字.">${esc(label)}部</部>`);
  }
  bump('字');
  curHead = head;
  const attrs = Object.entries(wh.attrs)
    .filter(([k, v]) => v && (k === 'id' || k === 'img'))
    .map(([k, v]) => ` ${k}="${esc(v)}"`).join('');
  const sealTag = seal.get(head) ? `<圖 n="${esc(seal.get(head)!)}"/>` : '';
  push(`<字${attrs}>${esc(head)}</字>${sealTag}${ids ? `<構形>${esc(ids)}</構形>` : ''}`);
}

/** 一個 `<shuowen>`：**可以有好幾個字頭**（`(wordhead, text_note2?)+`），
 *  每個 wordhead 各開一個 `<字>`，其後的說文／段注都算那一條。 */
function emitShuowen(sw: El, state: { part: string | null }) {
  for (const k of sw.kids) {
    if (typeof k === 'string') continue;
    if (k.name === 'wordhead') { emitWordhead(k, state); continue; }
    if (k.name === 'explanation') { push(inline(k, true)); continue; }
    if (k.name === 'duan_note') { bump('段注'); push(inline(k, true)); continue; }
    if (k.name === 'note') { bump('注'); push(`<注>${k.kids.map((x) => inline(x, true)).join('')}</注>`); continue; }
    if (k.name === 'seal_script') { bump('篆'); push(`<篆>${k.kids.map((x) => inline(x, true)).join('')}</篆>`); continue; }
    if (k.name === '#comment') continue;
    unknown.set(k.name, (unknown.get(k.name) ?? 0) + 1);
    push(inline(k, true));
  }
}

function walkChapter(ch: El, index: number) {
  const ct = child(ch, 'chaptertitle');
  bump('卷');
  const { label, longNotes } = ct ? titleAndNote(ct) : { label: `第${index}篇`, longNotes: [] };
  const id = ct?.attrs.id ?? '';
  const hasPart = kidsOf(ch, 'shuowen').length > 0;
  const hasSection = kidsOf(ch, 'shuowen2').some((s) => kidsOf(s, 'section').length > 0);
  const tiers = hasSection ? ' t="節,部目."' : hasPart ? ' t="部,字."' : '';
  // 卷號優先用原書的篇號（v01…v28、v15a／v15b、v29／v30）；沒有就用順序
  const n = /^v\d+[a-z]?$/.test(id) ? id.slice(1) : String(index);
  push(`<卷 n="${n}"${id ? ` id="${esc(id)}"` : ''}${tiers}>${esc(label)}</卷>`);
  const state = { part: null as string | null };
  for (const n of longNotes) { bump('段注'); push(`<段注>${esc(n)}</段注>`); }
  for (const k of ch.kids) {
    if (typeof k === 'string') continue;
    const sum = directText(k);
    switch (k.name) {
      case 'chaptertitle':
      case '#comment':
        break;
      case 'author':
        bump('作者');
        push(`<作者>${esc(sum)}</作者>`);
        break;
      case 'shuowen':
        emitShuowen(k, state);
        break;
      case 'part_wordnum': {
        state.part = null;
        bump('部數');
        push(`<部數>${esc(sum)}</部數>`);
        for (const n of kidsOf(k, 'duan_note')) { bump('段注'); push(inline(n, true)); }
        break;
      }
      case 'volume_wordnum':
        bump('卷數');
        push(`<卷數>${esc(sum.replace(/[\r\n]+/g, '　'))}</卷數>`);
        for (const n of kidsOf(k, 'duan_note')) { bump('段注'); push(inline(n, true)); }
        break;
      case 'endchapter': {
        const { label: t2 } = titleAndNote(k);
        bump('篇末');
        push(`<篇末>${esc(t2)}</篇末>`);
        break;
      }
      case 'addenda': {
        bump('補遺');
        const at = child(k, 'addenda_title');
        push(`<補遺>${esc(at ? selfText(at) : '補遺')}</補遺>`);
        emitNotePairs(k);
        break;
      }
      case 'publishdate':
        bump('出版');
        push(`<出版>${esc(sum)}</出版>`);
        break;
      case 'shuowen2': {
        emitNotePairs(k);
        for (const sec of kidsOf(k, 'section')) {
          const num = child(sec, 'section_num');
          bump('節');
          push(`<節 t="部目.">${esc(num ? selfText(num) : '')}</節>`);
          let ord = 0;
          for (const pw of kidsOf(sec, 'part_word')) {
            ord++;
            const wh = child(pw, 'wordhead');
            const head = wh ? selfText(wh) : '';
            const rest = directText(pw); // 「部一」
            const n = /\d+/.exec(rest)?.[0] ?? String(ord);
            bump('部目');
            push(`<部目 n="${esc(n)}">${esc(head)}</部目>`);
            for (const dn of kidsOf(pw, 'duan_note')) { bump('段注'); push(inline(dn, true)); }
            if (!wh) warnings.push('part_word 沒有部首');
          }
        }
        break;
      }
      default:
        unknown.set(k.name, (unknown.get(k.name) ?? 0) + 1);
        push(inline(k, true));
    }
  }
  // 這一卷結束時部還沒收（沒有 part_wordnum）→ 下一卷沿用同一個部首
  if (state.part) carryPart = state.part;
}

let prefaceSeq = 0;
function walkPreface(pf: El) {
  bump('卷');
  bump('序');
  const titles = kidsOf(pf, 'prefacetitle');
  const contents = kidsOf(pf, 'content');
  titles.forEach((t, i) => {
    const name = selfText(t);
    const seq = ++prefaceSeq;
    push(`<卷 n="序${seq}" id="p${String(seq).padStart(2, '0')}">${esc(name)}</卷>`);
    const c = contents[i];
    if (!c) return;
    // content 是 mixed：文字段落一行，duan_note 各一行
    const buf: string[] = [];
    for (const k of c.kids) {
      if (typeof k === 'string') { buf.push(esc(clean(k))); continue; }
      if (k.name === 'duan_note') {
        if (buf.join('').trim()) push(buf.join(''));
        buf.length = 0;
        bump('段注');
        push(inline(k, true));
      } else {
        buf.push(inline(k, true));
      }
    }
    if (buf.join('').trim()) push(buf.join(''));
  });
}

// ── 主流程 ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
let refPath: string | null = null;
let sealPath: string | null = null;
const positional: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--ref') { refPath = args[++i] ?? null; continue; }
  if (args[i] === '--seal') { sealPath = args[++i] ?? null; continue; }
  positional.push(args[i]);
}
const [xmlPath, outPath] = positional;
if (!xmlPath || !outPath) {
  console.error('usage: bun run ts/tools/swjz2adb.ts <swjz.xml> <out.txt> [--ref shiwen-ref.json] [--seal seal-manifest.tsv]');
  process.exit(2);
}
let ref: ShiwenRef | null = null;
if (refPath) {
  ref = loadShiwenRef(refPath);
  console.error(`ref ${refPath}: ${Object.keys(ref).length} 個大徐本字頭`);
}
/** 小篆字形：字 → resource 名稱（`seal/U4E00.svg`） */
const seal = new Map<string, string>();
if (sealPath) {
  for (const line of readFileSync(sealPath, 'utf8').split('\n')) {
    const [, ch, , res] = line.split('\t');
    if (ch && res) seal.set(ch, res.trim());
  }
  console.error(`seal ${sealPath}: ${seal.size} 個字形`);
}
const xml = readFileSync(xmlPath, 'utf8');
if (/\uFFFD/.test(xml)) warnings.push('來源含 U+FFFD 亂碼');
const root = parseXml(xml);
const book = child(root, 'book')!;
if (!book) throw new Error('找不到 <book>');
const volumes = child(book, 'volumes')!;
const dbTitle = book.attrs.title ?? '說文解字注';

push('<檔 n="swjz.xml">');
push(`<集 c="isdict" l="說文,段注,篆,注,構形,部數,卷數,篇末,補遺,作者,出版">${esc(dbTitle)}</集>`);
push('<隱><樹 s="*" t="卷">目錄</樹><樹 s="$字">字頭</樹><樹 s="*字">全文</樹></隱>');

let chapterIndex = 0;
for (const k of volumes.kids) {
  if (typeof k === 'string') continue;
  if (k.name === 'preface') { walkPreface(k); continue; }
  if (k.name === 'chapter') { walkChapter(k, ++chapterIndex); continue; }
  if (k.name === 'catalogs') continue; // 目錄樹由 <卷 t> 宣告
  if (k.name === '#comment') continue;
  unknown.set(k.name, (unknown.get(k.name) ?? 0) + 1);
}

const text = out.join('\n') + '\n';
writeFileSync(outPath, text, 'utf8');

console.error(`dbcname ${dbTitle}`);
console.error(
  `lines ${out.length}  chars ${text.length}  maxLine ${maxLine} ${JSON.stringify(maxLineHead)}`,
);
console.error(
  Object.entries(stats).filter(([, v]) => v).map(([k, v]) => `${k}:${v}`).join(' '),
);
if (unknown.size) console.error('unknown elements:', [...unknown.entries()].map(([k, v]) => `${k}:${v}`).join(' '));
if (warnings.length) {
  console.error(`warnings ${warnings.length}:`);
  for (const w of warnings.slice(0, 20)) console.error('  ' + w);
}
