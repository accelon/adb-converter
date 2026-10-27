/**
 * 「塗紅」——painting the current hit inside the document pane.
 *
 * Split out of viewer.ts: the mark logic is self-contained (it only reads the DOM
 * rows and the mapper's spans) and it is the part that changes most often, because
 * every database drifts differently.
 *
 *   markPhraseInLine  paint a phrase by TEXT inside one rendered line
 *   markPhraseOnPage  the same, scanning the whole page (fgdict's drift)
 *   paintHit          the entry point: decide what to paint for the pinned hit
 */
import { mapper } from './viewer';
import { docSession, hardBreaksOn, scheduleCursorSync, scrollToVa, simConverter } from './doc-pane';
import { kwMarks } from './kw-marks';

/** 這個命中屬於哪個關鍵字（代入它的 HSV 色相；沒有就 0＝紅） */
function kwHue(token?: string): number {
  if (!token) return 0;
  const hit = kwMarks().find((m) => m.text && (token.includes(m.text) || m.text.includes(token)));
  return hit ? hit.hue : 0;
}

/**
 * 一行裡的所有文字節點（跳過渲染器自己加的不是原文的文字：頁碼 `.pageBreak`、
 * 段落縮排 `.paraIndent`）。
 *
 * **已經塗過的 `<mark>` 也要算進來**：接行模式下關鍵字在渲染時就標好了（`.kw`），
 * 若這裡跳過 mark，位移就會少掉那些字，之後的「按位移上色」會塗到隔壁字
 * （作者 2026-10 回報：性空 被塗成 義，）。
 */
function textNodesOf(root: HTMLElement): Text[] {
  const out: Text[] = [];
  const walk = (n: Node) => {
    if (n.nodeType === Node.TEXT_NODE) { out.push(n as Text); return; }
    const el = n as HTMLElement;
    if (el.classList?.contains('pageBreak') || el.classList?.contains('paraIndent')) return;
    for (const c of [...n.childNodes]) walk(c);
  };
  walk(root);
  return out;
}

/** 整行合起來的文字（節點之間用空字串接，和畫面上看到的一致） */
function lineTextOf(nodes: Text[]): string {
  return nodes.map((n) => n.textContent ?? '').join('');
}

/**
 * 把 `nodes` 合起來的第 start..end 字包成 mark（可能跨好幾個節點）。
 * 從後面往前面包，前面節點的位移才不會被影響。
 */
function markRange(nodes: Text[], start: number, end: number, va: number, hue: number): HTMLElement | null {
  const pieces: { node: Text; from: number; to: number }[] = [];
  let acc = 0;
  for (const node of nodes) {
    const len = node.textContent?.length ?? 0;
    const a = Math.max(start, acc);
    const b = Math.min(end, acc + len);
    if (b > a) pieces.push({ node, from: a - acc, to: b - acc });
    acc += len;
  }
  let first: HTMLElement | null = null;
  for (let i = pieces.length - 1; i >= 0; i--) {
    const p = pieces[i];
    // 這一段已經被包在既有的 mark 裡（接行模式預先標好的 .kw）：不重複包，
    // 直接把那個 mark 當成命中標記（補上 class 與顏色）。
    const host = p.node.parentElement;
    if (host && host.tagName === 'MARK') {
      host.classList.add('docHit');
      host.dataset.va = String(va);
      host.style.setProperty('--hue', String(hue));
      first = host;
      continue;
    }
    const range = document.createRange();
    range.setStart(p.node, p.from);
    range.setEnd(p.node, p.to);
    const mark = document.createElement('mark');
    mark.className = 'docHit';
    mark.dataset.va = String(va);
    mark.style.setProperty('--hue', String(hue));
    try {
      range.surroundContents(mark);
      first = mark;
    } catch { /* 這一段包不起來（例如跨 element 邊界）：跳過 */ }
  }
  return first;
}

/**
 * 把一行裡的 `phrase` 包成 mark。`all=true` 時**同一行的每一次出現都包**
 * （作者 2026-10-27：摘要一張卡有兩個著色點，本文卻只塗第一個）。
 * 由後往前包，前面節點的位移才不會被影響。
 */
function markPhraseInLine(line: number | undefined, phrase: string | undefined, va: number, hue = 0, all = false): HTMLElement | null {
  if (line === undefined || !phrase) return null;
  // 顯示模式（無損／強制簡體）下畫面上的字已經轉過，比對的字串也要跟著轉
  const conv = simConverter();
  const needle = conv ? conv(phrase) : phrase;
  const box = document.getElementById('L' + line)?.querySelector<HTMLElement>('.lineText');
  if (!box) return null;
  const text = lineTextOf(textNodesOf(box));
  const at: number[] = [];
  let from = 0;
  while ((from = text.indexOf(needle, from)) >= 0) {
    at.push(from);
    from += needle.length;
    if (!all) break;
  }
  if (!at.length) return null;
  let first: HTMLElement | null = null;
  for (let k = at.length - 1; k >= 0; k--) {
    const mark = markRange(textNodesOf(box), at[k], at[k] + needle.length, va, hue);
    if (mark && !first) first = mark;
  }
  if (!first) return null;
  first.scrollIntoView({ block: 'center' });
  return first;
}

/**
 * Paint `phrase` in the rendered page, starting at `fromLine` and wrapping once.
 *
 * `markPhraseInLine` only looks at the one line the link computed, and on a database
 * whose VA walk drifts (fgdict) that line can be the segment's heading rather than
 * the hit's own line — the query would then silently stay unpainted. The page is
 * always the page that holds the hit, so searching it finds the phrase.
 */
function markPhraseOnPage(phrase: string | undefined, va: number, fromLine: number, hue = 0): boolean {
  if (!phrase) return false;
  const rows = [...document.querySelectorAll<HTMLElement>('#docText .docLine')];
  if (!rows.length) return false;
  const lineOf = (el: HTMLElement) => Number((el.id || '').replace(/^L/, ''));
  const start = Math.max(0, rows.findIndex((r) => lineOf(r) === fromLine));
  for (let i = start; i < rows.length; i++) if (markPhraseInLine(lineOf(rows[i]), phrase, va, hue, true)) return true;
  for (let i = 0; i < start; i++) if (markPhraseInLine(lineOf(rows[i]), phrase, va, hue, true)) return true;
  return false;
}

/**
 * 多詞組：把整頁每一個關鍵字的出現都塗上自己的顏色。
 *
 * 只處理「純文字節點」（已經被 `.docHit` 包住的不動）—— 命中的那一個由 paintHit
 * 用同樣的色相畫，所以兩者看起來是同一種顏色。
 */
function paintKeywordMarks(): void {
  // 不保留硬換行時，關鍵字在**渲染 HTML 之前**就包好了（renderPageBlocks 的 marks），
  // 事後在 DOM 上找字反而容易抓錯（作者 2026-10）。
  if (!hardBreaksOn()) return;
  const marks = kwMarks();
  if (!marks.length) return;
  const texts = [...marks]
    .filter((m) => m.text)
    .sort((a, b) => b.text.length - a.text.length);      // 長詞優先，避免被短詞切碎
  if (!texts.length) return;
  const lines = document.querySelectorAll<HTMLElement>('#docText .docLine .lineText');
  for (const lineBox of lines) {
    const nodes: Text[] = [];
    const walk = (n: Node) => {
      if (n.nodeType === Node.TEXT_NODE) { nodes.push(n as Text); return; }
      if ((n as HTMLElement).tagName === 'MARK') return;   // 已塗過（.docHit）就跳過
      for (const c of [...n.childNodes]) walk(c);
    };
    walk(lineBox);
    for (const node of nodes) {
      const text = node.textContent ?? '';
      if (!text) continue;
      const spans: { start: number; end: number; hue: number }[] = [];
      for (const m of texts) {
        let at = 0;
        while ((at = text.indexOf(m.text, at)) >= 0) {
          spans.push({ start: at, end: at + m.text.length, hue: m.hue });
          at += m.text.length;
        }
      }
      if (!spans.length) continue;
      spans.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
      // 由後往前包，才不會讓前面的 Range 位移
      const kept: typeof spans = [];
      let last = Infinity;
      for (let i = spans.length - 1; i >= 0; i--) {
        const sp = spans[i];
        if (sp.end > last) continue;                        // 與後面已選的區間重疊
        kept.push(sp);
        last = sp.start;
      }
      // 由右往左包：`kept` 已經是左→右排好的，反過來用才不會讓前面的 Range 位移
      for (const sp of kept) {
        const range = document.createRange();
        range.setStart(node, sp.start);
        range.setEnd(node, sp.end);
        const el = document.createElement('mark');
        el.className = 'kw';
        el.style.setProperty('--hue', String(sp.hue));
        try { range.surroundContents(el); } catch { /* 跨節點（理論上不會） */ }
      }
    }
  }
}

async function paintHit(va: number, units?: number): Promise<void> {
  const s = docSession();
  if (!mapper || !s) return;
  // A node-label link (名詞 / 原書分頁) names the node itself, so marking its text in
  // the line the reader was sent to is walk-independent — and on a drifting database
  // (fgdict) it is the ONLY correct answer: the span path painted an unrelated
  // character on the right line. Search hits and token clicks keep the span path,
  // where the token name can differ from the source text (yinshun normalizes) and
  // the same phrase may occur several times in one line.
  // 原書分頁 only jumps: the `<頁>` marker is a milestone, not a hit, so nothing is
  // painted (linkTo has already scrolled its line into view).
  if (s.pinned?.noMark) return;
  const hue = kwHue(s.pinned?.phrase ?? s.pinned?.token);
  if (s.pinned?.exact) {
    const phrase = s.pinned.phrase ?? s.pinned.token;
    const done = !!markPhraseInLine(s.pinned.line, phrase, va, hue, true)
      || markPhraseOnPage(phrase, va, s.pinned.line, hue);
    // 多詞組查詢：其他關鍵字在同一頁也要有顏色（自己的那個已經畫好了）
    paintKeywordMarks();
    if (done) return;
  }
  let spans = units && units > 1 ? await mapper.phraseSpans(va, units) : await mapper.lineSpans(va);
  if (!spans.length) {
    // A heading TAG carries no inline text span (lineSpans skips tags), so a
    // directory click on `<戊 u="文">` would produce no mark AND no scroll.
    const el = await mapper.elementAt(va);
    if (el?.element.line !== undefined) scrollToVa(va);
    paintKeywordMarks();
    return;
  }
  // The page is chosen by the LINK (linkTo follows the hit explicitly), never by
  // the painter: if the hit is not on the page now on screen, there is simply
  // nothing to mark. Moving the page here made 上一頁／下一頁 impossible.
  if (spans.some((x) => !document.getElementById('L' + x.line))) {
    // The walk's spans can disagree with the line table (fgdict drifts by >1000 VA,
    // so its element lookup returns the wrong text). The reader was sent to the
    // table line, so mark the searched phrase inside THAT line instead.
    const readerSent = s.pinned?.phrase ?? s.pinned?.token;
    markPhraseInLine(s.pinned?.line, readerSent, va, hue, true);
    paintKeywordMarks();
    return;
  }
  let firstMark: HTMLElement | null = null;
  for (const sp of spans) {
    const row = document.getElementById('L' + sp.line);
    const box = row?.querySelector<HTMLElement>('.lineText');
    if (!box) continue;
    // 索引的位移是算在「原始行」上的；渲染後 DOM 的文字少了標籤、頁碼被跳過，
    // 位移不一定對得起來 → 先用 data-src 取出那幾個字，再用「找字」的方式塗。
    const src = row?.dataset.src;
    let mark: HTMLElement | null = null;
    if (src) {
      const raw = src.slice(sp.start, sp.end);
      const conv = simConverter();
      const phrase = conv ? conv(raw) : raw;
      // 這一行裡的所有出現都塗（作者 2026-10-27：摘要同一張卡有兩個著色點，
      // 本文卻只塗第一個）。指定那一個已經在裡面，重包時只會補 class。
      if (phrase) mark = markPhraseInLine(sp.line, phrase, va, hue, true);
    }
    if (!mark) {
      const nodes = textNodesOf(box);
      const text = lineTextOf(nodes);
      const start = Math.max(0, Math.min(text.length, sp.start));
      const end = Math.max(start, Math.min(text.length, sp.end));
      if (end <= start) continue;
      mark = markRange(nodes, start, end, va, hue);
    }
    if (!mark) continue;
    if (!firstMark) firstMark = mark;
  }
  (firstMark ?? document.getElementById('L' + (spans[0]?.line ?? 0)))?.scrollIntoView({ block: 'center' });
  paintKeywordMarks();
  scheduleCursorSync();
}

export { markPhraseInLine, markPhraseOnPage, paintHit };
