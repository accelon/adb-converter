#!/usr/bin/env bun
/**
 * offtext（`.off`，pitaka／accelon22 的來源格式）→ Accelon XML（adb 的文字層）。
 *
 *   bun run ts/tools/off2accelon.ts --src D:/2023/cs-mm/off --out D:/2026/sz/cs-mm \
 *     --glob "*.mm.off" --strip ".mm.off" --notes "-fn.off" --notesout "-fn" \
 *     --dbname cs-mm --dbcname 緬譯巴利藏 --enname "Tipitaka Myanmar"
 *
 * 只做「文字轉換」：輸出是一行一個 adb 行的 Accelon XML，不做 adb（打包交給各庫的 pack.ts）。
 * 規則、對照表與已知限制見 `docs/adb/off-to-accelon.md`。
 *
 * 三個重要約定（2026-11-02，作者定）：
 *   1. **一行對一行**：輸出行數＝來源行數（文件層級）。平行文本靠這個對齊，使用者也容易
 *      捲動比較；所以不刪空行、不併行，`<居中>` 這類標籤可以和文字接在同一行。
 *      唯一的例外是超過 4,096 字的行要切開（`an8`／`an9`／`an10`／`an11`）。
 *   2. **正文與註文分檔**：`^fN` → `<註 n="N" pg="塊.段"/>`（正文檔）；
 *      `-fn.off` 的 `^fnN 文字` → `<釋 n="N" pg="塊.段">…</釋>`（`<書>-fn.xml`）。
 *   3. **標籤**：`^ak`→`<區>`、`^bk`→`<書>`、`^ck`→`<塊>`、`^n`→`<段 n>`；
 *      頁 id（`<頁 id="塊.段">`）之後才補，`--pageid` 打開時才會輸出。
 *
 * 選項：
 *   --src <dir>         .off 目錄（必填）
 *   --out <dir>         輸出目錄（必填；會建立）
 *   --glob <pat>        要轉的檔名樣式（預設 `*.off`；`?` 一個字、`*` 任意）
 *   --strip <suffix>    檔名去掉這個後綴就是書 id（預設 `.off`）
 *   --notes <suffix>    註文來源後綴，例 `-fn.off`（沒有就不處理註）
 *   --notesout <suffix> 註文輸出檔名後綴，例 `-fn` → `<book>-fn.xml`（預設 `-fn`）
 *   --pageid <template> 頁 id 模板；`{ck}`／`{n}`／`{book}` 會被替換（預設空字串＝不輸出 `<頁>`）
 *   --pg <template>     註文配對用的 pg 模板（預設 `{ck}.{n}`）
 *   --dbname <s>        dbname（寫進 `<檔 n=…>`；預設 off 目錄名）
 *   --dbcname <s>       中文庫名（`<集>`）
 *   --enname <s>        英文庫名（`<英文名>`）
 *   --header <file>     宣告檔名（預設 `00.xml`；空字串＝不寫）
 *   --maxlen <n>        每行字元上限（預設 4096；accelon3 是 8192 bytes）
 *   --limit <n>         只轉前 n 個檔（除錯）
 *   --report <file>     報告檔（預設 <out>/../out/off2accelon-report.txt）
 *   --dry               只跑不寫檔
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

// ---------------------------------------------------------------- 規則表

export interface OffTagRule {
  /** 輸出的 Accelon 標籤名 */
  tag: string;
  /** 壓縮 id（`^bk#dn1` 的 `dn1`、`^pb12` 的 `12`）要放進哪個屬性 */
  attr: 'id' | 'n' | 'none';
  /** block：標籤後面（到下一個標籤為止）的文字是它的內容；milestone：只是里程碑 */
  kind: 'block' | 'milestone';
}

/**
 * off 標籤 → Accelon 標籤。key 是 off 的標籤名（只有小寫字母；數字後綴是壓縮 id，
 * 見 `ruleOf()` 對 `subhead2`／`subhead3` 的特別處理）。
 *
 * 作者 2026-11-02 定的四個結構標籤：區（ak）／書（bk）／塊（ck）／段（n）。
 * 其餘沿用既有 adb 的名字（頁／註／釋／章／節）。改名只要改這張表。
 */
export const RULES: Record<string, OffTagRule> = {
  ak: { tag: '區', attr: 'id', kind: 'block' }, // 部（尼柯耶）：^ak#dn(Long Discourses)
  bk: { tag: '書', attr: 'id', kind: 'block' }, // 冊：^bk#dn1(書名)
  ck: { tag: '塊', attr: 'id', kind: 'block' }, // 塊（chunk）：長部／中部的一經、相應部的一相應、增支部的一集
  ckan: { tag: '小塊', attr: 'id', kind: 'block' }, // 塊再細分（增支部的一經：a1a）
  cksn: { tag: '小塊', attr: 'id', kind: 'block' }, // 塊再細分（相應部的一相應：s1a）
  n: { tag: '段', attr: 'n', kind: 'milestone' }, // 段號（定位：塊.段）
  pb: { tag: 'pb', attr: 'n', kind: 'milestone' }, // 原書頁界（緬甸版頁碼；不是定位用的頁）
  f: { tag: '註', attr: 'n', kind: 'milestone' }, // 註號（文內）
  fn: { tag: '釋', attr: 'n', kind: 'milestone' }, // 註文（只出現在 -fn.off）
  center: { tag: '居中', attr: 'none', kind: 'block' }, // 置中題／經末標記
  title: { tag: '題', attr: 'none', kind: 'block' }, // 書題
  chapter: { tag: '章', attr: 'none', kind: 'block' },
  subhead: { tag: '節', attr: 'none', kind: 'block' },
  subsubhead: { tag: '項', attr: 'none', kind: 'block' }, // 與 subhead2 同層
  unindent: { tag: '頂格', attr: 'none', kind: 'milestone' }, // 「這一段不縮排」的段落標記（不帶文字）
  head: { tag: '首', attr: 'none', kind: 'block' },
  classe: { tag: '類', attr: 'none', kind: 'block' },
  // 其他譯本（yh／ccc／xsq／pku／hz／kmj）用到的
  z: { tag: '章', attr: 'none', kind: 'block' }, // `^z1(經名)`／`^z2(品)`／`^z3(小節)`：層級在 id
  h: { tag: '小節', attr: 'none', kind: 'block' }, // 行內小標題（ccc／yh）
  sz: { tag: '偈', attr: 'none', kind: 'milestone' }, // 偈頌行（CBETA `<l>`）
  m: { tag: 'm', attr: 'n', kind: 'milestone' }, // 該譯本自己的段號（不是緬甸版的 n）
  miss: { tag: '缺', attr: 'none', kind: 'milestone' },
  doubt: { tag: '疑', attr: 'none', kind: 'milestone' },
  empty: { tag: '空', attr: 'none', kind: 'milestone' },
  p: { tag: 'pb', attr: 'n', kind: 'milestone' }, // 殘留的頁標記（ccc an1 的 ^p1）
  a: { tag: '錨', attr: 'none', kind: 'milestone' }, // 殘留的錨（ccc an1 的 ^a(1)，夾文留正文）
  b: { tag: 'b', attr: 'none', kind: 'milestone' },
  nn: { tag: 'nn', attr: 'none', kind: 'milestone' },
  trailer: { tag: '尾', attr: 'none', kind: 'block' },
  end: { tag: '終', attr: 'none', kind: 'block' },
  // 行內的引用連結（cs 的 `^t@dhp.53`）：目標放在 `j=`，給閱讀器跳轉用
  t: { tag: '聯', attr: 'none', kind: 'milestone' },
};

/** `^subhead2` 這一類「標籤名＋數字」其實是標題層級（gen 從 h3/h4 轉來的）。 */
const SUBHEAD_LEVEL_TAG: Record<string, string> = { '2': '項', '3': '目', '4': '小目', '5': '細目' };
/** `^z1/^z2/^z3`：目錄層級（1＝篇／經，2＝章／品，3＝節／小節）。 */
const Z_LEVEL_TAG: Record<string, string> = { '1': '篇', '2': '章', '3': '節', '4': '項', '5': '目' };

export function ruleOf(name: string, id: string): OffTagRule | null {
  if (name === 'subhead' && /^\d+$/.test(id)) {
    return { tag: SUBHEAD_LEVEL_TAG[id] ?? '節', attr: 'none', kind: 'block' };
  }
  if (name === 'z' && /^\d+$/.test(id)) {
    return { tag: Z_LEVEL_TAG[id] ?? '節', attr: 'none', kind: 'block' };
  }
  return RULES[name] ?? null;
}

/** 目錄樹的層級：區→書→塊（`t=` 逐實例宣告；末層加「.」表示不再往下）。 */
const TOC_CHILD: Record<string, string> = { 區: '書.', 書: '塊.' };

/** 夾文後面緊接的文字算標題的一部分（塊／書／區）：SC 的 ^ck#d1(Brahmajāla )1. Talk… */
const JOIN_FOLLOW = new Set(['ak', 'bk', 'ck', 'ckan', 'cksn']);

/** 可以「續行」的標籤：標籤在行尾、文字在下一行時，把下一行開頭的文字收進來。 */
const CARRY_TAGS = new Set(['居中', '題', '章', '節', '項', '目', '小目', '首', '類', '尾', '終', '小塊', '塊', '書', '區']);
/** 續行時可以先跳過的里程碑標籤（`<段 n="7"/>`、`<pb n="4"/>`、`<註 n="2"/>` …） */
const LEADING_MILESTONE = /^(?:<(?:段|pb|註|頂格|b|nn)\b[^<>]*\/>)*/;

// ---------------------------------------------------------------- offtag 解析

/** ptk `eatofftag` 的字元集（標籤名＋壓縮屬性都在這一段裡）。 */
const TAGCHAR = /[-\$.\/0-9:;_#@a-z~]/;
/** 夾文括號（前後 Unicode 必須相差 1）。 */
const BRACKET: Record<string, string> = {
  '(': ')', '（': '）', '「': '」', '『': '』', '〔': '〕', '【': '】',
  '《': '》', '〈': '〉', '‘': '’', '“': '”', '﹙': '﹚', '﹝': '﹞',
};

export interface ParsedOffTag {
  name: string;
  id: string;
  /** `^t@dhp.53` 的連結目標（`@` 之後那一段） */
  link?: string;
  /** 夾文內容（不含括號）；沒有夾文就是 undefined */
  inner?: string;
  /** 夾文原樣（含括號）：顯示時括號要留著，ptk 也是這樣 */
  rawInner?: string;
  /** 標籤結束的位置（指向標籤之後的第一個字元） */
  end: number;
}

/**
 * 讀一個 offtag。`at` 必須指向 `^`。
 *
 * ptk 的語法：`^` + 名稱（只有 `[a-z_:]`）+ 壓縮屬性（`#id`、`~寬度`、`@連結`、數字開頭的 id），
 * 之後若緊接括號就是夾文。名稱後面的空白**不是**內容的一部分，只是分隔。
 */
export function readTag(line: string, at: number): ParsedOffTag | null {
  if (line[at] !== '^') return null;
  let i = at + 1;
  const start = i;
  while (i < line.length && TAGCHAR.test(line[i])) i++;
  const token = line.slice(start, i);
  if (!token) return null;
  const m = /^([a-z_:]+)(.*)$/.exec(token);
  if (!m) return null;
  const name = m[1];
  const compact = m[2] ?? '';
  let id = '';
  let link = '';
  if (compact) {
    if (compact[0] === '#') id = compact.slice(1);
    else if (compact[0] === '@') {
      // `^t@ds.251g3aAdyO`：引用常常緊貼著被引的詞（沒有空白），
      // 只把「書.頁[g偈]」那一段當目標，後面的字還給正文
      const ref = /^[a-z][a-z0-9]*(?:\.[0-9]+(?:-[0-9]+)?)+(?:g[0-9]+)?/.exec(compact.slice(1));
      link = ref ? ref[0] : compact.slice(1);
      if (ref) i = start + name.length + 1 + ref[0].length;
    } else if (compact[0] === '~') id = '';
    else id = compact;
    // 樣板漏字：sn5.mm.off:4781 的 `^n553-586undefined`（gen.js 的 `${x}` 沒值）
    if (id.endsWith('undefined')) id = id.slice(0, -'undefined'.length);
    // xsq 的 PTS 段號寫成 `^n1.`（句點是原文標點，不是 id）：留給正文，不進 id
    if (id.endsWith('.')) id = id.slice(0, -1);
  }
  let inner: string | undefined;
  let rawInner: string | undefined;
  // 夾文：括號要**配對**（`^h((1)有偈篇)` 的內容是 `(1)有偈篇`，不是 `(1`）
  const open = line[i];
  const close = BRACKET[open];
  if (close) {
    let depth = 0;
    let k = i;
    for (; k < line.length; k++) {
      if (line[k] === open) depth++;
      else if (line[k] === close) {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth === 0 && k > i) {
      inner = line.slice(i + 1, k);
      rawInner = line.slice(i, k + 1);
      i = k + 1;
    }
  }
  return { name, id, link: link || undefined, inner, rawInner, end: i };
}

// ---------------------------------------------------------------- 單行轉換

export interface LineContext {
  book: string;
  /** 壞掉的塊 id 修復佇列（依出現順序取用）：xsq dn2／dn3 的 ^ck$1` */
  ckQueue?: string[];
  /** 最近的 `^ck`（塊 id） */
  ck: string;
  /** 目前的段號（最近的 `^n`） */
  pn: string;
  /** 頁 id 模板：`{ck}`／`{n}`／`{book}`。空字串＝不輸出 `<頁>`（頁之後才補） */
  pageId: string;
  /** 註文配對用的 pg 模板（預設 `{ck}.{n}`） */
  pgTemplate: string;
  warnings: string[];
  tagCounts: Record<string, number>;
  /**
   * 正文轉寫器（預設只做轉義）。`plain`＝目前正在渲染節點名字（區／書／塊的夾文），
   * 這種地方不能再插行內標籤（例：巴利底本的 `<詞>`），否則目錄名會被拆壞。
   */
  text?: (s: string, plain: boolean) => string;
  /** 目前是否在渲染節點名字 */
  plain?: boolean;
  /** 塊 id 正規化（例：義注加 `a`、複注加 `t`、再複注加 `x`） */
  ckTransform?: (id: string, book: string) => string;
}

export const escapeText = (s: string): string =>
  s
    .replace(/&nbsp;/g, ' ')
    .replace(/\t/g, ' ')
    // 來源殘留的 HTML（ccc 有 <br>、<a …>、</a>、</span>）：標籤丟掉、文字留下
    .replace(/<\/?[a-zA-Z][^<>]{0,200}>/g, '')
    // 正文裡孤立的 < >（ccc an7 的錯字）換全形，否則會被當成標籤
    .replace(/</g, '＜')
    .replace(/>/g, '＞');

const attrsOf = (rule: OffTagRule, id: string): string =>
  rule.attr !== 'none' && id ? ` ${rule.attr}="${id}"` : '';

const fillTemplate = (ctx: LineContext, tpl: string, pn: string): string =>
  tpl
    ? tpl
        .replace(/\{ck\}/g, ctx.ck || ctx.book)
        .replace(/\{n\}/g, pn)
        .replace(/\{book\}/g, ctx.book)
    : '';

const countTag = (ctx: LineContext, tag: string): void => {
  ctx.tagCounts[tag] = (ctx.tagCounts[tag] ?? 0) + 1;
};

/** 一段文字 → 輸出文字（有轉寫器就用轉寫器，否則只做轉義）。 */
const textOf = (s: string, ctx: LineContext): string =>
  ctx.text ? ctx.text(s, !!ctx.plain) : escapeText(s);

/**
 * 夾文內容（含外圍括號）。夾文裡面**也可能有 offtag**（例 yh 的 `『…^f2…』`），
 * 所以要遞迴轉一次，不能原樣貼上。
 */
function renderInner(t: ParsedOffTag, ctx: LineContext, plain = false): string {
  if (!t.rawInner) return '';
  const open = t.rawInner[0];
  const close = t.rawInner[t.rawInner.length - 1];
  const prev = ctx.plain;
  if (plain) ctx.plain = true;
  const inner = renderSegment(t.inner ?? '', 0, false, ctx).out;
  ctx.plain = prev;
  return open + inner + close;
}

/** 把一段文字裡的 offtag 換成 Accelon 標籤。`inBlock` 時遇到標籤就停。 */
function renderSegment(
  s: string,
  start: number,
  inBlock: boolean,
  ctx: LineContext,
): { out: string; end: number; stop: boolean } {
  let out = '';
  let i = start;
  for (;;) {
    const at = s.indexOf('^', i);
    if (at < 0) {
      out += textOf(s.slice(i), ctx);
      return { out, end: s.length, stop: false };
    }
    out += textOf(s.slice(i, at), ctx);
    const t = readTag(s, at);
    if (!t) {
      // 孤立的 `^`（`^n3^` 的續行記號）：ptk 也是直接丟掉
      i = at + 1;
      ctx.warnings.push(`孤立的 ^（第 ${at + 1} 字，已略過）`);
      continue;
    }
    // `^:` 是 schema 宣告（0.off 的 tag 清單），不是正文
    if (t.name === ':') {
      ctx.warnings.push('略過 ^: 宣告');
      return { out, end: s.length, stop: false };
    }
    // 收標題文字時遇到任何標籤就停（標題裡的註號會把標題斷開，文字不丟）
    if (inBlock) return { out, end: at, stop: true };

    // 壞掉的塊 id（xsq 的 `^ck$1`，全部一樣）：依出現順序換成正確的 id
    if (t.name === 'ck' && (!t.id || t.id.startsWith('$')) && ctx.ckQueue?.length) {
      t.id = ctx.ckQueue.shift()!;
    }
    // 塊 id 正規化：義注／複注／再複注加尾綴（a／t／x），讓塊 id 全庫唯一
    if (ctx.ckTransform && t.id && (t.name === 'ck' || t.name === 'ckan' || t.name === 'cksn')) {
      t.id = ctx.ckTransform(t.id, ctx.book);
    }
    const rule = ruleOf(t.name, t.id);
    if (!rule) ctx.warnings.push(`未知標籤 ^${t.name}${t.id ? '#' + t.id : ''}（當 block 保留文字）`);
    const r: OffTagRule = rule ?? { tag: `_${t.name}`, attr: 'none', kind: 'block' };

    if (r.kind === 'milestone') {
      if (t.name === 'ck') ctx.ck = t.id;
      if (t.name === 'n') {
        // `^n `（只有空格、沒有段號）：來源的「這一 <p> 沒有段號」，不產生 `<段>`
        if (!t.id) {
          i = t.end;
          continue;
        }
        ctx.pn = t.id;
        if (ctx.pageId) {
          const pid = fillTemplate(ctx, ctx.pageId, t.id);
          if (pid) {
            out += `<頁 id="${pid}"/>`;
            countTag(ctx, '頁');
          }
        }
        out += `<段 n="${t.id}"/>`;
        countTag(ctx, '段');
        // `^n85『唯然…』`：段號後面緊接引號會被讀成夾文，文字要留下（裡面可能還有標籤）
        if (t.rawInner) out += renderInner(t, ctx);
        i = t.end;
        continue;
      }
      let extra = '';
      // 註號要帶 pg（＝它所在段落的 塊.段），閱讀器靠 n＋pg 配對同一條註
      if (t.name === 'f' && ctx.pn) {
        const pg = fillTemplate(ctx, ctx.pgTemplate, ctx.pn);
        if (pg) extra = ` pg="${pg}"`;
      }
      // `^t@dhp.53`：引用連結，目標放 `j=`
      if (t.link) extra = ` j="${escapeText(t.link).replace(/"/g, '“')}"`;
      out += `<${r.tag}${attrsOf(r, t.id)}${extra}/>`;
      // 里程碑標籤沒有「內容」，夾文要留在正文（括號也留，和 ptk 的顯示一致）
      if (t.rawInner) out += renderInner(t, ctx);
      countTag(ctx, r.tag);
      i = t.end;
      continue;
    }

    // block：夾文（含括號）＋緊接的文字是內容；沒有夾文時收後面到下一個標籤為止的文字
    if (t.name === 'ck') ctx.ck = t.id || ctx.ck;
    // 夾文是節點名字（書名／塊名／小標題），用 plain 模式渲染，不插行內標籤
    let inner = t.rawInner === undefined ? '' : renderInner(t, ctx, true);
    let next: number = t.end;
    if (t.rawInner === undefined) {
      const sub = renderSegment(s, t.end, true, ctx);
      inner = sub.out;
      next = sub.end;
    } else {
      // 夾文後面可能還有緊接的文字，那是標題的另一半（SC 的
      // `^ck#d1(The Prime Net )1. Talk…`）。只有「書／塊」這類 id 標籤才併；
      // 標題標籤（`^h(小標)正文…`）後面的文字是正文，不能吸進來。
      if (JOIN_FOLLOW.has(t.name)) {
        const prev = ctx.plain;
        ctx.plain = true;
        const sub = renderSegment(s, t.end, true, ctx);
        ctx.plain = prev;
        if (sub.out.trim()) {
          next = sub.end;
          inner = [inner.trim(), sub.out.trim()].filter(Boolean).join(' ');
        }
      }
    }
    const content = inner.trim();
    // 目錄樹的層級鏈：區宣告子層「書」、書宣告子層「塊」（`t=` 是逐實例的宣告）
    const tocChild = TOC_CHILD[r.tag] ? ` t="${TOC_CHILD[r.tag]}"` : '';
    out += content
      ? `<${r.tag}${attrsOf(r, t.id)}${tocChild}>${content}</${r.tag}>`
      : `<${r.tag}${attrsOf(r, t.id)}${tocChild}/>`;
    countTag(ctx, r.tag);
    i = next;
    if (i >= s.length) return { out, end: s.length, stop: false };
  }
}

/** 一行 off → 一行 Accelon XML。 */
export function convertLine(line: string, ctx: LineContext): string {
  return renderSegment(line, 0, false, ctx).out;
}

/** 目錄樹的層級：區→書→塊（`t=` 逐實例宣告，空字串＝沒有子層）。 */
/** 標題標籤（拿來當塊的目錄名）：由粗到細，取「同一行最近的一個」。 */
const HEAD_FOR_NAME = /<(篇|章|節|項|目|小節|居中)>([^<>]*)<\/\1>/g;

/**
 * `<塊/>` 沒有名字時，用它**同一行前面最近的標題**當目錄名（`n=`）。
 *
 * 為什麼要這個：yh／ccc 的塊多半沒有夾文（名字在緊接的 `^h(...)`／`^z3(...)` 標題裡），
 * 沒有名字的目錄節點在樹上只顯示子節點數，很難瀏覽。只補 `n=`（目錄顯示用），
 * 不動 `id=`（定位用），也不動正文。
 */
const cleanName = (s: string): string =>
  s
    .trim()
    .replace(/^[「『【〔（(﹙\[]+/, '')
    .replace(/[」』】〕）)﹚\]]+$/, '')
    .trim();

const attrOf = (attrs: string, name: string): string => {
  const m = new RegExp('\\b' + name + '\\s*=\\s*"([^"]*)"').exec(attrs);
  return m ? m[1] : '';
};

export function nameChunks(line: string): string {
  if (!line.includes('<塊') && !line.includes('<書')) return line;
  let out = line;
  // 塊：同一行前面最近的標題 → 沒有就用 id
  out = out.replace(/<塊([^<>]*?)\/>/g, (whole: string, attrs: string, offset: number) => {
    if (/\bn\s*=/.test(attrs)) return whole;
    const before = out.slice(0, offset);
    let last = '';
    for (const m of before.matchAll(HEAD_FOR_NAME)) last = m[2] ?? '';
    const name = cleanName(last) || attrOf(attrs, 'id');
    if (!name) return whole;
    return `<塊${attrs} n="${name.replace(/"/g, '“')}"/>`;
  });
  // 書：沒有夾文時，用同一行後面的 <題>（書題）→ 沒有就用 id
  out = out.replace(/<書([^<>]*?)\/>/g, (whole: string, attrs: string, offset: number) => {
    if (/\bn\s*=/.test(attrs)) return whole;
    const after = out.slice(offset + whole.length);
    const m = /<題>([^<>]*)<\/題>/.exec(after);
    const name = cleanName(m ? m[1] : '') || attrOf(attrs, 'id');
    if (!name) return whole;
    return `<書${attrs} n="${name.replace(/"/g, '“')}"/>`;
  });
  return out;
}


/**
 * 目錄樹要求「書」在「塊」前面（層級是 區→書→塊）。來源有些書把 `^ck` 寫在 `^bk` 前面
 * （sc 的 an1：`^ak#an^ck#a1^ckan#a1a^bk#an1`），會讓塊掛到錯的層。
 * 這裡只搬**沒有內容的** `<書 …/>`（不動任何文字）。
 */
export function bookBeforeChunk(line: string): string {
  const ci = line.indexOf('<塊');
  if (ci < 0) return line;
  const m = /<書([^<>]*?)\/>/.exec(line);
  if (!m || m.index < ci) return line;
  // 先拿掉書，再插到「第一個塊之前、最後一個 </區> 之後」
  const without = line.slice(0, m.index) + line.slice(m.index + m[0].length);
  const ci2 = without.indexOf('<塊');
  let at = ci2;
  const close = without.lastIndexOf('</區>', ci2);
  if (close >= 0) at = Math.max(at, close + 4);
  else {
    const sc = without.lastIndexOf('/>', ci2);
    if (sc >= 0 && without.lastIndexOf('<區', sc) >= 0) at = Math.max(at, sc + 2);
  }
  return without.slice(0, at) + m[0] + without.slice(at);
}

const AREA_EL = /<區[^<>]*>[^<>]*<\/區>|<區[^<>]*\/>/;
const BOOK_EL = /<書[^<>]*>[^<>]*<\/書>|<書[^<>]*\/>/;

/**
 * 目錄樹是 區（部）→書（冊）→塊。少數來源把 `^ck`／`^bk` 寫在 `^ak` 前面
 * （sc 的 mn1、ccc 的 an1），區就會落在書後面，樹上整個部都掉了。
 * 這裡把「區」與「書」搬到第一個「塊」之前——只搬家、不增刪字，行數不變。
 */
export function normalizeTop(lines: string[]): string[] {
  const text = lines.join('\n');
  const area = AREA_EL.exec(text)?.[0] ?? '';
  if (!area) return lines; // 沒有區（xsq）：不用排
  const book = BOOK_EL.exec(text)?.[0] ?? '';
  const ai = text.indexOf(area);
  const bi = book ? text.indexOf(book) : -1;
  const ci = text.indexOf('<塊');
  const ordered = (bi < 0 || ai < bi) && (ci < 0 || ai < ci);
  if (ordered) return lines;
  let t = text.replace(area, '');
  if (book) t = t.replace(book, '');
  const at = t.indexOf('<塊');
  const head = area + book;
  t = at >= 0 ? t.slice(0, at) + head + t.slice(at) : head + t;
  return t.split('\n');
}
// ---------------------------------------------------------------- 續行（標籤在行尾、文字在下一行）

/**
 * 1,790 處的標籤寫在行尾、文字在下一行（例：`…။^center` 換行 `ပဌမသုတ်။`）。
 * 為了保住「一行對一行」，不併行，而是把標籤搬到下一行，包住它開頭的文字。
 * 搬不成的（下一行沒有可包的文字）就留在原行尾變成空標籤。
 */
export function attachTrailingHeads(lines: readonly string[]): { lines: string[]; moved: number } {
  const out: string[] = [];
  let pending: string[] = [];
  let moved = 0;
  const flushPending = (): void => {
    if (!pending.length) return;
    for (let k = out.length - 1; k >= 0; k--) {
      if (out[k].trim()) {
        out[k] += pending.map((t) => `<${t}/>`).join('');
        break;
      }
    }
    pending = [];
  };
  for (const line of lines) {
    if (!line.trim()) {
      out.push(line);
      continue;
    }
    let l = line;
    if (pending.length) {
      const lead = LEADING_MILESTONE.exec(l)?.[0] ?? '';
      const rest = l.slice(lead.length);
      const lt = rest.indexOf('<');
      const run = lt < 0 ? rest : rest.slice(0, lt);
      if (run.trim() && run.length <= 600) {
        const tags = pending;
        const open = tags.map((t) => `<${t}>`).join('');
        const close = tags
          .slice()
          .reverse()
          .map((t) => `</${t}>`)
          .join('');
        l = lead + open + run + close + (lt < 0 ? '' : rest.slice(lt));
        pending = [];
        moved++;
      } else {
        flushPending();
      }
    }
    const m = /<([^<>\/]+)\/>$/.exec(l);
    if (m && CARRY_TAGS.has(m[1])) {
      l = l.slice(0, m.index);
      pending.push(m[1]);
    }
    out.push(l);
  }
  flushPending();
  return { lines: out, moved };
}

/**
 * `<居中>` 自成一行（作者 2026-11-02）：`^center` 是緬版的小節，其他譯本可能沒有；
 * 為了平行，讓它單獨佔一行，前後文不要和它擠在同一行。
 */
export function splitCenterLines(lines: readonly string[]): { lines: string[]; added: number } {
  const hasText = (s: string): boolean => /[^\s]/.test(s.replace(/<[^<>]*>/g, ''));
  const BLOCK_START = /^<(?:段|節|項|目|章|題|塊|小塊|書|區|居中)/;
  const out: string[] = [];
  let added = 0;
  for (const line of lines) {
    if (!line.includes('<居中>')) {
      out.push(line);
      continue;
    }
    const pieces: string[] = [];
    let cur = '';
    let i = 0;
    for (;;) {
      const a = line.indexOf('<居中>', i);
      const b = a < 0 ? -1 : line.indexOf('</居中>', a);
      if (a < 0 || b < 0) {
        cur += line.slice(i);
        break;
      }
      const center = line.slice(a, b + 5);
      const pre = line.slice(i, a);
      if (hasText(pre)) {
        cur += pre;
        if (cur.trim()) pieces.push(cur);
        cur = center;
      } else {
        cur += pre + center;
      }
      i = b + 5;
      const rest = line.slice(i);
      if (hasText(rest) || BLOCK_START.test(rest.trim())) {
        if (cur.trim()) {
          pieces.push(cur);
          added++;
        }
        cur = '';
      }
    }
    if (cur.trim()) pieces.push(cur);
    if (!pieces.length) out.push(line);
    else out.push(...pieces);
  }
  return { lines: out, added };
}

// ---------------------------------------------------------------- 長行切開

/** 這一段文字裡「還沒收尾」的最後一個標籤的起點（沒有就 -1）。 */
function lastUnclosedTagStart(seg: string): number {
  const re = /<(\/?)([^\s<>/]+)([^<>]*?)(\/?)>/g;
  const stack: { name: string; at: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(seg))) {
    if (m[1]) {
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k].name === m[2]) {
          stack.length = k;
          break;
        }
      }
    } else if (!m[4]) {
      stack.push({ name: m[2], at: m.index });
    }
  }
  return stack.length ? stack[stack.length - 1].at : -1;
}

/**
 * 切長行。accelon3 的 `lines.physical` 每行上限 8192 bytes（4,096 個 UTF-16 字），
 * 超過會讓行表與內文錯開，所以寧可切開。切點：緬文句號 `။`／`၊`、空白；
 * 不切進標籤、不切開代理對；可以的話也**不切在標籤內容中間**（讓每一行自己收尾）。
 */
export function splitLongLine(line: string, maxLen = 4096): string[] {
  if (line.length <= maxLen) return [line];
  const out: string[] = [];
  let start = 0;
  while (line.length - start > maxLen) {
    const limit = start + maxLen;
    let inTag = false;
    let lastBreak = -1;
    for (let i = start; i < limit; i++) {
      const ch = line[i];
      if (ch === '<') inTag = true;
      else if (ch === '>') inTag = false;
      else if (!inTag && (ch === ' ' || ch === '\u104b' || ch === '\u104a')) lastBreak = i + 1;
    }
    let cut = lastBreak > start ? lastBreak : limit;
    const code = line.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut--; // 不要切開代理對
    const lt = line.lastIndexOf('<', cut);
    const gt = line.lastIndexOf('>', cut);
    if (lt > gt) cut = lt; // 不要把標籤切成兩半
    // 儘量不要切在標籤內容中間：退到那個標籤的開頭（後面的行重新開標籤）
    const openAt = lastUnclosedTagStart(line.slice(start, cut));
    if (openAt > 0) cut = start + openAt;
    if (cut <= start) cut = limit;
    out.push(line.slice(start, cut).trimEnd());
    start = cut;
    while (line[start] === ' ') start++;
  }
  if (start < line.length) out.push(line.slice(start));
  return out;
}

// ---------------------------------------------------------------- 註文檔

export interface OffNote {
  n: string;
  text: string;
}

export interface NoteGroup {
  /** `^n` 段落號（註文檔用它分組） */
  pn: string | null;
  notes: OffNote[];
}

/**
 * 解析 `-fn.off`：`^n<段號>` 開一個群組，之後每行 `^fn<號> 注文`。
 * 續行（不以 `^n`／`^fn` 開頭）接到上一條注文後面。
 */
export function parseNoteFile(text: string): NoteGroup[] {
  const groups: NoteGroup[] = [];
  let cur: NoteGroup | null = null;
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    const m = /^\^n([0-9-]+)/.exec(line);
    if (m) {
      cur = { pn: m[1], notes: [] };
      groups.push(cur);
      continue;
    }
    const f = /^\^fn(\d+)\s?([\s\S]*)$/.exec(line);
    if (f) {
      if (!cur) {
        cur = { pn: null, notes: [] };
        groups.push(cur);
      }
      cur.notes.push({ n: f[1], text: escapeText(f[2]) });
      continue;
    }
    const last = cur?.notes[cur.notes.length - 1];
    if (last) last.text += ' ' + escapeText(line.replace(/^\^/, ''));
  }
  return groups.filter((g) => g.notes.length);
}

/**
 * 解析 TSV 註文（yh 的 `<書>.yh.tsv`）：第一行是 `^:<name=…>` 宣告，之後 `編號<TAB>注文`；
 * 沒有 TAB 的行接到上一條後面。回傳的 `pn` 一律 null（沒有段落資訊）。
 */
export function parseTsvNotes(text: string): NoteGroup[] {
  const notes: OffNote[] = [];
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim() || line.startsWith('^:')) continue;
    const tab = line.indexOf('\t');
    if (tab > 0) {
      const id = line.slice(0, tab).trim();
      if (/^\d+$/.test(id)) {
        notes.push({ n: id, text: escapeText(line.slice(tab + 1)) });
        continue;
      }
    }
    const last = notes[notes.length - 1];
    if (last) last.text += ' ' + escapeText(line);
  }
  return notes.length ? [{ pn: null, notes }] : [];
}

// ---------------------------------------------------------------- 驗收

/** 來源一行 → 純文字（去掉 offtag；夾文連括號一起留）。驗收比對用。 */
export function plainOff(line: string): string {
  let out = '';
  let i = 0;
  for (;;) {
    const at = line.indexOf('^', i);
    if (at < 0) return out + line.slice(i);
    out += line.slice(i, at);
    const t = readTag(line, at);
    if (!t) {
      i = at + 1; // 孤立 ^ 兩邊都丟掉
      continue;
    }
    if (t.rawInner) {
      // 夾文裡面可能還有 offtag：括號留著，內容遞迴去標籤
      out += t.rawInner[0] + plainOff(t.inner ?? '') + t.rawInner[t.rawInner.length - 1];
    }
    i = t.end;
  }
}

/** 去掉空白再比（換行、`&nbsp;`、行尾空白都不算差異）。 */
const normText = (s: string): string =>
  s
    .replace(/&nbsp;/g, '')
    .replace(/<\/?[a-zA-Z][^<>]{0,200}>/g, '')
    .replace(/[<>]/g, (m) => (m === '<' ? '＜' : '＞'))
    .replace(/[\s\u00a0]+/g, '');
const plainXml = (line: string): string => line.replace(/<[^<>]*>/g, '');

export interface VerifyIssue {
  file: string;
  line: number;
  kind: string;
}

export interface VerifyResult {
  books: number;
  lines: number;
  maxLen: number;
  /** 正文掉字／多字的書（「書: 第一個差異」） */
  textDiffs: string[];
  /** `<段>` 序列與來源 `^n` 不同、或行數對不上的書 */
  structDiffs: string[];
  /** 輸出行數 ≠ 來源行數的書（正常只有切長行的那幾本） */
  lineDiffs: string[];
  /** 文字順序被結構正規化調整（字元相同）的書 */
  orderDiffs: string[];
  issues: VerifyIssue[];
}

/**
 * 驗收一個輸出目錄（對照同一組來源）：正文有沒有掉字、`<段>` 序列對不對、
 * 有沒有殘留 `^`／裸 `&`／壞標籤／超長行。收在工具裡，換一庫就重跑一次。
 */
export function verifyOffDir(opts: ConvertOptions): VerifyResult {
  const srcDir = resolve(opts.srcDir);
  const outDir = resolve(opts.outDir);
  const glob = globToRegExp(opts.glob ?? '*.off');
  const strip = opts.strip ?? '.off';
  const maxLen = opts.maxLen ?? 4096;
  const files = readdirSync(srcDir)
    .filter((f) => statSync(join(srcDir, f)).isFile())
    .filter((f) => glob.test(f))
    .map((f) => ({ file: f, book: f.endsWith(strip) ? f.slice(0, -strip.length) : f.replace(/\.[^.]*$/, '') }))
    .filter((x) => x.book && x.book !== '0')
    .sort((a, b) => (opts.order ?? canonOrder)(a.book, b.book));

  const res: VerifyResult = { books: 0, lines: 0, maxLen: 0, textDiffs: [], structDiffs: [], lineDiffs: [], orderDiffs: [], issues: [] };
  for (const { file, book } of files) {
    const outPath = join(outDir, `${book}.xml`);
    if (!existsSync(outPath)) {
      res.structDiffs.push(`${book}: 沒有輸出檔`);
      continue;
    }
    res.books++;
    const srcLines = readFileSync(join(srcDir, file), 'utf8')
      .replace(/^\uFEFF/, '')
      .replace(/\r\n?/g, '\n')
      .split('\n');
    if (srcLines.length && srcLines[srcLines.length - 1] === '') srcLines.pop();
    const outLines = readFileSync(outPath, 'utf8').replace(/\r\n?/g, '\n').split('\n');
    if (outLines.length && outLines[outLines.length - 1] === '') outLines.pop();
    res.lines += outLines.length;
    if (outLines.length !== srcLines.length) {
      res.lineDiffs.push(`${book}: 輸出 ${outLines.length} 行 ≠ 來源 ${srcLines.length} 行`);
    }

    // 1) 正文沒掉字
    const a = normText(srcLines.map(plainOff).join(''));
    const b = normText(outLines.map(plainXml).join(''));
    if (a !== b) {
      // 目錄樹會把「區／書」搬到第一個塊之前（結構正規化），字沒有少、只是先後不同
      const sa = [...a].sort().join('');
      const sb = [...b].sort().join('');
      if (sa === sb) {
        res.orderDiffs.push(`${book}: 文字順序調整（字元相同，區／書搬到塊前）`);
      } else {
        let k = 0;
        while (k < Math.min(a.length, b.length) && a[k] === b[k]) k++;
        res.textDiffs.push(
          `${book}: 第 ${k} 字 ${JSON.stringify(a.slice(k, k + 20))} ≠ ${JSON.stringify(b.slice(k, k + 20))}`,
        );
      }
    }

    // 2) <段> 序列與來源 ^n 一致
    const srcN = srcLines.flatMap((l) => [...l.matchAll(/\^n([0-9-]+)/g)].map((m) => m[1]));
    const outN = outLines.flatMap((l) => [...l.matchAll(/<段 n="([0-9-]+)"\/>/g)].map((m) => m[1]));
    if (srcN.join(',') !== outN.join(',')) res.structDiffs.push(`${book}: <段> ${outN.length} 個 ≠ 來源 ^n ${srcN.length} 個`);

    // 3) 每行的結構
    for (let i = 0; i < outLines.length; i++) {
      const l = outLines[i];
      res.maxLen = Math.max(res.maxLen, l.length);
      if (l.length > maxLen) res.issues.push({ file: book, line: i + 1, kind: `行太長（${l.length}）` });
      if (l.includes('^')) res.issues.push({ file: book, line: i + 1, kind: '殘留 ^' });
      if (l.includes('&')) res.issues.push({ file: book, line: i + 1, kind: '裸 &' });
      if (/[<>]/.test(plainXml(l))) res.issues.push({ file: book, line: i + 1, kind: '正文裡有 < >' });
      for (const m of l.matchAll(/<[^<>]*>/g)) {
        if (!/^<\/?[^\s<>/]+(\s+[^<>]*?)?\/?>$/.test(m[0])) {
          res.issues.push({ file: book, line: i + 1, kind: `壞標籤 ${m[0].slice(0, 30)}` });
        }
      }
    }
  }
  return res;
}

// ---------------------------------------------------------------- 清除紀錄

/**
 * 來源裡不該有的東西：HTML 標籤、孤立的 `<`／`>`、孤立的 `^`、`&nbsp;`。
 * 轉換時一律清掉（offtext 不該有 HTML；作者 2026-11-02），但每一處都要記錄下來，
 * 方便回頭修來源的產生器。
 */
export interface Cleanup {
  line: number;
  kind: 'html' | 'angle' | 'caret' | 'nbsp';
  text: string;
}

export function scanCleanups(line: string): Omit<Cleanup, 'line'>[] {
  const out: Omit<Cleanup, 'line'>[] = [];
  const html = /<\/?[a-zA-Z][^<>]{0,200}>/g;
  for (const m of line.matchAll(html)) out.push({ kind: 'html', text: m[0] });
  if (line.includes('&nbsp;')) out.push({ kind: 'nbsp', text: '&nbsp;' });
  // 去掉 HTML 與合法 offtag 之後，還留在正文裡的 < > ^
  let rest = line.replace(html, '').replace(/\^[-.\/0-9:;_#@a-z~]*/g, '');
  for (const m of rest.matchAll(/[<>^]/g)) {
    out.push({ kind: m[0] === '^' ? 'caret' : 'angle', text: '（孤立）' + m[0] });
  }
  return out;
}

// ---------------------------------------------------------------- 逐書轉換
export interface BookReport {
  book: string;
  source: string;
  inLines: number;
  outLines: number;
  /** 輸出與來源 1:1（切長行會使 outLines > inLines） */
  oneToOne: boolean;
  splits: number;
  carriedHeads: number;
  /** 為了讓 `<居中>` 自成一行而多出來的行數 */
  centerLines: number;
  notesSource: string;
  notesOut: string;
  notes: number;
  notesNoPg: number;
  paragraphs: number;
  printedPages: number;
  markers: number;
  /** 清掉的 HTML／孤立字元（每種幾個） */
  cleaned: Record<string, number>;
  tags: Record<string, number>;
  maxLen: number;
  warnings: string[];
}

export interface ConvertOptions {
  srcDir: string;
  outDir: string;
  glob?: string;
  strip?: string;
  /** 註文來源後綴（例 `-fn.off`）；空字串＝不處理註 */
  notesSuffix?: string;
  /** 註文輸出檔名後綴（例 `-fn`） */
  notesOutSuffix?: string;
  /** TSV 註文後綴（例 `.yh.tsv`）：`編號<TAB>注文`，沒有段落資訊 */
  notesTsv?: string;
  /** 頁 id 模板：`{ck}`／`{n}`／`{book}`；空字串＝不輸出 `<頁>` */
  pageId?: string;
  /** 註文 pg 模板（預設 `{ck}.{n}`） */
  pg?: string;
  /** 壞掉的塊 id：書 → 依序要換上的 id（xsq 的 dn2／dn3 是 ``） */
  ckIds?: Record<string, string[]>;
  /** 目錄樹（<樹>…</樹> 的文字）；空字串＝不宣告 */
  toc?: string;
  /** 目錄樹的 s=（檢索範圍）；預設不寫＝不能搜尋、可以看目錄 */
  tocScope?: string;
  dbname?: string;
  dbcname?: string;
  enname?: string;
  /** 宣告檔名（預設 `00.xml`）；空字串＝不寫 */
  headerFile?: string;
  /** 清除紀錄（HTML／孤立字元）的輸出檔；不給就不寫 */
  cleanupFile?: string;
  maxLen?: number;
  limit?: number;
  /**
   * `inline`（預設）＝`<居中>` 可以和文字接在同一行，XML 行數與來源相同；
   * `alone`＝讓 `<居中>` 自成一行（會多出行）。
   */
  centerLines?: 'inline' | 'alone';
  dry?: boolean;
  log?: (msg: string) => void;
  order?: (a: string, b: string) => number;
  /** 只轉這幾本（依給定順序）；不給就照 glob 掃描後排序 */
  books?: string[];
  /** 正文轉寫器（例：巴利底本的儉約巴利 → IAST ＋ `<詞>`）；不給就只做轉義 */
  text?: (s: string, plain: boolean) => string;
  /** 塊 id 正規化（例：義注加 `a`、複注加 `t`、再複注加 `x`） */
  ckTransform?: (id: string, book: string) => string;
  /** 沒有 `^ak` 的書，要用哪個部類代碼當它的區（回傳空字串＝不補） */
  areaOf?: (book: string) => string;
}

export interface ConvertReport {
  dbname: string;
  books: BookReport[];
  header: string;
  outLines: number;
  totalNotes: number;
  pageId: string;
  /** 清掉的 HTML／孤立字元（全部） */
  cleanups: (Cleanup & { book: string })[];
  /** 清除紀錄檔（有寫檔才有） */
  cleanupFile?: string;
}

const globToRegExp = (g: string): RegExp =>
  new RegExp(
    '^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^]*').replace(/\?/g, '.') + '$',
    'i',
  );

/** 巴利三藏的部類順序：律 → 長部 → 中部 → 相應部 → 增支部 → 小部 → 論。 */
const PITAKA_ORDER = [
  'pj', 'pc', 'mv', 'cv', 'pvr', 'dn', 'mn', 'sn', 'an', 'kp', 'dhp', 'ud', 'iti', 'snp',
  'vv', 'pv', 'thap', 'thip', 'bv', 'cp', 'ps', 'mil', 'ds', 'vb', 'pp', 'kv',
];

export function canonOrder(a: string, b: string): number {
  const key = (id: string): [number, number, string] => {
    const m = /^([a-z]+)(\d*)/.exec(id);
    const pf = m?.[1] ?? id;
    const no = m?.[2] ? Number(m[2]) : 0;
    const idx = PITAKA_ORDER.indexOf(pf);
    return [idx < 0 ? 99 : idx, no, id];
  };
  const ka = key(a);
  const kb = key(b);
  return ka[0] - kb[0] || ka[1] - kb[1] || (ka[2] < kb[2] ? -1 : ka[2] > kb[2] ? 1 : 0);
}

const oneLine = (s: string): string => s.replace(/[\r\n]+/g, ' ').trim();

/** 先掃一遍正文：段號 → 塊 id（註文檔只有段號，要靠這張表組 pg）。 */
function scanParagraphs(lines: readonly string[], book: string): Map<string, string> {
  const out = new Map<string, string>();
  let ck = '';
  for (const line of lines) {
    for (let i = line.indexOf('^'); i >= 0; i = line.indexOf('^', i + 1)) {
      const t = readTag(line, i);
      if (!t) continue;
      if (t.name === 'ck' && t.id) ck = t.id;
      else if (t.name === 'n' && t.id) out.set(t.id, ck || book);
    }
  }
  return out;
}

export async function convertOffDir(opts: ConvertOptions): Promise<ConvertReport> {
  const srcDir = resolve(opts.srcDir);
  const outDir = resolve(opts.outDir);
  if (!existsSync(srcDir)) throw new Error(`找不到來源目錄：${srcDir}`);
  const glob = globToRegExp(opts.glob ?? '*.off');
  const strip = opts.strip ?? '.off';
  const notesSuffix = opts.notesSuffix ?? '';
  const notesOutSuffix = opts.notesOutSuffix ?? '-fn';
  const pageId = opts.pageId ?? '';
  const pgTemplate = opts.pg ?? '{ck}.{n}';
  const headerFile = opts.headerFile ?? '00.xml';
  const maxLen = opts.maxLen ?? 4096;
  const dbname = opts.dbname ?? basename(srcDir);
  const log = opts.log ?? (() => {});

  const files = (opts.books
    ? [...new Set(opts.books)].map((b) => ({ file: b + strip, book: b }))
    : readdirSync(srcDir)
        .filter((f) => statSync(join(srcDir, f)).isFile())
        .filter((f) => glob.test(f))
        .map((f) => ({
          file: f,
          book: f.endsWith(strip) ? f.slice(0, -strip.length) : f.replace(/\.[^.]*$/, ''),
        }))
        .filter((x) => x.book && x.book !== '0')
        .sort((a, b) => (opts.order ?? canonOrder)(a.book, b.book)));
  const use = opts.limit ? files.slice(0, opts.limit) : files;

  const header =
    `<檔 n="${oneLine(dbname)}">` +
    (opts.dbcname ? `<集>${oneLine(opts.dbcname)}</集>` : '') +
    (opts.enname ? `<英文名>${oneLine(opts.enname)}</英文名>` : '') +
    `</檔>`;

  if (!opts.dry) mkdirSync(outDir, { recursive: true });

  const books: BookReport[] = [];
  const allCleanups: (Cleanup & { book: string })[] = [];
  for (const { file, book } of use) {
    const raw = readFileSync(join(srcDir, file), 'utf8')
      .replace(/^\uFEFF/, '')
      .replace(/\r\n?/g, '\n');
    const inLines = raw.split('\n');
    if (inLines.length && inLines[inLines.length - 1] === '') inLines.pop();

    const pnCk = scanParagraphs(inLines, book);
    const ctx: LineContext = {
      book,
      ckQueue: opts.ckIds?.[book] ? [...opts.ckIds[book]] : undefined,
      ck: '',
      pn: '',
      pageId,
      pgTemplate,
      warnings: [],
      tagCounts: {},
      text: opts.text,
      ckTransform: opts.ckTransform,
    };

    // 一行來源 → 一行輸出（保留空行；之後才處理「標籤在行尾」的續行）
    const converted = inLines.map((rawLine) => {
      const line = rawLine.replace(/[ \t]+$/, '');
      if (!line) return '';
      return bookBeforeChunk(nameChunks(convertLine(line, ctx))).replace(/[ \t]+$/, '');
    });
    // 清除紀錄：來源不該有 HTML／孤立字元，清了就要留下記錄（檔案、行號、片段）
    const cleanups: Cleanup[] = [];
    for (let i = 0; i < inLines.length; i++) {
      for (const c of scanCleanups(inLines[i])) cleanups.push({ ...c, line: i + 1 });
    }
    if (cleanups.length) {
      ctx.warnings.push(`清除 ${cleanups.length} 處（HTML／孤立字元）`);
      for (const c of cleanups) allCleanups.push({ book, ...c });
    }
    const attached = attachTrailingHeads(converted);
    // 來源整個檔都沒有 `^bk`（xsq 的 dn2／dn3）：在第一個塊的位置補一個空的書標籤，
    // 否則那一冊的塊沒有上層，目錄樹會把它們掛到前一冊。行數不變、不加文字。
    if (!attached.lines.some((l) => l.includes('<書'))) {
      const k = attached.lines.findIndex((l) => l.includes('<塊'));
      if (k >= 0) attached.lines[k] = `<書 id="${book}" t="塊."/>` + attached.lines[k];
    }
    // 部（區）缺了就補：每個部類的第一冊（dn1／mn1／sn1／an1…）如果來源沒有 `^ak`，
    // 在這裡放一個區標籤（用部類代碼當目錄名），否則那一部會掛到上一部底下。
    const areaId = opts.areaOf ? opts.areaOf(book) : (/^([a-z]+)1$/.exec(book)?.[1] ?? '');
    if (areaId && !attached.lines.some((l) => l.includes('<區'))) {
      const k = Math.max(0, attached.lines.findIndex((l) => l.includes('<書')));
      attached.lines[k] = `<區 id="${areaId}" t="書." n="${areaId}"/>` + attached.lines[k];
      ctx.tagCounts['區'] = (ctx.tagCounts['區'] ?? 0) + 1;
    }
    // 區→書→塊：少數書把塊／書寫在區前面，搬正（只搬標籤與它的文字，不增刪）
    const ordered = normalizeTop(attached.lines);
    // 預設不拆行：XML 的行數與來源相同，使用者比較平行文本時好捲動（作者 2026-11-02）
    const centered = opts.centerLines === 'alone' ? splitCenterLines(ordered) : { lines: ordered, added: 0 };

    const out: string[] = [];
    let splits = 0;
    let maxSeen = 0;
    for (const line of centered.lines) {
      const pieces = splitLongLine(line, maxLen);
      if (pieces.length > 1) splits += pieces.length - 1;
      for (const piece of pieces) {
        maxSeen = Math.max(maxSeen, piece.length);
        out.push(piece);
      }
    }

    // 註文：另一本檔（`<book>-fn.xml`），一條一行 `<釋>`；pg＝它那一段的 塊.段
    const notesTsv = opts.notesTsv ?? '';
    const noteSrc = notesSuffix ? join(srcDir, book + notesSuffix) : '';
    const tsvSrc = notesTsv ? join(srcDir, book + notesTsv) : '';
    const noteOutName = `${book}${notesOutSuffix}.xml`;
    let notes = 0;
    let notesNoPg = 0;
    const noteOut: string[] = [];
    // TSV 註（yh）：沒有段落資訊，pg 留空，靠 n 配對
    if (tsvSrc && existsSync(tsvSrc)) {
      for (const g of parseTsvNotes(readFileSync(tsvSrc, 'utf8'))) {
        notesNoPg += g.notes.length;
        for (const note of g.notes) {
          noteOut.push(`<釋 n="${note.n}">${note.text}</釋>`);
          notes++;
        }
      }
    }
    if (noteSrc && existsSync(noteSrc)) {
      const groups = parseNoteFile(readFileSync(noteSrc, 'utf8'));
      for (const g of groups) {
        const ck = g.pn != null ? pnCk.get(g.pn) : undefined;
        const pg = ck && g.pn != null ? fillTemplate({ ...ctx, ck }, pgTemplate, g.pn) : '';
        if (!pg) notesNoPg += g.notes.length;
        for (const note of g.notes) {
          noteOut.push(`<釋 n="${note.n}"${pg ? ` pg="${pg}"` : ''}>${note.text}</釋>`);
          notes++;
        }
      }
    }
    if (notes) {
      ctx.tagCounts['釋'] = (ctx.tagCounts['釋'] ?? 0) + notes;
      if (!opts.dry && noteOut.length) {
        writeFileSync(join(outDir, noteOutName), noteOut.join('\n') + '\n', 'utf8');
      }
    }

    const report: BookReport = {
      book,
      source: file,
      inLines: inLines.length,
      outLines: out.length,
      oneToOne: out.length === inLines.length,
      splits,
      carriedHeads: attached.moved,
      centerLines: centered.added,
      notesSource: noteSrc ? basename(noteSrc) : '',
      notesOut: noteOut.length ? noteOutName : '',
      notes,
      notesNoPg,
      paragraphs: ctx.tagCounts['段'] ?? 0,
      printedPages: ctx.tagCounts['pb'] ?? 0,
      markers: ctx.tagCounts['註'] ?? 0,
      tags: ctx.tagCounts,
      maxLen: maxSeen,
      warnings: ctx.warnings,
    };
    books.push(report);
    if (!opts.dry) writeFileSync(join(outDir, `${book}.xml`), out.join('\n') + '\n', 'utf8');
    log(
      `${book.padEnd(6)} 行 ${String(report.inLines).padStart(6)}→${String(report.outLines).padStart(6)}` +
        `${report.oneToOne ? '' : '≠'}` +
        `  段 ${String(report.paragraphs).padStart(5)}  註 ${String(report.markers).padStart(4)}/${String(report.notes).padStart(4)}` +
        (attached.moved ? `  續行 ${attached.moved}` : '') +
        (splits ? `  切 ${splits}` : '') +
        (report.warnings.length ? `  警告 ${report.warnings.length}` : ''),
    );
  }

  // 宣告檔最後寫。目錄樹三層：區（部）→書（冊）→塊。沒有 `區` 的庫（xsq）退成兩層。
  // 少數書把 `^ck`／`^bk` 寫在 `^ak` 前面，轉換時已把它們排到區之後（見 normalizeTop）。
  const anyArea = books.reduce((n, b) => n + (b.tags['區'] ?? 0), 0);
  const tocTitle = opts.toc ?? '目錄';
  const tocScope = opts.tocScope ?? '*';
  const treeLine = tocTitle
    ? `<隱><樹${tocScope ? ` s="${tocScope}"` : ''} t="${anyArea ? '區,書,塊.' : '書,塊.'}">${oneLine(tocTitle)}</樹></隱>`
    : '';
  if (!opts.dry && headerFile) {
    writeFileSync(join(outDir, headerFile), [header, treeLine].filter(Boolean).join('\n') + '\n', 'utf8');
  }

  // 清除紀錄（HTML／孤立字元）：一處一行，方便回頭修來源的產生器
  let cleanupFile: string | undefined;
  if (opts.cleanupFile && allCleanups.length) {
    cleanupFile = resolve(opts.cleanupFile);
    if (!opts.dry) {
      mkdirSync(join(cleanupFile, '..'), { recursive: true });
      const rows = ['書\t行\t種類\t片段'];
      for (const c of allCleanups) rows.push(`${c.book}\t${c.line}\t${c.kind}\t${c.text}`);
      writeFileSync(cleanupFile, rows.join('\n') + '\n', 'utf8');
    }
  }

  return {
    dbname,
    books,
    header,
    outLines: books.reduce((s, b) => s + b.outLines, 0),
    totalNotes: books.reduce((s, b) => s + b.notes, 0),
    pageId,
    cleanups: allCleanups,
    cleanupFile,
  };
}

export function reportText(r: ConvertReport): string {
  const lines: string[] = [];
  lines.push(`# off → accelon 轉換報告（${new Date().toISOString()}）`);
  lines.push(`dbname: ${r.dbname}   頁 id 模板: ${r.pageId || '(未輸出 `<頁>`；之後補)'}`);
  lines.push(`書: ${r.books.length} 本，正文 ${r.outLines} 行，註文 ${r.totalNotes} 條`);
  lines.push('');
  lines.push('書     來源行  輸出行  1:1  段     原頁  註號  註文  無pg  續行  居中行  切行  最長行  標籤');
  for (const b of r.books) {
    const tags = Object.entries(b.tags)
      .sort((a, c) => c[1] - a[1])
      .map(([k, v]) => `${k}${v}`)
      .join(' ');
    lines.push(
      [
        b.book.padEnd(6),
        String(b.inLines).padStart(6),
        String(b.outLines).padStart(7),
        b.oneToOne ? ' ✓ ' : ' ✗ ',
        String(b.paragraphs).padStart(5),
        String(b.printedPages).padStart(5),
        String(b.markers).padStart(5),
        String(b.notes).padStart(5),
        String(b.notesNoPg).padStart(5),
        String(b.carriedHeads).padStart(5),
        String(b.centerLines).padStart(6),
        String(b.splits).padStart(5),
        String(b.maxLen).padStart(7),
        tags,
      ].join(' '),
    );
  }
  // 清除（HTML／孤立字元）：來源不該有這種東西，清了就要看得到
  if (r.cleanups.length) {
    const byKind: Record<string, number> = {};
    const byBook: Record<string, Record<string, number>> = {};
    for (const c of r.cleanups) {
      byKind[c.kind] = (byKind[c.kind] ?? 0) + 1;
      byBook[c.book] ??= {};
      byBook[c.book][c.kind] = (byBook[c.book][c.kind] ?? 0) + 1;
    }
    const kinds = Object.entries(byKind)
      .map(([k, v]) => `${k} ${v}`)
      .join('、');
    lines.push('', `## 清除紀錄（HTML／孤立字元）：${r.cleanups.length} 處（${kinds}）`);
    for (const [book, ks] of Object.entries(byBook)) {
      lines.push(`- ${book}: ` + Object.entries(ks).map(([k, v]) => `${k} ${v}`).join('、'));
    }
    if (r.cleanupFile) lines.push('', `明細（書／行／種類／片段）：${r.cleanupFile}`);
  }
  const warns = r.books.flatMap((b) => b.warnings.map((w) => `${b.book}: ${w}`));
  if (warns.length) {
    lines.push('', `## 警告（${warns.length}）`);
    for (const w of warns.slice(0, 200)) lines.push('- ' + w);
    if (warns.length > 200) lines.push(`- …另有 ${warns.length - 200} 條`);
  }
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------- CLI

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opt = (n: string, d?: string): string | undefined => {
    const k = args.indexOf('--' + n);
    if (k < 0) return d;
    const v = args[k + 1];
    return v && !v.startsWith('--') ? v : d;
  };
  const src = opt('src');
  const out = opt('out');
  if (!src || !out) {
    console.error('用法：bun run ts/tools/off2accelon.ts --src <off 目錄> --out <輸出目錄> [選項]');
    console.error('選項見檔案開頭註解或 docs/adb/off-to-accelon.md。');
    process.exit(2);
  }
  const t0 = Date.now();
  const base: ConvertOptions = {
    srcDir: src,
    outDir: out,
    glob: opt('glob', '*.off'),
    strip: opt('strip', '.off'),
    notesSuffix: opt('notes', ''),
    notesTsv: opt('notestsv', ''),
    notesOutSuffix: opt('notesout', '-fn'),
    pageId: opt('pageid', ''),
    pg: opt('pg', '{ck}.{n}'),
    dbname: opt('dbname'),
    dbcname: opt('dbcname'),
    enname: opt('enname'),
    headerFile: opt('header', '00.xml'),
    maxLen: opt('maxlen') ? Number(opt('maxlen')) : undefined,
    limit: opt('limit') ? Number(opt('limit')) : undefined,
    centerLines: opt('centers', 'inline') === 'alone' ? 'alone' : 'inline',
    dry: args.includes('--dry'),
    toc: opt('toc', '目錄'),
    tocScope: opt('tocscope', '*'),
    log: (m) => console.log(m),
  };
  if (args.includes('--check')) {
    const v = verifyOffDir(base);
    console.log(`驗收：${v.books} 本、${v.lines} 行、最長 ${v.maxLen} 字`);
    console.log(`  正文掉字：${v.textDiffs.length} 本`);
    for (const d of v.textDiffs) console.log('    - ' + d);
    console.log(`  段序列不符：${v.structDiffs.length} 本`);
    for (const d of v.structDiffs) console.log('    - ' + d);
    if (v.lineDiffs.length) {
      console.log(`  行數不同（預期只有切長行的那幾本）：${v.lineDiffs.length} 本`);
      for (const d of v.lineDiffs) console.log('    · ' + d);
    }
    console.log(`  結構問題：${v.issues.length} 筆`);
    for (const i of v.issues.slice(0, 20)) console.log(`    - ${i.file}:${i.line} ${i.kind}`);
    console.log(`用時 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    process.exit(v.textDiffs.length || v.structDiffs.length || v.issues.length ? 1 : 0);
  }
  base.cleanupFile = opt('cleanup', join(out, '..', 'out', 'off2accelon-cleanups.tsv'));
  const report = await convertOffDir(base);
  const text = reportText(report);
  const rep = opt('report', join(out, '..', 'out', 'off2accelon-report.txt'))!;
  if (!args.includes('--dry')) {
    mkdirSync(join(rep, '..'), { recursive: true });
    writeFileSync(rep, text, 'utf8');
    console.log(text.split('\n').slice(0, 5).join('\n'));
    console.log(`報告：${resolve(rep)}`);
  }
  console.log(`完成，用時 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
