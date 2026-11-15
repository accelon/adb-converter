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
import type { DocCtx } from './doc-ctx';
import { docSession, hardBreaksOn, scheduleCursorSync, scrollToVa, simConverter } from './doc-pane';
import { kwMarks } from './kw-marks';
import { findPunctLoose } from './loose-match';

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
function markPhraseInLine(line: number | undefined, phrase: string | undefined, va: number, hue = 0, all = false, noScroll = false): HTMLElement | null {
  if (line === undefined || !phrase) return null;
  // 顯示模式（無損／強制簡體）下畫面上的字已經轉過，比對的字串也要跟著轉
  const conv = simConverter();
  const needle = conv ? conv(phrase) : phrase;
  // 「標題＋段」同行的來源行會切成兩列（`L{n}-h` 標題、`L{n}` 正文，見 render_accelon3），
  // 查詢可能落在任何一半，所以兩塊都試。表格的一列有多個 `.lineText`（每格一個），
  // 逐一試 —— 命中在哪一格就塗哪一格（2026-11-06）。
  const boxes = [`L${line}`, `L${line}-h`]
    .flatMap((id) => [...(document.getElementById(id)?.querySelectorAll<HTMLElement>('.lineText') ?? [])]);
  for (const box of boxes) {
    const marked = markInBox(box, needle, va, hue, all);
    if (marked) {
      if (!noScroll) marked.scrollIntoView({ block: 'center' });
      return marked;
    }
  }
  return null;
}

/** 在一個 `.lineText` 裡把 `needle` 包成 mark（由後往前，位移才不會被前面節點影響） */
function markInBox(box: HTMLElement, needle: string, va: number, hue: number, all: boolean): HTMLElement | null {
  const text = lineTextOf(textNodesOf(box));
  // 先嚴格比對（絕大多數情況）；找不到再「忽略標點」比對一次——跨標點命中
  // （搜「涅槃寂靜」、原文「涅槃、寂靜」）只有後者找得到（作者 2026-11-12）。
  let ranges: { start: number; end: number }[] = [];
  let from = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at < 0) break;
    ranges.push({ start: at, end: at + needle.length });
    from = at + needle.length;
    if (!all) break;
  }
  if (!ranges.length) ranges = findPunctLoose(text, needle, all);
  if (!ranges.length) return null;
  let first: HTMLElement | null = null;
  for (let k = ranges.length - 1; k >= 0; k--) {
    const mark = markRange(textNodesOf(box), ranges[k].start, ranges[k].end, va, hue);
    if (mark && !first) first = mark;
  }
  return first;
}

/**
 * 片語被硬換行切開時（`…廣く波` ＋ `羅提木叉…`）：在相鄰兩行的可見文字裡找，
 * 前一行塗尾巴、後一行塗頭。VA walk 會漂的庫（ndd、fgdict）只有這條路可靠。
 */
function markPhraseAcrossLines(line: number | undefined, phrase: string | undefined, va: number, hue = 0, noScroll = false): boolean {
  if (line === undefined || !phrase) return false;
  const conv = simConverter();
  const needle = conv ? conv(phrase) : phrase;
  const rows = [...document.querySelectorAll<HTMLElement>('#docText .docLine')];
  const idx = rows.findIndex((r) => Number((r.id || '').replace(/^L/, '')) === line);
  if (idx < 0) return false;
  for (const at of [idx - 1, idx]) {
    const a = rows[at], b = rows[at + 1];
    if (!a || !b) continue;
    const boxA = a.querySelector<HTMLElement>('.lineText');
    const boxB = b.querySelector<HTMLElement>('.lineText');
    if (!boxA || !boxB) continue;
    const ta = lineTextOf(textNodesOf(boxA));
    const tb = lineTextOf(textNodesOf(boxB));
    const total = ta + tb;
    let p = total.indexOf(needle);
    let len = needle.length;
    if (p < 0) {
      // 跨標點的命中（「涅槃、寂靜」被硬換行切開時也一樣）用寬鬆比對補
      const r = findPunctLoose(total, needle)[0];
      if (!r) continue;
      p = r.start;
      len = r.end - r.start;
    }
    if (p < 0 || p >= ta.length) continue;      // 不在這個交界
    const tail = total.slice(p, ta.length);
    const head = total.slice(ta.length, p + len);
    if (!tail || !head) continue;
    const offA = ta.lastIndexOf(tail);
    const offB = tb.indexOf(head);
    if (offA < 0 || offB < 0) continue;
    const markB = markRange(textNodesOf(boxA), offA, offA + tail.length, va, hue);
    const markA = markRange(textNodesOf(boxB), offB, offB + head.length, va, hue);
    const mark = markB ?? markA;
    if (mark && !noScroll) mark.scrollIntoView({ block: 'center' });
    return true;
  }
  return false;
}

/**
 * Paint `phrase` in the rendered page, starting at `fromLine` and wrapping once.
 *
 * `markPhraseInLine` only looks at the one line the link computed, and on a database
 * whose VA walk drifts (fgdict) that line can be the segment's heading rather than
 * the hit's own line — the query would then silently stay unpainted. The page is
 * always the page that holds the hit, so searching it finds the phrase.
 */
function markPhraseOnPage(phrase: string | undefined, va: number, fromLine: number, hue = 0, noScroll = false): boolean {
  if (!phrase) return false;
  const rows = [...document.querySelectorAll<HTMLElement>('#docText .docLine')];
  if (!rows.length) return false;
  const lineOf = (el: HTMLElement) => Number((el.id || '').replace(/^L/, ''));
  const start = Math.max(0, rows.findIndex((r) => lineOf(r) === fromLine));
  for (let i = start; i < rows.length; i++) if (markPhraseInLine(lineOf(rows[i]), phrase, va, hue, true, noScroll)) return true;
  for (let i = 0; i < start; i++) if (markPhraseInLine(lineOf(rows[i]), phrase, va, hue, true, noScroll)) return true;
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

/** 圖版的命中標記（每次重塗前先清掉，否則翻頁後會留在別張圖上） */
function clearFigureHit(): void {
  document.querySelectorAll('#docText .svgHit, #docText svg.hitFigure')
    .forEach((el) => el.classList.remove('svgHit', 'hitFigure'));
  document.querySelectorAll('#docText .svgHitBox').forEach((el) => el.remove());
}

/**
 * 搜尋命中落在「圖版後面那份被 `<隱>` 藏起來的文字」時，改在**圖上**標色
 * （厚觀法師 2026-11-15：「雖然可以跳到那一頁，但不會反顏色是嗎？能否讓它反顏色？」）。
 *
 * 福嚴的圖版（2p312 三假說對照、5p34 大科分判、5p627／6p631 的附表）畫面上只畫圖，
 * 原本的文字留在圖後面供檢索。命中的時候 DOM 裡沒有字可以包 `<mark>`，法師看到的
 * 就是「跳到那一頁，但那一處不會反顏色」。
 *
 * 這裡先在同一頁的圖裡找含這個詞的 `<tspan>`／`<text>`——圖上的字本身也是文字，
 * 標一條色帶（CSS 用 `paint-order` 畫在字下面）就像螢光筆畫過。找不到（圖是點陣、
 * 或字被拆成很多段）就退回框住那一張圖，至少告訴讀者「是這一張」。
 */
function paintFigureHit(phrase: string | undefined, fromLine: number, hue = 0, noScroll = false): boolean {
  const needle = (phrase ?? '').replace(/\s+/g, '');
  if (!needle) return false;
  const body = document.querySelector<HTMLElement>('#docText .docBody');
  if (!body) return false;
  const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, '');
  const rowOf = (el: Element): number => {
    const row = el.closest('.docLine');
    const n = Number((row?.id || '').replace(/^L/, '').replace(/-h$/, ''));
    return Number.isFinite(n) ? n : Number.NaN;
  };
  const ranked = [...body.querySelectorAll<SVGSVGElement>('svg')]
    .map((el) => ({ el, d: Math.abs(rowOf(el) - fromLine) }))
    .sort((a, b) => (Number.isFinite(a.d) ? a.d : 1e6) - (Number.isFinite(b.d) ? b.d : 1e6))
    .slice(0, 3);
  if (!ranked.length) return false;
  for (const { el } of ranked) {
    const hits = [...el.querySelectorAll<SVGElement>('tspan, text')]
      .filter((n) => norm(n.textContent).includes(needle));
    if (!hits.length) continue;
    // 取字數最少的：外層 <text> 通常含整格兩三行，內層 <tspan> 才是那一行
    hits.sort((a, b) => norm(a.textContent).length - norm(b.textContent).length);
    const best = hits[0];
    // Visio 匯出的 svg 常用 `x="0.296em 2.355em 4.414em 6.473em"` 一個字一個 tab 位置，
    // 每個字的 stroke 會各自成一塊。補一個底色矩形墊在後面，看起來才是連續的反白。
    try {
      // rect 只能放在 <text> 的**父層**（text 的子元素只能是字）：命中若是 tspan，
      // 就用它所屬的那個 text 取邊界，底色才會跟整行一樣寬。
      const anchor = (best.tagName.toLowerCase() === 'tspan'
        ? (best.closest('text') as SVGGraphicsElement | null)
        : (best as unknown as SVGGraphicsElement));
      const bb = anchor?.getBBox();
      if (anchor && bb && bb.width > 0 && bb.height > 0) {
        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        const pad = bb.height * 0.12;
        rect.setAttribute('x', String(bb.x - pad));
        rect.setAttribute('y', String(bb.y - pad));
        rect.setAttribute('width', String(bb.width + pad * 2));
        rect.setAttribute('height', String(bb.height + pad * 2));
        rect.setAttribute('rx', String(bb.height * 0.15));
        rect.setAttribute('class', 'svgHitBox');
        rect.style.setProperty('--hue', String(hue));
        anchor.parentNode?.insertBefore(rect, anchor);
      }
    } catch { /* getBBox 在未渲染時會拋錯，沒有底色也還有 stroke */ }
    best.classList.add('svgHit');
    best.style.setProperty('--hue', String(hue));
    if (!noScroll) best.scrollIntoView({ block: 'center' });
    return true;
  }
  const near = ranked[0].el;
  near.classList.add('hitFigure');
  near.style.setProperty('--hue', String(hue));
  if (!noScroll) near.scrollIntoView({ block: 'center' });
  return true;
}

/** 這一行的 DOM 是不是「有列、但一個字也沒有」（＝被 `<隱>` 藏起來的行） */
function isEmptyRenderedLine(line: number | undefined): boolean {
  if (line === undefined) return false;
  const row = document.getElementById('L' + line);
  if (!row) return true;                       // 這一頁根本沒有這一列
  return (row.textContent || '').trim() === ''; // 有列但是空的（<隱> 包住的內容）
}

/**
 * `opts.noScroll`（作者 2026-11-01）：不要自己捲到釘選的那一行。
 * 由 `renderDoc` 在「還原上次看的捲動位置／選取區」時傳入，否則還原好的位置
 * 會被這裡的 scrollIntoView 搶走。
 */
async function paintHit(ctx: DocCtx | null, va: number, units?: number, opts: { noScroll?: boolean } = {}): Promise<void> {
  const s = docSession();
  const mp = ctx?.mapper ?? null;
  const noScroll = !!opts.noScroll;
  if (!mp || !s) return;
  // A node-label link (名詞 / 原書分頁) names the node itself, so marking its text in
  // the line the reader was sent to is walk-independent — and on a drifting database
  // (fgdict) it is the ONLY correct answer: the span path painted an unrelated
  // character on the right line. Search hits and token clicks keep the span path,
  // where the token name can differ from the source text (yinshun normalizes) and
  // the same phrase may occur several times in one line.
  // 原書分頁 only jumps: the `<頁>` marker is a milestone, not a hit, so nothing is
  // painted (linkTo has already scrolled its line into view).
  if (s.pinned?.noMark) return;
  clearFigureHit();
  const hue = kwHue(s.pinned?.phrase ?? s.pinned?.token);
  if (s.pinned?.exact) {
    const phrase = s.pinned.phrase ?? s.pinned.token;
    const done = !!markPhraseInLine(s.pinned.line, phrase, va, hue, true, noScroll)
      || markPhraseAcrossLines(s.pinned.line, phrase, va, hue, noScroll)
      || markPhraseOnPage(phrase, va, s.pinned.line, hue, noScroll);
    // 多詞組查詢：其他關鍵字在同一頁也要有顏色（自己的那個已經畫好了）
    paintKeywordMarks();
    if (done) return;
  }
  // 搜尋命中：token 就是查詢字串，先用「文字」找（VA walk 會漂的庫——ndd、fgdict——
  // 用 span 會把 mark 畫到隔壁字）；片語跨硬換行時由 markPhraseAcrossLines 補。
  if (!s.pinned?.exact && s.pinned?.token) {
    const done = !!markPhraseInLine(s.pinned.line, s.pinned.token, va, hue, true, noScroll)
      || markPhraseAcrossLines(s.pinned.line, s.pinned.token, va, hue, noScroll);
    if (done) { paintKeywordMarks(); return; }
    // 命中落在圖版後面那份被 <隱> 藏起來的文字：畫面沒有字可塗，改在圖上標
    // （厚觀法師 2026-11-15）。只在「那一列確實是空的」時才動手，免得頁面還沒
    // 渲染好就被誤標成圖版命中。
    if (isEmptyRenderedLine(s.pinned.line) && paintFigureHit(s.pinned.token, s.pinned.line, hue, noScroll)) {
      paintKeywordMarks();
      return;
    }
  }
  let spans = units && units > 1 ? await mp.phraseSpans(va, units) : await mp.lineSpans(va);
  if (!spans.length) {
    // A heading TAG carries no inline text span (lineSpans skips tags), so a
    // directory click on `<戊 u="文">` would produce no mark AND no scroll.
    const el = await mp.elementAt(va);
    if (el?.element.line !== undefined && !noScroll) scrollToVa(ctx, va);
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
    markPhraseInLine(s.pinned?.line, readerSent, va, hue, true, noScroll);
    paintKeywordMarks();
    return;
  }
  let firstMark: HTMLElement | null = null;
  for (const sp of spans) {
    const row = document.getElementById('L' + sp.line);
    // 一列可能有多個 `.lineText`（表格的每一格）；位移路徑只對「單一區塊」可靠
    const boxes = [...(row?.querySelectorAll<HTMLElement>('.lineText') ?? [])];
    if (!boxes.length) continue;
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
      if (phrase) mark = markPhraseInLine(sp.line, phrase, va, hue, true, noScroll);
    }
    // 找不到片語時只在「這一列只有一格」的情況退回位移；表格有多格時寧可不塗，
    // 也不要塗到錯的格（2026-11-06）。
    if (!mark && boxes.length === 1) {
      const nodes = textNodesOf(boxes[0]);
      const text = lineTextOf(nodes);
      const start = Math.max(0, Math.min(text.length, sp.start));
      const end = Math.max(start, Math.min(text.length, sp.end));
      if (end > start) mark = markRange(nodes, start, end, va, hue);
    }
    if (!mark) continue;
    if (!firstMark) firstMark = mark;
  }
  if (!noScroll) (firstMark ?? document.getElementById('L' + (spans[0]?.line ?? 0)))?.scrollIntoView({ block: 'center' });
  paintKeywordMarks();
  scheduleCursorSync();
}

export { markPhraseInLine, markPhraseOnPage, paintHit };
